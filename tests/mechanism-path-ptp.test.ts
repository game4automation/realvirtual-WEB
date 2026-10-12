// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-729 §9.2 — MechanismPath PTP segments and the branch-flip guard.
 *
 * PTP solves the waypoint ONCE at segment start (a continuation burst from the
 * current pose), then the drives run their own physics: the
 * speed goes in through `setLiveField('TargetSpeed', …)` (the only write path
 * that reaches config AND runtime value and invalidates the smooth core —
 * `startMove()` takes no speed), scaled so all axes arrive together. The
 * synchronisation is a v1 approximation (ramps), so arrival is asserted inside
 * a small tick band, not as exact simultaneity.
 *
 * Guarded: skips loudly without the kinematic wasm artifact.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Vector3 } from 'three';
import { RVMechanismPath } from '@rv-private/kinematic-mechanism/rv-mechanism-path';
import { releaseAllAxes } from '../src/core/engine/rv-axis-ownership';
import { setDriveSpeedOverride } from '../src/core/engine/rv-speed-override';
import { buildArmRig, requireRig, type PathRig } from './_mechanism-path-rig';

/** Allowed difference between the two axes' arrival ticks. */
const ARRIVAL_BAND_TICKS = 3;

let rig: PathRig | null = null;
const defaultJump = RVMechanismPath.maxJointJumpPerTick;

afterEach(() => {
  RVMechanismPath.maxJointJumpPerTick = defaultJump;
  rig?.dispose();
  rig = null;
  releaseAllAxes();
  vi.restoreAllMocks();
  setDriveSpeedOverride(1);
});

describe('plan-729 9.2 — RVMechanismPath (PTP)', () => {
  it('solves at segment start only, drives both axes via setLiveField + startMove and arrives in sync', async (ctx) => {
    rig = await buildArmRig({
      waypoints: [{ name: 'P', pos: [0.3, 0.7, 0], interp: 'PointToPoint' }],
      paths: [{ waypoints: ['P'] }],
      driveSpeed: 90,
      driveAccel: 5000,
    });
    if (!requireRig(ctx, rig)) return;
    const r = rig;
    const solver = r.mech.solverInstance!;
    const solveSpy = vi.spyOn(solver, 'solveInverse');
    const liveSpies = r.drives.map((d) => vi.spyOn(d, 'setLiveField'));
    const moveSpies = r.drives.map((d) => vi.spyOn(d, 'startMove'));

    r.path.startPath();
    // The waypoint is solved at segment start — a short continuation burst from
    // the current pose (a single far DLS call can stall in a local minimum) —
    // and NOT again while the drives move.
    const solvesAtStart = solveSpy.mock.calls.length;
    expect(solvesAtStart).toBeGreaterThan(0);
    for (let i = 0; i < 2; i++) {
      expect(liveSpies[i]).toHaveBeenCalledWith('TargetSpeed', expect.any(Number));
      expect(moveSpies[i]).toHaveBeenCalledTimes(1);
    }

    const arrival: number[] = [-1, -1];
    let tick = 0;
    const ticks = r.runUntil(() => r.path.PathIsFinished, 2000, () => {
      tick++;
      for (let i = 0; i < 2; i++) {
        if (arrival[i] < 0 && r.drives[i].isAtTarget) arrival[i] = tick;
      }
    });
    expect(ticks).toBeGreaterThan(0);
    expect(solveSpy).toHaveBeenCalledTimes(solvesAtStart);
    expect(arrival[0]).toBeGreaterThan(5);
    expect(arrival[1]).toBeGreaterThan(5);
    expect(Math.abs(arrival[0] - arrival[1])).toBeLessThanOrEqual(ARRIVAL_BAND_TICKS);
    // Cartesian residual — PTP lands exactly on the waypoint.
    expect(r.tip().distanceTo(new Vector3(0.3, 0.7, 0))).toBeLessThan(1e-3);
    // The authored drive speeds are back once the path let go.
    for (const d of r.drives) {
      expect(d.TargetSpeed).toBe(90);
      expect(d.targetSpeed).toBe(90);
    }
  });

  it('refuses an unreachable PTP waypoint on the spot (Reachable=false, no motion)', async (ctx) => {
    rig = await buildArmRig({
      waypoints: [{ name: 'Far', pos: [1.6, 0.0, 0], interp: 'PointToPoint' }],
      paths: [{ waypoints: ['Far'], signalEnded: 'Ended' }],
    });
    if (!requireRig(ctx, rig)) return;
    const r = rig;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = r.drives.map((d) => d.currentPosition);
    r.path.startPath();
    expect(r.path.PathIsActive).toBe(false);
    expect(r.path.PathFailed).toBe(true);
    expect(r.path.Reachable).toBe(false);
    expect(r.store.getBoolByPath(r.signal.Ended)).toBe(false);
    expect(err).toHaveBeenCalled();
    for (let i = 0; i < 10; i++) r.tick();
    expect(r.drives.map((d) => d.currentPosition)).toEqual(before);
  });

  it('mixes PTP and LIN waypoints in one path', async (ctx) => {
    rig = await buildArmRig({
      waypoints: [
        { name: 'P', pos: [0.5, 0.5, 0], interp: 'PointToPoint' },
        { name: 'L', pos: [0.3, 0.6, 0], interp: 'Linear' },
      ],
      paths: [{ waypoints: ['P', 'L'], linearSpeed: 300 }],
      driveAccel: 5000,
    });
    if (!requireRig(ctx, rig)) return;
    const r = rig;
    r.path.startPath();
    expect(r.runUntil(() => r.path.PathIsFinished, 3000)).toBeGreaterThan(0);
    expect(r.path.PathFailed).toBe(false);
    expect(r.tip().distanceTo(new Vector3(0.3, 0.6, 0))).toBeLessThan(1e-3);
  });

  it('follows the global drive speed override through the drives — arrives clearly earlier at 2, no double scaling', async (ctx) => {
    const run = async (factor: number): Promise<{ ticks: number; speeds: number[] } | null> => {
      setDriveSpeedOverride(factor);
      rig = await buildArmRig({
        waypoints: [{ name: 'P', pos: [0.3, 0.7, 0], interp: 'PointToPoint' }],
        paths: [{ waypoints: ['P'] }],
        driveSpeed: 90,
        driveAccel: 5000,
      });
      if (!requireRig(ctx, rig)) return null;
      const r = rig;
      const liveSpies = r.drives.map((d) => vi.spyOn(d, 'setLiveField'));
      r.path.startPath();
      // The TargetSpeed the path writes carries only the PATH override — the
      // drive multiplies the global factor in itself (RVDrive.update).
      const speeds = liveSpies.map((s) => s.mock.calls.find((c) => c[0] === 'TargetSpeed')![1] as number);
      const ticks = r.runUntil(() => r.path.PathIsFinished, 2000);
      expect(r.path.PathFailed).toBe(false);
      expect(r.tip().distanceTo(new Vector3(0.3, 0.7, 0))).toBeLessThan(1e-3);
      r.dispose();
      rig = null;
      releaseAllAxes();
      vi.restoreAllMocks();
      return { ticks, speeds };
    };
    const a = await run(1);
    if (!a) return;
    const b = (await run(2))!;
    expect(a.ticks).toBeGreaterThan(0);
    expect(b.ticks).toBeGreaterThan(0);
    for (let i = 0; i < 2; i++) expect(b.speeds[i]).toBeCloseTo(a.speeds[i], 9);
    // Ramps and the arrival poll add a few ticks — about half the time, inside a band.
    expect(b.ticks / a.ticks).toBeGreaterThan(0.4);
    expect(b.ticks / a.ticks).toBeLessThan(0.65);
  });

  it('stops on a joint jump above the per-tick limit (branch-flip guard)', async (ctx) => {
    rig = await buildArmRig({
      waypoints: [{ name: 'L', pos: [0.6, 0.3, 0] }],
      paths: [{ waypoints: ['L'], linearSpeed: 400 }],
    });
    if (!requireRig(ctx, rig)) return;
    const r = rig;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A normal LIN tick moves a joint a fraction of a degree; with the limit
    // squeezed far below that, the very first cruising tick reads as a flip.
    RVMechanismPath.maxJointJumpPerTick = 0.05;
    const before = r.drives.map((d) => d.currentPosition);
    r.path.startPath();
    const ticks = r.runUntil(() => !r.path.PathIsActive, 600);
    expect(ticks).toBeGreaterThan(0);
    expect(r.path.PathFailed).toBe(true);
    expect(r.path.Reachable).toBe(false);
    expect(r.path.LastError).toMatch(/jump/);
    expect(err).toHaveBeenCalled();
    // Checked BEFORE the write: the offending solution never reached the drives,
    // so the arm stopped a few small steps from where it started.
    for (let i = 0; i < 2; i++) {
      expect(Math.abs(r.drives[i].currentPosition - before[i])).toBeLessThan(2);
    }
  });
});
