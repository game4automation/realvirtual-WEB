// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * model-cache-hash-change.test.ts — plan-508 F3 / F4, browser mode (real Cache API).
 *
 * `ModelCache` keys on the url and remembers the catalog hash each key was last
 * requested under (`_expectedHash`, set before the first await). A different
 * hash — `undefined → H` included — invalidates decoded, baked and in-flight
 * work; the blob layer below keys on url + hash and verifies. The hash comes
 * from the url → hash registry the catalog normalizer fills, so a nested
 * placement the instancer materialises picks it up without any new field.
 *
 * The network is a stub serving a 12-byte `glTF` header whose last byte is the
 * "version"; the loader is a fake that builds a small drawable tree (the URL
 * seam of `_decode`). One real-bytes case loads the bundled library catalog and
 * a real GLB through the real loader.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import '../src/core/engine/rv-scene-loader';
import {
  ModelCache,
  GLB_CACHE_BUCKET,
  LEGACY_GLB_CACHE_BUCKETS,
  resolvedCacheKey,
} from '../src/core/engine/rv-model-cache';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { gltfLoader } from '../src/core/engine/rv-glb-parse';
import {
  cacheKeyFor,
  clearAssetHashes,
  hashForUrl,
  resolvedAssetKey,
  setAssetHash,
} from '../src/core/library/rv-asset-hash-registry';
import { normalizeCatalogEntry } from '../src/core/library/library-store';
import { sha256Hex } from '../src/core/import/rv-cad-glb-cache';
import { clearCacheOutcomes, getCacheOutcomes } from '../src/core/engine/rv-asset-cache-outcomes';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';

// ─── The versioned network ──────────────────────────────────────────────

function glb(marker: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(12);
  b.set([0x67, 0x6c, 0x54, 0x46], 0);
  b[4] = 2;
  b[8] = 12;
  b[11] = marker;
  return b;
}
const shaOf = async (marker: number): Promise<string> => sha256Hex(glb(marker).buffer.slice(0) as ArrayBuffer);

/** Unique urls per test: the Cache API bucket and the blob singleton outlive a test. */
let seq = 0;
const freshUrl = (name: string): string => `https://example.test/p508/${Date.now()}-${++seq}/${name}.glb`;

let serving = 1;
let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;
const fetchedMarkers: number[] = [];

// ─── The fake decode: a drawable tree tagged with the version it was built from ─

async function markerOfBlobUrl(url: string): Promise<number> {
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  return bytes[11];
}

function makeLoader(decodes: number[]): GLTFLoader {
  return {
    loadAsync: async (blobUrl: string): Promise<{ scene: Group }> => {
      // The object url the blob cache minted: read the version marker back out of its bytes.
      const marker = await markerOfBlobUrl(blobUrl);
      decodes.push(marker);
      const root = new Group();
      root.name = `v${marker}`;
      const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
      mesh.name = 'Body';
      root.add(mesh);
      return { scene: root };
    },
  } as unknown as GLTFLoader;
}

function makeCache(decodes: number[]): ModelCache {
  return new ModelCache(makeLoader(decodes), { pickPort: () => createPickBuildPort({ createWorker: () => null }) });
}

beforeEach(() => {
  clearAssetHashes();
  clearCacheOutcomes();
  serving = 1;
  fetchedMarkers.length = 0;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fetchSpy = null;
});

/**
 * The stub serves every http(s) `.glb` url; `blob:` urls (the decode reading its
 * object url back) must reach the real fetch, so the stub delegates them.
 */
function stubNetworkPassingBlobs(serve?: (url: string, init?: RequestInit) => Uint8Array<ArrayBuffer>): void {
  const realFetch = globalThis.fetch.bind(globalThis);
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
    if (url.startsWith('blob:')) return realFetch(input as RequestInfo, init);
    // Only the GLBs exist on this "server" — the `.kin.json` sidecar probe gets a plain 404.
    if (!/\.glb(\?|#|$)/.test(url)) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    const bytes = (serve ?? (() => glb(serving)))(url, init);
    fetchedMarkers.push(bytes[11]);
    return new Response(bytes, { status: 200, headers: { 'content-type': 'model/gltf-binary' } });
  });
}

describe('ModelCache expected hash', () => {
  it('uses the v2 bucket, sweeps the legacy one, and spells resolved keys like the registry', () => {
    expect(GLB_CACHE_BUCKET).toBe('rv-assets-glb-v2');
    expect(LEGACY_GLB_CACHE_BUCKETS).toEqual(['rv-planner-glbs']);
    expect(resolvedCacheKey('project', 'p', 'e')).toBe(resolvedAssetKey('project', 'p', 'e'));
  });

  it('H1 decoded + baked, then a load with H2: invalidates, re-decodes, re-bakes', async () => {
    stubNetworkPassingBlobs();
    const url = freshUrl('belt');
    const decodes: number[] = [];
    const cache = makeCache(decodes);
    const h1 = await shaOf(1);
    const h2 = await shaOf(2);

    setAssetHash(url, { sha256: h1 });
    const baked1 = await cache.getOrLoadBaked(url);
    const clone1 = await cache.getOrLoad(url);
    expect(decodes).toEqual([1]);
    expect(cache.expectedHashOf(url)).toBe(h1);
    expect(clone1).toBeTruthy();

    // The catalog now says H2 and the network serves it.
    serving = 2;
    setAssetHash(url, { sha256: h2 });
    const baked2 = await cache.getOrLoadBaked(url);
    expect(baked2).not.toBe(baked1);
    expect(baked1.retired).toBe(true);
    expect(decodes).toEqual([1, 2]);
    expect(cache.expectedHashOf(url)).toBe(h2);
    // The blob layer verified and stored the H2 bytes under url + H2 — and only those.
    const bucket = await caches.open(GLB_CACHE_BUCKET);
    expect(await bucket.match(cacheKeyFor(url, h2))).toBeTruthy();
    expect(await bucket.match(cacheKeyFor(url, h1))).toBeUndefined();
    cache.dispose();
  });

  it('two concurrent asks H1 and H2 for one url do not share the in-flight decode', async () => {
    // The first download serves H1, every later one H2 — the H1 request goes out first.
    let downloads = 0;
    stubNetworkPassingBlobs(() => glb(++downloads === 1 ? 1 : 2));
    const url = freshUrl('parallel');
    const decodes: number[] = [];
    const cache = makeCache(decodes);
    const [h1, h2] = [await shaOf(1), await shaOf(2)];
    setAssetHash(url, { sha256: h1 });
    const first = cache.getOrLoad(url);             // H1, in flight
    setAssetHash(url, { sha256: h2 });              // the registry moves on mid-flight (same tick)
    const second = cache.getOrLoad(url);            // must not join the H1 decode
    const [a, b] = await Promise.all([first, second]);
    expect(a.name).toBe('v1');
    expect(b.name).toBe('v2');
    expect(decodes.sort()).toEqual([1, 2]);
    // The H1 decode finished after the invalidate — it did not publish over H2.
    expect((await cache.getOrLoad(url)).name).toBe('v2');
    cache.dispose();
  });

  it('an unhashed prefetch never serves a later hashed load (undefined → H invalidates)', async () => {
    stubNetworkPassingBlobs();
    const url = freshUrl('prefetch');
    const decodes: number[] = [];
    const cache = makeCache(decodes);
    serving = 7; // what an old, unverified url-keyed load gets
    cache.prefetch(url);
    await vi.waitFor(() => expect(decodes).toEqual([7]));
    expect(cache.expectedHashOf(url)).toBeUndefined();

    serving = 2;
    setAssetHash(url, { sha256: await shaOf(2) });
    const clone = await cache.getOrLoad(url);
    expect(clone.name).toBe('v2');
    expect(decodes).toEqual([7, 2]);
  });

  it('H → undefined (a catalog without hashes after one with) invalidates nothing', async () => {
    stubNetworkPassingBlobs();
    const url = freshUrl('keep');
    const decodes: number[] = [];
    const cache = makeCache(decodes);
    setAssetHash(url, { sha256: await shaOf(1) });
    await cache.getOrLoad(url);
    clearAssetHashes(); // the registry no longer knows the url
    await cache.getOrLoad(url);
    expect(decodes).toEqual([1]);
    expect(cache.expectedHashOf(url)).toBe(await shaOf(1));
  });

  it('a nested library placement (instancer path) picks up a changed registry hash', async () => {
    stubNetworkPassingBlobs();
    let h: TestViewerHandle | null = null;
    try {
      h = await createTestViewer('webgl');
      const decodes: number[] = [];
      const cache = makeCache(decodes);
      h.viewer.placements.setModelCache(cache);
      const url = freshUrl('nested');
      // A reference inside a placed asset becomes exactly this ref (rv-placement-instancer.ts:498).
      const ref = { catalogId: 'nested-belt', glbUrl: url };
      setAssetHash(url, { sha256: await shaOf(1) });
      const first = await h.viewer.placements.resolveBaked(ref);
      expect(decodes).toEqual([1]);

      serving = 2;
      setAssetHash(url, { sha256: await shaOf(2) });
      const second = await h.viewer.placements.resolveBaked(ref);
      expect(second).not.toBe(first);
      expect(decodes).toEqual([1, 2]);
    } finally {
      h?.dispose();
    }
  });

  it('registry update mid-session invalidates a known key', async () => {
    stubNetworkPassingBlobs();
    const url = freshUrl('midsession');
    const decodes: number[] = [];
    const cache = makeCache(decodes);
    setAssetHash(url, { sha256: await shaOf(1) });
    const baked = await cache.getOrLoadBaked(url);
    expect(cache.peekBaked(url)).toBe(baked);

    serving = 3;
    setAssetHash(url, { sha256: await shaOf(3) });
    // The listener retired the stale bake at once — before anybody asked again.
    expect(cache.peekBaked(url)).toBeUndefined();
    expect(baked.retired).toBe(true);
    expect(cache.expectedHashOf(url)).toBe(await shaOf(3));
    expect((await cache.getOrLoad(url)).name).toBe('v3');
    expect(decodes).toEqual([1, 3]);
    cache.dispose();
  });

  it('refetch with cache: "reload" gets past an HTTP cache that still holds the old bytes', async () => {
    // The stub plays a browser HTTP cache that answers a default request with the stale
    // version: only a `cache: 'reload'` request reaches the "server" with the new file.
    stubNetworkPassingBlobs((_url, init) => glb(init?.cache === 'reload' ? 5 : 4));
    const url = freshUrl('reload');
    const decodes: number[] = [];
    const cache = makeCache(decodes);
    setAssetHash(url, { sha256: await shaOf(5) });
    const clone = await cache.getOrLoad(url);
    expect(clone.name).toBe('v5');
    expect(fetchedMarkers).toEqual([4, 5]);
    const outcomes = getCacheOutcomes().outcomes.map((o) => o.outcome);
    expect(outcomes).toEqual(['hash-mismatch', 'miss']);
    // Stored under url + hash in the REAL Cache API: the next session hits without the network.
    const bucket = await caches.open(GLB_CACHE_BUCKET);
    expect(await bucket.match(cacheKeyFor(url, await shaOf(5)))).toBeTruthy();
  });

  it('a stale catalog hash fails the load loudly with "hash mismatch" (never serves unverified bytes)', async () => {
    stubNetworkPassingBlobs(() => glb(4));
    const url = freshUrl('stale-catalog');
    const cache = makeCache([]);
    setAssetHash(url, { sha256: await shaOf(5) });
    await expect(cache.getOrLoad(url)).rejects.toThrow(/^hash mismatch \(expected [0-9a-f]{12}…, got [0-9a-f]{12}…\)/);
  });
});

describe('real bytes: the bundled catalog and a library GLB', () => {
  it('normalizing the catalog registers the hash; the real GLB verifies and decodes', async () => {
    const catalogUrl = new URL('/library/catalog.json', location.href).href;
    const catalog = await (await fetch(catalogUrl)).json() as { entries: Array<{ glbUrl: string; sha256?: string }> };
    const base = catalogUrl.slice(0, catalogUrl.lastIndexOf('/') + 1);
    const raw = catalog.entries.find((e) => /CartonBox\.glb$/.test(e.glbUrl)) ?? catalog.entries[0];
    expect(raw.sha256).toMatch(/^[0-9a-f]{64}$/);
    const entry = normalizeCatalogEntry(raw, base);
    expect(hashForUrl(entry.glbUrl!)?.sha256).toBe(raw.sha256);
    // The root-relative form a scene stores finds the same hash.
    expect(hashForUrl(new URL(entry.glbUrl!).pathname)?.sha256).toBe(raw.sha256);

    const cache = new ModelCache(gltfLoader, { pickPort: () => createPickBuildPort({ createWorker: () => null }) });
    const clone = await cache.getOrLoad(entry.glbUrl!);
    expect(clone).toBeTruthy();
    const last = getCacheOutcomes().outcomes.at(-1)!;
    expect(['miss', 'hit']).toContain(last.outcome);
    expect(last.detail).toContain(raw.sha256!.slice(0, 12));
    cache.dispose();
  }, 60_000);
});
