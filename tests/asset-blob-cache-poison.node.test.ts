// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * asset-blob-cache-poison.node.test.ts — the persistent blob tier must not
 * serve or store bytes that are not the asset (2026-09-26, DemoPlanner).
 *
 * A dev server answers an unknown path with its `index.html` and status 200.
 * Cached once under a GLB url, that page WAS the asset for the life of the
 * browser profile: every load parsed HTML, every reload failed the same way,
 * and the Problems panel called a file that existed "not found". The cache
 * now checks the bytes on the way in AND on the way out of the Cache API.
 *
 * Runner: `npm run test:node` (vitest.node.config.ts, environment: node).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RVAssetBlobCache, rejectUnlessGlb } from '../src/core/engine/rv-asset-blob-cache';

const GLB_URL = 'http://localhost:5173/library/PalletHandling/ChainConveyor-1m.glb';

function glbBytes(): ArrayBuffer {
  // 'glTF' magic, version 2, total length 12 — a valid, empty header.
  const buf = new ArrayBuffer(12);
  const b = new Uint8Array(buf);
  b.set([0x67, 0x6c, 0x54, 0x46], 0);
  b[4] = 2;
  b[8] = 12;
  return buf;
}

/** A minimal Cache API double: one bucket, keyed by url. */
class FakeCache {
  store = new Map<string, Response>();
  async match(url: string): Promise<Response | undefined> {
    const r = this.store.get(url);
    return r ? r.clone() : undefined;
  }
  async put(url: string, resp: Response): Promise<void> {
    this.store.set(url, resp);
  }
  async delete(url: string): Promise<boolean> {
    return this.store.delete(url);
  }
}

let bucket: FakeCache;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  bucket = new FakeCache();
  fetchMock = vi.fn();
  vi.stubGlobal('caches', { open: async () => bucket, delete: async () => true });
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function htmlResponse(): Response {
  return new Response('<!DOCTYPE html><html><body>dev server</body></html>', {
    status: 200, headers: { 'content-type': 'text/html' },
  });
}

function glbResponse(extraHeaders: Record<string, string> = {}): Response {
  return new Response(glbBytes(), { status: 200, headers: { 'content-type': 'model/gltf-binary', ...extraHeaders } });
}

/** A GLB whose header carries a marker byte, to tell old bytes from new ones. */
function glbResponseMarked(marker: number, extraHeaders: Record<string, string> = {}): Response {
  const buf = glbBytes();
  new Uint8Array(buf)[11] = marker;
  return new Response(buf, { status: 200, headers: { 'content-type': 'model/gltf-binary', ...extraHeaders } });
}

async function markerOf(blob: Blob): Promise<number> {
  return new Uint8Array(await blob.arrayBuffer())[11];
}

describe('rejectUnlessGlb', () => {
  it('accepts a GLB header and names what an HTML page is', async () => {
    expect(await rejectUnlessGlb(new Blob([glbBytes()]), GLB_URL)).toBeNull();
    const why = await rejectUnlessGlb(new Blob(['<!DOCTYPE html>'], { type: 'text/html' }), GLB_URL);
    expect(why).toMatch(/HTML page/);
    expect(await rejectUnlessGlb(new Blob([]), GLB_URL)).toMatch(/too short/);
  });
});

describe('RVAssetBlobCache with a content check', () => {
  it('evicts a poisoned Cache API entry and refetches from the network', async () => {
    // The poison: an HTML page stored under the GLB url by an earlier session.
    bucket.store.set(GLB_URL, htmlResponse());
    fetchMock.mockResolvedValueOnce(glbResponse());

    const cache = new RVAssetBlobCache({ bucket: 'test-glbs', reject: rejectUnlessGlb });
    const blob = await cache.getBlob(GLB_URL);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(blob.size).toBe(12);
    // The good bytes replaced the poison, so the next session hits them.
    const stored = bucket.store.get(GLB_URL);
    expect(stored).toBeDefined();
    expect(Array.from(new Uint8Array(await stored!.arrayBuffer()).slice(0, 4))).toEqual([0x67, 0x6c, 0x54, 0x46]);
  });

  it('never stores a rejected network response and says what came back', async () => {
    fetchMock.mockResolvedValueOnce(htmlResponse());
    const cache = new RVAssetBlobCache({ bucket: 'test-glbs', reject: rejectUnlessGlb });

    await expect(cache.getBlob(GLB_URL)).rejects.toThrow(/HTML page/);
    expect(bucket.store.has(GLB_URL)).toBe(false);

    // The rejection is not memoised: the next ask fetches again.
    fetchMock.mockResolvedValueOnce(glbResponse());
    const blob = await cache.getBlob(GLB_URL);
    expect(blob.size).toBe(12);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('serves a valid cached entry WITHOUT validators without touching the network', async () => {
    bucket.store.set(GLB_URL, glbResponse());
    const cache = new RVAssetBlobCache({ bucket: 'test-glbs', reject: rejectUnlessGlb });
    const blob = await cache.getBlob(GLB_URL);
    expect(blob.size).toBe(12);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('revalidation of a valid same-origin hit (an edited library GLB must reach a returning browser)', () => {
    beforeEach(() => {
      vi.stubGlobal('location', new URL('http://localhost:5173/?doc=x'));
    });

    it('asks the server with If-None-Match and keeps the cached bytes on 304', async () => {
      bucket.store.set(GLB_URL, glbResponseMarked(1, { etag: 'W/"old"' }));
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 304 }));
      const cache = new RVAssetBlobCache({ bucket: 'test-glbs', reject: rejectUnlessGlb });

      const blob = await cache.getBlob(GLB_URL);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect((init.headers as Record<string, string>)['If-None-Match']).toBe('W/"old"');
      expect(await markerOf(blob)).toBe(1);
    });

    it('replaces the cached bytes when the server answers 200 with a newer file', async () => {
      bucket.store.set(GLB_URL, glbResponseMarked(1, { 'last-modified': 'Mon, 22 Sep 2026 00:00:00 GMT' }));
      fetchMock.mockResolvedValueOnce(glbResponseMarked(2, { 'last-modified': 'Wed, 24 Sep 2026 00:00:00 GMT' }));
      const cache = new RVAssetBlobCache({ bucket: 'test-glbs', reject: rejectUnlessGlb });

      const blob = await cache.getBlob(GLB_URL);

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect((init.headers as Record<string, string>)['If-Modified-Since']).toBe('Mon, 22 Sep 2026 00:00:00 GMT');
      expect(await markerOf(blob)).toBe(2);
      // The next session hits the NEW bytes.
      const stored = bucket.store.get(GLB_URL)!;
      expect(await markerOf(await stored.blob())).toBe(2);
    });

    it('falls back to the cached bytes when the server is unreachable', async () => {
      bucket.store.set(GLB_URL, glbResponseMarked(1, { etag: '"x"' }));
      fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      const cache = new RVAssetBlobCache({ bucket: 'test-glbs', reject: rejectUnlessGlb });
      expect(await markerOf(await cache.getBlob(GLB_URL))).toBe(1);
    });

    it('does not revalidate a cross-origin hit (no preflight-forcing headers)', async () => {
      const remote = 'https://cdn.example.com/library/belt.glb';
      bucket.store.set(remote, glbResponseMarked(1, { etag: '"x"' }));
      const cache = new RVAssetBlobCache({ bucket: 'test-glbs', reject: rejectUnlessGlb });
      expect(await markerOf(await cache.getBlob(remote))).toBe(1);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('evict() forgets both tiers so the next ask refetches', async () => {
    fetchMock.mockImplementation(async () => glbResponse());
    const cache = new RVAssetBlobCache({ bucket: 'test-glbs', reject: rejectUnlessGlb });
    await cache.getBlob(GLB_URL);
    await cache.getBlob(GLB_URL); // in-memory tier — no second fetch
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await cache.evict(GLB_URL);
    expect(bucket.store.has(GLB_URL)).toBe(false);
    await cache.getBlob(GLB_URL);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
