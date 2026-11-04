// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2016 S4 — `Grip.DirectlyGrip` + `Grip.PickAlignWithObject` (Unity `Grip.cs`:
 * `PartToGrip.EventEnter += Fix`, `Fix` re-parents the MU to the grip, releases it from
 * a previous holder and aligns it to `PickAlignWithObject`).
 *
 * Runs through the shipping bake (`loadBakedGLB()`): the align node must survive it
 * (PATH_FIELDS → bake survival) and the grips must work on the baked tree.
 *
 *   Cell
 *    ├─ Machine/Axis (Drive)       ← Source.Destination: the MU rides it after spawn
 *    ├─ Part (mesh, MU template)
 *    ├─ Src   Source { Destination: Machine/Axis }      at (0, 1, 0)
 *    ├─ SensA Sensor (box 0.2)                          at (0, 1, 0)
 *    ├─ GripA Grip { DirectlyGrip, PartToGrip: SensA }  at (0, 1.1, 0)
 *    ├─ SensB Sensor (box 0.2)                          at (2, 1, 0)
 *    ├─ GripB Grip { DirectlyGrip?, PartToGrip: SensB, PickAlignWithObject?, SignalPlace }
 *    ├─ AlignB (rotated)                                at (2, 0.95, 0.04)
 *    └─ Signals/PlaceB  PLCOutputBool
 */

import { describe, it, expect, afterEach } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, Object3D, Quaternion, Scene, Vector3 } from 'three';
import { loadBakedGLB } from './helpers/load-baked-glb';
import { PATH_FIELDS } from '../src/core/engine/rv-node-path-rewrite.mjs';
import { REFERENCE_BAKE_TARGETS } from '../src/core/engine/rv-bake-survival';
import { clearAllProblems } from '../src/core/hmi/problems-store';
import type { RVMovingUnit } from '../src/core/engine/rv-mu';
import type { RVGrip } from '../src/core/engine/rv-grip';
import { CR, node, sceneToGlb } from './helpers/migrate-769-fixtures';

interface Opts {
  directA?: boolean;
  directB?: boolean;
  align?: unknown;
  alignRotation?: boolean;
  /** Second, destination-free (instanceable) source `Free` at this world position. */
  freeAt?: [number, number, number];
  /** Small sensor `SensC` (box 0.02) at the align pose, after SensB in sensor order. */
  sensC?: boolean;
}

function sensorBox(name: string, size = 0.2): Mesh {
  const m = new Mesh(new BoxGeometry(size, size, size), new MeshBasicMaterial());
  m.name = name;
  m.userData.realvirtual = { Sensor: {} };
  return m;
}

async function build(o: Opts): Promise<ArrayBuffer> {
  const scene = new Scene();
  scene.name = 'Cell';
  const machine = node('Machine');
  const axis = node('Axis', { Drive: { Direction: 'LinearX', TargetSpeed: 100 } });
  machine.add(axis);
  const base = new Mesh(new BoxGeometry(1, 0.1, 1), new MeshBasicMaterial());
  base.name = 'Base';
  base.position.set(0, -1, 0);
  machine.add(base);

  const part = new Mesh(new BoxGeometry(0.05, 0.05, 0.05), new MeshBasicMaterial());
  part.name = 'Part';
  part.position.set(-3, 0, 0);
  part.userData.realvirtual = { MU: {} };

  const src = node('Src', {
    Source: { ThisObjectAsMU: 'Part', AutomaticGeneration: false, GenerateMU: true, Destination: 'Machine/Axis' },
  });
  src.position.set(0, 1, 0);

  const sensA = sensorBox('SensA');
  sensA.position.set(0, 1, 0);
  const gripA = node('GripA', {
    Grip: { DirectlyGrip: o.directA ?? true, OneBitControl: false, PartToGrip: CR('SensA', 'Sensor') },
  });
  gripA.position.set(0, 1.1, 0);

  const sensB = sensorBox('SensB');
  sensB.position.set(2, 1, 0);
  const signals = node('Signals');
  signals.add(node('PlaceB', { PLCOutputBool: { Name: 'PlaceB', Status: { Value: false } } }));
  const gripB = node('GripB', {
    Grip: {
      DirectlyGrip: o.directB ?? true, OneBitControl: false, PlaceMode: 'Static',
      PartToGrip: CR('SensB', 'Sensor'), SignalPlace: CR('Signals/PlaceB', 'PLCOutputBool'),
      ...(o.align !== undefined ? { PickAlignWithObject: o.align } : {}),
      ...(o.alignRotation !== undefined ? { AlignRotation: o.alignRotation } : {}),
    },
  });
  gripB.position.set(2, 1.1, 0);
  const alignB = node('AlignB');
  alignB.position.set(2, 0.95, 0.04);
  alignB.rotation.set(0.3, 0.7, 0);

  scene.add(machine, part, src, sensA, gripA, sensB, gripB, alignB, signals);
  if (o.freeAt) {
    const part2 = new Mesh(new BoxGeometry(0.05, 0.05, 0.05), new MeshBasicMaterial());
    part2.name = 'Part2';
    part2.position.set(-4, 0, 0);
    part2.userData.realvirtual = { MU: {} };
    const free = node('Free', { Source: { ThisObjectAsMU: 'Part2', AutomaticGeneration: false, GenerateMU: true } });
    free.position.set(...o.freeAt);
    scene.add(part2, free);
  }
  if (o.sensC) {
    const sensC = sensorBox('SensC', 0.02);
    sensC.position.set(2, 0.93, 0.07);
    scene.add(sensC);
  }
  return sceneToGlb(scene);
}

async function load(o: Opts) {
  const result = await loadBakedGLB('grip-direct.glb', new Scene(), { data: (await build(o)).slice(0), loadKinematicsSidecar: false });
  const tm = result.transportManager;
  const grip = (n: string) => tm.grips.find((g) => g.node.name === n) as RVGrip;
  const source = tm.sources.find((s) => s.node.name === 'Src')!;
  tm.update(1 / 60);
  const mu = tm.mus.find((m) => !m.isInstanced) as RVMovingUnit | undefined;
  return { result, tm, gripA: grip('GripA'), gripB: grip('GripB'), source, mu };
}

const worldPos = (o: Object3D) => { o.updateWorldMatrix(true, false); return o.getWorldPosition(new Vector3()); };
const worldQuat = (o: Object3D) => { o.updateWorldMatrix(true, false); return o.getWorldQuaternion(new Quaternion()); };

/** Puts a clone MU at a world position (keeps its parent). */
function moveTo(mu: RVMovingUnit, x: number, y: number, z: number): void {
  const p = mu.node.parent!;
  p.updateWorldMatrix(true, false);
  mu.node.position.copy(p.worldToLocal(new Vector3(x, y, z)));
  mu.node.updateMatrix();
  mu.node.updateMatrixWorld(true);
}

/** Moves grip A (with its MU) into sensor B and ticks once. */
function carryToB(gripA: RVGrip, tm: { update(dt: number): void }): void {
  gripA.node.position.x = 2;
  gripA.node.updateMatrix();
  gripA.node.updateMatrixWorld(true);
  tm.update(1 / 60);
}

afterEach(() => clearAllProblems());

describe('plan-2016 S4 — Grip.DirectlyGrip + PickAlignWithObject', () => {
  it('PickAlignWithObject is a declared path field with a merge bake target', () => {
    expect(PATH_FIELDS.some((f: { component: string; field: string }) => f.component === 'Grip' && f.field === 'PickAlignWithObject')).toBe(true);
    expect(REFERENCE_BAKE_TARGETS.some((e) => e.component === 'Grip' && e.field === 'PickAlignWithObject' && e.bakeTarget === 'merge')).toBe(true);
  });

  it('(a) grips on sensor entry without a pick signal, taking the MU from its Source.Destination', async () => {
    const { tm, gripA, source, mu } = await load({});
    expect(mu, 'one clone MU (a DirectlyGrip scene spawns clones)').toBeTruthy();
    expect(tm.mus.every((m) => !m.isInstanced)).toBe(true);
    expect(gripA.DirectlyGrip).toBe(true);
    expect(gripA.pickObjects).toBe(false);
    expect(gripA.grippedMUs).toEqual([mu]);
    expect(mu!.node.parent).toBe(gripA.node);
    expect(mu!.heldBy).toBe('grip');
    expect(mu!.destinationParent, 'the destination ride ended').toBeNull();
    // Picked in place (no align object): still at the source's world pose.
    expect(worldPos(mu!.node).distanceTo(worldPos(source.node))).toBeLessThan(1e-5);
    // The grip carries it: moving the grip moves the MU.
    gripA.node.position.y += 0.3;
    gripA.node.updateMatrix();
    tm.update(1 / 60);
    expect(worldPos(mu!.node).y).toBeGreaterThan(1.25);
  });

  it('(b) takeover A → B: B grips on entry, A loses the MU, a later SignalPlace releases it', async () => {
    const { result, tm, gripA, gripB, mu } = await load({});
    carryToB(gripA, tm);
    expect(gripB.grippedMUs).toEqual([mu]);
    expect(gripA.grippedMUs).toEqual([]);
    expect(mu!.node.parent).toBe(gripB.node);
    expect(mu!.heldBy).toBe('grip');
    const atTakeover = worldPos(mu!.node);
    expect(atTakeover.x).toBeCloseTo(2, 4);

    // Grip A moving away does not drag the MU along any more.
    gripA.node.position.x = 0;
    gripA.node.updateMatrix();
    tm.update(1 / 60);
    expect(mu!.node.parent).toBe(gripB.node);

    result.signalStore.set('PlaceB', true);
    tm.update(1 / 60);
    expect(gripB.grippedMUs).toEqual([]);
    expect(mu!.heldBy).toBeNull();
    expect(mu!.node.parent).not.toBe(gripB.node);
    expect(worldPos(mu!.node).distanceTo(atTakeover)).toBeLessThan(1e-5);
  });

  it('(c) PickAlignWithObject with AlignRotation: the MU takes the align node world pose', async () => {
    const { result, tm, gripA, gripB, mu } = await load({ align: 'AlignB' });
    const align = result.registry.getNode('AlignB');
    expect(align, 'AlignB survives the bake').toBeTruthy();
    expect(gripB.pickAlignNode).toBe(align);
    carryToB(gripA, tm);
    expect(gripB.grippedMUs).toEqual([mu]);
    expect(worldPos(mu!.node).distanceTo(worldPos(align!))).toBeLessThan(1e-5);
    expect(worldQuat(mu!.node).angleTo(worldQuat(align!))).toBeLessThan(1e-5);
  });

  it('(d) PickAlignWithObject without AlignRotation: position only, rotation kept', async () => {
    const { result, tm, gripA, gripB, mu } = await load({ align: 'AlignB', alignRotation: false });
    const align = result.registry.getNode('AlignB')!;
    const before = worldQuat(mu!.node);
    carryToB(gripA, tm);
    expect(gripB.grippedMUs).toEqual([mu]);
    expect(worldPos(mu!.node).distanceTo(worldPos(align))).toBeLessThan(1e-5);
    expect(worldQuat(mu!.node).angleTo(before)).toBeLessThan(1e-5);
  });

  it('(e) without DirectlyGrip nothing changes: no grip on entry, the pick signal still picks', async () => {
    const { tm, gripA, mu } = await load({ directA: false, directB: false });
    expect(gripA.grippedMUs).toEqual([]);
    expect(mu!.isGripped).toBe(false);
    expect(mu!.node.parent?.name).toBe('Axis');
    gripA.pickObjects = true;
    tm.update(1 / 60);
    expect(gripA.grippedMUs).toEqual([mu]);
    // B without DirectlyGrip does not take it when it is carried into its sensor.
    carryToB(gripA, tm);
    expect(gripA.grippedMUs).toEqual([mu]);
  });

  it('(g) MU-enter fires once per real entry: a second MU is seen, staying inside never re-fires', async () => {
    const { tm, source } = await load({ directA: false, directB: false });
    const sensB = tm.sensors.find((x) => x.node.name === 'SensB')!;
    const entered: string[] = [];
    sensB.addMuEnterListener((m) => entered.push(m.getName()));
    const a = tm.spawnFromSource(source) as RVMovingUnit;
    const b = tm.spawnFromSource(source) as RVMovingUnit;
    expect(a.isInstanced || b.isInstanced).toBe(false);
    a.node.name = 'A'; b.node.name = 'B';
    moveTo(a, 2, 1, 0);
    tm.update(1 / 60);
    expect(entered).toEqual(['A']);
    // B joins while A stays the occupying (first) MU: B still enters.
    moveTo(b, 2.02, 1, 0);
    tm.update(1 / 60);
    expect(entered).toEqual(['A', 'B']);
    // Both stay inside, the order of the candidates flips: nothing new.
    moveTo(a, 2.03, 1, 0);
    moveTo(b, 1.99, 1, 0);
    for (let i = 0; i < 5; i++) tm.update(1 / 60);
    expect(entered).toEqual(['A', 'B']);
    // A leaves and comes back: a real second entry.
    moveTo(a, 5, 1, 0);
    tm.update(1 / 60);
    expect(sensB.occupiedMU).toBe(b);
    moveTo(a, 2, 1, 0);
    tm.update(1 / 60);
    expect(entered).toEqual(['A', 'B', 'A']);
    // A sensor reset forgets who is inside: the MUs still there enter again.
    sensB.resetDetection();
    tm.update(1 / 60);
    expect(entered.slice(3).sort()).toEqual(['A', 'B']);
  });

  it('(h) a placed MU stays in the sensor and is NOT gripped again (it never left)', async () => {
    const { result, tm, gripA, gripB, mu } = await load({});
    carryToB(gripA, tm);
    expect(gripB.grippedMUs).toEqual([mu]);
    result.signalStore.set('PlaceB', true);
    tm.update(1 / 60);
    result.signalStore.set('PlaceB', false);
    for (let i = 0; i < 10; i++) tm.update(1 / 60);
    expect(gripB.grippedMUs).toEqual([]);
    expect(gripA.grippedMUs).toEqual([]);
    expect(mu!.heldBy).toBeNull();
    // Grip A coming back into sensor B with nothing does not change that either.
    gripA.node.position.x = 0;
    gripA.node.updateMatrix();
    for (let i = 0; i < 3; i++) tm.update(1 / 60);
    expect(gripB.grippedMUs).toEqual([]);
  });

  it('(i) removing a held MU releases it from the grip and from the sensor tracking', async () => {
    const { tm, gripA, mu } = await load({});
    expect(gripA.grippedMUs).toEqual([mu]);
    tm.removeMU(mu!);
    expect(gripA.grippedMUs).toEqual([]);
    for (let i = 0; i < 3; i++) tm.update(1 / 60);
    expect(gripA.grippedMUs).toEqual([]);
    expect(tm.sensors.find((x) => x.node.name === 'SensA')!.occupiedMU).toBeNull();
  });

  it('(j) after a simulation reset a new MU entering is gripped again', async () => {
    const { tm, gripA, mu } = await load({});
    expect(gripA.grippedMUs).toEqual([mu]);
    tm.reset();
    expect(gripA.grippedMUs).toEqual([]);
    tm.update(1 / 60);
    const fresh = tm.mus.find((m) => !m.isInstanced) as RVMovingUnit | undefined;
    expect(fresh, 'the source spawns again after the reset').toBeTruthy();
    expect(fresh).not.toBe(mu);
    expect(gripA.grippedMUs).toEqual([fresh]);
  });

  it('(k) an independent instanced source no DirectlyGrip sensor reaches stays instanced', async () => {
    const { tm } = await load({ freeAt: [6, 1, 0] });
    const free = tm.sources.find((s) => s.node.name === 'Free')!;
    expect(free.useInstancing, 'Part2 is instanceable').toBe(true);
    const inst = tm.mus.filter((m) => m.isInstanced);
    expect(inst.length).toBe(1);
    for (let i = 0; i < 3; i++) tm.update(1 / 60);
    expect(tm.mus.filter((m) => m.isInstanced)).toEqual(inst);
  });

  it('(l) an instanced MU entering a DirectlyGrip sensor is promoted to a clone and gripped; ids and counters kept', async () => {
    const { tm, gripB } = await load({ freeAt: [2, 1, 0], directA: false });
    const free = tm.sources.find((s) => s.node.name === 'Free')!;
    expect(free.useInstancing).toBe(true);
    expect(tm.mus.some((m) => m.isInstanced), 'no instance left: it was promoted').toBe(false);
    expect(gripB.grippedMUs.length).toBe(1);
    const held = gripB.grippedMUs[0];
    expect(held.isInstanced).toBe(false);
    expect(held.node.parent).toBe(gripB.node);
    expect(tm.mus.includes(held)).toBe(true);
    expect(worldPos(held.node).distanceTo(worldPos(free.node))).toBeLessThan(1e-5);
    expect(tm.totalSpawned).toBe(2);
    expect(tm.muById(held.id)).toBe(held);
    // Stays held over further ticks, no second promote or grip.
    for (let i = 0; i < 3; i++) tm.update(1 / 60);
    expect(gripB.grippedMUs).toEqual([held]);
    expect(tm.mus.length).toBe(2);
  });

  for (const grid of [false, true]) {
    it(`(m) the align pose is indexed at once: a later sensor sees it the same tick (${grid ? 'grid' : 'brute force'})`, async () => {
      const { tm, gripA, gripB, mu } = await load({ align: 'AlignB', sensC: true });
      if (grid) tm.bruteForceThreshold = 0;
      const sensC = tm.sensors.find((x) => x.node.name === 'SensC')!;
      expect(tm.sensors.indexOf(sensC)).toBeGreaterThan(tm.sensors.findIndex((x) => x.node.name === 'SensB'));
      expect(sensC.occupied).toBe(false);
      carryToB(gripA, tm);
      expect(gripB.grippedMUs).toEqual([mu]);
      expect(sensC.occupied, 'SensC sees the aligned MU in the grip tick').toBe(true);
    });
  }

  it('(f) dispose removes the sensor listener: a disposed grip grips nothing', async () => {
    const { tm, gripA, gripB, mu } = await load({});
    gripB.dispose();
    carryToB(gripA, tm);
    expect(gripA.grippedMUs).toEqual([mu]);
    expect(gripB.grippedMUs).toEqual([]);
  });
});
