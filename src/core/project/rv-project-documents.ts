// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-documents — the one list a project has (plan-413 §2.4 step B).
 *
 * ## The one list
 *
 * `models[]`, `scenes[]` and `library[]` were three names for the same thing:
 * a GLB the project owns. Since plan-397 they are literally the same bytes, and
 * the only surviving difference sits in the editing layer above — which is a
 * *role*, not a type. {@link RvDocumentEntry} is that one list.
 *
 * ## The three arrays are gone, and what replaced them
 *
 * Step A of §2.4 kept writing `scenes[]`/`models[]`/`library[]` as a derived
 * mirror, with a baseline fingerprint map so an older client's edit could be
 * folded back. That was transition scaffolding with a stated end: it came down
 * once the delivery pipeline read `documents[]` (phase 6 step 1, run 6). It is
 * down. `documents[]` is now the only list in the manifest — nothing derives
 * it, nothing derives from it on disk.
 *
 * What the ~80 places that used to read `project.scenes` read instead is
 * {@link sceneDocumentsOf} / {@link assetDocumentsOf} — projections computed at
 * the read site, over the one list. A projection and a mirror look similar and
 * are not the same thing: a projection cannot go stale, cannot disagree with
 * its source, and cannot be edited behind the source's back. That is why the
 * baseline and the three-way merge went with the mirror rather than following
 * it into a new home.
 *
 * A client older than this build that opens such a project sees no scenes and,
 * if it saves, writes a manifest this build then refuses (F10). That is the
 * documented consequence of ending the mirror, not an oversight — the forward
 * direction is still carried by {@link migrateProjectDocuments}, which builds
 * `documents[]` out of whatever legacy arrays a stored manifest still has.
 *
 * ## What is deliberately NOT here
 *
 * No storage, no backend, no React. This module is pure data: given manifests
 * and lists it returns manifests and lists.
 */

import {
  classificationEquals,
  parseClassification,
  type DocumentClassification,
} from './rv-document-classification';
import {
  assetEntryKey,
  type RvDocumentEntry,
  type RvProject,
  type RvProjectAssetEntry,
  type RvProjectSceneEntry,
} from './rv-project-types';

// ─── Sections ───────────────────────────────────────────────────────────

/**
 * Which storage surface holds a document's bytes.
 *
 * Not transition bookkeeping — it outlived the mirror on purpose (run 6). A
 * `scenes` document is read and written through `readScene`/`writeScene` with
 * the compare-and-swap of §2.8; a `models`/`library` document is a plain blob.
 * It is *stored* rather than inferred because the only other candidate — the
 * path prefix — is wrong for the browser backend, where a scene's path is its
 * bare id and every path heuristic would file it under `library`.
 */
export type DocumentSection = 'scenes' | 'models' | 'library';

/** All sections, in the order a listing enumerates them. */
export const DOCUMENT_SECTIONS: readonly DocumentSection[] =
  ['scenes', 'models', 'library'] as const;

/** True for a value this build recognises as a section. */
export function isDocumentSection(value: unknown): value is DocumentSection {
  return typeof value === 'string' && (DOCUMENT_SECTIONS as readonly string[]).includes(value);
}

/**
 * The section a document belongs to.
 *
 * Recorded value first; for a foreign manifest that has `documents[]` without
 * our bookkeeping, the path prefix is the honest guess, and `library` is the
 * fallback — a document of unknown provenance is a referenceable artefact, not
 * something we would open on a click.
 */
export function sectionOfDocument(entry: RvDocumentEntry): DocumentSection {
  if (isDocumentSection(entry.section)) return entry.section;
  const path = typeof entry.path === 'string' ? entry.path : '';
  if (/^scenes\//i.test(path) || /\.scene\.(glb|json)$/i.test(path)) return 'scenes';
  if (/^models\//i.test(path)) return 'models';
  return 'library';
}

// ─── Keys and ids ───────────────────────────────────────────────────────

/**
 * The key a document is addressed by inside its section.
 *
 * Same rule as {@link assetEntryKey} — id when it has one, path otherwise — so
 * an entry that gains an id keeps answering to the same question it did before.
 * The section is part of the key because `models/a.glb` and `library/a.glb` are
 * two documents.
 */
export function sectionKeyOf(
  section: DocumentSection,
  entry: { id?: unknown; path?: unknown },
): string {
  const id = typeof entry.id === 'string' ? entry.id.trim() : '';
  const path = typeof entry.path === 'string' ? entry.path : '';
  return `${section}:${id !== '' ? id : path}`;
}

/** The key of a document entry. */
export function documentKeyOf(entry: RvDocumentEntry): string {
  return sectionKeyOf(sectionOfDocument(entry), entry);
}

/**
 * Mint a document id for a genuinely new document. Random, like every other id
 * in this codebase — two documents created a millisecond apart are two
 * documents.
 */
export function newDocumentId(): string {
  return 'doc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/**
 * The id an id-less legacy entry is migrated to — **derived from its path, not
 * minted**.
 *
 * Randomness would be wrong here in two ways that only show up later:
 *
 *  1. `readManifest()` runs the migration on every read (doc-persistence §13.3:
 *     the migrator belongs in the reader, not at the call sites). A random id
 *     would make `listDocuments()` return different ids on two consecutive
 *     calls of the same unchanged manifest — and a list whose identities move
 *     under it is a list nothing can select in.
 *  2. A project travels. Two machines opening the same git repo before either
 *     has saved would mint two different ids for the same file, and the first
 *     save to land would silently re-key the other's references.
 *
 * Path-derived, it is the same answer everywhere, every time, and it is legible
 * in a git diff. The hash suffix carries the uniqueness that the truncated slug
 * cannot, so two deeply-nested paths sharing a prefix stay distinct.
 */
export function stableDocumentId(path: string): string {
  const clean = (path ?? '').trim();
  const slug = clean
    .toLowerCase()
    .replace(/\.(scene\.)?(glb|gltf|json|splat|ksplat|ply)$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `doc_${slug || 'unnamed'}_${fnv32(clean).toString(36)}`;
}

/** Non-cryptographic 32-bit hash. Uniqueness suffix only — never a revision. */
function fnv32(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// ─── Projection: legacy entry → document ────────────────────────────────

/** Display name for an asset entry that has no name field of its own. */
function assetNameOf(entry: RvProjectAssetEntry): string {
  const label = typeof entry.label === 'string' ? entry.label.trim() : '';
  if (label !== '') return label;
  const path = typeof entry.path === 'string' ? entry.path : '';
  const file = path.split('/').filter(Boolean).pop() ?? path;
  return file.replace(/\.(scene\.)?(glb|gltf|json|splat|ksplat|ply)$/i, '') || path;
}

/**
 * Lift a legacy scene entry into a document.
 *
 * Everything the entry carried survives verbatim — including unknown fields, on
 * which the whole forward-compatibility contract of this manifest rests.
 */
export function documentOfSceneEntry(
  entry: RvProjectSceneEntry,
  mintId: (entry: { path: string }) => string = e => stableDocumentId(e.path),
): RvDocumentEntry {
  const id = typeof entry.id === 'string' && entry.id.trim() !== '' ? entry.id : mintId(entry);
  const name = typeof entry.name === 'string' && entry.name !== ''
    ? entry.name
    : assetNameOf(entry as unknown as RvProjectAssetEntry);
  return { ...entry, id, name, path: entry.path, section: 'scenes' };
}

/**
 * Lift a legacy `models[]` / `library[]` entry into a document.
 *
 * `name` follows the same precedence the scene branch has always had (own name
 * first, derived second) since plan-717: once every file carries an authored
 * row, the row's name is a user decision and re-deriving it from the filename
 * would silently undo a rename. For an entry that has no name — a bare
 * `{ path }` straight off a folder scan — nothing changes.
 */
export function documentOfAssetEntry(
  entry: RvProjectAssetEntry,
  section: Exclude<DocumentSection, 'scenes'>,
  mintId: (entry: { path: string }) => string = e => stableDocumentId(e.path),
): RvDocumentEntry {
  const id = typeof entry.id === 'string' && entry.id.trim() !== '' ? entry.id : mintId(entry);
  const own = typeof entry.name === 'string' ? entry.name.trim() : '';
  return { ...entry, id, name: own !== '' ? own : assetNameOf(entry), path: entry.path, section };
}

// ─── Fingerprints ───────────────────────────────────────────────────────

/**
 * SHA-256 hex of a string — the manifest's compare-and-swap token.
 *
 * Its own five lines rather than an import from `rv-scene-record`: a manifest
 * revision is a property of the *manifest* contract, and the scene-body module
 * lost its text half when the JSON reader went. A hash with no `crypto.subtle`
 * available (a non-secure context) degrades to a length-and-content marker — a
 * weaker fingerprint is still a fingerprint, whereas throwing would make the
 * project unopenable over a bookkeeping detail.
 */
export async function fingerprintOf(text: string): Promise<string> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
    return `fnv:${text.length.toString(36)}:${h.toString(16)}`;
  }
}

// ─── Reading the one list ───────────────────────────────────────────────

/**
 * The manifest's `documents[]`, or null when the project has none.
 *
 * A **filter**, not a parser: an unknown field written by a newer client rides
 * through untouched, which is the forward-compatibility contract the index
 * signature states. The two typed fields plan-717 added are the exception, and
 * only in the narrow sense that a malformed value is *dropped* rather than
 * handed on as if it type-checked — `collections: "Conveyors"` would otherwise
 * reach a `.map()` as a string. The row object is rebuilt only when something
 * actually had to be dropped, so the common path allocates nothing.
 */
export function readDocuments(project: RvProject | null | undefined): RvDocumentEntry[] | null {
  const raw = project?.documents;
  if (!Array.isArray(raw)) return null;
  return raw
    .filter(
      (e): e is RvDocumentEntry =>
        !!e && typeof e === 'object' && !Array.isArray(e) && typeof (e as RvDocumentEntry).path === 'string',
    )
    .map(sanitiseDocumentFields);
}

/** Drop a `collections`/`missingSince` this build cannot honour. See {@link readDocuments}. */
function sanitiseDocumentFields(entry: RvDocumentEntry): RvDocumentEntry {
  const collectionsOk = entry.collections === undefined
    || (Array.isArray(entry.collections) && entry.collections.every(c => typeof c === 'string'));
  const missingSinceOk = entry.missingSince === undefined || typeof entry.missingSince === 'string';
  if (collectionsOk && missingSinceOk) return entry;
  const out = { ...entry };
  if (!collectionsOk) delete out.collections;
  if (!missingSinceOk) delete out.missingSince;
  return out;
}

/** The manifest's `documents[]`, empty when it has none. */
export function documentsOf(project: RvProject | null | undefined): RvDocumentEntry[] {
  return readDocuments(project) ?? [];
}

/**
 * The document a start-document reference names, or null (plan-726 F12).
 *
 * ## Why this is a function and not three inline `find`s
 *
 * `settings.defaultModel` is matched LITERALLY today, at two call sites that
 * each spelled the same rule out by hand (`main.ts`, `ProjectsDashboardHost`).
 * plan-726 adds a third — the non-kiosk boot — and three copies of a matching
 * rule is how the three answers start to differ.
 *
 * ## Why it is tolerant, and exactly how far
 *
 * `settings.defaultModel` is authored by a human or written by a deploy script,
 * while `documents[].path` is a project-relative path. Five delivered customer
 * manifests (`Toray`, `festo`, `mauser3dhmi`, `wmyb`, `demo-process-industry`)
 * carry a BARE FILENAME there against a `models/`-prefixed path. That is
 * harmless today only because nothing consumes the `defaultModel` branch on the
 * unlocked boot; the moment it is consumed, those five projects would open and
 * show an empty scene. Correcting the manifests would not help — the deploys
 * already shipped carry the old value.
 *
 * So the fallback exists, and it is deliberately the narrowest one that covers
 * the real data:
 *
 *  1. an exact `path` match — **always wins**, so a project that spells the
 *     reference out correctly can never be redirected by a coincidence;
 *  2. an exact `id` match — a remembered pair may hold either spelling;
 *  3. the file name, and **only when exactly one document carries it**. Two
 *     documents named `Line.glb` in different folders is an ambiguous
 *     reference, and guessing between them would be worse than the null: null
 *     falls through to the caller's existing fallback, a wrong guess opens the
 *     wrong machine.
 */
export function findStartDocument(
  source: RvProject | readonly RvDocumentEntry[] | null | undefined,
  asset: string | null | undefined,
): RvDocumentEntry | null {
  const wanted = typeof asset === 'string' ? asset.trim() : '';
  if (wanted === '') return null;
  const documents: readonly RvDocumentEntry[] = Array.isArray(source)
    ? source
    : documentsOf(source as RvProject | null | undefined);

  const byPath = documents.find(d => d.path === wanted);
  if (byPath) return byPath;
  const byId = documents.find(d => d.id === wanted);
  if (byId) return byId;

  // Only a bare name may be resolved leniently. A reference that already names
  // a folder said where it meant, and answering it with a file from somewhere
  // else would be the guess this fallback exists to avoid.
  if (wanted.includes('/') || wanted.includes('\\')) return null;
  const matches = documents.filter(d => fileNameOf(d.path) === wanted);
  return matches.length === 1 ? matches[0]! : null;
}

/** The last path segment of a project-relative path. */
function fileNameOf(path: unknown): string {
  const text = typeof path === 'string' ? path : '';
  return text.split(/[\\/]/).filter(Boolean).pop() ?? '';
}

/** Every document of one section, in manifest order. */
export function documentsInSection(
  project: RvProject | null | undefined,
  section: DocumentSection,
): RvDocumentEntry[] {
  return documentsOf(project).filter(doc => sectionOfDocument(doc) === section);
}

/**
 * The scene documents of a project, typed as the scene entries every consumer
 * downstream still speaks.
 *
 * A **projection, not a mirror** — computed here, at the read, out of the one
 * list, and never written anywhere. The cast is sound rather than convenient:
 * `RvDocumentEntry` requires `id`, `name` and `path`, which is exactly what
 * `RvProjectSceneEntry` requires, and both carry the same index signature. The
 * extra fields a document has (`classification`, `section`) travel along, which
 * is what lets a consumer that has learnt about them use them without a second
 * lookup.
 */
export function sceneDocumentsOf(
  project: RvProject | null | undefined,
): RvProjectSceneEntry[] {
  return documentsInSection(project, 'scenes') as unknown as RvProjectSceneEntry[];
}

/** The `models[]` / `library[]` documents of a project, as asset entries. */
export function assetDocumentsOf(
  project: RvProject | null | undefined,
  section: Exclude<DocumentSection, 'scenes'>,
): RvProjectAssetEntry[] {
  return documentsInSection(project, section) as unknown as RvProjectAssetEntry[];
}

/**
 * Give a FOREIGN manifest its `documents[]` before anything reads it.
 *
 * The folder backend gets this for free: `readManifest()` runs the conversion
 * (and refuses what it cannot convert). Two backends do not — the bundled one
 * reads a deploy's `project.json` over `fetch`, and the browser one reads a
 * manifest an older build of this very app may have stored. Both would
 * otherwise show an empty project for a manifest that is merely unconverted.
 *
 * So this is the same read-side fallback the delivery pipeline keeps for an
 * unmigrated customer (run 6): derive from the legacy arrays when there is no
 * document list, and drop the arrays either way so nothing downstream can read
 * a second, older answer to the same question. It mints no marker and writes
 * nothing — a derivation, not a migration.
 */
export function withDerivedDocuments(project: RvProject): RvProject;
export function withDerivedDocuments(project: RvProject | null | undefined): RvProject | null;
export function withDerivedDocuments(project: RvProject | null | undefined): RvProject | null {
  if (!project) return null;
  if (readDocuments(project)) return withoutLegacyArrays(project);
  const legacy = project as { scenes?: unknown; models?: unknown; library?: unknown };
  const listOf = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
  return {
    ...withoutLegacyArrays(project),
    documents: documentsFromLists({
      scenes: listOf<RvProjectSceneEntry>(legacy.scenes),
      models: listOf<RvProjectAssetEntry>(legacy.models),
      library: listOf<RvProjectAssetEntry>(legacy.library),
    }),
  };
}

/**
 * Drop what a pre-phase-6 manifest carried and this build no longer maintains.
 *
 * Called once, on the way to disk. The three arrays are not "left alone out of
 * politeness": leaving them would leave a *stale* copy of the document list in
 * every saved manifest, and a stale copy is worse than none — the presence of a
 * legacy array has to mean "nobody has converted this yet", not "here is what
 * the list looked like some saves ago".
 *
 * plan-703 phase 9 completed the Node half: the delivery pipeline no longer
 * keeps a private `scenes[]` fallback (that sentence used to stand here and is
 * now wrong). It derives once, at its own read boundary — `loadProject()` in
 * `scripts/_bunny-lib.mjs`, via the Node twins in `scripts/_rv-manifest.mjs` —
 * so the meaning of a leftover array is the same on both sides of the fence.
 */
export function withoutLegacyArrays(project: RvProject): RvProject {
  const out: Record<string, unknown> = { ...(project as Record<string, unknown>) };
  for (const key of DOCUMENT_SECTIONS) delete out[key];
  delete out.documentsBaseline;
  return out as RvProject;
}

// ─── Display list (backend listing) ─────────────────────────────────────

/**
 * The list a backend hands out, built from what it actually has.
 *
 * Not the same thing as the manifest's `documents[]`, and the difference is
 * deliberate. A folder project is **folder-driven** for models and library —
 * dropping `Machine.glb` into `models/` *is* the act of adding it — so the
 * listing has to start from the files and use the manifest as a metadata
 * overlay. The manifest's `documents[]`, by contrast, is derived from and
 * mirrored back into the manifest arrays only, so a folder scan never rewrites
 * a customer's `project.json` with fifty entries it never asked for.
 */
export function documentsFromLists(
  lists: {
    scenes?: readonly RvProjectSceneEntry[];
    models?: readonly RvProjectAssetEntry[];
    library?: readonly RvProjectAssetEntry[];
  },
  declared: readonly RvDocumentEntry[] = [],
  mintId: (entry: { path: string }) => string = e => stableDocumentId(e.path),
): RvDocumentEntry[] {
  const overlay = new Map<string, RvDocumentEntry>();
  for (const doc of declared) {
    if (!doc || typeof doc !== 'object') continue;
    overlay.set(sectionKeyOf(sectionOfDocument(doc), doc), doc);
  }

  const out: RvDocumentEntry[] = [];
  for (const entry of lists.scenes ?? []) {
    if (!entry || typeof entry.path !== 'string') continue;
    const key = sectionKeyOf('scenes', entry);
    const base = documentOfSceneEntry(entry, mintId);
    const known = overlay.get(key);
    out.push(known ? { ...known, ...base, classification: known.classification } : base);
  }
  for (const section of ['models', 'library'] as const) {
    for (const entry of lists[section] ?? []) {
      if (!entry || typeof entry.path !== 'string') continue;
      const key = sectionKeyOf(section, entry);
      const base = documentOfAssetEntry(entry, section, mintId);
      const known = overlay.get(key);
      out.push(known ? { ...known, ...base, classification: known.classification } : base);
    }
  }
  return out;
}

// ─── Scan reconciliation (§2.5 — the file wins) ─────────────────────────

/**
 * What a backend can cheaply say about a stored document.
 *
 * `sha256` is the third option and the best one where it exists for free: the
 * browser backend stores bodies content-addressed, so an unchanged digest is
 * proof of unchanged bytes — stronger than `(size, mtime)`, which is a heuristic
 * that a copy or a restore defeats. Backends offer whichever of the three they
 * have; the pre-filter clears on any of them.
 */
export interface DocumentStat {
  path: string;
  size: number;
  /** Epoch milliseconds. Absent where the medium has no reliable timestamp. */
  mtime?: number;
  /** Content digest, where the medium is content-addressed. */
  sha256?: string;
}

export interface ClassificationScanResult {
  documents: RvDocumentEntry[];
  /** Paths whose bytes had to be read because the pre-filter did not clear them. */
  read: string[];
  /** Paths whose cached classification disagreed with the file and was replaced. */
  changed: string[];
}

/**
 * Bring the manifest's classification cache back in line with the files.
 *
 * Two rules, both from §2.5:
 *
 *  1. **`(size, mtime)` pre-filter.** An entry whose recorded size and mtime
 *     still match what the backend reports is not read at all. A scan over a
 *     hundred unchanged documents performs zero GLB reads — which is the only
 *     reason a scan can run on every open.
 *  2. **The GLB wins, always.** Where the two disagree the manifest is
 *     *replaced*, never merged. The cache is derivable by definition; treating
 *     it as half of a negotiation is how a stale cache outlives the file that
 *     contradicts it. This also means a GLB copied into the folder from outside
 *     shows up with the classification it brought with it.
 *
 * `readClassification` returns `null` both for "no classification in this file"
 * and for "could not read it". The two are the same answer here — an
 * unclassified document — and distinguishing them would only produce a warning
 * nobody can act on.
 */
export async function reconcileClassificationCache(
  documents: readonly RvDocumentEntry[],
  seams: {
    stats: readonly DocumentStat[];
    readClassification: (path: string) => Promise<DocumentClassification | null>;
  },
): Promise<ClassificationScanResult> {
  const statByPath = new Map<string, DocumentStat>();
  for (const s of seams.stats) if (s && typeof s.path === 'string') statByPath.set(s.path, s);

  const out: RvDocumentEntry[] = [];
  const read: string[] = [];
  const changed: string[] = [];

  for (const doc of documents) {
    const stat = statByPath.get(doc.path);
    if (!stat) {
      // Not scannable (bundled/HTTP, or a file the backend cannot stat). The
      // manifest is authoritative there by definition — see §2.5.
      out.push(doc);
      continue;
    }
    const shaKnown = !!stat.sha256 && doc.sha256 === stat.sha256;
    const sizeKnown = typeof doc.sizeBytes === 'number' && doc.sizeBytes === stat.size;
    const mtimeKnown = typeof doc.mtimeMs === 'number' && stat.mtime !== undefined
      && doc.mtimeMs === stat.mtime;
    if (shaKnown || (sizeKnown && mtimeKnown)) {
      out.push(doc);
      continue;
    }

    read.push(doc.path);
    const fromFile = await seams.readClassification(doc.path).catch(() => null);
    const next: RvDocumentEntry = { ...doc, sizeBytes: stat.size };
    if (stat.mtime !== undefined) next.mtimeMs = stat.mtime;
    if (stat.sha256 !== undefined) next.sha256 = stat.sha256;
    if (!classificationEquals(doc.classification, fromFile)) {
      if (fromFile) next.classification = fromFile;
      else delete next.classification;
      changed.push(doc.path);
    }
    out.push(next);
  }

  return { documents: out, read, changed };
}

/**
 * Read a classification out of a parsed glTF JSON chunk.
 *
 * Kept here so a backend can implement `readClassification` without pulling in
 * the whole GLB read path; the canonical default-scene rule (`json.scene ?? 0`,
 * SOL R1-8) is applied exactly once, right here.
 */
export function classificationOfGltfJson(json: unknown): DocumentClassification | null {
  if (!json || typeof json !== 'object') return null;
  const doc = json as { scene?: unknown; scenes?: unknown };
  const scenes = Array.isArray(doc.scenes) ? doc.scenes : [];
  const index = typeof doc.scene === 'number' ? doc.scene : 0;
  const scene = scenes[index] as { extras?: unknown } | undefined;
  const extras = scene?.extras as { realvirtual?: unknown } | undefined;
  return parseClassification(extras?.realvirtual);
}

/**
 * Read a classification out of a GLB **without reading the GLB**.
 *
 * Two slices, twenty bytes and then the JSON chunk — the BIN tail, which is all
 * of the size, is never touched. `Blob.slice()` is lazy over a `File`, so on the
 * folder backend this genuinely reads a few kilobytes off disk rather than a
 * hundred megabytes into memory, which is the difference between a scan that can
 * run on every open and one that cannot.
 *
 * Anything that is not a GLB, or is a truncated one, yields `null`. A malformed
 * file is an unclassified document — never an exception (F5).
 */
export async function classificationOfGlbBlob(
  blob: Blob,
): Promise<DocumentClassification | null> {
  try {
    const head = new DataView(await blob.slice(0, 20).arrayBuffer());
    if (head.byteLength < 20) return null;
    if (head.getUint32(0, true) !== 0x46546c67) return null;      // 'glTF'
    const jsonLength = head.getUint32(12, true);
    if (head.getUint32(16, true) !== 0x4e4f534a) return null;      // 'JSON'
    if (jsonLength <= 0 || jsonLength > 64 * 1024 * 1024) return null;
    const bytes = await blob.slice(20, 20 + jsonLength).arrayBuffer();
    return classificationOfGltfJson(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
}

// ─── Convenience ────────────────────────────────────────────────────────

// ─── Identity across sources (plan-413 §2.7, phase 5) ───────────────────

/** One document id that more than one source claims. */
export interface DocumentIdCollision {
  id: string;
  /** `sourceId` of every source listing it, in the order they were scanned. */
  sources: string[];
  /** The path each of those sources has it at, index-aligned with `sources`. */
  paths: string[];
}

/**
 * Report document ids that appear in more than one source.
 *
 * This is the scan half of the move contract (§2.7). A move keeps the id, so
 * between "the copy arrived" and "the original row is gone" two sources
 * legitimately claim it — and if the second step fails, they keep claiming it.
 * The resolver stays first-source-wins throughout, which is a defensible answer
 * to "which one?" but not to "why are there two?"; this is what can say the
 * latter.
 *
 * A source listing the same id twice is a collision too, and worth reporting
 * for the same reason: one of the two rows is stale bookkeeping.
 */
export function findDocumentIdCollisions(
  sources: readonly { sourceId: string; documents: readonly RvDocumentEntry[] }[],
): DocumentIdCollision[] {
  const seen = new Map<string, { sources: string[]; paths: string[] }>();
  for (const { sourceId, documents } of sources) {
    for (const doc of documents) {
      const id = typeof doc?.id === 'string' ? doc.id.trim() : '';
      if (id === '') continue;
      const hit = seen.get(id) ?? { sources: [], paths: [] };
      hit.sources.push(sourceId);
      hit.paths.push(typeof doc.path === 'string' ? doc.path : '');
      seen.set(id, hit);
    }
  }
  const out: DocumentIdCollision[] = [];
  for (const [id, hit] of seen) {
    if (hit.sources.length > 1) out.push({ id, sources: hit.sources, paths: hit.paths });
  }
  return out;
}

/** Every distinct tag used by a document list, sorted — the autocomplete source. */
export function collectDocumentTags(documents: readonly RvDocumentEntry[]): string[] {
  const seen = new Set<string>();
  for (const doc of documents) {
    for (const tag of doc.classification?.tags ?? []) seen.add(tag);
  }
  return [...seen].sort();
}

/** Re-export so callers do not have to know both key helpers exist. */
export { assetEntryKey };
