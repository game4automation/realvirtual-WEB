// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-agv-fleet.ts — the LOW-LEVEL vehicle control surface (plan-921).
 *
 * The deliberately minimal per-vehicle primitive on which project-specific
 * fleet logic (work plans, order pools, charging strategies …) is built —
 * in a TypeScript project plugin, a JS-in-GLB script, or via MCP. The engine
 * ships NO fleet logic of its own (plan-268 F6): exactly one command shape:
 *
 *   task = { destination, serviceSec?, onArrive?, onServiceEnd?, data? }
 *
 * - `destination` — ANY path segment id; the vehicle routes there by shortest
 *   driving distance (`RVPathNetwork.nextHopToward`) and stops at its END.
 * - `serviceSec` — time at the destination ("Zeit am Ziel").
 * - `onArrive` — fired when the dwell STARTS (arrival at the destination end).
 * - `onServiceEnd` — fired when the dwell ENDS. Assigning the next task from
 *   inside this callback chains seamlessly (work-plan style); without a new
 *   task the vehicle goes IDLE and stays parked.
 *
 * Without any task a vehicle CRUISES (successors[0] forever — the pre-task
 * behavior, unchanged). A registered network router (central control) always
 * wins the junction decision over the mechanical shortest-path hop.
 *
 * The registry itself is dumb on purpose: Agv instances register a handle at
 * setup and remove it at teardown; project code enumerates/looks up handles
 * and assigns tasks. Callbacks run synchronously in the simulation tick (or
 * DES event) that completes the phase — schedule follow-up work through the
 * task API, not by blocking.
 */

import type { Object3D } from 'three';
import type { RVPath } from './rv-path';
import { reportProblem, clearProblem } from '../hmi/problems-store';
import { getDefaultMovementAuthority, type SensorLimit } from './rv-movement-authority';

export type AgvPhase = 'cruising' | 'driving' | 'servicing' | 'idle';

/** One vehicle command — see the module doc for the semantics. */
export interface AgvTask {
  /** Path id of the destination segment (the vehicle stops at its END). */
  destination: string;
  /** Dwell time at the destination in seconds (default 0 = touch-and-go). */
  serviceSec?: number;
  /** Fired at dwell START (arrival at the destination end). */
  onArrive?: (agvId: string, task: AgvTask) => void;
  /** Fired at dwell END — assign the next task here to chain a work plan. */
  onServiceEnd?: (agvId: string, task: AgvTask) => void;
  /** Free-form project payload (order id, station id, …). Not interpreted. */
  data?: unknown;
  /**
   * Statistics category booked while the vehicle stands at THIS task's
   * destination (dwell timer or dock), e.g. `'Charging'` (plan-612). Absent or
   * empty: `'Working'` — the behaviour before the field existed. It is
   * re-booked after every DES event of the stay, so it holds for its whole
   * length. A through-dock that is not the destination keeps `'Working'`.
   */
  serviceState?: string;
  /**
   * How the destination is approached (plan-595). `'reverse'`: the destination
   * is a STUB, authored from the handling position toward the lane (a chain of
   * single-successor pieces into a merge piece). The vehicle drives forward to
   * the END of the merge piece, stops, reverses into the stub (rear / forks
   * first) and is served at the stub START, then leaves forward. Needs
   * `AllowReverse` on the vehicle; otherwise — or for a destination that is no
   * stub — the task is approached forward (with a warning). A stub whose merge
   * entry is too short for the fleet's bodies is REJECTED: the task is not
   * started (Problems entry `agv-reverse-stub-refused`). Absent = `'forward'`.
   */
  approach?: 'forward' | 'reverse';
}

/**
 * Live motion snapshot of a vehicle (plan-558) — read by visualizers at
 * RENDER time (the speed is the plan's speed at the last time the vehicle's
 * pose was sampled, so it is correct between DES events too). SI units.
 */
export interface AgvMotionInfo {
  /** Speed (m/s). */
  speed: number;
  /** Scanner field state. */
  field: 'clear' | 'warning' | 'protective';
  /** Protective / warning field length (m) at `speed` (0 without scanner). */
  protectiveLength: number;
  warningLength: number;
  /** Body reach ahead of the root (m) and body width (m). */
  front: number;
  width: number;
  /** Body reach BEHIND the root (m) — the counterpart of `front`, where the field sits at dir = -1 (plan-595). */
  rear: number;
  /** Travel direction of the applied plan: +1 = front first, -1 = rear (forks) first. The field sits at the leading end. */
  dir: 1 | -1;
  /** The vehicle has scanner fields configured. */
  scanner: boolean;
}

/**
 * Where the congestion trace (plan-629) reads a vehicle from:
 * - `'planned'` — registered with a movement authority via `registerPlanned`
 *   (DES, or continuous with UseAcceleration): the authority's plan, analytically
 *   at any sim time;
 * - `'legacy'`  — the continuous step mode (`registerExternal`, an obstacle only):
 *   the traveler state;
 * - `'live'`    — an interface controls the vehicle (`isWired`, wins over both):
 *   the node's world pose and the `Agv.*` signals.
 */
export type AgvTraceSource = 'planned' | 'legacy' | 'live';

/** Static body extents (m) relative to the vehicle root — set at setup, no motion plan needed. */
export interface AgvBodyInfo {
  /** Reach ahead of the root (m). */
  front: number;
  /** Reach behind the root (m). */
  rear: number;
  /** Body width (m). */
  width: number;
}

/** The vehicle's own `Agv.*` status signals (the PLC values while wired). SI units. */
export interface AgvSignalStatus {
  run: boolean;
  moving: boolean;
  blocked: boolean;
  /** `Agv.Speed` in m/s (the signal is mm/s). */
  speed: number;
}

/** Traveler state of a vehicle (legacy step mode reads it directly — not the authority). */
export interface AgvTravelerState {
  /** Current path piece. */
  path: RVPath | null;
  /** Geometric arc length on the piece (m). */
  s: number;
  /** Speed (m/s). */
  speed: number;
  /** The traveler stands at a dead end. */
  atEnd: boolean;
}

/**
 * Where a vehicle stands according to its movement-authority PLAN at the host's
 * current sim time (plan-559 S2) — not the drawn pose and not `traveler.s`
 * (the continuous mode draws #202-shifted, plan-632). The place shape the fleet
 * core's `RouteTable` (src/core/fleet/core/route-table.ts) measures from.
 */
export interface AgvLocation {
  /** Id of the path piece holding the vehicle root. */
  pathId: string;
  /** Geometric arc length on that piece (m), measured from the piece START. */
  s: number;
  /** Travel direction of the plan: +1 = toward the piece END, -1 = toward its START (reverse leg). */
  dir: 1 | -1;
  /** Sim time (s) the location was evaluated at (the host's clock). */
  t: number;
}

/**
 * One task change of a vehicle (plan-559 S1), as `AgvFleet.onTaskChanged`
 * reports it. `requested` is the task handed to `assign()` (null = `clear()`).
 * `effective: true` — the vehicle now drives it; `effective: false` — the
 * request is held back (a reverse manoeuvre finishes first) and a second
 * report with `effective: true` follows when it is applied.
 */
export interface AgvTaskChange {
  requested: AgvTask | null;
  effective: boolean;
}

/** Problems-panel code: two different vehicles registered under one fleet id (plan-559 S4). */
export const FLEET_ID_COLLISION_CODE = 'fleet-id-collision';

/**
 * A vehicle's geometric sensor limit for sim time `now` (plan-664). `null` =
 * nothing measured yet; a limit with `state: 'clear'` = the corridor is free.
 * Called once per fixed step in the Agv input stage, BEFORE the clock advances.
 */
export type SensorLimitSource = (now: number) => SensorLimit | null;

/**
 * `node.userData[AGV_NO_BODY_KEY] === true` — the subtree is an overlay a
 * visualizer parented to the vehicle root (scanner fields, …), not part of the
 * vehicle body. The Agv's mesh-bounds footprint skips it; otherwise a
 * re-configure (mode switch, re-bind) measures the overlay as body and pushes
 * front/width — and with them the overlay itself — further out each time.
 */
export const AGV_NO_BODY_KEY = '_rvAgvNoBody';

/** The per-vehicle control handle the Agv behavior registers. */
export interface AgvTaskCodec {
  owns(task: AgvTask): boolean;
  validate?(task: AgvTask, vehicleId: string): string | null;
  attach(task: AgvTask): void;
  /** Data of an owned task as written to a snapshot: free of process-unique values (the token is re-set by `attach`). */
  exportData?(data: unknown): unknown;
}

export interface AgvHandle {
  /** Ends the current dock stay (same as the dock `release`); with `epoch`, only that very stay (a late call of an abandoned stay is ignored). */
  releaseStay?(epoch?: number): void;
  /** Epoch of the current service stay (the guard value for {@link releaseStay}). */
  stayEpoch?(): number;
  readonly id: string;
  /**
   * Kernel of the vehicle instance behind this handle (plan-648, read only):
   * `'continuous'` (behaviour binding) or `'des'` (DES runner instance). After
   * every kernel switch the handle belongs to the instance of the active kernel.
   */
  readonly kernel?: 'continuous' | 'des';
  /** Assign (or replace) the current task — takes effect at the next tick /
   *  path boundary; a driving vehicle re-routes at the next junction. */
  assign(task: AgvTask): void;
  /** Drop the task and return to free cruising (successors[0]). */
  clear(): void;
  /** The current task (null = cruising or idle without a task). */
  readonly task: AgvTask | null;
  /** Movement phase — 'idle' means parked after a completed task. */
  readonly phase: AgvPhase;
  /** The vehicle's scene root (visualizers parent overlays to it). */
  readonly node?: Object3D;
  /**
   * Id of the RESOLVED start path (plan-453 §2.4b) — `PathId`, or the Path node
   * under the root when `PathId` is empty or unresolvable. A path verb that
   * shifts arc-length addresses finds the vehicles it must move by this id.
   */
  readonly startPathId?: string | null;
  /**
   * Live motion snapshot (plan-558), written into `out` (no allocation per
   * frame). False while the vehicle is not planned (out untouched).
   */
  motion?(out: AgvMotionInfo): boolean;
  /** Source the congestion trace reads this vehicle from (plan-629) — evaluated live. */
  readonly traceSource?: AgvTraceSource;
  /** Static body extents (plan-629), written into `out` — available without a motion plan. */
  body?(out: AgvBodyInfo): void;
  /** Current `Agv.*` status signals (plan-629), written into `out`. */
  signalStatus?(out: AgvSignalStatus): void;
  /**
   * Current traveler state (plan-629), written into `out`; false without a path.
   * For a vehicle planned by the continuous authority this is the DRAWN state after
   * the last completed continuous sync / pose update — since plan-632 every vehicle
   * of a fixed step is synced at the same shared clock time, so between steps it
   * equals the plan location at that time (`mb.locate(id, clock.now)`). Inside a
   * running step (e.g. from a plan-event callback) a vehicle not yet synced in
   * that step still reports the previous step.
   */
  travelerState?(out: AgvTravelerState): boolean;
  /**
   * Plan location at the host's current sim time (plan-559 S2), written into
   * `out` (no allocation). False — `out` untouched — while the vehicle is not
   * planned by a movement authority (legacy step mode, not yet registered) or
   * an interface controls it.
   */
  locate?(out: AgvLocation): boolean;
}

/** Dumb id-keyed handle registry + idle / register / unregister / task-change notification channels. */
export class AgvFleet {
  private readonly taskCodecs = new Set<AgvTaskCodec>();

  registerTaskCodec(codec: AgvTaskCodec): () => void {
    this.taskCodecs.add(codec);
    return () => { this.taskCodecs.delete(codec); };
  }

  taskCodecFor(task: AgvTask): AgvTaskCodec | undefined {
    return [...this.taskCodecs].find(codec => codec.owns(task));
  }

  private readonly handles = new Map<string, AgvHandle>();
  /** Cached handle list for per-frame readers (rebuilt on register / unregister). */
  private list: AgvHandle[] | null = null;
  private readonly idleSubs = new Set<(agvId: string) => void>();
  private readonly registerSubs = new Set<(handle: AgvHandle) => void>();
  private readonly unregisterSubs = new Set<(agvId: string) => void>();
  private readonly taskSubs = new Set<(agvId: string, change: AgvTaskChange) => void>();
  /** Ids with an open `fleet-id-collision` Problems entry of THIS fleet (plan-559 S4). */
  private readonly collisions = new Set<string>();
  /** vehicle id → geometric sensor source (plan-664, see {@link setSensorLimitSource}). */
  private readonly sensorSources = new Map<string, SensorLimitSource>();

  /**
   * Add (or replace) a handle, then notify the `onRegister` subscribers.
   *
   * plan-559 S4: a DIFFERENT vehicle under an id that is already registered is
   * reported as one Problems entry `fleet-id-collision:<id>`; the new handle
   * still replaces the old one (the pre-S4 behaviour, unchanged). A re-binding
   * of the SAME vehicle is no collision: the same handle object, or a fresh
   * handle of the same scene node (a DES runner restart re-runs the Agv setup
   * and registers a new handle for the same root without an unregister).
   */
  register(handle: AgvHandle): void {
    const prev = this.handles.get(handle.id);
    if (prev !== undefined && prev !== handle && !(prev.node !== undefined && prev.node === handle.node)) {
      this.collisions.add(handle.id);
      reportProblem({
        id: `${FLEET_ID_COLLISION_CODE}:${handle.id}`,
        severity: 'warning',
        code: FLEET_ID_COLLISION_CODE,
        title: `Two vehicles share the fleet id '${handle.id}'`,
        detail: `A second vehicle registered under the id '${handle.id}' and replaced the first one in the fleet `
          + 'registry, so the first vehicle can no longer be addressed. Give the vehicles distinct names.',
      });
    }
    this.handles.set(handle.id, handle);
    this.list = null;
    for (const cb of this.registerSubs) {
      try { cb(handle); } catch (e) { console.error('[agv-fleet] onRegister subscriber failed:', e); }
    }
  }

  /** Remove a handle; `onUnregister` subscribers hear of it only when one was actually removed. */
  /**
   * Register the geometric sensor source of a vehicle (plan-664). The Agv input
   * stage polls it ONCE per fixed step, before the clock advances, and pushes
   * the answer into the authority. `null` removes the source (and the vehicle's
   * limit with it, requesting a replan immediately).
   *
   * This indirection is deliberate: the authority must not know what a scanner
   * is, and `Agv.ts` must not import a sensor component. Phase 0 drives it from
   * a test stub with a fixed obstacle; Phase 3 registers the geometric field
   * machine of the `LaserScanner` here.
   */
  setSensorLimitSource(id: string, src: SensorLimitSource | null): void {
    if (src) this.sensorSources.set(id, src);
    else {
      this.sensorSources.delete(id);
      const handle = this.handles.get(id);
      // clearSensorLimit also requests a replan on the vehicle's own host.
      if (handle?.kernel) getDefaultMovementAuthority(handle.kernel).clearSensorLimit(id);
    }
  }

  /** The vehicle's geometric sensor source (null = none). */
  sensorLimitSourceOf(id: string): SensorLimitSource | null {
    return this.sensorSources.get(id) ?? null;
  }

  /** Any sensor source at all — the input stage skips its loop entirely without one. */
  get hasSensorLimitSources(): boolean { return this.sensorSources.size > 0; }

  unregister(id: string): void {
    if (this.collisions.delete(id)) clearProblem(`${FLEET_ID_COLLISION_CODE}:${id}`);
    this.sensorSources.delete(id);
    if (!this.handles.delete(id)) return;
    this.list = null;
    for (const cb of this.unregisterSubs) {
      try { cb(id); } catch (e) { console.error('[agv-fleet] onUnregister subscriber failed:', e); }
    }
  }

  get(id: string): AgvHandle | null {
    return this.handles.get(id) ?? null;
  }

  all(): AgvHandle[] {
    return [...this.handles.values()];
  }

  /** The registered handles as a STABLE array (no allocation per call) — read only. */
  get handleList(): readonly AgvHandle[] {
    this.list ??= [...this.handles.values()];
    return this.list;
  }

  /**
   * Subscribe to "vehicle became idle" (task completed, no follow-up task) —
   * the minimal dispatch trigger for project fleet logic. Returns the
   * unsubscribe function.
   */
  onIdle(cb: (agvId: string) => void): () => void {
    this.idleSubs.add(cb);
    return () => this.idleSubs.delete(cb);
  }

  /** Called by the Agv behavior when a vehicle enters the idle phase. */
  notifyIdle(agvId: string): void {
    for (const cb of this.idleSubs) {
      try { cb(agvId); } catch (e) { console.error('[agv-fleet] onIdle subscriber failed:', e); }
    }
  }

  /**
   * Subscribe to "a vehicle handle was registered" (plan-559 F13 / SOL #4) —
   * the trigger for the FIRST dispatch of a freshly bound vehicle (phase
   * `'cruising'`, so `onIdle` never fires for it). Fired synchronously inside
   * `register()`, after the handle is in the registry; a re-bind fires again
   * with the fresh handle. Handles registered BEFORE the subscription are NOT
   * replayed: a late subscriber reads them once from `all()` / `handleList`
   * (one rule, never a double delivery). Returns the unsubscribe function.
   */
  onRegister(cb: (handle: AgvHandle) => void): () => void {
    this.registerSubs.add(cb);
    return () => this.registerSubs.delete(cb);
  }

  /**
   * Subscribe to "a vehicle handle was removed" (plan-559 S5) — fired by
   * `unregister()` only when a handle was actually removed; `clear()` drops the
   * subscribers without notifying. Returns the unsubscribe function.
   */
  onUnregister(cb: (agvId: string) => void): () => void {
    this.unregisterSubs.add(cb);
    return () => this.unregisterSubs.delete(cb);
  }

  /**
   * Subscribe to task changes requested through a handle's `assign()` /
   * `clear()` (plan-559 S1): `effective: true` once the vehicle drives the
   * requested task; `effective: false` while a reverse manoeuvre holds it back,
   * followed by `effective: true` when it is applied. A completed task (see
   * `onIdle`), a reset and a refused reverse task (Problems entry
   * `agv-reverse-stub-refused`) never report `effective: true`.
   * Returns the unsubscribe function.
   */
  onTaskChanged(cb: (agvId: string, change: AgvTaskChange) => void): () => void {
    this.taskSubs.add(cb);
    return () => this.taskSubs.delete(cb);
  }

  /** Called by the Agv behavior when a task is requested / becomes effective (plan-559 S1). */
  notifyTaskChanged(agvId: string, change: AgvTaskChange): void {
    for (const cb of this.taskSubs) {
      try { cb(agvId, change); } catch (e) { console.error('[agv-fleet] onTaskChanged subscriber failed:', e); }
    }
  }

  /** Number of registered handles. */
  get size(): number {
    return this.handles.size;
  }

  /**
   * Model-cleared reset (plan-647 D2): drop every handle, the cached list and
   * the own collision Problems entries, but KEEP every subscriber (idle,
   * register, unregister, task). Global plugins subscribe once per viewer
   * lifetime and must hear the vehicles of the NEXT model too. Nobody is
   * notified: the vehicles of the old model already left through their own
   * teardown (`unregister`); what is dropped here is only a leftover.
   */
  resetHandles(): void {
    this.handles.clear();
    this.list = null;
    for (const id of this.collisions) clearProblem(`${FLEET_ID_COLLISION_CODE}:${id}`);
    this.collisions.clear();
  }

  /** Test reset: drop every handle, subscriber and own collision entry. */
  clear(): void {
    this.handles.clear();
    this.sensorSources.clear();
    this.list = null;
    this.idleSubs.clear();
    this.registerSubs.clear();
    this.unregisterSubs.clear();
    this.taskSubs.clear();
    for (const id of this.collisions) clearProblem(`${FLEET_ID_COLLISION_CODE}:${id}`);
    this.collisions.clear();
  }
}

const defaultFleet = new AgvFleet();

/** The shared fleet registry (project plugins / scripts / MCP control it). */
export function getDefaultAgvFleet(): AgvFleet {
  return defaultFleet;
}
