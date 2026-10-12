// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-754 §9.21 — the full-tree door after a destructive bake (Phase 1b).
 *
 * Extends `editor-open-from-placement.test.ts`, which pinned the plan-753
 * contract "the decoded master survives the bake". That contract is gone: the
 * bake CONSUMES its input (D9), so this file pins what replaces it.
 *
 * The asset editor and `descend` are class (c) — they need the full source
 * hierarchy — and they get it WITHOUT this cache: both open the child's own
 * bytes as an authoring load, and an authoring load refuses the bake outright
 * (`assertBakeAllowed`). `decodeFresh` is the door for a (c) consumer that
 * starts from a cache key instead of a file — today the forced-split re-bake.
 *
 * Forced split (§2.6, executor decision): kept working THROUGH `decodeFresh`,
 * not cut. A split bake is a second bake of the same asset, so it decodes its
 * own uncached tree and prunes that one.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Group, Mesh, type Object3D } from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import '../src/core/engine/rv-scene-loader';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { ModelCache } from '../src/core/engine/rv-model-cache';
import { PlacementInstancer } from '../src/core/engine/rv-placement-instancer';
import { BakeRegistry } from '../src/core/engine/rv-bake-registry';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { assertBakeAllowed } from '../src/core/engine/rv-bake-pipeline';
import { setNodeId } from '../src/core/engine/rv-node-id';
import { group, uberMesh, withComponent } from './fixtures/bake-fixture';

const GLB_URL = 'blob:rv-test/editor-open.glb';
const SPLIT_ID = 'node-id:cover';
const uber = new RVUberMaterial(false);

/**
 * Cabinet
 *  ├─ Frame        bare CAD → merged into the static chunk, node removed
 *  ├─ Cover        bare CAD with a stable node id → the forced-split target
 *  │   └─ Hinge    bare CAD under it
 *  └─ Axis (Drive) boundary → own chunk, node survives
 */
function makeAsset(): Group {
  const root = group('Cabinet');
  root.add(uberMesh(uber, 'Frame'));
  const cover = group('Cover');
  setNodeId(cover, SPLIT_ID);
  cover.add(uberMesh(uber, 'Hinge', [0, 1, 0]));
  root.add(cover);
  const axis = withComponent(group('Axis'), 'Drive', { Direction: 'RotationY' });
  axis.add(uberMesh(uber, 'Arm', [2, 0, 0]));
  root.add(axis);
  return root;
}

/**
 * plan-757 R1 — BYTE semantics: the real loader path of `_decode` is bytes →
 * `verifyRvSigBuffer` → `parseAsync` → `detectRenamedNodes` → drop the parser.
 * The mock loader therefore exposes `parseAsync` (not `loadAsync`) and asserts
 * it is handed the very bytes the cache fetched; the fetch itself is the
 * `_fetchBytes` seam, answered with a REAL (unsigned) GLB so the signature
 * verdict of the decode is `'none'`, not `'invalid'`.
 */
let assetBytes: ArrayBuffer;

class ByteCache extends ModelCache {
  protected override async _fetchBytes(url: string): Promise<ArrayBuffer> {
    expect(url).toBe(GLB_URL);
    return assetBytes.slice(0);
  }
}

function fakeLoader(counter?: { parses: number; bytes: number }): GLTFLoader {
  return {
    parseAsync: async (data: ArrayBuffer, path: string): Promise<{ scene: Group }> => {
      expect(data).toBeInstanceOf(ArrayBuffer);
      expect(data.byteLength).toBe(assetBytes.byteLength);
      expect(path).toBe('');
      if (counter) { counter.parses++; counter.bytes += data.byteLength; }
      return { scene: makeAsset() };
    },
  } as unknown as GLTFLoader;
}

function makeCache(counter?: { parses: number; bytes: number }): ModelCache {
  return new ByteCache(fakeLoader(counter), { uber: () => uber, pickPort: () => createPickBuildPort({ createWorker: () => null }) });
}

beforeAll(async () => { assetBytes = await objectToGlb(makeAsset()); });

function names(root: Object3D): string[] {
  const out: string[] = [];
  root.traverse((n) => out.push(n.name));
  return out;
}

describe('the full-tree door after a destructive bake (plan-754 §9.21)', () => {

  it('loadModel gives the pruned template, decodeFreshModel the full CAD tree', async () => {
    const cache = makeCache();
    const instancer = new PlacementInstancer({ bakeRegistry: () => new BakeRegistry() });
    instancer.setModelCache(cache);
    const ref = { catalogId: 'cat:cabinet', glbUrl: GLB_URL };

    await instancer.resolveBaked(ref);

    // (b) — geometry only. The drag ghost and the thumbnail live here.
    const drawable = await instancer.loadModel(ref);
    expect(names(drawable)).not.toContain('Cover');
    expect(names(drawable)).not.toContain('Frame');
    let meshes = 0;
    drawable.traverse((n) => { if ((n as Mesh).isMesh) meshes++; });
    expect(meshes).toBeGreaterThan(0);

    // (c) — the full source hierarchy, through the one door.
    const full = await instancer.decodeFreshModel(ref);
    expect(names(full)).toEqual(expect.arrayContaining(['Cabinet', 'Frame', 'Cover', 'Hinge', 'Axis', 'Arm']));
    // And it did not repopulate the cache the bake emptied.
    expect(cache.size).toBe(0);
  });

  it('an authoring load (editor open / descend) never reaches a bake at all', () => {
    // The mechanism behind "editor open gets the FULL tree": it is not a cache
    // lookup, it is a load of the child's own bytes with `preserveHierarchy`,
    // and THAT is refused by the bake entry — so no template can ever reach the
    // asset editor, whatever the cache holds for the same asset.
    expect(() => assertBakeAllowed({ preserveHierarchy: true })).toThrow(/preserveHierarchy/);
    expect(() => assertBakeAllowed({ preserveHierarchy: false })).not.toThrow();
  });

  it('a forced split still works after the base bake consumed the decode', async () => {
    const counter = { parses: 0, bytes: 0 };
    const cache = makeCache(counter);

    const base = await cache.getOrLoadBaked(GLB_URL);
    expect(base.destructive).toBe(true);
    expect(cache.size).toBe(0);
    // plan-757 R1/D8: the decode ran on BYTES (one parse of exactly the fetched
    // buffer) and the asset carries the verdict of those bytes — unsigned.
    expect(counter.parses).toBe(1);
    expect(counter.bytes).toBe(assetBytes.byteLength);
    expect(base.signatureState).toBe('none');
    const parsesAfterBase = counter.parses;

    // The split target is a bare CAD node the BASE bake removed — which is
    // exactly why the split bake cannot reuse the pruned template and decodes
    // its own tree instead (§2.6).
    const split = await cache.getOrLoadBaked(GLB_URL, undefined, { forceSplitNodeIds: [SPLIT_ID] });
    expect(counter.parses).toBe(parsesAfterBase + 1);
    expect(split).not.toBe(base);
    expect(split.destructive).toBe(true);
    // The split node became a boundary: its own chunk, and it survives as a node.
    expect(split.chunks.map((c) => c.ownerPath)).toContain('Cover');
    expect(names(split.template)).toContain('Cover');
    // The base bake is untouched by it — different key, different asset.
    expect(base.chunks.map((c) => c.ownerPath)).not.toContain('Cover');
    expect(cache.peekBaked(GLB_URL)).toBe(base);
  });
});
