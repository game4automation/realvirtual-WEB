// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-drive-smooth-ownership.test.ts — external authorities and context
 * lifetime under the REAL jerk-limited core (plan-281 §2.7, F12, Finding #3).
 *
 * Two failure modes this file exists for:
 *
 *  1. While something else owns the position — DrivesPlayback, a multiuser
 *     owner, a PLC feedback binding — the core is NOT advanced. The tick that
 *     hands control back must re-seed it from where the drive ACTUALLY is;
 *     resuming the old profile would teleport the drive to the position it
 *     would have reached had nothing interrupted it.
 *  2. A context lives in the wasm linear memory. Dropping the JavaScript object
 *     frees nothing, so a model reload that does not dispose its drives leaks
 *     one context per smooth drive, permanently, per reload.
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

function smoothDrive(track = true): RVDrive {
  const drive = new RVDrive(new Group());
  drive.Direction = DriveDirection.LinearX;
  drive.TargetSpeed = 500;
  drive.Acceleration = 200;
  drive.Jerk = 1000;
  drive.UseAcceleration = true;
  drive.SmoothAcceleration = true;
  drive.initDrive();
  if (track) openDrives.push(drive);
  return drive;
}

describe('positionOverwrite handover', () => {
  it('does not advance the core while an external authority writes the position', (ctx) => {
    if (!requireCore(ctx)) return;
    const drive = smoothDrive();
    drive.startMove(3000);
    for (let i = 0; i < 30; i++) drive.update(DT);
    const handoverElapsed = drive.smoothSnapshot.elapsed;

    drive.positionOverwrite = true;
    for (let i = 0; i < 60; i++) {
      drive.currentPosition += 1;         // the external authority
      drive.update(DT);
    }
    expect(drive.smoothSnapshot.elapsed).toBe(handoverElapsed);
  });

  it('resumes from the ACTUAL position, not from where the old profile would be', (ctx) => {
    if (!requireCore(ctx)) return;
    const drive = smoothDrive();
    drive.startMove(3000);
    for (let i = 0; i < 30; i++) drive.update(DT);

    drive.positionOverwrite = true;
    drive.currentPosition = 1200;         // a jump only the external owner knows about
    drive.update(DT);

    drive.positionOverwrite = false;
    drive.update(DT);

    // Continues from 1200 — a stale profile would have snapped back to ~60 mm.
    expect(drive.currentPosition).toBeGreaterThan(1199);
    expect(drive.currentPosition).toBeLessThan(1210);

    for (let i = 0; i < 3000 && drive.isRunning; i++) drive.update(DT);
    expect(drive.currentPosition).toBeCloseTo(3000, 6);
  });

  it('re-seeds after applySyncData from a remote owner', (ctx) => {
    if (!requireCore(ctx)) return;
    const drive = smoothDrive();
    drive.startMove(3000);
    for (let i = 0; i < 30; i++) drive.update(DT);

    drive.applySyncData(2000, 0);
    drive.update(DT);

    expect(drive.currentPosition).toBeGreaterThan(1999);
    expect(drive.currentPosition).toBeLessThan(2010);
  });

  it('re-seeds when ownership returns to the local client', (ctx) => {
    if (!requireCore(ctx)) return;
    const drive = smoothDrive();
    drive.startMove(3000);
    for (let i = 0; i < 30; i++) drive.update(DT);

    // Remote owner takes over, moves the drive, then hands it back.
    drive.isOwner = false;
    drive.applySyncData(500, 0);
    for (let i = 0; i < 30; i++) drive.update(DT);
    expect(drive.currentPosition).toBe(500);

    drive.isOwner = true;
    drive.onOwnershipChanged(true);
    drive.update(DT);
    expect(drive.currentPosition).toBeGreaterThan(499);
    expect(drive.currentPosition).toBeLessThan(510);

    for (let i = 0; i < 3000 && drive.isRunning; i++) drive.update(DT);
    expect(drive.currentPosition).toBeCloseTo(3000, 6);
  });

  it('resumes from a standstill, not from the interrupted velocity', (ctx) => {
    if (!requireCore(ctx)) return;
    const drive = smoothDrive();
    drive.startMove(3000);
    for (let i = 0; i < 120; i++) drive.update(DT);
    expect(drive.currentSpeed).toBeGreaterThan(300);

    drive.positionOverwrite = true;
    drive.update(DT);
    drive.positionOverwrite = false;
    drive.update(DT);

    // The external authority left the drive standing still; re-accelerating from
    // a phantom 400 mm/s would overshoot the target it now plans for.
    expect(drive.currentSpeed).toBeLessThan(10);
    for (let i = 0; i < 3000 && drive.isRunning; i++) drive.update(DT);
    expect(drive.currentPosition).toBeCloseTo(3000, 6);
  });
});

describe('context lifetime', () => {
  it('frees the context on dispose', (ctx) => {
    if (!requireCore(ctx)) return;
    const before = provider.liveContexts;
    const drive = smoothDrive(false);
    drive.startMove(1000);
    drive.update(DT);
    expect(provider.liveContexts).toBe(before + 1);

    drive.dispose();
    expect(provider.liveContexts).toBe(before);
  });

  it('does not leak across repeated model reloads', (ctx) => {
    if (!requireCore(ctx)) return;
    const before = provider.liveContexts;

    for (let reload = 0; reload < 5; reload++) {
      const model: RVDrive[] = [];
      for (let d = 0; d < 20; d++) {
        const drive = smoothDrive(false);
        drive.startMove(1000);
        drive.update(DT);
        model.push(drive);
      }
      expect(provider.liveContexts).toBe(before + 20);
      // What RVViewer.clearModel() does for the whole drive population.
      for (const drive of model) drive.dispose();
      expect(provider.liveContexts).toBe(before);
    }

    expect(provider.liveContexts).toBe(before);
  });

  it('survives a double dispose without double-counting the release', (ctx) => {
    if (!requireCore(ctx)) return;
    const before = provider.liveContexts;
    const drive = smoothDrive(false);
    drive.startMove(1000);
    drive.update(DT);

    drive.dispose();
    drive.dispose();
    drive.dispose();
    expect(provider.liveContexts).toBe(before);
  });

  it('keeps working after a dispose — a new command creates a fresh context', (ctx) => {
    if (!requireCore(ctx)) return;
    const drive = smoothDrive();
    drive.startMove(1000);
    drive.update(DT);
    drive.dispose();

    drive.startMove(800);
    for (let i = 0; i < 3000 && drive.isRunning; i++) drive.update(DT);
    // Precision 4 (< 50 nm), not 6: the fresh plan starts from a state with a
    // tiny residual velocity, and the core resolves such a profile to its
    // integrated endpoint rather than stamping the requested value (F2). The
    // resulting offset is ~7 nm — six orders of magnitude below the drive's own
    // 0.01 mm at-target threshold.
    expect(drive.currentPosition).toBeCloseTo(800, 4);
    expect(drive.isAtTarget).toBe(true);
  });
});
