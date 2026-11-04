// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-632 §9 — the continuous AGV fleet step on the REAL viewer host.
 *
 * The unit suite (`agv-continuous-clock-join.test.ts`) drives the fleet with a
 * test host; this one proves the production step key: a real `RVViewer`
 * (`createTestViewer`), the Agv bound through the real load path
 * (`registerAllBehaviors` → `loadModel` → payload dispatch), fixed steps run by
 * the viewer's own `SimulationLoop` accumulator — several catch-up steps per
 * render frame — and `RVViewer.fixedStepCount` as the key. After EVERY fixed
 * step (sampled by wrapping the loop's `onFixedUpdate`, which still calls the
 * real `RVViewer.fixedUpdate`) each vehicle's drawn world pose equals the plan
 * location `mb.locate(id, clock.now)` and the clock advanced exactly dt;
 * through a global pause / resume, a `resetSimulation()` and a
 * continuous → DES → continuous mode switch. plan-648 §9.2: across the round
 * trip every fleet handle belongs to the instance of the active kernel, and
 * after it a task given through the handle reaches its service stop.
 *
 * The DES switch needs the private DES runner (imported below, so this file is
 * private-dependent).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, Object3D, Scene, Vector3 } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { createDesRunner } from '@rv/plugins/des/register-des-runner';
import { createTestViewer, type TestViewerHandle } from '../helpers/create-test-viewer';
import type { RVViewer } from '../../src/core/rv-viewer';
import { registerAllBehaviors } from '../../src/core/behaviors';
import { getDefaultMovementAuthority } from '../../src/core/engine/rv-movement-authority';
import { agvFleetStepDiagnostics } from '../../src/behaviors/Agv';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { clearShared } from '../helpers/agv-harness';

const DT = 1 / 60;
/** Holds the viewer's real-time loop between the tests (every step below is explicit). */
const HOLD = 'plan-632-viewer-test';
/** Pose equality to the analytic plan location (mm). */
const POSE_EPS_MM = 1e-3;
const CLOCK_EPS = 1e-12;
const NAMES = ['AGV_1', 'AGV_2', 'AGV_3'];

/** A closed rectangle P1 → P2 → P3 → P4 → P1 and three AGVs on P1 (AGVDemo-like speeds: the first catches up). */
function sceneGraph(): Scene {
  const scene = new Scene();
  const model = new Object3D();
  model.name = 'ClockJoinCell';
  scene.add(model);
  const corners: [number, number, number][] = [[0, 0, 0], [20, 0, 0], [20, 0, 10], [0, 0, 10]];
  for (let i = 0; i < 4; i++) {
    const n = new Object3D();
    n.name = `P${i + 1}`;
    n.userData.realvirtual = {
      Path: {
        type: 'Path', version: 1, closed: false, align: [0, 1, 0], id: n.name,
        segments: [{ kind: 'line', from: corners[i], to: corners[(i + 1) % 4] }],
        successors: [`P${((i + 1) % 4) + 1}`],
      },
    };
    model.add(n);
  }
  const cfg: [number, number][] = [[0, 1000], [3000, 800], [6000, 1200]];
  cfg.forEach(([start, speed], i) => {
    const a = new Object3D();
    a.name = NAMES[i];
    a.userData.realvirtual = {
      LayoutObject: { Name: a.name },
      Agv: { PathId: 'P1', StartPosition: start, TargetSpeed: speed, VehicleLength: 1200, VehicleWidth: 800 },
    };
    const body = new Mesh(new BoxGeometry(0.8, 0.3, 1.2), new MeshBasicMaterial());
    body.position.y = 0.15;
    a.add(body);
    model.add(a);
  });
  return scene;
}

let handle: TestViewerHandle;
let viewer: RVViewer;
const roots = new Map<string, Object3D>();

interface Loop {
  onFixedUpdate: (dt: number) => void;
  advanceAccumulator(frameTime: number): number;
  setPaused(reason: string, paused: boolean): void;
  readonly isPaused: boolean;
}
const loop = (): Loop => viewer.loop as unknown as Loop;

/** Per-fixed-step meter, installed around the loop's real onFixedUpdate. */
const meter = {
  /** Sampling on (continuous mode); off while DES runs — the continuous fleet does not step there. */
  on: true,
  steps: 0, maxErrMm: 0, badClock: [] as string[], skewed: [] as string[], lastNow: 0, lastKey: 0,
};

function sampleStep(): void {
  if (!meter.on) return;
  const mb = getDefaultMovementAuthority('continuous');
  const now = mb.clock.now;
  const key = viewer.fixedStepCount;
  if (key !== meter.lastKey + 1) meter.badClock.push(`key ${meter.lastKey}->${key}`);
  if (Math.abs(now - meter.lastNow - DT) > CLOCK_EPS) meter.badClock.push(`k${key}:${((now - meter.lastNow) / DT).toFixed(3)}`);
  meter.lastNow = now;
  meter.lastKey = key;
  meter.steps++;
  const sync = agvFleetStepDiagnostics().syncTimes;
  for (const id of NAMES) {
    if (sync[id] !== now) meter.skewed.push(`k${key}:${id}`);
    const loc = mb.locate(id, now);
    if (!loc) { meter.skewed.push(`k${key}:${id}:no-plan`); continue; }
    const err = roots.get(id)!.getWorldPosition(new Vector3()).distanceTo(loc.path.getAbsPosition(loc.s, new Vector3())) * 1000;
    if (err > meter.maxErrMm) meter.maxErrMm = err;
  }
}

/** One render frame of `frameTime` seconds through the loop's real accumulator. */
const frame = (frameTime: number): void => { loop().advanceAccumulator(frameTime); };

/** Re-anchor the meter at the current clock / key (after a reset or a mode switch). */
function anchor(): void {
  meter.lastNow = getDefaultMovementAuthority('continuous').clock.now;
  meter.lastKey = viewer.fixedStepCount;
}

beforeAll(async () => {
  clearShared();
  const data = (await new GLTFExporter().parseAsync(sceneGraph(), { binary: true })) as ArrayBuffer;
  handle = await createTestViewer('webgl');
  viewer = handle.viewer;
  viewer.loop.setPaused(HOLD, true);
  registerAllBehaviors(viewer.behaviors);
  await viewer.loadModel('clock-join-cell.glb', { data });
  await viewer.whenSceneReady();
  viewer.scene.updateMatrixWorld(true);
  for (const id of NAMES) {
    const n = viewer.scene.getObjectByName(id);
    if (n) roots.set(id, n);
  }
  const l = loop();
  const real = l.onFixedUpdate;
  l.onFixedUpdate = (dt: number) => { real(dt); sampleStep(); };
}, 180_000);

afterAll(() => { handle?.dispose(); clearShared(); });

describe('plan-632 — continuous fleet step on the real viewer host', () => {
  it('binds three continuous Agv through the real load path', () => {
    expect([...roots.keys()].sort()).toEqual(NAMES);
    expect(viewer.behaviors.getActiveBinds().filter((b) => b.behaviorId === 'Agv')).toHaveLength(3);
    for (const id of NAMES) expect(getDefaultMovementAuthority('continuous').has(id), id).toBe(true);
  });

  it('catch-up steps, pause / resume, reset and continuous → DES → continuous: pose == locate, clock exactly dt', () => {
    loop().setPaused(HOLD, false);
    try {
      expect(loop().isPaused, 'no other pause reason holds the loop').toBe(false);
      anchor();
      const k0 = viewer.fixedStepCount;
      // ── 1. Render frames with 3 catch-up fixed steps each (3.5·dt: the remainder carries) ──
      for (let f = 0; f < 120; f++) frame(3.5 * DT);
      const steps1 = viewer.fixedStepCount - k0;
      expect(steps1, 'catch-up steps ran').toBeGreaterThanOrEqual(3 * 120);
      expect(meter.steps).toBe(steps1);
      const d1 = agvFleetStepDiagnostics();
      expect(d1.fallbackSteps, 'the viewer provides the step key').toBe(0);
      expect(d1.keyedSteps).toBe(meter.steps);

      // ── 2. Global pause: no fixed step, clock stands; resume continues at dt ──
      const kp = viewer.fixedStepCount;
      const tp = getDefaultMovementAuthority('continuous').clock.now;
      loop().setPaused('plan-632-user-pause', true);
      for (let f = 0; f < 30; f++) frame(2 * DT);
      expect(viewer.fixedStepCount, 'paused: no fixed step').toBe(kp);
      expect(getDefaultMovementAuthority('continuous').clock.now).toBe(tp);
      loop().setPaused('plan-632-user-pause', false);
      for (let f = 0; f < 60; f++) frame(2 * DT);
      expect(viewer.fixedStepCount - kp).toBeGreaterThanOrEqual(119);

      // ── 3. resetSimulation(): every vehicle re-joins at the current clock time ──
      viewer.resetSimulation();
      anchor();
      for (let f = 0; f < 90; f++) frame(3.5 * DT);

      // ── 4. continuous → DES → continuous ──
      const kernel = viewer.simulationKernel!;
      expect(kernel.hasDesRunner(), 'private DES runner registered').toBe(true);
      kernel.setMode('des');
      expect(kernel.mode).toBe('des');
      for (const id of NAMES) expect(getDefaultAgvFleet().get(id)?.kernel, `${id} handle in DES`).toBe('des');
      const before = meter.steps;
      meter.on = false;
      for (let f = 0; f < 60; f++) frame(2 * DT);  // DES Animated: the continuous fleet does not step
      kernel.setMode('continuous');
      expect(kernel.mode).toBe('continuous');
      meter.on = true;
      anchor();
      for (let f = 0; f < 120; f++) frame(3.5 * DT);
      expect(meter.steps - before, 'continuous steps after the switch back').toBeGreaterThanOrEqual(3 * 120);
      // plan-648 §9.2: the handles are the continuous ones again, and a task given
      // through a handle reaches its service stop (LOP #219: it never did).
      for (const id of NAMES) expect(getDefaultAgvFleet().get(id)?.kernel, `${id} handle back`).toBe('continuous');
      let served = false;
      getDefaultAgvFleet().get('AGV_1')!.assign({ destination: 'P2', serviceSec: 0.2, onServiceEnd: () => { served = true; } });
      // P2 ends 30 m ahead of AGV_1's start (1 m/s): bounded at 1200 frames ≈ 70 s sim time.
      for (let f = 0; f < 1200 && !served; f++) frame(3.5 * DT);
      expect(served, 'AGV_1 reached its service stop after the round trip').toBe(true);
    } finally {
      loop().setPaused(HOLD, true);
    }
    expect(meter.badClock, 'fixed steps whose clock advance != dt or whose key did not step by 1').toEqual([]);
    expect(meter.skewed, 'vehicles not synced at clock.now').toEqual([]);
    expect(meter.maxErrMm, 'drawn pose vs locate(id, clock.now)').toBeLessThan(POSE_EPS_MM);
    expect(agvFleetStepDiagnostics().syncBeforeT0).toBe(0);
  });

  it('the private DES runner factory is present (this file is private-dependent)', () => {
    expect(typeof createDesRunner).toBe('function');
  });
});
