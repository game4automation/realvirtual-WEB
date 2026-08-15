// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-268 §9.3 — distance keeping WITHOUT raycasts + zone claiming (Phase 2).
 *
 * Headway: two vehicles in a row, slower leader → the follower brakes to
 * ≈ the leader's speed, the arc-length gap stays ≥ safetyDistance and NEVER
 * drops below minGap (hard clamp). Leader stops → follower stops at
 * safetyDistance with Blocked=true; leader restarts → smooth restart,
 * Blocked=false, no jumps. NO colliders/raycasts anywhere — pure 1D
 * arc-length along the path graph (SpacingController).
 *
 * Zone: two vehicles at a crossing zone (capacity 1): only one enters
 * (claim), the other waits AT the entrance; after release it enters. Never
 * both inside. Plus the edge assertions from §9.X: single vehicle → v_max &
 * Blocked=false; gap=0 pair → no penetration; zone capacity 0; releaseAll on
 * reset/dispose (deadlock regression); closed-path headway wrap.
 *
 * Headless: synthetic RVPath graphs, manually ticked — unit level against
 * SpacingController/ZoneRegistry, integration level via the real Agv library
 * component (createBindContext + iterateFixedUpdate), no GLB/DOM.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { EventEmitter } from '../../src/core/rv-events';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';
import {
  createBindContext,
  applyKinematicsSpec,
  iterateFixedUpdate,
  type BindContextHost,
  type BindContextHandle,
  type KinematicsSpec,
} from '../../src/core/behavior-runtime';
import { LineSegment, RVPath, parsePathExtras } from '../../src/core/engine/rv-path';
import { RVPathNetwork, getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { PathTraveler } from '../../src/core/engine/rv-path-traveler';
import {
  SpacingController,
  computeCarFollowingSpeed,
  getDefaultSpacingController,
  HEADWAY_STOP_EPS_MM_S,
} from '../../src/core/engine/rv-spacing-controller';
import { ZoneRegistry, getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { clearLiveControl } from '../../src/core/engine/rv-live-control';
import AgvBehavior from '../../src/behaviors/Agv';

const TICK = 1 / 60;
const v3 = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z);

/** Straight line path along +Z at lateral offset `x`. */
function linePath(id: string, x: number, z0: number, z1: number, opts: {
  successors?: string[]; closed?: boolean; zone?: string; zoneCapacity?: number;
} = {}): RVPath {
  return parsePathExtras({
    type: 'Path',
    id,
    segments: [{ kind: 'line', from: [x, 0, z0], to: [x, 0, z1] }],
    closed: opts.closed === true,
    successors: opts.successors ?? [],
    ...(opts.zone !== undefined ? { zone: opts.zone } : {}),
    ...(opts.zoneCapacity !== undefined ? { zoneCapacity: opts.zoneCapacity } : {}),
  }, id)!;
}

beforeEach(() => {
  getDefaultPathNetwork().clear();
  getDefaultSpacingController().clear();
  getDefaultZoneRegistry().clear();
  clearLiveControl();
});
afterEach(() => {
  clearLiveControl();
});

// ─────────────────────────────────────────────────────────────────────────────
// SpacingController — 1D arc-length headway (unit level)
// ─────────────────────────────────────────────────────────────────────────────

describe('SpacingController — arc-length gap (no raycast, no collider)', () => {
  it('same path: gap is the arc-length difference; the frontmost is free', () => {
    const net = new RVPathNetwork();
    const p = linePath('P', 0, 0, 10);
    net.register(p);
    const a = new PathTraveler('A', p, net); a.s = 2;
    const b = new PathTraveler('B', p, net); b.s = 5;
    const sc = new SpacingController();
    sc.add(a); sc.add(b);
    sc.refresh();
    expect(sc.gapOf('A')).toBeCloseTo(3, 9);
    expect(sc.leaderOf('A')).toBe('B');
    expect(sc.gapOf('B')).toBe(Infinity); // open path, nothing ahead
    expect(sc.leaderOf('B')).toBeNull();
  });

  it('across path ends: the leader on the routed successor is found (graph walk)', () => {
    const net = new RVPathNetwork();
    net.register(linePath('P1', 0, 0, 10, { successors: ['P2'] }));
    net.register(linePath('P2', 0, 10, 20));
    net.resolveGraph();
    const a = new PathTraveler('A', net.get('P1'), net); a.s = 9;
    const b = new PathTraveler('B', net.get('P2'), net); b.s = 1;
    const sc = new SpacingController();
    sc.add(a, { lookAhead: 5 }); sc.add(b);
    sc.refresh();
    expect(sc.gapOf('A')).toBeCloseTo(1 + 1, 9); // 1 m to the end + 1 m into P2
    expect(sc.leaderOf('A')).toBe('B');
  });

  it('the graph walk is bounded by lookAhead (a far leader is "free")', () => {
    const net = new RVPathNetwork();
    net.register(linePath('P1', 0, 0, 10, { successors: ['P2'] }));
    net.register(linePath('P2', 0, 10, 30));
    net.resolveGraph();
    const a = new PathTraveler('A', net.get('P1'), net); a.s = 9.5;
    const b = new PathTraveler('B', net.get('P2'), net); b.s = 15;
    const sc = new SpacingController();
    sc.add(a, { lookAhead: 2 }); // leader is 0.5 + 15 = 15.5 m away — beyond reach
    sc.add(b);
    sc.refresh();
    expect(sc.gapOf('A')).toBe(Infinity);
  });

  it('closed path: the frontmost wraps to the hindmost (gap mod L)', () => {
    const net = new RVPathNetwork();
    const loop = linePath('Loop', 0, 0, 10, { closed: true });
    net.register(loop);
    const a = new PathTraveler('A', loop, net); a.s = 8;
    const b = new PathTraveler('B', loop, net); b.s = 2;
    const sc = new SpacingController();
    sc.add(a); sc.add(b);
    sc.refresh();
    expect(sc.gapOf('B')).toBeCloseTo(6, 9);      // plain 8 − 2
    expect(sc.gapOf('A')).toBeCloseTo(4, 9);      // wrap: 2 + 10 − 8
    expect(sc.leaderOf('A')).toBe('B');
  });

  it('a single traveler on a closed path never follows itself', () => {
    const net = new RVPathNetwork();
    const loop = linePath('Loop', 0, 0, 10, { closed: true });
    net.register(loop);
    const a = new PathTraveler('A', loop, net); a.s = 3;
    const sc = new SpacingController();
    sc.add(a, { lookAhead: 100 });
    sc.refresh();
    expect(sc.gapOf('A')).toBe(Infinity);
  });

  it('gap = 0 (identical positions): the id tie-break makes exactly one the follower', () => {
    const net = new RVPathNetwork();
    const p = linePath('P', 0, 0, 10);
    net.register(p);
    const a = new PathTraveler('A', p, net); a.s = 4;
    const b = new PathTraveler('B', p, net); b.s = 4;
    const sc = new SpacingController();
    sc.add(a); sc.add(b);
    sc.refresh();
    expect(sc.gapOf('A')).toBe(0);        // 'A' < 'B' → A is the follower
    expect(sc.leaderOf('A')).toBe('B');
    expect(sc.gapOf('B')).toBe(Infinity); // B is free and can drive away
  });

  it('computeCarFollowingSpeed: clamp((gap − safety)·k, 0, vMax) with a stop snap', () => {
    expect(computeCarFollowingSpeed(Infinity, 1000, 2, 800)).toBe(800); // free → vMax
    expect(computeCarFollowingSpeed(1500, 1000, 2, 800)).toBe(800);     // clamped at vMax
    expect(computeCarFollowingSpeed(1200, 1000, 2, 800)).toBeCloseTo(400, 9); // band
    expect(computeCarFollowingSpeed(1000, 1000, 2, 800)).toBe(0);       // at safety → hold
    expect(computeCarFollowingSpeed(500, 1000, 2, 800)).toBe(0);        // inside → hold
    // eps snap: a residual below HEADWAY_STOP_EPS_MM_S becomes exactly 0
    const tiny = 1000 + HEADWAY_STOP_EPS_MM_S / 2 / 2;
    expect(computeCarFollowingSpeed(tiny, 1000, 2, 800)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ZoneRegistry — claim/release/capacity (unit level)
// ─────────────────────────────────────────────────────────────────────────────

describe('ZoneRegistry — control-point claims', () => {
  it('capacity 1 (default): one holder, idempotent re-claim, release frees', () => {
    const z = new ZoneRegistry();
    expect(z.claim('X', 'A')).toBe(true);
    expect(z.claim('X', 'A')).toBe(true);   // idempotent — no double count
    expect(z.holderCount('X')).toBe(1);
    expect(z.claim('X', 'B')).toBe(false);  // occupied
    z.release('X', 'A');
    expect(z.claim('X', 'B')).toBe(true);
  });

  it('explicit capacities: 2 admits two, 0 admits none; max of declarations wins', () => {
    const z = new ZoneRegistry();
    z.define('Y', 2);
    expect(z.claim('Y', 'A')).toBe(true);
    expect(z.claim('Y', 'B')).toBe(true);
    expect(z.claim('Y', 'C')).toBe(false);

    z.define('Z0', 0);
    expect(z.capacityOf('Z0')).toBe(0);
    expect(z.claim('Z0', 'A')).toBe(false); // capacity 0 is never enterable

    z.define('M', 1);
    z.define('M', 3);
    z.define('M', 2);
    expect(z.capacityOf('M')).toBe(3);      // deterministic: max of explicit declares
  });

  it('releaseAll frees every claim of one holder; clear/undefine drop state', () => {
    const z = new ZoneRegistry();
    z.claim('X', 'A');
    z.claim('Y', 'A');
    z.claim('X2', 'B');
    z.releaseAll('A');
    expect(z.holderCount('X')).toBe(0);
    expect(z.holderCount('Y')).toBe(0);
    expect(z.holderCount('X2')).toBe(1);    // other holders untouched
    const held: string[] = [];
    expect(z.collectHeld('A', held)).toBe(0);
    z.undefine('X2');
    expect(z.holderCount('X2')).toBe(0);
    z.clear();
    expect(z.capacityOf('Anything')).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Agv integration — real library component, two vehicles, manual ticks
// ─────────────────────────────────────────────────────────────────────────────

interface Host extends BindContextHost {
  values: Map<string, boolean | number>;
  events: EventEmitter<Record<string, unknown>>;
}

function makeHost(): Host {
  const subs = new Map<string, Set<(v: boolean | number) => void>>();
  const values = new Map<string, boolean | number>();
  const events = new EventEmitter<Record<string, unknown>>();
  return {
    values,
    events,
    signalStore: {
      get: (n: string) => values.get(n),
      set: (n: string, v: boolean | number) => { values.set(n, v); subs.get(n)?.forEach((cb) => cb(v)); },
      subscribe: (n: string, cb: (v: boolean | number) => void) => {
        let s = subs.get(n); if (!s) { s = new Set(); subs.set(n, s); }
        s.add(cb); return () => { s!.delete(cb); };
      },
    },
    on: (e, cb) => events.on(e, cb as never),
    contextMenu: new ContextMenuStore(),
    drives: [],
    registry: null,
  };
}

/** An Agv root configured via rv_extras. LayoutObject marks the root as a
 *  placed instance so the two vehicles get INSTANCE-SCOPED signal names
 *  (`<name>.Agv.Run`) instead of colliding on a shared `Agv.Run`. */
function makeAgv(name: string, cfg: Record<string, unknown>): Object3D {
  const root = new Object3D();
  root.name = name;
  root.userData.realvirtual = { LayoutObject: { Name: name }, Agv: cfg };
  return root;
}

function bindAgv(root: Object3D, host: Host): BindContextHandle {
  const accum: KinematicsSpec = {};
  const { ctx, handle } = createBindContext(root, host, accum);
  AgvBehavior.bind(ctx);
  applyKinematicsSpec(root, accum);
  return handle;
}

const sig = (host: Host, agv: string, key: string): boolean | number | undefined =>
  host.values.get(`${agv}.Agv.${key}`);

describe('Agv headway — follower brakes, holds safetyDistance, never penetrates', () => {
  // Follower params used throughout: safety 1000 mm, minGap 200 mm, gain 2 /s.
  const FOLLOW = {
    PathId: 'R', TargetSpeed: 1000, UseAcceleration: false,
    SafetyDistance: 1000, MinGap: 200, LookAhead: 5000, HeadwayGain: 2,
  };

  it('slower leader: follower settles at ≈ the leader speed, gap ≥ safety, no penetration', () => {
    getDefaultPathNetwork().register(linePath('R', 0, 0, 60));
    const host = makeHost();
    const leader = makeAgv('AgvA', { PathId: 'R', TargetSpeed: 500, UseAcceleration: false, StartPosition: 5000 });
    const follower = makeAgv('AgvB', { ...FOLLOW, StartPosition: 0 });
    const hA = bindAgv(leader, host);
    const hB = bindAgv(follower, host);

    let minGapSeen = Infinity;
    let prevB = sig(host, 'AgvB', 'Position') as number;
    let lastDeltaB = 0;
    for (let i = 0; i < 900; i++) {
      iterateFixedUpdate(hA, TICK);
      iterateFixedUpdate(hB, TICK);
      const posA = sig(host, 'AgvA', 'Position') as number;
      const posB = sig(host, 'AgvB', 'Position') as number;
      const gap = posA - posB;
      if (gap < minGapSeen) minGapSeen = gap;
      lastDeltaB = posB - prevB;
      prevB = posB;
    }
    // gap stayed ≥ safetyDistance the whole run (monotone approach to the
    // equilibrium safety + vLeader/gain = 1250 mm) and NEVER below minGap.
    expect(minGapSeen).toBeGreaterThanOrEqual(1000 - 1e-6);
    expect(minGapSeen).toBeGreaterThanOrEqual(200); // hard floor, trivially implied
    // follower speed settled at ≈ the leader's 500 mm/s (measured per tick)
    expect(lastDeltaB / TICK).toBeGreaterThan(480);
    expect(lastDeltaB / TICK).toBeLessThan(520);
    const finalGap = (sig(host, 'AgvA', 'Position') as number) - (sig(host, 'AgvB', 'Position') as number);
    expect(finalGap).toBeCloseTo(1250, -2); // equilibrium ±50
    expect(sig(host, 'AgvB', 'Blocked')).toBe(false); // following, not blocked
  });

  it('leader halts → follower stops AT safetyDistance with Blocked=true; restart is smooth', () => {
    getDefaultPathNetwork().register(linePath('R', 0, 0, 60));
    const host = makeHost();
    const hA = bindAgv(makeAgv('AgvA', { PathId: 'R', TargetSpeed: 500, UseAcceleration: false, StartPosition: 5000 }), host);
    const hB = bindAgv(makeAgv('AgvB', { ...FOLLOW, StartPosition: 0 }), host);
    const tick = (): void => { iterateFixedUpdate(hA, TICK); iterateFixedUpdate(hB, TICK); };

    for (let i = 0; i < 600; i++) tick();       // settle behind the leader
    host.signalStore!.set('AgvA.Agv.Run', false); // leader halts
    for (let i = 0; i < 500; i++) tick();

    const gapStopped = (sig(host, 'AgvA', 'Position') as number) - (sig(host, 'AgvB', 'Position') as number);
    expect(gapStopped).toBeGreaterThanOrEqual(1000 - 1e-6); // never inside safety
    expect(gapStopped).toBeLessThanOrEqual(1001);           // ...and truly AT it
    expect(sig(host, 'AgvB', 'Blocked')).toBe(true);        // v≈0 caused by the leader
    expect(sig(host, 'AgvB', 'Moving')).toBe(false);

    // Leader restarts → follower restarts smoothly (bounded per-tick advance,
    // no jump) and Blocked clears.
    host.signalStore!.set('AgvA.Agv.Run', true);
    let prevB = sig(host, 'AgvB', 'Position') as number;
    for (let i = 0; i < 300; i++) {
      tick();
      const posB = sig(host, 'AgvB', 'Position') as number;
      const delta = posB - prevB;
      expect(delta).toBeGreaterThanOrEqual(0);
      expect(delta).toBeLessThanOrEqual(1000 * TICK + 1e-6); // never faster than TargetSpeed
      prevB = posB;
    }
    expect(sig(host, 'AgvB', 'Blocked')).toBe(false);
    expect(sig(host, 'AgvB', 'Moving')).toBe(true);
  });

  it('edge: a single vehicle without a leader runs at v_max with Blocked=false', () => {
    getDefaultPathNetwork().register(linePath('R', 0, 0, 60));
    const host = makeHost();
    const hA = bindAgv(makeAgv('AgvA', { ...FOLLOW, StartPosition: 0 }), host);
    let prev = 0;
    for (let i = 0; i < 120; i++) {
      iterateFixedUpdate(hA, TICK);
      const pos = sig(host, 'AgvA', 'Position') as number;
      if (i > 0) expect(pos - prev).toBeCloseTo(1000 * TICK, 6); // full TargetSpeed
      prev = pos;
    }
    expect(sig(host, 'AgvA', 'Blocked')).toBe(false);
    expect(sig(host, 'AgvA', 'Moving')).toBe(true);
  });

  it('edge: two vehicles at gap=0 never penetrate — one waits, the other departs', () => {
    getDefaultPathNetwork().register(linePath('R', 0, 0, 60));
    const host = makeHost();
    const hA = bindAgv(makeAgv('AgvA', { ...FOLLOW, StartPosition: 0 }), host);
    const hB = bindAgv(makeAgv('AgvB', { ...FOLLOW, StartPosition: 0 }), host);
    for (let i = 0; i < 300; i++) {
      iterateFixedUpdate(hA, TICK);
      iterateFixedUpdate(hB, TICK);
      const posA = sig(host, 'AgvA', 'Position') as number;
      const posB = sig(host, 'AgvB', 'Position') as number;
      // id tie-break: 'AgvA' < 'AgvB' → A follows B; B must always be ahead-or-equal
      expect(posB).toBeGreaterThanOrEqual(posA - 1e-9);
    }
    // B drove away; A started following once the gap exceeded safety
    expect(sig(host, 'AgvB', 'Position') as number).toBeGreaterThan(4000);
    expect(sig(host, 'AgvA', 'Position') as number).toBeGreaterThan(0);
    expect(sig(host, 'AgvA', 'Blocked')).toBe(false);
  });

  it('closed path: headway wraps (mod L) — the follower keeps its distance around the loop', () => {
    getDefaultPathNetwork().register(linePath('Loop', 0, 0, 20, { closed: true }));
    const host = makeHost();
    const hA = bindAgv(makeAgv('AgvA', { PathId: 'Loop', TargetSpeed: 400, UseAcceleration: false, StartPosition: 10000, SafetyDistance: 1000, MinGap: 200, HeadwayGain: 2, LookAhead: 5000 }), host);
    const hB = bindAgv(makeAgv('AgvB', { PathId: 'Loop', TargetSpeed: 800, UseAcceleration: false, StartPosition: 0, SafetyDistance: 1000, MinGap: 200, HeadwayGain: 2, LookAhead: 5000 }), host);
    const L = 20000;
    let minArcGap = Infinity;
    for (let i = 0; i < 3000; i++) {
      iterateFixedUpdate(hA, TICK);
      iterateFixedUpdate(hB, TICK);
      const posA = sig(host, 'AgvA', 'Position') as number;
      const posB = sig(host, 'AgvB', 'Position') as number;
      const arcGap = ((posA - posB) % L + L) % L; // B chases A around the loop
      if (arcGap < minArcGap) minArcGap = arcGap;
    }
    expect(minArcGap).toBeGreaterThanOrEqual(1000 - 1e-6); // wrap-aware, ≥ safety
    const posA = sig(host, 'AgvA', 'Position') as number;
    const posB = sig(host, 'AgvB', 'Position') as number;
    const finalGap = ((posA - posB) % L + L) % L;
    expect(finalGap).toBeCloseTo(1200, -2); // equilibrium 1000 + 400/2 (±50)
  });
});

describe('Agv zones — claim before entry, hold at the entrance, release after transfer', () => {
  /** Crossing fixture: two parallel corridors sharing zone 'X' (capacity 1). */
  function makeCrossing(): void {
    const net = getDefaultPathNetwork();
    net.register(linePath('In1', 0, 0, 2, { successors: ['CrossA'] }));
    net.register(linePath('CrossA', 0, 2, 3, { successors: ['Out1'], zone: 'X' }));
    net.register(linePath('Out1', 0, 3, 6));
    net.register(linePath('In2', 2, 0, 2, { successors: ['CrossB'] }));
    net.register(linePath('CrossB', 2, 2, 3, { successors: ['Out2'], zone: 'X' }));
    net.register(linePath('Out2', 2, 3, 6));
  }
  const CFG = { TargetSpeed: 1000, UseAcceleration: false, StartPosition: 0, LookAhead: 5000, SafetyDistance: 1000, MinGap: 200, HeadwayGain: 2 };

  it('capacity 1: only one vehicle is ever inside; the other waits at the entrance, then follows', () => {
    makeCrossing();
    const host = makeHost();
    const rootA = makeAgv('AgvA', { ...CFG, PathId: 'In1' });
    const rootB = makeAgv('AgvB', { ...CFG, PathId: 'In2' });
    const hA = bindAgv(rootA, host);
    const hB = bindAgv(rootB, host);
    const zones = getDefaultZoneRegistry();

    const inside = (root: Object3D): boolean => root.position.z > 2.001 && root.position.z < 2.999;
    let bWaitedAtEntrance = false;
    let bWasBlocked = false;
    for (let i = 0; i < 700; i++) {
      iterateFixedUpdate(hA, TICK);
      iterateFixedUpdate(hB, TICK);
      // Mutual exclusion — the REAL invariant, every tick:
      expect(zones.holderCount('X')).toBeLessThanOrEqual(1);
      expect(inside(rootA) && inside(rootB)).toBe(false);
      if (inside(rootA) && rootB.position.z <= 2.0 + 1e-6) {
        bWaitedAtEntrance = true;
        if (sig(host, 'AgvB', 'Blocked') === true) bWasBlocked = true;
      }
    }
    expect(bWaitedAtEntrance).toBe(true);          // B held AT the zone entrance
    expect(bWasBlocked).toBe(true);                // ...and reported Blocked
    expect(rootA.position.z).toBeGreaterThan(3.5); // both passed eventually
    expect(rootB.position.z).toBeGreaterThan(3.5); // (B entered after the release)
  });

  it('edge: zone capacity 0 is never enterable — the vehicle parks at the entrance', () => {
    const net = getDefaultPathNetwork();
    net.register(linePath('In', 0, 0, 2, { successors: ['Cross'] }));
    net.register(linePath('Cross', 0, 2, 3, { successors: ['Out'], zone: 'Z0', zoneCapacity: 0 }));
    net.register(linePath('Out', 0, 3, 6));
    const host = makeHost();
    const root = makeAgv('AgvA', { ...CFG, PathId: 'In' });
    const h = bindAgv(root, host);
    for (let i = 0; i < 300; i++) iterateFixedUpdate(h, TICK);
    expect(root.position.z).toBeCloseTo(2, 5);                    // parked at the entrance
    expect(getDefaultZoneRegistry().holderCount('Z0')).toBe(0);   // never claimed
    expect(sig(host, 'AgvA', 'Blocked')).toBe(true);
    expect(sig(host, 'AgvA', 'Moving')).toBe(false);
  });

  function makeZonedCorridor(): void {
    const net = getDefaultPathNetwork();
    net.register(linePath('In', 0, 0, 2, { successors: ['Cross'] }));
    net.register(linePath('Cross', 0, 2, 3, { successors: ['Out'], zone: 'X' }));
    net.register(linePath('Out', 0, 3, 6));
  }

  /** Tick until the vehicle root sits INSIDE the crossing (z ∈ (2.2, 2.8)). */
  function driveIntoZone(h: BindContextHandle, root: Object3D): void {
    for (let i = 0; i < 400 && root.position.z < 2.5; i++) iterateFixedUpdate(h, TICK);
    expect(root.position.z).toBeGreaterThan(2.2);
    expect(root.position.z).toBeLessThan(2.999);
  }

  it('reset releases held zones (deadlock regression) and re-seeds the start pose', () => {
    makeZonedCorridor();
    const host = makeHost();
    const root = makeAgv('AgvA', { ...CFG, PathId: 'In' });
    const h = bindAgv(root, host);
    const zones = getDefaultZoneRegistry();

    driveIntoZone(h, root);
    expect(zones.isHolder('X', 'AgvA')).toBe(true);

    // Reset while INSIDE the zone: without releaseAll this claim would block
    // the crossing forever (a timeout can never heal it in DES/FastForward).
    host.events.emit('simulation-reset');
    expect(zones.holderCount('X')).toBe(0);
    expect(zones.claim('X', 'SomeOtherAgv')).toBe(true); // crossing is claimable again
    zones.release('X', 'SomeOtherAgv');
    expect(root.position.z).toBeCloseTo(0, 6);           // back at the start pose
    expect(sig(host, 'AgvA', 'Blocked')).toBe(false);
    expect(sig(host, 'AgvA', 'Position')).toBe(0);
  });

  it('dispose releases held zones and leaves the shared traffic state clean', () => {
    makeZonedCorridor();
    const host = makeHost();
    const root = makeAgv('AgvA', { ...CFG, PathId: 'In' });
    const h = bindAgv(root, host);
    const zones = getDefaultZoneRegistry();
    const spacing = getDefaultSpacingController();

    driveIntoZone(h, root);
    expect(zones.isHolder('X', 'AgvA')).toBe(true);
    expect(spacing.size).toBe(1);

    h.dispose(); // model-cleared / despawn
    expect(zones.holderCount('X')).toBe(0);
    expect(spacing.size).toBe(0);
  });

  it('queue-order regression: a follower never claims a zone ACROSS its leader (gridlock)', () => {
    // Same corridor, two vehicles in a row before the zone entrance. The
    // follower's LookAhead reaches the entrance PAST its leader; claiming there
    // would invert the queue: the follower holds the zone, the leader waits at
    // the entrance for it, the follower waits behind the leader — gridlock
    // (plan-921 field finding). The follower must leave the claim to the leader.
    const net = getDefaultPathNetwork();
    net.register(linePath('In', 0, 0, 10, { successors: ['Cross'] }));
    net.register(linePath('Cross', 0, 10, 13, { successors: ['Out'], zone: 'X' }));
    net.register(linePath('Out', 0, 13, 20));
    const host = makeHost();
    const CFG2 = { TargetSpeed: 500, UseAcceleration: false, LookAhead: 5000, SafetyDistance: 1500, MinGap: 200, HeadwayGain: 2 };
    const leader = makeAgv('Leader', { ...CFG2, PathId: 'In', StartPosition: 9500 });
    const follower = makeAgv('Follower', { ...CFG2, PathId: 'In', StartPosition: 7000 });
    // Bind + tick the FOLLOWER FIRST — the order that used to let it claim
    // the entrance before the leader's walk ran.
    const hF = bindAgv(follower, host);
    const hL = bindAgv(leader, host);
    const zones = getDefaultZoneRegistry();

    for (let i = 0; i < 3000; i++) {
      iterateFixedUpdate(hF, TICK);
      iterateFixedUpdate(hL, TICK);
      expect(zones.holderCount('X')).toBeLessThanOrEqual(1);
      // The inversion itself: the follower must never hold the zone while the
      // leader is still between it and the entrance (leader on 'In').
      if (zones.isHolder('X', 'Follower')) {
        expect(leader.position.z).toBeGreaterThan(10 - 1e-6);
      }
    }
    // No gridlock: both passed through the zone.
    expect(leader.position.z).toBeGreaterThan(13.5);
    expect(follower.position.z).toBeGreaterThan(13.5);
  });
});
