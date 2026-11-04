// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * library-snap-index reads snap names from the GLB JSON chunk — no decode.
 *
 *  1. Parity: for every library GLB the JSON index yields exactly the names a
 *     full decode with the shared `gltfLoader` + `detectRenamedNodes` produces.
 *  2. No decode: `gltfLoader` is not touched for a normal asset, and the module
 *     imports neither GLTFLoader nor DRACOLoader (the gstatic path stays gone).
 *  3. Duplicate fallback: two nodes that sanitize to one name → decode, warning,
 *     names in the decode's `_N` spelling.
 *  4. Cache key: a new content hash re-indexes; `clearCache()` clears v3.
 *  5. Order: the parallel scan returns results in `entries` order.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Object3D } from 'three';
import { gltfLoader, detectRenamedNodes, type GltfParserLike } from '../src/core/engine/rv-glb-parse';
import { parseSnapName } from '../src/core/connect/snap-name-parser';
import { setAssetHash, clearAssetHashes } from '../src/core/library/rv-asset-hash-registry';
import type { LibraryCatalogEntry } from '../src/plugins/layout-planner/rv-layout-store';
import { assembleGlb } from './helpers/glb-fixture';

// Byte source seam: by default the REAL `getGlbBytes`; a test may route a url to
// fixture bytes or a deferred promise instead.
const bytesSeam = vi.hoisted(() => ({
  override: null as ((url: string) => Promise<ArrayBuffer>) | null,
}));
vi.mock('../src/core/engine/rv-model-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/engine/rv-model-cache')>();
  return {
    ...actual,
    getGlbBytes: vi.fn((url: string) => (bytesSeam.override ? bytesSeam.override(url) : actual.getGlbBytes(url))),
  };
});

import {
  ensureAssetIndex,
  findCompatibleLibraryAssets,
  clearCache,
  _getMemoryCache,
} from '../src/plugins/snap-point/library-snap-index';

// Keys only — the lazy loaders are never called.
const LIBRARY_GLBS = Object.keys(import.meta.glob('../public/library/**/*.glb', { query: '?url', import: 'default' }))
  .map((k) => k.replace(/^\.\.\/public/, ''))
  .sort();

const MODULE_SOURCE = Object.values(
  import.meta.glob('../src/plugins/snap-point/library-snap-index.ts', { query: '?raw', import: 'default', eager: true }),
)[0] as string;

const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);

/** Snap names a full runtime decode produces: shared loader + name reconciliation + traverse. */
async function decodedSnapNames(bytes: ArrayBuffer): Promise<string[]> {
  const gltf = await gltfLoader.parseAsync(bytes.slice(0), '');
  detectRenamedNodes(gltf.parser as unknown as GltfParserLike);
  const names: string[] = [];
  gltf.scene.traverse((n: Object3D) => { if (parseSnapName(n.name)) names.push(n.name); });
  return names.sort();
}

/** A mesh-less GLB: `Root` with one child per name. */
function snapFixture(childNames: string[]): ArrayBuffer {
  return assembleGlb({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Root', children: childNames.map((_, i) => i + 1) }, ...childNames.map((name) => ({ name }))],
  }, null);
}

function entry(id: string, glbUrl: string): LibraryCatalogEntry {
  return { id, name: id, glbUrl } as unknown as LibraryCatalogEntry;
}

function v3Keys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith('rv-snap-index-v3:')) keys.push(k);
  }
  return keys;
}

beforeEach(() => {
  clearCache();
  bytesSeam.override = null;
});

afterEach(() => {
  vi.restoreAllMocks();
  bytesSeam.override = null;
  clearAssetHashes();
  clearCache();
});

describe('library-snap-index — JSON-chunk index', () => {
  it('parity: every library GLB yields the runtime decode spelling', async () => {
    expect(LIBRARY_GLBS.length).toBeGreaterThan(0);
    // Fixture-free byte source: a plain fetch, so this test neither writes to
    // nor depends on the persistent blob cache.
    bytesSeam.override = async (url) => (await fetch(url)).arrayBuffer();
    const warn = vi.spyOn(console, 'warn');
    let totalSnaps = 0;
    for (const url of LIBRARY_GLBS) {
      const bytes = await (await fetch(url)).arrayBuffer();
      const expected = await decodedSnapNames(bytes);
      const idx = await ensureAssetIndex(url, url);
      expect(idx.snaps.map((s) => s.nodeName).sort(), url).toEqual(expected);
      for (const s of idx.snaps) {
        expect(Number.isInteger(s.nodeIndex), url).toBe(true);
        expect(typeof s.authoredName, url).toBe('string');
      }
      totalSnaps += idx.snaps.length;
    }
    // No library asset needs the decode fallback.
    expect(warn.mock.calls.some((c) => String(c[0]).includes('[library-snap-index]'))).toBe(false);
    expect(totalSnaps).toBeGreaterThan(0);
    console.info(`[library-snap-index parity] ${LIBRARY_GLBS.length} GLBs, ${totalSnaps} snaps`);
  }, 120_000);

  it('no decode: a normal asset never touches gltfLoader; no private loader import', async () => {
    const parse = vi.spyOn(gltfLoader, 'parseAsync');
    const load = vi.spyOn(gltfLoader, 'loadAsync');
    // The REAL byte path (shared blob cache).
    const idx = await ensureAssetIndex('turntable', '/library/PalletHandling/Turntable.glb');
    expect(idx.snaps.length).toBe(4);
    const zn = idx.snaps.find((s) => s.nodeName === 'Snap-ZN-convroll');
    expect(zn?.authoredName).toBe('Snap-ZN-convroll');
    expect(parse).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();

    expect(MODULE_SOURCE).toBeTruthy();
    expect(MODULE_SOURCE).not.toMatch(/from\s+['"]three\/(addons|examples\/jsm)\/loaders\/(GLTFLoader|DRACOLoader)/);
    expect(MODULE_SOURCE).not.toMatch(/new\s+(GLTFLoader|DRACOLoader)\s*\(/);
    expect(MODULE_SOURCE).not.toContain('gstatic');
  });

  it('only nodes reachable from the default scene count', async () => {
    const bytes = assembleGlb({
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }, { nodes: [2] }],
      nodes: [{ name: 'Root', children: [1] }, { name: 'Snap-ZN-in' }, { name: 'Snap-ZP-elsewhere' }, { name: 'Snap-XP-orphan' }],
    }, null);
    bytesSeam.override = async () => bytes;
    const idx = await ensureAssetIndex('reach', '/test/reach.glb');
    expect(idx.snaps.map((s) => [s.nodeName, s.nodeIndex])).toEqual([['Snap-ZN-in', 1]]);
  });

  it('duplicate fallback: colliding names decode through the shared loader with a warning', async () => {
    const url = '/test/dup-snaps.glb';
    // Both sanitize to `Snap-ZN-convroll` — Three appends `_1` to one of them.
    const bytes = snapFixture(['Snap-ZN-convroll', 'Snap-ZN-conv.roll']);
    bytesSeam.override = async () => bytes;
    const expected = await decodedSnapNames(bytes);
    expect(expected.some((n) => /_1$/.test(n))).toBe(true);

    const parse = vi.spyOn(gltfLoader, 'parseAsync');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const idx = await ensureAssetIndex('dup', url);
    expect(parse).toHaveBeenCalledTimes(1);
    // Through THE parse wrapper (plan-498) — it hands the loader the empty resource path.
    expect(parse).toHaveBeenCalledWith(expect.anything(), '');
    expect(warn.mock.calls.some((c) => String(c[0]).includes(url))).toBe(true);
    expect(idx.snaps.map((s) => s.nodeName).sort()).toEqual(expected);
    expect(idx.snaps.map((s) => s.authoredName).sort()).toEqual(['Snap-ZN-conv.roll', 'Snap-ZN-convroll']);
    expect(idx.snaps.map((s) => s.nodeIndex).sort()).toEqual([1, 2]);
  });

  it('pure sanitization keeps the authored name (no fallback)', async () => {
    const bytes = snapFixture(['Snap-ZN-conv.roll']);
    bytesSeam.override = async () => bytes;
    const expected = await decodedSnapNames(bytes);
    const parse = vi.spyOn(gltfLoader, 'parseAsync');
    const idx = await ensureAssetIndex('pure', '/test/pure.glb');
    expect(parse).not.toHaveBeenCalled();
    expect(idx.snaps.map((s) => s.nodeName)).toEqual(expected);
    expect(idx.snaps[0].nodeName).toBe('Snap-ZN-conv.roll');
  });

  it('cache key: a new content hash re-indexes; clearCache clears v3 (and legacy) keys', async () => {
    const url = '/test/hashed.glb';
    let bytes = snapFixture(['Snap-ZN-a']);
    const fetches = vi.fn(async () => bytes);
    bytesSeam.override = fetches;

    // No hash known → plain url key.
    await ensureAssetIndex('h', url);
    expect([..._getMemoryCache().keys()]).toEqual([url]);
    expect(v3Keys()).toEqual([`rv-snap-index-v3:${url}`]);
    clearCache();

    setAssetHash(url, { sha256: H1 });
    const a = await ensureAssetIndex('h', url);
    expect(a.snaps.map((s) => s.nodeName)).toEqual(['Snap-ZN-a']);
    expect(_getMemoryCache().has(`${url}@${H1}`)).toBe(true);
    expect(v3Keys()).toContain(`rv-snap-index-v3:${url}@${H1}`);
    await ensureAssetIndex('h', url); // memory hit
    expect(fetches).toHaveBeenCalledTimes(2);

    bytes = snapFixture(['Snap-ZP-b']);
    setAssetHash(url, { sha256: H2 });
    const b = await ensureAssetIndex('h', url);
    expect(fetches).toHaveBeenCalledTimes(3);
    expect(b.snaps.map((s) => s.nodeName)).toEqual(['Snap-ZP-b']);
    expect(_getMemoryCache().has(`${url}@${H2}`)).toBe(true);

    localStorage.setItem(`rv-snap-index-v2:${url}`, '{"snaps":[]}');
    clearCache();
    expect(_getMemoryCache().size).toBe(0);
    expect(v3Keys()).toEqual([]);
    expect(localStorage.getItem(`rv-snap-index-v2:${url}`)).toBeNull();

    // A v3 localStorage entry survives a memory-only loss (reload) without a fetch.
    await ensureAssetIndex('h', url);
    expect(fetches).toHaveBeenCalledTimes(4);
    (_getMemoryCache() as Map<string, unknown>).clear();
    await ensureAssetIndex('h', url);
    expect(fetches).toHaveBeenCalledTimes(4);
  });

  it('order: out-of-order resolution keeps entries order, bounded to 4, errors skipped', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const deferred = new Map<string, { resolve: (b: ArrayBuffer) => void; reject: (e: Error) => void }>();
    let inFlight = 0;
    let maxInFlight = 0;
    bytesSeam.override = (url) => new Promise<ArrayBuffer>((resolve, reject) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const done = <T>(fn: (v: T) => void) => (v: T) => { inFlight--; fn(v); };
      deferred.set(url, { resolve: done(resolve), reject: done(reject) });
    });
    const entries = [
      ...ids.map((id) => entry(id, `/test/order-${id}.glb`)),
      entry('no-url', ''),
    ];
    let finished = false;
    const pending = findCompatibleLibraryAssets(entries, 'convroll').finally(() => { finished = true; });

    // Resolve whatever is waiting, newest first, until the scan has finished.
    const settle = async (): Promise<void> => {
      for (let guard = 0; guard < 200 && !finished; guard++) {
        await new Promise((r) => setTimeout(r, 0));
        const urls = [...deferred.keys()].reverse();
        for (const url of urls) {
          const d = deferred.get(url)!;
          deferred.delete(url);
          if (url.endsWith('order-c.glb')) d.reject(new Error('load failed'));
          else d.resolve(snapFixture(['Snap-ZN-convroll']));
        }
        await new Promise((r) => setTimeout(r, 0));
      }
    };
    await settle();
    const out = await pending;
    expect(out.map((r) => r.entry.id)).toEqual(['a', 'b', 'd', 'e', 'f', 'g']);
    expect(out.every((r) => r.ownSnapName === 'Snap-ZN-convroll')).toBe(true);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThan(1);
  });
});
