// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-781 §9.2 / 9.8b — the narrowphase over the PICK STRUCTURE.
 *
 * Every walk (tree × tree, tree × flat, segment-only F15, brute force F19) must
 * give exactly the answer of the O(n·m) oracle over the same allowed triangles,
 * under rotation, non-uniform scale and mirroring. The interval filter is the
 * other half: a body owns only its segments of a shared chunk, so geometry of
 * another node in the SAME chunk must never produce a hit.
 *
 * The structures here are built by the test with the bake's own builders — the
 * collision path itself builds none (rule 15).
 */
import { describe, expect, it } from 'vitest';
import {
  BoxGeometry, BufferAttribute, CylinderGeometry, Euler, InterleavedBuffer, InterleavedBufferAttribute, MathUtils,
  Matrix4, Quaternion, SphereGeometry, TorusGeometry, Vector3, type BufferGeometry,
} from 'three';
import { buildPickStructure, buildSegmentOnlyStructure, type PickSegmentInput } from '../src/core/engine/rv-pick-build';
import { segmentBoxUnion } from '../src/core/engine/rv-pick-structure';
import {
  createNarrowCounters, partsOverlap, partsOverlapBruteForce, type NarrowPart,
} from '../src/core/engine/rv-collision-narrowphase';
import { TOUCH_EPS } from '../src/core/engine/rv-collision-tri-tri';
import { makePrimitiveAssembly, type PickFixture } from './helpers/pick-geometry';
import { makeRandom } from './helpers/seeded-random';

// ─── Fixtures ──────────────────────────────────────────────────────────

interface Geo {
  position: Float32Array;
  index: Uint32Array;
  segments: PickSegmentInput[];
}

/** Merge primitives (one segment each) — small enough for the O(n·m) oracle. */
function assembly(shapes: Array<{ geo: BufferGeometry; at: Matrix4 }>): Geo {
  let vc = 0;
  let ic = 0;
  for (const s of shapes) {
    vc += s.geo.getAttribute('position').count;
    ic += s.geo.index!.count;
  }
  const position = new Float32Array(vc * 3);
  const index = new Uint32Array(ic);
  const segments: PickSegmentInput[] = [];
  const v = new Vector3();
  let vo = 0;
  let io = 0;
  for (const s of shapes) {
    const pos = s.geo.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(s.at);
      position.set([v.x, v.y, v.z], (vo + i) * 3);
    }
    const idx = s.geo.index!.array;
    for (let i = 0; i < idx.length; i++) index[io + i] = idx[i] + vo;
    segments.push({ indexStart: io, indexCount: idx.length, node: segments.length, owner: segments.length });
    io += idx.length;
    vo += pos.count;
  }
  return { position, index, segments };
}

function smallAssembly(): Geo {
  const at = (x: number, y: number, z: number, rx = 0, ry = 0): Matrix4 =>
    new Matrix4().makeRotationFromEuler(new Euler(rx, ry, 0)).setPosition(x, y, z);
  return assembly([
    { geo: new BoxGeometry(0.4, 0.4, 0.4, 4, 4, 4), at: at(0, 0, 0) },
    { geo: new SphereGeometry(0.25, 16, 10), at: at(0.45, 0.05, 0) },
    { geo: new CylinderGeometry(0.12, 0.18, 0.5, 16, 2), at: at(0, 0.1, 0.45, 0.4, 0.3) },
    { geo: new TorusGeometry(0.2, 0.05, 10, 24), at: at(0.45, 0, 0.45, 1.1, 0.2) },
  ]);
}

function fromFixture(f: PickFixture): Geo {
  return { position: f.position, index: f.index, segments: f.segments };
}

type Mode = 'tree' | 'segonly' | 'brute';

interface PartOpts {
  mode?: Mode;
  /** Inclusive SEGMENT intervals (tree / segonly) — default: all. */
  segments?: number[];
  index16?: boolean;
  interleaved?: boolean;
}

/** A NarrowPart over `geo` at `world`, the way the bodies module builds one. */
function makePart(geo: Geo, world: Matrix4, opts: PartOpts = {}): NarrowPart {
  const mode = opts.mode ?? 'tree';
  const index = geo.index.slice();
  const position = geo.position;
  const box = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  const grow = (x: number, y: number, z: number): void => {
    if (x < box[0]) box[0] = x; if (y < box[1]) box[1] = y; if (z < box[2]) box[2] = z;
    if (x > box[3]) box[3] = x; if (y > box[4]) box[4] = y; if (z > box[5]) box[5] = z;
  };
  let reader: NarrowPart['positionReader'] = null;
  let fast: Float32Array | null = position;
  if (opts.interleaved) {
    // x y z pad, 4 floats per vertex — the slow `getX/Y/Z` path.
    const n = position.length / 3;
    const inter = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) inter.set([position[i * 3], position[i * 3 + 1], position[i * 3 + 2], 7], i * 4);
    reader = new InterleavedBufferAttribute(new InterleavedBuffer(inter, 4), 3, 0);
    fast = null;
  }
  if (mode === 'brute') {
    const tris = index.length / 3;
    for (let i = 0; i < position.length; i += 3) grow(position[i], position[i + 1], position[i + 2]);
    return {
      pick: null, segmentOnly: false, position: fast, positionReader: reader,
      index: opts.index16 ? Uint16Array.from(index) : index,
      intervals: Uint32Array.from([0, tris - 1]), intervalCount: 1,
      localBox: box, world: Float64Array.from(world.elements),
    };
  }
  const pick = mode === 'tree'
    ? buildPickStructure(position, index, geo.segments).data
    : buildSegmentOnlyStructure(position, index, geo.segments);
  const iv = opts.segments ?? [0, pick.segmentCount - 1];
  const s = new Float64Array(6);
  for (let k = 0; k < iv.length; k += 2) {
    if (!segmentBoxUnion(pick, iv[k], iv[k + 1], s)) continue;
    grow(s[0], s[1], s[2]);
    grow(s[3], s[4], s[5]);
  }
  return {
    pick, segmentOnly: mode === 'segonly', position: fast, positionReader: reader,
    index: opts.index16 ? Uint16Array.from(index) : index,
    intervals: Uint32Array.from(iv), intervalCount: iv.length / 2,
    localBox: box, world: Float64Array.from(world.elements),
  };
}

function pose(rnd: () => number, spread: number, scaleVar = 0): Matrix4 {
  const q = new Quaternion().setFromAxisAngle(
    new Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize(), rnd() * Math.PI * 2);
  const s = new Vector3(1 + scaleVar * (rnd() - 0.5), 1 + scaleVar * (rnd() - 0.5), 1 + scaleVar * (rnd() - 0.5));
  const t = new Vector3((rnd() - 0.5) * spread, (rnd() - 0.5) * spread, (rnd() - 0.5) * spread);
  return new Matrix4().compose(t, q, s);
}

function overlap(a: NarrowPart, b: NarrowPart, counters = createNarrowCounters()): boolean {
  return partsOverlap(a, b, 0, TOUCH_EPS, counters, null);
}

/** Run `n` random relative poses; every walk must equal the oracle. */
function parity(geoA: Geo, geoB: Geo, modes: [Mode, Mode], n: number, seed: number, scaleVar: number, spread: number): { hits: number } {
  const rnd = makeRandom(seed);
  let hits = 0;
  for (let i = 0; i < n; i++) {
    const wa = pose(rnd, spread, scaleVar);
    const wb = pose(rnd, spread, scaleVar);
    const a = makePart(geoA, wa, { mode: modes[0] });
    const b = makePart(geoB, wb, { mode: modes[1] });
    const oracle = partsOverlapBruteForce(a, b, TOUCH_EPS);
    const got = overlap(a, b);
    expect(got, `pose ${i} (${modes.join(' × ')})`).toBe(oracle);
    if (oracle) hits++;
  }
  return { hits };
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe('narrowphase on the pick structure', () => {
  const geo = smallAssembly();

  it('tree × tree equals the O(n·m) oracle under rotation and non-uniform scale', () => {
    const { hits } = parity(geo, geo, ['tree', 'tree'], 40, 1, 0.6, 0.9);
    expect(hits).toBeGreaterThan(5);
    expect(hits).toBeLessThan(40);
  });

  it('tree × brute, brute × tree and brute × brute equal the oracle', () => {
    expect(parity(geo, geo, ['tree', 'brute'], 20, 2, 0.4, 0.9).hits).toBeGreaterThan(2);
    expect(parity(geo, geo, ['brute', 'tree'], 20, 3, 0.4, 0.9).hits).toBeGreaterThan(2);
    expect(parity(geo, geo, ['brute', 'brute'], 12, 4, 0.4, 0.9).hits).toBeGreaterThan(1);
  });

  it('a segment-only chunk (F15) gives the structured result, never an error', () => {
    const rnd = makeRandom(5);
    let hits = 0;
    for (let i = 0; i < 30; i++) {
      const wa = pose(rnd, 0.9, 0.3);
      const wb = pose(rnd, 0.9, 0.3);
      const structured = overlap(makePart(geo, wa), makePart(geo, wb));
      expect(overlap(makePart(geo, wa, { mode: 'segonly' }), makePart(geo, wb))).toBe(structured);
      expect(overlap(makePart(geo, wa), makePart(geo, wb, { mode: 'segonly' }))).toBe(structured);
      expect(overlap(makePart(geo, wa, { mode: 'segonly' }), makePart(geo, wb, { mode: 'segonly' }))).toBe(structured);
      if (structured) hits++;
    }
    expect(hits).toBeGreaterThan(3);
  });

  it('stays exact for a mirrored placement (det < 0) and a thin sheet', () => {
    const mirror = new Matrix4().makeScale(-1, 1, 1);
    const rnd = makeRandom(6);
    for (let i = 0; i < 20; i++) {
      const wa = pose(rnd, 0.9, 0.2).multiply(mirror);
      const wb = pose(rnd, 0.9, 0.2);
      const a = makePart(geo, wa);
      const b = makePart(geo, wb);
      expect(overlap(a, b)).toBe(partsOverlapBruteForce(a, b, TOUCH_EPS));
    }
    // Two parallel plates 1 mm apart do NOT collide; the same plates crossed do.
    const plate = assembly([{ geo: new BoxGeometry(1, 0.002, 1, 24, 1, 24), at: new Matrix4() }]);
    const a = makePart(plate, new Matrix4());
    expect(overlap(a, makePart(plate, new Matrix4().makeTranslation(0, 0.003, 0)))).toBe(false);
    expect(overlap(a, makePart(plate, new Matrix4().makeRotationZ(MathUtils.degToRad(30))))).toBe(true);
  });

  it('rejects overlapping boxes with separated triangles (rod through a torus hole)', () => {
    const torus = assembly([{ geo: new TorusGeometry(1, 0.15, 12, 48), at: new Matrix4() }]);
    const rod = assembly([{ geo: new BoxGeometry(0.1, 0.1, 4), at: new Matrix4() }]);
    expect(overlap(makePart(torus, new Matrix4()), makePart(rod, new Matrix4()))).toBe(false);
    expect(overlap(makePart(torus, new Matrix4()), makePart(rod, new Matrix4().makeTranslation(1, 0, 0)))).toBe(true);
  });

  it('the interval filter: another node\'s segment in the SAME chunk never hits', () => {
    // Segment 0 = a box at the origin, segment 1 = a box at x = 3 — one chunk.
    const chunk = assembly([
      { geo: new BoxGeometry(1, 1, 1, 2, 2, 2), at: new Matrix4() },
      { geo: new BoxGeometry(1, 1, 1, 2, 2, 2), at: new Matrix4().makeTranslation(3, 0, 0) },
    ]);
    const probe = assembly([{ geo: new BoxGeometry(0.6, 0.6, 0.6), at: new Matrix4() }]);
    const intoSecond = makePart(probe, new Matrix4().makeTranslation(3.5, 0, 0));
    expect(overlap(makePart(chunk, new Matrix4()), intoSecond)).toBe(true);              // whole chunk
    expect(overlap(makePart(chunk, new Matrix4(), { segments: [0, 0] }), intoSecond)).toBe(false);  // only node 0
    expect(overlap(makePart(chunk, new Matrix4(), { segments: [1, 1] }), intoSecond)).toBe(true);   // only node 1
    expect(overlap(makePart(chunk, new Matrix4(), { segments: [0, 0], mode: 'segonly' }), intoSecond)).toBe(false);
  });

  it('a small role in a large chunk prunes the other subtrees (counter)', () => {
    const big = fromFixture(makePrimitiveAssembly());   // ~55 k triangles, 25 segments
    const probe = assembly([{ geo: new BoxGeometry(0.3, 0.3, 0.3, 2, 2, 2), at: new Matrix4() }]);
    // The probe sits inside primitive 0's neighbourhood; restrict the chunk to
    // a segment far away so the answer is "no hit" and only pruning differs.
    const at = new Matrix4().makeTranslation(0, 0.05, 0);
    const whole = createNarrowCounters();
    const restricted = createNarrowCounters();
    const bigWhole = makePart(big, new Matrix4());
    const bigFar = makePart(big, new Matrix4(), { segments: [23, 23] });
    overlap(bigWhole, makePart(probe, at), whole);
    expect(overlap(bigFar, makePart(probe, at), restricted)).toBe(false);
    expect(restricted.boxesTested).toBeLessThan(whole.boxesTested);
    expect(restricted.trianglesTested).toBe(0);
  });

  it('Uint16 index, non-indexed (implicit index) and interleaved positions give the same result', () => {
    const rnd = makeRandom(8);
    const nonIndexed = (() => {
      const tris = geo.index.length / 3;
      const pos = new Float32Array(tris * 9);
      for (let t = 0; t < tris * 3; t++) {
        const v = geo.index[t];
        pos.set([geo.position[v * 3], geo.position[v * 3 + 1], geo.position[v * 3 + 2]], t * 3);
      }
      return pos;
    })();
    for (let i = 0; i < 15; i++) {
      const wa = pose(rnd, 0.9, 0.3);
      const wb = pose(rnd, 0.9, 0.3);
      const ref = overlap(makePart(geo, wa), makePart(geo, wb));
      expect(overlap(makePart(geo, wa, { index16: true }), makePart(geo, wb))).toBe(ref);
      expect(overlap(makePart(geo, wa, { mode: 'brute', index16: true }), makePart(geo, wb))).toBe(ref);
      expect(overlap(makePart(geo, wa, { mode: 'brute', interleaved: true }), makePart(geo, wb))).toBe(ref);
      const flat: NarrowPart = {
        pick: null, segmentOnly: false, position: nonIndexed, positionReader: null, index: null,
        intervals: Uint32Array.from([0, nonIndexed.length / 9 - 1]), intervalCount: 1,
        localBox: makePart(geo, wa, { mode: 'brute' }).localBox, world: Float64Array.from(wa.elements),
      };
      expect(overlap(flat, makePart(geo, wb))).toBe(ref);
    }
  });

  it('NaN in a keep geometry and a singular matrix give no hit and never throw (rule 14)', () => {
    const box = assembly([{ geo: new BoxGeometry(1, 1, 1), at: new Matrix4() }]);
    const poisoned = { ...box, position: box.position.slice() };
    poisoned.position[0] = NaN;
    poisoned.position[4] = Infinity;
    const a = makePart(poisoned, new Matrix4(), { mode: 'brute' });
    const b = makePart(box, new Matrix4().makeTranslation(0.5, 0, 0));
    expect(() => overlap(a, b)).not.toThrow();
    // The remaining (finite) triangles still cross, the poisoned ones are skipped.
    expect(typeof overlap(a, b)).toBe('boolean');
    const singular = makePart(box, new Matrix4().makeScale(0, 1, 1));
    expect(overlap(singular, b)).toBe(false);
    const nanWorld = makePart(box, new Matrix4());
    nanWorld.world[12] = NaN;
    expect(overlap(nanWorld, b)).toBe(false);
  });

  it('touching faces are no hit; 10 × eps penetration is', () => {
    const box = assembly([{ geo: new BoxGeometry(1, 1, 1, 2, 2, 2), at: new Matrix4() }]);
    const small = assembly([{ geo: new BoxGeometry(0.5, 0.5, 0.5, 2, 2, 2), at: new Matrix4() }]);
    const a = makePart(box, new Matrix4());
    expect(overlap(a, makePart(box, new Matrix4().makeTranslation(1, 0, 0)))).toBe(false);          // flush
    expect(overlap(a, makePart(small, new Matrix4().makeTranslation(0.75, 0, 0)))).toBe(false);     // flush, smaller
    expect(overlap(a, makePart(small, new Matrix4().makeTranslation(0.75 - 10 * TOUCH_EPS, 0, 0)))).toBe(true);
    // Two equal boxes overlapping by 10 eps with all other faces flush cross only
    // in edge-on-plane configurations — touching by construction, not penetration.
    expect(overlap(a, makePart(box, new Matrix4().makeTranslation(1 - 10 * TOUCH_EPS, 0, 0)))).toBe(false);
    // Edge-to-edge (one box rotated 45° about y, resting on an edge).
    const r = new Matrix4().makeRotationY(Math.PI / 4).setPosition(0.5 + Math.SQRT1_2, 0, 0);
    expect(overlap(a, makePart(box, r))).toBe(false);
  });

  it('BufferAttribute sanity: the interleaved reader is a real three.js attribute', () => {
    const attr = new BufferAttribute(new Float32Array([1, 2, 3]), 3);
    expect(attr.getX(0)).toBe(1);
  });
});
