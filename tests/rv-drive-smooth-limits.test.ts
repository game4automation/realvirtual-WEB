// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-drive-smooth-limits.test.ts — limits, wrap and reset under the REAL
 * jerk-limited core (plan-281 §2.7, F9, §9.9).
 *
 * The point of this file is the thing the old Unity code had a TODO for: the
 * core holds a profile ACROSS ticks, so every host-side position discontinuity
 * has to be told to it explicitly. A hard clamp must `rebase` (park the core at
 * the limit) and a wrap must `shiftPosition` (translate state, profile and
 * effective target together). Getting this wrong does not show up as a wrong
 * number on the tick it happens — it shows up as the drive silently continuing
 * an invisible internal profile and jumping later.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Group } from 'three';
import { DriveDirection, RVDrive } from '../src/core/engine/rv-drive';
import { smoothMotionRegistry } from '../src/core/engine/rv-smooth-motion-port';
import { WasmSmoothMotionProvider } from '@rv-private/smooth-motion/rv-smooth-motion-provider';
import { SMOOTH_MOTION_WASM_URL } from '@rv-private/smooth-motion/rv-smooth-motion-wasm-url';

const DT = 1 / 60;

let provider: WasmSmoothMotionProvider;
let loaded = false;
const openDrives: RVDrive[] = [];

beforeAll(async () => {
  provider = new WasmSmoothMotionProvider();
  loaded = await provider.load();
  if (loaded) smoothMotionRegistry.register(provider);
});

afterEach(() => {
  for (const drive of openDrives.splice(0)) drive.dispose();
});

afterAll(() => {
  smoothMotionRegistry.reset();
});

function requireCore(ctx: { skip: (note?: string) => void }): boolean {
  if (!loaded) {
    ctx.skip(
      `rv_smooth_motion.wasm unavailable (url=${SMOOTH_MOTION_WASM_URL ?? 'none'}, `
      + `${provider.failure}: ${provider.failureDetail})`,
    );
    return false;
  }
  return true;
}

function smoothDrive(overrides: Partial<RVDrive> = {}): RVDrive {
  const drive = new RVDrive(new Group());
  drive.Direction = DriveDirection.RotationZ;
  drive.TargetSpeed = 90;
  drive.Acceleration = 200;
  drive.Jerk = 1000;
  drive.UseAcceleration = true;
  drive.SmoothAcceleration = true;
  Object.assign(drive, overrides);
  drive.initDrive();
  openDrives.push(drive);
  return drive;
}

describe('smooth hard limits', () => {
  it('clamps a PTP move at the upper limit and parks the core there', (ctx) => {
    if (!requireCore(ctx)) return;
    const drive = smoothDrive({ UseLimits: true, LowerLimit: 0, UpperLimit: 100 });
    drive.startMove(500);

    let escaped = false;
    for (let i = 0; i < 600; i++) {
      drive.update(DT);
      if (drive.currentPosition > 100.0001 || drive.currentPosition < -0.0001) escaped = true;
    }

    expect(escaped).toBe(false);
    expect(drive.currentPosition).toBeCloseTo(100, 9);
    expect(drive.currentSpeed).toBe(0);
    expect(drive.isRunning).toBe(false);
    // Parked, not merely clipped: another 200 ticks must not move it a micron.
    const parked = drive.currentPosition;
    for (let i = 0; i < 200; i++) drive.update(DT);
    expect(drive.currentPosition).toBe(parked);
  });

  it('clamps at the lower limit for a backward move', (ctx) => {
    if (!requireCore(ctx)) return;
    const drive = smoothDrive({ UseLimits: true, LowerLimit: -40, UpperLimit: 100, StartPosition: 50 });
    drive.startMove(-500);
    for (let i = 0; i < 600; i++) drive.update(DT);

    expect(drive.currentPosition).toBeCloseTo(-40, 9);
    expect(drive.currentSpeed).toBe(0);
  });

  it('parks a jog against a limit without oscillating or re-arming into it', (ctx) => {
    if (!requireCore(ctx)) return;
    const drive = smoothDrive({ UseLimits: true, LowerLimit: 0, UpperLimit: 100 });
    drive.jogForward = true;

    let escaped = false;
    for (let i = 0; i < 600; i++) {
      drive.update(DT);
      if (drive.currentPosition > 100.0001) escaped = true;
    }
    expect(escaped).toBe(false);
    expect(drive.currentPosition).toBeCloseTo(100, 9);
    expect(drive.currentSpeed).toBe(0);

    // Releasing and jogging the other way must work again from the limit.
    drive.jogForward = false;
    drive.jogBackward = true;
    // Half a second only — the range is 100°, so a longer run would simply park
    // the drive against the LOWER limit and the assertion would test nothing.
    for (let i = 0; i < 30; i++) drive.update(DT);
    expect(drive.currentPosition).toBeLessThan(100);
    expect(drive.currentSpeed).toBeLessThan(0);
  });

  it('handles an asymmetric, non-zero-based limit range', (ctx) => {
    if (!requireCore(ctx)) return;
    const drive = smoothDrive({ UseLimits: true, LowerLimit: -250, UpperLimit: -30, StartPosition: -100 });
    drive.startMove(500);
    for (let i = 0; i < 600; i++) drive.update(DT);
    expect(drive.currentPosition).toBeCloseTo(-30, 9);
  });
});

describe('smooth wrap-around (JumpToLowerLimitOnUpperLimit)', () => {
  it('wraps forward and keeps moving without a speed discontinuity', (ctx) => {
    if (!requireCore(ctx)) return;
    const drive = smoothDrive({
      UseLimits: true, LowerLimit: 0, UpperLimit: 100,
      JumpToLowerLimitOnUpperLimit: true, StartPosition: 90,
    });
    drive.jogForward = true;

    let wraps = 0;
    let previous = drive.currentPosition;
    let maxSpeedDrop = 0;
    let previousSpeed = 0;
    let escaped = false;
    for (let i = 0; i < 900; i++) {
      drive.update(DT);
      if (drive.currentPosition < previous - 50) wraps++;
      if (drive.currentPosition < -1e-9 || drive.currentPosition > 100 + 1e-9) escaped = true;
      if (i > 120) maxSpeedDrop = Math.max(maxSpeedDrop, Math.abs(previousSpeed - drive.currentSpeed));
      previous = drive.currentPosition;
      previousSpeed = drive.currentSpeed;
    }

    expect(wraps).toBeGreaterThanOrEqual(10);
    expect(escaped).toBe(false);
    // The profile is shifted WITH the state, so the seam is invisible in v.
    expect(maxSpeedDrop).toBeLessThan(1e-6);
    expect(drive.currentSpeed).toBeCloseTo(90, 6);
  });

  it('wraps backward as well', (ctx) => {
    if (!requireCore(ctx)) return;
    const drive = smoothDrive({
      UseLimits: true, LowerLimit: 0, UpperLimit: 100,
      JumpToLowerLimitOnUpperLimit: true, StartPosition: 10,
    });
    drive.jogBackward = true;

    let wraps = 0;
    let previous = drive.currentPosition;
    let escaped = false;
    for (let i = 0; i < 900; i++) {
      drive.update(DT);
      if (drive.currentPosition > previous + 50) wraps++;
      if (drive.currentPosition < -1e-9 || drive.currentPosition > 100 + 1e-9) escaped = true;
      previous = drive.currentPosition;
    }
    expect(wraps).toBeGreaterThanOrEqual(10);
    expect(escaped).toBe(false);
    expect(drive.currentSpeed).toBeCloseTo(-90, 6);
  });

  it('brakes correctly after a wrap — profile and state stayed together', (ctx) => {
    if (!requireCore(ctx)) return;
    const drive = smoothDrive({
      UseLimits: true, LowerLimit: 0, UpperLimit: 100,
      JumpToLowerLimitOnUpperLimit: true, StartPosition: 90,
    });
    drive.jogForward = true;
    // Cross the seam at least once before releasing.
    let previous = drive.currentPosition;
    let wrapped = false;
    for (let i = 0; i < 900 && !wrapped; i++) {
      drive.update(DT);
      if (drive.currentPosition < previous - 50) wrapped = true;
      previous = drive.currentPosition;
    }
    expect(wrapped).toBe(true);

    drive.jogForward = false;
    let escaped = false;
    for (let i = 0; i < 600; i++) {
      drive.update(DT);
      if (drive.currentPosition < -1e-9 || drive.currentPosition > 100 + 1e-9) escaped = true;
    }
    expect(escaped).toBe(false);
    expect(drive.currentSpeed).toBe(0);
    expect(drive.isRunning).toBe(false);
  });

  it('wraps an asymmetric range around its own span', (ctx) => {
    if (!requireCore(ctx)) return;
    const drive = smoothDrive({
      UseLimits: true, LowerLimit: -180, UpperLimit: 180,
      JumpToLowerLimitOnUpperLimit: true, StartPosition: 170,
    });
    drive.jogForward = true;
    for (let i = 0; i < 300; i++) drive.update(DT);
    expect(drive.currentPosition).toBeGreaterThanOrEqual(-180);
    expect(drive.currentPosition).toBeLessThanOrEqual(180);
    expect(drive.currentSpeed).toBeCloseTo(90, 6);
  });
});

describe('smooth reset', () => {
  it('returns to StartPosition and stops the core profile', (ctx) => {
    if (!requireCore(ctx)) return;
    const drive = smoothDrive({ StartPosition: 25 });
    drive.startMove(500);
    for (let i = 0; i < 60; i++) drive.update(DT);
    expect(drive.currentPosition).toBeGreaterThan(25);

    drive.reset();
    expect(drive.currentPosition).toBe(25);
    expect(drive.currentSpeed).toBe(0);

    // The core must be parked too: without the rebase it would keep playing the
    // old profile and jump forward on the very next command tick.
    for (let i = 0; i < 30; i++) drive.update(DT);
    expect(drive.currentPosition).toBe(25);
  });

  it('runs correctly again after a reset', (ctx) => {
    if (!requireCore(ctx)) return;
    const drive = smoothDrive({ StartPosition: 0 });
    drive.startMove(200);
    for (let i = 0; i < 60; i++) drive.update(DT);
    drive.reset();

    drive.startMove(150);
    for (let i = 0; i < 900 && drive.isRunning; i++) drive.update(DT);
    expect(drive.currentPosition).toBeCloseTo(150, 6);
    expect(drive.isAtTarget).toBe(true);
  });

  it('keeps its context across a reset instead of churning handles', (ctx) => {
    if (!requireCore(ctx)) return;
    const before = provider.liveContexts;
    const drive = smoothDrive();
    drive.startMove(200);
    drive.update(DT);
    for (let i = 0; i < 10; i++) drive.reset();
    expect(provider.liveContexts).toBe(before + 1);
  });
});
