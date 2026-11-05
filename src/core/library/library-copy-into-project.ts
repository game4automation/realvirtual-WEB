// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * library-copy-into-project — "Copy into project" (plan-778 Phase 5, Decision 3,
 * F17): fork library B's document into the open project A and point the
 * selected placement at A's copy.
 *
 * The copy follows the cross-source copy rules of `library-asset-ops.ts`
 * (`transferDocument`): a NEW document id, `copiedFrom` naming the source —
 * here `{ projectId, documentId }`, because B's document id is unique only in
 * B — and nothing that describes B's file (hash, revision, stats, thumbnail
 * pointer, B's legacy `aliases`). It writes through the OPEN project's store
 * (`writeDocument` + `applyManifestDelta`) rather than a transfer session: a
 * session's manifest half is a CAS write beside the store, which is right for a
 * project that is NOT open and wrong for the one that is (the store's own
 * manifest would not know the new row).
 *
 * The repoint is the planner's `repointPlacement` — remove + place at the same
 * transform inside ONE scene transaction, so one Undo restores the library
 * placement.
 */

import type { RVViewer } from '../rv-viewer';
import type { ProjectBackend } from '../project/backends/project-backend';
import type { RvDocumentEntry, RvProject } from '../project/rv-project-types';
import { readDocuments, newDocumentId } from '../project/rv-project-documents';
import { SceneRevisionConflictError } from '../project/rv-scene-record';
import { getProjectStore } from '../project/project-store';
import { libraryLabelOf, libraryNodeOf } from './library-document-edit';
import { listLibrarySources, subscribeLibrarySources } from './library-source-registry';
import { OPEN_PROJECT_PROVIDER_ID } from './library-origin';
import { requalifyCopiedReferences } from './library-reference-requalify';
import { copyThumbnailSidecar } from './resolve-document-thumbnail';
import type { LibraryCatalogEntry } from './library-types';

/** The open project as this verb needs it (the store, narrowed — a test seam). */
export interface CopyTargetStore {
  getBackend(): ProjectBackend | null;
  getProject(): RvProject | null;
  applyManifestDelta(apply: (current: RvProject) => RvProject): Promise<RvProject | null>;
}

export type CopyIntoProjectResult =
  | { kind: 'ok'; row: RvDocumentEntry }
  | { kind: 'error'; message: string };

/** Row fields that describe B's FILE, not the document — never carried into A. */
const FILE_FIELDS = ['sha256', 'revision', 'mtimeMs', 'thumbnail', 'aliases', 'copiedFrom', 'forkedFrom'] as const;

function splitPath(path: string): { folder: string; stem: string; ext: string } {
  const segments = path.split('/').filter(Boolean);
  const file = segments.pop() ?? path;
  const dot = file.lastIndexOf('.');
  return { folder: segments.join('/'), stem: dot > 0 ? file.slice(0, dot) : file, ext: dot > 0 ? file.slice(dot) : '' };
}

/**
 * Fork B's document `documentId` into the open project. The copy lands at A's
 * root under B's file name (`<stem> 2.glb`, … when taken — the cross-source
 * copy's naming), written as a create so nothing is ever overwritten.
 */
export async function copyLibraryDocumentIntoProject(
  libraryProjectId: string,
  documentId: string,
  store: CopyTargetStore = getProjectStore(),
): Promise<CopyIntoProjectResult> {
  const node = libraryNodeOf(libraryProjectId);
  const label = libraryLabelOf(libraryProjectId, node);
  const state = node?.state;
  if (state?.kind !== 'ready' || !state.backend) {
    return { kind: 'error', message: `Library '${label}' is not available — nothing was copied.` };
  }
  const row = state.documents.find((d) => d.id === documentId);
  if (!row?.path) return { kind: 'error', message: `Library '${label}' has no document "${documentId}".` };
  const target = store.getBackend();
  if (!target?.writable) return { kind: 'error', message: 'The open project is read-only — nothing was copied.' };
  // The project the copy is FOR, captured before the awaits (plan-778 review E4):
  // a switch while B's bytes are read or written must not land the row in another project.
  const projectIdAtStart = store.getProject()?.id ?? null;
  const switched = (): boolean => store.getBackend() !== target || (store.getProject()?.id ?? null) !== projectIdAtStart;
  const SWITCHED = 'The project changed while the part was being copied — nothing was copied.';

  let bytes: Uint8Array | null = null;
  try {
    bytes = (await state.backend.readDocument(row.path))?.bytes ?? null;
  } catch (e) {
    return { kind: 'error', message: `"${row.name}" could not be read from library '${label}' (${e instanceof Error ? e.message : String(e)}).` };
  }
  if (!bytes) return { kind: 'error', message: `"${row.name}" could not be read from library '${label}'.` };
  // plan-780 A3: the copy's unqualified refs get B's qualifier; computed before any write.
  try {
    bytes = requalifyCopiedReferences(bytes, libraryProjectId).bytes;
  } catch (e) {
    return { kind: 'error', message: `"${row.name}" is not a readable GLB — nothing was copied (${e instanceof Error ? e.message : String(e)}).` };
  }

  const { stem, ext } = splitPath(row.path);
  const taken = new Set((readDocuments(store.getProject()) ?? []).map((d) => (d.path ?? '').toLowerCase()));
  let path: string | null = null;
  for (let n = 1; n < 100 && !path; n++) {
    const candidate = `${n === 1 ? stem : `${stem} ${n}`}${ext || '.glb'}`;
    if (taken.has(candidate.toLowerCase())) continue;
    try {
      await target.writeDocument(candidate, bytes, { expectedRevision: 'create' });
      path = candidate;
    } catch (e) {
      if (!(e instanceof SceneRevisionConflictError)) {
        return { kind: 'error', message: `The copy could not be written (${e instanceof Error ? e.message : String(e)}).` };
      }
    }
  }
  if (!path) return { kind: 'error', message: `Too many copies of "${stem}" already exist in this project.` };
  const orphan = async (message: string): Promise<CopyIntoProjectResult> => {
    // Bytes without a row are an orphan; take them back out (same rule as a cross-source copy).
    await target.deleteDocument(path!).catch(() => {});
    return { kind: 'error', message };
  };
  if (switched()) return orphan(SWITCHED);

  const newId = newDocumentId();
  // plan-780 R6: B's thumbnail sidecar is copied as bytes under the copy's id; a failure leaves no pointer.
  const thumbnail = await copyThumbnailSidecar(
    { read: async (p) => (await state.backend!.readDocument(p).catch(() => null))?.bytes ?? null },
    { write: async (p, b) => { await target.writeDocument(p, b, { expectedRevision: 'any' }); } },
    row.thumbnail,
    row.id,
    newId,
  );
  if (switched()) return orphan(SWITCHED);
  const entry: RvDocumentEntry = {
    ...row,
    id: newId,
    path,
    name: splitPath(path).stem === stem ? row.name : splitPath(path).stem,
    sizeBytes: bytes.byteLength,
    modifiedAt: new Date().toISOString(),
    copiedFrom: { projectId: libraryProjectId, documentId },
  };
  for (const field of FILE_FIELDS) delete (entry as Record<string, unknown>)[field];
  if (thumbnail) entry.thumbnail = thumbnail;
  entry.copiedFrom = { projectId: libraryProjectId, documentId };
  let recorded = false;
  let written: RvProject | null;
  try {
    written = await store.applyManifestDelta((current) => {
      // Re-checked INSIDE the delta: the queue may run it after a switch.
      if (switched() || (current.id ?? null) !== projectIdAtStart) return current;
      recorded = true;
      return { ...current, documents: [...(readDocuments(current) ?? []).filter((d) => d.path !== path), entry] };
    });
  } catch (e) {
    return orphan(`The copy could not be recorded (${e instanceof Error ? e.message : String(e)}).`);
  }
  if (!written) return orphan('The open project is read-only — nothing was copied.');
  if (!recorded) return orphan(SWITCHED);
  return { kind: 'ok', row: entry };
}

/** The open project's catalog entry for `row`, once its library source lists it (≤ `timeoutMs`). */
export async function waitForProjectEntry(row: RvDocumentEntry, timeoutMs = 5000): Promise<LibraryCatalogEntry | null> {
  const find = (): LibraryCatalogEntry | null => {
    for (const s of listLibrarySources()) {
      if (s.providerId !== OPEN_PROJECT_PROVIDER_ID) continue;
      const hit = s.source.getEntry(row.id) ?? s.source.getEntry(`project:${row.path}`);
      if (hit) return hit;
    }
    return null;
  };
  for (const s of listLibrarySources()) {
    if (s.providerId === OPEN_PROJECT_PROVIDER_ID) await s.source.refresh?.().catch(() => {});
  }
  const now = find();
  if (now) return now;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { off(); resolve(find()); }, timeoutMs);
    const off = subscribeLibrarySources(() => {
      const hit = find();
      if (hit) { clearTimeout(timer); off(); resolve(hit); }
    });
  });
}

/** The planner surface the repoint needs (duck-typed: core never imports the plugin). */
interface RepointPlanner {
  repointPlacement(id: string, entry: LibraryCatalogEntry, label?: string): Promise<string | null>;
}

/**
 * Copy into project, whole: fork B's document into A, then point placement
 * `placementId` at the copy as ONE undo step. Returns the new placement id.
 */
export async function copyLibraryPlacementIntoProject(
  viewer: RVViewer,
  placementId: string,
  libraryProjectId: string,
  documentId: string,
): Promise<{ kind: 'ok'; placementId: string; row: RvDocumentEntry } | { kind: 'error'; message: string }> {
  const planner = viewer.getPlugin?.('layout-planner') as unknown as RepointPlanner | undefined;
  if (!planner?.repointPlacement) return { kind: 'error', message: 'The layout planner is not available.' };
  const copied = await copyLibraryDocumentIntoProject(libraryProjectId, documentId);
  if (copied.kind !== 'ok') return copied;
  const entry = await waitForProjectEntry(copied.row);
  if (!entry) {
    return { kind: 'error', message: `"${copied.row.name}" was copied into the project, but the placement could not be switched to it yet.` };
  }
  const next = await planner.repointPlacement(placementId, entry, 'Copy into project');
  if (!next) {
    return { kind: 'error', message: `"${copied.row.name}" was copied into the project, but the placement no longer exists.` };
  }
  return { kind: 'ok', placementId: next, row: copied.row };
}
