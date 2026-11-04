// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * ik-joint-limit-selection.test.ts — plan-772 Phase 5: a configuration the rig's
 * joint limits refuse must not be SELECTED while an admissible one sits next to it.
 *
 * ## Why a synthetic rig and not the CRX
 *
 * The defect is latent on the robot this repository ships: measured against the
 * FanucCRX-10iA-L, 0 of 150 solver results still violated a limit after the
 * replay's 360° unwrap had its turn, because that robot's axes are wide
 * (±360 on A6, ±180 on most of the rest) and almost any branch has an
 * admissible representation. It bites on TIGHT limits — the IRB's A3 runs
 * −60…+65 — so the rig here is built from exactly such a window. A test on the
 * CRX would be green by geometry, not by logic.
 *
 * ## What is asserted
 *
 * 1. The primitive (`limitRespectingAxisPosition`) leaves an admissible value
 *    UNCHANGED, shifts only a refused one, and reports `null` when no
 *    representation fits at all.
 * 2. `selectClosest` without the drives still picks the violating branch — the
 *    pre-Phase-5 behaviour, pinned so the gate is provably what changed.
 * 3. With the drives it picks the admissible branch, and returns `null` when
 *    every branch violates a limit.
 * 4. The replay's `unwrapAngleToReference` keeps its documented last-resort leak
 *    (returns the raw angle), because a baked Unity `AxisPos` outside the web
 *    rig's limits must still move the robot. The gate in front of it is the fix,
 *    not a change to that fallback.
 */

import { describe, it, expect } from 'vitest';
import { DriveDirection } from '../src/core/engine/rv-drive';
import {
  firstLimitViolation,
  limitFeasibleAngle,
  limitRespectingAxisPosition,
  unwrapAngleToReference,
  type AxisAngleDrive,
} from '../src/core/engine/rv-axis-angle-utils';
import { solutionsWithinLimits } from '../src/core/engine/rv-ik-solution-utils';
import { ikSolverRegistry, type IKSolution } from '../src/core/engine/rv-ik-solver';

/** One rotary axis with an explicit limit window (degrees), standing at `at`. */
function axis(lower: number, upper: number, at = 0): AxisAngleDrive {
  return {
    Direction: DriveDirection.RotationZ,
    UseLimits: true,
    LowerLimit: lower,
    UpperLimit: upper,
    currentPosition: at,
  };
}

/** An IRB-like rig: A3 is the tight one (−60…+65), the rest generous. */
function tightRig(): AxisAngleDrive[] {
  return [
    axis(-180, 180),
    axis(-100, 135),
    axis(-60, 65),
    axis(-200, 200),
    axis(-120, 120),
    axis(-400, 400),
  ];
}

function sol(angles: number[], reachable = true): IKSolution {
  return { angles, reachable };
}

describe('limitRespectingAxisPosition — the authoring question', () => {
  it('leaves a value the limits accept UNCHANGED (no gratuitous re-centering)', () => {
    // 170 is inside ±180 but far from the reference: the replay's unwrap would
    // move it to -190; the authoring primitive must not.
    const d = axis(-180, 180, -170);
    expect(limitRespectingAxisPosition(170, d)).toBe(170);
    // The replay's unwrap wants -190 for continuity and only lands back on 170
    // because the window refuses -190. The authoring primitive never asks.
    expect(unwrapAngleToReference(170, -170, d)).toBe(170);
  });

  it('passes everything through when the drive has no limits', () => {
    const free: AxisAngleDrive = {
      Direction: DriveDirection.RotationZ,
      UseLimits: false, LowerLimit: -10, UpperLimit: 10, currentPosition: 0,
    };
    expect(limitRespectingAxisPosition(999, free)).toBe(999);
  });

  it('shifts a refused value to the representation the limits allow', () => {
    // A3 = 350° is physically A3 = -10°, which the -60…+65 window allows.
    expect(limitRespectingAxisPosition(350, axis(-60, 65))).toBe(-10);
  });

  it('returns null when NO representation fits — a real joint-limit violation', () => {
    // 120° has no representation inside -60…+65 (120, -240, 480, …).
    expect(limitRespectingAxisPosition(120, axis(-60, 65))).toBeNull();
  });

  it('refuses a linear axis outright — it has only one representation', () => {
    const linear: AxisAngleDrive = {
      Direction: DriveDirection.LinearX,
      UseLimits: true, LowerLimit: 0, UpperLimit: 500, currentPosition: 0,
    };
    expect(limitRespectingAxisPosition(600, linear)).toBeNull();
    expect(limitRespectingAxisPosition(250, linear)).toBe(250);
  });

  it('names the first offending axis', () => {
    const rig = tightRig();
    expect(firstLimitViolation([0, 0, 30, 0, 0, 0], rig)).toBe(-1);
    expect(firstLimitViolation([0, 0, 120, 0, 0, 0], rig)).toBe(2);
    // Fewer drives than angles is not a violation — nothing constrains the rest.
    expect(firstLimitViolation([0, 0, 120], rig.slice(0, 2))).toBe(-1);
  });
});

describe('unwrapAngleToReference — the documented last-resort leak stays', () => {
  it('hands back the raw angle when the limits refuse every representation', () => {
    // This is the Restfall the TypeScript fix does NOT remove: a baked AxisPos
    // outside the rig's limits still drives, because refusing to move at all
    // would be worse than moving. The gate is in the SELECTION, in front of it.
    expect(unwrapAngleToReference(120, 0, { UseLimits: true, LowerLimit: -60, UpperLimit: 65 })).toBe(120);
    expect(limitFeasibleAngle(120, 0, { UseLimits: true, LowerLimit: -60, UpperLimit: 65 })).toBeNull();
  });
});

describe('solutionsWithinLimits — the discard is counted, never silent', () => {
  it('keeps the admissible configurations and reports what it dropped', () => {
    const rig = tightRig();
    const filtered = solutionsWithinLimits(
      [
        [0, 0, 30, 0, 0, 0],     // fine
        [0, 0, 120, 0, 0, 0],    // A3 out of -60…+65 in every turn
        [0, 0, 350, 0, 0, 0],    // A3 = -10 after one turn → fine
        [0, 170, 0, 0, 0, 0],    // A2 out of -100…+135
      ],
      rig,
    );
    expect(filtered.kept).toEqual([[0, 0, 30, 0, 0, 0], [0, 0, 350, 0, 0, 0]]);
    expect(filtered.rejected).toBe(2);
    expect(filtered.rejectedAxes).toEqual([1, 2]);
  });

  it('keeps everything when the rig has no limits', () => {
    const free = tightRig().map((d) => ({ ...d, UseLimits: false }));
    const filtered = solutionsWithinLimits([[0, 0, 120, 0, 0, 0]], free);
    expect(filtered.rejected).toBe(0);
    expect(filtered.kept.length).toBe(1);
  });
});

describe('selectClosest — joint limits are a hard gate, not a penalty', () => {
  /** The rig stands at A3 = 60°, near the top of its −60…+65 window. */
  function rigAtA3_60(): AxisAngleDrive[] {
    const rig = tightRig();
    rig[2] = axis(-60, 65, 60);
    return rig;
  }
  const reference = [0, 0, 60, 0, 0, 0];
  /**
   * Two branches, chosen so the metric and the limits DISAGREE: A3 = 95° is only
   * 35° from where the axis stands (and has no representation inside the window),
   * A3 = −55° is 115° away and admissible. A metric-only selection provably
   * prefers the one the rig cannot hold.
   */
  const near = [sol([0, 0, 95, 0, 0, 0]), sol([0, 0, -55, 0, 0, 0])];

  it('picks the violating branch when it is not given the drives (pre-Phase-5)', () => {
    expect(ikSolverRegistry.selectClosest(near, reference)).toEqual([0, 0, 95, 0, 0, 0]);
  });

  it('skips it and takes the admissible branch when the drives are passed', () => {
    expect(ikSolverRegistry.selectClosest(near, reference, rigAtA3_60()))
      .toEqual([0, 0, -55, 0, 0, 0]);
  });

  it('returns null when every reachable branch violates a limit', () => {
    const all = [sol([0, 0, 95, 0, 0, 0]), sol([0, 0, -150, 0, 0, 0])];
    expect(ikSolverRegistry.selectClosest(all, reference, rigAtA3_60())).toBeNull();
    // Without the gate the pose looked perfectly reachable — that was the bug.
    expect(ikSolverRegistry.selectClosest(all, reference)).not.toBeNull();
  });

  it('still skips geometrically unreachable branches, gate or no gate', () => {
    const mixed = [sol([0, 0, 10, 0, 0, 0], false), sol([0, 0, 20, 0, 0, 0])];
    expect(ikSolverRegistry.selectClosest(mixed, reference, rigAtA3_60()))
      .toEqual([0, 0, 20, 0, 0, 0]);
  });

  it('is unchanged for a rig whose limits are off — the wide-axis case', () => {
    const free = rigAtA3_60().map((d) => ({ ...d, UseLimits: false }));
    expect(ikSolverRegistry.selectClosest(near, reference, free))
      .toEqual(ikSolverRegistry.selectClosest(near, reference));
  });
});
