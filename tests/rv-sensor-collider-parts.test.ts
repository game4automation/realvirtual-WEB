// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2016 S5 — Codex post-implementation findings on the collider detection:
 *  (a) the union of several colliders is only the broadphase; a sensor must hit
 *      one of the single collider boxes (the union fills the gap between them);
 *      Unity raycasts do not hit mesh in a gap between authored colliders;
 *  (b) a spawned clone keeps "object in its own right" and "MU root" through the
 *      strip of its rv-extras, so a MeshCollider does not swallow a child object's
 *      mesh and a nested MU's colliders stay out;
 *  (c) a pre-placed MU gets its detection shape too;
 *  (d) `refreshShapeFromMeshes` refreshes the detection shape even when the mesh
 *      box is empty.
 *
 * Every bar is 1 m tall (mesh y -0.5 … 0.5, local), 0.2 m wide.
 *   Caps     MU, two box colliders: top cap y 0.4 … 0.5, bottom cap y -0.5 … -0.4
 *   Owner    MU root (no mesh) with a MeshCollider; children: Body (plain bar),
 *            Handle (own rv-extras, mesh at y 2 … 2.2), Kid (a nested MU with a
 *            box collider at y 3)
 *   PreC     pre-placed MU (no Source), box collider over the upper half
 *   RayMid   Sensor (ray +Z) at (2, 1, -0.5): crosses a bar at (2, 1, 0) in its MIDDLE
 *   RayTop   Sensor (ray +Z) at (4, 1.45, -0.5): crosses the top cap
 */

import { describe, it, expect } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, Object3D, Scene, Vector3 } from 'three';
import { loadBakedGLB } from './helpers/load-baked-glb';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import type { RVSource } from '../src/core/engine/rv-source';
import type { RVSensor } from '../src/core/engine/rv-sensor';
import { node, sceneToGlb } from './helpers/migrate-769-fixtures';

function mesh(name: string, sx: number, sy: number, sz: number, rv?: Record<string, unknown>): Mesh {
  const m = new Mesh(new BoxGeometry(sx, sy, sz), new MeshBasicMaterial());
  m.name = name;
  if (rv) m.userData.realvirtual = rv;
  return m;
}

const box = (cy: number, sy: number, trigger = false) => ({
  type: 'BoxCollider', isTrigger: trigger, enabled: true,
  center: { x: 0, y: cy, z: 0 }, size: { x: 0.2, y: sy, z: 0.2 },
});

async function build(): Promise<ArrayBuffer> {
  const scene = new Scene();
  scene.name = 'Cell';
  const caps = node('Caps', { MU: {}, colliders: [box(0.45, 0.1), box(-0.45, 0.1)] });
  caps.position.set(-10, 0, 0);
  caps.add(mesh('Caps_Body', 0.2, 1, 0.2));
  const owner = node('Owner', { MU: {}, colliders: [{ type: 'MeshCollider', isTrigger: false, enabled: true, convex: true }] });
  owner.position.set(-12, 0, 0);
  const body = mesh('Body', 0.2, 1, 0.2);
  const handle = mesh('Handle', 0.2, 0.2, 0.2, { layer: 0 });
  handle.position.set(0, 2.1, 0);
  const kid = node('Kid', { MU: {}, colliders: [box(0, 0.2)] });
  kid.position.set(0, 3, 0);
  kid.add(mesh('Kid_Body', 0.2, 0.2, 0.2));
  owner.add(body, handle, kid);
  const pre = node('PreC', { MU: {}, colliders: [box(0.25, 0.5)] });
  pre.position.set(20, 1, 0);
  pre.add(mesh('PreC_Body', 0.2, 1, 0.2));
  scene.add(caps, owner, pre);
  for (const [src, tpl, y] of [['SrcCaps', 'Caps', 10], ['SrcOwner', 'Owner', 12]] as const) {
    const s = node(src, { Source: { ThisObjectAsMU: tpl, AutomaticGeneration: false, GenerateMU: true } });
    s.position.set(0, y, 0);
    scene.add(s);
  }
  const ray = (name: string, x: number, y: number) => {
    const n = node(name, { Sensor: { UseRaycast: true, RayCastLength: 1000, RayCastDirection: { x: 0, y: 0, z: 1 } } });
    n.position.set(x, y, -0.5);
    return n;
  };
  const boxMid = mesh('BoxMid', 0.05, 0.05, 0.05, { Sensor: {} });
  boxMid.position.set(6, 1, 0);
  scene.add(ray('RayMid', 2, 1), ray('RayTop', 4, 1.45), boxMid);
  return sceneToGlb(scene);
}

async function load() {
  const result = await loadBakedGLB('sensor-collider-parts.glb', new Scene(), { data: (await build()).slice(0), loadKinematicsSidecar: false });
  const tm = result.transportManager;
  const spawn = (src: string): RVMovingUnit => {
    const source = tm.sources.find((s: RVSource) => s.node.name === src)!;
    return tm.spawnFromSource(source) as RVMovingUnit;
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

const sizeY = (a: { min: Vector3; max: Vector3 }): number => a.max.y - a.min.y;

describe('plan-2016 S5 Codex fixes — collider detection', () => {
  it('(a) two separate colliders: Unity collider-only: neither ray nor box sensor detects the gap', async () => {
    const { spawn, sensor, place } = await load();
    const c = spawn('SrcCaps');
    place(c, 2, 1, 0);
    expect(sizeY(c.detectAabb), 'union spans both caps').toBeCloseTo(1, 2);
    expect(c.detectParts?.length).toBe(2);
    // The union and mesh fill this gap, but Unity requires an actual collider hit.
    expect(sensor('RayMid').occupied, 'ray through the collider gap').toBe(false);
    place(c, 50, 1, 0);
    expect(sensor('RayMid').occupied).toBe(false);
    place(c, 4, 1, 0);
    expect(sensor('RayTop').occupied, 'ray through the top cap').toBe(true);
    place(c, 6, 1, 0);
    expect(sensor('BoxMid').occupied, 'box sensor in the gap').toBe(false);
    place(c, 6, 1.45, 0);         // bottom cap centre at y 1.0 = the box sensor
    expect(sensor('BoxMid').occupied, 'box sensor in the bottom cap').toBe(true);
  });

  it('(b) after the strip a MeshCollider counts only its own primitives, a nested MU stays out', async () => {
    const { spawn, place } = await load();
    const o = spawn('SrcOwner');
    place(o, 0, 1, 0);
    expect(o.node.userData.realvirtual, 'clone is stripped').toBeUndefined();
    // Re-measure FROM THE CLONE (what a MUSwitcher does), not from the template.
    o.refreshShapeFromMeshes();
    expect(sizeY(o.detectAabb), 'Body only, not Handle (y 2.1) nor Kid (y 3)').toBeCloseTo(1, 2);
    expect(o.detectAabb.max.y).toBeCloseTo(1.5, 2);
  });

  it('(c) a pre-placed MU detects by its collider', async () => {
    const { tm } = await load();
    const pre = tm.preplacedMUs.find((m: RVMovingUnit) => m.node.name === 'PreC')!;
    expect(pre).toBeTruthy();
    pre.updateAABB();
    expect(pre.detectAabb).not.toBe(pre.aabb);
    expect(sizeY(pre.detectAabb), 'upper-half collider').toBeCloseTo(0.5, 2);
    expect(pre.detectAabb.min.y).toBeCloseTo(1, 2);
  });

  it('(d) refreshShapeFromMeshes refreshes the detection shape of an MU without mesh', () => {
    const root = new Object3D();
    const n = new Object3D();
    n.userData.realvirtual = { colliders: [box(0.25, 0.5)] };
    root.add(n);
    root.updateMatrixWorld(true);
    const mu = new RVMovingUnit(n, '', new Vector3(0.1, 0.5, 0.1));
    expect(mu.detectAabb).toBe(mu.aabb);
    expect(mu.refreshShapeFromMeshes()).toBe(true);
    expect(mu.detectAabb).not.toBe(mu.aabb);
    expect(sizeY(mu.detectAabb)).toBeCloseTo(0.5, 5);
    expect(sizeY(mu.aabb), 'transport box kept').toBeCloseTo(1, 5);
  });
});
