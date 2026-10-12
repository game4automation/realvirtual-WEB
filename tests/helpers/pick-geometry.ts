// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Synthetic geometry and ray fixtures for the plan-756 pick-structure suites.
 *
 * Everything here is generated from three.js primitives and closed-form
 * surfaces — NO GLB is fetched. The pick structure is a pure function over
 * `(position, index, segments)`, so a real model adds load time and a private
 * asset dependency without adding a single new code path. The shapes below are
 * chosen for the cases that actually break a traversal: shared edges and
 * vertices (merged primitives), near-coplanar thin skins, zero-area and needle
 * triangles, duplicates, mirrored winding, and one metre-sized part with
 * sub-millimetre features (the Morton quantisation case).
 */

import { BoxGeometry, CylinderGeometry, Matrix4, SphereGeometry, TorusGeometry, Vector3, type BufferGeometry } from 'three';
import type { PickSegmentInput } from '../../src/core/engine/rv-pick-build';
import { makeRandom } from './seeded-random';

export interface PickFixture {
  label: string;
  position: Float32Array;
  index: Uint32Array;
  segments: PickSegmentInput[];
  triangles: number;
  bounds: { min: [number, number, number]; max: [number, number, number] };
}

function boundsOf(position: Float32Array): PickFixture['bounds'] {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < position.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = position[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

interface Part {
  geometry: BufferGeometry;
  matrix: Matrix4;
}

/** Merge parts into world space, one SEGMENT per part. */
function mergeParts(label: string, parts: Part[]): PickFixture {
  let vertexCount = 0;
  let indexCount = 0;
  for (const part of parts) {
    const pos = part.geometry.getAttribute('position');
    vertexCount += pos.count;
    indexCount += part.geometry.index ? part.geometry.index.count : pos.count;
  }
  const position = new Float32Array(vertexCount * 3);
  const index = new Uint32Array(indexCount);
  const segments: PickSegmentInput[] = [];
  const v = new Vector3();
  let vo = 0;
  let io = 0;
  for (const part of parts) {
    const pos = part.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(part.matrix);
      position[3 * (vo + i)] = v.x;
      position[3 * (vo + i) + 1] = v.y;
      position[3 * (vo + i) + 2] = v.z;
    }
    const idx = part.geometry.index;
    const count = idx ? idx.count : pos.count;
    const usable = count - (count % 3);
    if (idx) {
      const arr = idx.array;
      for (let i = 0; i < usable; i++) index[io + i] = arr[i] + vo;
    } else {
      for (let i = 0; i < usable; i++) index[io + i] = vo + i;
    }
    segments.push({ indexStart: io, indexCount: usable, node: segments.length, owner: segments.length % 3 === 2 ? -1 : segments.length });
    io += usable;
    vo += pos.count;
  }
  const used = io === index.length ? index : index.slice(0, io);
  return { label, position, index: used, segments, triangles: used.length / 3, bounds: boundsOf(position) };
}

/**
 * A grid of overlapping primitives: many segments, most of them larger than one
 * cluster, plenty of shared edges and coincident surfaces where two primitives
 * touch. ~55 k triangles.
 */
export function makePrimitiveAssembly(): PickFixture {
  const parts: Part[] = [];
  const random = makeRandom(7561);
  const shapes: BufferGeometry[] = [
    new BoxGeometry(0.4, 0.4, 0.4, 6, 6, 6),
    new SphereGeometry(0.25, 24, 18),
    new CylinderGeometry(0.15, 0.2, 0.5, 24, 4),
    new TorusGeometry(0.2, 0.06, 16, 32),
  ];
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 6; i++) {
      const shape = shapes[(i + j) % shapes.length];
      const matrix = new Matrix4()
        .makeRotationY(random() * Math.PI)
        .premultiply(new Matrix4().makeRotationX(random() * Math.PI))
        .setPosition(i * 0.45, 0.1 * random(), j * 0.45);
      parts.push({ geometry: shape, matrix });
    }
  }
  // A deliberately tiny part (< CLUSTER_TRIS): exercises the skip-sort path.
  parts.push({ geometry: new BoxGeometry(0.05, 0.05, 0.05), matrix: new Matrix4().setPosition(0.2, 0.5, 0.2) });
  const fixture = mergeParts('primitive assembly (24 overlapping primitives + 1 tiny box)', parts);
  for (const shape of shapes) shape.dispose();
  return fixture;
}

/**
 * Two highly tessellated curved skins 0.5 mm apart on a 1 m radius — the
 * worst case for loose cluster boxes (plan risk R3), and the reason the suite
 * asserts a bound on `trianglesTested / ray`.
 */
export function makeThinSheet(nu = 220, nv = 170): PickFixture {
  const radius = 1;
  const gap = 0.0005;
  const length = 2;
  const skinVertices = (nu + 1) * (nv + 1);
  const position = new Float32Array(2 * skinVertices * 3);
  const index = new Uint32Array(2 * nu * nv * 6);
  let io = 0;
  for (let skin = 0; skin < 2; skin++) {
    const r = radius + skin * gap;
    const base = skin * skinVertices;
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const a = (Math.PI * i) / nu;
        const o = 3 * (base + j * (nu + 1) + i);
        position[o] = r * Math.cos(a);
        position[o + 1] = r * Math.sin(a);
        position[o + 2] = (length * j) / nv;
      }
    }
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const a = base + j * (nu + 1) + i;
        const b = a + 1;
        const c = a + nu + 1;
        const d = c + 1;
        index[io++] = a; index[io++] = b; index[io++] = d;
        index[io++] = a; index[io++] = d; index[io++] = c;
      }
    }
  }
  const half = index.length / 2;
  return {
    label: `thin curved sheet (2 skins 0.5 mm apart, ${2 * nu * nv * 2} tris)`,
    position,
    index,
    segments: [
      { indexStart: 0, indexCount: half, node: 0, owner: 0 },
      { indexStart: half, indexCount: half, node: 1, owner: -1 },
    ],
    triangles: index.length / 3,
    bounds: boundsOf(position),
  };
}

/**
 * Degenerate corpus: exact-zero-area triangles, needles with a 1e-7 aspect,
 * exact duplicates, and a handful of well-formed triangles to hit.
 */
export function makeDegenerateCorpus(): PickFixture {
  const random = makeRandom(7562);
  const positions: number[] = [];
  const indices: number[] = [];
  const push = (x: number, y: number, z: number): number => {
    positions.push(x, y, z);
    return positions.length / 3 - 1;
  };
  const tri = (a: number, b: number, c: number): void => {
    indices.push(a, b, c);
  };
  for (let k = 0; k < 120; k++) {
    const x = random() * 2 - 1;
    const y = random() * 2 - 1;
    const z = random() * 2 - 1;
    // well-formed
    const a = push(x, y, z);
    const b = push(x + 0.08, y, z + 0.02);
    const c = push(x + 0.03, y + 0.07, z);
    tri(a, b, c);
    // exact duplicate of the same triangle
    tri(a, b, c);
    // zero area: two coincident corners
    tri(a, b, b);
    // zero area: collinear
    const d = push(x, y + 0.05, z);
    const e = push(x, y + 0.1, z);
    tri(a, d, e);
    // needle: 1e-7 wide, 0.1 long
    const f = push(x + 1e-7, y, z);
    const g = push(x, y + 0.1, z + 1e-7);
    tri(a, f, g);
  }
  const position = new Float32Array(positions);
  const index = new Uint32Array(indices);
  return {
    label: 'degenerate corpus (zero-area, collinear, needles, duplicates)',
    position,
    index,
    segments: [{ indexStart: 0, indexCount: index.length, node: 0, owner: 0 }],
    triangles: index.length / 3,
    bounds: boundsOf(position),
  };
}

/**
 * The Morton-quantisation case of plan §2.4a.3 / P4: a METRE-sized part whose
 * geometry consists only of SUB-MILLIMETRE detail — `dense` 10 µm triangles
 * distributed over four 2 mm detail cubes that sit 1 m apart.
 *
 * A 30-bit grid over the 1 m box has ~1 mm cells, so every detail cube
 * collapses into a handful of codes and the sort inside it degenerates; the
 * 60-bit grid has ~1 µm cells and resolves it. One single segment, so a
 * large-enough `dense` takes the wide path in `'auto'` mode.
 */
export function makeMicroFeatureBlock(dense = 100_000): PickFixture {
  const random = makeRandom(7563);
  const span = 1.0;
  const cube = 0.002;
  const feature = 0.00001;
  const centres: Array<[number, number, number]> = [
    [0, 0, 0],
    [span, 0, 0],
    [0, span, span],
    [span, span, 0],
  ];
  const positions = new Float32Array(dense * 9);
  const index = new Uint32Array(dense * 3);
  let o = 0;
  for (let t = 0; t < dense; t++) {
    const centre = centres[t % centres.length];
    const cx = centre[0] + (random() - 0.5) * cube;
    const cy = centre[1] + (random() - 0.5) * cube;
    const cz = centre[2] + (random() - 0.5) * cube;
    positions.set(
      [cx, cy, cz, cx + feature, cy, cz + 0.5 * feature, cx + 0.5 * feature, cy + feature, cz],
      o,
    );
    o += 9;
  }
  for (let i = 0; i < index.length; i++) index[i] = i;
  return {
    label: `micro-feature part (1 m span, ${dense} × 10 µm triangles in four 2 mm cubes)`,
    position: positions,
    index,
    segments: [{ indexStart: 0, indexCount: index.length, node: 0, owner: 0 }],
    triangles: index.length / 3,
    bounds: boundsOf(positions),
  };
}

/** ~1 M triangles in ONE segment: the wide code path and the timing fixture. */
export function makeMillionTriangleFixture(): PickFixture {
  const sphere = new SphereGeometry(1, 800, 640);
  const fixture = mergeParts('sphere, 800 × 640 segments (~1 M tris, one segment)', [
    { geometry: sphere, matrix: new Matrix4() },
  ]);
  sphere.dispose();
  fixture.segments = [{ indexStart: 0, indexCount: fixture.index.length, node: 0, owner: 0 }];
  return { ...fixture, label: 'sphere 800 × 640 (~1 M tris, one segment)' };
}

/** Mirror along X — a negative-determinant instance in the bake. */
export function mirrorFixture(source: PickFixture): PickFixture {
  const position = source.position.slice();
  for (let i = 0; i < position.length; i += 3) position[i] = -position[i];
  return {
    label: `${source.label} [mirrored on X]`,
    position,
    index: source.index.slice(),
    segments: source.segments.map((s) => ({ ...s })),
    triangles: source.triangles,
    bounds: boundsOf(position),
  };
}

/** Reverse every triangle's winding — the geometric twin of a winding flip. */
export function reverseWinding(source: PickFixture): PickFixture {
  const index = source.index.slice();
  for (let i = 0; i < index.length; i += 3) {
    const t = index[i + 1];
    index[i + 1] = index[i + 2];
    index[i + 2] = t;
  }
  return {
    label: `${source.label} [reversed winding]`,
    position: source.position.slice(),
    index,
    segments: source.segments.map((s) => ({ ...s })),
    triangles: source.triangles,
    bounds: { min: [...source.bounds.min], max: [...source.bounds.max] },
  };
}

// ─── Ray sets ───────────────────────────────────────────────────────

/** Rays from a sphere around the fixture towards a random point inside it. */
export function randomRays(fixture: PickFixture, count: number, seed: number): Float64Array {
  const random = makeRandom(seed);
  const { min, max } = fixture.bounds;
  const cx = (min[0] + max[0]) / 2;
  const cy = (min[1] + max[1]) / 2;
  const cz = (min[2] + max[2]) / 2;
  const radius = 0.75 * Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const out = new Float64Array(count * 6);
  for (let i = 0; i < count; i++) {
    const z = 2 * random() - 1;
    const phi = 2 * Math.PI * random();
    const s = Math.sqrt(1 - z * z);
    const ox = cx + radius * s * Math.cos(phi);
    const oy = cy + radius * s * Math.sin(phi);
    const oz = cz + radius * z;
    const tx = min[0] + random() * (max[0] - min[0]);
    const ty = min[1] + random() * (max[1] - min[1]);
    const tz = min[2] + random() * (max[2] - min[2]);
    const l = Math.hypot(tx - ox, ty - oy, tz - oz);
    out.set([ox, oy, oz, (tx - ox) / l, (ty - oy) / l, (tz - oz) / l], i * 6);
  }
  return out;
}

/**
 * Exactly axis-parallel rays launched through an existing vertex: produces
 * `0 · ∞` in two slabs of every box, i.e. the NaN case the slab test must drop.
 */
export function axisParallelRays(fixture: PickFixture, count: number, seed: number): Float64Array {
  const random = makeRandom(seed);
  const out = new Float64Array(count * 6);
  const vertices = fixture.position.length / 3;
  for (let i = 0; i < count; i++) {
    const v = Math.floor(random() * vertices) * 3;
    const axis = i % 3;
    const negative = (i & 8) !== 0;
    const origin = [fixture.position[v], fixture.position[v + 1], fixture.position[v + 2]];
    const direction = [0, 0, 0];
    direction[axis] = negative ? -1 : 1;
    origin[axis] = negative ? fixture.bounds.max[axis] + 1 : fixture.bounds.min[axis] - 1;
    out.set([origin[0], origin[1], origin[2], direction[0], direction[1], direction[2]], i * 6);
  }
  return out;
}

/**
 * Rays aimed exactly at a shared edge midpoint or a vertex of an existing
 * triangle — the watertightness case (a leak shows up as a miss).
 */
export function edgeAndVertexRays(fixture: PickFixture, count: number, seed: number): Float64Array {
  const random = makeRandom(seed);
  const out = new Float64Array(count * 6);
  const index = fixture.index;
  const position = fixture.position;
  const triangles = index.length / 3;
  const { min, max } = fixture.bounds;
  const radius = 0.75 * Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) + 1;
  for (let i = 0; i < count; i++) {
    const t = Math.floor(random() * triangles) * 3;
    const a = index[t] * 3;
    const b = index[t + 1] * 3;
    const c = index[t + 2] * 3;
    let tx: number;
    let ty: number;
    let tz: number;
    if (i % 2 === 0) {
      // edge midpoint
      const p = i % 6 === 0 ? a : i % 6 === 2 ? b : c;
      const q = i % 6 === 0 ? b : i % 6 === 2 ? c : a;
      tx = 0.5 * (position[p] + position[q]);
      ty = 0.5 * (position[p + 1] + position[q + 1]);
      tz = 0.5 * (position[p + 2] + position[q + 2]);
    } else {
      const p = i % 6 === 1 ? a : i % 6 === 3 ? b : c;
      tx = position[p];
      ty = position[p + 1];
      tz = position[p + 2];
    }
    const z = 2 * random() - 1;
    const phi = 2 * Math.PI * random();
    const s = Math.sqrt(1 - z * z);
    const ox = tx + radius * s * Math.cos(phi);
    const oy = ty + radius * s * Math.sin(phi);
    const oz = tz + radius * z;
    const l = Math.hypot(tx - ox, ty - oy, tz - oz);
    out.set([ox, oy, oz, (tx - ox) / l, (ty - oy) / l, (tz - oz) / l], i * 6);
  }
  return out;
}
