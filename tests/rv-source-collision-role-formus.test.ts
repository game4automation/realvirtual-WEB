// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-419 §9.3 — `Source.CollisionRoleForMUs` end to end, and the `None`
 * contract (F5).
 *
 * The Unity side gains an additive `CollisionRoleForMUs` enum field on
 * `Source.cs` (Phase 1). Nothing in the viewer changes for it — the field and
 * its schema already exist (plan-394/-409) — so what this suite pins down is
 * that the value the exporter now writes actually travels the whole way:
 *
 *     rv_extras → applySchema → RVSource.CollisionRoleForMUs
 *               → RVTransportManager.update() → IMULifecycleHook.onMUSpawned
 *               → collision body role
 *
 * And the contract for the DEFAULT: `None` is exported as a string, is
 * accepted, and produces exactly the same behaviour as a legacy scene where the
 * field was never serialized at all — no body, no pair.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, Object3D, Scene } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { processExtras } from '../src/core/engine/rv-scene-loader';
import { RVSource } from '../src/core/engine/rv-source';
import { RVCollisionManager } from '../src/core/engine/rv-collision-manager';
import { __resetCollisionAlertStore } from '../src/core/hmi/collision-alert-store';
import { FakeHighlightHost } from './collision-fixture';

const DT = 1;

/** Records what the transport manager reports to the collision layer. */
class SpyLifecycleHook {
  readonly spawned: { name: string; role: string | undefined }[] = [];
  onMUSpawned(mu: { getName(): string }, role: string | undefined): void {
    this.spawned.push({ name: mu.getName(), role });
  }
  onMURemoved(): void { /* not needed here */ }
}

function meshBox(name: string, size: [number, number, number]): Mesh {
  const m = new Mesh(new BoxGeometry(...size), new MeshBasicMaterial());
  m.name = name;
  return m;
}

/**
 * A belt with a self-template source standing on it — the minimum that makes
 * `RVTransportManager.update()` actually spawn (the source classifies its
 * placement against the live surface set, and refuses to spawn in mid-air).
 *
 * `sourceExtras` is spread into the `Source` entry, so a test can leave
 * `CollisionRoleForMUs` out entirely (the legacy-scene case).
 */
function beltWithSource(sourceExtras: Record<string, unknown>): {
  manager: RVTransportManager; source: RVSource; scene: Scene; root: Object3D;
} {
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'Line';

  const belt = meshBox('Belt', [4, 0.1, 1]);
  belt.userData.realvirtual = { TransportSurface: { Speed: 100 } };
  root.add(belt);

  const part = meshBox('Turbine', [0.2, 0.2, 0.2]);
  part.position.set(0, 0.05, 0);          // sitting on the belt top
  part.userData.realvirtual = { Source: { Interval: 1, ...sourceExtras }, MU: {} };
  root.add(part);

  scene.add(root);
  scene.updateMatrixWorld(true);

  const manager = new RVTransportManager();
  manager.scene = scene;
  processExtras(root, new NodeRegistry(), new SignalStore(), manager, scene);

  const source = manager.sources[0];
  expect(source, 'processExtras should have built the Source').toBeTruthy();
  return { manager, source, scene, root };
}

beforeEach(() => __resetCollisionAlertStore());

describe('Source.CollisionRoleForMUs reaches spawned MUs', () => {
  it('reads the authored role off the rv_extras', () => {
    const { source } = beltWithSource({ CollisionRoleForMUs: 'Workpiece' });
    expect(source.CollisionRoleForMUs).toBe('Workpiece');
  });

  it('hands exactly that role to the MU lifecycle hook on spawn', () => {
    const { manager } = beltWithSource({ CollisionRoleForMUs: 'Workpiece' });
    const hook = new SpyLifecycleHook();
    manager.muLifecycleHook = hook;

    manager.update(DT);

    expect(hook.spawned.length).toBeGreaterThan(0);
    expect(hook.spawned.every((s) => s.role === 'Workpiece')).toBe(true);
  });

  it('gives the spawned MU a Workpiece body that pairs with a Machine', () => {
    const { manager, scene } = beltWithSource({ CollisionRoleForMUs: 'Workpiece' });
    const collision = new RVCollisionManager();
    collision.setHighlightHost(new FakeHighlightHost());
    manager.muLifecycleHook = collision;

    // A machine body straddling the spawn point.
    const machine = new Object3D();
    machine.name = 'CNC';
    machine.add(meshBox('Housing', [2, 2, 2]));
    scene.add(machine);
    scene.updateMatrixWorld(true);
    collision.register(machine, 'Machine');

    manager.update(DT);
    collision.rebuild();

    const muBodies = collision.bodies.filter((b) => b.kind === 'mu');
    expect(muBodies.length).toBeGreaterThan(0);
    expect(muBodies.every((b) => b.role === 'Workpiece')).toBe(true);
    expect(collision.pairs.length).toBeGreaterThan(0);
  });
});

describe('the None contract (F5)', () => {
  // The exporter serializes EVERY public enum field, so `None` really does
  // arrive in the GLB. It must be indistinguishable from a scene predating the
  // field — otherwise every existing model would change behaviour on re-export.
  const CASES: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['explicit None', { CollisionRoleForMUs: 'None' }],
    ['field absent (legacy scene)', {}],
  ];

  it.each(CASES)('%s → the field reads None', (_name, extras) => {
    const { source } = beltWithSource({ ...extras });
    expect(source.CollisionRoleForMUs).toBe('None');
  });

  it.each(CASES)('%s → the hook is told None', (_name, extras) => {
    const { manager } = beltWithSource({ ...extras });
    const hook = new SpyLifecycleHook();
    manager.muLifecycleHook = hook;

    manager.update(DT);

    expect(hook.spawned.length).toBeGreaterThan(0);
    expect(hook.spawned.every((s) => s.role === 'None')).toBe(true);
  });

  it.each(CASES)('%s → no MU body and no effective collision pair', (_name, extras) => {
    const { manager, scene } = beltWithSource({ ...extras });
    const collision = new RVCollisionManager();
    collision.setHighlightHost(new FakeHighlightHost());
    manager.muLifecycleHook = collision;

    const machine = new Object3D();
    machine.name = 'CNC';
    machine.add(meshBox('Housing', [2, 2, 2]));
    scene.add(machine);
    scene.updateMatrixWorld(true);
    collision.register(machine, 'Machine');

    manager.update(DT);
    collision.rebuild();

    expect(collision.bodies.filter((b) => b.kind === 'mu')).toHaveLength(0);
    expect(collision.pairs).toHaveLength(0);
  });

  it('explicit None and a missing field produce the identical spawn report', () => {
    const roles = CASES.map(([, extras]) => {
      const { manager } = beltWithSource({ ...extras });
      const hook = new SpyLifecycleHook();
      manager.muLifecycleHook = hook;
      manager.update(DT);
      return hook.spawned.map((s) => s.role);
    });
    expect(roles[0]).toEqual(roles[1]);
  });
});
