// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Project geometry/binding and runtime configuration, relocated unchanged from index.ts. */

import type { Object3D } from 'three';
import { activeYardVehicles, boundYardVehicles, NO_ACTIVE_AGV_PROBLEM_CODE } from './active-vehicles';
import type { RVDrive } from '@rv/core/engine/rv-drive';
import type { AgvFleet } from '@rv/core/engine/rv-agv-fleet';
import type { PathDockRegistry } from '@rv/core/engine/rv-path-dock';
import type { ZoneRegistry } from '@rv/core/engine/rv-zone-registry';
import { getDefaultPathNetwork } from '@rv/core/engine/rv-path-network';
import { findByNameInSubtree, findPathInSubtree } from '@rv/core/engine/rv-traverse-utils';
import { reportProblem } from '@rv/core/hmi/problems-store';
import { intervalOf } from '@rv/core/fleet/core/order-sources';
import type { FleetKernelAdapters } from '@rv/core/fleet/exec/backends';
import type { FleetJobRunner, FleetSite } from '@rv/core/fleet/exec/job-runner';
import { YardKpiRun } from './yard-order-kpis';
import type { DESRunner } from '@rv/plugins/des/des-runner';
import type { MaterialFlowAdapter } from '@rv/plugins/des/material-flow-adapter';
import { DES_SOC_USERDATA_KEY } from '@rv/plugins/des/hmi/des-stat-colors';
import { DesHandoverBackend, PluginOwnerRegistry, instanceAt, type DesDropLine, type DesHandoverPoses, type DesVehicleNodes } from '@rv/plugins/des/fleet/des-handover';
import type { PlanningValue } from '@rv/core/planning/rv-planning-params';
import {
  FORK_ANCHOR_NODE_PATH, FORK_TOP_HOME_MM, LIFT_NODE_PATH, PALLET_LENGTH_M, PALLET_SEAT_M, PALLET_WIDTH_M,
  STATION_GEOMETRY, STICH_LENGTH_M, VEHICLE_DECELERATION_MMS2,
  conveyorNodeOf, conveyorOutNodeOf, handlingPose, headSeatOf, palletYardBakeRoleOf, palletYardClaimPaths,
  readStationTag, slotNodeOf, stichZoneOf, turnPathOf,
  type PalletYardConfig, type PalletYardStation, type StationGeometry,
} from './layout';
import { createYardDispatcher, fleetStationsOf } from './dispatch-policy';
import { DEFAULT_YARD, type YardComposition } from './yard-compose';
import { BATTERY_TARGET_KEY, BATTERY_THRESHOLD_KEY, SHIP_DURATION_KEY, SHIP_EVERY_KEY, intervalOfRate } from './parameters';
import type { StatusSignalSink } from '@rv/core/fleet/exec/status-output';
import type { OrderSignalStore } from '@rv/core/fleet/exec/order-request';
import type { ChargingView } from './charger-label';
import type { ContinuousHandover } from '@rv/core/fleet/continuous/handover';
import type { PlantPluginDefinition } from '@rv/core/fleet/define-plant-plugin';
import type { SFC32 } from '@rv/core/rv-rng-distribution';


/** Problems code: a DES snapshot was loaded — PalletYard does not support it (plan-612 §2.4 Nicht-Ziel). */
const SNAPSHOT_PROBLEM_CODE = 'pallet-yard-snapshot-unsupported';
/** Problems code: the scene lacks a node / component the run needs. */
export const BIND_PROBLEM_CODE = 'pallet-yard-bind-incomplete';
/** Sim seconds after a stay's end within which the vehicle must have left the stich (wait `exit`, else reported). */
export const STICH_EXIT_LIMIT_SEC = 60;
/** Sim seconds a vehicle may wait at a turn point for its fork pre-stroke (wait `fork`) before it is reported. */
const FORK_WAIT_LIMIT_SEC = 30;
/** Pause reason of the start hold while a loaded yard is rebuilt to the session's size (plan-681 §2.2). */
export const SIZE_RECONCILE_PAUSE_REASON = 'pallet-yard-size-reconcile';

/** The yard's run: the fleet core's fixed forklift executor and status output. */
export type YardRun = FleetJobRunner;

/** Options of a yard run (the yard's configuration of the fleet executor). */
export interface YardRunOptions {
  definition?: PlantPluginDefinition;
  /** Run configuration (copied — live planning changes mutate the run's own copy). Default: the size-2 yard. */
  cfg?: PalletYardConfig;
  /**
   * The yard the configuration belongs to — its path graph, station geometry and
   * vehicle start paths (plan-681 D12: `composeYard(n)`). Default {@link DEFAULT_YARD}.
   */
  yard?: Pick<YardComposition, 'pathGraph' | 'vehicles' | 'geometry'>;
  fleet?: AgvFleet;
  docks?: PathDockRegistry;
  zones?: ZoneRegistry;
  /** Sim seconds until a missing stich exit is reported (default {@link STICH_EXIT_LIMIT_SEC}). */
  stichExitLimitSec?: number;
  /** Sim seconds of fork wait at a turn point before the report (default {@link FORK_WAIT_LIMIT_SEC}). */
  forkWaitLimitSec?: number;
  /** Where the core publishes `<vehicle>.Status.*` (the viewer's signal store). */
  signals?: (StatusSignalSink & Partial<OrderSignalStore>) | null;
  /**
   * Seeded RNG of the stochastic takt (plan-2051) — only drawn from when
   * `cfg.production.stochastic` is on. Under FleetPlugin it is left out here: the
   * plugin derives a fresh one on every bind and sets it on the run
   * (`FleetJobRunner.setRng`). Direct callers (`startDesRuntime`, tests) pass it.
   */
  rng?: SFC32 | null;
}

/** The run configuration of each yard run (live planning changes mutate it; the dispatcher reads it). */
const runConfigs = new WeakMap<YardRun, PalletYardConfig>();

/** The run configuration of `rt` (its own copy). */
export function yardConfigOf(rt: YardRun): PalletYardConfig {
  const cfg = runConfigs.get(rt);
  if (!cfg) throw new Error('PalletYard: not a yard run');
  return cfg;
}

/** The executor's view of the yard: stations, turn points, the wait point, the start paths. */
function yardSite(cfg: PalletYardConfig, yard: Pick<YardComposition, 'pathGraph' | 'vehicles' | 'geometry'>, vehicleIds: readonly string[]): FleetSite {
  const turnOf = new Map<string, string>();
  for (const s of cfg.stations) turnOf.set(s.pathId, turnPathOf(s.id, yard.geometry));
  turnOf.set(cfg.waitPointPathId, turnPathOf('W', yard.geometry));
  const nextOf = new Map<string, string>();
  for (const p of yard.pathGraph) if (p.successors.length > 0) nextOf.set(p.id, p.successors[0]);
  const start = new Map(yard.vehicles.map((v) => [v.id, v.startPathId]));
  return {
    stations: fleetStationsOf(cfg), turnOf, nextOf, zoneOf: stichZoneOf,
    waitPointPathId: cfg.waitPointPathId, stichLengthM: STICH_LENGTH_M,
    vehicles: vehicleIds.map((id) => ({ id, startPathId: start.get(id) ?? '' })),
  };
}

/** A yard run on the kernel adapters `adapters` (not started). */
export function createYardRun(adapters: FleetKernelAdapters, opts: YardRunOptions = {}): YardRun {
  // Own copy: live planning changes (load, pauses, battery) mutate it in place,
  // and the dispatcher and the executor read the same object.
  const cfg = structuredClone(opts.cfg ?? DEFAULT_YARD.config);
  const vehicleIds = boundYardVehicles.get(adapters) ?? cfg.vehicles;
  const rt = new YardKpiRun(adapters, yardSite(cfg, opts.yard ?? DEFAULT_YARD, vehicleIds), createYardDispatcher(cfg, opts.definition?.retrieval), {
    fork: cfg.vehicle, battery: cfg.battery, startSoc: vehicleIds.map(id => cfg.battery.startSoc[cfg.vehicles.indexOf(id)] ?? 100),
    // The run's TaktPlan IS `cfg.production` (live planning mutates it in place). The plant
    // definition's `config.takts` are per-station interval/phase overrides mapped onto it by
    // the binder's reconfigure(); the plan-wide `stochastic` switch (plan-2051) is a field of
    // this TaktPlan itself, so it reaches the takt unchanged — default absent = fixed takt.
    production: cfg.production, pauses: cfg.shippingPauses,
  }, {
    fleet: opts.fleet, docks: opts.docks, zones: opts.zones,
    // Preserve the scheduled plan-612 limits (fork 30 s, exit 60 s) for M3.
    // Target, charge and standstill use passive executor defaults.
    waitLimits: {
      fork: opts.forkWaitLimitSec ?? FORK_WAIT_LIMIT_SEC, exit: opts.stichExitLimitSec ?? STICH_EXIT_LIMIT_SEC,
    },
    status: { signals: opts.signals, lampMap: opts.definition?.lampMap, lampNames: opts.definition?.config?.lamps },
    orderSignals: opts.signals?.subscribe ? { subscribe: opts.signals.subscribe.bind(opts.signals) } : null,
    socUserDataKey: DES_SOC_USERDATA_KEY,
    decelerationMS2: VEHICLE_DECELERATION_MMS2 / 1000,
    rng: opts.rng ?? null,
  });
  runConfigs.set(rt, cfg);
  return rt;
}

/** What the charger labels read of `rt` (one object per run — the labels compare it). */
export function yardChargingView(rt: YardRun, geometry?: readonly StationGeometry[]): ChargingView {
  return {
    cfg: yardConfigOf(rt), geometry,
    get epoch() { return rt.epoch; },
    chargingAt: (id) => rt.chargingAt(id),
    socAt: (id) => rt.socAt(id),
  };
}

/**
 * Apply a live planning value NOW (inside a clock event). Returns false for a
 * key the run does not know (a reset parameter, an unknown station).
 * - `production.<A>.ratePerHour`: the takt re-bases on the last release; 0 disables the output.
 * - `shipping.everySec` / `durationSec`: the pause plan restarts from now.
 * - `battery.threshold` / `target`: read at the next decision (a dispatch round now).
 */
export function applyYardLive(rt: YardRun, key: string, value: PlanningValue): boolean {
  if (typeof value !== 'number') return false;
  const cfg = yardConfigOf(rt);
  const rate = /^production\.(.+)\.ratePerHour$/.exec(key);
  if (rate) {
    const pickIds = cfg.stations.filter((s) => s.kind === 'pick').map((s) => s.id);
    const i = pickIds.indexOf(rate[1]);
    if (i < 0) return false;
    const p = cfg.production;
    const intervals = p.intervalPerOutput ?? (p.intervalPerOutput = pickIds.map((_, k) => intervalOf(p, k)));
    intervals[i] = intervalOfRate(value);
    rt.retimeTakt(i);
    return true;
  }
  if (key === SHIP_EVERY_KEY || key === SHIP_DURATION_KEY) {
    const p = cfg.shippingPauses;
    if (key === SHIP_EVERY_KEY) p.everySec = value; else p.durationSec = value;
    rt.replanPauses();
    return true;
  }
  if (key === BATTERY_THRESHOLD_KEY || key === BATTERY_TARGET_KEY) {
    if (key === BATTERY_THRESHOLD_KEY) cfg.battery.threshold = value; else cfg.battery.target = value;
    rt.dispatchAll();
    return true;
  }
  return false;
}

/** What a DES bind needs: the started runner, the scene root, the drives (for the lifts). */
interface DesBindInput {
  runner: DESRunner;
  root: Object3D;
  drives: readonly RVDrive[];
  cfg?: PalletYardConfig;
  /** Owner registry — keep ONE per plugin so rebinds on the same manager reuse the owners. */
  owners?: PluginOwnerRegistry;
  /** Where a conveyor's stich Path-Id (its `PalletYardStation` tag) resolves (default: the shared PathNetwork). */
  paths?: { get(id: string): unknown };
  /** Station geometry of the yard at its current size (`composeYard(n).geometry`); default the size-2 table. */
  geometry?: readonly StationGeometry[];
}

/** `pending` = a needed placement is still an empty reference node (it materialises later) — retry silently. */
type DesBindResult = { ok: true; backend: DesHandoverBackend } | { ok: false; missing: string[]; pending: boolean };

/** An empty reference node: a placement that has not materialised yet. */
const isEmptyPlacement = (n: Object3D | null): boolean => !!n && n.children.length === 0
  && !!(n.userData?.realvirtual as Record<string, unknown> | undefined)?.AssetReference;

/** The node tagged as station `id` (CP1d-b placements), or null. */
function taggedStationNode(root: Object3D, id: string): Object3D | null {
  let hit: Object3D | null = null;
  root.traverse((n) => { if (!hit && readStationTag(n)?.Station === id) hit = n; });
  return hit;
}

/** A DES instance addressed by node name (exact): on that node or below it (placement). */
function namedInstance(runner: DESRunner, root: Object3D, name: string, kind: string): MaterialFlowAdapter | null {
  const node = findByNameInSubtree(root, name);
  return node ? instanceAt(runner, node, kind) : null;
}

/**
 * The yard's logical hand-over poses (plan-631 F2a) in the `PalletYardRoot`
 * frame: the production head seat and the dock seat at the current lift height
 * (fork top `FORK_TOP_HOME_MM + lift`, the pallet bottom `PALLET_SEAT_M` below it).
 */
function yardPoses(root: Object3D, geometry: readonly StationGeometry[]): DesHandoverPoses {
  return {
    frame: findByNameInSubtree(root, 'PalletYardRoot') ?? root,
    spawn: (station) => {
      const g = geometry.find((x) => x.id === station);
      return g ? headSeatOf(g) : null;
    },
    dockSeat: (station, liftMm) => {
      const g = geometry.find((x) => x.id === station);
      if (!g) return null;
      const { seat } = handlingPose(g);
      return [seat[0], (FORK_TOP_HOME_MM + liftMm) / 1000 - PALLET_SEAT_M, seat[1]];
    },
    defaultMuSize: [PALLET_WIDTH_M, PALLET_SEAT_M, PALLET_LENGTH_M],
    carrierSeatM: PALLET_SEAT_M,
  };
}

/**
 * Bind the yard's DES hand-over to a started runner: the six conveyors (two
 * outputs, two shipping inputs + their out conveyors), two sources, two sinks,
 * three vehicles (fork anchor + lift drive by node path) and six floor slots
 * must all be there — otherwise the missing names are returned. A tagged
 * conveyor's stich must be the configured one and resolve in the PathNetwork.
 */
export function bindDesYard(input: DesBindInput): DesBindResult {
  const cfg = input.cfg ?? DEFAULT_YARD.config;
  const { runner, root } = input;
  const vehicleIds = activeYardVehicles(root, cfg.vehicles);
  if (!vehicleIds.length) return { ok: false, missing: [NO_ACTIVE_AGV_PROBLEM_CODE], pending: false };
  const paths = input.paths ?? getDefaultPathNetwork();
  const missing: string[] = [];
  const need = <T>(v: T | null, what: string): T | null => { if (!v) missing.push(what); return v; };
  const outputs = new Map<string, { conveyor: MaterialFlowAdapter; source: MaterialFlowAdapter }>();
  const inputs = new Map<string, DesDropLine>();
  // The conveyor of a station: per placement the node TAGGED with the station (its instance on
  // or below it, the stich checked against the configuration); else by the configured node name.
  const conveyorOf = (s: PalletYardStation): MaterialFlowAdapter | null => {
    const tagged = taggedStationNode(root, s.id);
    const conveyor = need(tagged ? instanceAt(runner, tagged, 'conveyor') : namedInstance(runner, root, s.conveyor ?? conveyorNodeOf(s.id), 'conveyor'),
      `${conveyorNodeOf(s.id)} (Conveyor)`);
    const tag = tagged ? readStationTag(tagged) : null;
    if (tag && tag.StichPathId !== s.pathId) missing.push(`${conveyorNodeOf(s.id)}: stich ${tag.StichPathId} != configured ${s.pathId}`);
    else if (tag && !paths.get(tag.StichPathId)) missing.push(`${conveyorNodeOf(s.id)}: stich ${tag.StichPathId} (Path)`);
    return conveyor;
  };
  for (const s of cfg.stations) {
    if (s.kind === 'pick') {
      const conveyor = conveyorOf(s);
      const source = need(namedInstance(runner, root, `Pallet_${s.id}`, 'source'), `Pallet_${s.id} (Source)`);
      if (conveyor && source) outputs.set(s.id, { conveyor, source });
    } else if (s.kind === 'drop') {
      const conveyor = conveyorOf(s);
      const out = need(namedInstance(runner, root, conveyorOutNodeOf(s.id), 'conveyor'), `${conveyorOutNodeOf(s.id)} (Conveyor)`);
      const sink = need(namedInstance(runner, root, `Sink_${s.id}`, 'sink'), `Sink_${s.id} (Sink)`);
      if (conveyor && out && sink) inputs.set(s.id, { conveyor, out, sink });
    }
  }
  const vehicles = new Map<string, DesVehicleNodes>();
  for (const id of vehicleIds) {
    const vroot = need(findByNameInSubtree(root, id), id);
    if (!vroot) continue;
    // Node paths inside the stacker asset (a placed stacker hangs its content below the
    // asset root `AGV_Stacker`: `Stapler_1/AGV_Stacker/Lift/ForkAnchor`).
    const anchor = need(findPathInSubtree(vroot, FORK_ANCHOR_NODE_PATH), `${id}/${FORK_ANCHOR_NODE_PATH}`);
    const liftNode = findPathInSubtree(vroot, LIFT_NODE_PATH);
    const lift = liftNode ? input.drives.find((d) => d.node === liftNode) ?? null : null;
    need(lift, `${id}/${LIFT_NODE_PATH} (Drive)`);
    if (anchor) vehicles.set(id, { root: vroot, anchor, lift });
  }
  const slots = new Map<string, Object3D>();
  for (const s of cfg.stations) {
    if (s.kind !== 'buffer') continue;
    const name = s.slot ?? slotNodeOf(s.id);
    const n = need(findByNameInSubtree(root, name), name);
    if (n) slots.set(s.id, n);
  }
  if (missing.length > 0) {
    // During load the stackers / conveyors are still empty reference nodes — not a gap, a wait.
    const placed = [...vehicleIds];
    for (const s of cfg.stations) {
      if (s.kind === 'pick') placed.push(s.conveyor ?? conveyorNodeOf(s.id), `Pallet_${s.id}`);
      else if (s.kind === 'drop') placed.push(s.conveyor ?? conveyorNodeOf(s.id), conveyorOutNodeOf(s.id), `Sink_${s.id}`);
    }
    const pending = placed.some((name) => isEmptyPlacement(findByNameInSubtree(root, name)));
    return { ok: false, missing, pending };
  }
  const poses = yardPoses(root, input.geometry ?? STATION_GEOMETRY);
  const backend = new DesHandoverBackend(runner, root, outputs, inputs, vehicles, slots, input.owners ?? new PluginOwnerRegistry(), poses);
  boundYardVehicles.set(backend, vehicleIds);
  return { ok: true, backend };
}

// ── Viewer plugin ───────────────────────────────────────────────────────────

/**
 * Bake claims for the component-less MAIN-MODEL nodes the run needs
 * (plan-754 D17): the floor slots — without a claim the destructive bake drops
 * them. Document-root paths. Nothing inside a placement (stackers, conveyors):
 * a claim cannot reach there (plan-757 D5, it would only be a
 * `plugin-claim-not-applicable` entry) — the library assets keep those nodes
 * themselves (layout.ts `palletYardClaimPaths`).
 */
export function palletYardBakeClaims(cfg: PalletYardConfig = DEFAULT_YARD.config, rootName = 'PalletYardRoot'): Array<{ path: string; role: 'merge' | 'chunk' }> {
  // The SECOND guard: the generator writes the same list as authored `rv.BakeRole` into the
  // GLB, which also holds when the viewer loads this plugin only after the bake.
  return palletYardClaimPaths(cfg, rootName).map((path) => ({ path, role: palletYardBakeRoleOf(path) }));
}

/** Problems entry for a loaded DES snapshot (plan-612 §2.4 Nicht-Ziel: visible, not silent). */
export function reportSnapshotProblem(): void {
  reportProblem({
    id: SNAPSHOT_PROBLEM_CODE, severity: 'warning', code: SNAPSHOT_PROBLEM_CODE,
    title: 'PalletYard does not support DES snapshots',
    detail: 'The yard logic (orders, pallets on forks, shipping pauses, battery) is not part of a DES snapshot. '
      + 'The yard restarted from its start state — use Reset instead of loading a snapshot.',
  });
}

/**
 * Yard run on the DES hand-over, wired the way the plugin wires it: a restart
 * the runner reports to the clock restarts the yard; a snapshot restore
 * restarts it once and reports `onSnapshot` once (plan-645 L3: the plugin
 * owners see the restore first and only report; the runner's `restored` that
 * follows re-plans, because it dropped every callback planned before it). Started.
 */
export function startDesRuntime(backend: DesHandoverBackend, onSnapshot: () => void = reportSnapshotProblem, opts?: YardRunOptions): YardRun {
  const rt = createYardRun(backend, opts);
  let reported = false;
  backend.onClockRestart = (why) => {
    if (why === 'restore' && !reported) onSnapshot();
    reported = false;
    rt.start();
  };
  backend.onSnapshotRestored = () => { if (!reported) onSnapshot(); reported = true; };
  rt.start();
  return rt;
}

/**
 * Yard run on the continuous backend (CP2), wired the way the plugin wires it:
 * a sim time that went backwards without a `simulation-start` restarts the yard.
 * Started.
 */
export function startContinuousRuntime(backend: ContinuousHandover, opts?: YardRunOptions): YardRun {
  const rt = createYardRun(backend, opts);
  backend.onClockRestart = () => rt.start();
  rt.start();
  return rt;
}

