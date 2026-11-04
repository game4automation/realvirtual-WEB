// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-778 9.1 — `project.json.libraries[]` refs round trip.
 *
 * Before plan-778 the writer matched entries by `url` and dropped everything
 * without one — exactly the shape of a library PROJECT ref `{projectId}`. These
 * tests pin: typed read (bare strings, unknown keys), a writer keyed
 * `projectId ?? url`, and that a `{projectId}` entry survives every caller that
 * writes the list (attach / detach of a URL entry, the URL-only view writer).
 */
import { describe, it, expect } from 'vitest';
import type { RvProject } from '../src/core/project/rv-project-types';
import {
  libraryRefKey,
  libraryRefsSignature,
  readLibraryProjectRefs,
  readLibraryRefs,
  readProjectLibraries,
  withLibraryRefs,
  withProjectLibraries,
} from '../src/core/library/project-libraries';
import {
  attachLibraryToProject,
  detachLibraryFromProject,
  listLibraries,
  type AttachLibraryStoreLike,
  type AttachProjectStoreLike,
} from '../src/core/library/project-library-attach';

// An external URL catalog (plan-778 Phase 4: the bundled library catalog.json is gone).
const CATALOG = 'https://host/partner/catalog.json';
const OTHER = 'https://other/catalog.json';
const LIB = { projectId: 'prj_shared_conv', label: 'SharedConveyors', hint: 'SharedConveyors', future: { x: 1 } };

function base(libraries?: unknown[]): RvProject {
  return {
    schemaVersion: 2, id: 'prj_a', name: 'A', canonicalName: 'a',
    ...(libraries ? { libraries } : {}),
  } as unknown as RvProject;
}

/** A project store double whose manifest writes go through `applyManifestDelta`. */
function projectStore(initial: RvProject): AttachProjectStoreLike & { current(): RvProject } {
  let project = initial;
  const backend = { id: 'b' };
  return {
    getProject: () => project,
    getBackend: () => backend,
    applyManifestDelta: async (apply) => { project = apply(project); return project; },
    current: () => project,
  };
}

/** A catalog store double — every URL loads. */
function libraryStore(): AttachLibraryStoreLike & { applied: string[][] } {
  const urls: string[] = [];
  const catalogs = new Map<string, { name?: string; entries: never[] }>();
  const applied: string[][] = [];
  return {
    applied,
    get catalogUrls() { return urls; },
    catalogErrors: new Map(),
    catalogs: catalogs as never,
    async addCatalog(url: string) { if (!urls.includes(url)) urls.push(url); catalogs.set(url, { name: url, entries: [] }); },
    removeCatalog(url: string) { const i = urls.indexOf(url); if (i >= 0) urls.splice(i, 1); catalogs.delete(url); },
    async applyProjectLibraries(list: string[]) { applied.push([...list]); },
    getOrigin: () => 'projectManifest',
  } as unknown as AttachLibraryStoreLike & { applied: string[][] };
}

describe('plan-778 9.1 — readLibraryRefs / withLibraryRefs', () => {
  it('reads {projectId}, {url} and bare strings, de-duplicated by key, unknown keys kept', () => {
    const refs = readLibraryRefs(base([LIB, { url: CATALOG, label: 'RV' }, CATALOG, '  ', { label: 'no key' }, { ...LIB }]));
    expect(refs).toEqual([LIB, { url: CATALOG, label: 'RV' }]);
    expect(readLibraryProjectRefs(base([LIB, CATALOG]))).toEqual([LIB]);
    expect(readLibraryRefs(null)).toEqual([]);
    expect(readLibraryRefs(base({} as never))).toEqual([]);
    expect(libraryRefKey({ projectId: ' p ', url: 'u' })).toBe('p');
    expect(libraryRefKey({ url: ' u ' })).toBe('u');
  });

  it('writes keyed by projectId ?? url: merges over the stored entry, keeps unknown keys, drops the rest', () => {
    const project = base([LIB, { url: CATALOG, label: 'RV', extra: 7 }, OTHER]);
    const next = withLibraryRefs(project, [{ url: CATALOG }, { projectId: 'prj_shared_conv' }, { projectId: 'prj_new', hint: 'https://h/' }]);
    expect(next.libraries).toEqual([
      { url: CATALOG, label: 'RV', extra: 7 },
      LIB,
      { projectId: 'prj_new', hint: 'https://h/' },
    ]);
    expect('libraries' in withLibraryRefs(project, [])).toBe(false);
    expect(withLibraryRefs(base(), [])).toEqual(base());
  });

  it('the URL-only view never sees or drops a {projectId} entry', () => {
    const project = base([{ url: CATALOG }, LIB, { url: OTHER }]);
    expect(readProjectLibraries(project)).toEqual([CATALOG, OTHER]);
    const next = withProjectLibraries(project, [OTHER]);
    expect(next.libraries).toEqual([LIB, { url: OTHER }]);
    const reordered = withProjectLibraries(project, [OTHER, CATALOG]);
    expect(readProjectLibraries(reordered)).toEqual([OTHER, CATALOG]);
    expect(readLibraryProjectRefs(reordered)).toEqual([LIB]);
    // No URLs left: the project ref keeps the section alive.
    expect(withProjectLibraries(project, []).libraries).toEqual([LIB]);
  });

  it('the sync signature changes with projectId, url AND hint (main.ts re-syncs on it)', () => {
    const a = libraryRefsSignature(base([LIB]));
    expect(libraryRefsSignature(base([{ ...LIB, hint: 'https://elsewhere/' }]))).not.toBe(a);
    expect(libraryRefsSignature(base([{ ...LIB, projectId: 'prj_other' }]))).not.toBe(a);
    expect(libraryRefsSignature(base([LIB, CATALOG]))).not.toBe(a);
    expect(libraryRefsSignature(base([{ ...LIB, label: 'renamed' }]))).toBe(a);
  });
});

describe('plan-778 9.1 — {projectId} survives every writer', () => {
  it('attach of a URL entry keeps the library project ref (and its unknown keys)', async () => {
    const store = projectStore(base([LIB]));
    const lib = libraryStore();
    const res = await attachLibraryToProject(CATALOG, 'RV', { project: store, library: lib });
    expect(res.ok).toBe(true);
    expect(store.current().libraries).toEqual([LIB, { url: CATALOG, label: 'RV' }]);
    // The catalog store is told about URLs only.
    expect(lib.applied.at(-1)).toEqual([CATALOG]);
  });

  it('attach of an already attached URL is idempotent and keeps the project ref', async () => {
    const store = projectStore(base([{ url: CATALOG, label: 'RV' }, LIB]));
    const res = await attachLibraryToProject(CATALOG, null, { project: store, library: libraryStore() });
    expect(res.ok && res.alreadyAttached).toBe(true);
    expect(store.current().libraries).toEqual([{ url: CATALOG, label: 'RV' }, LIB]);
  });

  it('detach of a URL entry keeps the library project ref', async () => {
    const store = projectStore(base([{ url: CATALOG }, LIB, OTHER]));
    const res = await detachLibraryFromProject(CATALOG, { project: store, library: libraryStore() });
    expect(res.ok).toBe(true);
    expect(store.current().libraries).toEqual([LIB, { url: OTHER }]);
  });

  it('detach of the last URL keeps the section for the project ref', async () => {
    const store = projectStore(base([{ url: CATALOG }, LIB]));
    await detachLibraryFromProject(CATALOG, { project: store, library: libraryStore() });
    expect(store.current().libraries).toEqual([LIB]);
  });

  it('listLibraries reads the label of a URL entry without tripping over a project ref', () => {
    const store = projectStore(base([LIB, { url: CATALOG, label: 'RV' }]));
    const list = listLibraries({ project: store, library: libraryStore() });
    expect(list.libraries.map((r) => [r.url, r.label, r.scope])).toEqual([[CATALOG, 'RV', 'project']]);
  });
});
