// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-453 — the structural path verbs inside a REAL `RVViewer` (continuous
 * planner runtime, real Agv behavior, real `resetSimulation()`):
 *  - 9.9  the verb reset re-seeds the vehicle on the NEW geometry: the traveler
 *         rides the network's CURRENT path object (not the replaced one), at the
 *         configured start position clamped to the new length, posed there, and
 *         holds exactly its start zone (Agv.ts reset, §2.4c);
 *  - 9.5  in the reset state every verb applies, and N fixed steps later the
 *         vehicle has covered exactly the arc length a FRESH load of the edited
 *         geometry covers in N steps;
 *  - 9.4  (real runtime) running and paused-after-running are locked, two pause
 *         reasons at once and the reset state are not; the verb reset re-runs
 *         the `simulation-start` listeners exactly once;
 *  - 9.7  (real Agv) the start-path resolution of a vehicle with an EMPTY and
 *         with an UNRESOLVABLE PathId (the Path node under its root) is what the
 *         chain-start shift follows.
 *
 * The edit target has no scene store here, so the verbs take their runtime
 * path (not undoable) — undo / transactions are pinned in
 * path-segment-verbs-commands.test.ts. Every drive loop has a hard step bound.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Object3D, Vector3 } from 'three';
import { objectToGlb } from '../../src/core/import/rv-import-object';
import { createTestViewer, type TestViewerHandle } from '../helpers/create-test-viewer';
import type { RVViewer } from '../../src/core/rv-viewer';
import { registerAllBehaviors } from '../../src/core/behaviors';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { getDefaultAgvFleet, type AgvTravelerState } from '../../src/core/engine/rv-agv-fleet';
import type { PathSegmentSpec } from '../../src/core/engine/rv-path';
import type { RVPath } from '../../src/core/engine/rv-path';
import { PathVisualizerPlugin, type PathVerbResult } from '../../src/plugins/path-visualizer-plugin';
import { setActiveEditTarget } from '../../src/core/hmi/rv-edit-target';
import { clearShared } from '../helpers/agv-harness';

const DT = 1 / 60;
const HOLD = 'plan-453-verbs';
/** Fixed steps the vehicle drives after a verb (hard bound, ≈ 1.5 s sim time). */
const N_STEPS = 90;

type V3 = [number, number, number];

const LINE: PathSegmentSpec = { kind: 'line', from: [0, 0, 0], to: [4, 0, 0] };
const ARC: PathSegmentSpec = { kind: 'arc', center: [4, 0, 2], radius: 2, startAngle: -90, degrees: 90, plane: 'XZ' };

function pathNode(id: string, segments: PathSegmentSpec[], extra: Record<string, unknown> = {}): Object3D {
  const n = new Object3D();
  n.name = id;
  n.userData.realvirtual = {
    Path: { type: 'Path', version: 1, closed: false, align: [0, 1, 0], id, segments, successors: [], ...extra },
  };
  return n;
}

function agvNode(name: string, pathId: string, startMm: number, child?: Object3D): Object3D {
  const a = new Object3D();
  a.name = name;
  a.userData.realvirtual = {
    LayoutObject: { Name: name },
    Agv: { PathId: pathId, StartPosition: startMm, TargetSpeed: 1000, VehicleLength: 600, VehicleWidth: 400 },
  };
  const body = new Mesh(new BoxGeometry(0.4, 0.3, 0.6), new MeshBasicMaterial());
  body.position.y = 0.15;
  a.add(body);
  if (child) a.add(child);
  return a;
}

/** P (zone Z) with AGV on it; Q under the root of AGV_EMPTY (PathId ''); R under AGV_GONE (PathId 'GONE'). */
function model(pSegments: PathSegmentSpec[], startMm = 1500): Group {
  const root = new Group();
  root.name = 'VerbModel';
  root.add(pathNode('P', pSegments, { zone: 'Z', zoneCapacity: 1 }));
  root.add(agvNode('AGV', 'P', startMm));
  root.add(agvNode('AGV_EMPTY', '', 1000, pathNode('Q', [{ kind: 'line', from: [0, 0, 10], to: [5, 0, 10] }])));
  root.add(agvNode('AGV_GONE', 'GONE', 1000, pathNode('R', [{ kind: 'line', from: [0, 0, 20], to: [5, 0, 20] }])));
  return root;
}

const DEV_SERVER_SETTLE_MS = 2500;
const settleDevServer = (): Promise<void> => new Promise((r) => setTimeout(r, DEV_SERVER_SETTLE_MS));

let handle: TestViewerHandle;
let viewer: RVViewer;
let plugin: PathVisualizerPlugin;

const tick = (): void => { (viewer as unknown as { _tickOnce(dt: number): void })._tickOnce(DT); };

async function load(name: string, root: Group): Promise<void> {
  // The plugin is init'ed by hand here — deliver the model clear it would get as a registered plugin.
  plugin.onModelCleared();
  viewer.clearModel();
  clearShared();
  const data = await objectToGlb(root);
  await viewer.loadModel(name, { data });
  await viewer.whenSceneReady();
  viewer.scene.updateMatrixWorld(true);
  plugin.refresh();
}

function travelerOf(id: string): AgvTravelerState {
  const h = getDefaultAgvFleet().get(id);
  expect(h, `${id} registered`).not.toBeNull();
  const out = {} as AgvTravelerState;
  expect(h!.travelerState!(out), `${id} has a traveler`).toBe(true);
  return out;
}

function startMmOf(id: string): number {
  const node = getDefaultAgvFleet().get(id)!.node!;
  return Number((node.userData.realvirtual as Record<string, Record<string, unknown>>).Agv.StartPosition);
}

/** 9.9: the vehicle stands on the CURRENT path object at its configured start, posed there, holding exactly its start zone. */
function expectSeededOnNewGeometry(id: string, pathId: string, replaced: RVPath | null, zone: string | null): void {
  const net = getDefaultPathNetwork();
  const current = net.get(pathId);
  expect(current, `${pathId} registered`).not.toBeNull();
  if (replaced) expect(current, 'the verb replaced the path object').not.toBe(replaced);
  const st = travelerOf(id);
  expect(st.path, 'traveler rides the NEW path object').toBe(current);
  const expectedS = Math.min(Math.max(0, startMmOf(id) / 1000), current!.length);
  expect(st.s).toBeCloseTo(expectedS, 9);
  const node = getDefaultAgvFleet().get(id)!.node!;
  node.updateWorldMatrix(true, false);
  const world = node.getWorldPosition(new Vector3());
  const want = current!.getAbsPosition(expectedS);
  expect(world.distanceTo(want), 'posed on the new geometry').toBeLessThan(1e-6);
  const held: string[] = [];
  getDefaultZoneRegistry().collectHeld(id, held);
  expect(held.sort()).toEqual(zone ? [zone] : []);
}

beforeAll(async () => {
  clearShared();
  handle = await createTestViewer('webgl');
  viewer = handle.viewer;
  viewer.loop.setPaused(HOLD, true);
  registerAllBehaviors(viewer.behaviors);
  setActiveEditTarget(null);
  plugin = new PathVisualizerPlugin();
  plugin.init(viewer);
}, 180_000);

afterAll(async () => {
  plugin?.dispose();
  await settleDevServer();
  handle?.dispose();
  clearShared();
}, 30_000);

beforeEach(() => {
  // Every test starts in the reset state: paused by exactly our hold.
  for (const r of viewer.runtime.pauseReasons) if (r !== HOLD) viewer.loop.setPaused(r, false);
  viewer.loop.setPaused(HOLD, true);
});

const VERBS: Array<[string, () => Promise<PathVerbResult>]> = [
  ['arc sweep', () => plugin.setArcSweep('P', 1, 45)],
  ['append at end', () => plugin.appendPathSegment('P', 'end')],
  ['append at start', () => plugin.appendPathSegment('P', 'start')],
  ['remove at end', () => plugin.removePathEndSegment('P', 'end')],
  ['remove at start', () => plugin.removePathEndSegment('P', 'start')],
  ['split', () => plugin.splitPathSegment('P', 0, 0.5)],
];

describe('9.9 + 9.5 — verb reset re-seeds the vehicle on the NEW geometry', () => {
  for (const [name, verb] of VERBS) {
    it(`${name}: new path object, configured start, pose, start zone; N steps match a fresh load`, async () => {
      await load(`verbs-${name}.glb`, model([LINE, ARC]));
      expect(viewer.runtime.state).toBe('paused');
      expect(viewer.simTime).toBe(0);
      expect(plugin.structuralAllowed()).toBe(true);
      // Drive a little and reset, so the vehicle is NOT at its start before the verb.
      for (let i = 0; i < 30; i++) tick();
      expect(plugin.structuralAllowed(), 'paused after running is locked').toBe(false);
      viewer.resetSimulation();
      expect(plugin.structuralAllowed()).toBe(true);

      const replaced = getDefaultPathNetwork().get('P');
      const r = await verb();
      expect(r.ok, JSON.stringify(r)).toBe(true);
      const edited = (r as { specs: PathSegmentSpec[] }).specs;
      expectSeededOnNewGeometry('AGV', 'P', replaced, 'Z');

      // 9.5: N fixed steps on the edited geometry …
      for (let i = 0; i < N_STEPS; i++) tick();
      const live = travelerOf('AGV');
      const liveS = live.s;
      const livePathLen = live.path!.length;
      const startMm = startMmOf('AGV');

      // … equal N steps of a FRESH load of exactly that geometry and start.
      await load(`verbs-${name}-fresh.glb`, model(edited, startMm));
      for (let i = 0; i < N_STEPS; i++) tick();
      const fresh = travelerOf('AGV');
      expect(fresh.path!.length).toBeCloseTo(livePathLen, 9);
      expect(liveS).toBeGreaterThan(Math.min(startMm / 1000, livePathLen) + 0.1); // it really drove
      expect(liveS).toBeCloseTo(fresh.s, 6);
    }, 120_000);
  }
});

describe('9.4 (real runtime) — the lock follows SimulationRuntime.state and the clocks', () => {
  it('running → locked; paused after ticks → locked; two pause reasons → unchanged; reset state → free; one start per verb', async () => {
    await load('verbs-lock.glb', model([LINE, ARC]));
    const before = getDefaultPathNetwork().get('P')!.segments.length;

    // Running: no pause reason at all.
    viewer.loop.setPaused(HOLD, false);
    expect(viewer.runtime.state).toBe('running');
    expect(await plugin.appendPathSegment('P', 'end')).toEqual({ ok: false, reason: 'sim-locked' });
    viewer.loop.setPaused(HOLD, true);

    // Paused after N counted ticks.
    for (let i = 0; i < 10; i++) tick();
    expect(viewer.simTime).toBeGreaterThan(0);
    expect(await plugin.splitPathSegment('P', 0, 0.5)).toEqual({ ok: false, reason: 'sim-locked' });

    // Two pause reasons (user + layout edit); releasing one keeps it paused → condition unchanged.
    viewer.loop.setPaused('layout-edit', true);
    viewer.resetSimulation();
    expect(plugin.structuralAllowed()).toBe(true);
    viewer.loop.setPaused('layout-edit', false);
    expect(viewer.runtime.state).toBe('paused');
    expect(plugin.structuralAllowed()).toBe(true);
    expect(getDefaultPathNetwork().get('P')!.segments.length).toBe(before);

    // The reset side effects run exactly once per verb.
    let starts = 0;
    const off = viewer.on('simulation-start', () => { starts++; });
    try {
      expect((await plugin.appendPathSegment('P', 'end')).ok).toBe(true);
      expect(starts).toBe(1);
      const sweep = await plugin.setArcSweep('P', 1, 60);
      expect(sweep.ok, JSON.stringify(sweep) + ' state=' + viewer.runtime.state + ' t=' + viewer.simTime).toBe(true);
      expect(starts).toBe(2);
    } finally {
      off();
    }
  }, 120_000);
});

describe('9.7 (real Agv) — chain-start shift follows the RESOLVED start path', () => {
  it('empty PathId and unresolvable PathId resolve to the Path node under the root', async () => {
    await load('verbs-resolve.glb', model([LINE, ARC]));
    const fleet = getDefaultAgvFleet();
    expect(fleet.get('AGV')!.startPathId).toBe('P');
    expect(fleet.get('AGV_EMPTY')!.startPathId).toBe('Q');
    expect(fleet.get('AGV_GONE')!.startPathId).toBe('R');

    // Prepend on Q: only AGV_EMPTY moves (+5 m), it re-seeds on the new Q.
    const oldQ = getDefaultPathNetwork().get('Q');
    expect((await plugin.appendPathSegment('Q', 'start')).ok).toBe(true);
    expect(startMmOf('AGV_EMPTY')).toBe(6000);
    expect(startMmOf('AGV_GONE')).toBe(1000);
    expect(startMmOf('AGV')).toBe(1500);
    expectSeededOnNewGeometry('AGV_EMPTY', 'Q', oldQ, null);
    // The vehicle stands where it stood before the prepend, in world terms.
    expect(travelerOf('AGV_EMPTY').path!.getAbsPosition(6).distanceTo(new Vector3(...([1, 0, 10] as V3)))).toBeLessThan(1e-6);

    // Remove at the start of R: −5 m, clamped at 0.
    expect((await plugin.appendPathSegment('R', 'end')).ok).toBe(true);
    expect((await plugin.removePathEndSegment('R', 'start')).ok).toBe(true);
    expect(startMmOf('AGV_GONE')).toBe(0);
    expectSeededOnNewGeometry('AGV_GONE', 'R', null, null);
  }, 120_000);
});
