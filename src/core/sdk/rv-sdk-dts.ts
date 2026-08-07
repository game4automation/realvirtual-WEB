// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-sdk-dts.ts — generator for `rv-sdk.d.ts` (plan-210 §6 S5).
 *
 * The generated declaration string feeds:
 *  - the Monaco extraLib in the phase-3 script editor
 *    (`typescriptDefaults.addExtraLib(generateSdkDts(), 'rv-sdk.d.ts')`),
 *  - the source-projection `work/rv-sdk.d.ts` (plan §4b),
 *  - the `dts-generation` compile test (tsc `noLib` — see
 *    `SDK_MINIMAL_LIB_DTS` for the minimal ambient lib the restrictive
 *    compiler setup pairs with it).
 *
 * v1 is a hand-maintained template mirroring the §6-appendix surface; it MUST
 * stay compilable under `noLib` (guarded by tests/dts-generation.node.test.ts).
 * A schema-driven generator (plan-139 property typings per node) extends this
 * in phase 3/4.
 */

export const SDK_API_VERSION = 1;

/**
 * Minimal ambient lib for `noLib` compilation — the restrictive compiler
 * setup deliberately drops lib.dom/lib.es*: the author sees ONLY this surface
 * (no `window`, no `fetch`). Sufficient for the checker's required globals
 * plus the `Math` subset script components may use.
 */
export const SDK_MINIMAL_LIB_DTS = `// rv-sdk minimal lib (noLib companion) — apiVersion ${SDK_API_VERSION}
interface Boolean {}
interface Function {}
interface CallableFunction extends Function {}
interface NewableFunction extends Function {}
interface IArguments {}
interface Number { toFixed(digits?: number): string }
interface Object {}
interface RegExp {}
interface String { readonly length: number }
interface Array<T> {
  readonly length: number;
  [n: number]: T;
  push(...items: T[]): number;
  indexOf(item: T): number;
  slice(start?: number, end?: number): T[];
  map<U>(fn: (value: T, index: number) => U): U[];
  filter(fn: (value: T, index: number) => boolean): T[];
  find(fn: (value: T, index: number) => boolean): T | undefined;
  forEach(fn: (value: T, index: number) => void): void;
  some(fn: (value: T, index: number) => boolean): boolean;
  every(fn: (value: T, index: number) => boolean): boolean;
}
interface ReadonlyArray<T> {
  readonly length: number;
  readonly [n: number]: T;
  indexOf(item: T): number;
  slice(start?: number, end?: number): T[];
  map<U>(fn: (value: T, index: number) => U): U[];
  filter(fn: (value: T, index: number) => boolean): T[];
  find(fn: (value: T, index: number) => boolean): T | undefined;
  forEach(fn: (value: T, index: number) => void): void;
  some(fn: (value: T, index: number) => boolean): boolean;
  every(fn: (value: T, index: number) => boolean): boolean;
}
declare const Math: {
  readonly PI: number;
  abs(x: number): number;
  acos(x: number): number;
  asin(x: number): number;
  atan(x: number): number;
  atan2(y: number, x: number): number;
  ceil(x: number): number;
  cos(x: number): number;
  floor(x: number): number;
  max(...values: number[]): number;
  min(...values: number[]): number;
  pow(x: number, y: number): number;
  round(x: number): number;
  sign(x: number): number;
  sin(x: number): number;
  sqrt(x: number): number;
  tan(x: number): number;
  trunc(x: number): number;
};
declare function Number(value: unknown): number;
declare function String(value: unknown): string;
declare function Boolean(value: unknown): boolean;
`;

/**
 * Generate the `rv-sdk.d.ts` content — the §6-appendix SDK surface v1
 * (Tier 0 full + math library + component handles + Tier-1 profile).
 */
export function generateSdkDts(): string {
  return `// rv-sdk.d.ts — realvirtual WEB component SDK (apiVersion ${SDK_API_VERSION}, generated)
// Value-typed script surface: only plain data crosses the sandbox boundary.

// ── Value types (POJOs) ──
interface Vec3 { x: number; y: number; z: number }
interface Quat { x: number; y: number; z: number; w: number }
type Mat4 = number[];
interface AABB { min: Vec3; max: Vec3 }
type EulerOrder = 'XYZ' | 'YXZ' | 'ZXY' | 'ZYX' | 'YZX' | 'XZY';
type PropValue = number | string | boolean | null;

// ── Math library (pure in-VM value math) ──
interface Vec3Lib {
  (x?: number, y?: number, z?: number): Vec3;
  add(a: Vec3, b: Vec3): Vec3; sub(a: Vec3, b: Vec3): Vec3; scale(a: Vec3, s: number): Vec3;
  dot(a: Vec3, b: Vec3): number; cross(a: Vec3, b: Vec3): Vec3;
  length(a: Vec3): number; lengthSq(a: Vec3): number; normalize(a: Vec3): Vec3;
  distance(a: Vec3, b: Vec3): number; lerp(a: Vec3, b: Vec3, t: number): Vec3;
  angleTo(a: Vec3, b: Vec3): number; project(a: Vec3, onto: Vec3): Vec3;
  reflect(a: Vec3, n: Vec3): Vec3; applyQuat(a: Vec3, q: Quat): Vec3;
  applyMat4(a: Vec3, m: Mat4): Vec3; negate(a: Vec3): Vec3;
  equals(a: Vec3, b: Vec3, eps?: number): boolean;
}
interface QuatLib {
  (x?: number, y?: number, z?: number, w?: number): Quat;
  fromAxisAngle(axis: Vec3, rad: number): Quat;
  fromEuler(x: number, y: number, z: number, order?: EulerOrder): Quat;
  mul(a: Quat, b: Quat): Quat; conjugate(q: Quat): Quat; invert(q: Quat): Quat;
  normalize(q: Quat): Quat; slerp(a: Quat, b: Quat, t: number): Quat;
  angleTo(a: Quat, b: Quat): number; lookRotation(forward: Vec3, up?: Vec3): Quat;
}
interface Mat4Lib {
  identity(): Mat4; multiply(a: Mat4, b: Mat4): Mat4; invert(m: Mat4): Mat4;
  compose(pos: Vec3, rot: Quat, scale: Vec3): Mat4;
  transformPoint(m: Mat4, p: Vec3): Vec3; transformDir(m: Mat4, d: Vec3): Vec3;
}
interface AABBLib {
  fromNodes(nodes: NodeHandle[]): AABB; size(b: AABB): Vec3; center(b: AABB): Vec3;
  longestAxis(b: AABB): 'x' | 'y' | 'z'; overlaps(a: AABB, b: AABB): boolean;
  contains(b: AABB, p: Vec3): boolean;
}

// ── NodeHandle: value-typed world reads (replaces Object3D at the boundary) ──
interface NodeHandle {
  readonly name: string; readonly path: string;
  worldPosition(): Vec3; worldQuaternion(): Quat; worldDirection(localAxis?: Vec3): Vec3;
  localPosition(): Vec3; localQuaternion(): Quat; scale(): Vec3; worldMatrix(): Mat4;
  worldToLocal(p: Vec3): Vec3; localToWorld(p: Vec3): Vec3;
  bounds(): AABB; parent(): NodeHandle | null; occupied(): boolean;
}

// ── Component handles ──
interface DriveHandle {
  readonly position: number; readonly speed: number;
  readonly isAtTarget: boolean; readonly isMoving: boolean;
  targetSpeed: number;
  moveTo(destination: number): void; startMove(destination?: number): void;
  jog(forward: boolean): void; stop(): void;
  readonly node: NodeHandle;
}
interface SensorHandle {
  readonly occupied: boolean; readonly mode: 'Raycast' | 'Collision';
  /** Edge callback. The second argument carries the occupying MU handle on
   *  ENTER (null on exit / when unknown) — plan-259 sensor→MU bridge. */
  on(cb: (occupied: boolean, mu?: MU | null) => void): () => void;
  readonly node: NodeHandle;
}
interface BeltHandle {
  run(forward: boolean): void;
  readonly occupied: boolean; readonly speed: number; readonly node: NodeHandle;
}
interface TransportHandle {
  readonly direction: Vec3; readonly speed: number; readonly radial: boolean;
  readonly node: NodeHandle;
}
interface SourceHandle { spawn(): MU; automatic: boolean; interval: number }
interface SinkHandle { on(cb: (mu: MU) => void): () => void }
interface GripHandle {
  pick(): void; place(): void;
  readonly gripped: ReadonlyArray<MU>; readonly range: number;
}
interface LogicStepHandle {
  readonly state: 'Idle' | 'Active' | 'Waiting' | 'Finished';
  readonly progress: number;
  start(): void; reset(): void;
}
interface SignalHandle {
  readonly bool: boolean; readonly num: number; readonly int: number;
  set(value: boolean | number): void;
  on(cb: (value: boolean | number) => void): () => void;
}
/** A topology port (snap graph). \`occupied()/upstreamWaiting()/setOccupied()\`
 *  carry the shared per-port-then-root Flow.Occupied interlock convention —
 *  never build interlock signal names by hand. */
interface Port {
  readonly id: string; readonly role: 'input' | 'output';
  /** This component's OWN local snap node (the angle-math frame). */
  readonly node: NodeHandle;
  /** The partner component's root node. */
  readonly partner: NodeHandle;
  readonly worldAngle?: number;
  /** True when the downstream behind this port cannot accept (interlock). */
  occupied(): boolean;
  /** True when a part waits on the connected upstream side. */
  upstreamWaiting(): boolean;
  /** Publish MY per-port occupied state for exactly this connection. */
  setOccupied(v: boolean): void;
}
/** A movable unit as the script sees it (value handle). */
interface MU {
  readonly id: number;
  readonly type?: string;
  readonly prop?: { [k: string]: PropValue };
  readonly node?: NodeHandle | null;
  /** Hold this MU: continuous = surface halt; DES = keep its capacity slot. */
  park(): void;
  /** Undo \`park()\`. */
  release(): void;
}
/** A path of the AGV path graph as a plain descriptor (rv_extras.Path).
 *  Pure value data — lengths are in MILLIMETERS (drive parity, same unit as
 *  \`Agv.Position\`/\`TargetSpeed\`). */
interface PathDesc {
  readonly id: string;
  /** Arc length in mm. */
  readonly length: number;
  readonly closed: boolean;
  readonly successorIds: string[];
  readonly predecessorIds: string[];
  /** Zone id this path belongs to (null = unzoned). */
  readonly zone: string | null;
  /** Explicit zone capacity (null = undeclared, registry default 1). */
  readonly zoneCapacity: number | null;
}
/** Context of a \`routing.selectNextPath\` decision. */
interface RouteContext {
  readonly travelerId: string;
  readonly currentPathId: string;
  /** 1 = forward (successors), -1 = backward (predecessors). */
  readonly direction: 1 | -1;
}
/** Path-graph queries + zone claims (\`self.paths\`). Zones follow the shared
 *  ZoneRegistry semantics — the SAME mutual exclusion the AGV traffic control
 *  uses; \`holderId\` defaults to THIS component's path when omitted. */
interface PathsApi {
  /** All registered paths as plain descriptors. */
  list(): PathDesc[];
  /** One path by id (null when unknown). */
  get(id: string): PathDesc | null;
  /** Successor path ids of \`id\` (empty at a dead end / unknown id). */
  successors(id: string): string[];
  /** Claim a zone (idempotent per holder). False when capacity is exhausted. */
  claim(zoneId: string, holderId?: string): boolean;
  /** Release one claim (no-op when not held). */
  release(zoneId: string, holderId?: string): void;
  /** True when the holder currently holds the zone. */
  isHolder(zoneId: string, holderId?: string): boolean;
}
/** Value snapshot/handle of ANOTHER script component (\`self.component(path)\`). */
interface ScriptComponentHandle {
  readonly path: string;
  /** The other component's current \`self.state\`. */
  readonly state: string;
  /** False when the other component is disabled/failed. */
  readonly enabled: boolean;
  /** Error raised via \`raiseError\` (null when clear). */
  readonly error: { code: string; message: string } | null;
  /** Deliver a message — arrives as \`onMessage(topic, data, fromPath)\` via the
   *  target's event list (deterministic in both kernels). */
  send(topic: string, data?: unknown): boolean;
}
/** Source-side handle on a typed connection (plan-259). One connection is a
 *  named bidirectional call: request parameters out, deferred response
 *  parameters back through the reply callback. */
interface ConnectionHandle {
  readonly type: string;
  /** Call ALL outgoing edges of this component with the given type (1:n —
   *  \`onReply\` may fire once per replying target). Parameters are validated
   *  against the connectionTypes signature. Returns the delivered count. */
  call(params?: { [k: string]: unknown } | null, onReply?: (response: { [k: string]: unknown }) => void): number;
}

type ComponentHandle =
  DriveHandle | SensorHandle | BeltHandle | TransportHandle |
  SourceHandle | SinkHandle | GripHandle | LogicStepHandle;

// ── Self (Tier 0 core + Tier 1 material-flow/DES profile) ──
interface Self {
  readonly name: string; readonly path: string;
  readonly self: NodeHandle;
  node(pathOrName: string): NodeHandle | null;
  find<T extends ComponentHandle>(type: string, pathOrName: string): T | null;
  /** ALL components of a type in the scene (like FindObjectsOfType). For
   *  supervisory control, plain array iteration calls a method on every one:
   *  \`self.findAll<DriveHandle>('Drive').forEach(function (d) { d.stop(); });\` */
  findAll<T extends ComponentHandle>(type: string): T[];
  /** Child nodes of the own node; with a convention kind ('transport' |
   *  'sensor' | 'rotary' | ...) all matching DESCENDANT nodes. */
  children(type?: string): NodeHandle[];

  readonly state: string; setState(next: string): void;
  readonly prop: { [k: string]: PropValue };
  readonly now: number; random(): number;

  drive(p: string): DriveHandle | null; sensor(p: string): SensorHandle | null;
  belt(p: string): BeltHandle | null; transport(p: string): TransportHandle | null;
  source(p: string): SourceHandle | null; sink(p: string): SinkHandle | null;
  grip(p: string): GripHandle | null; logicStep(p: string): LogicStepHandle | null;

  signal(name: string): SignalHandle; signalAt(path: string): SignalHandle;
  setSignals(updates: { [name: string]: boolean | number }): void;

  readonly vec3: Vec3Lib; readonly quat: QuatLib;
  readonly mat4: Mat4Lib; readonly aabb: AABBLib;
  readonly DEG2RAD: number; readonly RAD2DEG: number;
  clamp(x: number, lo: number, hi: number): number;

  disable(reason: string): void;
  /** False once \`disable()\` was called on this instance. */
  readonly enabled: boolean;
  log(...args: unknown[]): void;
  /** Warning-level log (debug log, nodePath prefix). */
  warn(...args: unknown[]): void;
  /** Error-level log (debug log, nodePath prefix). */
  error(...args: unknown[]): void;
  /** Raise a visible error state: emits the \`component-error\` viewer event,
   *  sets the conventional \`<Name>.Error\` signal and is readable by other
   *  components via \`self.component(path).error\`. Does NOT disable. */
  raiseError(code: string, message?: string): void;
  /** Clear the raised error state. */
  clearError(): void;

  // ── Supervisory: other script components ──
  /** Handle on ANOTHER script component (state read + message send). Null
   *  when no script component lives at that path. */
  component(path: string): ScriptComponentHandle | null;
  /** Send \`topic\`/\`data\` to ALL other script components. Returns receiver count. */
  broadcast(topic: string, data?: unknown): number;
  /** Typed-connection handle (plan-259): call over this component's outgoing
   *  edges of \`type\`; the reply arrives deferred via the callback. */
  connection(type: string): ConnectionHandle;

  // Tier 1 — material-flow / DES profile. Timers (in/at/cancel/now) are
  // kernel-agnostic Tier-0 primitives (event heap continuous, DES scheduler
  // in the event kernel).
  in(delaySec: number, hook: string, mu?: MU | null, data?: unknown): number;
  at(timeSec: number, hook: string, mu?: MU | null, data?: unknown): number;
  /** Recurring event every \`intervalSec\` — the hook fires repeatedly until
   *  cancelled (same id space as \`cancel\`; auto-cancelled on dispose).
   *  DES-safe by construction (pure event scheduling, no dt polling). */
  every(intervalSec: number, hook: string, data?: unknown): number;
  cancel(eventId: number): void;
  inputs(): Port[]; outputs(): Port[]; freeOutputs(mu?: MU): Port[];
  readonly ports: ReadonlyArray<Port>;
  /** Path-graph queries + zone claim/release by id (AGV path simulation). */
  readonly paths: PathsApi;
  downstreamOccupied(port?: Port): boolean;
  downstreamCanAccept(mu: MU, port?: Port): boolean;
  transfer(mu: MU, fromPort?: Port): void; spawn(): MU;
  readonly mus: ReadonlyArray<MU>; readonly currentLoad: number;
  /** Canonical utilization category (Working|Blocked|Empty|Setup|Failure) —
   *  separate from setState so the FSM phase never pollutes the stats. */
  statState(name: string): void;
  statOutput(n?: number): void; statCycleStart(): void; statCycleEnd(): void;
}

/** Phase a failing handler was in when \`onError\` is consulted. */
type ErrorPhase = 'fixedUpdate' | 'hook' | 'signal' | 'message' | 'reset' | 'routing' | 'snapshot';

// ── Module contract ──
interface Handlers {
  continuous?: {
    fixedUpdate?(dt: number): void;
    lateFixedUpdate?(dt: number): void;
    teardown?(): void;
  };
  des?: {
    canAccept?(mu: MU, port?: Port): boolean;
    onAccept?(mu: MU, port?: Port): boolean;
    on?(hook: string, mu: MU | null, data?: unknown): void;
    onDownstreamReady?(port: Port): void;
  };
  /** Path routing hooks (AGV path simulation) — declaring ANY of these makes
   *  this component the project router of the path network (one per model).
   *  Id-based value signatures; called synchronously from the traffic
   *  mechanics, so keep them cheap and DETERMINISTIC (the look-ahead walks
   *  re-ask the same decision). */
  routing?: {
    /** Pick the next path id at a junction. Return one of \`candidateIds\`;
     *  anything else falls back to the default route (\`candidateIds[0]\`). */
    selectNextPath?(candidateIds: string[], ctx: RouteContext): string | void;
    /** A traveler completed a path (forward hand-off or dead-end stop). */
    onArrive?(pathId: string, travelerId: string): void;
    /** A traveler idles at a dead end (path end without successor) —
     *  the dispatch trigger for project fleet logic. */
    requestDispatch?(travelerId: string): void;
  };
  onSignal?(name: string, value: boolean | number): void;
  onReset?(): void;
  /** Message receiver for \`component(path).send\` / \`broadcast\` — delivered
   *  through this component's event list (deterministic in both kernels). */
  onMessage?(topic: string, data: unknown, fromPath: string): void;
  /** StopOnExit arrival (plan-259): an MU stopped at a connected sensor is
   *  handed over as a reference. The MU is ALREADY held — process it
   *  (\`self.in(ProcessTime, 'done', mu)\`) and free it with \`mu.release()\`. */
  onArrival?(mu: MU): void;
  /** Custom-connection request receiver (plan-259): answer now or later
   *  through the deferred \`reply(response)\` handle (exactly once). */
  onRequest?(topic: string, params: { [k: string]: unknown }, reply: (response?: { [k: string]: unknown }) => void): void;
  /** DES snapshot hook (plan-261): return a JSON-serializable value holding
   *  the free closure state that the engine cannot see. MUST be synchronous. */
  onSnapshot?(): unknown;
  /** DES restore hook (plan-261): re-inject the value \`onSnapshot()\` returned.
   *  Runs AFTER the seeded RNG position and the FSM state are restored.
   *  Pending timers do NOT survive — re-arm them here. MUST be synchronous. */
  onRestore?(state: unknown): void;
  /** Soft error layer: called when another handler of THIS component throws.
   *  Return \`true\` = handled, keep running; otherwise the default applies
   *  (first-tick failure disables the component, later failures log). */
  onError?(err: unknown, phase: ErrorPhase): boolean | void;
}

/** The script declares a GLOBAL setup function (plan-210 phase-0 contract). */
type SetupFn = (self: Self) => Handlers | void;
`;
}
