// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-asset-identity — an identity that survives a move (plan-703 Phase 5, §2.5).
 *
 * Four rules, and the whole module is those four rules:
 *
 *  1. **The scan reads; the adopt verb writes** (plan-717 §2.2). Browsing still
 *     imprints nothing: a listing derives its ids ({@link stableDocumentId},
 *     re-exported as {@link previewAssetId}), allocates nothing and touches no
 *     manifest — the Phase-6 tree scans hundreds of files on every open, and a
 *     scan that rewrote `project.json` would make *looking* a write.
 *
 *     What plan-717 adds beside it is a second, explicit step:
 *     {@link adoptDiscoveredDocuments} turns the files the scan found into
 *     authored rows. It is a verb, not a side effect — it runs only on a
 *     **writable** backend, only after the scan, writes exactly one delta per
 *     run, logs a line per adoption/move/quarantine/removal, and does nothing
 *     at all when the delta is empty. So the old sentence is re-framed rather
 *     than broken: the read-only guarantee belongs to the *scan*, and the
 *     write is somewhere a reader can see it. A read-only project (bundled,
 *     HTTP, a folder without a grant) never adopts, and keeps showing the
 *     derived rows as the transient display fallback they always were.
 *  2. **The mint hangs on the PERSISTENCE step, never on the op** (A12). A
 *     reference becomes durable when its bytes are written — Save or Bake — and
 *     that is the only moment {@link mintAssetIdentity} runs. This is what makes
 *     `core/share/rv-share-escalate.ts` correct without knowing this module
 *     exists: its file header calls its own path transient ("No new executor,
 *     nothing written"), and a hook that hung on `insert reference` would have
 *     broken exactly that contract. Nothing here has a special case for it,
 *     because nothing here can be reached from it.
 *  3. **A move rewrites `path` and only `path`** ({@link moveDocumentPath}).
 *  4. **Two files with one id is an error with a message**
 *     ({@link assertNoDocumentIdCollisions}), never a silent alias. §8 records
 *     the fall pattern this exists to avoid: Unity's GUID model fails silently
 *     on a folder copy — "Unity does not throw an error" — while Godot 4.4's
 *     UID repairs the reference at save time. The house answer is Godot's:
 *     report it, in the user's face, once.
 *
 * ## Why the minted id is derived and not random
 *
 * `newDocumentId()` exists and would look like the natural "real" id. It is the
 * wrong one here, for the reason `stableDocumentId`'s own doc comment gives:
 * *a project travels*. Two machines opening the same git checkout before either
 * has saved would mint two different ids for the same file, and the first save
 * to land would silently re-key the other's references — which is precisely the
 * failure the move-proof id is supposed to prevent.
 *
 * Deriving costs nothing here, because **durability comes from the manifest row,
 * not from the derivation**. Once the row exists the id is read from it and
 * never recomputed, so a later move keeps it even though
 * `stableDocumentId(newPath)` would now answer differently. The mint's job is to
 * make the id permanent, not to make it different — and a derived id is
 * additionally legible in a git diff, which a random one is not.
 *
 * ## No storage, no backend, no React
 *
 * Every function here takes a manifest and returns a manifest. The callers that
 * own bytes ({@link ProjectStore}, the folder writer, the library verbs) apply
 * the result through their own write path, which is what keeps the rules
 * testable without a file system.
 */

import type { RvDocumentEntry, RvProject } from './rv-project-types';
import {
  type DocumentSection,
  type DocumentStat,
  findDocumentIdCollisions,
  readDocuments,
  sectionOfDocument,
  stableDocumentId,
} from './rv-project-documents';

// ─── Browse: derive, never write ────────────────────────────────────────

/**
 * The id a GLB answers to while it has no manifest row.
 *
 * A pure derivation over the path, and the one function in this module a scan
 * may call: it allocates nothing, writes nothing and is the same answer on every
 * machine. Named separately from {@link stableDocumentId} so the *intent* is
 * visible at the call site — "this is the browse-time id, and it is not
 * imprinted".
 */
export function previewAssetId(path: string): string {
  return stableDocumentId(path);
}

/** Normalise a project-relative path for comparison (leading `./`, `\`, case). */
function normalisePath(path: string): string {
  return (path ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * The manifest row for `path`, or null.
 *
 * Path is the lookup key rather than the id on purpose: at the persistence step
 * the caller has a path (it just wrote bytes there) and is asking whether this
 * file already has an identity. Asking by id would presuppose the answer.
 */
export function findDocumentByPath(
  project: RvProject | null | undefined,
  path: string,
  section?: DocumentSection,
): RvDocumentEntry | null {
  const wanted = normalisePath(path);
  if (wanted === '') return null;
  for (const doc of readDocuments(project) ?? []) {
    if (normalisePath(doc.path) !== wanted) continue;
    if (section && sectionOfDocument(doc) !== section) continue;
    return doc;
  }
  return null;
}

/** The manifest row carrying `id`, or null. */
export function findDocumentById(
  project: RvProject | null | undefined,
  id: string,
): RvDocumentEntry | null {
  const wanted = (id ?? '').trim();
  if (wanted === '') return null;
  return (readDocuments(project) ?? []).find(d => d.id === wanted) ?? null;
}

// ─── Collisions ─────────────────────────────────────────────────────────

/** Two rows, one id — the Unity-GUID fall pattern (§8), refused out loud. */
export class DocumentIdCollisionError extends Error {
  constructor(
    readonly id: string,
    /** Every path claiming the id, in manifest order. */
    readonly paths: string[],
  ) {
    super(
      `Two documents claim the same id "${id}": ${paths.map(p => `"${p}"`).join(' and ')}. `
      + 'A copied file must get its own id — rename or re-import one of them.',
    );
    this.name = 'DocumentIdCollisionError';
  }
}

/**
 * Every id claimed by more than one row of THIS manifest.
 *
 * {@link findDocumentIdCollisions} is the cross-source scan of plan-413 §2.7;
 * this is the one-manifest case, which is what a folder copy produces. Reusing
 * it (with a single synthetic source) rather than re-implementing the grouping
 * keeps one definition of "collision" in the codebase — its doc comment already
 * settles that a source listing an id twice counts.
 */
export function findLocalIdCollisions(
  project: RvProject | null | undefined,
): Array<{ id: string; paths: string[] }> {
  const documents = readDocuments(project) ?? [];
  return findDocumentIdCollisions([{ sourceId: 'project', documents }])
    .map(({ id, paths }) => ({ id, paths }));
}

/**
 * Throw on the first collision, with the message the user sees.
 *
 * Throwing rather than returning is the decision of §2.5: a collision is a
 * *fehler mit meldung*, and a boolean return would let a caller carry on with
 * two documents answering to one name — the silent aliasing the rule forbids.
 */
export function assertNoDocumentIdCollisions(project: RvProject | null | undefined): void {
  const first = findLocalIdCollisions(project)[0];
  if (first) throw new DocumentIdCollisionError(first.id, first.paths);
}

// ─── Mint (the persistence step, and only there) ────────────────────────

export interface AssetIdentityRequest {
  /** Project-relative path the bytes were just written to. */
  path: string;
  /** Which storage surface. Defaults to the path-derived section. */
  section?: DocumentSection;
  /** Display name; the file stem when omitted. */
  name?: string;
  /**
   * The id to write. Defaults to {@link previewAssetId} of the path, which is
   * what every caller wants; the adopt verb passes an explicit one only to
   * carry the collision suffix (§2.2), never to invent an identity.
   */
  id?: string;
  /**
   * Extra row fields to record with the mint — stats the adopt verb just
   * learnt (`sizeBytes`, `mtimeMs`, `sha256`), and from Phase 2 the collections
   * ingested out of a sidecar. `id`, `path`, `name` and `section` are owned by
   * the request above and cannot be overridden here.
   */
  extra?: Partial<RvDocumentEntry>;
}

export interface AssetIdentityResult {
  /**
   * The manifest to persist. **The same object** when nothing changed, so a
   * caller can skip its write with `result.project === before`.
   */
  project: RvProject;
  entry: RvDocumentEntry;
  /** True when a row was added — i.e. this call is the imprint. */
  minted: boolean;
}

/** File stem without the (compound) extension — the default display name. */
function stemOf(path: string): string {
  const file = normalisePath(path).split('/').filter(Boolean).pop() ?? path;
  return file.replace(/\.(scene\.)?(glb|gltf|json|splat|ksplat|ply)$/i, '') || file;
}

/** Section a path belongs to when the caller does not say. */
function sectionOfPath(path: string): DocumentSection {
  const p = normalisePath(path);
  if (p.startsWith('scenes/')) return 'scenes';
  if (p.startsWith('models/')) return 'models';
  return 'library';
}

/**
 * Give the file at `request.path` a durable identity — **exactly one row**.
 *
 * Idempotent by construction: a second call for a path that already has a row
 * returns that row with `minted: false` and the manifest untouched. That is what
 * makes it safe to call on every save rather than only on the first one, which
 * in turn is what keeps the caller free of a "have I minted this yet?" flag —
 * the manifest is that flag.
 *
 * Refuses when the id it would write is already taken by a different path: the
 * only way that happens is a file copied in from outside, and answering it with
 * a second row would be the silent alias §2.5 forbids.
 */
export function mintAssetIdentity(
  project: RvProject,
  request: AssetIdentityRequest,
): AssetIdentityResult {
  const path = normalisePath(request.path);
  if (path === '') throw new Error('mintAssetIdentity needs a path.');
  const section = request.section ?? sectionOfPath(path);

  const existing = findDocumentByPath(project, path, section);
  if (existing) return { project, entry: existing, minted: false };

  const id = request.id?.trim() || previewAssetId(path);
  const clash = findDocumentById(project, id);
  if (clash && normalisePath(clash.path) !== path) {
    throw new DocumentIdCollisionError(id, [clash.path, path]);
  }

  const entry: RvDocumentEntry = {
    ...(request.extra ?? {}),
    id,
    path,
    name: request.name?.trim() || stemOf(path),
    section,
  };
  const documents = [...(readDocuments(project) ?? []), entry];
  return { project: { ...project, documents }, entry, minted: true };
}

/** What a save/bake learnt about the references it just wrote into bytes. */
export interface WrittenReference {
  /** Project-relative path of the referenced GLB. */
  path: string;
  section?: DocumentSection;
  name?: string;
}

export interface MintedReferences {
  project: RvProject;
  /** The rows that were ADDED, in call order. Empty when all were known. */
  minted: RvDocumentEntry[];
  /** Every row the references resolved to, minted or pre-existing. */
  entries: RvDocumentEntry[];
}

/**
 * The persistence-step hook: imprint every reference the written bytes carry.
 *
 * One pass, one manifest, one row per distinct path — a plant that places the
 * same roll two hundred times mints one identity, not two hundred. The result's
 * `project` is the same object when nothing was minted, so the caller's write is
 * conditional on a reference comparison rather than on a diff.
 */
export function mintReferencedAssets(
  project: RvProject,
  references: readonly WrittenReference[],
): MintedReferences {
  let current = project;
  const minted: RvDocumentEntry[] = [];
  const entries: RvDocumentEntry[] = [];
  const seen = new Set<string>();
  for (const ref of references) {
    const path = normalisePath(ref.path);
    if (path === '' || seen.has(path)) continue;
    seen.add(path);
    const result = mintAssetIdentity(current, ref);
    current = result.project;
    entries.push(result.entry);
    if (result.minted) minted.push(result.entry);
  }
  return { project: current, minted, entries };
}

// ─── From written bytes to mintable rows ────────────────────────────────

/** One `AssetReference` as it stands in the bytes that were just written. */
export interface WrittenGlbReference {
  assetId: string;
  /** `ref.path`, relative to the file that carries the reference. May be empty. */
  path: string;
}

/** A path we could put in a manifest row: project-relative, no scheme, no `..`. */
function isProjectRelative(path: string): boolean {
  const p = normalisePath(path);
  if (p === '' || p.startsWith('/')) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(p)) return false;   // http:, blob:, data:, file:
  return !p.split('/').includes('..');
}

/**
 * Which of the references in the written bytes still need an identity.
 *
 * Three reasons to skip, and each is a rule rather than an optimisation:
 *
 *  - **The id already has a row.** It is durable; minting again would be the
 *    second row that {@link assertNoDocumentIdCollisions} exists to refuse.
 *  - **The path is not project-relative.** An `http:`/`blob:` reference points
 *    outside the project, and a manifest row for it would claim ownership of
 *    something the project does not hold.
 *  - **The id is not the browse-time derivation of that path.** Then it came
 *    from a catalog with an identity of its own (a library `catalogId`), and
 *    that identity is not this project's to re-issue.
 *
 * What is left is exactly §2.5's case: a project-local GLB that has been carried
 * this whole time on its path-derived id, and has now been referenced in bytes.
 */
export function mintableReferences(
  project: RvProject | null | undefined,
  references: readonly WrittenGlbReference[],
): WrittenReference[] {
  const out: WrittenReference[] = [];
  const seen = new Set<string>();
  for (const ref of references) {
    const path = normalisePath(ref.path);
    if (!isProjectRelative(path) || seen.has(path)) continue;
    if (ref.assetId && findDocumentById(project, ref.assetId)) continue;
    if (findDocumentByPath(project, path)) continue;
    if (ref.assetId && ref.assetId !== previewAssetId(path)) continue;
    seen.add(path);
    out.push({ path });
  }
  return out;
}

// ─── Move ───────────────────────────────────────────────────────────────

/**
 * Point a document's row at a new path. **The id does not change.**
 *
 * That single sentence is F12: a GLB moved in the tree must not break a
 * reference, and since a reference addresses by `assetId` first
 * (`rv-glb-reference-resolver.ts`, "the stable identity — a file renamed or
 * moved inside a library still resolves"), keeping the id is the whole of the
 * repair. Nothing else on the row is touched, including `revision` and the
 * classification cache: the bytes did not change, only where they are.
 *
 * Returns the same object when the row is already at `newPath`, and throws when
 * the id is unknown — a move whose row cannot be found is a bug in the caller,
 * not a no-op to swallow.
 */
export function moveDocumentPath(
  project: RvProject,
  id: string,
  newPath: string,
): RvProject {
  const target = normalisePath(newPath);
  if (target === '') throw new Error('moveDocumentPath needs a destination path.');
  const documents = readDocuments(project) ?? [];
  const row = documents.find(d => d.id === id);
  if (!row) throw new Error(`No document with id "${id}" in this project.`);
  if (normalisePath(row.path) === target) return project;

  const occupant = documents.find(d => d !== row && normalisePath(d.path) === target);
  if (occupant) {
    throw new Error(
      `"${target}" is already taken by "${occupant.name}" — move or rename that one first.`,
    );
  }

  return {
    ...project,
    documents: documents.map(d => (d === row ? { ...d, path: target } : d)),
  };
}

// ─── Adopt: the one place a scan result becomes rows (plan-717 §2.2) ─────

/** How long a row may sit quarantined before the adopt verb drops it. */
export const ADOPT_QUARANTINE_MS = 15 * 60 * 1000;

/** File extensions the adopt verb recognises as a document. */
const ADOPTABLE_EXTENSIONS = ['.glb', '.gltf', '.splat', '.ksplat', '.ply'];

/**
 * True for a scanned path that may become a row.
 *
 * Two exclusions, both of them about not adopting our own bookkeeping: a
 * dot-segment is a private folder (`.thumbnails/`, `.trash/`), and anything
 * that is not an asset file is a sidecar — `library/library.json` is the one
 * that would otherwise show up as a document on the browser backend, where
 * every written blob lands in the same index.
 */
export function isAdoptablePath(path: string): boolean {
  const p = normalisePath(path);
  if (p === '') return false;
  if (p.split('/').some(seg => seg.startsWith('.'))) return false;
  const lower = p.toLowerCase();
  return ADOPTABLE_EXTENSIONS.some(ext => lower.endsWith(ext));
}

// ─── Sidecar ingestion (plan-717 §2.4, Phase 2) ─────────────────────────

/**
 * Manifest key recording that `library/library.json` has been drawn into the
 * rows (plan-717 §2.4).
 *
 * A FILE marker, like `rv-project/documents-migration` and for the same reason
 * spelt out there: what it marks travels — git, a zip, a customer delivery —
 * so a localStorage key would say "machine A already did this" while machine B
 * re-ran the ingestion against a sidecar that is no longer the truth.
 *
 * The value is the ingestion's schema version, `1`, and it is read tolerantly:
 * anything truthy means "this project has been through it".
 */
export const SIDECAR_MIGRATION_MARKER = 'rv-project/sidecar-migration';

/** What {@link SIDECAR_MIGRATION_MARKER} is written as. */
export const SIDECAR_MIGRATION_VERSION = 1;

/** True when this manifest records a completed sidecar ingestion. */
export function isSidecarMigrated(project: RvProject | null | undefined): boolean {
  return !!project?.[SIDECAR_MIGRATION_MARKER];
}

/** The two sidecar fields that have a home on the row. See {@link AdoptSidecarIngestion}. */
export interface AdoptSidecarMeta {
  collections?: string[];
  displayName?: string;
}

/**
 * A parsed `library.json`, keyed the way the manifest is (§2.4).
 *
 * Deliberately a plain shape rather than `LibrarySidecarV1`: this module owns
 * manifest rules and knows nothing about the library layer's file format, and
 * the adapter that re-keys library-relative paths to project-relative ones
 * lives over there (`library-sidecar-ingest.ts`) where the folder constant
 * already is.
 *
 * **Precedence, once and for all: the row wins, the sidecar fills gaps.** Two
 * metadata homes is the state this plan ends; a sidecar that could overwrite a
 * row would only move the ambiguity, not remove it.
 */
export interface AdoptSidecarIngestion {
  /** Metadata by PROJECT-relative path, e.g. `library/conveyor/belt.glb`. */
  entries: Record<string, AdoptSidecarMeta>;
  /** True when the manifest already carries {@link SIDECAR_MIGRATION_MARKER}. */
  migrated: boolean;
  /** Project-relative path of the sidecar file — the audit line's subject. */
  path: string;
}

/** One line of the adopt audit trail. Every write this verb makes has one. */
export interface AdoptLogEntry {
  kind: 'adopt' | 'move' | 'quarantine' | 'restore' | 'remove' | 'rehash' | 'discarded'
    | 'ingest';
  path: string;
  id?: string;
  /** Previous path, for a move. */
  from?: string;
  /** Why a delta was discarded, for `discarded`. */
  detail?: string;
}

/**
 * One decision the scan made, still to be merged into whatever manifest is
 * current at commit time.
 *
 * The delta is deliberately a list of *intents* rather than a finished
 * manifest: an adopt op carries no id, because the id is minted against the
 * FRESH state in {@link applyAdoptDelta} — which is the whole point of the
 * delta-merge commit (§2.2 step 5, R1-S1). A finished manifest computed here
 * would be exactly the stale snapshot the CAS retry must not re-write.
 */
export type AdoptOp =
  | {
    op: 'adopt';
    path: string;
    section: DocumentSection;
    name: string;
    sizeBytes?: number;
    mtimeMs?: number;
    sha256?: string;
    /** Ingested out of the sidecar (§2.4) — a brand-new row has no gap to lose. */
    collections?: string[];
  }
  | { op: 'move'; id: string; from: string; to: string; sizeBytes?: number; mtimeMs?: number; sha256?: string }
  | { op: 'stat'; id: string; path: string; sizeBytes?: number; mtimeMs?: number; sha256?: string }
  | { op: 'quarantine'; id: string; path: string; missingSince: string }
  | { op: 'restore'; id: string; path: string }
  | { op: 'remove'; id: string; path: string }
  /**
   * Fill an EXISTING row's gaps from the sidecar (§2.4). Never overwrites: the
   * gate is re-checked against the fresh manifest in {@link applyAdoptDelta},
   * so a value another tab wrote in the meantime survives.
   */
  | { op: 'meta'; id: string; path: string; collections?: string[]; name?: string }
  /** Record that the sidecar has been drawn in. Same commit as the rows (R1-S3). */
  | { op: 'sidecar-migrated'; path: string };

/** What the adopt verb needs from the world. No backend, no storage — see the file header. */
export interface AdoptSeams {
  /** What the backend says is actually stored, from `statDocuments()`. */
  stats: readonly DocumentStat[];
  /**
   * SHA-256 hex of the bytes at a path, or null when they cannot be read.
   *
   * Required for a folder project and the reason the R1-S2 blocker closed:
   * `FolderBackend.statDocuments()` reports size and mtime only, so without
   * this the move-match would be structurally dead for the main target group.
   * Called at most once per path per run, and only for a file that is either
   * being adopted, has changed since the last run, or is a size-matched move
   * candidate.
   */
  hashOf?: (path: string) => Promise<string | null>;
  /** Epoch ms. Injected by the tests; `Date.now` in production. */
  now?: () => number;
  /** Quarantine window. Defaults to {@link ADOPT_QUARANTINE_MS}. */
  quarantineMs?: number;
  /**
   * A parsed `library.json` to draw into the rows (§2.4), or absent.
   *
   * Absent covers three different situations and all three mean the same
   * thing here — do nothing: there is no sidecar, the backend is read-only, or
   * the file exists but could not be parsed. The last one is the case the
   * caller must NOT collapse into "empty": an unparseable sidecar is never
   * overwritten and never deleted, it is reported.
   */
  sidecar?: AdoptSidecarIngestion;
}

export interface AdoptScanResult {
  /** Empty when there is nothing to do — the caller must then not commit. */
  delta: AdoptOp[];
  /** Paths whose bytes were hashed in this run. Audit + the §9.1 measurement. */
  hashed: string[];
}

/**
 * Diff the files against the rows and say what should change (§2.2 steps 1-4).
 *
 * Nothing here writes: the result is a delta, and {@link applyAdoptDelta} is
 * what merges it into a manifest. Five decisions, in the order they are made:
 *
 *  1. **Path first.** A file with a row is settled; only the two mismatched
 *     sets — rows with no file, files with no row — are interesting.
 *  2. **Move-match by content, never by name.** A row whose file is gone is
 *     matched against the *unregistered* files by `sha256`, size-prefiltered so
 *     a hundred-file library does not hash a hundred files to find one rename.
 *     The match can only fire when the old position is EMPTY (git's
 *     diffcore-rename rule), which is what makes an external copy — where the
 *     original is still there — a new adoption rather than a merge of two
 *     documents into one identity.
 *  3. **Hash upkeep.** The digest is maintained on the row itself, computed
 *     once at adoption and afterwards only when `(size, mtime)` moved — the
 *     same pre-filter `reconcileClassificationCache` uses, for the same reason.
 *  4. **A missing row is quarantined, not deleted.** First run marks
 *     (`missingSince`), a later run removes, and only once the mark is older
 *     than the window. A file that comes back clears the mark and keeps its id
 *     and its collections.
 *  5. **Scenes are never orphan candidates.** That section is manifest-driven
 *     on every backend, and on the browser one its bodies are not blobs at all
 *     — every scene row would look missing to a stat list of blobs.
 *
 * An EMPTY stat list means "the scan learnt nothing" (a backend that cannot
 * stat, a revoked grant mid-scan), never "the project is empty": it returns an
 * empty delta rather than quarantining every row in the manifest.
 */
export async function adoptDiscoveredDocuments(
  project: RvProject | null | undefined,
  seams: AdoptSeams,
): Promise<AdoptScanResult> {
  const delta: AdoptOp[] = [];
  const hashed: string[] = [];
  const stats = (seams.stats ?? []).filter(s => s && typeof s.path === 'string');
  if (stats.length === 0) return { delta, hashed };

  const now = seams.now?.() ?? Date.now();
  const quarantineMs = seams.quarantineMs ?? ADOPT_QUARANTINE_MS;
  const rows = readDocuments(project) ?? [];

  const statByPath = new Map<string, DocumentStat>();
  for (const stat of stats) statByPath.set(normalisePath(stat.path), stat);
  const rowPaths = new Set(rows.map(r => normalisePath(r.path)));

  // Hashed at most once per path per run, whichever step asks first.
  const digests = new Map<string, string | null>();
  const digestOf = async (path: string, stat?: DocumentStat): Promise<string | null> => {
    if (stat?.sha256) return stat.sha256;
    if (digests.has(path)) return digests.get(path) ?? null;
    let sha: string | null = null;
    try {
      sha = (await seams.hashOf?.(path)) ?? null;
    } catch {
      sha = null;                       // unreadable is "no digest", never a throw
    }
    digests.set(path, sha);
    if (sha) hashed.push(path);
    return sha;
  };

  const unregistered = [...statByPath.entries()]
    .filter(([path]) => !rowPaths.has(path) && isAdoptablePath(path))
    .map(([path, stat]) => ({ path, stat }));
  const missing = rows.filter(
    r => sectionOfDocument(r) !== 'scenes' && !statByPath.has(normalisePath(r.path)),
  );

  // ── 2. Move-match ──
  const claimed = new Set<string>();
  const moved = new Set<string>();
  for (const row of missing) {
    const rowSha = typeof row.sha256 === 'string' && row.sha256 !== '' ? row.sha256 : null;
    // No digest on the row is not a failure and not a guess: the file is
    // simply un-matchable, so the row waits in quarantine and the new file is
    // adopted with an identity of its own (R1-T2).
    if (!rowSha) continue;
    for (const candidate of unregistered) {
      if (claimed.has(candidate.path)) continue;
      const sizeKnown = typeof row.sizeBytes === 'number' && typeof candidate.stat.size === 'number';
      if (sizeKnown && row.sizeBytes !== candidate.stat.size) continue;
      const sha = await digestOf(candidate.path, candidate.stat);
      if (!sha || sha !== rowSha) continue;
      claimed.add(candidate.path);
      moved.add(row.id);
      delta.push({
        op: 'move',
        id: row.id,
        from: normalisePath(row.path),
        to: candidate.path,
        ...statFields(candidate.stat, sha),
      });
      break;
    }
  }

  // ── 3. Adoption of what is left over ──
  const sidecarEntries = seams.sidecar?.entries ?? {};
  for (const candidate of unregistered) {
    if (claimed.has(candidate.path)) continue;
    const sha = await digestOf(candidate.path, candidate.stat);
    const meta = sidecarEntries[candidate.path];
    const stem = stemOf(candidate.path);
    delta.push({
      op: 'adopt',
      path: candidate.path,
      section: sectionOfPath(candidate.path),
      // A fresh row has no name to defend, so the sidecar's display name is
      // simply the better one — it is what the user saw before the upgrade.
      name: meta?.displayName?.trim() || stem,
      ...statFields(candidate.stat, sha),
      ...(meta?.collections?.length ? { collections: [...meta.collections] } : {}),
    });
  }

  // ── 3b. Hash upkeep + quarantine release for rows whose file is there ──
  for (const row of rows) {
    const path = normalisePath(row.path);
    const stat = statByPath.get(path);
    if (!stat) continue;
    if (typeof row.missingSince === 'string') {
      delta.push({ op: 'restore', id: row.id, path });
    }
    const shaKnown = !!stat.sha256 && row.sha256 === stat.sha256;
    const sizeKnown = typeof row.sizeBytes === 'number' && row.sizeBytes === stat.size;
    // A medium that reports no timestamp (`DocumentStat.mtime` is documented as
    // absent there) degrades the pre-filter to size alone rather than defeating
    // it: re-hashing every file on every run is the one outcome that would put
    // the follow-up run outside its budget, and the digest is a *matching
    // signal* for moves — a same-size in-place edit costs at worst a move that
    // is read as a fresh adoption.
    const mtimeKnown = stat.mtime === undefined
      || (typeof row.mtimeMs === 'number' && row.mtimeMs === stat.mtime);
    if (shaKnown || (sizeKnown && mtimeKnown && typeof row.sha256 === 'string')) continue;
    const sha = await digestOf(path, stat);
    const next = statFields(stat, sha);
    if (
      next.sizeBytes === row.sizeBytes
      && next.mtimeMs === row.mtimeMs
      && next.sha256 === row.sha256
    ) continue;                          // nothing learnt — keep the delta empty
    delta.push({ op: 'stat', id: row.id, path, ...next });
  }

  // ── 3c. Sidecar ingestion for rows that already exist (§2.4) ──
  //
  // The adoption above covered the files that had no row. What is left is the
  // library a customer has been using all along: rows exist, and the
  // collections they were filed under are still sitting in `library.json`.
  // Gaps only, and the gate is re-checked at merge time — this is a *proposal*,
  // not a decision.
  if (seams.sidecar) {
    for (const [path, meta] of Object.entries(sidecarEntries)) {
      const row = rows.find(r => normalisePath(r.path) === normalisePath(path));
      if (!row) continue;                 // an entry for a file that is gone
      const op: Extract<AdoptOp, { op: 'meta' }> = { op: 'meta', id: row.id, path: normalisePath(path) };
      if (meta.collections?.length && row.collections === undefined) {
        op.collections = [...meta.collections];
      }
      const displayName = meta.displayName?.trim();
      if (displayName && !hasAuthoredName(row)) op.name = displayName;
      if (op.collections || op.name) delta.push(op);
    }
    // Even a sidecar with nothing left to give gets the marker: it is what
    // makes the DELETE that follows the commit safe to repeat, and what tells
    // the read fallback it has been superseded.
    if (!seams.sidecar.migrated) {
      delta.push({ op: 'sidecar-migrated', path: seams.sidecar.path });
    }
  }

  // ── 4. Quarantine, then removal ──
  for (const row of missing) {
    if (moved.has(row.id)) continue;
    const path = normalisePath(row.path);
    const since = typeof row.missingSince === 'string' ? Date.parse(row.missingSince) : NaN;
    if (!Number.isFinite(since)) {
      delta.push({ op: 'quarantine', id: row.id, path, missingSince: new Date(now).toISOString() });
    } else if (now - since >= quarantineMs) {
      delta.push({ op: 'remove', id: row.id, path });
    }
  }

  return { delta, hashed };
}

/**
 * Does this row carry a name somebody chose, as opposed to the file stem?
 *
 * The one question the sidecar's `displayName` has to answer before it may be
 * used: a row whose name is just the stem was minted by a scan and has nothing
 * to lose, while a name that differs was typed by a user — in this build or an
 * older one — and outranks anything a sidecar remembers.
 */
function hasAuthoredName(row: RvDocumentEntry): boolean {
  const name = typeof row.name === 'string' ? row.name.trim() : '';
  return name !== '' && name !== stemOf(row.path);
}

/** The stat half of a row, with the fields the backend could not supply left off. */
function statFields(
  stat: DocumentStat,
  sha: string | null,
): { sizeBytes?: number; mtimeMs?: number; sha256?: string } {
  const out: { sizeBytes?: number; mtimeMs?: number; sha256?: string } = {};
  if (typeof stat.size === 'number') out.sizeBytes = stat.size;
  if (stat.mtime !== undefined) out.mtimeMs = stat.mtime;
  const digest = stat.sha256 ?? sha ?? undefined;
  if (digest) out.sha256 = digest;
  return out;
}

export interface AdoptApplyResult {
  /** The same object when nothing survived the merge — the caller can skip its write. */
  project: RvProject;
  log: AdoptLogEntry[];
  changed: boolean;
}

/**
 * Merge an adopt delta into whatever manifest is current (§2.2 step 5).
 *
 * This is the function `updateManifestCas` re-runs on every attempt, so it must
 * be correct against a manifest it has never seen — a second tab may have
 * adopted, moved or removed rows since the scan. Three invariants carry that:
 *
 *  - **One path, one row** (R2-F2). An adopt whose path is already owned is
 *    DISCARDED and logged, never added beside the existing row; a move onto an
 *    occupied path likewise loses. The rule is "the row that is already there
 *    wins", which is deterministic in both tabs and needs no ordering
 *    assumption — the external copy+delete window, where both paths exist for
 *    a moment, is exactly the case that makes commutativity untrue.
 *  - **The id is minted here, not at scan time.** Against the fresh manifest,
 *    with the same deterministic `#n` suffix `planDocument` uses when the
 *    path-derived id is already taken by a different path (R1-T6, both the
 *    against-existing-row and the intra-batch case — the second op of a batch
 *    sees the first one's row).
 *  - **Removal is conditional.** A row that lost its quarantine mark in the
 *    meantime (its file came back in another tab) is not removed.
 */
export function applyAdoptDelta(
  project: RvProject,
  delta: readonly AdoptOp[],
): AdoptApplyResult {
  const log: AdoptLogEntry[] = [];
  let next = project;
  let changed = false;

  const rowsOf = (p: RvProject) => readDocuments(p) ?? [];
  const patch = (p: RvProject, id: string, fn: (row: RvDocumentEntry) => RvDocumentEntry): RvProject =>
    ({ ...p, documents: rowsOf(p).map(d => (d.id === id ? fn(d) : d)) });

  for (const op of delta) {
    switch (op.op) {
      case 'adopt': {
        const occupant = findDocumentByPath(next, op.path);
        if (occupant) {
          log.push({
            kind: 'discarded', path: op.path, id: occupant.id,
            detail: 'a row already owns this path — the existing id wins',
          });
          break;
        }
        const extra: Partial<RvDocumentEntry> = { ...statFieldsOf(op) };
        if (op.collections?.length) extra.collections = [...op.collections];
        let id = previewAssetId(op.path);
        let minted: RvDocumentEntry | null = null;
        for (let n = 2; n <= 10; n++) {
          try {
            const result = mintAssetIdentity(next, {
              path: op.path, section: op.section, name: op.name, id, extra,
            });
            next = result.project;
            minted = result.entry;
            break;
          } catch (e) {
            if (!(e instanceof DocumentIdCollisionError)) throw e;
            id = previewAssetId(`${op.path}#${n}`);
          }
        }
        if (!minted) {
          log.push({ kind: 'discarded', path: op.path, detail: 'no free id after 9 attempts' });
          break;
        }
        changed = true;
        log.push({ kind: 'adopt', path: op.path, id: minted.id });
        break;
      }

      case 'move': {
        const row = findDocumentById(next, op.id);
        if (!row) {
          log.push({ kind: 'discarded', path: op.to, id: op.id, detail: 'the row is gone' });
          break;
        }
        const occupant = findDocumentByPath(next, op.to);
        if (occupant && occupant.id !== op.id) {
          log.push({
            kind: 'discarded', path: op.to, id: occupant.id,
            detail: `a row already owns this path — the move of "${op.id}" is dropped`,
          });
          break;
        }
        next = moveDocumentPath(next, op.id, op.to);
        next = patch(next, op.id, row2 => {
          const out = { ...row2, ...statFieldsOf(op) };
          delete out.missingSince;
          return out;
        });
        changed = true;
        log.push({ kind: 'move', path: op.to, from: op.from, id: op.id });
        break;
      }

      case 'stat': {
        const row = findDocumentById(next, op.id);
        if (!row || normalisePath(row.path) !== op.path) break;
        next = patch(next, op.id, row2 => ({ ...row2, ...statFieldsOf(op) }));
        changed = true;
        log.push({ kind: 'rehash', path: op.path, id: op.id });
        break;
      }

      case 'quarantine': {
        const row = findDocumentById(next, op.id);
        if (!row || normalisePath(row.path) !== op.path || row.missingSince) break;
        next = patch(next, op.id, row2 => ({ ...row2, missingSince: op.missingSince }));
        changed = true;
        log.push({ kind: 'quarantine', path: op.path, id: op.id, detail: op.missingSince });
        break;
      }

      case 'restore': {
        const row = findDocumentById(next, op.id);
        if (!row || !row.missingSince) break;
        next = patch(next, op.id, row2 => {
          const out = { ...row2 };
          delete out.missingSince;
          return out;
        });
        changed = true;
        log.push({ kind: 'restore', path: op.path, id: op.id });
        break;
      }

      case 'meta': {
        const row = findDocumentById(next, op.id);
        if (!row || normalisePath(row.path) !== op.path) break;
        // The gate is applied HERE, against the manifest as it is now — not
        // against the one the scan read. A second tab that set collections in
        // between must not be overwritten by a sidecar value this run planned
        // while the field was still empty.
        const fields: Partial<RvDocumentEntry> = {};
        if (op.collections && row.collections === undefined) fields.collections = [...op.collections];
        if (op.name && !hasAuthoredName(row)) fields.name = op.name;
        if (Object.keys(fields).length === 0) {
          log.push({
            kind: 'discarded', path: op.path, id: op.id,
            detail: 'the row already carries this metadata — the sidecar value is dropped',
          });
          break;
        }
        next = patch(next, op.id, row2 => ({ ...row2, ...fields }));
        changed = true;
        log.push({ kind: 'ingest', path: op.path, id: op.id, detail: Object.keys(fields).join('+') });
        break;
      }

      case 'sidecar-migrated': {
        if (isSidecarMigrated(next)) break;      // another tab got there first
        next = { ...next, [SIDECAR_MIGRATION_MARKER]: SIDECAR_MIGRATION_VERSION };
        changed = true;
        log.push({ kind: 'ingest', path: op.path, detail: 'sidecar migration marker' });
        break;
      }

      case 'remove': {
        const row = findDocumentById(next, op.id);
        if (!row || normalisePath(row.path) !== op.path) break;
        if (!row.missingSince) {
          log.push({
            kind: 'discarded', path: op.path, id: op.id,
            detail: 'the file is back — the removal is dropped',
          });
          break;
        }
        next = { ...next, documents: rowsOf(next).filter(d => d.id !== op.id) };
        changed = true;
        log.push({ kind: 'remove', path: op.path, id: op.id });
        break;
      }
    }
  }

  return { project: changed ? next : project, log, changed };
}

/** The `sizeBytes`/`mtimeMs`/`sha256` an op carries, without the undefined ones. */
function statFieldsOf(
  op: { sizeBytes?: number; mtimeMs?: number; sha256?: string },
): Partial<RvDocumentEntry> {
  const out: Partial<RvDocumentEntry> = {};
  if (op.sizeBytes !== undefined) out.sizeBytes = op.sizeBytes;
  if (op.mtimeMs !== undefined) out.mtimeMs = op.mtimeMs;
  if (op.sha256 !== undefined) out.sha256 = op.sha256;
  return out;
}
