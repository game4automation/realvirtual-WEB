// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-sdk-self.ts — `SDKSelf`: the value-typed, narrow `self` surface for
 * script components (plan-210 §6 appendix, Tier 0 + Tier-1 shims).
 *
 * DELIBERATELY SEPARATE from `MaterialFlowSelf` — two self implementations
 * coexist (§6 "SDK ist additiv"): `MaterialFlowSelf` stays the rich, bundled,
 * trusted surface for native TS behaviors; `SDKSelf` is the narrow, sandboxed
 * surface for JS-in-GLB components running in QuickJS.
 *
 * Boundary architecture (S1 — value-based, no three.js across the VM line):
 *
 *  - The guest `self` object is built INSIDE the VM by `SDK_SELF_SOURCE`
 *    (evaluated once per context). Its methods call ONE exposed host function
 *    `__rvHostCall(op, …args)` — a whitelist dispatcher on the host-side
 *    `SdkBridge`.
 *  - **Opaque handles:** nodes and components cross the boundary as integer
 *    ids; the guest wraps them in `NodeHandle` / `DriveHandle` / … objects
 *    whose reads/methods are `__rvHostCall`s. No recursive marshalling.
 *  - **World reads return POJOs** ({x,y,z} / {x,y,z,w} / number[16] /
 *    {min,max}); never three.js instances.
 *  - **Math never crosses the boundary:** the `vec3/quat/mat4/aabb` library
 *    is injected as JS source (`rv-sdk-math.ts`) — pure in-VM calls.
 *  - **Determinism:** `self.random()` is a mulberry32 PRNG seeded in the VM
 *    from a per-component seed (derived from the node path — same component
 *    path ⇒ same sequence). No `Date`, no wall clock; `self.now` reads the
 *    kernel scheduler's virtual time.
 *  - **Guest→host callbacks** (sensor.on / signal.on) register a guest-side
 *    callback id; the host notifies via the retained `__cb` lifecycle handler
 *    (see `SDK_SETUP_WRAPPER_SOURCE`).
 */

import { Box3, Quaternion, Vector3, type Object3D } from 'three';
import type { SdkScheduler, ScriptMuRef } from './rv-script-hook';
import type { SdkSceneAccess } from './rv-sdk-scene';
import { findAll as findKindNodes, NODE_KIND_TESTS } from '../library-component-loader';

// ─── Host-side narrow component targets (duck-typed engine slices) ─────────

/** Narrow drive slice (an `RVDrive` satisfies it structurally). */
export interface SdkDriveTarget {
  currentPosition: number;
  currentSpeed: number;
  targetSpeed: number;
  readonly isAtTarget: boolean;
  jogForward: boolean;
  jogBackward: boolean;
  startMove(destination?: number): void;
  stop(): void;
  node?: Object3D;
}

/** Narrow sensor slice. `subscribe` fans out — the SDK supports multiple listeners.
 *  The optional second callback argument carries the occupying MU as a value
 *  reference (plan-259 sensor→MU bridge) — additive, old callbacks ignore it. */
export interface SdkSensorTarget {
  readonly occupied: boolean;
  readonly mode?: 'Raycast' | 'Collision';
  subscribe?(cb: (occupied: boolean, mu?: ScriptMuRef | null) => void): () => void;
  node?: Object3D;
}

export interface SdkBeltTarget {
  run(forward: boolean): void;
  readonly occupied?: boolean;
  readonly speed?: number;
  node?: Object3D;
}

export interface SdkTransportTarget {
  readonly direction?: { x: number; y: number; z: number };
  readonly speed?: number;
  readonly radial?: boolean;
  node?: Object3D;
}

export interface SdkSourceTarget {
  spawn(): ScriptMuRef | null;
  automatic?: boolean;
  interval?: number;
  node?: Object3D;
}

export interface SdkSinkTarget {
  subscribe?(cb: (mu: ScriptMuRef) => void): () => void;
  node?: Object3D;
}

export interface SdkGripTarget {
  pick(): void;
  place(): void;
  readonly gripped?: ReadonlyArray<ScriptMuRef>;
  readonly range?: number;
  node?: Object3D;
}

export interface SdkLogicStepTarget {
  readonly runId?: number;
  readonly state: string;
  readonly progress?: number;
  start(): void;
  reset(): void;
  complete?(): void;
  node?: Object3D;
}

/** Component kinds `self.drive/sensor/…` resolve (Tier-0 handle set). */
export type SdkComponentKind =
  | 'drive' | 'sensor' | 'belt' | 'transport'
  | 'source' | 'sink' | 'grip' | 'logicStep';

type SdkComponentTarget =
  | SdkDriveTarget | SdkSensorTarget | SdkBeltTarget | SdkTransportTarget
  | SdkSourceTarget | SdkSinkTarget | SdkGripTarget | SdkLogicStepTarget;

/** Per-kind resolver the host environment provides (missing kinds resolve null). */
export type SdkComponentResolver = {
  [K in SdkComponentKind]?: (pathOrName: string) =>
    (K extends 'drive' ? SdkDriveTarget
      : K extends 'sensor' ? SdkSensorTarget
      : K extends 'belt' ? SdkBeltTarget
      : K extends 'transport' ? SdkTransportTarget
      : K extends 'source' ? SdkSourceTarget
      : K extends 'sink' ? SdkSinkTarget
      : K extends 'grip' ? SdkGripTarget
      : SdkLogicStepTarget) | null;
};

/** Per-kind LIST resolver (`self.findAll`) — mirrors `SdkComponentResolver`. */
export type SdkComponentListResolver = {
  [K in SdkComponentKind]?: () =>
    ReadonlyArray<K extends 'drive' ? SdkDriveTarget
      : K extends 'sensor' ? SdkSensorTarget
      : K extends 'belt' ? SdkBeltTarget
      : K extends 'transport' ? SdkTransportTarget
      : K extends 'source' ? SdkSourceTarget
      : K extends 'sink' ? SdkSinkTarget
      : K extends 'grip' ? SdkGripTarget
      : SdkLogicStepTarget>;
};

/**
 * Host-side PORT target (phase 1b). One entry per resolved topology port —
 * the same snap-graph source the native TS behaviors use
 * (`classifyConnections`/`findOutputPairings`, see `rv-sdk-ports.ts`).
 * `occupied()/upstreamWaiting()/setOccupied()` carry the per-port-then-root
 * `Flow.Occupied` interlock convention (transport-links.ts) — value-typed,
 * never re-implemented in the guest.
 */
export interface SdkPortTarget {
  readonly id: string;
  readonly role: 'input' | 'output';
  /** This component's OWN local snap node (the angle-math frame). */
  readonly node?: Object3D | null;
  /** The partner LayoutObject root. */
  readonly partnerNode?: Object3D | null;
  /** Optional world dispatch angle in degrees (routers). */
  readonly worldAngle?: number;
  occupied(): boolean;
  upstreamWaiting(): boolean;
  setOccupied(v: boolean): void;
}

/**
 * MU / material-flow backend (phase 1b — replaces the phase-1 shims).
 * Continuous hosts wire `createLocalFlowBackend()` (rv-sdk-flow.ts) or their
 * own; the DES path wires the runner's MU management. Missing members keep
 * the documented shim behavior (warn-once no-op / empty).
 */
export interface SdkFlowBackend {
  /** `self.transfer(mu, fromPort?)` — hand the MU downstream (DES: blocking handshake). */
  transfer?(mu: ScriptMuRef | null, portId?: string | null): void;
  /** `self.spawn()` — mint a real, tracked MU. */
  spawn?(): ScriptMuRef;
  /** `self.mus` — MUs currently held by this component. */
  mus?(): ReadonlyArray<ScriptMuRef>;
  /** `self.currentLoad` — defaults to `mus().length` when absent. */
  currentLoad?(): number;
  /** `self.downstreamOccupied()` without a port (single-successor interlock). */
  downstreamOccupied?(): boolean;
  /** `self.downstreamCanAccept(mu, port?)` — DES handshake probe. */
  downstreamCanAccept?(mu: ScriptMuRef | null, portId?: string | null): boolean;
  /** `mu.park()` — continuous: halt the MU on its surface; DES: hold a capacity slot. */
  park?(muId: number): void;
  /** `mu.release()` — undo `park`. */
  release?(muId: number): void;
  /** Scene node of an MU (for `mu.node`), when the backend can resolve it. */
  muNode?(muId: number): Object3D | null;
}

/** Statistics sink behind `self.statOutput/statCycleStart/statCycleEnd/statState`. */
export interface SdkStatsBackend {
  output?(n: number): void;
  cycleStart?(): void;
  cycleEnd?(): void;
  /** Canonical utilization category (Working|Blocked|Empty|Setup|Failure). */
  state?(name: string): void;
}

/** Statistics-window rows behind `self.statValue`, scoped to one script instance. */
/**
 * One published `self.statValue` row as the DES snapshot carries it (plan-2212
 * Phase 3): `[key, value, unit, group]`, `null` for an absent unit/group.
 */
export type SdkStatRow = [key: string, value: number | string | null, unit: string | null, group: string | null];

export interface SdkStatRowsBackend {
  /** Set the last value for a key; units are display-only, group defaults to the owner path. */
  set(key: string, value: number | string | null, unit?: string, group?: string): void;
  /** Remove this instance's rows when it is disposed. */
  clear(): void;
}

/** Info snapshot of ANOTHER script component (`self.component(path)`). */
export interface SdkScriptComponentInfo {
  readonly path: string;
  readonly state: string;
  readonly enabled: boolean;
  readonly error: { code: string; message: string } | null;
}

/**
 * Script→script access backend (`self.component(path)` / `self.broadcast`).
 * The web-component registry wires a default implementation (message delivery
 * through the TARGET's event list — deterministic in both kernels).
 */
export interface SdkScriptComponentAccess {
  get(path: string): SdkScriptComponentInfo | null;
  /** Deliver `topic`/`data` to the component at `toPath`. False when unknown/inactive. */
  send(toPath: string, topic: string, data: unknown): boolean;
  /** Deliver to ALL other script components; returns the receiver count. */
  broadcast(topic: string, data: unknown): number;
}

/**
 * Typed-connection access (`self.connection(type).call` / deferred `reply`,
 * plan-259). Wired by the web-component plugin against the session's
 * `RVConnectionRegistry`; absent ⇒ `connection(...).call` is a warn no-op.
 */
export interface SdkConnectionAccess {
  /**
   * Source-side call over all outgoing edges of THIS component with `type`
   * (1:n fan-out — `onReply` may fire once per replying target). Returns the
   * number of endpoints the request reached.
   */
  call(
    type: string,
    params: unknown,
    onReply: ((response: Record<string, unknown>) => void) | null,
  ): number;
  /** Target-side deferred reply by handle id (guest `reply(...)`). */
  reply(replyId: number, response: unknown): void;
}

/** Error-state sink behind `self.raiseError/clearError` (phase 1b). */
export interface SdkErrorSink {
  raise(code: string, message: string): void;
  clear(): void;
}

// ─── Path network / routing (plan-268 Phase 6) ─────────────────────────────

/**
 * Plain path descriptor as it crosses the script boundary (plan-268 §2.4 S1
 * — value boundary: `RVPath` host objects NEVER cross into QuickJS, exactly
 * like ports cross as {@link ScriptPortDesc}). Pure JSON: id strings, plain
 * numbers, string arrays. Unlike ports, paths need no live handle — the
 * graph data is parse-static — so the guest keeps the descriptors themselves
 * (fresh per query, no by-id read-back channel needed).
 *
 * `length` is in MILLIMETERS (drive parity — same unit as `Agv.Position`,
 * `TargetSpeed`, `SafetyDistance`).
 */
export interface SdkPathDesc {
  readonly id: string;
  /** Arc length in mm (drive parity). */
  readonly length: number;
  readonly closed: boolean;
  readonly successorIds: string[];
  readonly predecessorIds: string[];
  /** Zone id this path belongs to (rv_extras.Path `zone`), null = unzoned. */
  readonly zone: string | null;
  /** Explicit zone capacity, null = undeclared (registry default 1). */
  readonly zoneCapacity: number | null;
}

/**
 * Path-graph query + zone claim backend (`self.paths`, plan-268 Phase 6 —
 * the by-id analogue of the ports backend). Continuous hosts wire
 * `createPathNetworkPathsBackend()` (rv-sdk-paths.ts); absent ⇒ `self.paths`
 * queries return empty/null and claims fail.
 */
export interface SdkPathsBackend {
  /** All registered paths as plain descriptors (fresh per call). */
  list(): SdkPathDesc[];
  /** One path by id (null when unknown). */
  get(id: string): SdkPathDesc | null;
  /** Successor path ids of `id` (empty when unknown / dead end). */
  successors(id: string): string[];
  /** Claim `zoneId` for `holderId` (ZoneRegistry semantics — idempotent for
   *  the holder, false when the capacity is exhausted). */
  claimZone(zoneId: string, holderId: string): boolean;
  /** Release one claim (no-op when `holderId` does not hold `zoneId`). */
  releaseZone(zoneId: string, holderId: string): void;
  /** True when `holderId` currently holds `zoneId`. */
  isZoneHolder(zoneId: string, holderId: string): boolean;
  /** Release EVERY zone held by `holderId` — called by the bridge on dispose
   *  for the component's OWN default holder id (ghost-claim hygiene, §10). */
  releaseAllZones(holderId: string): void;
}

/** Value context of a `selectNextPath` routing decision (plain data — the
 *  same shape as the engine's SelectNextPathContext). */
export interface SdkRouteContext {
  travelerId: string;
  currentPathId: string;
  direction: 1 | -1;
}

/**
 * Host-side router built from a script's `routing.*` handlers (plan-268 F6):
 * synchronous host→VM dispatch with plain-value arguments — the same
 * `callHandler` pattern as the DES station handshake. Structurally identical
 * to the engine's `PathNetworkRouter`.
 */
export interface SdkPathRouter {
  selectNextPath?: (candidateIds: string[], ctx: SdkRouteContext) => string | undefined;
  onArrive?: (pathId: string, travelerId: string) => void;
  requestDispatch?: (travelerId: string) => void;
}

/**
 * Routing registration backend: the web-component registry registers a
 * script's routing handlers here when the setup return declares any
 * `routing.*` handler. Returns the unregister function (auto-teardown on
 * instance dispose / hot-reload). Continuous hosts wire
 * `createPathNetworkRoutingBackend()` (rv-sdk-paths.ts).
 */
export interface SdkRoutingBackend {
  register(router: SdkPathRouter): () => void;
}

/** Narrow signal-store slice the bridge reads/writes. */
export interface SdkSignalAccess {
  get(name: string): unknown;
  set(name: string, value: boolean | number): void;
  subscribe?(name: string, cb: (value: boolean | number) => void): () => void;
}

/**
 * The host environment one script component runs against. Phase 1 keeps it
 * duck-typed/mock-friendly; phase 2's loader wiring builds it from the live
 * viewer (NodeRegistry / SignalStore / transport manager).
 */
export interface SdkEnvironment {
  scene?: SdkSceneAccess;
  /** Component node name (leaf). */
  name: string;
  /** Full hierarchy path of the component node (also the RNG seed source). */
  path: string;
  /** The component's own scene node. */
  node: Object3D;
  /** `self.prop` bag (from rv_extras / plan-139 props). */
  props?: Record<string, number | string | boolean | null>;
  /** Node lookup — full hierarchy paths preferred, name fallback (registry rule). */
  resolveNode?(pathOrName: string): Object3D | null;
  /** Typed component lookups (per kind). Missing kind ⇒ `self.<kind>()` = null. */
  components?: SdkComponentResolver;
  /** Per-kind LIST lookups for `self.findAll` (scene-wide, like FindObjectsOfType). */
  componentsAll?: SdkComponentListResolver;
  /** Signal store slice for `self.signal/signalAt/setSignals`. */
  signals?: SdkSignalAccess;
  /** Kernel scheduler behind `self.in/at/cancel/now` (heap- or DES-backed). */
  scheduler: SdkScheduler;
  /** Optional surface-occupancy probe for `NodeHandle.occupied()`. */
  occupied?(node: Object3D): boolean;
  /**
   * Topology ports backend (phase 1b): resolves the current snap-graph ports
   * FRESH per call (the graph mutates as assets are placed) — the same
   * resolution semantics `MaterialFlowSelf.ports` has. Absent ⇒ `self.ports`
   * is empty (headless / no snap plugin).
   */
  ports?(): SdkPortTarget[];
  /**
   * Path-graph query + zone claim backend (`self.paths`, plan-268 Phase 6).
   * Absent ⇒ queries return empty/null and zone claims fail (headless hosts).
   */
  paths?: SdkPathsBackend;
  /**
   * Routing registration backend (plan-268 Phase 6): consumed by the
   * web-component REGISTRY (not the bridge) — a script declaring `routing.*`
   * handlers is registered as the path network's project router.
   */
  routing?: SdkRoutingBackend;
  /** MU / material-flow backend (phase 1b). Absent ⇒ documented shim behavior. */
  flow?: SdkFlowBackend;
  /** Statistics sink (phase 1b). Absent ⇒ stat calls are no-ops. */
  stats?: SdkStatsBackend;
  /** Statistics-window rows. Absent means statValue calls are no-ops; cleared on dispose. */
  statRows?: SdkStatRowsBackend;
  /** Script→script access (`self.component`/`broadcast`). Wired by the registry. */
  scripts?: SdkScriptComponentAccess;
  /** Typed-connection access (`self.connection(...)`, plan-259). */
  connections?: SdkConnectionAccess;
  /** Error-state sink (`self.raiseError/clearError`). Wired by the registry. */
  errors?: SdkErrorSink;
  /** `self.log(…)` sink (default: console.log with a component prefix). */
  log?(...args: unknown[]): void;
  /** `self.warn(…)` sink (default: console.warn with a component prefix). */
  warn?(...args: unknown[]): void;
  /** `self.error(…)` sink (default: console.error with a component prefix). */
  error?(...args: unknown[]): void;
  /** Observes `self.setState(name)` (statistics / HMI). */
  onSetState?(state: string): void;
  /** LEGACY phase-1 shim (superseded by `flow.transfer`; kept for compat). */
  transfer?(mu: ScriptMuRef | null): void;
  /** LEGACY phase-1 shim (superseded by `flow.spawn`; kept for compat). */
  spawnMU?(): ScriptMuRef;
  /** Explicit RNG seed override (default: FNV-1a of `path`). */
  seed?: number;
}

/** FNV-1a 32-bit hash — the default per-component RNG seed from the node path. */
export function seedFromPath(path: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ─── SdkBridge (host side of `__rvHostCall`) ────────────────────────────────

const _v3 = new Vector3();
const _q = new Quaternion();
const _box = new Box3();

function toVec3(v: Vector3): { x: number; y: number; z: number } {
  return { x: v.x, y: v.y, z: v.z };
}

/** Default full-path builder: ancestor names root→leaf joined by '/'. */
function defaultPathOf(node: Object3D): string {
  const parts: string[] = [];
  let cur: Object3D | null = node;
  while (cur && (cur as { isScene?: boolean }).isScene !== true) {
    if (cur.name) parts.unshift(cur.name);
    cur = cur.parent;
  }
  return parts.join('/');
}

/** Safety cap for chained deferred notifications (guest writes a signal its
 *  own subscription listens to → each flush schedules the next). A runaway
 *  self-triggering loop is an author bug; we drop and warn instead of hanging. */
const MAX_NOTIFY_CASCADE = 1000;

/** Problem/warning code of a state write refused in a DES frame hook (plan-2212 Phase 4). */
export const DES_FRAME_HOOK_WRITE_CODE = 'des-frame-hook-write';

/**
 * plan-2212 Phase 4 — the host ops a FRAME hook may use during a DES run
 * ("display only, never state"): reads of the scene, nodes, components,
 * signals, ports, paths and flow, plus logging. Everything else — timers,
 * FSM state, KPIs (`statValue`/`stat`), signal/component/scene writes,
 * subscriptions, material flow, zones, messages, connections, errors,
 * `disable` — would change DES state or results and is refused. An allowlist
 * on purpose: a new host op is refused in frame hooks until it is listed here.
 */
export const DISPLAY_HOST_OPS: ReadonlySet<string> = new Set([
  'scene.list', 'scene.read', 'now', 'log', 'log.warn', 'log.error',
  'node.self', 'node.resolve', 'node.parent', 'node.children', 'node.read',
  'node.worldDirection', 'node.worldToLocal', 'node.localToWorld',
  'comp.resolve', 'comp.resolveAll', 'comp.read', 'sig.get',
  'ports.list', 'port.read', 'paths.list', 'paths.get', 'paths.successors', 'zone.isHolder',
  'flow.mus', 'flow.load', 'flow.downstreamOccupied', 'flow.downstreamCanAccept',
  'mu.node', 'script.get',
]);

/**
 * The host-side whitelist dispatcher behind the single exposed guest function
 * `__rvHostCall`. Owns the opaque handle tables (node ids / component ids /
 * subscription tokens) and the **auto-teardown register** (plan-210 §6,
 * phase 2): every host-side registration the guest takes — sensor/signal
 * subscriptions AND pending scheduler timers (`self.in/at`) — is tracked here
 * and released by `dispose()`. The script author never unsubscribes manually;
 * dispose (hot-reload / model clear) cannot leave ghosts behind (§10).
 *
 * **Notify re-entrancy (phase-2 fix of the open phase-1 point):** a host-side
 * callback (signal subscription, sensor edge) may fire synchronously WHILE the
 * VM is already executing a guest call (e.g. `fixedUpdate` writes a signal the
 * same context subscribed to). Calling back into the VM at that moment would
 * nest guest calls and corrupt the shared deadline bookkeeping. The bridge
 * therefore defers: notifications raised while a `__rvHostCall` is on the
 * stack (or while a notification is already being delivered) are queued and
 * flushed at the next safe point — after the current notification chain, or
 * when the owner calls `flushDeferredNotifies()` after its VM invocation
 * (the registry does this after every tick).
 */
export class SdkBridge {
  private readonly env: SdkEnvironment;
  private readonly nodes = new Map<number, Object3D>();
  private readonly nodeIds = new WeakMap<Object3D, number>();
  private readonly comps = new Map<number, { kind: SdkComponentKind; target: SdkComponentTarget }>();
  private readonly unsubs = new Map<number, () => void>();
  /** Auto-teardown register for `self.in/at` timers: pending event ids,
   *  cancelled on dispose. Ids of already-fired events stay in the set until
   *  dispose — `SdkScheduler.cancel` is a documented no-op for those. */
  private readonly pendingTimers = new Set<number>();
  /** Notifications deferred while the VM is busy (see class doc). */
  private readonly deferredNotifies: Array<{ subId: number; args: unknown[] }> = [];
  private hostCallDepth = 0;
  private notifying = false;
  private nextNodeId = 1;
  private nextCompId = 1;
  private nextToken = 1;
  private localMuId = 0;
  private warnedTransfer = false;
  private warnedPark = false;
  private warnedConn = false;
  private disposed = false;
  /** Port targets by id — refreshed on every `ports.list` (fresh topology). */
  private readonly portTargets = new Map<string, SdkPortTarget>();
  /**
   * plan-2212 Phase 3: the rows this instance published (`self.statValue`), in
   * first-publish order — guest-visible KPI state the DES snapshot carries.
   */
  private readonly statRowValues = new Map<string, SdkStatRow>();

  /** Set by the façade: delivers guest-callback notifications (`__cb`). */
  private notifier: ((subId: number, args: unknown[]) => void) | null = null;
  /** Set by the façade: `self.disable(reason)` → script-context disable. */
  private onDisableRequested: ((reason: string) => void) | null = null;

  constructor(env: SdkEnvironment) {
    this.env = env;
  }

  setNotifier(fn: (subId: number, args: unknown[]) => void): void {
    this.notifier = fn;
  }

  setDisableHook(fn: (reason: string) => void): void {
    this.onDisableRequested = fn;
  }

  /** Number of not-yet-cancelled timer registrations (leak tests). */
  get pendingTimerCount(): number {
    return this.pendingTimers.size;
  }

  /** The published `self.statValue` rows (DES snapshot capture, plan-2212 Phase 3). */
  captureStatRows(): SdkStatRow[] {
    return [...this.statRowValues.values()].map(r => [...r] as SdkStatRow);
  }

  /**
   * Replace the published rows with a captured set (DES restore): the KPI rows
   * show the snapshot values at once, before the script's next event.
   */
  restoreStatRows(rows: readonly SdkStatRow[]): void {
    this.statRowValues.clear();
    this.env.statRows?.clear();
    for (const [key, value, unit, group] of rows) this.publishStatRow(key, value, unit, group);
  }

  private publishStatRow(key: string, value: number | string | null, unit: string | null, group: string | null): void {
    this.statRowValues.set(key, [key, value, unit, group]);
    this.env.statRows?.set(key, value, unit ?? undefined, group ?? undefined);
  }

  /** Number of live host-side subscriptions taken by the guest (leak tests). */
  get subscriptionCount(): number {
    return this.unsubs.size;
  }

  /**
   * Releases every host-side registration taken by the guest — subscriptions
   * AND pending `self.in/at` timer events (auto-teardown register, §10
   * ghosting fix: a pending timer of a disposed instance never fires).
   * Idempotent.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const unsub of this.unsubs.values()) {
      try { unsub(); } catch { /* subscription target already gone */ }
    }
    this.unsubs.clear();
    // Ghost-claim hygiene (plan-268 Phase 6): zone claims taken by the guest
    // under its DEFAULT holder id (the component path) are released here —
    // a disposed/hot-reloaded script must never leave a crossing held.
    // Claims made with an EXPLICIT holder id (acting for an AGV) are
    // deliberately kept: they belong to that actor, not to this VM.
    try { this.env.paths?.releaseAllZones(this.env.path); } catch { /* registry gone */ }
    for (const id of this.pendingTimers) {
      try { this.env.scheduler.cancel(id); } catch { /* scheduler already gone */ }
    }
    // plan-2212 Phase 4c: the recurring `self.every` timers live host-side.
    try { this.env.scheduler.everyTimers?.cancelAll(); } catch { /* scheduler already gone */ }
    this.pendingTimers.clear();
    this.env.statRows?.clear();
    this.statRowValues.clear();
    this.deferredNotifies.length = 0;
    this.nodes.clear();
    this.comps.clear();
    this.portTargets.clear();
  }

  /**
   * plan-2212 Phase 4: true while the guest runs a FRAME hook of a DES run
   * (`continuous.fixedUpdate` / `lateFixedUpdate` in animated DES) — display
   * only. Every host op outside {@link DISPLAY_HOST_OPS} is refused (throws).
   */
  private displayOnly = false;
  private readonly displayRefusedOps: string[] = [];

  /** Arm / release the display-only fence (the kernel adapter brackets every DES frame hook). */
  setDisplayOnly(on: boolean): void {
    this.displayOnly = on;
  }

  /** Every op refused under the display-only fence since the last call (one entry per call), then cleared. */
  takeDisplayRefusals(): string[] {
    return this.displayRefusedOps.splice(0);
  }

  /** The `__rvHostCall(op, …args)` entry point (exposed via the whitelist bridge). */
  hostCall = (...raw: unknown[]): unknown => {
    this.hostCallDepth++;
    try {
      if (this.displayOnly) {
        const op = String(raw[0]);
        if (!DISPLAY_HOST_OPS.has(op)) {
          this.displayRefusedOps.push(op);
          throw new Error(`${DES_FRAME_HOOK_WRITE_CODE}: '${op}' is refused in a frame hook during a DES run - frame hooks are display only; change state in DES events (self.in/at/every, sink/sensor callbacks)`);
        }
      }
      return this.dispatchHostCall(raw);
    } finally {
      this.hostCallDepth--;
    }
  };

  private dispatchHostCall(raw: unknown[]): unknown {
    const op = String(raw[0]);
    const a = raw.slice(1);
    switch (op) {
      case 'scene.list': return this.env.scene?.list(a[0] == null ? undefined : String(a[0])) ?? [];
      case 'scene.read': return this.env.scene?.read(String(a[0]), String(a[1])) ?? null;
      case 'scene.set': {
        if (!this.env.scene) throw new Error('Scene access is unavailable');
        this.env.scene.set(String(a[0]), String(a[1]), String(a[2]), a[3]);
        return undefined;
      }
      // ── time / lifecycle ─────────────────────────────────────────────
      case 'now': return this.env.scheduler.now;
      case 'log': {
        const log = this.env.log ?? ((...args: unknown[]) => console.log(`[sdk:${this.env.path}]`, ...args));
        log(...a);
        return undefined;
      }
      case 'disable': {
        const reason = String(a[0] ?? 'disabled by script');
        this.onDisableRequested?.(reason);
        return undefined;
      }
      case 'setState': {
        this.env.onSetState?.(String(a[0]));
        return undefined;
      }
      // ── timers (kernel scheduler; auto-registered for teardown) ─────
      case 'timer.in': {
        const id = this.env.scheduler.in(Number(a[0]), String(a[1]), (a[2] ?? null) as ScriptMuRef | null, a[3]);
        this.pendingTimers.add(id);
        return id;
      }
      case 'timer.at': {
        const id = this.env.scheduler.at(Number(a[0]), String(a[1]), (a[2] ?? null) as ScriptMuRef | null, a[3]);
        this.pendingTimers.add(id);
        return id;
      }
      case 'timer.every': {
        // plan-2212 Phase 4c: the host owns the CLOCK of recurring timers (negative
        // public id, the scheduler re-arms each slice before the guest sees it); the
        // payload never crosses, the guest keeps it. Teardown: `everyTimers.cancelAll()`.
        const every = this.env.scheduler.every;
        if (!every) throw new Error('self.every is unavailable on this scheduler');
        return every.call(this.env.scheduler, Number(a[0]), String(a[1]));
      }
      case 'timer.cancel': {
        const id = Number(a[0]);
        this.pendingTimers.delete(id);
        this.env.scheduler.cancel(id);   // negative = an every timer of this scheduler
        return undefined;
      }
      // ── nodes ────────────────────────────────────────────────────────
      case 'node.self': return this.nodeId(this.env.node);
      case 'node.resolve': {
        const n = this.env.resolveNode?.(String(a[0])) ?? null;
        return n ? this.nodeId(n) : null;
      }
      case 'node.parent': {
        const n = this.node(a[0]);
        return n?.parent && (n.parent as { isScene?: boolean }).isScene !== true
          ? this.nodeId(n.parent) : null;
      }
      case 'node.children': {
        const n = this.node(a[0]);
        if (!n) return [];
        const kind = a[1] == null ? null : String(a[1]);
        if (kind && kind in NODE_KIND_TESTS) {
          // Convention-kind filter (like MaterialFlowSelf.findAll): all
          // DESCENDANT nodes matching the shared name-convention table.
          return findKindNodes(n, NODE_KIND_TESTS[kind as keyof typeof NODE_KIND_TESTS])
            .map((c) => this.nodeId(c));
        }
        return n.children.map((c) => this.nodeId(c));
      }
      case 'node.read': return this.nodeRead(a[0], String(a[1]));
      case 'node.worldDirection': {
        const n = this.node(a[0]);
        if (!n) return null;
        const axis = (a[1] ?? { x: 0, y: 0, z: 1 }) as { x: number; y: number; z: number };
        n.getWorldQuaternion(_q);
        _v3.set(axis.x, axis.y, axis.z).normalize().applyQuaternion(_q);
        return toVec3(_v3);
      }
      case 'node.worldToLocal': {
        const n = this.node(a[0]);
        const p = a[1] as { x: number; y: number; z: number };
        if (!n || !p) return null;
        n.updateWorldMatrix(true, false);
        return toVec3(n.worldToLocal(_v3.set(p.x, p.y, p.z)));
      }
      case 'node.localToWorld': {
        const n = this.node(a[0]);
        const p = a[1] as { x: number; y: number; z: number };
        if (!n || !p) return null;
        n.updateWorldMatrix(true, false);
        return toVec3(n.localToWorld(_v3.set(p.x, p.y, p.z)));
      }
      // ── components ──────────────────────────────────────────────────
      case 'comp.resolve': {
        const kind = String(a[0]) as SdkComponentKind;
        const resolver = this.env.components?.[kind];
        const target = resolver ? resolver(String(a[1])) : null;
        if (!target) return null;
        const c = this.nextCompId++;
        this.comps.set(c, { kind, target: target as SdkComponentTarget });
        const node = (target as { node?: Object3D }).node;
        return { c, node: node ? this.nodeId(node) : null };
      }
      case 'comp.resolveAll': {
        const kind = String(a[0]) as SdkComponentKind;
        const resolver = this.env.componentsAll?.[kind];
        const targets = resolver ? resolver() : [];
        return targets.map((target) => {
          const c = this.nextCompId++;
          this.comps.set(c, { kind, target: target as SdkComponentTarget });
          const node = (target as { node?: Object3D }).node;
          return { c, node: node ? this.nodeId(node) : null };
        });
      }
      case 'comp.read': return this.compRead(Number(a[0]), String(a[1]));
      case 'comp.call': return this.compCall(Number(a[0]), String(a[1]), (a[2] ?? []) as unknown[]);
      case 'comp.on': {
        const entry = this.comps.get(Number(a[0]));
        const subId = Number(a[1]);
        if (!entry) return null;
        const target = entry.target as SdkSensorTarget & SdkSinkTarget;
        if (typeof target.subscribe !== 'function') return null;
        // Second callback argument (sensor→MU bridge, plan-259) is forwarded
        // additively; targets without it notify with [value, null] as before.
        const unsub = (target.subscribe as (cb: (v: unknown, extra?: unknown) => void) => () => void)(
          (v: unknown, extra?: unknown) => this.notify(subId, [this.plainEventValue(v), this.plainEventValue(extra)]),
        );
        const token = this.nextToken++;
        this.unsubs.set(token, unsub);
        return token;
      }
      // ── signals ─────────────────────────────────────────────────────
      case 'sig.get': return this.plainEventValue(this.env.signals?.get(String(a[0])));
      case 'sig.set':
        this.env.signals?.set(String(a[0]), a[1] as boolean | number);
        return undefined;
      case 'sig.setAll': {
        const updates = (a[0] ?? {}) as Record<string, boolean | number>;
        for (const [name, value] of Object.entries(updates)) this.env.signals?.set(name, value);
        return undefined;
      }
      case 'sig.on': {
        const name = String(a[0]);
        const subId = Number(a[1]);
        const sub = this.env.signals?.subscribe;
        if (!sub) return null;
        const unsub = sub.call(this.env.signals, name, (v) => this.notify(subId, [v]));
        const token = this.nextToken++;
        this.unsubs.set(token, unsub);
        return token;
      }
      case 'unsub': {
        const token = Number(a[0]);
        const unsub = this.unsubs.get(token);
        if (unsub) {
          this.unsubs.delete(token);
          try { unsub(); } catch (err) {
            // plan-2212 Phase 2: a target may REFUSE an unsubscribe (DES sink
            // outside setup()): the subscription stays (token kept for dispose),
            // and the guest sees the error, so its callback stays registered.
            // Anything else: target gone.
            if ((err as { refused?: boolean } | null)?.refused === true) {
              this.unsubs.set(token, unsub);
              throw err;
            }
          }
        }
        return undefined;
      }
      // ── Tier 1: ports / topology (phase 1b — snap-graph backend) ────
      case 'ports.list': {
        const list = this.env.ports?.() ?? [];
        this.portTargets.clear();
        return list.map((p) => {
          this.portTargets.set(p.id, p);
          return {
            id: p.id,
            role: p.role,
            node: p.node ? this.nodeId(p.node) : null,
            partner: p.partnerNode ? this.nodeId(p.partnerNode) : null,
            worldAngle: p.worldAngle ?? null,
          };
        });
      }
      case 'port.read': {
        const p = this.portTarget(String(a[0]));
        if (!p) return false;
        return String(a[1]) === 'upstreamWaiting' ? p.upstreamWaiting() : p.occupied();
      }
      case 'port.setOccupied': {
        this.portTarget(String(a[0]))?.setOccupied(a[1] === true);
        return undefined;
      }
      // ── Tier 1: path graph / zones by id (plan-268 Phase 6) ──────────
      // Descriptors are plain JSON built fresh per query (value boundary S1
      // — no RVPath ever crosses; see SdkPathDesc). Zone claims default to
      // the component path as the holder id when the guest passes none.
      case 'paths.list': return this.env.paths?.list() ?? [];
      case 'paths.get': return this.env.paths?.get(String(a[0])) ?? null;
      case 'paths.successors': return this.env.paths?.successors(String(a[0])) ?? [];
      case 'zone.claim': {
        const holder = a[1] == null ? this.env.path : String(a[1]);
        return this.env.paths?.claimZone(String(a[0]), holder) === true;
      }
      case 'zone.release': {
        const holder = a[1] == null ? this.env.path : String(a[1]);
        this.env.paths?.releaseZone(String(a[0]), holder);
        return undefined;
      }
      case 'zone.isHolder': {
        const holder = a[1] == null ? this.env.path : String(a[1]);
        return this.env.paths?.isZoneHolder(String(a[0]), holder) === true;
      }
      // ── Tier 1: MU / material flow (phase 1b) ────────────────────────
      case 'transfer': {
        const mu = (a[0] ?? null) as ScriptMuRef | null;
        const portId = a[1] == null ? null : String(a[1]);
        if (this.env.flow?.transfer) {
          this.env.flow.transfer(mu, portId);
        } else if (this.env.transfer) {
          this.env.transfer(mu); // legacy phase-1 sink
        } else if (!this.warnedTransfer) {
          this.warnedTransfer = true;
          console.warn(`[sdk:${this.env.path}] self.transfer() has no host backend in this environment (no-op)`);
        }
        return undefined;
      }
      case 'spawn': {
        const mu = this.env.flow?.spawn?.() ?? this.env.spawnMU?.() ?? { id: ++this.localMuId };
        return this.plainEventValue(mu);
      }
      case 'flow.mus':
        return (this.env.flow?.mus?.() ?? []).map((m) => this.plainEventValue(m));
      case 'flow.load': {
        const flow = this.env.flow;
        if (!flow) return 0;
        return flow.currentLoad ? flow.currentLoad() : (flow.mus?.().length ?? 0);
      }
      case 'flow.downstreamOccupied': {
        if (this.env.flow?.downstreamOccupied) return this.env.flow.downstreamOccupied();
        // Fallback: single-successor interlock over the ports backend — the
        // first OUTPUT port's per-port-then-root occupied read.
        const first = (this.env.ports?.() ?? []).find((p) => p.role === 'output');
        return first ? first.occupied() : false;
      }
      case 'flow.downstreamCanAccept': {
        const probe = this.env.flow?.downstreamCanAccept;
        if (!probe) return true; // continuous default: the surface gates the flow
        return probe(
          (a[0] ?? null) as ScriptMuRef | null,
          a[1] == null ? null : String(a[1]),
        );
      }
      case 'mu.park':
      case 'mu.release': {
        const fn = op === 'mu.park' ? this.env.flow?.park : this.env.flow?.release;
        if (fn) {
          fn.call(this.env.flow, Number(a[0]));
        } else if (!this.warnedPark) {
          this.warnedPark = true;
          console.warn(`[sdk:${this.env.path}] mu.park()/mu.release() has no host backend in this environment (no-op)`);
        }
        return undefined;
      }
      case 'mu.node': {
        const n = this.env.flow?.muNode?.(Number(a[0])) ?? null;
        return n ? this.nodeId(n) : null;
      }
      // ── Tier 1: statistics (phase 1b) ────────────────────────────────
      case 'stat.row': {
        const value = a[1];
        if (value !== null && typeof value !== 'number' && typeof value !== 'string') {
          throw new Error('statValue value must be a number, string or null');
        }
        this.publishStatRow(String(a[0]), value,
          a[2] == null ? null : String(a[2]), a[3] == null ? null : String(a[3]));
        return undefined;
      }
      case 'stat': {
        const stats = this.env.stats;
        switch (String(a[0])) {
          case 'output': stats?.output?.(Number(a[1] ?? 1)); break;
          case 'cycleStart': stats?.cycleStart?.(); break;
          case 'cycleEnd': stats?.cycleEnd?.(); break;
          case 'state': stats?.state?.(String(a[1])); break;
        }
        return undefined;
      }
      // ── Supervisory: script→script access (phase 1b) ─────────────────
      case 'script.get': {
        const info = this.env.scripts?.get(String(a[0])) ?? null;
        return info
          ? { path: info.path, state: info.state, enabled: info.enabled, error: info.error }
          : null;
      }
      case 'script.send':
        return this.env.scripts?.send(String(a[0]), String(a[1]), a[2] ?? null) ?? false;
      case 'script.broadcast':
        return this.env.scripts?.broadcast(String(a[0]), a[1] ?? null) ?? 0;
      // ── Typed connections (plan-259) ─────────────────────────────────
      case 'conn.call': {
        const conn = this.env.connections;
        if (!conn) {
          if (!this.warnedConn) {
            this.warnedConn = true;
            console.warn(`[sdk:${this.env.path}] self.connection(...).call has no host backend in this environment (no-op)`);
          }
          return 0;
        }
        const type = String(a[0]);
        const params = a[1] ?? null;
        const cbId = a[2] == null ? null : Number(a[2]);
        // Replies are ALWAYS deferred (queued, delivered at the next flush
        // point — the registry flushes after every tick pass): the reply may
        // originate inside ANOTHER component's VM call, and entering this VM
        // synchronously from there would nest guest calls across contexts.
        return conn.call(type, params, cbId === null ? null : (resp) => {
          if (this.disposed) return;
          this.deferredNotifies.push({ subId: cbId, args: [resp] });
        });
      }
      case 'conn.reply':
        this.env.connections?.reply(Number(a[0]), a[1] ?? null);
        return undefined;
      // ── Supervisory: error handling (phase 1b) ────────────────────────
      case 'err.raise': {
        const code = String(a[0] ?? 'Error');
        const message = String(a[1] ?? '');
        if (this.env.errors) this.env.errors.raise(code, message);
        else console.warn(`[sdk:${this.env.path}] raiseError(${code}): ${message}`);
        return undefined;
      }
      case 'err.clear':
        this.env.errors?.clear();
        return undefined;
      case 'log.warn': {
        const warn = this.env.warn ?? ((...args: unknown[]) => console.warn(`[sdk:${this.env.path}]`, ...args));
        warn(...a);
        return undefined;
      }
      case 'log.error': {
        const error = this.env.error ?? ((...args: unknown[]) => console.error(`[sdk:${this.env.path}]`, ...args));
        error(...a);
        return undefined;
      }
      default:
        throw new Error(`unknown host op '${op}'`);
    }
  }

  /** Port target by id — re-resolves the topology once when unknown (fresh graph). */
  private portTarget(id: string): SdkPortTarget | null {
    let p = this.portTargets.get(id);
    if (!p && this.env.ports) {
      for (const t of this.env.ports()) this.portTargets.set(t.id, t);
      p = this.portTargets.get(id);
    }
    return p ?? null;
  }

  /**
   * Delivers deferred guest notifications when the VM is idle. Owners call
   * this after their VM invocations (the web-component registry does after
   * every tick). Safe to call any time — no-op while a guest call or another
   * flush is on the stack (that flusher drains the queue itself).
   */
  flushDeferredNotifies(): void {
    if (this.disposed || this.notifying || this.hostCallDepth > 0) return;
    this.notifying = true;
    try {
      let delivered = 0;
      while (this.deferredNotifies.length > 0) {
        if (this.disposed) return;
        if (++delivered > MAX_NOTIFY_CASCADE) {
          console.warn(`[sdk:${this.env.path}] dropped ${this.deferredNotifies.length} deferred notification(s) — self-triggering notify cascade exceeded ${MAX_NOTIFY_CASCADE}`);
          this.deferredNotifies.length = 0;
          return;
        }
        const next = this.deferredNotifies.shift()!;
        this.notifier?.(next.subId, next.args);
      }
    } finally {
      this.notifying = false;
    }
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private notify(subId: number, args: unknown[]): void {
    if (this.disposed) return;
    // VM busy (a __rvHostCall or another notification delivery is on the
    // stack) → defer; a nested guest call would corrupt the shared deadline
    // bookkeeping (phase-1 open point "Notify-Reentranz").
    if (this.hostCallDepth > 0 || this.notifying) {
      this.deferredNotifies.push({ subId, args });
      return;
    }
    this.notifying = true;
    try {
      this.notifier?.(subId, args);
    } finally {
      this.notifying = false;
    }
    this.flushDeferredNotifies();
  }

  /** Coerce event/signal values to plain marshallable data. */
  private plainEventValue(v: unknown): unknown {
    if (v === undefined) return null;
    if (v === null || typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') return v;
    // MU-like objects (sink events / flow backend) cross as value refs.
    const mu = v as { id?: unknown; type?: unknown; prop?: unknown };
    if (typeof mu.id === 'number') {
      return {
        id: mu.id,
        type: typeof mu.type === 'string' ? mu.type : '',
        prop: (mu.prop as Record<string, unknown> | undefined) ?? {},
      };
    }
    return null;
  }

  private nodeId(node: Object3D): number {
    let id = this.nodeIds.get(node);
    if (id === undefined) {
      id = this.nextNodeId++;
      this.nodeIds.set(node, id);
      this.nodes.set(id, node);
    }
    return id;
  }

  private node(idRaw: unknown): Object3D | null {
    return this.nodes.get(Number(idRaw)) ?? null;
  }

  private nodeRead(idRaw: unknown, what: string): unknown {
    const n = this.node(idRaw);
    if (!n) return null;
    switch (what) {
      case 'name': return n.name;
      case 'path': return defaultPathOf(n);
      case 'worldPosition': return toVec3(n.getWorldPosition(_v3));
      case 'worldQuaternion': {
        n.getWorldQuaternion(_q);
        return { x: _q.x, y: _q.y, z: _q.z, w: _q.w };
      }
      case 'localPosition': return toVec3(_v3.copy(n.position));
      case 'localQuaternion': {
        const q = n.quaternion;
        return { x: q.x, y: q.y, z: q.z, w: q.w };
      }
      case 'scale': return toVec3(_v3.copy(n.scale));
      case 'worldMatrix': {
        n.updateWorldMatrix(true, false);
        return [...n.matrixWorld.elements];
      }
      case 'bounds': {
        _box.setFromObject(n);
        return { min: toVec3(_box.min), max: toVec3(_box.max) };
      }
      case 'occupied': return this.env.occupied?.(n) ?? false;
      default:
        throw new Error(`unknown node read '${what}'`);
    }
  }

  private compRead(id: number, field: string): unknown {
    const entry = this.comps.get(id);
    if (!entry) return null;
    const t = entry.target as Record<string, unknown>;
    switch (`${entry.kind}.${field}`) {
      case 'drive.position': return (t as unknown as SdkDriveTarget).currentPosition;
      case 'drive.speed': return (t as unknown as SdkDriveTarget).currentSpeed;
      case 'drive.isAtTarget': return (t as unknown as SdkDriveTarget).isAtTarget;
      case 'drive.isMoving': return (t as unknown as SdkDriveTarget).currentSpeed !== 0;
      case 'drive.targetSpeed': return (t as unknown as SdkDriveTarget).targetSpeed;
      case 'sensor.occupied': return (t as unknown as SdkSensorTarget).occupied;
      case 'sensor.mode': return (t as unknown as SdkSensorTarget).mode ?? 'Collision';
      case 'belt.occupied': return (t as unknown as SdkBeltTarget).occupied ?? false;
      case 'belt.speed': return (t as unknown as SdkBeltTarget).speed ?? 0;
      case 'transport.direction': return (t as unknown as SdkTransportTarget).direction ?? { x: 0, y: 0, z: 0 };
      case 'transport.speed': return (t as unknown as SdkTransportTarget).speed ?? 0;
      case 'transport.radial': return (t as unknown as SdkTransportTarget).radial ?? false;
      case 'source.automatic': return (t as unknown as SdkSourceTarget).automatic ?? false;
      case 'source.interval': return (t as unknown as SdkSourceTarget).interval ?? 0;
      case 'grip.gripped': return ((t as unknown as SdkGripTarget).gripped ?? []).map((m) => ({ id: m.id, prop: m.prop ?? {} }));
      case 'grip.range': return (t as unknown as SdkGripTarget).range ?? 0;
      case 'logicStep.state': return (t as unknown as SdkLogicStepTarget).state;
      case 'logicStep.runId': return (t as unknown as SdkLogicStepTarget).runId ?? 0;
      case 'logicStep.progress': return (t as unknown as SdkLogicStepTarget).progress ?? 0;
      default:
        throw new Error(`unknown component read '${entry.kind}.${field}'`);
    }
  }

  private compCall(id: number, method: string, args: unknown[]): unknown {
    const entry = this.comps.get(id);
    if (!entry) return null;
    switch (`${entry.kind}.${method}`) {
      case 'drive.moveTo': {
        (entry.target as SdkDriveTarget).startMove(Number(args[0]));
        return undefined;
      }
      case 'drive.startMove': {
        (entry.target as SdkDriveTarget).startMove(args.length > 0 ? Number(args[0]) : undefined);
        return undefined;
      }
      case 'drive.jog': {
        const d = entry.target as SdkDriveTarget;
        const forward = args[0] === true;
        d.jogForward = forward;
        d.jogBackward = !forward;
        return undefined;
      }
      case 'drive.stop': {
        const d = entry.target as SdkDriveTarget;
        d.jogForward = false;
        d.jogBackward = false;
        d.stop();
        return undefined;
      }
      case 'drive.setTargetSpeed': {
        (entry.target as SdkDriveTarget).targetSpeed = Number(args[0]);
        return undefined;
      }
      case 'belt.run': {
        (entry.target as SdkBeltTarget).run(args[0] === true);
        return undefined;
      }
      case 'source.spawn': {
        const mu = (entry.target as SdkSourceTarget).spawn();
        return mu ? { id: mu.id, prop: mu.prop ?? {} } : null;
      }
      case 'source.setAutomatic': {
        (entry.target as SdkSourceTarget).automatic = args[0] === true;
        return undefined;
      }
      case 'source.setInterval': {
        (entry.target as SdkSourceTarget).interval = Number(args[0]);
        return undefined;
      }
      case 'grip.pick': (entry.target as SdkGripTarget).pick(); return undefined;
      case 'grip.place': (entry.target as SdkGripTarget).place(); return undefined;
      case 'logicStep.start': (entry.target as SdkLogicStepTarget).start(); return undefined;
      case 'logicStep.reset': (entry.target as SdkLogicStepTarget).reset(); return undefined;
      case 'logicStep.complete': {
        const target = entry.target as SdkLogicStepTarget;
        if (!target.complete) throw new Error('Only a JavaScript logic step supports complete()');
        target.complete();
        return undefined;
      }
      default:
        throw new Error(`unknown component method '${entry.kind}.${method}'`);
    }
  }
}

// ─── Guest-side self construction source ────────────────────────────────────

/**
 * JS source evaluated once per context (after the math install). Defines
 * `globalThis.__rvCreateSelf(meta)` building the guest `self` object plus the
 * guest callback dispatch table (`__rvDispatchCb`).
 */
export const SDK_SELF_SOURCE = String.raw`
(function () {
  'use strict';
  var M = globalThis.__rvMath;
  var call = globalThis.__rvHostCall;

  var _cbs = {};
  var _cbNext = 1;
  function regCb(fn) { var id = _cbNext++; _cbs[id] = fn; return id; }
  // A host call that takes a registered callback: when the host refuses it
  // (e.g. the DES frame-hook fence, plan-2212 Phase 4), the registration is
  // rolled back — a refused call leaves no unreachable callback behind.
  function callWithCb(id, args) {
    try { return call.apply(null, args); } catch (e) { delete _cbs[id]; throw e; }
  }
  globalThis.__rvDispatchCb = function (id, args) {
    var fn = _cbs[id];
    if (fn) return fn.apply(null, args || []);
  };

  function nodeHandle(h) {
    if (h === null || h === undefined) return null;
    return {
      __h: h,
      get name() { return call('node.read', h, 'name'); },
      get path() { return call('node.read', h, 'path'); },
      worldPosition: function () { return call('node.read', h, 'worldPosition'); },
      worldQuaternion: function () { return call('node.read', h, 'worldQuaternion'); },
      worldDirection: function (axis) { return call('node.worldDirection', h, axis || null); },
      localPosition: function () { return call('node.read', h, 'localPosition'); },
      localQuaternion: function () { return call('node.read', h, 'localQuaternion'); },
      scale: function () { return call('node.read', h, 'scale'); },
      worldMatrix: function () { return call('node.read', h, 'worldMatrix'); },
      worldToLocal: function (p) { return call('node.worldToLocal', h, p); },
      localToWorld: function (p) { return call('node.localToWorld', h, p); },
      bounds: function () { return call('node.read', h, 'bounds'); },
      parent: function () { return nodeHandle(call('node.parent', h)); },
      occupied: function () { return call('node.read', h, 'occupied'); },
    };
  }

  function subOn(c, cb) {
    var id = regCb(cb);
    var tok = callWithCb(id, ['comp.on', c, id]);
    return function () { if (tok !== null) call('unsub', tok); delete _cbs[id]; };
  }

  function driveHandle(r) {
    var c = r.c;
    return {
      get position() { return call('comp.read', c, 'position'); },
      get speed() { return call('comp.read', c, 'speed'); },
      get isAtTarget() { return call('comp.read', c, 'isAtTarget'); },
      get isMoving() { return call('comp.read', c, 'isMoving'); },
      get targetSpeed() { return call('comp.read', c, 'targetSpeed'); },
      set targetSpeed(v) { call('comp.call', c, 'setTargetSpeed', [v]); },
      moveTo: function (d) { call('comp.call', c, 'moveTo', [d]); },
      startMove: function (d) { call('comp.call', c, 'startMove', d === undefined ? [] : [d]); },
      jog: function (f) { call('comp.call', c, 'jog', [!!f]); },
      stop: function () { call('comp.call', c, 'stop', []); },
      node: nodeHandle(r.node),
    };
  }
  function sensorHandle(r) {
    var c = r.c;
    return {
      get occupied() { return call('comp.read', c, 'occupied'); },
      get mode() { return call('comp.read', c, 'mode'); },
      // Second callback arg: the occupying MU as a full guest handle
      // (plan-259 sensor→MU bridge). Null on exit / when no MU is known.
      on: function (cb) {
        return subOn(c, function (v, mu) { cb(v, mu ? muHandle(mu) : null); });
      },
      node: nodeHandle(r.node),
    };
  }
  function beltHandle(r) {
    var c = r.c;
    return {
      run: function (f) { call('comp.call', c, 'run', [!!f]); },
      get occupied() { return call('comp.read', c, 'occupied'); },
      get speed() { return call('comp.read', c, 'speed'); },
      node: nodeHandle(r.node),
    };
  }
  function transportHandle(r) {
    var c = r.c;
    return {
      get direction() { return call('comp.read', c, 'direction'); },
      get speed() { return call('comp.read', c, 'speed'); },
      get radial() { return call('comp.read', c, 'radial'); },
      node: nodeHandle(r.node),
    };
  }
  function sourceHandle(r) {
    var c = r.c;
    return {
      spawn: function () { return call('comp.call', c, 'spawn', []); },
      get automatic() { return call('comp.read', c, 'automatic'); },
      set automatic(v) { call('comp.call', c, 'setAutomatic', [!!v]); },
      get interval() { return call('comp.read', c, 'interval'); },
      set interval(v) { call('comp.call', c, 'setInterval', [v]); },
      node: nodeHandle(r.node),
    };
  }
  function sinkHandle(r) {
    var c = r.c;
    return {
      on: function (cb) { return subOn(c, cb); },
      node: nodeHandle(r.node),
    };
  }
  function gripHandle(r) {
    var c = r.c;
    return {
      pick: function () { call('comp.call', c, 'pick', []); },
      place: function () { call('comp.call', c, 'place', []); },
      get gripped() { return call('comp.read', c, 'gripped'); },
      get range() { return call('comp.read', c, 'range'); },
      node: nodeHandle(r.node),
    };
  }
  function logicStepHandle(r) {
    var c = r.c;
    return {
      get state() { return call('comp.read', c, 'state'); },
      get runId() { return call('comp.read', c, 'runId'); },
      get progress() { return call('comp.read', c, 'progress'); },
      start: function () { call('comp.call', c, 'start', []); },
      reset: function () { call('comp.call', c, 'reset', []); },
      complete: function () { call('comp.call', c, 'complete', []); },
      node: nodeHandle(r.node),
    };
  }

  var WRAP = {
    drive: driveHandle, sensor: sensorHandle, belt: beltHandle,
    transport: transportHandle, source: sourceHandle, sink: sinkHandle,
    grip: gripHandle, logicStep: logicStepHandle,
  };
  var FIND_KIND = {
    Drive: 'drive', Sensor: 'sensor', Belt: 'belt', TransportSurface: 'transport',
    Source: 'source', Sink: 'sink', Grip: 'grip', LogicStep: 'logicStep',
  };

  function resolveComp(kind, p) {
    var r = call('comp.resolve', kind, p);
    return r ? WRAP[kind](r) : null;
  }

  // ── Tier 1: value-typed Port / MU handles (phase 1b) ─────────────────
  function portHandle(d) {
    if (d === null || d === undefined) return null;
    return {
      id: d.id,
      role: d.role,
      node: nodeHandle(d.node === undefined ? null : d.node),
      partner: nodeHandle(d.partner === undefined ? null : d.partner),
      worldAngle: (d.worldAngle === null || d.worldAngle === undefined) ? undefined : d.worldAngle,
      occupied: function () { return call('port.read', d.id, 'occupied') === true; },
      upstreamWaiting: function () { return call('port.read', d.id, 'upstreamWaiting') === true; },
      setOccupied: function (v) { call('port.setOccupied', d.id, !!v); },
    };
  }
  function listPorts() {
    var ds = call('ports.list') || [];
    var out = [];
    for (var i = 0; i < ds.length; i++) out.push(portHandle(ds[i]));
    return out;
  }
  function muHandle(ref) {
    if (ref === null || ref === undefined) return null;
    return {
      id: ref.id,
      type: ref.type || '',
      prop: ref.prop || {},
      get node() { return nodeHandle(call('mu.node', ref.id)); },
      park: function () { call('mu.park', ref.id); },
      release: function () { call('mu.release', ref.id); },
    };
  }
  function deflateMu(mu) {
    if (mu === null || mu === undefined) return null;
    return { id: mu.id, type: mu.type || '', prop: mu.prop || {} };
  }

  // ── Recurring timers (self.every) — plan-2212 Phase 4c ──────────────
  // The HOST owns the clock (record + re-arm before dispatch, negative public
  // ids). The guest keeps only pid -> { hook, data } with the ORIGINAL data
  // object, so mutations reach later slices exactly as before 4c. A slice
  // arrives as '__rv.every' with { pid }: no payload marshalling, no host call.
  var _everyData = {};
  globalThis.__rvEveryData = {
    add: function (pid, hook, data) { _everyData[pid] = { hook: hook, data: data }; },
    remove: function (pid) { delete _everyData[pid]; },
    clear: function () { _everyData = {}; },
    // Snapshot export in creation order (negative-integer keys keep insertion order).
    // pids (optional): only these entries - the live host records - so a
    // guest-only leftover never reaches the payload validator.
    items: function (pids) {
      var keys = Object.keys(_everyData);
      if (Array.isArray(pids)) {
        var live = {};
        pids.forEach(function (p) { live[p] = true; });
        keys = keys.filter(function (pid) { return live[pid] === true; });
      }
      return keys.map(function (pid) {
        return { pid: Number(pid), hook: _everyData[pid].hook, data: _everyData[pid].data };
      });
    },
    replace: function (items) {
      var next = {};
      items.forEach(function (it) { next[it.pid] = { hook: it.hook, data: it.data }; });
      _everyData = next;
    },
  };

  // Internal hook router: consumes '__rv.every' (user hook of a recurring
  // timer) and '__rv.msg' (onMessage), hydrates MU refs for everything else.
  // Called by the synthesized des.on in the setup wrapper. Returns false only
  // for an every slice the guest holds no entry for (the host then drops it).
  globalThis.__rvRouteHook = function (hook, mu, data, handlers) {
    if (hook === '__rv.every') {
      var rec = data ? _everyData[data.pid] : undefined;
      if (!rec) return false;
      if (handlers.on) handlers.on(rec.hook, null, rec.data);
      return;
    }
    if (hook === '__rv.msg') {
      if (handlers.onMessage && data) handlers.onMessage(data.topic, data.data, data.from);
      return;
    }
    if (hook === '__rv.arrival') {
      // StopOnExit (plan-259): the MU is ALREADY held — the station only
      // processes and eventually calls mu.release().
      if (handlers.onArrival) handlers.onArrival(muHandle(mu));
      return;
    }
    if (hook === '__rv.connreq') {
      // Custom-connection request (plan-259): build the deferred reply handle
      // from the host reply id. Exactly-once on the guest side too — the host
      // additionally guards duplicate/invalidated replies.
      if (handlers.onRequest && data) {
        var rid = data.replyId;
        var replied = false;
        handlers.onRequest(data.topic, data.params || {}, function (resp) {
          if (replied) return;
          replied = true;
          call('conn.reply', rid, resp === undefined ? null : resp);
        });
      }
      return;
    }
    if (handlers.on) handlers.on(hook, muHandle(mu), data);
  };
  globalThis.__rvHydrateMu = muHandle;
  globalThis.__rvHydratePort = portHandle;

  function signalHandle(name) {
    return {
      get bool() { return call('sig.get', name) === true; },
      get num() {
        var v = call('sig.get', name);
        return typeof v === 'number' ? v : (v === true ? 1 : 0);
      },
      get int() { return Math.trunc(this.num); },
      set: function (v) { call('sig.set', name, v); },
      on: function (cb) {
        var id = regCb(cb);
        var tok = callWithCb(id, ['sig.on', name, id]);
        return function () { if (tok !== null) call('unsub', tok); delete _cbs[id]; };
      },
    };
  }

  // Trusted persist/timer validator (plan-2059 3b). Every intrinsic is captured HERE, before any
  // user code runs, and the result is serialized by hand from a detached walk — user code that
  // replaces Object/Reflect/JSON/Array methods or adds toJSON can neither fake a verdict nor
  // change what is serialized. Non-writable, non-configurable on the global.
  (function () {
    var uncurry = Function.prototype.bind.bind(Function.prototype.call);
    var gopd = Object.getOwnPropertyDescriptor, ownKeys = Reflect.ownKeys, getProto = Object.getPrototypeOf;
    var isArray = Array.isArray, isFinite_ = Number.isFinite, is = Object.is, stringify = JSON.stringify;
    var ObjectProto = Object.prototype, ArrayProto = Array.prototype, Num = Number, Str = String, Err = Error;
    var SetCtor = Set, setHas = uncurry(Set.prototype.has), setAdd = uncurry(Set.prototype.add);
    function validatedText(value) {
      var seen = new SetCtor();
      function visit(v, path) {
        function bad(reason) { throw new Err(path + ': ' + reason); }
        if (v === null) return 'null';
        if (typeof v === 'string') return stringify(v);
        if (typeof v === 'boolean') return v ? 'true' : 'false';
        if (typeof v === 'number') {
          if (!isFinite_(v) || is(v, -0)) bad('unsupported number');
          return stringify(v);
        }
        if (typeof v !== 'object') bad('unsupported value');
        if (setHas(seen, v)) bad('alias or cycle');
        setAdd(seen, v);
        var array = isArray(v), proto = getProto(v);
        if (proto !== (array ? ArrayProto : ObjectProto) && !(proto === null && !array)) bad('non-plain container');
        var keys = ownKeys(v), out = '';
        if (array && keys.length !== v.length + 1) bad('sparse array or extra keys');
        var first = true;
        for (var i = 0; i < keys.length; i++) {
          var key = keys[i];
          if (array && key === 'length') continue;
          if (typeof key !== 'string') bad('symbol key');
          if (key === '$map' || key === '$set' || key === '$num') bad('reserved tag');
          if (array) { var n = Num(key); if (!(n >= 0 && n < v.length && n % 1 === 0 && Str(n) === key)) bad('array key'); }
          var d = gopd(v, key);
          if (!d.enumerable || !('value' in d)) bad('accessor or hidden property');
          var item = visit(d.value, path + '.' + key);
          out += (first ? '' : ',') + (array ? '' : stringify(key) + ':') + item;
          first = false;
        }
        return array ? '[' + out + ']' : '{' + out + '}';
      }
      return visit(value, '$');
    }
    Object.defineProperty(globalThis, '__rvValidatedText', { value: validatedText, writable: false, configurable: false, enumerable: false });
  })();

  globalThis.__rvCreateSelf = function (meta) {
    // mulberry32, seeded per component (deterministic, kernel-agnostic).
    var _rs = (meta.seed >>> 0) || 1;
    function random() {
      _rs = (_rs + 0x6D2B79F5) | 0;
      var t = Math.imul(_rs ^ (_rs >>> 15), 1 | _rs);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    var _state = 'idle';
    var _enabled = true;
    // plan-2212 Phase 4b (C): the time of the dispatch the guest is running in,
    // handed in by the host with the dispatch; undefined outside one (host call).
    var _dispatchNow;
    var selfNodeId = call('node.self');

    return {
      name: meta.name,
      path: meta.path,
      self: nodeHandle(selfNodeId),
      node: function (p) { return nodeHandle(call('node.resolve', p)); },
      find: function (type, p) {
        var kind = FIND_KIND[type];
        return kind ? resolveComp(kind, p) : null;
      },
      findAll: function (type) {
        var kind = FIND_KIND[type];
        if (!kind) return [];
        var rs = call('comp.resolveAll', kind) || [];
        var out = [];
        for (var i = 0; i < rs.length; i++) out.push(WRAP[kind](rs[i]));
        return out;
      },
      children: function (type) {
        var ids = call('node.children', selfNodeId, type || null) || [];
        var out = [];
        for (var i = 0; i < ids.length; i++) out.push(nodeHandle(ids[i]));
        return out;
      },

      get state() { return _state; },
      setState: function (n) { var s = String(n); call('setState', s); _state = s; },
      prop: meta.props || {},
      get now() { return _dispatchNow !== undefined ? _dispatchNow : call('now'); },
      random: random,

      drive: function (p) { return resolveComp('drive', p); },
      sensor: function (p) { return resolveComp('sensor', p); },
      belt: function (p) { return resolveComp('belt', p); },
      transport: function (p) { return resolveComp('transport', p); },
      source: function (p) { return resolveComp('source', p); },
      sink: function (p) { return resolveComp('sink', p); },
      grip: function (p) { return resolveComp('grip', p); },
      logicStep: function (p) { return resolveComp('logicStep', p); },
      scene: {
        list: function (type) { return call('scene.list', type); },
        read: function (path, type) { return call('scene.read', path, type); },
        set: function (path, type, field, value) { call('scene.set', path, type, field, value); },
      },

      signal: signalHandle,
      signalAt: signalHandle,
      setSignals: function (u) { call('sig.setAll', u); },

      vec3: M.vec3, quat: M.quat, mat4: M.mat4, aabb: M.aabb,
      DEG2RAD: M.DEG2RAD, RAD2DEG: M.RAD2DEG, clamp: M.clamp,

      // Host first (plan-2212 Phase 4): a refused disable leaves self.enabled true.
      disable: function (reason) { call('disable', reason); _enabled = false; },
      get enabled() { return _enabled; },
      log: function () {
        call.apply(null, ['log'].concat(Array.prototype.slice.call(arguments)));
      },
      warn: function () {
        call.apply(null, ['log.warn'].concat(Array.prototype.slice.call(arguments)));
      },
      error: function () {
        call.apply(null, ['log.error'].concat(Array.prototype.slice.call(arguments)));
      },
      raiseError: function (code, message) { call('err.raise', code, message === undefined ? '' : message); },
      clearError: function () { call('err.clear'); },

      // ── Supervisory: other script components (phase 1b) ────────────────
      component: function (p) {
        var info = call('script.get', p);
        if (!info) return null;
        var path = info.path;
        return {
          path: path,
          get state() { var i = call('script.get', path); return i ? i.state : ''; },
          get enabled() { var i = call('script.get', path); return i ? i.enabled : false; },
          get error() { var i = call('script.get', path); return i ? i.error : null; },
          send: function (topic, data) {
            return call('script.send', path, topic, data === undefined ? null : data) === true;
          },
        };
      },
      broadcast: function (topic, data) {
        return call('script.broadcast', topic, data === undefined ? null : data);
      },

      // ── Typed connections (plan-259): bidirectional call over edges ────
      connection: function (type) {
        return {
          type: type,
          call: function (params, onReply) {
            var cbId = null;
            var remaining = 0;
            if (typeof onReply === 'function') {
              cbId = regCb(function (resp) {
                onReply(resp);
                remaining--;
                if (remaining <= 0) delete _cbs[cbId];
              });
            }
            var n = cbId === null
              ? call('conn.call', type, params === undefined ? null : params, cbId)
              : callWithCb(cbId, ['conn.call', type, params === undefined ? null : params, cbId]);
            if (cbId !== null) {
              // Replies are always deferred (scheduled on the target's event
              // list) — never synchronous within call(), so this is race-free.
              if (n <= 0) delete _cbs[cbId];
              else remaining = n;
            }
            return n;
          },
        };
      },

      // ── Tier 1: timers (kernel-agnostic) + recurring events ────────────
      in: function (d, hook, mu, data) {
        return call('timer.in', d, hook, deflateMu(mu), data === undefined ? null : data);
      },
      at: function (t, hook, mu, data) {
        return call('timer.at', t, hook, deflateMu(mu), data === undefined ? null : data);
      },
      every: function (interval, hook, data) {
        // plan-2212 Phase 4c: host first (one op, clock only) - a refused timer
        // (DES frame hook) leaves no host record, no entry here, no pid step.
        var pid = call('timer.every', interval, hook);
        globalThis.__rvEveryData.add(pid, hook, data === undefined ? null : data);
        return pid;
      },
      cancel: function (id) {
        // Host first (negative = a recurring timer, host clock): a refused cancel
        // (DES frame hook fence) throws here and leaves BOTH halves intact; the
        // guest entry goes only after the host record is gone (review 2).
        call('timer.cancel', id);
        if (id < 0) globalThis.__rvEveryData.remove(id);
      },

      // ── Tier 1: ports / topology (snap-graph backend, phase 1b) ────────
      inputs: function () {
        var out = [];
        var ps = listPorts();
        for (var i = 0; i < ps.length; i++) if (ps[i].role === 'input') out.push(ps[i]);
        return out;
      },
      outputs: function () {
        var out = [];
        var ps = listPorts();
        for (var i = 0; i < ps.length; i++) if (ps[i].role === 'output') out.push(ps[i]);
        return out;
      },
      freeOutputs: function (mu) {
        var out = [];
        var ps = listPorts();
        for (var i = 0; i < ps.length; i++) {
          var p = ps[i];
          if (p.role !== 'output' || p.occupied()) continue;
          if (mu && call('flow.downstreamCanAccept', deflateMu(mu), p.id) !== true) continue;
          out.push(p);
        }
        return out;
      },
      get ports() { return listPorts(); },
      downstreamOccupied: function (port) {
        return port ? port.occupied() : call('flow.downstreamOccupied') === true;
      },
      downstreamCanAccept: function (mu, port) {
        return call('flow.downstreamCanAccept', deflateMu(mu), port ? port.id : null) === true;
      },

      // ── Tier 1: path graph / zones by id (plan-268 Phase 6) ────────────
      // Query functions return plain JSON descriptors (no live handles —
      // path geometry/topology is parse-static). claim/release/isHolder use
      // the ZoneRegistry semantics; the holder id defaults to THIS
      // component's path (self.path) when omitted.
      paths: {
        list: function () { return call('paths.list') || []; },
        get: function (id) { return call('paths.get', id); },
        successors: function (id) { return call('paths.successors', id) || []; },
        claim: function (zoneId, holderId) {
          return call('zone.claim', zoneId, holderId === undefined ? null : holderId) === true;
        },
        release: function (zoneId, holderId) {
          call('zone.release', zoneId, holderId === undefined ? null : holderId);
        },
        isHolder: function (zoneId, holderId) {
          return call('zone.isHolder', zoneId, holderId === undefined ? null : holderId) === true;
        },
      },

      // ── Tier 1: MU / transfer (flow backend, phase 1b) ─────────────────
      transfer: function (mu, fromPort) {
        call('transfer', deflateMu(mu), fromPort ? fromPort.id : null);
      },
      spawn: function () { return muHandle(call('spawn')); },
      get mus() {
        var refs = call('flow.mus') || [];
        var out = [];
        for (var i = 0; i < refs.length; i++) out.push(muHandle(refs[i]));
        return out;
      },
      get currentLoad() { return call('flow.load'); },

      // ── Tier 1: statistics ──────────────────────────────────────────────
      statValue: function (key, value, unit, group) { call('stat.row', String(key), value, unit, group); },
      statState: function (name) { call('stat', 'state', String(name)); },
      statOutput: function (n) { call('stat', 'output', n === undefined ? 1 : n); },
      statCycleStart: function () { call('stat', 'cycleStart'); },
      statCycleEnd: function () { call('stat', 'cycleEnd'); },

      // ── Internal (plan-261): PRNG/FSM state accessors for snapshot/restore.
      // NOT part of the public script API — the setup wrapper merges them into
      // the handler root under the namespaced '__rv.rng' / '__rv.state' paths
      // so the host can capture and re-inject the self.random() position and
      // the FSM state across a DES snapshot round-trip.
      __rvGetRng: function () { return _rs | 0; },
      __rvCbCount: function () { return Object.keys(_cbs).length; },
      __rvSetRng: function (v) { _rs = v | 0; },
      __rvGetState: function () { return _state; },
      // plan-2212 Phase 4b: enter/leave a dispatch at host time t (returns the previous value).
      __rvSetDispatchNow: function (t) {
        var prev = _dispatchNow;
        _dispatchNow = (typeof t === 'number' && t === t) ? t : undefined;
        return prev;
      },
      __rvSetState: function (v) { _state = String(v); call('setState', _state); },
    };
  };
})();
'ok';
`;

/**
 * Installed AFTER the user code (which defines the global `setup`). Wraps it:
 * the wrapped `setup()` (called argument-free by `RVScriptContext.runSetup`)
 * builds the guest `self`, runs the user setup and attaches the guest
 * callback dispatcher as the retained `__cb` lifecycle handler — the host's
 * ONLY way to call back into arbitrary guest callbacks (sensor.on/signal.on).
 *
 * Phase 1b additions (all guest-side, no host change):
 *  - **Soft error layer (`onError`):** every user handler is wrapped in
 *    try/catch; a thrown error first goes to the script's optional
 *    `onError(err, phase)` — returning `true` means "handled, keep running".
 *    Unhandled → rethrow → the existing host behavior (first-tick disable /
 *    late-tick log, poison backoff below).
 *  - **Hydration:** DES station handlers (`canAccept/onAccept/
 *    onDownstreamReady`) and hook events receive full guest `MU`/`Port`
 *    handles (park/release/node, occupied/…), built from the plain value refs
 *    that crossed the boundary.
 *  - **Synthesized `des.on`:** ALWAYS present, routing internal hooks —
 *    `__rv.every` (recurring timers; re-armed host-side since plan-2212 Phase 4c) and `__rv.msg`
 *    (`onMessage(topic, data, fromPath)`) — before the user's own `on`.
 */
export const SDK_SETUP_WRAPPER_SOURCE = String.raw`
globalThis.__rvUserSetup = setup;
globalThis.setup = function () {
  var self = globalThis.__rvCreateSelf(globalThis.__rvMeta);
  var persistCalled = false, persistValue, setupDone = false;
  var validatedText = globalThis.__rvValidatedText; // trusted, captured before any user code
  self.persist = function (initial) {
    if (persistCalled || setupDone) throw new Error('self.persist must be called once during setup');
    validatedText(initial);
    persistCalled = true; persistValue = initial;
    return initial;
  };
  var h = globalThis.__rvUserSetup(self);
  setupDone = true;
  if (h === null || typeof h !== 'object') h = {};

  function guard(fn, phase) {
    if (typeof fn !== 'function') return undefined;
    return function () {
      try {
        return fn.apply(null, arguments);
      } catch (e) {
        var handled = false;
        if (typeof h.onError === 'function') {
          try { handled = h.onError(e, phase) === true; } catch (e2) { handled = false; }
        }
        if (!handled) throw e;
        return undefined;
      }
    };
  }

  var userDes = (h.des !== null && typeof h.des === 'object') ? h.des : {};
  var userOn = guard(userDes.on, 'hook');
  var userMsg = guard(h.onMessage, 'message');
  var userArrival = guard(h.onArrival, 'hook');
  var userRequest = guard(h.onRequest, 'hook');
  // plan-2212 Phase 4b (C): host dispatches pass the current time as their last
  // argument; inside the dispatch self.now answers from it (no host call). The
  // previous value is restored, so nesting and the time outside stay unchanged.
  var setDispatchNow = self.__rvSetDispatchNow;
  var des = {};
  if (typeof userDes.canAccept === 'function') {
    var gCanAccept = guard(userDes.canAccept, 'hook');
    des.canAccept = function (mu, port, now) {
      var prev = setDispatchNow(now);
      try { return gCanAccept(globalThis.__rvHydrateMu(mu), globalThis.__rvHydratePort(port)); }
      finally { setDispatchNow(prev); }
    };
  }
  if (typeof userDes.onAccept === 'function') {
    var gOnAccept = guard(userDes.onAccept, 'hook');
    des.onAccept = function (mu, port, now) {
      var prev = setDispatchNow(now);
      try { return gOnAccept(globalThis.__rvHydrateMu(mu), globalThis.__rvHydratePort(port)); }
      finally { setDispatchNow(prev); }
    };
  }
  if (typeof userDes.onDownstreamReady === 'function') {
    var gDown = guard(userDes.onDownstreamReady, 'hook');
    des.onDownstreamReady = function (port, now) {
      var prev = setDispatchNow(now);
      try { return gDown(globalThis.__rvHydratePort(port)); }
      finally { setDispatchNow(prev); }
    };
  }
  des.on = function (hook, mu, data, now) {
    var prev = setDispatchNow(now);
    try {
      return globalThis.__rvRouteHook(hook, mu, data, {
        on: userOn, onMessage: userMsg, onArrival: userArrival, onRequest: userRequest,
      });
    } finally { setDispatchNow(prev); }
  };
  // plan-2212 Phase 4b (A): the explicit settle opt-in 'des: { samplesLiveGeometry: true }'.
  var samplesLiveGeometry = userDes.samplesLiveGeometry === true;
  h.des = des;

  if (h.continuous !== null && typeof h.continuous === 'object') {
    h.continuous = {
      fixedUpdate: guard(h.continuous.fixedUpdate, 'fixedUpdate'),
      lateFixedUpdate: guard(h.continuous.lateFixedUpdate, 'fixedUpdate'),
      teardown: guard(h.continuous.teardown, 'fixedUpdate'),
    };
  }
  // Path routing hooks (plan-268 Phase 6): id-based, dispatched host→VM by
  // the web-component registry when declared. Guarded like every handler so
  // onError applies; a failed selectNextPath falls back to the default route.
  if (h.routing !== null && typeof h.routing === 'object') {
    h.routing = {
      selectNextPath: guard(h.routing.selectNextPath, 'routing'),
      onArrive: guard(h.routing.onArrive, 'routing'),
      requestDispatch: guard(h.routing.requestDispatch, 'routing'),
    };
  }
  if (typeof h.onSignal === 'function') h.onSignal = guard(h.onSignal, 'signal');
  if (typeof h.onReset === 'function') h.onReset = guard(h.onReset, 'reset');

  // Snapshot hooks (plan-261): the ONLY supported way to persist script state
  // across a DES snapshot/restore. onSnapshot() returns a JSON value; the host
  // stores it and passes it back to onRestore(state). Both MUST be synchronous.
  if (typeof h.onSnapshot === 'function') h.onSnapshot = guard(h.onSnapshot, 'snapshot');
  if (typeof h.onRestore === 'function') h.onRestore = guard(h.onRestore, 'snapshot');

  // Namespaced internal handlers (plan-261 B4): '__rv.rng.get/set' and
  // '__rv.state.get/set' let the host capture and re-inject the seeded
  // self.random() position (_rs) and the FSM state. Namespaced under '__rv'
  // so user-defined top-level handler keys can never collide.
  h.__rv = {
    // plan-2212 Phase 4c: the guest half of the every table (pid -> hook + data).
    every: {
      get: function (pids) { return validatedText(globalThis.__rvEveryData.items(pids)); },
      set: function (text) { globalThis.__rvEveryData.replace(JSON.parse(text)); },
      clear: function () { globalThis.__rvEveryData.clear(); },
    },
    persist: {
      get: function () {
        var out = {};
        if (persistCalled) out.persist = persistValue;
        if (typeof h.onSnapshot === 'function') out.legacy = h.onSnapshot();
        return validatedText(out);
      },
      set: function (text) {
        var value = JSON.parse(text);
        if (persistCalled && value !== null && typeof value === 'object' && persistValue !== null && typeof persistValue === 'object') {
          if (Array.isArray(persistValue)) persistValue.length = 0;
          Object.keys(persistValue).forEach(function (key) { delete persistValue[key]; });
          Object.keys(value).forEach(function (key) {
            Object.defineProperty(persistValue, key, {value: value[key], writable: true, enumerable: true, configurable: true});
          });
        } else persistValue = value;
      },
    },
    // Registered guest callbacks (leak checks, plan-2212 Phase 4).
    cbs: { count: function () { return self.__rvCbCount(); } },
    des: { samplesLiveGeometry: function () { return samplesLiveGeometry; } },
    // An uncatchable abort (call deadline) skips the 'finally' that leaves a
    // dispatch: the host calls this after a failed dispatch so a stale time can
    // never answer self.now outside a dispatch.
    dispatch: { clear: function () { setDispatchNow(undefined); } },
    rng: {
      initial: function () { return (globalThis.__rvMeta.seed >>> 0) || 1; },
      get: function () { return self.__rvGetRng(); },
      set: function (v) { self.__rvSetRng(v); },
    },
    state: {
      get: function () { return self.__rvGetState(); },
      set: function (v) { self.__rvSetState(v); },
    },
  };

  h.__cb = function (id, args, now) {
    var prev = setDispatchNow(now);
    try { return globalThis.__rvDispatchCb(id, args); } finally { setDispatchNow(prev); }
  };
  return h;
};
'ok';
`;
