// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * bundled-backend-basepath — the demo reads from its own folder (plan-737 9.1).
 *
 * plan-737 moved the demo project out of the deploy root and into
 * `demo-realvirtual/`. `BundledBackend` follows it with ONE mechanism — a base
 * path folded in by `_url()` — and this file pins the three things that makes
 * true, plus the one thing it must NOT do:
 *
 *  - every relative read is prefixed, not just `project.json`;
 *  - an absolute URL is still passed through untouched (a foreign deploy's
 *    `models.json` rows are absolute, and re-basing them would break plan-700 F12);
 *  - the library catalog stays deploy-root-relative, because the library is
 *    app-level and sits BESIDE the demo folder;
 *  - `getBundledBackend()` yields the same base path no matter which call site
 *    happens to construct the singleton first (the Runde-1 blocker).
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  BundledBackend,
  DEMO_BASE_PATH,
  DEMO_PROJECT_FOLDER,
  REALVIRTUAL_LIBRARY_PATH,
} from '../src/core/project/backends/bundled-backend';
import { ProjectStore, resetProjectStore } from '../src/core/project/project-store';

const MANIFEST = {
  schemaVersion: 2,
  id: 'prj_sample',
  name: 'DemoRealvirtual',
  canonicalName: 'demorealvirtual',
  kind: 'demo',
  settings: { defaultModel: 'DemoRealvirtualWeb.glb' },
  documents: [{ id: 'doc_a', name: 'Web Demo', path: 'DemoRealvirtualWeb.glb' }],
};

/** A backend that records every URL it is asked for and serves the manifest. */
function recording(opts: { basePath?: string } = {}) {
  const urls: string[] = [];
  const backend = new BundledBackend({
    baseUrl: '/',
    ...opts,
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith('project.json')) {
        return { ok: true, status: 200, json: async () => MANIFEST } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => null,
        arrayBuffer: async () => new ArrayBuffer(8),
      } as unknown as Response;
    }) as typeof fetch,
  });
  return { backend, urls };
}

describe('BundledBackend base path', () => {
  it('reads the manifest from the demo folder', async () => {
    const { backend, urls } = recording({ basePath: DEMO_BASE_PATH });
    await backend.readManifest();
    expect(urls).toContain('/demo-realvirtual/project.json');
    expect(urls).not.toContain('/project.json');
  });

  it('prefixes document URLs too, not only the manifest', async () => {
    const { backend } = recording({ basePath: DEMO_BASE_PATH });
    const resolved = await backend.readDocumentUrl({ path: 'DemoRealvirtualWeb.glb' });
    expect(resolved?.url).toBe('/demo-realvirtual/DemoRealvirtualWeb.glb');
  });

  it('leaves an absolute URL alone — a foreign deploy publishes those', async () => {
    // plan-700 F12: `_withDiscoveredModels` folds a foreign host's models.json
    // in as ABSOLUTE urls. Re-basing one would point it at our own origin.
    const { backend } = recording({ basePath: DEMO_BASE_PATH });
    const resolved = await backend.readDocumentUrl({ path: 'https://cdn.example/x/Press.glb' });
    expect(resolved?.url).toBe('https://cdn.example/x/Press.glb');
  });

  it('is empty by default, so a root/remote backend still reads the root', async () => {
    const { backend, urls } = recording();
    await backend.readManifest();
    expect(backend.basePath).toBe('');
    expect(urls).toContain('/project.json');
  });

  it('tolerates the sloppy spellings of the folder', () => {
    for (const spelling of [DEMO_PROJECT_FOLDER, `/${DEMO_PROJECT_FOLDER}`, `${DEMO_PROJECT_FOLDER}/`]) {
      expect(new BundledBackend({ basePath: spelling }).basePath).toBe(DEMO_BASE_PATH);
    }
  });

  it('keeps the library catalog root-relative — it is app-level, not the demo\'s', () => {
    // The library sits BESIDE `demo-realvirtual/`, is shared by every project,
    // and is reached through the manifest's `libraries[]` (resolved against the
    // page base by library-store), never through this backend's `_url()`.
    expect(REALVIRTUAL_LIBRARY_PATH).toBe('library/catalog.json');
    expect(REALVIRTUAL_LIBRARY_PATH.startsWith(DEMO_PROJECT_FOLDER)).toBe(false);
  });

  it('gives the root and the demo instance different ids on one deploy', () => {
    // They share a base URL and differ only by folder; ids are how everything
    // downstream tells two backends apart.
    const demo = new BundledBackend({ baseUrl: '/', basePath: DEMO_BASE_PATH });
    const root = new BundledBackend({ baseUrl: '/' });
    expect(demo.id).not.toBe(root.id);
  });
});

describe('getBundledBackend() call order is irrelevant (plan-737 9.7)', () => {
  beforeEach(() => { resetProjectStore(); });

  it('yields the demo base path whichever call site constructs it first', () => {
    // The singleton discards `opts` on every call but the first, and there are
    // four call sites with four different options. Constructing the base path
    // INSIDE the factory is what makes that harmless — this asserts it by
    // driving the factory from the two extremes of the option space.
    const first = new ProjectStore();
    expect(first.getBundledBackend({ baseUrl: '/', models: [] }).basePath).toBe(DEMO_BASE_PATH);
    // A later caller cannot move it, and cannot override it either.
    expect(first.getBundledBackend({ basePath: '' }).basePath).toBe(DEMO_BASE_PATH);

    const second = new ProjectStore();
    expect(second.getBundledBackend({ basePath: 'somewhere-else/' }).basePath).toBe(DEMO_BASE_PATH);
    expect(second.getBundledBackend().basePath).toBe(DEMO_BASE_PATH);
  });

  it('hands out a separate ROOT backend that reads the deploy root', () => {
    const store = new ProjectStore();
    expect(store.getRootBackend().basePath).toBe('');
    expect(store.getRootBackend()).toBe(store.getRootBackend());       // cached
    expect(store.getRootBackend()).not.toBe(store.getBundledBackend()); // and distinct
  });
});
