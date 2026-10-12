// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-729 §9.1 — MechanismPath: LIN segments, profile, sequencing, failure path.
 *
 * Integration with the REAL kinematic wasm: the path solves the mechanism
 * inversely every tick, the drives carry the values, the forward solve poses
 * the links, and the assertions read the resulting CARTESIAN pose of the target
 * link — never the joint values (with redundancy several joint vectors reach
 * one point; the residual is the criterion, SOL finding 8 of plan-404).
 *
 * Guarded: every solver case skips loudly without the artifact (`requireRig`).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Object3D, Scene, Vector3 } from 'three';
import {
  RVMechanismPath,
  RVMechanismPathStep,
  buildMechanismPathStep,
} from '@rv-private/kinematic-mechanism/rv-mechanism-path';
import { StepState, type RVSerialContainer } from '../src/core/engine/rv-logic-step';
import { RVLogicEngine } from '../src/core/engine/rv-logic-engine';
import { registerLogicStepBuilder } from '../src/core/engine/rv-logic-step-registry';
import { applySchema, type ComponentContext } from '../src/core/engine/rv-component-registry';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { SignalReapplyRegistry } from '../src/core/engine/rv-signal-reapply-registry';
import { claimAxes, releaseAllAxes, releaseAxes } from '../src/core/engine/rv-axis-ownership';
import { setDriveSpeedOverride } from '../src/core/engine/rv-speed-override';
import {
  DT,
  buildArmRig,
  distanceToLine,
  requireRig,
  type PathRig,
} from './_mechanism-path-rig';

let rig: PathRig | null = null;

afterEach(() => {
  rig?.dispose();
  rig = null;
  releaseAllAxes();
  vi.restoreAllMocks();
  setDriveSpeedOverride(1);
});

describe('plan-729 9.1 — RVMechanismPath (LIN)', () => {
  it('drives the target link along a LIN segment and finishes', async (ctx) => {
    rig = await buildArmRig({
      waypoints: [{ name: 'WP1', pos: [0.6, 0.3, 0] }],
      paths: [{ waypoints: ['WP1'], linearSpeed: 200, linearAccel: 1000 }],
    });
    if (!requireRig(ctx, rig)) return;
    const r = rig;
    const start = r.tip(new Vector3());
    const end = new Vector3(0.6, 0.3, 0);

    r.path.startPath();
    expect(r.path.PathIsActive).toBe(true);
    let maxLineDev = 0;
    const ticks = r.runUntil(() => r.path.PathIsFinished, 1000, () => {
      maxLineDev = Math.max(maxLineDev, distanceToLine(r.tip(), start, end));
    });

    expect(ticks).toBeGreaterThan(0);
    expect(r.path.PathFailed).toBe(false);
    expect(r.path.Reachable).toBe(true);
    // Cartesian residual at the waypoint — the acceptance criterion.
    expect(r.tip().distanceTo(end)).toBeLessThan(1e-3);
    // A straight line, not a joint-space arc: < 1 mm off the line all the way.
    expect(maxLineDev).toBeLessThan(1e-3);
    // The drives are released again after the path.
    expect(r.path.getLiveState().OwnershipPaused).toBe(false);
  });

  it('ramps speed with trapezoid profile (never exceeds LinearSpeedToTarget)', async (ctx) => {
    rig = await buildArmRig({
      waypoints: [{ name: 'WP1', pos: [0.3, 0.6, 0] }],
      paths: [{ waypoints: ['WP1'], linearSpeed: 300, linearAccel: 1500 }],
    });
    if (!requireRig(ctx, rig)) return;
    const r = rig;
    const prev = r.tip(new Vector3());
    const speeds: number[] = [];
    r.path.startPath();
    const ticks = r.runUntil(() => r.path.PathIsFinished, 1000, () => {
      const cur = r.tip();
      speeds.push((cur.distanceTo(prev) / DT) * 1000); // mm/s, measured on the link
      prev.copy(cur);
    });
    expect(ticks).toBeGreaterThan(0);

    const peakCommanded = r.path.peakPathSpeedMmS;
    // Segment ≈ 0.94 m, braking distance 300²/(2·1500) = 30 mm → a real plateau.
    expect(peakCommanded).toBeLessThanOrEqual(300 + 1e-6);
    expect(peakCommanded).toBeGreaterThan(299);
    // The link itself obeys the limit too (small numeric slack for the solve).
    expect(Math.max(...speeds)).toBeLessThan(300 * 1.03);
    // Ramp-up: the first ticks are clearly slower than the plateau.
    expect(speeds[0]).toBeLessThan(100);
  });

  it('degenerates to a triangle profile when the segment is shorter than the braking distance', async (ctx) => {
    rig = await buildArmRig({
      // 20 mm segment; vmax 500 mm/s would need 2·125 mm to ramp up and down.
      waypoints: [{ name: 'WP1', pos: [0.78, 0, 0] }],
      paths: [{ waypoints: ['WP1'], linearSpeed: 500, linearAccel: 1000 }],
    });
    if (!requireRig(ctx, rig)) return;
    const r = rig;
    r.path.startPath();
    const ticks = r.runUntil(() => r.path.PathIsFinished, 600);
    expect(ticks).toBeGreaterThan(0);
    // v_peak = sqrt(a·d) = sqrt(1000·20) ≈ 141 mm/s — far below the limit.
    expect(r.path.peakPathSpeedMmS).toBeLessThan(200);
    expect(r.path.peakPathSpeedMmS).toBeGreaterThan(80);
    expect(r.tip().distanceTo(new Vector3(0.78, 0, 0))).toBeLessThan(1e-3);
  });

  it('stops with Reachable=false on an unreachable waypoint and does not set SignalEnded', async (ctx) => {
    rig = await buildArmRig({
      // Outside the 1 m annulus.
      waypoints: [{ name: 'Far', pos: [2.0, 0.2, 0] }],
      paths: [{ waypoints: ['Far'], linearSpeed: 400, signalEnded: 'Ended', signalIsStarted: 'Running' }],
    });
    if (!requireRig(ctx, rig)) return;
    const r = rig;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    r.path.startPath();
    expect(r.store.getBoolByPath(r.signal.Running)).toBe(true);
    const ticks = r.runUntil(() => !r.path.PathIsActive, 2000);

    expect(ticks).toBeGreaterThan(0);
    expect(r.path.PathFailed).toBe(true);
    expect(r.path.Reachable).toBe(false);
    expect(r.path.PathIsFinished).toBe(false);
    expect(r.path.LastError).not.toBe('');
    expect(r.store.getBoolByPath(r.signal.Ended)).toBe(false);
    expect(r.store.getBoolByPath(r.signal.Running)).toBe(false);
    expect(err).toHaveBeenCalled();
    // Hard stop, not a clamp: the tip stayed inside the workspace.
    expect(r.tip().length()).toBeLessThanOrEqual(1.0 + 1e-3);
  });

  it('loops when LoopPath is set and honors WaitForSeconds dwell', async (ctx) => {
    rig = await buildArmRig({
      waypoints: [
        { name: 'A', pos: [0.7, 0.2, 0], wait: 0.5, setSignal: 'AtA' },
        { name: 'B', pos: [0.6, 0.35, 0] },
      ],
      paths: [{ waypoints: ['A', 'B'], loop: true, linearSpeed: 400, linearAccel: 2000 }],
    });
    if (!requireRig(ctx, rig)) return;
    const r = rig;
    const atA = r.signal.AtA;
    const rises: number[] = [];
    const falls: number[] = [];
    let tick = 0;
    let last = false;
    r.path.startPath();
    r.runUntil(() => rises.length >= 3, 3000, () => {
      tick++;
      const v = r.store.getBoolByPath(atA);
      if (v && !last) rises.push(tick);
      if (!v && last) falls.push(tick);
      last = v;
    });

    // Three arrivals at A → the path looped at least twice.
    expect(rises.length).toBe(3);
    expect(r.path.PathIsActive).toBe(true);
    // Dwell: SetSignal drops only when the path LEAVES A, ≥ 0.5 s later.
    expect(falls.length).toBeGreaterThanOrEqual(1);
    expect(falls[0] - rises[0]).toBeGreaterThanOrEqual(Math.floor(0.5 / DT) - 1);
  });

  it('chains StartNextPath after SignalEnded', async (ctx) => {
    rig = await buildArmRig({
      waypoints: [
        { name: 'A', pos: [0.7, 0.2, 0] },
        { name: 'B', pos: [0.5, 0.4, 0] },
      ],
      paths: [
        { name: 'First', waypoints: ['A'], startNext: 'Second', signalEnded: 'FirstEnded' },
        { name: 'Second', waypoints: ['B'] },
      ],
    });
    if (!requireRig(ctx, rig)) return;
    const r = rig;
    const first = r.paths.First;
    const second = r.paths.Second;
    first.startPath();
    expect(r.runUntil(() => first.PathIsFinished, 1500)).toBeGreaterThan(0);
    expect(r.store.getBoolByPath(r.signal.FirstEnded)).toBe(true);
    // Started in the same tick the first one ended.
    expect(second.PathIsActive).toBe(true);
    expect(r.runUntil(() => second.PathIsFinished, 1500)).toBeGreaterThan(0);
    expect(r.tip().distanceTo(new Vector3(0.5, 0.4, 0))).toBeLessThan(1e-3);
  });

  it('does not start while its drives are foreign-owned (axis ownership) and resumes after release', async (ctx) => {
    rig = await buildArmRig({
      waypoints: [{ name: 'WP1', pos: [0.6, 0.3, 0] }],
      paths: [{ waypoints: ['WP1'] }],
    });
    if (!requireRig(ctx, rig)) return;
    const r = rig;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    claimAxes(r.drives, 'DES');
    const before = r.tip(new Vector3());
    r.path.startPath();
    for (let i = 0; i < 20; i++) r.tick();
    expect(r.path.PathIsActive).toBe(false);
    expect(r.path.getLiveState().OwnershipPaused).toBe(true);
    expect(r.tip().distanceTo(before)).toBeLessThan(1e-9);

    releaseAxes('DES');
    const ticks = r.runUntil(() => r.path.PathIsFinished, 1500);
    expect(ticks).toBeGreaterThan(0);
    expect(r.tip().distanceTo(new Vector3(0.6, 0.3, 0))).toBeLessThan(1e-3);
    warn.mockRestore();
  });

  it('suspends a KinematicTarget on the same drives while the path runs', async (ctx) => {
    rig = await buildArmRig({
      waypoints: [{ name: 'WP1', pos: [0.6, 0.3, 0] }],
      paths: [{ waypoints: ['WP1'] }],
      withKinematicTarget: true,
    });
    if (!requireRig(ctx, rig)) return;
    const r = rig;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The target sits at the home tip and tracks — it would pin the arm there.
    r.kinematicTarget!.TrackingActive = true;
    const home = new Vector3(0.8, 0, 0);
    const wp = new Vector3(0.6, 0.3, 0);
    r.path.startPath();
    let maxLineDev = 0;
    let closest = Infinity;
    const ticks = r.runUntil(() => !r.path.PathIsActive, 1500, () => {
      if (!r.path.PathIsActive) return; // the tick the path let go is the target's again
      const tip = r.tip();
      maxLineDev = Math.max(maxLineDev, distanceToLine(tip, home, wp));
      closest = Math.min(closest, tip.distanceTo(wp));
    });
    expect(ticks).toBeGreaterThan(0);
    expect(r.path.PathIsFinished).toBe(true);
    // The path won while it ran: straight on its line up to the waypoint (the
    // last rendered tick is one LIN step short of it), never pulled home.
    expect(maxLineDev).toBeLessThan(1e-3);
    expect(closest).toBeLessThan(5e-3);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('tracking suspended'))).toBe(true);
    // Released → the target takes over again at once and holds the tip home.
    r.runUntil(() => false, 10);
    expect(r.tip().distanceTo(home)).toBeLessThan(1e-3);
  });

  it('runs to the end through LogicStep_MechanismPath (RVMechanismPathStep)', async (ctx) => {
    rig = await buildArmRig({
      waypoints: [{ name: 'A', pos: [0.7, 0.2, 0] }, { name: 'B', pos: [0.6, 0.3, 0], interp: 'PointToPoint' }],
      paths: [{ waypoints: ['A', 'B'] }],
    });
    if (!requireRig(ctx, rig)) return;
    const r = rig;
    const step = new RVMechanismPathStep(r.path);
    step.start();
    expect(step.state).toBe(StepState.Active);
    const ticks = r.runUntil(() => { step.fixedUpdate(DT); return step.state === StepState.Finished; }, 2000);
    expect(ticks).toBeGreaterThan(0);
    expect(step.progress).toBe(100);
    // A restart (auto-looping container) runs the finished path again.
    step.reset();
    step.start();
    expect(r.path.PathIsActive).toBe(true);
  });

  it('builds LogicStep_MechanismPath through the public registry seam', async (ctx) => {
    rig = await buildArmRig({
      waypoints: [{ name: 'A', pos: [0.7, 0.2, 0] }],
      paths: [{ waypoints: ['A'] }],
    });
    if (!requireRig(ctx, rig)) return;
    const r = rig;
    const off = registerLogicStepBuilder('LogicStep_MechanismPath', buildMechanismPathStep);
    try {
      const seq = new Object3D(); seq.name = 'Cycle'; r.root.add(seq);
      seq.userData.realvirtual = { LogicStep_SerialContainer: {} };
      const leaf = new Object3D(); leaf.name = 'RunPath'; seq.add(leaf);
      leaf.userData.realvirtual = {
        LogicStep_MechanismPath: {
          MechanismPath: {
            type: 'ComponentReference',
            path: NodeRegistry.computeNodePath(r.path.node),
            componentType: 'realvirtual.MechanismPath',
          },
        },
      };
      r.registry.registerNode(NodeRegistry.computeNodePath(seq), seq);
      r.registry.registerNode(NodeRegistry.computeNodePath(leaf), leaf);

      const engine = RVLogicEngine.build(seq, r.registry, r.store);
      const step = (engine.roots[0] as RVSerialContainer).children[0];
      expect(step).toBeInstanceOf(RVMechanismPathStep);
      step.start();
      expect(r.path.PathIsActive).toBe(true);
      expect(r.runUntil(() => { step.fixedUpdate(DT); return step.state === StepState.Finished; }, 1500))
        .toBeGreaterThan(0);
    } finally {
      off();
    }
  });
});

// ─── Global tempo factor (sim toolbar / web_drive_speed_override) ──────────

/** The commanded LIN path speed of the running segment, m/s (private, read for the ramp check). */
function segSpeed(p: RVMechanismPath): number {
  return (p as unknown as { _segSpeed: number })._segSpeed;
}

describe('MechanismPath LIN follows the global drive speed override', () => {
  it('factor 2 covers the segment in about half the time', async (ctx) => {
    const run = async (factor: number): Promise<number> => {
      setDriveSpeedOverride(factor);
      rig = await buildArmRig({
        waypoints: [{ name: 'WP1', pos: [0.3, 0.6, 0] }],
        paths: [{ waypoints: ['WP1'], linearSpeed: 300, linearAccel: 6000 }],
      });
      if (!requireRig(ctx, rig)) return -1;
      rig.path.startPath();
      const ticks = rig.runUntil(() => rig!.path.PathIsFinished, 2000);
      expect(rig.path.PathFailed).toBe(false);
      expect(rig.tip().distanceTo(new Vector3(0.3, 0.6, 0))).toBeLessThan(1e-3);
      rig.dispose();
      rig = null;
      releaseAllAxes();
      return ticks;
    };
    const t1 = await run(1);
    if (t1 < 0) return;
    const t2 = await run(2);
    expect(t1).toBeGreaterThan(0);
    expect(t2).toBeGreaterThan(0);
    // Ramps are not scaled (IKPath parity), so the ratio sits a little above 0.5.
    expect(t2 / t1).toBeGreaterThan(0.45);
    expect(t2 / t1).toBeLessThan(0.6);
  });

  it('a change mid-segment acts on the next tick and ramps — no speed step', async (ctx) => {
    rig = await buildArmRig({
      waypoints: [{ name: 'WP1', pos: [0.3, 0.6, 0] }],
      paths: [{ waypoints: ['WP1'], linearSpeed: 300, linearAccel: 1500 }],
    });
    if (!requireRig(ctx, rig)) return;
    const r = rig;
    const maxStep = 1.5 * DT + 1e-9; // LinearAcceleration (m/s²) × tick — the factor does not scale it
    r.path.startPath();
    for (let k = 0; k < 60; k++) r.tick();
    expect(segSpeed(r.path)).toBeCloseTo(0.3, 6); // plateau at factor 1

    // Raise to 2: the very next tick accelerates, never faster than the ramp.
    setDriveSpeedOverride(2);
    let prev = segSpeed(r.path);
    r.tick();
    expect(segSpeed(r.path)).toBeGreaterThan(prev);
    let maxDelta = segSpeed(r.path) - prev;
    prev = segSpeed(r.path);
    for (let k = 0; k < 20; k++) {
      r.tick();
      maxDelta = Math.max(maxDelta, Math.abs(segSpeed(r.path) - prev));
      prev = segSpeed(r.path);
    }
    expect(maxDelta).toBeLessThanOrEqual(maxStep);
    expect(segSpeed(r.path)).toBeCloseTo(0.6, 6); // new plateau reached after 0.2 s

    // 0 = hold: ramps down to a standstill, the segment does NOT end, the tip stays.
    setDriveSpeedOverride(0);
    maxDelta = 0;
    for (let k = 0; k < 40; k++) {
      r.tick();
      maxDelta = Math.max(maxDelta, Math.abs(segSpeed(r.path) - prev));
      prev = segSpeed(r.path);
    }
    expect(maxDelta).toBeLessThanOrEqual(maxStep);
    expect(segSpeed(r.path)).toBe(0);
    const held = r.tip().clone();
    for (let k = 0; k < 30; k++) r.tick();
    expect(r.tip().distanceTo(held)).toBeLessThan(1e-6);
    expect(r.path.PathIsActive).toBe(true);
    expect(r.path.PathIsFinished).toBe(false);
    expect(r.path.PathFailed).toBe(false);

    // Back to 1: resumes and still lands on the waypoint.
    setDriveSpeedOverride(1);
    expect(r.runUntil(() => r.path.PathIsFinished, 2000)).toBeGreaterThan(0);
    expect(r.path.PathFailed).toBe(false);
    expect(r.tip().distanceTo(new Vector3(0.3, 0.6, 0))).toBeLessThan(1e-3);
    expect(r.path.peakPathSpeedMmS).toBeLessThanOrEqual(600 + 1e-6);
  });
});

// ─── plan-427 F10 pattern — no solver needed ────────────────────────────────

describe('plan-729 9.1 — SignalStart replay', () => {
  function buildBare(startValue: boolean) {
    const scene = new Scene();
    const root = new Object3D(); root.name = 'Root'; scene.add(root);
    const registry = new NodeRegistry();
    const store = new SignalStore();
    const reapply = new SignalReapplyRegistry();
    const sig = new Object3D(); sig.name = 'PathStart'; root.add(sig);
    const pathNode = new Object3D(); pathNode.name = 'Path'; root.add(pathNode);
    scene.traverse((n) => { if (n.parent) registry.registerNode(NodeRegistry.computeNodePath(n), n); });
    const sigPath = NodeRegistry.computeNodePath(sig);
    store.register('PathStart', sigPath, startValue, 'PLCOutputBool');

    pathNode.userData.realvirtual = { MechanismPath: {} };
    const path = new RVMechanismPath(pathNode);
    applySchema(path as unknown as Record<string, unknown>, RVMechanismPath.schema, {});
    path.SignalStart = sigPath;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    path.init({ registry, signalStore: store, reapply } as unknown as ComponentContext);
    warn.mockRestore();
    const startSpy = vi.spyOn(path, 'startPath').mockImplementation(() => {});
    return { store, reapply, path, startSpy };
  }

  it('resyncs the SignalStart edge baseline on replay without a fresh trigger (plan-427 pattern)', () => {
    const { reapply, path, startSpy } = buildBare(true);
    path.reset();
    startSpy.mockClear();
    reapply.reapplyAll();
    path.fixedUpdate(DT);
    path.fixedUpdate(DT);
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('a genuine false→true edge after the replay still starts the path', () => {
    const { store, reapply, path, startSpy } = buildBare(true);
    path.reset();
    reapply.reapplyAll();
    path.fixedUpdate(DT);
    startSpy.mockClear();
    store.set('PathStart', false);
    path.fixedUpdate(DT);
    store.set('PathStart', true);
    path.fixedUpdate(DT);
    expect(startSpy).toHaveBeenCalledTimes(1);
  });
});
