// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-453 §9.1 / §9.2 / §9.3 / §9.6 — the PURE structural verbs of
 * rv-path-edit.ts, headless:
 *  - 9.1 splitting is geometry-neutral (lines and arcs in XZ/XY/YZ, clockwise,
 *    negative degrees; length, split point, 64 samples along the arc length);
 *  - 9.2 the sweep changes ONLY `degrees` (clamps at 1° and 360°, sign kept),
 *    including the unwrapped sweep-from-point used by the drag;
 *  - 9.3 removing the last remaining segment is refused;
 *  - 9.6 projection inverts evaluation in every plane, `locateArcLength`, the
 *    ray pick, and `appendSegment` is tangential with inherited dimensions.
 */

import { describe, it, expect } from 'vitest';
import type { PathArcSpec, PathLineSpec, PathSegmentSpec } from '../../src/core/engine/rv-path';
import {
  MAX_SWEEP_DEG,
  MIN_PIECE_M,
  MIN_SWEEP_DEG,
  appendSegment,
  arcPointAt,
  cloneSegmentSpecs,
  derivePathHandles,
  locateArcLength,
  movePathHandle,
  pickSegmentPoint,
  projectToSegment,
  removeEndSegment,
  segmentLength,
  setArcDegrees,
  specListLength,
  splitSegment,
  sweepFromPoint,
  type Vec3Tuple,
} from '../../src/core/engine/rv-path-edit';

const TOL = 1e-9;

const line = (from: Vec3Tuple, to: Vec3Tuple): PathLineSpec => ({ kind: 'line', from, to });
const arc = (o: Partial<PathArcSpec> = {}): PathArcSpec => ({
  kind: 'arc', center: [1, 0.5, -2], radius: 2, startAngle: 30, degrees: 120, ...o,
});

/** Every arc variant the formulas must hold for (plane × turning sense × sign). */
const ARC_VARIANTS: PathArcSpec[] = [];
for (const plane of ['XZ', 'XY', 'YZ'] as const) {
  for (const clockwise of [false, true]) {
    for (const degrees of [120, -75]) ARC_VARIANTS.push(arc({ plane, clockwise, degrees }));
  }
}

/** Point at arc length `s` along a spec list (walks the segments). */
function pointAtS(specs: readonly PathSegmentSpec[], s: number): Vec3Tuple {
  const loc = locateArcLength(specs, s)!;
  const seg = specs[loc.index];
  if (seg.kind === 'line') {
    const a = seg.from as Vec3Tuple;
    const b = seg.to as Vec3Tuple;
    return [a[0] + loc.t01 * (b[0] - a[0]), a[1] + loc.t01 * (b[1] - a[1]), a[2] + loc.t01 * (b[2] - a[2])];
  }
  return arcPointAt(seg, loc.t01);
}

const dist = (a: Vec3Tuple, b: Vec3Tuple): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Direction of travel at the start (`t=0`) or end (`t=1`) of a segment, by finite difference. */
function tangent(spec: PathSegmentSpec, atEnd: boolean): Vec3Tuple {
  const h = 1e-6;
  const p = (t: number): Vec3Tuple => {
    if (spec.kind === 'line') {
      const a = spec.from as Vec3Tuple;
      const b = spec.to as Vec3Tuple;
      return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])];
    }
    return arcPointAt(spec, t);
  };
  const [t0, t1] = atEnd ? [1 - h, 1] : [0, h];
  const a = p(t0);
  const b = p(t1);
  const n = dist(a, b);
  return [(b[0] - a[0]) / n, (b[1] - a[1]) / n, (b[2] - a[2]) / n];
}

// ─── 9.1 ────────────────────────────────────────────────────────────────

describe('9.1 splitting preserves geometry', () => {
  const lineSpecs: PathSegmentSpec[] = [line([0, 0, 0], [5, 0, 0]), line([5, 0, 0], [5, 1, 4])];

  for (const t of [0.1, 0.5, 0.73, 0.999]) {
    it(`a line split at t=${t} keeps length, chain and the split point`, () => {
      const out = splitSegment(lineSpecs, 1, t)!;
      expect(out).not.toBeNull();
      expect(out.length).toBe(3);
      expect(Math.abs(specListLength(out) - specListLength(lineSpecs))).toBeLessThan(TOL);
      const a = out[1] as PathLineSpec;
      const b = out[2] as PathLineSpec;
      expect(a.to).toEqual(b.from);
      expect(a.to).not.toBe(b.from); // own tuple copies
      expect(a.from).toEqual(lineSpecs[1].kind === 'line' ? lineSpecs[1].from : null);
      expect(b.to).toEqual((lineSpecs[1] as PathLineSpec).to);
    });
  }

  for (const spec of ARC_VARIANTS) {
    for (const t of [0.2, 0.5, 0.9]) {
      it(`an arc (${spec.plane}, cw=${spec.clockwise}, deg=${spec.degrees}) split at t=${t} is identical`, () => {
        const before = [line([9, 9, 9], [9, 9, 9.5]), spec];
        const out = splitSegment([spec], 0, t)!;
        expect(out).not.toBeNull();
        expect(out.length).toBe(2);
        const [first, second] = out as PathArcSpec[];
        // clockwise, plane, center, radius copied; sign of degrees kept.
        for (const piece of [first, second]) {
          expect(piece.clockwise).toBe(spec.clockwise);
          expect(piece.plane).toBe(spec.plane);
          expect(piece.center).toEqual(spec.center);
          expect(piece.radius).toBe(spec.radius);
          expect(Math.sign(piece.degrees)).toBe(Math.sign(spec.degrees));
        }
        expect(first.startAngle).toBe(spec.startAngle);
        // Length invariant.
        expect(Math.abs(specListLength(out) - specListLength([spec]))).toBeLessThan(TOL);
        // The second piece starts at the split point, the first ends there.
        const p = arcPointAt(spec, t);
        expect(dist(arcPointAt(second, 0), p)).toBeLessThan(1e-9);
        expect(dist(arcPointAt(first, 1), p)).toBeLessThan(1e-9);
        // 64 samples along the arc length coincide before and after.
        const L = specListLength([spec]);
        for (let k = 0; k <= 64; k++) {
          const s = (L * k) / 64;
          expect(dist(pointAtS(out, s), pointAtS([spec], s))).toBeLessThan(1e-9);
        }
        // Splitting inside a longer chain leaves the other segments alone.
        const chained = splitSegment(before, 1, t)!;
        expect(chained[0]).toEqual(before[0]);
        expect(chained.length).toBe(3);
      });
    }
  }

  it('t at 0 or 1 (or outside) and pieces shorter than 1 mm are refused; the input stays unchanged', () => {
    const specs = [line([0, 0, 0], [5, 0, 0])];
    const snapshot = cloneSegmentSpecs(specs);
    for (const t of [0, 1, -0.1, 1.2, Number.NaN]) expect(splitSegment(specs, 0, t)).toBeNull();
    // 5 m line: a piece of 0.5 mm at either end.
    expect(splitSegment(specs, 0, 0.0005 / 5)).toBeNull();
    expect(splitSegment(specs, 0, 1 - 0.0005 / 5)).toBeNull();
    // 1 mm exactly is allowed (MIN_PIECE_M).
    expect(splitSegment(specs, 0, (MIN_PIECE_M * 1.01) / 5)).not.toBeNull();
    expect(splitSegment(specs, 3, 0.5)).toBeNull(); // unknown index
    expect(specs).toEqual(snapshot);
  });
});

// ─── 9.2 ────────────────────────────────────────────────────────────────

describe('9.2 arc sweep handle changes only degrees', () => {
  it('setArcDegrees changes degrees only, clamps to [1°, 360°] and keeps the sign', () => {
    for (const spec of ARC_VARIANTS) {
      const specs = [line([0, 0, 0], [1, 0, 0]), spec];
      const out = setArcDegrees(specs, 1, 45)!;
      const a = out[1] as PathArcSpec;
      expect(Math.abs(a.degrees)).toBe(45);
      expect(Math.sign(a.degrees)).toBe(Math.sign(spec.degrees));
      expect(a.center).toEqual(spec.center);
      expect(a.radius).toBe(spec.radius);
      expect(a.startAngle).toBe(spec.startAngle);
      expect(a.plane).toBe(spec.plane);
      expect(a.clockwise).toBe(spec.clockwise);
      expect(out[0]).toEqual(specs[0]);
      // Toward 0° and beyond 360°.
      expect(Math.abs((setArcDegrees(specs, 1, 0)![1] as PathArcSpec).degrees)).toBe(MIN_SWEEP_DEG);
      expect(Math.abs((setArcDegrees(specs, 1, 0.2)![1] as PathArcSpec).degrees)).toBe(MIN_SWEEP_DEG);
      expect(Math.abs((setArcDegrees(specs, 1, 500)![1] as PathArcSpec).degrees)).toBe(MAX_SWEEP_DEG);
      expect(Math.abs((setArcDegrees(specs, 1, Number.NaN)![1] as PathArcSpec).degrees)).toBe(MIN_SWEEP_DEG);
      // The input is never mutated.
      expect(specs[1]).toBe(spec);
    }
  });

  it('a line or an unknown index is not an arc', () => {
    expect(setArcDegrees([line([0, 0, 0], [1, 0, 0])], 0, 45)).toBeNull();
    expect(setArcDegrees([arc()], 4, 45)).toBeNull();
  });

  it('the sweep handle sits at the arc end and is opt-in', () => {
    const spec = arc({ plane: 'XY' });
    expect(derivePathHandles([spec]).map((h) => h.id).sort()).toEqual(['c0', 'r0']);
    const withSweep = derivePathHandles([spec], { sweep: true });
    const s = withSweep.find((h) => h.id === 's0')!;
    expect(s).toBeDefined();
    expect(s.kind).toBe('arc-sweep');
    expect(dist(s.position, arcPointAt(spec, 1))).toBeLessThan(1e-12);
  });

  it('sweepFromPoint unwraps continuously in the turning direction (no jump at ±180°)', () => {
    for (const spec of ARC_VARIANTS) {
      // Walk the drag point around the circle from 10° to 350° of sweep and beyond.
      let prev = Math.abs(spec.degrees);
      for (let target = 10; target <= 380; target += 10) {
        const probe = setArcDegrees([spec], 0, Math.min(target, 360))![0] as PathArcSpec;
        // A point at that sweep (unclamped: rebuild directly for > 360).
        const p = arcPointAt({ ...spec, degrees: Math.sign(spec.degrees) * target }, 1);
        const got = sweepFromPoint(spec, p, prev);
        expect(Math.abs(got - target)).toBeLessThan(1e-6);
        prev = got;
        expect(Math.abs(probe.degrees)).toBeLessThanOrEqual(360);
      }
    }
  });

  it('movePathHandle on s<i> runs the point on the circle and changes degrees only', () => {
    const spec = arc({ plane: 'XZ', startAngle: 0, degrees: 90, center: [0, 0, 0], radius: 2 });
    // Drag to 180° on the XZ circle (and off-plane/off-radius: ignored).
    const out = movePathHandle([spec], 's0', [-5, 3, 0])[0] as PathArcSpec;
    expect(out.degrees).toBeCloseTo(180, 9);
    expect(out.radius).toBe(2);
    expect(out.center).toEqual([0, 0, 0]);
    expect(out.startAngle).toBe(0);
  });
});

// ─── 9.3 ────────────────────────────────────────────────────────────────

describe('9.3 remove is refused on the last segment', () => {
  it('one segment → null, the list unchanged', () => {
    const specs = [line([0, 0, 0], [1, 0, 0])];
    expect(removeEndSegment(specs, 'end')).toBeNull();
    expect(removeEndSegment(specs, 'start')).toBeNull();
    expect(removeEndSegment([], 'end')).toBeNull();
    expect(specs.length).toBe(1);
  });

  it('removes exactly the end segment at either end', () => {
    const a = line([0, 0, 0], [1, 0, 0]);
    const b = line([1, 0, 0], [2, 0, 0]);
    const c = arc();
    expect(removeEndSegment([a, b, c], 'end')).toEqual([a, b]);
    expect(removeEndSegment([a, b, c], 'start')).toEqual([b, c]);
  });
});

// ─── 9.6 ────────────────────────────────────────────────────────────────

describe('9.6 projection inverts evaluation', () => {
  it('lines: point at t projects back to t; off-segment distance; ends clamp', () => {
    const spec = line([1, 2, 3], [4, 6, 3]); // length 5
    for (let k = 0; k <= 20; k++) {
      const t = k / 20;
      const p: Vec3Tuple = [1 + 3 * t, 2 + 4 * t, 3];
      expect(projectToSegment(spec, p).t01).toBeCloseTo(t, 12);
      expect(projectToSegment(spec, p).distance).toBeLessThan(1e-12);
    }
    // 2 m off the middle along Z.
    const side = projectToSegment(spec, [2.5, 4, 5]);
    expect(side.t01).toBeCloseTo(0.5, 12);
    expect(side.distance).toBeCloseTo(2, 12);
    expect(projectToSegment(spec, [-10, -10, 3]).t01).toBe(0);
    expect(projectToSegment(spec, [40, 60, 3]).t01).toBe(1);
  });

  it('arcs in all three planes: point at t projects back to t; distance; beyond an end clamps', () => {
    for (const spec of ARC_VARIANTS) {
      for (let k = 1; k < 20; k++) {
        const t = k / 20;
        const pr = projectToSegment(spec, arcPointAt(spec, t));
        expect(pr.t01).toBeCloseTo(t, 9);
        expect(pr.distance).toBeLessThan(1e-9);
      }
      // A point 0.5 m outside the circle at t = 0.5 → distance 0.5.
      const mid = arcPointAt(spec, 0.5);
      const c = spec.center as Vec3Tuple;
      const out: Vec3Tuple = [
        c[0] + (mid[0] - c[0]) * 1.25, c[1] + (mid[1] - c[1]) * 1.25, c[2] + (mid[2] - c[2]) * 1.25,
      ];
      const off = projectToSegment(spec, out);
      expect(off.t01).toBeCloseTo(0.5, 9);
      expect(off.distance).toBeCloseTo(0.5, 9);
      // Slightly beyond the end / before the start (sweep direction) clamps to 1 / 0.
      const sign = Math.sign((spec.clockwise ? -1 : 1) * spec.degrees);
      const beyond = arcPointAt({ ...spec, degrees: spec.degrees * 1.05 }, 1);
      expect(projectToSegment(spec, beyond).t01).toBe(1);
      const before = arcPointAt({ ...spec, startAngle: spec.startAngle - sign * 5, degrees: spec.degrees }, 0);
      expect(projectToSegment(spec, before).t01).toBe(0);
    }
  });

  it('locateArcLength: segment boundaries belong to the later segment, inside an arc it is linear', () => {
    const a = line([0, 0, 0], [2, 0, 0]);
    const b = arc({ center: [2, 0, 1], radius: 1, startAngle: -90, degrees: 180, plane: 'XZ' }); // length π
    const c = line([2, 0, 2], [0, 0, 2]);
    const specs = [a, b, c];
    expect(locateArcLength(specs, 0)).toEqual({ index: 0, t01: 0 });
    expect(locateArcLength(specs, 1)).toEqual({ index: 0, t01: 0.5 });
    expect(locateArcLength(specs, 2)).toEqual({ index: 1, t01: 0 });
    const inArc = locateArcLength(specs, 2 + Math.PI / 4)!;
    expect(inArc.index).toBe(1);
    expect(inArc.t01).toBeCloseTo(0.25, 12);
    expect(locateArcLength(specs, 2 + Math.PI)!.index).toBe(2);
    expect(locateArcLength(specs, 1e9)).toEqual({ index: 2, t01: 1 });
    expect(locateArcLength(specs, -3)).toEqual({ index: 0, t01: 0 });
    expect(locateArcLength([], 1)).toBeNull();
    // A node position turns into a split that keeps the geometry (plan-628 P7 seam).
    const at = locateArcLength(specs, 2 + Math.PI / 2)!;
    const split = splitSegment(specs, at.index, at.t01)!;
    expect(Math.abs(specListLength(split) - specListLength(specs))).toBeLessThan(TOL);
  });

  it('pickSegmentPoint: ray against a line and against an arc in its OWN plane', () => {
    // Line along X at y=0; a ray from above pointing straight down at x=3.
    const l = line([0, 0, 0], [10, 0, 0]);
    const hitL = pickSegmentPoint(l, [3, 5, 0.2], [0, -1, 0])!;
    expect(hitL.t01).toBeCloseTo(0.3, 12);
    expect(hitL.point[0]).toBeCloseTo(3, 12);
    // XY arc (vertical plane): a ray along -Z through a point on the arc.
    const xy = arc({ plane: 'XY', center: [0, 0, 0], radius: 2, startAngle: 0, degrees: 90 });
    const target = arcPointAt(xy, 0.4);
    const hitA = pickSegmentPoint(xy, [target[0], target[1], 10], [0, 0, -1])!;
    expect(hitA.t01).toBeCloseTo(0.4, 9);
    // A ray parallel to the arc plane finds nothing; one pointing away neither.
    expect(pickSegmentPoint(xy, [0, 0, 10], [1, 0, 0])).toBeNull();
    expect(pickSegmentPoint(xy, [0, 0, 10], [0, 0, 1])).toBeNull();
  });

  it('appendSegment: same kind, same dimensions, chain closed and the same tangent at the joint', () => {
    const cases: PathSegmentSpec[][] = [
      [line([0, 0, 0], [2, 0, 1])],
      ...ARC_VARIANTS.map((s) => [s]),
      [line([0, 0, 0], [1, 0, 0]), arc({ center: [1, 0, 1], radius: 1, startAngle: -90, degrees: 90 })],
    ];
    for (const specs of cases) {
      for (const end of ['start', 'end'] as const) {
        const out = appendSegment(specs, end)!;
        expect(out.length).toBe(specs.length + 1);
        const added = end === 'end' ? out[out.length - 1] : out[0];
        const nb = end === 'end' ? specs[specs.length - 1] : specs[0];
        expect(added.kind).toBe(nb.kind);
        expect(segmentLength(added)).toBeCloseTo(segmentLength(nb), 12);
        if (nb.kind === 'arc') {
          const a = added as PathArcSpec;
          expect(a.radius).toBe(nb.radius);
          expect(a.degrees).toBe(nb.degrees);
          expect(a.clockwise).toBe(nb.clockwise);
          expect(a.plane).toBe(nb.plane);
          expect(a.center).toEqual(nb.center);
        }
        // Chain closure + tangent continuity at the joint.
        const [first, second] = end === 'end' ? [nb, added] : [added, nb];
        const endP = first.kind === 'line' ? (first.to as Vec3Tuple) : arcPointAt(first, 1);
        const startP = second.kind === 'line' ? (second.from as Vec3Tuple) : arcPointAt(second, 0);
        expect(dist(endP, startP)).toBeLessThan(1e-9);
        const t1 = tangent(first, true);
        const t2 = tangent(second, false);
        expect(t1[0] * t2[0] + t1[1] * t2[1] + t1[2] * t2[2]).toBeGreaterThan(1 - 1e-6);
        // The original segments are untouched.
        expect(end === 'end' ? out.slice(0, specs.length) : out.slice(1)).toEqual(specs);
      }
    }
  });

  it('appendSegment fallback and degenerate neighbours', () => {
    expect(appendSegment([], 'end')).toEqual([{ kind: 'line', from: [0, 0, 0], to: [1, 0, 0] }]);
    expect(appendSegment([line([1, 1, 1], [1, 1, 1])], 'end')).toBeNull();
    expect(appendSegment([arc({ radius: 0 })], 'start')).toBeNull();
  });
});
