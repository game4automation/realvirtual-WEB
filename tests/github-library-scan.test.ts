// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * GitHub library scanning — paste a GitHub repo/folder URL and auto-discover
 * `.glb` files (no catalog.json required). Covers URL parsing, the scan/build
 * pipeline (default-branch resolution + recursive tree listing), subfolder
 * filtering, raw-URL construction, and error cases.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseGitHubRepoUrl,
  isGitHubRepoScanUrl,
  isGitHubCatalogUrl,
  buildCatalogFromGitHub,
} from '../src/plugins/layout-planner/rv-layout-store';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Install a fetch mock that answers the repo-info and git-trees endpoints. */
function mockGitHub(opts: {
  defaultBranch?: string;
  tree: Array<{ path: string; type: string }>;
  truncated?: boolean;
}): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const u = String(input);
    if (/\/repos\/[^/]+\/[^/]+$/.test(u)) {
      return new Response(JSON.stringify({ default_branch: opts.defaultBranch ?? 'main' }), { status: 200 });
    }
    if (/\/git\/trees\//.test(u)) {
      return new Response(JSON.stringify({ tree: opts.tree, truncated: !!opts.truncated }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }));
}

describe('parseGitHubRepoUrl', () => {
  it('parses a bare repo URL', () => {
    expect(parseGitHubRepoUrl('https://github.com/acme/assets')).toEqual({
      owner: 'acme', repo: 'assets', branch: undefined, subpath: '',
    });
  });

  it('parses a tree URL with branch + subfolder', () => {
    expect(parseGitHubRepoUrl('https://github.com/acme/assets/tree/dev/library/pallets')).toEqual({
      owner: 'acme', repo: 'assets', branch: 'dev', subpath: 'library/pallets',
    });
  });

  it('strips a trailing .git and trailing slash', () => {
    expect(parseGitHubRepoUrl('https://github.com/acme/assets.git/')).toEqual({
      owner: 'acme', repo: 'assets', branch: undefined, subpath: '',
    });
  });

  it('returns null for non-GitHub URLs', () => {
    expect(parseGitHubRepoUrl('https://example.com/lib/catalog.json')).toBeNull();
  });
});

describe('isGitHubRepoScanUrl', () => {
  it('treats a repo/folder URL as a scan target', () => {
    expect(isGitHubRepoScanUrl('https://github.com/acme/assets')).toBe(true);
    expect(isGitHubRepoScanUrl('https://github.com/acme/assets/tree/main/lib')).toBe(true);
  });
  it('does NOT scan a catalog.json (blob) URL — that is fetched as a manifest', () => {
    expect(isGitHubRepoScanUrl('https://github.com/acme/assets/blob/main/catalog.json')).toBe(false);
    expect(isGitHubRepoScanUrl('https://example.com/catalog.json')).toBe(false);
  });
});

describe('isGitHubCatalogUrl (opt-in gate — never auto-loaded/persisted)', () => {
  it('matches github.com repo and tree URLs', () => {
    expect(isGitHubCatalogUrl('https://github.com/game4automation/realvirtual-Library')).toBe(true);
    expect(isGitHubCatalogUrl('https://github.com/acme/assets/tree/main/lib')).toBe(true);
  });
  it('matches raw.githubusercontent.com URLs (incl. a direct catalog.json)', () => {
    expect(isGitHubCatalogUrl('https://raw.githubusercontent.com/game4automation/realvirtual-Library/main/PalletHandling/RollConveyor2m.glb')).toBe(true);
    expect(isGitHubCatalogUrl('https://raw.githubusercontent.com/acme/assets/main/catalog.json')).toBe(true);
  });
  it('tolerates surrounding whitespace', () => {
    expect(isGitHubCatalogUrl('  https://github.com/acme/assets  ')).toBe(true);
  });
  it('does NOT match the bundled local library or other remote hosts', () => {
    expect(isGitHubCatalogUrl('bundled://library')).toBe(false);
    expect(isGitHubCatalogUrl('/models/partner/catalog.json')).toBe(false);
    expect(isGitHubCatalogUrl('https://example.com/lib/catalog.json')).toBe(false);
    expect(isGitHubCatalogUrl('https://cdn.realvirtual.io/partner/catalog.json')).toBe(false);
  });
});

describe('buildCatalogFromGitHub', () => {
  it('discovers .glb files and builds raw-URL entries', async () => {
    mockGitHub({
      defaultBranch: 'main',
      tree: [
        { path: 'README.md', type: 'blob' },
        { path: 'pallets/EuropalletLoaded.glb', type: 'blob' },
        { path: 'conveyors/Belt_1m.glb', type: 'blob' },
        { path: 'pallets', type: 'tree' },
      ],
    });

    const cat = await buildCatalogFromGitHub('https://github.com/acme/assets');
    expect(cat.version).toBe('1.0');
    expect(cat.name).toBe('assets');
    expect(cat.entries).toHaveLength(2);

    const euro = cat.entries.find(e => e.name === 'EuropalletLoaded')!;
    expect(euro.glbUrl).toBe('https://raw.githubusercontent.com/acme/assets/main/pallets/EuropalletLoaded.glb');
    expect(euro.category).toBe('custom');
    expect(euro.collections).toEqual(['pallets']);
  });

  it('filters to the requested subfolder', async () => {
    mockGitHub({
      tree: [
        { path: 'pallets/A.glb', type: 'blob' },
        { path: 'conveyors/B.glb', type: 'blob' },
      ],
    });
    const cat = await buildCatalogFromGitHub('https://github.com/acme/assets/tree/main/conveyors');
    expect(cat.name).toBe('assets/conveyors');
    expect(cat.entries.map(e => e.name)).toEqual(['B']);
    expect(cat.entries[0].glbUrl).toBe('https://raw.githubusercontent.com/acme/assets/main/conveyors/B.glb');
  });

  it('throws a clear error when no .glb files are present', async () => {
    mockGitHub({ tree: [{ path: 'README.md', type: 'blob' }] });
    await expect(buildCatalogFromGitHub('https://github.com/acme/assets'))
      .rejects.toThrow(/No \.glb files/);
  });

  it('surfaces a rate-limit (HTTP 403) as a friendly message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 403 })));
    await expect(buildCatalogFromGitHub('https://github.com/acme/assets'))
      .rejects.toThrow(/rate limit/i);
  });
});
