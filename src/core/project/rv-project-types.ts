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

// ─── Constants ──────────────────────────────────────────────────────────

/** Current manifest schema version. */
export const RV_PROJECT_SCHEMA_VERSION = 1;

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
  [key: string]: unknown;
}

/** `{path, label, sha256, sizeBytes}` artefact reference (models[], library[]). */
export interface RvProjectAssetEntry {
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

  // ── artefact sections (all optional) ──
  models?: RvProjectAssetEntry[];
  library?: RvProjectAssetEntry[];
  /** External catalog subscriptions that travel with the project (§2.6.3). */
  libraries?: RvProjectLibraryRef[];
  scenes?: RvProjectSceneEntry[];
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
  connect?: Record<string, unknown>;
  /** Reference to `settings/project-settings.json`. Named `settingsRef` on purpose. */
  settingsRef?: { ref: string; [key: string]: unknown };
  /** Reserved for the shared-roots follow-up plan. Accepted, never written here. */
  sharedRoots?: Array<{ name: string; purpose?: string; hint?: string; [key: string]: unknown }>;
  rag?: Record<string, unknown>;
  plugins?: { entry?: string; models?: string[]; [key: string]: unknown };
  attachments?: Array<{ path: string; label?: string; kind?: string; [key: string]: unknown }>;

  /** Unknown/future sections travel through untouched. */
  [key: string]: unknown;
}

// ─── Id + slug ──────────────────────────────────────────────────────────

/** Mint a project id. Same shape rationale as `newSceneId()`. */
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

// ─── Scene filenames (RR1) ──────────────────────────────────────────────

/**
 * Derive the on-disk filename for a scene. **Never derived from the name
 * alone** (RR1).
 *
 * Scene names are not unique: `_uniqueSceneName()` is used only by
 * `addPublishedToMyScenes`, while `rename()` and `saveAs()` check nothing.
 * The pre-existing `exportSceneJSON` download name
 * (`scene.name.replace(/\s+/g,'_')`) is fine for a one-off browser download
 * but catastrophic for a managed folder: two scenes called "Cell" would
 * slug onto the same file, and with the delete semantics of §4d one could
 * remove the other's data.
 *
 * The id is therefore part of the filename and carries the uniqueness; the
 * slug is only there so a human (and a git diff) can read the folder.
 */
export function sceneFileNameFor(scene: { id: string; name?: string }): string {
  const slug = canonicalNameOf(scene.name ?? '').slice(0, 40);
  return `${slug}-${sceneIdToken(scene.id)}.scene.json`;
}

/** Filesystem-safe token derived from a scene id. Distinct ids yield distinct tokens. */
export function sceneIdToken(id: string): string {
  const stripped = (id ?? '').replace(/^scn_/, '');
  const safe = stripped.replace(/[^A-Za-z0-9_-]/g, '_');
  return safe || 'unknown';
}

/** Full manifest path (`scenes/<file>`) for a scene. */
export function sceneRelPathFor(scene: { id: string; name?: string }): string {
  return `${PROJECT_FOLDER.scenes}/${sceneFileNameFor(scene)}`;
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

  if (p.scenes !== undefined) {
    if (!Array.isArray(p.scenes)) return false;
    for (const raw of p.scenes) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
      const e = raw as Record<string, unknown>;
      if (typeof e.id !== 'string' || e.id.trim() === '') return false;
      if (typeof e.path !== 'string' || e.path.trim() === '') return false;
    }
  }

  if (!isOptionalAssetList(p.models)) return false;
  if (!isOptionalAssetList(p.library)) return false;

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
    scenes: [],
    activeSceneId: null,
    settingsRef: { ref: PROJECT_SETTINGS_REF },
  };
}
