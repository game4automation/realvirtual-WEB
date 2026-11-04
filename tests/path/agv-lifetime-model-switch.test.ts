// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-647 §9.1 — the traffic registries on a REAL model switch (LOP #214).
 *
 * A real `RVViewer` loads model 1 (a loop OLD_A ↔ OLD_B, a path SHARED, zone Z
 * on OLD_A, one Agv, a dock on OLD_B), lets it drive, then model 2 (NEW_A with
 * successors [NEW_B, OLD_B], NEW_B, SHARED, one Agv). No `clearShared()`
 * between the steps — only before the first load and before the comparison
 * run — so a leak of the production `clearModel()` is visible here instead of
 * being masked by the test reset:
 *  - after `clearModel()` every registry is empty (`trafficRegistryStats()`);
 *  - model 2 sees only its own paths (`all`, `get`, `candidateIds`);
 *  - the stats after loading model 2 equal a FRESH load of model 2;
 *  - the Agv of model 2 reaches its service stop, the old dock never fires
 *    for it;
 *  - a global fleet subscription made BEFORE the switch hears model 2 (D2).
 *
 * Every simulation loop below has a hard step bound.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Object3D } from 'three';
import { objectToGlb } from '../../src/core/import/rv-import-object';
import { createTestViewer, type TestViewerHandle } from '../helpers/create-test-viewer';
import type { RVViewer } from '../../src/core/rv-viewer';
import { registerAllBehaviors } from '../../src/core/behaviors';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultPathDockRegistry } from '../../src/core/engine/rv-path-dock';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { trafficRegistryStats, type TrafficRegistryStats } from '../../src/core/engine/rv-traffic-registries';
import { clearShared } from '../helpers/agv-harness';

const DT = 1 / 60;
const HOLD = 'plan-647-model-switch';
/** Hard bound for every drive phase (≈ 25 s sim time). */
const MAX_STEPS = 1500;

type V3 = [number, number, number];

function pathNode(id: string, from: V3, to: V3, successors: string[], extra?: Record<string, unknown>): Object3D {
  const n = new Object3D();
  n.name = id;
  n.userData.realvirtual = {
    Path: { type: 'Path', version: 1, closed: false, align: [0, 1, 0], id, segments: [{ kind: 'line', from, to }], successors, ...extra },
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

/** Model 1: OLD_A → OLD_B → OLD_A (loop), SHARED, zone Z on OLD_A, AGV_1 on OLD_A. */
function model1(): Group {
  const root = new Group();
  root.name = 'SwitchModel1';
  root.add(pathNode('OLD_A', [0, 0, 0], [4, 0, 0], ['OLD_B'], { zone: 'Z', zoneCapacity: 1 }));
  root.add(pathNode('OLD_B', [4, 0, 0], [0, 0, 0.5], ['OLD_A']));
  root.add(pathNode('SHARED', [0, 0, 3], [4, 0, 3], []));
  root.add(agvNode('AGV_1', 'OLD_A'));
  return root;
}

/** Model 2: NEW_A → [NEW_B, OLD_B], NEW_B, SHARED, AGV_2 on NEW_A. */
function model2(): Group {
  const root = new Group();
  root.name = 'SwitchModel2';
  root.add(pathNode('NEW_A', [0, 0, 0], [4, 0, 0], ['NEW_B', 'OLD_B']));
  root.add(pathNode('NEW_B', [4, 0, 0], [8, 0, 0], []));
  root.add(pathNode('SHARED', [0, 0, 3], [4, 0, 3], []));
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

const tick = (): void => { (viewer as unknown as { _tickOnce(dt: number): void })._tickOnce(DT); };

/** Tick until `done()` or the hard bound; returns the steps taken (MAX_STEPS = bound hit). */
function tickUntil(done: () => boolean): number {
  let n = 0;
  while (!done() && n < MAX_STEPS) { tick(); n++; }
  return n;
}

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

describe('plan-647 §9.1 — traffic registries on a real model switch', () => {
  it('clearModel() empties every registry; model 2 sees only its own paths and drives', async () => {
    const fleet = getDefaultAgvFleet();
    // Global subscriptions made BEFORE the switch (a plugin subscribes once per viewer lifetime).
    const registered: string[] = [];
    const taskChanges: string[] = [];
    const unsubRegister = fleet.onRegister((h) => { registered.push(h.id); });
    const unsubTask = fleet.onTaskChanged((id) => { taskChanges.push(id); });
    try {
      // ── Model 1: load, dock on OLD_B, drive until the dock served AGV_1 ──
      await load('switch-model-1.glb', bytes1);
      expect(getDefaultPathNetwork().all().map((p) => p.id).sort()).toEqual(['OLD_A', 'OLD_B', 'SHARED']);
      const oldDockArrivals: string[] = [];
      getDefaultPathDockRegistry().register('OLD_B', {
        onVehicleArrive(agvId, release) { oldDockArrivals.push(agvId); release(); },
      });
      const steps1 = tickUntil(() => oldDockArrivals.length > 0);
      expect(steps1, 'AGV_1 reached the dock on OLD_B within the bound').toBeLessThan(MAX_STEPS);
      expect(oldDockArrivals[0]).toBe('AGV_1');

      // ── The production model clear ──
      viewer.clearModel();
      const afterClear = trafficRegistryStats();
      console.log('[plan-647 9.1] stats after clearModel():', JSON.stringify(afterClear));
      expect.soft(afterClear).toEqual(ZERO);

      // ── Model 2 ──
      oldDockArrivals.length = 0;
      await load('switch-model-2.glb', bytes2);
      const afterLoad2 = trafficRegistryStats();
      const net = getDefaultPathNetwork();
      const ids = net.all().map((p) => p.id).sort();
      console.log('[plan-647 9.1] paths after loading model 2:', ids.join(','));
      expect.soft(ids).toEqual(['NEW_A', 'NEW_B', 'SHARED']);
      expect.soft(net.get('OLD_A')).toBeNull();
      expect.soft(net.get('OLD_B')).toBeNull();
      expect.soft(net.candidateIds(net.get('NEW_A')!, 1)).toEqual(['NEW_B']);
      expect.soft(getDefaultPathDockRegistry().dockAt('OLD_B')).toBeNull();

      // D2: the subscription made before the switch hears model 2.
      expect(registered).toContain('AGV_2');
      const agv2 = fleet.get('AGV_2');
      expect(agv2, 'AGV_2 registered in the fleet').not.toBeNull();
      let arrived = false;
      agv2!.assign({ destination: 'NEW_B', serviceSec: 0.5, onArrive: () => { arrived = true; } });
      expect(taskChanges).toContain('AGV_2');

      const steps2 = tickUntil(() => arrived);
      expect(steps2, 'AGV_2 reached its service stop within the bound').toBeLessThan(MAX_STEPS);
      expect.soft(oldDockArrivals, 'the dock of model 1 never served model 2').toEqual([]);

      // ── Comparison run: a FRESH load of model 2 yields the same registry sizes ──
      viewer.clearModel();
      clearShared();
      await load('switch-model-2-fresh.glb', bytes2);
      const fresh = trafficRegistryStats();
      console.log('[plan-647 9.1] stats switch vs fresh:', JSON.stringify(afterLoad2), JSON.stringify(fresh));
      expect(afterLoad2).toEqual(fresh);
    } finally {
      unsubRegister();
      unsubTask();
    }
  }, 180_000);
});
