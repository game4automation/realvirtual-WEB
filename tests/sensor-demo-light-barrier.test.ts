// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * The standard demo's light barriers must hit the authored colliders (plan-2039).
 * Raycast sensors hit colliders only; colliders must cover the part. The cap
 * alone misses both beams. Turbine-cut restores the body's collider from the
 * Unity prefab: scale 0.01, rotation 90 degrees about X, about 382 x 385 x 160 mm,
 * covering local height -2..157 mm. The negative control omits only this collider.
 *
 * This fixture is the measured demo constellation, no drives and no logic:
 *
 *   EntrySensor   world (2.493, 0.459, -0.366), Unity dir (1,0,0) → glTF (-1,0,0),
 *                 RayCastLength 550 mm, layer 0, AdditionalRayCastLayers [{}, {}]
 *                 (the parked Unity export bug: List<string> written as empty objects)
 *   Turbine (MU)  node world (2.21, 0.4097, -3.079), layer 17 (rvMU)
 *                 mesh AABB  381 × 236 × 381 mm  (world y 0.4081 … 0.6437)
 *                 BoxCollider Unity center (0.000251, 0.193217, -0.000124),
 *                             size (0.0505, 0.0842, 0.0516)
 *                 → world y 0.5608 … 0.6450: an 84 mm cap on a 236 mm part
 *   plus the two non-MU boxes on and around the beam — ConveyorEntry2 (layer 20)
 *   CONTAINS the ray origin, its child Conveyor (layer 16) sits just below it.
 *   Neither may silence the beam: plan-2016 points (c) and (c2) are withdrawn.
 *
 * The MU is moved along +Z through the beam in 2 mm steps and the measurement is:
 * do EntrySensor AND ExitSensor become occupied and emit MU-enter events?
 */

import { describe, it, expect } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, Scene, Vector3 } from 'three';
import { loadBakedGLB } from './helpers/load-baked-glb';
import { node, sceneToGlb } from './helpers/migrate-769-fixtures';
import type { RVMovingUnit } from '../src/core/engine/rv-mu';
import type { RVSource } from '../src/core/engine/rv-source';
import type { RVSensor } from '../src/core/engine/rv-sensor';

const TURBINE_COLLIDER = {
  type: 'BoxCollider', isTrigger: false, enabled: true,
  center: { x: 0.000251054764, y: 0.193217069, z: -0.00012421608 },
  size: { x: 0.05050516, y: 0.08418727, z: 0.0515646935 },
};

function boxMesh(name: string, sx: number, sy: number, sz: number): Mesh {
  const m = new Mesh(new BoxGeometry(sx, sy, sz), new MeshBasicMaterial());
  m.name = name;
  return m;
}

async function build(withBodyCollider: boolean): Promise<ArrayBuffer> {
  const scene = new Scene();
  scene.name = 'DemoCell';

  // The MU template: a 381 × 236 × 381 mm body whose bottom sits at the node origin,
  // with the Turbine's authored BoxCollider cap.
  const turbine = node('Turbine', { MU: {}, layer: 17, colliders: [TURBINE_COLLIDER] });
  turbine.position.set(2.21, 0.4097, -3.079);
  const body = boxMesh('Turbine_Body', 0.381, 0.2356, 0.381);
  body.position.set(0, 0.1178, 0);          // mesh y local 0 … 0.2356 → world 0.4097 … 0.6453
  turbine.add(body);
  const cut = node('Turbine-cut', {
    layer: 17,
    colliders: withBodyCollider ? [{
      type: 'BoxCollider', isTrigger: false, enabled: true,
      center: { x: -0.020749867, y: 0.0272840261, z: -7.75143528 },
      size: { x: 38.2475, y: 38.4586, z: 15.9788342 },
    }] : [],
  });
  cut.scale.setScalar(0.01);
  cut.rotation.x = Math.PI / 2;
  turbine.add(cut);
  scene.add(turbine);

  const src = node('Source', { Source: { ThisObjectAsMU: 'Turbine', AutomaticGeneration: false, GenerateMU: true }, layer: 0 });
  src.position.set(2.21, 0.4097, -3.079);
  scene.add(src);

  // The sensor, with the demo's raw (broken) layer list.
  const sensor = node('EntrySensor', {
    layer: 0,
    Sensor: {
      UseRaycast: true, RayCastLength: 550, RayCastDirection: { x: 1, y: 0, z: 0 },
      AdditionalRayCastLayers: [{}, {}], LimitSensorToTag: '',
    },
  });
  sensor.position.set(2.493, 0.459, -0.366);
  scene.add(sensor);
  const exit = node('ExitSensor', structuredClone(sensor.userData.realvirtual));
  exit.position.set(2.51, 0.462, 1.13);
  scene.add(exit);

  // The two non-MU boxes around the beam (candidates of the withdrawn blocking rule).
  const outer = node('ConveyorEntry2', {
    layer: 20,
    colliders: [{
      type: 'BoxCollider', isTrigger: false, enabled: true,
      center: { x: 0.00562560558, y: 0.241909415, z: -0.002812937 },
      size: { x: 0.6568263, y: 0.5161812, z: 1.65259278 },
    }],
  });
  outer.position.set(2.21, 0, -1.054);
  outer.add(boxMesh('ConveyorEntry2_Body', 0.6568, 0.5162, 1.6526));
  const belt = node('Conveyor', {
    layer: 16,
    colliders: [{
      type: 'BoxCollider', isTrigger: false, enabled: true,
      center: { x: 0, y: 0.3795, z: 0 }, size: { x: 0.491, y: 0.05327034, z: 1.58759558 },
    }],
  });
  belt.position.set(2.213, 0, -1.0344);
  belt.add(boxMesh('Conveyor_Body', 0.491, 0.0533, 1.5876));
  scene.add(outer, belt);

  return sceneToGlb(scene);
}

describe('the standard demo light barriers require colliders covering the part', () => {
  it.each([true, false])('body collider present = %s: both beams follow Unity collider-only semantics', async (withBodyCollider) => {
    const result = await loadBakedGLB('demo-light-barrier.glb', new Scene(), {
      data: (await build(withBodyCollider)).slice(0), loadKinematicsSidecar: false, expectChunks: false,
    });
    const tm = result.transportManager;
    const sensors = ['EntrySensor', 'ExitSensor'].map((name) => tm.sensors.find((s: RVSensor) => s.node.name === name)!);
    const source = tm.sources.find((s: RVSource) => s.node.name === 'Source')!;
    const mu = tm.spawnFromSource(source) as RVMovingUnit;
    expect(mu, 'no MU spawned').toBeTruthy();
    const hits = [0, 0];
    const enters = [0, 0];
    sensors.forEach((sensor, i) => {
      expect(sensor, 'missing light barrier').toBeTruthy();
      expect(sensor.UseRaycast).toBe(true);
      expect(sensor.rayLayerMask, 'a broken layer list must not filter').toBeNull();
      sensor.addMuEnterListener((entered) => {
        expect(entered).toBe(mu);
        enters[i]++;
      });
    });
    expect(mu.detectAabb, 'the MU has authored colliders').not.toBeNull();
    expect(mu.detectAabb).not.toBe(mu.aabb);
    expect(mu.detectParts?.length ?? 1).toBe(withBodyCollider ? 2 : 1);

    const parent = mu.node.parent!;
    // Sweep through both measured demo beams in 2 mm steps, including free space
    // before and after each beam. With only the cap, the mesh still crosses both.
    for (let z = -0.9; z <= 1.7; z += 0.002) {
      parent.updateWorldMatrix(true, false);
      mu.node.position.copy(parent.worldToLocal(new Vector3(2.21, 0.4097, z)));
      mu.node.updateMatrixWorld(true);
      tm.update(1 / 60);
      sensors.forEach((sensor, i) => {
        if (sensor.occupied) {
          expect(sensor.occupiedMU).toBe(mu);
          hits[i]++;
        }
      });
    }
    sensors.forEach((sensor, i) => {
      if (withBodyCollider) {
        expect(hits[i], sensor.node.name + ': sustained body-collider hit').toBeGreaterThan(50);
        expect(enters[i], sensor.node.name + ': one entry per pass').toBe(1);
      } else {
        // Unity semantics: mesh at beam height cannot compensate for a missed cap.
        expect(hits[i], sensor.node.name + ': cap only must miss').toBe(0);
        expect(enters[i]).toBe(0);
      }
      expect(sensor.occupied, 'free again after the pass').toBe(false);
    });
  }, 120_000);
});
