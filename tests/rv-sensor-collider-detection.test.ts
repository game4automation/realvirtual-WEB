// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2016 S5 fix — sensors detect a spawned MU by the union of its ACTIVE
 * colliders (Unity parity: `Physics.Raycast` / `OverlapBox` against colliders,
 * triggers included — the blow-moulding model sets `queriesHitTriggers`), not by its mesh box.
 * Box colliders count as oriented boxes, MeshColliders as their mesh bounds,
 * colliders on inactive nodes not at all. Transport keeps the mesh box. Without
 * any collider nothing changes.
 *
 * Rays hit authored colliders only (Unity parity): colliders must cover the part.
 * A ray through mesh outside the collider must miss.
 *
 * Every MU template is a 1 m tall bar (mesh y -0.5 … 0.5, local). `BarC`
 * carries a BoxCollider covering only the UPPER half (center y 0.25, size 0.5);
 * `BarM` carries no collider; `BarMesh` a MeshCollider.
 *
 *   Cell
 *    ├─ BarC / BarM / BarMesh  (MU templates, far away)
 *    ├─ SrcC / SrcM / SrcMesh  Source { ThisObjectAsMU: … }
 *    ├─ RayLow   Sensor (ray +Z, 1 m) at (2, 0.75, -0.5): crosses an MU at
 *    │           (2, 1, 0) through its LOWER half (y 0.75 = local -0.25)
 *    ├─ RayHigh  Sensor (ray +Z, 1 m) at (4, 1.25, -0.5): crosses the UPPER half
 *    ├─ BoxLow   Sensor (0.1 box) at (6, 0.7, 0): overlaps only the lower half
 *    ├─ BarWide  a bar whose collider sits BESIDE the mesh (Unity centre x -0.3)
 *    ├─ BarTrig  a bar whose only collider is a TRIGGER box on a child (upper half)
 *    ├─ BarMC    a bar plus a child mesh (upper half) carrying a MeshCollider
 *    ├─ Var      MU with two full-bar variants: VarA (group A, active, trigger box
 *    │           upper half) and VarB (group B, activeSelf false, box lower half)
 *    └─ SwB      Sensor + MUSwitcher { B } at (8, 1.25, 0)
 */

import { describe, it, expect } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, Scene, Vector3 } from 'three';
import { loadBakedGLB } from './helpers/load-baked-glb';
import type { RVMovingUnit } from '../src/core/engine/rv-mu';
import type { RVSource } from '../src/core/engine/rv-source';
import type { RVSensor } from '../src/core/engine/rv-sensor';
import { node, sceneToGlb } from './helpers/migrate-769-fixtures';
import { RV_INACTIVE_KEY } from '../src/core/engine/rv-authored-inactive';

function mesh(name: string, sx: number, sy: number, sz: number, rv?: Record<string, unknown>): Mesh {
  const m = new Mesh(new BoxGeometry(sx, sy, sz), new MeshBasicMaterial());
  m.name = name;
  if (rv) m.userData.realvirtual = rv;
  return m;
}

const BOX_UPPER_HALF = [{
  type: 'BoxCollider', isTrigger: false, enabled: true,
  center: { x: 0, y: 0.25, z: 0 }, size: { x: 0.2, y: 0.5, z: 0.2 },
}];

function bar(name: string, extras: Record<string, unknown>, x: number) {
  const n = node(name, { MU: {}, ...extras });
  n.position.set(x, 0, 0);
  n.add(mesh(`${name}_Body`, 0.2, 1, 0.2));
  return n;
}

async function build(): Promise<ArrayBuffer> {
  const scene = new Scene();
  scene.name = 'Cell';
  scene.add(
    bar('BarC', { colliders: BOX_UPPER_HALF }, -10),
    bar('BarM', {}, -12),
    bar('BarMesh', { colliders: [{ type: 'MeshCollider', isTrigger: false, enabled: true, convex: true }] }, -14),
    // Collider beside the mesh: Unity centre x -0.3 = glTF +0.3 (the X flip).
    bar('BarWide', { colliders: [{ ...BOX_UPPER_HALF[0], center: { x: -0.3, y: 0.25, z: 0 } }] }, -16),
  );
  const trig = bar('BarTrig', {}, -18);
  trig.add(node('Trig', { colliders: [{ ...BOX_UPPER_HALF[0], isTrigger: true }] }));
  const mc = bar('BarMC', {}, -20);
  const part = mesh('Part', 0.2, 0.5, 0.2, { colliders: [{ type: 'MeshCollider', isTrigger: false, enabled: true, convex: true }] });
  part.position.set(0, 0.25, 0);
  mc.add(part);
  const v = node('Var', { MU: {} });
  v.position.set(-22, 0, 0);
  v.add(
    mesh('VarA', 0.2, 1, 0.2, { Group: { GroupName: 'A' }, activeSelf: true, colliders: [{ ...BOX_UPPER_HALF[0], isTrigger: true }] }),
    mesh('VarB', 0.2, 1, 0.2, { Group: { GroupName: 'B' }, activeSelf: false, colliders: [{ ...BOX_UPPER_HALF[0], center: { x: 0, y: -0.25, z: 0 } }] }),
  );
  const swB = mesh('SwB', 0.1, 0.1, 0.1, { Sensor: {}, MUSwitcher: { SwitchToGroup: 'B' } });
  swB.position.set(8, 1.25, 0);
  scene.add(trig, mc, v, swB);
  for (const [src, tpl, y] of [['SrcC', 'BarC', 10], ['SrcM', 'BarM', 12], ['SrcMesh', 'BarMesh', 14], ['SrcWide', 'BarWide', 16],
    ['SrcTrig', 'BarTrig', 18], ['SrcMC', 'BarMC', 20], ['SrcVar', 'Var', 22]] as const) {
    const s = node(src, { Source: { ThisObjectAsMU: tpl, AutomaticGeneration: false, GenerateMU: true } });
    s.position.set(0, y, 0);
    scene.add(s);
  }
  const ray = (name: string, x: number, y: number) => {
    const n = node(name, { Sensor: { UseRaycast: true, RayCastLength: 1000, RayCastDirection: { x: 0, y: 0, z: 1 } } });
    n.position.set(x, y, -0.5);
    return n;
  };
  const boxLow = mesh('BoxLow', 0.1, 0.1, 0.1, { Sensor: {} });
  boxLow.position.set(6, 0.7, 0);
  scene.add(ray('RayLow', 2, 0.75), ray('RayHigh', 4, 1.25), boxLow);
  return sceneToGlb(scene);
}

async function load() {
  const result = await loadBakedGLB('sensor-collider.glb', new Scene(), { data: (await build()).slice(0), loadKinematicsSidecar: false });
  const tm = result.transportManager;
  const spawn = (src: string): RVMovingUnit => {
    const source = tm.sources.find((s: RVSource) => s.node.name === src)!;
    const mu = tm.spawnFromSource(source) as RVMovingUnit;
    expect(mu.isInstanced).toBe(false);
    return mu;
  };
  const sensor = (name: string): RVSensor => tm.sensors.find((s: RVSensor) => s.node.name === name)!;
  const place = (mu: RVMovingUnit, x: number, y: number, z: number): void => {
    const p = mu.node.parent!;
    p.updateWorldMatrix(true, false);
    mu.node.position.copy(p.worldToLocal(new Vector3(x, y, z)));
    mu.node.updateMatrixWorld(true);
    tm.update(1 / 60);
  };
  return { tm, spawn, sensor, place };
}

const size = (min: Vector3, max: Vector3): Vector3 => max.clone().sub(min);

describe('plan-2016 S5 fix — sensors detect the authored BoxCollider of an MU', () => {
  it('the MU keeps its mesh box for transport and gets the collider as detection box', async () => {
    const { spawn, place } = await load();
    const c = spawn('SrcC');
    place(c, 0, 1, 0);
    expect(size(c.aabb.min, c.aabb.max).y, 'transport box = mesh').toBeCloseTo(1, 2);
    expect(c.detectAabb).not.toBe(c.aabb);
    expect(size(c.detectAabb.min, c.detectAabb.max).y, 'detection box = collider').toBeCloseTo(0.5, 2);
    expect(c.detectAabb.min.y).toBeCloseTo(1, 2);   // collider bottom = MU centre
    const m = spawn('SrcM');
    expect(m.detectAabb, 'no collider: one shared box').toBe(m.aabb);
    const mc = spawn('SrcMesh');
    place(mc, 0, 3, 0);
    expect(size(mc.detectAabb.min, mc.detectAabb.max).y, 'MeshCollider on the root: its mesh bounds').toBeCloseTo(1, 2);
  });

  it('Unity collider-only: a ray through mesh outside the collider misses; through the collider it hits', async () => {
    const { spawn, sensor, place } = await load();
    const c = spawn('SrcC');
    place(c, 2, 1, 0);
    // Unity raycasts require a collider at the beam height, even inside the mesh.
    expect(sensor('RayLow').occupied, 'lower half: mesh only').toBe(false);
    expect(sensor('RayLow').occupiedMU).toBeNull();
    place(c, 50, 1, 0);
    expect(sensor('RayLow').occupied, 'and free again when the MU leaves').toBe(false);
    place(c, 4, 1, 0);
    expect(sensor('RayHigh').occupied, 'upper half: collider').toBe(true);
    expect(sensor('RayHigh').occupiedMU).toBe(c);
  });

  it('without a collider (or with a MeshCollider) the mesh is detected as before', async () => {
    const { spawn, sensor, place } = await load();
    const m = spawn('SrcM');
    place(m, 2, 1, 0);
    expect(sensor('RayLow').occupied).toBe(true);
    place(m, 50, 1, 0);
    expect(sensor('RayLow').occupied).toBe(false);
    const mc = spawn('SrcMesh');
    place(mc, 2, 1, 0);
    expect(sensor('RayLow').occupied).toBe(true);
  });

  // Collision mode continues to overlap the collider box alone.
  it('a collision (box) sensor overlaps the collider, not the mesh', async () => {
    const { spawn, sensor, place } = await load();
    const c = spawn('SrcC');
    place(c, 6, 1, 0);   // BoxLow at y 0.7 sits in the mesh's lower half only
    expect(sensor('BoxLow').occupied).toBe(false);
    place(c, 6, 0.5, 0);   // collider now spans y 0.5 … 1.0
    expect(sensor('BoxLow').occupied).toBe(true);
    const m = spawn('SrcM');
    place(c, 50, 0, 0);
    place(m, 6, 1, 0);
    expect(sensor('BoxLow').occupied, 'no collider: mesh overlap').toBe(true);
  });

  it('the grid path finds a detection box that reaches beyond the mesh box (X flipped Unity → glTF)', async () => {
    const { tm, spawn, sensor, place } = await load();
    tm.bruteForceThreshold = 0;   // force the MU grid for the sensor pass
    const w = spawn('SrcWide');
    place(w, 3.7, 1, 0);   // mesh x 3.6 … 3.8 (grid cell 3), collider x 3.9 … 4.1 (cell 4)
    expect(w.detectAabb.min.x).toBeCloseTo(3.9, 2);
    expect(w.aabb.max.x).toBeCloseTo(3.8, 2);
    expect(sensor('RayHigh').occupied, 'ray at x 4 hits the collider only').toBe(true);
    place(w, 4.3, 1, 0);   // mesh x 4.2 … 4.4, collider x 4.5 … 4.7: the ray at x 4 misses both
    expect(sensor('RayHigh').occupied, 'mesh beside the ray, collider past it').toBe(false);
  });
});

describe('plan-2016 S5 follow-up — every ACTIVE collider of the MU subtree counts', () => {
  it('a TRIGGER box collider on a child counts (Unity queriesHitTriggers)', async () => {
    const { spawn, sensor, place } = await load();
    const t = spawn('SrcTrig');
    place(t, 2, 1, 0);
    expect(sensor('RayLow').occupied, 'Unity: mesh below the child trigger has no collider').toBe(false);
    place(t, 4, 1, 0);
    expect(sensor('RayHigh').occupied, 'upper half: the child trigger').toBe(true);
  });

  it('a MeshCollider on a child counts as its mesh bounds', async () => {
    const { spawn, sensor, place } = await load();
    const m = spawn('SrcMC');
    place(m, 0, 1, 0);
    expect(size(m.detectAabb.min, m.detectAabb.max).y).toBeCloseTo(0.5, 2);
    expect(m.detectAabb.min.y).toBeCloseTo(1, 2);
    expect(size(m.aabb.min, m.aabb.max).y, 'transport keeps the whole mesh').toBeCloseTo(1, 2);
    place(m, 2, 1, 0);
    expect(sensor('RayLow').occupied, 'Unity: below the child MeshCollider is mesh only').toBe(false);
    place(m, 50, 1, 0);
    expect(sensor('RayLow').occupied).toBe(false);
  });

  it('a MUSwitcher variant change re-derives the detection box from the now active colliders', async () => {
    const { spawn, place } = await load();
    const v = spawn('SrcVar');
    place(v, 0, 1, 0);
    expect(v.detectAabb.min.y, 'VarA trigger: upper half').toBeCloseTo(1, 2);
    expect(v.detectAabb.max.y).toBeCloseTo(1.5, 2);
    place(v, 8, 1, 0);   // SwB overlaps the upper half → switch to B
    const varB = v.node.children.find((c) => c.name === 'VarB')!;
    expect(varB.visible).toBe(true);
    expect(varB.userData[RV_INACTIVE_KEY]).toBeUndefined();
    expect(v.detectAabb.min.y, 'VarB box: lower half').toBeCloseTo(0.5, 2);
    expect(v.detectAabb.max.y).toBeCloseTo(1, 2);
  });
});

