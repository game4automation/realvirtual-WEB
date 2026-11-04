// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Pure, deterministic module composition. Geometry and graph helpers come from layout. */
import {
  STICH_LENGTH_M, stichPathId, composeGraph, handlingPose, conveyorNodeOf, slotNodeOf,
  handlingHeightMm, CONVEYOR_SURFACE_M, PALLET_YARD_CONFIG, LIBRARY_ASSETS,
  conveyorZOf, headSeatOf, stationTagOf, CONVEYOR_LENGTH_M, CONVEYOR_OUT_LENGTH_M,
  SINK_BEHIND_END_M, VEHICLE_LENGTH_MM, VEHICLE_WIDTH_MM,
  COURSE, STICH, junctionsOf, junctionInId, junctionOutId, stichArcId, stichNormalZ, straightOf,
  type StationGeometry, type Straight, type PathGraphEntry,
  type PalletYardStation, type PalletYardConfig, type LibraryAsset,
} from './layout.ts';
import { round, specLength, type SegmentSpec } from './path-dsl.mjs';

export { composeGraph } from './layout.ts';

export const GENERATED_OWNER = 'palletYard';
export function generatedMarker(): { owner: string } { return { owner: GENERATED_OWNER }; }

export interface ModuleRatios {
  outputs: number; inputs: number; slots: number; chargers: number;
  vehiclesPerModule: number; ratePerOutput: number;
}
export const DEFAULT_RATIOS: ModuleRatios = { outputs: 1, inputs: 1, slots: 3, chargers: 1, vehiclesPerModule: 1.5, ratePerOutput: 40 };
export interface ModuleCounts { outputs: number; inputs: number; slots: number; chargers: number; waitPoints: number; vehicles: number }
export const SIZE_TABLE: Readonly<Record<number, Partial<ModuleCounts>>> = {};
export const SIZE_MIN = 1, SIZE_MAX = 16;
export const MODULE_PITCH_M = 6.8;

function validateSize(size: number): void {
  if (!Number.isInteger(size) || size < SIZE_MIN || size > SIZE_MAX) throw new RangeError(`palletYard size ${size}: expected integer ${SIZE_MIN}..${SIZE_MAX}`);
}

export function countsFor(size: number, ratios: ModuleRatios = DEFAULT_RATIOS, table = SIZE_TABLE): ModuleCounts {
  validateSize(size);
  for (const key of ['outputs', 'inputs', 'slots', 'chargers'] as const) {
    if (ratios[key] !== DEFAULT_RATIOS[key]) throw new Error(`module-geometry-mismatch: ${key}`);
  }
  const counts: ModuleCounts = { outputs: size, inputs: size, slots: 3 * size, chargers: size, waitPoints: Math.ceil(size / 2), vehicles: Math.floor(ratios.vehiclesPerModule * size + 0.5) };
  const row = table[size] ?? {};
  for (const key of ['outputs', 'inputs', 'slots', 'chargers', 'waitPoints'] as const) {
    if (row[key] !== undefined && row[key] !== counts[key]) throw new Error(`module-geometry-mismatch: ${key}`);
  }
  if (row.vehicles !== undefined) counts.vehicles = row.vehicles;
  if (!Number.isInteger(counts.vehicles) || counts.vehicles < 1) throw new RangeError('palletYard: vehicles must be an integer >= 1');
  return counts;
}

/** Integer tenths preserve the exact legacy coordinates, including negative literals. */
export function composeGeometry(size: number): { geometry: StationGeometry[]; xMin: number; xMax: number; waitPointIds: string[] } {
  validateSize(size);
  const geometry: StationGeometry[] = [];
  const add = (id: string, kind: StationGeometry['kind'], straight: Straight, side: StationGeometry['side'], x10: number): void => {
    geometry.push({ id, kind, straight, side, x: x10 / 10 });
  };
  for (let i = 0; i < size; i++) {
    const x = -66 + 68 * i;
    let p = 3 * i;
    const pick = (at: number): void => add(`A${i + 1}`, 'pick', 'south', 'outside', at);
    const buffer = (at: number, side: StationGeometry['side']): void => add(`P${++p}`, 'buffer', 'south', side, at);
    if (i % 2 === 0) { pick(x); buffer(x, 'inside'); buffer(x + 34, 'inside'); buffer(x + 34, 'outside'); }
    else { buffer(x, 'inside'); buffer(x, 'outside'); pick(x + 34); buffer(x + 34, 'inside'); }
  }
  for (let group = Math.ceil(size / 2) - 1; group >= 0; group--) {
    const first = 2 * group, count = Math.min(2, size - first);
    const xW = -66 + 68 * (first + count - 1) + 51;
    add(group === 0 ? 'W' : `W${group + 1}`, 'wait', 'north', 'inside', xW);
    for (let j = count - 1; j >= 0; j--) {
      const id = first + count - j;
      const x = xW - 34 * (count - j);
      add(`L${id}`, 'charger', 'north', 'inside', x);
      add(`V${id}`, 'drop', 'north', 'outside', x);
    }
  }
  return { geometry, xMin: -7.5, xMax: (68 * size - 61) / 10, waitPointIds: geometry.filter(g => g.kind === 'wait').map(g => g.id) };
}

export type YardAsset = 'YardEndWest' | 'YardModule' | 'YardEndEast' | 'AGVStacker'
  | 'YardSlotMarking' | 'YardChargerStation' | 'YardWaitMarking'
  | 'RollConveyor-3m' | 'RollConveyor-2m' | 'EuropalletLoaded' | 'PalletScanner' | 'PalletSink';
/** All yard assets resolve through the public bundled library. */
export const YARD_ASSETS: Readonly<Record<YardAsset, LibraryAsset>> = {
  AGVStacker: LIBRARY_ASSETS.stacker,
  'RollConveyor-3m': LIBRARY_ASSETS.conveyor3m,
  'RollConveyor-2m': LIBRARY_ASSETS.conveyor2m,
  EuropalletLoaded: { assetId: 'pallethandling-europalletloaded', path: '/library/PalletHandling/EuropalletLoaded.glb' },
  PalletScanner: { assetId: 'pallethandling-palletscanner', path: '/library/PalletHandling/PalletScanner.glb' },
  PalletSink: { assetId: 'pallethandling-palletsink', path: '/library/PalletHandling/PalletSink.glb' },
  YardModule: { assetId: 'pallethandling-palletyardmodule', path: '/library/PalletHandling/PalletYardModule.glb' },
  YardEndWest: { assetId: 'pallethandling-palletyardendwest', path: '/library/PalletHandling/PalletYardEndWest.glb' },
  YardEndEast: { assetId: 'pallethandling-palletyardendeast', path: '/library/PalletHandling/PalletYardEndEast.glb' },
  YardSlotMarking: { assetId: 'pallethandling-palletyardslotmarking', path: '/library/PalletHandling/PalletYardSlotMarking.glb' },
  YardChargerStation: { assetId: 'pallethandling-palletyardchargerstation', path: '/library/PalletHandling/PalletYardChargerStation.glb' },
  YardWaitMarking: { assetId: 'pallethandling-palletyardwaitmarking', path: '/library/PalletHandling/PalletYardWaitMarking.glb' },
};

export interface YardComposition {
  size: number;
  placements: Array<{
    id: string; asset: YardAsset; assetRef: LibraryAsset;
    /** Asset content origin in metres; Phase 2 compensates the asset root's transform. */
    position: [number, number, number]; yawDeg: number;
    /** Component-keyed reference extras and optional asset-root overrides. */
    extras: Record<string, unknown>; overrides?: Record<string, unknown>;
  }>;
  geometry: StationGeometry[];
  stations: PalletYardStation[];
  vehicles: Array<{ id: string; startPathId: string }>;
  pathGraph: PathGraphEntry[];
  docks: Array<{ placementId: string; station: string; stichPathId: string }>;
  slots: Array<{ station: string; node: string; position: [number, number, number] }>;
  config: PalletYardConfig;
  counts: ModuleCounts;
  course: { xMin: number; xMax: number };
  waitPointPathIds: string[];
  /**
   * One `Downtime` node per vehicle when the yard is composed with AGV breakdowns
   * (`PalletYard.AgvMtbf > 0`); ABSENT otherwise, so a yard without breakdowns
   * composes (and hashes) exactly as before the field existed.
   */
  downtimes?: YardDowntime[];
}

/** AGV breakdown parameters of a yard (`PalletYard.AgvMtbf` / `AgvMttr` / `AgvDowntimeStochastic`). */
export interface AgvDowntime {
  /** Mean time between failures per AGV in seconds; 0 = no breakdowns. */
  mtbf: number;
  /** Mean time to repair in seconds (> 0). */
  mttr: number;
  /** Exponential draws from the seeded RNG instead of the fixed means. */
  stochastic: boolean;
}

/** No breakdowns — the schema default of the three fields. */
export const NO_AGV_DOWNTIME: Readonly<AgvDowntime> = Object.freeze({ mtbf: 0, mttr: 300, stochastic: true });

/** One composed `Downtime` node: `id` is the node name, `vehicle` the AGV placement it fails. */
export interface YardDowntime {
  id: string;
  vehicle: string;
  /** rv_extras `Downtime` payload WITHOUT `TargetComponentPath` (the scene path is added where the yard stands). */
  extras: { MTBF: number; MTTR: number; Stochastic: boolean; Enabled: true };
}

/** Node name of the `Downtime` node that fails `vehicle`. */
export function downtimeNodeOf(vehicle: string): string { return 'Downtime_' + vehicle; }

/**
 * `Generated.owner` of the AGV breakdown nodes. Its own owner, not
 * {@link GENERATED_OWNER}: they live next to the floor slots under
 * `PalletYardRoot`, and a slot replacement must never take them along.
 */
export const DOWNTIME_OWNER = 'palletYardDowntime';
/**
 * `Generated.owner` of the breakdown nodes the runtime adds for a vehicle the
 * document has no node for (a variant with more AGVs). Replaced as a whole;
 * the document's own nodes ({@link DOWNTIME_OWNER}) are only updated in place.
 */
export const DOWNTIME_ADDED_OWNER = 'palletYardDowntimeAdded';

/** The rv_extras `Downtime` payload of every composed breakdown, aimed below `yardDesPath`. */
export function downtimeComponents(yard: Pick<YardComposition, 'downtimes'>, yardDesPath: string): Array<{ name: string; Downtime: Record<string, unknown> }> {
  return (yard.downtimes ?? []).map((d) => ({
    name: d.id,
    Downtime: { ...d.extras, TargetComponentPath: `${yardDesPath}/${d.vehicle}` },
  }));
}

/** Throws on a parameter set the `Downtime` component would refuse at setup. */
export function validateAgvDowntime(d: AgvDowntime): void {
  if (!Number.isFinite(d.mtbf) || d.mtbf < 0) throw new RangeError(`palletYard AgvMtbf ${d.mtbf}: expected a number >= 0`);
  if (!Number.isFinite(d.mttr) || d.mttr <= 0) throw new RangeError(`palletYard AgvMttr ${d.mttr}: expected a number > 0`);
}

/**
 * The `Downtime` nodes of a fleet (one per vehicle, `Downtime_Stapler_k`), or
 * none when `mtbf` is 0. Derived from the vehicle list, so any AGV count gets
 * exactly its own breakdowns and never one aimed at a missing vehicle.
 */
export function composeAgvDowntimes(vehicles: ReadonlyArray<{ id: string }>, d: AgvDowntime): YardDowntime[] {
  validateAgvDowntime(d);
  if (d.mtbf === 0) return [];
  return vehicles.map(v => ({
    id: downtimeNodeOf(v.id), vehicle: v.id,
    extras: { MTBF: d.mtbf, MTTR: d.mttr, Stochastic: d.stochastic, Enabled: true as const },
  }));
}

function stationConfig(g: StationGeometry): PalletYardStation {
  if (g.kind === 'wait') throw new Error('the wait point is not a station');
  const base = { id: g.id, kind: g.kind, pathId: stichPathId(g.id), stichLengthM: STICH_LENGTH_M };
  if (g.kind === 'pick' || g.kind === 'drop') return { ...base, conveyor: conveyorNodeOf(g.id), handlingHeightMm: handlingHeightMm(CONVEYOR_SURFACE_M) };
  if (g.kind === 'buffer') return { ...base, slot: slotNodeOf(g.id), handlingHeightMm: handlingHeightMm(0) };
  return { ...base, handlingHeightMm: 0 };
}

/**
 * Every start position a vehicle may be parked on, in the order the composition
 * hands them out: free lane pieces long enough for one stacker and not adjacent
 * to a zone (the named ones first, so the small yards keep their legacy poses),
 * then the charger docks. `n` vehicles take the FIRST `n` of this list, so
 * raising the count appends vehicles and leaves the existing ones where they are
 * — the invariant the `Vehicles` parameter rests on (plan-2015).
 */
export function vehicleStartPaths(graph: PathGraphEntry[], chargers: number): string[] {
  const lane = graph.filter(p => !p.id.startsWith('Stich_'));
  const predecessor = (id: string): PathGraphEntry | undefined => lane.find(p => p.successors.includes(id));
  const candidates = lane.filter(p => !p.zone && p.segments.reduce((sum, s) => sum + specLength(s), 0) >= 0.6 + 0.875 + 0.1 && !predecessor(p.id)?.zone);
  const chosen: PathGraphEntry[] = [];
  for (const id of ['West', 'East', 'West_4', 'East_4', 'West_6', 'East_6', ...candidates.map(p => p.id)]) {
    const p = candidates.find(p => p.id === id);
    if (!p || chosen.some(q => q.id === id || q.successors.includes(id) || p.successors.includes(q.id))) continue;
    chosen.push(p);
  }
  for (let k = 1; k <= chargers; k++) {
    const dock = graph.find(p => p.id === stichPathId('L' + k));
    if (dock) chosen.push(dock);
  }
  return chosen.map(p => p.id);
}

/**
 * How many AGVs the yard at `size` can be composed with — the number of start
 * positions {@link vehicleStartPaths} finds. The upper bound of the
 * `PalletYard.Vehicles` parameter at that size.
 */
export function maxVehiclesFor(size: number): number {
  validateSize(size);
  const { geometry, xMin, xMax } = composeGeometry(size);
  return vehicleStartPaths(composeGraph(geometry, xMin, xMax), size).length;
}

function composeVehicles(graph: PathGraphEntry[], count: number, chargers: number): YardComposition['vehicles'] {
  const starts = vehicleStartPaths(graph, chargers);
  if (starts.length < count) throw new Error('palletYard: no start position for ' + count + ' vehicles');
  return starts.slice(0, count).map((id, k) => ({ id: 'Stapler_' + (k + 1), startPathId: id }));
}

/** Same authored start pose as the generator, measured along the first segment. */
function pointOn(spec: SegmentSpec, s: number): { x: number; z: number; tx: number; tz: number } {
  if (spec.kind === 'line') {
    const length = specLength(spec);
    const tx = (spec.to[0] - spec.from[0]) / length, tz = (spec.to[2] - spec.from[2]) / length;
    return { x: spec.from[0] + tx * s, z: spec.from[2] + tz * s, tx, tz };
  }
  const sign = Math.sign(spec.degrees);
  const a = spec.startAngle * Math.PI / 180 + sign * s / spec.radius;
  return { x: spec.center[0] + spec.radius * Math.cos(a), z: spec.center[2] + spec.radius * Math.sin(a),
    tx: -sign * Math.sin(a), tz: sign * Math.cos(a) };
}

function agvConfig(startPathId: string, config: PalletYardConfig): Record<string, number | boolean | string> {
  return {
    PathId: startPathId, StartPosition: 600, TargetSpeed: config.vehicle.travelSpeedMmS,
    Acceleration: 500, Deceleration: 500, LateralAcceleration: 500, SafetyGap: 300,
    DockingSpeed: 300, DockingDistance: 500,
    VehicleLength: VEHICLE_LENGTH_MM, VehicleWidth: VEHICLE_WIDTH_MM,
    AllowReverse: true, ReverseSpeed: config.vehicle.reverseSpeedMmS,
    ScannerFields: true, ScannerReactionTime: 0.2, ProtectiveMargin: 200, WarningMargin: 1000,
  };
}

export function composeYard(size: number, ratios: ModuleRatios = DEFAULT_RATIOS, table = SIZE_TABLE): YardComposition {
  const counts = countsFor(size, ratios, table);
  if (!Number.isFinite(ratios.ratePerOutput) || ratios.ratePerOutput <= 0) throw new RangeError('palletYard: ratePerOutput must be positive');
  const { geometry, xMin, xMax, waitPointIds } = composeGeometry(size);
  const pathGraph = composeGraph(geometry, xMin, xMax);
  const stations = geometry.filter(g => g.kind !== 'wait').map(stationConfig);
  const vehicles = composeVehicles(pathGraph, counts.vehicles, counts.chargers);
  const intervalSec = Math.round(3600 / ratios.ratePerOutput);
  const config: PalletYardConfig = {
    stations, waitPointPathId: stichPathId('W'), vehicles: vehicles.map(v => v.id),
    production: { intervalSec, phaseSec: Array.from({ length: counts.outputs }, (_, k) => Math.round(k * intervalSec / counts.outputs)) },
    shippingPauses: { everySec: 1200, durationSec: 300, offsetSec: Array.from({ length: counts.inputs }, (_, k) => Math.round(300 + k * 1200 / counts.inputs) % 1200) },
    vehicle: structuredClone(PALLET_YARD_CONFIG.vehicle),
    battery: { ...structuredClone(PALLET_YARD_CONFIG.battery), startSoc: vehicles.map((_, k) => vehicles.length === 1 ? 90 : Math.round(90 - 40 * k / (vehicles.length - 1))) },
  };
  const placements: YardComposition['placements'] = [];
  const place = (id: string, asset: YardAsset, position: [number, number, number], extras: Record<string, unknown> = {}, yawDeg = 0): YardComposition['placements'][number] => {
    const p = { id, asset, assetRef: { ...YARD_ASSETS[asset] }, position: position.map(round) as [number, number, number], yawDeg: round(yawDeg), extras };
    placements.push(p);
    return p;
  };
  place('YardEndWest', 'YardEndWest', [xMin, 0, 0]);
  for (let i = 0; i < size; i++) place('YardModule_' + (i + 1), 'YardModule', [(-34 + 68 * i) / 10, 0, 0], { YardModule: { Index: i + 1, Parity: i % 2 } });
  place('YardEndEast', 'YardEndEast', [xMax, 0, 0]);
  const docks: YardComposition['docks'] = [];
  for (const g of geometry) {
    if (g.kind !== 'pick' && g.kind !== 'drop') continue;
    const convZ = conveyorZOf(g);
    const station = stations.find(s => s.id === g.id)!;
    place(conveyorNodeOf(g.id), 'RollConveyor-3m', [g.x, 0, convZ], { PalletYardStation: stationTagOf(station) });
    docks.push({ placementId: conveyorNodeOf(g.id), station: g.id, stichPathId: stichPathId(g.id) });
    if (g.kind === 'pick') {
      const id = 'Pallet_' + g.id;
      place(id, 'EuropalletLoaded', headSeatOf(g)).overrides = { Source: { AutomaticGeneration: false, GenerateMU: false, Interval: 0, ThisObjectAsMU: id } };
    } else {
      place('Scanner_' + g.id, 'PalletScanner', [g.x, 0, convZ + 0.8]);
      place('ConveyorOut_' + g.id, 'RollConveyor-2m', [g.x, 0, convZ + CONVEYOR_LENGTH_M / 2 + CONVEYOR_OUT_LENGTH_M / 2]);
      place('Sink_' + g.id, 'PalletSink', [g.x, CONVEYOR_SURFACE_M + 0.1, convZ + CONVEYOR_LENGTH_M / 2 + CONVEYOR_OUT_LENGTH_M + SINK_BEHIND_END_M]);
    }
  }
  for (const v of vehicles) {
    const path = pathGraph.find(p => p.id === v.startPathId)!;
    const pt = pointOn(path.segments[0], 0.6);
    place(v.id, 'AGVStacker', [pt.x, 0, pt.z], { Agv: agvConfig(v.startPathId, config) }, Math.atan2(pt.tx, pt.tz) * 180 / Math.PI);
  }
  const slots: YardComposition['slots'] = [];
  for (const g of geometry) {
    const pose = handlingPose(g);
    if (g.kind === 'buffer') {
      place('Marking_' + g.id, 'YardSlotMarking', [g.x, 0, pose.seat[1]]);
      slots.push({ station: g.id, node: slotNodeOf(g.id), position: [g.x, 0, round(pose.seat[1])] });
    } else if (g.kind === 'charger' || g.kind === 'wait') {
      const charger = g.kind === 'charger';
      place((charger ? 'Charger_' : 'Marking_') + g.id, charger ? 'YardChargerStation' : 'YardWaitMarking',
        [g.x, 0, pose.root[1]], {}, pose.forwardZ === 1 ? 0 : 180);
    }
  }
  return { size, placements, geometry, stations, vehicles, pathGraph, docks, slots, config, counts, course: { xMin, xMax }, waitPointPathIds: waitPointIds.map(stichPathId) };
}

/** Default size of the yard (the size `scenes/PalletYard.glb` is generated at). */
export const DEFAULT_SIZE = 2;

/** AGVs of a yard at `size` when nothing says otherwise (`vehiclesPerModule`, rounded). */
export function defaultVehiclesFor(size: number): number {
  return countsFor(size).vehicles;
}

/** AGVs of the generated scene (`DEFAULT_SIZE`) — the schema default of `PalletYard.Vehicles`. */
export const DEFAULT_VEHICLES = defaultVehiclesFor(DEFAULT_SIZE);

/**
 * The yard at `size` with an EXPLICIT number of AGVs (plan-2015) — the one way
 * the `PalletYard.Vehicles` parameter reaches the composition. `vehicles` must be
 * an integer in `1 .. maxVehiclesFor(size)`; anything else throws, so a bad
 * parameter value fails the rebuild instead of silently composing another yard.
 * `defaultVehiclesFor(size)` gives back exactly `composeYard(size)`.
 */
export function composeYardWithVehicles(size: number, vehicles: number, downtime: AgvDowntime = NO_AGV_DOWNTIME): YardComposition {
  validateSize(size);
  if (!Number.isInteger(vehicles) || vehicles < 1) throw new RangeError(`palletYard vehicles ${vehicles}: expected an integer >= 1`);
  const max = maxVehiclesFor(size);
  if (vehicles > max) throw new RangeError(`palletYard vehicles ${vehicles}: at most ${max} fit a yard of ${size} modules`);
  return withDowntimes(composeYard(size, DEFAULT_RATIOS, { [size]: { vehicles } }), downtime);
}

/**
 * `yard` with the AGV breakdowns `downtime` (one `Downtime` per vehicle, or none
 * for `mtbf` 0 — then `yard` itself comes back unchanged).
 */
export function withDowntimes(yard: YardComposition, downtime: AgvDowntime): YardComposition {
  const downtimes = composeAgvDowntimes(yard.vehicles, downtime);
  return downtimes.length === 0 ? yard : { ...yard, downtimes };
}

/**
 * The yard at its default size — the ONE default of the plugin, its backends and
 * the charger labels (plan-681 D12, replaces `PALLET_YARD_CONFIG` / `VEHICLES` /
 * `buildPathGraph()` / `STATION_GEOMETRY` there; for n = 2 deep-equal to them,
 * test 9.1). Frozen: a consumer that needs to change a value copies it.
 */
export const DEFAULT_YARD: YardComposition = Object.freeze(composeYard(DEFAULT_SIZE)) as YardComposition;

// ── Path blocks (plan-628 8.6) ──────────────────────────────────────────────

/** Kinds of the WebViewer `PathBlock` component the yard graph decomposes into. */
export type YardBlockKind = 'straight' | 'curve' | 'stub';

/**
 * One `PathBlock` parent of the generated path network (plan-628 8.6): the
 * `rv_extras.PathBlock` payload (`kind`, `params`, `pose`, junction `host` /
 * `hostPathId` / `frontPathId` — schema of the WebViewer's `rv-path-block.ts`,
 * params kept minimal per kind like `makePathBlockExtras`) plus its child path
 * ids in pathGraph order. `id` is the block node name.
 */
export interface YardPathBlock {
  id: string;
  kind: YardBlockKind;
  params: { lengthM?: number; radiusM?: number; degrees?: number; side?: 'left' | 'right'; stubStraightM?: number; twin?: true };
  /** `[x, z, headingDeg]`: input port (straight/curve) or the node on the host lane (stub). Heading 0 = +X. */
  pose: [number, number, number];
  host?: string;
  hostPathId?: string;
  frontPathId?: string;
  paths: string[];
}

type BlockDraft = Omit<YardPathBlock, 'id' | 'paths'> & { key: string };

/**
 * Group `yard.pathGraph` into path-network blocks — pure, derived from the same
 * geometry as the graph, never its own geometry (plan-628 8.6, plan-681 §2.1):
 * - each lane straight = one `straight` block (its free pieces; the merge
 *   pieces belong to the junctions it hosts),
 * - each end half circle = one 180° `curve` block (a right turn of the loop),
 * - each junction = one `stub` block (twin when two stations share it): its
 *   `_In` / `_Out` merge pieces plus the stich dock + mouth of every station.
 * The yard has no S-curves and no plain merges. Every piece belongs to exactly
 * one block — a piece without a block kind throws, it is never left as a
 * silent block-free path. Blocks are ordered by the first appearance of one of
 * their pieces in the graph and named `PN_Block_<n>` in that order; `paths`
 * keep graph order. Ids, successors and zones of the graph are untouched.
 */
export function composeYardBlocks(yard: Pick<YardComposition, 'geometry' | 'course' | 'pathGraph'>): YardPathBlock[] {
  const { geometry, pathGraph } = yard;
  const { xMin, xMax } = yard.course;
  const r = COURSE.r;
  const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;
  const ids = pathGraph.map((p) => p.id);
  const owner = new Map<string, number>();
  const drafts: Array<BlockDraft & { own: string[] }> = [];
  const claim = (draft: BlockDraft, own: string[]): void => {
    const k = drafts.length;
    for (const id of own) {
      if (owner.has(id)) throw new Error(`palletYard blocks: ${id} claimed twice`);
      owner.set(id, k);
    }
    drafts.push({ ...draft, own });
  };
  const lane = (name: string): string[] => ids.filter((id) => id === name || id.startsWith(`${name}_`));
  const junctionPieces = new Set<string>();
  const junctions: Array<[BlockDraft, string[]]> = [];
  for (const straight of ['south', 'north'] as const) {
    const { z, dir } = straightOf(straight);
    for (const j of junctionsOf(straight, geometry)) {
      const first = geometry.find((g) => g.id === j.stations[0])!;
      const own = [junctionInId(j), junctionOutId(j), ...j.stations.flatMap((s) => [stichPathId(s), stichArcId(s)])];
      for (const id of own) junctionPieces.add(id);
      const front = pathGraph.filter((p) => p.successors.includes(junctionInId(j)));
      const out = pathGraph.find((p) => p.id === junctionOutId(j));
      if (front.length !== 1 || !out || out.successors.length !== 1) {
        throw new Error(`palletYard blocks: junction ${j.id} has no unique front / rest piece`);
      }
      // Left of travel f is (f.z, 0, −f.x) = −dir·Z: a stich whose outward normal is −dir lies left.
      const side: 'left' | 'right' = stichNormalZ(first) === -dir ? 'left' : 'right';
      junctions.push([{
        key: `junction:${j.id}`,
        kind: 'stub',
        params: { radiusM: STICH.arcR, side, stubStraightM: STICH.straightM, ...(j.stations.length === 2 ? { twin: true as const } : {}) },
        pose: [r6(dir * j.u), z, dir === 1 ? 0 : 180],
        host: `straight:${straight}`,
        hostPathId: out.successors[0],
        frontPathId: front[0].id,
      }, own]);
    }
  }
  const free = (name: string): string[] => lane(name).filter((id) => !junctionPieces.has(id));
  claim({ key: 'straight:south', kind: 'straight', params: { lengthM: r6(xMax - xMin) }, pose: [xMin, -r, 0] }, free('South'));
  claim({ key: 'curve:east', kind: 'curve', params: { radiusM: r, degrees: 180, side: 'right' }, pose: [xMax, -r, 0] }, lane('East'));
  claim({ key: 'straight:north', kind: 'straight', params: { lengthM: r6(xMax - xMin) }, pose: [xMax, r, 180] }, free('North'));
  claim({ key: 'curve:west', kind: 'curve', params: { radiusM: r, degrees: 180, side: 'right' }, pose: [xMin, r, 180] }, lane('West'));
  for (const [draft, own] of junctions) claim(draft, own);
  const missing = ids.filter((id) => !owner.has(id));
  if (missing.length) throw new Error(`palletYard blocks: pieces without a block kind: ${missing.join(', ')}`);
  const order: number[] = [];
  for (const id of ids) {
    const k = owner.get(id)!;
    if (!order.includes(k)) order.push(k);
  }
  const nameOf = new Map(order.map((k, i) => [drafts[k].key, `PN_Block_${i + 1}`]));
  return order.map((k) => {
    const { key, own, host, ...rest } = drafts[k];
    const set = new Set(own);
    return {
      id: nameOf.get(key)!,
      ...rest,
      ...(host ? { host: nameOf.get(host)! } : {}),
      paths: ids.filter((id) => set.has(id)),
    };
  });
}

/**
 * The `rv_extras.PathBlock` payload of one composed block (schema of the
 * WebViewer's rv-path-block.ts, version 1) — written by the generator into the
 * GLB and by the runtime rebuild (yard-materialize.ts) into its runtime nodes.
 */
export function pathBlockExtras(b: YardPathBlock): Record<string, unknown> {
  return {
    type: 'PathBlock', version: 1, kind: b.kind, params: { ...b.params }, pose: [...b.pose],
    ...(b.host ? { host: b.host } : {}),
    ...(b.hostPathId ? { hostPathId: b.hostPathId } : {}),
    ...(b.frontPathId ? { frontPathId: b.frontPathId } : {}),
  };
}

/** Canonical JSON uses sorted object keys and preserves array order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return '{' + Object.keys(obj).sort().map(k => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

/** FNV-1a 64-bit over canonical JSON encoded as UTF-8; no platform APIs. */
export function compositionHash(c: YardComposition): string {
  let hash = 0xcbf29ce484222325n;
  const byte = (b: number): void => { hash = BigInt.asUintN(64, (hash ^ BigInt(b)) * 0x100000001b3n); };
  for (const char of canonical(c)) {
    const cp = char.codePointAt(0)!;
    if (cp < 0x80) byte(cp);
    else if (cp < 0x800) { byte(0xc0 | (cp >> 6)); byte(0x80 | (cp & 63)); }
    else if (cp < 0x10000) { byte(0xe0 | (cp >> 12)); byte(0x80 | ((cp >> 6) & 63)); byte(0x80 | (cp & 63)); }
    else { byte(0xf0 | (cp >> 18)); byte(0x80 | ((cp >> 12) & 63)); byte(0x80 | ((cp >> 6) & 63)); byte(0x80 | (cp & 63)); }
  }
  return hash.toString(16).padStart(16, '0');
}
