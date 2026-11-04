// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-778 Phase 3 — the REAL `public/library/project.json` through the REAL
 * production loader deps and `BundledBackend` (only `fetch` is stubbed).
 *
 * The built-in location of `prj_realvirtual_library` (Phase 1 loader step 0)
 * must resolve to `ready` with the 26 documents of today's catalog, placeable
 * only when a project lists it (Decision C), and the GitHub-scan id of every
 * file must answer as an alias.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { RvProject } from '../src/core/project/rv-project-types';
import { resetLibrarySourceRegistryForTests, getLibrarySource } from '../src/core/library/library-source-registry';
import { LibraryProjectLoader } from '../src/core/library/library-project-loader';
import { createLibraryProjectLoaderDeps } from '../src/core/library/library-project-backends';
import {
  LIBRARY_PROJECTS_PROVIDER_ID,
  installLibraryProjectsProvider,
  uninstallLibraryProjectsProvider,
} from '../src/core/library/library-projects-provider';
import { REALVIRTUAL_LIBRARY_PROJECT_ID, findLegacyOrigin } from '../src/core/library/library-origin';
import libraryProject from '../public/library/project.json';
import fixtureIds from './fixtures/realvirtual-library-ids.json';

const BASE = 'https://app.test/library/';

afterEach(() => {
  uninstallLibraryProjectsProvider();
  resetLibrarySourceRegistryForTests();
  vi.unstubAllGlobals();
});

function stubFetch(): string[] {
  const seen: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    if (url.split('?')[0] === `${BASE}project.json`) {
      return new Response(JSON.stringify(libraryProject), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  }));
  return seen;
}

function projectA(libraries?: unknown[]): RvProject {
  return { schemaVersion: 2, id: 'prj_a', name: 'A', canonicalName: 'a', ...(libraries ? { libraries } : {}) } as unknown as RvProject;
}

async function boot(project: RvProject): Promise<LibraryProjectLoader> {
  const loader = new LibraryProjectLoader({ ...createLibraryProjectLoaderDeps(), builtinBaseUrl: () => BASE });
  installLibraryProjectsProvider(loader);
  loader.setProject(project);
  await loader.whenSettled();
  return loader;
}

describe('the bundled realvirtual library project (built-in location)', () => {
  it('resolves to ready from <base>library/project.json with the 26 catalog documents', async () => {
    const seen = stubFetch();
    const loader = await boot(projectA([{ projectId: REALVIRTUAL_LIBRARY_PROJECT_ID, label: 'realvirtual Library', hint: 'library/project.json' }]));
    expect(seen.some((u) => u.startsWith(`${BASE}project.json`))).toBe(true);

    const node = loader.getNode(REALVIRTUAL_LIBRARY_PROJECT_ID)!;
    expect(node.state.kind).toBe('ready');
    if (node.state.kind === 'ready') expect(node.state.via).toBe('builtin');
    expect([node.direct, node.placeable]).toEqual([true, true]);

    const source = getLibrarySource(LIBRARY_PROJECTS_PROVIDER_ID, REALVIRTUAL_LIBRARY_PROJECT_ID)!;
    expect([source.loaded, source.hidden, source.writable]).toEqual([true, false, false]);
    const entries = source.listEntries();
    expect(entries).toHaveLength(26);
    expect(entries.map((e) => e.id).sort()).toEqual([...fixtureIds].sort());
  });

  it('every document also answers to the GitHub-scan id (alias, legacy lookup only)', async () => {
    stubFetch();
    await boot(projectA([{ projectId: REALVIRTUAL_LIBRARY_PROJECT_ID }]));
    const source = getLibrarySource(LIBRARY_PROJECTS_PROVIDER_ID, REALVIRTUAL_LIBRARY_PROJECT_ID)!;
    const chain = source.getEntry('pallethandling-chainconveyor-1m')!;
    expect(chain).not.toBeNull();
    const scanId = 'realvirtual-library-pallethandling-chainconveyor-1m-glb';
    expect(source.getEntry(scanId)).toBeNull();
    expect(source.getAliasEntry!(scanId)).toBe(chain);
    expect(findLegacyOrigin(scanId)?.source.id).toBe(REALVIRTUAL_LIBRARY_PROJECT_ID);
    expect(findLegacyOrigin("pallethandling-chainconveyor-1m")?.source.id).toBe(REALVIRTUAL_LIBRARY_PROJECT_ID);
  });

  it('a project that does not list it still resolves legacy refs but cannot place from it (Decision C)', async () => {
    stubFetch();
    const loader = await boot(projectA());
    const node = loader.getNode(REALVIRTUAL_LIBRARY_PROJECT_ID)!;
    expect(node.state.kind).toBe('ready');
    expect([node.direct, node.placeable]).toEqual([false, false]);
    expect(getLibrarySource(LIBRARY_PROJECTS_PROVIDER_ID, REALVIRTUAL_LIBRARY_PROJECT_ID)!.hidden).toBe(true);
    expect(findLegacyOrigin('realvirtual-library-robots-fanuccrx-10ia-l-glb')?.source.id).toBe(REALVIRTUAL_LIBRARY_PROJECT_ID);
  });
});
