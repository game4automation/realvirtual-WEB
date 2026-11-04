// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2016 S6b — `MUPusher`: the MU a grip carries into a station pushes the MU
 * standing there out, position-based (no contact detection, no physics). The
 * couple position is computed from the geometry when the drive starts its move
 * to `ReleasePosition`; the pushed MU is released there onto the belt, which
 * carries it to the sink.
 *
 *   Cell
 *    ├─ Axis   Drive LinearZ (+z)                       master, 100 mm/s
 *    │   └─ Slide  Drive LinearZ + Drive_Gear(Axis, 1)  telescope child: 1 + 1 = 2 × master
 *    │       └─ Gripper (0, 0.3, 0)  Grip DirectlyGrip, PartToGrip SensG
 *    ├─ SensG  Sensor box 0.1 at (0, 0.3, 0); Src → Part (box 0.2) spawns there
 *    ├─ Base   Sensor box 0.3 at (0, 0.3, 0.6) + MUPusher; Src2 → Part2 (box 0.2) spawns there
 *    ├─ Belt   Drive LinearZ jog + TransportSurface, top y = 0.2, z 0.8 … 2.4
 *    └─ Sink   box at z 2.3
 *
 * Pushing MU front z = 0.1, standing MU back z = 0.5 → gap 0.4 m, 0.002 m per
 * master mm → couple at 200 mm. Release at 350 mm: the pushed MU ends 0.3 m
 * further, centre z = 0.9, over the belt.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, Scene, Vector3 } from 'three';
import { loadBakedGLB } from './helpers/load-baked-glb';
import { clearAllProblems } from '../src/core/hmi/problems-store';
import type { RVMovingUnit } from '../src/core/engine/rv-mu';
import type { RVDrive } from '../src/core/engine/rv-drive';
import { RVMUPusher } from '../src/core/engine/rv-mu-pusher';
import { getComponentInstances } from '../src/core/engine/rv-component-registry';
import { CR, node, sceneToGlb } from './helpers/migrate-769-fixtures';

const DT = 1 / 50;
const RELEASE = 350;

function boxMesh(name: string, sx: number, sy: number, sz: number, extras?: Record<string, unknown>): Mesh {
  const m = new Mesh(new BoxGeometry(sx, sy, sz), new MeshBasicMaterial());
  m.name = name;
  if (extras) m.userData.realvirtual = extras;
  return m;
}

async function build(o: { standing: boolean; bigSensor?: boolean }): Promise<ArrayBuffer> {
  const scene = new Scene();
  scene.name = 'Cell';
  const axis = node('Axis', { Drive: { Direction: 'LinearZ', TargetSpeed: 100 } });
  const slide = node('Slide', {
    Drive: { Direction: 'LinearZ', TargetSpeed: 100 },
    Drive_Gear: { MasterDrive: CR('Axis', 'realvirtual.Drive'), GearFactor: 1 },
  });
  const gripper = node('Gripper', {
    Grip: { DirectlyGrip: true, OneBitControl: false, PlaceMode: 'Static', PartToGrip: CR('SensG', 'realvirtual.Sensor') },
  });
  gripper.position.set(0, 0.3, 0);
  slide.add(gripper);
  axis.add(slide);

  const part = boxMesh('Part', 0.2, 0.2, 0.2, { MU: {} });
  part.position.set(-3, 0, 0);
  const src = node('Src', { Source: { ThisObjectAsMU: 'Part', AutomaticGeneration: false, GenerateMU: true } });
  src.position.set(0, 0.3, 0);
  const sensG = boxMesh('SensG', 0.1, 0.1, 0.1, { Sensor: {} });
  sensG.position.set(0, 0.3, 0);

  const part2 = boxMesh('Part2', 0.2, 0.2, 0.2, { MU: {} });
  part2.position.set(-4, 0, 0);
  const src2 = node('Src2', { Source: { ThisObjectAsMU: 'Part2', AutomaticGeneration: false, GenerateMU: o.standing } });
  src2.position.set(0, 0.3, 0.6);
  // bigSensor: the station sensor reaches back over the carried MU (it reports that one first).
  const base = boxMesh('Base', 0.3, 0.3, o.bigSensor ? 1.4 : 0.3, {
    Sensor: {},
    MUPusher: {
      Drive: CR('Axis', 'realvirtual.Drive'),
      Pusher: CR('Axis/Slide/Gripper', 'realvirtual.Grip'),
      Sensor: CR('Base', 'realvirtual.Sensor'),
      ReleasePosition: RELEASE,
      ReleaseSurface: CR('Belt', 'realvirtual.TransportSurface'),
    },
  });
  base.position.set(0, 0.3, o.bigSensor ? 0.6 : 0.6);

  const belt = boxMesh('Belt', 0.6, 0.1, 1.6, {
    Drive: { Direction: 'LinearZ', TargetSpeed: 500, JogForward: true },
    TransportSurface: { TransportDirection: { x: 0, y: 0, z: 1 } },
  });
  belt.position.set(0, 0.15, 1.6);
  const sink = boxMesh('Sink', 0.4, 0.4, 0.1, {
    Sink: {}, BoxCollider: { center: { x: 0, y: 0, z: 0 }, size: { x: 0.4, y: 0.4, z: 0.1 } },
  });
  sink.position.set(0, 0.3, 2.3);

  scene.add(axis, part, src, sensG, part2, src2, base, belt, sink);
  return sceneToGlb(scene);
}

async function load(o: { standing: boolean; bigSensor?: boolean }) {
  const result = await loadBakedGLB('mu-pusher.glb', new Scene(), { data: (await build(o)).slice(0), loadKinematicsSidecar: false });
  const tm = result.transportManager;
  tm.preferCloneMU = true; // the pushed MU is a clone in the real cell (it was gripped before)
  const drive = (n: string) => result.drives.find((d) => d.name === n) as RVDrive;
  const axis = drive('Axis');
  const slide = drive('Slide');
  const belt = drive('Belt');
  const baseNode = result.registry.getNode('Base')!;
  const pusher = getComponentInstances(baseNode).find((i) => i instanceof RVMUPusher) as RVMUPusher;
  const step = () => { axis.update(DT); slide.update(DT); belt.update(DT); tm.update(DT); };
  step();
  const grip = tm.grips[0];
  const pushing = grip.grippedMUs[0];
  const standing = tm.mus.find((m) => m !== pushing) as RVMovingUnit | undefined;
  return { result, tm, axis, pusher, grip, pushing, standing, step };
}

const worldPos = (mu: RVMovingUnit) => { mu.node.updateWorldMatrix(true, false); return mu.node.getWorldPosition(new Vector3()); };

afterEach(() => clearAllProblems());

describe('plan-2016 S6b — MUPusher (position-based push out of a station)', () => {
  it('computes the couple position from the geometry (gear included)', async () => {
    const { axis, pusher, grip, pushing, standing } = await load({ standing: true });
    expect(pusher, 'MUPusher on Base').toBeTruthy();
    expect(pusher.Drive).toBe(axis);
    expect(pusher.Pusher).toBe(grip);
    expect(pushing, 'the grip holds the pushing MU').toBeTruthy();
    expect(standing, 'an MU stands in the station').toBeTruthy();
    const k = RVMUPusher.travelPerMm(grip.node, axis, new Vector3());
    expect(k.z).toBeCloseTo(0.002, 6);
    expect(Math.abs(k.x) + Math.abs(k.y)).toBeLessThan(1e-9);
    const plan = RVMUPusher.computePlan([pushing], standing!, k, 0, RELEASE, new Vector3());
    expect(plan!.couplePosition).toBeCloseTo(200, 3);
    expect(plan!.gapMm).toBeCloseTo(400, 3);
  });

  it('couples at the computed position without gap or overlap, releases at ReleasePosition onto the belt, the belt carries it to the sink', async () => {
    const { tm, axis, pusher, pushing, standing, step } = await load({ standing: true });
    const start = worldPos(standing!).clone();
    axis.startMove(RELEASE);
    let coupledAt = Number.NaN;
    let contactErrMm = Number.NaN;
    let released: Vector3 | null = null;
    let releaseGapMm = Number.NaN;
    let releasedAtAxis = Number.NaN;
    for (let i = 0; i < 400 && axis.isRunning; i++) {
      step();
      if (!released && pusher.pushedCount === 1) {
        released = worldPos(standing!).clone();
        releasedAtAxis = axis.currentPosition;
        releaseGapMm = (standing!.aabb.min.z - pushing.aabb.max.z) * 1000;
      }
      if (Number.isNaN(coupledAt) && pusher.pushedMU) {
        coupledAt = axis.currentPosition;
        pushing.updateAABB();
        standing!.updateAABB();
        contactErrMm = (standing!.aabb.min.z - pushing.aabb.max.z) * 1000;
      }
      if (Number.isNaN(coupledAt)) {
        // Before the contact the standing MU does not move.
        expect(worldPos(standing!).distanceTo(start)).toBeLessThan(1e-6);
      }
    }
    expect(pusher.lastPlan!.couplePosition).toBeCloseTo(200, 3);
    expect(coupledAt).toBeGreaterThanOrEqual(200);
    expect(coupledAt).toBeLessThan(200 + 100 * DT + 1e-6);
    expect(Math.abs(contactErrMm), 'touching at the coupling tick').toBeLessThan(0.5);
    // Released at the end position: free, 0.3 m further, over the belt.
    expect(releasedAtAxis).toBeCloseTo(RELEASE, 3);
    expect(pusher.pushedMU).toBeNull();
    expect(standing!.heldBy).toBeNull();
    expect(pusher.pushedCount).toBe(1);
    expect(released, 'released during the move').toBeTruthy();
    expect(released!.z).toBeCloseTo(0.9, 3);
    expect(released!.x).toBeCloseTo(0, 6);
    expect(released!.y).toBeCloseTo(0.3, 6);
    // Still touching the pushing MU at the release.
    expect(releaseGapMm).toBeCloseTo(0, 1);
    // The belt takes it over and the sink removes it.
    let gone = false;
    for (let i = 0; i < 400 && !gone; i++) {
      step();
      gone = !tm.mus.includes(standing!);
    }
    expect(gone, 'the sink removed the pushed MU').toBe(true);
    expect(tm.mus).toContain(pushing);
  });

  it('an empty station never couples', async () => {
    const { tm, axis, pusher, pushing, step } = await load({ standing: false });
    expect(tm.mus).toEqual([pushing]);
    axis.startMove(RELEASE);
    for (let i = 0; i < 400 && axis.isRunning; i++) step();
    expect(axis.currentPosition).toBeCloseTo(RELEASE, 3);
    expect(pusher.lastPlan).toBeNull();
    expect(pusher.pushedCount).toBe(0);
  });

  it('a move to another position does not arm the push', async () => {
    const { axis, pusher, standing, step } = await load({ standing: true });
    const start = worldPos(standing!).clone();
    axis.startMove(RELEASE - 50); // 300 mm: past the couple position, not the release
    for (let i = 0; i < 400 && axis.isRunning; i++) step();
    expect(pusher.lastPlan).toBeNull();
    expect(standing!.heldBy).toBeNull();
    // The gripped MU now overlaps the standing one — no push without the release move.
    expect(worldPos(standing!).distanceTo(start)).toBeLessThan(1e-6);
  });

  it('finds the standing MU also when the station sensor reports the carried MU', async () => {
    const { axis, pusher, pushing, standing, step } = await load({ standing: true, bigSensor: true });
    expect(pusher.Sensor!.occupiedMU, 'the carried MU is the first one in the sensor').toBe(pushing);
    axis.startMove(RELEASE);
    for (let i = 0; i < 400 && axis.isRunning; i++) step();
    expect(pusher.lastPlan!.couplePosition).toBeCloseTo(200, 3);
    expect(pusher.pushedCount).toBe(1);
    expect(worldPos(standing!).z).toBeGreaterThan(0.89);
  });

  it('dispose while coupled lets go of the MU at its world pose (Codex review): no longer under the grip', async () => {
    const { tm, axis, pusher, grip, standing, step } = await load({ standing: true });
    axis.startMove(RELEASE);
    for (let i = 0; i < 400 && axis.isRunning && !pusher.pushedMU; i++) step();
    expect(pusher.pushedMU, 'coupled').toBe(standing);
    expect(standing!.heldBy).toBe('pusher');
    const before = worldPos(standing!).clone();
    pusher.dispose();
    expect(standing!.heldBy).toBeNull();
    expect(standing!.parentBeforeGrip).toBeNull();
    let underGrip = false;
    for (let n = standing!.node.parent; n; n = n.parent) if (n === grip.node) underGrip = true;
    expect(underGrip, 'detached from the grip').toBe(false);
    expect(worldPos(standing!).distanceTo(before), 'world pose kept').toBeLessThan(1e-6);
    expect(tm.mus).toContain(standing);
    // The axis keeps moving: the freed MU does not ride along.
    const z0 = worldPos(standing!).z;
    for (let i = 0; i < 20 && axis.isRunning; i++) step();
    expect(worldPos(standing!).z - z0).toBeLessThan(0.02);
  });
});
