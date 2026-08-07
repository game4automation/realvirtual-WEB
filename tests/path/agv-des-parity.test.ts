// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-268 §9.4 — Agv DES ↔ continuous coupling (Phase 3).
 *
 * PARITY IS CONFLICT-FREE ONLY (§2.4 final decision / §10 finding 3): on a
 * free path the arrival time is `L/v` in BOTH modes (± tick), the `path`
 * tween samples the ARC (position at half the transit == arc-length midpoint,
 * not the chord), and the FastForward end state equals the continuous end
 * state. UNDER CONTENTION the two modes deliberately run different algorithms
 * — continuous = soft car-following ramp per tick, DES = discrete
 * reschedule-on-free — so the contention test compares ONLY the arrival ORDER
 * and the end state / throughput, NEVER the momentary position. That boundary
 * is by design; no shared discretised conflict model exists (or should).
 *
 * Continuous side: the real Agv library component (createBindContext +
 * iterateFixedUpdate). DES side: the PRIVATE DESRunner (`@rv-private/...`) —
 * this suite runs in the standard test run because the vitest/tsc config
 * resolves `@rv-private` against the sibling Private~ checkout (its stub
 * fallback has no des-runner, so a stub-only environment would skip here —
 * see the conveyor DES suites, same pattern).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { DESRunner } from '@rv-private/plugins/des/des-runner';
import { _resetDesHookCache } from '@rv-private/plugins/des/des-hook-adapter';
import { EventEmitter } from '../../src/core/rv-events';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';
import {
  createBindContext,
  applyKinematicsSpec,
  iterateFixedUpdate,
  type BindContextHost,
  type BindContextHandle,
  type KinematicsSpec,
  type RVBindContext,
} from '../../src/core/behavior-runtime';
import {
  createSelf,
  type MaterialFlowSelf,
} from '../../src/core/material-flow/material-flow-self';
import type { MaterialFlowDefinition } from '../../src/core/material-flow/define-material-flow';
import { parsePathExtras, type RVPath } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultSpacingController } from '../../src/core/engine/rv-spacing-controller';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { clearLiveControl } from '../../src/core/engine/rv-live-control';
import AgvBehavior, { AgvFlow } from '../../src/behaviors/Agv';

const AgvDef = AgvFlow as unknown as MaterialFlowDefinition;
const TICK = 1 / 60;

// ─── Shared harness ─────────────────────────────────────────────────────────

interface Host extends BindContextHost {
  values: Map<string, boolean | number>;
}

function makeHost(): Host {
  const subs = new Map<string, Set<(v: boolean | number) => void>>();
  const values = new Map<string, boolean | number>();
  const events = new EventEmitter<Record<string, unknown>>();
  return {
    values,
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

/** An Agv root configured via rv_extras (LayoutObject → instance-scoped signals). */
function makeAgv(name: string, cfg: Record<string, unknown>): Object3D {
  const root = new Object3D();
  root.name = name;
  root.userData.realvirtual = { LayoutObject: { Name: name }, Agv: cfg };
  return root;
}

function makeCtx(root: Object3D, host: Host): { ctx: RVBindContext; handle: BindContextHandle } {
  const accum: KinematicsSpec = {};
  const { ctx, handle } = createBindContext(root, host, accum);
  applyKinematicsSpec(root, accum);
  return { ctx, handle };
}

/** Continuous binding of the real library component. */
function bindContinuous(root: Object3D, host: Host): BindContextHandle {
  const accum: KinematicsSpec = {};
  const { ctx, handle } = createBindContext(root, host, accum);
  AgvBehavior.bind(ctx);
  applyKinematicsSpec(root, accum);
  return handle;
}

/** DES instance over the SAME definition (conveyor-des-timing pattern). The
 *  entityId is read LIVE off the adapter — it is assigned by
 *  `manager.registerComponent` inside `runner.start()` BEFORE the onGenerate
 *  kickoff schedules the first leg, so the closure always resolves correctly. */
function bindDes(runner: DESRunner, root: Object3D, host: Host): MaterialFlowSelf {
  const { ctx } = makeCtx(root, host);
  let adapter: { entityId: number } | null = null;
  const self = createSelf(ctx, AgvDef, {
    mode: 'des',
    scheduler: runner.makeScheduler(AgvDef, () => adapter?.entityId ?? -1),
    local: (AgvDef.state ?? AgvDef.local)?.(),
  });
  adapter = runner.addInstance(AgvDef, self, root);
  return self;
}

const sig = (host: Host, agv: string, key: string): boolean | number | undefined =>
  host.values.get(`${agv}.Agv.${key}`);

function clearShared(): void {
  getDefaultPathNetwork().clear();
  getDefaultSpacingController().clear();
  getDefaultZoneRegistry().clear();
}

beforeEach(() => {
  clearShared();
  _resetDesHookCache();
  clearLiveControl();
});
afterEach(() => {
  clearLiveControl();
});

// ─── Layouts ────────────────────────────────────────────────────────────────

/** Quarter arc, radius 5 m (L = 2π·5/4 ≈ 7.854 m) — arc sampling is
 *  DISTINGUISHABLE from a straight chord lerp. */
function registerArcPath(): RVPath {
  const p = parsePathExtras({
    type: 'Path',
    id: 'Arc',
    segments: [{ kind: 'arc', center: [0, 0, 0], radius: 5, startAngle: 0, degrees: 90, clockwise: false, plane: 'XZ' }],
  }, 'Arc')!;
  getDefaultPathNetwork().register(p);
  getDefaultPathNetwork().resolveGraph();
  return p;
}

/**
 * Crossing layout for the CONTENTION test: two independent lanes sharing one
 * capacity-1 zone 'X'. Lane A reaches the zone first (boundary at 10 m); lane
 * B arrives while A is inside (boundary at 10.8 m — no event-time ties with
 * A's boundary events at 10 s / 12 s under v = 1 m/s).
 */
function registerCrossingLayout(): void {
  const net = getDefaultPathNetwork();
  const mk = (id: string, x: number, z0: number, z1: number, extra: Record<string, unknown> = {}): void => {
    net.register(parsePathExtras({
      type: 'Path', id,
      segments: [{ kind: 'line', from: [x, 0, z0], to: [x, 0, z1] }],
      ...extra,
    }, id)!);
  };
  mk('A-in', 0, 0, 10, { successors: ['A-cross'] });
  mk('A-cross', 0, 10, 12, { zone: 'X', successors: ['A-out'] });
  mk('A-out', 0, 12, 20);
  mk('B-in', 5, 0, 10.8, { successors: ['B-cross'] });
  mk('B-cross', 5, 10.8, 12.8, { zone: 'X', successors: ['B-out'] });
  mk('B-out', 5, 12.8, 20.8);
  net.resolveGraph();
}

// ─── Conflict-free parity (§9.4 strong promise) ────────────────────────────

describe('Agv DES ↔ continuous — conflict-free parity (§9.4)', () => {
  const CFG = { PathId: 'Arc', TargetSpeed: 1000, UseAcceleration: false };

  it('arrival time is L/v in BOTH modes (± tick) and the end poses match', () => {
    // ── Continuous ──
    const arc = registerArcPath();
    const L = arc.length; // ≈ 7.854 m
    const T = L / 1.0;    // v = 1000 mm/s = 1 m/s
    const hostC = makeHost();
    const rootC = makeAgv('AgvC', CFG);
    const handle = bindContinuous(rootC, hostC);
    let tCont = -1;
    for (let i = 1; i <= 800; i++) {
      iterateFixedUpdate(handle, TICK);
      if (tCont < 0 && sig(hostC, 'AgvC', 'Moving') === false && (sig(hostC, 'AgvC', 'Position') as number) > 0) {
        tCont = i * TICK;
        break;
      }
    }
    expect(tCont).toBeGreaterThan(0);
    expect(Math.abs(tCont - T)).toBeLessThanOrEqual(TICK + 1e-9);
    const endCont = rootC.position.clone();

    // ── DES (same definition, private runner, animated sub-mode) ──
    clearShared();
    registerArcPath();
    const runner = new DESRunner({ subMode: 'animated' });
    const hostD = makeHost();
    const rootD = makeAgv('AgvD', CFG);
    bindDes(runner, rootD, hostD);
    runner.start([AgvDef], { root: new Object3D() });

    let tDes = -1;
    for (let i = 1; i <= 800; i++) {
      runner.tick(TICK);
      runner.lateTick(TICK);
      if (sig(hostD, 'AgvD', 'Moving') === false) { tDes = i * TICK; break; }
    }
    expect(tDes).toBeGreaterThan(0);
    // DES arrival == L/v exactly (event time); the tick loop detects it one
    // render tick late at most.
    expect(Math.abs(tDes - T)).toBeLessThanOrEqual(TICK + 1e-9);
    // Cross-mode: same arrival time within a tick of each other.
    expect(Math.abs(tDes - tCont)).toBeLessThanOrEqual(2 * TICK + 1e-9);

    // End pose parity: both roots sit exactly at the arc-length end position.
    const end = arc.getAbsPosition(L, new Vector3());
    expect(endCont.distanceTo(end)).toBeLessThan(1e-6);
    expect(rootD.position.distanceTo(end)).toBeLessThan(1e-6);
    expect(rootD.position.distanceTo(endCont)).toBeLessThan(1e-6);
    runner.dispose();
  });

  it('path-tween position at HALF the transit == arc-length midpoint (not the chord)', () => {
    const arc = registerArcPath();
    const L = arc.length;
    const runner = new DESRunner({ subMode: 'animated' });
    const host = makeHost();
    const root = makeAgv('AgvD', CFG);
    bindDes(runner, root, host);
    runner.start([AgvDef], { root: new Object3D() });

    // Tick to (as close as the fixed step allows) half the transit time.
    const halfT = L / 2; // seconds at 1 m/s
    const n = Math.round(halfT / TICK);
    for (let i = 0; i < n; i++) runner.tick(TICK);
    runner.lateTick(TICK);

    // The tween lerps the ARC ADDRESS: s = renderClock · v.
    const sNow = n * TICK * 1.0;
    const expected = arc.getAbsPosition(sNow, new Vector3());
    expect(root.position.distanceTo(expected)).toBeLessThan(1e-6);
    // …which is ON the arc, clearly off the straight chord midpoint.
    const chordMid = arc.getAbsPosition(0, new Vector3())
      .add(arc.getAbsPosition(L, new Vector3()))
      .multiplyScalar(0.5);
    expect(root.position.distanceTo(chordMid)).toBeGreaterThan(0.5);
    runner.dispose();
  });

  it('FastForward: NO transform writes mid-run; end state == continuous end state', () => {
    const arc = registerArcPath();
    const L = arc.length;
    const runner = new DESRunner({ subMode: 'fastforward' });
    const host = makeHost();
    const root = makeAgv('AgvD', CFG);
    bindDes(runner, root, host);
    runner.start([AgvDef], { root: new Object3D() });

    const startPos = root.position.clone(); // pose applied by setup (path start)

    // One FF tick drains the whole (finite) event queue synchronously.
    runner.tick(TICK);
    // Event processing itself wrote NO transform — the root still sits at the
    // start pose (the des hooks only mutate traveler state; §9.8 anchors the
    // registry's mid-run No-Write).
    expect(root.position.distanceTo(startPos)).toBeLessThan(1e-9);

    // The render pass reaps the FINISHED tween with its final value: the
    // deterministic end state == the arc-length end position == continuous.
    runner.lateTick(TICK);
    const end = arc.getAbsPosition(L, new Vector3());
    expect(root.position.distanceTo(end)).toBeLessThan(1e-6);
    expect(runner.getManager().currentTime).toBeCloseTo(L / 1.0, 6);
    expect(sig(host, 'AgvD', 'Moving')).toBe(false);
    runner.dispose();
  });
});

// ─── Contention (§9.4 weaker promise — order + end state ONLY) ─────────────

describe('Agv DES ↔ continuous — contention: order + end state only (§2.4 boundary)', () => {
  // Both vehicles, same speed, independent lanes crossing zone 'X' (cap 1).
  const A = { PathId: 'A-in', TargetSpeed: 1000, UseAcceleration: false };
  const B = { PathId: 'B-in', TargetSpeed: 1000, UseAcceleration: false };
  const A_END = new Vector3(0, 0, 20);
  const B_END = new Vector3(5, 0, 20.8);

  interface RunResult {
    order: string[];            // completion order (vehicle names)
    posA: Vector3; posB: Vector3;
    bWasBlocked: boolean;
    bothHeldZone: boolean;      // invariant violation flag (must stay false)
  }

  function doneA(root: Object3D): boolean { return root.position.distanceTo(A_END) < 1e-3; }
  function doneB(root: Object3D): boolean { return root.position.distanceTo(B_END) < 1e-3; }

  function runContinuous(): RunResult {
    registerCrossingLayout();
    const host = makeHost();
    const rootA = makeAgv('AgvA', A);
    const rootB = makeAgv('AgvB', B);
    const hA = bindContinuous(rootA, host);
    const hB = bindContinuous(rootB, host);
    const zones = getDefaultZoneRegistry();
    const order: string[] = [];
    let bWasBlocked = false;
    let bothHeldZone = false;
    for (let i = 0; i < 60 * 30 && order.length < 2; i++) {
      iterateFixedUpdate(hA, TICK);
      iterateFixedUpdate(hB, TICK);
      if (zones.isHolder('X', 'AgvA') && zones.isHolder('X', 'AgvB')) bothHeldZone = true;
      if (sig(host, 'AgvB', 'Blocked') === true) bWasBlocked = true;
      if (order.indexOf('AgvA') < 0 && doneA(rootA)) order.push('AgvA');
      if (order.indexOf('AgvB') < 0 && doneB(rootB)) order.push('AgvB');
    }
    return { order, posA: rootA.position.clone(), posB: rootB.position.clone(), bWasBlocked, bothHeldZone };
  }

  function runDes(): RunResult {
    registerCrossingLayout();
    const runner = new DESRunner({ subMode: 'animated' });
    const host = makeHost();
    const rootA = makeAgv('AgvA', A);
    const rootB = makeAgv('AgvB', B);
    bindDes(runner, rootA, host);
    bindDes(runner, rootB, host);
    runner.start([AgvDef], { root: new Object3D() });
    const zones = getDefaultZoneRegistry();
    const order: string[] = [];
    let bWasBlocked = false;
    let bothHeldZone = false;
    for (let i = 0; i < 60 * 30 && order.length < 2; i++) {
      runner.tick(TICK);
      runner.lateTick(TICK);
      if (zones.isHolder('X', 'AgvA') && zones.isHolder('X', 'AgvB')) bothHeldZone = true;
      if (sig(host, 'AgvB', 'Blocked') === true) bWasBlocked = true;
      if (order.indexOf('AgvA') < 0 && doneA(rootA)) order.push('AgvA');
      if (order.indexOf('AgvB') < 0 && doneB(rootB)) order.push('AgvB');
    }
    runner.dispose();
    return { order, posA: rootA.position.clone(), posB: rootB.position.clone(), bWasBlocked, bothHeldZone };
  }

  it('same arrival ORDER and same end state in both modes; momentary positions are NOT compared', () => {
    // §2.4 / §10 finding 3 — the DELIBERATE parity boundary: under contention
    // the continuous car-following ramp and the DES arrival-reschedule diverge
    // in their momentary trajectory. This test therefore compares ONLY:
    //   1. the arrival (completion) ORDER,
    //   2. the per-vehicle END state (both at their own dead ends),
    //   3. throughput (both completed),
    //   4. the zone invariant (never two holders in EITHER mode).
    // It deliberately asserts NOTHING about mid-run positions or times of B.
    const cont = runContinuous();

    clearShared();
    _resetDesHookCache();
    const des = runDes();

    // Real contention happened in both modes (B was held by the zone).
    expect(cont.bWasBlocked).toBe(true);
    expect(des.bWasBlocked).toBe(true);

    // Throughput: both vehicles completed in both modes.
    expect(cont.order.length).toBe(2);
    expect(des.order.length).toBe(2);

    // Arrival order identical (A crossed first, B waited).
    expect(cont.order).toEqual(['AgvA', 'AgvB']);
    expect(des.order).toEqual(['AgvA', 'AgvB']);

    // End state identical across modes — each vehicle at its own dead end.
    expect(cont.posA.distanceTo(A_END)).toBeLessThan(1e-3);
    expect(des.posA.distanceTo(A_END)).toBeLessThan(1e-3);
    expect(cont.posB.distanceTo(B_END)).toBeLessThan(1e-3);
    expect(des.posB.distanceTo(B_END)).toBeLessThan(1e-3);
    expect(des.posA.distanceTo(cont.posA)).toBeLessThan(1e-3);
    expect(des.posB.distanceTo(cont.posB)).toBeLessThan(1e-3);

    // Mutual exclusion held throughout in BOTH modes.
    expect(cont.bothHeldZone).toBe(false);
    expect(des.bothHeldZone).toBe(false);
  });
});
