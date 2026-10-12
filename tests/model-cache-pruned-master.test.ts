// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-754 §9.8 — the ModelCache after a DESTRUCTIVE bake (Phase 1b).
 *
 * Three guarantees, each of them a hole somebody would otherwise fall into:
 *  - the pruned template never leaks a non-survivor: `getOrLoad` is a geometry
 *    consumer (drag ghost, thumbnail) and gets chunk + keep meshes, never a
 *    bare CAD leaf that no longer exists (R6);
 *  - `decodeFresh` is the ONE door back to the full source tree, and it is
 *    neither cached nor de-duplicated — two callers get two trees, because both
 *    of its uses either edit or consume what they get;
 *  - a second placement of the asset allocates NO new geometry: the chunk
 *    buffers are shared by reference (D21), which is the whole reason a
 *    template is worth keeping.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Group, Mesh, type BufferGeometry, type Object3D } from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
// Side effect: registers every component's capabilities (Drive = `chunk`,
// Lamp = `keep`) — what the survival model and the classification read.
import '../src/core/engine/rv-scene-loader';
import { ModelCache } from '../src/core/engine/rv-model-cache';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { BakeRegistry } from '../src/core/engine/rv-bake-registry';
import { group, uberMesh, withComponent } from './fixtures/bake-fixture';

const URL_KEY = 'blob:rv-test/pruned-master.glb';
const uber = new RVUberMaterial(false);

/**
 * Machine
 *  ├─ Housing              bare CAD, nothing claims it  → REMOVED, triangles to the static chunk
 *  │   └─ CadBolt          idem (a removed top removes its subtree)
 *  ├─ Axis     (Drive)     boundary → its own chunk, node survives
 *  │   └─ Arm              bare CAD under the boundary  → REMOVED
 *  └─ Beacon   (Lamp)      keep mesh → MOVED into the template, geometry intact
 */
function makeAsset(): Group {
  const root = group('Machine');
  const housing = group('Housing');
  housing.add(uberMesh(uber, 'CadBolt', [0, 0, 1]));
  root.add(housing);
  const axis = withComponent(group('Axis'), 'Drive', { Direction: 'RotationY' });
  axis.add(uberMesh(uber, 'Arm', [1, 0, 0]));
  root.add(axis);
  const beacon = uberMesh(uber, 'Beacon', [0, 2, 0]);
  withComponent(beacon, 'Lamp', { OnColor: { r: 1, g: 0, b: 0, a: 1 } });
  root.add(beacon);
  return root;
}

/** A loader that parses a FRESH tree every time — as a real one does. */
function fakeLoader(counter?: { parses: number }): GLTFLoader {
  return {
    loadAsync: async (): Promise<{ scene: Group }> => {
      if (counter) counter.parses++;
      return { scene: makeAsset() };
    },
  } as unknown as GLTFLoader;
}

function makeCache(counter?: { parses: number }): ModelCache {
  return new ModelCache(fakeLoader(counter), { uber: () => uber, pickPort: () => createPickBuildPort({ createWorker: () => null }) });
}

function names(root: Object3D): string[] {
  const out: string[] = [];
  root.traverse((n) => out.push(n.name));
  return out;
}

function geometriesOf(root: Object3D): Set<BufferGeometry> {
  const out = new Set<BufferGeometry>();
  root.traverse((n) => {
    const m = n as Mesh;
    if (m.isMesh && m.geometry) out.add(m.geometry);
  });
  return out;
}

describe('ModelCache after a destructive bake (plan-754 §9.8)', () => {

  it('getOrLoad never yields a non-survivor, and the decode is gone', async () => {
    const cache = makeCache();
    const baked = await cache.getOrLoadBaked(URL_KEY);
    expect(baked.destructive).toBe(true);
    // The decode the bake consumed is not in the cache any more (§2.6).
    expect(cache.size).toBe(0);

    const clone = await cache.getOrLoad(URL_KEY);
    const cloned = names(clone);
    // Survivors: the root, the Drive boundary, the keep mesh.
    expect(cloned).toContain('Machine');
    expect(cloned).toContain('Axis');
    expect(cloned).toContain('Beacon');
    // Non-survivors: nothing unclaimed comes back, at any depth.
    expect(cloned).not.toContain('Housing');
    expect(cloned).not.toContain('CadBolt');
    expect(cloned).not.toContain('Arm');
    // …and it is still geometry-COMPLETE: every triangle is in a chunk or a
    // keep mesh, which is what makes the ghost/thumbnail consumers class (b).
    let triangles = 0;
    clone.traverse((n) => {
      const m = n as Mesh;
      if (!m.isMesh || !m.geometry) return;
      const g = m.geometry;
      triangles += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    });
    expect(triangles).toBe(baked.triangles + 12); // chunks + the kept Beacon box
    // Asking again does not resurrect the decode.
    await cache.getOrLoad(URL_KEY);
    expect(cache.size).toBe(0);
  });

  it('decodeFresh yields the FULL tree, is not cached, and hands each caller its own', async () => {
    const counter = { parses: 0 };
    const cache = makeCache(counter);
    await cache.getOrLoadBaked(URL_KEY);
    const parsesAfterBake = counter.parses;

    const fresh = await cache.decodeFresh(URL_KEY);
    const full = names(fresh);
    expect(full).toContain('Housing');
    expect(full).toContain('CadBolt');
    expect(full).toContain('Arm');
    expect(full).toContain('Beacon');
    // Not published: the pruned state of the cache is unchanged by a fresh decode.
    expect(cache.size).toBe(0);

    const second = await cache.decodeFresh(URL_KEY);
    expect(second).not.toBe(fresh);
    expect(counter.parses).toBe(parsesAfterBake + 2);
    // Two trees, two sets of objects — nothing is shared that a caller could edit.
    expect(second.getObjectByName('CadBolt')).not.toBe(fresh.getObjectByName('CadBolt'));

    // A registry key without its resolve callback has no transport at all —
    // refused, not silently fetched as if it were a URL.
    await expect(cache.decodeFresh('resolved:prov:src:entry')).rejects.toThrow(/registry resolve callback/);
  });

  it('a second placement of the asset allocates no new geometry', async () => {
    const cache = makeCache();
    const baked = await cache.getOrLoadBaked(URL_KEY);
    const registry = new BakeRegistry();

    const rootA = new Group();
    const a = registry.instantiate(baked, rootA);
    const geometriesA = geometriesOf(rootA);
    expect(geometriesA.size).toBeGreaterThan(0);

    const rootB = new Group();
    const b = registry.instantiate(baked, rootB);
    const geometriesB = geometriesOf(rootB);
    expect(geometriesB.size).toBe(geometriesA.size);
    const fresh = [...geometriesB].filter((g) => !geometriesA.has(g));
    expect(fresh).toEqual([]);

    registry.release(a);
    registry.release(b);
  });
});
