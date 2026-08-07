// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ThumbnailCache + stable key — moved out of the Layout Planner into
 * `core/thumbnails/` by plan-372 Phase 5.
 *
 * The three original cases (round-trip, key isolation, graceful no-op without
 * the Cache API) are kept verbatim in intent; they now run against the stable
 * identity key instead of the asset's `glbUrl`. The key cases below cover what
 * the move was actually for: two projects owning an equally-named asset must
 * not share one preview.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ThumbnailCache, THUMBNAIL_BUCKET_V2 } from '../src/core/thumbnails/thumbnail-cache';
import { buildThumbnailKey, NO_PROJECT } from '../src/core/thumbnails/thumbnail-key';

/** Minimal in-memory Cache API stub (keyed by request URL string). */
function installFakeCaches(): { buckets: Map<string, Map<string, Response>>; deleted: string[] } {
  const buckets = new Map<string, Map<string, Response>>();
  const deleted: string[] = [];
  const fake = {
    open: async (name: string) => {
      let store = buckets.get(name);
      if (!store) { store = new Map(); buckets.set(name, store); }
      return {
        match: async (key: string) => store!.get(String(key)),
        put: async (key: string, resp: Response) => { store!.set(String(key), resp); },
      };
    },
    delete: async (name: string) => { deleted.push(name); return buckets.delete(name); },
  };
  vi.stubGlobal('caches', fake);
  return { buckets, deleted };
}

const KEY_A = buildThumbnailKey({ projectId: 'p1', providerId: 'core', sourceId: 's', assetId: 'a' });
const KEY_B = buildThumbnailKey({ projectId: 'p1', providerId: 'core', sourceId: 's', assetId: 'b' });

beforeEach(() => { installFakeCaches(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('ThumbnailCache', () => {
  it('round-trips a stored preview blob and returns an object URL', async () => {
    const cache = new ThumbnailCache('test-bucket');
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });

    expect(await cache.get(KEY_A)).toBeNull(); // miss before put
    await cache.put(KEY_A, blob);

    const url = await cache.get(KEY_A);
    expect(url).toBeTruthy();
    expect(url!.startsWith('blob:')).toBe(true);
  });

  it('isolates entries by stable key', async () => {
    const cache = new ThumbnailCache('test-bucket');
    await cache.put(KEY_A, new Blob(['a'], { type: 'image/png' }));
    expect(await cache.get(KEY_A)).toBeTruthy();
    expect(await cache.get(KEY_B)).toBeNull();
  });

  it('returns null and never throws when the Cache API is unavailable', async () => {
    vi.stubGlobal('caches', undefined);
    const cache = new ThumbnailCache('test-bucket');
    await expect(cache.put(KEY_A, new Blob(['z']))).resolves.toBeUndefined();
    expect(await cache.get(KEY_A)).toBeNull();
  });

  it('purges the legacy glbUrl-keyed bucket once, and only for the default bucket', async () => {
    const { deleted } = installFakeCaches();
    // A test bucket must never delete a real user's cache.
    await new ThumbnailCache('test-bucket').get(KEY_A);
    expect(deleted).not.toContain('rv-planner-thumbnails');

    await new ThumbnailCache(THUMBNAIL_BUCKET_V2).get(KEY_A);
    expect(deleted).toContain('rv-planner-thumbnails');

    // Second instance must not purge again (module-scope guard).
    const before = deleted.filter(d => d === 'rv-planner-thumbnails').length;
    await new ThumbnailCache(THUMBNAIL_BUCKET_V2).get(KEY_B);
    expect(deleted.filter(d => d === 'rv-planner-thumbnails').length).toBe(before);
  });
});

describe('buildThumbnailKey', () => {
  it('separates equally-named assets in different projects', () => {
    const a = buildThumbnailKey({ projectId: 'proj-a', providerId: 'core', sourceId: 'lib', assetId: 'conveyor/belt.glb' });
    const b = buildThumbnailKey({ projectId: 'proj-b', providerId: 'core', sourceId: 'lib', assetId: 'conveyor/belt.glb' });
    expect(a).not.toBe(b);
  });

  it('is deterministic and includes the version only when present', () => {
    const parts = { projectId: 'p', providerId: 'core', sourceId: 's', assetId: 'a' };
    expect(buildThumbnailKey(parts)).toBe(buildThumbnailKey(parts));
    expect(buildThumbnailKey(parts)).toBe('p:core:s:a');
    expect(buildThumbnailKey({ ...parts, version: 'v2' })).toBe('p:core:s:a:v2');
  });

  it('escapes colons so one part cannot impersonate another key', () => {
    const sneaky = buildThumbnailKey({ projectId: 'p', providerId: 'core', sourceId: 's', assetId: 'a:v9' });
    const real = buildThumbnailKey({ projectId: 'p', providerId: 'core', sourceId: 's', assetId: 'a', version: 'v9' });
    expect(sneaky).not.toBe(real);
  });

  it('falls back to a visible placeholder when no project is active', () => {
    expect(buildThumbnailKey({ projectId: '', providerId: 'core', sourceId: 's', assetId: 'a' }))
      .toBe(NO_PROJECT + ':core:s:a');
  });
});
