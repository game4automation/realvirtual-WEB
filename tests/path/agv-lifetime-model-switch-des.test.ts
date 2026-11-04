// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-647 §9.1b (R3-1) — a model switch out of a RUNNING DES FastForward.
 *
 * Model 1 (four loops OLD_A ↔ OLD_B with one Agv each — events forever) is switched to
 * DES and a FastForward run is started that is already yielding to the
 * browser (sim time advanced, run not finished). Then the model is cleared:
 *  - `clearModel()` disposes the kernel before dropping it → the FF promise
 *    resolves `false` (cancelled), the drain loop stops: the old DES clock and
 *    the old vehicle's pose stay frozen while macrotasks pass;
 *  - every traffic registry is empty, and stays empty until the next load;
 *  - a second dispose of the old kernel (teardown re-triggered) is a no-op;
 *  - model 2 loads into a fresh CONTINUOUS kernel, its registries equal a
 *    fresh load, and its Agv reaches its service stop — no old action
 *    (no DES vehicle, no pose change of an old node) shows up meanwhile.
 *
 * `setMode('des')` is a no-op in the public build, so this file is
 * private-dependent (listed in tests/private-dependent-tests.json).
 * Every wait / drive loop has a hard bound.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Object3D, Vector3 } from 'three';
import { createDesRunner } from '@rv/plugins/des/register-des-runner';
import { objectToGlb } from '../../src/core/import/rv-import-object';
import { yieldToBrowser } from '../../src/core/engine/rv-des-yield';
import { createTestViewer, type TestViewerHandle } from '../helpers/create-test-viewer';
import type { RVViewer } from '../../src/core/rv-viewer';
import { registerAllBehaviors } from '../../src/core/behaviors';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { trafficRegistryStats, type TrafficRegistryStats } from '../../src/core/engine/rv-traffic-registries';
import { clearShared } from '../helpers/agv-harness';

const DT = 1 / 60;
const HOLD = 'plan-647-model-switch-des';
const MAX_STEPS = 1500;

type V3 = [number, number, number];

function pathNode(id: string, from: V3, to: V3, successors: string[]): Object3D {
  const n = new Object3D();
  n.name = id;
  n.userData.realvirtual = {
    Path: { type: 'Path', version: 1, closed: false, align: [0, 1, 0], id, segments: [{ kind: 'line', from, to }], successors },
  };
  return n;
}

function agvNode(name: string, pathId: string): Object3D {
  const a = new Object3D();
  a.name = name;
  a.userData.realvirtual = {
    LayoutObject: { Name: name },
    Agv: { PathId: pathId, StartPosition: 0, TargetSpeed: 1000, VehicleLength: 1000, VehicleWidth: 600 },
  };
  const body = new Mesh(new BoxGeometry(0.6, 0.3, 1), new MeshBasicMaterial());
  body.position.y = 0.15;
  a.add(body);
  return a;
}

/** Loops in model 1: several INDEPENDENT vehicles make the DES event stream dense. */
const LOOPS = 4;

/** Model 1: LOOPS separate loops OLD_A<i> ↔ OLD_B<i>, one Agv each — events forever. */
function model1(): Group {
  const root = new Group();
  root.name = 'DesSwitchModel1';
  for (let i = 0; i < LOOPS; i++) {
    const z = i * 3;
    root.add(pathNode(`OLD_A${i}`, [0, 0, z], [4, 0, z], [`OLD_B${i}`]));
    root.add(pathNode(`OLD_B${i}`, [4, 0, z], [0, 0, z + 0.5], [`OLD_A${i}`]));
    root.add(agvNode(`AGV_1_${i}`, `OLD_A${i}`));
  }
  return root;
}

function model2(): Group {
  const root = new Group();
  root.name = 'DesSwitchModel2';
  root.add(pathNode('NEW_A', [0, 0, 0], [4, 0, 0], ['NEW_B']));
  root.add(pathNode('NEW_B', [4, 0, 0], [8, 0, 0], []));
  root.add(agvNode('AGV_2', 'NEW_A'));
  return root;
}

const ZERO: TrafficRegistryStats = {
  paths: 0, zones: 0, zoneHolders: 0, spacing: 0, docks: 0,
  authorityVehicles: { des: 0, continuous: 0 }, pendingClockEvents: 0, fleetHandles: 0,
};

/**
 * Dev-server settle before teardown. A load makes the page import lazy chunks,
 * and Vite pre-transforms their imports in the background. With
 * `server.watch.usePolling` its chokidar watcher adds a polling watcher
 * (`fs.watchFile`) per transformed file; if vitest closes the server while
 * those adds are still in flight they are created AFTER the watcher closed,
 * and the never-unwatched STATWATCHERs keep the main process alive ("close
 * timed out … something prevents the main process from exiting").
 * Traced: three PRIV modules watched 7.7 s into a run, still live at exit.
 * Not a leak of the viewer — a tooling race; this short idle lets the server
 * finish before the run ends.
 */
const DEV_SERVER_SETTLE_MS = 2500;
const settleDevServer = (): Promise<void> => new Promise((r) => setTimeout(r, DEV_SERVER_SETTLE_MS));

let handle: TestViewerHandle;
let viewer: RVViewer;
let bytes1: ArrayBuffer;
let bytes2: ArrayBuffer;

const macrotask = (): Promise<void> => new Promise((r) => setTimeout(r, 5));
const tick = (): void => { (viewer as unknown as { _tickOnce(dt: number): void })._tickOnce(DT); };

async function load(name: string, data: ArrayBuffer): Promise<void> {
  await viewer.loadModel(name, { data });
  await viewer.whenSceneReady();
  viewer.scene.updateMatrixWorld(true);
}

beforeAll(async () => {
  clearShared();
  bytes1 = await objectToGlb(model1());
  bytes2 = await objectToGlb(model2());
  handle = await createTestViewer('webgl');
  viewer = handle.viewer;
  viewer.loop.setPaused(HOLD, true);
  registerAllBehaviors(viewer.behaviors);
}, 180_000);

afterAll(async () => { await settleDevServer(); handle?.dispose(); clearShared(); }, 30_000);

describe('plan-647 §9.1b — model switch out of a running DES FastForward', () => {
  it('the FF run is cancelled, nothing of model 1 acts afterwards, model 2 drives continuously', async () => {
    await load('des-switch-model-1.glb', bytes1);
    const kernel = viewer.simulationKernel!;
    expect(kernel.hasDesRunner(), 'private DES runner registered').toBe(true);
    kernel.setMode('des');
    expect(kernel.mode).toBe('des');
    const des = kernel.desControl()!;
    expect(des, 'DES control surface').not.toBeNull();
    // End time 8e6 s: the first FastForward slice (12 ms) covers roughly 1e6 s
    // of this dense stream, so the run is still in flight after it — and the
    // end time BOUNDS the run should the cancel fail. (Do not raise it to
    // ~3e8 s: one loop vehicle under that end time ran into a DES event storm
    // in the first slice — "Map maximum size exceeded" — an observation
    // outside plan-647, recorded in its Implementation section.)
    des.setEndTime?.(8e6);

    // ── A FastForward run that is already yielding ──
    let ffResult: boolean | undefined;
    const ff = des.runFastForward!();
    void ff.then((r) => { ffResult = r; });
    // The first slice ran synchronously; the drain loop now waits in its yield.
    expect(des.ffProgress, 'the FF run is in flight after its first slice').not.toBeUndefined();
    // Let the drain loop continue once more. It yields via `yieldToBrowser()`
    // (scheduler.yield / MessageChannel); a setTimeout would be starved until
    // the whole run is over — so this wait uses the same scheduling turn.
    await yieldToBrowser();
    expect(ffResult, 'the FF run is still in flight (it yields, it is not finished)').toBeUndefined();
    expect(des.simTime, 'the FF run advanced the DES clock').toBeGreaterThan(0);
    const simTimeAtSwitch = des.simTime;

    const oldAgv = viewer.scene.getObjectByName('AGV_1_0')!;
    expect(oldAgv, 'old vehicle node').toBeTruthy();

    // ── The production model clear ──
    viewer.clearModel();
    expect(trafficRegistryStats()).toEqual(ZERO);
    await Promise.resolve();
    await macrotask();
    expect(ffResult, 'the FF promise resolved as cancelled').toBe(false);
    console.log('[plan-647 9.1b] switched at sim time', simTimeAtSwitch, '— after the cancel', des.simTime);

    const frozenTime = des.simTime;
    const frozenPose = oldAgv.getWorldPosition(new Vector3());
    for (let i = 0; i < 20; i++) await macrotask();
    expect(des.simTime, 'the old DES clock stands still').toBe(frozenTime);
    expect(oldAgv.getWorldPosition(new Vector3()).distanceTo(frozenPose), 'the old vehicle does not move').toBe(0);
    expect(trafficRegistryStats(), 'nothing re-registered behind the reset').toEqual(ZERO);
    // A teardown triggered again (e.g. by model-cleared) is idempotent.
    expect(() => kernel.dispose()).not.toThrow();
    expect(trafficRegistryStats()).toEqual(ZERO);

    // ── Model 2: fresh continuous kernel, own paths, drives ──
    await load('des-switch-model-2.glb', bytes2);
    const afterLoad2 = trafficRegistryStats();
    expect(getDefaultPathNetwork().all().map((p) => p.id).sort()).toEqual(['NEW_A', 'NEW_B']);
    const kernel2 = viewer.simulationKernel!;
    expect(kernel2).not.toBe(kernel);
    expect(kernel2.mode).toBe('continuous');
    const agv2 = getDefaultAgvFleet().get('AGV_2');
    expect(agv2, 'AGV_2 registered').not.toBeNull();
    let arrived = false;
    agv2!.assign({ destination: 'NEW_B', serviceSec: 0.5, onArrive: () => { arrived = true; } });
    let steps = 0;
    while (!arrived && steps < MAX_STEPS) {
      tick();
      steps++;
      if (steps % 100 === 0) await macrotask(); // let a stale drain loop show itself, if any
    }
    expect(steps, 'AGV_2 reached its service stop within the bound').toBeLessThan(MAX_STEPS);
    expect(des.simTime, 'the old DES clock never moved again').toBe(frozenTime);
    expect(oldAgv.getWorldPosition(new Vector3()).distanceTo(frozenPose)).toBe(0);
    expect(trafficRegistryStats().authorityVehicles.des, 'no DES vehicle of model 1 came back').toBe(0);

    // ── Comparison: a fresh load of model 2 yields the same registry sizes ──
    viewer.clearModel();
    clearShared();
    await load('des-switch-model-2-fresh.glb', bytes2);
    expect(afterLoad2).toEqual(trafficRegistryStats());
  }, 180_000);

  it('the private DES runner factory is present (this file is private-dependent)', () => {
    expect(typeof createDesRunner).toBe('function');
  });
});
