// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * drive-des.test.ts — the generic drive-level DES motion primitive.
 *
 * Covers `driveMoveTime` (constant-speed |Δ|/speed with the division guards) and
 * `scheduleDriveMove` (schedules the completion hook after that time and builds a
 * {kind:'drive'} tween that writes the real drive). This is the single home for
 * DES move-timing shared by the turntable, conveyor and future RBG.
 */

import { describe, it, expect } from 'vitest';
import { driveMoveTime, scheduleDriveMove } from '../../src/behaviors/_shared/drive-des';

describe('drive-des — driveMoveTime (constant speed)', () => {
  it('|Δ|/speed', () => {
    expect(driveMoveTime(45, 0, 90)).toBeCloseTo(2, 6);     // 90° @ 45°/s = 2 s
    expect(driveMoveTime(1000, 0, 500)).toBeCloseTo(0.5, 6); // 500 mm @ 1000 mm/s
    expect(driveMoveTime(45, 90, 0)).toBeCloseTo(2, 6);      // sign-agnostic
  });
  it('zero Δ floors to 0.001 (no zero-time DES event)', () => {
    expect(driveMoveTime(45, 30, 30)).toBe(0.001);
  });
  it('zero/negative speed is guarded (finite, no divide-by-zero)', () => {
    expect(Number.isFinite(driveMoveTime(0, 0, 90))).toBe(true);
  });
});

describe('drive-des — scheduleDriveMove', () => {
  it('schedules the hook after |Δ|/speed and builds a drive tween that writes the drive', () => {
    const calls: Array<{ delay: number; hook: string; data: unknown }> = [];
    const self = { in: (delay: number, hook: string, _mu: unknown, data: unknown) => { calls.push({ delay, hook, data }); return calls.length; } };
    let applied = 0;
    const drive = { positionOverwrite: false, currentPosition: 0, applyToNode() { applied++; } };

    const dt = scheduleDriveMove(self, { drive, speed: 45, from: 0, to: 90 }, 'RotateComplete', null);

    expect(dt).toBeCloseTo(2, 6);
    expect(calls.length).toBe(1);
    expect(calls[0].hook).toBe('RotateComplete');
    expect(calls[0].delay).toBeCloseTo(2, 6);

    const spec = (calls[0].data as { tween: { kind: string; from: number; to: number; drive: { setPosition(v: number): void } } }).tween;
    expect(spec.kind).toBe('drive');
    expect(spec.from).toBe(0);
    expect(spec.to).toBe(90);
    // Driving the tween writes the REAL drive 1:1 (positionOverwrite + applyToNode).
    spec.drive.setPosition(45);
    expect(drive.positionOverwrite).toBe(true);
    expect(drive.currentPosition).toBe(45);
    expect(applied).toBe(1);
  });

  it('null drive → time-only (no tween payload)', () => {
    const calls: Array<{ data: unknown }> = [];
    const self = { in: (_d: number, _h: string, _mu: unknown, data: unknown) => { calls.push({ data }); return 1; } };
    scheduleDriveMove(self, { drive: null, speed: 45, from: 0, to: 90 }, 'MotionDone', null);
    expect(calls[0].data).toBeUndefined();
  });
});
