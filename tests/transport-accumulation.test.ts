// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * transport-accumulation.test.ts — MU accumulation on conveyors (plan-255).
 *
 * The gap clamp in RVTransportSurface.transportMU() limits each moving MU's
 * advance to the free distance up to the next MU in its SIGNED move direction
 * (queried via RVTransportManager.queryLeadingMU / IAccumulationQuery).
 * Covers the 15 scenarios from plan-255 §9: core clamp, jam release, chains,
 * reversal, tunneling, seams, lanes, rotation, corners, pre-existing overlap,
 * radial exclusion, standalone compatibility, opt-out, instanced parity, perf.
 *
 * Same deterministic style as rv-transport.test.ts: synchronous fixed-dt loops
 * over manager.update(dt) — no wall clock, no rendering.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Object3D, Vector3, Scene, BoxGeometry, MeshBasicMaterial, Quaternion } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVMovingUnit, InstancedMovingUnit, MUInstancePool } from '../src/core/engine/rv-mu';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';

// ─── Helpers (setup pattern from rv-transport.test.ts) ────────────

const DT = 1 / 60;
/** MU half-extents used throughout (0.1 m cube parts). */
const MU_HALF = new Vector3(0.05, 0.05, 0.05);

function createMU(name: string, x: number, y: number, z: number): RVMovingUnit {
  const node = new Object3D();
  node.name = name;
  node.position.set(x, y, z);
  return new RVMovingUnit(node, 'test-source', MU_HALF.clone());
}

interface MockDrive { currentSpeed: number; name: string }

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
  // Derive localDirection + world direction from TransportDirection (init()
  // does this in production; standalone construction needs it explicitly —
  // required for non-(1,0,0) directions like the 90° corner belt).
  surface.reapplyConfig();
  surface.initTransport();

  // Mock drive with configurable speed (currentSpeed is what TransportSurface reads)
  surface.drive = { currentSpeed: speed, name: 'mock-drive' } as unknown as RVTransportSurface['drive'];

  return surface;
}

function setSpeed(surface: RVTransportSurface, speed: number): void {
  (surface.drive as unknown as MockDrive).currentSpeed = speed;
}

function createManager(): RVTransportManager {
  const manager = new RVTransportManager();
  manager.scene = new Scene();
  return manager;
}

/** Tick `manager` for `ticks` fixed steps, invoking `each` after every step. */
function run(manager: RVTransportManager, ticks: number, each?: (tick: number) => void): void {
  for (let i = 0; i < ticks; i++) {
    manager.update(DT);
    each?.(i);
  }
}

/** Signed X-gap between two MUs' AABBs (positive = clear space between them). */
function gapX(behind: RVMovingUnit | InstancedMovingUnit, ahead: RVMovingUnit | InstancedMovingUnit): number {
  return ahead.aabb.min.x - behind.aabb.max.x;
}

// The static field is process-global — restore it after any test that flips it.
afterEach(() => {
  RVTransportSurface.accumulateDefault = true;
});

// ─── Core ─────────────────────────────────────────────────────────

describe('MU accumulation — core clamp', () => {
  it('follower stops at MinGap behind stopped leader', () => {
    const manager = createManager();
    // A runs +X and carries the follower; B (downstream, seam overlap at x=1) is
    // stopped and holds the leader in place.
    const A = createSurface(0, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 500);
    const B = createSurface(2, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 0);
    A.MinGap = 20; // mm
    manager.surfaces.push(A, B);

    const leader = createMU('leader', 1.08, 0, 0);   // parked on stopped B
    const follower = createMU('follower', 0, 0, 0);  // on running A
    manager.mus.push(leader, follower);

    run(manager, 300); // 5 s — far more than needed to close the gap

    // Leader never moved; follower holds MinGap behind it (+ contact epsilon,
    // + at most one tick of travel as staleness tolerance).
    expect(leader.getPosition().x).toBeCloseTo(1.08, 5);
    const gap = gapX(follower, leader);
    expect(gap).toBeGreaterThanOrEqual(0.02 - 1e-6);
    expect(gap).toBeLessThanOrEqual(0.02 + (500 / 1000) * DT + 1e-3);
    expect(follower.aabb.overlaps(leader.aabb)).toBe(false);
    expect(follower.blocked).toBe(true);
    expect(leader.blocked).toBe(false);
  });

  it('jam releases when leader moves again', () => {
    const manager = createManager();
    const A = createSurface(0, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 500);
    const B = createSurface(2, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 0);
    manager.surfaces.push(A, B);

    const leader = createMU('leader', 1.08, 0, 0);
    const follower = createMU('follower', 0, 0, 0);
    manager.mus.push(leader, follower);

    // Build the jam.
    run(manager, 300);
    expect(follower.blocked).toBe(true);
    const jammedX = follower.getPosition().x;

    // Release: downstream belt starts — leader drives off, follower follows.
    setSpeed(B, 500);
    let overlapped = false;
    run(manager, 120, () => {
      if (follower.aabb.overlaps(leader.aabb)) overlapped = true;
    });
    expect(overlapped).toBe(false);
    expect(leader.getPosition().x).toBeGreaterThan(1.5);
    expect(follower.getPosition().x).toBeGreaterThan(jammedX + 0.3);
  });

  it('chain of 5 MUs accumulates without penetration (grid path)', () => {
    const manager = createManager();
    manager.bruteForceThreshold = 0; // force the SpatialGridXZ path
    const A = createSurface(0, 0, 0, new Vector3(3, 0.1, 0.5), new Vector3(1, 0, 0), 1000);
    const B = createSurface(4, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 0);
    manager.surfaces.push(A, B);

    const leader = createMU('leader', 3.3, 0, 0); // parked on stopped B
    const chain = [
      createMU('c1', -0.5, 0, 0),
      createMU('c2', -1.0, 0, 0),
      createMU('c3', -1.5, 0, 0),
      createMU('c4', -2.0, 0, 0),
      createMU('c5', -2.5, 0, 0),
    ];
    manager.mus.push(leader, ...chain);

    run(manager, 600); // 10 s — everything queues up behind the leader

    // Order preserved: c1 in front … c5 in back; pairwise no penetration.
    const queue = [leader, ...chain];
    for (let i = 1; i < queue.length; i++) {
      expect(queue[i].getPosition().x).toBeLessThan(queue[i - 1].getPosition().x);
      expect(gapX(queue[i], queue[i - 1])).toBeGreaterThanOrEqual(-1e-6);
      expect(queue[i].aabb.overlaps(queue[i - 1].aabb)).toBe(false);
    }
    // The tail actually accumulated (moved up from -2.5 into the queue).
    expect(chain[4].getPosition().x).toBeGreaterThan(1.5);
  });

  it('reversal: negative speed clamps against MU behind (signed direction)', () => {
    const manager = createManager();
    // A runs BACKWARD (-X, negative speed); the blocker sits on a stopped belt
    // to A's LEFT — the clamp must look in the actual move direction (F5a).
    const A = createSurface(0, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), -500);
    const B = createSurface(-2, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 0);
    manager.surfaces.push(A, B);

    const leader = createMU('leader', -1.08, 0, 0);  // parked on stopped B
    const follower = createMU('follower', 0, 0, 0);  // reversing on A
    manager.mus.push(leader, follower);

    run(manager, 300);

    expect(leader.getPosition().x).toBeCloseTo(-1.08, 5);
    // Follower moved left and stopped just short of the leader (no penetration).
    expect(follower.getPosition().x).toBeLessThan(-0.8);
    expect(follower.aabb.min.x).toBeGreaterThanOrEqual(leader.aabb.max.x - 1e-6);
    expect(follower.aabb.overlaps(leader.aabb)).toBe(false);
    expect(follower.blocked).toBe(true);
  });
});

// ─── Edge cases ───────────────────────────────────────────────────

describe('MU accumulation — edge cases', () => {
  it('no tunneling at high speed (whole MU lengths per substep)', () => {
    const manager = createManager();
    // 60 000 mm/s at 60 Hz = 1 m per substep — 10× the MU length. The query
    // window is expanded by the per-substep travel, so the leader is found
    // before the jump would cross it (maxSubSteps burst equivalent).
    const A = createSurface(0, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 60000);
    const B = createSurface(2, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 0);
    manager.surfaces.push(A, B);

    const leader = createMU('leader', 1.08, 0, 0);
    const follower = createMU('follower', -0.5, 0, 0);
    manager.mus.push(leader, follower);

    let overlapped = false;
    let jumpedPast = false;
    run(manager, 60, () => {
      if (follower.aabb.overlaps(leader.aabb)) overlapped = true;
      if (follower.getPosition().x > leader.getPosition().x) jumpedPast = true;
    });

    expect(overlapped).toBe(false);   // never penetrated …
    expect(jumpedPast).toBe(false);   // … and never tunneled THROUGH
    expect(gapX(follower, leader)).toBeGreaterThanOrEqual(-1e-6);
    expect(follower.blocked).toBe(true);
  });

  it('blocking MU on downstream surface is respected (seam case)', () => {
    const manager = createManager();
    const A = createSurface(0, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 500);
    const B = createSurface(2, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 0);
    manager.surfaces.push(A, B);

    const leader = createMU('leader', 1.08, 0, 0);   // already on the NEXT surface
    const follower = createMU('follower', 0, 0, 0);  // still on A
    manager.mus.push(leader, follower);

    run(manager, 300);

    // Cross-surface: the global grid query found the leader although it lives
    // on B — the follower stops at contact instead of shoving into it.
    expect(follower.currentSurface).toBe(A);
    expect(leader.currentSurface).toBe(B);
    expect(follower.aabb.overlaps(leader.aabb)).toBe(false);
    expect(gapX(follower, leader)).toBeGreaterThanOrEqual(-1e-6);
    expect(gapX(follower, leader)).toBeLessThanOrEqual(0.01);
    expect(follower.blocked).toBe(true);
  });

  it('parallel lanes do not block each other', () => {
    const manager = createManager();
    // One wide belt, two MUs in separate lanes with a slight X stagger — the
    // lateral test must let both run at full speed.
    const A = createSurface(0, 0, 0, new Vector3(1, 0.1, 1), new Vector3(1, 0, 0), 1000);
    manager.surfaces.push(A);

    const lane1 = createMU('lane1', -0.6, 0, -0.3);
    const lane2 = createMU('lane2', -0.4, 0, 0.3);
    manager.mus.push(lane1, lane2);

    run(manager, 30); // 0.5 s at 1 m/s → +0.5 m each

    expect(lane1.getPosition().x).toBeCloseTo(-0.1, 2);
    expect(lane2.getPosition().x).toBeCloseTo(0.1, 2);
    expect(lane1.blocked).toBe(false);
    expect(lane2.blocked).toBe(false);
  });

  it('rotated conveyor (45deg world yaw) accumulates via direction projection', () => {
    const manager = createManager();
    // Belt rotated 45° about Y: local +X transport → world (√½, 0, -√½). The
    // static blocker sits on the diagonal just OUTSIDE the belt footprint.
    const A = createSurface(0, 0, 0, new Vector3(0.8, 0.1, 0.8), new Vector3(1, 0, 0), 500);
    A.node.rotation.y = Math.PI / 4;
    A.node.updateMatrixWorld(true);
    A.reapplyConfig(); // re-derive the world direction from the rotated node
    manager.surfaces.push(A);

    const leader = createMU('leader', 0.9, 0, -0.9);        // off-belt, static
    const follower = createMU('follower', -0.4, 0, 0.4);    // on the diagonal path
    manager.mus.push(leader, follower);

    let overlapped = false;
    run(manager, 300, () => {
      if (follower.aabb.overlaps(leader.aabb)) overlapped = true;
    });

    expect(overlapped).toBe(false);
    // Follower advanced along the diagonal (both axes) and then jammed.
    expect(follower.getPosition().x).toBeGreaterThan(0.5);
    expect(follower.getPosition().z).toBeLessThan(-0.5);
    expect(follower.blocked).toBe(true);
    // 1D check along the diagonal: centre distance ≥ sum of projected halves.
    const dx = leader.aabb.center.x - follower.aabb.center.x;
    const dz = leader.aabb.center.z - follower.aabb.center.z;
    const s = Math.SQRT1_2;
    const proj = dx * s + dz * -s;
    expect(proj).toBeGreaterThanOrEqual(4 * (s * 0.05) - 1e-6); // 2 × halfAlong(0.0707)
  });

  it('90-degree corner transfer neither deadlocks nor tunnels', () => {
    const manager = createManager();
    // A runs +X into a perpendicular belt B (running +Z after release).
    const A = createSurface(0, 0, 0, new Vector3(1, 0.1, 0.4), new Vector3(1, 0, 0), 500);
    const B = createSurface(1.4, 0, 1.0, new Vector3(0.5, 0.1, 1.5), new Vector3(0, 0, 1), 0);
    manager.surfaces.push(A, B);

    const first = createMU('first', 0.5, 0, 0);
    const second = createMU('second', -0.5, 0, 0);
    manager.mus.push(first, second);

    let overlapped = false;
    const watch = () => {
      if (first.aabb.overlaps(second.aabb)) overlapped = true;
    };

    // Phase 1: B stopped — first parks at the corner, second jams behind it.
    run(manager, 300, watch);
    expect(overlapped).toBe(false);
    expect(second.blocked).toBe(true);
    expect(second.getPosition().x).toBeLessThan(first.getPosition().x);

    // Phase 2: corner belt starts — first turns onto +Z, second follows around.
    setSpeed(B, 500);
    run(manager, 300, watch);
    expect(overlapped).toBe(false);                       // never tunneled
    expect(first.getPosition().z).toBeGreaterThan(0.5);   // went around the corner
    expect(second.getPosition().z).toBeGreaterThan(0.2);  // no deadlock — followed
  });

  it('pre-existing overlap resolves by driving apart (no permanent freeze)', () => {
    const manager = createManager();
    // Overlapping pair on A; downstream B is FASTER, so the leader pulls away.
    const A = createSurface(0, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 500);
    const B = createSurface(2, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 2000);
    manager.surfaces.push(A, B);

    const leader = createMU('leader', 0.06, 0, 0);   // overlaps the follower by 40 mm
    const follower = createMU('follower', 0, 0, 0);
    manager.mus.push(leader, follower);
    expect(follower.aabb.overlaps(leader.aabb)).toBe(true); // sanity: legacy overlap

    // Neither MU freezes: pre-overlapping candidates are IGNORED (F5b), so both
    // advance at belt speed from the very first tick.
    run(manager, 60);
    expect(follower.getPosition().x).toBeCloseTo(0.5, 1);
    expect(leader.getPosition().x).toBeCloseTo(0.56, 1);

    // Leader reaches the faster belt, separates, and normal accumulation
    // resumes: at the end of the line they queue up WITHOUT overlap.
    run(manager, 300);
    expect(follower.aabb.overlaps(leader.aabb)).toBe(false);
    expect(follower.getPosition().x).toBeGreaterThan(2.5);
    expect(gapX(follower, leader)).toBeGreaterThanOrEqual(-1e-6);
  });

  it('instanced MUs accumulate identically to clone MUs', () => {
    // Same seam scenario with both IMUAccessor backends — final positions must
    // match (the clamp reads candidate AABBs, never the shared pool temp).
    const scenario = (makeMU: (name: string, x: number) => RVMovingUnit | InstancedMovingUnit) => {
      const manager = createManager();
      const A = createSurface(0, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 500);
      const B = createSurface(2, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 0);
      manager.surfaces.push(A, B);
      const leader = makeMU('leader', 1.08);
      const follower = makeMU('follower', 0);
      manager.mus.push(leader, follower);
      run(manager, 300);
      expect(follower.aabb.overlaps(leader.aabb)).toBe(false);
      expect(follower.blocked).toBe(true);
      return { leaderX: leader.aabb.center.x, followerX: follower.aabb.center.x };
    };

    const cloneResult = scenario((name, x) => createMU(name, x, 0, 0));

    const pool = new MUInstancePool(
      new BoxGeometry(0.1, 0.1, 0.1), new MeshBasicMaterial(), 'box', MU_HALF.clone(),
    );
    const quat = new Quaternion();
    const spawnAt = new Vector3();
    const instancedResult = scenario((name, x) => pool.spawn(spawnAt.set(x, 0, 0), quat, name, 'test-source'));

    expect(instancedResult.followerX).toBeCloseTo(cloneResult.followerX, 4);
    expect(instancedResult.leaderX).toBeCloseTo(cloneResult.leaderX, 4);
  });
});

// ─── API contracts ────────────────────────────────────────────────

describe('MU accumulation — API contracts', () => {
  it('radial surface skips clamp (v1 exclusion)', () => {
    const manager = createManager();
    // Turntable: Radial surface rotating about +Y at 90°/s. Two MUs on opposite
    // sides — with a (bogus) linear clamp one would freeze; radial transport
    // must rotate BOTH exactly, blocked stays false.
    const node = new Object3D();
    const aabb = AABB.fromHalfSize(node, new Vector3(0.6, 0.1, 0.6));
    const turntable = new RVTransportSurface(node, aabb);
    turntable.TransportDirection.set(0, 1, 0);
    turntable.Radial = true;
    turntable.reapplyConfig();  // derive world direction (rotation axis) = +Y
    turntable.initTransport();  // captures rotationAxis from the derived direction
    turntable.drive = { currentSpeed: 90, name: 'mock-drive' } as unknown as RVTransportSurface['drive'];
    manager.surfaces.push(turntable);

    const muA = createMU('a', 0.3, 0, 0);
    const muB = createMU('b', -0.3, 0, 0);
    manager.mus.push(muA, muB);

    run(manager, 60); // 1 s → 90° about +Y: (0.3,0,0) → (0,0,-0.3)

    expect(muA.getPosition().x).toBeCloseTo(0, 2);
    expect(muA.getPosition().z).toBeCloseTo(-0.3, 2);
    expect(muB.getPosition().x).toBeCloseTo(0, 2);
    expect(muB.getPosition().z).toBeCloseTo(0.3, 2);
    expect(muA.blocked).toBe(false);
    expect(muB.blocked).toBe(false);
  });

  it('standalone transportMU without manager behaves exactly as before', () => {
    // No manager, no provider — the legacy call pattern of ~20 existing test
    // call sites. Even with a "leader" dead ahead the MU moves the full
    // distance (no clamp, no crash).
    const surface = createSurface(0, 0, 0, new Vector3(2, 0.1, 0.5), new Vector3(1, 0, 0), 1000);
    expect(surface.accumulationProvider).toBeNull();

    const follower = createMU('follower', 0, 0, 0);
    createMU('leader', 0.12, 0, 0); // 20 mm ahead of contact — would clamp with a provider

    const before = follower.getPosition().x;
    for (let i = 0; i < 60; i++) surface.transportMU(follower, DT);

    expect(follower.getPosition().x - before).toBeCloseTo(1.0, 3); // full 1 m/s × 1 s
    expect(follower.blocked).toBe(false);
  });

  it('accumulate=false restores legacy behavior (penetration possible)', () => {
    const manager = createManager();
    const A = createSurface(0, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 500);
    const B = createSurface(2, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 0);
    A.Accumulate = false; // per-surface opt-out
    manager.surfaces.push(A, B);

    const leader = createMU('leader', 1.08, 0, 0);
    const follower = createMU('follower', 0, 0, 0);
    manager.mus.push(leader, follower);

    run(manager, 300);

    // Legacy: the follower is driven to the end of A and INTO the leader.
    expect(follower.aabb.overlaps(leader.aabb)).toBe(true);
    expect(follower.blocked).toBe(false);
  });

  it('global kill-switch accumulateDefault=false disables the clamp without scene changes', () => {
    RVTransportSurface.accumulateDefault = false; // restored by afterEach
    const manager = createManager();
    const A = createSurface(0, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 500);
    const B = createSurface(2, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 0);
    expect(A.Accumulate).toBe(true); // the scene still says accumulate
    manager.surfaces.push(A, B);

    const leader = createMU('leader', 1.08, 0, 0);
    const follower = createMU('follower', 0, 0, 0);
    manager.mus.push(leader, follower);

    run(manager, 300);
    expect(follower.aabb.overlaps(leader.aabb)).toBe(true); // legacy penetration
  });
});

// ─── Performance ──────────────────────────────────────────────────

describe('MU accumulation — performance', () => {
  it('perf: 500 MUs accumulation overhead below budget', () => {
    const manager = createManager();
    // One long belt, 500 free-flowing MUs (grid path, ≥ bruteForceThreshold).
    const A = createSurface(0, 0, 0, new Vector3(50, 0.1, 1), new Vector3(1, 0, 0), 1000);
    manager.surfaces.push(A);
    for (let i = 0; i < 500; i++) {
      manager.mus.push(createMU(`mu${i}`, -49 + i * 0.15, 0, 0));
    }

    run(manager, 10); // warm-up (grid build, JIT)

    const TICKS = 100;
    const t0 = performance.now();
    run(manager, TICKS);
    const msPerTick = (performance.now() - t0) / TICKS;

    // Target from plan-255 NFR is < 0.1 ms ADDED cost; assert a CI-tolerant
    // hard ceiling on the WHOLE transport tick and log the measured value.
    console.log(`[perf] 500-MU transport tick with accumulation: ${msPerTick.toFixed(3)} ms`);
    expect(msPerTick).toBeLessThan(5);
    expect(manager.mus.length).toBe(500); // nothing vanished/broke during the run
  });
});
