// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * material-flow-self.ts — the shared `self` context (Plan 194 §2.3).
 *
 * `MaterialFlowSelf` is the single mutable surface that all three layers of a
 * `defineMaterialFlow` definition (`logic` / `continuous` / `des`) talk to. It
 * is a thin PROJECTION over the existing `RVBindContext` (behavior-runtime.ts):
 * signals/drive/find/contextMenu/onFixedUpdate forward straight through, so the
 * continuous path keeps zero behavior change, while ports/state/transfer/prop
 * add the mode-agnostic material-flow surface on top.
 *
 * `Port` extends Plan-196's `TransportLink` (transport-links.ts): `port.id`
 * equals `TransportLink.partnerSnapId` equals the partner snap's id, and
 * `port.ownerComponent` fills Plan-196's reserved `partnerComponent` slot for
 * the DES object-handshake. Topology comes from `resolvePorts()` (topology
 * resolver below): snap-graph primary via `classifyConnections`/
 * `findOutputPairings`; autoConnect fallback is a documented stub for now.
 *
 * `self.in` / `self.at` / `self.cancel` / `self.now` are kernel-agnostic
 * Tier-0 primitives (plan-210 §6b): in DES mode they delegate to the injected
 * `SelfScheduler` (private runner, unchanged); in continuous mode they run on
 * a lazily-created `RVEventHeap` drained by the fixed tick (`time <= now`).
 * Due hooks dispatch through `CreateSelfOptions.onHook`; without a wired
 * dispatcher the drain warns once instead of silently dropping events.
 */

import type { Object3D, Quaternion, Vector3 } from 'three';
import type { ContextMenuItem } from '../hmi/context-menu-store';
import type {
  RVBindContext,
  BindContextDrive,
  NodeRef,
  SignalOpts,
  SignalType,
} from '../behavior-runtime';
import type { TransportLink } from '../../behaviors/_shared/transport-links';
import type { StateStatistics } from './rv-state-statistics';
import {
  createDownstreamInterlock,
  declareFlowSignalsWith,
  flowOccupiedRootSignal,
  FLOW_OCCUPIED,
} from '../../behaviors/_shared/transport-links';
import {
  classifyConnections,
  findOutputPairings,
  type PortConnection,
  type OutputPairing,
} from '../../behaviors/_shared/snap-graph-helpers';
import {
  findFirst,
  findAll as findAllNodes,
  NODE_KIND_TESTS,
} from '../library-component-loader';
import { RVEventHeap } from '../sdk/rv-event-heap';

/** A convention node kind — derived from the finder table, so adding a kind to
 *  `NODE_KIND_TESTS` extends `self.find`/`self.findAll` with no other change. */
export type NodeKind = keyof typeof NODE_KIND_TESTS;

// (findTransport/findSensor/findRotaryDrive live in NODE_KIND_TESTS as
//  'transport'/'sensor'/'rotary' — self.find(kind) is the single generic finder.)
import {
  attachBelt,
  attachDrive,
  selfDrives,
  type BeltHandle,
  type DriveHandle,
} from '../../behaviors/_shared/lazy-drive';
import { isSurfaceOccupied } from '../../behaviors/_shared/surface-occupancy';
import {
  attachDriveBehaviorByCode,
  addSignal,
  type AddSignalOpts,
  type AttachableDriveBehaviorType,
  type DriveBehaviorHostViewer,
  type SignalHandle,
  type SignalWiring,
} from '../engine/rv-signal-construction';
import type { RVComponent, PlcSignalType } from '../engine/rv-component-registry';
import type { RVSensor } from '../engine/rv-sensor';
import { instanceScope } from '../engine/rv-instance-scope';
import { isAnyLiveControlled } from '../engine/rv-slot-authority';

// Re-export the handle types the toolkit returns so the behavior-kit `RV`
// namespace can alias them without importing `_shared/lazy-drive` directly.
export type { BeltHandle, DriveHandle } from '../../behaviors/_shared/lazy-drive';

// ─── Public value types ─────────────────────────────────────────────────

/** JSON-serializable value (matches the DES `prop` bag — snapshot-safe). */
export type JsonValue =
  | string | number | boolean | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type MaterialFlowKind =
  | 'conveyor' | 'router' | 'station' | 'source' | 'sink' | 'storage' | 'downtime';

export type SimulationMode = 'continuous' | 'des';

/**
 * Drive facade exposed to a material-flow definition — identical surface to
 * `BindContextDrive` plus a continuous-friendly `currentSpeed` alias and a
 * `setTo(target, progress)` used by the (later) Tween-Registry.
 */
export interface SelfDrive extends BindContextDrive {
  /** Live speed in mm/s or deg/s (alias of the running drive speed). */
  readonly currentSpeed?: number;
  /** Interpolated set — `progress` in [0,1] from `from` to `to`. Tween-Registry use (P5). */
  setTo?(target: number, progress: number): void;
}

/**
 * A movable unit as seen by the material-flow layers. Kept structural and
 * minimal so the public core never has to import the private DES `DESMU`.
 * The DES runner passes its richer `DESMU` (which is assignable to this).
 */
export interface MU {
  readonly id: number;
  readonly generation?: number;
  /** The visual moving-unit (RVMovingUnit) — null until/unless rendered. */
  visual?: unknown;
  /** Per-MU snapshot-safe custom state. */
  prop?: Record<string, JsonValue>;
  childMUs?: MuRef[];
  parentMU?: MuRef | null;
  carrierType?: string;
  carrierCapacity?: number;
  visualTemplateId?: string;
}

/** Stable moving-unit reference used by persisted kernel contracts. */
export interface MuRef {
  readonly id: number;
  readonly gen: number;
}

/** JSON record for one active downstream-capacity reservation. */
export interface ReservationRecord {
  readonly id: number;
  readonly holderId: string;
  readonly targetId: string;
  readonly port?: string;
  readonly n: number;
  readonly carrier?: { readonly ref: MuRef; readonly slots: number };
  state: 'reserved' | 'committed' | 'rolledback';
}

/** Runtime facade for a persisted reservation record. */
export interface ReservationHandle {
  readonly record: ReservationRecord;
  commitMany(mus: readonly MU[]): boolean;
  rollback(): void;
}

/** JSON-only tween state stored while a component is failed. */
export interface FrozenTweenDescriptor {
  readonly kind: 'position' | 'path';
  readonly muRef: MuRef | null;
  readonly pathRef?: string;
  readonly from?: readonly [number, number, number];
  readonly to?: readonly [number, number, number];
  readonly fromS?: number;
  readonly toS?: number;
  readonly remaining: number;
}

/** JSON-only scheduled work stored while a component is failed. */
export interface FrozenDescriptor {
  readonly action: string;
  readonly muRef: MuRef | null;
  readonly payload: unknown;
  readonly remaining: number;
  readonly tween?: FrozenTweenDescriptor;
  /** Multiple tweens owned by one barrier event (for synchronous indexed motion). */
  readonly tweens?: readonly FrozenTweenDescriptor[];
}

/** Hook name as authored in a `des` block (e.g. 'Arrival', 'RotateComplete'). */
export type DesHookName = string;

/**
 * A tween descriptor a `des` block may attach to a DURATION event so the
 * (private) DESRunner animates the effect over the scheduled interval (Plan 194
 * §3.1). It is pure DATA — the public side never touches the tween registry; it
 * only describes the interpolation, and the private scheduler registers it on
 * its `TweenRegistry` (keyed by the event's t0 / duration). Both flavours map
 * onto `TweenRegistry.addPosition` / `addDrive`.
 *
 * Pass it as the `data` argument of `self.in(delay, hook, mu, { tween })` (the
 * scheduler reads `data.tween`); in continuous/mock mode (no DES scheduler) it
 * is inert — the continuous event heap carries the data through to the hook
 * but registers no tween (the transport sim animates continuously anyway).
 */
export interface TweenSpec {
  /** Position tween: lerp `target.position` from `from` to `to` over the interval. */
  readonly tween:
    | {
        readonly kind: 'position';
        /** The visual to move (a `PositionTweenTarget` — typically `mu.visual`). */
        readonly target: unknown | null;
        readonly from: readonly [number, number, number];
        readonly to: readonly [number, number, number];
        /**
         * Integer id of the MU this tween moves (plan-262 Phase 3, optional).
         * Lets the DES runner keep the tween WINDOW for a HEADLESS MU
         * (`target === null` in FastForward) so the MU can be positioned and
         * re-connected when it is materialised on FastForward exit.
         */
        readonly muId?: number;
      }
    | {
        readonly kind: 'drive';
        /** The drive to interpolate (a `DriveTweenTarget` wrapper). */
        readonly drive: unknown | null;
        readonly from: number;
        readonly to: number;
      }
    | {
        readonly kind: 'path';
        /**
         * Arc-length sampler (structurally a `PathTweenSampler`, tween-registry
         * — typically an `RVPath`): `getAbsPosition(meters, out)` plus optional
         * `getAbsDirection`/`align` for the pose. Kept `unknown` like `target`
         * so the public spec stays import-free (plan-268 Phase 3).
         */
        /** Legacy live sampler fallback. New persisted events use `pathRef`. */
        readonly path?: unknown | null;
        /** Stable id resolved from the path registry at execution/restore time. */
        readonly pathRef?: string;
        /** Arc-length START address on the path, in METERS. */
        readonly fromS: number;
        /** Arc-length END address on the path, in METERS. */
        readonly toS: number;
        /**
         * The visual to move (a `PathTweenTarget` — e.g. the lazily-created
         * root pose target `self.pathTween` defaults to). Null → the runner
         * registers nothing (headless — the end state is set by the des hook).
         */
        readonly target?: unknown | null;
        /** Optional MU whose visual is resolved lazily at execution/restore. */
        readonly muId?: number;
      }
    | {
        readonly kind: 'axes';
        /** Stable hierarchy path of the RobotIK anchor. */
        readonly anchorRef: string;
        /** Normalized visual windows inside the enclosing DES event duration. */
        readonly phases: readonly {
          readonly at0: number;
          readonly at1: number;
          readonly axes: readonly {
            /** Stable hierarchy path of one axis Drive node. */
            readonly driveRef: string;
            readonly from: number;
            readonly to: number;
          }[];
        }[];
        /** Axes default to smoothstep; explicit linear is supported. */
        readonly ease?: 'linear' | 'scurve';
      };
}

/**
 * A unified material-flow port. EXTENDS Plan-196's `TransportLink`:
 *   port.id === TransportLink.partnerSnapId === partner snap id
 *   port.ownerComponent fills TransportLink.partnerComponent (DES handshake)
 */
export interface Port extends TransportLink {
  /** Stable port id — equals `partnerSnapId` (the partner snap's id). */
  readonly id: string;
  /** Flow role from the topology resolver (direction-classified). */
  readonly role: 'input' | 'output';
  /** The partner LayoutObject root (alias of `TransportLink.partnerRoot`). */
  readonly ownerRoot: Object3D;
  /**
   * THIS component's OWN local port snap node (its `.position` is root-local).
   * Routers (turntable) feed it to the angle math — the local snap is the
   * correct frame, NOT `ownerRoot` (the partner root, scene-positioned). Optional:
   * distance-fallback ports have no snap, so consumers use `snapNode ?? ownerRoot`.
   */
  readonly snapNode?: Object3D;
  /**
   * The partner's MaterialFlowInstance for the DES object-handshake. Fills the
   * `partnerComponent` slot Plan-196 reserved (null on the continuous path).
   */
  readonly ownerComponent: unknown | null;
  /** Optional world dispatch angle (deg) for routers — filled by P4. */
  worldAngle?: number;
}

// ─── Declarative `signals` block + typed `self.sig` (Plan 197 §2.4b-A) ────

/**
 * The shape of a definition's optional `signals` block: a map from a short key
 * (e.g. `Run`) to its PLC signal type. The factory auto-declares each as
 * `${def.type}.${key}` and exposes a typed accessor on `self.sig.<key>`.
 */
export type SignalShape = Record<string, SignalType>;

/**
 * Value type carried by a PLC signal type: Bool → boolean, Int/Float → number.
 * Drives the `get()`/`set()` typing of every `self.sig.<key>` accessor.
 */
export type SignalValue<T extends SignalType> = T extends `${string}Bool`
  ? boolean
  : number;

/** A single typed signal accessor — `get()`/`set()` against the scoped store. */
export interface SignalAccessor<T extends SignalType> {
  /** Read the current value (boolean for Bool signals, number for Int/Float). */
  get(): SignalValue<T>;
  /** Write a new value (boolean for Bool signals, number for Int/Float). */
  set(value: SignalValue<T>): void;
}

/**
 * The `self.sig` surface: one keyed, value-typed accessor per `signals` entry.
 * A mapped type over the `signals` shape so `self.sig.Run` is key-checked and
 * `self.sig.Run.get()` returns `boolean` (for `PLCInputBool`), etc.
 */
export type SigAccessors<SIG extends SignalShape> = {
  readonly [K in keyof SIG]: SignalAccessor<SIG[K]>;
};

// ─── self interface ─────────────────────────────────────────────────────

export interface MaterialFlowSelf<
  S = Record<string, never>,
  SIG extends SignalShape = Record<string, never>,
> {
  readonly type: string;
  readonly kind: MaterialFlowKind;
  readonly root: Object3D;
  readonly node: Object3D;
  /** Opaque viewer handle (== rv.viewer) — the type isSurfaceOccupied accepts. */
  readonly viewer: unknown;
  /** DES integer entity id; -1 in pure continuous. */
  readonly entityId: number;
  readonly mode: SimulationMode;

  /** Per-instance mutable state slot — behaviours store resolved nodes/handles/flags here. */
  readonly local: S;

  // Signals — instance-scoped, identical surface to rv.signals.
  readonly signals: {
    get<T = unknown>(name: string): T;
    set(name: string, value: boolean | number): void;
    on(name: string, cb: (value: boolean | number) => void): void;
  };
  /**
   * Typed accessors for the definition's `signals` block (Plan 197 §2.4b-A).
   * `self.sig.Run.get()` / `self.sig.Run.set(v)` are key-checked and value-typed
   * (boolean for Bool, number for Int/Float). Empty when no `signals` block is
   * declared. Each accessor reads/writes through `self.signals` under the scoped
   * name `${type}.${key}`.
   */
  readonly sig: SigAccessors<SIG>;
  /** Declare a signal (setup() only — forwards to rv.signal). */
  signal(name: string, opts: SignalOpts): void;
  /** Stamp an inspector/badge companion component (forwards to rv.behavior(rv.root,...)). */
  stamp(type: string, props: Record<string, unknown>): void;

  // ── Toolkit: convention-based node resolution + handles (delegate to the
  //    _shared/loader helpers with self.root / selfDrives(self) / self.viewer).
  /**
   * First convention node of `kind` under root, or null — like Unity
   * `GetComponentInChildren`. `self.find('transport')` / `'sensor'` / `'rotary'`.
   */
  find(kind: NodeKind): Object3D | null;
  /**
   * ALL convention nodes of `kind` under root — like Unity
   * `GetComponentsInChildren`. Use when a component has several of a kind (e.g. a
   * transfer with an X and a Z transport axis). `find(kind)` === `findAll(kind)[0]`.
   */
  findAll(kind: NodeKind): Object3D[];
  /** Lazy belt handle (`run(forward)`) for a transport node. */
  attachBelt(node: Object3D | null): BeltHandle;
  /** Lazy positioned-drive handle (`run/moveTo/isAtTarget/stop`) for a drive node. */
  attachDrive(node: Object3D | null): DriveHandle;
  /**
   * Unity-style AddComponent: attach a drive behavior model (`Drive_Simple`,
   * `Drive_DestinationMotor`) to a drive node. Its schema-declared standard
   * signals are created via {@link addSignal}, wired into the component
   * properties and stamped into rv_extras — identical to a GLB-imported
   * component. Pass `wiring` to connect individual slots to your own signals
   * (from `self.addSignal`) instead; wired slots are not auto-created.
   * Idempotent; returns the (existing or new) instance, or null when the node
   * is absent / carries no Drive.
   */
  addComponent(node: Object3D | null, type: AttachableDriveBehaviorType, wiring?: SignalWiring): RVComponent | null;
  /**
   * Unity-style AddSignal: create ONE signal for this component. The leaf lands
   * in the component's `Signals` folder (or under `opts.at` for any other
   * hierarchy level), is registered in store + hierarchy and returned as a
   * handle whose `path` wires straight into a component property.
   */
  addSignal(node: Object3D, slot: string, type: PlcSignalType, opts?: AddSignalOpts): SignalHandle;
  /**
   * Subscribes to occupancy changes of the Sensor component on `node`.
   * The listener is automatically removed with the behavior context.
   */
  onSensorChanged(node: Object3D, cb: (occupied: boolean) => void): void;
  /** True when a live MU is physically on a transport surface under `node`. */
  surfaceOccupied(node: Object3D): boolean;
  /** Declare the public 4-signal material-flow contract (Flow.Run/Occupied/Running/PartCount). */
  declareFlowSignals(): void;
  /** Cached single-successor downstream interlock for the continuous hot path. */
  downstreamInterlock(): { occupied(): boolean };
  /**
   * True when this component is connected to a live signal — i.e. ANY of its
   * signals is bound to a source from realvirtual CONNECT (a PLC) or the built-in
   * virtual PLC. When wired the component's internal simulation should defer to
   * the live values (the relay is authoritative). Standard detection — no
   * per-signal name-building in the component code.
   */
  readonly isWired: boolean;
  /** Disable this instance: warn + set local.disabled — the factory then gates setup/fixedUpdate. */
  disable(reason: string): void;
  /** True once `self.disable()` has been called (factory gate). */
  readonly disabled: boolean;

  // Scheduling — kernel-agnostic (plan-210 §6b): DES scheduler when injected,
  // continuous event heap (drained by the fixed tick) otherwise.
  in(delay: number, hook: DesHookName, mu?: MU | null, data?: unknown): number;
  at(time: number, hook: DesHookName, mu?: MU | null, data?: unknown): number;
  cancel(eventId: number): void;
  readonly now: number;
  /**
   * Build a PATH tween spec (plan-268 Phase 3) for a DES duration event: pass
   * it as the `data` of `self.in(transit, 'Arrival', mu, self.pathTween(...))`
   * and the private runner samples `getAbsPosition` over the scheduled window —
   * a curved transit renders ON the curve instead of cutting the chord.
   * FastForward writes no transforms; the final value lands on the arc-length
   * END position (tween-registry contract).
   *
   * `path` is the arc-length sampler (an `RVPath`), `fromM`/`toM` the arc
   * addresses in METERS. `target` defaults to a lazily-created pose target
   * that writes THIS component's root position + quaternion (allocated once
   * per self); pass an explicit target to move something else, or `null` to
   * register no visual. Pure data — inert in continuous mode like every
   * TweenSpec (the continuous sim animates via fixedUpdate anyway).
   */
  pathTween(path: unknown, fromM: number, toM: number, target?: unknown | null, muId?: number): TweenSpec;
  /** Build a JSON-safe multi-axis tween over normalized phase windows. */
  axesTween(
    anchorRef: string,
    phases: Extract<TweenSpec['tween'], { kind: 'axes' }>['phases'],
    ease?: 'linear' | 'scurve',
  ): TweenSpec;

  // Drives.
  drive(ref: NodeRef): SelfDrive | null;

  // Ports — unified snap-graph ∪ IN*/OUT* model.
  readonly ports: ReadonlyArray<Port>;
  inputs(): Port[];
  outputs(): Port[];
  freeOutputs(mu?: MU): Port[];
  /** Per-port downstream interlock used by `logic.shouldFlow` (continuous: signal-backed). */
  downstreamOccupied(port?: Port): boolean;

  // State machine.
  setState(name: string): void;
  readonly state: string;

  /**
   * Book a CANONICAL statistics category (Working | Blocked | Empty | Setup |
   * Failure) for utilization tracking. Separate from `setState` so an FSM
   * component (Turntable, ChainTransfer) keeps its internal phase in `self.state`
   * while reporting a clean category to the stats — and so a non-FSM component
   * (Conveyor) can report its category without inventing an FSM. Booked into the
   * StateStatistics sink (continuous) and forwarded via `onStatState` to the DES
   * component (DES), so the SAME component code captures stats in BOTH modes.
   * De-duped: re-stating the current category is a no-op (the interval runs on).
   */
  statState(name: string): void;

  // Statistics (Plan 201). When the self has a StateStatistics sink these book
  // into it; otherwise they are no-ops. `statState` feeds state time.
  /** Count completed output (parts) for throughput statistics. */
  statOutput(n?: number): void;
  /** Start a cycle timer (statistics). */
  statCycleStart(): void;
  /** Close a cycle timer (statistics). Ignored if no cycle was started. */
  statCycleEnd(): void;

  // MU transfer / load.
  transfer(mu: MU, fromPort?: Port): void;
  /**
   * Would the downstream accept `mu` right now? DES routing pre-check (Plan 194
   * §2.5 `self.downstream?.canAccept(mu)`): in DES mode it queries the resolved
   * downstream component's handshake; in continuous/mock mode (no backend) it
   * returns `true` (the transport surface, not a handshake, gates the flow).
   * `port` selects a specific output for multi-output routers.
   */
  downstreamCanAccept(mu: MU, port?: Port): boolean;
  /**
   * Mint a fresh MU (sources). In DES mode this creates + registers a real
   * runner-backed MU (so the manager tracks it, ids are global, and the tween
   * registry can animate its `visual`). In continuous/mock mode it returns a
   * plain structural MU. Use this in `des.onGenerate` instead of fabricating a
   * `{ id }` literal so the model-load flow tracks every part.
   */
  spawn(visualTemplateId?: string): MU;
  readonly mus: ReadonlyArray<MU>;
  readonly currentLoad: number;
  /** Capacity promised to upstream holders but not committed yet. */
  readonly reservedLoad: number;
  downstreamFreeCapacity(port?: Port): number;
  reserveDownstream(
    n: number,
    port?: Port,
    carrier?: { ref: MuRef; slots: number },
  ): ReservationHandle;
  /** Resolve a restored active reservation by id for an event payload. */
  reservation(id: number): ReservationHandle | null;

  contextMenu(target: NodeRef, items: ContextMenuItem[]): void;

  /** Snapshot-safe custom runtime state (== DESComponent.prop). */
  readonly prop: Record<string, JsonValue>;
}

// ─── Topology resolver (snap-graph primary, autoConnect fallback) ─────────

/**
 * Build the unified `Port[]` for a node.
 *
 * Primary source: the snap-graph. `classifyConnections` gives every PAIRED
 * snap a direction-classified `role` (input/output) — used for routers
 * (turntables) and any multi-port component. `findOutputPairings` is the
 * single-successor convenience the conveyor uses; we fold any output pairings
 * not already covered into the result so a plain conveyor (which may only have
 * output snaps modelled) still exposes its downstream port.
 *
 * Fallback (autoConnect by world-distance, V2 §2.6): NOT yet implemented —
 * returns no extra ports. When the snap-graph yields nothing (no snap-point
 * plugin, or unsnapped placement) `resolvePorts` returns `[]`. The autoConnect
 * distance heuristic (OUT-to-IN nearest, role from IN-/OUT- node name) lands
 * with P4/topology-resolver.ts. See the TODO(P5) note below.
 */
export function resolvePorts(rv: RVBindContext): Port[] {
  const out: Port[] = [];
  const seen = new Set<string>();

  // 1. Direction-classified connections (works for routers + bidirectional ports).
  const conns: PortConnection[] = classifyConnections(rv.viewer, rv.root);
  for (const c of conns) {
    const p = portFromConnection(rv, c);
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }

  // 2. Output pairings the conveyor relies on (single-successor); fold in any
  //    not already represented (e.g. when classifyConnections returns nothing
  //    because no component registry / transport surface is present).
  const pairings: OutputPairing[] = findOutputPairings(rv.viewer, rv.root);
  for (const pr of pairings) {
    if (seen.has(pr.pairedSnap.id)) continue;
    seen.add(pr.pairedSnap.id);
    out.push(portFromPairing(rv, pr));
  }

  // 3. TODO(P5): autoConnect distance fallback (no snaps → nearest OUT→IN by
  //    world distance, role from IN*/OUT* node name). Intentionally a no-op
  //    for now — documented in resolvePorts() jsdoc above. Returns [] here.

  return out;
}

/** A Port built from a direction-classified PortConnection. */
function portFromConnection(rv: RVBindContext, c: PortConnection): Port {
  const link = makeLinkLike(rv, c.snap.id, c.pairedSnap.id, c.ownerRoot);
  return {
    ...link,
    id: c.pairedSnap.id,
    role: c.role,
    ownerRoot: c.ownerRoot,
    snapNode: c.snap.object3D, // this component's own local snap (angle-math frame)
    ownerComponent: null, // continuous path; DES runner fills it (P5)
  };
}

/** A Port built from a single-successor OutputPairing (always role 'output'). */
function portFromPairing(rv: RVBindContext, pr: OutputPairing): Port {
  const link = makeLinkLike(rv, pr.snap.id, pr.pairedSnap.id, pr.ownerRoot);
  return {
    ...link,
    id: pr.pairedSnap.id,
    role: 'output',
    ownerRoot: pr.ownerRoot,
    snapNode: pr.snap.object3D, // this component's own local snap (angle-math frame)
    ownerComponent: null,
  };
}

/**
 * Build the TransportLink fields for a port. This mirrors `makeLink` in
 * transport-links.ts (kept private there) using the same per-port/root
 * `Flow.Occupied@<id>` signal convention so the addressing is identical
 * across Plan 196 and Plan 194. The per-root interlock symbol comes from the
 * shared `flowOccupiedRootSignal()` helper (which folds in `FLOW_OCCUPIED` with
 * the `.`-separator) — no second literal lives here, so makeLink and makeLinkLike
 * can never diverge on the separator.
 */
function makeLinkLike(
  rv: RVBindContext,
  mySnapId: string,
  partnerSnapId: string,
  partnerRoot: Object3D,
): TransportLink {
  const partnerRootSig = flowOccupiedRootSignal(partnerRoot.name);
  return {
    mySnapId,
    partnerSnapId,
    partnerRoot,
    partnerComponent: null,
    occupied(): boolean {
      const perPort = `${partnerRootSig}@${partnerSnapId}`;
      const name = rv.signals.get(perPort) !== undefined ? perPort : partnerRootSig;
      return rv.signals.get<boolean>(name) === true;
    },
    upstreamWaiting(): boolean {
      return rv.signals.get<boolean>(partnerRootSig) === true;
    },
    setOccupied(v: boolean): void {
      rv.signals.set(`${FLOW_OCCUPIED}@${mySnapId}`, v);
    },
  };
}

/** Typed initial value for an auto-declared signal: Bool → false, Int/Float → 0. */
function signalInitialValue(type: SignalType): boolean | number {
  return type.includes('Bool') ? false : 0;
}

/**
 * Read a numeric config value from `self.prop` (the rv_extras bag the binding
 * wiring fills) with a default fallback. Non-finite / missing → `def`.
 */
export function readConfigNumber(
  self: Pick<MaterialFlowSelf, 'prop'>,
  key: string,
  def: number,
): number {
  const v = self.prop[key];
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : def;
}

// ─── createSelf ─────────────────────────────────────────────────────────

/** Minimal definition shape `createSelf` needs (avoids a cycle with define-material-flow). */
export interface SelfDef {
  readonly type: string;
  readonly kind: MaterialFlowKind;
  /**
   * Signal-name namespace for the `signals` block / `self.sig` accessors
   * (Plan 197 §2.4b-A). Each signal is scoped `${signalNamespace ?? type}.${key}`.
   * Defaults to `type`; the material-flow interop components (Conveyor/Turntable/
   * Sink) set `signalNamespace: 'Flow'` so `self.sig.<key>` and the factory
   * auto-declare resolve to the shared `Flow.*` interop signal names instead of
   * the per-component `<type>.*` names.
   */
  readonly signalNamespace?: string;
  /**
   * The definition's optional `signals` block (Plan 197 §2.4b-A). `createSelf`
   * builds the typed `self.sig.<key>` accessor map from it (when `opts.signals`
   * is not given) AND auto-declares each signal into the store, so the DES path
   * (which calls `createSelf` directly, without the library-component factory)
   * gets identical `self.sig` accessors and declared signals as the continuous
   * path. Each accessor reads/writes the scoped name
   * `${signalNamespace ?? type}.${key}`.
   */
  readonly signals?: SignalShape;
}

export interface CreateSelfOptions<
  S = Record<string, never>,
  SIG extends SignalShape = Record<string, never>,
> {
  /** Simulation mode for this self. Default 'continuous'. */
  mode?: SimulationMode;
  /** DES entity id; -1 in pure continuous (default). */
  entityId?: number;
  /**
   * Declarative `signals` block (Plan 197 §2.4b-A). When present (or taken from
   * `def.signals`), `createSelf` BOTH builds the typed `self.sig.<key>` accessor
   * map AND auto-declares each signal into the store under the scoped name
   * `${signalNamespace ?? type}.${key}` with a typed default (Bool→false,
   * Int/Float→0). Declaration happens here — on whichever path (continuous
   * factory or DES runner) builds the self — so behaviours never re-declare in
   * `setup`; they only override non-default initial values via `self.sig.set()`.
   */
  signals?: SIG;
  /**
   * DES scheduling backend (P5). When present, `self.in/at/cancel/now` delegate
   * to it. Absent (continuous) → they run on a lazily-created continuous event
   * heap advanced by the fixed tick (plan-210 §6b — kernel-agnostic timers).
   */
  scheduler?: SelfScheduler | null;
  /**
   * Continuous hook dispatcher (plan-210 §6b): receives every due timer event
   * (`self.in`/`self.at`) drained by the fixed tick when NO DES scheduler is
   * injected. The SDK adapter (and, later, the library-component factory)
   * wires it to the component's `des.on(hook, mu, data)` handler so timer
   * hooks run identically in both kernels. Without it, a due event warns once
   * and is dropped (visible, not silent).
   */
  onHook?: (hook: DesHookName, mu: MU | null, data: unknown) => void;
  /**
   * DES MU-transfer backend (P5). When present, `self.transfer(mu, fromPort)`
   * delegates the blocking handshake (canAccept → accept → release / block)
   * to it. Absent (continuous) → `transfer` is the implicit no-op hand-off
   * (the transport manager moves MUs surface→surface).
   */
  onTransfer?: ((mu: MU, fromPort?: Port) => void) | null;
  /**
   * DES MU factory (P5). When present, `self.spawn()` mints a real runner-backed
   * MU. Absent (continuous) → `self.spawn()` returns a plain structural MU with a
   * locally-incremented id.
   */
  spawnMU?: ((visualTemplateId?: string) => MU) | null;
  /**
   * DES downstream-acceptance probe (P5). When present, `self.downstreamCanAccept`
   * delegates to it (the runner queries the resolved downstream adapter). Absent
   * (continuous) → `downstreamCanAccept` returns `true`.
   */
  canAcceptDownstream?: ((mu: MU, port?: Port) => boolean) | null;
  /** Adapter-owned canonical MU collection (DES); omitted on continuous. */
  mus?: (() => ReadonlyArray<MU>) | null;
  /** Adapter-owned incoming reservation count (DES); omitted on continuous. */
  reservedLoad?: (() => number) | null;
  /** Remaining downstream component slots after active reservations. */
  downstreamFreeCapacity?: ((port?: Port) => number) | null;
  /** Persisted downstream-reservation backend (DES only). */
  reserveDownstream?: ((
    n: number,
    port?: Port,
    carrier?: { ref: MuRef; slots: number },
  ) => ReservationHandle) | null;
  /** Resolve a restored reservation record by stable id (DES only). */
  reservation?: ((id: number) => ReservationHandle | null) | null;
  /** Per-instance state object exposed as `self.local` (defaults to `{}`). */
  local?: S;
  /**
   * Plan 201 — per-component state-statistics sink. When present, `self.setState`
   * ALSO books state time into it, and `self.statOutput/statCycleStart/statCycleEnd`
   * delegate to it. Absent → every stat call is a no-op. The caller (a createSelf
   * caller wired to the StatisticsManager) constructs it with the shared sim clock
   * (`() => viewer.simTime`) and registers it for aggregation.
   */
  statistics?: StateStatistics | null;
  /**
   * DES statistics forwarder (Plan 201, both-modes). When present, `self.statState`
   * ALSO forwards the canonical category here. The DES bind wires it to the live
   * `DESComponent.setState` so the discrete-event stats capture the same Working /
   * Blocked / Empty / Setup categories the continuous `StateStatistics` does.
   * Absent (continuous) → only the `statistics` sink is fed.
   */
  onStatState?: ((name: string) => void) | null;
}

/** DES scheduling backend the DESRunner injects (P5). */
export interface SelfScheduler {
  in(delay: number, hook: DesHookName, mu?: MU | null, data?: unknown): number;
  at(time: number, hook: DesHookName, mu?: MU | null, data?: unknown): number;
  cancel(eventId: number): void;
  readonly now: number;
}

/**
 * Project a `MaterialFlowSelf` over an existing `RVBindContext`.
 *
 * The signal/drive/find/contextMenu/onFixedUpdate surface forwards straight
 * through `rv`, so a continuous definition behaves exactly like a hand-written
 * behavior. Ports are resolved lazily (the snap-graph mutates as assets are
 * placed); `state`/`prop`/`mus` are local mutable state on the self.
 */
export function createSelf<
  S = Record<string, never>,
  SIG extends SignalShape = Record<string, never>,
>(
  rv: RVBindContext,
  def: SelfDef,
  opts: CreateSelfOptions<S, SIG> = {},
): MaterialFlowSelf<S, SIG> {
  const mode: SimulationMode = opts.mode ?? 'continuous';
  const entityId = opts.entityId ?? -1;
  const scheduler = opts.scheduler ?? null;
  const onTransfer = opts.onTransfer ?? null;
  const spawnMU = opts.spawnMU ?? null;
  const canAcceptDownstream = opts.canAcceptDownstream ?? null;
  const adapterMus = opts.mus ?? null;
  const adapterReservedLoad = opts.reservedLoad ?? null;
  const downstreamFreeCapacity = opts.downstreamFreeCapacity ?? null;
  const reserveDownstream = opts.reserveDownstream ?? null;
  const reservation = opts.reservation ?? null;
  const local = (opts.local ?? {}) as S;
  const statistics = opts.statistics ?? null;
  const onStatState = opts.onStatState ?? null;
  let lastStat = ''; // last canonical category booked via statState (de-dupe)
  let localMuId = 0;

  // Build the typed `self.sig` accessor map from the optional `signals` shape.
  // Each accessor reads/writes `self.signals` under the scoped name
  // `${signalNamespace ?? type}.${key}` (the same convention the factory uses to
  // auto-declare). The namespace defaults to `type`, but the material-flow interop
  // components (Conveyor/Turntable/Sink → `Flow.*`) override it. Empty object when
  // no `signals` block was passed.
  const signalNamespace = def.signalNamespace ?? def.type;
  // The accessor map uses the explicit `opts.signals` shape when given, else the
  // definition's own `signals` block (so the DES path, which calls createSelf
  // without opts.signals, still gets a populated `self.sig`).
  const sigShape = opts.signals ?? def.signals;
  const sig = {} as Record<string, SignalAccessor<SignalType>>;
  if (sigShape) {
    for (const key of Object.keys(sigShape)) {
      const scoped = `${signalNamespace}.${key}`;
      sig[key] = {
        get(): SignalValue<SignalType> {
          return rv.signals.get(scoped) as SignalValue<SignalType>;
        },
        set(value: SignalValue<SignalType>): void {
          rv.signals.set(scoped, value);
        },
      };
    }
  }

  const prop: Record<string, JsonValue> = {};
  const mus: MU[] = [];
  let state = 'idle';
  let disabled = false;

  // Instance scope is fixed for the lifetime of this self (rv.root never
  // re-parents during a bind) — compute the live-control prefix ONCE instead
  // of walking the parent chain on every `isWired` read (per fixed tick).
  const liveControlPrefix = (() => {
    const scope = instanceScope(rv.root);
    return scope ? `${scope}.` : '';
  })();

  // Lazy: only allocate the shared interlock when an instance actually calls
  // self.downstreamOccupied() / self.downstreamInterlock() (behaviours that
  // never gate on the downstream don't pay for it). The SAME cached object backs
  // both the one-shot `downstreamOccupied()` and the per-tick `downstreamInterlock()`.
  let interlock: { occupied(): boolean } | null = null;
  const getInterlock = (): { occupied(): boolean } =>
    (interlock ??= createDownstreamInterlock(rv));

  // ── Continuous timers (plan-210 §6b) ─────────────────────────────────────
  // Without a DES scheduler, `self.in/at/cancel/now` run on a lazily-created
  // event heap: the fixed tick advances the virtual clock and drains all
  // events with `time <= now` (delta-cycle drain). The heap + tick hook are
  // only allocated when an instance actually schedules (or reads `now`), so
  // pure tick-polled behaviours pay nothing. NEVER used in DES mode — there
  // the injected scheduler (private runner) dispatches, unchanged.
  const onHook = opts.onHook ?? null;
  // Default path-tween target (plan-268 Phase 3): writes THIS component's root
  // pose. Allocated ONCE per self on first use — the specs are per event, the
  // target is not (GC discipline).
  let rootPoseTarget: {
    setPosition(v: Vector3): void;
    setQuaternion(q: Quaternion): void;
  } | null = null;
  let continuousTimers: RVEventHeap | null = null;
  let continuousNow = 0;
  let warnedNoHook = false;
  const getContinuousTimers = (): RVEventHeap => {
    if (!continuousTimers) {
      const heap = new RVEventHeap();
      continuousTimers = heap;
      heap.addListener((ev) => {
        if (onHook) {
          onHook(ev.hook, (ev.mu ?? null) as MU | null, ev.data);
        } else if (!warnedNoHook) {
          warnedNoHook = true;
          console.warn(
            `[material-flow] timer hook '${ev.hook}' fired in continuous mode but no ` +
              `onHook dispatcher is wired (type='${def.type}') — pass CreateSelfOptions.onHook`,
          );
        }
      });
      rv.onFixedUpdate((dt) => {
        continuousNow += dt;
        heap.drainUntil(continuousNow);
      });
    }
    return continuousTimers;
  };

  const self: MaterialFlowSelf<S, SIG> = {
    type: def.type,
    kind: def.kind,
    root: rv.root,
    node: rv.root,
    viewer: rv.viewer,
    entityId,
    mode,

    local,

    signals: rv.signals,
    sig: sig as SigAccessors<SIG>,
    signal(name: string, o: SignalOpts): void {
      rv.signal(name, o);
    },
    stamp(type: string, props: Record<string, unknown>): void {
      rv.behavior(rv.root, type, props);
    },

    // ── Toolkit (delegates to the _shared/loader helpers) ──────────────────
    // Generic, table-driven node finders: the kind selects a name predicate from
    // NODE_KIND_TESTS, so adding a convention kind needs no new method here.
    find(kind: NodeKind): Object3D | null {
      return findFirst(rv.root, NODE_KIND_TESTS[kind]);
    },
    findAll(kind: NodeKind): Object3D[] {
      return findAllNodes(rv.root, NODE_KIND_TESTS[kind]);
    },
    attachBelt(node: Object3D | null): BeltHandle {
      return attachBelt(selfDrives(self), node);
    },
    attachDrive(node: Object3D | null): DriveHandle {
      return attachDrive(selfDrives(self), node);
    },
    addComponent(node: Object3D | null, type: AttachableDriveBehaviorType, wiring?: SignalWiring): RVComponent | null {
      if (!node) return null;
      return attachDriveBehaviorByCode(rv.viewer as unknown as DriveBehaviorHostViewer, node, type, wiring);
    },
    addSignal(node: Object3D, slot: string, type: PlcSignalType, opts?: AddSignalOpts): SignalHandle {
      const host = rv.viewer as unknown as DriveBehaviorHostViewer | undefined;
      if (!host || !host.signalStore || !host.registry) {
        // Headless self (no store yet, e.g. unit tests) — return a stub handle so
        // setup() stays robust; the paired addComponent no-ops in the same
        // condition, so this handle is never actually wired.
        return { name: slot, path: '', node };
      }
      const handle = addSignal(node, slot, type, host.signalStore, host.registry, opts);
      host.signalStore.buildIndex();
      return handle;
    },
    onSensorChanged(node: Object3D, cb: (occupied: boolean) => void): void {
      const host = rv.viewer as unknown as {
        transportManager?: { sensors?: RVSensor[] } | null;
      };
      const sensor = host.transportManager?.sensors?.find(candidate => candidate.node === node);
      if (!sensor) {
        console.warn(`[material-flow] Sensor component not found on '${node.name}'`);
        return;
      }
      const listener = (): void => cb(sensor.occupied);
      sensor.addFeedbackListener(listener);
      rv.onDispose(() => sensor.removeFeedbackListener(listener));
    },
    surfaceOccupied(node: Object3D): boolean {
      return isSurfaceOccupied(rv.viewer, node);
    },
    declareFlowSignals(): void {
      declareFlowSignalsWith((n, o) => rv.signal(n, o));
    },
    downstreamInterlock(): { occupied(): boolean } {
      return getInterlock();
    },
    get isWired(): boolean {
      return isAnyLiveControlled(liveControlPrefix);
    },
    disable(reason: string): void {
      disabled = true;
      (local as Record<string, unknown>).disabled = true;
      console.warn(`[material-flow] ${def.type} disabled: ${reason}`);
    },
    get disabled(): boolean {
      return disabled;
    },

    in(delay, hook, mu, data): number {
      if (scheduler) return scheduler.in(delay, hook, mu, data);
      return getContinuousTimers().schedule(continuousNow + delay, hook, mu ?? null, data);
    },
    at(time, hook, mu, data): number {
      if (scheduler) return scheduler.at(time, hook, mu, data);
      return getContinuousTimers().schedule(time, hook, mu ?? null, data);
    },
    cancel(eventId: number): void {
      if (scheduler) {
        scheduler.cancel(eventId);
        return;
      }
      continuousTimers?.cancel(eventId);
    },
    get now(): number {
      if (scheduler) return scheduler.now;
      // Lazily start the continuous clock on first read — otherwise a
      // component that reads `now` before ever scheduling would see a frozen 0.
      getContinuousTimers();
      return continuousNow;
    },
    pathTween(path: unknown, fromM: number, toM: number, target?: unknown | null, muId?: number): TweenSpec {
      // `undefined` target → the shared root pose target (position + quaternion
      // of this component's root). An EXPLICIT null stays null (no visual).
      if (target === undefined) {
        rootPoseTarget ??= {
          setPosition: (v: Vector3): void => { rv.root.position.copy(v); },
          setQuaternion: (q: Quaternion): void => { rv.root.quaternion.copy(q); },
        };
        target = rootPoseTarget;
      }
      return {
        tween: {
          kind: 'path',
          ...(
            typeof (path as { id?: unknown } | null)?.id === 'string'
              ? { pathRef: (path as { id: string }).id }
              : { path: path ?? null }
          ),
          fromS: fromM,
          toS: toM,
          target: target ?? null,
          ...(typeof muId === 'number' ? { muId } : {}),
        },
      };
    },
    axesTween(
      anchorRef: string,
      phases: Extract<TweenSpec['tween'], { kind: 'axes' }>['phases'],
      ease: 'linear' | 'scurve' = 'scurve',
    ): TweenSpec {
      return {
        tween: {
          kind: 'axes',
          anchorRef,
          phases,
          ease,
        },
      };
    },

    drive(ref: NodeRef): SelfDrive | null {
      const d = rv.drives.get(ref);
      return (d as SelfDrive | null) ?? null;
    },

    get ports(): ReadonlyArray<Port> {
      return resolvePorts(rv);
    },
    inputs(): Port[] {
      return resolvePorts(rv).filter(p => p.role === 'input');
    },
    outputs(): Port[] {
      return resolvePorts(rv).filter(p => p.role === 'output');
    },
    freeOutputs(_mu?: MU): Port[] {
      // A free output = one whose downstream is NOT occupied (Plan 196:
      // `outputs().filter(p => !linkOf(rv,p).occupied())`).
      return resolvePorts(rv).filter(p => p.role === 'output' && !p.occupied());
    },
    downstreamOccupied(port?: Port): boolean {
      // Per-port when given (multi-output routers); else the conveyor's
      // allocation-free single-successor interlock (Plan 196), resolved lazily.
      return port ? port.occupied() : getInterlock().occupied();
    },

    setState(name: string): void {
      // FSM phase ONLY (e.g. Turntable 'receiving'/'aligning_in'). Statistics go
      // through the canonical `statState` channel so an FSM name never pollutes
      // the utilization buckets and the deadlock-guard on `self.state` is intact.
      state = name;
    },
    statState(name: string): void {
      if (name === lastStat) return; // re-stating current category → interval runs on
      lastStat = name;
      statistics?.setState(name); // continuous sink (no-op when absent)
      onStatState?.(name);        // DES forwarder → DESComponent (no-op when absent)
    },
    get state(): string {
      return state;
    },
    statOutput(n = 1): void {
      statistics?.output(n);
    },
    statCycleStart(): void {
      statistics?.cycleStart();
    },
    statCycleEnd(): void {
      statistics?.cycleEnd();
    },

    transfer(mu: MU, fromPort?: Port): void {
      // DES: delegate the blocking handshake (canAccept → accept → release /
      // block) to the runner-injected backend. Continuous: implicit no-op
      // hand-off (the transport manager moves MUs surface→surface).
      if (onTransfer) onTransfer(mu, fromPort);
    },
    spawn(visualTemplateId?: string): MU {
      // DES: a real runner-backed MU (manager-tracked, global id, visual). Else
      // a plain structural MU with a local id (continuous/mock).
      return spawnMU
        ? spawnMU(visualTemplateId)
        : { id: ++localMuId, prop: {}, ...(visualTemplateId ? { visualTemplateId } : {}) };
    },
    downstreamCanAccept(mu: MU, port?: Port): boolean {
      // DES: probe the resolved downstream adapter; continuous/mock: always true
      // (the transport surface gates the flow, not a handshake).
      return canAcceptDownstream ? canAcceptDownstream(mu, port) : true;
    },
    get mus(): ReadonlyArray<MU> {
      return adapterMus ? adapterMus() : mus;
    },
    get currentLoad(): number {
      return adapterMus ? adapterMus().length : mus.length;
    },
    get reservedLoad(): number {
      return adapterReservedLoad?.() ?? 0;
    },
    downstreamFreeCapacity(port): number {
      return downstreamFreeCapacity?.(port) ?? Number.POSITIVE_INFINITY;
    },
    reserveDownstream(n, port, carrier): ReservationHandle {
      if (!reserveDownstream) {
        throw new Error(`[material-flow] reserveDownstream is unavailable in ${mode} mode`);
      }
      return reserveDownstream(n, port, carrier);
    },
    reservation(id: number): ReservationHandle | null {
      return reservation?.(id) ?? null;
    },

    contextMenu(target: NodeRef, items: ContextMenuItem[]): void {
      rv.contextMenu(target, items);
    },

    prop,
  };

  // Auto-declare the `signals` block into the store, ONCE, on whichever path
  // built this self (continuous factory `bind()` OR the DES runner's direct
  // `createSelf`). Each signal is registered under the scoped name
  // `${signalNamespace ?? type}.${key}` with a typed default (Bool→false,
  // Int/Float→0). Behaviours therefore never re-declare in `setup` — they only
  // override the non-default initial values via `self.sig.<key>.set(...)`.
  if (sigShape) {
    for (const key of Object.keys(sigShape)) {
      const type = sigShape[key];
      self.signal(`${signalNamespace}.${key}`, {
        type,
        initialValue: signalInitialValue(type),
      });
    }
  }

  return self;
}
