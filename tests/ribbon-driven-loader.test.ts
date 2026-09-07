// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-460 §9.2b — a REAL `RVDrive` on a roller node, built by the loader.
 *
 * The other integration tests use a `FakeDrive`, which proves the arithmetic but
 * not the wiring. This file constructs the drive the way `processExtras` does —
 * `constructComponentOnNode(deps, node, 'Drive', …)` on the SAME node that
 * carries the `RibbonRoller` extras — so the two things a fake cannot show are
 * covered:
 *
 * 1. the Unity `Direction` → glTF axis mapping (`RotationZ` points at glTF `-Z`,
 *    so a roller with `Axis: 'Z'` needs `ReverseDirection` to run forward), and
 * 2. that `driveOnNode()` is resolved from the registry on EVERY read: adding or
 *    removing a drive in the editor takes effect on the next tick, with no
 *    reload and no rebuild.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ribbonHarness, type RollerSpec } from './ribbon-fixture';
import { constructComponentOnNode } from '../src/core/engine/rv-scene-loader';
import type { RVDrive } from '../src/core/engine/rv-drive';

const DT = 1 / 60;

/** Unwinder — idler — nip — rewinder; no fixture drives at all. */
const LINE: RollerSpec[] = [
  { name: 'Unwinder', xMm: 0, yMm: 0, radiusMm: 400, winder: true },
  { name: 'Idler', xMm: 1200, yMm: 400, radiusMm: 60 },
  { name: 'Nip', xMm: 2400, yMm: 400, radiusMm: 80 },
  { name: 'Rewinder', xMm: 3600, yMm: 0, radiusMm: 100, winder: true },
];

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); });

/** The rv_extras a Unity export writes for a roller drive about the Z axis. */
function driveExtras(): Record<string, unknown> {
  return {
    Direction: 'RotationZ',
    // Unity's RotationZ maps to glTF -Z (rv-coordinate-utils), so the roller's
    // own +Z axis needs the reversal to turn the web forward.
    ReverseDirection: true,
    TargetSpeed: 360,
    Acceleration: 100000,
    StartPosition: 0,
  };
}

describe('a Drive and a RibbonRoller in one extras record', () => {
  it('makes the roller driven, and the drive — not the path — turns the node', () => {
    const h = ribbonHarness(LINE);
    const node = h.nodes.get('Nip')!;
    const path = h.buildPath();
    const drive = constructComponentOnNode(h.deps, node, 'Drive', driveExtras()) as RVDrive;
    expect(drive).toBeTruthy();
    expect(h.driveHost.drives).toContain(drive);
    // Both components ended up in ONE rv_extras record on ONE node, exactly as a
    // Unity export emits them — which is the shape this file exists to prove.
    const extras = node.userData.realvirtual as Record<string, unknown>;
    expect(extras.RibbonRoller).toBeTruthy();
    expect(extras.Drive).toBeTruthy();

    const nip = path.rollers[2];
    const quatBefore = nip.node.quaternion.clone();

    // First tick baselines the newly appeared drive; the second measures it.
    h.ribbonManager.update(DT);
    drive.currentPosition += 90 * DT;
    drive.applyToNode();
    h.ribbonManager.update(DT);

    expect(nip.isDriven).toBe(true);
    expect(nip.surfaceSpeedMmPerS).toBeCloseTo(((90 * Math.PI) / 180) * 80, 6);
    // The path never touched its angle...
    expect(nip.angle).toBe(0);
    // ...but the DRIVE did move the node.
    expect(nip.node.quaternion.angleTo(quatBefore)).toBeGreaterThan(0);
    // ...and the followers are running.
    expect(path.rollers[1].angle).toBeGreaterThan(0);
  });

  it('without ReverseDirection the Unity RotationZ mapping runs the web backwards', () => {
    const h = ribbonHarness(LINE);
    const path = h.buildPath();
    const drive = constructComponentOnNode(
      h.deps, h.nodes.get('Nip')!, 'Drive', { ...driveExtras(), ReverseDirection: false },
    ) as RVDrive;

    h.ribbonManager.update(DT);
    drive.currentPosition += 90 * DT;
    h.ribbonManager.update(DT);
    expect(path.rollers[2].surfaceSpeedMmPerS).toBeCloseTo(-((90 * Math.PI) / 180) * 80, 6);
  });

  it('adding a Drive to a follower makes it driven on the next tick; removing it makes it a follower again', () => {
    const h = ribbonHarness(LINE);
    const path = h.buildPath();
    const nip = path.rollers[2];

    // Before: nothing drives this web at all.
    h.ribbonManager.update(DT);
    expect(nip.isDriven).toBe(false);
    expect(path.sections[0].speed).toBe(0);

    // Editor: add the drive. No reload, no rebuild — the roller resolves it from
    // the registry on its very next read.
    const drive = constructComponentOnNode(h.deps, h.nodes.get('Nip')!, 'Drive', driveExtras()) as RVDrive;
    h.ribbonManager.update(DT);              // baselines the new drive
    expect(nip.isDriven).toBe(true);
    drive.currentPosition += 90 * DT;
    h.ribbonManager.update(DT);
    expect(path.sections[0].speed).toBeCloseTo(((90 * Math.PI) / 180) * 80, 6);
    const angleAfterDriven = path.rollers[1].angle;
    expect(angleAfterDriven).toBeGreaterThan(0);

    // Editor: remove it again. The roller falls back to being a follower, and
    // the path — now without any driven roller — stands still.
    h.registry.unregisterComponent('Drive', 'Root/Nip');
    h.ribbonManager.update(DT);
    expect(nip.isDriven).toBe(false);
    expect(path.sections[0].speed).toBe(0);
    expect(path.rollers[1].angle).toBe(angleAfterDriven);
    expect(warn.mock.calls.flat().join(' ')).toContain('has no driven roller');
  });

  it('a Drive on a WINDER node in the same record drives the web with R(t)', () => {
    const h = ribbonHarness(LINE);
    const path = h.buildPath();
    const drive = constructComponentOnNode(
      h.deps, h.nodes.get('Rewinder')!, 'Drive', driveExtras(),
    ) as RVDrive;
    const rewinder = path.winders[1];

    h.ribbonManager.update(DT);
    drive.currentPosition += 90 * DT;
    h.ribbonManager.update(DT);

    expect(rewinder.isDriven).toBe(true);
    expect(rewinder.surfaceSpeedMmPerS).toBeCloseTo(((90 * Math.PI) / 180) * 100, 6);
    // The roll grew by exactly that length in the same tick.
    expect(rewinder.woundLengthMm).toBeGreaterThan(0);
  });
});
