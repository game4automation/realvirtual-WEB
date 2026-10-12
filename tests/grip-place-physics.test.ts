// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * grip-place-physics.test.ts — plan-525 T8: `Grip.PlaceMode = 'Physics'`.
 *
 *  - a place inside a physics zone hands the part to the provider; its start
 *    velocity is the grip's own velocity;
 *  - the zone test runs on THIS tick's pose — entering the zone in the place
 *    tick hands over, leaving it in the place tick does not (the grip runs
 *    before the central MU AABB update);
 *  - the part keeps the rotation it had in the gripper;
 *  - physics off / provider not ready / outside every zone → placed like
 *    'Static' with ONE warning per grip;
 *  - leaving continuous mode (DES) tears the physics world down.
 *
 * Real Rapier (private provider, out-of-band package): skips unless
 * `RV_PHYSICS_REQUIRE_WASM=1`. PRIVATE-DEPENDENT: listed in
 * `tests/private-dependent-tests.json`.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { Box3, Object3D, Quaternion, Scene, Vector3 } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVGrip } from '../src/core/engine/rv-grip';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { RVPhysicsZone } from '../src/core/engine/rv-physics-zone';
import { EventEmitter } from '../src/core/rv-events';
import {
  physicsDiagnostics, physicsRegistry, physicsSettings, type PhysicsProvider,
} from '../src/core/engine/rv-physics-registry';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';
import type { RVViewer } from '../src/core/rv-viewer';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';
import { RapierPhysicsProvider } from '@rv-private/physics/rv-rapier-provider';
import { PhysicsZonePlugin } from '@rv-private/plugins/physics-zone-plugin';

const REQUIRE_WASM = typeof __RV_PHYSICS_REQUIRE_WASM__ !== 'undefined' && __RV_PHYSICS_REQUIRE_WASM__;
const DT = 1 / 60;
const HALF = new Vector3(0.025, 0.025, 0.025);
/** The zone box: x ∈ [1, 2], y ∈ [0, 1], z ∈ [-0.5, 0.5]. */
const ZONE_MIN = new Vector3(1, 0, -0.5);
const ZONE_MAX = new Vector3(2, 1, 0.5);

let rapierAvailable = false;
beforeAll(async () => {
  const probe = new RapierPhysicsProvider();
  try { await probe.init(); rapierAvailable = probe.ready; } catch { rapierAvailable = false; }
  probe.dispose();
}, 30000);

function requireRapier(): boolean {
  if (rapierAvailable) return true;
  if (REQUIRE_WASM) throw new Error('[plan-525 T8] RV_PHYSICS_REQUIRE_WASM=1 but @dimforge/rapier3d-compat is not usable');
  console.warn('[plan-525 T8] @dimforge/rapier3d-compat not installed (out-of-band) — skipping');
  return false;
}

interface BodyProbe { linvel(): { x: number; y: number; z: number }; rotation(): { x: number; y: number; z: number; w: number } }
function bodyOf(provider: RapierPhysicsProvider, id: string): BodyProbe | null {
  const map = (provider as unknown as { bodyMap: Map<string, { body: BodyProbe }> }).bodyMap;
  return map.get(id)?.body ?? null;
}

interface Cell {
  scene: Scene;
  tm: RVTransportManager;
  grip: RVGrip;
  mu: RVMovingUnit;
  provider: RapierPhysicsProvider;
  /** Move the grip to `x` and run one grip tick (pick held). */
  moveTo(x: number, y?: number): void;
  /** Release: the place flank runs in this tick after moving the grip to `x`. */
  placeAt(x: number, y?: number): void;
}

const cells: Cell[] = [];

beforeEach(() => {
  RVPhysicsZone.clearAll();
  physicsSettings.enabled = true;
  physicsSettings.full = false;
});
afterEach(() => {
  for (const c of cells.splice(0)) c.provider.dispose();
  RVPhysicsZone.clearAll();
  physicsRegistry.register(null);
  physicsSettings.enabled = false;
  vi.restoreAllMocks();
});

function zone(): RVPhysicsZone {
  const node = new Object3D();
  node.name = 'Chute';
  node.position.copy(ZONE_MIN).add(ZONE_MAX).multiplyScalar(0.5);
  node.updateMatrixWorld(true);
  const size = ZONE_MAX.clone().sub(ZONE_MIN);
  const z = new RVPhysicsZone(node, AABB.fromBoxCollider(node, { x: 0, y: 0, z: 0 }, size));
  z.ShowGizmo = false;
  z.init({ gizmoManager: undefined } as unknown as ComponentContext);
  return z;
}

/** A grip at (x0, 0.5, 0) holding a 50 mm part, with a real Rapier provider registered. */
async function cell(x0: number, opts: { withZone?: boolean; register?: boolean } = {}): Promise<Cell> {
  const scene = new Scene();
  const tm = new RVTransportManager();
  tm.scene = scene;
  if (opts.withZone !== false) zone();
  const provider = new RapierPhysicsProvider();
  await provider.init();
  provider.addZone('zone', { min: ZONE_MIN, max: ZONE_MAX }, { friction: 0.5, restitution: 0, removeBelowY: -10 });
  if (opts.register !== false) physicsRegistry.register(provider);

  const gripNode = new Object3D();
  gripNode.name = 'EjectGrip';
  gripNode.position.set(x0, 0.5, 0);
  scene.add(gripNode);
  const grip = new RVGrip(gripNode);
  grip.PlaceMode = 'Physics';
  grip.allMUs = () => tm.mus;
  grip.allGripTargets = () => tm.gripTargets;
  grip.loadHost = tm;
  grip.physicsHost = tm;

  const muNode = new Object3D();
  muNode.name = 'Part';
  muNode.position.set(x0, 0.5 - HALF.y - 0.005, 0);
  scene.add(muNode);
  scene.updateMatrixWorld(true);
  const mu = new RVMovingUnit(muNode, 'test', HALF.clone());
  tm.mus.push(mu);
  mu.updateAABB();
  grip.pick();
  expect(grip.grippedMUs).toEqual([mu]);
  grip.pickObjects = true; // hold (OneBitControl: place = !pick)
  grip.fixedUpdate(DT);    // first velocity sample

  const c: Cell = {
    scene, tm, grip, mu, provider,
    moveTo(x, y = 0.5) {
      gripNode.position.set(x, y, 0);
      gripNode.updateMatrixWorld(true);
      grip.fixedUpdate(DT);
    },
    placeAt(x, y = 0.5) {
      gripNode.position.set(x, y, 0);
      gripNode.updateMatrixWorld(true);
      grip.pickObjects = false;
      grip.fixedUpdate(DT);
    },
  };
  cells.push(c);
  return c;
}

describe('plan-525 T8: Grip PlaceMode Physics (real Rapier)', () => {
  it('a place in the zone hands the part over with the grip velocity as start velocity', async () => {
    if (!requireRapier()) return;
    const c = await cell(1.2);
    for (let i = 1; i <= 5; i++) c.moveTo(1.2 + i * 0.01); // 0.6 m/s in +X
    c.placeAt(1.26);
    expect(c.mu.physicsOwned).toBe(true);
    expect(c.grip.grippedMUs).toHaveLength(0);
    const body = bodyOf(c.provider, c.mu.physicsBodyId!)!;
    expect(body).not.toBeNull();
    expect(body.linvel().x).toBeCloseTo(0.6, 3);
    expect(Math.abs(body.linvel().y)).toBeLessThan(1e-6);
    // Released under the scene root at its world pose (StandardParent).
    expect(c.mu.node.parent).toBe(c.scene);
  });

  it('entering the zone in the place tick hands over; leaving it in the place tick does not', async () => {
    if (!requireRapier()) return;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const into = await cell(0.5);           // outside, last tick's AABB outside too
    into.placeAt(1.5);                      // grip moved INTO the zone this tick
    expect(into.mu.physicsOwned).toBe(true);

    RVPhysicsZone.clearAll();
    const out = await cell(1.5);            // inside, last tick's AABB inside
    out.placeAt(3);                         // grip moved OUT of the zone this tick
    expect(out.mu.physicsOwned).toBe(false);
    expect(warn.mock.calls.some((a) => String(a[0]).includes('PlaceMode Physics'))).toBe(true);
  });

  it('the part keeps the rotation it had in the gripper', async () => {
    if (!requireRapier()) return;
    const c = await cell(1.5);
    c.grip.node.rotation.set(0, Math.PI / 2, 0);
    c.placeAt(1.5);
    expect(c.mu.physicsOwned).toBe(true);
    const q = bodyOf(c.provider, c.mu.physicsBodyId!)!.rotation();
    const expected = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    expect(Math.abs(q.y)).toBeCloseTo(Math.abs(expected.y), 6);
    expect(Math.abs(q.w)).toBeCloseTo(Math.abs(expected.w), 6);
  });

  it('physics off / provider not ready / no zone → placed like Static, ONE warning per grip', async () => {
    if (!requireRapier()) return;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const count = () => warn.mock.calls.filter((a) => String(a[0]).includes('PlaceMode Physics')).length;

    physicsSettings.enabled = false;
    const off = await cell(1.5);
    off.placeAt(1.5);
    expect(off.mu.physicsOwned).toBe(false);
    expect(off.mu.node.parent).toBe(off.scene); // released in place like Static
    expect(count()).toBe(1);
    // A second place of the same grip does not warn again.
    off.grip.pick();
    off.grip.pickObjects = true;
    off.grip.fixedUpdate(DT);
    off.placeAt(1.5);
    expect(count()).toBe(1);
    physicsSettings.enabled = true;

    RVPhysicsZone.clearAll();
    const notReady = await cell(1.5, { register: false });
    physicsRegistry.register({ ready: false, failed: false } as unknown as PhysicsProvider);
    notReady.placeAt(1.5);
    expect(notReady.mu.physicsOwned).toBe(false);
    expect(count()).toBe(2);

    RVPhysicsZone.clearAll();
    const noZone = await cell(1.5, { withZone: false });
    noZone.placeAt(1.5);
    expect(noZone.mu.physicsOwned).toBe(false);
    expect(count()).toBe(3);
  });

  it('leaving continuous mode (DES) tears the physics world down', async () => {
    if (!requireRapier()) return;
    zone();
    const provider = new RapierPhysicsProvider();
    physicsRegistry.register(provider);
    const tm = new RVTransportManager();
    tm.scene = new Scene();
    const emitter = new EventEmitter();
    const viewer = {
      transportManager: tm, registry: { getNode: () => null }, gizmoManager: undefined,
      simulationKernel: null, getPlugin: () => undefined, drives: [],
      on: emitter.on.bind(emitter), emit: emitter.emit.bind(emitter),
    } as unknown as RVViewer;
    const plugin = new PhysicsZonePlugin();
    plugin.onModelLoaded({
      root: new Object3D(), transportManager: tm, registry: { getNode: () => null }, drives: [],
      boundingBox: new Box3(new Vector3(-5, -1, -5), new Vector3(5, 3, 5)),
    } as unknown as LoadResult, viewer);
    await plugin.buildPromise;
    expect(physicsDiagnostics.active).toBe(true);
    expect(tm.physicsMUHook).toBe(plugin);
    emitter.emit('simulation-mode-changed' as never, { mode: 'discrete' } as never);
    expect(physicsDiagnostics.active).toBe(false);
    expect(tm.physicsMUHook).toBeNull();
    expect(provider.ready).toBe(false);
    plugin.dispose();
    provider.dispose();
  });
});
