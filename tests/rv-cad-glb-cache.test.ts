// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-cad-glb-cache.test.ts — the durable, content-addressed store of converted
 * GLB bytes. This is what makes an editor reload a byte read instead of an occt
 * re-tessellation, and what lets a PUBLIC build (no CAD provider) replay a draft.
 *
 * Covers both tiers (working folder, Cache API fallback), the `(sha256, quality)`
 * key, and the reason the cache CANNOT live under `library/`: `listFiles`
 * recurses every subdirectory and filters only by extension, so cached GLBs there
 * would surface as planner catalog entries.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// The cache has two tiers: the OPFS blob store and a Cache-API fallback. The
// work-folder tier it once had is gone (plan-709 §2.6), so nothing about the
// File System Access API is stubbed any more — `listFiles` below runs for real
// against the in-memory handles, which is what the last two tests need.
const state = vi.hoisted(() => ({ opfsAvailable: true }));

// OPFS itself stays REAL (the browser runner provides it); only the
// availability probe is stubbed so the Cache-API fallback stays reachable.
vi.mock('../src/core/storage/rv-opfs-blobs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/storage/rv-opfs-blobs')>();
  return { ...actual, isOpfsSupported: () => state.opfsAvailable };
});

import {
  putCadGlb,
  getCadGlb,
  clearCadGlbCache,
  cadGlbFileName,
  sha256Hex,
  CAD_CACHE_FOLDER,
} from '../src/core/import/rv-cad-glb-cache';
import { listFiles } from '../src/core/engine/rv-local-filesystem';

// ─── Fake FS ─────────────────────────────────────────────────────────────

class FakeFile {
  readonly kind = 'file';
  constructor(public name: string, private blob: Blob = new Blob()) {}
  async getFile(): Promise<Blob> { return this.blob; }
  async createWritable() {
    const self = this;
    return {
      async write(data: Blob | ArrayBuffer) { self.blob = data instanceof Blob ? data : new Blob([data]); },
      async close() { /* no-op */ },
    };
  }
}

class FakeDir {
  readonly kind = 'directory';
  private children = new Map<string, FakeDir | FakeFile>();
  constructor(public name: string) {}

  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FakeDir> {
    const hit = this.children.get(name);
    if (hit instanceof FakeDir) return hit;
    if (!opts?.create) throw new DOMException('NotFoundError', 'NotFoundError');
    const dir = new FakeDir(name);
    this.children.set(name, dir);
    return dir;
  }
  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FakeFile> {
    const hit = this.children.get(name);
    if (hit instanceof FakeFile) return hit;
    if (!opts?.create) throw new DOMException('NotFoundError', 'NotFoundError');
    const file = new FakeFile(name);
    this.children.set(name, file);
    return file;
  }
  async removeEntry(name: string): Promise<void> { this.children.delete(name); }
  async *keys(): AsyncIterableIterator<string> { for (const k of this.children.keys()) yield k; }
  async *entries(): AsyncIterableIterator<[string, FakeDir | FakeFile]> {
    for (const e of this.children.entries()) yield e;
  }
}

const bytesOf = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const textOf = async (b: ArrayBuffer | null) => (b ? new TextDecoder().decode(b) : null);

beforeEach(async () => {
  state.opfsAvailable = true;
  await clearCadGlbCache();
});

// ─── Keys ────────────────────────────────────────────────────────────────

describe('cadGlbFileName', () => {
  it('embeds a cache version so retuned quality presets cannot serve stale GLBs', () => {
    expect(cadGlbFileName('abc123', 'standard')).toMatch(/^v\d+\.abc123\.standard\.glb$/);
  });

  it('sanitizes the quality token and separates qualities', () => {
    expect(cadGlbFileName('h', 'Ultra Fine!')).toContain('.ultra-fine-.');
    expect(cadGlbFileName('h', 'coarse')).not.toBe(cadGlbFileName('h', 'fine'));
  });
});

describe('sha256Hex', () => {
  it('is a stable lowercase hex digest of the bytes', async () => {
    const a = await sha256Hex(bytesOf('step-source'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256Hex(bytesOf('step-source'))).toBe(a);
    expect(await sha256Hex(bytesOf('other'))).not.toBe(a);
  });
});

// ─── Cache-API tier (OPFS unavailable) ───────────────────────────────────

describe('Cache-API fallback tier', () => {
  // The browser runner HAS OPFS, so this tier is only reachable by taking OPFS
  // away — which is exactly the private-mode shape the fallback exists for.
  beforeEach(() => { state.opfsAvailable = false; });

  it('round-trips bytes under (sha256, quality)', async () => {
    expect(await putCadGlb('hash1', 'standard', bytesOf('GLB-A'))).toBe('cache-api');
    expect(await textOf(await getCadGlb('hash1', 'standard'))).toBe('GLB-A');
  });

  it('keys on BOTH hash and quality (a quality change must re-convert)', async () => {
    await putCadGlb('hash1', 'coarse', bytesOf('GLB-coarse'));
    expect(await textOf(await getCadGlb('hash1', 'coarse'))).toBe('GLB-coarse');
    expect(await getCadGlb('hash1', 'fine')).toBeNull();
    expect(await getCadGlb('hash2', 'coarse')).toBeNull();
  });

  it('a miss is null, never a throw (callers re-tessellate or prompt)', async () => {
    expect(await getCadGlb('never-stored', 'standard')).toBeNull();
  });

  it('clearCadGlbCache wipes the bucket', async () => {
    await putCadGlb('hash1', 'standard', bytesOf('GLB-A'));
    await clearCadGlbCache();
    expect(await getCadGlb('hash1', 'standard')).toBeNull();
  });
});

// ─── OPFS tier (plan-372 §5.4) ───────────────────────────────────────────

describe('OPFS tier', () => {
  it('reports the opfs tier and reads the bytes back', async () => {
    expect(await putCadGlb('hashW', 'standard', bytesOf('GLB-W'))).toBe('opfs');
    expect(await textOf(await getCadGlb('hashW', 'standard'))).toBe('GLB-W');
  });

  it('is preferred over the Cache-API tier', async () => {
    // Seed the Cache API with OPFS unavailable, then bring OPFS back with
    // different bytes for the same key: the OPFS copy must win.
    state.opfsAvailable = false;
    await putCadGlb('hashP', 'standard', bytesOf('FROM-CACHE-API'));
    state.opfsAvailable = true;
    await putCadGlb('hashP', 'standard', bytesOf('FROM-OPFS'));

    expect(await textOf(await getCadGlb('hashP', 'standard'))).toBe('FROM-OPFS');
  });

  it('falls back to the Cache API when OPFS holds nothing', async () => {
    state.opfsAvailable = false;
    await putCadGlb('hashF', 'standard', bytesOf('ONLY-IN-CACHE-API'));
    state.opfsAvailable = true;
    expect(await textOf(await getCadGlb('hashF', 'standard'))).toBe('ONLY-IN-CACHE-API');
  });

  it('separates qualities even though the store keys on one hash', async () => {
    // The composite key is folded into a single sha256 so the store's
    // path-traversal guard still accepts it — qualities must stay distinct.
    await putCadGlb('hashQ', 'coarse', bytesOf('COARSE'));
    expect(await textOf(await getCadGlb('hashQ', 'coarse'))).toBe('COARSE');
    expect(await getCadGlb('hashQ', 'fine')).toBeNull();
  });
});

// ─── Catalog pollution guard ─────────────────────────────────────────────

describe('the cache must not pollute the planner catalog', () => {
  it('.cad-cache is a SIBLING of library/, and listFiles(library) never sees it', async () => {
    // listFiles recurses every subdirectory and filters only by extension — a
    // cache under library/ would list every cached GLB as a catalog asset.
    // (library/.thumbnails/ escapes that only because it holds .png.)
    const root = new FakeDir('work');
    const lib = await root.getDirectoryHandle('library', { create: true });
    await lib.getFileHandle('Forklift.glb', { create: true });
    const cache = await root.getDirectoryHandle(CAD_CACHE_FOLDER, { create: true });
    await cache.getFileHandle(cadGlbFileName('deadbeef', 'standard'), { create: true });

    const found = await listFiles(lib as unknown as FileSystemDirectoryHandle, ['.glb']);
    expect(found.map((f) => f.name)).toEqual(['Forklift.glb']);

    // Belt and braces: the constant itself must not be nested under library.
    expect(CAD_CACHE_FOLDER.startsWith('library')).toBe(false);
  });

  it('proves the hazard: listFiles WOULD pick up a cache placed under library/', async () => {
    const lib = new FakeDir('library');
    const bad = await lib.getDirectoryHandle('.cad', { create: true });
    await bad.getFileHandle('deadbeef.standard.glb', { create: true });

    const found = await listFiles(lib as unknown as FileSystemDirectoryHandle, ['.glb']);
    expect(found).toHaveLength(1); // ← exactly the catalog pollution we avoid
  });
});
