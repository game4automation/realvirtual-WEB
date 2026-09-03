// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * library-asset-ops — cross-source transfer and collections, ROW route only
 * (plan-372 §2.6.5 / Phase 9, gutted by plan-717 Phase 4).
 *
 * What this module used to be — "rename, duplicate, delete and re-collect a
 * library asset, all four writing bytes and a `library.json` beside them" — is
 * exactly what plan-717 removed. Every one of those verbs moved bytes past the
 * manifest, so the row (and with it the document's id) was a thing the next
 * folder scan re-derived from the new path. That is how a rename used to break
 * an `assetId` reference silently.
 *
 * ## What is left, and which route each takes
 *
 *  - **`copyDocumentAcrossSources` / `moveDocumentAcrossSources`** — transfer
 *    between two *different* sources. Row-based from the start (plan-413): the
 *    arrival gets a manifest row through `updateManifestEntry`, a copy with a
 *    new id and a move with the source's.
 *  - **`setAssetCollections`** — one field on one row, through
 *    `applyManifestDelta`.
 *  - **`LIBRARY_FOLDER` / `TRASH_FOLDER`** and the small path helpers, which the
 *    rest of the persistence layer imports.
 *
 * Same-project create, rename, duplicate and delete are NOT here any more. They
 * are `rv-document-ops` (`createDocument`, `duplicateDocument`,
 * `deleteDocument`) and `applyTreeMove` — the one create/rename/move path
 * (§2.7, F6/F7).
 *
 * ## The sidecar is read-only legacy
 *
 * Nothing in this module touches `library.json` any more. Collections are a row
 * field (§2.4), so a transfer carries them in the row it writes; the file
 * survives only as a migration INPUT that the adopt verb ingests once and then
 * deletes (`library-sidecar-ingest.ts`). The write API is deleted and
 * `registration-removal-guard.test.ts` keeps it deleted.
 *
 * ## Delete is still a move, not a delete
 *
 * A move between sources retires the original into `<root>/.trash/` rather than
 * removing it: a library asset can be the only copy of hours of authoring work,
 * and a mis-click must not be terminal. `.trash/` is excluded from
 * `.rvprojectignore` and from the `.rvproject` export, so the safety net never
 * travels or bloats an archive.
 */

import type { DocumentTransferSession, DocumentTransferSide } from '../project/rv-document-transfer';
import {
  classificationOfGlbBlob,
  newDocumentId,
} from '../project/rv-project-documents';
import type { DocumentClassification } from '../project/rv-document-classification';
import type { RvDocumentEntry, RvProject } from '../project/rv-project-types';

/** Root folder of a project's own assets. */
export const LIBRARY_FOLDER = 'library';

/** Where deleted assets go. Never exported, never scanned as a catalog. */
export const TRASH_FOLDER = '.trash';

export type AssetOpResult =
  | { kind: 'ok' }
  | { kind: 'exists'; message: string }
  | { kind: 'error'; message: string };

const ok: AssetOpResult = { kind: 'ok' };

/** Full backend path for an asset given its path relative to `library/`. */
function libPath(relPath: string): string {
  return `${LIBRARY_FOLDER}/${relPath}`;
}

/**
 * The slice of a backend these operations actually touch.
 *
 * Named so the cross-source verbs below can take a {@link DocumentTransferSide}
 * — which is deliberately narrower than a backend — through the same helpers a
 * same-project rename uses, instead of growing a second copy of "read the
 * bytes, write the bytes, probe the name".
 */
interface BlobSurface {
  readDocumentUrl(relPath: string): Promise<{ url: string; release(): void } | null>;
  writeDocument(
    relPath: string,
    bytes: Uint8Array,
    opts: { expectedRevision: string },
  ): Promise<{ revision: string }>;
  deleteDocument(relPath: string): Promise<void>;
}

/** Read a full path as bytes, or null when it is not there. */
async function readBytesAt(surface: BlobSurface, path: string): Promise<Blob | null> {
  const resolved = await surface.readDocumentUrl(path);
  if (!resolved) return null;
  try {
    return await (await fetch(resolved.url)).blob();
  } finally {
    resolved.release();
  }
}

/** True when something is stored at this full path. */
async function existsAt(surface: BlobSurface, path: string): Promise<boolean> {
  const resolved = await surface.readDocumentUrl(path);
  if (!resolved) return false;
  resolved.release();
  return true;
}

// ─── Deleted in plan-717 Phase 4 (F1/F6/F9) ─────────────────────────────
//
// `createEmptyAsset`, `renameAsset`, `duplicateAsset`, `deleteAsset` and
// `moveSidecarEntry`, together with the sidecar write API they shared
// (`readSidecar`/`writeSidecar`/`writeSidecarAt`/`sidecarIsUnreadableAt`) and
// the two blob helpers only they used (`copyBlob`, `exists`).
//
// All five wrote bytes — and in four cases metadata — without going through the
// manifest, which is what made a document's identity a function of its current
// path. Their replacements all keep the row and the id:
//
//   createEmptyAsset  → `createDocument(store, name, { folder })`
//   renameAsset       → `runTreeEdit` / `applyTreeMove` (row name + file name)
//   duplicateAsset    → `duplicateDocument` (row copy, new id, collections carried)
//   deleteAsset       → `deleteDocument` (row removed, bytes to `.trash/`)
//   moveSidecarEntry  → nothing: collections are on the row `applyTreeMove` repoints
//
// Phase 3 emptied their call sites; this deleted the functions. The unreadable-
// sidecar refusal they carried lives on where a sidecar is still touched at all:
// the ingestion reports it and leaves the file alone (`project-store`, R1-S3).

// ─── Cross-source copy and move (plan-413 §2.7, phase 5) ────────────────

/**
 * Where a transferred document lands by default.
 *
 * A copy arrives as a *library asset* of the target, whatever it was in the
 * source. That is not a simplification: `library/` is the one folder every
 * writable project has, it is what the source registry lists, and a scene
 * dropped into another project's `scenes/` would need a manifest scene entry,
 * a body revision and an id the scene index agrees with — a second, larger
 * feature wearing the same verb's name.
 */
export const DEFAULT_TRANSFER_FOLDER = LIBRARY_FOLDER;

export interface DocumentTransferOptions {
  /** Folder inside the target. Defaults to {@link DEFAULT_TRANSFER_FOLDER}. */
  targetFolder?: string;
}

export interface DocumentTransferOk {
  kind: 'ok';
  /** Path of the arrival inside the target, including its folder. */
  path: string;
  /** Identity of the arrival: a NEW id for a copy, the SAME id for a move. */
  id: string;
  /** What the arrived bytes say they are — read back out of the copy. */
  classification: DocumentClassification | null;
  /** True when the target had no manifest file to record the row in. */
  manifestSkipped?: boolean;
  /**
   * Set when a move delivered the bytes but could not clear the source.
   *
   * The document then exists twice, which is the failure this order was chosen
   * to produce: a duplicate is a tidy-up, a loss is not (§5.4).
   */
  warning?: string;
}

export type DocumentTransferResult =
  | DocumentTransferOk
  | { kind: 'exists'; message: string }
  | { kind: 'error'; message: string };

/** Split a path into the parts a name probe needs. */
function splitFileName(path: string): { folder: string; file: string; stem: string; ext: string } {
  const segments = path.split('/').filter(Boolean);
  const file = segments.pop() ?? path;
  const dot = file.lastIndexOf('.');
  return {
    folder: segments.join('/'),
    file,
    stem: dot > 0 ? file.slice(0, dot) : file,
    ext: dot > 0 ? file.slice(dot) : '',
  };
}

/**
 * First free name in `folder`, starting from `file` and counting up.
 *
 * Probed rather than assumed, for the same reason {@link duplicateAsset} probes:
 * copying the same document into the same target twice must produce two
 * documents, not one silent overwrite of the first.
 */
async function probeFreeName(
  surface: BlobSurface,
  folder: string,
  file: string,
): Promise<string | null> {
  const { stem, ext } = splitFileName(file);
  for (let n = 1; n < 100; n++) {
    const candidate = n === 1 ? `${stem}${ext}` : `${stem} ${n}${ext}`;
    const path = folder ? `${folder}/${candidate}` : candidate;
    if (!(await existsAt(surface, path))) return path;
  }
  return null;
}

/** The `.trash/` path a document at `path` is retired to, inside its own root. */
function trashPathFor(path: string): string {
  const { folder, file } = splitFileName(path);
  const root = folder.split('/').filter(Boolean)[0] ?? '';
  return root ? `${root}/${TRASH_FOLDER}/${file}` : `${TRASH_FOLDER}/${file}`;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Copy a document from one writable source into another (F11).
 *
 * ## The copy is a NEW document
 *
 * New `id`, minted; `copiedFrom` records where it came from (SOL R1-4). Two
 * files with the same identity in two places is not a copy, it is a fork of one
 * document that the reference resolver would then answer for arbitrarily. A
 * *move* is the operation that keeps the id — same document, new home.
 *
 * ## The order, and what each failure costs
 *
 *  1. read the source bytes            — nothing written yet
 *  2. probe a free name in the target  — never overwrites
 *  3. write the bytes                  — the copy exists
 *  4. read it back and verify the size — a truncated write is caught here
 *  5. read the classification OUT OF THE COPY (§2.5: the file wins, always)
 *  6. manifest row, then sidecar       — caches, in that order
 *
 * A failure at 6 deletes the bytes again (nothing half-arrived); a failure at 3
 * or 4 leaves the target as it was. The classification travels inside the bytes
 * and is therefore never passed in — it is read back out, which is the same
 * rule the scan follows and the reason a GLB copied in from outside shows up
 * correctly classified too.
 *
 * Verification is by size, not by hash: re-reading and digesting a hundred
 * megabytes on every transfer is the cost that would make the verb unusable,
 * while the write surfaces are all-or-nothing, so the thing left to catch is a
 * write that did not land at all.
 */
export async function copyDocumentAcrossSources(
  session: DocumentTransferSession,
  doc: RvDocumentEntry,
  opts: DocumentTransferOptions = {},
): Promise<DocumentTransferResult> {
  return transferDocument(session, doc, opts, { keepId: false });
}

/**
 * Move a document between two writable sources: copy, verify, then trash the
 * original (F11).
 *
 * ## Same id, new home
 *
 * A move keeps the document's `id`, so an `AssetReference` or a Layout Planner
 * placement pointing at it still resolves once the target's library is
 * registered — identity is what the resolver looks up, not the path. The
 * consequence is a transient window in which two sources list the same id; the
 * scan reports it (`findDocumentIdCollisions`) and it closes when the source
 * row goes.
 *
 * ## Delete is a move into `.trash/`, and delete failure is not a rollback
 *
 * The original is retired into `<root>/.trash/` with the same numeric probing
 * {@link deleteAsset} uses, never removed outright. And if that step fails
 * after the bytes arrived, the copy **stays** and the result says so: the
 * ordering exists precisely so a torn move costs a duplicate rather than the
 * only copy of somebody's work (§5.4).
 */
export async function moveDocumentAcrossSources(
  session: DocumentTransferSession,
  doc: RvDocumentEntry,
  opts: DocumentTransferOptions = {},
): Promise<DocumentTransferResult> {
  return transferDocument(session, doc, opts, { keepId: true });
}

async function transferDocument(
  session: DocumentTransferSession,
  doc: RvDocumentEntry,
  opts: DocumentTransferOptions,
  mode: { keepId: boolean },
): Promise<DocumentTransferResult> {
  const { source, target } = session;
  if (!source) return { kind: 'error', message: 'This transfer has no source.' };
  if (!target) return { kind: 'error', message: 'This transfer has no target.' };
  // Both halves are checked, and for a move both matter: the target has to
  // accept bytes and the source has to be able to give up its own.
  if (!target.writable) {
    return { kind: 'error', message: `"${target.label}" is read-only.` };
  }
  if (mode.keepId && !source.writable) {
    return { kind: 'error', message: `"${source.label}" is read-only — copy it instead.` };
  }
  if (source.backendId === target.backendId) {
    return {
      kind: 'error',
      message: 'Source and target are the same library — use Duplicate instead.',
    };
  }

  const folder = (opts.targetFolder ?? DEFAULT_TRANSFER_FOLDER).replace(/\/+$/, '');
  const { file } = splitFileName(doc.path);

  let bytes: Blob | null;
  try {
    bytes = await readBytesAt(source, doc.path);
  } catch (e) {
    return { kind: 'error', message: errText(e) };
  }
  if (!bytes) return { kind: 'error', message: `"${doc.name}" could not be read.` };

  let targetPath: string | null;
  try {
    targetPath = await probeFreeName(target, folder, file);
  } catch (e) {
    return { kind: 'error', message: errText(e) };
  }
  if (!targetPath) {
    return { kind: 'exists', message: `Too many copies of "${file}" already exist there.` };
  }

  try {
    // `targetPath` is the first free name the probe above found, so this is a
    // create — and saying so is what refuses the write if a concurrent copy got
    // there between the probe and here.
    await target.writeDocument(
      targetPath, new Uint8Array(await bytes.arrayBuffer()), { expectedRevision: 'create' });
  } catch (e) {
    return { kind: 'error', message: errText(e) };
  }

  // Everything from here on has bytes in the target to clean up if it fails.
  let classification: DocumentClassification | null = null;
  let manifestSkipped = false;
  try {
    const arrived = await readBytesAt(target, targetPath);
    if (!arrived) throw new Error(`The copy of "${doc.name}" could not be read back.`);
    if (arrived.size !== bytes.size) {
      throw new Error(`The copy of "${doc.name}" is incomplete.`);
    }
    classification = await classificationOfGlbBlob(arrived);

    const arrivedName = splitFileName(targetPath).stem;
    const sourceName = splitFileName(doc.path).stem;
    const entry: RvDocumentEntry = {
      ...doc,
      id: mode.keepId ? doc.id : newDocumentId(),
      path: targetPath,
      // A probed name has to reach the display string too, or two rows read
      // "Belt" and only the file names tell them apart.
      name: arrivedName === sourceName ? doc.name : arrivedName,
      sizeBytes: bytes.size,
      modifiedAt: new Date().toISOString(),
    };
    if (classification) entry.classification = classification;
    else delete entry.classification;
    if (mode.keepId) delete entry.copiedFrom;
    else entry.copiedFrom = doc.id;
    // Stats and revisions describe the source's file, not this one. Left in
    // place they would make the target's scan pre-filter clear on a document it
    // has never looked at.
    delete entry.mtimeMs;
    delete entry.sha256;
    delete entry.revision;

    const recorded = await target.updateManifestEntry((documents) => [
      ...documents.filter(d => d.path !== targetPath),
      entry,
    ]);
    manifestSkipped = !recorded;

    // No sidecar write, and nothing lost with it (plan-717 Phase 4). What the
    // two halves of that record used to carry now both travel in the row above:
    // `tags` inside `entry.classification`, read back out of the arrived BYTES,
    // and `collections` in the `...doc` spread, because they are a row field
    // since §2.4. Writing them a second time into a `library.json` is precisely
    // the two-homes failure this plan removed.

    if (!mode.keepId) {
      return { kind: 'ok', path: targetPath, id: entry.id, classification, manifestSkipped };
    }

    // ── Move only: retire the original ──
    try {
      await retireSourceDocument(source, doc);
    } catch (e) {
      return {
        kind: 'ok',
        path: targetPath,
        id: entry.id,
        classification,
        manifestSkipped,
        warning: `"${doc.name}" was copied to "${target.label}" but could not be removed from `
          + `"${source.label}" (${errText(e)}). It now exists in both.`,
      };
    }
    return { kind: 'ok', path: targetPath, id: entry.id, classification, manifestSkipped };
  } catch (e) {
    // Body written, cache (or verification) failed: take the partial copy back
    // out. A target left holding bytes nothing lists is exactly the orphan the
    // "bytes first" ordering is meant to make repairable, not permanent.
    await target.deleteDocument(targetPath).catch(() => {});
    return { kind: 'error', message: errText(e) };
  }
}

/**
 * Retire a document in its own source: bytes to `.trash/`, then the row.
 *
 * Throws on failure — the caller turns that into the "it now exists in both"
 * warning rather than into a rollback, because rolling back would mean deleting
 * the copy that already succeeded.
 *
 * Removing the row is what drops the document's metadata, collections included
 * (plan-717 Phase 4). It used to clear a sidecar record as well; with the row
 * gone there is no second place left for a stale record to survive in and
 * reattach itself to a future document of the same path.
 */
async function retireSourceDocument(
  source: DocumentTransferSide,
  doc: RvDocumentEntry,
): Promise<void> {
  const trashTarget = trashPathFor(doc.path);
  const { folder, file } = splitFileName(trashTarget);
  const free = await probeFreeName(source, folder, file);
  if (!free) throw new Error('The trash folder already holds too many files of that name.');

  const bytes = await readBytesAt(source, doc.path);
  if (!bytes) throw new Error(`"${doc.name}" could not be read.`);
  // `free` came from `probeFreeName` — nothing may be there.
  await source.writeDocument(
    free, new Uint8Array(await bytes.arrayBuffer()), { expectedRevision: 'create' });
  await source.deleteDocument(doc.path);

  await source.updateManifestEntry(documents => documents.filter(d => d.path !== doc.path));
}

/**
 * The manifest half of a project, as narrow as this verb needs it.
 *
 * A structural type rather than `ProjectStore` so the collections write can be
 * tested without a backend, a folder handle or a boot path — the same device
 * the rest of this file uses for {@link BlobSurface}.
 */
export interface DocumentRowWriter {
  applyManifestDelta(
    apply: (current: RvProject) => RvProject,
    opts?: { publish?: boolean },
  ): Promise<RvProject | null>;
}

/**
 * Replace a document's collections (the Collections editor's single write).
 *
 * ## Why this writes the ROW and not the sidecar any more (plan-717 §2.4/F4)
 *
 * Until plan-717 this wrote `library/library.json`, and nothing in production
 * ever read it back — `resolveAssetMeta()` had zero callers, so setting
 * collections was a write into a file the catalog never consulted. The row is
 * now the one home for them, which is what closes that loop (§2.6).
 *
 * ## Why through `applyManifestDelta` and not `backend.updateManifestEntry`
 *
 * Three reasons, in the order they bite:
 *
 *  1. `updateManifestEntry` is not on `ProjectBackend` at all — it belongs to
 *     `DocumentTransferSide`, the cross-source surface. Reaching it from here
 *     would mean widening the backend interface for one verb.
 *  2. `applyManifestDelta` already serves both media: the CAS chain for a
 *     folder project, `writeManifest` for a browser one. A backend-level write
 *     would have to re-implement that fork.
 *  3. It is **durable-first and merging**: the row lands on disk before the
 *     store publishes it, and a concurrent writer's rows are merged rather than
 *     overwritten by a captured snapshot. Collections are exactly the kind of
 *     hand-typed metadata that must not vanish because a second tab saved.
 */
export async function setAssetCollections(
  rows: DocumentRowWriter,
  relPath: string,
  collections: string[],
): Promise<AssetOpResult> {
  const path = libPath(relPath);
  // Trim, drop blanks and de-duplicate: collection names are user-typed and
  // "Conveyors " must not become a second chip beside "Conveyors".
  const cleaned = [...new Set(collections.map(c => c.trim()).filter(Boolean))];
  let found = false;
  try {
    const written = await rows.applyManifestDelta((current) => {
      const documents = (current.documents ?? []).map((doc) => {
        if ((doc.path ?? '').replace(/\\/g, '/') !== path) return doc;
        found = true;
        // An empty list is stored as an empty array, not as a missing field:
        // "the user filed this under nothing" is an answer, and dropping the
        // field would re-open the legacy read fallback for this row.
        return { ...doc, collections: cleaned };
      });
      return { ...current, documents };
    });
    if (written === null) {
      return { kind: 'error', message: 'This project has no manifest to record collections in.' };
    }
    if (!found) {
      return {
        kind: 'error',
        message: `"${relPath}" is not registered in this project yet — reopen the project and try again.`,
      };
    }
    return ok;
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}
