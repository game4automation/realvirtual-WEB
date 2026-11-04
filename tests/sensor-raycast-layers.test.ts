// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2016 S6c — raycast sensors like Unity `Sensor.Raycast()`:
 *  (1) ONE `Physics.Raycast`: the NEAREST MU on the beam is detected and enters;
 *  (2) `AdditionalRayCastLayers`: the ray hits only colliders on those layers
 *      (+ the sensor's own layer). The layer table is the realvirtual standard plus
 *      the file's `scenes[0].extras.realvirtual.layerNames` (here 24 = MauserParts);
 *  (3) a list without a usable name — broken (`[{},{}]`, an old export), EMPTY, or
 *      missing — means no filter (Thomas 2026-10-29: "explicit empty = own layer
 *      only" blinded models whose export wrote an empty array).
 *
 * Every ray runs along +Z from z = -0.5 at x = 2. MUs are 0.2 m bars.
 *   Fass    MU on layer 17 (rvMU), box collider L17; child PunchPos (L24 = MauserParts)
 *           with a box collider 0.4 m above the body
 *   Butzen  MU on layer 24 (MauserParts), box collider L24
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, Scene, Vector3 } from 'three';
import { loadBakedGLB } from './helpers/load-baked-glb';
import type { RVMovingUnit, InstancedMovingUnit } from '../src/core/engine/rv-mu';
import type { RVSource } from '../src/core/engine/rv-source';
import type { RVSensor } from '../src/core/engine/rv-sensor';
import {
  buildLayerMask, buildRaycastLayerMask, layerIndexOf, layerPasses, registerFileLayerNames, resetLayerNames,
} from '../src/core/engine/rv-layers';
import { node, sceneToGlb } from './helpers/migrate-769-fixtures';

function mesh(name: string, sy: number, rv?: Record<string, unknown>): Mesh {
  const m = new Mesh(new BoxGeometry(0.2, sy, 0.2), new MeshBasicMaterial());
  m.name = name;
  if (rv) m.userData.realvirtual = rv;
  return m;
}

const box = (cy: number, sy: number) => ({
  type: 'BoxCollider', isTrigger: false, enabled: true,
  center: { x: 0, y: cy, z: 0 }, size: { x: 0.2, y: sy, z: 0.2 },
});

/** 32-entry table with the Mauser project's own layer 24. */
const LAYER_NAMES = Array.from({ length: 32 }, (_, i) => (i === 24 ? 'MauserParts' : ''));

async function build(layers: Record<string, unknown>, withTable = true): Promise<ArrayBuffer> {
  const scene = new Scene();
  scene.name = 'Cell';
  if (withTable) scene.userData.realvirtual = { layerNames: LAYER_NAMES };
  const fass = node('Fass', { MU: {}, layer: 17, colliders: [box(0, 0.2)] });
  fass.position.set(-10, 0, 0);
  fass.add(mesh('Fass_Body', 0.2));
  const punch = node('PunchPos', { layer: 24, colliders: [box(0, 0.05)] });
  punch.position.set(0, 0.4, 0);
  fass.add(punch);
  const butzen = node('Butzen', { MU: {}, layer: 24, colliders: [box(0, 0.2)] });
  butzen.position.set(-12, 0, 0);
  butzen.add(mesh('Butzen_Body', 0.2, { layer: 24 }));
  scene.add(fass, butzen);
  for (const [src, tpl, y] of [['SrcFass', 'Fass', 10], ['SrcButzen', 'Butzen', 12]] as const) {
    const s = node(src, { Source: { ThisObjectAsMU: tpl, AutomaticGeneration: false, GenerateMU: true } });
    s.position.set(0, y, 0);
    scene.add(s);
  }
  for (const [name, list] of Object.entries(layers)) {
    // Sensor on rvSensor (15) like the Mauser grip sensors.
    const n = node(name, { layer: 15, Sensor: { UseRaycast: true, RayCastLength: 1000, RayCastDirection: { x: 0, y: 0, z: 1 }, AdditionalRayCastLayers: list } });
    n.position.set(2, 1, -0.5);
    scene.add(n);
  }
  return sceneToGlb(scene);
}

async function load(layers: Record<string, unknown>, withTable = true) {
  const result = await loadBakedGLB('sensor-raycast-layers.glb', new Scene(), { data: (await build(layers, withTable)).slice(0), loadKinematicsSidecar: false, expectChunks: false });
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
  };
  const tick = (): void => tm.update(1 / 60);
  return { tm, spawn, sensor, place, tick };
}

beforeEach(() => resetLayerNames());

describe('plan-2016 S6c — layer table', () => {
  it('knows the realvirtual standard layers and a file table', () => {
    expect(layerIndexOf('rvMU')).toBe(17);
    expect(layerIndexOf('rvMUSensor')).toBe(13);
    expect(layerIndexOf('MauserParts')).toBe(-1);
    registerFileLayerNames({ realvirtual: { layerNames: LAYER_NAMES } });
    expect(layerIndexOf('MauserParts')).toBe(24);
  });

  it('builds a Unity mask (+ own layer); broken, empty or unknown-only lists = no filter', () => {
    registerFileLayerNames({ realvirtual: { layerNames: LAYER_NAMES } });
    const m = buildRaycastLayerMask(['MauserParts'], 15).mask!;
    expect(layerPasses(m, 24)).toBe(true);
    expect(layerPasses(m, 15)).toBe(true);
    expect(layerPasses(m, 17)).toBe(false);
    expect(layerPasses(m, -1), 'unknown layer is never filtered').toBe(true);
    expect(buildLayerMask([]).mask, 'zone: empty = no filter').toBeNull();
    // Thomas 2026-10-29 (plan-2016 point (e) hardening): an empty list is no filter
    // again — a model whose Unity export wrote `[]` was blind to every layered MU.
    expect(buildRaycastLayerMask([], 15).mask, 'sensor: empty = no filter').toBeNull();
    expect(buildLayerMask([{}, {}]).mask).toBeNull();
    expect(buildRaycastLayerMask([{}, {}], 15).mask).toBeNull();
    const u = buildLayerMask(['NoSuchLayer']);
    expect(u.mask).toBeNull();
    expect(u.unknown).toEqual(['NoSuchLayer']);
  });
});

describe('plan-2016 S6c — raycast sensor parity', () => {
  it('(1) only the nearest MU on the beam is detected and enters (Unity Physics.Raycast)', async () => {
    const { spawn, sensor, place, tick } = await load({ Ray: ['rvMU', 'rvMUSensor', 'MauserParts'] });
    const s = sensor('Ray');
    const entered: (RVMovingUnit | InstancedMovingUnit)[] = [];
    s.addMuEnterListener((mu) => entered.push(mu));
    const near = spawn('SrcFass');
    const far = spawn('SrcFass');
    place(near, 2, 1, 0);
    place(far, 2, 1, 0.5);
    tick();
    expect(s.occupiedMU).toBe(near);
    expect(entered, 'the nearest collider blocks the beam: the MU behind it does not enter').toEqual([near]);
  });

  it('(2) a MauserParts sensor ignores the barrel (rvMU) in front and sees the Butzen', async () => {
    const { spawn, sensor, place, tick } = await load({ RayButzen: ['MauserParts'], RayAll: ['rvMU', 'rvMUSensor', 'MauserParts'] });
    const fass = spawn('SrcFass');
    const butzen = spawn('SrcButzen');
    place(fass, 2, 1, 0);
    place(butzen, 2, 1, 0.5);
    tick();
    expect(sensor('RayButzen').occupiedMU, 'barrel body is on rvMU').toBe(butzen);
    expect(sensor('RayAll').occupiedMU).toBe(fass);
    place(butzen, 2, 1, -20);   // out of the beam
    tick();
    expect(sensor('RayButzen').occupied, 'barrel alone: not seen').toBe(false);
    expect(sensor('RayAll').occupied).toBe(true);
  });

  it('(2b) the barrel\'s MauserParts child collider IS seen (per-collider layer, like Unity)', async () => {
    const { spawn, sensor, place, tick } = await load({ RayButzen: ['MauserParts'] });
    const fass = spawn('SrcFass');
    place(fass, 2, 0.6, 0);     // PunchPos (0.4 above the body) on the beam
    tick();
    expect(sensor('RayButzen').occupiedMU).toBe(fass);
  });

  it('(3) a broken list AND an empty one keep the old behaviour: every layer', async () => {
    const { spawn, sensor, place, tick } = await load({ Empty: [], Broken: [{}, {}] });
    const fass = spawn('SrcFass');
    place(fass, 2, 1, 0);
    tick();
    // Thomas 2026-10-29 (plan-2016 point (e) hardening): "explicit empty = own layer
    // only" made every model with an empty export array blind.
    expect(sensor('Empty').occupiedMU, 'an empty list is no filter').toBe(fass);
    expect(sensor('Broken').occupiedMU).toBe(fass);
  });

  it('(3b) without a file table an unknown name does not blind the sensor', async () => {
    const { spawn, sensor, place, tick } = await load({ RayButzen: ['MauserParts'] }, false);
    const fass = spawn('SrcFass');
    place(fass, 2, 1, 0);
    tick();
    expect(sensor('RayButzen').occupiedMU).toBe(fass);
  });
});
