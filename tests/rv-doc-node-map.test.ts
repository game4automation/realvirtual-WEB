// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-doc-node-map.test.ts — plan-284 F9 inverted document→node index: key
 * derivation, scene traversal, and source resolution with the basename fallback
 * that bridges CONNECT source urls and GLB-side `_rvPdfLinks`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildDocNodeIndex,
  docMatchKeys,
  nodesForSource,
  nodesForSources,
  resetDocNodeIndexCache,
  type DocNodeMapViewer,
} from '../src/core/engine/rv-doc-node-map';

function fakeViewer(nodes: Array<{ path: string; urls: string[] }>): DocNodeMapViewer {
  const objs = nodes.map((n) => ({
    userData: { _rvPdfLinks: n.urls.map((u) => ({ source: { url: u } })) },
    __path: n.path,
  }));
  return {
    scene: { traverse: (cb) => objs.forEach((o) => cb(o)) },
    registry: { getPathForNode: (o) => (o as { __path?: string }).__path ?? null },
  };
}

beforeEach(() => resetDocNodeIndexCache());

describe('docMatchKeys', () => {
  it('derives normalized path, basename and basename-without-extension (lower-cased)', () => {
    expect(docMatchKeys('https://h/assets/docs/KA19.pdf?v=2'))
      .toEqual(['assets/docs/ka19.pdf', 'ka19.pdf', 'ka19']);
  });

  it('is empty for a blank ref', () => {
    expect(docMatchKeys('')).toEqual([]);
  });
});

describe('buildDocNodeIndex', () => {
  it('inverts node→doc links into doc-key → node paths', () => {
    const viewer = fakeViewer([
      { path: 'M1/Gear', urls: ['https://h/assets/docs/KA19.pdf'] },
      { path: 'M7/Gear2', urls: ['docs/KA19.pdf'] },
    ]);
    const index = buildDocNodeIndex(viewer);
    expect(index.get('ka19.pdf')).toEqual(new Set(['M1/Gear', 'M7/Gear2']));
    expect(index.get('ka19')).toEqual(new Set(['M1/Gear', 'M7/Gear2']));
  });
});

describe('nodesForSource / nodesForSources', () => {
  const viewer = () => fakeViewer([
    { path: 'M1/Gear', urls: ['https://h/assets/docs/KA19.pdf'] },
    { path: 'M7/Gear2', urls: ['https://h/assets/docs/KA19.pdf'] },
    { path: 'C3/Conv', urls: ['https://h/assets/docs/belt.pdf'] },
  ]);

  it('matches a CONNECT source url by basename (differing path prefix)', () => {
    expect(nodesForSource(viewer(), { url: 'docs/KA19.pdf' }).sort())
      .toEqual(['M1/Gear', 'M7/Gear2']);
  });

  it('matches a cited source by its title (basename without extension)', () => {
    expect(nodesForSource(viewer(), { title: 'KA19' }).sort())
      .toEqual(['M1/Gear', 'M7/Gear2']);
  });

  it('returns [] for an unlinked source', () => {
    expect(nodesForSource(viewer(), { url: 'docs/unknown.pdf', title: 'unknown' })).toEqual([]);
  });

  it('dedupes node paths across multiple cited sources', () => {
    const paths = nodesForSources(viewer(), [
      { title: 'KA19' },
      { url: 'docs/KA19.pdf' },
      { title: 'belt' },
    ]).sort();
    expect(paths).toEqual(['C3/Conv', 'M1/Gear', 'M7/Gear2']);
  });
});
