// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * select-actions.test.ts — set computations behind the editor's "Select ▸"
 * submenu (Identical / Material / Invert). Pure-function tests over a
 * hand-built universe map — no RVViewer, no GLB.
 *
 * The geometrySignature tests pin down the exact invariances the Identical
 * matcher promises: baked rigid transforms, vertex ORDER, float noise, and
 * extra attributes (uber-bake clones) must NOT break a match; different
 * sizes/shapes and different tessellation density MUST break it. When a
 * real-world copy is still missed with these green, the cause is a genuine
 * tessellation difference (vertex/index counts differ), not the matcher.
 */

import { describe, it, expect } from 'vitest';
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
} from 'three';
import {
  expandToUniverseMeshes,
  computeIdenticalPaths,
  computeSameMaterialPaths,
  computeInvertPaths,
  resolveSeedPaths,
  geometrySignature,
  signaturesMatch,
} from '../src/plugins/asset-editor/select-actions';

// Universe: two boxes SHARING one geometry (loader-dedup situation) with
// different materials, one sphere. Red1/Red2 are distinct Material objects
// with identical appearance (equal fingerprints); blue differs.
function makeUniverse() {
  const boxGeo = new BoxGeometry(1, 1, 1);
  const sphereGeo = new SphereGeometry(0.5);
  const red1 = new MeshStandardMaterial({ color: 0xff0000 });
  const red2 = new MeshStandardMaterial({ color: 0xff0000 });
  const blue = new MeshStandardMaterial({ color: 0x0000ff });
  const universe = new Map<string, Mesh>([
    ['A/box1', new Mesh(boxGeo, red1)],
    ['A/box2', new Mesh(boxGeo, blue)],
    ['B/sphere', new Mesh(sphereGeo, red2)],
  ]);
  return { universe, red1, red2, blue };
}

/** Same triangles, DIFFERENT vertex order: non-indexed with the triangle
 *  sequence reversed — simulates a tessellator emitting faces in another
 *  order for a second occurrence of the same part. */
function reorderedCopy(src: BufferGeometry): BufferGeometry {
  const flat = src.toNonIndexed();
  const pos = flat.attributes.position as BufferAttribute;
  const arr = pos.array as Float32Array;
  const out = new Float32Array(arr.length);
  const triFloats = 9; // 3 vertices x xyz
  const triCount = arr.length / triFloats;
  for (let t = 0; t < triCount; t++) {
    out.set(arr.subarray(t * triFloats, (t + 1) * triFloats), (triCount - 1 - t) * triFloats);
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(out, 3));
  return geo;
}

/** Copy with every coordinate perturbed by deterministic small noise —
 *  simulates float drift between independent tessellations. */
function noisyCopy(src: BufferGeometry): BufferGeometry {
  const geo = src.clone();
  const pos = geo.attributes.position as BufferAttribute;
  const arr = (pos.array as Float32Array).slice();
  for (let i = 0; i < arr.length; i++) arr[i] += ((i % 3) - 1) * 1e-6;
  geo.setAttribute('position', new BufferAttribute(arr, 3));
  return geo;
}

describe('expandToUniverseMeshes', () => {
  it('expands a group path to its descendant universe meshes', () => {
    const { universe } = makeUniverse();
    expect([...expandToUniverseMeshes(universe, ['A'])].sort())
      .toEqual(['A/box1', 'A/box2']);
  });

  it('keeps a leaf mesh path as itself', () => {
    const { universe } = makeUniverse();
    expect([...expandToUniverseMeshes(universe, ['B/sphere'])])
      .toEqual(['B/sphere']);
  });

  it('does not match a sibling whose name merely starts with the prefix', () => {
    const { universe } = makeUniverse();
    universe.set('AB/box3', universe.get('A/box1')!);
    expect(expandToUniverseMeshes(universe, ['A']).has('AB/box3')).toBe(false);
  });

  it('returns empty for empty input', () => {
    const { universe } = makeUniverse();
    expect(expandToUniverseMeshes(universe, []).size).toBe(0);
  });
});

describe('geometrySignature invariances', () => {
  it('matches two independently created geometries of the same shape', () => {
    const a = geometrySignature(new BoxGeometry(1, 1, 1));
    const b = geometrySignature(new BoxGeometry(1, 1, 1));
    expect(signaturesMatch(a, b)).toBe(true);
  });

  it('is invariant under baked translation, rotation and mirror', () => {
    const a = geometrySignature(new BoxGeometry(1, 2, 3));
    const rigid = new BoxGeometry(1, 2, 3)
      .applyMatrix4(new Matrix4().makeRotationY(0.7))
      .applyMatrix4(new Matrix4().makeTranslation(5, -2, 9));
    const mirrored = new BoxGeometry(1, 2, 3)
      .applyMatrix4(new Matrix4().makeScale(-1, 1, 1));
    expect(signaturesMatch(a, geometrySignature(rigid))).toBe(true);
    expect(signaturesMatch(a, geometrySignature(mirrored))).toBe(true);
  });

  it('is invariant under vertex ORDER (tessellator emits faces differently)', () => {
    const src = new BoxGeometry(1, 2, 3);
    const a = geometrySignature(src.toNonIndexed());
    const b = geometrySignature(reorderedCopy(src));
    expect(signaturesMatch(a, b)).toBe(true);
  });

  it('tolerates float noise between independent tessellations', () => {
    const src = new SphereGeometry(0.5, 16, 12);
    const a = geometrySignature(src);
    const b = geometrySignature(noisyCopy(src));
    expect(signaturesMatch(a, b)).toBe(true);
  });

  it('ignores extra attributes (uber-bake clone with baked color/rmPacked)', () => {
    const src = new BoxGeometry(1, 1, 1);
    const clone = src.clone();
    const vCount = (clone.attributes.position as BufferAttribute).count;
    clone.setAttribute('color', new BufferAttribute(new Uint8Array(vCount * 3), 3, true));
    clone.setAttribute('rmPacked', new BufferAttribute(new Uint8Array(vCount * 2), 2, true));
    expect(signaturesMatch(geometrySignature(src), geometrySignature(clone))).toBe(true);
  });

  it('distinguishes different sizes beyond tolerance', () => {
    const a = geometrySignature(new BoxGeometry(1, 1, 1));
    const b = geometrySignature(new BoxGeometry(1, 1, 1.01)); // 10 mm longer
    expect(signaturesMatch(a, b)).toBe(false);
  });

  it('distinguishes different shapes and different tessellation density', () => {
    const box = geometrySignature(new BoxGeometry(1, 1, 1));
    const sphere = geometrySignature(new SphereGeometry(0.5));
    const sphereCoarse = geometrySignature(new SphereGeometry(0.5, 8, 6));
    const sphereFine = geometrySignature(new SphereGeometry(0.5, 32, 24));
    expect(signaturesMatch(box, sphere)).toBe(false);
    // Different segment counts = different vertex counts = intentionally NOT
    // identical — this is the "genuine tessellation difference" case.
    expect(signaturesMatch(sphereCoarse, sphereFine)).toBe(false);
  });
});

describe('computeIdenticalPaths', () => {
  it('selects every mesh sharing the seed geometry, ignoring material', () => {
    const { universe } = makeUniverse();
    expect(computeIdenticalPaths(universe, new Set(['A/box1'])).sort())
      .toEqual(['A/box1', 'A/box2']);
  });

  it('finds copies that do NOT share a geometry reference (CAD-import case)', () => {
    const { universe, red1 } = makeUniverse();
    universe.set('C/box3', new Mesh(new BoxGeometry(1, 1, 1), red1));
    expect(computeIdenticalPaths(universe, new Set(['A/box1'])).sort())
      .toEqual(['A/box1', 'A/box2', 'C/box3']);
  });

  it('unions shapes over multiple seeds', () => {
    const { universe } = makeUniverse();
    expect(computeIdenticalPaths(universe, new Set(['A/box1', 'B/sphere'])).sort())
      .toEqual(['A/box1', 'A/box2', 'B/sphere']);
  });

  it('returns empty for empty seeds', () => {
    const { universe } = makeUniverse();
    expect(computeIdenticalPaths(universe, new Set())).toEqual([]);
  });
});

describe('computeSameMaterialPaths', () => {
  it('matches equal-appearance materials by fingerprint, not just by reference', () => {
    const { universe } = makeUniverse();
    // Seed red1 (A/box1) must also catch red2 (B/sphere) — distinct objects,
    // identical appearance — but not blue (A/box2).
    expect(computeSameMaterialPaths(universe, new Set(['A/box1'])).sort())
      .toEqual(['A/box1', 'B/sphere']);
  });

  it('matches any slot of a multi-material mesh', () => {
    const { universe, red1, blue } = makeUniverse();
    const geo = new BoxGeometry(2, 2, 2);
    universe.set('C/multi', new Mesh(geo, [blue, red1]));
    expect(computeSameMaterialPaths(universe, new Set(['A/box1'])).sort())
      .toEqual(['A/box1', 'B/sphere', 'C/multi']);
  });
});

describe('computeInvertPaths', () => {
  it('returns the complement of the selection, expanding group paths', () => {
    const { universe } = makeUniverse();
    expect(computeInvertPaths(universe, ['A'])).toEqual(['B/sphere']);
  });

  it('with nothing selected returns everything (Select All)', () => {
    const { universe } = makeUniverse();
    expect(computeInvertPaths(universe, []).sort())
      .toEqual(['A/box1', 'A/box2', 'B/sphere']);
  });

  it('with everything selected returns empty', () => {
    const { universe } = makeUniverse();
    expect(computeInvertPaths(universe, ['A', 'B/sphere'])).toEqual([]);
  });
});

describe('resolveSeedPaths', () => {
  it('uses the whole selection when the clicked node is part of it', () => {
    expect(resolveSeedPaths(['A/box1', 'B/sphere'], 'A/box1'))
      .toEqual(['A/box1', 'B/sphere']);
  });

  it('uses only the clicked node when it is outside the selection', () => {
    expect(resolveSeedPaths(['A/box1'], 'A/box2')).toEqual(['A/box2']);
  });
});
