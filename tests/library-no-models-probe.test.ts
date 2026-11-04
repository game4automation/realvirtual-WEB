// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-778 Phase 5 fix (live check 2026-11-03): a library-project backend never
 * probes `models.json`.
 *
 * The built-in realvirtual library at `<BASE_URL>library/` was opened with
 * `BundledBackend({ discover: true })`, which fetches `<base>models.json` before
 * the manifest — three 404s in the console on every demo load. A library project
 * is its `project.json` and nothing else, so every backend the production
 * factory builds for a library (built-in, hosted hint, delivered relative copy)
 * must ask for `project.json` only.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { RvProject } from '../src/core/project/rv-project-types';
import { resetLibrarySourceRegistryForTests } from '../src/core/library/library-source-registry';
import { LibraryProjectLoader } from '../src/core/library/library-project-loader';
import {
  createLibraryBackendFactory,
  createLibraryProjectLoaderDeps,
  openRelativeToBackend,
} from '../src/core/library/library-project-backends';
import { installLibraryProjectsProvider, uninstallLibraryProjectsProvider } from '../src/core/library/library-projects-provider';
import { BundledBackend } from '../src/core/project/backends/bundled-backend';
import { REALVIRTUAL_LIBRARY_PROJECT_ID } from '../src/core/library/library-origin';
import libraryProject from '../public/library/project.json';

const BUILTIN = 'https://app.test/library/';
const HOSTED = 'https://hosted.test/libs/prj_b/';

const B_MANIFEST = {
  schemaVersion: 2, id: 'prj_b', name: 'B', canonicalName: 'b',
  documents: [{ id: 'models/pump', name: 'Pump', path: 'models/pump.glb' }],
};

afterEach(() => {
  uninstallLibraryProjectsProvider();
  resetLibrarySourceRegistryForTests();
  vi.unstubAllGlobals();
});

/** Every URL fetched; `project.json` answers for the two known bases, anything else 404s. */
function stubFetch(): string[] {
  const seen: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input).split('?')[0];
    seen.push(url);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url === `${BUILTIN}project.json`) return json(libraryProject);
    if (url === `${HOSTED}project.json`) return json(B_MANIFEST);
    return new Response('not found', { status: 404 });
  }));
  return seen;
}

function projectA(libraries: unknown[]): RvProject {
  return { schemaVersion: 2, id: 'prj_a', name: 'A', canonicalName: 'a', libraries } as unknown as RvProject;
}

const probedModels = (seen: string[]) => seen.filter((u) => /models\.json$/i.test(u));

describe('library-project backends never probe models.json', () => {
  it('the built-in realvirtual library resolves from project.json alone', async () => {
    const seen = stubFetch();
    const loader = new LibraryProjectLoader({ ...createLibraryProjectLoaderDeps(), builtinBaseUrl: () => BUILTIN });
    installLibraryProjectsProvider(loader);
    loader.setProject(projectA([{ projectId: REALVIRTUAL_LIBRARY_PROJECT_ID }]));
    await loader.whenSettled();

    const node = loader.getNode(REALVIRTUAL_LIBRARY_PROJECT_ID);
    expect(node?.state.kind).toBe('ready');
    expect(seen).toContain(`${BUILTIN}project.json`);
    expect(probedModels(seen)).toEqual([]);
  });

  it('a hosted library (URL hint) resolves from project.json alone', async () => {
    const seen = stubFetch();
    const loader = new LibraryProjectLoader({
      ...createLibraryProjectLoaderDeps(),
      builtinBaseUrl: () => BUILTIN,
      getLinkedHandle: async () => null,
    });
    installLibraryProjectsProvider(loader);
    loader.setProject(projectA([{ projectId: 'prj_b', hint: HOSTED }]));
    await loader.whenSettled();

    const node = loader.getNode('prj_b');
    expect(node?.state.kind).toBe('ready');
    expect(seen).toContain(`${HOSTED}project.json`);
    expect(probedModels(seen)).toEqual([]);
  });

  it('the factory and the delivered relative copy build non-discovering backends', async () => {
    const seen = stubFetch();
    const remote = createLibraryBackendFactory().remote(HOSTED);
    expect((await remote.readManifest())?.id).toBe('prj_b');

    const hostedA = new BundledBackend({ baseUrl: 'https://hosted.test/', basePath: 'libs/' });
    const relative = await openRelativeToBackend(hostedA, 'prj_b', 'prj_b');
    expect(relative?.via).toBe('hosted');
    expect((await relative!.backend.readManifest())?.id).toBe('prj_b');
    // A manifest-less host is still no library — and still no models.json probe.
    expect(await createLibraryBackendFactory().remote('https://hosted.test/nothing/').readManifest()).toBeNull();

    expect(probedModels(seen)).toEqual([]);
  });
});
