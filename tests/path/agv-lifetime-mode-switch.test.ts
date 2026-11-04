// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-648 §9.1 (LOP #219) — vehicle-id ownership across kernel switches.
 *
 * One vehicle has TWO instances: the continuous behaviour binding and the DES
 * runner instance. Exactly the instance of the ACTIVE traffic kernel owns the
 * id (fleet handle, spacing, zones, planner); a switch hands it over and the
 * new owner starts from its start pose. Real viewer, real load path, real
 * private DES runner, NO `clearShared()` between the steps:
 *  - continuous → DES → continuous, three times, each switch while the dock
 *    HOLDS the vehicle: the handle belongs to the active kernel, a task given
 *    through it reaches the dock and its service end, the registry sizes equal
 *    a fresh start in the target kernel, the vehicle stands at its start pose
 *    and holds exactly its start zone (G8), and the old dock release is void;
 *  - `resetSimulation()` of the continuous owner and a UseAcceleration=false
 *    vehicle (G1);
 *  - `resetSimulation()` during DES leaves the continuous instance alone (F6);
 *  - a vehicle frozen at the switch starts unfrozen (rule of the reset);
 *  - a throwing DES `start()` after an acquire and an event restarts the
 *    continuous mode (F5 / G6);
 *  - a late placement in DES + `rebindScene()`, then the switch (F7 / G2);
 *  - a model clear out of DES, a DES boot and the way back (F7 / R2-1).
 *
 * `setMode('des')` is a no-op in the public build → private-dependent.
 * Every drive loop has a hard bound.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Object3D, Vector3 } from 'three';
import { createDesRunner } from '@rv/plugins/des/register-des-runner';
import { objectToGlb } from '../../src/core/import/rv-import-object';
import { createTestViewer, type TestViewerHandle } from '../helpers/create-test-viewer';
import type { RVViewer } from '../../src/core/rv-viewer';
import { registerAllBehaviors } from '../../src/core/behaviors';
import { getDefaultAgvFleet, type AgvHandle } from '../../src/core/engine/rv-agv-fleet';
import { getDefaultPathDockRegistry } from '../../src/core/engine/rv-path-dock';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import {
  getActiveTrafficKernel, trafficRegistryStats, type TrafficRegistryStats,
} from '../../src/core/engine/rv-traffic-registries';
import { AgvFlow, agvTrafficOwnerKind } from '../../src/behaviors/Agv';
import type { SimulationExecutor } from '../../src/core/material-flow/simulation-executor';
import { clearShared } from '../helpers/agv-harness';

const DT = 1 / 60;
const HOLD = 'plan-648-mode-switch';
/** Hard bound of every continuous drive phase (50 s sim time). */
const MAX_STEPS = 3000;
/** Hard bound of every DES drive phase (0.5 s slices → 100 s sim time). */
const MAX_DES_SLICES = 200;
const DES_SLICE = 0.5;
const ID = 'AGV_M';
const LEGACY = 'AGV_L';
const LATE = 'AGV_P';

type V3 = [number, number, number];
type Mode = 'continuous' | 'des';

function pathNode(id: string, from: V3, to: V3, successors: string[], zone?: string): Object3D {
  const n = new Object3D();
  n.name = id;
  n.userData.realvirtual = {
    Path: {
      type: 'Path', version: 1, closed: false, align: [0, 1, 0], id, segments: [{ kind: 'line', from, to }], successors,
      ...(zone ? { zone, zoneCapacity: 1 } : {}),
    },
  };
  return n;
}

function agvNode(name: string, pathId: string, extra: Record<string, unknown> = {}): Object3D {
  const a = new Object3D();
  a.name = name;
  a.userData.realvirtual = {
    LayoutObject: { Name: name },
    Agv: { PathId: pathId, StartPosition: 0, TargetSpeed: 1000, VehicleLength: 1000, VehicleWidth: 600, ...extra },
  };
  const body = new Mesh(new BoxGeometry(0.6, 0.3, 1), new MeshBasicMaterial());
  body.position.y = 0.15;
  a.add(body);
  return a;
}

/** Main loop A → B → C → D → A (zones ZA on A, ZC on C, dock at C) + a legacy loop E ↔ F. */
function model(): Group {
  const root = new Group();
  root.name = 'ModeSwitchCell';
  root.add(pathNode('A', [0, 0, 0], [6, 0, 0], ['B'], 'ZA'));
  root.add(pathNode('B', [6, 0, 0], [6, 0, 4], ['C']));
  root.add(pathNode('C', [6, 0, 4], [0, 0, 4], ['D'], 'ZC'));
  root.add(pathNode('D', [0, 0, 4], [0, 0, 0], ['A']));
  root.add(pathNode('E', [0, 0, 10], [6, 0, 10], ['F']));
  root.add(pathNode('F', [6, 0, 10], [0, 0, 10.5], ['E']));
  root.add(pathNode('G', [0, 0, 20], [6, 0, 20], ['H']));
  root.add(pathNode('H', [6, 0, 20], [0, 0, 20.5], ['G']));
  root.add(agvNode(ID, 'A'));
  root.add(agvNode(LEGACY, 'E', { UseAcceleration: false }));
  return root;
}

const DEV_SERVER_SETTLE_MS = 2500;
const settleDevServer = (): Promise<void> => new Promise((r) => setTimeout(r, DEV_SERVER_SETTLE_MS));

let handle: TestViewerHandle;
let viewer: RVViewer;
let bytes: ArrayBuffer;
let startPos: Vector3;
let freshCont: TrafficRegistryStats;
let freshDes: TrafficRegistryStats | null = null;

interface DesManagerLike { readonly currentTime: number; processUpTo(t: number, budget: number): void }
interface DesExecLike extends SimulationExecutor { getManager(): DesManagerLike }

const kernel = () => viewer.simulationKernel!;
const fleet = (id = ID): AgvHandle => getDefaultAgvFleet().get(id)!;
const tick = (): void => { (viewer as unknown as { _tickOnce(dt: number): void })._tickOnce(DT); };
const world = (name: string): Vector3 => {
  const n = viewer.scene.getObjectByName(name)!;
  n.updateWorldMatrix(true, false);
  return n.getWorldPosition(new Vector3());
};
const held = (id = ID): string[] => { const out: string[] = []; getDefaultZoneRegistry().collectHeld(id, out); return out.sort(); };

/** Advance the ACTIVE kernel until `done` (bounded). Returns true when reached. */
function advanceUntil(done: () => boolean): boolean {
  if (kernel().mode === 'continuous') {
    for (let n = 0; n < MAX_STEPS && !done(); n++) tick();
    return done();
  }
  // processUpTo() moves the clock only to processed events — the target runs on its own.
  const m = (kernel().activeExecutor as DesExecLike).getManager();
  let target = m.currentTime;
  for (let n = 0; n < MAX_DES_SLICES && !done(); n++) { target += DES_SLICE; m.processUpTo(target, 1e6); }
  return done();
}

/** Advance the ACTIVE kernel by `sec` seconds of sim time (short, bounded). */
function advanceFor(sec: number): void {
  if (kernel().mode === 'continuous') {
    for (let n = 0; n < Math.round(sec / DT); n++) tick();
    return;
  }
  const m = (kernel().activeExecutor as DesExecLike).getManager();
  m.processUpTo(m.currentTime + sec, 1e6);
}

/** The dock at C: records every arrival and keeps the latest release. */
const dock = { arrivals: 0, release: null as null | (() => void), agv: '' };
function bindDock(): void {
  getDefaultPathDockRegistry().register('C', {
    id: 'dock-C',
    onVehicleArrive: (agvId, release) => { dock.arrivals++; dock.release = release; dock.agv = agvId; },
  });
}

/** Give a task to C through the handle and drive until the dock holds the vehicle. */
function driveToDock(label: string): { ended: () => boolean; release: () => void } {
  const before = dock.arrivals;
  let ended = false;
  fleet().assign({ destination: 'C', serviceSec: 0.2, onServiceEnd: () => { ended = true; } });
  expect(advanceUntil(() => dock.arrivals > before), `${label}: the vehicle reached the dock`).toBe(true);
  expect(fleet().phase, `${label}: servicing at the dock`).toBe('servicing');
  return { ended: () => ended, release: dock.release! };
}

/** A complete delivery: dock reached, released, service end reached. */
function deliver(label: string): void {
  const d = driveToDock(label);
  d.release();
  expect(advanceUntil(d.ended), `${label}: onServiceEnd reached`).toBe(true);
}

/** The ownership state right after a switch into `mode` (fresh start from the start pose). */
function expectFreshOwner(mode: Mode, label: string): void {
  expect(kernel().mode, label).toBe(mode);
  expect(getActiveTrafficKernel(), `${label}: active traffic kernel`).toBe(mode);
  expect(fleet().kernel, `${label}: handle belongs to the ${mode} instance`).toBe(mode);
  expect(agvTrafficOwnerKind(ID), `${label}: owner`).toBe(mode);
  expect(fleet(LEGACY).kernel, `${label}: legacy handle`).toBe(mode);
  expect(fleet().phase, `${label}: fresh phase`).toBe('cruising');
  expect(world(ID).distanceTo(startPos) * 1000, `${label}: start pose (mm)`).toBeLessThan(1);
  expect(held(), `${label}: exactly the start zone of the owner (G8)`).toEqual(['ZA']);
  const stats = trafficRegistryStats();
  const ref = mode === 'continuous' ? freshCont : freshDes;
  if (ref) expect(stats, `${label}: registry sizes = fresh start in ${mode}`).toEqual(ref);
  else freshDes = stats;
}

function desInstanceSelf(name: string): { local: Record<string, unknown> } {
  const inst = kernel().activeExecutor.instances!().find((i) => i.def.type === 'Agv' && i.self.root.name === name);
  expect(inst, `DES instance of ${name}`).toBeTruthy();
  return inst!.self as unknown as { local: Record<string, unknown> };
}

async function load(name: string): Promise<void> {
  await viewer.loadModel(name, { data: bytes });
  await viewer.whenSceneReady();
  viewer.scene.updateMatrixWorld(true);
  bindDock();
}

beforeAll(async () => {
  clearShared();
  bytes = await objectToGlb(model());
  handle = await createTestViewer('webgl');
  viewer = handle.viewer;
  viewer.loop.setPaused(HOLD, true);
  registerAllBehaviors(viewer.behaviors);
  await load('mode-switch-cell.glb');
  startPos = world(ID);
  expect(kernel().hasDesRunner(), 'private DES runner registered').toBe(true);
  freshCont = trafficRegistryStats();
}, 180_000);

afterAll(async () => { await settleDevServer(); handle?.dispose(); clearShared(); }, 30_000);

describe('plan-648 §9.1 — vehicle ownership on the kernel switch', () => {
  it('fresh load: the continuous instance owns the id', () => {
    expect(getActiveTrafficKernel()).toBe('continuous');
    expect(fleet().kernel).toBe('continuous');
    expect(agvTrafficOwnerKind(ID)).toBe('continuous');
    expect(held()).toEqual(['ZA']);
    expect(freshCont.authorityVehicles).toEqual({ des: 0, continuous: 1 });
    expect(freshCont.fleetHandles).toBe(2);
  });

  it('continuous → DES → continuous three times, every switch while the dock holds the vehicle', () => {
    deliver('continuous first');
    for (let round = 1; round <= 3; round++) {
      // ── continuous: the dock holds the vehicle → switch to DES ──
      let oldEnded = false;
      fleet().assign({ destination: 'C', serviceSec: 0.2, onServiceEnd: () => { oldEnded = true; } });
      const arrivals = dock.arrivals;
      expect(advanceUntil(() => dock.arrivals > arrivals), `round ${round}: continuous dock reached`).toBe(true);
      const oldRelease = dock.release!;
      expect(held(), `round ${round}: on C the vehicle holds ZC`).toContain('ZC');
      kernel().setMode('des');
      expectFreshOwner('des', `round ${round} → DES`);
      oldRelease();                                   // the old owner's dock release is void
      advanceFor(1);                                  // a service end would be due after 1 ms
      expect(oldEnded, `round ${round}: the old service end never fires`).toBe(false);
      expect(fleet().phase).toBe('cruising');
      deliver(`round ${round} DES`);
      // ── DES: the dock holds the vehicle → switch back ──
      let desEnded = false;
      fleet().assign({ destination: 'C', serviceSec: 0.2, onServiceEnd: () => { desEnded = true; } });
      const a2 = dock.arrivals;
      expect(advanceUntil(() => dock.arrivals > a2), `round ${round}: DES dock reached`).toBe(true);
      const desRelease = dock.release!;
      kernel().setMode('continuous');
      expectFreshOwner('continuous', `round ${round} → continuous`);
      desRelease();
      advanceFor(1);
      expect(fleet().phase).toBe('cruising');
      expect(desEnded, `round ${round}: the DES service end never fires`).toBe(false);
      deliver(`round ${round} continuous`);
      // The legacy vehicle drives again in continuous mode.
      const l0 = world(LEGACY);
      for (let i = 0; i < 60; i++) tick();
      expect(world(LEGACY).distanceTo(l0), `round ${round}: legacy vehicle drives`).toBeGreaterThan(0.1);
    }
  }, 180_000);

  it('resetSimulation of the continuous owner (G1): same handle, fresh registries, delivers again', () => {
    expect(kernel().mode).toBe('continuous');
    const h = fleet();
    const hl = fleet(LEGACY);
    for (let i = 0; i < 90; i++) tick();
    viewer.resetSimulation();
    expect(fleet(), 'the owner keeps its handle').toBe(h);
    expect(fleet(LEGACY), 'the legacy owner keeps its handle').toBe(hl);
    expect(agvTrafficOwnerKind(ID)).toBe('continuous');
    expect(world(ID).distanceTo(startPos) * 1000).toBeLessThan(1);
    expect(held()).toEqual(['ZA']);
    expect(trafficRegistryStats()).toEqual(freshCont);
    deliver('after reset');
    const l0 = world(LEGACY);
    for (let i = 0; i < 60; i++) tick();
    expect(world(LEGACY).distanceTo(l0), 'legacy vehicle drives after the reset').toBeGreaterThan(0.1);
  });

  it('resetSimulation during DES leaves the continuous instance alone; back in continuous it delivers (F6)', () => {
    kernel().setMode('des');
    expectFreshOwner('des', 'reset-in-DES → DES');
    deliver('DES before reset');
    const h = fleet();
    viewer.resetSimulation();
    expect(kernel().mode).toBe('des');
    expect(agvTrafficOwnerKind(ID), 'DES keeps the id').toBe('des');
    expect(fleet().kernel).toBe('des');
    expect(fleet(), 'the DES restart refreshes the handle of the same instance').not.toBe(h);
    expect(trafficRegistryStats(), 'the continuous instance registered nothing').toEqual(freshDes);
    deliver('DES after reset');
    kernel().setMode('continuous');
    expectFreshOwner('continuous', 'reset-in-DES → continuous');
    deliver('continuous after the DES reset');
  });

  it('a vehicle frozen at the switch starts unfrozen (the rule of resetSimulation)', () => {
    kernel().setMode('des');
    expectFreshOwner('des', 'freeze → DES');
    const self = desInstanceSelf(ID);
    AgvFlow.des.onFreeze(self as never, []);
    expect(self.local.frozen).toBe(true);
    kernel().setMode('continuous');
    expectFreshOwner('continuous', 'freeze → continuous');
    deliver('continuous after the frozen DES phase');
    kernel().setMode('des');
    expectFreshOwner('des', 'freeze → DES again');
    expect(desInstanceSelf(ID).local.frozen, 'the DES instance restarts unfrozen').toBe(false);
    deliver('DES after the freeze');
    kernel().setMode('continuous');
    expectFreshOwner('continuous', 'freeze → back');
  });

  it('a throwing DES start() after an acquire and an event restarts the continuous mode (F5 / G6)', () => {
    expect(kernel().mode).toBe('continuous');
    for (let i = 0; i < 60; i++) tick();
    const des = (kernel() as unknown as { _resolveExecutor(m: Mode): SimulationExecutor })._resolveExecutor('des');
    const orig = des.start.bind(des);
    let acquiredInStart = false;
    let desVehiclesInStart = 0;
    des.start = (defs, topology) => {
      orig(defs, topology);
      acquiredInStart = agvTrafficOwnerKind(ID) === 'des';
      desVehiclesInStart = trafficRegistryStats().authorityVehicles.des;
      throw new Error('plan-648 injected start failure');
    };
    try {
      kernel().setMode('des');
    } finally {
      des.start = orig;
    }
    expect(acquiredInStart, 'the half-started DES instance had acquired').toBe(true);
    expect(desVehiclesInStart, 'and registered (start kick = an event planned)').toBeGreaterThan(0);
    expect(kernel().mode).toBe('continuous');
    expectFreshOwner('continuous', 'after the failed switch');
    expect(trafficRegistryStats().authorityVehicles.des, 'nothing of the half start is left').toBe(0);
    deliver('continuous after the failed switch');
  });

  it('a late placement in DES + rebindScene(), then the switch (F7 / G2)', () => {
    kernel().setMode('des');
    expectFreshOwner('des', 'late → DES');
    const late = agvNode(LATE, 'G');
    viewer.currentModelRoot!.add(late);
    late.updateMatrixWorld(true);
    viewer.behaviors.dispatchPlaced(late);
    expect(getDefaultAgvFleet().get(LATE), 'the muted continuous binding takes no id').toBeNull();
    expect(agvTrafficOwnerKind(LATE)).toBeNull();
    kernel().rebindScene();
    expect(agvTrafficOwnerKind(LATE), 'the rebound DES instance owns it').toBe('des');
    expect(fleet(LATE).kernel).toBe('des');
    expect(agvTrafficOwnerKind(ID)).toBe('des');
    deliver('DES after the rebind');
    kernel().setMode('continuous');
    expect(agvTrafficOwnerKind(LATE), 'the binding made during DES is activated').toBe('continuous');
    expect(fleet(LATE).kernel).toBe('continuous');
    expect(agvTrafficOwnerKind(ID)).toBe('continuous');
    let lateEnded = false;
    fleet(LATE).assign({ destination: 'H', serviceSec: 0.2, onServiceEnd: () => { lateEnded = true; } });
    expect(advanceUntil(() => lateEnded), 'the late vehicle serves in continuous mode').toBe(true);
    deliver('main vehicle next to the late one');
  });

  it('model clear out of DES, a DES boot and the way back (F7 / R2-1)', async () => {
    kernel().setMode('des');
    expect(agvTrafficOwnerKind(ID)).toBe('des');
    viewer.clearModel();
    expect(getActiveTrafficKernel(), 'no kernel after the clear').toBeNull();
    expect(agvTrafficOwnerKind(ID), 'no old owner').toBeNull();
    expect(trafficRegistryStats().fleetHandles).toBe(0);
    await load('mode-switch-cell-2.glb');
    expect(kernel().mode).toBe('continuous');
    expect(getActiveTrafficKernel()).toBe('continuous');
    expect(trafficRegistryStats(), 'reload = fresh load').toEqual(freshCont);
    // DES boot: straight into DES without a continuous step.
    kernel().setMode('des');
    expectFreshOwner('des', 'DES boot');
    deliver('DES boot');
    kernel().setMode('continuous');
    expectFreshOwner('continuous', 'DES boot → continuous');
    deliver('continuous after the DES boot');
  });

  it('the private DES runner factory is present (this file is private-dependent)', () => {
    expect(typeof createDesRunner).toBe('function');
  });
});
