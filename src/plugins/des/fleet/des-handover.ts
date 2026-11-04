// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * DES hand-over of the fleet executor (plan-559 Phase 5, V6; moved from the
 * PalletYard project, plan-612 §2.4 "Uebergabe" + plan-631 pose hand-over —
 * behaviour unchanged). Implements {@link HandoverBackend} and composes the DES
 * kernel adapters ({@link FleetKernelAdapters}: clock, lift, hand-over) without
 * any change to `Conveyor.ts` / `Source.ts`:
 *
 * - **Pick at a production output end** ({@link DesConveyorEndHandover}): an
 *   END PROBE is wired behind the output conveyor (`nextComponents = [probe]`).
 *   The conveyor's own `tryRelease` asks the probe at the ARRIVAL at the belt
 *   end — that is the event "an MU stands at the end"; the probe refuses, the MU
 *   parks in the conveyor's `blockedMUs`. To pick, the backend swaps
 *   `nextComponents = [carrier]` and pokes `onDownstreamReady`: the conveyor
 *   clears through its OWN release path. A forklift docked BEFORE the arrival
 *   keeps `[carrier]` wired and receives the MU AT the arrival.
 * - **Owner during the drive** ({@link CarrierOwner}): a plain `DESComponent` on
 *   the vehicle's fork anchor, registered with the manager. The FastForward →
 *   Animated materialisation does NOT seat a carried MU on the fork —
 *   {@link reconcileSeats} re-parents every MU held by a plugin owner to the
 *   owner node and its seat pose, once per frame (and after every hand-over).
 * - **Drop on a conveyor head** ({@link dropOnConveyorHead}): a POSE hand-over
 *   (plan-631): `head.transferInWithPose(carrier, mu, pose)` — the conveyor takes
 *   the MU over where the fork set it down. The pose is LOGICAL (the project's
 *   dock seat + lift height, {@link DesHandoverPoses}), so FastForward headless
 *   takes the same path. A refusal or a roll-back keeps the MU on the fork.
 * - **Floor places** ({@link FloorSlot}): passive capacity-1 owners without a
 *   successor; FIFO and occupancy live in the fleet core (`StorageGroup`).
 *
 * There is no `DESManager.unregisterComponent`, so an owner is bound to
 * (manager, node uuid) and REUSED as long as both stay; a new manager or node
 * gets a new owner ({@link PluginOwnerRegistry}).
 */

import { Object3D, Quaternion, Vector3 } from 'three';
import type { RVDrive } from '../../../core/engine/rv-drive';
import { instanceScope } from '../../../core/engine/rv-instance-scope';
import { isUnderScope } from '../../../core/engine/rv-reference-resolver';
import type { AcceptPose } from '../../../core/material-flow/material-flow-self';
import { validatePickState } from '../../../core/fleet/exec/backend-state';
import type { FleetKernelAdapters, HandoverBackend, LiftDrive, PickWait } from '../../../core/fleet/exec/backends';
import { DESComponent } from '../rv-des-component';
import type { DESManager } from '../rv-des-manager';
import type { DESMU } from '../rv-des-mu';
import type { MaterialFlowAdapter, PoseTransferResult } from '../material-flow-adapter';
import type { DESRunner } from '../des-runner';
import { DesSimClock, type ClockRestart } from './des-sim-clock';
import { fleetClockParticipant } from './des-clock-participant';
import { DesLift } from './des-lift';

// ── Owners ──────────────────────────────────────────────────────────────────

/** Visual scene node of a DES MU (null while headless in FastForward). */
export function muNode(mu: DESMU | null | undefined): Object3D | null {
  return (mu?.visual as { node?: Object3D } | null | undefined)?.node ?? null;
}

/** A plugin-owned DES component: one MU at most, seat pose on its node. */
export abstract class PluginOwner extends DESComponent {
  abstract readonly role: string;

  /** Local seat pose of a held MU in the owner node's frame. */
  readonly seatPosition = new Vector3();
  readonly seatQuaternion = new Quaternion();
  /** Called when the generic DES owner state was restored. */
  onSnapshotRestored: (() => void) | null = null;

  constructor(node: Object3D) {
    super(node);
    this.MaxCapacity = 1;
    this.onRestored = () => { this.onSnapshotRestored?.(); };
  }

  get held(): DESMU | null { return this.mus[0] ?? null; }
}

/**
 * Owner of the MU on a forklift fork — lives on the fork anchor (fork top, MU
 * centre). The seat (MU origin below the carrying face) is set by the backend.
 */
export class CarrierOwner extends PluginOwner {
  static readonly role = 'CarrierOwner';
  get role(): string { return CarrierOwner.role; }
}

/** Passive one-place floor owner (no successor, no auto release). Seat = the place node pose. */
export class FloorSlot extends PluginOwner {
  static readonly role = 'FloorSlot';
  get role(): string { return FloorSlot.role; }
}

/** End probe of a production output: refuses every MU and reports the arrival. */
export class EndProbe extends PluginOwner {
  static readonly role = 'EndProbe';
  get role(): string { return EndProbe.role; }
}

type OwnerCtor<T extends PluginOwner> = { new (node: Object3D): T; readonly role: string };

/** Creates plugin owners exactly once per (manager, node). */
export class PluginOwnerRegistry {
  private readonly owners = new Map<string, { manager: DESManager; owner: PluginOwner }>();
  /** How many owners were constructed (diagnostics / tests). */
  created = 0;

  get<T extends PluginOwner>(ctor: OwnerCtor<T>, node: Object3D, manager: DESManager): T {
    const key = `${ctor.role}:${node.uuid}`;
    const hit = this.owners.get(key);
    if (hit && hit.manager === manager && hit.owner.node === node) {
      if (manager.getComponentByEntityId(hit.owner.entityId) !== hit.owner) manager.registerComponent(hit.owner);
      return hit.owner as T;
    }
    const owner = new ctor(node);
    manager.registerComponent(owner);
    this.owners.set(key, { manager, owner });
    this.created++;
    return owner;
  }

  all(): PluginOwner[] { return [...this.owners.values()].map((e) => e.owner); }

  retain(owners: readonly PluginOwner[]): void {
    for (const [key, entry] of this.owners) {
      if (!owners.includes(entry.owner)) this.owners.delete(key);
    }
  }

  /** Drop every owner's MU state (reset); the owners themselves stay registered. */
  clearState(): void { for (const { owner } of this.owners.values()) owner.clearMUState(); }

  clear(): void { this.owners.clear(); }
}

/** Seat the visual of `mu` on `owner` (parent + local seat pose). Idempotent; false while headless. */
export function seatOn(mu: DESMU, owner: PluginOwner): boolean {
  const node = muNode(mu);
  if (!node) return false;
  if (node.parent !== owner.node) owner.node.add(node);
  node.position.copy(owner.seatPosition);
  node.quaternion.copy(owner.seatQuaternion);
  node.updateMatrixWorld(true);
  return true;
}

/**
 * Per-frame seat reconcile for every plugin owner (fork carriers AND floor
 * places): a held MU whose visual is not parented to the owner — e.g.
 * materialised on FastForward exit — is re-parented and seated. Returns the
 * number of fixed MUs. No allocation.
 */
export function reconcileSeats(owners: readonly PluginOwner[]): number {
  let fixed = 0;
  for (let i = 0; i < owners.length; i++) {
    const o = owners[i];
    if (o instanceof EndProbe) continue;
    const mu = o.held;
    const node = muNode(mu);
    if (mu && node && node.parent !== o.node) { seatOn(mu, o); fixed++; }
  }
  return fixed;
}

/**
 * The DES hand-over of ONE production output conveyor end (see the module doc).
 * `onArrive` reports "an MU stands at the end" (once per MU); `onPicked` reports
 * the pick — called from inside the conveyor's release stack, so the consumer
 * must DEFER follow-up work (clock event at now).
 */
export class DesConveyorEndHandover {
  /** MU ids that reached the end and wait for a pick. */
  readonly waiting = new Set<number>();
  private carrier: CarrierOwner | null = null;
  onArrive: ((mu: DESMU) => void) | null = null;
  onPicked: ((mu: DESMU, carrier: CarrierOwner) => void) | null = null;

  constructor(readonly conveyor: MaterialFlowAdapter, readonly probe: EndProbe) {
    // MaxCapacity stays 1: DESComponent.canAccept checks the load BEFORE onCanAccept.
    probe.onCanAccept = (mu) => {
      if (!this.waiting.has(mu.id)) { this.waiting.add(mu.id); this.onArrive?.(mu); }
      return false;
    };
    this.wire();
  }

  /** (Re)wire the probe behind the conveyor — bind and every reset. */
  wire(): void {
    this.conveyor.nextComponents = [this.probe];
    this.probe.previousComponents = [this.conveyor];
  }

  /** The vehicle currently docked for a pick (null = none). */
  get dockedCarrier(): CarrierOwner | null { return this.carrier; }

  /**
   * A forklift docked at the end with an empty fork. Takes the waiting MU now,
   * or at its arrival. Returns the MU if it was taken synchronously.
   */
  dock(carrier: CarrierOwner): DESMU | null {
    this.restoreDock(carrier);
    if (this.waiting.size > 0) this.conveyor.onDownstreamReady(carrier);
    return carrier.held;
  }

  /** Restore wiring silently, without attempting a transfer. */
  restoreDock(carrier: CarrierOwner): void {
    this.carrier = carrier;
    carrier.onMUEnter = (mu) => {
      this.waiting.delete(mu.id);
      this.wire();
      this.carrier = null;
      carrier.onMUEnter = undefined;
      this.onPicked?.(mu, carrier);
    };
    this.conveyor.nextComponents = [carrier];
  }

  /** The forklift leaves without an MU (re-tasked, reset): restore the probe. */
  undock(): void {
    if (this.carrier) this.carrier.onMUEnter = undefined;
    this.carrier = null;
    this.wire();
  }

  /** Reset: forget the waiting MUs (the runner cleared the conveyor), rewire the probe. */
  reset(): void {
    this.undock();
    this.waiting.clear();
  }
}

/**
 * Drop a carried MU onto a conveyor HEAD at `pose` (plan-631 F5): the MU is
 * handed over WITH its set-down pose — the conveyor pre-checks capacity and the
 * pose (±20 mm), takes it over there and schedules only the rest of the belt.
 * The visual goes to `worldParent` (world pose kept) only on success; on a
 * refusal or a roll-back the MU stays / is put back on the fork. Returns the
 * hand-over result (`ok` = the conveyor owns the MU).
 */
export function dropOnConveyorHead(
  carrier: CarrierOwner, head: MaterialFlowAdapter, worldParent: Object3D, pose: AcceptPose,
): PoseTransferResult | null {
  const mu = carrier.held;
  if (!mu) return null;
  // Pre-check first: the visual must not leave the fork for a refused drop.
  if (!head.canAcceptWithPose(mu, pose)) return { ok: false, reason: 'refused', ownerKept: true };
  const node = muNode(mu);
  if (node) worldParent.attach(node);
  const r = head.transferInWithPose(carrier, mu, pose);
  if (!r.ok) seatOn(mu, carrier); // ownerKept: back on the fork
  return r;
}

/** Fork → floor place (store). */
export function storeOnSlot(carrier: CarrierOwner, slot: FloorSlot): boolean {
  const mu = carrier.held;
  if (!mu || !slot.canAccept(mu)) return false;
  carrier.releaseMU(mu);
  slot.acceptMU(mu);
  seatOn(mu, slot);
  return true;
}

/** Floor place → fork (retrieve). */
export function retrieveFromSlot(slot: FloorSlot, carrier: CarrierOwner): DESMU | null {
  const mu = slot.held;
  if (!mu || !carrier.canAccept(mu)) return null;
  slot.releaseMU(mu);
  carrier.acceptMU(mu);
  seatOn(mu, carrier);
  return mu;
}

/**
 * Production through the source adapter's own self, spawned ON the head
 * (plan-631 R2-3): the head is asked first with the spawn pose and the template
 * size — refused (occupied, pose off the belt) → nothing is spawned, the takt
 * waits. Then the fresh MU is handed over at `spawnPose`.
 */
export function produceOne(
  runner: DESRunner, source: MaterialFlowAdapter, head: MaterialFlowAdapter,
  spawnPose: AcceptPose, templateSize: readonly [number, number, number],
): DESMU | null {
  if (!runner.canAcceptWithPose(head, templateSize, spawnPose)) return null;
  const mu = source.self.spawn() as unknown as DESMU;
  const r = runner.transferMUWithPose(mu as never, head, spawnPose, source);
  if (r.ok) return mu;
  // Pre-checked a moment ago in the same event — should not happen. The MU stays
  // with the source and leaves through its normal transfer (blocked / retried).
  console.warn(`[Fleet] production at ${head.node.name}: pose hand-over ${r.reason}`);
  source.transferMU(mu);
  return mu;
}

// ── Instance lookup ─────────────────────────────────────────────────────────

/** The live DES instance of `kind` bound ON `node`, else the first one below it (a placement binds on its reference node or the asset root). */
export function instanceAt(runner: DESRunner, node: Object3D, kind: string): MaterialFlowAdapter | null {
  let below: MaterialFlowAdapter | null = null;
  for (const i of runner.liveInstances) {
    if (i.def.kind !== kind) continue;
    if (i.adapter.node === node) return i.adapter;
    if (!below && isUnderScope(i.adapter.node, node)) below = i.adapter;
  }
  return below;
}

/** The conveyor's own `Flow.Run` accessor (`self.sig.Run`), or null. */
export function runSignalOf(a: MaterialFlowAdapter): { set(v: boolean): void } | null {
  const sig = (a.self as unknown as { sig?: Record<string, { set(v: boolean): void } | undefined> }).sig;
  return sig?.Run ?? null;
}

// ── Backend ─────────────────────────────────────────────────────────────────

/** One drop line: the input conveyor the forklift drops on, the conveyor behind it, the sink at its end. */
export interface DesDropLine {
  conveyor: MaterialFlowAdapter;
  out: MaterialFlowAdapter;
  sink: MaterialFlowAdapter;
}

/** One vehicle of the DES hand-over: its root, the fork anchor (carrier owner node), the lift drive. */
export interface DesVehicleNodes {
  root: Object3D;
  anchor: Object3D;
  lift: RVDrive | null;
}

/**
 * The project's LOGICAL hand-over poses (plan-631 F2a): layout + lift state,
 * never a visual. Coordinates are in the frame of {@link frame}.
 */
export interface DesHandoverPoses {
  /** Frame of the pose coordinates (the yard root, else the model root). */
  readonly frame: Object3D;
  /** Spawn pose of the production head of pick station `station`: the MU origin on the belt head. */
  spawn(station: string): readonly [number, number, number] | null;
  /** Set-down pose of an MU on the fork at drop station `station` with the fork at `liftMm` (headless-valid). */
  dockSeat(station: string, liftMm: number): readonly [number, number, number] | null;
  /** MU size (m, own frame) for the pose pre-check before the first spawn of a source. */
  readonly defaultMuSize: readonly [number, number, number];
  /** MU origin below the carrying face of the fork (m) — the carrier seat. */
  readonly carrierSeatM: number;
}

/** The conveyors' own `onMUExit` (before the first fleet bind) — rebinds wrap this, never a wrapper. */
const originalMuExit = new WeakMap<MaterialFlowAdapter, ((mu: DESMU) => void) | undefined>();
/** One end-probe node per output conveyor node (owners are reused per node). */
const probeNodes = new WeakMap<Object3D, Object3D>();

export interface DesHandoverState {
  pickWaiters: [string, PickWait][];
  outputs: [string, { waiting: number[]; dockedVehicle: string | null }][];
  templateSizes: [string, readonly [number, number, number]][];
}

/** DES hand-over + clock + lift — see the module doc. */
export class DesHandoverBackend implements HandoverBackend, FleetKernelAdapters {
  readonly kind = 'des' as const;
  readonly clock: DesSimClock;
  readonly lift: DesLift;
  readonly manager: DESManager;
  onPalletReady: ((station: string, mu: string) => void) | null = null;
  onInputFreed: ((station: string) => void) | null = null;
  /** Restart / restore the runner reported to the clock (lifecycle service, plan-645 L3). */
  onClockRestart: ((why: ClockRestart) => void) | null = null;
  /** A snapshot restore reached a plugin owner. */
  onSnapshotRestored: (() => void) | null = null;

  private readonly handovers = new Map<string, DesConveyorEndHandover>();
  private readonly carriers = new Map<string, CarrierOwner>();
  private readonly floor = new Map<string, FloorSlot>();
  private pickWaiters = new Map<string, PickWait>();
  private pickHandler: (output: string, wait: PickWait, mu: string) => void = () => {};
  setPickHandler(handler: (output: string, wait: PickWait, mu: string) => void): (output: string, wait: PickWait, mu: string) => void {
    const previous = this.pickHandler;
    this.pickHandler = handler;
    return previous;
  }
  exportState(): DesHandoverState {
    // Owner loads belong to the generic DES component/MU participants.
    return structuredClone({ pickWaiters: [...this.pickWaiters],
      outputs: [...this.handovers].map(([id, h]) => [id, { waiting: [...h.waiting],
        dockedVehicle: [...this.carriers].find(([, c]) => c === h.dockedCarrier)?.[0] ?? null }]),
      templateSizes: [...this.templateSizes] });
  }
  validateState(json: unknown): string[] {
    const s = json as DesHandoverState;
    const errors = validatePickState({ pickWaiters: s?.pickWaiters });
    if (!s || !Array.isArray(s.outputs) || !Array.isArray(s.templateSizes)) return [...errors, 'expected outputs and templateSizes'];
    if (Object.keys(s).sort().join(',') !== 'outputs,pickWaiters,templateSizes') errors.push('unexpected handover fields');
    const outputs = new Set<string>(), vehicles = new Set<string>(), mus = new Set<number>();
    for (const entry of s.outputs) {
      if (!Array.isArray(entry) || entry.length !== 2) { errors.push('invalid output entry'); continue; }
      const [id, h] = entry;
      if (!this.handovers.has(id) || outputs.has(id)) errors.push('unknown or duplicate output');
      outputs.add(id);
      if (!h || !Array.isArray(h.waiting)) { errors.push('invalid waiting'); continue; }
      for (const mu of h.waiting) {
        if (!Number.isSafeInteger(mu) || mu < 0 || mus.has(mu)) errors.push('invalid or duplicate waiting MU');
        mus.add(mu);
      }
      if (h.dockedVehicle !== null) {
        if (!this.carriers.has(h.dockedVehicle) || vehicles.has(h.dockedVehicle)) errors.push('unknown or duplicate docked vehicle');
        vehicles.add(h.dockedVehicle);
      }
    }
    if (outputs.size !== this.handovers.size) errors.push('missing outputs');
    if (!errors.length) for (const [id, w] of s.pickWaiters)
      if (!this.handovers.has(id) || !this.carriers.has(w.v)) errors.push('unknown pick output or vehicle');
    const sizes = new Set<string>();
    for (const entry of s.templateSizes) {
      if (!Array.isArray(entry) || entry.length !== 2) { errors.push('invalid template size'); continue; }
      const [id, size] = entry;
      if (!this.outputs.has(id) || sizes.has(id) || !Array.isArray(size) || size.length !== 3
        || !size.every(n => Number.isFinite(n) && n >= 0)) errors.push('invalid template size');
      sizes.add(id);
    }
    return errors;
  }
  prepareState(json: unknown): DesHandoverState {
    const errors = this.validateState(json);
    if (errors.length) throw new Error('fleet.handover: ' + errors.join('; '));
    return structuredClone(json as DesHandoverState);
  }
  swapState(prepared: DesHandoverState): void {
    this.pickWaiters = new Map(prepared.pickWaiters);
    for (const h of this.handovers.values()) h.undock();
    for (const [id, state] of prepared.outputs) {
      const h = this.handovers.get(id)!;
      h.waiting.clear();
      for (const mu of state.waiting) h.waiting.add(mu);
      if (state.dockedVehicle !== null) h.restoreDock(this.carriers.get(state.dockedVehicle)!);
    }
    this.templateSizes.clear();
    for (const [id, size] of prepared.templateSizes) this.templateSizes.set(id, size);
  }
  private readonly ownerList: Array<CarrierOwner | FloorSlot | EndProbe> = [];
  /** MU size (m, own frame) of the last MU each source spawned — the pose pre-check's probe size. */
  private readonly templateSizes = new Map<string, readonly [number, number, number]>();
  private readonly poses: DesHandoverPoses;
  private disposed = false;
  private readonly offOwnerSnapshot: () => void;
  private readonly offOwnerRestore: () => void;
  private readonly offClockSnapshot: () => void;

  constructor(
    readonly runner: DESRunner,
    readonly root: Object3D,
    private readonly outputs: Map<string, { conveyor: MaterialFlowAdapter; source: MaterialFlowAdapter }>,
    private readonly inputs: Map<string, DesDropLine>,
    readonly vehicles: Map<string, DesVehicleNodes>,
    slots: Map<string, Object3D>,
    readonly owners: PluginOwnerRegistry,
    poses?: DesHandoverPoses,
  ) {
    this.manager = runner.getManager();
    this.poses = poses ?? { frame: root, spawn: () => null, dockSeat: () => null, defaultMuSize: [1, 1, 1], carrierSeatM: 0 };
    this.clock = new DesSimClock(this.runner, (why) => this.onClockRestart?.(why));
    this.offClockSnapshot = runner.registerSnapshotProvider('fleet.clock', () => [fleetClockParticipant(this.clock)]);
    this.offOwnerSnapshot = runner.registerSnapshotComponents('fleet.owners', ({ addressOf }) => {
      const components = new Map<string, DESComponent>();
      for (const owner of this.ownerList) {
        // Probes are detached; their logical address is the output conveyor.
        const node = owner instanceof EndProbe
          ? [...this.handovers.values()].find(h => h.probe === owner)!.conveyor.node : owner.node;
        const id = `${addressOf(node)}@${owner.role}`;
        if (components.has(id)) throw new Error(`duplicate fleet owner '${id}'`);
        components.set(id, owner);
      }
      return components;
    }, ['seatPosition', 'seatQuaternion', 'onSnapshotRestored']);
    this.offOwnerRestore = runner.onLifecycle(e => {
      if (e.type === 'restored') for (const owner of this.ownerList)
        if (owner.held && !(owner instanceof EndProbe)) seatOn(owner.held, owner);
    });
    const liftDrives = new Map<string, LiftDrive>();
    for (const [id, v] of vehicles) if (v.lift) liftDrives.set(id, v.lift as unknown as LiftDrive);
    this.lift = new DesLift(() => this.runner, this.clock, liftDrives);
    const restored = (): void => { this.onSnapshotRestored?.(); };
    for (const [id, o] of outputs) {
      let probeNode = probeNodes.get(o.conveyor.node);
      if (!probeNode) {
        // Not in the scene: an end probe has no visual and no hierarchy entry.
        probeNode = new Object3D();
        probeNode.name = `${o.conveyor.node.name}_EndProbe`;
        probeNodes.set(o.conveyor.node, probeNode);
      }
      const probe = owners.get(EndProbe, probeNode, this.manager);
      probe.onSnapshotRestored = restored;
      const h = new DesConveyorEndHandover(o.conveyor, probe);
      h.onArrive = (mu) => { if (!this.disposed) this.onPalletReady?.(id, String(mu.id)); };
      h.onPicked = (mu) => {
        const cb = this.pickWaiters.get(id);
        this.pickWaiters.delete(id);
        if (cb) this.pickHandler(id, cb, String(mu.id));
      };
      this.handovers.set(id, h);
      this.ownerList.push(probe);
    }
    for (const [id, i] of inputs) {
      if (!originalMuExit.has(i.conveyor)) originalMuExit.set(i.conveyor, i.conveyor.onMUExit);
      const own = originalMuExit.get(i.conveyor);
      i.conveyor.onMUExit = (mu) => {
        own?.(mu);
        if (!this.disposed && i.conveyor.currentLoad === 0) this.onInputFreed?.(id);
      };
    }
    for (const [id, v] of vehicles) {
      const c = owners.get(CarrierOwner, v.anchor, this.manager);
      // The MU bottom sits `carrierSeatM` below its carrying face (= the fork top).
      c.seatPosition.set(0, -this.poses.carrierSeatM, 0);
      c.onSnapshotRestored = restored;
      this.carriers.set(id, c);
      this.ownerList.push(c);
    }
    for (const [id, n] of slots) {
      const s = owners.get(FloorSlot, n, this.manager);
      s.onSnapshotRestored = restored;
      this.floor.set(id, s);
      this.ownerList.push(s);
    }
    owners.retain(this.ownerList);
    this.wire();
  }

  /** The kernel adapters' hand-over half — this backend itself. */
  get handover(): HandoverBackend { return this; }

  get ownersInUse(): ReadonlyArray<CarrierOwner | FloorSlot | EndProbe> { return this.ownerList; }
  carrierOf(vehicle: string): CarrierOwner | null { return this.carriers.get(vehicle) ?? null; }
  slotOwner(slot: string): FloorSlot | null { return this.floor.get(slot) ?? null; }
  inputConveyor(input: string): MaterialFlowAdapter | null { return this.inputs.get(input)?.conveyor ?? null; }
  outputConveyor(output: string): MaterialFlowAdapter | null { return this.outputs.get(output)?.conveyor ?? null; }
  /** The conveyor behind drop station `input`. */
  conveyorOutOf(input: string): MaterialFlowAdapter | null { return this.inputs.get(input)?.out ?? null; }
  sinkOf(input: string): MaterialFlowAdapter | null { return this.inputs.get(input)?.sink ?? null; }
  sourceOf(output: string): MaterialFlowAdapter | null { return this.outputs.get(output)?.source ?? null; }

  /**
   * Explicit topology, set at bind (never a ComponentReference from the layout
   * into a placement — 559 M1, #209; the port graph of the runner may or may not
   * have wired it already): source → output, input → out → sink.
   */
  private wire(): void {
    for (const o of this.outputs.values()) { o.source.nextComponents = [o.conveyor]; o.conveyor.previousComponents = [o.source]; }
    for (const i of this.inputs.values()) {
      i.conveyor.nextComponents = [i.out];
      i.out.previousComponents = [i.conveyor];
      i.out.nextComponents = [i.sink];
      i.sink.previousComponents = [i.out];
    }
    for (const h of this.handovers.values()) h.wire();
  }

  // ── Hand-over poses (plan-631 F2a): LOGICAL — layout + lift state, never a visual ──

  /** World position of a point given in the pose frame. */
  private frameToWorld(p: readonly [number, number, number]): AcceptPose {
    const frame = this.poses.frame;
    frame.updateWorldMatrix(true, false);
    const v = new Vector3(p[0], p[1], p[2]).applyMatrix4(frame.matrixWorld);
    return { position: [v.x, v.y, v.z] };
  }

  /** Spawn pose of the production source of `output`: the MU origin on the belt head. */
  spawnPose(output: string): AcceptPose | null {
    const p = this.poses.spawn(output);
    return p ? this.frameToWorld(p) : null;
  }

  /** Set-down pose of `vehicle` docked at `station` at the CURRENT lift height. Valid headless (FastForward). */
  dockSeatPose(vehicle: string, station: string): AcceptPose | null {
    const p = this.poses.dockSeat(station, this.lift.position(vehicle));
    return p ? this.frameToWorld(p) : null;
  }

  private templateSizeOf(output: string): readonly [number, number, number] {
    return this.templateSizes.get(output) ?? this.poses.defaultMuSize;
  }

  /** Takt release: one MU spawned ON the head, taken over at the spawn pose (plan-631 R2-3). */
  produce(output: string): boolean {
    const o = this.outputs.get(output);
    const pose = this.spawnPose(output);
    if (!o || !pose) return false;
    const mu = produceOne(this.runner, o.source, o.conveyor, pose, this.templateSizeOf(output));
    const size = (mu as { _bugSize?: [number, number, number] } | null)?._bugSize;
    if (size) this.templateSizes.set(output, [size[0], size[1], size[2]]);
    return mu !== null;
  }

  /** The head takes a new MU AT the spawn pose now (capacity + pose; nothing is spawned). */
  headFree(output: string): boolean {
    const o = this.outputs.get(output);
    const pose = this.spawnPose(output);
    return !!o && !!pose && this.runner.canAcceptWithPose(o.conveyor, this.templateSizeOf(output), pose);
  }

  awaitPick(output: string, vehicle: string, wait: PickWait): void {
    const h = this.handovers.get(output);
    const c = this.carriers.get(vehicle);
    if (!h || !c) return;
    this.pickWaiters.set(output, wait);
    h.dock(c);
  }

  cancelPick(output: string, vehicle: string): void {
    const h = this.handovers.get(output);
    const c = this.carriers.get(vehicle);
    if (!h || !c || h.dockedCarrier !== c) return;
    this.pickWaiters.delete(output);
    h.undock();
  }

  inputOccupant(input: string): string | null {
    const mu = this.inputs.get(input)?.conveyor.heldMUs[0];
    return mu ? String(mu.id) : null;
  }

  inputFree(input: string): boolean {
    const i = this.inputs.get(input);
    return !!i && i.conveyor.currentLoad === 0 && i.conveyor.reservedLoad === 0 && !i.conveyor.isFailure;
  }

  putOnHead(vehicle: string, input: string): boolean {
    const i = this.inputs.get(input);
    const c = this.carriers.get(vehicle);
    const pose = this.dockSeatPose(vehicle, input);
    if (!i || !c || !pose) return false;
    const r = dropOnConveyorHead(c, i.conveyor, this.root, pose);
    if (r && !r.ok && r.reason !== 'refused') console.warn(`[Fleet] ${vehicle}: drop on ${input} ${r.reason} — MU stays on the fork`);
    return !!r?.ok;
  }

  /**
   * DES pause = `Flow.Run` of THIS input conveyor (per instance): an MU on it
   * parks at its end (the release checks `Run`), in front of the out conveyor;
   * an MU already on the out conveyor still runs into the sink. At the pause end
   * the input is poked (`onDownstreamReady` — a `Flow.Run` edge pulls nothing in
   * DES). Written through the conveyor's own signal accessor (`self.sig.Run`).
   */
  setInputRun(input: string, run: boolean): void {
    const i = this.inputs.get(input);
    if (!i) return;
    runSignalOf(i.conveyor)?.set(run);
    if (run) i.conveyor.onDownstreamReady(i.out);
  }

  /** The scoped `Flow.Run` signal name of input `input`'s conveyor (diagnostics, tests). */
  inputRunSignal(input: string): string | null {
    const i = this.inputs.get(input);
    if (!i) return null;
    const scope = instanceScope(i.conveyor.node);
    return scope ? `${scope}.Flow.Run` : 'Flow.Run';
  }

  store(vehicle: string, slot: string): boolean {
    const c = this.carriers.get(vehicle);
    const s = this.floor.get(slot);
    return !!c && !!s && storeOnSlot(c, s);
  }

  retrieve(slot: string, vehicle: string): string | null {
    const c = this.carriers.get(vehicle);
    const s = this.floor.get(slot);
    if (!c || !s) return null;
    const mu = retrieveFromSlot(s, c);
    return mu ? String(mu.id) : null;
  }

  carried(vehicle: string): string | null {
    const mu = this.carriers.get(vehicle)?.held;
    return mu ? String(mu.id) : null;
  }

  onSlot(slot: string): string | null {
    const mu = this.floor.get(slot)?.held;
    return mu ? String(mu.id) : null;
  }

  reconcile(): number { return reconcileSeats(this.ownerList); }

  vehicleNode(vehicle: string): Object3D | null { return this.vehicles.get(vehicle)?.root ?? null; }

  releaseVisuals(): void {
    for (const o of this.ownerList) {
      const node = muNode(o.held);
      if (node && node.parent === o.node) this.root.attach(node);
    }
  }

  resetState(): void {
    this.releaseVisuals();
    this.pickWaiters.clear();
    for (const i of this.inputs.values()) runSignalOf(i.conveyor)?.set(true);
    for (const h of this.handovers.values()) h.reset();
    this.owners.clearState();
    this.lift.clear();
    this.wire();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseVisuals();
    for (const h of this.handovers.values()) h.undock();
    for (const i of this.inputs.values()) i.conveyor.onMUExit = originalMuExit.get(i.conveyor);
    this.pickWaiters.clear();
    this.offOwnerSnapshot();
    this.offOwnerRestore();
    this.offClockSnapshot();
    this.lift.dispose();
    this.clock.dispose();
  }
}
