// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Dead-end connectivity cache tests (plan-240 §9.3).
 *
 * The hybrid adjacency cache (static surfaces cached, Radial/moving surfaces
 * live) must not change WHEN an MU vanishes, must keep turntables correct
 * while they actually rotate over many ticks, and must invalidate on
 * placement, removal and planner moves. The 17 pre-existing dead-end tests in
 * tests/rv-transport.test.ts are the regression net and stay untouched.
 *
 * Helper factories mirror tests/rv-transport.test.ts (file-local there).
 */
import { describe, it, expect } from 'vitest';
import { Object3D, Vector3, Scene } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';

// ─── Helpers ──────────────────────────────────────────────────────

const dt = 1 / 60;

function createMU(name: string, x: number, y: number, z: number): RVMovingUnit {
  const node = new Object3D();
  node.name = name;
  node.position.set(x, y, z);
  return new RVMovingUnit(node, 'test-source', new Vector3(0.05, 0.05, 0.05));
}

function createSurface(
  x: number, y: number, z: number,
  halfSize: Vector3,
  direction: Vector3,
  speed: number,
): RVTransportSurface {
  const node = new Object3D();
  node.position.set(x, y, z);

  const aabb = AABB.fromHalfSize(node, halfSize);
  const surface = new RVTransportSurface(node, aabb);
  surface.TransportDirection.copy(direction);
  surface.Radial = false;
  surface.TextureScale = 1;
  surface.HeightOffsetOverride = 0;
  surface.initTransport();

  surface.drive = {
    currentSpeed: speed,
    name: 'mock-drive',
  } as any;

  return surface;
}

/** Radial (turntable) surface that REALLY rotates: the mock drive supplies
 *  degrees/second and `reapplyConfig()` seeds the world direction so
 *  `initTransport()` captures the +Y rotation axis (init() does the same in
 *  production; the plain helper skips init()). */
function createRadialSurface(
  x: number, y: number, z: number,
  halfSize: Vector3,
  speedDegPerSec: number,
): RVTransportSurface {
  const node = new Object3D();
  node.position.set(x, y, z);
  const aabb = AABB.fromHalfSize(node, halfSize);
  const surface = new RVTransportSurface(node, aabb);
  surface.TransportDirection.set(0, 1, 0); // rotation axis
  surface.Radial = true;
  surface.reapplyConfig();  // derive local axis + world direction
  surface.initTransport();  // captures rotationAxis from the seeded direction
  surface.drive = { currentSpeed: speedDegPerSec, name: 'mock-drive' } as any;
  return surface;
}

/** Manager with end-of-line vanish armed and every pushed surface auto-tagged
 *  as a planner-placed layout object (vanish is scoped to those — mirrors the
 *  setup of the existing dead-end suite). */
function createVanishManager(): RVTransportManager {
  const manager = new RVTransportManager();
  manager.scene = new Scene();
  manager.vanishMUsAtEndOfLine = true;
  const arr = manager.surfaces;
  const origPush = arr.push;
  arr.push = function (...items: RVTransportSurface[]): number {
    for (const s of items) s.node.userData._layoutObject = true;
    return origPush.apply(this, items);
  };
  return manager;
}

/** Run until the MU list drains or `cap` ticks elapse; returns ticks run. */
function run(manager: RVTransportManager, cap = 400): number {
  let i = 0;
  for (; i < cap; i++) {
    manager.update(dt);
    if (manager.mus.length === 0) break;
  }
  return i;
}

/** Structural view of the manager's private cache state (tests only). */
interface CacheView {
  _adjacencyCache: Map<RVTransportSurface, { isDynamic: boolean }> | null;
  _observedMoving: Set<RVTransportSurface>;
}
function cacheView(manager: RVTransportManager): CacheView {
  return manager as unknown as CacheView;
}

// ─── Tests ────────────────────────────────────────────────────────

describe('dead-end connectivity cache', () => {
  it('MU vanishes at true dead end (static line) — same tick as before', () => {
    // Parity harness: an identical manager whose cache is invalidated BEFORE
    // EVERY tick (notifyTopologyChanged → fresh topology each tick, i.e. the
    // uncached ground truth). The cached manager must vanish its MU on
    // EXACTLY the same tick.
    const build = () => {
      const manager = createVanishManager();
      manager.surfaces.push(createSurface(0, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 0));
      manager.mus.push(createMU('parked', 0.9, 0, 0)); // parked at the +X discharge end
      return manager;
    };
    const cached = build();
    const uncached = build();

    let cachedTick = -1;
    let uncachedTick = -1;
    for (let i = 0; i < 400; i++) {
      if (cachedTick < 0) {
        cached.update(dt);
        if (cached.mus.length === 0) cachedTick = i;
      }
      if (uncachedTick < 0) {
        uncached.notifyTopologyChanged(); // kill the cache every tick
        uncached.update(dt);
        if (uncached.mus.length === 0) uncachedTick = i;
      }
      if (cachedTick >= 0 && uncachedTick >= 0) break;
    }

    expect(cachedTick).toBeGreaterThan(0);       // it DID vanish (dwell + dissolve)
    expect(cachedTick).toBe(uncachedTick);       // ... on the same tick as the uncached truth
    expect(cached.totalConsumed).toBe(1);
    // The cache was actually built and reused (not silently bypassed).
    expect(cacheView(cached)._adjacencyCache).not.toBeNull();
  });

  it('MU on turntable does NOT vanish while rotating toward an exit over 60+ ticks', () => {
    const manager = createVanishManager();
    // Turntable REALLY rotating at 90°/s; an arm conveyor overlaps its rim.
    const turntable = createRadialSurface(0, 0, 0, new Vector3(0.6, 0.1, 0.6), 90);
    const arm = createSurface(1.0, 0, 0, new Vector3(0.5, 0.1, 0.3), new Vector3(1, 0, 0), 0);
    manager.surfaces.push(turntable, arm);

    const mu = createMU('rotating', 0.4, 0, 0); // off-centre → orbits the platform
    manager.mus.push(mu);

    // 100 ticks (> 60): rotation progresses for real, the MU's AABB wanders
    // across grid cells — and the MU must survive every single tick because
    // the Radial surface is live-checked (an exit exists: the arm).
    for (let i = 0; i < 100; i++) {
      manager.update(dt);
      expect(manager.mus.length).toBe(1);
    }
    expect(mu.currentSurface).toBe(turntable);
    // The MU actually orbited (rotation was real, not a frozen pose).
    expect(Math.abs(mu.node.position.z)).toBeGreaterThan(0.05);
    // The cache classified the Radial surface dynamic — it is never cached.
    const cache = cacheView(manager)._adjacencyCache;
    expect(cache).not.toBeNull();
    expect(cache!.get(turntable)?.isDynamic).toBe(true);

    // Counter-check that the radial probe stays LIVE: drop the arm and the
    // (still rotating) lone turntable becomes a true dead end → MU vanishes.
    manager.surfaces = manager.surfaces.filter((s) => s !== arm);
    manager.notifyTopologyChanged();
    run(manager);
    expect(manager.mus.length).toBe(0);
  });

  it('placement of a new downstream surface invalidates cache (MU no longer vanishes)', () => {
    const manager = createVanishManager();
    const A = createSurface(0, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 0); // stopped
    manager.surfaces.push(A);

    const mu = createMU('waiting', 0.9, 0, 0); // parked at the +X discharge end
    manager.mus.push(mu);

    // Dwell accrues at the dead end, but stays below the 2 s vanish delay.
    for (let i = 0; i < 60; i++) manager.update(dt);
    expect(manager.mus.length).toBe(1);
    expect(mu.offSurfaceTime ?? 0).toBeGreaterThan(0); // dead-end timer was running

    // Planner placement: successor belt appears at the seam (push + the
    // production hook scene-mutations calls after processExtras).
    const B = createSurface(1.7, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 0); // spans X[0.7,2.7]
    manager.surfaces.push(B);
    manager.notifyTopologyChanged();

    run(manager);
    expect(manager.mus.length).toBe(1);       // successor found → never vanishes
    expect(mu.offSurfaceTime ?? 0).toBe(0);   // dwell timer reset and held at 0
  });

  it('removal of downstream surface invalidates cache (MU vanishes again)', () => {
    const manager = createVanishManager();
    const A = createSurface(0, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 0);
    const B = createSurface(1.7, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 0);
    manager.surfaces.push(A, B);

    const mu = createMU('handoff', 0.9, 0, 0); // at the A∩B seam, successor ahead
    manager.mus.push(mu);

    for (let i = 0; i < 200; i++) manager.update(dt);
    expect(manager.mus.length).toBe(1); // successor ahead → survives (cache in steady use)

    // Planner removal: scene-mutations style — filter REASSIGNMENT + hook.
    manager.surfaces = manager.surfaces.filter((s) => s !== B);
    manager.notifyTopologyChanged();

    run(manager);
    expect(manager.mus.length).toBe(0); // successor gone → dead end → vanished
    expect(manager.totalConsumed).toBe(1);
  });

  it('planner move without add/remove invalidates adjacency cache (layout-transform-update case)', () => {
    // A layout move mutates NO manager array — in production the planner
    // emits 'layout-transform-update'. The manager has no event-bus access,
    // so it self-heals instead: the per-tick AABB-signature guard detects the
    // moved (static-cached) surface and invalidates the cache. Same observable
    // behaviour, no wiring required.
    const manager = createVanishManager();
    const A = createSurface(0, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 0);
    const B = createSurface(1.7, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 0);
    manager.surfaces.push(A, B);

    const mu = createMU('abandoned', 0.9, 0, 0);
    manager.mus.push(mu);

    for (let i = 0; i < 100; i++) manager.update(dt);
    expect(manager.mus.length).toBe(1);                      // B ahead → safe
    expect(cacheView(manager)._adjacencyCache).not.toBeNull(); // cache in use

    // Planner drag: move B far away — transform change only, NO array
    // mutation, NO explicit notifyTopologyChanged.
    B.node.position.x += 10;
    B.node.updateMatrixWorld(true);

    run(manager);
    expect(manager.mus.length).toBe(0);                       // stale cache would have kept it alive
    expect(manager.totalConsumed).toBe(1);
    // The moved surface was learned as dynamic (no cache thrash from now on).
    expect(cacheView(manager)._observedMoving.has(B)).toBe(true);
  });
});
