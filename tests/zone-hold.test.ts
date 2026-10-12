// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * zone-hold.test.ts — plan-521 §9.3: the Hold effect on the shared hold kernel.
 *
 * Covers acquire (OnActivate / WhileActive, All / One as total occupancy), the
 * Zone release policy (surface → GripTarget → in place) next to the UNCHANGED
 * Grip policy (GripTarget → carrier → in place), owner rules against Grip and
 * ConnectionHold, lifecycle (removal, zone dispose, reset with a pre-placed MU
 * and its load), passive loads riding along, the switch-on tick, and authority
 * (DES gate, multiuser follower).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Object3D, Scene, Vector3 } from 'three';
import { RVZone } from '../src/core/engine/rv-zone';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { RVGripTarget } from '../src/core/engine/rv-grip-target';
import { RVGrip } from '../src/core/engine/rv-grip';
import { ConnectionHoldController } from '../src/core/engine/rv-connection-hold';
import { ContinuousRunner } from '../src/core/material-flow/continuous-runner';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';
import { classifiedScene, muOf, palletRow, worldPos, PALLET } from './_mu-preplaced-fixture';

const DT = 1 / 60;
const MU_HALF = new Vector3(0.05, 0.05, 0.05);

function createMU(name: string, x: number, y: number, z: number, parent?: Object3D): RVMovingUnit {
  const node = new Object3D();
  node.name = name;
  node.position.set(x, y, z);
  parent?.add(node);
  return new RVMovingUnit(node, 'test-source', MU_HALF.clone());
}

function createSurface(x: number, y: number, speed: number, halfX = 2): RVTransportSurface {
  const node = new Object3D();
  node.position.set(x, y, 0);
  const surface = new RVTransportSurface(node, AABB.fromHalfSize(node, new Vector3(halfX, 0.05, 0.5)));
  surface.TransportDirection.set(1, 0, 0);
  surface.Radial = false;
  surface.TextureScale = 1;
  surface.HeightOffsetOverride = 0;
  surface.reapplyConfig();
  surface.initTransport();
  surface.drive = { currentSpeed: speed, name: 'mock-drive' } as unknown as RVTransportSurface['drive'];
  return surface;
}

interface Rig {
  scene: Scene;
  manager: RVTransportManager;
  store: SignalStore;
  axis: Object3D;
  zone: RVZone;
  /** Set the activation signal (the zone is Signal-activated). */
  setActive(v: boolean): void;
}

/** A Hold zone on a lift axis node in `scene`, activated by a bool signal. */
function rig(size: [number, number, number] = [400, 300, 400], at: [number, number, number] = [0, 0, 0]): Rig {
  const scene = new Scene();
  const manager = new RVTransportManager();
  manager.scene = scene;
  const store = new SignalStore();
  store.register('Act', 'Signals/Act', false);
  const axis = new Object3D();
  axis.name = 'Lift';
  axis.position.set(...at);
  scene.add(axis);
  const zone = new RVZone(axis);
  zone.Size.set(...size);
  zone.Detect = true;
  zone.Hold = true;
  zone.Activation = 'Signal';
  zone.ActivationSignal = 'Signals/Act';
  zone.init({ transportManager: manager, signalStore: store } as unknown as ComponentContext);
  return { scene, manager, store, axis, zone, setActive: (v) => store.setByPath('Signals/Act', v) };
}

function addMU(r: Rig, name: string, x: number, y = 0, z = 0): RVMovingUnit {
  const mu = createMU(name, x, y, z, r.scene);
  r.manager.mus.push(mu);
  return mu;
}

function addTarget(r: Rig, x: number, y: number): RVGripTarget {
  const n = new Object3D();
  n.name = 'Target';
  n.position.set(x, y, 0);
  r.scene.add(n);
  const t = new RVGripTarget(n);
  r.manager.gripTargets.push(t);
  return t;
}

function run(manager: RVTransportManager, ticks: number): void {
  for (let i = 0; i < ticks; i++) manager.update(DT);
}

const disposers: (() => void)[] = [];
afterEach(() => { for (const d of disposers.splice(0)) d(); });

describe('Zone Hold acquire (F6)', () => {
  it('OnActivate + All: every contained MU is held at the switch-on, follows the moving zone; later ones are not taken', () => {
    const r = rig();
    const a = addMU(r, 'a', -0.1);
    const b = addMU(r, 'b', 0.1);
    const outside = addMU(r, 'outside', -1);
    run(r.manager, 2);
    expect(r.zone.held).toHaveLength(0);
    r.setActive(true);
    run(r.manager, 1);
    expect(r.zone.held).toEqual(expect.arrayContaining([a, b]));
    expect(r.zone.held).toHaveLength(2);
    expect(a.heldBy).toBe('zone');
    expect(a.node.parent).toBe(r.axis);
    expect(a.currentSurface).toBeNull();

    r.axis.position.y += 0.5; // the lift raises
    run(r.manager, 1);
    expect(worldPos(a.node).y).toBeCloseTo(0.5, 6);
    expect(worldPos(b.node).y).toBeCloseTo(0.5, 6);

    r.axis.position.y = 0;
    outside.node.position.x = 0; // enters the box after the edge
    run(r.manager, 3);
    expect(outside.heldBy).toBeNull();
    expect(r.zone.held).toHaveLength(2);
  });

  it('WhileActive: an MU entering later is held', () => {
    const r = rig();
    r.zone.HoldAcquire = 'WhileActive';
    r.manager.surfaces.push(createSurface(0, -0.1, 500));
    r.setActive(true);
    const late = addMU(r, 'late', -1);
    run(r.manager, 150);
    expect(late.heldBy).toBe('zone');
    expect(r.zone.held).toEqual([late]);
  });

  it('One: only the MU nearest the box center, and never a second one over many ticks', () => {
    const r = rig([600, 300, 400]);
    r.zone.HoldCount = 'One';
    r.zone.HoldAcquire = 'WhileActive';
    const far = addMU(r, 'far', 0.2);
    const near = addMU(r, 'near', 0.05);
    r.setActive(true);
    run(r.manager, 1);
    expect(r.zone.held).toEqual([near]);
    const later = addMU(r, 'later', -0.2);
    run(r.manager, 60);
    expect(r.zone.held).toEqual([near]);
    expect(far.heldBy).toBeNull();
    expect(later.heldBy).toBeNull();
  });

  it('switch-on tick: a contained MU that would leave the box in this very tick is held (Hold and Hold+Block)', () => {
    for (const block of [false, true]) {
      const r = rig([400, 300, 400]);
      r.zone.Block = block;
      r.manager.surfaces.push(createSurface(0, -0.1, 5000));
      // Leading face 1 mm inside the exit face (0.2): one 5 m/s tick (83 mm) would carry it out.
      const mu = addMU(r, 'edge', 0.149);
      run(r.manager, 1); // inactive: no hold (the belt moves it on this tick)
      mu.node.position.x = 0.149;
      mu.updateAABB();
      r.setActive(true);
      run(r.manager, 1);
      expect(mu.heldBy, `block=${block}`).toBe('zone');
      expect(mu.node.position.x, `block=${block}`).toBeCloseTo(0.149, 6);
    }
  });
});

describe('Zone release policy (F7) vs Grip policy', () => {
  it('surface below → lowered onto it and transported again', () => {
    const r = rig();
    r.manager.surfaces.push(createSurface(0, -0.1, 500));
    const mu = addMU(r, 'part', 0);
    r.setActive(true);
    run(r.manager, 1);
    r.axis.position.y = 0.4; // lifted
    run(r.manager, 1);
    r.setActive(false);
    run(r.manager, 1);
    expect(mu.heldBy).toBeNull();
    expect(mu.node.parent).toBe(r.scene);
    // Lowered onto the belt top (y = -0.05): the part's bottom rests there.
    expect(mu.aabb.min.y).toBeCloseTo(-0.05, 6);
    const x0 = worldPos(mu.node).x;
    run(r.manager, 30);
    expect(worldPos(mu.node).x).toBeGreaterThan(x0 + 0.1);
  });

  it('plan-570: released a hair BELOW the surface top (lift latency) → put onto the top; deeper → left alone', () => {
    for (const [dy, expected] of [[-0.001, -0.05], [-0.02, -0.07]] as const) {
      const r = rig();
      r.manager.surfaces.push(createSurface(0, -0.1, 500));
      const mu = addMU(r, 'part', 0);
      r.setActive(true);
      run(r.manager, 1);
      r.axis.position.y = dy; // carried slightly into the belt
      run(r.manager, 1);
      r.setActive(false);
      run(r.manager, 1);
      expect(mu.heldBy).toBeNull();
      expect(mu.aabb.min.y, `dy=${dy}`).toBeCloseTo(expected, 6);
    }
  });

  it('only a GripTarget in reach → placed on it; surface AND GripTarget → the surface wins; nothing → stays in place', () => {
    // GripTarget only
    {
      const r = rig();
      const mu = addMU(r, 'part', 0);
      const t = addTarget(r, 0.3, 0.2);
      r.setActive(true);
      run(r.manager, 1);
      r.setActive(false);
      run(r.manager, 1);
      expect(mu.node.parent).toBe(t.node);
      expect(t.occupiedBy).toBe(mu);
      expect(worldPos(mu.node).distanceTo(worldPos(t.node))).toBeLessThan(1e-6);
    }
    // Surface AND GripTarget
    {
      const r = rig();
      r.manager.surfaces.push(createSurface(0, -0.1, 0));
      const mu = addMU(r, 'part', 0);
      const t = addTarget(r, 0.3, 0.2);
      r.setActive(true);
      run(r.manager, 1);
      r.setActive(false);
      run(r.manager, 1);
      expect(t.occupiedBy).toBeNull();
      expect(mu.node.parent).toBe(r.scene);
    }
    // Nothing
    {
      const r = rig();
      const mu = addMU(r, 'part', 0.05, 0.02);
      r.setActive(true);
      run(r.manager, 1);
      r.axis.position.x = 0.5;
      run(r.manager, 1);
      const held = worldPos(mu.node).clone();
      r.setActive(false);
      run(r.manager, 1);
      expect(mu.heldBy).toBeNull();
      expect(mu.node.parent).toBe(r.scene);
      expect(worldPos(mu.node).distanceTo(held)).toBeLessThan(1e-9);
    }
  });

  it('Grip keeps its own order: surface AND GripTarget → the GripTarget wins', () => {
    const r = rig();
    r.manager.surfaces.push(createSurface(0, -0.1, 0));
    const t = addTarget(r, 0.3, 0.2);
    const gripNode = new Object3D();
    gripNode.position.set(0, 0.05, 0);
    r.scene.add(gripNode);
    const grip = new RVGrip(gripNode);
    grip.allMUs = () => r.manager.mus;
    grip.allGripTargets = () => r.manager.gripTargets;
    grip.loadHost = r.manager;
    const mu = addMU(r, 'part', 0);
    grip.pick();
    expect(mu.heldBy).toBe('grip');
    grip.place();
    expect(t.occupiedBy).toBe(mu);
    expect(mu.node.parent).toBe(t.node);
  });
});

describe('Zone owner rules', () => {
  it('a grip-held or connection-held MU is never taken; the grip never picks a zone-held MU; the zone never frees a grip MU', () => {
    const r = rig();
    const gripped = addMU(r, 'gripped', -0.1);
    const connected = addMU(r, 'connected', 0.1);
    gripped.heldBy = 'grip';
    connected.heldBy = 'connection';
    r.setActive(true);
    run(r.manager, 1);
    expect(r.zone.held).toHaveLength(0);
    expect(gripped.heldBy).toBe('grip');
    expect(connected.heldBy).toBe('connection');
    r.setActive(false);
    run(r.manager, 1);
    expect(gripped.heldBy).toBe('grip');
    gripped.heldBy = null;
    connected.heldBy = null;

    // Zone holds → a grip in range does not pick it.
    r.setActive(true);
    run(r.manager, 1);
    expect(gripped.heldBy).toBe('zone');
    const gripNode = new Object3D();
    r.scene.add(gripNode);
    const grip = new RVGrip(gripNode);
    grip.allMUs = () => r.manager.mus;
    grip.allGripTargets = () => [];
    grip.GripRange = 1000;
    grip.pick();
    expect(grip.grippedMUs).toHaveLength(0);
    grip.place();
    expect(gripped.heldBy).toBe('zone');
  });

  it('connection protection: a zone-held MU is not re-owned by ConnectionHold; a release there changes nothing; the zone still frees it', () => {
    const r = rig();
    const mu = addMU(r, 'part', 0);
    r.setActive(true);
    run(r.manager, 1);
    const holds = new ConnectionHoldController();
    expect(holds.hold(mu.id, r.manager)).toBe('none');
    holds.release(mu.id);
    expect(mu.heldBy).toBe('zone');
    expect(r.zone.held).toEqual([mu]);
    r.setActive(false);
    run(r.manager, 1);
    expect(mu.heldBy).toBeNull();
    expect(r.zone.held).toHaveLength(0);
    // …and a free MU is held by the connection as before.
    expect(holds.hold(mu.id, r.manager)).toBe('held');
    expect(mu.heldBy).toBe('connection');
  });
});

describe('Zone lifecycle (F13)', () => {
  it('a held MU that is removed is forgotten — deactivating afterwards neither throws nor re-attaches', () => {
    const r = rig();
    const mu = addMU(r, 'part', 0);
    r.setActive(true);
    run(r.manager, 1);
    r.manager.removeMU(mu);
    expect(r.zone.held).toHaveLength(0);
    expect(mu.heldBy).toBeNull();
    r.setActive(false);
    expect(() => run(r.manager, 2)).not.toThrow();
    expect(mu.node.parent).toBeNull();
  });

  it('a zone removed while holding frees its MUs in place', () => {
    const r = rig();
    const mu = addMU(r, 'part', 0);
    r.setActive(true);
    run(r.manager, 1);
    r.axis.position.y = 0.3;
    run(r.manager, 1);
    const before = worldPos(mu.node).clone();
    r.zone.dispose();
    expect(r.manager.zones.has(r.zone)).toBe(false);
    expect(mu.heldBy).toBeNull();
    expect(mu.node.parent).toBe(r.scene);
    expect(worldPos(mu.node).distanceTo(before)).toBeLessThan(1e-9);
  });

  it('passive loads ride along, currentSurface is cleared; a reset restores the pre-placed pallet and its load', () => {
    const { root, pallets, parts } = palletRow(1, 1);
    const { scene, tm } = classifiedScene(root);
    tm.activatePreplaced();
    const pallet = muOf(tm, pallets[0]);
    const part = muOf(tm, parts[0][0]);
    expect(part.loadedOn).toBe(pallet);
    const palletWorld = worldPos(pallet.node).clone();
    const partWorld = worldPos(part.node).clone();

    const axis = new Object3D();
    scene.add(axis);
    const zone = new RVZone(axis);
    zone.Hold = true;
    zone.Size.set(800, 300, 600);
    zone.Center.set(0, PALLET[1] * 1000 / 2, 0);
    tm.zones.add(zone);
    tm.update(DT);
    expect(zone.held).toEqual([pallet]);
    expect(pallet.currentSurface).toBeNull();
    axis.position.y = 0.5;
    tm.update(DT);
    expect(worldPos(pallet.node).y).toBeCloseTo(palletWorld.y + 0.5, 6);
    expect(worldPos(part.node).y).toBeCloseTo(partWorld.y + 0.5, 6);
    expect(part.loadedOn).toBe(pallet);

    tm.reset();
    tm.activatePreplaced();
    axis.position.y = 0;
    expect(zone.held).toHaveLength(0);
    expect(pallet.heldBy).toBeNull();
    expect(worldPos(pallet.node).distanceTo(palletWorld)).toBeLessThan(1e-6);
    expect(worldPos(part.node).distanceTo(partWorld)).toBeLessThan(1e-6);
    expect(part.loadedOn).toBe(pallet);
    expect(pallet.node.parent).toBe(root);
    // The rising edge fires again after the reset — also for the freshly
    // re-activated pre-placed MU (indexed before the zone looks).
    tm.update(DT);
    expect(zone.held).toEqual([pallet]);
  });
});

describe('Zone authority (plan-521 §2.4.5)', () => {
  it('DES (a transport-owning plugin) evaluates nothing; back in Continuous the zone works again', () => {
    const r = rig();
    const mu = addMU(r, 'part', 0);
    r.setActive(true);
    let continuous = false;
    const runner = new ContinuousRunner(r.manager, { tick() {} } as never, undefined, () => continuous);
    runner.tick(DT);
    expect(r.zone.held).toHaveLength(0);
    expect(r.zone.occupied).toBe(false);
    continuous = true;
    runner.tick(DT);
    expect(mu.heldBy).toBe('zone');
    expect(r.zone.occupied).toBe(true);
  });

  it('multiuser follower (isOwner = false): no effects, held MUs let go in place; normal again after the session', () => {
    const r = rig();
    r.zone.Block = true;
    const mu = addMU(r, 'part', 0);
    r.setActive(true);
    run(r.manager, 1);
    expect(mu.heldBy).toBe('zone');
    r.zone.isOwner = false; // what the multiuser plugin does at the first mu_sync
    run(r.manager, 1);
    expect(mu.heldBy).toBeNull();
    expect(r.zone.active).toBe(false);
    expect(r.zone.occupied).toBe(false);
    const dir = new Vector3(1, 0, 0);
    const other = createMU('other', -1, 0, 0);
    expect(r.manager.clampStopperTravel(other, dir, 2)).toBe(2);
    r.zone.isOwner = true; // session left
    run(r.manager, 1);
    expect(mu.heldBy).toBe('zone');
    expect(r.zone.occupied).toBe(true);
  });
});
