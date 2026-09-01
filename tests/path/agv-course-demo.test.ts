// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-451 §9.2/§9.3/§9.4/§9.5/§9.6 — the DES course demo, as a synthetic kernel
 * fixture.
 *
 * The DiscreteEventSimulation test project drives three vehicles around a
 * four-segment oval (`PathSouth → PathEast → PathNorth → PathWest → PathSouth`)
 * whose east curve carries a capacity-1 zone. This suite rebuilds that topology
 * from `rv_extras.Path` payloads and the REAL `Agv` library component, so the
 * kernel promises the demo depends on are covered whether or not the project's
 * scene file exists.
 *
 * What it deliberately does NOT cover — and why the plan keeps a second test
 * beside it: a synthetic fixture builds the path network BEFORE it binds any
 * vehicle, so it can never reproduce an ordering fault in the real loader, and
 * it stays green while the project's scene is empty. That is test 9.1's job, in
 * the private suite, over the real GLTF path.
 *
 * Three facts about `Agv` shape this file (all verified against
 * `src/behaviors/Agv.ts`):
 *
 *  - **`Run` is a SIGNAL, not a schema field.** `setup()` asserts it for every
 *    unwired instance, so a "parked" vehicle has to be parked by writing the
 *    SCOPED signal back after the bind (§9.3). In DES there is no window before
 *    the gate at all — see the note on the DES case in §9.3.
 *  - **`setup()` installs `traveler.hooks.onArrive` itself** and maintains
 *    `l.atNodeId` inside it. Observation therefore WRAPS the hook — replacing it
 *    would quietly take that bookkeeping away from the vehicle.
 *  - **`PathId` must be explicit.** Without it `setup()` falls back to a `Path`
 *    node under the vehicle's own root, which a vehicle parked next to the
 *    course does not have (§9.6).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Object3D } from 'three';
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
import { createSelf, type MaterialFlowSelf } from '../../src/core/material-flow/material-flow-self';
import type { MaterialFlowDefinition } from '../../src/core/material-flow/define-material-flow';
import { DESRunner } from '@rv-private/plugins/des/des-runner';
import { _resetDesHookCache } from '@rv-private/plugins/des/des-hook-adapter';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultSpacingController } from '../../src/core/engine/rv-spacing-controller';
import type { PathTraveler } from '../../src/core/engine/rv-path-traveler';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { getDefaultPathDockRegistry } from '../../src/core/engine/rv-path-dock';
import { clearLiveControl } from '../../src/core/engine/rv-live-control';
import type { RVViewer } from '../../src/core/rv-viewer';
import AgvBehavior, { AgvFlow } from '../../src/behaviors/Agv';
// The DES test project's own fleet plugin — §9.4's second half is a change in
// THAT file, so the test has to exercise the real module, not a copy of it.
import {
  registerModelPlugins,
  unregisterModelPlugins,
} from '@rv-projects/DiscreteEventSimulation/plugins/index';

const AgvDef = AgvFlow as unknown as MaterialFlowDefinition;
const TICK = 1 / 60;

/** The lap, in the order `onArrive` reports COMPLETED segments. */
const LAP = ['PathSouth', 'PathEast', 'PathNorth', 'PathWest', 'PathSouth'] as const;

/**
 * Runtime bound for the loop tests, in ticks (≈ 150 s).
 *
 * The slowest vehicle runs at 800 mm/s, so a 40 m lap costs it 50 s even with a
 * free course; headway behind it and the capacity-1 east curve add to that. The
 * bound exists so a HANGING run fails instead of spinning — it is not a
 * performance assertion.
 */
const MAX_TICKS = 9000;

// ─── Harness (agv-task-control / agv-des-parity pattern) ────────────────────

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
  } as Host;
}

/** An Agv root configured via rv_extras. `LayoutObject` marks it as a placed
 *  instance, which is what gives each vehicle INSTANCE-SCOPED signal names
 *  (`<name>.Agv.Run`) instead of three vehicles sharing one `Agv.Run`. */
function makeAgv(name: string, cfg: Record<string, unknown>): Object3D {
  const root = new Object3D();
  root.name = name;
  root.userData.realvirtual = { LayoutObject: { Name: name }, Agv: cfg };
  return root;
}

function bindContinuous(root: Object3D, host: Host): BindContextHandle {
  const accum: KinematicsSpec = {};
  const { ctx, handle } = createBindContext(root, host, accum);
  AgvBehavior.bind(ctx);
  applyKinematicsSpec(root, accum);
  return handle;
}

function makeCtx(root: Object3D, host: Host): { ctx: RVBindContext; handle: BindContextHandle } {
  const accum: KinematicsSpec = {};
  const { ctx, handle } = createBindContext(root, host, accum);
  applyKinematicsSpec(root, accum);
  return { ctx, handle };
}

/** DES instance over the same definition (agv-des-parity pattern). */
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

// ─── The course ─────────────────────────────────────────────────────────────

/** One straight segment of the oval. */
function seg(id: string, from: [number, number, number], to: [number, number, number],
             opts: { successors?: string[]; zone?: string; zoneCapacity?: number } = {}): void {
  getDefaultPathNetwork().register(parsePathExtras({
    type: 'Path',
    id,
    segments: [{ kind: 'line', from, to }],
    successors: opts.successors ?? [],
    ...(opts.zone !== undefined ? { zone: opts.zone } : {}),
    ...(opts.zoneCapacity !== undefined ? { zoneCapacity: opts.zoneCapacity } : {}),
  }, id)!);
}

/**
 * The AGVDemo course: a 10 m × 10 m oval of four segments, closed through
 * `successors`, with the capacity-1 `EastCurve` zone on the east leg — the
 * topology `library/Custom/Course.glb` carries in the test project.
 */
function registerCourse(): void {
  seg('PathSouth', [0, 0, 0], [10, 0, 0], { successors: ['PathEast'] });
  seg('PathEast', [10, 0, 0], [10, 0, 10], { successors: ['PathNorth'], zone: 'EastCurve', zoneCapacity: 1 });
  seg('PathNorth', [10, 0, 10], [0, 0, 10], { successors: ['PathWest'] });
  seg('PathWest', [0, 0, 10], [0, 0, 0], { successors: ['PathSouth'] });
  getDefaultPathNetwork().resolveGraph();
}

/** The three vehicles from the project documentation (§2.3 of the plan). */
const FLEET = [
  { name: 'Agv1', StartPosition: 0, TargetSpeed: 1000 },
  { name: 'Agv2', StartPosition: 3000, TargetSpeed: 800 },
  { name: 'Agv3', StartPosition: 6000, TargetSpeed: 1200 },
] as const;

const vehicleCfg = (v: typeof FLEET[number]): Record<string, unknown> => ({
  PathId: 'PathSouth',
  StartPosition: v.StartPosition,
  TargetSpeed: v.TargetSpeed,
  UseAcceleration: false,
  SafetyDistance: 1000,
  MinGap: 200,
  LookAhead: 5000,
  HeadwayGain: 2,
});

// ─── Traveler capture + arrival tracing ─────────────────────────────────────

/**
 * Capture the `PathTraveler` each vehicle builds during `setup()`.
 *
 * There is no public "traveler by id" lookup, but `setup()` hands every
 * traveler to the shared `SpacingController` (`.add`) right after installing
 * its hooks. Patching that ONE call is the least invasive seam that yields the
 * real instance — and because it runs after the hook install, wrapping the hook
 * afterwards can still see the component's own handler.
 */
function captureTravelers(): { travelers: Map<string, PathTraveler>; restore: () => void } {
  const sc = getDefaultSpacingController();
  const travelers = new Map<string, PathTraveler>();
  const original = sc.add;
  const patched: typeof sc.add = function patchedAdd(traveler, opts) {
    travelers.set(traveler.id, traveler);
    return original.call(sc, traveler, opts);
  };
  (sc as unknown as { add: typeof sc.add }).add = patched;
  return {
    travelers,
    restore: () => { delete (sc as unknown as Record<string, unknown>)['add']; },
  };
}

/**
 * Record completed segments WITHOUT taking the component's own hook away.
 *
 * `Agv.setup()` installs `onArrive` to maintain `l.atNodeId`; replacing it would
 * silently break that. The original therefore runs first, and the log is kept
 * beside it.
 */
function traceArrivals(traveler: PathTraveler, log: string[]): void {
  const inner = traveler.hooks.onArrive;
  traveler.hooks.onArrive = (nodeId, travelerId) => {
    inner?.(nodeId, travelerId);
    log.push(nodeId);
  };
}

function clearShared(): void {
  getDefaultPathNetwork().clear();
  getDefaultSpacingController().clear();
  getDefaultZoneRegistry().clear();
  getDefaultAgvFleet().clear();
  getDefaultPathDockRegistry().clear();
}

beforeEach(() => {
  clearShared();
  _resetDesHookCache();
  clearLiveControl();
});
afterEach(() => {
  clearLiveControl();
  vi.useRealTimers();
});

// ─── 9.2 — the loop closes, and it is PROTOCOLLED ───────────────────────────

describe('plan-451 §9.2 — course loop closes for every vehicle', () => {
  it('every vehicle completes South→East→North→West→South within the runtime bound', () => {
    registerCourse();
    const capture = captureTravelers();
    const host = makeHost();

    const handles: BindContextHandle[] = [];
    const logs = new Map<string, string[]>();
    try {
      for (const v of FLEET) {
        const root = makeAgv(v.name, vehicleCfg(v));
        handles.push(bindContinuous(root, host));
        const traveler = capture.travelers.get(v.name);
        expect(traveler, `${v.name} built no traveler — PathId did not resolve`).toBeTruthy();
        const log: string[] = [];
        logs.set(v.name, log);
        traceArrivals(traveler!, log);
      }
    } finally {
      capture.restore();
    }

    const done = (): boolean => FLEET.every(v => (logs.get(v.name)!.length >= LAP.length));
    let ticks = 0;
    while (ticks < MAX_TICKS && !done()) {
      for (const h of handles) iterateFixedUpdate(h, TICK);
      ticks++;
    }

    // A hanging run must FAIL, not spin: the bound is the assertion.
    expect(done(), `not every vehicle closed the loop within ${MAX_TICKS} ticks`).toBe(true);
    for (const v of FLEET) {
      expect(logs.get(v.name)!.slice(0, LAP.length), `${v.name} path sequence`).toEqual([...LAP]);
    }
  });
});

// ─── 9.5 — the east curve admits exactly one ────────────────────────────────

describe('plan-451 §9.5 — zone EastCurve admits exactly one vehicle', () => {
  it('the maximum simultaneous occupancy over a full run is 1', () => {
    registerCourse();
    const capture = captureTravelers();
    const host = makeHost();
    const handles: BindContextHandle[] = [];
    const logs = new Map<string, string[]>();
    try {
      for (const v of FLEET) {
        handles.push(bindContinuous(makeAgv(v.name, vehicleCfg(v)), host));
        const log: string[] = [];
        logs.set(v.name, log);
        traceArrivals(capture.travelers.get(v.name)!, log);
      }
    } finally {
      capture.restore();
    }

    const zones = getDefaultZoneRegistry();
    let maxOccupancy = 0;
    let everOccupied = false;
    const done = (): boolean => FLEET.every(v => logs.get(v.name)!.length >= LAP.length);
    let ticks = 0;
    while (ticks < MAX_TICKS && !done()) {
      for (const h of handles) iterateFixedUpdate(h, TICK);
      const held = zones.holderCount('EastCurve');
      if (held > maxOccupancy) maxOccupancy = held;
      if (held > 0) everOccupied = true;
      ticks++;
    }

    expect(done()).toBe(true);
    expect(everOccupied).toBe(true);   // the zone was actually exercised
    expect(maxOccupancy).toBe(1);      // ...and never by two vehicles at once
  });
});

// ─── 9.3 — Run is a signal, and clearing it parks the vehicle ──────────

describe('plan-451 §9.3 — Run=false parks the vehicle', () => {
  it('a vehicle whose scoped Run is cleared after the bind never leaves its start', () => {
    registerCourse();
    const capture = captureTravelers();
    const host = makeHost();
    const root = makeAgv('Agv1', vehicleCfg(FLEET[0]));
    const handle = bindContinuous(root, host);
    const traveler = capture.travelers.get('Agv1')!;
    capture.restore();
    const arrivals: string[] = [];
    traceArrivals(traveler, arrivals);

    // `Run` is a SIGNAL, not a schema field: `setup()` has just asserted it for
    // this unwired instance, so parking means writing the SCOPED signal back
    // (the `tests/path/agv-signals.test.ts` pattern).
    expect(sig(host, 'Agv1', 'Run')).toBe(true);
    host.signalStore!.set('Agv1.Agv.Run', false);

    const startPos = root.position.clone();
    for (let i = 0; i < 1800; i++) iterateFixedUpdate(handle, TICK);

    expect(arrivals).toEqual([]);                        // no segment completed
    expect(sig(host, 'Agv1', 'Moving')).toBe(false);
    expect(root.position.distanceTo(startPos)).toBeLessThan(1e-9);
  });

  it('positive control: with Run left asserted the same vehicle laps the course', () => {
    registerCourse();
    const capture = captureTravelers();
    const host = makeHost();
    const root = makeAgv('Agv1', vehicleCfg(FLEET[0]));
    const handle = bindContinuous(root, host);
    const traveler = capture.travelers.get('Agv1')!;
    capture.restore();
    const arrivals: string[] = [];
    traceArrivals(traveler, arrivals);

    for (let i = 0; i < MAX_TICKS && arrivals.length < LAP.length; i++) {
      iterateFixedUpdate(handle, TICK);
    }
    expect(arrivals.slice(0, LAP.length)).toEqual([...LAP]);
  });

  /**
   * The DES half of the same promise — and the limit this plan found.
   *
   * `Agv.des.onGenerate` gates the start kick on `Run` ("a parked vehicle
   * schedules nothing"), but there is NO window in which a caller can clear
   * `Run` before that gate is read: `DESRunner.start()` runs `def.setup(self)`
   * — which asserts `Run` for every unwired instance — and the `onGenerate`
   * kickoff in the same call, back to back, and `reset()` routes through
   * `start()` again. So an unwired DES vehicle can only be parked AFTER the
   * first leg is already scheduled. What is testable here is that the start
   * kick happens at all; the gate itself is reachable only for a PLC-wired
   * instance, whose `Run` `setup()` deliberately leaves alone.
   */
  it('DES: the start kick schedules the first leg for an unwired vehicle', () => {
    registerCourse();
    const runner = new DESRunner({ subMode: 'animated' });
    const host = makeHost();
    const root = makeAgv('Agv1', vehicleCfg(FLEET[0]));
    bindDes(runner, root, host);

    runner.start([AgvDef], { root: new Object3D() });
    expect(sig(host, 'Agv1', 'Run')).toBe(true); // asserted by setup(), inside start()
    for (let i = 0; i < 600; i++) { runner.tick(TICK); runner.lateTick(TICK); }

    expect(sig(host, 'Agv1', 'Position') as number).toBeGreaterThan(0);
    runner.dispose();
  });
});

// ─── 9.6 — an unresolvable PathId is visible, not silent ────────────────────

describe('plan-451 §9.6 — an unresolvable PathId disables the vehicle visibly', () => {
  it('the vehicle reports the reason, publishes no signals and never moves', () => {
    registerCourse();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const host = makeHost();
      // A vehicle placed BESIDE the course: no Path node under its own root, so
      // the PathId fallback has nothing to fall back to.
      const root = makeAgv('AgvX', { ...vehicleCfg(FLEET[0]), PathId: 'PathDoesNotExist' });
      const handle = bindContinuous(root, host);
      const startPos = root.position.clone();

      for (let i = 0; i < 300; i++) iterateFixedUpdate(handle, TICK);

      const messages = warn.mock.calls.map(c => String(c[0]));
      expect(messages.some(m => m.includes('Agv disabled'))).toBe(true);
      expect(sig(host, 'AgvX', 'Run')).toBeUndefined();     // setup bailed before the assert
      expect(sig(host, 'AgvX', 'Moving')).toBeUndefined();
      expect(root.position.distanceTo(startPos)).toBe(0);   // no silent motion
    } finally {
      warn.mockRestore();
    }
  });
});

// ─── 9.4 (first half) — a wall-clock dock, made deterministic ───────────────

describe('plan-451 §9.4 — the east-curve dock releases deterministically', () => {
  it('the vehicle holds for the handling time, then the loop continues', () => {
    vi.useFakeTimers();
    registerCourse();
    const host = makeHost();
    const capture = captureTravelers();
    const root = makeAgv('Agv1', vehicleCfg(FLEET[0]));
    const handle = bindContinuous(root, host);
    const traveler = capture.travelers.get('Agv1')!;
    capture.restore();
    const arrivals: string[] = [];
    traceArrivals(traveler, arrivals);

    // The project's dock shape: a wall-clock handling time on the east leg.
    // Fake timers are what make it a test rather than a 1.5 s sleep.
    const serviced: string[] = [];
    getDefaultPathDockRegistry().register('PathEast', {
      onVehicleArrive: (agvId, release) => {
        serviced.push(agvId);
        setTimeout(release, 1500);
      },
    });

    // Drive until the dock captures the vehicle at the end of PathEast.
    for (let i = 0; i < MAX_TICKS && serviced.length === 0; i++) iterateFixedUpdate(handle, TICK);
    expect(serviced).toEqual(['Agv1']);
    // Only PathSouth has been COMPLETED: `onArrive` fires on the transfer
    // (`s > L` in PathTraveler.carry), and the dock stops the vehicle AT the end
    // of PathEast before that transfer ever happens.
    expect(arrivals).toEqual(['PathSouth']);
    expect(root.position.x).toBeCloseTo(10, 3);
    expect(root.position.z).toBeCloseTo(10, 3);   // parked at the end of PathEast

    // Held: the timer has not fired, so the transfer does not happen.
    for (let i = 0; i < 120; i++) iterateFixedUpdate(handle, TICK);
    expect(arrivals).toEqual(['PathSouth']);
    expect(root.position.z).toBeCloseTo(10, 3);

    // Released deterministically by advancing the fake clock, not by waiting.
    vi.advanceTimersByTime(1500);
    for (let i = 0; i < MAX_TICKS && arrivals.length < 4; i++) iterateFixedUpdate(handle, TICK);
    expect(arrivals.slice(0, 4)).toEqual(['PathSouth', 'PathEast', 'PathNorth', 'PathWest']);
  });
});

// ─── 9.4 (second half) — the project dock must not outlive its registration ──

describe('plan-451 §9.4 — the DES project dock cancels its timer on unregister', () => {
  /** The plugin only ever calls `viewer.on(...)` and keeps the disposer. */
  const stubViewer = (): RVViewer =>
    ({ on: () => () => { /* no-op disposer */ } }) as unknown as RVViewer;

  it('a release() scheduled before unregister never fires afterwards', () => {
    vi.useFakeTimers();
    try {
      registerModelPlugins(stubViewer());
      const dock = getDefaultPathDockRegistry().dockAt('PathEast');
      expect(dock, 'the plugin registers a dock on PathEast').toBeTruthy();

      let released = 0;
      dock!.onVehicleArrive('Agv1', () => { released++; });

      // Mid-service: the handling time has not elapsed yet.
      vi.advanceTimersByTime(1000);
      expect(released).toBe(0);

      // A model clear in the middle of the service. Before plan-451 the handle
      // was never kept, so this timer survived and fired release() into a fleet
      // generation that no longer existed.
      unregisterModelPlugins();
      vi.advanceTimersByTime(10_000);
      expect(released).toBe(0);
    } finally {
      unregisterModelPlugins();
    }
  });

  it('positive control: an undisturbed service still releases after the handling time', () => {
    vi.useFakeTimers();
    try {
      registerModelPlugins(stubViewer());
      const dock = getDefaultPathDockRegistry().dockAt('PathEast')!;
      let released = 0;
      dock.onVehicleArrive('Agv1', () => { released++; });

      vi.advanceTimersByTime(1499);
      expect(released).toBe(0);
      vi.advanceTimersByTime(1);
      expect(released).toBe(1);

      // ...and the fired timer left nothing behind for the unregister to cancel.
      unregisterModelPlugins();
      vi.advanceTimersByTime(10_000);
      expect(released).toBe(1);
    } finally {
      unregisterModelPlugins();
    }
  });
});
