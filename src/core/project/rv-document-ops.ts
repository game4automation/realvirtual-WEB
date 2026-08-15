// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-document-ops — create, duplicate and retire a GLB DOCUMENT (plan-716 §2.5,
 * F5).
 *
 * Phase 3 leaves exactly one save path, and that path needs somewhere to put a
 * workspace that does not have a document yet: the first save of a draft, a
 * `saveAs`, a "New". Those three used to mint a `scn_` id and a catalogue row.
 * They now do what every other artefact in the product does — write a file into
 * the project and add a `documents[]` row — and this module is the one place
 * that knows how.
 *
 * ## Why it is not in the SceneStore
 *
 * Three of the four verbs here have nothing to do with an open workspace
 * (`duplicateDocument`, `retireDocument`, and `planDocument` on behalf of the
 * dashboard), and the fourth is called from a method that is already the
 * longest in that file. Keeping them out also makes them testable without a
 * viewer, which is what §9.3 asks of `saveAs`/`duplicate`/`delete`.
 *
 * ## Two manifests, one write
 *
 * A row has to reach BOTH halves of the project's memory, and they are written
 * differently on purpose:
 *
 *  - `ProjectStore.replaceManifest()` updates the in-memory manifest (so the
 *    dashboard re-renders) and, for a FOLDER project, writes `project.json`
 *    through the CAS wrapper;
 *  - `BrowserBackend.writeManifest()` is the only durable store a BROWSER
 *    project has, and `ProjectStore` never calls it.
 *
 * {@link commitDocuments} does both, in that order, and tolerates a backend
 * that has neither — a bundled/read-only project refuses long before this.
 *
 * ## Create-only, never overwrite
 *
 * Every blob write here passes `expectedRevision: null`. That is the mode the
 * CAS contract calls "copy in, never overwrite"
 * (write-blob-cas.contract.test.ts:164), and it is what makes the name probe
 * below a guarantee rather than an optimistic guess: if the probe and the write
 * disagree — another tab created the same name in between — the write is
 * REFUSED instead of silently replacing somebody's file.
 */

import type { ProjectBackend } from './backends/project-backend';
import type { RvDocumentEntry, RvProject } from './rv-project-types';
import {
  documentsOf,
  sectionOfDocument,
  stableDocumentId,
  type DocumentSection,
} from './rv-project-documents';

/**
 * Where a document is placed when the caller names no folder: the project ROOT.
 *
 * It was `'scenes'` until plan-716/717's model was carried all the way through
 * the storage layer. That default was the last place the old three-section
 * layout could still assert itself without anybody choosing it — a save with no
 * folder in view, a create outside the project tree, a rename of a document
 * whose path names nothing — and each of those quietly filed a document under a
 * section that no longer means anything. The root is the honest answer: it is
 * the project, undivided, and every other folder is now something the user
 * asked for by standing in it.
 */
export const DEFAULT_DOCUMENT_FOLDER = '';

/** Where a retired document's bytes go. Never a hard delete (plan-716 R1-I1). */
export const DOCUMENT_TRASH_FOLDER = '.trash';

/** The identity of a document, as every caller here hands it back. */
export interface DocumentTarget {
  documentId: string;
  relPath: string;
  name: string;
}

/** Anything with the browser backend's manifest writer. Duck-typed on purpose. */
type ManifestWriting = { writeManifest(project: RvProject): Promise<void> };

/** The half of `ProjectStore` this module uses. Narrow so tests can fake it. */
export interface DocumentManifestHost {
  getProject(): RvProject | null;
  getBackend(): ProjectBackend | null;
  replaceManifest(next: RvProject): Promise<void>;
}

// ─── Naming ─────────────────────────────────────────────────────────────

/** A display name → a safe GLB file stem. Same rule as the migration's. */
export function safeDocumentFileName(raw: string): string {
  return (raw ?? '')
    .trim()
    .replace(/\.(scene\.)?glb$/i, '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 80)
    .trim();
}

function normalisePath(path: string): string {
  return (path ?? '').trim().replace(/^\/+/, '').toLowerCase();
}

/**
 * Pick a free name, path and id for a NEW document.
 *
 * The probe asks two sources, and both are needed. The manifest answers "is
 * this name already a row?"; the backend answers "are there already bytes
 * there?" — which is the state an interrupted create leaves behind, and the one
 * a create-only write would otherwise refuse forever.
 *
 * Deterministic given the same inputs: "Line", "Line 2", "Line 3" — the pattern
 * `createEmptyAsset` established and the migration reuses (§2.3c).
 *
 * ## `exclude`, and why a rename needs it (plan-717 §2.7)
 *
 * A RENAME plans a destination for a document that already occupies a path, and
 * that path is legitimately reusable by the very document being renamed:
 * renaming a row whose display name drifted from its file stem back onto the
 * stem must land on the stem, not on "<stem> 2". `exclude` is that one path the
 * probe treats as free — in the manifest and on the backend alike, because the
 * bytes sitting there are the ones about to move.
 */
export async function planDocument(
  backend: ProjectBackend,
  project: RvProject | null,
  rawName: string,
  opts: { folder?: string; section?: DocumentSection; exclude?: string } = {},
): Promise<DocumentTarget> {
  // An EMPTY folder is the project root, and so is an absent one — the two
  // agree since the default became the root, which is why nothing here has to
  // tell "in the root" apart from "unspecified" any more.
  const folder = opts.folder ?? DEFAULT_DOCUMENT_FOLDER;
  const prefix = folder === '' ? '' : `${folder}/`;
  const base = safeDocumentFileName(rawName) || 'Untitled';
  const exclude = opts.exclude === undefined ? null : normalisePath(opts.exclude);
  const taken = new Set(
    documentsOf(project).map(d => normalisePath(d.path)).filter(p => p !== exclude),
  );

  let name = base;
  let relPath = `${prefix}${name}.glb`;
  for (let n = 2; ; n++) {
    if (!taken.has(normalisePath(relPath))) {
      const stored = normalisePath(relPath) === exclude
        ? null
        : await backend.readBlobBytes(relPath).catch(() => null);
      if (!stored) break;
    }
    name = `${base} ${n}`;
    relPath = `${prefix}${name}.glb`;
  }

  const takenIds = new Set(documentsOf(project).map(d => d.id));
  let documentId = stableDocumentId(relPath);
  for (let n = 2; takenIds.has(documentId); n++) documentId = stableDocumentId(`${relPath}#${n}`);

  return { documentId, relPath, name };
}

// ─── Manifest ───────────────────────────────────────────────────────────

/**
 * Write `documents` into both halves of the project's memory.
 *
 * Best-effort on the durable half and NEVER on the in-memory half: a row the
 * dashboard cannot see is a document the user cannot find, while a manifest
 * that fails to reach disk is repaired by the next successful write (and by
 * `listDocuments()`, which re-derives from the storage index).
 */
export async function commitDocuments(
  host: DocumentManifestHost,
  documents: readonly RvDocumentEntry[],
): Promise<void> {
  const project = host.getProject();
  if (!project) return;
  const next = { ...project, documents: [...documents] } as RvProject;
  await host.replaceManifest(next);
  const backend = host.getBackend() as (ProjectBackend & Partial<ManifestWriting>) | null;
  if (typeof backend?.writeManifest === 'function') {
    try {
      await backend.writeManifest(next);
    } catch (e) {
      console.warn('[document-ops] the manifest could not be stored:', e);
    }
  }
}

/**
 * The row a freshly placed document gets.
 *
 * `section` is DERIVED from the target path rather than fixed at `'scenes'`
 * (plan-717 F7). Since Phase 3 this function serves every create — the "New"
 * button now places a document into whatever folder is in view, and a library
 * asset stamped `section: 'scenes'` would sort itself into the wrong half of
 * every listing that groups by section. `sectionOfDocument` is the same rule the
 * scan applies, so a created row and a scanned one describe themselves
 * identically; `extra.section` still wins when a caller knows better (the
 * duplicate, which copies its source's).
 */
export function documentRowFor(
  target: DocumentTarget,
  at: string,
  extra: Partial<RvDocumentEntry> = {},
): RvDocumentEntry {
  return {
    id: target.documentId,
    path: target.relPath,
    name: target.name,
    section: sectionOfDocument({ path: target.relPath } as RvDocumentEntry),
    createdAt: at,
    modifiedAt: at,
    ...extra,
  };
}

/**
 * The folder a project-relative path lives in — the empty string for the root.
 *
 * Exported since plan-717 Phase 3: the rename plans its destination in the
 * document's OWN folder (a rename is not a move), and that is the one caller
 * outside this module that needs the split.
 *
 * A path with no folder is a document in the project root, and so is a path
 * that names nothing — both answer with the root now that the root IS the
 * default. The `scenes/` answer this used to give a root document is what
 * turned its rename into a move.
 */
export function documentFolderOf(path: string): string {
  const segments = (typeof path === 'string' ? path : '').split('/');
  segments.pop();
  return segments.join('/');
}

// ─── Verbs ──────────────────────────────────────────────────────────────

/**
 * Create a document from `bytes` (or an empty GLB) and register its row.
 *
 * The bytes go first and the row second — "sidecar follows the bytes". A torn
 * write leaves a file with no row, which {@link planDocument} recognises and
 * reuses; the other order leaves a row pointing at nothing, which is a document
 * the user can see and cannot open.
 */
export async function createDocument(
  host: DocumentManifestHost,
  name: string,
  opts: { bytes?: BlobPart; folder?: string; extra?: Partial<RvDocumentEntry>; now?: () => string } = {},
): Promise<DocumentTarget> {
  const backend = host.getBackend();
  if (!backend?.writable) throw new Error('This project cannot be written to.');
  const project = host.getProject();
  // `!== undefined`, not a truthiness test: '' is the project root, a real
  // target, and dropping it here would silently redirect the create to `scenes/`.
  const target = await planDocument(backend, project, name, { ...(opts.folder !== undefined ? { folder: opts.folder } : {}) });

  const bytes = opts.bytes ?? (await emptyGlbPart());
  await backend.writeBlob(
    target.relPath,
    new Blob([bytes], { type: 'model/gltf-binary' }),
    { expectedRevision: null },
  );

  const at = (opts.now ?? (() => new Date().toISOString()))();
  await commitDocuments(host, [
    ...documentsOf(project),
    documentRowFor(target, at, opts.extra ?? {}),
  ]);
  return target;
}

/** A minimal valid GLB, lazily imported so the empty-scene builder is not eager. */
async function emptyGlbPart(): Promise<BlobPart> {
  const { buildEmptyGlbBlob } = await import('../hmi/scene/empty-glb');
  return buildEmptyGlbBlob();
}

/**
 * Copy a document next to itself as "<name> copy".
 *
 * The bytes are read through the backend rather than re-baked: a duplicate is a
 * copy of a FILE, and re-deriving it from a live workspace would silently make
 * "duplicate" mean "duplicate plus whatever is unsaved".
 *
 * ## The copy inherits the filing (plan-717 §2.7)
 *
 * `collections` travel to the copy. This is not a new behaviour but the same one
 * under a new home: `duplicateAsset` carried the source's sidecar record over
 * for the reason its comment gave — "collections and tags are what make a
 * duplicate useful as a starting point" — and since Phase 2 that record IS the
 * row's `collections`. `id` and `copiedFrom` are the two fields that must NOT be
 * inherited; everything else about a duplicate is meant to look like its source.
 */
export async function duplicateDocument(
  host: DocumentManifestHost,
  documentId: string,
  opts: { now?: () => string } = {},
): Promise<DocumentTarget> {
  const backend = host.getBackend();
  if (!backend?.writable) throw new Error('This project cannot be written to.');
  const project = host.getProject();
  const source = documentsOf(project).find(d => d.id === documentId);
  if (!source) throw new Error(`Document ${documentId} not found`);

  const bytes = await backend.readBlobBytes(source.path);
  if (!bytes) throw new Error(`"${source.name}" could not be read.`);

  const target = await planDocument(backend, project, `${source.name} copy`, {
    folder: documentFolderOf(source.path),
  });
  await backend.writeBlob(
    target.relPath,
    new Blob([bytes], { type: 'model/gltf-binary' }),
    { expectedRevision: null },
  );

  const at = (opts.now ?? (() => new Date().toISOString()))();
  await commitDocuments(host, [
    ...documentsOf(project),
    documentRowFor(target, at, {
      copiedFrom: source.id,
      ...(source.section ? { section: source.section } : {}),
      ...(Array.isArray(source.collections) ? { collections: [...source.collections] } : {}),
    }),
  ]);
  return target;
}

/**
 * Drop a document's row and move its bytes into `.trash/`.
 *
 * Recoverable on purpose, exactly like `deleteAsset`: a document can be the
 * only copy of hours of work, and a delete gesture that cannot be taken back is
 * the one failure mode this codebase consistently refuses. A name already in the
 * trash gets a numeric suffix rather than being overwritten.
 *
 * @returns false when the id names no row (already gone — not an error).
 */
export async function retireDocument(
  host: DocumentManifestHost,
  documentId: string,
): Promise<boolean> {
  const backend = host.getBackend();
  if (!backend?.writable) throw new Error('This project cannot be written to.');
  const project = host.getProject();
  const row = documentsOf(project).find(d => d.id === documentId);
  if (!row) return false;

  try {
    const bytes = await backend.readBlobBytes(row.path);
    if (bytes) {
      const file = row.path.split('/').pop() ?? row.path;
      let target = `${DOCUMENT_TRASH_FOLDER}/${file}`;
      for (let n = 2; n < 100 && (await backend.readBlobBytes(target).catch(() => null)); n++) {
        const dot = file.lastIndexOf('.');
        const stem = dot > 0 ? file.slice(0, dot) : file;
        const ext = dot > 0 ? file.slice(dot) : '';
        target = `${DOCUMENT_TRASH_FOLDER}/${stem} ${n}${ext}`;
      }
      await backend.writeBlob(target, new Blob([bytes], { type: 'model/gltf-binary' }));
      await backend.deleteBlob(row.path);
    }
  } catch (e) {
    // The row still goes: a document whose bytes cannot be moved is exactly the
    // broken card the user is trying to get rid of.
    console.warn(`[document-ops] "${row.name}" could not be moved to the trash:`, e);
  }

  await commitDocuments(host, documentsOf(project).filter(d => d.id !== documentId));
  return true;
}

