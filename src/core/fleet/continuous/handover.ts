// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Continuous fleet hand-over and kernel adapters: real roller conveyors moved
 * by the transport manager, conveyor end sensors, sources and vehicle docks.
 * Scene records and the pallet seat depth are supplied by the caller.
 *
 * - **Production** ({@link ContinuousHandover.produce}): one RISING EDGE of
 *   `GenerateMU` on the output's `Source` (`Pallet_<output>`, automatic and
 *   interval generation switched off at bind). `produce()` answers `true` =
 *   the edge was ACCEPTED (head free, no trigger open, G3); the production has
 *   happened only when the source spawned the MU. The edge is HIGH for exactly
 *   one source update and LOW for at least one more before the next trigger. No
 *   spawn within one tick after LOW → counted ({@link spawnFailures}) and a
 *   Problems entry {@link SPAWN_PROBLEM_CODE}; it never vanishes silently.
 * - **Ready to pick**: the output conveyor stops at its own end sensor (no
 *   successor → its ZPA interlock is "occupied"); the sensor's `occupiedMU`
 *   becoming the pallet on that belt is the event `onPalletReady` (DES: the end
 *   probe). A vehicle docked before the arrival takes it at the arrival.
 * - **Pick** ({@link holdMU} with owner `'grip'` on `ForkAnchor`, G1): the world
 *   pose is kept — no jump. The sensor stops the pallet 44 mm before the DES
 *   hand-off pose the fork seat is laid out for (sensor at local z 0.8, DES
 *   end seat 0.844, layout.ts), so the held pallet then GLIDES onto the fork's
 *   seat (centred, square, its COLLIDER bottom palletSeatM below the fork
 *   top) by at most {@link SEAT_GLIDE_STEP_M} per tick — continuous, never a
 *   jump; the drop then lands on the DES head pose (x/z; the height differs by
 *   the library pallet's collider offset, 4.4 mm — parity test 9.7).
 * - **Drop** ({@link putOnHead}, §2.4 Rueckabwicklung, G1): pre-check with
 *   `checkPlacement` while the pallet is still held (refused → nothing changes);
 *   then `detachMU` + `placeMUOnSurface` at the pallet's own collider centre (no
 *   x/z jump, the height correction is measured by the tests, G2). A refusal
 *   AFTER the detach restores the hold AND the saved local seat pose; the
 *   vehicle stays in the dock. A refused drop is retried every
 *   {@link DROP_RETRY_SEC} sim seconds while it stays refused (G2: never a
 *   permanent wait); a head that becomes free retries at once (`onInputFreed`).
 * - **Shipping pause**: `<input conveyor>.Flow.Run` (per placement). At the pause
 *   end the belt runs again and carries the parked pallet on by itself.
 * - **Floor slots**: the pallet is set down as a FREE MU under its neutral parent
 *   (world pose kept), occupancy lives in the fleet core (`StorageGroup`); a retrieve
 *   holds it again (and glides it onto the seat).
 * - **Clock** (E3): the fleet core's `ContinuousSimClock`, advanced once per
 *   fixed tick in {@link tick} (`TickStage.POST` via {@link ContinuousHandover.attach}) to the viewer's
 *   sim time; the lift is {@link ContinuousLift}. A sim time that went backwards
 *   is a restart ({@link onClockRestart}).
 *
 * {@link tick} allocates nothing: arrays of preallocated per-station records,
 * index loops, module scratch vectors.
 */

import { Quaternion, Vector3 } from 'three';
import type { Object3D } from 'three';
import type { RVTransportManager } from '@rv/core/engine/rv-transport-manager';
import type { RVTransportSurface } from '@rv/core/engine/rv-transport-surface';
import type { RVSensor } from '@rv/core/engine/rv-sensor';
import type { RVSink } from '@rv/core/engine/rv-sink';
import type { InstancedMovingUnit, RVMovingUnit } from '@rv/core/engine/rv-mu';
import { getMuSource, type RVSource } from '@rv/core/engine/rv-source';
import { detachMU, holdMU, sceneRootOf } from '@rv/core/engine/rv-mu-hold';
import {
  checkPlacement, createPlacementCheck, placeMUOnSurface, type PlaceOptions, type PlaceResult, type Refusal,
} from '@rv/core/engine/rv-mu-manipulation';
import { ContinuousSimClock } from '@rv/core/fleet/core/sim-clock';
import { ContinuousLift, type ContinuousLiftDrive } from '@rv/core/fleet/continuous/lift';
import type { FleetKernelAdapters, HandoverBackend, PickWait } from '@rv/core/fleet/exec/backends';
import { clearProblem, reportProblem } from '@rv/core/hmi/problems-store';
import type { SimLoopFacade } from '@rv/core/rv-plugin-context';
import { TickStage } from '@rv/core/rv-tick-stages';

/** Problems code: a takt edge on a production source spawned no pallet (id suffix = output). */
export const SPAWN_PROBLEM_CODE = 'pallet-yard-spawn-missing';
/** Largest seat correction per fixed tick while a held pallet glides onto the fork seat (m). */
export const SEAT_GLIDE_STEP_M = 0.001;
/** Largest rotation correction per fixed tick of that glide (rad). */
export const SEAT_GLIDE_STEP_RAD = 0.25 * Math.PI / 180;
/** Sim seconds between two attempts of a refused drop (the head may stay "free" for the input check). */
export const DROP_RETRY_SEC = 1;

type AnyMU = RVMovingUnit | InstancedMovingUnit;

/** Spawn edge state of one production source (G3). */
type Edge = 'idle' | 'high' | 'settle' | 'missing';

export interface OutputRec {
  readonly id: string;
  readonly node: Object3D;
  readonly surfaces: RVTransportSurface[];
  readonly sensor: RVSensor;
  readonly source: RVSource;
  /** The pallet on this output conveyor (DES: capacity 1 — at most one), null = none. */
  onBelt: RVMovingUnit | null;
  /** `onBelt` reached the end sensor (onPalletReady was reported / the pick is possible). */
  arrived: boolean;
  edge: Edge;
  createdAtEdge: number;
  waiterVehicle: string | null;
  waiterCb: PickWait | null;
}

export interface InputRec {
  readonly id: string;
  readonly node: Object3D;
  readonly surfaces: RVTransportSurface[];
  readonly runSignal: string;
  wasFree: boolean;
  /** A refused drop asked for a retry (clock event pending). */
  retryArmed: boolean;
}

export interface VehicleRec {
  readonly id: string;
  readonly root: Object3D;
  readonly anchor: Object3D;
  carried: RVMovingUnit | null;
  /** The held pallet still glides onto the logical fork seat. */
  gliding: boolean;
  /** Local seat the glide ends on: collider bottom palletSeatM below the fork top, centred, square. */
  readonly seatTarget: Vector3;
  /** Local seat pose of the held pallet (the rollback restores it, G1). */
  readonly seatPos: Vector3;
  readonly seatQuat: Quaternion;
}

export interface SlotRec { readonly id: string; readonly node: Object3D; mu: RVMovingUnit | null }

/** Counters of the continuous backend (tests, MU balance). */
export interface ContinuousCounters {
  /** Takt edges accepted (`produce()` = true). */
  edges: number;
  /** Pallets the sources really spawned on an edge — the production of the MU balance. */
  spawned: number;
  /** Edges without a spawn (G3). */
  spawnFailures: number;
  /** Drops refused by the placement check (before or after the detach). */
  dropsRefused: number;
  /** Drops rolled back after the detach (hold + seat pose restored). */
  rollbacks: number;
}

// Scratch (no GC in the tick / per hand-over).
const _point = new Vector3();
const _identity = new Quaternion();
const _check = createPlacementCheck();

/**
 * A pallet set down on the floor has left the conveyors for good: clear the
 * latched transport state the end-of-line vanish keys on (`everOnSurface`,
 * `onLayoutObject`, `lastSurface` — what `placeMUOnSurface` resets too), so a
 * stored pallet is never taken for one that ran off a belt end.
 */
function forgetConveyor(mu: RVMovingUnit): void {
  mu.currentSurface = null;
  mu.lastSurface = null;
  mu.lastSurfaceTickId = undefined;
  mu.everOnSurface = undefined;
  mu.onLayoutObject = undefined;
  mu.offSurfaceTime = undefined;
}

/** Continuous backend — see the module doc. */
export class ContinuousHandover implements HandoverBackend, FleetKernelAdapters {
  readonly kind = 'continuous' as const;
  readonly clock: ContinuousSimClock;
  readonly lift: ContinuousLift;
  onPalletReady: ((output: string, pallet: string) => void) | null = null;
  onInputFreed: ((input: string) => void) | null = null;
  /** The viewer's sim time went backwards without a `simulation-start` (the plugin restarts the yard). */
  onClockRestart: (() => void) | null = null;
  readonly counters: ContinuousCounters = { edges: 0, spawned: 0, spawnFailures: 0, dropsRefused: 0, rollbacks: 0 };
  /** Consumed pallet ids per shipping input (the sinks' own consume events). */
  readonly shipped: Record<string, number[]> = {};
  /** Why the last drop was refused (diagnostics, tests), null = none yet. */
  lastRefusal: string | null = null;
  /** Test seam: the placement call of a drop (default `placeMUOnSurface`). */
  placeImpl: (tm: RVTransportManager, mu: AnyMU, point: Vector3, opts: PlaceOptions) => PlaceResult | Refusal = placeMUOnSurface;

  private readonly outputById = new Map<string, OutputRec>();
  private readonly inputById = new Map<string, InputRec>();
  private readonly vehicleById = new Map<string, VehicleRec>();
  private readonly slotById = new Map<string, SlotRec>();
  private readonly ourSources = new Set<RVSource>();
  private readonly sinkUnsubs: Array<() => void> = [];
  private disposed = false;

  constructor(
    readonly root: Object3D,
    readonly tm: RVTransportManager,
    private readonly simTime: () => number,
    private readonly signals: { set(name: string, value: boolean): void } | null,
    private readonly outputs: OutputRec[],
    private readonly inputs: InputRec[],
    private readonly vehicles: VehicleRec[],
    lifts: ReadonlyMap<string, ContinuousLiftDrive>,
    private readonly slots: SlotRec[],
    sinks: ReadonlyArray<{ input: string; sink: RVSink }>,
    private readonly palletSeatM: number,
  ) {
    this.clock = new ContinuousSimClock(simTime());
    this.lift = new ContinuousLift(lifts, this.clock);
    for (const o of outputs) { this.outputById.set(o.id, o); this.ourSources.add(o.source); }
    for (const i of inputs) { this.inputById.set(i.id, i); this.shipped[i.id] = []; }
    for (const v of vehicles) this.vehicleById.set(v.id, v);
    for (const s of slots) this.slotById.set(s.id, s);
    for (const { input, sink } of sinks) {
      const list = this.shipped[input];
      this.sinkUnsubs.push(sink.subscribeConsumed((mu) => { if (!this.disposed) list.push(mu.id); }));
    }
    this.configureSources();
  }

  /** Subscribe after the engine moved drives, MUs and sensors. */
  attach(simLoop: SimLoopFacade): () => void {
    return simLoop.onTick(TickStage.POST, () => this.tick());
  }

  /** G3: no automatic and no interval generation — only the plugin's edges spawn. */
  private configureSources(): void {
    for (const o of this.outputs) {
      o.source.AutomaticGeneration = false;
      o.source.Interval = 0;
      o.source.GenerateMU = false;
    }
  }

  // ── Read access (tests, diagnostics) ──────────────────────────────────────

  outputConveyor(output: string): Object3D | null { return this.outputById.get(output)?.node ?? null; }
  inputConveyor(input: string): Object3D | null { return this.inputById.get(input)?.node ?? null; }
  sourceOf(output: string): RVSource | null { return this.outputById.get(output)?.source ?? null; }
  /** The pallet on output `output`'s conveyor (not yet picked), or null. */
  palletOnOutput(output: string): RVMovingUnit | null { return this.outputById.get(output)?.onBelt ?? null; }
  /** The pallet MU on the fork of `vehicle`, or null. */
  carriedMU(vehicle: string): RVMovingUnit | null { return this.vehicleById.get(vehicle)?.carried ?? null; }
  /** The pallet MU on floor slot `slot`, or null. */
  slotMU(slot: string): RVMovingUnit | null { return this.slotById.get(slot)?.mu ?? null; }
  /** The fork anchor of `vehicle`. */
  anchorOf(vehicle: string): Object3D | null { return this.vehicleById.get(vehicle)?.anchor ?? null; }
  /** The scoped `Flow.Run` signal name of input `input`'s conveyor. */
  inputRunSignal(input: string): string | null { return this.inputById.get(input)?.runSignal ?? null; }
  /** True while the held pallet of `vehicle` still glides onto the fork seat. */
  isGliding(vehicle: string): boolean { return this.vehicleById.get(vehicle)?.gliding ?? false; }
  /** Live pallets of the yard's sources (on belts, forks, slots, in the shipping lines). */
  livePallets(): number {
    let n = 0;
    for (const mu of this.tm.mus) if (!mu.markedForRemoval && this.isOurs(mu)) n++;
    return n;
  }

  private isOurs(mu: AnyMU): boolean {
    const src = getMuSource(mu);
    return !!src && this.ourSources.has(src);
  }

  /** The kernel adapters' hand-over half — this backend itself. */
  get handover(): HandoverBackend { return this; }

  // ── HandoverBackend ───────────────────────────────────────────────────────

  /** Takt edge at `output` — `true` = accepted (G3); the pallet exists once the source spawned it. */
  produce(output: string): boolean {
    const o = this.outputById.get(output);
    if (!o || !this.headFree(output)) return false;
    o.createdAtEdge = o.source.Created;
    o.source.GenerateMU = true;       // HIGH — the next source update spawns
    o.edge = 'high';
    this.counters.edges++;
    return true;
  }

  /** The output takes a new pallet: none on its conveyor and no edge open (DES: capacity 1). */
  headFree(output: string): boolean {
    const o = this.outputById.get(output);
    return !!o && o.edge === 'idle' && o.onBelt === null;
  }

  private pickHandler: (output: string, wait: PickWait, mu: string) => void = () => {};
  setPickHandler(handler: (output: string, wait: PickWait, mu: string) => void): (output: string, wait: PickWait, mu: string) => void {
    const previous = this.pickHandler;
    this.pickHandler = handler;
    return previous;
  }

  awaitPick(output: string, vehicle: string, wait: PickWait): void {
    const o = this.outputById.get(output);
    if (!o || !this.vehicleById.has(vehicle)) return;
    if (o.onBelt && o.arrived) { this.pick(o, vehicle, wait); return; }
    o.waiterVehicle = vehicle;
    o.waiterCb = wait;
  }

  cancelPick(output: string, vehicle: string): void {
    const o = this.outputById.get(output);
    if (!o || o.waiterVehicle !== vehicle) return;
    o.waiterVehicle = null;
    o.waiterCb = null;
  }

  /** No pallet (other than a held one) on the input conveyor's surfaces. */
  inputFree(input: string): boolean {
    const i = this.inputById.get(input);
    return !!i && !this.surfaceTaken(i.surfaces);
  }

  putOnHead(vehicle: string, input: string): boolean {
    const v = this.vehicleById.get(vehicle);
    const i = this.inputById.get(input);
    const mu = v?.carried ?? null;
    if (!v || !i || !mu) return false;
    // World matrices of the vehicle subtree are refreshed by the render pass only
    // (static baked nodes below the moving root): refresh before reading poses.
    v.root.updateMatrixWorld(true);
    // The drop point: the pallet's own collider centre — no x/z jump (G2).
    mu.updateAABB();
    _point.copy(mu.aabb.center);
    // Pre-check while still held: a refusal changes nothing (G1).
    const surface = this.surfaceUnder(i.surfaces, _point);
    const check = surface ? checkPlacement(this.tm, mu, _point, { surface }, _check) : null;
    if (!check || !check.ok) {
      this.lastRefusal = check ? `${check.reason}` : `no surface of ${i.node.name} under the pallet centre `
        + `(${_point.x.toFixed(3)}, ${_point.z.toFixed(3)})`;
      this.refused(i);
      return false;
    }
    v.seatPos.copy(mu.node.position);
    v.seatQuat.copy(mu.node.quaternion);
    detachMU(mu, 'grip', this.neutralParent(mu));
    const r = this.placeImpl(this.tm, mu, _point, { surface });
    if (!r.ok) {
      // Roll back: hold AND seat pose (G1); the vehicle stays in the dock.
      holdMU(mu, v.anchor, 'grip');
      mu.node.position.copy(v.seatPos);   // the exact seat pose of before the detach
      mu.node.quaternion.copy(v.seatQuat);
      mu.node.updateMatrixWorld(true);
      this.counters.rollbacks++;
      this.lastRefusal = r.reason;
      console.warn(`[PalletYard] ${vehicle}: drop on ${input} refused (${r.reason}) — pallet back on the fork`);
      this.refused(i);
      return false;
    }
    v.carried = null;
    v.gliding = false;
    i.wasFree = false;
    return true;
  }

  setInputRun(input: string, run: boolean): void {
    const i = this.inputById.get(input);
    if (i) this.signals?.set(i.runSignal, run);
  }

  store(vehicle: string, slot: string): boolean {
    const v = this.vehicleById.get(vehicle);
    const s = this.slotById.get(slot);
    const mu = v?.carried ?? null;
    if (!v || !s || !mu || s.mu) return false;
    v.root.updateMatrixWorld(true);
    detachMU(mu, 'grip', this.neutralParent(mu));   // a free MU where the fork set it down
    forgetConveyor(mu);
    mu.updateAABB();
    s.mu = mu;
    v.carried = null;
    v.gliding = false;
    return true;
  }

  retrieve(slot: string, vehicle: string): string | null {
    const v = this.vehicleById.get(vehicle);
    const s = this.slotById.get(slot);
    const mu = s?.mu ?? null;
    if (!v || !s || !mu || v.carried) return null;
    s.mu = null;
    this.take(v, mu);
    return String(mu.id);
  }

  carried(vehicle: string): string | null {
    const mu = this.vehicleById.get(vehicle)?.carried;
    return mu ? String(mu.id) : null;
  }

  onSlot(slot: string): string | null {
    const mu = this.slotById.get(slot)?.mu;
    return mu ? String(mu.id) : null;
  }

  /** Holds are parented — nothing to re-seat (the glide runs in {@link tick}). */
  reconcile(): number { return 0; }

  vehicleNode(vehicle: string): Object3D | null { return this.vehicleById.get(vehicle)?.root ?? null; }

  /** Before the engine reset: no pallet may stay parented to a fork. */
  releaseVisuals(): void {
    for (const v of this.vehicles) {
      const mu = v.carried;
      if (mu && mu.node.parent === v.anchor) { v.root.updateMatrixWorld(true); detachMU(mu, 'grip', this.neutralParent(mu)); }
    }
  }

  /**
   * After the engine reset (and at every start / rebind): holds released, the
   * yard's pallets of a previous run removed (G4: no rest MUs), the edges low,
   * the lift strokes stopped, the clock at the current sim time.
   */
  resetState(): void {
    this.releaseVisuals();
    for (let k = this.tm.mus.length - 1; k >= 0; k--) {
      const mu = this.tm.mus[k];
      if (!mu.markedForRemoval && this.isOurs(mu)) this.tm.removeMU(mu, false);
    }
    this.configureSources();
    for (const o of this.outputs) {
      o.onBelt = null; o.arrived = false; o.edge = 'idle'; o.waiterVehicle = null; o.waiterCb = null;
      clearProblem(`${SPAWN_PROBLEM_CODE}:${o.id}`);
    }
    for (const i of this.inputs) { i.wasFree = true; i.retryArmed = false; this.signals?.set(i.runSignal, true); }
    for (const v of this.vehicles) { v.carried = null; v.gliding = false; }
    for (const s of this.slots) s.mu = null;
    for (const l of Object.values(this.shipped)) l.length = 0;
    Object.assign(this.counters, { edges: 0, spawned: 0, spawnFailures: 0, dropsRefused: 0, rollbacks: 0 });
    this.lift.clear();
    this.clock.reset(this.simTime());
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseVisuals();
    for (const v of this.vehicles) { v.carried = null; v.gliding = false; }
    for (const o of this.outputs) { o.source.GenerateMU = false; o.waiterCb = null; o.waiterVehicle = null; }
    for (const u of this.sinkUnsubs) { try { u(); } catch { /* ignore */ } }
    this.sinkUnsubs.length = 0;
    this.lift.clear();
    this.clock.dispose();
  }

  // ── Per fixed tick (TickStage.POST) ─────────────────────────────

  /**
   * Once per fixed tick, after the engine moved drives, MUs and sensors: lift
   * ends, source edges, arrivals at the end sensors, freed inputs, the seat
   * glide, then the clock to the viewer's sim time. Allocation-free.
   */
  tick(): void {
    if (this.disposed) return;
    const t = this.simTime();
    if (t < this.clock.now() - 1e-9) { this.onClockRestart?.(); if (this.disposed) return; }
    this.lift.tick();
    for (let k = 0; k < this.outputs.length; k++) this.tickOutput(this.outputs[k]);
    for (let k = 0; k < this.inputs.length; k++) {
      const i = this.inputs[k];
      const free = !this.surfaceTaken(i.surfaces);
      if (free && !i.wasFree) { i.wasFree = true; this.onInputFreed?.(i.id); } else i.wasFree = free;
    }
    for (let k = 0; k < this.vehicles.length; k++) {
      const v = this.vehicles[k];
      if (v.gliding && v.carried) this.glide(v, v.carried);
    }
    this.clock.advanceTo(t);
  }

  private tickOutput(o: OutputRec): void {
    switch (o.edge) {
      case 'high':
        // The HIGH reached one source update: LOW now, before any next trigger (G3).
        o.source.GenerateMU = false;
        if (this.adoptSpawn(o)) o.edge = 'settle'; else o.edge = 'missing';
        break;
      case 'settle':
        o.edge = 'idle';   // the LOW reached one source update too
        break;
      case 'missing':
        if (!this.adoptSpawn(o)) {
          this.counters.spawnFailures++;
          const what = `takt edge at Pallet_${o.id}: the source spawned no pallet (Created ${o.source.Created}, `
            + `enabled ${o.source.Enabled}, live MUs ${this.tm.mus.length})`;
          console.warn(`[PalletYard] ${what}`);
          reportProblem({
            id: `${SPAWN_PROBLEM_CODE}:${o.id}`, severity: 'warning', code: SPAWN_PROBLEM_CODE,
            title: `PalletYard: production ${o.id} spawned no pallet`,
            detail: `${what}. The takt goes on; the missed pallet is not counted as produced.`,
          });
        }
        o.edge = 'idle';
        break;
      default:
        break;
    }
    const mu = o.onBelt;
    // The output end IS a dead end on a layout object (the forklift takes the pallet
    // there): keep the engine's end-of-line vanish (Layout-Planner switch, 2 s dwell)
    // away from a pallet the yard waits to pick.
    if (mu) mu.offSurfaceTime = 0;
    if (mu && !o.arrived && o.sensor.occupied && o.sensor.occupiedMU === mu) {
      o.arrived = true;
      const vehicle = o.waiterVehicle;
      const cb = o.waiterCb;
      if (vehicle && cb) this.pick(o, vehicle, cb);
      else this.onPalletReady?.(o.id, String(mu.id));
    }
  }

  /** The MU the source spawned since the edge (newest first), or false. */
  private adoptSpawn(o: OutputRec): boolean {
    if (o.source.Created <= o.createdAtEdge) return false;
    const mus = this.tm.mus;
    for (let k = mus.length - 1; k >= 0; k--) {
      const mu = mus[k];
      if (mu.isInstanced || getMuSource(mu) !== o.source || mu === o.onBelt) continue;
      o.onBelt = mu as RVMovingUnit;
      o.arrived = false;
      o.createdAtEdge = o.source.Created;
      this.counters.spawned++;
      clearProblem(`${SPAWN_PROBLEM_CODE}:${o.id}`);
      return true;
    }
    return false;
  }

  private pick(o: OutputRec, vehicle: string, wait: PickWait): void {
    const v = this.vehicleById.get(vehicle);
    const mu = o.onBelt;
    if (!v || !mu) return;
    o.onBelt = null;
    o.arrived = false;
    o.waiterVehicle = null;
    o.waiterCb = null;
    this.take(v, mu);
    this.pickHandler(o.id, wait, String(mu.id));
  }

  /** Hold `mu` on the fork with its world pose (no jump), then glide onto the seat. */
  private take(v: VehicleRec, mu: RVMovingUnit): void {
    v.root.updateMatrixWorld(true);   // fresh fork pose (see putOnHead)
    holdMU(mu, v.anchor, 'grip');
    v.carried = mu;
    // The seat is defined by the COLLIDER bottom — what the engine's placement sets on a
    // belt (`placeMUOnSurface`: collider bottom on the surface top). The library pallet's
    // collider starts a few mm above its node origin; seating by the origin would turn
    // that offset into a height jump at every drop (G2).
    mu.updateAABB();
    mu.node.getWorldPosition(_point);
    v.seatTarget.set(0, -this.palletSeatM - (mu.aabb.min.y - _point.y), 0);
    v.seatPos.copy(mu.node.position);
    v.seatQuat.copy(mu.node.quaternion);
    v.gliding = true;
  }

  private glide(v: VehicleRec, mu: RVMovingUnit): void {
    const p = mu.node.position;
    const target = v.seatTarget;
    const d = p.distanceTo(target);
    if (d > SEAT_GLIDE_STEP_M) p.lerp(target, SEAT_GLIDE_STEP_M / d); else p.copy(target);
    const q = mu.node.quaternion;
    q.rotateTowards(_identity, SEAT_GLIDE_STEP_RAD);
    if (d <= SEAT_GLIDE_STEP_M && q.angleTo(_identity) < 1e-6) v.gliding = false;
    v.seatPos.copy(p);
    v.seatQuat.copy(q);
  }

  /** A refused drop: counted, and retried later while nothing else wakes the vehicle (G2). */
  private refused(i: InputRec): void {
    this.counters.dropsRefused++;
    if (i.retryArmed) return;
    i.retryArmed = true;
    const g = this.clock.generation;
    this.clock.schedule(this.clock.now() + DROP_RETRY_SEC, () => {
      if (g !== this.clock.generation || this.disposed) return;
      i.retryArmed = false;
      this.onInputFreed?.(i.id);
    });
  }

  private surfaceTaken(surfaces: readonly RVTransportSurface[]): boolean {
    const mus = this.tm.mus;
    for (let k = 0; k < mus.length; k++) {
      const mu = mus[k];
      if (mu.markedForRemoval || (!mu.isInstanced && (mu as RVMovingUnit).isGripped)) continue;
      for (let j = 0; j < surfaces.length; j++) if (surfaces[j].aabb.overlapsXZ(mu.aabb)) return true;
    }
    return false;
  }

  private surfaceUnder(surfaces: readonly RVTransportSurface[], p: Vector3): RVTransportSurface | null {
    for (let j = 0; j < surfaces.length; j++) {
      const a = surfaces[j].aabb;
      a.update();
      if (p.x >= a.min.x && p.x <= a.max.x && p.z >= a.min.z && p.z <= a.max.z) return surfaces[j];
    }
    return null;
  }

  private neutralParent(mu: RVMovingUnit): Object3D {
    return mu.parentBeforeGrip ?? this.tm.neutralParentOf(mu) ?? sceneRootOf(this.root);
  }
}
