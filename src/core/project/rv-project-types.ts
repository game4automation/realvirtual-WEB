// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-types — the `rv-project/1.0` manifest (`project.json`).
 *
 * ## The one rule that governs this file: additive, never replacing
 *
 * A `project.json` already exists at exactly this path with a different
 * schema and a different purpose — the deploy manifest read by
 * `scripts/_bunny-lib.mjs` (`loadProject()`, which requires `code` **and**
 * `name` to be non-empty strings and ignores everything else). Five
 * productive customer projects carry it.
 *
 * `rv-project/1.0` is therefore a **superset**: `code`, `name`, `created`,
 * `lastPublished` and `settings.defaultModel` keep their name, their place
 * and their meaning; the new fields sit beside them. Consequences:
 *
 *   - the deploy pipeline is not touched by this plan and keeps working,
 *   - a code rollback is harmless (only fields were added),
 *   - the settings-bundle reference is called `settingsRef`, NOT `settings`,
 *     because `settings` is taken by the deploy manifest.
 *
 * ## Forward compatibility is a hard requirement
 *
 * {@link isValidProjectV1} never rejects unknown fields, and the writer does
 * read-modify-write on the parsed original **at every level** — including
 * fields inside a single `scenes[]` entry. A client with an older build must
 * be able to open, edit and save a project written by a newer one without
 * silently dropping a section (which would show up in the git diff as a
 * deletion). See `rv-project-storage.mergeManifest`.
 */

import type { DocumentClassification } from './rv-document-classification';

// ─── Constants ──────────────────────────────────────────────────────────

/**
 * Current manifest schema version.
 *
 * **2** since plan-413: the manifest carries one `documents[]` list. Phase 6
 * made that a requirement rather than an offer — {@link isValidProjectV2} now
 * insists on the list, and a stored manifest that only has the three legacy
 * arrays gets exactly one chance to become one, in `migrateProjectDocuments`
 * inside `readManifest()`.
 */
export const RV_PROJECT_SCHEMA_VERSION = 2;

/** The version before plan-413 — the one the delivery scripts still write. */
export const RV_PROJECT_SCHEMA_VERSION_V1 = 1;

/** Manifest filename at the project root. */
export const PROJECT_MANIFEST_FILE = 'project.json';

/** Backup written before every manifest overwrite (torn-write recovery). */
export const PROJECT_MANIFEST_BAK_FILE = 'project.json.bak';

/** Well-known subfolders. All optional — a missing one is an empty list, not an error. */
export const PROJECT_FOLDER = {
  models: 'models',
  library: 'library',
  scenes: 'scenes',
  docs: 'docs',
  aasx: 'aasx',
  connect: 'connect',
  settings: 'settings',
  rag: 'rag',
  thumbnails: 'thumbnails',
  /**
   * Gaussian splat captures (plan-372 Phase 11).
   *
   * Their own folder rather than a corner of `models/`: splats are `.splat` /
   * `.ksplat` / `.ply`, not GLB, and the library scan filters by extension —
   * mixing them into `models/` would mean every scan had to learn about them.
   */
  splats: 'splats',
} as const;

/** Settings-bundle file inside `settings/`. */
export const PROJECT_SETTINGS_FILE = 'project-settings.json';

/** Default ref stored in `settingsRef.ref`. */
export const PROJECT_SETTINGS_REF = `${PROJECT_FOLDER.settings}/${PROJECT_SETTINGS_FILE}`;

// ─── Types ──────────────────────────────────────────────────────────────

/**
 * A scene entry in the manifest. Mirrors `RvSceneMeta` plus the on-disk
 * `path`, so the Models panel renders identically whether it is fed from
 * disk or from localStorage.
 *
 * The index signature is deliberate: it is what makes field-level
 * read-modify-write expressible. A future `tags` field on one entry must
 * survive a save by an older client.
 */
export interface RvProjectSceneEntry {
  id: string;
  name: string;
  path: string;
  createdAt?: string;
  modifiedAt?: string;
  baseKind?: string;
  baseLabel?: string;
  parentId?: string;
  thumbnail?: string;
  /**
   * Id of the bundled entry this one was forked from (§2.3).
   *
   * Only user-tier entries carry it. `tier` itself is **not** stored: it is
   * a property of where the entry was read from, and persisting it would let
   * a stale manifest claim a level it does not have. See `rv-project-tiers`.
   */
  forkedFrom?: string;
  /**
   * Content revision of the stored body — SHA-256 hex (plan-397 §2.8).
   *
   * The compare-and-swap token of {@link SceneWrite}. Optional because every
   * manifest written before plan-397 lacks it, and a missing revision means
   * "unknown", never "empty": a write that wants a precondition has to read
   * the body first, which is the honest cost of not having one recorded.
   */
  revision?: string;
  [key: string]: unknown;
}

/** `{path, label, sha256, sizeBytes}` artefact reference (models[], library[]). */
export interface RvProjectAssetEntry {
  /**
   * Stable identity of the artefact, independent of where it currently sits
   * (plan-397 F2, §2.7).
   *
   * Until now `path` was the de-facto key, which made every rename a broken
   * reference: an `AssetReference` resolves by id **first** and falls back to
   * the path, so a moved file keeps its referrers. Optional, because a
   * manifest written before this plan has none — `assetEntryKey()` is the one
   * place that decides what to use.
   */
  id?: string;
  path: string;
  label?: string;
  sha256?: string;
  sizeBytes?: number;
  thumbnail?: string;
  /** Path of the bundled entry this one was forked from (§2.3). */
  forkedFrom?: string;
  [key: string]: unknown;
}

/**
 * The key an artefact is addressed by: its id when it has one, else its path.
 *
 * The fallback is what makes the `id` field additive — an entry without one
 * behaves exactly as it did before, and gaining an id later does not change
 * the answer for anybody who still refers to it by path.
 */
export function assetEntryKey(entry: RvProjectAssetEntry): string {
  const id = typeof entry.id === 'string' ? entry.id.trim() : '';
  return id !== '' ? id : entry.path;
}

/** Mint an artefact id. Same shape rationale as {@link newProjectId}. */
export function newAssetId(): string {
  return 'ast_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/**
 * One document of the project — the entry type that replaces all three
 * (plan-413 §2.3).
 *
 * `RvProjectSceneEntry` and `RvProjectAssetEntry` described the same thing from
 * two directions: a GLB the project owns, plus whatever the section it happened
 * to sit in needed. Since plan-397 they are literally the same bytes; the
 * difference that survives is a **role** ("this one is opened", "this one is
 * referenced"), and a role is not a type.
 *
 * Two fields are worth reading twice:
 *
 *  - **`id` is mandatory** (F2). It is what a reference, a fork and a move all
 *    survive on. `RvProjectAssetEntry.id` was optional because the manifests
 *    that predate plan-397 have none — the documents migration mints one for
 *    every entry that arrives without, which is why this field can be required
 *    while the old one stays optional.
 *  - **`classification` is a CACHE.** The truth lives in the GLB's root extras
 *    (`rv-document-classification`). When the two disagree, the file wins and
 *    this field is replaced, never merged (§2.5).
 *
 * The index signature is the same forward-compatibility contract the other
 * entry types carry: a field written by a newer client survives a save by this
 * one.
 */
export interface RvDocumentEntry {
  /** Mandatory (F2). The migration mints one for every entry that lacks it. */
  id: string;
  /** Where the bytes are, relative to the project. A bare id for the browser backend. */
  path: string;
  name: string;
  /** Cache of the GLB's own classification. The file wins on conflict (§2.5). */
  classification?: DocumentClassification;
  /** Which storage surface holds the bytes — see `DocumentSection`. */
  section?: 'scenes' | 'models' | 'library';
  /** SHA-256 of the body — the compare-and-swap token from plan-397. */
  revision?: string;
  createdAt?: string;
  modifiedAt?: string;
  thumbnail?: string;
  /** Id of the bundled entry this one was forked from (§2.3). */
  forkedFrom?: string;
  /** Id of the document this one was copied from (plan-413 §2.7, phase 5). */
  copiedFrom?: string;
  sizeBytes?: number;
  sha256?: string;
  /**
   * The collections the user filed this document under (plan-717 §2.4).
   *
   * The row is the ONE home for it. Until plan-717 the same information lived
   * in `library/library.json`, a sidecar nothing in production read back — so
   * the field is not a duplicate of that file, it is its successor. Folder
   * chips derived from the path are a different thing (a *place*, not a
   * filing) and are computed by the catalog, never stored here.
   */
  collections?: string[];
  /**
   * When the adopt verb first found this row's file missing, ISO-8601
   * (plan-717 §2.2 step 4).
   *
   * A quarantine mark, not a tombstone: the row is still fully live, and the
   * next run that finds the file again deletes the field. Removal needs a
   * LATER run *and* a mark older than the quarantine window, which is what
   * keeps a half-copied folder or a lagging cloud sync from costing a user
   * their collections. Absent on every healthy row — the normal state.
   */
  missingSince?: string;
  /**
   * Modification time recorded at the last classification scan, epoch ms.
   *
   * Half of the `(size, mtime)` pre-filter of §2.5 — the half that makes "a scan
   * over a hundred unchanged documents reads zero GLBs" true. Never a
   * correctness input: a wrong mtime costs one needless read, never a wrong
   * answer, because the GLB is what the read then believes.
   */
  mtimeMs?: number;
  /**
   * The CONNECT configuration file this document is bound to (plan-718 §2.3).
   *
   * A project-relative path — never a name, never a folder convention. Two rows
   * may carry the SAME value and that is the point (N:1): switching between two
   * documents bound to one config is not a config change, so the workers keep
   * running. Absent means "no binding", which is a valid state and not an error.
   */
  connectRef?: string;
  /**
   * The project's own code for this document (plan-718 §2.6).
   *
   * Project-relative path of the `.ts` source. Replaces the module's
   * self-declaration `models: string[]`, which bound code to a GLB FILE NAME and
   * therefore broke on every rename. This binding hangs on the row, whose id is
   * frozen at birth (plan-717), so renaming or moving the GLB cannot break it.
   */
  scriptRef?: string;
  /**
   * The knowledge file for this document (plan-718 §2.3, stage 3).
   *
   * Project-relative path. The file it points at is what references the PDFs and
   * the RAG index — this field never names them itself, so no `docs/` or `rag/`
   * folder convention is implied.
   */
  knowledgeRef?: string;
  /**
   * Preferred workspace mode to switch to when this document is opened
   * (e.g. `planner`, `des`). Optional — absent means "leave the mode alone".
   *
   * Carried by a manifest row since plan-731: it used to live in the curated
   * `scenes/index.json`, the second catalogue that plan abolished. A `?mode=`
   * in the URL still wins over it.
   */
  mode?: string;
  /**
   * Repo fixture: visible in the dev checkout, removed by every staging path
   * (plan-731 §2.4).
   *
   * The successor of the `Test*` FILENAME convention `applyPublicScenePruning`
   * used to prune by. A convention cannot say "this one is a test" about a file
   * whose name does not start with `Test`, and it cannot be seen from the
   * manifest at all — this field can, which is what lets the release gate of
   * Phase 4 assert "no dev-only document reached the channel".
   */
  devOnly?: boolean;
  /**
   * The settings sidecar this document is bound to (plan-731 F5).
   *
   * A project-relative path, replacing the `<model>.settings.json` FILENAME
   * convention the staging scripts used to hard-code. The convention stays as a
   * fallback for a manifest that does not declare one — same shape as the
   * `models/` path fallback beside it.
   */
  settingsPath?: string;
  [key: string]: unknown;
}

/**
 * A library SUBSCRIPTION carried by the project (plan-372 §2.6.3).
 *
 * Not to be confused with {@link RvProject.library} — that one lists the
 * artefacts inside `<project>/library/`. This one lists *external* catalogs the
 * project depends on ("this project needs the conveyor catalog"), travels with
 * git / zip / deploy, and is deliberately the only project-level half of the
 * two-level library SSOT; the other half is the user's global localStorage list.
 */
export interface RvProjectLibraryRef {
  /** Catalog URL, GitHub repo/folder URL, or any other `addCatalog` key. */
  url: string;
  label?: string;
  [key: string]: unknown;
}

/**
 * Which parts of a project WE own and update, and which parts belong to the
 * customer (plan-700 §2.3).
 *
 * A delivered project folder is two things at once: our shipped material and
 * the customer's working directory. Without a marking, an update can only
 * choose between overwriting everything (destroying their scenes) or nothing
 * (no update ever arrives). This block draws the line.
 *
 * The default when this block is **absent** is deliberately the safe one:
 * everything in the project is customer-owned and nothing is overwritten. A
 * forgotten glob costs one update that did not arrive; a glob that is too wide
 * costs customer data. Only the first mistake is repairable.
 */
export interface RvProjectVendorBlock {
  /**
   * Vendor-managed paths inside the project, as globs (same syntax as the
   * delivery pipeline's `globRegex`: `*` within a segment, `**` across).
   * Order is irrelevant.
   */
  managed?: string[];
  /**
   * Exceptions INSIDE `managed` that belong to the customer. More specific
   * beats more general — `handover` always wins over `managed`, with no
   * ordering semantics of its own.
   */
  handover?: string[];
  [key: string]: unknown;
}

/**
 * What a project folder IS (plan-434 §2.6).
 *
 * Operator-facing metadata: the browser neither sets nor reads it, but it must
 * know the field exists, because the manifest is read-modify-written here and an
 * unknown section is carried through, never dropped. The Node side is the
 * authority — `PROJECT_KINDS` in `scripts/_rv-guards.mjs`, kept in the same
 * three spellings.
 *
 *  - `customer` — real customer material, delivered, under an NDA.
 *  - `demo` — something shown publicly.
 *  - `internal` — test fixtures, scratch, spikes.
 */
export type RvProjectKind = 'customer' | 'demo' | 'internal';

/** Who wrote this manifest last, and with what. */
export interface RvProjectProvenance {
  createdBy?: string;
  generator?: string;
  generatorVersion?: string;
  lastWriter?: 'web' | 'connect' | 'cli' | string;
  gitRemote?: string;
  [key: string]: unknown;
}

/**
 * The `project.json` manifest.
 *
 * Every artefact section is optional; absence means "not present", never
 * "broken". The index signature carries unknown sections through untouched.
 */
export interface RvProject {
  // ── new core fields ──
  schemaVersion: number;
  id: string;
  name: string;
  canonicalName?: string;
  createdAt?: string;
  modifiedAt?: string;
  provenance?: RvProjectProvenance;
  /**
   * What this project is — customer material, a demo, or internal (plan-434).
   * Optional here on purpose: a manifest written before phase 2 has none, and
   * `isValidProjectV1` never rejects a manifest over a missing optional field.
   */
  kind?: RvProjectKind;
  /**
   * Vendor/customer split used by the customer-delivery merge (plan-700).
   * Absent means "the whole project is customer-owned" — nothing is updated.
   */
  vendor?: RvProjectVendorBlock;

  // ── pre-existing deploy-manifest fields — unchanged in name and place ──
  /** Deploy code. `loadProject()` in `_bunny-lib.mjs` requires this. */
  code?: string;
  created?: string;
  lastPublished?: string;
  /** Deploy settings (`{ defaultModel }`). NOT the settings bundle — see `settingsRef`. */
  settings?: Record<string, unknown>;

  // ── the one artefact list (plan-413 §2.4 step B) ──
  /**
   * Every document the project owns — the **only** artefact list.
   *
   * `scenes[]`, `models[]` and `library[]` are gone from this type as of phase
   * 6. They may still be present in a stored manifest nobody has opened since,
   * and the index signature carries them through the parse; what reads them is
   * `migrateProjectDocuments`, once, on the way in. Nothing writes them.
   *
   * Optional in the type and mandatory in practice: `readManifest()` migrates
   * or refuses (F10), so every project this build hands out has one. The `?`
   * exists for the moment before that, and for a hand-built fixture.
   */
  documents?: RvDocumentEntry[];

  /**
   * Folders that exist even though nothing is in them.
   *
   * Every other folder in the tree is DERIVED from the paths in `documents[]`,
   * which is why an empty one had no way to exist: delete the last file and the
   * folder went with it. A user who makes a folder before they have anything to
   * put in it is stating an intent, and this is where that intent is recorded.
   *
   * Paths are project-relative, `/`-separated, no leading or trailing slash —
   * the same spelling `documents[].path` uses. A folder that later holds a
   * document may stay listed here or not; the tree unions the two, so neither
   * answer changes what is on screen.
   */
  folders?: string[];

  /** External catalog subscriptions that travel with the project (§2.6.3). */
  libraries?: RvProjectLibraryRef[];

  /**
   * The document this project was last left on — **a live resume mechanism, not
   * scene-era residue.** Read this before deleting it.
   *
   * It is priority 4 of the open decision ("decision 24", `rv-project-open.ts`),
   * consumed by `project-store.ts` (`_seedSceneMetas`) and the dashboard host,
   * and written by `rv-project-folder-writer.ts`. It is the ONLY resume signal
   * that travels WITH the project rather than in the local remembered-pair, so
   * it is what makes opening a delivered project on a fresh machine land on its
   * real document instead of degrading to `settings.defaultModel`.
   *
   * The name is pre-plan-716 and the value is a document id. A plan-720 audit
   * classified the field as dead on the name alone; the review caught it. Rename
   * it if you like, but do not remove it (Z6).
   */
  activeSceneId?: string | null;
  /**
   * Ids/paths the user has hidden (§2.3.2).
   *
   * A bundled entry cannot be deleted — the next load re-reads it from the
   * build — so hiding is the only way for a customer to get shipped demos out
   * of their view. It lives in the user tier and never touches the bundled one.
   */
  hidden?: string[];
  docs?: { indexRef?: string; basePath?: string; [key: string]: unknown };
  aasx?: { indexRef?: string; basePath?: string; [key: string]: unknown };
  /**
   * Project-wide CONNECT references (plan-718 §2.3).
   *
   * Narrowed from `Record<string, unknown>` (K10): the loose form was a
   * placeholder nothing ever read or wrote, and leaving it open would have let a
   * second, undeclared shape grow next to the two fields that are actually
   * resolved. Unknown keys still travel through — the index signature keeps
   * forward-compatibility without pretending the schema is unknown.
   */
  connect?: {
    /** Path of the agents/diagnosis section file CONNECT feeds its config pipeline from. */
    agentsRef?: string;
    /** Path of the gitignored secrets sidecar. Defaults to {@link DEFAULT_SECRETS_REF}. */
    secretsRef?: string;
    /**
     * Path of the RAG bundle CONNECT unpacks for the diagnosis feature
     * (plan-718 stage 3.3).
     *
     * Declared here because CONNECT already reads it (`ProjectManifest.RagRef`)
     * and an undeclared field that one side resolves is exactly the drift the
     * cross-language fixture exists to prevent. The bundle is the project's
     * artefact; the generations CONNECT extracts from it stay host-local under
     * the data root and are never referenced from a manifest.
     */
    ragRef?: string;
    [key: string]: unknown;
  };
  /** Reference to `settings/project-settings.json`. Named `settingsRef` on purpose. */
  settingsRef?: { ref: string; [key: string]: unknown };
  /** Reserved for the shared-roots follow-up plan. Accepted, never written here. */
  sharedRoots?: Array<{ name: string; purpose?: string; hint?: string; [key: string]: unknown }>;
  // `rag` and `plugins` used to sit here as typed placeholders. Neither was ever
  // read or written anywhere in `src/`, `scripts/` or `tests/`, and plan-718
  // gives both of them a real home on the document row instead
  // (`knowledgeRef`, `scriptRef`). They are removed rather than kept as a third
  // schema beside the two that resolve (K10). The manifest's index signature
  // still carries them through untouched on an old file — removing the type
  // removes the *invitation*, not the data.
  attachments?: Array<{ path: string; label?: string; kind?: string; [key: string]: unknown }>;

  /** Unknown/future sections travel through untouched. */
  [key: string]: unknown;
}

// ─── Id + slug ──────────────────────────────────────────────────────────

/** Mint a project id: short, sortable, unique enough for a client-side id. */
export function newProjectId(): string {
  return 'prj_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/**
 * Slugify a display name into a `canonicalName`, following the same
 * restrictions CONNECT's `ProjectPaths.ValidateProjectName` applies, so the
 * WEB slug and the CONNECT RAG bundle id agree.
 */
export function canonicalNameOf(name: string): string {
  const slug = (name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'project';
}

// ─── Declared folders ───────────────────────────────────────────────────

/**
 * Normalise a folder path to the one spelling the manifest stores.
 *
 * Empty string for anything that is not a usable path, so callers can reject
 * with a single falsy check instead of repeating the rules.
 */
export function normaliseFolderPath(raw: string | null | undefined): string {
  return (raw ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .map(s => s.trim())
    .filter(Boolean)
    .join('/');
}

/**
 * The folders a project declares, de-duplicated and in manifest order.
 *
 * Defensive like every reader in this layer: a malformed or future-shaped
 * `folders[]` yields an empty list rather than a throw.
 */
export function readProjectFolders(project: RvProject | null | undefined): string[] {
  const raw = project?.folders;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const path = normaliseFolderPath(item);
    if (!path || out.includes(path)) continue;
    out.push(path);
  }
  return out;
}

/**
 * Return a manifest whose `folders[]` is exactly `paths`.
 *
 * Passing an empty list removes the section rather than writing `[]`, so a
 * project that never declared a folder stays byte-identical — the same rule
 * {@link RvProject.libraries} follows.
 */
export function withProjectFolders(project: RvProject, paths: readonly string[]): RvProject {
  const wanted: string[] = [];
  for (const p of paths) {
    const path = normaliseFolderPath(p);
    if (path && !wanted.includes(path)) wanted.push(path);
  }
  if (wanted.length === 0) {
    if (project.folders === undefined) return project;
    const { folders: _dropped, ...rest } = project;
    return rest as RvProject;
  }
  return { ...project, folders: wanted };
}

// ─── Scene filenames (RR1) ──────────────────────────────────────────────

/** Filesystem-safe token derived from a scene id. Distinct ids yield distinct tokens. */
export function sceneIdToken(id: string): string {
  const stripped = (id ?? '').replace(/^scn_/, '');
  const safe = stripped.replace(/[^A-Za-z0-9_-]/g, '_');
  return safe || 'unknown';
}

/**
 * On-disk filename for a scene. **Never derived from the name alone** (RR1).
 *
 * Scene names are not unique: `_uniqueSceneName()` is used only by
 * `materializePublishedExample`, while `rename()` and `saveAs()` check nothing. Two
 * scenes called "Cell" would slug onto the same file, and with the delete
 * semantics of §4d one could remove the other's data.
 *
 * The id is therefore part of the filename and carries the uniqueness; the
 * slug is only there so a human (and a git diff) can read the folder.
 */
export function sceneGlbFileNameFor(scene: { id: string; name?: string }): string {
  const slug = canonicalNameOf(scene.name ?? '').slice(0, 40);
  return `${slug}-${sceneIdToken(scene.id)}.scene.glb`;
}

/** Full manifest path (`scenes/<file>.scene.glb`) for a GLB scene. */
export function sceneGlbRelPathFor(scene: { id: string; name?: string }): string {
  return `${PROJECT_FOLDER.scenes}/${sceneGlbFileNameFor(scene)}`;
}

/** Split a `scenes/<file>` ref into its filename. Tolerates a bare filename. */
export function sceneFileNameOfPath(path: string): string {
  const parts = (path ?? '').split('/');
  return parts[parts.length - 1] ?? '';
}

// ─── Validation ─────────────────────────────────────────────────────────

/**
 * Validate the *shape* of a manifest.
 *
 * Checks `schemaVersion`, `id`, `name` and the form of whichever optional
 * sections are present. **Unknown fields are never a reason to reject** —
 * that is the forward-compatibility contract, and rejecting them would turn
 * a newer project into an unopenable one.
 */
export function isValidProjectV1(value: unknown): value is RvProject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;

  if (typeof p.schemaVersion !== 'number' || p.schemaVersion < 1) return false;
  if (typeof p.id !== 'string' || p.id.trim() === '') return false;
  if (typeof p.name !== 'string' || p.name.trim() === '') return false;

  // The three legacy arrays are no longer part of the type, but a stored
  // manifest that has not been migrated yet still carries them, and their shape
  // is what `migrateProjectDocuments` is about to read. Checking it here is what
  // turns "malformed legacy array" into a refusal at the door rather than a
  // half-built `documents[]` further in.
  const legacyScenes = (p as { scenes?: unknown }).scenes;
  if (legacyScenes !== undefined) {
    if (!Array.isArray(legacyScenes)) return false;
    for (const raw of legacyScenes) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
      const e = raw as Record<string, unknown>;
      if (typeof e.id !== 'string' || e.id.trim() === '') return false;
      if (typeof e.path !== 'string' || e.path.trim() === '') return false;
    }
  }

  if (!isOptionalAssetList((p as { models?: unknown }).models)) return false;
  if (!isOptionalAssetList((p as { library?: unknown }).library)) return false;

  if (p.activeSceneId !== undefined && p.activeSceneId !== null && typeof p.activeSceneId !== 'string') {
    return false;
  }
  if (p.settingsRef !== undefined) {
    if (!isPlainObject(p.settingsRef)) return false;
    if (typeof (p.settingsRef as Record<string, unknown>).ref !== 'string') return false;
  }
  if (p.sharedRoots !== undefined) {
    if (!Array.isArray(p.sharedRoots)) return false;
    for (const raw of p.sharedRoots) {
      if (!isPlainObject(raw)) return false;
      if (typeof (raw as Record<string, unknown>).name !== 'string') return false;
    }
  }
  if (p.attachments !== undefined) {
    if (!Array.isArray(p.attachments)) return false;
    for (const raw of p.attachments) {
      if (!isPlainObject(raw)) return false;
      if (typeof (raw as Record<string, unknown>).path !== 'string') return false;
    }
  }
  // `vendor` is a shape check only — whether a glob is *sensible* (not too
  // wide) is a delivery-time question and lives in scripts/validate-project.mjs,
  // where it can fail a build. Rejecting it here would make an over-wide glob
  // un-openable in the browser instead of un-deliverable, which helps nobody.
  if (p.vendor !== undefined) {
    if (!isPlainObject(p.vendor)) return false;
    const v = p.vendor as Record<string, unknown>;
    for (const key of ['managed', 'handover'] as const) {
      if (v[key] === undefined) continue;
      if (!Array.isArray(v[key])) return false;
      if (!(v[key] as unknown[]).every(g => typeof g === 'string' && g.trim() !== '')) return false;
    }
  }
  for (const key of ['docs', 'aasx', 'connect', 'rag', 'plugins', 'provenance', 'settings'] as const) {
    if (p[key] !== undefined && !isPlainObject(p[key])) return false;
  }
  return true;
}

/**
 * Validate a manifest of schema 2 — a v1-shaped manifest that **has**
 * `documents[]`.
 *
 * Hard since phase 6, and that is the change: through the transition this
 * accepted a manifest with no `documents[]` at all, because a v1 manifest was
 * a v2 manifest that had not been migrated yet. There is no transition left to
 * be in. A manifest reaching this check without a document list has either been
 * through {@link migrateProjectDocuments} — which builds one from the legacy
 * arrays — or it is something this build cannot open, and saying so out loud
 * (F10) is the whole point of the gate.
 *
 * `documents[]` itself is checked on `id` and `path`, the two fields every
 * later step keys off. An entry without them is not forward compatibility; it
 * is a bug in whoever wrote it, and carrying it further would surface as a
 * document that cannot be selected, referenced or moved.
 */
export function isValidProjectV2(value: unknown): value is RvProject {
  if (!isValidProjectV1(value)) return false;
  const p = value as Record<string, unknown>;
  if (!Array.isArray(p.documents)) return false;
  for (const raw of p.documents) {
    if (!isPlainObject(raw)) return false;
    const e = raw as Record<string, unknown>;
    if (typeof e.id !== 'string' || e.id.trim() === '') return false;
    if (typeof e.path !== 'string' || e.path.trim() === '') return false;
  }
  return true;
}

function isOptionalAssetList(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  return value.every(e => isPlainObject(e) && typeof (e as Record<string, unknown>).path === 'string');
}

function isPlainObject(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// ─── Construction ───────────────────────────────────────────────────────

/** Build a fresh, minimal `rv-project/1.0` manifest. */
export function newProject(name: string): RvProject {
  const now = new Date().toISOString();
  return {
    schemaVersion: RV_PROJECT_SCHEMA_VERSION,
    id: newProjectId(),
    name,
    canonicalName: canonicalNameOf(name),
    createdAt: now,
    modifiedAt: now,
    provenance: { generator: 'realvirtual WEB', lastWriter: 'web' },
    documents: [],
    activeSceneId: null,
    settingsRef: { ref: PROJECT_SETTINGS_REF },
  };
}
