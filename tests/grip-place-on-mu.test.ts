// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * grip-place-on-mu.test.ts — plan-516 §9.5: grip and sensor against passive
 * loads (F5/F6).
 *
 * Grip candidates are the active MUs AND, recursively, their load trees, each
 * judged by its own collider box — a load counts even when only IT is in the
 * grip range or the `PartToGrip` volume. `place()` in Auto mode puts the part
 * onto the MU below it (collider rule) before falling back to the scene root.
 * A tag-limited sensor sees loads; the plain sensor tick sees active MUs only.
 */

import { describe, it, expect } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVGrip } from '../src/core/engine/rv-grip';
import { RVSensor } from '../src/core/engine/rv-sensor';
import type { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { PALLET, PART, classifiedScene, muNode, muOf, palletRow, worldPos } from './_mu-preplaced-fixture';

const DT = 1 / 60;

function makeGrip(tm: RVTransportManager, parent: Object3D, pos: Vector3): RVGrip {
  const node = new Object3D();
  node.position.copy(pos);
  parent.add(node);
  const grip = new RVGrip(node);
  grip.allMUs = () => tm.mus;
  grip.allGripTargets = () => tm.gripTargets;
  grip.loadHost = tm;
  tm.grips.push(grip);
  return grip;
}

function makeSensor(tm: RVTransportManager, parent: Object3D, pos: Vector3, half: Vector3): RVSensor {
  const node = new Object3D();
  node.position.copy(pos);
  parent.add(node);
  const sensor = new RVSensor(node, AABB.fromHalfSize(node, half));
  sensor.invertSignal = false;
  sensor.UseRaycast = false;
  tm.sensors.push(sensor);
  return sensor;
}

const PART_TOP = PALLET[1] + PART[1];

describe('grip candidates include passive loads (plan-516 F5)', () => {
  it('a grip range that reaches only the product picks the product', () => {
    const { root, pallets, parts } = palletRow(1, 1);
    const { tm, scene } = classifiedScene(root);
    tm.activatePreplaced();
    const pallet = muOf(tm, pallets[0]);
    const product = muOf(tm, parts[0][0]);
    // 2 cm above the product; the pallet top is 10 cm away (> 50 mm range).
    const grip = makeGrip(tm, scene, new Vector3(0, PART_TOP + 0.02, 0));
    grip.pick();
    expect(grip.grippedMUs).toEqual([product]);
    expect(product.loadedOn).toBeNull();
    expect(pallet.loadedMus.length).toBe(0);
    expect(tm.mus).toContain(product); // active again (gripped → transport skips it)
    expect(product.node.parent).toBe(grip.node);
    expect(pallet.isGripped).toBe(false);
  });

  it('PartToGrip over the product → product; over the pallet rim → pallet', () => {
    const { root, pallets, parts } = palletRow(2, 1);
    const { tm, scene } = classifiedScene(root);
    tm.activatePreplaced();
    const product0 = muOf(tm, parts[0][0]);
    const pallet1 = muOf(tm, pallets[1]);

    // Sensor volume only above the pallet top (y 0.12..0.16) around product 0.
    const overProduct = makeSensor(tm, scene, new Vector3(0, 0.14, 0), new Vector3(0.03, 0.02, 0.03));
    // Sensor volume at pallet 1's rim, below its top, away from its product.
    const overRim = makeSensor(tm, scene, new Vector3(1.27, 0.05, 0), new Vector3(0.02, 0.02, 0.02));
    tm.update(DT);
    expect(overProduct.occupiedMU).toBeNull(); // the plain tick only sees active MUs
    expect(overRim.occupiedMU).toBe(pallet1);

    const g0 = makeGrip(tm, scene, new Vector3(0, PART_TOP + 0.05, 0));
    g0.partToGripSensor = overProduct;
    g0.pick();
    expect(g0.grippedMUs).toEqual([product0]);

    const g1 = makeGrip(tm, scene, new Vector3(1.27, 0.2, 0));
    g1.partToGripSensor = overRim;
    g1.pick();
    expect(g1.grippedMUs).toEqual([pallet1]);
    expect(pallet1.loadedMus.length).toBe(1); // the pallet takes its load with it
  });

  it('the third level of a stack can be gripped', () => {
    const root = new Object3D();
    const pallet = muNode('Pallet', PALLET, [0, 0, 0]);
    const a = muNode('A', PART, [0, PALLET[1], 0]);
    const b = muNode('B', PART, [0, PALLET[1] + PART[1], 0]);
    const c = muNode('C', PART, [0, PALLET[1] + 2 * PART[1], 0]);
    root.add(pallet, a, b, c);
    const { tm, scene } = classifiedScene(root);
    tm.activatePreplaced();
    const grip = makeGrip(tm, scene, new Vector3(0, PALLET[1] + 3 * PART[1] + 0.01, 0));
    grip.pick();
    expect(grip.grippedMUs).toEqual([muOf(tm, c)]);
    expect(muOf(tm, b).loadedMus.length).toBe(0);
    expect(muOf(tm, a).loadedMus).toEqual([muOf(tm, b)]);
  });

  it('autoPlace over another pallet makes the part its load, and it rides along', () => {
    const { root, pallets, parts } = palletRow(2, 1);
    const { tm, scene } = classifiedScene(root);
    tm.activatePreplaced();
    const pallet1 = muOf(tm, pallets[1]);
    const product0 = muOf(tm, parts[0][0]);
    const product1 = muOf(tm, parts[1][0]);

    // Only product 0 is in range (its pallet top is > 50 mm below the grip point).
    const grip = makeGrip(tm, scene, new Vector3(0, PART_TOP + 0.01, 0));
    grip.pick();
    expect(grip.grippedMUs).toEqual([product0]);

    // Carry it over pallet 1, beside product 1, bottom exactly on the pallet top.
    grip.node.position.set(1.2, PART_TOP + 0.01, 0);
    grip.node.updateMatrixWorld(true);
    grip.place();
    expect(product0.loadedOn).toBe(pallet1);
    expect(pallet1.loadedMus).toEqual([product1, product0]);
    expect(tm.mus).not.toContain(product0);
    expect(product0.node.parent).toBe(pallet1.node);

    const before = worldPos(product0.node);
    pallet1.node.position.x += 0.4;
    const after = worldPos(product0.node);
    expect(after.x - before.x).toBeCloseTo(0.4, 6);
  });

  it('with no MU below, place() falls back to the scene root (still active)', () => {
    const { root, parts } = palletRow(1, 1);
    const { tm, scene } = classifiedScene(root);
    tm.activatePreplaced();
    const product = muOf(tm, parts[0][0]);
    const grip = makeGrip(tm, scene, new Vector3(0, PART_TOP + 0.01, 0));
    grip.pick();
    grip.node.position.set(5, 1, 0);
    grip.place();
    expect(product.loadedOn).toBeNull();
    expect(product.node.parent).toBe(scene);
    expect(tm.mus).toContain(product);
  });
});

describe('sensors and loads (plan-516 F6)', () => {
  it('a sensor with LimitSensorToTag detects a load on its carrier; an unlimited one only active MUs', () => {
    const { root, parts } = palletRow(1, 1);
    parts[0][0].userData.tag = 'Valve';
    const { tm, scene } = classifiedScene(root);
    tm.activatePreplaced();
    const product = muOf(tm, parts[0][0]);
    // Volume around the product only — above the pallet's collider top.
    const tagged = makeSensor(tm, scene, new Vector3(0, 0.15, 0), new Vector3(0.08, 0.02, 0.08));
    tagged.LimitSensorToTag = 'Valve';
    const plain = makeSensor(tm, scene, new Vector3(0, 0.15, 0), new Vector3(0.08, 0.02, 0.08));
    tm.update(DT);
    expect(tagged.occupied).toBe(true);
    expect(tagged.occupiedMU).toBe(product);
    expect(plain.occupied).toBe(false);
  });

  it('a raycast sensor with LimitSensorToTag hits a load', () => {
    const { root, parts } = palletRow(1, 1);
    parts[0][0].userData.tag = 'Valve';
    const { tm, scene } = classifiedScene(root);
    tm.activatePreplaced();
    const node = new Object3D();
    node.position.set(-1, 0.14, 0);
    scene.add(node);
    const sensor = new RVSensor(node, AABB.fromHalfSize(node, new Vector3(0.01, 0.01, 0.01)));
    sensor.UseRaycast = true;
    sensor.RayCastDirection = { x: 1, y: 0, z: 0 }; // node-local, towards the part
    sensor.RayCastLength = 2000;
    sensor.LimitSensorToTag = 'Valve';
    tm.sensors.push(sensor);
    tm.update(DT);
    expect(sensor.occupiedMU).toBe(muOf(tm, parts[0][0]));
  });
});
