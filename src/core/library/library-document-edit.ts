// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * library-document-edit — "Edit in library" (plan-778 Phase 5, Decision 3, F16).
 *
 * A library B is read-only inside A: its loader backend is built
 * `writable:false` and never asks for more. Changing B from A is one explicit
 * act — a confirmation that names B, then `requestPermission({mode:'readwrite'})`
 * on B's folder handle as the FIRST await of that click. A grant yields a
 * writable `FolderBackend` with the SAME id as the read backend
 * (`folder:<projectId>`), so the save ledger that the open path filled while
 * reading B is the one the write checks against (Stab 3: one ledger per unique
 * backend id, never A's `folder:<dirname>`).
 *
 * Only a LOCAL FOLDER library can be written. The built-in realvirtual library,
 * hosted / GitHub libraries, a browser-stored library and the trimmed copy a
 * delivery ships under `libraries/<id>/` are refused with a sentence that
 * points at Copy into project instead (`libraryEditRefusal`).
 *
 * The synchronous half the save verb needs (save backend, refusal, label, the
 * grant registry) is `library-save-target.ts`; this module is loaded on use.
 */

import type { ProjectBackend } from '../project/backends/project-backend';
import type { RvDocumentEntry } from '../project/rv-project-types';
import { revisionOfBytes } from '../project/rv-scene-record';
import { clearProblem, reportProblem } from '../hmi/problems-store';
import {
  commandRegistry,
  CommandError,
  type CommandDescriptor,
  type CommandImpl,
} from '../hmi/rv-command-registry';
import { getLibraryProjectLoader } from './library-project-loader';
import type { LibraryProjectNode } from './library-project-loader';
import {
  folderDirOf,
  libraryFolderHandle,
  libraryLabelOf,
  libraryNodeOf,
  getLibraryWriteBackend,
  releaseLibraryWriteGrant,
  releaseLibraryWriteGrants,
  setLibraryWriteBackend,
} from './library-save-target';

export {
  getLibraryWriteBackend,
  libraryFolderHandle,
  libraryLabelOf,
  libraryNodeOf,
  librarySaveBackend,
  releaseLibraryWriteGrant,
  releaseLibraryWriteGrants,
} from './library-save-target';

const COPY_HINT = 'Use Copy into project to change this part for this project only.';

/** Why library B cannot be written from here, or null when Edit in library may ask for access. */
export function libraryEditRefusal(projectId: string, node: LibraryProjectNode | null = libraryNodeOf(projectId)): string | null {
  const label = libraryLabelOf(projectId, node);
  if (!node) return `'${label}' is not a library of the open project.`;
  const state = node.state;
  if (state.kind === 'pending') return `Library '${label}' is still loading.`;
  if (state.kind === 'locked') return `Library '${label}' needs folder access first — use Grant in the Problems panel.`;
  if (state.kind !== 'ready') return `Library '${label}' is not available on this computer — locate its folder first.`;
  if (state.delivered) {
    return `Library '${label}' is the copy delivered with this project and cannot be changed here. ${COPY_HINT}`;
  }
  switch (state.via) {
    case 'builtin':
      return `The realvirtual library ships with the application and cannot be changed. ${COPY_HINT}`;
    case 'hosted':
    case 'scan':
      return `Library '${label}' is published online and cannot be changed from here. ${COPY_HINT}`;
    case 'browser':
      return `Library '${label}' is stored in this browser and cannot be changed from another project. `
        + 'Open it as a project to change it, or use Copy into project to change this part for this project only.';
    default:
      return folderDirOf(state.backend) ? null : `Library '${label}' cannot be written to. ${COPY_HINT}`;
  }
}

/**
 * The library ids whose drafts draft recovery may offer (plan-778 review E7):
 * only libraries a save can go into. A built-in, hosted, browser-stored or
 * delivered library never takes a save — its draft would be a recovery that
 * leads nowhere. Still loading or locked may become savable (Grant), so they
 * keep their offer.
 */
export function recoverableLibraryIds(nodes: readonly LibraryProjectNode[]): string[] {
  return nodes
    .filter((n) => n.state.kind === 'pending' || n.state.kind === 'locked' || libraryEditRefusal(n.projectId, n) === null)
    .map((n) => n.projectId);
}

/** The `libraryDocument` editor base (structural twin of the `AssetDraftBase` variant). */
export interface LibraryDocumentBase {
  kind: 'libraryDocument';
  libraryProjectId: string;
  documentId: string;
  path: string;
  name: string;
  libraryLabel?: string;
}

/** The confirmation title of Edit in library. */
export function editInLibraryTitle(label: string): string {
  return `Save changes into library '${label}'?`;
}

/** The confirmation sentence of Edit in library (§3.3). */
export function editInLibraryMessage(label: string): string {
  return `Save changes into library '${label}'? Every project that uses it gets the change.`;
}

/** The row of `documentId` in library B, or null. */
export function libraryDocumentRow(projectId: string, documentId: string): RvDocumentEntry | null {
  const state = libraryNodeOf(projectId)?.state;
  if (state?.kind !== 'ready') return null;
  return state.documents.find((d) => d.id === documentId) ?? null;
}

/** The editor base for B's document `documentId`, or null when B does not list it. */
export function libraryDocumentBaseOf(projectId: string, documentId: string): LibraryDocumentBase | null {
  const row = libraryDocumentRow(projectId, documentId);
  if (!row?.path) return null;
  return {
    kind: 'libraryDocument',
    libraryProjectId: projectId,
    documentId,
    path: row.path,
    name: row.name || row.path.split('/').pop()?.replace(/\.glb$/i, '') || documentId,
    libraryLabel: libraryLabelOf(projectId),
  };
}

export type LibraryWriteGrant = { ok: true; backend: ProjectBackend } | { ok: false; reason: string };

/**
 * Ask for write access to library B. Call it straight from the confirming
 * click: everything before `requestPermission` is synchronous, so the prompt
 * still holds the click's user activation.
 */
export async function grantLibraryWrite(projectId: string): Promise<LibraryWriteGrant> {
  const node = libraryNodeOf(projectId);
  const refusal = libraryEditRefusal(projectId, node);
  const handle = libraryFolderHandle(node);
  if (refusal || !handle) return { ok: false, reason: refusal ?? `Library '${projectId}' cannot be written to.` };
  const label = libraryLabelOf(projectId, node);
  let state: PermissionState;
  try {
    state = await (handle as FileSystemDirectoryHandle & {
      requestPermission(d: { mode: 'readwrite' }): Promise<PermissionState>;
    }).requestPermission({ mode: 'readwrite' });
  } catch {
    // A prompt without user activation throws `SecurityError`; same answer as a denial.
    state = 'denied';
  }
  if (state !== 'granted') {
    return { ok: false, reason: `Write access to library '${label}' was not granted — nothing was changed.` };
  }
  const previous = getLibraryWriteBackend(projectId);
  if (previous) return { ok: true, backend: previous };
  const { FolderBackend } = await import('../project/backends/folder-backend');
  // Same id as the read backend (`folder:<projectId>`) — one ledger for B.
  const backend = new FolderBackend(handle, { writable: true, id: `folder:${projectId}` });
  await backend.activate();
  setLibraryWriteBackend(projectId, backend);
  watchLibraryGrants();
  return { ok: true, backend };
}

let unwatchGrants: (() => void) | null = null;
let watchedLoader: unknown = null;

/**
 * While write grants exist (plan-778 review E5): a project switch or close
 * drops all of them; a library that left the open project's graph (detached,
 * no longer needed) drops its own. Locate and detach release theirs directly.
 */
function watchLibraryGrants(): void {
  const loader = getLibraryProjectLoader();
  if (!loader || (unwatchGrants && watchedLoader === loader)) return;
  unwatchGrants?.();
  watchedLoader = loader;
  const projectId = loader.activeProjectId;
  unwatchGrants = loader.subscribe(() => {
    const left = releaseLibraryWriteGrants((id) => loader.activeProjectId === projectId && !!loader.getNode(id));
    if (left === 0) { unwatchGrants?.(); unwatchGrants = null; }
  });
}

/** How the row update after a save into B went. */
export type LibraryRowUpdate = { ok: true } | { ok: false; reason: string };

export const LIBRARY_ROW_STALE_CODE = 'library-row-stale';
/** The retry of a failed row update — UI-only, registered with the first failure (never an MCP command). */
export const LIBRARY_ROW_REFRESH_COMMAND = 'library.refreshDocumentRow';

export function libraryRowStaleProblemId(projectId: string, relPath: string): string {
  return `${LIBRARY_ROW_STALE_CODE}:${projectId}:${relPath}`;
}

/** Write `sha256` / `sizeBytes` of `bytes` into B's row of `relPath` (one CAS write of B's manifest). */
async function writeLibraryRow(projectId: string, dir: FileSystemDirectoryHandle, relPath: string, bytes: Uint8Array): Promise<void> {
  const sha256 = await revisionOfBytes(bytes);
  const [{ updateManifestCas }, { readDocuments }] = await Promise.all([
    import('../project/rv-project-storage'),
    import('../project/rv-project-documents'),
  ]);
  await updateManifestCas(dir, (current) => {
    if (!current) throw new Error(`Library '${projectId}' has no project.json.`);
    let found = false;
    const documents = (readDocuments(current) ?? []).map((d) => {
      if (d.path !== relPath) return d;
      found = true;
      const next: RvDocumentEntry = {
        ...d, sha256, sizeBytes: bytes.byteLength, modifiedAt: new Date().toISOString(),
      };
      // Stats and revision describe the old file (same rule as a cross-source copy).
      delete next.mtimeMs;
      delete next.revision;
      return next;
    });
    if (!found) throw new Error(`Library '${projectId}' lists no document "${relPath}".`);
    return { ...current, documents };
  });
}

/**
 * After a save into B: B's row describes the new bytes (`sha256`, `sizeBytes`
 * — the model cache key and integrity check of every project that places it),
 * then the loader re-reads B so A's library source and its placements see the
 * new version. Never throws: the bytes are written either way.
 *
 * A row that could NOT be updated is not a footnote (plan-778 review E3): every
 * project would keep serving its cached old model under the old hash. The
 * caller gets the failure, and a Problems row offers **Retry**, which hashes
 * the file as it is on disk and writes the row again.
 */
export async function finishLibraryDocumentSave(
  projectId: string,
  backend: ProjectBackend,
  relPath: string,
  bytes: Uint8Array,
): Promise<LibraryRowUpdate> {
  let result: LibraryRowUpdate = { ok: true };
  const dir = folderDirOf(backend);
  if (dir) {
    try {
      await writeLibraryRow(projectId, dir, relPath, bytes);
      clearProblem(libraryRowStaleProblemId(projectId, relPath));
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.warn(`[library-edit] the row of "${relPath}" in library '${projectId}' could not be updated:`, e);
      reportLibraryRowStale(projectId, relPath, reason);
      result = { ok: false, reason };
    }
  }
  getLibraryProjectLoader()?.invalidate(projectId);
  return result;
}

/**
 * **Retry** of a stale row: read B's file of `relPath` as it is NOW, hash it and
 * write the row. Needs Edit in library's write grant (the row lives in B).
 */
export async function refreshLibraryDocumentRow(projectId: string, relPath: string): Promise<LibraryRowUpdate> {
  const backend = getLibraryWriteBackend(projectId);
  const dir = folderDirOf(backend);
  if (!dir) {
    return { ok: false, reason: `Write access to library '${libraryLabelOf(projectId)}' has ended — use Edit in library again, then Retry.` };
  }
  let bytes: Uint8Array;
  try {
    const parts = relPath.split('/').filter(Boolean);
    let folder = dir;
    for (const part of parts.slice(0, -1)) folder = await folder.getDirectoryHandle(part);
    const file = await (await folder.getFileHandle(parts[parts.length - 1])).getFile();
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (e) {
    const reason = `"${relPath}" could not be read (${e instanceof Error ? e.message : String(e)}).`;
    reportLibraryRowStale(projectId, relPath, reason);
    return { ok: false, reason };
  }
  return finishLibraryDocumentSave(projectId, backend!, relPath, bytes);
}

function reportLibraryRowStale(projectId: string, relPath: string, reason: string): void {
  ensureRowRefreshCommand();
  const label = libraryLabelOf(projectId);
  reportProblem({
    id: libraryRowStaleProblemId(projectId, relPath),
    severity: 'warning',
    code: LIBRARY_ROW_STALE_CODE,
    title: `Library '${label}': "${relPath}" was saved, but its entry was not updated`,
    detail: `Projects that use '${label}' keep showing the previous version of this part until the entry is updated. ${reason}`,
    action: { label: 'Retry', commandId: LIBRARY_ROW_REFRESH_COMMAND, args: { projectId, path: relPath } },
  });
}

function ensureRowRefreshCommand(): void {
  if (commandRegistry.get(LIBRARY_ROW_REFRESH_COMMAND)) return;
  const impl: CommandImpl<{ projectId: string; path: string }, LibraryRowUpdate> = {
    enabled: () => true,
    run: async (_ctx, a) => {
      const r = await refreshLibraryDocumentRow(String(a?.projectId ?? ''), String(a?.path ?? ''));
      if (!r.ok) throw new CommandError(r.reason);
      return r;
    },
  };
  commandRegistry.register({
    id: LIBRARY_ROW_REFRESH_COMMAND, label: 'Update library entry', readOnly: false, scope: 'none',
    available: true, unavailableReason: 'Libraries need an open project.',
    argsSchema: { projectId: 'string', path: 'string' },
    eagerImpl: impl as CommandImpl<never, unknown>,
    impl: () => Promise.resolve(impl as CommandImpl<never, unknown>),
  } as CommandDescriptor<never, unknown>);
}
