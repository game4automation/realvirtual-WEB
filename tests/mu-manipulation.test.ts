// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * mu-manipulation.test.ts — plan-567 §9.1: the engine primitives behind
 * "take a carrier off the line / put it elsewhere" in Commissioning.
 *
 *  - deleteMU while paused frees the sensor at once (signal written), incl.
 *    inverted sensors, residual occupancy and tag-limited load detection
 *    (SOL #9); the grid path gives the same answer as the brute-force path;
 *  - connection holds are released — single-MU hold and the belt-stop
 *    refcount with two holds on one drive (F1);
 *  - the flow ledger forgets the MU (SOL #1);
 *  - a pre-placed carrier is removed with its load tree and comes back on a
 *    reset (SOL #2/#11);
 *  - placeMUOnSurface: bottom on the surface top, yaw kept, next tick on the
 *    new surface, overlap refused without a change, loads ride along (F2,
 *    SOL #4/#5); physics-owned and held carriers are refused;
 *  - the drag: 'user' hold, GripTarget stays reserved, cancel restores
 *    everything, a concurrent drop onto the reserved target is impossible,
 *    commit frees the target (SOL #3, R2-1).
 *
 * Fixtures modelled on zone-hold.test.ts / _mu-preplaced-fixture.ts.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { Object3D, Quaternion, Scene, Vector3 } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { RVSensor } from '../src/core/engine/rv-sensor';
import { RVGripTarget } from '../src/core/engine/rv-grip-target';
import type { RVDrive } from '../src/core/engine/rv-drive';
import { ConnectionHoldController, __setConnectionHoldsForTests } from '../src/core/engine/rv-connection-hold';
import { findNearestGripTarget } from '../src/core/engine/rv-mu-hold';
import { createLocalFlowBackend, trackFlowLedger } from '../src/core/sdk/rv-sdk-flow';
import {
  REASON_OCCUPIED,
  REASON_PHYSICS,
  REASON_NO_SURFACE,
  beginUserDrag,
  cancelUserDrag,
  commitUserDrag,
  deleteMU,
  placeMUOnSurface,
  previewUserDrag,
  resolveCarrierById,
} from '../src/core/engine/rv-mu-manipulation';
import { classifiedScene, muOf, palletRow, worldPos } from './_mu-preplaced-fixture';

const DT = 1 / 60;
const MU_HALF = new Vector3(0.05, 0.05, 0.05);

let holds: ConnectionHoldController;
const disposers: (() => void)[] = [];
beforeEach(() => {
  holds = new ConnectionHoldController();
  __setConnectionHoldsForTests(holds);
});
afterEach(() => {
  __setConnectionHoldsForTests(null);
  for (const d of disposers.splice(0)) d();
});

interface MockDrive {
  jogForward: boolean; jogBackward: boolean; isRunning: boolean;
  currentSpeed: number; targetSpeed: number; name: string;
  stop(): void; startMove(): void;
}

function mockDrive(speed: number): MockDrive {
  const d: MockDrive = {
    jogForward: false, jogBackward: false, isRunning: speed !== 0, currentSpeed: speed, targetSpeed: speed, name: 'drive',
    stop() { d.isRunning = false; d.currentSpeed = 0; },
    startMove() { d.isRunning = true; d.currentSpeed = d.targetSpeed; },
  };
  return d;
}

function surfaceAt(scene: Scene, name: string, x: number, y: number, speed: number, halfX = 2, accumulate = true): RVTransportSurface {
  const node = new Object3D();
  node.name = name;
  node.position.set(x, y, 0);
  scene.add(node);
  const s = new RVTransportSurface(node, AABB.fromHalfSize(node, new Vector3(halfX, 0.05, 0.5)));
  s.TransportDirection.set(1, 0, 0);
  s.Radial = false;
  s.TextureScale = 1;
  s.HeightOffsetOverride = 0;
  s.Accumulate = accumulate;
  s.reapplyConfig();
  s.initTransport();
  s.drive = mockDrive(speed) as unknown as RVDrive;
  return s;
}

function muAt(scene: Scene, name: string, x: number, y = 0, z = 0): RVMovingUnit {
  const node = new Object3D();
  node.name = name;
  node.position.set(x, y, z);
  scene.add(node);
  return new RVMovingUnit(node, 'test-source', MU_HALF.clone());
}

function sensorAt(scene: Scene, x: number, signal: { value: boolean | null }): RVSensor {
  const node = new Object3D();
  node.name = `Sensor@${x}`;
  node.position.set(x, 0, 0);
  scene.add(node);
  const s = new RVSensor(node, AABB.fromHalfSize(node, new Vector3(0.05, 0.5, 0.5)));
  s.UseRaycast = false;
  s.invertSignal = false;
  s.onChanged = (occ) => { signal.value = occ; };
  return s;
}

interface Line {
  scene: Scene;
  tm: RVTransportManager;
  a: RVTransportSurface;
  b: RVTransportSurface;
}

/** Two belts: A at x∈[-2, 2] (stopped), B at x∈[4, 8] (running, +X). Tops at y = -0.05. */
function line(bruteForceThreshold = 64): Line {
  const scene = new Scene();
  const tm = new RVTransportManager();
  tm.scene = scene;
  tm.bruteForceThreshold = bruteForceThreshold;
  const a = surfaceAt(scene, 'BeltA', 0, -0.1, 0);
  const b = surfaceAt(scene, 'BeltB', 6, -0.1, 500);
  tm.surfaces.push(a, b);
  return { scene, tm, a, b };
}

function run(tm: RVTransportManager, ticks: number): void {
  for (let i = 0; i < ticks; i++) tm.update(DT);
}

// ─── deleteMU ───────────────────────────────────────────────────────────

describe('deleteMU while paused (F1/F3, SOL #9)', () => {
  for (const threshold of [64, 0]) {
    const path = threshold === 0 ? 'grid path' : 'brute-force path';
    it(`frees the sensor at once and writes its signal — ${path}`, () => {
      const l = line(threshold);
      const sig = { value: null as boolean | null };
      l.tm.sensors.push(sensorAt(l.scene, 0, sig));
      const mu = muAt(l.scene, 'WT1', 0);
      l.tm.mus.push(mu);
      run(l.tm, 1);
      expect(l.tm.sensors[0].occupied).toBe(true);
      expect(sig.value).toBe(true);

      // Paused: no further tick.
      const r = deleteMU(l.tm, mu);
      expect(r.ok).toBe(true);
      expect(l.tm.mus).not.toContain(mu);
      expect(mu.node.parent).toBeNull();
      expect(l.tm.sensors[0].occupied).toBe(false);
      expect(l.tm.sensors[0].occupiedMU).toBeNull();
      expect(sig.value).toBe(false);
      // Taken off by hand, not consumed by a sink.
      expect(l.tm.totalConsumed).toBe(0);
    });
  }

  it('inverted sensor: becomes "occupied" (raw free) right after the delete', () => {
    const l = line();
    const sig = { value: null as boolean | null };
    const s = sensorAt(l.scene, 0, sig);
    s.invertSignal = true;
    l.tm.sensors.push(s);
    const mu = muAt(l.scene, 'WT1', 0);
    l.tm.mus.push(mu);
    run(l.tm, 1);
    expect(s.occupied).toBe(false);
    deleteMU(l.tm, mu);
    expect(s.occupied).toBe(true);
    expect(sig.value).toBe(true);
  });

  it('residual occupancy: a second carrier keeps the sensor occupied', () => {
    const l = line();
    const sig = { value: null as boolean | null };
    const s = sensorAt(l.scene, 0, sig);
    l.tm.sensors.push(s);
    const first = muAt(l.scene, 'WT1', -0.02);
    const second = muAt(l.scene, 'WT2', 0.03, 0, 0.3);
    l.tm.mus.push(first, second);
    run(l.tm, 1);
    deleteMU(l.tm, first);
    expect(s.occupied).toBe(true);
    expect(s.occupiedMU).toBe(second);
  });

  it('live-controlled sensor keeps its relayed value', () => {
    const l = line();
    const sig = { value: null as boolean | null };
    const s = sensorAt(l.scene, 0, sig);
    l.tm.sensors.push(s);
    const mu = muAt(l.scene, 'WT1', 0);
    l.tm.mus.push(mu);
    run(l.tm, 1);
    s.liveControlled = true;
    deleteMU(l.tm, mu);
    expect(s.occupied).toBe(true);
  });
});

describe('deleteMU releases holds and bookings (F1, SOL #1)', () => {
  it('a single-MU connection hold is released', () => {
    const l = line();
    const mu = muAt(l.scene, 'WT1', 0);
    l.tm.mus.push(mu);
    run(l.tm, 1);
    expect(holds.hold(mu.id, l.tm)).toBe('held');
    expect(mu.heldBy).toBe('connection');
    const r = deleteMU(l.tm, mu);
    expect(r.ok && r.releasedHold).toBe('held');
    expect(holds.isHeld(mu.id)).toBe(false);
    expect(holds.heldCount).toBe(0);
  });

  it('two belt-stop holds on one drive: the belt restarts only when the last one is gone', () => {
    const scene = new Scene();
    const tm = new RVTransportManager();
    tm.scene = scene;
    const belt = surfaceAt(scene, 'Belt', 0, -0.1, 500, 2, false);
    tm.surfaces.push(belt);
    const drive = belt.drive as unknown as MockDrive;
    const m1 = muAt(scene, 'WT1', -1);
    const m2 = muAt(scene, 'WT2', 1);
    tm.mus.push(m1, m2);
    run(tm, 1);
    expect(holds.hold(m1.id, tm)).toBe('belt-stop');
    expect(holds.hold(m2.id, tm)).toBe('belt-stop');
    expect(drive.isRunning).toBe(false);

    const r1 = deleteMU(tm, m1);
    expect(r1.ok && r1.releasedHold).toBe('belt-stop');
    expect(drive.isRunning).toBe(false); // the other hold still stops it
    deleteMU(tm, m2);
    expect(drive.isRunning).toBe(true);
    expect(holds.heldCount).toBe(0);
  });

  it('the flow ledger forgets the deleted carrier', () => {
    const l = line();
    const mu = muAt(l.scene, 'WT1', 0);
    l.tm.mus.push(mu);
    const flow = createLocalFlowBackend();
    disposers.push(trackFlowLedger(flow));
    const booked = flow.accept({ id: mu.id, type: '' });
    flow.park(booked.id);
    expect(flow.isParked(mu.id)).toBe(true);
    deleteMU(l.tm, mu);
    expect(flow.held).toHaveLength(0);
    expect(flow.isParked(mu.id)).toBe(false);
  });
});

describe('deleteMU of a pre-placed carrier with loads (SOL #2/#11)', () => {
  it('removes carrier + load tree; the reset brings both back', () => {
    const { root, pallets, parts } = palletRow(1, 2);
    const { tm } = classifiedScene(root);
    tm.activatePreplaced();
    const pallet = muOf(tm, pallets[0]);
    const part = muOf(tm, parts[0][0]);
    expect(part.loadedOn).toBe(pallet);

    // A click on the load addresses the carrier.
    const r = deleteMU(tm, part);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.id).toBe(pallet.id);
    expect(r.preplaced).toBe(true);
    expect(r.removed).toEqual(expect.arrayContaining([pallet.id, part.id, muOf(tm, parts[0][1]).id]));
    expect(tm.mus).toHaveLength(0);
    expect(pallets[0].parent).toBeNull();

    tm.restorePreplaced(true);
    expect(tm.mus).toContain(pallet);
    expect(pallets[0].parent).toBe(root);
    expect(part.loadedOn).toBe(pallet);
    expect(worldPos(pallets[0]).x).toBeCloseTo(0, 6);
  });

  it('a tag-limited sensor that saw the load is freed with the carrier', () => {
    const { root, pallets, parts } = palletRow(1, 1);
    const { scene, tm } = classifiedScene(root);
    tm.activatePreplaced();
    const sig = { value: null as boolean | null };
    const s = sensorAt(scene, 0, sig);
    s.LimitSensorToTag = parts[0][0].name;
    tm.sensors.push(s);
    tm.refreshDetection();
    expect(s.occupied).toBe(true);
    deleteMU(tm, muOf(tm, pallets[0]));
    expect(s.occupied).toBe(false);
    expect(sig.value).toBe(false);
  });

  it('physics-owned carriers are refused and stay untouched', () => {
    const l = line();
    const mu = muAt(l.scene, 'WT1', 0);
    l.tm.mus.push(mu);
    mu.physicsOwned = true;
    const r = deleteMU(l.tm, mu);
    expect(r).toEqual({ ok: false, reason: REASON_PHYSICS });
    expect(l.tm.mus).toContain(mu);
    const m = placeMUOnSurface(l.tm, mu, new Vector3(6, 0, 0));
    expect(m.ok).toBe(false);
    expect(mu.node.position.x).toBe(0);
  });
});

// ─── placeMUOnSurface ───────────────────────────────────────────────────

describe('placeMUOnSurface (F2, SOL #4/#5)', () => {
  it('bottom on the surface top, yaw kept, the next tick drives it on the new surface', () => {
    const l = line();
    const mu = muAt(l.scene, 'WT1', 0, 0.3);
    mu.node.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 4);
    const yaw = mu.node.quaternion.clone();
    l.tm.mus.push(mu);
    run(l.tm, 1);
    mu.everOnSurface = true;
    mu.offSurfaceTime = 1.5;

    const r = placeMUOnSurface(l.tm, mu, new Vector3(5, 1, 0.1));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.surface).toBe('BeltB');
    mu.updateAABB();
    expect(mu.aabb.min.y).toBeCloseTo(l.b.aabb.max.y, 6);
    expect(mu.aabb.center.x).toBeCloseTo(5, 6);
    expect(mu.aabb.center.z).toBeCloseTo(0.1, 6);
    expect(mu.node.quaternion.angleTo(yaw)).toBeLessThan(1e-9);
    expect(mu.currentSurface).toBeNull();
    expect(mu.everOnSurface).toBeUndefined();
    expect(mu.offSurfaceTime).toBeUndefined();

    const x0 = mu.node.position.x;
    run(l.tm, 6);
    expect(mu.currentSurface).toBe(l.b);
    expect(mu.node.position.x).toBeGreaterThan(x0);
  });

  it('snapToCenterLine removes the lateral offset', () => {
    const l = line();
    const mu = muAt(l.scene, 'WT1', 0);
    l.tm.mus.push(mu);
    const r = placeMUOnSurface(l.tm, mu, new Vector3(5, 0, 0.3), { snapToCenterLine: true });
    expect(r.ok).toBe(true);
    mu.updateAABB();
    expect(mu.aabb.center.z).toBeCloseTo(0, 6);
  });

  for (const threshold of [64, 0]) {
    it(`an occupied drop position is refused and nothing changes (${threshold === 0 ? 'grid' : 'brute force'})`, () => {
      const l = line(threshold);
      const mu = muAt(l.scene, 'WT1', 0);
      const blocker = muAt(l.scene, 'WT2', 5);
      l.tm.mus.push(mu, blocker);
      run(l.tm, 1);
      const before = mu.node.position.clone();
      const surfaceBefore = mu.currentSurface;
      const r = placeMUOnSurface(l.tm, mu, new Vector3(5.05, 0, 0));
      expect(r).toEqual({ ok: false, reason: REASON_OCCUPIED });
      expect(mu.node.position.equals(before)).toBe(true);
      expect(mu.currentSurface).toBe(surfaceBefore);
    });
  }

  it('a held carrier (even a hidden one, held by the gripper) blocks the drop position', () => {
    const l = line();
    const mu = muAt(l.scene, 'WT1', 0);
    const held = muAt(l.scene, 'WT2', 5);
    l.tm.mus.push(mu, held);
    held.heldBy = 'grip';
    const r = placeMUOnSurface(l.tm, mu, new Vector3(5, 0, 0));
    expect(r.ok).toBe(false);
  });

  it('off every surface is refused', () => {
    const l = line();
    const mu = muAt(l.scene, 'WT1', 0);
    l.tm.mus.push(mu);
    expect(placeMUOnSurface(l.tm, mu, new Vector3(3, 0, 0))).toEqual({ ok: false, reason: REASON_NO_SURFACE });
  });

  it('a held carrier is refused with the holder named', () => {
    const l = line();
    const mu = muAt(l.scene, 'WT1', 0);
    l.tm.mus.push(mu);
    mu.heldBy = 'zone';
    const r = placeMUOnSurface(l.tm, mu, new Vector3(5, 0, 0));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/zone/);
  });

  it('passive loads ride along and are not an overlap with their own carrier', () => {
    const { root, pallets, parts } = palletRow(1, 2);
    const { scene, tm } = classifiedScene(root);
    const belt = surfaceAt(scene, 'Belt', 5, -0.05, 0);
    tm.surfaces.push(belt);
    tm.activatePreplaced();
    const pallet = muOf(tm, pallets[0]);
    const before = worldPos(parts[0][0]);
    const r = placeMUOnSurface(tm, pallet, new Vector3(5, 0, 0));
    expect(r.ok).toBe(true);
    const after = worldPos(parts[0][0]);
    expect(after.x - before.x).toBeCloseTo(5, 6);
    expect(muOf(tm, parts[0][0]).loadedOn).toBe(pallet);
    // A load's id addresses its carrier (the MCP path).
    expect(resolveCarrierById(tm, muOf(tm, parts[0][1]).id)).toBe(pallet);
  });

  it('a teleport ends the flow booking', () => {
    const l = line();
    const mu = muAt(l.scene, 'WT1', 0);
    l.tm.mus.push(mu);
    const flow = createLocalFlowBackend();
    disposers.push(trackFlowLedger(flow));
    flow.accept({ id: mu.id, type: '' });
    placeMUOnSurface(l.tm, mu, new Vector3(5, 0, 0));
    expect(flow.held).toHaveLength(0);
  });
});

// ─── Drag gesture ───────────────────────────────────────────────────────

function onTarget(l: Line): { mu: RVMovingUnit; target: RVGripTarget } {
  const tn = new Object3D();
  tn.name = 'Target';
  tn.position.set(0, 0, 0);
  l.scene.add(tn);
  const target = new RVGripTarget(tn);
  l.tm.gripTargets.push(target);
  const mu = muAt(l.scene, 'WT1', 0);
  tn.attach(mu.node);
  target.setOccupied(mu);
  l.tm.mus.push(mu);
  return { mu, target };
}

describe('drag gesture on the hold kernel (SOL #3, R2-1)', () => {
  it("holds with 'user', keeps the GripTarget reserved, cancel restores owner, parent, pose and surface", () => {
    const l = line();
    const { mu, target } = onTarget(l);
    const parent = mu.node.parent;
    const pos = mu.node.position.clone();
    const quat = mu.node.quaternion.clone();
    mu.lastSurface = l.a;
    mu.everOnSurface = true;

    const session = beginUserDrag(l.tm, mu);
    expect('ok' in session).toBe(false);
    if ('ok' in session) return;
    expect(mu.heldBy).toBe('user');
    expect(target.occupiedBy).toBe(mu);
    previewUserDrag(l.tm, session, new Vector3(5, 0, 0), l.b);
    expect(worldPos(mu.node).x).toBeCloseTo(5, 6);

    // A concurrent drop cannot use the reserved target.
    expect(findNearestGripTarget(l.tm.gripTargets, new Vector3(0, 0, 0), 500)).toBeNull();

    cancelUserDrag(l.tm, session);
    expect(mu.heldBy).toBeNull();
    expect(mu.node.parent).toBe(parent);
    expect(mu.node.position.equals(pos)).toBe(true);
    expect(mu.node.quaternion.equals(quat as Quaternion)).toBe(true);
    expect(mu.lastSurface).toBe(l.a);
    expect(mu.everOnSurface).toBe(true);
    expect(target.occupiedBy).toBe(mu);
  });

  it('commit places on the surface and frees the GripTarget', () => {
    const l = line();
    const { mu, target } = onTarget(l);
    const session = beginUserDrag(l.tm, mu);
    if ('ok' in session) throw new Error(session.reason);
    previewUserDrag(l.tm, session, new Vector3(6, 0, 0), l.b);
    const r = commitUserDrag(l.tm, session, new Vector3(6, 0, 0), l.b);
    expect(r.ok).toBe(true);
    expect(mu.heldBy).toBeNull();
    expect(target.occupiedBy).toBeNull();
    expect(mu.node.parent).toBe(l.scene);
    mu.updateAABB();
    expect(mu.aabb.center.x).toBeCloseTo(6, 6);
  });

  it('a refused commit leaves the carrier exactly where it was', () => {
    const l = line();
    const { mu, target } = onTarget(l);
    const blocker = muAt(l.scene, 'WT2', 6);
    l.tm.mus.push(blocker);
    const pos = mu.node.position.clone();
    const session = beginUserDrag(l.tm, mu);
    if ('ok' in session) throw new Error(session.reason);
    const check = previewUserDrag(l.tm, session, new Vector3(6, 0, 0), l.b);
    expect(check.ok).toBe(false);
    const r = commitUserDrag(l.tm, session, new Vector3(6, 0, 0), l.b);
    expect(r.ok).toBe(false);
    expect(mu.node.position.equals(pos)).toBe(true);
    expect(target.occupiedBy).toBe(mu);
    expect(mu.heldBy).toBeNull();
  });

  it('only a free carrier can be taken', () => {
    const l = line();
    const mu = muAt(l.scene, 'WT1', 0);
    l.tm.mus.push(mu);
    mu.heldBy = 'grip';
    const s = beginUserDrag(l.tm, mu);
    expect('ok' in s && s.reason).toMatch(/gripper/);
  });

  it('a reset during the gesture: cancel is a no-op on the restored carrier', () => {
    const { root, pallets } = palletRow(1, 0);
    const { tm } = classifiedScene(root);
    tm.activatePreplaced();
    const pallet = muOf(tm, pallets[0]);
    const session = beginUserDrag(tm, pallet);
    if ('ok' in session) throw new Error(session.reason);
    tm.reset();
    tm.restorePreplaced(true);
    expect(pallet.heldBy).toBeNull();
    const parent = pallets[0].parent;
    cancelUserDrag(tm, session);
    expect(pallets[0].parent).toBe(parent);
  });
});
