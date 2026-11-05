// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-781 F21 — collision detection is the on-demand feature `collision`.
 *
 * (a) a model with a `CollisionRole` activates it in the load prescan, before any
 *     component is built, and collides as before (bodies, pair, signal);
 * (b) a model without roles never loads it — `collision.status` / `collision.reset`
 *     answer without it, `collision.watch` loads it late and wires the open model;
 * (c) a Source handing a role to its MUs activates it without any CollisionRole, and
 *     an MU spawned while the feature is not active reaches the manager after it is;
 * plus the prescan's field trigger and the registrar slot as units.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D } from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { resetProblemsForTests } from '../src/core/hmi/problems-store';
import { registerComponentSchema } from '../src/core/engine/rv-component-registry';
import { addPatchTypes, collectComponentTypes } from '../src/core/engine/rv-component-types';
import '../src/core/engine/rv-collision-role';
import { CollisionRegistrarSlot, type CollisionSlotTarget } from '../src/core/engine/rv-collision-slot';
import { RVCollisionManager } from '../src/core/engine/rv-collision-manager';
import { collisionReset, collisionStatus, collisionWatch } from '../src/core/hmi/session-overlay-commands';
import { __resetCollisionAlertStore } from '../src/core/hmi/collision-alert-store';
import type { RVViewer } from '../src/core/rv-viewer';
import { bootRealLoaderViewer, type Booted } from './helpers/nested-placement-fixture';

/** A chunk boundary for the body that must move (like a Drive). */
registerComponentSchema('TestOnDemandMover', {}, { bake: 'chunk' });

const DT = 1 / 60;

let booted: Booted | null = null;
afterEach(() => {
  booted?.h.dispose();
  booted = null;
  vi.restoreAllMocks();
  resetProblemsForTests();
  __resetCollisionAlertStore();
});

function box(name: string): Mesh {
  const m = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
  m.name = name;
  return m;
}

function node(name: string, extras: Record<string, unknown> | null, at: [number, number, number] = [0, 0, 0], ...children: Object3D[]): Group {
  const g = new Group();
  g.name = name;
  if (extras) g.userData.realvirtual = extras;
  g.position.set(...at);
  for (const c of children) g.add(c);
  return g;
}

function find(viewer: RVViewer, name: string): Object3D {
  let hit: Object3D | null = null;
  viewer.scene.traverse((n) => { if (!hit && n.name === name) hit = n; });
  if (!hit) throw new Error(`no node ${name}`);
  return hit;
}

async function load(root: Object3D): Promise<RVViewer> {
  booted = await bootRealLoaderViewer();
  const viewer = booted.h.viewer;
  expect(viewer.features.isDeclared('collision')).toBe(true);
  expect(viewer.features.isActive('collision')).toBe(false);
  expect(viewer.collisionManager).toBeNull();
  await viewer.loadModel(`${root.name}.glb`, { data: await objectToGlb(root) });
  await viewer.whenSceneReady();
  return viewer;
}

const ctx = (viewer: RVViewer) => ({ viewer }) as never;
const triggerOf = (viewer: RVViewer) => viewer.features.statuses().find((s) => s.id === 'collision')?.trigger;

describe('collision on demand (plan-781 F21)', () => {
  it('(a) a model with CollisionRole activates the feature before the build and collides', async () => {
    const root = node('Cell', null, [0, 0, 0],
      node('Machine', { CollisionRole: { CollisionRole: 'Machine' } }, [0, 0, 0], box('MachineBox')),
      node('Robot', { CollisionRole: { CollisionRole: 'Robot' }, TestOnDemandMover: {} }, [3, 0, 0], box('RobotBox')),
    );
    const viewer = await load(root);

    expect(viewer.features.isActive('collision')).toBe(true);
    expect(triggerOf(viewer)).toBe('component:CollisionRole');
    const m = viewer.collisionManager!;
    expect(m).toBeInstanceOf(RVCollisionManager);
    const robot = find(viewer, 'Robot');
    expect(m.roleOf(robot)).toBe('Robot');
    expect(m.roleOf(find(viewer, 'Machine'))).toBe('Machine');

    m.update(DT);                       // apart: armed, no pair
    expect(m.bodies.length).toBe(2);
    expect(m.activePairs.length).toBe(0);
    // Pressed into the machine — offset on every axis: equal boxes with flush
    // faces only touch (plan-781 touch rule).
    robot.position.set(0.3, 0.2, 0.1);
    m.update(DT);
    expect(m.activePairs.length).toBe(1);
    expect(viewer.signalStore!.get('CollisionActive')).toBe(true);
  }, 60_000);

  it('(b) a model without roles never loads it; status/reset answer, watch loads it late', async () => {
    const root = node('Plain', null, [0, 0, 0],
      node('Part', { TestOnDemandMover: {} }, [0, 0, 0], box('PartBox')),
      // A Source whose MUs carry no role is no reason to load collision.
      node('Feeder', { Source: { Interval: 1, CollisionRoleForMUs: 'None' }, MU: {} }, [5, 0, 0], box('FeederBox')),
    );
    const viewer = await load(root);

    expect(viewer.features.isActive('collision')).toBe(false);
    expect(viewer.features.statuses().find((s) => s.id === 'collision')?.state).toBe('declared');
    expect(viewer.collisionManager).toBeNull();
    expect(viewer.signalStore!.get('CollisionActive')).toBeUndefined();

    const status = await collisionStatus.run(ctx(viewer), { includeBodies: true }) as Record<string, unknown>;
    expect(status).toEqual({ bodies: 0, bodiesByRole: {}, checkedPairs: 0, sessionWatched: 0, collisions: 0, pairs: [], bodyList: [] });
    const reset = await collisionReset.run(ctx(viewer), { clearWatch: true }) as Record<string, unknown>;
    expect(reset).toEqual({ ok: true, removedWatch: 0, remainingWatch: 0 });
    expect(viewer.features.isActive('collision')).toBe(false);

    const path = viewer.registry!.getPathForNode(find(viewer, 'Part'))!;
    const watch = await collisionWatch.run(ctx(viewer), { assignmentsJson: JSON.stringify([{ path, role: 'Robot' }]) }) as Record<string, unknown>;
    expect(watch).toMatchObject({ registered: [{ path, role: 'Robot' }] });
    expect(viewer.features.isActive('collision')).toBe(true);
    expect(triggerOf(viewer)).toBe('command:collision.watch');
    const m = viewer.collisionManager!;
    expect(m.roleOf(find(viewer, 'Part'))).toBe('Robot');
    // The open model was wired at activation: signals, MU hook through the slot.
    expect(viewer.signalStore!.get('CollisionActive')).toBe(false);
    expect((await collisionStatus.run(ctx(viewer), {}) as Record<string, unknown>).sessionWatched).toBe(1);
  }, 60_000);

  it('(c) a Source handing a role to its MUs activates it without any CollisionRole', async () => {
    const root = node('Line', null, [0, 0, 0],
      node('Belt', { TransportSurface: { Speed: 100 } }, [0, 0, 0], box('BeltBox')),
      node('Feeder', { Source: { Interval: 1, CollisionRoleForMUs: 'Workpiece' }, MU: {} }, [0, 0.6, 0], box('FeederBox')),
    );
    const viewer = await load(root);
    expect(viewer.features.isActive('collision')).toBe(true);
    expect(triggerOf(viewer)).toBe('component:CollisionRole');
    expect(viewer.collisionManager).not.toBeNull();
    // Every spawn reaches the manager through the slot the transport holds.
    const spawned = vi.spyOn(viewer.collisionManager!, 'onMUSpawned');
    const mu = { node: new Object3D() } as never;
    viewer.transportManager!.muLifecycleHook!.onMUSpawned(mu, 'Workpiece');
    expect(spawned).toHaveBeenCalledWith(mu, 'Workpiece');
  }, 60_000);

  it('(c2) an MU spawned with a role before the feature is active reaches the manager after it', async () => {
    const viewer = await load(node('Plain', null, [0, 0, 0], node('Part', { TestOnDemandMover: {} }, [0, 0, 0], box('PartBox'))));
    expect(viewer.features.isActive('collision')).toBe(false);
    const spawned = vi.spyOn(RVCollisionManager.prototype, 'onMUSpawned');
    const mu = { node: new Object3D() } as never;
    // A role edited onto a Source at runtime: the spawn itself asks for the feature.
    viewer.transportManager!.muLifecycleHook!.onMUSpawned(mu, 'Workpiece');
    await viewer.features.ensure('collision', 'component:CollisionRole');
    expect(viewer.collisionManager).not.toBeNull();
    expect(spawned).toHaveBeenCalledWith(mu, 'Workpiece');
  }, 60_000);
});

describe('prescan field trigger (plan-781 F21)', () => {
  const wanted = new Set(['CollisionRole']);

  it('a Source with CollisionRoleForMUs ≠ None yields CollisionRole', () => {
    const root = node('R', null, [0, 0, 0], node('S', { Source: { CollisionRoleForMUs: 'Workpiece' } }));
    expect([...collectComponentTypes(root, null, wanted)]).toEqual(['CollisionRole']);
    expect(collectComponentTypes(root).has('CollisionRole')).toBe(true);
  });

  it('None, a missing field or an unknown value yields nothing', () => {
    for (const fields of [{ CollisionRoleForMUs: 'None' }, {}, { CollisionRoleForMUs: 'Banana' }]) {
      const root = node('R', null, [0, 0, 0], node('S', { Source: fields }));
      expect(collectComponentTypes(root, null, wanted).size).toBe(0);
    }
  });

  it('an overlay / placement override patch counts too', () => {
    expect(addPatchTypes(new Set(), { '#a': { Source: { CollisionRoleForMUs: 'Tool' } } }).has('CollisionRole')).toBe(true);
    const root = node('R', null);
    const overlay = { nodes: { S: { Source: { CollisionRoleForMUs: 'Robot' } } } } as never;
    expect(collectComponentTypes(root, overlay, wanted).has('CollisionRole')).toBe(true);
  });
});

describe('CollisionRegistrarSlot (plan-781 F21)', () => {
  function spyTarget() {
    const calls: string[] = [];
    const target: CollisionSlotTarget = {
      register: (n, r) => { calls.push(`register ${n.name} ${r}`); },
      unregister: (n) => { calls.push(`unregister ${n.name}`); },
      invalidate: () => { calls.push('invalidate'); },
      registerStockBounds: () => { calls.push('stock+'); },
      unregisterStockBounds: () => { calls.push('stock-'); },
      onMUSpawned: (mu, r) => { calls.push(`spawn ${(mu as unknown as { id: string }).id} ${r}`); },
      onMURemoved: (mu) => { calls.push(`remove ${(mu as unknown as { id: string }).id}`); },
    };
    return { target, calls };
  }
  const named = (name: string) => { const o = new Object3D(); o.name = name; return o; };
  const mu = (id: string) => ({ id }) as never;

  it('buffers, asks once for a participating entry, replays on install, then forwards', () => {
    const needed = vi.fn();
    const slot = new CollisionRegistrarSlot(needed);
    const a = named('A');
    const gone = named('Gone');
    slot.register(named('Quiet'), 'None');
    expect(needed).not.toHaveBeenCalled();
    slot.register(a, 'Robot');
    slot.register(gone, 'Tool');
    slot.unregister(gone);
    slot.onMUSpawned(mu('m1'), 'Workpiece');
    slot.onMUSpawned(mu('m2'), 'None');
    const m3 = mu('m3');
    slot.onMUSpawned(m3, 'Tool');
    slot.onMURemoved(m3);
    slot.invalidate();
    expect(needed).toHaveBeenCalledOnce();

    const { target, calls } = spyTarget();
    slot.install(target);
    expect(calls).toEqual(['register Quiet None', 'register A Robot', 'spawn m1 Workpiece']);
    calls.length = 0;
    slot.register(a, 'Machine');
    slot.onMUSpawned(mu('m4'), 'None');
    slot.invalidate();
    expect(calls).toEqual(['register A Machine', 'spawn m4 None', 'invalidate']);
    expect(slot.target).toBe(target);
  });

  it('clear() forgets the buffer and re-arms the request (model change)', () => {
    const needed = vi.fn();
    const slot = new CollisionRegistrarSlot(needed);
    slot.register(named('A'), 'Robot');
    slot.clear();
    slot.register(named('B'), 'Robot');
    expect(needed).toHaveBeenCalledTimes(2);
    const { target, calls } = spyTarget();
    slot.install(target);
    expect(calls).toEqual(['register B Robot']);
  });
});
