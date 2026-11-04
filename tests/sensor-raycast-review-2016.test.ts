// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2016 — Codex post-implementation review of the raycast sensor parity, as it
 * stands after Thomas' withdrawals of 2026-10-29:
 *
 *  (1) a list without a usable layer name — missing field, EMPTY list, or the broken
 *      Unity export (`[{}]`) — means NO filter; resolvable names add the own layer.
 *      "Explicit empty = own layer only" is WITHDRAWN (point (e) hardening): a model
 *      whose export writes an empty array was blind;
 *  (2) a ROTATED child BoxCollider is tested as its own oriented box, not as the
 *      axis-aligned enclosure in the MU frame (no phantom hit in the corners, no
 *      false "origin inside"; point (c2) reinstated 2026-10-30);
 *  (3) the beam moving between two colliders of the SAME node (clone) or of a
 *      pooled MU is a collider change: exit + enter like Unity (point (f), withdrawn
 *      on 2026-10-29 and REINSTATED on 2026-10-30 — measured, the blow-moulding line QC line ran
 *      1/1/1 instead of 20/19/19 without it);
 *  (4) a non-MU collider removed from the scene or switched inactive stops
 *      blocking without any change of the sensor set; switched on, it blocks again
 *      (point (c), withdrawn 2026-10-29 and REINSTATED 2026-10-30 on Thomas'
 *      decision — the blow-moulding line run stayed red at 1/1/1 without it);
 *  (5) two models after each other with different layer tables: the table is reset
 *      with the scene and masks are rebuilt (layer revision).
 *
 * The pusher dispose case lives in mu-pusher.test.ts, the demo constellation in
 * sensor-demo-light-barrier.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, Object3D, Quaternion, Scene, Vector3 } from 'three';
import { loadBakedGLB } from './helpers/load-baked-glb';
import { node, sceneToGlb } from './helpers/migrate-769-fixtures';
import { clearAllProblems } from '../src/core/hmi/problems-store';
import {
  buildRaycastLayerMask, getLayerRevision, layerIndexOf, layerPasses, registerFileLayerNames, resetLayerNames,
} from '../src/core/engine/rv-layers';
import { setNodeActive } from '../src/core/engine/rv-authored-inactive';
import { MUInstancePool, RVMovingUnit } from '../src/core/engine/rv-mu';
import type { InstancedMovingUnit } from '../src/core/engine/rv-mu';
import { rayDetectDist } from '../src/core/engine/rv-sensor';
import type { RVSensor } from '../src/core/engine/rv-sensor';
import type { RVSource } from '../src/core/engine/rv-source';

type AnyMU = RVMovingUnit | InstancedMovingUnit;

const box = (sx: number, sy: number, sz: number, cx = 0) => ({
  type: 'BoxCollider', isTrigger: false, enabled: true,
  center: { x: cx, y: 0, z: 0 }, size: { x: sx, y: sy, z: sz },
});

function body(name: string, s = 0.05): Mesh {
  const m = new Mesh(new BoxGeometry(s, s, s), new MeshBasicMaterial());
  m.name = name;
  return m;
}

interface RaySpec { layers?: unknown; layer?: number; at: [number, number, number]; dir: { x: number; y: number; z: number } }

async function build(o: {
  rays: Record<string, RaySpec>;
  table?: string[] | null;
  statics?: Record<string, [number, [number, number, number]]>;
  slugLayer?: number;
}): Promise<ArrayBuffer> {
  const scene = new Scene();
  scene.name = 'Cell';
  if (o.table !== null) scene.userData.realvirtual = { layerNames: o.table ?? Array.from({ length: 32 }, (_, i) => (i === 24 ? 'MauserParts' : '')) };
  // Rot: one thin bar collider (1.0 × 0.1 × 0.05) on a child turned 45° about Y.
  const rot = node('Rot', { MU: {}, layer: 17 });
  rot.position.set(-10, 0, 0);
  rot.add(body('Rot_Body', 0.02));
  const bar = node('Bar', { layer: 17, colliders: [box(1.0, 0.1, 0.05)] });
  bar.rotation.y = Math.PI / 4;
  rot.add(bar);
  // Twin: TWO box colliders on the SAME node, at x = ±0.15 (Unity centre x is mirrored).
  // Two meshes → the Source clones (no instancing).
  const twin = node('Twin', { MU: {}, layer: 17, colliders: [box(0.1, 0.1, 0.1, -0.15), box(0.1, 0.1, 0.1, 0.15)] });
  twin.position.set(-12, 0, 0);
  twin.add(body('Twin_A'), body('Twin_B'));
  // Slug: a plain MU on its own layer (default rvMU).
  const slug = node('Slug', { MU: {}, layer: o.slugLayer ?? 17, colliders: [box(0.2, 0.2, 0.2)] });
  slug.position.set(-14, 0, 0);
  slug.add(body('Slug_Body', 0.2));
  scene.add(rot, twin, slug);
  for (const [src, tpl, y] of [['SrcRot', 'Rot', 10], ['SrcTwin', 'Twin', 12], ['SrcSlug', 'Slug', 14]] as const) {
    const s = node(src, { Source: { ThisObjectAsMU: tpl, AutomaticGeneration: false, GenerateMU: true } });
    s.position.set(0, y, 0);
    scene.add(s);
  }
  for (const [name, r] of Object.entries(o.rays)) {
    const sensor: Record<string, unknown> = { UseRaycast: true, RayCastLength: 1000, RayCastDirection: r.dir };
    if (r.layers !== undefined) sensor.AdditionalRayCastLayers = r.layers;
    const n = node(name, { layer: r.layer ?? 15, Sensor: sensor });
    n.position.set(...r.at);
    scene.add(n);
  }
  for (const [name, [layer, at]] of Object.entries(o.statics ?? {})) {
    const n = node(name, { layer, colliders: [box(0.4, 0.4, 0.02)] });
    n.position.set(...at);
    scene.add(n);
  }
  return sceneToGlb(scene);
}

async function load(o: Parameters<typeof build>[0], file = 'sensor-raycast-review.glb') {
  const result = await loadBakedGLB(file, new Scene(), { data: (await build(o)).slice(0), loadKinematicsSidecar: false, expectChunks: false });
  const tm = result.transportManager;
  tm.preferCloneMU = true;
  const spawn = (src: string): AnyMU => tm.spawnFromSource(tm.sources.find((s: RVSource) => s.node.name === src)!) as AnyMU;
  const sensor = (name: string): RVSensor => tm.sensors.find((s: RVSensor) => s.node.name === name)!;
  const place = (mu: AnyMU, x: number, y: number, z: number): void => {
    if (mu.isInstanced) { mu.setPosition(new Vector3(x, y, z)); return; }
    const n = (mu as RVMovingUnit).node;
    const p = n.parent!;
    p.updateWorldMatrix(true, false);
    n.position.copy(p.worldToLocal(new Vector3(x, y, z)));
    n.updateMatrix();
    n.updateMatrixWorld(true);
  };
  const tick = (n = 1): void => { for (let i = 0; i < n; i++) tm.update(1 / 60); };
  const enters = (s: RVSensor): AnyMU[] => {
    const out: AnyMU[] = [];
    s.addMuEnterListener((mu) => out.push(mu));
    return out;
  };
  let root: Object3D = tm.sensors[0].node;
  while (root.parent) root = root.parent;
  return { tm, spawn, sensor, place, tick, enters, root };
}

const DOWN = { x: 0, y: -1, z: 0 };
const PLUS_Z = { x: 0, y: 0, z: 1 };

beforeEach(() => resetLayerNames());
afterEach(() => clearAllProblems());

describe('plan-2016 — AdditionalRayCastLayers (Unity Sensor.Start, empty = no filter since 2026-10-29)', () => {
  it('mask: resolvable names + own layer; empty, missing or broken list = no filter', () => {
    // Thomas 2026-10-29: "explicit empty = own layer only" blinded every model whose
    // Unity export wrote an empty array — an unusable list means no filter.
    expect(buildRaycastLayerMask([], 15).mask, 'empty list = no filter').toBeNull();
    expect(buildRaycastLayerMask(['rvMU'], 15).mask).toBe((1 << 15) | (1 << 17));
    expect(buildRaycastLayerMask(undefined, 15).mask).toBeNull();
    expect(buildRaycastLayerMask([{}], 15).mask, 'broken legacy export').toBeNull();
    expect(buildRaycastLayerMask([{}], 15).broken, 'and it is reported, so the sensor can warn').toBe(true);
    expect(buildRaycastLayerMask([], 15).broken, 'an empty list is not the broken export').toBeFalsy();
    expect(buildRaycastLayerMask(['rvMU', {}], 15).mask, 'broken entries are skipped').toBe((1 << 15) | (1 << 17));
  });

  it('a sensor with an empty, a missing or a broken list sees the MU on any layer', async () => {
    const at = (x: number): [number, number, number] => [x, 1, -0.5];
    const { spawn, sensor, place, tick } = await load({
      rays: {
        Empty15: { layers: [], at: at(2), dir: PLUS_Z },
        Empty17: { layers: [], layer: 17, at: at(4), dir: PLUS_Z },
        Missing: { at: at(6), dir: PLUS_Z },
        Broken: { layers: [{}], at: at(8), dir: PLUS_Z },
      },
    });
    const mus = [2, 4, 6, 8].map((x) => { const m = spawn('SrcSlug'); place(m, x, 1, 0.3); return m; });
    tick();
    expect(sensor('Empty15').rayLayerMask, 'empty list = no mask').toBeNull();
    expect(sensor('Empty15').occupiedMU, 'empty list (export artefact) = every layer').toBe(mus[0]);
    expect(sensor('Empty17').occupiedMU, 'own layer rvMU with [] sees it').toBe(mus[1]);
    expect(sensor('Missing').occupiedMU, 'field missing (old export) = every layer').toBe(mus[2]);
    expect(sensor('Broken').occupiedMU, 'broken legacy list = every layer').toBe(mus[3]);
    // A name that resolves still filters — the one documented Mauser requirement.
    expect(buildRaycastLayerMask(['MauserParts'], 15).mask).toBe((1 << 15) | (1 << 24));
  });
});

describe('plan-2016 Codex review — a rotated child collider is its own oriented box', () => {
  it('a vertical beam through the enclosure corner misses the bar; a beam starting there hits it', async () => {
    const { spawn, sensor, place, tick } = await load({
      rays: {
        Corner: { layers: ['rvMU'], at: [2.3, 1, 0.3], dir: DOWN },
        // RayCastDirection is in Unity axes: Unity +X = web -X.
        Inside: { layers: ['rvMU'], at: [5.3, 0.5, 0.3], dir: { x: 1, y: 0, z: 0 } },
      },
    });
    const a = spawn('SrcRot');
    const b = spawn('SrcRot');
    place(a, 2, 0.5, 0);
    place(b, 5, 0.5, 0);
    tick();
    expect(sensor('Corner').occupied, 'the corner of the enclosure is empty space').toBe(false);
    expect(sensor('Inside').occupiedMU, 'origin outside the bar (inside its enclosure): the bar is hit').toBe(b);
    // The distance is the true one: the bar crosses z = 0.3 at x = 4.7 → 0.6 m.
    const d = rayDetectDist(b, new Vector3(5.3, 0.5, 0.3), new Vector3(-1, 0, 0), 10);
    expect(d).toBeCloseTo(0.6 - 0.025 * Math.SQRT2, 3);
  });
});

describe('plan-2016 — collider identity: node + index, pooled instances per collider', () => {
  it('clone: the beam moving from one collider of a node to the other enters again', async () => {
    const { spawn, sensor, place, tick, enters } = await load({ rays: { Ray: { layers: ['rvMU'], at: [2, 1, -0.5], dir: PLUS_Z } } });
    const inRay = enters(sensor('Ray'));
    const twin = spawn('SrcTwin');
    expect(twin.isInstanced).toBe(false);
    place(twin, 2 + 0.15, 1, 0.3);    // beam on the collider at x = -0.15
    tick();
    expect(inRay).toEqual([twin]);
    place(twin, 2 - 0.15, 1, 0.3);    // beam on the collider at x = +0.15 (same node)
    tick();
    // Point (f) REINSTATED 2026-10-30. Measured on the blow-moulding line: with one enter
    // per stay the QC line ran 1/1/1 instead of 20/19/19 — the first hose stayed
    // `_inside` the loading gripper's sensor forever, so DirectlyGrip never fired
    // again. Its MUs carry several colliders (FassMU 3, Source_Schlauch 5); the
    // standard demo's turbine carries one, so the rule cannot change anything there.
    expect(inRay, 'collider change on the same node = exit + enter').toEqual([twin, twin]);
    tick();
    expect(inRay, 'staying on it does not re-enter').toEqual([twin, twin]);
  });

  it('pooled: two template colliders are two identities, two primitives of one collider are one', () => {
    const pool = new MUInstancePool(new BoxGeometry(0.1, 0.1, 0.1), new MeshBasicMaterial(), 'Tpl', new Vector3(0.25, 0.05, 0.05));
    pool.detectHalf = new Vector3(0.25, 0.05, 0.05);
    pool.detectCenter = new Vector3();
    const half = new Vector3(0.05, 0.05, 0.05);
    pool.detectParts = [-0.2, 0, 0.2].map((x) => ({ half, center: new Vector3(x, 0, 0) }));
    pool.detectObbs = [0, 1, 1].map((ci) => ({ rot: new Quaternion(), half: half.clone(), colliderIndex: ci }));
    pool.detectColliderIds = [0, 1, 1];
    const mu = pool.spawn(new Vector3(0, 1, 0), new Quaternion(), 'pooled', 'Src');
    expect(mu.detectColliderKey(0)).toBe(mu.detectColliderKey(1));
    expect(mu.detectColliderSub(0)).not.toBe(mu.detectColliderSub(1));
    expect(mu.detectColliderSub(1)).toBe(mu.detectColliderSub(2));
    const other = pool.spawn(new Vector3(0, 2, 0), new Quaternion(), 'pooled2', 'Src');
    expect(other.detectColliderKey(0)).not.toBe(mu.detectColliderKey(0));
  });

  it('pooled: the beam moving between template colliders enters again', async () => {
    const { tm, sensor, tick, enters } = await load({ rays: { Ray: { layers: ['rvMU'], at: [2, 1, -0.5], dir: PLUS_Z } } });
    const pool = new MUInstancePool(new BoxGeometry(0.1, 0.1, 0.1), new MeshBasicMaterial(), 'Tpl', new Vector3(0.25, 0.05, 0.05));
    pool.layer = 17;
    pool.detectHalf = new Vector3(0.25, 0.05, 0.05);
    pool.detectCenter = new Vector3();
    pool.detectPartLayers = [17, 17];
    const half = new Vector3(0.05, 0.05, 0.05);
    pool.detectParts = [-0.2, 0.2].map((x) => ({ half, center: new Vector3(x, 0, 0) }));
    pool.detectObbs = [0, 1].map((ci) => ({ rot: new Quaternion(), half: half.clone(), colliderIndex: ci }));
    pool.detectColliderIds = [0, 1];
    const mu = pool.spawn(new Vector3(2.2, 1, 0.3), new Quaternion(), 'pooled', 'Src');
    tm.mus.push(mu);
    tm.reindexMU(mu);
    const inRay = enters(sensor('Ray'));
    tick();
    expect(inRay).toEqual([mu]);
    mu.setPosition(new Vector3(1.8, 1, 0.3));
    tm.reindexMU(mu);
    tick();
    // Point (f) reinstated 2026-10-30 — the pooled MUs of the blow-moulding line carry several
    // template colliders, and the loading gripper only re-grips on a fresh enter.
    expect(inRay, 'another template collider of the same instance = exit + enter').toEqual([mu, mu]);
    tick();
    expect(inRay).toEqual([mu, mu]);
  });
});

describe('plan-2016 Codex review — non-MU colliders follow removal and SetActive', () => {
  // Point (c) reinstated 2026-10-30 on Thomas' decision, after the blow-moulding line acceptance run
  // stayed red at 1/1/1 with (c) out: the blocking collider is what stops the loading
  // gripper's beam at its own jaws instead of reaching further hoses. The earlier reason
  // "no blocker on any of the 18 Mauser beams" was measured while the collider index was
  // not collected at all. Point (b) stays out.
  it('a plate removed or switched off stops blocking without a sensor change; switched on it blocks again', async () => {
    const { tm, spawn, sensor, place, tick, root } = await load({
      rays: { Ray: { layers: ['rvMU', 'rvTransport'], at: [2, 1, -0.5], dir: PLUS_Z } },
      statics: { Plate: [16, [2, 1, 0]] },
    });
    const mu = spawn('SrcSlug');
    place(mu, 2, 1, 0.3);
    tick();
    const s = sensor('Ray');
    expect(s.occupied).toBe(true);
    expect(s.occupiedMU, 'the plate blocks the beam').toBeNull();
    const plate = root.getObjectByName('Plate')!;
    setNodeActive(plate, false);
    tick();
    expect(s.occupiedMU, 'switched off: the beam reaches the MU').toBe(mu);
    setNodeActive(plate, true);
    tick();
    expect(s.occupiedMU, 'switched on again: it blocks').toBeNull();
    const parent = plate.parent!;
    plate.removeFromParent();
    tick();
    expect(s.occupiedMU, 'removed from the scene: the beam reaches the MU').toBe(mu);
    // A new collider in the scene is picked up after a topology notification.
    parent.add(plate);
    tm.notifyTopologyChanged();
    tick();
    expect(s.occupiedMU, 'back in the scene: it blocks').toBeNull();
  });
});

describe('plan-2016 Codex review — the layer table belongs to the scene', () => {
  it('reset clears a former model\'s names; masks rebuild against the new table', async () => {
    const tableA = Array.from({ length: 32 }, (_, i) => (i === 24 ? 'MauserParts' : ''));
    const tableB = Array.from({ length: 32 }, (_, i) => (i === 25 ? 'MauserParts' : i === 17 ? 'rvMU' : ''));
    const a = await load({ rays: { Ray: { layers: ['MauserParts'], at: [2, 1, -0.5], dir: PLUS_Z } }, table: tableA, slugLayer: 24 }, 'layers-a.glb');
    const slugA = a.spawn('SrcSlug');
    a.place(slugA, 2, 1, 0.3);
    a.tick();
    expect(layerIndexOf('MauserParts')).toBe(24);
    expect(a.sensor('Ray').occupiedMU).toBe(slugA);
    const maskA = a.sensor('Ray').rayLayerMask;

    // The viewer's clearModel(): the scene context ends.
    const rev = getLayerRevision();
    resetLayerNames();
    expect(getLayerRevision()).not.toBe(rev);
    expect(layerIndexOf('MauserParts'), 'the old model\'s name is gone').toBe(-1);

    const b = await load({ rays: { Ray: { layers: ['MauserParts'], at: [2, 1, -0.5], dir: PLUS_Z } }, table: tableB, slugLayer: 25 }, 'layers-b.glb');
    expect(layerIndexOf('MauserParts')).toBe(25);
    expect(layerIndexOf('rvMUSensor'), 'an empty entry never clears a standard layer').toBe(13);
    const slugB = b.spawn('SrcSlug');
    b.place(slugB, 2, 1, 0.3);
    b.tick();
    expect(b.sensor('Ray').occupiedMU).toBe(slugB);
    // A mask built against the old table is rebuilt (revision), not reused.
    const maskAfter = a.sensor('Ray').rayLayerMask;
    expect(maskAfter).not.toBe(maskA);
    expect(layerPasses(maskAfter, 25)).toBe(true);
    expect(layerPasses(maskAfter, 24)).toBe(false);

    // A later table (a placed asset) only adds names.
    registerFileLayerNames({ realvirtual: { layerNames: Array.from({ length: 32 }, (_, i) => (i === 26 ? 'Extra' : '')) } });
    expect(layerIndexOf('MauserParts')).toBe(25);
    expect(layerIndexOf('Extra')).toBe(26);
  });
});
