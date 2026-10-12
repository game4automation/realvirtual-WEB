// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-554 F3c — the read-only motion contract of RVDrive the cinematic motion blur reads:
 * `stepTravel` (signed distance / angle actually travelled in the last update, before any wrap,
 * several turns representable), `travelOdometer` (its running sum) and `discontinuityRev`
 * (incremented on every position change from OUTSIDE the motion integration: direct writes,
 * forced positions, resets — never on regular target / speed motion).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { DriveDirection, RVDrive, type IDriveBehavior } from '../src/core/engine/rv-drive';
import {
  SMOOTH_MOTION_ABI_VERSION, SMOOTH_OK, smoothMotionRegistry,
  type MotionSnapshot, type MotionState, type SmoothMotionProvider,
} from '../src/core/engine/rv-smooth-motion-port';

const DT = 1 / 60;

function drive(dir: DriveDirection, overrides: Partial<RVDrive> = {}): RVDrive {
  const d = new RVDrive(new Object3D());
  d.Direction = dir;
  Object.assign(d, overrides);
  d.initDrive();
  return d;
}

/** A constant-velocity stand-in for the smooth core (enough to reach the wrap). */
function constantVelocityCore(): SmoothMotionProvider {
  let pos = 0;
  let vel = 0;
  let vmax = 0;
  let elapsed = 0;
  const fill = (out: MotionSnapshot, target: number): void => {
    out.position = pos; out.velocity = vel; out.acceleration = 0; out.requestedTarget = target; out.effectiveTarget = target;
    out.duration = 1e9; out.elapsed = elapsed; out.decelerationStart = 1e9; out.phaseCount = 1; out.outcome = 0; out.finished = false; out.status = SMOOTH_OK;
  };
  return {
    abiVersion: SMOOTH_MOTION_ABI_VERSION,
    create: () => 1,
    destroy: () => { /* single context */ },
    configure: (_h, v) => { vmax = v; return SMOOTH_OK; },
    setState: (_h, s: MotionState) => { pos = s.position; vel = s.velocity; return SMOOTH_OK; },
    setTarget: (_h, target, _v, out) => { vel = Math.sign(target - pos) * vmax; elapsed = 0; fill(out, target); return SMOOTH_OK; },
    adjustDuration: () => SMOOTH_OK,
    stepInto: (_h, dt, ov, out) => { pos += vel * dt * ov; elapsed += dt; fill(out, out.requestedTarget); return SMOOTH_OK; },
    rebase: (_h, s) => { pos = s.position; vel = 0; return SMOOTH_OK; },
    shiftPosition: (_h, delta) => { pos += delta; return SMOOTH_OK; },
  };
}

afterEach(() => { smoothMotionRegistry.reset(); });

describe('stepTravel / travelOdometer (plan-554 F3c)', () => {
  it('regular positioning: the travel per step sums to the distance; no discontinuity', () => {
    const d = drive(DriveDirection.LinearX, { TargetSpeed: 600 });
    d.startMove(100);
    let sum = 0;
    for (let i = 0; i < 30; i++) { d.update(DT); sum += d.stepTravel; }
    expect(d.currentPosition).toBeCloseTo(100, 9);
    expect(sum).toBeCloseTo(100, 9);
    expect(d.travelOdometer).toBeCloseTo(100, 9);
    expect(d.discontinuityRev).toBe(0);
  });

  it('rotary jog: several turns in ONE step are representable; reverse is negative', () => {
    // 720° per 60 Hz step (no limits) — the position after the step equals the start modulo 360,
    // a matrix history could not tell the motion apart from standing still.
    const fwd = drive(DriveDirection.RotationY, { TargetSpeed: 720 * 60, JogForward: true });
    fwd.update(DT); // the jog integrates with the speed of the previous tick (Unity parity)
    fwd.update(DT);
    expect(fwd.stepTravel).toBeCloseTo(720, 9);
    const rev = drive(DriveDirection.RotationY, { TargetSpeed: 270 * 60, JogBackward: true });
    rev.update(DT);
    rev.update(DT);
    expect(rev.stepTravel).toBeCloseTo(-270, 9);
    expect(rev.travelOdometer).toBeCloseTo(-270, 9);
    expect(fwd.discontinuityRev + rev.discontinuityRev).toBe(0);
  });

  it('across a limit wrap the travel is the real step, not the jump to the other end', () => {
    smoothMotionRegistry.register(constantVelocityCore());
    const d = drive(DriveDirection.RotationZ, {
      TargetSpeed: 600, Acceleration: 1000, Jerk: 1000, UseAcceleration: true, SmoothAcceleration: true,
      UseLimits: true, LowerLimit: 0, UpperLimit: 360, JumpToLowerLimitOnUpperLimit: true, StartPosition: 345,
    });
    d.jogForward = true;
    const before = d.travelOdometer;
    let wrapped = false;
    for (let i = 0; i < 4; i++) {
      const p0 = d.currentPosition;
      d.update(DT);
      if (d.currentPosition < p0) {
        wrapped = true;
        expect(d.stepTravel).toBeCloseTo(10, 6); // 600 °/s × 1/60 s, not −350
      }
    }
    expect(wrapped).toBe(true);
    expect(d.travelOdometer - before).toBeCloseTo(40, 6);
    expect(d.discontinuityRev).toBe(0);
    d.dispose();
  });

  it('positions streamed in overwrite mode (playback, IK path) are motion', () => {
    const d = drive(DriveDirection.RotationY);
    d.positionOverwrite = true;
    for (let i = 1; i <= 3; i++) { d.currentPosition = i * 5; d.update(DT); }
    expect(d.stepTravel).toBeCloseTo(5, 9);
    expect(d.travelOdometer).toBeCloseTo(15, 9);
    expect(d.discontinuityRev).toBe(0);
  });

  it('a coupled behavior that does not claim the axis (Drive_Gear) moves it as motion', () => {
    const d = drive(DriveDirection.RotationY);
    const gear: IDriveBehavior = { update: () => { d.currentPosition += 3; d.applyToNode(); } };
    d.driveBehaviors.push(gear);
    d.update(DT);
    d.update(DT);
    expect(d.stepTravel).toBeCloseTo(3, 9);
    expect(d.discontinuityRev).toBe(0);
  });
});

describe('discontinuityRev (plan-554 F3c)', () => {
  it('increments on a direct currentPosition write between updates, not on the following motion', () => {
    const d = drive(DriveDirection.LinearX, { TargetSpeed: 600 });
    d.currentPosition = 50; // DES / cylinder homing / Erratic style
    d.update(DT);
    expect(d.discontinuityRev).toBe(1);
    expect(d.stepTravel).toBe(0);
    d.startMove(60);
    d.update(DT);
    expect(d.discontinuityRev).toBe(1);
    expect(d.stepTravel).toBeCloseTo(10, 9);
  });

  it('increments on a forced position (a behavior that claims the axis — Drive_FollowPosition)', () => {
    const d = drive(DriveDirection.RotationY);
    let target = 0;
    d.driveBehaviors.push({ update: () => { d.positionClaimedThisTick = true; target += 7; d.currentPosition = target; d.markBehaviorChanged(); } });
    d.update(DT);
    d.update(DT);
    expect(d.discontinuityRev).toBe(2);
    expect(d.stepTravel).toBe(0);
  });

  it('increments on reset(), applySyncData() and setPreviewPosition()', () => {
    const d = drive(DriveDirection.LinearX, { StartPosition: 0 });
    d.reset();
    expect(d.discontinuityRev).toBe(1);
    d.applySyncData(20, 0);
    expect(d.discontinuityRev).toBe(2);
    d.setPreviewPosition(30);
    expect(d.discontinuityRev).toBe(3);
    // already counted — the next update does not count the same jump twice
    d.update(DT);
    expect(d.discontinuityRev).toBe(3);
  });

  it('regular target / speed motion and jog never increment it', () => {
    const d = drive(DriveDirection.RotationY, { TargetSpeed: 90, JogForward: true });
    for (let i = 0; i < 20; i++) d.update(DT);
    d.jogForward = false;
    d.startMove(10);
    for (let i = 0; i < 60; i++) d.update(DT);
    expect(d.discontinuityRev).toBe(0);
  });
});
