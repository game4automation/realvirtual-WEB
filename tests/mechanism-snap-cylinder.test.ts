// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * T8 of plan-411 — the `cylinder-axis` snap.
 *
 * `circle-center` snaps a bore through its RIM. This closes the other half:
 * hovering the WALL of a hole (or a shaft) must yield the axis and the radius,
 * fitted from the curved surface itself.
 *
 * The positive cases are the easy part. What this suite is really about are the
 * REJECTIONS, because a snap that returns a plausible-looking wrong axis is
 * worse than one that returns nothing: the mechanism solves, it just solves to
 * the wrong pose. plan-411 §2.5 makes the parity rules of the Unity reference
 * (`MeshCircleDetector.TryEvaluateCurvedRegion`) binding, and each of them owns
 * a test below:
 *
 *   cone            → the radius drifts along the axis (counter-check on the
 *                     UNTRIMMED points, before the median trim flattens it)
 *   sphere/free-form→ structure tensor λ0/λ2 above the cylinder threshold
 *   partial arc     → angular coverage below 200°
 *   gap             → a single gap above 120°
 *   non-uniform scale → the circle is an ellipse in world space; no radius exists
 *
 * Plus inside-vs-outside (the bore wins the ranking), invariance under an
 * arbitrary rigid transform of the mesh, and the hover-budget measurement the
 * plan asks for.
 */

import { describe, it, expect } from 'vitest';
import { BufferGeometry, Euler, Matrix4, Vector3 } from 'three';
import {
  chooseSnapCandidate, computeSnapCandidates, snapCandidateLabel,
  type SnapCandidate,
} from '@rv-private/plugins/asset-editor/mechanism/mechanism-snap';
// The mesh builders moved to tests/helpers with plan-722: the circle-enumeration
// suite needs the same mantles, and two copies of a fixture that IS the ground
// truth is how one suite ends up passing against a drifted reference.
import { mantle, sphere, toGeometry } from './helpers/mesh-fixtures';

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** A triangle in the middle of the mantle — a stable seed for the hover. */
function midFace(geometry: BufferGeometry): number {
  return Math.floor((geometry.getIndex()!.count / 3) / 2);
}

function cylinderOf(candidates: SnapCandidate[]): SnapCandidate | undefined {
  return candidates.find((c) => c.kind === 'cylinder-axis');
}

/** Angle between two axes, ignoring sign (an axis has no direction). */
function axisAngleDeg(a: Vector3, b: Vector3): number {
  const dot = Math.min(1, Math.abs(a.clone().normalize().dot(b.clone().normalize())));
  return (Math.acos(dot) * 180) / Math.PI;
}

// ─── Positive cases ─────────────────────────────────────────────────────────

describe('plan-411 T8 — cylinder-axis, the cases it must find', () => {
  it('fits the axis and radius of a bore wall', () => {
    const geometry = mantle({ radiusBottom: 5, height: 20, inward: true });
    const face = midFace(geometry);
    const candidates = computeSnapCandidates(geometry, face, new Vector3(5, 0, 0));

    const cylinder = cylinderOf(candidates);
    expect(cylinder).toBeDefined();
    expect(cylinder!.radius).toBeCloseTo(5, 1);
    expect(axisAngleDeg(cylinder!.normal, new Vector3(0, 0, 1))).toBeLessThan(1);
    expect(cylinder!.inner).toBe(true);
  });

  it('fits a shaft (outer) wall and marks it as NOT inner', () => {
    const geometry = mantle({ radiusBottom: 8, height: 20, inward: false });
    const cylinder = cylinderOf(
      computeSnapCandidates(geometry, midFace(geometry), new Vector3(8, 0, 0)),
    );
    expect(cylinder).toBeDefined();
    expect(cylinder!.radius).toBeCloseTo(8, 1);
    expect(cylinder!.inner).toBe(false);
  });

  it('is invariant under an arbitrary rigid transform of the bore', () => {
    // A moved and rotated hole: the axis must follow the geometry, and the
    // radius must not change. This is the case a snap that secretly assumes a
    // world-aligned axis would fail.
    const transform = new Matrix4()
      .makeRotationFromEuler(new Euler(0.4, -0.9, 1.3))
      .setPosition(37, -12.5, 4);
    const geometry = mantle({ radiusBottom: 5, height: 20, inward: true, transform });

    const expectedAxis = new Vector3(0, 0, 1).transformDirection(transform);
    const seedPoint = new Vector3(5, 0, 0).applyMatrix4(transform);
    const cylinder = cylinderOf(computeSnapCandidates(geometry, midFace(geometry), seedPoint));

    expect(cylinder).toBeDefined();
    expect(cylinder!.radius).toBeCloseTo(5, 1);
    expect(axisAngleDeg(cylinder!.normal, expectedAxis)).toBeLessThan(1);

    // The snap sits ON the axis: the vector from the fitted point to the seed
    // point is perpendicular to the axis, and its length is the radius.
    const toSeed = seedPoint.clone().sub(cylinder!.position);
    expect(Math.abs(toSeed.dot(cylinder!.normal))).toBeLessThan(1e-3);
    expect(toSeed.length()).toBeCloseTo(5, 1);
  });

  it('still offers circle-center for a RIM hover — the two are complementary', () => {
    // An annulus (flat face with a circular hole): the planar branch owns this
    // one, and adding the cylinder branch must not have taken it away.
    const segments = 48;
    const positions: number[] = [];
    const indices: number[] = [];
    for (const r of [4, 10]) {
      for (let s = 0; s <= segments; s++) {
        const angle = (s / segments) * Math.PI * 2;
        positions.push(Math.cos(angle) * r, Math.sin(angle) * r, 0);
      }
    }
    for (let s = 0; s < segments; s++) {
      const a = s, b = s + 1, c = segments + 1 + s + 1, d = segments + 1 + s;
      indices.push(a, b, c, a, c, d);
    }
    const geometry = toGeometry({ positions, indices });

    const candidates = computeSnapCandidates(geometry, 0, new Vector3(7, 0, 0));
    const circle = candidates.find((c) => c.kind === 'circle-center');
    expect(circle).toBeDefined();
    expect(circle!.radius).toBeCloseTo(4, 0);
  });
});

// ─── Negative cases — the parity rules ──────────────────────────────────────

describe('plan-411 T8 — cylinder-axis, the cases it must REFUSE', () => {
  it('refuses a cone (the radius drifts along the axis)', () => {
    const geometry = mantle({ radiusBottom: 5, radiusTop: 9, height: 20, inward: true });
    expect(cylinderOf(computeSnapCandidates(geometry, midFace(geometry), new Vector3(7, 0, 0))))
      .toBeUndefined();
  });

  it('accepts a barely-tapered wall — the rejection is a THRESHOLD, not a veto', () => {
    // Real CAD bores carry a draft angle. A cone check that fired on 0.5 % drift
    // would make the feature useless on anything cast or moulded.
    const geometry = mantle({ radiusBottom: 5, radiusTop: 5.02, height: 20, inward: true });
    expect(cylinderOf(computeSnapCandidates(geometry, midFace(geometry), new Vector3(5, 0, 0))))
      .toBeDefined();
  });

  it('refuses a sphere (curved in both directions — no axis)', () => {
    const geometry = sphere(10);
    expect(cylinderOf(computeSnapCandidates(geometry, midFace(geometry), new Vector3(0, 0, 10))))
      .toBeUndefined();
  });

  it('refuses too little angular coverage (a 120° arc is not a bore)', () => {
    const geometry = mantle({ radiusBottom: 5, height: 20, inward: true, sweepDeg: 120 });
    expect(cylinderOf(computeSnapCandidates(geometry, midFace(geometry), new Vector3(5, 0, 0))))
      .toBeUndefined();
  });

  it('refuses a wall with one large gap', () => {
    // 360° of ring, but a 150° wedge of it is missing — above the 120° limit.
    const geometry = mantle({ radiusBottom: 5, height: 20, inward: true, gapDeg: 150 });
    expect(cylinderOf(computeSnapCandidates(geometry, midFace(geometry), new Vector3(-5, 0, 0))))
      .toBeUndefined();
  });

  it('refuses a non-uniformly scaled node (the circle is an ellipse in world space)', () => {
    const geometry = mantle({ radiusBottom: 5, height: 20, inward: true });
    const face = midFace(geometry);
    const seed = new Vector3(5, 0, 0);

    // Uniform scale: still a circle, still a snap.
    const uniform = new Matrix4().makeScale(2, 2, 2);
    expect(cylinderOf(computeSnapCandidates(geometry, face, seed, { localToWorld: uniform })))
      .toBeDefined();

    // Anisotropic IN THE CIRCLE PLANE: refused.
    const squashed = new Matrix4().makeScale(2, 0.5, 2);
    expect(cylinderOf(computeSnapCandidates(geometry, face, seed, { localToWorld: squashed })))
      .toBeUndefined();

    // Anisotropic ALONG the axis only — the circle stays a circle, so this one
    // is still fine. (The naive "any non-uniform scale" rule would reject it.)
    const stretchedAlongAxis = new Matrix4().makeScale(1, 1, 4);
    expect(cylinderOf(computeSnapCandidates(geometry, face, seed, { localToWorld: stretchedAlongAxis })))
      .toBeDefined();
  });

  it('never throws on degenerate input', () => {
    expect(computeSnapCandidates(new BufferGeometry(), 0, new Vector3())).toEqual([]);
    const geometry = mantle({ radiusBottom: 5, height: 20 });
    expect(computeSnapCandidates(geometry, -1, new Vector3())).toEqual([]);
    expect(computeSnapCandidates(geometry, 999999, new Vector3())).toEqual([]);
  });
});

// ─── Ranking and label ──────────────────────────────────────────────────────

describe('plan-411 T8 — ranking and label', () => {
  it('the BORE wins over an outer cylinder at the same distance', () => {
    // plan-411 §2.5: "the bore wins when hovering in the hole". The competitor
    // is the other CYLINDER — a boss and the hole drilled through it are both
    // under the same ray, and the hole is what the cursor is inside of.
    const cursor = new Vector3(0, 0, 0);
    const bore: SnapCandidate = {
      kind: 'cylinder-axis', position: new Vector3(5, 0, 0),
      normal: new Vector3(0, 0, 1), radius: 3, inner: true,
    };
    const boss: SnapCandidate = {
      kind: 'cylinder-axis', position: new Vector3(-5, 0, 0),
      normal: new Vector3(0, 0, 1), radius: 12, inner: false,
    };
    expect(chooseSnapCandidate([boss, bore], cursor)).toBe(bore);
    expect(chooseSnapCandidate([bore, boss], cursor)).toBe(bore);

    // The bonus is a tie-breaker, not a licence: a clearly nearer outer
    // cylinder still wins, or the rule would drag every pick into the nearest hole.
    const nearBoss: SnapCandidate = { ...boss, position: new Vector3(1, 0, 0) };
    expect(chooseSnapCandidate([nearBoss, bore], cursor)).toBe(nearBoss);
  });

  it('a cursor sitting exactly on a vertex still snaps to that vertex', () => {
    // The kind weight is a PULL, not an override. `mantle()` puts a vertex at
    // (r,0,0), so this hover is on one — and a distance of zero beats any weight.
    // Worth pinning: the alternative (an axis that hijacks a deliberate vertex
    // click) would make precise anchor authoring impossible.
    const geometry = mantle({ radiusBottom: 5, height: 20, inward: true });
    const localPoint = new Vector3(5, 0, 0);
    const candidates = computeSnapCandidates(geometry, midFace(geometry), localPoint);
    expect(cylinderOf(candidates)).toBeDefined();
    expect(chooseSnapCandidate(candidates, localPoint)!.kind).toBe('vertex');
  });

  it('labels a bore and a shaft differently', () => {
    expect(snapCandidateLabel({
      kind: 'cylinder-axis', position: new Vector3(), normal: new Vector3(0, 0, 1),
      radius: 5, inner: true,
    })).toMatch(/Bore axis/);
    expect(snapCandidateLabel({
      kind: 'cylinder-axis', position: new Vector3(), normal: new Vector3(0, 0, 1),
      radius: 8, inner: false,
    })).toMatch(/Cylinder axis/);
  });
});

// ─── Performance (plan-411 §2.5: the fit runs in the HOVER path) ────────────

describe('plan-411 T8 — hover budget', () => {
  it('stays inside the 50 ms hover throttle on a large CAD-scale mesh', () => {
    // 256 segments × 40 rings ≈ 20 480 triangles of pure mantle — denser than
    // any single bore of a real import, and the region growing walks ALL of it
    // (a real part's bore is one feature among many, and the growth stops at
    // its ends).
    const geometry = mantle({ radiusBottom: 5, height: 40, segments: 256, rings: 40, inward: true });
    const face = midFace(geometry);
    const seed = new Vector3(5, 0, 0);

    // First call includes the one-off welded-topology build (cached per geometry).
    const coldStart = performance.now();
    expect(cylinderOf(computeSnapCandidates(geometry, face, seed))).toBeDefined();
    const cold = performance.now() - coldStart;

    // Steady state: what every subsequent hover sample actually costs.
    const warmStart = performance.now();
    const samples = 5;
    for (let i = 0; i < samples; i++) computeSnapCandidates(geometry, face, seed);
    const warm = (performance.now() - warmStart) / samples;

    // Recorded in the plan's completion report, not just asserted.
    console.info(
      `[plan-411 T8] cylinder fit on ${geometry.getIndex()!.count / 3} triangles: `
      + `cold ${cold.toFixed(1)} ms (incl. topology build), warm ${warm.toFixed(1)} ms/hover`,
    );

    // The 50 ms throttle IS the CPU budget of one hover sample
    // (doc-render-picking.md §2.4). The warm path must fit inside it with room
    // for the two raycasts that share the same sample.
    expect(warm).toBeLessThan(50);
  });
});
