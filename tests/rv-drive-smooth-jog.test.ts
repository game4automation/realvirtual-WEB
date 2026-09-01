// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-drive-smooth-jog.test.ts — continuous jog on the REAL jerk-limited core
 * (plan-281 F5, §9.9).
 *
 * The core plans point-to-point profiles; an endless jog is a HOST policy on top
 * of it: arm a ±1e6 sentinel target, re-arm before the profile would brake, and
 * on release plan a braking profile from the state the drive is actually in
 * (plan-281 E4). This suite is what proves that policy — a held jog must not
 * decelerate on its own, and a released jog must coast to a stop instead of
 * snapping its velocity to zero.
 *
 * Also covers the signed-velocity contract TransportSurface depends on.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Group, Vector3 } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { DriveDirection, RVDrive } from '../src/core/engine/rv-drive';
import { smoothMotionRegistry } from '../src/core/engine/rv-smooth-motion-port';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
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

describe('RVDrive smooth jog', () => {
  it('ramps up to TargetSpeed and holds it (no self-deceleration)', (ctx) => {
    if (!requireCore(ctx)) return;
    const drive = smoothDrive();
    drive.jogForward = true;

    let peak = 0;
    for (let i = 0; i < 600; i++) {
      drive.update(DT);
      peak = Math.max(peak, drive.currentSpeed);
    }

    expect(peak).toBeLessThanOrEqual(500 + 1e-6);
    // Still at full speed after 10 s — the sentinel/re-arm policy works.
    expect(drive.currentSpeed).toBeCloseTo(500, 3);
    expect(drive.isRunning).toBe(true);
  });

  it('accelerates jerk-limited, not in a single acceleration step', (ctx) => {
    if (!requireCore(ctx)) return;
    const drive = smoothDrive();
    drive.jogForward = true;
    drive.update(DT);
    // The trapezoidal jog reaches a·dt = 3.33 mm/s on tick one.
    expect(drive.currentSpeed).toBeLessThan(3.0);
    expect(drive.currentSpeed).toBeGreaterThanOrEqual(0);
  });

  it('brakes smoothly on release — no velocity snap (F5)', (ctx) => {
    if (!requireCore(ctx)) return;
    const drive = smoothDrive();
    drive.jogForward = true;
    while (drive.currentSpeed < 500 - 1e-6) drive.update(DT);

    const releasePosition = drive.currentPosition;
    drive.jogForward = false;

    let previous = drive.currentSpeed;
    let maxDrop = 0;
    let ticks = 0;
    while (drive.currentSpeed !== 0 && ticks < 1000) {
      drive.update(DT);
      maxDrop = Math.max(maxDrop, previous - drive.currentSpeed);
      previous = drive.currentSpeed;
      ticks++;
    }

    // Physically: v²/2a = 625 mm plus the jerk margin — a genuine coast-down.
    expect(drive.currentPosition).toBeGreaterThan(releasePosition + 500);
    expect(drive.currentSpeed).toBe(0);
    expect(drive.isRunning).toBe(false);
    // One tick at amax = 200 mm/s² removes 3.33 mm/s; a snap to zero would be 500.
    expect(maxDrop).toBeLessThan(5);
  });

  it('reports SIGNED speed while jogging backward', (ctx) => {
    if (!requireCore(ctx)) return;
    const drive = smoothDrive();
    drive.jogBackward = true;
    for (let i = 0; i < 300; i++) drive.update(DT);

    expect(drive.currentSpeed).toBeCloseTo(-500, 3);
    expect(drive.currentPosition).toBeLessThan(0);
  });

  it('drives a TransportSurface at the signed jog speed', (ctx) => {
    if (!requireCore(ctx)) return;
    const drive = smoothDrive();
    drive.isTransportSurface = true;
    const surface = new RVTransportSurface(
      drive.node,
      AABB.fromHalfSize(drive.node, new Vector3(2.5, 0.1, 0.6)),
    );
    surface.drive = drive;

    drive.jogForward = true;
    for (let i = 0; i < 300; i++) drive.update(DT);
    expect(surface.speed).toBeCloseTo(500, 3);

    drive.jogForward = false;
    drive.jogBackward = true;
    for (let i = 0; i < 600; i++) drive.update(DT);
    expect(surface.speed).toBeCloseTo(-500, 3);
  });

  it('reverses direction without a discontinuity', (ctx) => {
    if (!requireCore(ctx)) return;
    const drive = smoothDrive();
    drive.jogForward = true;
    while (drive.currentSpeed < 400) drive.update(DT);

    drive.jogForward = false;
    drive.jogBackward = true;

    let previous = drive.currentSpeed;
    let maxDrop = 0;
    for (let i = 0; i < 600; i++) {
      drive.update(DT);
      maxDrop = Math.max(maxDrop, Math.abs(previous - drive.currentSpeed));
      previous = drive.currentSpeed;
    }
    expect(maxDrop).toBeLessThan(5);
    expect(drive.currentSpeed).toBeCloseTo(-500, 3);
  });

  it('stop() freezes the drive and parks the core', (ctx) => {
    if (!requireCore(ctx)) return;
    const drive = smoothDrive();
    drive.jogForward = true;
    while (drive.currentSpeed < 300) drive.update(DT);

    drive.stop();
    const frozen = drive.currentPosition;
    for (let i = 0; i < 30; i++) drive.update(DT);

    expect(drive.currentSpeed).toBe(0);
    expect(drive.currentPosition).toBe(frozen);
    expect(drive.isIdle).toBe(true);
  });

  it('scales the jog with the per-drive override (F7)', (ctx) => {
    if (!requireCore(ctx)) return;
    const drive = smoothDrive({ SpeedOverride: 0.4 });
    drive.jogForward = true;
    for (let i = 0; i < 900; i++) drive.update(DT);

    expect(drive.currentSpeed).toBeCloseTo(200, 3);
    expect(drive.smoothSnapshot.velocity).toBeCloseTo(500, 3);
  });

  it('re-uses one context across arm / release / re-arm cycles', (ctx) => {
    if (!requireCore(ctx)) return;
    const before = provider.liveContexts;
    const drive = smoothDrive();
    for (let cycle = 0; cycle < 5; cycle++) {
      drive.jogForward = true;
      for (let i = 0; i < 60; i++) drive.update(DT);
      drive.jogForward = false;
      for (let i = 0; i < 300; i++) drive.update(DT);
    }
    expect(provider.liveContexts).toBe(before + 1);
    expect(drive.currentSpeed).toBe(0);
  });
});
