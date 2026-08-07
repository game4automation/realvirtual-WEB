// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-372 §9.7 — the two-level library SSOT and the origin policy (§2.6.3).
 *
 * The load-bearing case is the last one in the "origin policy" block: a URL
 * that arrives first from a config default and is THEN added explicitly by the
 * user must be promoted before `addCatalog`'s duplicate early-return fires.
 * Without that, the user's library silently disappears on the next restart.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { LibraryStore } from '../src/core/library/library-store';
import {
  readProjectLibraries,
  withProjectLibraries,
} from '../src/core/library/project-libraries';
import type { RvProject } from '../src/core/project/rv-project-types';

const URL_A = 'https://example.com/a/catalog.json';
const URL_B = 'https://example.com/b/catalog.json';
const GITHUB = 'https://github.com/acme/assets';

function okCatalog(): Response {
  return new Response(JSON.stringify({ version: '1.0', name: 'T', entries: [] }));
}

function persistedUrls(): string[] {
  return JSON.parse(localStorage.getItem('rv-layout-library-urls') ?? '[]');
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => okCatalog());
});
afterEach(() => vi.restoreAllMocks());

describe('origin policy', () => {
  test('a user subscription is persisted globally', async () => {
    const store = new LibraryStore();
    await store.addCatalog(URL_A, 'user');
    expect(persistedUrls()).toEqual([URL_A]);
    expect(store.getOrigin(URL_A)).toBe('user');
  });

  test('config / urlParam / projectManifest are NOT persisted globally', async () => {
    const store = new LibraryStore();
    await store.addCatalog(URL_A, 'config');
    await store.addCatalog(URL_B, 'urlParam');
    await store.addCatalog('https://example.com/c/catalog.json', 'projectManifest');
    // All three are loaded and usable this session…
    expect(store.catalogUrls).toHaveLength(3);
    // …but none of them leaks into the user's global list.
    expect(persistedUrls()).toEqual([]);
  });

  test('promotion is monotone — user never degrades back to config', async () => {
    const store = new LibraryStore();
    await store.addCatalog(URL_A, 'user');
    await store.addCatalog(URL_A, 'config');
    await store.addCatalog(URL_A, 'projectManifest');
    expect(store.getOrigin(URL_A)).toBe('user');
    expect(persistedUrls()).toEqual([URL_A]);
  });

  test('the duplicate early-return still PROMOTES (§2.6.3, the whole point)', async () => {
    const store = new LibraryStore();
    // Boot: the build default loads it — not persisted.
    await store.addCatalog(URL_A, 'config');
    expect(persistedUrls()).toEqual([]);

    // The user then adds the very same URL by hand. `addCatalog` returns early
    // because the tab already exists; the promotion must have happened first.
    await store.addCatalog(URL_A, 'user');
    expect(store.getOrigin(URL_A)).toBe('user');
    expect(persistedUrls()).toEqual([URL_A]);
  });

  test('the promoted origin survives a simulated restart', async () => {
    const first = new LibraryStore();
    await first.addCatalog(URL_A, 'config');
    await first.addCatalog(URL_A, 'user');

    // "Restart": a brand-new store over the same localStorage.
    const second = new LibraryStore();
    await second.restoreFromStorage();
    expect(second.catalogUrls).toEqual([URL_A]);
    expect(second.getOrigin(URL_A)).toBe('user');
  });

  test('removeCatalog forgets the origin too', async () => {
    const store = new LibraryStore();
    await store.addCatalog(URL_A, 'user');
    store.removeCatalog(URL_A);
    expect(store.getOrigin(URL_A)).toBeNull();
    expect(persistedUrls()).toEqual([]);
  });

  test('GitHub stays opt-in: never persisted, never auto-restored', async () => {
    const store = new LibraryStore();
    // A manual add loads it this session…
    await store.addCatalog(GITHUB, 'user');
    expect(store.catalogUrls).toContain(GITHUB);
    // …but it is never written to the global list.
    expect(persistedUrls()).not.toContain(GITHUB);

    // And a GitHub URL that leaked into storage is skipped on restore.
    localStorage.setItem('rv-layout-library-urls', JSON.stringify([GITHUB, URL_A]));
    const restored = new LibraryStore();
    await restored.restoreFromStorage();
    expect(restored.catalogUrls).toEqual([URL_A]);
  });
});

describe('two levels: project manifest vs. global list', () => {
  test('the two levels are independent', async () => {
    const store = new LibraryStore();
    await store.addCatalog(URL_A, 'user');
    await store.applyProjectLibraries([URL_B]);

    expect(store.catalogUrls).toEqual([URL_A, URL_B]);
    expect(store.getProjectLibraryUrls()).toEqual([URL_B]);
    // Only the user subscription reaches the global list.
    expect(persistedUrls()).toEqual([URL_A]);
  });

  test('a project switch swaps ONLY the project level', async () => {
    const store = new LibraryStore();
    await store.addCatalog(URL_A, 'user');
    await store.applyProjectLibraries([URL_B]);

    await store.applyProjectLibraries(['https://example.com/c/catalog.json']);

    expect(store.catalogUrls).toEqual([URL_A, 'https://example.com/c/catalog.json']);
    expect(persistedUrls()).toEqual([URL_A]);
  });

  test('a manifest URL the user also added survives the swap', async () => {
    const store = new LibraryStore();
    await store.applyProjectLibraries([URL_B]);
    await store.addCatalog(URL_B, 'user');       // user adopts it

    await store.applyProjectLibraries([]);        // project closed

    expect(store.catalogUrls).toContain(URL_B);
    expect(persistedUrls()).toEqual([URL_B]);
  });

  test('a GitHub URL in a manifest is not auto-scanned', async () => {
    const store = new LibraryStore();
    await store.applyProjectLibraries([GITHUB]);
    expect(store.catalogUrls).not.toContain(GITHUB);
  });
});

describe('project.json.libraries[] read/write', () => {
  const base: RvProject = { schemaVersion: 1, id: 'prj_a', name: 'A' };

  test('a missing section reads as an empty list', () => {
    expect(readProjectLibraries(base)).toEqual([]);
    expect(readProjectLibraries(null)).toEqual([]);
  });

  test('object and bare-string entries both parse; duplicates collapse', () => {
    const project = {
      ...base,
      libraries: [{ url: URL_A, label: 'A' }, URL_B, { url: URL_A }],
    } as unknown as RvProject;
    expect(readProjectLibraries(project)).toEqual([URL_A, URL_B]);
  });

  test('a malformed section degrades to empty instead of throwing', () => {
    const project = { ...base, libraries: { nope: true } } as unknown as RvProject;
    expect(readProjectLibraries(project)).toEqual([]);
    const project2 = { ...base, libraries: [42, null, {}] } as unknown as RvProject;
    expect(readProjectLibraries(project2)).toEqual([]);
  });

  test('writing preserves unknown fields on an existing entry', () => {
    const project = {
      ...base,
      libraries: [{ url: URL_A, label: 'A', futureField: 7 }],
    } as unknown as RvProject;
    const next = withProjectLibraries(project, [URL_A, URL_B]);
    expect(next.libraries).toEqual([
      { url: URL_A, label: 'A', futureField: 7 },
      { url: URL_B },
    ]);
  });

  test('an empty list removes the section rather than writing []', () => {
    const project = { ...base, libraries: [{ url: URL_A }] } as unknown as RvProject;
    expect('libraries' in withProjectLibraries(project, [])).toBe(false);
    // A project that never had the section stays byte-identical.
    expect(withProjectLibraries(base, [])).toBe(base);
  });

  test('write then read round-trips', () => {
    const next = withProjectLibraries(base, [URL_B, URL_A]);
    expect(readProjectLibraries(next)).toEqual([URL_B, URL_A]);
  });
});
