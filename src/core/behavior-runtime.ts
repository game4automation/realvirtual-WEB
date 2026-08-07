// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * behavior-runtime — single low-level core for the Component Behaviors API.
 *
 * Writes Drive / TransportSurface / Sensor / Snap / Signal / AASLink / companion
 * behavior-component configuration into `node.userData.realvirtual` (the runtime
 * form of `rv_extras` embedded in GLBs).
 *
 * All three configuration paths (Behavior file, Naming-Convention, Sidecar-JSON)
 * funnel through `applyKinematicsSpec()` and `createBindContext()`. The bind
 * context exposes a chainable, fluent API (`rv.drive(...).transport(...)...`)
 * and tracks all hooks/subscriptions for centralized auto-dispose when the
 * model is cleared.
 *
 * Defensive parsing throughout: missing nodes log a warning by default and
 * throw only in `strict: true` mode. Deep-merge by default preserves existing
 * user-authored values; `overwrite: true` reverses that.
 */

import type { Object3D } from 'three';
import type { SignalWriter, SignalWriterKind } from './engine/rv-signal-store';
import type { ContextMenuItem } from './hmi/context-menu-store';
import type { StatisticsManager } from './material-flow/rv-statistics-manager';
import { getSchemaDefaults } from './engine/rv-component-registry';
import { instanceScope, scopeSignalName } from './engine/rv-instance-scope';

// ─── Public Types ───────────────────────────────────────────────────────

export type DirectionEnum =
  | 'LinearX' | 'LinearY' | 'LinearZ'
  | 'RotationX' | 'RotationY' | 'RotationZ';

/** ±-axis shorthand for transport directions (e.g. '+X', '-Z'). */
export type AxisCode = `${'+' | '-'}${'X' | 'Y' | 'Z'}`;

/** Snap direction codes — axis (X/Y/Z) + sign (N/P). */
export type SnapDir = 'XN' | 'XP' | 'YN' | 'YP' | 'ZN' | 'ZP';

/**
 * A node reference: a name, slash-separated path, or direct Object3D.
 * Any string containing '/' is treated as a path; everything else is a name.
 */
export type NodeRef = string | { path: string } | Object3D;

export type SignalType =
  | 'PLCInputBool'  | 'PLCOutputBool'
  | 'PLCInputFloat' | 'PLCOutputFloat'
  | 'PLCInputInt'   | 'PLCOutputInt';

export interface DriveOpts {
  speed?: number;
  acceleration?: number;
  reverseDirection?: boolean;
  startPosition?: number;
  offset?: number;
  useLimits?: boolean;
  lowerLimit?: number;
  upperLimit?: number;
  extra?: Record<string, unknown>;
  overwrite?: boolean;
}

export interface TransportOpts {
  speed?: number;
  drive?: NodeRef;
  extra?: Record<string, unknown>;
  overwrite?: boolean;
}

export interface SensorOpts {
  size?: [number, number, number];
  extra?: Record<string, unknown>;
  overwrite?: boolean;
}

export interface SignalOpts {
  type: SignalType;
  drive?: NodeRef;
  binding?: string;
  initialValue?: boolean | number;
  overwrite?: boolean;
}

export interface AasLinkOpts {
  tab?: 'Nameplate' | 'TechnicalData' | 'Documents';
  idShort?: string;
  description?: string;
  serverUrl?: string;
  overwrite?: boolean;
}

/**
 * Key under which behavior-declared signals are accumulated on the root node's
 * `userData.realvirtual`. The scene-loader picks them up post-load and
 * registers them in the SignalStore. Prefixed with `__` to mark it as an
 * internal contract, not part of the public rv_extras schema.
 */
export const BEHAVIOR_SIGNALS_KEY = '__BehaviorSignals';

/** Spec-form (equivalent to bind callback). Used by sidecar JSON and Naming-Convention loader. */
export interface KinematicsSpec {
  drives?: ({ target: NodeRef; direction?: DirectionEnum } & DriveOpts)[];
  transports?: ({ target: NodeRef; direction?: AxisCode | [number, number, number] } & TransportOpts)[];
  sensors?: ({ target: NodeRef } & SensorOpts)[];
  snaps?: { target: NodeRef; direction: SnapDir; typeId: string }[];
  signals?: ({ name: string } & SignalOpts)[];
  aasLinks?: ({ target: NodeRef; aasxFile: string } & AasLinkOpts)[];
  /** Companion components on a node — Drive_Simple, Drive_Erratic, Sensor signal bindings, etc.
   *  Written directly to `userData.realvirtual[type]` after deep-merge. */
  behaviors?: { target: NodeRef; type: string; props: Record<string, unknown>; overwrite?: boolean }[];
  overwrite?: boolean;
  strict?: boolean;
}

export interface KinematizeReport {
  applied: {
    drives: number;
    transports: number;
    sensors: number;
    snaps: number;
    signals: number;
    aasLinks: number;
    behaviors: number;
  };
  warnings: string[];
}

// ─── Helpers ────────────────────────────────────────────────────────────

/** Build a slash-separated path from a node up to (but excluding) the given root. */
export function nodePathFromRoot(node: Object3D, root: Object3D): string {
  const parts: string[] = [];
  let cur: Object3D | null = node;
  while (cur && cur !== root) {
    parts.unshift(cur.name);
    cur = cur.parent;
  }
  return parts.join('/');
}

/**
 * Resolve a NodeRef against a root subtree.
 *
 * Lookup rules:
 *   - Object3D ref → returned as-is.
 *   - String ref / `{ path }` containing `/` → walk segments from root.
 *   - String ref without `/` → exact match against `root` first, then
 *     breadth-first scan for a descendant with that name.
 */
export function resolveNode(root: Object3D, ref: NodeRef): Object3D | null {
  if (!ref) return null;
  if (typeof ref === 'object' && 'isObject3D' in ref) return ref as Object3D;
  const str = typeof ref === 'string' ? ref : (ref as { path: string }).path;
  if (!str) return null;

  if (str.includes('/')) {
    const segments = str.split('/').filter(s => s.length > 0);
    if (segments.length === 0) return null;
    // Allow root.name as optional first segment
    let cur: Object3D | null = root;
    let start = 0;
    if (root.name === segments[0]) start = 1;
    for (let i = start; i < segments.length; i++) {
      if (!cur) return null;
      const next: Object3D | undefined = cur.children.find(c => c.name === segments[i]);
      if (!next) return null;
      cur = next;
    }
    return cur ?? null;
  }

  // Plain name — BFS scan
  if (root.name === str) return root;
  const queue: Object3D[] = [...root.children];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (node.name === str) return node;
    queue.push(...node.children);
  }
  return null;
}

/** Ensure `userData.realvirtual` exists and return it. */
export function ensureExtras(node: Object3D): Record<string, unknown> {
  if (!node.userData) node.userData = {};
  const ud = node.userData as Record<string, unknown>;
  let rv = ud.realvirtual as Record<string, unknown> | undefined;
  if (!rv) {
    rv = {};
    ud.realvirtual = rv;
  }
  return rv;
}

/** Convert an AxisCode ('+X', '-Z', ...) to a normalized [x,y,z] direction vector. */
export function axisCodeToVector(code: AxisCode): [number, number, number] {
  const sign = code[0] === '-' ? -1 : 1;
  const axis = code[1] as 'X' | 'Y' | 'Z';
  if (axis === 'X') return [sign, 0, 0];
  if (axis === 'Y') return [0, sign, 0];
  return [0, 0, sign];
}

/**
 * Deep-merge `patch` into `target`. Plain objects merge recursively; arrays
 * and primitives are replaced wholesale. When `overwrite` is true, every
 * field in `patch` overwrites the corresponding field in `target`.
 *
 * Returns the (mutated) target for convenience.
 */
export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  patch: Record<string, unknown>,
  overwrite: boolean,
): T {
  for (const key of Object.keys(patch)) {
    const pv = patch[key];
    if (pv === undefined) continue;
    const tv = (target as Record<string, unknown>)[key];
    if (
      pv !== null && typeof pv === 'object' && !Array.isArray(pv) &&
      tv !== null && typeof tv === 'object' && !Array.isArray(tv)
    ) {
      deepMerge(tv as Record<string, unknown>, pv as Record<string, unknown>, overwrite);
    } else if (overwrite || tv === undefined) {
      (target as Record<string, unknown>)[key] = pv;
    }
    // else: keep existing tv (deep-merge default)
  }
  return target;
}

// ─── Field projection: opts → rv_extras shape ───────────────────────────

interface DriveFields {
  Direction?: DirectionEnum;
  TargetSpeed?: number;
  Acceleration?: number;
  ReverseDirection?: boolean;
  StartPosition?: number;
  Offset?: number;
  UseLimits?: boolean;
  LowerLimit?: number;
  UpperLimit?: number;
  [k: string]: unknown;
}

function buildDriveFields(direction: DirectionEnum | undefined, opts: DriveOpts | undefined): DriveFields {
  const f: DriveFields = {};
  if (direction !== undefined) f.Direction = direction;
  if (opts?.speed !== undefined) f.TargetSpeed = opts.speed;
  if (opts?.acceleration !== undefined) {
    f.Acceleration = opts.acceleration;
    f.UseAcceleration = true;
  }
  if (opts?.reverseDirection !== undefined) f.ReverseDirection = opts.reverseDirection;
  if (opts?.startPosition !== undefined) f.StartPosition = opts.startPosition;
  if (opts?.offset !== undefined) f.Offset = opts.offset;
  if (opts?.useLimits !== undefined) f.UseLimits = opts.useLimits;
  if (opts?.lowerLimit !== undefined) f.LowerLimit = opts.lowerLimit;
  if (opts?.upperLimit !== undefined) f.UpperLimit = opts.upperLimit;
  if (opts?.extra) Object.assign(f, opts.extra);
  return f;
}

/**
 * Fields written into `rv_extras.TransportSurface`. Must match
 * {@link RVTransportSurface.schema}:
 *
 *  - `TransportDirection` is a `vector3` field with `unityCoords: true`,
 *    so the loader negates X on the way in. To compensate we pre-negate
 *    X when serialising a glTF-space direction, so the consumed value
 *    matches the intended axis.
 *  - The Drive that powers the surface is resolved at runtime by
 *    `RVTransportSurface.init` via `registry.findInParent('Drive')` — we
 *    no longer write an explicit drive-reference field. Callers wanting
 *    a non-ancestor drive should put the Drive on the same node as the
 *    Transport or use the legacy explicit ref via `extra`.
 */
interface TransportFields {
  TransportDirection?: { x: number; y: number; z: number };
  TargetSpeed?: number;
  [k: string]: unknown;
}

function buildTransportFields(
  direction: AxisCode | [number, number, number] | undefined,
  opts: TransportOpts | undefined,
  _driveRefPath: string | undefined,
): TransportFields {
  const f: TransportFields = {};
  if (direction !== undefined) {
    const v = Array.isArray(direction) ? direction : axisCodeToVector(direction);
    // Compensate for `unityCoords: true` X-flip on the schema side.
    f.TransportDirection = { x: -v[0], y: v[1], z: v[2] };
  }
  if (opts?.speed !== undefined) f.TargetSpeed = opts.speed;
  if (opts?.extra) Object.assign(f, opts.extra);
  return f;
}

// ─── Spec Application ───────────────────────────────────────────────────

interface WarnSink {
  warnings: string[];
  strict: boolean;
}

function warnOrThrow(sink: WarnSink, msg: string): void {
  if (sink.strict) throw new Error(msg);
  sink.warnings.push(msg);
  console.warn('[kinematize] ' + msg);
}

function refDesc(ref: NodeRef): string {
  if (typeof ref === 'string') return ref;
  if (typeof ref === 'object' && 'isObject3D' in ref) return (ref as Object3D).name || '<unnamed>';
  return (ref as { path?: string })?.path ?? '<?>';
}

/**
 * Apply a KinematicsSpec to a root subtree.
 *
 * Deep-merges into existing `userData.realvirtual` unless `spec.overwrite`
 * (global) or `entry.overwrite` (per-entry) is true.
 *
 * NOTE: This writes the rv_extras shape only. Component construction (the
 * RVDrive / RVSensor / RVTransportSurface instances) happens AFTER, in the
 * scene-loader; or — for the Behavior path — the bind callback is invoked
 * AFTER components have already been constructed, in which case writes here
 * affect future loads but do not retro-construct components on the current
 * model. Behavior-time mutations therefore typically target field tuning
 * via direct drive references (e.g. `rv.drives.get(...)`).
 */
export function applyKinematicsSpec(
  root: Object3D,
  spec: KinematicsSpec,
): KinematizeReport {
  const report: KinematizeReport = {
    applied: { drives: 0, transports: 0, sensors: 0, snaps: 0, signals: 0, aasLinks: 0, behaviors: 0 },
    warnings: [],
  };
  const sink: WarnSink = { warnings: report.warnings, strict: !!spec.strict };
  const globalOverwrite = !!spec.overwrite;

  // Per-call NodeRef cache: avoids repeated O(N) BFS scans when the same node
  // is referenced by multiple spec entries (drives, transports, signals, etc.).
  const lookupCache = new Map<unknown, Object3D | null>();
  const lookup = (ref: NodeRef): Object3D | null => {
    if (typeof ref === 'object' && ref !== null && 'isObject3D' in ref) return ref as Object3D;
    const key = typeof ref === 'string' ? ref : (ref as { path?: string })?.path ?? ref;
    const cached = lookupCache.get(key);
    if (cached !== undefined) return cached;
    const node = resolveNode(root, ref);
    lookupCache.set(key, node);
    return node;
  };

  // Editable Drive defaults, resolved once (schema is registered at import).
  const driveDefaults = getSchemaDefaults('Drive');

  // Drives
  for (const entry of spec.drives ?? []) {
    const node = lookup(entry.target);
    if (!node) {
      warnOrThrow(sink, `Drive: target not found: ${refDesc(entry.target)}`);
      continue;
    }
    const extras = ensureExtras(node);
    const overwrite = globalOverwrite || !!entry.overwrite;
    const fields = buildDriveFields(entry.direction, entry);
    if (Object.keys(fields).length === 0) continue;
    const cur = (extras.Drive as Record<string, unknown> | undefined) ?? {};
    deepMerge(cur, fields as Record<string, unknown>, overwrite);
    // Seed the full editable Drive schema so a synthesized drive (e.g. from a
    // `Drive-Lin-Z` name) exposes the same inspector fields as an authored
    // Drive component. Only fills MISSING keys — authored extras and explicit
    // spec opts are never overwritten.
    for (const [k, dv] of Object.entries(driveDefaults)) {
      if (cur[k] === undefined) cur[k] = dv;
    }
    extras.Drive = cur;
    report.applied.drives++;
  }

  // Transports
  for (const entry of spec.transports ?? []) {
    const node = lookup(entry.target);
    if (!node) {
      warnOrThrow(sink, `Transport: target not found: ${refDesc(entry.target)}`);
      continue;
    }
    const extras = ensureExtras(node);
    const overwrite = globalOverwrite || !!entry.overwrite;
    let driveRefPath: string | undefined;
    if (entry.drive) {
      const dn = lookup(entry.drive);
      if (!dn) {
        warnOrThrow(sink, `Transport: drive ref not found: ${refDesc(entry.drive)}`);
      } else {
        driveRefPath = nodePathFromRoot(dn, root);
      }
    }
    const fields = buildTransportFields(entry.direction, entry, driveRefPath);
    if (Object.keys(fields).length === 0) continue;
    const cur = (extras.TransportSurface as Record<string, unknown> | undefined) ?? {};
    deepMerge(cur, fields as Record<string, unknown>, overwrite);
    extras.TransportSurface = cur;
    report.applied.transports++;
  }

  // Sensors
  for (const entry of spec.sensors ?? []) {
    const node = lookup(entry.target);
    if (!node) {
      warnOrThrow(sink, `Sensor: target not found: ${refDesc(entry.target)}`);
      continue;
    }
    const extras = ensureExtras(node);
    const overwrite = globalOverwrite || !!entry.overwrite;
    const fields: Record<string, unknown> = {};
    if (entry.size) fields.Size = [...entry.size];
    if (entry.extra) Object.assign(fields, entry.extra);
    if (Object.keys(fields).length === 0) {
      // Still mark the sensor presence (idempotent if already present).
      if (!extras.Sensor) extras.Sensor = {};
      report.applied.sensors++;
      continue;
    }
    const cur = (extras.Sensor as Record<string, unknown> | undefined) ?? {};
    deepMerge(cur, fields, overwrite);
    extras.Sensor = cur;
    report.applied.sensors++;
  }

  // Snaps — write into the existing Snap-<DIR>-<TYPEID> naming convention
  // (the snap-point plugin reads the name only). We also stash a small
  // rv_extras.Snap record for inspector visibility / round-trip.
  for (const entry of spec.snaps ?? []) {
    const node = lookup(entry.target);
    if (!node) {
      warnOrThrow(sink, `Snap: target not found: ${refDesc(entry.target)}`);
      continue;
    }
    const extras = ensureExtras(node);
    const overwrite = globalOverwrite;
    const fields = { Direction: entry.direction, TypeId: entry.typeId };
    const cur = (extras.Snap as Record<string, unknown> | undefined) ?? {};
    deepMerge(cur, fields as Record<string, unknown>, overwrite);
    extras.Snap = cur;
    report.applied.snaps++;
  }

  // Signals — accumulate on the root node under BEHAVIOR_SIGNALS_KEY so the
  // viewer's signal store can register them post-load. The shape mirrors the
  // PLC schema (one record per signal name).
  if (spec.signals && spec.signals.length > 0) {
    const extras = ensureExtras(root);
    const sigList = ((extras[BEHAVIOR_SIGNALS_KEY] as Record<string, unknown>[] | undefined) ?? []);
    for (const entry of spec.signals) {
      let driveRefPath: string | undefined;
      if (entry.drive) {
        const dn = lookup(entry.drive);
        if (dn) driveRefPath = nodePathFromRoot(dn, root);
      }
      sigList.push({
        Name: entry.name,
        Type: entry.type,
        Drive: driveRefPath,
        Binding: entry.binding,
        InitialValue: entry.initialValue,
      });
      report.applied.signals++;
    }
    extras[BEHAVIOR_SIGNALS_KEY] = sigList;
  }

  // AAS links
  for (const entry of spec.aasLinks ?? []) {
    const node = lookup(entry.target);
    if (!node) {
      warnOrThrow(sink, `AASLink: target not found: ${refDesc(entry.target)}`);
      continue;
    }
    const extras = ensureExtras(node);
    const overwrite = globalOverwrite || !!entry.overwrite;
    const fields: Record<string, unknown> = { AASxFile: entry.aasxFile };
    if (entry.tab !== undefined) fields.Tab = entry.tab;
    if (entry.idShort !== undefined) fields.IdShort = entry.idShort;
    if (entry.description !== undefined) fields.Description = entry.description;
    if (entry.serverUrl !== undefined) fields.ServerUrl = entry.serverUrl;
    const cur = (extras.AASLink as Record<string, unknown> | undefined) ?? {};
    deepMerge(cur, fields, overwrite);
    extras.AASLink = cur;
    report.applied.aasLinks++;
  }

  // Companion behavior components — written directly to userData.realvirtual[type]
  // so the scene-loader's component factories pick them up unchanged.
  for (const entry of spec.behaviors ?? []) {
    const node = lookup(entry.target);
    if (!node) {
      warnOrThrow(sink, `Behavior '${entry.type}': target not found: ${refDesc(entry.target)}`);
      continue;
    }
    const extras = ensureExtras(node);
    const overwrite = globalOverwrite || !!entry.overwrite;
    const cur = (extras[entry.type] as Record<string, unknown> | undefined) ?? {};
    deepMerge(cur, entry.props, overwrite);
    extras[entry.type] = cur;
    report.applied.behaviors++;
  }

  return report;
}

// ─── Bind Context — fluent code-style API ───────────────────────────────

/**
 * Minimal viewer surface the bind context depends on. Defined here as a
 * narrow interface so kinematize.ts does not depend on rv-viewer.ts
 * directly (avoids circular imports — RVViewer imports kinematize).
 */
export interface BindContextHost {
  signalStore: {
    get(name: string): boolean | number | undefined;
    set(name: string, value: boolean | number): void;
    createWriter?(
      writerId: string,
      writerKind: SignalWriterKind,
    ): SignalWriter;
    subscribe(name: string, cb: (value: boolean | number) => void): () => void;
    /** Optional: register a signal with initialValue + PLC type. The BehaviorManager
     *  calls this after applying a bind's KinematicsSpec so behavior-declared signals
     *  (which are written to extras AFTER the load-time signal-construction pass)
     *  are present in the store before the first onFixedUpdate tick. RVViewer.signalStore
     *  implements it; minimal/test hosts can omit it and the manager falls back to set(). */
    register?(name: string, path: string, initialValue: boolean | number, plcType?: string): void;
    /** Optional: rebuild the path→name suffix index. Called once after the
     *  BehaviorManager materialises synthetic signal nodes so a short-name
     *  `getByPath` resolves against the new node paths (F4). Test/minimal hosts
     *  may omit it. */
    buildIndex?(): void;
  } | null;
  simulationLoop?: {
    onFixedUpdateExtra?: ((dt: number) => void) | null;
  };
  on(event: string, cb: (...args: unknown[]) => void): () => void;
  contextMenu: {
    register(reg: { pluginId: string; items: ContextMenuItem[] }): void;
    unregister(pluginId: string): void;
  };
  drives: Array<{ name: string; node: Object3D; startMove?: (d?: number) => void; stop?: () => void; jogForward?: boolean; jogBackward?: boolean; TargetSpeed?: number; currentPosition?: number; isAtTarget?: boolean }>;
  registry?: {
    getNode?(path: string): Object3D | null;
    /** Optional write surface — used by the BehaviorManager to materialise
     *  synthetic signal nodes into the NodeRegistry so `self.signal()` signals
     *  appear in the hierarchy identically to rv_extras signal nodes (F4).
     *  All optional, so read-only / `registry: null` hosts stay valid. */
    registerNode?(path: string, node: Object3D): void;
    register?(type: string, path: string, data: unknown): void;
    getPathForNode?(node: Object3D): string | null;
    unregisterSubtree?(root: Object3D): unknown;
  } | null;
  /** Access another plugin by id (e.g. 'snap-point') — implemented by RVViewer.
   *  Lets behaviors query cross-cutting registries like the snap-point graph. */
  getPlugin?(id: string): unknown;
  /**
   * Plan 201 (E2) — authoritative simulation clock in seconds. RVViewer provides
   * it (`get simTime`); minimal/test hosts may omit it (treated as 0). Read by the
   * per-component `StateStatistics` (`clockFn = () => host.simTime ?? 0`).
   */
  readonly simTime?: number;
  /**
   * Plan 201 (Phase 3) — per-component statistics registry. RVViewer provides a
   * shared `StatisticsManager`; minimal/test hosts may omit it (then no stats are
   * collected). The continuous bind path registers each component's accumulator here.
   */
  statisticsManager?: StatisticsManager | null;
}

/** Minimal drive interface the context exposes (subset of RVDrive). */
export interface BindContextDrive {
  name: string;
  node: Object3D;
  TargetSpeed: number;
  jogForward: boolean;
  jogBackward: boolean;
  /** Live position in mm or deg — populated by the runtime from RVDrive.currentPosition. */
  readonly currentPosition?: number;
  /** True when the drive has reached its commanded `targetPosition` (within ε). */
  readonly isAtTarget?: boolean;
  startMove(destination?: number): void;
  stop(): void;
  moveTo(destination: number): void;
  jog(forward: boolean): void;
}

export interface RVBindContext {
  readonly root: Object3D;
  readonly viewer: BindContextHost;

  // Kinematics — with direction OR opts-only (tune-existing)
  drive(target: NodeRef, direction: DirectionEnum, opts?: DriveOpts): RVBindContext;
  drive(target: NodeRef, opts: DriveOpts): RVBindContext;
  transport(target: NodeRef, direction: AxisCode | [number, number, number], opts?: TransportOpts): RVBindContext;
  transport(target: NodeRef, opts: TransportOpts): RVBindContext;
  sensor(target: NodeRef, opts?: SensorOpts): RVBindContext;
  snap(target: NodeRef, direction: SnapDir, typeId: string): RVBindContext;

  // Signals
  signal(name: string, opts: SignalOpts): RVBindContext;
  readonly signals: {
    get<T = unknown>(name: string): T;
    set(name: string, value: boolean | number): void;
    on(name: string, cb: (value: boolean | number) => void): void;
  };

  // Hooks
  /** Runs every fixed sim tick (60 Hz). Auto-disposed on model-cleared. */
  onFixedUpdate(cb: (dt: number) => void): void;
  /** Subscribe to any viewer event. Auto-disposed on model-cleared. */
  on(event: string, cb: (...args: unknown[]) => void): void;
  /** Fires whenever the simulation transitions to paused (any reason). */
  onPause(cb: (reason: string) => void): void;
  /** Fires whenever the simulation transitions from paused to running. */
  onResume(cb: () => void): void;
  /** Fires on `resetSimulation()` phase 1 — restore internal state to the start
   *  (FSM, counters, timers, bookkeeping). Auto-disposed on model-cleared. */
  onReset(cb: () => void): void;
  /** Fires on `resetSimulation()` phase 3 — (re)start from the clean state after
   *  a reset (e.g. re-assert `Run = true`). Auto-disposed on model-cleared. */
  onStart(cb: () => void): void;
  /** Fires on a statistics reset (`'simulation-resetstat'`) — clear stat
   *  accumulators only (DES). Auto-disposed on model-cleared. */
  onResetStat(cb: () => void): void;
  /** Runs immediately before all subscriptions are auto-disposed (on model-cleared). Use for user-managed cleanup that isn't tracked by the context. */
  onDispose(cb: () => void): void;

  // AAS
  aas(target: NodeRef, aasxFile: string, opts?: AasLinkOpts): RVBindContext;

  /**
   * Attach a companion behavior component (e.g. `Drive_Simple`, `Drive_Erratic`,
   * `Drive_Cylinder`, future component types) to a node. `props` is written
   * directly under `userData.realvirtual[type]` so the existing component
   * factory picks it up unchanged. Use this for any signal-to-property
   * binding or behavior config that isn't covered by the primary `drive` /
   * `transport` / `sensor` methods.
   *
   * Examples:
   *   rv.behavior('Axis1', 'Drive_Simple',  { Forward: 'PLC.X.Fwd', Backward: 'PLC.X.Bwd' });
   *   rv.behavior('Axis1', 'Drive_Erratic', { SignalEnable: 'PLC.X.Enable' });
   *   rv.behavior('Photoeye', 'Sensor',     { SensorOccupied: 'PLC.X.Eye' });
   */
  behavior(target: NodeRef, type: string, props: Record<string, unknown>, opts?: { overwrite?: boolean }): RVBindContext;

  // Context menu
  contextMenu(target: NodeRef, items: ContextMenuItem[], opts?: { includeChildren?: boolean }): RVBindContext;

  // Navigation helpers
  find(name: string): Object3D | null;
  path(...segments: string[]): Object3D | null;
  readonly drives: { get(target: NodeRef): BindContextDrive | null };
}

/** Internal interface for tracking subscriptions per context. */
export interface BindContextHandle {
  dispose(): void;
  spec: KinematicsSpec;
}

interface ContextInternals {
  root: Object3D;
  host: BindContextHost;
  spec: KinematicsSpec;
  /** Bag of unsubscribe functions to invoke on dispose. */
  unsubs: Array<() => void>;
  /** Per-context context-menu plugin id (used for unregister). */
  menuPluginId: string;
  /** Per-context onFixedUpdate callbacks (registered with the sim loop). */
  fixedUpdateCallbacks: Set<(dt: number) => void>;
  disposed: boolean;
}

/** Monotonic counter for unique context-menu pluginIds per bind context. */
let _bindCounter = 0;

/**
 * Create a fluent bind context. Returns the context (chainable surface) and
 * a `_handle` to dispose all tracked subscriptions when the model is
 * cleared. The handle is exported via {@link createBindContext} return shape.
 *
 * Spec mutations accumulate on `accum`; the caller is responsible for
 * passing the accumulated spec to `applyKinematicsSpec()` once the bind
 * callback has finished.
 */
export function createBindContext(
  root: Object3D,
  host: BindContextHost,
  accum: KinematicsSpec,
): { ctx: RVBindContext; handle: BindContextHandle } {
  accum.drives ??= [];
  accum.transports ??= [];
  accum.sensors ??= [];
  accum.snaps ??= [];
  accum.signals ??= [];
  accum.aasLinks ??= [];
  accum.behaviors ??= [];

  const internals: ContextInternals = {
    root,
    host,
    spec: accum,
    unsubs: [],
    menuPluginId: `__bind_menu_${++_bindCounter}`,
    fixedUpdateCallbacks: new Set(),
    disposed: false,
  };

  const findDrive = (target: NodeRef): BindContextDrive | null => {
    const node = resolveNode(root, target);
    if (!node) return null;
    // Node identity wins (unique). The name fallback is only for when the
    // resolved node isn't itself in the drive list — without the node-first
    // pass, two placed instances whose drives share a name (e.g. 'Transport-X')
    // would both match the FIRST same-named drive.
    const drv = host.drives.find(d => d.node === node) ?? host.drives.find(d => d.name === node.name);
    if (!drv) return null;
    const d = drv as BindContextDrive;
    if (typeof d.moveTo !== 'function') {
      d.moveTo = function (destination: number) { this.startMove(destination); };
    }
    if (typeof d.jog !== 'function') {
      d.jog = function (forward: boolean) {
        if (forward) { this.jogForward = true; this.jogBackward = false; }
        else { this.jogBackward = true; this.jogForward = false; }
      };
    }
    return d;
  };

  // Per-instance signal scoping: behaviors bound to a placed LayoutObject get
  // their signal names prefixed with the LayoutObject root name, so multiple
  // placements of the same asset don't collide. Standalone (no LayoutObject
  // ancestor) → empty scope → names unchanged. See rv-instance-scope.ts.
  const signalScope = instanceScope(root);
  const sn = (name: string): string => scopeSignalName(signalScope, name);
  const signalWriter = host.signalStore
    ? host.signalStore.createWriter?.(
        `behavior:${signalScope || root.name || 'root'}`,
        'behavior',
      ) ?? { set: host.signalStore.set.bind(host.signalStore) }
    : null;

  const ctx: RVBindContext = {
    root,
    viewer: host,

    drive(target: NodeRef, a?: DirectionEnum | DriveOpts, b?: DriveOpts): RVBindContext {
      // Overload resolution
      let direction: DirectionEnum | undefined;
      let opts: DriveOpts | undefined;
      if (typeof a === 'string') {
        direction = a;
        opts = b;
      } else {
        opts = a as DriveOpts | undefined;
      }
      accum.drives!.push({ target, direction, ...(opts ?? {}) });
      return ctx;
    },

    transport(target: NodeRef, a?: AxisCode | [number, number, number] | TransportOpts, b?: TransportOpts): RVBindContext {
      let direction: AxisCode | [number, number, number] | undefined;
      let opts: TransportOpts | undefined;
      if (typeof a === 'string' || Array.isArray(a)) {
        direction = a as AxisCode | [number, number, number];
        opts = b;
      } else {
        opts = a as TransportOpts | undefined;
      }
      accum.transports!.push({ target, direction, ...(opts ?? {}) });
      return ctx;
    },

    sensor(target: NodeRef, opts?: SensorOpts): RVBindContext {
      accum.sensors!.push({ target, ...(opts ?? {}) });
      return ctx;
    },

    snap(target: NodeRef, direction: SnapDir, typeId: string): RVBindContext {
      accum.snaps!.push({ target, direction, typeId });
      return ctx;
    },

    signal(name: string, opts: SignalOpts): RVBindContext {
      accum.signals!.push({ name: sn(name), ...opts });
      return ctx;
    },

    signals: {
      get<T = unknown>(name: string): T {
        const v = host.signalStore?.get(sn(name));
        return v as unknown as T;
      },
      set(name: string, value: boolean | number): void {
        signalWriter?.set(sn(name), value);
      },
      on(name: string, cb: (value: boolean | number) => void): void {
        if (internals.disposed) return;
        const off = host.signalStore?.subscribe(sn(name), cb);
        if (off) internals.unsubs.push(off);
      },
    },

    onFixedUpdate(cb: (dt: number) => void): void {
      if (internals.disposed) return;
      internals.fixedUpdateCallbacks.add(cb);
      internals.unsubs.push(() => internals.fixedUpdateCallbacks.delete(cb));
    },

    on(event: string, cb: (...args: unknown[]) => void): void {
      if (internals.disposed) return;
      const off = host.on(event, cb);
      if (off) internals.unsubs.push(off);
    },

    onPause(cb: (reason: string) => void): void {
      if (internals.disposed) return;
      const handler = (payload: unknown): void => {
        const p = payload as { paused?: boolean; reason?: string } | undefined;
        if (p?.paused === true) cb(p.reason ?? '');
      };
      const off = host.on('simulation-pause-changed', handler);
      if (off) internals.unsubs.push(off);
    },

    onResume(cb: () => void): void {
      if (internals.disposed) return;
      const handler = (payload: unknown): void => {
        const p = payload as { paused?: boolean } | undefined;
        if (p?.paused === false) cb();
      };
      const off = host.on('simulation-pause-changed', handler);
      if (off) internals.unsubs.push(off);
    },

    onReset(cb: () => void): void {
      if (internals.disposed) return;
      const off = host.on('simulation-reset', () => cb());
      if (off) internals.unsubs.push(off);
    },

    onStart(cb: () => void): void {
      if (internals.disposed) return;
      const off = host.on('simulation-start', () => cb());
      if (off) internals.unsubs.push(off);
    },

    onResetStat(cb: () => void): void {
      if (internals.disposed) return;
      const off = host.on('simulation-resetstat', () => cb());
      if (off) internals.unsubs.push(off);
    },

    onDispose(cb: () => void): void {
      if (internals.disposed) return;
      // Push at the FRONT so it runs before signal/fixedUpdate/menu cleanups.
      internals.unsubs.unshift(() => {
        try { cb(); } catch (e) { console.error('[kinematize] onDispose error', e); }
      });
    },

    aas(target: NodeRef, aasxFile: string, opts?: AasLinkOpts): RVBindContext {
      accum.aasLinks!.push({ target, aasxFile, ...(opts ?? {}) });
      return ctx;
    },

    behavior(target: NodeRef, type: string, props: Record<string, unknown>, opts?: { overwrite?: boolean }): RVBindContext {
      (accum.behaviors ??= []).push({ target, type, props, ...(opts ?? {}) });
      return ctx;
    },

    contextMenu(target: NodeRef, items: ContextMenuItem[], opts?: { includeChildren?: boolean }): RVBindContext {
      const node = resolveNode(root, target);
      if (!node) {
        console.warn(`[kinematize] contextMenu: target not found: ${refDesc(target)}`);
        return ctx;
      }
      const includeChildren = !!opts?.includeChildren;
      const matches = (candidate: Object3D): boolean => {
        if (candidate === node) return true;
        if (!includeChildren) return false;
        let p: Object3D | null = candidate;
        while (p) {
          if (p === node) return true;
          p = p.parent;
        }
        return false;
      };
      // Each contextMenu() call uses a unique pluginId so multiple calls
      // can coexist; we track ids on the internals.
      const pluginId = `${internals.menuPluginId}_${accum.aasLinks!.length + accum.drives!.length + Math.random().toString(36).slice(2, 8)}`;
      const wrapped: ContextMenuItem[] = items.map(it => ({
        ...it,
        condition: (target) => {
          if (it.condition && !it.condition(target)) return false;
          return matches(target.node);
        },
      }));
      host.contextMenu.register({ pluginId, items: wrapped });
      internals.unsubs.push(() => host.contextMenu.unregister(pluginId));
      return ctx;
    },

    find(name: string): Object3D | null {
      return resolveNode(root, name);
    },
    path(...segments: string[]): Object3D | null {
      if (segments.length === 0) return null;
      return resolveNode(root, segments.join('/'));
    },
    drives: {
      get(target: NodeRef) {
        return findDrive(target);
      },
    },
  };

  const handle: BindContextHandle = {
    spec: accum,
    dispose(): void {
      if (internals.disposed) return;
      internals.disposed = true;
      for (const off of internals.unsubs) {
        try { off(); } catch (e) { console.error('[kinematize] dispose error', e); }
      }
      internals.unsubs.length = 0;
      internals.fixedUpdateCallbacks.clear();
    },
  };

  // Expose internals so the viewer can fire fixedUpdate callbacks per-tick.
  (handle as unknown as { _internals: ContextInternals })._internals = internals;

  return { ctx, handle };
}

/**
 * Iterate all live fixedUpdate callbacks registered against a handle.
 * Used by the viewer-side glue to forward sim-loop ticks.
 */
export function iterateFixedUpdate(handle: BindContextHandle, dt: number): void {
  const internals = (handle as unknown as { _internals: ContextInternals })._internals;
  if (!internals || internals.disposed) return;
  for (const cb of internals.fixedUpdateCallbacks) {
    try { cb(dt); } catch (e) { console.error('[kinematize] onFixedUpdate error', e); }
  }
}
