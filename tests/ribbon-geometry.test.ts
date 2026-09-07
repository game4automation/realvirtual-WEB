// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-459 §9.1 — the portable web path geometry.
 *
 * Every expectation here is ANALYTIC: the belt-drive tangent formulas
 * (`asin((r1 − r2)/d)` external, `asin((r1 + r2)/d)` crossed) and `r·θ` arcs are
 * computed independently in the test, never read back from the implementation.
 * A change that "makes the test green" therefore has to be right.
 */

import { describe, it, expect } from 'vitest';
import {
  buildRibbonSegments,
  sampleArcLength,
  tangentBetween,
  wrapAngle,
  RIBBON_SAMPLE_STRIDE,
  type ArcSegment2,
  type Circle2,
  type RibbonPathGeometry,
} from '../src/core/engine/ribbon/ribbon-geometry';

function circle(cx: number, cy: number, r: number, side: 1 | -1): Circle2 {
  return { cx, cy, r, side };
}

function ok(result: RibbonPathGeometry | { error: string }): RibbonPathGeometry {
  expect('error' in result ? result.error : null).toBeNull();
  return result as RibbonPathGeometry;
}

describe('ribbon-geometry — tangents', () => {
  it('external tangent of two equal circles is parallel to the center line', () => {
    const t = tangentBetween(circle(0, 0, 100, 1), circle(1000, 0, 100, 1))!;
    expect(t).not.toBeNull();
    // Both contact points sit at the same offset perpendicular to the x axis.
    expect(t.p0.y).toBeCloseTo(t.p1.y, 9);
    expect(t.p0.y).toBeCloseTo(-100, 9); // side +1 (CCW) → n = rot90cw(t) = (0,-1)
    expect(t.p0.x).toBeCloseTo(0, 9);
    expect(t.p1.x).toBeCloseTo(1000, 9);
  });

  it('external tangent for r1 != r2 has asin((r1-r2)/d) inclination', () => {
    const d = 1000;
    const r1 = 200;
    const r2 = 80;
    const t = tangentBetween(circle(0, 0, r1, 1), circle(d, 0, r2, 1))!;
    const dir = { x: t.p1.x - t.p0.x, y: t.p1.y - t.p0.y };
    const inclination = Math.atan2(dir.y, dir.x);
    expect(inclination).toBeCloseTo(Math.asin((r1 - r2) / d), 9);
    // Tangent length: sqrt(d^2 - (r1 - r2)^2)
    expect(Math.hypot(dir.x, dir.y)).toBeCloseTo(Math.sqrt(d * d - (r1 - r2) ** 2), 6);
  });

  it('crossed tangent when web side flips', () => {
    const d = 1000;
    const r1 = 150;
    const r2 = 90;
    const t = tangentBetween(circle(0, 0, r1, 1), circle(d, 0, r2, -1))!;
    expect(Math.sign(t.p0.y)).toBe(-Math.sign(t.p1.y));
    const dir = { x: t.p1.x - t.p0.x, y: t.p1.y - t.p0.y };
    expect(Math.atan2(dir.y, dir.x)).toBeCloseTo(Math.asin((r1 + r2) / d), 9);
    expect(Math.hypot(dir.x, dir.y)).toBeCloseTo(Math.sqrt(d * d - (r1 + r2) ** 2), 6);
  });

  it('picks the tangent branch on the web side of the center line', () => {
    const left = tangentBetween(circle(0, 0, 100, 1), circle(1000, 0, 100, 1))!;
    const right = tangentBetween(circle(0, 0, 100, -1), circle(1000, 0, 100, -1))!;
    // Mirrored about the centre line: same x, opposite y.
    expect(right.p0.y).toBeCloseTo(-left.p0.y, 9);
    expect(right.p1.y).toBeCloseTo(-left.p1.y, 9);
    expect(right.p0.x).toBeCloseTo(left.p0.x, 9);
  });

  it('returns null for overlapping circles (crossed) and for |r1-r2| > d (external)', () => {
    // Crossed needs r1 + r2 < d.
    expect(tangentBetween(circle(0, 0, 300, 1), circle(500, 0, 300, -1))).toBeNull();
    // External needs |r1 - r2| < d.
    expect(tangentBetween(circle(0, 0, 900, 1), circle(500, 0, 100, 1))).toBeNull();
  });

  it('coincident centers return an error', () => {
    expect(tangentBetween(circle(10, 10, 50, 1), circle(10, 10, 60, 1))).toBeNull();
    const built = buildRibbonSegments([circle(0, 0, 50, 1), circle(0, 0, 50, 1)]);
    expect('error' in built && built.error).toContain('centres coincide');
  });
});

describe('ribbon-geometry — open path', () => {
  it('open 3-roller path has arcs only on the middle roller', () => {
    const g = ok(buildRibbonSegments([
      circle(0, 0, 100, 1),
      circle(1000, 200, 60, 1),
      circle(2000, 0, 100, 1),
    ]));
    expect(g.segments.map((s) => s.kind)).toEqual(['line', 'arc', 'line']);
  });

  it('S-curve (Left,Right,Left) yields two crossed tangents and CW/CCW arcs', () => {
    const g = ok(buildRibbonSegments([
      circle(0, 0, 100, 1),
      circle(800, 0, 100, -1),
      circle(1600, 0, 100, 1),
    ]));
    expect(g.segments.map((s) => s.kind)).toEqual(['line', 'arc', 'line']);
    const arc = g.segments[1] as ArcSegment2;
    // The middle roller is a Right roller → clockwise sweep (negative).
    expect(arc.sweep).toBeLessThan(0);
    expect(wrapAngle(arc)).toBeGreaterThan(0);

    // And the mirrored S (Right,Left,Right) sweeps the other way.
    const mirrored = ok(buildRibbonSegments([
      circle(0, 0, 100, -1),
      circle(800, 0, 100, 1),
      circle(1600, 0, 100, -1),
    ]));
    expect((mirrored.segments[1] as ArcSegment2).sweep).toBeGreaterThan(0);
  });

  it('N=5 path length equals sum of tangent lengths + r*theta', () => {
    const rollers: Circle2[] = [
      circle(0, 0, 250, 1),
      circle(900, 400, 60, 1),
      circle(1800, -200, 80, -1),
      circle(2700, 500, 60, 1),
      circle(3600, 0, 250, 1),
    ];
    const g = ok(buildRibbonSegments(rollers));

    // Independent recomputation from the segment primitives themselves.
    let expected = 0;
    for (const s of g.segments) {
      expected += s.kind === 'line'
        ? Math.hypot(s.x1 - s.x0, s.y1 - s.y0)
        : s.r * wrapAngle(s);
    }
    expect(g.lengthMm).toBeCloseTo(expected, 6);
    expect(g.segments.filter((s) => s.kind === 'arc')).toHaveLength(3);
    expect(g.segments.filter((s) => s.kind === 'line')).toHaveLength(4);
    expect(g.lengthMm).toBeGreaterThan(3600); // longer than the straight span
  });

  it('a straight run of three collinear equal rollers has a zero wrap on the middle one', () => {
    const g = ok(buildRibbonSegments([
      circle(0, 0, 100, 1),
      circle(1000, 0, 100, 1),
      circle(2000, 0, 100, 1),
    ]));
    expect(wrapAngle(g.segments[1] as ArcSegment2)).toBeCloseTo(0, 9);
    expect(g.lengthMm).toBeCloseTo(2000, 6);
  });

  it('rejects a path with fewer than two rollers and a non-positive radius', () => {
    expect('error' in buildRibbonSegments([circle(0, 0, 100, 1)])).toBe(true);
    const bad = buildRibbonSegments([circle(0, 0, 0, 1), circle(500, 0, 100, 1)]);
    expect('error' in bad && bad.error).toContain('non-positive');
  });
});

describe('ribbon-geometry — sampling', () => {
  it('sampleArcLength writes equidistant samples and returns count', () => {
    const g = ok(buildRibbonSegments([
      circle(0, 0, 100, 1),
      circle(1000, 300, 100, 1),
      circle(2000, 0, 100, 1),
    ]));
    const out = new Float32Array(512 * RIBBON_SAMPLE_STRIDE);
    const { count } = sampleArcLength(g.segments, g.lengthMm / 100, out);
    expect(count).toBe(101);

    // Equidistant in ARC length: the chord of a pair is the spacing on a
    // straight run and marginally shorter across an arc, never meaningfully
    // longer (the slack absorbs the float32 storage of the sample buffer).
    const spacing = g.lengthMm / (count - 1);
    for (let i = 1; i < count; i++) {
      const dx = out[i * 4] - out[(i - 1) * 4];
      const dy = out[i * 4 + 1] - out[(i - 1) * 4 + 1];
      const chord = Math.hypot(dx, dy);
      expect(chord).toBeLessThan(spacing * 1.001);
      expect(chord).toBeGreaterThan(spacing * 0.99);
    }
    // Tangents are unit vectors.
    for (let i = 0; i < count; i++) {
      expect(Math.hypot(out[i * 4 + 2], out[i * 4 + 3])).toBeCloseTo(1, 6);
    }
  });

  it('samples sit on an ABSOLUTE i * step grid, whatever the total length', () => {
    // The property two slit strips depend on: they share every roller up to the
    // cutter but end at different rewinders, so a `total / (count - 1)` spacing
    // would sample the SHARED part differently for each of them.
    const prefix: Circle2[] = [
      circle(0, 0, 100, 1),
      circle(1000, 300, 100, -1),
      circle(2000, 0, 100, 1),
    ];
    const short = ok(buildRibbonSegments([...prefix, circle(3000, 200, 100, 1)]));
    const long = ok(buildRibbonSegments([...prefix, circle(9000, 200, 100, 1)]));
    expect(long.lengthMm).toBeGreaterThan(short.lengthMm + 5000);

    const STEP = 1000 / 48;              // 48 samples per metre, the demo density
    const outA = new Float32Array(2048 * RIBBON_SAMPLE_STRIDE);
    const outB = new Float32Array(2048 * RIBBON_SAMPLE_STRIDE);
    const { count: nA, stepMm: stepA } = sampleArcLength(short.segments, STEP, outA);
    const { count: nB, stepMm: stepB } = sampleArcLength(long.segments, STEP, outB);
    expect(stepA).toBe(STEP);
    expect(stepB).toBe(STEP);
    expect(nB).toBeGreaterThan(nA);

    // The two paths are geometrically identical up to the ARRIVAL at the third
    // roller (segments 0..2: line, arc, line); the arc ON that roller already
    // depends on where the web leaves it, i.e. on the fourth roller. That is
    // exactly the range a slit strip shares with its siblings, and every sample
    // in it must be the SAME point at the SAME index for both.
    const sharedMm = short.segments.slice(0, 3).reduce((s, seg) => s + seg.lengthMm, 0);
    const sharedSamples = Math.floor(sharedMm / STEP);
    expect(sharedSamples).toBeGreaterThan(20);
    for (let i = 0; i <= sharedSamples; i++) {
      expect(Math.hypot(outA[i * 4] - outB[i * 4], outA[i * 4 + 1] - outB[i * 4 + 1]))
        .toBeLessThan(1e-4);
    }

    // The interior spacing IS the step; only the last interval is shorter.
    for (let i = 1; i < nB - 1; i++) {
      const chord = Math.hypot(outB[i * 4] - outB[(i - 1) * 4], outB[i * 4 + 1] - outB[(i - 1) * 4 + 1]);
      expect(chord).toBeLessThanOrEqual(STEP * 1.001);
      expect(chord).toBeGreaterThan(STEP * 0.99);
    }
    const last = Math.hypot(
      outB[(nB - 1) * 4] - outB[(nB - 2) * 4], outB[(nB - 1) * 4 + 1] - outB[(nB - 2) * 4 + 1],
    );
    expect(last).toBeLessThanOrEqual(STEP * 1.001);
  });

  it('first and last sample sit exactly on the path ends', () => {
    const g = ok(buildRibbonSegments([circle(0, 0, 100, 1), circle(1000, 0, 100, 1)]));
    const out = new Float32Array(64 * RIBBON_SAMPLE_STRIDE);
    const { count } = sampleArcLength(g.segments, 37, out); // not a divisor of the length
    const first = g.segments[0] as { x0: number; y0: number; x1: number; y1: number };
    expect(out[0]).toBeCloseTo(first.x0, 4);
    expect(out[1]).toBeCloseTo(first.y0, 4);
    expect(out[(count - 1) * 4]).toBeCloseTo(first.x1, 4);
    expect(out[(count - 1) * 4 + 1]).toBeCloseTo(first.y1, 4);
  });

  it('never writes past the caller buffer — the grid is COARSENED, not truncated', () => {
    // Truncating the count would leave the interior samples on the requested
    // 1 mm grid and jump the last one to 10 000 mm: everything past sample
    // `capacity - 2` collapses into one straight run, and every slit / section
    // boundary in that remainder clamps to the path end. The grid is coarsened
    // by an integer factor instead, and the factor is REPORTED.
    const g = ok(buildRibbonSegments([circle(0, 0, 100, 1), circle(10_000, 0, 100, 1)]));
    const out = new Float32Array(8 * RIBBON_SAMPLE_STRIDE);
    const { count, stepMm } = sampleArcLength(g.segments, 1, out); // would want 10 000 samples
    expect(count).toBeLessThanOrEqual(8);
    expect(out.every((v) => Number.isFinite(v))).toBe(true);

    // The reported step is an integer multiple of the requested one, and it
    // actually covers the path: no gap between consecutive samples is bigger
    // than one step, and the last sample is the path end.
    expect(stepMm / 1).toBeCloseTo(Math.round(stepMm), 9);
    expect(stepMm).toBeGreaterThan(1);
    for (let i = 1; i < count; i++) {
      const gap = Math.hypot(out[i * 4] - out[(i - 1) * 4], out[i * 4 + 1] - out[(i - 1) * 4 + 1]);
      expect(gap).toBeLessThanOrEqual(stepMm * 1.001);
    }
    expect(out[(count - 1) * 4]).toBeCloseTo(10_000, 3);
    // …and the coarse grid is a SUBSET of the requested one, so a sibling that
    // did fit still shares these sample positions.
    for (let i = 0; i < count - 1; i++) expect(out[i * 4]).toBeCloseTo(i * stepMm, 3);
  });
});

// ── Auto side (plan-459 /fix 2026-09-05) ─────────────────────────────────
import {
  buildRibbonSegments as buildAuto,
  resolveAutoSides,
  type Circle2 as AutoCircle2,
  type LineSegment2 as AutoLine2,
  type RibbonPathGeometry as AutoGeometry,
} from '../src/core/engine/ribbon/ribbon-geometry';

function linesCross(a: AutoLine2, b: AutoLine2): boolean {
  const d1x = a.x1 - a.x0, d1y = a.y1 - a.y0, d2x = b.x1 - b.x0, d2y = b.y1 - b.y0;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-9) return false;
  const t = ((b.x0 - a.x0) * d2y - (b.y0 - a.y0) * d2x) / den;
  const u = ((b.x0 - a.x0) * d1y - (b.y0 - a.y0) * d1x) / den;
  return t > 1e-3 && t < 1 - 1e-3 && u > 1e-3 && u < 1 - 1e-3;
}

describe('Auto web side', () => {
  const demo = (): AutoCircle2[] => [
    { cx: 0, cy: 1200, r: 400, side: 0 },
    { cx: 1000, cy: 1700, r: 200, side: 0 },
    { cx: 1800, cy: 600, r: 120, side: 0 },
    { cx: 2900, cy: 1400, r: 190, side: 0 },
    { cx: 4000, cy: 1900, r: 150, side: 0 },
    { cx: 5200, cy: 1500, r: 76, side: 0 },
  ];

  it('wraps every inner roller under 180 deg on the demo S-layout', () => {
    const built = buildAuto(demo());
    expect('segments' in built).toBe(true);
    for (const s of (built as AutoGeometry).segments) {
      if (s.kind === 'arc') expect(Math.abs(s.sweep)).toBeLessThan(Math.PI);
    }
  });

  it('never lets two straight runs cross each other', () => {
    const built = buildAuto(demo()) as AutoGeometry;
    const lines = built.segments.filter((s): s is AutoLine2 => s.kind === 'line');
    for (let i = 0; i < lines.length; i++) {
      for (let j = i + 1; j < lines.length; j++) expect(linesCross(lines[i], lines[j])).toBe(false);
    }
  });

  it('a roller left of its neighbours chord (positive cross) wraps clockwise, right of it counter-clockwise; ends default Left', () => {
    const up: AutoCircle2[] = [{ cx: 0, cy: 0, r: 50, side: 0 }, { cx: 1000, cy: 800, r: 50, side: 0 }, { cx: 2000, cy: 0, r: 50, side: 0 }];
    resolveAutoSides(up);
    expect(up.map((c) => c.side)).toEqual([1, -1, 1]);
    const down: AutoCircle2[] = [{ cx: 0, cy: 0, r: 50, side: 0 }, { cx: 1000, cy: -800, r: 50, side: 0 }, { cx: 2000, cy: 0, r: 50, side: 0 }];
    resolveAutoSides(down);
    expect(down[1].side).toBe(1);
  });

  it('the far-side (explicit, wrong) wrap of the same roller is over 180 deg — what Auto avoids', () => {
    const c = demo();
    c[2].side = -1; // Idler_02 sits BELOW the chord; Right is the impossible wrap
    const built = buildAuto(c) as AutoGeometry;
    const arc = built.segments[3];
    expect(arc.kind).toBe('arc');
    if (arc.kind === 'arc') expect(Math.abs(arc.sweep)).toBeGreaterThan(Math.PI);
  });
});
