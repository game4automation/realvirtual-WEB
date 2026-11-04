// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * physics-zone-layer-filter.test.ts — plan-2016 S7: `WebPhysicsZone.LimitToLayers`.
 *
 * A physics zone can be limited to MUs on given Unity layers. Only those become
 * rigid bodies; every other MU passes the zone kinematically. The blow-moulding line model
 * case: the slugs a deflashing station cuts off (layer `MauserParts`) fall onto
 * a scrap belt, the barrel (layer `rvMU`) in the same volume never turns
 * physical.
 *
 *  - filter set: matching MU hands over, other MU stays kinematic
 *  - empty filter / only unknown names: every MU, as before
 *  - an MU without a layer does not match a set filter
 *  - physics-surface handover honours the filter
 *  - DirectlyGrip takes a part back that was a body for its spawn tick
 *  - real Rapier: the slug falls onto the physics belt and reaches the sink,
 *    the barrel stays where it is
 *
 * Mock provider for the handover rules; the end-to-end case uses real Rapier
 * (private provider, out-of-band package) and skips unless
 * `RV_PHYSICS_REQUIRE_WASM=1`. PRIVATE-DEPENDENT: listed in
 * `tests/private-dependent-tests.json`.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { Box3, BoxGeometry, Mesh, MeshBasicMaterial, Object3D, Quaternion, Scene, Vector3 } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { MUInstancePool, RVMovingUnit, type InstancedMovingUnit } from '../src/core/engine/rv-mu';
import { loadBakedGLB } from './helpers/load-baked-glb';
import { node as extrasNode, sceneToGlb } from './helpers/migrate-769-fixtures';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { RVSink } from '../src/core/engine/rv-sink';
import { RVGrip } from '../src/core/engine/rv-grip';
import { RVPhysicsZone } from '../src/core/engine/rv-physics-zone';
import { RV_LAYER_KEY, registerFileLayerNames, resetLayerNames } from '../src/core/engine/rv-layers';
import { EventEmitter } from '../src/core/rv-events';
import {
  physicsRegistry, physicsSettings,
  type PhysicsAABB, type PhysicsPose, type PhysicsProvider, type PhysicsQuat,
  type PhysicsRayHit, type PhysicsVec3, type PhysicsZoneConfig,
} from '../src/core/engine/rv-physics-registry';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';
import type { RVViewer } from '../src/core/rv-viewer';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';
import { PhysicsZonePlugin } from '@rv-private/plugins/physics-zone-plugin';
import { RapierPhysicsProvider } from '@rv-private/physics/rv-rapier-provider';

const REQUIRE_WASM = typeof __RV_PHYSICS_REQUIRE_WASM__ !== 'undefined' && __RV_PHYSICS_REQUIRE_WASM__;
const DT = 1 / 60;
/** Unity layer indices of the Mauser project (TagManager): 17 = rvMU, 24 = MauserParts. */
const LAYER_BARREL = 17;
const LAYER_SLUG = 24;

// ─── Factories ──────────────────────────────────────────────────────────────

/** A spawned-MU clone carries its Unity layer in the `_rvLayer` stash (rv-source). */
function createMU(name: string, pos: [number, number, number], layer: number | null, half = 0.05): RVMovingUnit {
  const node = new Object3D();
  node.name = name;
  node.position.set(...pos);
  if (layer !== null) node.userData[RV_LAYER_KEY] = layer;
  node.updateMatrixWorld(true);
  const mu = new RVMovingUnit(node, 'test-source', new Vector3(half, half, half));
  mu.updateAABB();
  return mu;
}

function createZone(
  center: [number, number, number], size: [number, number, number], layers: unknown = [],
): RVPhysicsZone {
  const node = new Object3D();
  node.name = 'ButzenZone';
  node.position.set(...center);
  node.updateMatrixWorld(true);
  const zone = new RVPhysicsZone(node, AABB.fromBoxCollider(node, { x: 0, y: 0, z: 0 }, { x: size[0], y: size[1], z: size[2] }));
  zone.LimitToLayers = layers;
  zone.RemoveBelowY = -5;
  zone.ShowGizmo = false;
  zone.init({ gizmoManager: undefined } as unknown as ComponentContext);
  return zone;
}

function createSurface(center: [number, number, number], half: Vector3, dir: Vector3, speed: number): RVTransportSurface {
  const node = new Object3D();
  node.name = 'ScrapBelt';
  node.position.set(...center);
  node.updateMatrixWorld(true);
  const surface = new RVTransportSurface(node, AABB.fromHalfSize(node, half));
  surface.TransportDirection.copy(dir);
  surface.Radial = false;
  surface.TextureScale = 1;
  surface.HeightOffsetOverride = 0;
  surface.reapplyConfig();
  surface.initTransport();
  surface.drive = { currentSpeed: speed, name: 'belt-drive' } as unknown as RVTransportSurface['drive'];
  return surface;
}

function createSink(center: [number, number, number], half: Vector3): RVSink {
  const node = new Object3D();
  node.name = 'Sink';
  node.position.set(...center);
  node.updateMatrixWorld(true);
  return new RVSink(node, AABB.fromBoxCollider(node, { x: 0, y: 0, z: 0 }, { x: half.x * 2, y: half.y * 2, z: half.z * 2 }));
}

function createManager(): RVTransportManager {
  const tm = new RVTransportManager();
  tm.scene = new Scene();
  return tm;
}

// ─── Mock provider (records handovers) ──────────────────────────────────────

class MockProvider implements PhysicsProvider {
  ready = true;
  failed = false;
  added: string[] = [];
  removed: string[] = [];
  onSensorEvent: ((sensorId: string, muId: string, entered: boolean) => void) | null = null;
  async init(): Promise<void> { this.ready = true; }
  dispose(): void { this.ready = false; }
  addZone(_id: string, _aabb: PhysicsAABB, _cfg: PhysicsZoneConfig): void {}
  addStaticBox(): void {}
  addConveyor(): void {}
  setConveyorVelocity(): void {}
  addDynamicMU(muId: string, _pose: PhysicsPose, _half: PhysicsVec3, _vel: PhysicsVec3): void { this.added.push(muId); }
  removeBody(muId: string): void { this.removed.push(muId); }
  addSensorBox(): void {}
  castRay(): PhysicsRayHit | null { return null; }
  step(): void {}
  syncPoses(_out: (muId: string, pos: PhysicsVec3, quat: PhysicsQuat) => void): void {}
  getSettledBodies(): string[] { return []; }
  addKinematicBody(): void {}
  setKinematicPose(): void {}
  forEachContactLoad(): void {}
}

function fakeViewer(tm: RVTransportManager): RVViewer {
  const emitter = new EventEmitter();
  return {
    transportManager: tm,
    registry: { getNode: () => null, storedNode: () => null },
    gizmoManager: undefined,
    simulationKernel: null,
    drives: [],
    getPlugin: () => undefined,
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
  } as unknown as RVViewer;
}

function fakeLoadResult(tm: RVTransportManager): LoadResult {
  return {
    root: new Object3D(),
    boundingBox: new Box3(new Vector3(-10, -1, -10), new Vector3(10, 5, 10)),
    transportManager: tm,
    registry: { getNode: () => null, storedNode: () => null },
    drives: [],
  } as unknown as LoadResult;
}

async function builtPlugin(tm: RVTransportManager): Promise<PhysicsZonePlugin> {
  const plugin = new PhysicsZonePlugin();
  plugin.onModelLoaded(fakeLoadResult(tm), fakeViewer(tm));
  await plugin.buildPromise;
  return plugin;
}

// ─── Setup ──────────────────────────────────────────────────────────────────

let mock: MockProvider;

beforeEach(() => {
  RVPhysicsZone.clearAll();
  resetLayerNames();
  // The Mauser file's own layer table (scenes[0].extras.realvirtual.layerNames).
  const names = Array.from({ length: 32 }, () => '');
  names[LAYER_SLUG] = 'MauserParts';
  registerFileLayerNames({ realvirtual: { layerNames: names } });
  mock = new MockProvider();
  physicsRegistry.register(mock);
  physicsSettings.enabled = true;
  physicsSettings.full = false;
});

afterEach(() => {
  RVPhysicsZone.clearAll();
  resetLayerNames();
  physicsRegistry.register(null);
  physicsSettings.enabled = false;
  vi.restoreAllMocks();
});

// ─── Handover rules (mock provider) ─────────────────────────────────────────

describe('WebPhysicsZone.LimitToLayers — handover', () => {
  it('only the MU on a listed layer becomes a body; the barrel passes the zone kinematically', () => {
    const tm = createManager();
    createZone([0, 1, 0], [2, 2, 2], ['MauserParts']);
    const slug = createMU('Butzen', [0, 1.2, 0], LAYER_SLUG);
    const barrel = createMU('Fass', [0.5, 1.2, 0], LAYER_BARREL);
    tm.mus.push(slug, barrel);

    for (let i = 0; i < 5; i++) tm.update(DT);

    expect(slug.owner).toBe('rapier');
    expect(barrel.owner).toBe('transport');
    expect(mock.added).toEqual([String(slug.id)]);
    expect(barrel.getPosition().y).toBeCloseTo(1.2, 6); // untouched, not falling
  });

  it('an empty filter takes every MU, as before the filter existed', () => {
    const tm = createManager();
    const zone = createZone([0, 1, 0], [2, 2, 2]);
    expect(zone.layerMask).toBeNull();
    const slug = createMU('Butzen', [0, 1.2, 0], LAYER_SLUG);
    const barrel = createMU('Fass', [0.5, 1.2, 0], LAYER_BARREL);
    const plain = createMU('Plain', [-0.5, 1.2, 0], null);
    tm.mus.push(slug, barrel, plain);

    tm.update(DT);

    expect([slug.owner, barrel.owner, plain.owner]).toEqual(['rapier', 'rapier', 'rapier']);
  });

  it('a list without any known layer name is no filter (one warning)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tm = createManager();
    const zone = createZone([0, 1, 0], [2, 2, 2], ['NoSuchLayer', {}]);
    expect(zone.layerMask).toBeNull();
    expect(zone.layerMask).toBeNull();
    const barrel = createMU('Fass', [0, 1.2, 0], LAYER_BARREL);
    tm.mus.push(barrel);
    tm.update(DT);
    expect(barrel.owner).toBe('rapier');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/unknown layer\(s\) "NoSuchLayer" — no MU filter/);
  });

  it('an MU without a layer does not match a set filter', () => {
    const tm = createManager();
    createZone([0, 1, 0], [2, 2, 2], ['MauserParts']);
    const plain = createMU('Plain', [0, 1.2, 0], null);
    tm.mus.push(plain);
    tm.update(DT);
    expect(plain.owner).toBe('transport');
    expect(mock.added).toHaveLength(0);
  });

  it('a rejected MU falls through to a later zone that accepts it (first ACCEPTING zone wins)', () => {
    createZone([0, 1, 0], [2, 2, 2], ['MauserParts']);
    const open = createZone([0, 1, 0], [3, 3, 3]);
    const barrel = createMU('Fass', [0, 1.2, 0], LAYER_BARREL);
    const slug = createMU('Butzen', [0, 1.2, 0], LAYER_SLUG);
    expect(RVPhysicsZone.findZoneOverlapping(barrel.aabb, barrel)).toBe(open);
    expect(RVPhysicsZone.findZoneOverlapping(slug.aabb, slug)).toBe(RVPhysicsZone.zones[0]);
    // Without an MU (surfaces, sinks, sensors) the filter plays no role.
    expect(RVPhysicsZone.findZoneOverlapping(barrel.aabb)).toBe(RVPhysicsZone.zones[0]);
  });

  it('a filter edit takes effect at once (the setter drops the cached mask)', () => {
    const zone = createZone([0, 1, 0], [2, 2, 2], ['MauserParts']);
    const barrel = createMU('Fass', [0, 1.2, 0], LAYER_BARREL);
    expect(zone.acceptsMU(barrel)).toBe(false);
    zone.LimitToLayers = ['MauserParts', 'rvMU'];
    expect(zone.acceptsMU(barrel)).toBe(true);
    zone.LimitToLayers = [];
    expect(zone.acceptsMU(barrel)).toBe(true);
  });

  it('a physics-managed surface hands over only MUs the zone accepts; the barrel rides it kinematically', () => {
    const tm = createManager();
    const belt = createSurface([0, 0, 0], new Vector3(0.4, 0.05, 2), new Vector3(0, 0, -1), 300);
    tm.surfaces.push(belt);
    createZone([0, 0.5, 0], [2, 2, 5], ['MauserParts']);
    tm.physicsManagedSurfaces = new Set([belt]);
    const slug = createMU('Butzen', [0, 0.1, 1], LAYER_SLUG);
    const barrel = createMU('Fass', [0, 0.1, 0.5], LAYER_BARREL);
    tm.mus.push(slug, barrel);
    const z0 = barrel.getPosition().z;

    for (let i = 0; i < 10; i++) tm.update(DT);

    expect(slug.owner).toBe('rapier');
    expect(barrel.owner).toBe('transport');
    expect(barrel.getPosition().z).not.toBeCloseTo(z0, 3); // carried by the kinematic belt
  });
});

// ─── Pooled (instanced) MUs carry the template's layers ─────────────────────

describe('pooled MUs carry the same layers as a clone of the template', () => {
  function poolMU(layer: number, partLayers?: number[]): InstancedMovingUnit {
    const pool = new MUInstancePool(new BoxGeometry(0.1, 0.1, 0.1), new MeshBasicMaterial(), 'Tpl', new Vector3(0.05, 0.05, 0.05));
    pool.layer = layer;
    if (partLayers) {
      pool.detectHalf = new Vector3(0.05, 0.05, 0.05);
      pool.detectCenter = new Vector3();
      pool.detectPartLayers = partLayers;
      pool.detectParts = partLayers.length > 1
        ? partLayers.map((_, i) => ({ half: new Vector3(0.02, 0.05, 0.05), center: new Vector3(i * 0.04 - 0.02, 0, 0) }))
        : undefined;
    }
    return pool.spawn(new Vector3(0, 1.2, 0), new Quaternion(), 'pooled', 'Src');
  }

  it('a pooled MU on MauserParts passes the filter, a pooled MU on another layer does not', () => {
    const tm = createManager();
    const zone = createZone([0, 1, 0], [2, 2, 2], ['MauserParts']);
    const slug = poolMU(LAYER_SLUG);
    const barrel = poolMU(LAYER_BARREL);
    expect(slug.layer).toBe(LAYER_SLUG);
    expect(zone.acceptsMU(slug)).toBe(true);
    expect(zone.acceptsMU(barrel)).toBe(false);
    expect(zone.acceptsMU(poolMU(-1))).toBe(false); // no layer = no match
    tm.mus.push(slug, barrel);
    tm.update(DT);
    expect(slug.owner).toBe('rapier');
    expect(barrel.owner).toBe('transport');
  });

  it('collider layers: one collider → its layer, several → one per part (clone rule)', () => {
    const one = poolMU(LAYER_BARREL, [LAYER_SLUG]);
    expect(one.detectLayer).toBe(LAYER_SLUG);
    expect(one.detectPartLayers).toBeNull();
    const two = poolMU(LAYER_BARREL, [LAYER_SLUG, 0]);
    expect(two.detectParts).toHaveLength(2);
    expect(two.detectPartLayers).toEqual([LAYER_SLUG, 0]);
    expect(two.detectLayer).toBe(LAYER_BARREL);
    expect(poolMU(LAYER_SLUG).detectLayer).toBe(LAYER_SLUG); // mesh box → the root's layer
  });

  it('a Source that pools its template hands the template layer to every instance', async () => {
    const scene = new Scene();
    scene.name = 'Cell';
    const part = new Mesh(new BoxGeometry(0.05, 0.05, 0.05), new MeshBasicMaterial());
    part.name = 'Part';
    part.position.set(-3, 0, 0);
    part.userData.realvirtual = { MU: {}, layer: LAYER_SLUG };
    const src = extrasNode('Src', { Source: { ThisObjectAsMU: 'Part', AutomaticGeneration: false, GenerateMU: true } });
    src.position.set(0, 1, 0);
    const base = new Mesh(new BoxGeometry(1, 0.1, 1), new MeshBasicMaterial());
    base.name = 'Base';
    base.position.set(0, -1, 0);
    scene.add(part, src, base);
    const result = await loadBakedGLB('pooled-layer.glb', new Scene(), { data: (await sceneToGlb(scene)).slice(0), loadKinematicsSidecar: false });
    const tm = result.transportManager;
    tm.update(DT);
    const pooled = tm.mus.find((m) => m.isInstanced) as InstancedMovingUnit | undefined;
    expect(pooled, 'the Source pools its single-mesh template').toBeTruthy();
    expect(pooled!.layer).toBe(LAYER_SLUG);
  });
});

// ─── DirectlyGrip takes a spawn-tick body back ──────────────────────────────

describe('DirectlyGrip in a physics zone (Unity MU.Fix)', () => {
  it('a part that became a body in its spawn tick is taken back and gripped', async () => {
    const tm = createManager();
    createZone([0, 1, 0], [2, 2, 2], ['MauserParts']);
    const plugin = await builtPlugin(tm);
    const slug = createMU('Butzen', [0, 1.2, 0], LAYER_SLUG);
    tm.mus.push(slug);
    tm.update(DT); // spawn tick: no driver, inside the zone → body
    expect(slug.owner).toBe('rapier');

    const gripNode = new Object3D();
    gripNode.name = 'GripButzenTop';
    gripNode.position.set(0, 1.3, 0);
    tm.scene!.add(gripNode);
    gripNode.updateMatrixWorld(true);
    const grip = new RVGrip(gripNode);
    grip.DirectlyGrip = true;
    grip.physicsHost = tm;
    grip.allMUs = () => tm.mus;
    grip.allGripTargets = () => tm.gripTargets;
    grip.loadHost = tm;
    // The DirectlyGrip sensor fires its MU-enter event (Unity PartToGrip.EventEnter += Fix).
    (grip as unknown as { onPartEnter(mu: RVMovingUnit): void }).onPartEnter(slug);

    expect(slug.owner).toBe('transport');
    expect(slug.physicsBodyId).toBeNull();
    expect(mock.removed).toEqual([String(slug.id)]);
    expect(grip.grippedMUs).toEqual([slug]);
    plugin.dispose();
  });

  it('without the Rapier hook the grip refuses a physics-owned part (no silent double owner)', () => {
    const tm = createManager();
    const slug = createMU('Butzen', [0, 1.2, 0], LAYER_SLUG);
    slug.owner = 'rapier';
    slug.physicsBodyId = String(slug.id);
    expect(tm.reclaimFromPhysics(slug)).toBe(false);
    expect(slug.owner).toBe('rapier');
  });
});

// ─── End to end with real Rapier ────────────────────────────────────────────

let rapierAvailable = false;
beforeAll(async () => {
  const probe = new RapierPhysicsProvider();
  try { await probe.init(); rapierAvailable = probe.ready; } catch { rapierAvailable = false; }
  probe.dispose();
}, 30000);

function requireRapier(): boolean {
  if (rapierAvailable) return true;
  if (REQUIRE_WASM) throw new Error('[plan-2016 S7] RV_PHYSICS_REQUIRE_WASM=1 but @dimforge/rapier3d-compat is not usable');
  console.warn('[plan-2016 S7] @dimforge/rapier3d-compat not installed (out-of-band) — skipping');
  return false;
}

describe('slug falls onto the scrap belt and reaches the sink (real Rapier)', () => {
  it('the slug drops, rides the physics belt into the sink; the barrel stays kinematic in place', async () => {
    if (!requireRapier()) return;
    const provider = new RapierPhysicsProvider();
    physicsRegistry.register(provider);
    const tm = createManager();
    // Belt: top at y = 0.05, z ∈ [-2, 2], running −Z at 300 mm/s (Transport_Garbage, ReverseDirection).
    const belt = createSurface([0, 0, 0], new Vector3(0.4, 0.05, 2), new Vector3(0, 0, -1), 300);
    belt.PhysicsMode = true;
    tm.surfaces.push(belt);
    const sink = createSink([0, 0.1, -1.6], new Vector3(0.4, 0.1, 0.3));
    tm.sinks.push(sink);
    createZone([0, 0.75, 0], [1.2, 1.7, 4.6], ['MauserParts']);
    const plugin = await builtPlugin(tm);
    expect(tm.physicsManagedSurfaces?.has(belt)).toBe(true);

    const slug = createMU('Butzen', [0, 1.2, 1.5], LAYER_SLUG, 0.04);
    const barrel = createMU('Fass', [0.2, 1.2, 1.0], LAYER_BARREL, 0.2);
    tm.mus.push(slug, barrel);

    let minY = Infinity;
    let consumed = false;
    for (let i = 0; i < 60 * 20 && !consumed; i++) {
      tm.update(DT);
      plugin.onFixedUpdatePost(DT);
      if (tm.mus.includes(slug)) minY = Math.min(minY, slug.getPosition().y);
      else consumed = true;
    }

    expect(consumed).toBe(true);                  // reached the sink and was removed
    expect(minY).toBeLessThan(0.2);               // it fell from 1.2 m onto the belt
    expect(minY).toBeGreaterThan(0.0);            // ... and stayed on it (no fall-through)
    expect(barrel.owner).toBe('transport');       // the barrel never became physical
    expect(barrel.getPosition().y).toBeCloseTo(1.2, 6);
    expect(barrel.getPosition().z).toBeCloseTo(1.0, 6);
    plugin.dispose();
    provider.dispose();
  }, 30000);
});
