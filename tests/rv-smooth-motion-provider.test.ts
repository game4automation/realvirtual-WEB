// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-smooth-motion-provider.test.ts — the PUBLIC smooth-motion port
 * (plan-281 §2.6, Phase 4).
 *
 * Covers the three things the AGPL side actually owns:
 *   1. the registry and its awaitable ready/failed gate (Finding #14),
 *   2. the fallback contract — no provider means the trapezoidal ramp keeps
 *      working, with exactly ONE degradation warning per model (G0.1),
 *   3. the host↔core protocol, via a recording fake provider: create once,
 *      configure with the drive's own limits, replan on a new command, one
 *      `stepInto` per tick into the drive's single reusable snapshot, and a
 *      `destroy` on teardown.
 *
 * No private import on purpose — this file must run in a community checkout,
 * which is exactly where the fallback contract matters.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Group } from 'three';
import { DriveDirection, RVDrive } from '../src/core/engine/rv-drive';
import {
  SMOOTH_MOTION_ABI_VERSION,
  SMOOTH_OK,
  createMotionSnapshot,
  hasWarnedSmoothMotionDegraded,
  resetSmoothMotionDegradation,
  smoothMotionRegistry,
  smoothStatusText,
} from '../src/core/engine/rv-smooth-motion-port';
import { FakeSmoothMotionProvider } from './_smooth-motion-fakes';

function makeSmoothDrive(provider?: FakeSmoothMotionProvider): RVDrive {
  if (provider) smoothMotionRegistry.register(provider);
  const drive = new RVDrive(new Group());
  drive.Direction = DriveDirection.LinearX;
  drive.TargetSpeed = 100;
  drive.Acceleration = 200;
  drive.Jerk = 1000;
  drive.UseAcceleration = true;
  drive.SmoothAcceleration = true;
  drive.initDrive();
  return drive;
}

beforeEach(() => {
  smoothMotionRegistry.reset();
  resetSmoothMotionDegradation();
});

afterEach(() => {
  smoothMotionRegistry.reset();
  resetSmoothMotionDegradation();
  vi.restoreAllMocks();
});

describe('smooth-motion registry', () => {
  it('starts empty and unavailable', () => {
    expect(smoothMotionRegistry.available).toBe(false);
    expect(smoothMotionRegistry.provider).toBeNull();
    expect(smoothMotionRegistry.abiVersion).toBe(0);
    expect(smoothMotionRegistry.state).toBe('idle');
  });

  it('publishes a registered provider and its ABI version', () => {
    const provider = new FakeSmoothMotionProvider();
    smoothMotionRegistry.register(provider);
    expect(smoothMotionRegistry.available).toBe(true);
    expect(smoothMotionRegistry.abiVersion).toBe(SMOOTH_MOTION_ABI_VERSION);
    expect(smoothMotionRegistry.provider).toBe(provider);
  });

  it('resolves whenReady() immediately in a build that never expects a provider', async () => {
    // The community build must not stall the boot sequence waiting for a
    // provider nobody is loading.
    await expect(smoothMotionRegistry.whenReady()).resolves.toBe(false);
  });

  it('holds whenReady() open between expect() and register()', async () => {
    smoothMotionRegistry.expect();
    expect(smoothMotionRegistry.state).toBe('pending');

    let settled: boolean | 'pending' = 'pending';
    const gate = smoothMotionRegistry.whenReady().then((ready) => { settled = ready; return ready; });
    // Not the same tick — a fire-and-forget registration would already read
    // "no provider" here and every drive would be stuck on the fallback.
    await Promise.resolve();
    expect(settled).toBe('pending');

    smoothMotionRegistry.register(new FakeSmoothMotionProvider());
    await expect(gate).resolves.toBe(true);
  });

  it('resolves whenReady() as false when the load fails, and keeps the reason', async () => {
    smoothMotionRegistry.expect();
    const gate = smoothMotionRegistry.whenReady();
    smoothMotionRegistry.fail('artifact-missing: not part of this build');
    await expect(gate).resolves.toBe(false);
    expect(smoothMotionRegistry.state).toBe('failed');
    expect(smoothMotionRegistry.failureDetail).toContain('artifact-missing');
    expect(smoothMotionRegistry.available).toBe(false);
  });

  it('maps every ABI status code to a readable text', () => {
    expect(smoothStatusText(SMOOTH_OK)).toBe('ok');
    expect(smoothStatusText(-1)).toContain('handle');
    expect(smoothStatusText(-3)).toContain('limits');
    expect(smoothStatusText(-100)).toContain('panic');
    expect(smoothStatusText(42)).toContain('unknown status 42');
  });
});

describe('fallback contract without a provider', () => {
  it('runs the trapezoidal ramp and reaches the target', () => {
    const drive = makeSmoothDrive();
    drive.startMove(100);
    for (let i = 0; i < 200; i++) drive.update(0.02);

    expect(drive.currentPosition).toBeCloseTo(100, 6);
    expect(drive.isRunning).toBe(false);
    // Trapezoidal, not smooth: no context was ever created.
    expect(drive.smoothActive).toBe(false);
  });

  it('warns exactly once per model, not once per drive and not per tick', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = makeSmoothDrive();
    const b = makeSmoothDrive();
    a.startMove(50);
    b.startMove(50);
    for (let i = 0; i < 10; i++) { a.update(0.02); b.update(0.02); }

    const degradations = warn.mock.calls.filter((c) => String(c[0]).includes('[smooth-motion]'));
    expect(degradations).toHaveLength(1);
    expect(String(degradations[0][0])).toContain('trapezoidal');
    expect(hasWarnedSmoothMotionDegraded()).toBe(true);
  });

  it('re-arms the warning for the next model', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const drive = makeSmoothDrive();
    drive.startMove(50);
    drive.update(0.02);
    resetSmoothMotionDegradation();          // what clearModel() does
    drive.update(0.02);

    expect(warn.mock.calls.filter((c) => String(c[0]).includes('[smooth-motion]'))).toHaveLength(2);
  });

  it('leaves non-smooth drives completely untouched', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const drive = makeSmoothDrive();
    drive.SmoothAcceleration = false;
    drive.startMove(100);
    for (let i = 0; i < 200; i++) drive.update(0.02);

    expect(drive.currentPosition).toBeCloseTo(100, 6);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('[smooth-motion]'))).toHaveLength(0);
  });
});

describe('host↔core protocol', () => {
  it('creates and configures exactly one context, with the drive\'s own limits', () => {
    const provider = new FakeSmoothMotionProvider();
    const drive = makeSmoothDrive(provider);
    drive.startMove(100);
    for (let i = 0; i < 5; i++) drive.update(0.02);

    expect(provider.opsOf('create')).toHaveLength(1);
    const configures = provider.opsOf('configure');
    expect(configures).toHaveLength(1);
    expect(configures[0].args).toEqual([100, 200, 1000]);
  });

  it('plans once per command and steps once per tick', () => {
    const provider = new FakeSmoothMotionProvider();
    const drive = makeSmoothDrive(provider);
    drive.startMove(100);
    for (let i = 0; i < 4; i++) drive.update(0.05);

    expect(provider.opsOf('setTarget')).toHaveLength(1);
    expect(provider.opsOf('setTarget')[0].args[0]).toBe(100);
    expect(provider.opsOf('stepInto')).toHaveLength(4);
    // Position/speed come from the core, not from any host integration.
    expect(drive.currentPosition).toBeCloseTo(20, 6);
    expect(drive.currentSpeed).toBeCloseTo(100, 6);
    expect(drive.smoothActive).toBe(true);
  });

  it('replans when a new destination is commanded mid-motion', () => {
    const provider = new FakeSmoothMotionProvider();
    const drive = makeSmoothDrive(provider);
    drive.startMove(100);
    drive.update(0.05);
    drive.startMove(40);
    drive.update(0.05);

    const targets = provider.opsOf('setTarget').map((c) => c.args[0]);
    expect(targets).toEqual([100, 40]);
    // The replan is seeded from the state the drive is actually in.
    const seeds = provider.opsOf('setState');
    expect(seeds[seeds.length - 1].args[0]).toBeCloseTo(5, 6);
  });

  it('multiplies the per-drive override with the global one (F7)', () => {
    const provider = new FakeSmoothMotionProvider();
    const drive = makeSmoothDrive(provider);
    drive.SpeedOverride = 0.5;
    drive.startMove(100);
    drive.update(0.1);

    // Only profile TIME is scaled — the limits pushed to configure stay nominal.
    expect(provider.opsOf('stepInto')[0].args).toEqual([0.1, 0.5]);
    expect(provider.opsOf('configure')[0].args[0]).toBe(100);
    expect(drive.currentPosition).toBeCloseTo(5, 6);
  });

  it('freezes without drift at override 0 and resumes without a jump', () => {
    const provider = new FakeSmoothMotionProvider();
    const drive = makeSmoothDrive(provider);
    drive.startMove(100);
    drive.update(0.1);
    const paused = drive.currentPosition;

    drive.SpeedOverride = 0;
    for (let i = 0; i < 20; i++) drive.update(0.1);
    expect(drive.currentPosition).toBeCloseTo(paused, 9);

    drive.SpeedOverride = 1;
    drive.update(0.1);
    expect(drive.currentPosition).toBeCloseTo(paused + 10, 6);
  });

  it('writes into ONE reusable snapshot object — no allocation per tick', () => {
    const provider = new FakeSmoothMotionProvider();
    const drive = makeSmoothDrive(provider);
    drive.startMove(100);
    drive.update(0.05);
    const snapshot = drive.smoothSnapshot;
    drive.update(0.05);

    expect(drive.smoothSnapshot).toBe(snapshot);
    expect(snapshot.position).toBeCloseTo(10, 6);
    expect(snapshot.status).toBe(SMOOTH_OK);
  });

  it('releases the context on dispose(), and dispose is idempotent', () => {
    const provider = new FakeSmoothMotionProvider();
    const drive = makeSmoothDrive(provider);
    drive.startMove(100);
    drive.update(0.05);
    expect(provider.liveContexts).toBe(1);

    drive.dispose();
    drive.dispose();
    expect(provider.liveContexts).toBe(0);
    expect(provider.destroyCount).toBe(1);
  });

  it('falls back to the trapezoidal ramp when the limits are rejected', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = new FakeSmoothMotionProvider();
    const drive = makeSmoothDrive(provider);
    drive.TargetSpeed = 0;               // not a valid vmax
    drive.startMove(100);
    for (let i = 0; i < 5; i++) drive.update(0.02);

    expect(provider.opsOf('setTarget')).toHaveLength(0);
    expect(drive.smoothActive).toBe(false);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('invalid limits'))).toBe(true);
    // The rejected context is freed rather than lingering unusable.
    expect(provider.liveContexts).toBe(0);
  });

  it('createMotionSnapshot() yields an independent, finished-by-default snapshot', () => {
    const a = createMotionSnapshot();
    const b = createMotionSnapshot();
    expect(a).not.toBe(b);
    expect(a.finished).toBe(true);
    expect(a.status).toBe(SMOOTH_OK);
  });
});
