// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { ribbonHarness } from './ribbon-fixture';
import type { RVRibbonWinder } from '../src/core/engine/rv-ribbon-winder';

const DT = 1 / 60;

describe('ribbon contact motion', () => {
  it.each(['Left', 'Right'] as const)('converts %s wrap in both running directions', (side) => {
    const sign = side === 'Left' ? 1 : -1;
    const h = ribbonHarness([
      { name: 'Nip', xMm: 0, yMm: 0, radiusMm: 100, side, driven: true },
      { name: 'Idler', xMm: 1000, yMm: 0, radiusMm: 100, side },
    ]);
    const path = h.buildPath();
    // The fixture commands raw shaft speed; the path converts it to web speed.
    h.drive.jog(sign * 600);
    h.step(DT);
    expect(path.sections[0].speed).toBeCloseTo(600, 6);
    expect(h.roller('Idler').angle).toBeCloseTo(sign * 6 * DT, 8);
    // Driven shafts are never rotated a second time by the ribbon path.
    expect(h.roller('Nip').angle).toBe(0);
    h.drive.jog(-sign * 600);
    h.step(DT);
    expect(path.sections[0].speed).toBeCloseTo(-600, 6);
    expect(h.roller('Idler').angle).toBeCloseTo(0, 8);
  });

  it('resolves Auto before sampling, including a changed contact side', () => {
    const h = ribbonHarness([
      { name: 'In', xMm: 0, yMm: 0, radiusMm: 50 },
      { name: 'Nip', xMm: 1000, yMm: 500, radiusMm: 100, driven: true, extras: { RibbonSide: 'Auto' } },
      { name: 'Out', xMm: 2000, yMm: 0, radiusMm: 50 },
    ]);
    const path = h.buildPath();
    h.drive.jog(-600);
    h.step(DT);
    expect(path.resolvedSideAt(1)).toBe(-1);
    expect(path.sections[0].speed).toBeCloseTo(600, 6);
    h.nodes.get('Nip')!.position.y = -0.5;
    h.step(DT);
    expect(path.resolvedSideAt(1)).toBe(1);
    expect(path.sections[0].speed).toBeCloseTo(-600, 6);
  });

  it('accounts for a roller axis opposite to the path axis', () => {
    const h = ribbonHarness([
      { name: 'Start', xMm: 0, yMm: 0, radiusMm: 100 },
      { name: 'Nip', xMm: 1000, yMm: 0, radiusMm: 100, driven: true },
      { name: 'Idler', xMm: 2000, yMm: 0, radiusMm: 100 },
    ]);
    h.nodes.get('Nip')!.rotation.x = Math.PI;
    h.nodes.get('Idler')!.rotation.x = Math.PI;
    const path = h.buildPath();
    h.drive.jog(-600);
    h.step(DT);
    expect(path.sections[0].speed).toBeCloseTo(600, 6);
    expect(h.roller('Idler').angle).toBeCloseTo(-6 * DT, 8);
    // In world space the follower nevertheless turns about +Z.
    const radial = new Vector3(1, 0, 0).applyQuaternion(h.nodes.get('Idler')!.quaternion);
    expect(radial.y).toBeGreaterThan(0);
  });

  it('combines Right wrap with an antiparallel drive axis', () => {
    const h = ribbonHarness([
      { name: 'Nip', xMm: 0, yMm: 0, radiusMm: 100, side: 'Right', driven: true, driveAxis: [0, 0, -1] },
      { name: 'End', xMm: 1000, yMm: 0, radiusMm: 100, side: 'Right' },
    ]);
    const path = h.buildPath();
    h.drive.jog(600);
    h.step(DT);
    expect(path.sections[0].speed).toBeCloseTo(600, 6);
  });

  it('turns a shared follower once and ignores obsolete manual sign corrections', () => {
    const h = ribbonHarness([
      { name: 'Nip', xMm: 0, yMm: 0, radiusMm: 100, driven: true },
      { name: 'End', xMm: 1000, yMm: 0, radiusMm: 100, extras: { RotationDirection: -1 } },
    ]);
    h.buildPath();
    h.addPath('Strip', ['Nip', 'End']);
    h.drive.jog(600);
    h.step(DT);
    expect(h.roller('End').angle).toBeCloseTo(6 * DT, 8);
  });

  it.each(['LineSpeed', 'Dancer'])('%s controls a Right-wrapped winder with negative shaft speed', (SpeedControl) => {
    const h = ribbonHarness([
      { name: 'Nip', xMm: 0, yMm: 0, radiusMm: 100, driven: true },
      { name: 'Dancer', xMm: 1000, yMm: 500, radiusMm: 60, dancer: true },
      { name: 'Reel', xMm: 2000, yMm: 0, radiusMm: 100, side: 'Right', winder: true, driven: true,
        extras: { SpeedControl, InitialWoundLengthMm: 0, CoreRadiusMm: 76.2 } },
    ]);
    h.buildPath();
    h.drive.jogRoller('Nip', 600);
    h.drive.follow('Reel');
    for (let i = 0; i < 120; i++) h.step(DT);
    const reel = h.roller('Reel') as unknown as RVRibbonWinder;
    expect(h.drive.driveOf('Reel')!.targetSpeed).toBeLessThan(0);
    expect(reel.surfaceSpeedMmPerS).toBeGreaterThan(0);
    expect(reel.woundLengthMm).toBeGreaterThan(500);
  });
});
