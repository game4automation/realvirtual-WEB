// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-776 §9.8 — the session URL store and the pointer resolver.
 *
 * One read per pointer however many cards show it; a reference per mounted
 * card; idle entries released oldest-first past the cap; everything released
 * on a clear; and the one-shot deletion of the old Cache API buckets.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  acquireThumbnailUrl,
  cleanupLegacyThumbnailCaches,
  clearThumbnailUrls,
  releaseThumbnailUrl,
  resetThumbnailUrlStoreForTests,
  thumbnailUrlStoreSize,
  LEGACY_THUMBNAIL_BUCKETS,
  MAX_ENTRIES,
} from '../src/core/thumbnails/rv-thumbnail-url-store';
import { resolveThumbnailUrl } from '../src/core/library/resolve-document-thumbnail';
import type { ProjectBackend } from '../src/core/project/backends/project-backend';

function countingBackend() {
  const released: string[] = [];
  const backend = {
    kind: 'folder', id: 'url-store', writable: true, isActive: true,
    readDocumentUrl: vi.fn(async (p: string) => ({ url: `blob:${p}`, release: () => { released.push(p); } })),
  } as unknown as ProjectBackend & { readDocumentUrl: ReturnType<typeof vi.fn> };
  return { backend, released };
}

beforeEach(() => resetThumbnailUrlStoreForTests());
afterEach(() => { resetThumbnailUrlStoreForTests(); vi.restoreAllMocks(); });

describe('thumbnail URL store (F8)', () => {
  it('two cards on one pointer: one read, released on the last clear', async () => {
    const { backend, released } = countingBackend();
    const p = '.thumbnails/a.11111111.webp';
    const [u1, u2] = await Promise.all([acquireThumbnailUrl(backend, p), acquireThumbnailUrl(backend, p)]);
    expect(u1).toBe(`blob:${p}`);
    expect(u2).toBe(u1);
    expect(backend.readDocumentUrl).toHaveBeenCalledTimes(1);
    releaseThumbnailUrl(backend, p);
    releaseThumbnailUrl(backend, p);
    expect(released).toEqual([]);              // idle, not gone — scrolling back is free
    clearThumbnailUrls();
    expect(released).toEqual([p]);
  });

  it('a new pointer (re-save) is a new entry; the old one goes idle', async () => {
    const { backend } = countingBackend();
    await acquireThumbnailUrl(backend, '.thumbnails/a.11111111.webp');
    releaseThumbnailUrl(backend, '.thumbnails/a.11111111.webp');
    expect(await acquireThumbnailUrl(backend, '.thumbnails/a.22222222.webp')).toBe('blob:.thumbnails/a.22222222.webp');
    expect(backend.readDocumentUrl).toHaveBeenCalledTimes(2);
  });

  it('clear() (project switch, viewer dispose) releases every URL', async () => {
    const { backend, released } = countingBackend();
    await acquireThumbnailUrl(backend, '.thumbnails/a.11111111.webp');
    await acquireThumbnailUrl(backend, '.thumbnails/b.11111111.webp');
    clearThumbnailUrls();
    expect(released.sort()).toEqual(['.thumbnails/a.11111111.webp', '.thumbnails/b.11111111.webp']);
    expect(thumbnailUrlStoreSize()).toBe(0);
  });

  it(`caps at ${MAX_ENTRIES} entries, releasing idle ones oldest first and never a held one`, async () => {
    const { backend, released } = countingBackend();
    const held = '.thumbnails/held.00000000.webp';
    await acquireThumbnailUrl(backend, held);              // stays referenced
    for (let i = 0; i < MAX_ENTRIES + 10; i++) {
      const p = `.thumbnails/d${i}.00000000.webp`;
      await acquireThumbnailUrl(backend, p);
      releaseThumbnailUrl(backend, p);
    }
    expect(thumbnailUrlStoreSize()).toBe(MAX_ENTRIES);
    expect(released).not.toContain(held);
    expect(released.slice(0, 3)).toEqual([
      '.thumbnails/d0.00000000.webp', '.thumbnails/d1.00000000.webp', '.thumbnails/d2.00000000.webp',
    ]);
  });

  it('deletes the old render-on-view Cache API buckets once', async () => {
    const deleted: string[] = [];
    vi.spyOn(caches, 'delete').mockImplementation(async (name: string) => { deleted.push(name); return true; });
    const first = await cleanupLegacyThumbnailCaches();
    await cleanupLegacyThumbnailCaches();
    expect(first).toEqual([...LEGACY_THUMBNAIL_BUCKETS]);
    expect(deleted).toEqual(['rv-thumbnails-v4', 'rv-thumbnails-v3', 'rv-thumbnails-v2', 'rv-planner-thumbnails']);
  });
});

describe('resolveThumbnailUrl (F7)', () => {
  it('passes scheme / absolute pointers through, refuses `..` and non-.thumbnails pointers', async () => {
    const { backend } = countingBackend();
    expect((await resolveThumbnailUrl(backend, 'https://x/y.png'))?.url).toBe('https://x/y.png');
    expect((await resolveThumbnailUrl(backend, '/y.png'))?.url).toBe('/y.png');
    expect(await resolveThumbnailUrl(backend, '../models/x.glb')).toBeNull();
    expect(await resolveThumbnailUrl(backend, 'models/x.png')).toBeNull();
    expect(backend.readDocumentUrl).not.toHaveBeenCalled();
  });

  it('never probes the legacy `.thumbnails/<id>.png` when there is no pointer', async () => {
    const { backend } = countingBackend();
    expect(await resolveThumbnailUrl(backend, undefined)).toBeNull();
    expect(await resolveThumbnailUrl(backend, '')).toBeNull();
    expect(backend.readDocumentUrl).not.toHaveBeenCalled();
  });
});
