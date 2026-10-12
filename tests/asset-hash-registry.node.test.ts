// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * asset-hash-registry.node.test.ts — plan-508 F4.
 *
 * The url → hash registry is filled by the catalog normalizer and read BY URL
 * by `ModelCache` and the splat plugin. It must find one asset under its
 * canonical absolute url, its root-relative form and a scene saved on another
 * deploy; a catalog WITHOUT hashes must never disarm one with; the cache key
 * must survive fragments and queries.
 *
 * Runner: `npm run test:node` (vitest.node.config.ts, environment: node).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  cacheKeyFor,
  unversionedCacheKey,
  setAssetHash,
  hashForUrl,
  subscribeAssetHashes,
  clearAssetHashes,
  resolvedAssetKey,
  isSha256,
} from '../src/core/library/rv-asset-hash-registry';
import { normalizeCatalogEntry } from '../src/core/library/library-store';

const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);

beforeEach(() => {
  clearAssetHashes();
  vi.stubGlobal('location', new URL('http://localhost:5508/?doc=x'));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cacheKeyFor', () => {
  it('is the canonical absolute url; the hash goes into the query, never the fragment', () => {
    expect(cacheKeyFor('/library/a.glb')).toBe('http://localhost:5508/library/a.glb');
    expect(cacheKeyFor('/library/a.glb', H1)).toBe(`http://localhost:5508/library/a.glb?__rvsha=${H1}`);
    // Fragment stripped: `a.glb#x` and `a.glb#y` share one key per hash.
    expect(cacheKeyFor('/library/a.glb#x', H1)).toBe(cacheKeyFor('/library/a.glb#y', H1));
    expect(cacheKeyFor('/library/a.glb#x', H1)).not.toContain('#');
    // An existing query is kept, the hash is added to it.
    expect(cacheKeyFor('https://cdn.example.com/a.glb?v=3', H2)).toBe(`https://cdn.example.com/a.glb?v=3&__rvsha=${H2}`);
    // Different hashes, different keys.
    expect(cacheKeyFor('/library/a.glb', H1)).not.toBe(cacheKeyFor('/library/a.glb', H2));
  });

  it('unversionedCacheKey strips only the hash', () => {
    expect(unversionedCacheKey(cacheKeyFor('/library/a.glb?v=3', H1))).toBe('http://localhost:5508/library/a.glb?v=3');
    expect(unversionedCacheKey(cacheKeyFor('/library/a.glb', H1))).toBe(cacheKeyFor('/library/a.glb'));
  });

  it('keeps resolved: keys verbatim and works without a page (manual form)', () => {
    const key = resolvedAssetKey('project', 'p1', 'project:library/a.glb');
    expect(cacheKeyFor(key)).toBe(key);
    expect(cacheKeyFor(key, H1)).toBe(`${key}?__rvsha=${H1}`);
    vi.unstubAllGlobals(); // no `location` — a relative url cannot be parsed
    expect(cacheKeyFor('library/a.glb#frag', H1)).toBe(`library/a.glb?__rvsha=${H1}`);
  });

  it('resolvedAssetKey spells the ModelCache registry key (resolved:<provider>:<source>:<entry>)', () => {
    // ModelCache.resolvedCacheKey delegates to this function — asserted in model-cache-hash-change.test.ts.
    expect(resolvedAssetKey('project', 'p1', 'e')).toBe('resolved:project:p1:e');
  });
});

describe('setAssetHash / hashForUrl', () => {
  it('finds an entry under the canonical absolute url and the root-relative form', () => {
    setAssetHash('http://localhost:5508/library/Pallet/Belt.glb', { sha256: H1, sizeBytes: 42 });
    expect(hashForUrl('http://localhost:5508/library/Pallet/Belt.glb')).toEqual({ sha256: H1, sizeBytes: 42 });
    expect(hashForUrl('/library/Pallet/Belt.glb')?.sha256).toBe(H1);
    expect(hashForUrl('/library/Pallet/Belt.glb#node')?.sha256).toBe(H1);
    // A scene saved on the `/demo/` deploy stores its own absolute path — BASE_URL-rebased.
    expect(hashForUrl('/demo/library/Pallet/Belt.glb')?.sha256).toBe(H1);
    expect(hashForUrl('models/library/Pallet/Belt.glb')?.sha256).toBe(H1);
    expect(hashForUrl('/library/Pallet/Other.glb')).toBeNull();
  });

  it('a cross-origin url is its own key', () => {
    setAssetHash('https://raw.githubusercontent.com/o/r/main/x.glb', { sha256: H2 });
    expect(hashForUrl('https://raw.githubusercontent.com/o/r/main/x.glb')?.sha256).toBe(H2);
    expect(hashForUrl('/library/x.glb')).toBeNull();
  });

  it('never answers for blob: / data: urls and ignores malformed hashes', () => {
    setAssetHash('/library/a.glb', { sha256: 'not-a-hash' });
    setAssetHash('/library/b.glb', { sha256: H1.toUpperCase() });
    expect(hashForUrl('/library/a.glb')).toBeNull();
    expect(hashForUrl('/library/b.glb')).toBeNull();
    expect(hashForUrl('blob:http://localhost/123')).toBeNull();
    expect(isSha256(H1)).toBe(true);
    expect(isSha256(H1.slice(1))).toBe(false);
  });

  it('a catalog without hashes never deletes one with: normalizeCatalogEntry sets, never clears', () => {
    const base = 'http://localhost:5508/library/';
    const first = normalizeCatalogEntry({ id: 'belt', glbUrl: 'Belt.glb', sha256: H1, sizeBytes: 12 }, base);
    expect(first.sha256).toBe(H1);
    expect(first.sizeBytes).toBe(12);
    expect(hashForUrl('/library/Belt.glb')?.sha256).toBe(H1);
    const second = normalizeCatalogEntry({ id: 'belt', glbUrl: 'Belt.glb' }, base);
    expect(second.sha256).toBeUndefined();
    expect(hashForUrl('/library/Belt.glb')?.sha256).toBe(H1);
    // Splat entries register their splatUrl.
    normalizeCatalogEntry({ id: 'hall', splatUrl: 'Hall.splat', sha256: H2 }, base);
    expect(hashForUrl('/library/Hall.splat')?.sha256).toBe(H2);
    // The last catalog to name a url with a DIFFERENT hash wins.
    normalizeCatalogEntry({ id: 'belt', glbUrl: 'Belt.glb', sha256: H2 }, base);
    expect(hashForUrl('/library/Belt.glb')?.sha256).toBe(H2);
  });

  it('listeners hear a changed hash once per key, not a repeated one', () => {
    const heard: string[] = [];
    const off = subscribeAssetHashes((key) => heard.push(key));
    setAssetHash('http://localhost:5508/library/a.glb', { sha256: H1 });
    setAssetHash('http://localhost:5508/library/a.glb', { sha256: H1 });
    setAssetHash('http://localhost:5508/library/a.glb', { sha256: H1, sizeBytes: 5 }); // size only
    expect(heard).toEqual(['http://localhost:5508/library/a.glb']);
    setAssetHash('http://localhost:5508/library/a.glb', { sha256: H2 });
    expect(heard).toHaveLength(2);
    off();
    setAssetHash('http://localhost:5508/library/a.glb', { sha256: H1 });
    expect(heard).toHaveLength(2);
  });

  it('a resolved: key (project document) is registered verbatim', () => {
    const key = resolvedAssetKey('project', 'proj-1', 'project:library/a.glb');
    setAssetHash(key, { sha256: H1 });
    expect(hashForUrl(key)?.sha256).toBe(H1);
  });
});
