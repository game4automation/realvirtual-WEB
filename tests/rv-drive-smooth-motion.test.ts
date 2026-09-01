// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-drive-smooth-motion.test.ts — RVDrive point-to-point on the REAL
 * jerk-limited core (plan-281 Phase 4, §9.9).
 *
 * This suite deliberately runs against the shipped `rv_smooth_motion.wasm`
 * rather than a fake: the properties under test (limit compliance, the
 * reachability endpoint, exact arrival) are properties of the Rust core, and a
 * fake that reproduced them would be the second numeric truth the whole plan
 * exists to prevent. Following the `mechanism-wasm-abi` precedent, the file
 * skips LOUDLY when the artifact is not part of the build instead of passing.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Group } from 'three';
import { DriveDirection, RVDrive } from '../src/core/engine/rv-drive';
import {
  OUTCOME_STOPPED_AT_EARLIEST_REACHABLE,
  SMOOTH_MOTION_ABI_VERSION,
  smoothMotionRegistry,
} from '../src/core/engine/rv-smooth-motion-port';
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

/** Skip loudly when the artifact is not in this build. */
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
  drive.Direction = DriveDirection.LinearX;
  drive.TargetSpeed = 500;
  drive.Acceleration = 200;
  drive.Jerk = 1000;
  drive.UseAcceleration = true;
  drive.SmoothAcceleration = true;
  Object.assign(drive, overrides);
  drive.initDrive();
  openDrives.push(drive);
  return drive;
}

/** Tick until the drive stops, tracking the peak |speed|. Returns the tick count. */
function runToStop(drive: RVDrive, maxTicks = 3000): { ticks: number; peakSpeed: number } {
  let peakSpeed = 0;
  let ticks = 0;
  while (drive.isRunning && ticks < maxTicks) {
    drive.update(DT);
    peakSpeed = Math.max(peakSpeed, Math.abs(drive.currentSpeed));
    ticks++;
  }
  return { ticks, peakSpeed };
}

describe('smooth-motion core ABI gate', () => {
  it('loads the artifact and reports ABI version 1', (ctx) => {
    if (!requireCore(ctx)) return;
    expect(provider.available).toBe(true);
    expect(provider.abiVersion).toBe(SMOOTH_MOTION_ABI_VERSION);
    expect(smoothMotionRegistry.available).toBe(true);
  });

  it('refuses an artifact that is not part of the build', async () => {
    const absent = new WasmSmoothMotionProvider(null);
    await expect(absent.load()).resolves.toBe(false);
    expect(absent.failure).toBe('artifact-missing');
    expect(absent.available).toBe(false);
  });

  it('refuses a URL that does not resolve to a module', async () => {
    const broken = new WasmSmoothMotionProvider('/definitely-not-a-wasm-artifact.wasm');
    await expect(broken.load()).resolves.toBe(false);
    expect(['fetch-failed', 'instantiate-failed']).toContain(broken.failure);
    expect(broken.available).toBe(false);
  });
});

describe('RVDrive smooth point-to-point', () => {
  it('reaches the target exactly, without exceeding TargetSpeed (F1)', (ctx) => {
    if (!requireCore(ctx)) return;
    const drive = smoothDrive();
    drive.startMove(2000);
    const { peakSpeed } = runToStop(drive);

    expect(drive.currentPosition).toBeCloseTo(2000, 6);
    expect(drive.currentSpeed).toBe(0);
    expect(drive.isAtTarget).toBe(true);
    expect(drive.isRunning).toBe(false);
    expect(peakSpeed).toBeLessThanOrEqual(500 + 1e-6);
  });

  it('moves backward to a negative target just as exactly', (ctx) => {
    if (!requireCore(ctx)) return;
    const drive = smoothDrive();
    drive.startMove(-1500);
    const { peakSpeed } = runToStop(drive);

    expect(drive.currentPosition).toBeCloseTo(-1500, 6);
    expect(peakSpeed).toBeLessThanOrEqual(500 + 1e-6);
    // PTP reports an unsigned magnitude on BOTH paths — a backward move must not
    // flip the sign that DriveBehaviours and TransportSurface read.
    expect(drive.currentSpeed).toBe(0);
  });

  it('never reports a negative speed on a backward PTP move', (ctx) => {
    if (!requireCore(ctx)) return;
    const drive = smoothDrive();
    drive.startMove(-800);
    let minSpeed = 0;
    for (let i = 0; i < 400 && drive.isRunning; i++) {
      drive.update(DT);
      minSpeed = Math.min(minSpeed, drive.currentSpeed);
    }
    expect(minSpeed).toBe(0);
  });

  it('accelerates smoothly — no first-tick velocity step', (ctx) => {
    if (!requireCore(ctx)) return;
    const drive = smoothDrive();
    drive.startMove(2000);
    drive.update(DT);
    // A trapezoidal ramp would jump to a·dt = 3.33 mm/s in one tick; the
    // jerk-limited profile starts from zero acceleration, so it must be far less.
    expect(drive.currentSpeed).toBeLessThan(3.0);
    expect(drive.currentSpeed).toBeGreaterThan(0);
  });

  it('resolves a too-late redirect to the earliest reachable stop (F2/F4)', (ctx) => {
    if (!requireCore(ctx)) return;
    const drive = smoothDrive();
    drive.startMove(1000);
    while (drive.currentSpeed < 300) drive.update(DT);

    const requested = drive.currentPosition + 1;
    const before = drive.currentPosition;
    drive.startMove(requested);

    let movedBackward = false;
    let previous = before;
    let ticks = 0;
    while (drive.isRunning && ticks < 3000) {
      drive.update(DT);
      if (drive.currentPosition + 1e-9 < previous) movedBackward = true;
      previous = drive.currentPosition;
      ticks++;
    }

    // The requested endpoint is physically unreachable from 300 mm/s.
    expect(movedBackward).toBe(false);
    expect(drive.currentPosition).toBeGreaterThan(requested + 1);
    expect(drive.smoothEffectiveTarget).toBeGreaterThan(requested);
    expect(drive.smoothEffectiveTarget).toBeCloseTo(drive.currentPosition, 3);
    expect(drive.currentSpeed).toBe(0);
    // ... and at-target answers against the EFFECTIVE endpoint, so a waiting
    // logic step is not stranded at a position the drive can never leave.
    expect(drive.isAtTarget).toBe(true);
  });

  it('reports the reachability outcome in the snapshot', (ctx) => {
    if (!requireCore(ctx)) return;
    const drive = smoothDrive();
    drive.startMove(1000);
    while (drive.currentSpeed < 300) drive.update(DT);
    drive.startMove(drive.currentPosition + 1);
    drive.update(DT);

    expect(drive.smoothSnapshot.outcome).toBe(OUTCOME_STOPPED_AT_EARLIEST_REACHABLE);
    expect(drive.smoothSnapshot.effectiveTarget)
      .toBeGreaterThan(drive.smoothSnapshot.requestedTarget);
  });

  it('honours a reachable redirect exactly (no reachability inflation)', (ctx) => {
    if (!requireCore(ctx)) return;
    const drive = smoothDrive();
    drive.startMove(3000);
    while (drive.currentSpeed < 300) drive.update(DT);
    drive.startMove(2500);
    runToStop(drive);

    expect(drive.currentPosition).toBeCloseTo(2500, 6);
    expect(drive.smoothEffectiveTarget).toBeCloseTo(2500, 6);
  });

  it('is idempotent for a command that is already fulfilled', (ctx) => {
    if (!requireCore(ctx)) return;
    const drive = smoothDrive();
    drive.startMove(0);
    drive.update(DT);
    expect(drive.currentPosition).toBeCloseTo(0, 9);
    expect(drive.isRunning).toBe(false);
    expect(drive.isAtTarget).toBe(true);
  });

  it('slows the wall-clock but not the path when the override is halved (F7)', (ctx) => {
    if (!requireCore(ctx)) return;
    const full = smoothDrive();
    full.startMove(2000);
    const fullRun = runToStop(full);

    const half = smoothDrive({ SpeedOverride: 0.5 });
    half.startMove(2000);
    const halfRun = runToStop(half);

    expect(half.currentPosition).toBeCloseTo(2000, 6);
    // Twice the wall-clock ticks (±1 for the finish clamp) …
    expect(halfRun.ticks).toBeGreaterThan(fullRun.ticks * 2 - 3);
    expect(halfRun.ticks).toBeLessThan(fullRun.ticks * 2 + 3);
    // … at half the REPORTED speed. The core's own snapshot still carries the
    // unscaled nominal profile velocity — `currentSpeed` is the wall-clock one,
    // because that is what TransportSurface and the PLC feedback consume.
    expect(halfRun.peakSpeed).toBeGreaterThan(fullRun.peakSpeed * 0.45);
    expect(halfRun.peakSpeed).toBeLessThan(fullRun.peakSpeed * 0.55);
  });

  it('keeps the nominal profile velocity in the snapshot while currentSpeed is scaled', (ctx) => {
    if (!requireCore(ctx)) return;
    const drive = smoothDrive({ SpeedOverride: 0.5 });
    drive.startMove(3000);
    for (let i = 0; i < 400 && drive.currentSpeed < 240; i++) drive.update(DT);

    expect(drive.smoothSnapshot.velocity).toBeCloseTo(drive.currentSpeed * 2, 6);
    expect(drive.currentSpeed).toBeLessThanOrEqual(250 + 1e-6);
  });

  it('does not leak contexts across many commands on one drive', (ctx) => {
    if (!requireCore(ctx)) return;
    const before = provider.liveContexts;
    const drive = smoothDrive();
    for (let i = 0; i < 20; i++) {
      drive.startMove(100 * (i + 1));
      for (let t = 0; t < 20; t++) drive.update(DT);
    }
    expect(provider.liveContexts).toBe(before + 1);
    drive.dispose();
    expect(provider.liveContexts).toBe(before);
  });
});
