// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-778 9.3 — the library-projects provider: one cached source per library
 * project, registry flags that make `isPending` exact, never blocking.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { ProjectBackend } from '../src/core/project/backends/project-backend';
import type { RvProject } from '../src/core/project/rv-project-types';
import {
  getLibrarySource,
  hasPendingLibrarySources,
  listBrowsableLibrarySources,
  listLibrarySources,
  resetLibrarySourceRegistryForTests,
} from '../src/core/library/library-source-registry';
import { LibraryProjectLoader, type LibraryProjectLoaderDeps } from '../src/core/library/library-project-loader';
import {
  LIBRARY_PROJECTS_PROVIDER_ID,
  indexScanCatalog,
  installLibraryProjectsProvider,
  isLibraryProjectSource,
  uninstallLibraryProjectsProvider,
} from '../src/core/library/library-projects-provider';
import {
  REALVIRTUAL_LIBRARY_PROJECT_ID,
  entryOriginOf,
  findLegacyOrigin,
  findQualifiedOrigin,
} from '../src/core/library/library-origin';
import { fakeLibraryProject } from './helpers/fake-document-project';

function projectA(libraries: unknown[]): RvProject {
  return { schemaVersion: 2, id: 'prj_a', name: 'A', canonicalName: 'a', libraries } as unknown as RvProject;
}

function deps(browsers: Record<string, ProjectBackend>, over: Partial<LibraryProjectLoaderDeps> = {}): LibraryProjectLoaderDeps {
  return {
    factory: {
      folder: () => { throw new Error('no folders here'); },
      browser: (id) => browsers[id] ?? null,
      remote: () => ({ readManifest: async () => null }) as unknown as ProjectBackend,
    },
    getLinkedHandle: async () => null,
    hasReadPermission: async () => false,
    builtinBaseUrl: () => null,
    ...over,
  };
}

afterEach(() => {
  uninstallLibraryProjectsProvider();
  resetLibrarySourceRegistryForTests();
  vi.useRealTimers();
});

describe('plan-778 9.3 — sources', () => {
  it('one source per library, keyed by document id, aliases separate, origin stamped', async () => {
    const b = fakeLibraryProject({
      id: 'prj_b', name: 'SharedConveyors',
      documents: [{ id: 'models/pump', path: 'models/pump.glb', aliases: ['legacy-pump-glb'] }],
    });
    const loader = new LibraryProjectLoader(deps({ prj_b: b.backend }));
    installLibraryProjectsProvider(loader);
    loader.setProject(projectA([{ projectId: 'prj_b' }]));
    await loader.whenSettled();

    const source = getLibrarySource(LIBRARY_PROJECTS_PROVIDER_ID, 'prj_b')!;
    expect(isLibraryProjectSource(source)).toBe(true);
    expect([source.label, source.writable, source.loaded, source.hidden]).toEqual(['SharedConveyors', false, true, false]);
    const entry = source.getEntry('models/pump')!;
    expect(entry.id).toBe('models/pump');
    expect(entry.libraryOrigin).toEqual({ providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: 'prj_b' });
    expect(source.getEntry('project:models/pump.glb')).toBeNull();
    expect(source.getEntry('legacy-pump-glb')).toBeNull();          // canonical lookup never sees aliases
    expect(source.getAliasEntry!('legacy-pump-glb')).toBe(entry);
    expect(entryOriginOf(entry)).toEqual({ assetId: 'models/pump', providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: 'prj_b' });
    expect(entryOriginOf({ ...entry, libraryOrigin: undefined }).sourceId).toBeUndefined();

    const resolved = await source.resolveAsset('models/pump', 'place');
    expect(b.outstandingUrls()).toBe(1);
    resolved.revokeUrl!();
    expect(b.outstandingUrls()).toBe(0);
  });

  it('source objects are stable: same array between changes, untouched nodes keep their object', async () => {
    const b = fakeLibraryProject({ id: 'prj_b', documents: [{ id: 'd', path: 'd.glb' }] });
    const c = fakeLibraryProject({ id: 'prj_c', documents: [{ id: 'd', path: 'd.glb' }] });
    const loader = new LibraryProjectLoader(deps({ prj_b: b.backend, prj_c: c.backend }));
    installLibraryProjectsProvider(loader);
    loader.setProject(projectA([{ projectId: 'prj_b' }, { projectId: 'prj_c' }]));
    await loader.whenSettled();
    const provider = listLibrarySources().filter((s) => s.providerId === LIBRARY_PROJECTS_PROVIDER_ID);
    const first = getLibrarySource(LIBRARY_PROJECTS_PROVIDER_ID, 'prj_b');
    expect(getLibrarySource(LIBRARY_PROJECTS_PROVIDER_ID, 'prj_b')).toBe(first);
    loader.markError('prj_c', 'gone');
    expect(getLibrarySource(LIBRARY_PROJECTS_PROVIDER_ID, 'prj_b')).toBe(first);
    expect(getLibrarySource(LIBRARY_PROJECTS_PROVIDER_ID, 'prj_c')!.error).toBe('gone');
    expect(provider.length).toBe(3);   // b, c, built-in
  });

  it('pending → locked: needsPermission, and nothing is pending right after the publish (no wall clock)', async () => {
    vi.useFakeTimers();
    const handle = { name: 'B' } as unknown as FileSystemDirectoryHandle;
    const loader = new LibraryProjectLoader(deps({}, {
      getLinkedHandle: async (id) => (id === 'prj_b' ? handle : null),
      hasReadPermission: async () => false,
    }));
    installLibraryProjectsProvider(loader);
    loader.setProject(projectA([{ projectId: 'prj_b' }]));
    const pending = getLibrarySource(LIBRARY_PROJECTS_PROVIDER_ID, 'prj_b')!;
    expect([pending.loaded, pending.error, pending.needsPermission]).toEqual([false, null, undefined]);
    expect(hasPendingLibrarySources()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    const locked = getLibrarySource(LIBRARY_PROJECTS_PROVIDER_ID, 'prj_b')!;
    expect([locked.loaded, locked.needsPermission, locked.error]).toEqual([false, true, null]);
    expect(hasPendingLibrarySources()).toBe(false);
  });

  it('unknown and error are not pending either', async () => {
    const loader = new LibraryProjectLoader(deps({}));
    installLibraryProjectsProvider(loader);
    loader.setProject(projectA([{ projectId: 'prj_gone' }]));
    await loader.whenSettled();
    const s = getLibrarySource(LIBRARY_PROJECTS_PROVIDER_ID, 'prj_gone')!;
    expect(s.loaded).toBe(false);
    expect(s.error).toContain('unknown');
    expect(hasPendingLibrarySources()).toBe(false);
  });

  it('a hint that never answers times out after 3 s → unknown', async () => {
    vi.useFakeTimers();
    const never = { readManifest: () => new Promise<RvProject | null>(() => {}) } as unknown as ProjectBackend;
    const loader = new LibraryProjectLoader(deps({}, { factory: {
      folder: () => { throw new Error('x'); }, browser: () => null, remote: () => never,
    } }));
    installLibraryProjectsProvider(loader);
    loader.setProject(projectA([{ projectId: 'prj_b', hint: 'https://slow/b/' }]));
    await vi.advanceTimersByTimeAsync(2999);
    expect(loader.getNode('prj_b')!.state.kind).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(loader.getNode('prj_b')!.state.kind).toBe('unknown');
    expect(hasPendingLibrarySources()).toBe(false);
  });

  it('a runtime read failure turns the source from ready to error (F8)', async () => {
    const b = fakeLibraryProject({ id: 'prj_b', documents: [{ id: 'd', path: 'd.glb' }] });
    const loader = new LibraryProjectLoader(deps({ prj_b: b.backend }));
    installLibraryProjectsProvider(loader);
    loader.setProject(projectA([{ projectId: 'prj_b' }]));
    await loader.whenSettled();
    b.failReads(true);
    await expect(getLibrarySource(LIBRARY_PROJECTS_PROVIDER_ID, 'prj_b')!.resolveAsset('d', 'place')).rejects.toThrow();
    await vi.waitFor(() => expect(getLibrarySource(LIBRARY_PROJECTS_PROVIDER_ID, 'prj_b')!.loaded).toBe(false));
    const s = getLibrarySource(LIBRARY_PROJECTS_PROVIDER_ID, 'prj_b')!;
    expect([s.loaded, typeof s.error]).toEqual([false, 'string']);
  });

  it('plan-778 review C4: ONE missing file is a per-document miss — the library stays ready', async () => {
    const b = fakeLibraryProject({ id: 'prj_b', documents: [{ id: 'd', path: 'd.glb' }, { id: 'e', path: 'e.glb' }] });
    const loader = new LibraryProjectLoader(deps({ prj_b: b.backend }));
    installLibraryProjectsProvider(loader);
    loader.setProject(projectA([{ projectId: 'prj_b' }]));
    await loader.whenSettled();
    b.dropFile('d.glb');
    const before = b.readManifestCalls();
    await expect(getLibrarySource(LIBRARY_PROJECTS_PROVIDER_ID, 'prj_b')!.resolveAsset('d', 'place')).rejects.toThrow();
    // The library is re-probed (manifest read), found intact, and NOT marked failed.
    await vi.waitFor(() => expect(b.readManifestCalls()).toBeGreaterThan(before));
    await new Promise((r) => setTimeout(r, 0));
    const s = getLibrarySource(LIBRARY_PROJECTS_PROVIDER_ID, 'prj_b')!;
    expect([s.loaded, s.error]).toEqual([true, null]);
    expect(loader.getNode('prj_b')!.state.kind).toBe('ready');
    const other = await s.resolveAsset('e', 'place');
    expect(other.url).toMatch(/^blob:/);
    other.revokeUrl?.();
  });
});

describe('plan-778 9.3 — the built-in realvirtual library (Decision C)', () => {
  function builtinDeps(): LibraryProjectLoaderDeps {
    const rv = fakeLibraryProject({
      id: REALVIRTUAL_LIBRARY_PROJECT_ID, name: 'realvirtual Library', kind: 'bundled',
      documents: [{ id: 'pallethandling-chainconveyor-1m', path: 'PalletHandling/ChainConveyor-1m.glb' }],
    });
    return deps({}, {
      builtinBaseUrl: () => 'https://app/library/',
      factory: {
        folder: () => { throw new Error('x'); },
        browser: () => null,
        remote: (base) => (base === 'https://app/library/' ? rv.backend : ({ readManifest: async () => null }) as unknown as ProjectBackend),
      },
    });
  }

  it('resolvable without being listed, but hidden (not placeable)', async () => {
    const loader = new LibraryProjectLoader(builtinDeps());
    installLibraryProjectsProvider(loader);
    loader.setProject(projectA([]));
    await loader.whenSettled();
    const s = getLibrarySource(LIBRARY_PROJECTS_PROVIDER_ID, REALVIRTUAL_LIBRARY_PROJECT_ID)!;
    expect([s.loaded, s.hidden]).toEqual([true, true]);
    expect(isLibraryProjectSource(s) && s.placeable).toBe(false);
    expect(listBrowsableLibrarySources().some((r) => r.source === s)).toBe(false);
    expect(findQualifiedOrigin({
      providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: REALVIRTUAL_LIBRARY_PROJECT_ID, assetId: 'pallethandling-chainconveyor-1m',
    })).not.toBeNull();
    expect(findLegacyOrigin('pallethandling-chainconveyor-1m')?.source).toBe(s);
  });

  it('placeable when the project lists it', async () => {
    const loader = new LibraryProjectLoader(builtinDeps());
    installLibraryProjectsProvider(loader);
    loader.setProject(projectA([{ projectId: REALVIRTUAL_LIBRARY_PROJECT_ID }]));
    await loader.whenSettled();
    const s = getLibrarySource(LIBRARY_PROJECTS_PROVIDER_ID, REALVIRTUAL_LIBRARY_PROJECT_ID)!;
    expect([s.loaded, s.hidden]).toEqual([true, false]);
    expect(isLibraryProjectSource(s) && s.placeable).toBe(true);
  });
});

describe('plan-778 F13 — a GitHub repo scan as a library (no project.json yet)', () => {
  it('scan ids become aliases of the derived document ids', () => {
    const index = indexScanCatalog({
      version: '1.0', name: 'realvirtual-Library',
      entries: [{ id: 'realvirtual-library-pallethandling-chainconveyor-1m-glb', name: 'Chain', category: 'custom', glbUrl: 'https://raw/x.glb' }],
    }, { providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: REALVIRTUAL_LIBRARY_PROJECT_ID });
    expect([...index.byId.keys()]).toEqual(['pallethandling-chainconveyor-1m']);
    expect(index.byAlias.get('realvirtual-library-pallethandling-chainconveyor-1m-glb')?.id).toBe('pallethandling-chainconveyor-1m');
  });
});
