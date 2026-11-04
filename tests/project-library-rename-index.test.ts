// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-655 F5 — a project part stays placeable right after a rename / move.
 *
 * Reproduction of "Asset 'Untitled 8.glb' could not be read": the project
 * library provider keeps a SNAPSHOT listing and refreshes it asynchronously
 * when the store publishes. A place by documentId in that window resolved the
 * OLD path. Measured separately: (a) the backend listing, (b) the provider
 * snapshot, (c) the resolve. Fix: the resolve reads the current manifest path
 * of the document id; MCP renames await `refreshProjectLibrary()`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  installProjectLibraryProvider,
  refreshProjectLibrary,
  uninstallProjectLibraryProvider,
  PROJECT_LIBRARY_PROVIDER_ID,
  type ProjectStoreLike,
} from '../src/core/library/project-library-provider';
import { listLibrarySources } from '../src/core/library/library-source-registry';
import type { RvDocumentEntry, RvProject } from '../src/core/project/rv-project-types';

/** Store + backend double: files by path, a manifest, and a SLOW listing. */
function world(): {
  store: ProjectStoreLike;
  rename(from: string, to: string): void;
  listings: number;
} {
  const files = new Map<string, string>([['library/Untitled 8.glb', 'glb-bytes']]);
  let project = {
    id: 'p1', name: 'Demo', version: 1,
    documents: [{ id: 'doc-8', path: 'library/Untitled 8.glb', name: 'Untitled 8' }],
  } as unknown as RvProject;
  const listeners = new Set<() => void>();
  const state = { listings: 0 };
  const backend = {
    kind: 'browser', writable: true,
    listDocuments: async (): Promise<RvDocumentEntry[]> => {
      state.listings++;
      const snapshot = (project.documents ?? []).map((d) => ({ ...d }));
      // A slow listing (after the first): the window a place by id fell into.
      if (state.listings > 1) await new Promise<void>((r) => setTimeout(r, 40));
      return snapshot as RvDocumentEntry[];
    },
    readDocumentUrl: async (path: string) =>
      (files.has(path) ? { url: `blob:${path}`, release: () => {} } : null),
  };
  const store: ProjectStoreLike = {
    subscribe: (l) => { listeners.add(l); return () => listeners.delete(l); },
    getBackend: () => backend as never,
    getProject: () => project,
  };
  return {
    store,
    rename(from, to) {
      files.set(to, files.get(from)!);
      files.delete(from);
      project = {
        ...project,
        documents: (project.documents ?? []).map((d) => (d.path === from ? { ...d, path: to } : d)),
      } as RvProject;
      for (const l of listeners) l();
    },
    get listings() { return state.listings; },
  };
}

function source() {
  return listLibrarySources().find((s) => s.providerId === PROJECT_LIBRARY_PROVIDER_ID)!.source;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('plan-655 F5 — index after rename / move', () => {
  afterEach(() => uninstallProjectLibraryProvider());

  it('reproduction: right after a rename the provider snapshot is stale, the backend already moved', async () => {
    const w = world();
    installProjectLibraryProvider(w.store);
    await settle();
    expect(source().listEntries().map((e) => e.localPath)).toEqual(['library/Untitled 8.glb']);
    w.rename('library/Untitled 8.glb', 'library/Interroll/RM8320.glb');
    await settle();
    // (b) provider snapshot: still the OLD path while the listing is in flight.
    expect(source().listEntries().map((e) => e.localPath)).toEqual(['library/Untitled 8.glb']);
    // (c) the resolve by document id nevertheless reads the NEW file.
    const byDoc = await source().resolveAsset('doc-8', 'place');
    expect(byDoc.url).toBe('blob:library/Interroll/RM8320.glb');
    // ... and by the stale catalog id too (same document).
    const byOldId = await source().resolveAsset('project:library/Untitled 8.glb', 'place');
    expect(byOldId.url).toBe('blob:library/Interroll/RM8320.glb');
  });

  it('after refreshProjectLibrary() (what web_document_update awaits) the entry carries the new path — rename AND move', async () => {
    const w = world();
    installProjectLibraryProvider(w.store);
    await settle();
    w.rename('library/Untitled 8.glb', 'library/RM8320.glb');
    await refreshProjectLibrary();
    expect(source().getEntry('doc-8')?.localPath).toBe('library/RM8320.glb');
    // Move into a sub-folder.
    w.rename('library/RM8320.glb', 'library/Interroll/RM8320.glb');
    await refreshProjectLibrary();
    const entry = source().getEntry('doc-8')!;
    expect(entry.id).toBe('project:library/Interroll/RM8320.glb');
    expect((await source().resolveAsset(entry.id, 'place')).url).toBe('blob:library/Interroll/RM8320.glb');
  });
});
