// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * asset-blob-cache-hash.node.test.ts — plan-508 F3 / F5 / F9.
 *
 * With a catalog hash the blob cache is content-addressed: the key is
 * `cacheKeyFor(url, sha256)` in BOTH tiers, network bytes are verified, a
 * mismatch evicts and refetches once past the HTTP cache (`cache: 'reload'`),
 * a second mismatch fails loudly and stores nothing, and after a verified store
 * every other version of the url leaves both tiers. Without a hash nothing
 * changes (`asset-blob-cache-poison.node.test.ts` keeps covering that path).
 *
 * Runner: `npm run test:node` (vitest.node.config.ts, environment: node).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { RVAssetBlobCache, rejectUnlessGlb } from '../src/core/engine/rv-asset-blob-cache';
import { cacheKeyFor } from '../src/core/library/rv-asset-hash-registry';
import { getCacheOutcomes, clearCacheOutcomes } from '../src/core/engine/rv-asset-cache-outcomes';
import { describeLoadError, reportMissingReference, getProblems, clearAllProblems } from '../src/core/hmi/problems-store';

const URL_A = 'http://localhost:5508/library/PalletHandling/ChainConveyor-1m.glb';

/** A 12-byte GLB header whose last byte tells versions apart. */
function glb(marker: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(12);
  b.set([0x67, 0x6c, 0x54, 0x46], 0);
  b[4] = 2;
  b[8] = 12;
  b[11] = marker;
  return b;
}
const sha = (marker: number): string => createHash('sha256').update(glb(marker)).digest('hex');
const glbResponse = (marker: number, headers: Record<string, string> = {}): Response =>
  new Response(glb(marker), { status: 200, headers: { 'content-type': 'model/gltf-binary', ...headers } });
async function markerOf(blob: Blob): Promise<number> {
  return new Uint8Array(await blob.arrayBuffer())[11];
}

/** Cache API double: one bucket keyed by url string, with `keys()` for the version sweep. */
class FakeCache {
  store = new Map<string, Response>();
  async match(url: string): Promise<Response | undefined> {
    const r = this.store.get(url);
    return r ? r.clone() : undefined;
  }
  async put(url: string, resp: Response): Promise<void> { this.store.set(url, resp); }
  async delete(url: string): Promise<boolean> { return this.store.delete(url); }
  async keys(): Promise<string[]> { return [...this.store.keys()]; }
}

let bucket: FakeCache;
let fetchMock: ReturnType<typeof vi.fn>;
let opened: string[];
let deleted: string[];

beforeEach(() => {
  bucket = new FakeCache();
  fetchMock = vi.fn();
  opened = [];
  deleted = [];
  vi.stubGlobal('caches', {
    open: async (name: string) => { opened.push(name); return bucket; },
    delete: async (name: string) => { deleted.push(name); return true; },
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  clearCacheOutcomes();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const newCache = (): RVAssetBlobCache => new RVAssetBlobCache({
  bucket: 'rv-assets-glb-v2', legacyBuckets: ['rv-planner-glbs'], reject: rejectUnlessGlb,
});

describe('hash-keyed blob cache', () => {
  it('stores under url+hash and serves the hit without a network call', async () => {
    bucket.store.set(cacheKeyFor(URL_A, sha(1)), glbResponse(1));
    const cache = newCache();
    const blob = await cache.getBlob(URL_A, { sha256: sha(1) });
    expect(await markerOf(blob)).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getCacheOutcomes().outcomes.map((o) => o.outcome)).toEqual(['hit']);
  });

  it('a hit under a hash key is NOT revalidated, even same-origin with validators', async () => {
    vi.stubGlobal('location', new URL('http://localhost:5508/?doc=x'));
    bucket.store.set(cacheKeyFor(URL_A, sha(1)), glbResponse(1, { etag: '"x"' }));
    const blob = await newCache().getBlob(URL_A, { sha256: sha(1) });
    expect(await markerOf(blob)).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a changed hash is a new key: fetches, verifies, stores, and removes the older version of the same url', async () => {
    const cache = newCache();
    // A legacy unhashed entry of the same url is swept too.
    bucket.store.set(cacheKeyFor(URL_A), glbResponse(9));
    for (const marker of [1, 2, 3]) {
      fetchMock.mockResolvedValueOnce(glbResponse(marker));
      const blob = await cache.getBlob(URL_A, { sha256: sha(marker) });
      expect(await markerOf(blob)).toBe(marker);
      // Exactly one version of the url in the bucket, and it is the current one.
      expect([...bucket.store.keys()]).toEqual([cacheKeyFor(URL_A, sha(marker))]);
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(getCacheOutcomes().counts.miss).toBe(3);
  });

  it('mismatch once, then a good second fetch: stores and resolves', async () => {
    fetchMock.mockResolvedValueOnce(glbResponse(7)).mockResolvedValueOnce(glbResponse(2));
    const blob = await newCache().getBlob(URL_A, { sha256: sha(2) });
    expect(await markerOf(blob)).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect([...bucket.store.keys()]).toEqual([cacheKeyFor(URL_A, sha(2))]);
    expect(getCacheOutcomes().outcomes.map((o) => o.outcome)).toEqual(['hash-mismatch', 'miss']);
  });

  it('mismatch twice: evicts, throws with expected/got, stores nothing', async () => {
    fetchMock.mockImplementation(async () => glbResponse(7));
    const expected = sha(2);
    const got = sha(7);
    const err = (await newCache().getBlob(URL_A, { sha256: expected }).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/^hash mismatch \(expected /);
    expect(err.message).toContain(`expected ${expected.slice(0, 12)}…, got ${got.slice(0, 12)}…`);
    expect(err.message).toContain(URL_A);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bucket.store.size).toBe(0);
    const outcomes = getCacheOutcomes().outcomes;
    expect(outcomes.map((o) => o.outcome)).toEqual(['hash-mismatch', 'hash-mismatch']);
    expect(outcomes[1].detail).toMatch(/attempt 2/);
  });

  it('the Problems entry names the mismatch through the reason path (F5)', async () => {
    fetchMock.mockImplementation(async () => glbResponse(7));
    const err = await newCache().getBlob(URL_A, { sha256: sha(2) }).catch((e: unknown) => e);
    reportMissingReference({ assetId: 'chain', occurrence: 'p508-mismatch', label: 'Chain Conveyor 1m', reason: describeLoadError(err) });
    const entry = getProblems().find((e) => e.id === 'missing-reference:p508-mismatch');
    expect(entry?.title).toBe('Referenced asset could not be loaded: Chain Conveyor 1m');
    expect(entry?.detail).toMatch(/Load failed: hash mismatch \(expected [0-9a-f]{12}…, got [0-9a-f]{12}…\)/);
    clearAllProblems();
  });

  it('the in-memory tier is keyed by url+hash: two concurrent asks with different hashes are two fetches', async () => {
    // The H1 download is held open until both other asks were made — they overlap for real.
    let releaseFirst!: (r: Response) => void;
    fetchMock
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { releaseFirst = resolve; }))
      .mockImplementationOnce(async () => glbResponse(2));
    const cache = newCache();
    const a = cache.getBlob(URL_A, { sha256: sha(1) });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const b = cache.getBlob(URL_A, { sha256: sha(2) });
    const c = cache.getBlob(URL_A, { sha256: sha(1) }); // joins the first
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    releaseFirst(glbResponse(1));
    const [blobA, blobB, blobC] = await Promise.all([a, b, c]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await markerOf(blobA)).toBe(1);
    expect(await markerOf(blobB)).toBe(2);
    expect(blobC).toBe(blobA);
  });

  it('cacheKeyFor strips the fragment and puts the hash in the query; a.glb#x and a.glb#y share one key per hash', async () => {
    expect(cacheKeyFor(`${URL_A}#x`, sha(1))).toBe(cacheKeyFor(`${URL_A}#y`, sha(1)));
    expect(cacheKeyFor(`${URL_A}#x`, sha(1))).toBe(`${URL_A}?__rvsha=${sha(1)}`);
    // A stored H1 entry must NOT answer an H2 ask through a fragment url.
    bucket.store.set(cacheKeyFor(`${URL_A}#x`, sha(1)), glbResponse(1));
    fetchMock.mockResolvedValueOnce(glbResponse(2));
    const blob = await newCache().getBlob(`${URL_A}#y`, { sha256: sha(2) });
    expect(await markerOf(blob)).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('the mismatch refetch is issued with cache: "reload"', async () => {
    fetchMock.mockResolvedValueOnce(glbResponse(7)).mockResolvedValueOnce(glbResponse(2));
    await newCache().getBlob(URL_A, { sha256: sha(2) });
    expect(fetchMock.mock.calls[0][1]).toBeUndefined();
    expect((fetchMock.mock.calls[1][1] as RequestInit).cache).toBe('reload');
    expect(fetchMock.mock.calls[1][0]).toBe(URL_A); // the network url, never the key
  });

  it('after a successful put the older version of the same url is dropped from _pending too', async () => {
    const cache = newCache();
    fetchMock.mockResolvedValueOnce(glbResponse(1));
    const first = await cache.getBlob(URL_A, { sha256: sha(1) });
    // In memory: a second ask with H1 is served without a fetch.
    await cache.getBlob(URL_A, { sha256: sha(1) });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(glbResponse(2));
    await cache.getBlob(URL_A, { sha256: sha(2) });
    // H1 is gone from both tiers — a later H1 ask goes to the network again.
    expect(bucket.store.has(cacheKeyFor(URL_A, sha(1)))).toBe(false);
    fetchMock.mockResolvedValueOnce(glbResponse(1));
    const again = await cache.getBlob(URL_A, { sha256: sha(1) });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(again).not.toBe(first);
    // The consumer that held the old promise kept its bytes.
    expect(await markerOf(first)).toBe(1);
  });

  it('without a Cache API the bytes are still verified (NO-CACHE path)', async () => {
    vi.stubGlobal('caches', undefined);
    fetchMock.mockImplementation(async () => glbResponse(7));
    await expect(newCache().getBlob(URL_A, { sha256: sha(2) })).rejects.toThrow(/hash mismatch/);
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(glbResponse(2));
    const blob = await newCache().getBlob(URL_A, { sha256: sha(2) });
    expect(await markerOf(blob)).toBe(2);
    expect(getCacheOutcomes().outcomes.at(-1)?.detail).toMatch(/verified, not stored/);
  });

  it('a parse failure reported through evict() removes the hash key, not only the bare url', async () => {
    const cache = newCache();
    fetchMock.mockResolvedValueOnce(glbResponse(1));
    await cache.getBlob(URL_A, { sha256: sha(1) });
    expect(bucket.store.has(cacheKeyFor(URL_A, sha(1)))).toBe(true);
    await cache.evict(URL_A, { sha256: sha(1) });
    expect(bucket.store.size).toBe(0);
    fetchMock.mockResolvedValueOnce(glbResponse(1));
    await cache.getBlob(URL_A, { sha256: sha(1) });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('without a hash the legacy path (magic check + same-origin conditional GET) is unchanged', async () => {
    vi.stubGlobal('location', new URL('http://localhost:5508/?doc=x'));
    bucket.store.set(URL_A, glbResponse(1, { etag: 'W/"old"' }));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 304 }));
    const blob = await newCache().getBlob(URL_A);
    expect(await markerOf(blob)).toBe(1);
    expect(((fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>)['If-None-Match']).toBe('W/"old"');
    expect(getCacheOutcomes().outcomes.map((o) => o.outcome)).toEqual(['revalidated']);
    // A malformed hash is treated as absent — the legacy path, not a verification.
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 304 }));
    await newCache().getBlob(URL_A, { sha256: 'nope' });
    expect(getCacheOutcomes().outcomes.at(-1)?.outcome).toBe('revalidated');
  });

  it('a body that fails the content check is rejected and recorded, even with a hash', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<!DOCTYPE html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    await expect(newCache().getBlob(URL_A, { sha256: sha(1) })).rejects.toThrow(/HTML page/);
    expect(getCacheOutcomes().outcomes.map((o) => o.outcome)).toEqual(['rejected']);
    expect(bucket.store.size).toBe(0);
  });

  it('opens the v2 bucket and deletes the legacy bucket once', async () => {
    const cache = newCache();
    fetchMock.mockImplementation(async () => glbResponse(1));
    await cache.getBlob(URL_A, { sha256: sha(1) });
    await cache.getBlob(`${URL_A}?other`, { sha256: sha(1) });
    expect(deleted).toEqual(['rv-planner-glbs']);
    expect(new Set(opened)).toEqual(new Set(['rv-assets-glb-v2']));
  });
});
