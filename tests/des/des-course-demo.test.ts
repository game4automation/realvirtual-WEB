// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-451 §9.1 — `the real AGVDemo scene loads with three drivable vehicles` (carries F7).
//
// Loads public/demo-realvirtual/AGVDemo.glb through the real RVViewer load path,
// with behaviors auto-discovered as in main.ts. The scene is a tracked public
// binary: a missing scene, LFS pointer or scene without vehicles must fail.
// Expected topology (plan-451 ?2.3 / plan-921): PathSouth ? PathEast ? PathNorth
// ? PathWest ? PathSouth, EastCurve capacity 1, and three AGVs on PathSouth at
// 0/3000/6000 with TargetSpeed 1000/800/1200.
//
// Time is SIM time: the viewer's own real-time loop is held by a pause reason before
// the load, and every step below is an explicit `_tickOnce(1/60)`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Mesh, Vector3, type Object3D } from 'three';
import { createTestViewer, type TestViewerHandle } from '../helpers/create-test-viewer';
import type { RVViewer } from '../../src/core/rv-viewer';
import type { LoadResult } from '../../src/core/engine/rv-scene-loader';
import { registerAllBehaviors, matchesAny, extractGlbName } from '../../src/core/behaviors';
import AgvBehavior from '../../src/behaviors/Agv';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultAgvFleet, type AgvHandle } from '../../src/core/engine/rv-agv-fleet';

const SCENE_URL = '/demo-realvirtual/AGVDemo.glb';
const DT = 1 / 60;
/** Pause reason that keeps the viewer's real-time loop from advancing the sim behind the test's back. */
const HOLD = 'plan-451-test-9.1';

/** The four course paths (project doc line 13). */
const COURSE = ['PathEast', 'PathNorth', 'PathSouth', 'PathWest'];
/** The loop the course closes (project doc line 13). */
const SUCCESSOR: Record<string, string> = {
  PathSouth: 'PathEast', PathEast: 'PathNorth', PathNorth: 'PathWest', PathWest: 'PathSouth',
};
/** The three vehicles, ordered by StartPosition (project doc line 14, plan-451 §2.3). */
const VEHICLES = [
  { PathId: 'PathSouth', StartPosition: 0, TargetSpeed: 1000 },
  { PathId: 'PathSouth', StartPosition: 3000, TargetSpeed: 800 },
  { PathId: 'PathSouth', StartPosition: 6000, TargetSpeed: 1200 },
];
/**
 * Sim seconds of the drive check. PathSouth is 10 m long and straight; the front vehicle
 * (StartPosition 6000, TargetSpeed 1200, Acceleration 500 mm/s² default) is at full speed
 * after 2.4 s and still ~2 m before the end of PathSouth at 3 s — so every sample is a
 * straight-line sample and nobody is in a curve or a zone approach yet.
 */
const DRIVE_SECONDS = 3;

let handle: TestViewerHandle;
let viewer: RVViewer;
let result: LoadResult;

interface VehicleConfig { PathId: string; StartPosition: number; TargetSpeed: number }
const configOf = (node: Object3D): VehicleConfig =>
  (node.userData.realvirtual as Record<string, unknown>).Agv as VehicleConfig;
/** The active vehicles: an Agv registers its fleet handle only after it resolved a path. */
const vehicles = (): readonly AgvHandle[] => getDefaultAgvFleet().handleList;
/** The fleet's vehicles ordered like {@link VEHICLES} (by their own StartPosition). */
const byStart = (): AgvHandle[] =>
  [...vehicles()].sort((a, b) => configOf(a.node!).StartPosition - configOf(b.node!).StartPosition);
const worldPos = (node: Object3D): Vector3 => node.getWorldPosition(new Vector3());
const tick = (): void => { (viewer as unknown as { _tickOnce(dt: number): void })._tickOnce(DT); };

beforeAll(async () => {
  // F7: a missing scene, the dev server's HTML fallback or an un-smudged LFS pointer
  // must fail loudly here, not skip.
  const res = await fetch(SCENE_URL);
  expect(res.ok, `${SCENE_URL}: HTTP ${res.status}`).toBe(true);
  const data = await res.arrayBuffer();
  const magic = new TextDecoder().decode(new Uint8Array(data, 0, Math.min(4, data.byteLength)));
  expect(magic, `${SCENE_URL} is not a GLB (${data.byteLength} B) — LFS pointer or SPA fallback?`).toBe('glTF');

  handle = await createTestViewer('webgl');
  viewer = handle.viewer;
  viewer.loop.setPaused(HOLD, true);
  // Behaviors are enrolled BEFORE the first load, as main.ts does (src/main.ts:1046-1047).
  registerAllBehaviors(viewer.behaviors);
  // The project-document load call of main.ts (src/main.ts:1470): bytes in hand,
  // identity = the document URL — so the filename glob sees `AGVDemo`.
  result = await viewer.loadModel(SCENE_URL, { data, modelName: 'AGVDemo.glb', identityUrl: SCENE_URL });
  await viewer.whenSceneReady();
  viewer.scene.updateMatrixWorld(true);
}, 180_000);

afterAll(() => handle?.dispose());

describe('plan-451 §9.1 — the real AGVDemo scene loads with three drivable vehicles', () => {
  it('holds the real-time loop, so every step below is sim time', () => {
    expect(viewer.loop.isPaused).toBe(true);
  });

  it('registers the four course paths as one closed loop', () => {
    const net = getDefaultPathNetwork();
    expect(net.all().map((p) => p.id).sort()).toEqual(COURSE);
    for (const id of COURSE) expect(net.get(id)!.successorIds, id).toEqual([SUCCESSOR[id]]);
    const east = net.get('PathEast')!;
    expect(east.zoneId).toBe('EastCurve');
    expect(east.zoneCapacity).toBe(1);
  });

  it('three active Agv instances, each on PathSouth with the documented config', () => {
    const fleet = byStart();
    expect(fleet, `active vehicles: ${vehicles().map((h) => h.id).join(', ') || 'none'}`).toHaveLength(3);
    const south = getDefaultPathNetwork().get('PathSouth')!;
    fleet.forEach((h, i) => {
      const node = h.node!;
      // The persisted config, as the real loader delivered it to the bound node.
      expect(configOf(node), h.id).toMatchObject(VEHICLES[i]);
      // The path the instance actually resolved (stamped by Agv.setup()).
      expect((node.userData.realvirtual as Record<string, { Path?: string }>).AgvBehavior?.Path, h.id).toBe('PathSouth');
      // ...and the instance stands where StartPosition says on THAT path (no tick yet).
      const expected = south.getAbsPosition(VEHICLES[i].StartPosition / 1000);
      expect(worldPos(node).distanceTo(expected), `${h.id} start pose`).toBeLessThan(0.001);
      // Its body is its own chunk (Agv `bake: 'chunk'`) — the geometry rides along.
      let meshes = 0;
      node.traverse((n) => { if ((n as Mesh).isMesh) meshes++; });
      expect(meshes, `${h.id} has no body`).toBeGreaterThan(0);
    });
  });

  it('binds no ghost Agv at the model root, although the file name matches *AGV*', () => {
    // Precondition: without the payload precedence (plan-455 F5) the scene file name
    // alone would bind a fourth Agv at the model root — the measured ghost of plan-451.
    expect(matchesAny(AgvBehavior.models, extractGlbName(SCENE_URL))).toBe(true);
    const fleet = vehicles();
    expect(fleet.some((h) => h.node === result.root)).toBe(false);
    const binds = viewer.behaviors.getActiveBinds().filter((b) => b.behaviorId === 'Agv');
    expect(binds, binds.map((b) => b.nodePath).join(', ')).toHaveLength(3);
    expect(binds.map((b) => b.nodePath.split('/').pop()).sort())
      .toEqual(fleet.map((h) => h.node!.name).sort());
  });

  it(`drives: every vehicle moves, none exceeds its TargetSpeed, the free one reaches it (${DRIVE_SECONDS} s sim time)`, () => {
    const run = drive();
    run.fleet.forEach((h, i) => {
      expect(run.end[i].distanceTo(run.start[i]), `${h.id} did not drive`).toBeGreaterThan(0.5);
      // Speed is judged over sliding windows of WINDOW ticks (1/6 s) here; the strict
      // per-tick bound is the next test. A vehicle running on the wrong TargetSpeed breaks
      // this window bound.
      expect(maxWindowSpeed(run.stepMm[i]), `${h.id} faster than its TargetSpeed`)
        .toBeLessThanOrEqual(VEHICLES[i].TargetSpeed * 1.02);
    });
    // The front vehicle has ~33 m of free track ahead: it reaches ITS speed, 1200 mm/s —
    // a vehicle running on the schema default (1000) would not.
    expect(maxWindowSpeed(run.stepMm[2])).toBeGreaterThan(VEHICLES[2].TargetSpeed * 0.98);
  });

  // Strict per-tick bound over the same 180 ticks: no tick's rendered displacement may exceed
  // TargetSpeed x 1.02. Was `it.fails` (#202): AGV_1 jumped +25.03 mm in one tick at its
  // headway re-plan, because every vehicle advanced the shared clock itself and was synced
  // before its new plan start. Fixed by plan-632 (one shared time per fixed step).
  it('the rendered pose never jumps at a headway re-plan (plan-632, #202)', () => {
    const run = drive();
    run.fleet.forEach((h, i) => {
      expect(Math.max(...run.stepMm[i]) / DT, `${h.id} per-tick speed`)
        .toBeLessThanOrEqual(VEHICLES[i].TargetSpeed * 1.02);
    });
  });
});

/** Ticks per speed window: 10 x 1/60 s = 1/6 s. */
const WINDOW = 10;

interface DriveRun { fleet: AgvHandle[]; start: Vector3[]; end: Vector3[]; stepMm: number[][] }
let driveRun: DriveRun | null = null;

/**
 * Drive the scene for DRIVE_SECONDS of sim time ONCE and record every vehicle's rendered
 * world displacement per tick (mm). Shared by the drive test and the pinned per-tick
 * defect, so both judge the very same 180 ticks.
 */
function drive(): DriveRun {
  if (driveRun) return driveRun;
  const fleet = byStart();
  expect(fleet).toHaveLength(3);
  const start = fleet.map((h) => worldPos(h.node!));
  const last = start.map((p) => p.clone());
  const stepMm: number[][] = fleet.map(() => []);
  const steps = Math.round(DRIVE_SECONDS / DT);
  for (let k = 0; k < steps; k++) {
    tick();
    fleet.forEach((h, i) => {
      const p = worldPos(h.node!);
      stepMm[i].push(p.distanceTo(last[i]) * 1000);
      last[i].copy(p);
    });
  }
  expect(stepMm.every((s) => s.length === steps)).toBe(true);
  driveRun = { fleet, start, end: last, stepMm };
  return driveRun;
}

/** Highest average speed (mm/s) over any WINDOW consecutive ticks. */
function maxWindowSpeed(stepMm: number[]): number {
  let best = 0;
  for (let k = 0; k + WINDOW <= stepMm.length; k++) {
    let sum = 0;
    for (let j = k; j < k + WINDOW; j++) sum += stepMm[j];
    best = Math.max(best, sum / (WINDOW * DT));
  }
  return best;
}
