// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Test 9.1 of plan-733 — the `ChainPathTable` curve evaluator, without a scene.
 *
 * The assertions are written against UNITY's arithmetic, not against this
 * implementation: the position→fraction conversion is
 * `ChainElement.SetPosition()` transcribed, including the two properties that
 * look like bugs (no `closed` branch, `1 - |p|/L` for negatives) and are the
 * contract.
 */

import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import {
  ChainPathTable,
  applyVerticalFlip,
  relativePosition,
} from '../src/core/engine/rv-chain-path';
import { squareLoopSpline, straightSpline } from './chain-fixture';

const pos = new Vector3();
const tan = new Vector3();
const up = new Vector3();
const quat = new Quaternion();

describe('relativePosition (Unity ChainElement.SetPosition parity)', () => {
  it('maps a position inside the length to its plain fraction', () => {
    expect(relativePosition(250, 1000)).toBeCloseTo(0.25, 12);
    expect(relativePosition(0, 1000)).toBe(0);
    expect(relativePosition(1000, 1000)).toBe(1);
  });

  it('wraps by modulo on an OPEN spline exactly as on a closed one (no clamping)', () => {
    // The evaluator has no `closed` input at all — that IS the parity statement.
    expect(relativePosition(1250, 1000)).toBeCloseTo(0.25, 12);
    expect(relativePosition(3250, 1000)).toBeCloseTo(0.25, 12);
    // Clamping would give 1 here; Unity gives 0.25.
    expect(relativePosition(1250, 1000)).not.toBe(1);
  });

  it('handles negative positions via the Unity sign formula (1 - |p|/L branch)', () => {
    // Small negative: no modulo runs, the sign branch alone wraps it.
    expect(relativePosition(-250, 1000)).toBeCloseTo(0.75, 12);
    // Beyond one length: modulo first (keeps the sign, like C#), then the branch.
    expect(relativePosition(-1250, 1000)).toBeCloseTo(0.75, 12);
    expect(relativePosition(-1000, 1000)).toBe(0);
  });

  it('never produces NaN or Infinity for a degenerate length', () => {
    for (const len of [0, -100, Number.NaN]) {
      expect(relativePosition(500, len)).toBe(0);
    }
    expect(relativePosition(Number.NaN, 1000)).toBe(0);
  });
});

describe('ChainPathTable construction', () => {
  it('returns inert (null) for degenerate tables of 0 or 1 samples', () => {
    expect(ChainPathTable.from(null)).toBeNull();
    expect(ChainPathTable.from({})).toBeNull();
    expect(ChainPathTable.from({ closed: false, length: 1, samples: [] })).toBeNull();
    expect(ChainPathTable.from({ closed: false, length: 1, samples: [0, 0, 0, 0, 0, 1, 0, 1, 0] })).toBeNull();
  });

  it('parses a well-formed block and reports count, length and closed', () => {
    const table = ChainPathTable.from(straightSpline(2, 5))!;
    expect(table).not.toBeNull();
    expect(table.count).toBe(5);
    expect(table.lengthM).toBeCloseTo(2, 12);
    expect(table.closed).toBe(false);
    expect(ChainPathTable.from(squareLoopSpline())!.closed).toBe(true);
  });

  it('falls back to the polyline length when the declared length is missing', () => {
    const block = straightSpline(2, 5) as unknown as Record<string, unknown>;
    delete block.length;
    expect(ChainPathTable.from(block)!.lengthM).toBeCloseTo(2, 5);
  });
});

describe('ChainPathTable sampling', () => {
  const table = ChainPathTable.from(straightSpline(2, 5))!;

  it('interpolates position linearly between samples on a straight segment', () => {
    // Fraction 0.375 lies between sample 1 (z=0.5) and sample 2 (z=1.0).
    table.sampleAt(0.375, pos, tan, up);
    expect(pos.z).toBeCloseTo(0.75, 6);
    expect(pos.x).toBeCloseTo(0, 12);
    // Direction vectors stay unit length after the lerp.
    expect(tan.length()).toBeCloseTo(1, 6);
    expect(up.length()).toBeCloseTo(1, 6);
  });

  it('hits the exact endpoints at fraction 0 and 1', () => {
    table.sampleAt(0, pos, tan, up);
    expect(pos.z).toBeCloseTo(0, 12);
    table.sampleAt(1, pos, tan, up);
    expect(pos.z).toBeCloseTo(2, 6);
  });

  it('samples by arc-length distance in metres', () => {
    table.sampleAtDistance(0.5, pos, tan, up);
    expect(pos.z).toBeCloseTo(0.5, 6);
  });

  it('turns the tangent through a closed loop instead of jumping', () => {
    const loop = ChainPathTable.from(squareLoopSpline(1, 4))!;
    loop.sampleAt(0, pos, tan, up);
    expect(tan.z).toBeCloseTo(1, 6); // first side runs +Z
    loop.sampleAt(0.5, pos, tan, up);
    expect(tan.z).toBeCloseTo(-1, 6); // third side runs -Z
  });
});

describe('ChainPathTable.poseAt', () => {
  const table = ChainPathTable.from(straightSpline(2, 5))!; // 2 m == 2000 mm

  it('applies ScaledOnFixedLength: fraction over FixedLength, sampling over the real length', () => {
    // relevantLength = FixedLength = 1000 mm, real curve = 2000 mm.
    // 500 mm => fraction 0.5 => sampled at the MIDDLE of the real 2 m curve.
    table.poseAt(500, 1000, false, pos, quat);
    expect(pos.z).toBeCloseTo(1.0, 6);
    // The same 500 mm over the real length would be a quarter of the way.
    table.poseAt(500, 2000, false, pos, quat);
    expect(pos.z).toBeCloseTo(0.5, 6);
  });

  it('handles FixedLength edge cases (0, greater than the real length) without NaN', () => {
    table.poseAt(500, 0, false, pos, quat);
    expect(Number.isFinite(pos.z)).toBe(true);
    expect(pos.z).toBeCloseTo(0, 12);
    table.poseAt(500, 8000, false, pos, quat);
    expect(pos.z).toBeCloseTo(0.125, 6);
    expect(Number.isNaN(quat.x)).toBe(false);
  });

  it('builds a LookRotation(tangent, up) orientation', () => {
    table.poseAt(0, 2000, false, pos, quat);
    // Local +Z must point along the tangent (+Z here) => identity rotation.
    const forward = new Vector3(0, 0, 1).applyQuaternion(quat);
    expect(forward.z).toBeCloseTo(1, 6);
    const upAxis = new Vector3(0, 1, 0).applyQuaternion(quat);
    expect(upAxis.y).toBeCloseTo(1, 6);
  });
});

describe('vertical orientation flip (Unity parity)', () => {
  // The tangents fed to applyVerticalFlip come from the baked sample table, which
  // the exporter writes in glTF space: X is negated (`ToGltf` = diag(-1,1,1)), Z is
  // not. Unity's test `tangent.z < 0 || (tangent.z == 0 && tangent.x > 0)` therefore
  // reads `x < 0` here. The two `z == 0` expectations below were originally written
  // against Unity's literal `x > 0` — i.e. they assumed unnegated Unity tangents —
  // and are corrected here; the `z != 0` cases are unaffected by the negation.
  it('negates the up vector exactly on Unity\'s condition', () => {
    // tangent.z < 0 => flip
    expect(applyVerticalFlip(new Vector3(0, 0, -1), new Vector3(0, 1, 0)).y).toBe(-1);
    // glTF x == -1 is Unity x == +1 => Unity flips => flip
    expect(applyVerticalFlip(new Vector3(-1, 0, 0), new Vector3(0, 1, 0)).y).toBe(-1);
    // glTF x == +1 is Unity x == -1 => Unity does not flip => NO flip
    expect(applyVerticalFlip(new Vector3(1, 0, 0), new Vector3(0, 1, 0)).y).toBe(1);
    // tangent.z > 0 => NO flip
    expect(applyVerticalFlip(new Vector3(0, 0, 1), new Vector3(0, 1, 0)).y).toBe(1);
  });

  it('matches Unity on the z == 0 boundary for every X sign (export negation parity)', () => {
    // The boundary case in full: for a stored (glTF-space) tangent the Unity-space
    // tangent is (-x, y, z). Unity flips iff its own x > 0, i.e. iff stored x < 0.
    const unityWouldFlip = (unityTangent: Vector3) =>
      unityTangent.z < 0 || (unityTangent.z === 0 && unityTangent.x > 0);

    for (const stored of [
      new Vector3(1, 0, 0),      // Unity (-1, 0, 0) => no flip
      new Vector3(-1, 0, 0),     // Unity ( 1, 0, 0) => flip
      new Vector3(0.6, 0.8, 0),  // exactly horizontal in Z, positive stored X
      new Vector3(-0.6, 0.8, 0), // exactly horizontal in Z, negative stored X
      new Vector3(0, 1, 0),      // x == 0 && z == 0 => neither side flips
    ]) {
      const unityTangent = new Vector3(-stored.x, stored.y, stored.z);
      const expected = unityWouldFlip(unityTangent) ? -1 : 1;
      expect(applyVerticalFlip(stored.clone(), new Vector3(0, 1, 0)).y).toBe(expected);
    }
  });

  it('is applied by poseAt only when the chain is vertical', () => {
    const loop = ChainPathTable.from(squareLoopSpline(1, 4))!; // 4 m == 4000 mm
    // Half way round the loop the tangent runs -Z, which triggers the flip.
    loop.poseAt(2000, 4000, false, pos, quat);
    const upHorizontal = new Vector3(0, 1, 0).applyQuaternion(quat);
    loop.poseAt(2000, 4000, true, pos, quat);
    const upVertical = new Vector3(0, 1, 0).applyQuaternion(quat);
    expect(upHorizontal.y).toBeCloseTo(1, 6);
    expect(upVertical.y).toBeCloseTo(-1, 6);
  });
});
