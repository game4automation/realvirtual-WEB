// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-778 9.12 — the GitHub location of the realvirtual library (F13).
 *
 * One library, several locations: the repo `game4automation/realvirtual-Library`
 * gets the same `project.json` (same project + document ids, rows carry
 * `aliases`). Until it is pushed, a GitHub hint WITHOUT `project.json` falls
 * back to today's repo scan, whose ids (`realvirtual-library-<path>-glb`) resolve
 * through the same aliases. No network: `fetch` is stubbed throughout.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RvProject } from '../src/core/project/rv-project-types';
import { getLibrarySource, resetLibrarySourceRegistryForTests } from '../src/core/library/library-source-registry';
import { LibraryProjectLoader } from '../src/core/library/library-project-loader';
import { createLibraryProjectLoaderDeps } from '../src/core/library/library-project-backends';
import {
  LIBRARY_PROJECTS_PROVIDER_ID,
  installLibraryProjectsProvider,
  uninstallLibraryProjectsProvider,
} from '../src/core/library/library-projects-provider';
import { REALVIRTUAL_LIBRARY_PROJECT_ID, findLegacyOrigin } from '../src/core/library/library-origin';
import { buildCatalogFromGitHub } from '../src/core/library/library-store';
import libraryProject from '../public/library/project.json';

const GITHUB = 'https://github.com/game4automation/realvirtual-Library';
const RAW_PROJECT = 'https://raw.githubusercontent.com/game4automation/realvirtual-Library/HEAD/project.json';
const PATHS = (libraryProject.documents as Array<{ path: string }>).map((d) => d.path);
const ALIASES = (libraryProject.documents as Array<{ aliases: string[] }>).flatMap((d) => d.aliases);

afterEach(() => {
  uninstallLibraryProjectsProvider();
  resetLibrarySourceRegistryForTests();
  vi.unstubAllGlobals();
});

/** The repo as the GitHub API would list it: the same files as the bundled library. */
function stubGitHub(opts: { withProjectJson: boolean }): string[] {
  const seen: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    if (url === RAW_PROJECT) {
      return opts.withProjectJson
        ? new Response(JSON.stringify(libraryProject), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response('404: Not Found', { status: 404 });
    }
    if (/api\.github\.com\/repos\/[^/]+\/[^/]+$/.test(url)) {
      return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 });
    }
    if (/\/git\/trees\//.test(url)) {
      return new Response(JSON.stringify({ tree: PATHS.map((path) => ({ path, type: 'blob' })), truncated: false }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }));
  return seen;
}

function projectA(): RvProject {
  return {
    schemaVersion: 2, id: 'prj_customer', name: 'Customer', canonicalName: 'customer',
    libraries: [{ projectId: REALVIRTUAL_LIBRARY_PROJECT_ID, label: 'realvirtual Library', hint: GITHUB }],
  } as unknown as RvProject;
}

async function boot(): Promise<LibraryProjectLoader> {
  // No app-level library in this build (a delivered tree without it): the hint is what is left.
  const loader = new LibraryProjectLoader({ ...createLibraryProjectLoaderDeps(), builtinBaseUrl: () => null });
  installLibraryProjectsProvider(loader);
  loader.setProject(projectA());
  await loader.whenSettled();
  return loader;
}

describe('GitHub hint without project.json → repo scan fallback (F13)', () => {
  it('is ready via the scan with every file; scan ids answer as aliases of the canonical ids', async () => {
    stubGitHub({ withProjectJson: false });
    const loader = await boot();
    const node = loader.getNode(REALVIRTUAL_LIBRARY_PROJECT_ID)!;
    expect(node.state.kind).toBe('ready');
    if (node.state.kind === 'ready') expect(node.state.via).toBe('scan');

    const source = getLibrarySource(LIBRARY_PROJECTS_PROVIDER_ID, REALVIRTUAL_LIBRARY_PROJECT_ID)!;
    expect(source.listEntries()).toHaveLength(26);

    const canonical = 'pallethandling-chainconveyor-1m';
    const scanId = 'realvirtual-library-pallethandling-chainconveyor-1m-glb';
    const entry = source.getEntry(canonical)!;
    expect(entry).not.toBeNull();
    expect(source.getEntry(scanId)).toBeNull();                       // canonical lookup never sees aliases
    expect(source.getAliasEntry!(scanId)).toBe(entry);                // the legacy pass does
    expect(findLegacyOrigin(scanId)?.source.id).toBe(REALVIRTUAL_LIBRARY_PROJECT_ID);
  });

  it('every scan id of the 26 files resolves, and equals the alias the builder wrote', async () => {
    stubGitHub({ withProjectJson: false });
    await boot();
    const source = getLibrarySource(LIBRARY_PROJECTS_PROVIDER_ID, REALVIRTUAL_LIBRARY_PROJECT_ID)!;
    for (const doc of libraryProject.documents as Array<{ id: string; path: string; aliases: string[] }>) {
      const alias = doc.aliases[0];
      expect(ALIASES, doc.id).toContain(alias);
      expect(source.getAliasEntry!(alias)?.id, alias).toBe(doc.id);
    }
  });

  it('the aliases the builder wrote are exactly the ids buildCatalogFromGitHub mints (one derivation, two implementations)', async () => {
    stubGitHub({ withProjectJson: false });
    const scan = await buildCatalogFromGitHub(GITHUB);
    expect(scan.entries.map((e) => e.id).sort()).toEqual([...ALIASES].sort());
  });
});

describe('GitHub hint WITH project.json (after the public push)', () => {
  it('opens the hosted project: same ids, same aliases, no scan', async () => {
    const seen = stubGitHub({ withProjectJson: true });
    const loader = await boot();
    const node = loader.getNode(REALVIRTUAL_LIBRARY_PROJECT_ID)!;
    if (node.state.kind === 'ready') expect(node.state.via).toBe('hosted');
    expect(node.state.kind).toBe('ready');
    expect(seen.some((u) => /api\.github\.com/.test(u))).toBe(false);

    const source = getLibrarySource(LIBRARY_PROJECTS_PROVIDER_ID, REALVIRTUAL_LIBRARY_PROJECT_ID)!;
    expect(source.listEntries().map((e) => e.id).sort())
      .toEqual((libraryProject.documents as Array<{ id: string }>).map((d) => d.id).sort());
    expect(source.getAliasEntry!('realvirtual-library-robots-fanuccrx-10ia-l-glb')?.id).toBe('robots-fanuccrx-10ia-l');
  });
});
