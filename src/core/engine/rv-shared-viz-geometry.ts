// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Shared, refcounted geometries for per-component visualisation helpers
 * (sensor ray tube, sensor collision box + its edge outline).
 *
 * Every placement of a library object with a sensor used to build its own
 * `CylinderGeometry` / `BoxGeometry` / `EdgesGeometry` — 30 conveyor
 * placements = 30 identical ray tubes, and `renderer.info.memory.geometries`
 * grew by one per placement. Identical parameters now resolve to ONE
 * `BufferGeometry` instance, keyed on the rounded parameters, and the instance
 * is freed when the last user releases it.
 *
 * Ownership contract (mirrors the baked-chunk guard, `chunkMetaOf`):
 *  - Every geometry handed out here is registered in
 *    {@link sharedVizGeometries}. The tree dispose helpers (`disposeSubtree`
 *    in rv-traverse-utils, `disposeModelSubtree` in rv-dispose-subtree) skip
 *    such a mesh entirely — geometry AND material — because a tree teardown
 *    of one placement must not free what the other placements still render.
 *  - The component that acquired the geometry is the only party that releases
 *    it: `RVSensor.dispose()` → {@link releaseSharedVizGeometry}. The
 *    geometry is disposed at refcount 0 and dropped from the cache, so a
 *    later acquire with the same key builds a fresh one.
 *  - If a teardown path skips the component's `dispose()`, the entry simply
 *    stays cached (bounded: one per distinct parameter tuple) and is reused by
 *    the next sensor with the same parameters — never a per-placement leak.
 *
 * Leaf module: imports only `three`, so both dispose helpers can import it
 * without forming a cycle.
 */

import { BoxGeometry, BufferGeometry, CylinderGeometry, EdgesGeometry } from 'three';

/** Every geometry handed out by this module. Dispose helpers skip these. */
export const sharedVizGeometries = new WeakSet<BufferGeometry>();

interface Entry { geometry: BufferGeometry; refs: number }

const cache = new Map<string, Entry>();
/** Reverse lookup geometry → cache key, for release and for the derived edges key. */
const keyOf = new WeakMap<BufferGeometry, string>();

/** Rounds a metre value to 1e-6 m so float noise does not split identical tubes. */
function q(v: number): number {
  return Math.round(v * 1e6);
}

function acquire(key: string, build: () => BufferGeometry): BufferGeometry {
  let entry = cache.get(key);
  if (!entry) {
    const geometry = build();
    entry = { geometry, refs: 0 };
    cache.set(key, entry);
    keyOf.set(geometry, key);
    sharedVizGeometries.add(geometry);
  }
  entry.refs++;
  return entry.geometry;
}

/**
 * Sensor ray tube: a non-indexed cylinder of `maxDist` length, pivot at the
 * ray origin, pointing along local +Z. Same construction as before the cache
 * (translate → rotateX → toNonIndexed for WebGPU index-format safety).
 */
export function acquireRayTubeGeometry(radius: number, maxDist: number, radialSegments = 6): BufferGeometry {
  return acquire(`ray:${q(radius)}:${q(maxDist)}:${radialSegments}`, () => {
    const indexed = new CylinderGeometry(radius, radius, maxDist, radialSegments, 1);
    indexed.translate(0, maxDist / 2, 0);
    indexed.rotateX(Math.PI / 2);
    const geo = indexed.toNonIndexed();
    indexed.dispose();
    return geo;
  });
}

/** Sensor collision box (full side lengths in metres). */
export function acquireSensorBoxGeometry(sx: number, sy: number, sz: number): BufferGeometry {
  return acquire(`box:${q(sx)}:${q(sy)}:${q(sz)}`, () => new BoxGeometry(sx, sy, sz));
}

/**
 * Edge outline of a box acquired via {@link acquireSensorBoxGeometry}. Cached
 * under a key derived from the box key; refcounted independently of the box
 * (release both).
 */
export function acquireSensorEdgesGeometry(box: BufferGeometry): BufferGeometry {
  const boxKey = keyOf.get(box);
  if (!boxKey) throw new Error('[shared-viz-geometry] edges requested for a box that is not a shared box geometry');
  return acquire(`edges:${boxKey}`, () => new EdgesGeometry(box));
}

/**
 * Drop one reference. Disposes and evicts the geometry when the last user
 * lets go. Returns `true` when the geometry was actually disposed. Unknown or
 * already-released geometries are a no-op (`false`).
 */
export function releaseSharedVizGeometry(geometry: BufferGeometry | null | undefined): boolean {
  if (!geometry) return false;
  const key = keyOf.get(geometry);
  if (key === undefined) return false;
  const entry = cache.get(key);
  if (!entry || entry.geometry !== geometry) return false;
  entry.refs--;
  if (entry.refs > 0) return false;
  cache.delete(key);
  keyOf.delete(geometry);
  sharedVizGeometries.delete(geometry);
  geometry.dispose();
  return true;
}

/** Current reference count of a shared geometry (0 when unknown). Test hook. */
export function sharedVizGeometryRefs(geometry: BufferGeometry): number {
  const key = keyOf.get(geometry);
  if (key === undefined) return 0;
  return cache.get(key)?.refs ?? 0;
}
