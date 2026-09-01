// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Drive_ErraticPosition must never pick a target outside the drive's travel
 * limits. An unclamped target deadlocks the axis forever: the drive clamps at
 * the limit, `destPos` is never reached within the 0.01 tolerance, and the
 * behavior waits for a position that cannot exist (live case 2026-08-22:
 * Autonox delta arm parked at +40° against an authored MaxPos above the limit).
 *
 * Contract pinned here:
 *   - random targets land inside [LowerLimit, UpperLimit] even when
 *     MinPos/MaxPos exceed the limits,
 *   - iterate mode toggles against the CLAMPED extremes (an out-of-limit
 *     MaxPos must not freeze the toggle),
 *   - a clamped target is actually reachable — arrival re-arms the next pick,
 *   - init() warns when the authored range exceeds the limits.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Group } from 'three';
import { RVDrive } from '../src/core/engine/rv-drive';
import { DriveDirection } from '../src/core/engine/rv-coordinate-utils';
import { RVErraticDriver } from '../src/core/engine/rv-erratic';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';

function makeDrive(opts?: Partial<Pick<RVDrive, 'UseLimits' | 'LowerLimit' | 'UpperLimit'>>): RVDrive {
  const node = new Group();
  node.name = 'Axis';
  const drive = new RVDrive(node);
  drive.Direction = DriveDirection.RotationY;
  drive.UseLimits = opts?.UseLimits ?? true;
  drive.LowerLimit = opts?.LowerLimit ?? -22;
  drive.UpperLimit = opts?.UpperLimit ?? 40;
  drive.initDrive();
  return drive;
}

function makeErratic(drive: RVDrive, fields: Partial<RVErraticDriver>): RVErraticDriver {
  const erratic = new RVErraticDriver(drive.node);
  Object.assign(erratic, fields);
  erratic.drive = drive;
  drive.driveBehaviors.push(erratic);
  return erratic;
}

/** Re-arm the pick loop as if the drive had arrived at its target. */
function arriveAtTarget(drive: RVDrive, erratic: RVErraticDriver): void {
  drive.currentPosition = drive.targetPosition;
  erratic.update(1 / 60); // arrival check flips `driving` off
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Drive_ErraticPosition target clamping', () => {
  it('clamps random targets into the drive limits when MinPos/MaxPos exceed them', () => {
    const drive = makeDrive();
    const erratic = makeErratic(drive, { MinPos: -30, MaxPos: 50, Speed: 60 });
    for (let i = 0; i < 200; i++) {
      erratic.update(1 / 60); // pick
      expect(drive.targetPosition).toBeGreaterThanOrEqual(drive.LowerLimit);
      expect(drive.targetPosition).toBeLessThanOrEqual(drive.UpperLimit);
      arriveAtTarget(drive, erratic); // re-arm the next pick
    }
  });

  it('leaves in-range targets untouched when UseLimits is off', () => {
    const drive = makeDrive({ UseLimits: false });
    const erratic = makeErratic(drive, { MinPos: -30, MaxPos: 50, Speed: 60 });
    for (let i = 0; i < 50; i++) {
      erratic.update(1 / 60);
      expect(drive.targetPosition).toBeGreaterThanOrEqual(-30);
      expect(drive.targetPosition).toBeLessThanOrEqual(50);
      arriveAtTarget(drive, erratic);
    }
  });

  it('iterate mode toggles between the CLAMPED extremes', () => {
    const drive = makeDrive();
    const erratic = makeErratic(drive, {
      MinPos: -30, MaxPos: 50, Speed: 60, IterateBetweenMaxAndMin: true,
    });
    // First pick: not at max → target = clamped max (40, not 50).
    erratic.update(1 / 60);
    expect(drive.targetPosition).toBe(40);
    // Arriving at the clamped max must flip the toggle to the clamped min —
    // before the fix the comparison ran against the unreachable authored 50
    // and the axis parked at 40 forever.
    arriveAtTarget(drive, erratic);
    erratic.update(1 / 60);
    expect(drive.targetPosition).toBe(-22);
    arriveAtTarget(drive, erratic);
    erratic.update(1 / 60);
    expect(drive.targetPosition).toBe(40);
  });

  it('every clamped target is reachable — arrival re-arms the next pick', () => {
    const drive = makeDrive();
    const erratic = makeErratic(drive, { MinPos: -30, MaxPos: 50, Speed: 60 });
    erratic.update(1 / 60);
    const first = drive.targetPosition;
    // The drive can actually reach the target (it lies inside the limits) …
    drive.currentPosition = first;
    erratic.update(1 / 60); // arrival
    erratic.update(1 / 60); // next pick — would never happen on a deadlocked axis
    // … and a new command was issued (target re-picked or re-armed).
    expect(drive.isRunning).toBe(true);
  });

  it('init() warns when the authored range exceeds the drive limits', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const drive = makeDrive();
    const erratic = new RVErraticDriver(drive.node);
    Object.assign(erratic, { MinPos: -30, MaxPos: 50, Speed: 60 });
    const context = {
      registry: { getByPath: () => drive },
      signalStore: null,
    } as unknown as ComponentContext;
    erratic.init(context);
    expect(warn.mock.calls.some(
      (args) => String(args[0]).includes('exceed the drive limits'),
    )).toBe(true);
  });

  it('init() stays silent when the range is inside the limits', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const drive = makeDrive();
    const erratic = new RVErraticDriver(drive.node);
    Object.assign(erratic, { MinPos: -20, MaxPos: 38, Speed: 60 });
    const context = {
      registry: { getByPath: () => drive },
      signalStore: null,
    } as unknown as ComponentContext;
    erratic.init(context);
    expect(warn.mock.calls.some(
      (args) => String(args[0]).includes('exceed the drive limits'),
    )).toBe(false);
  });
});
