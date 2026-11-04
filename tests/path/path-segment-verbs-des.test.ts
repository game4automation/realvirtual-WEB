// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-453 — the structural path verbs in DES mode (private DES runner):
 *  - 9.4  DES paused after N ticks BEFORE the first event with t > 0
 *         (`simTime === 0`, `renderClock > 0`) is locked; after
 *         `resetSimulation()` the DES manager reports `isPaused === false`
 *         while the runtime is paused — the condition still reads "paused"
 *         (the pause comes from `SimulationRuntime.state` only); a `step()`
 *         onto an event at t > 0 locks, the reset frees again (a QUEUED event
 *         at t = 0 has no public fixture — see the plan's Implementation
 *         section; the "both clocks 0" rule itself is pinned in
 *         path-segment-verbs-commands.test.ts);
 *  - 9.9  the verb reset re-seeds the DES vehicle on the NEW path object at the
 *         configured start, holding exactly its start zone.
 *
 * `setMode('des')` is a no-op in the public build, so this file is
 * private-dependent (listed in tests/private-dependent-tests.json).
 * Every drive loop has a hard step bound.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Object3D } from 'three';
import { createDesRunner } from '@rv/plugins/des/register-des-runner';
import { objectToGlb } from '../../src/core/import/rv-import-object';
import { createTestViewer, type TestViewerHandle } from '../helpers/create-test-viewer';
import type { RVViewer } from '../../src/core/rv-viewer';
import { registerAllBehaviors } from '../../src/core/behaviors';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { getDefaultAgvFleet, type AgvTravelerState } from '../../src/core/engine/rv-agv-fleet';
import type { PathSegmentSpec } from '../../src/core/engine/rv-path';
import { PathVisualizerPlugin } from '../../src/plugins/path-visualizer-plugin';
import { setActiveEditTarget } from '../../src/core/hmi/rv-edit-target';
import { clearShared } from '../helpers/agv-harness';

const DT = 1 / 60;
const HOLD = 'plan-453-verbs-des';
/** Ticks "before the first event": far below the first arrival of a 4 m drive at 1 m/s. */
const PRE_EVENT_TICKS = 3;

const LINE: PathSegmentSpec = { kind: 'line', from: [0, 0, 0], to: [4, 0, 0] };
const ARC: PathSegmentSpec = { kind: 'arc', center: [4, 0, 2], radius: 2, startAngle: -90, degrees: 90, plane: 'XZ' };

function model(): Group {
  const root = new Group();
  root.name = 'VerbDesModel';
  const p = new Object3D();
  p.name = 'P';
  p.userData.realvirtual = {
    Path: { type: 'Path', version: 1, closed: false, align: [0, 1, 0], id: 'P', segments: [LINE, ARC], successors: [], zone: 'Z', zoneCapacity: 1 },
  };
  root.add(p);
  const a = new Object3D();
  a.name = 'AGV';
  a.userData.realvirtual = {
    LayoutObject: { Name: 'AGV' },
    Agv: { PathId: 'P', StartPosition: 1500, TargetSpeed: 1000, VehicleLength: 600, VehicleWidth: 400 },
  };
  const body = new Mesh(new BoxGeometry(0.4, 0.3, 0.6), new MeshBasicMaterial());
  body.position.y = 0.15;
  a.add(body);
  root.add(a);
  // A Source far away from the path: its first generation is an event at t = 0.
  const src = new Object3D();
  src.name = 'Source_1';
  src.position.set(0, 0, 30);
  src.userData.realvirtual = { Source: { Interval: 2, AutomaticGeneration: true } };
  const sbody = new Mesh(new BoxGeometry(0.3, 0.05, 0.3), new MeshBasicMaterial());
  sbody.name = 'SourceBody';
  src.add(sbody);
  root.add(src);
  return root;
}

const DEV_SERVER_SETTLE_MS = 2500;
const settleDevServer = (): Promise<void> => new Promise((r) => setTimeout(r, DEV_SERVER_SETTLE_MS));

let handle: TestViewerHandle;
let viewer: RVViewer;
let plugin: PathVisualizerPlugin;
const tick = (): void => { (viewer as unknown as { _tickOnce(dt: number): void })._tickOnce(DT); };

function travelerOf(id: string): AgvTravelerState {
  const h = getDefaultAgvFleet().get(id);
  expect(h, `${id} registered`).not.toBeNull();
  const out = {} as AgvTravelerState;
  expect(h!.travelerState!(out)).toBe(true);
  return out;
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
  const data = await objectToGlb(model());
  await viewer.loadModel('verbs-des.glb', { data });
  await viewer.whenSceneReady();
  viewer.scene.updateMatrixWorld(true);
  plugin.refresh();
}, 180_000);

afterAll(async () => {
  plugin?.dispose();
  await settleDevServer();
  handle?.dispose();
  clearShared();
}, 30_000);

describe('plan-453 in DES mode', () => {
  it('9.4: pre-event ticks lock; reset frees (DES manager unpaused, runtime paused); a step onto t > 0 locks', async () => {
    const kernel = viewer.simulationKernel!;
    expect(kernel.hasDesRunner(), 'private DES runner registered').toBe(true);
    kernel.setMode('des');
    expect(kernel.mode).toBe('des');
    const des = kernel.desControl()!;
    expect(des).not.toBeNull();
    viewer.resetSimulation();
    expect(viewer.runtime.state).toBe('paused');
    expect(viewer.simTime).toBe(0);
    expect(des.renderClock ?? 0).toBe(0);
    expect(plugin.structuralAllowed()).toBe(true);

    // N counted ticks before the first event with t > 0: event time 0, render clock > 0.
    for (let i = 0; i < PRE_EVENT_TICKS; i++) tick();
    expect(viewer.simTime, 'no event with t > 0 yet').toBe(0);
    expect(des.renderClock ?? 0).toBeGreaterThan(0);
    for (const verb of [
      () => plugin.setArcSweep('P', 1, 45),
      () => plugin.appendPathSegment('P', 'end'),
      () => plugin.removePathEndSegment('P', 'start'),
      () => plugin.splitPathSegment('P', 0, 0.5),
    ]) {
      expect(await verb()).toEqual({ ok: false, reason: 'sim-locked' });
    }
    expect(getDefaultPathNetwork().get('P')!.segments.length).toBe(2);

    // The trap of §2.4: after a reset the DES manager's OWN pause flag is false.
    viewer.resetSimulation();
    const manager = (kernel.activeExecutor as unknown as { manager?: { isPaused: boolean } }).manager;
    expect(manager, 'DES manager reachable').toBeDefined();
    expect(manager!.isPaused).toBe(false);
    expect(viewer.runtime.state).toBe('paused');
    expect(plugin.structuralAllowed()).toBe(true);

    // step(): the Source's first QUEUED event lies at t > 0 (its first generation
    // runs directly at start) — the event clock moves → locked; the reset frees.
    // A reset run starts like the first run: the movement authority's deferred
    // start flush may sit at t = 0 ahead of it (it is consumed by the pre-event
    // ticks above after the first reset), so step until the clock moves (bounded).
    const p0 = des.eventStats?.().processed ?? 0;
    expect(des.step()).toBe(true);
    for (let i = 0; i < 4 && viewer.simTime === 0; i++) expect(des.step()).toBe(true);
    expect(des.eventStats?.().processed ?? 0).toBeGreaterThan(p0);
    expect(viewer.simTime).toBeGreaterThan(0);
    expect(plugin.structuralAllowed()).toBe(false);
    expect(await plugin.splitPathSegment('P', 0, 0.5)).toEqual({ ok: false, reason: 'sim-locked' });
    viewer.resetSimulation();
    expect(plugin.structuralAllowed()).toBe(true);

    // The verb applies; its reset leaves the DES clocks at 0 and the queue fresh.
    expect((await plugin.splitPathSegment('P', 0, 0.5)).ok).toBe(true);
    expect(des.eventStats?.().processed ?? 0).toBe(p0);
    expect(viewer.simTime).toBe(0);
    expect(des.renderClock ?? 0).toBe(0);
  }, 120_000);

  it('9.9 (DES): the verb reset re-seeds the vehicle on the NEW path object', async () => {
    const kernel = viewer.simulationKernel!;
    expect(kernel.mode).toBe('des');
    viewer.resetSimulation();
    for (const verb of [
      () => plugin.appendPathSegment('P', 'start'),
      () => plugin.setArcSweep('P', getDefaultPathNetwork().get('P')!.segments.length - 1, 135),
      () => plugin.removePathEndSegment('P', 'end'),
    ]) {
      const replaced = getDefaultPathNetwork().get('P');
      const r = await verb();
      expect(r.ok, JSON.stringify(r)).toBe(true);
      const current = getDefaultPathNetwork().get('P')!;
      expect(current).not.toBe(replaced);
      const st = travelerOf('AGV');
      expect(st.path, 'DES traveler rides the NEW path object').toBe(current);
      const cfg = Number((getDefaultAgvFleet().get('AGV')!.node!.userData.realvirtual as Record<string, Record<string, unknown>>).Agv.StartPosition);
      expect(st.s).toBeCloseTo(Math.min(cfg / 1000, current.length), 9);
      const held: string[] = [];
      getDefaultZoneRegistry().collectHeld('AGV', held);
      expect(held).toEqual(['Z']);
    }
  }, 120_000);

  it('the private DES runner factory is present (this file is private-dependent)', () => {
    expect(typeof createDesRunner).toBe('function');
  });
});
