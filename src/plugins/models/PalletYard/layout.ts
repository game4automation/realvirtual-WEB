// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * PalletYard layout — the ONE source of the scene geometry, the path graph and
 * the project configuration (plan-612 §2.3). Pure data + arithmetic; the only
 * import is the pure path DSL (`./path-dsl.mjs`). The generator
 * `tools/des-examples/pallet-yard.mjs` imports this file directly (Node type stripping), the
 * plugin and the tests import it through Vite. The generator writes
 * `PALLET_YARD_CONFIG` verbatim into the scene root as
 * `extras.realvirtual.PalletYard`; the scene test checks both are equal.
 *
 * `composeGraph` builds parametrized graphs; `buildPathGraph` wraps the legacy geometry.
 *
 * Frame: metres, glTF ground plane X/Z, Y up. One-way loop (as AGVFactory):
 * south straight z = -R travelling +X, east half circle, north straight z = +R
 * travelling -X, west half circle. Every station is a straight STICH joined to
 * the lane by a quarter arc (plan-595 §2.3: authored FROM the handling position
 * TO the lane, so the vehicle backs in fork first and drives out forward).
 * Pick stations (production outputs) lie outside the south straight, drop
 * stations (shipping inputs) outside the north straight, the six floor slots
 * inside the loop off the south straight, wait point and chargers inside the
 * loop off the north straight.
 *
 * SPLIT ZONES (plan-595 §2.3, Phase 4 CP1): the straight dock of a stich is its
 * own capacity-1 zone `Stich_<id>` (K_i); the quarter arc is the MOUTH piece and
 * belongs to the merge zone `Merge_<junction>` (M_i) together with the lane run
 * before the junction (`_In`) and the merge piece after it (`_Out`, the turn
 * point is its END). A vehicle standing in the dock holds only K_i — the lane
 * stays free for the whole stay. The lane run before every junction and the
 * mouth are long enough for the stacker bodies (finding #194; the scene test
 * runs `findShortMergeEntries` on this graph). A pick station and a floor slot
 * opposite of it share one junction (twin stub, both mouths in the same M_i) —
 * that keeps the south straight short enough for six floor slots.
 */

import { arc, buildGraph, line, round, type SegmentSpec } from './path-dsl.mjs';
import type { RetrievalRuleName } from './dispatch-policy';

// ── Vehicle model (public/library/MobileRobots/AGVStacker.glb) ─────────────

/** Vehicle middle (root) → pallet centre on the fork, along −forward (m). Read from `Lift/ForkAnchor`. */
export const FORK_SEAT_OFFSET_M = 0.2735;
/** Fork top above the floor at lift 0 (mm) — `ForkAnchor` height. */
export const FORK_TOP_HOME_MM = 88;
/** Body length incl. a carried pallet / width (mm) — explicit Agv.VehicleLength / VehicleWidth. */
export const VEHICLE_LENGTH_MM = 1750;
export const VEHICLE_WIDTH_MM = 860;

// ── Library dimensions (measured on the library GLBs) ──────────────────────

/** Pallet carrying face (underside of the deck boards) above the pallet bottom (m). */
export const PALLET_SEAT_M = 0.100;
/** Europallet footprint (m): 0.8 across the fork, 1.2 along it. */
export const PALLET_WIDTH_M = 0.8;
export const PALLET_LENGTH_M = 1.2;
/** RollConveyor-3m: roller surface height, length; the end sensor at local z = +1.4. */
export const CONVEYOR_SURFACE_M = 0.5;
export const CONVEYOR_LENGTH_M = 3.0;
export const CONVEYOR_SENSOR_Z_M = 1.4;
/**
 * Half length of the belt mesh `Transport-Z` of RollConveyor-3m along local Z
 * (m, measured on the library GLB: the rollers stop 56 mm short of the 3 m frame).
 * The DES Conveyor reads its exit from these bounds, NOT from the nominal
 * length (`src/behaviors/_shared/transit-timing.ts`).
 */
export const CONVEYOR_BELT_HALF_M = 1.4439072;
/**
 * Bug offset of the pallet (m): the DES transit ends with the pallet's LEADING
 * EDGE at the belt exit, its centre half a pallet behind it (`muBugOffset` =
 * half the MU length).
 */
export const PALLET_BUG_M = PALLET_LENGTH_M / 2;
/**
 * Pallet centre in conveyor-local Z where a production output conveyor HANDS
 * OFF a pallet: the transit ends with the leading edge at the belt exit, so the
 * pallet waits at `+belt half − bug` (0.844), not at the end sensor (0.8). The
 * fork seat of the pick stich stands exactly there (no jump at the take).
 */
export const CONVEYOR_END_SEAT_Z_M = CONVEYOR_BELT_HALF_M - PALLET_BUG_M;
/**
 * Pallet centre in conveyor-local Z on the HEAD of a conveyor (pallet flush with
 * the frame start): where the forklift sets a pallet down on a shipping input
 * and where the production source spawns on an output. The DES Conveyor takes
 * the pallet over AT this pose (plan-631 accept-at-pose: `transferMUWithPose`,
 * rest time from the belt position) — no infeed stand, no jump to the entry.
 */
export const CONVEYOR_HEAD_SEAT_Z_M = -CONVEYOR_LENGTH_M / 2 + PALLET_LENGTH_M / 2; // -0.9
/**
 * RollConveyor-2m behind every shipping input (plan-612 CP1c): the shipping
 * line continues in flow direction (local +Z) directly after the input
 * conveyor, the sink sits at its end. The shipping pause holds the pallet on
 * the INPUT conveyor, in front of this one.
 */
export const CONVEYOR_OUT_LENGTH_M = 2.0;
/** Sink centre behind the end of the shipping line (m, along +Z). */
export const SINK_BEHIND_END_M = 0.3;

/**
 * Lift position (mm) at which the fork top touches the carrying face of a
 * pallet whose bottom stands at `surfaceM`: 512 on a conveyor, 12 on the floor.
 */
export function handlingHeightMm(surfaceM: number): number {
  return Math.round((surfaceM + PALLET_SEAT_M) * 1000 - FORK_TOP_HOME_MM);
}

// ── Course ──────────────────────────────────────────────────────────────────

/** Straights run from -X_END to +X_END; the end half circles have radius R. */
export const COURSE = { xEnd: 7.5, r: 4, maxPieceM: 2.5 } as const;
/** Stich geometry: quarter arc radius at the lane (the mouth), straight dock length (m). */
export const STICH = { arcR: 1.5, straightM: 1.5 } as const;
/** Handling position (vehicle root at the dock) — distance from the lane centre line (m). */
export const STICH_DEPTH_M = STICH.arcR + STICH.straightM;
/** Reverse run of one stich (arc + straight, m) — the way in and the way out. */
export const STICH_LENGTH_M = STICH.straightM + (Math.PI / 2) * STICH.arcR;
/**
 * Merge zone on the lane around a junction (m): `preM` before it (`_In`),
 * `outM` after it (`_Out`, the merge piece — its END is the turn point of the
 * reverse approach), then `gapM` of free lane before the next merge zone.
 * - `preM` covers the reach of a stacker body rooted on a mouth (finding #194;
 *   `findShortMergeEntries` needs about 1.68 m, checked by the scene test).
 * - `gapM` exceeds the body reach ahead of the root: a vehicle standing at the
 *   turn point must not reach into the NEXT merge zone — the claim its front
 *   takes there is not given back by the reverse leg (the zone is not on the
 *   reverse route), and the vehicle would hold it through its whole dock stay.
 */
export const JUNCTION = { preM: 1.8, outM: 0.6, gapM: 1.0 } as const;
/** Junction spacing on a straight (m). */
export const JUNCTION_PITCH_M = JUNCTION.preM + JUNCTION.outM + JUNCTION.gapM;

export type Straight = 'south' | 'north';
export type Side = 'outside' | 'inside';
export type StationKind = 'pick' | 'drop' | 'buffer' | 'charger' | 'wait';

/** Geometry of one station stich. */
export interface StationGeometry {
  id: string;
  kind: StationKind;
  straight: Straight;
  side: Side;
  /** X of the straight dock segment (m). */
  x: number;
}

/**
 * All stations; `x` is the dock line, the junction is `arcR` downstream. The
 * junctions follow each other at {@link JUNCTION_PITCH_M}; every junction is a
 * TWIN (an inside and an outside stich share it) except the wait point:
 * - south (x = -5.1 … 5.1): A1|P1, P2|P3, P4|P5, A2|P6 — four floor slots
 *   inside, two outside between the production outputs;
 * - north (x = 3.8, 0.4, -3.0 in travel order): W, L1|V1, L2|V2.
 * The inside docks of both straights are offset by half a pitch, so a vehicle
 * at a charger never meets one at a floor slot across the loop.
 */
export const STATION_GEOMETRY: ReadonlyArray<StationGeometry> = [
  { id: 'A1', kind: 'pick', straight: 'south', side: 'outside', x: -6.6 },
  { id: 'P1', kind: 'buffer', straight: 'south', side: 'inside', x: -6.6 },
  { id: 'P2', kind: 'buffer', straight: 'south', side: 'inside', x: -3.2 },
  { id: 'P3', kind: 'buffer', straight: 'south', side: 'outside', x: -3.2 },
  { id: 'P4', kind: 'buffer', straight: 'south', side: 'inside', x: 0.2 },
  { id: 'P5', kind: 'buffer', straight: 'south', side: 'outside', x: 0.2 },
  { id: 'A2', kind: 'pick', straight: 'south', side: 'outside', x: 3.6 },
  { id: 'P6', kind: 'buffer', straight: 'south', side: 'inside', x: 3.6 },
  { id: 'W', kind: 'wait', straight: 'north', side: 'inside', x: 5.3 },
  { id: 'L1', kind: 'charger', straight: 'north', side: 'inside', x: 1.9 },
  { id: 'V1', kind: 'drop', straight: 'north', side: 'outside', x: 1.9 },
  { id: 'L2', kind: 'charger', straight: 'north', side: 'inside', x: -1.5 },
  { id: 'V2', kind: 'drop', straight: 'north', side: 'outside', x: -1.5 },
];

/** Lane centre Z and travel direction (+1 = +X) of a straight. */
export function straightOf(s: Straight): { z: number; dir: 1 | -1 } {
  return s === 'south' ? { z: -COURSE.r, dir: 1 } : { z: COURSE.r, dir: -1 };
}

/** Outward normal (±Z) of a stich: south/outside and north/inside point to -Z. */
export function stichNormalZ(g: Pick<StationGeometry, 'straight' | 'side'>): 1 | -1 {
  const outward = g.straight === 'south' ? -1 : 1;
  return g.side === 'outside' ? outward : (-outward as 1 | -1);
}

/** Junction X on the lane (the arc meets the lane `arcR` downstream of the dock line). */
export function junctionX(g: StationGeometry): number {
  return g.x + straightOf(g.straight).dir * STICH.arcR;
}

/**
 * Handling pose of a station: vehicle root `root` (x, z) and its forward
 * heading `forwardZ` (±1, pointing back to the lane), the pallet seat `seat`
 * (x, z) one `FORK_SEAT_OFFSET_M` behind the root (fork side).
 */
export function handlingPose(g: StationGeometry): {
  root: [number, number]; forwardZ: 1 | -1; seat: [number, number];
} {
  const n = stichNormalZ(g);
  const zLane = straightOf(g.straight).z;
  const rootZ = zLane + n * STICH_DEPTH_M;
  const forwardZ = (-n) as 1 | -1;
  return { root: [g.x, rootZ], forwardZ, seat: [g.x, rootZ - forwardZ * FORK_SEAT_OFFSET_M] };
}

/**
 * Centre z (m) of the 3 m conveyor of a pick / drop station: the fork seat of
 * the stich stands on the pallet's hand-off pose (pick: belt end,
 * {@link CONVEYOR_END_SEAT_Z_M}) or on the head (drop, {@link CONVEYOR_HEAD_SEAT_Z_M}).
 * The conveyor's flow is local +Z in both cases.
 */
export function conveyorZOf(g: StationGeometry): number {
  const seatLocal = g.kind === 'pick' ? CONVEYOR_END_SEAT_Z_M : CONVEYOR_HEAD_SEAT_Z_M;
  return round(handlingPose(g).seat[1] - seatLocal);
}

/**
 * LOGICAL head pose of the conveyor of station `g` in the yard frame (m): the
 * pallet origin (its bottom centre) on the rollers at the head. Spawn pose of
 * the production source (pick) and set-down pose of a drop (plan-631 F2a) —
 * from the layout, never from a visual.
 */
export function headSeatOf(g: StationGeometry): [number, number, number] {
  return [g.x, CONVEYOR_SURFACE_M, conveyorZOf(g) + CONVEYOR_HEAD_SEAT_Z_M];
}

/** Path ids: dock straight `Stich_<id>` (zone K), its quarter arc / mouth `Stich_<id>_Arc` (zone M). */
export const stichPathId = (id: string): string => `Stich_${id}`;
export const stichArcId = (id: string): string => `Stich_${id}_Arc`;
/** Capacity-1 zone of a stich dock (K_i). */
export const stichZoneOf = (id: string): string => `Stich_${id}`;

/** One junction of a straight: the stations whose mouths join the lane there. */
export interface Junction {
  /** Junction id = the station ids joined by `_` (`A1_P1`, `P2`, …). */
  id: string;
  straight: Straight;
  /** Travel coordinate of the junction on its straight (u = dir · x). */
  u: number;
  stations: string[];
}

const _gapCoversBody = JUNCTION.gapM > VEHICLE_LENGTH_MM / 2000 + 0.1;
if (!_gapCoversBody) throw new Error('PalletYard layout: JUNCTION.gapM must exceed the body reach ahead of the root');

const straightName = (s: Straight): string => (s === 'south' ? 'South' : 'North');
/** Merge zone of a junction (M_i). */
export const mergeZoneOf = (junctionId: string): string => `Merge_${junctionId}`;
/** Lane pieces around a junction: `_In` before, `_Out` (merge piece, turn point at its end) after. */
export const junctionInId = (j: Pick<Junction, 'id' | 'straight'>): string => `${straightName(j.straight)}_${j.id}_In`;
export const junctionOutId = (j: Pick<Junction, 'id' | 'straight'>): string => `${straightName(j.straight)}_${j.id}_Out`;

/** Junctions of a straight in travel order (stations with the same junction X share one). */
export function junctionsOf(straight: Straight, geometry: readonly StationGeometry[] = STATION_GEOMETRY): Junction[] {
  const { dir } = straightOf(straight);
  const out: Junction[] = [];
  for (const g of geometry) {
    if (g.straight !== straight) continue;
    const u = Math.round(dir * junctionX(g) * 1e6) / 1e6;
    const j = out.find((x) => Math.abs(x.u - u) < 1e-6);
    if (j) j.stations.push(g.id); else out.push({ id: '', straight, u, stations: [g.id] });
  }
  for (const j of out) j.id = j.stations.join('_');
  return out.sort((a, b) => a.u - b.u);
}

/** Junction of station `id`. */
export function junctionOfStation(id: string, geometry: readonly StationGeometry[] = STATION_GEOMETRY): Junction {
  const g = geometry.find((x) => x.id === id);
  if (!g) throw new Error(`PalletYard: unknown station ${id}`);
  const j = junctionsOf(g.straight, geometry).find((x) => x.stations.includes(id));
  if (!j) throw new Error(`PalletYard: station ${id} has no junction`);
  return j;
}

/** Vehicle names (scene nodes) and their start on the lane (pieces without a zone). */
export const VEHICLES: ReadonlyArray<{ id: string; startPathId: string }> = [
  { id: 'Stapler_1', startPathId: 'West' },
  { id: 'Stapler_2', startPathId: 'East' },
  { id: 'Stapler_3', startPathId: 'West_4' },
];

/** Deceleration of the stackers (mm/s², the authored `Agv.Deceleration`) — also the fleet's hold check. */
export const VEHICLE_DECELERATION_MMS2 = 500;
/** Node paths inside a stacker asset: the lift drive and the fork anchor (carrier seat) below it. */
export const LIFT_NODE_PATH = 'Lift';
export const FORK_ANCHOR_NODE_PATH = 'Lift/ForkAnchor';

/**
 * `extras.realvirtual.Agv` of a stacker (written by the generator, used by the
 * test harness): reverse travel on, explicit body size (symmetric to the root),
 * scanner fields. `startMm` = StartPosition on the start path.
 */
export function agvConfigOf(vehicleId: string, startMm = 600): Record<string, number | boolean | string> {
  const v = VEHICLES.find((x) => x.id === vehicleId);
  if (!v) throw new Error(`PalletYard: unknown vehicle ${vehicleId}`);
  return {
    PathId: v.startPathId, StartPosition: startMm, TargetSpeed: PALLET_YARD_CONFIG.vehicle.travelSpeedMmS,
    Acceleration: 500, Deceleration: VEHICLE_DECELERATION_MMS2, LateralAcceleration: 500, SafetyGap: 300,
    DockingSpeed: 300, DockingDistance: 500,
    VehicleLength: VEHICLE_LENGTH_MM, VehicleWidth: VEHICLE_WIDTH_MM,
    AllowReverse: true, ReverseSpeed: PALLET_YARD_CONFIG.vehicle.reverseSpeedMmS,
    ScannerFields: true, ScannerReactionTime: 0.2, ProtectiveMargin: 200, WarningMargin: 1000,
  };
}

// ── Path graph ──────────────────────────────────────────────────────────────

/** One entry of the path graph (the rv_extras `Path` payload without the boilerplate). */
export interface PathGraphEntry {
  id: string;
  segments: SegmentSpec[];
  successors: string[];
  zone?: string;
  zoneCapacity?: number;
}

const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;

interface Piece { id: string; segs: SegmentSpec[]; zone: string | null }

/** Pieces of one straight in travel order: free stretches, and per junction `_In` + `_Out` in its merge zone. */
function straightPieces(geometry: readonly StationGeometry[], straight: Straight, xMin: number, xMax: number): Piece[] {
  const { z, dir } = straightOf(straight);
  const name = straightName(straight);
  const u0 = dir === 1 ? xMin : -xMax, u1 = dir === 1 ? xMax : -xMin; // travel coordinate u = dir·x
  const pieces: Piece[] = [];
  const seg = (a: number, b: number): SegmentSpec => line(dir * a, z, dir * b, z);
  let free = 0;
  let cursor = u0;
  for (const j of junctionsOf(straight, geometry)) {
    const a = r6(j.u - JUNCTION.preM), b = r6(j.u + JUNCTION.outM);
    // The free gap after the previous merge zone must hold the body reach ahead of the root.
    const gapNeed = pieces.some((p) => p.zone) ? JUNCTION.gapM - 1e-9 : 0;
    if (a - cursor < gapNeed || b > u1 + 1e-9) throw new Error(`junction ${j.id}: merge zone too close to its neighbour / the course end`);
    if (a - cursor > 1e-6) pieces.push({ id: `${name}_${++free}`, segs: [seg(cursor, a)], zone: null });
    pieces.push({ id: junctionInId(j), segs: [seg(a, j.u)], zone: mergeZoneOf(j.id) });
    pieces.push({ id: junctionOutId(j), segs: [seg(j.u, b)], zone: mergeZoneOf(j.id) });
    cursor = b;
  }
  if (u1 - cursor > 1e-6) pieces.push({ id: `${name}_${++free}`, segs: [seg(cursor, u1)], zone: null });
  return pieces;
}

/** Stich of one station: the straight dock from the handling position, then the quarter arc (mouth) into the lane. */
function stichSpecs(g: StationGeometry): { straight: SegmentSpec; arc: SegmentSpec } {
  const { z: zL, dir } = straightOf(g.straight);
  const n = stichNormalZ(g);
  const { arcR, straightM } = STICH;
  const straight = line(g.x, zL + n * STICH_DEPTH_M, g.x, zL + n * arcR);
  const cx = g.x + dir * arcR, cz = zL + n * arcR;
  const a0 = Math.atan2(zL + n * arcR - cz, g.x - cx) * 180 / Math.PI;
  const a1 = Math.atan2(zL - cz, junctionX(g) - cx) * 180 / Math.PI;
  const sweep = ((a1 - a0 + 540) % 360) - 180;
  if (Math.abs(Math.abs(sweep) - 90) > 1e-9 || Math.abs(straightM - (STICH_DEPTH_M - arcR)) > 1e-9) {
    throw new Error(`stich ${g.id}: bad geometry`);
  }
  return { straight, arc: arc(cx, cz, arcR, a0, sweep) };
}

/**
 * The full path graph with split zones (see the module doc):
 * `[{ id, segments, successors, zone?, zoneCapacity? }]`.
 */
export function composeGraph(geometry: readonly StationGeometry[], xMin: number, xMax: number): PathGraphEntry[] {
  const { r } = COURSE;
  const loop: Piece[] = [
    ...straightPieces(geometry, 'south', xMin, xMax),
    { id: 'East', segs: [arc(xMax, 0, r, -90, 180)], zone: null },
    ...straightPieces(geometry, 'north', xMin, xMax),
    { id: 'West', segs: [arc(xMin, 0, r, 90, 180)], zone: null },
  ];
  const paths: Record<string, SegmentSpec[]> = {};
  const successors: Record<string, string[]> = {};
  loop.forEach((p, i) => {
    paths[p.id] = p.segs;
    successors[p.id] = [loop[(i + 1) % loop.length].id];
  });
  const zones = new Map<string, string>();
  for (const p of loop) if (p.zone) zones.set(p.id, p.zone);
  for (const g of geometry) {
    const { straight, arc: arcSpec } = stichSpecs(g);
    const j = junctionsOf(g.straight, geometry).find(j => j.stations.includes(g.id))!;
    paths[stichPathId(g.id)] = [straight];
    paths[stichArcId(g.id)] = [arcSpec];
    successors[stichPathId(g.id)] = [stichArcId(g.id)];
    successors[stichArcId(g.id)] = [junctionOutId(j)];
    zones.set(stichPathId(g.id), stichZoneOf(g.id));
    zones.set(stichArcId(g.id), mergeZoneOf(j.id));
  }
  const graph: PathGraphEntry[] = buildGraph(paths, successors, {
    maxPiece: COURSE.maxPieceM, keepWhole: /^Stich_|_In$|_Out$/,
  }).graph;
  for (const p of graph) {
    const zone = zones.get(p.id);
    if (zone) { p.zone = zone; p.zoneCapacity = 1; }
  }
  return graph;
}

/** Legacy graph using the fixed station geometry and course bounds. */
export function buildPathGraph(): PathGraphEntry[] {
  return composeGraph(STATION_GEOMETRY, -COURSE.xEnd, COURSE.xEnd);
}

/** Turn piece (merge piece — its END is the turn point) of a station's stich. */
export const turnPathOf = (stationId: string, geometry: readonly StationGeometry[] = STATION_GEOMETRY): string =>
  junctionOutId(junctionOfStation(stationId, geometry));

// ── Project configuration (extras.realvirtual.PalletYard) ──────────────────

export interface PalletYardStation {
  /** 'A1' | 'A2' | 'V1' | 'V2' | 'P1'..'P6' | 'L1' | 'L2'. */
  id: string;
  kind: 'pick' | 'drop' | 'buffer' | 'charger';
  /** Stich dock segment (path id). */
  pathId: string;
  /** Node path of the conveyor (pick/drop) or of the floor slot (buffer). */
  conveyor?: string;
  slot?: string;
  /** Lift position (mm) at which the fork top touches the pallet's carrying face. */
  handlingHeightMm: number;
  /** Reverse run into the stich (m) — equal for the way out. */
  stichLengthM: number;
}

export interface PalletYardConfig {
  /** Retrieval rule, default 'legacy-fifo' until plan-559 Phase 8 switches the default. */
  retrieval?: RetrievalRuleName;
  stations: PalletYardStation[];
  /** Wait point in front of the chargers (path id). */
  waitPointPathId: string;
  /** Vehicle node names, in the order of `battery.startSoc`. */
  vehicles: string[];
  /** Production takt per output (s) and first release (s) per output (A1, A2). */
  production: {
    intervalSec: number; phaseSec: number[];
    /**
     * Interval per output (s) when the load differs per output (plan-630 §2.13,
     * planning parameter `production.<A>.ratePerHour`); `Infinity` = 0 pallets/h
     * (disabled). Absent = `intervalSec` for every output.
     */
    intervalPerOutput?: number[];
    /**
     * Stochastic takt (plan-2051, `TaktPlan.stochastic`): intervals drawn exponentially
     * around the configured interval from the run's seeded RNG. Absent/false = fixed takt.
     */
    stochastic?: boolean;
  };
  /** Shipping input pauses: every `everySec` for `durationSec`, offset per input (V1, V2). */
  shippingPauses: { everySec: number; durationSec: number; offsetSec: number[] };
  vehicle: {
    travelSpeedMmS: number; reverseSpeedMmS: number;
    liftSpeedLoadedMmS: number; liftSpeedEmptyMmS: number;
    /** Fork height during travel (mm). */
    travelHeightMm: number;
    /** Approach below / lift above the handling height (mm). */
    handlingDeltaMm: number;
  };
  battery: {
    /** Per vehicle, staggered (%). */
    startSoc: number[];
    /** Percentage points per minute of driving / per metre of lift / per minute standing. */
    drivePerMin: number; liftPerM: number; idlePerMin: number;
    threshold: number; target: number; chargePerMin: number;
    /** Percentage points always kept for the way to the charger (floor of the computed need). */
    reserveToCharger: number;
    /** Factor on the lane route time (default 1.5). */
    travelSlack: number;
    /** Assumed maximum wait at an occupied charger (s). */
    chargerWaitReserveSec: number;
  };
}

const CONVEYOR_H = handlingHeightMm(CONVEYOR_SURFACE_M);
const FLOOR_H = handlingHeightMm(0);

/** Scene node names of the stations' equipment. */
export const conveyorNodeOf = (id: string): string => `Conveyor_${id}`;
/** The 2 m conveyor behind shipping input `id` (V1, V2) — between the input conveyor and the sink. */
export const conveyorOutNodeOf = (id: string): string => `ConveyorOut_${id}`;
export const slotNodeOf = (id: string): string => `Slot_${id}`;

function stationConfig(g: StationGeometry): PalletYardStation {
  if (g.kind === 'wait') throw new Error('the wait point is not a station');
  const base = { id: g.id, kind: g.kind, pathId: stichPathId(g.id), stichLengthM: STICH_LENGTH_M };
  if (g.kind === 'pick' || g.kind === 'drop') return { ...base, conveyor: conveyorNodeOf(g.id), handlingHeightMm: CONVEYOR_H };
  if (g.kind === 'buffer') return { ...base, slot: slotNodeOf(g.id), handlingHeightMm: FLOOR_H };
  return { ...base, handlingHeightMm: 0 };
}

/** The project configuration — Startwerte of plan-612 §2.3. */
export const PALLET_YARD_CONFIG: PalletYardConfig = {
  stations: STATION_GEOMETRY.filter((g) => g.kind !== 'wait').map(stationConfig),
  waitPointPathId: stichPathId('W'),
  vehicles: VEHICLES.map((v) => v.id),
  production: { intervalSec: 90, phaseSec: [0, 45] },
  shippingPauses: { everySec: 1200, durationSec: 300, offsetSec: [300, 900] },
  vehicle: {
    travelSpeedMmS: 1200, reverseSpeedMmS: 300,
    liftSpeedLoadedMmS: 150, liftSpeedEmptyMmS: 300,
    travelHeightMm: 150, handlingDeltaMm: 30,
  },
  battery: {
    startSoc: [90, 70, 50],
    drivePerMin: 1.2, liftPerM: 0.05, idlePerMin: 0.2,
    threshold: 30, target: 80, chargePerMin: 5,
    reserveToCharger: 5, travelSlack: 1.5, chargerWaitReserveSec: 600,
  },
};

/**
 * Document paths of the component-less nodes of the MAIN MODEL the PalletYard
 * runtime needs (plan-754 D17): the six floor slots. Without a claim the
 * destructive bake drops them. ONE list, two guards: the generator writes
 * `rv.BakeRole: 'merge'` onto each of these nodes (authored — survives a bake
 * that runs before the model plugin is loaded, as the viewer's planner-deferred
 * load does), and the plugin hands the same list to the bake as `bakeClaims()`.
 *
 * Since CP1d-b the stackers and conveyors are PLACEMENTS (library references): a
 * plugin claim cannot reach into a placement (plan-757 D5 — it would only be a
 * `plugin-claim-not-applicable` entry). What the runtime needs there is kept by
 * the library asset itself: `Lift/ForkAnchor` carries an authored
 * `rv.BakeRole: 'merge'` in AGVStacker.glb (b1-0), the conveyor belt
 * `Transport-Z` is a `mover:` chunk and `Sensor` survives through the Conveyor
 * behaviour's own claims (measured in pallet-yard-placements.test.ts).
 */
export function palletYardClaimPaths(cfg: PalletYardConfig = PALLET_YARD_CONFIG, rootName = 'PalletYardRoot'): string[] {
  const out: string[] = [];
  for (const s of cfg.stations) {
    if (s.kind === 'buffer') out.push(`${rootName}/${s.slot ?? slotNodeOf(s.id)}`);
  }
  return out;
}

/** Bake role of a claimed path — every main-model claim only has to survive: merge. */
export function palletYardBakeRoleOf(_path: string): 'merge' | 'chunk' {
  return 'merge';
}

// ── Placements (CP1d-b) ─────────────────────────────────────────────────────

/** A library asset the scene places by reference (`extras.realvirtual.AssetReference`). */
export interface LibraryAsset {
  /** Document id of the realvirtual library project (public/library/project.json). */
  assetId: string;
  /** The planner's path form — re-rooted onto the deploy's BASE_URL (`rebaseLocalLibraryUrl`). */
  path: string;
}

/** The library assets placed as instances: the stacker and the two conveyor lengths. */
export const LIBRARY_ASSETS: Readonly<Record<'stacker' | 'conveyor3m' | 'conveyor2m', LibraryAsset>> = {
  stacker: { assetId: 'mobilerobots-agvstacker', path: '/library/MobileRobots/AGVStacker.glb' },
  conveyor3m: { assetId: 'pallethandling-rollconveyor-3m', path: '/library/PalletHandling/RollConveyor-3m.glb' },
  conveyor2m: { assetId: 'pallethandling-rollconveyor-2m', path: '/library/PalletHandling/RollConveyor-2m.glb' },
};

/**
 * Extras key on a conveyor REFERENCE node naming its station and stich
 * (`extras.realvirtual.PalletYardStation = { Station, StichPathId }`). The stich
 * is a Path-Id STRING, resolved late against the PathNetwork by the plugin
 * (plan-559 M2 (3)) — never a ComponentReference from the layout into a
 * placement (559 M1, #209).
 */
export const STATION_TAG_KEY = 'PalletYardStation';

export interface StationTag {
  /** Station id (`A1`, `V2`, …). */
  Station: string;
  /** Path id of the station's stich dock. */
  StichPathId: string;
}

/** The tag the generator writes onto the conveyor reference of station `s`. */
export function stationTagOf(s: Pick<PalletYardStation, 'id' | 'pathId'>): StationTag {
  return { Station: s.id, StichPathId: s.pathId };
}

/** `PalletYardStation` tag of a node (a conveyor reference), or null. */
export function readStationTag(n: { userData?: Record<string, unknown> }): StationTag | null {
  const t = (n.userData?.realvirtual as Record<string, unknown> | undefined)?.[STATION_TAG_KEY] as Partial<StationTag> | undefined;
  return t && typeof t.Station === 'string' && typeof t.StichPathId === 'string' ? { Station: t.Station, StichPathId: t.StichPathId } : null;
}

/** Stations of one kind, in configuration order. */
export function stationsOf(cfg: PalletYardConfig, kind: PalletYardStation['kind']): PalletYardStation[] {
  return cfg.stations.filter((s) => s.kind === kind);
}
