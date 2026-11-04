// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Edit in library, synchronous half (plan-778): the backend a library document saves through. Eager — keep small. */

import type { ProjectBackend } from '../project/backends/project-backend';
import { getLibraryProjectLoader, type LibraryProjectNode } from './library-project-loader';

/** A writable folder backend granted by Edit in library. */
export type LibraryWriteBackend = ProjectBackend & { readonly directory: FileSystemDirectoryHandle; deactivate(): Promise<void> };

const writeBackends = new Map<string, LibraryWriteBackend>();

/** A folder backend's directory, duck-typed. */
export function folderDirOf(backend: ProjectBackend | null | undefined): FileSystemDirectoryHandle | null {
  if (backend?.kind !== 'folder') return null;
  return (backend as unknown as { directory?: FileSystemDirectoryHandle }).directory ?? null;
}

export function libraryNodeOf(projectId: string): LibraryProjectNode | null {
  return getLibraryProjectLoader()?.getNode(projectId) ?? null;
}

export function libraryLabelOf(projectId: string, node: LibraryProjectNode | null = libraryNodeOf(projectId)): string {
  return node?.label || projectId;
}

/** B's folder handle (a ready folder library only). */
export function libraryFolderHandle(node: LibraryProjectNode | null): FileSystemDirectoryHandle | null {
  const state = node?.state;
  return state?.kind === 'ready' ? folderDirOf(state.backend) : null;
}

/** Keyed by B's id: a re-read hands out a fresh handle clone (review E2). */
export function setLibraryWriteBackend(projectId: string, backend: LibraryWriteBackend): void {
  writeBackends.set(projectId, backend);
}

/** B's granted write backend, while B is a library of the open project. */
export function getLibraryWriteBackend(projectId: string): LibraryWriteBackend | null {
  return libraryNodeOf(projectId) ? writeBackends.get(projectId) ?? null : null;
}

/** B's write backend after Edit in library, else its read-only loader backend, else null. */
export function librarySaveBackend(projectId: string): ProjectBackend | null {
  const granted = getLibraryWriteBackend(projectId);
  if (granted) return granted;
  const state = libraryNodeOf(projectId)?.state;
  return state?.kind === 'ready' ? state.backend : null;
}

/** Forget B's grant (Locate, detach — review E5). */
export function releaseLibraryWriteGrant(projectId: string): void {
  void writeBackends.get(projectId)?.deactivate().catch(() => {});
  writeBackends.delete(projectId);
}

/** Forget the grants `keep` rejects (all by default); returns how many are left. */
export function releaseLibraryWriteGrants(keep?: (projectId: string) => boolean): number {
  for (const id of [...writeBackends.keys()]) if (!keep?.(id)) releaseLibraryWriteGrant(id);
  return writeBackends.size;
}
