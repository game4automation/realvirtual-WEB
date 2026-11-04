// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-planning-component-params — planning parameters that are EXISTING component
 * properties (plan-630 §2.14, Phase 8).
 *
 * No new component, no second parameter definition: the planning window SELECTS a
 * property the component schema already describes (`Source.Interval`, a drive's
 * `TargetSpeed`, later a ScriptComponent's `Values.<key>`), and this module derives the
 * planning declaration of that property from the schema. Type, unit and options come
 * only from the schema; a selection may narrow the range for display (`min/max/step`) and
 * give a label and a group, nothing else.
 *
 * ## One key format (shared with plan-2005 Phase 7 and plan-2003 K1)
 *
 * Owner `component`, owner-local key `a<h>.<Component>.<field>`, where `<h>` is the first
 * {@link COMPONENT_KEY_HASH_HEX} hex characters of SHA-256 over the full NodeRegistry
 * address `<occurrence>#<NodeId>` (plan-769). The hash keeps the key inside the
 * registry's key alphabet (`[A-Za-z0-9_-]` and dots — an address carries `#`, `/`, `|`)
 * and puts the owner split on the first dot. Two placements of the same file are two
 * addresses and therefore two keys. {@link componentParamKey} is the ONLY producer; the
 * declaration carries `target {address, component, field}` so nothing has to invert the
 * hash.
 *
 * ## One writer
 *
 * {@link writeComponentField} is the one function that writes a planning value into a
 * node's `userData.realvirtual[component]` (nested for a dotted field path, never a
 * literal `"Values.x"` key). It is called by the `component` owner's `onStructuralReset`
 * only — at a standstill, followed by the component's re-config path and exactly one
 * runner reset (§2.5a). Nothing else writes planning values into rv_extras.
 *
 * ## Re-config paths
 *
 * A property is selectable only when its component type declares how a written value
 * reaches the running model (`paramApply`): `des-extras` (the DES runner re-reads
 * the extras of its bound instances, `SimDesControl.reconfigureFromExtras`) or `rebuild`
 * (a handler registered with {@link registerComponentRebuild}, plan-2003). Everything else
 * is `planning-selection-unsupported`.
 *
 * Pure: no viewer, no DOM, no Problems store. The viewer side (address → node, schema,
 * re-config capability) comes in through {@link ComponentParamEnv}.
 */

import {
  checkPlanningValue,
  isValidPlanningKey,
  type PlanningParamDef,
  type PlanningParamType,
  type PlanningValue,
} from './rv-planning-params';
import {
  COMPONENT_PLANNING_OWNER,
  PROBLEM_SELECTION_INVALID,
  PROBLEM_SELECTION_UNSUPPORTED,
  isValidComponentFieldPath,
  isValidComponentKey,
  type ComponentParamSelection,
  type ComponentParamTarget,
} from './rv-planning-component-selection';

// The selection half (eager, read with every document) — re-exported so callers have one module.
export {
  COMPONENT_PLANNING_OWNER,
  PROBLEM_SELECTION_INVALID,
  PROBLEM_SELECTION_UNSUPPORTED,
  componentSelectionPayload,
  isComponentSelected,
  isValidComponentFieldPath,
  isValidComponentKey,
  parseComponentSelection,
  sameComponentSelection,
  sameComponentTarget,
  type ComponentParamSelection,
  type ComponentParamTarget,
  type ComponentSelectionParseResult,
} from './rv-planning-component-selection';

// ─── Constants ─────────────────────────────────────────────────────────────

/** Window title of the `component` owner. */
export const COMPONENT_PLANNING_TITLE = 'Components';
/** Default overlay group of a selected property. */
export const COMPONENT_PLANNING_GROUP = 'Components';
/** Hex characters of SHA-256(address) in the key (80 bit). */
export const COMPONENT_KEY_HASH_HEX = 20;


// ─── Types ─────────────────────────────────────────────────────────────────

/** How a written value reaches the running model. */
export type PlanningReconfig = 'des-extras' | 'rebuild';

/** What the schema (or a type resolver) says about one field. */
export interface ComponentParamFieldInfo {
  /** Schema type name: `number`, `integer`, `boolean`, `enum`, … */
  type: string;
  unit?: string;
  enum?: readonly string[];
  default?: unknown;
  readonly?: boolean;
  signal?: string;
  refType?: string;
  deprecated?: boolean;
  description?: string;
}

/**
 * Field info for ONE target — the per-type resolver (plan-2003 K1: the ScriptComponent
 * answers from its instance `Params`). `null` = not a field of this component.
 */
export type ComponentParamResolver = (target: ComponentParamTarget) => ComponentParamFieldInfo | null;

/**
 * Re-reads the written values of one component type (`rebuild`, plan-2003). `signal` is the
 * structural reset's: aborted when the document changes — stop, and touch nothing of the
 * next document.
 */
export type ComponentRebuildHandler = (targets: readonly ComponentParamTarget[], signal: AbortSignal) => void | Promise<void>;

/** The viewer side of the derivation. */
export interface ComponentParamEnv {
  /** Field info from the component schema (used when no type resolver is registered). */
  schemaField(component: string, field: string): ComponentParamFieldInfo | null;
  /** The re-config path for this target; `null` = none. */
  reconfigOf(target: ComponentParamTarget): PlanningReconfig | null;
  /** Does the address resolve to a node right now? */
  resolves(address: string): boolean;
  /** The value the DOCUMENT carries (planning default); `undefined` = field absent. */
  documentValue(target: ComponentParamTarget): unknown;
  /** The current effective value (planning start value, `initial`). */
  currentValue(target: ComponentParamTarget): unknown;
  /** Short display path of the node (`'Line/Source'`). */
  nodeLabel(address: string): string;
}

/** Outcome of {@link deriveComponentParamDef}. */
export type ComponentParamVerdict =
  | { ok: true; key: string; effectiveKey: string; def: PlanningParamDef; reconfig: PlanningReconfig }
  | {
    ok: false;
    /** `unresolved` = the address names no node (yet) — not a finding, the key stays dormant. */
    code: typeof PROBLEM_SELECTION_INVALID | typeof PROBLEM_SELECTION_UNSUPPORTED | 'unresolved';
    message: string;
    key: string | null;
    effectiveKey: string | null;
  };

// ─── SHA-256 (FIPS 180-4), synchronous ─────────────────────────────────────
// `crypto.subtle` is async; the key must be computable inside a synchronous
// declaration. Pinned against node:crypto in planning-component-params.node.test.ts.

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Lowercase hex SHA-256 of the UTF-8 bytes of `text`. */
export function sha256Hex(text: string): string {
  const msg = new TextEncoder().encode(text);
  const bitLen = msg.length * 8;
  const total = ((msg.length + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(total);
  buf.set(msg);
  buf[msg.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(total - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(total - 4, bitLen >>> 0);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K256[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  let out = '';
  for (let i = 0; i < 8; i++) out += h[i].toString(16).padStart(8, '0');
  return out;
}

// ─── Keys ──────────────────────────────────────────────────────────────────

/**
 * THE key of a component property (owner-local): `a<h>.<Component>.<field>`,
 * `h` = first {@link COMPONENT_KEY_HASH_HEX} hex chars of SHA-256(address).
 * `null` when component or field are not usable names (or the address is empty).
 */
export function componentParamKey(address: string, component: string, field: string): string | null {
  if (typeof address !== 'string' || address === '') return null;
  if (!isValidComponentKey(component) || !isValidComponentFieldPath(field)) return null;
  const key = `a${sha256Hex(address).slice(0, COMPONENT_KEY_HASH_HEX)}.${component}.${field}`;
  return isValidPlanningKey(key) ? key : null;
}

/** The effective (registry-wide) key: `component.a<h>.<Component>.<field>`. */
export function componentParamEffectiveKey(address: string, component: string, field: string): string | null {
  const key = componentParamKey(address, component, field);
  return key ? `${COMPONENT_PLANNING_OWNER}.${key}` : null;
}

/** Does an effective key belong to the `component` owner? */
export function isComponentParamEffectiveKey(key: unknown): key is string {
  return typeof key === 'string' && key.startsWith(`${COMPONENT_PLANNING_OWNER}.a`);
}

/** The base component type of a component key (`Drive_1` → `Drive`). */
export function componentBaseType(component: string): string {
  return component.replace(/_\d+$/, '');
}

// ─── Resolver and re-config tables (plan-2003 registers here) ──────────────

const resolvers = new Map<string, ComponentParamResolver>();
const rebuildHandlers = new Map<string, ComponentRebuildHandler>();

/**
 * Registers the field resolver of a component TYPE (plan-2003 K1: the ScriptComponent
 * resolves `Values.<key>` from its instance `Params`). Overwrites; returns the unregister.
 */
export function registerComponentParamResolver(componentType: string, resolver: ComponentParamResolver): () => void {
  resolvers.set(componentType, resolver);
  return () => { if (resolvers.get(componentType) === resolver) resolvers.delete(componentType); };
}

/** The resolver of a component key (exact key first, then its base type). */
export function componentParamResolverOf(component: string): ComponentParamResolver | undefined {
  return resolvers.get(component) ?? resolvers.get(componentBaseType(component));
}

/**
 * Registers what re-reads written values of a `rebuild` component type (plan-2003:
 * `build` of the ScriptComponent). Called by the one writer after it wrote, before the
 * runner reset. Overwrites; returns the unregister.
 */
export function registerComponentRebuild(componentType: string, handler: ComponentRebuildHandler): () => void {
  rebuildHandlers.set(componentType, handler);
  return () => { if (rebuildHandlers.get(componentType) === handler) rebuildHandlers.delete(componentType); };
}

/** The rebuild handler of a component key (exact key first, then its base type). */
export function componentRebuildOf(component: string): ComponentRebuildHandler | undefined {
  return rebuildHandlers.get(component) ?? rebuildHandlers.get(componentBaseType(component));
}

// ─── Derivation ────────────────────────────────────────────────────────────

const PLANNING_TYPES: Readonly<Record<string, PlanningParamType>> = {
  number: 'number', integer: 'integer', boolean: 'boolean', enum: 'enum',
};

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function fail(
  code: typeof PROBLEM_SELECTION_INVALID | typeof PROBLEM_SELECTION_UNSUPPORTED | 'unresolved',
  message: string,
  key: string | null,
): ComponentParamVerdict {
  return { ok: false, code, message, key, effectiveKey: key ? `${COMPONENT_PLANNING_OWNER}.${key}` : null };
}

/** Options of {@link deriveComponentParamDef}. */
export interface DeriveComponentParamOptions {
  /** Not shown in the planning window (experiment factors, plan-2005 Phase 7). */
  hidden?: boolean;
  /** Row order within its group. */
  order?: number;
}

/**
 * The planning declaration of one selected property — or why it cannot be one.
 *
 * Type, unit and options come from the schema (or the type's resolver); `default` is the
 * value the document carries (schema default only when the field is absent), `initial`
 * the current effective value — so declaring never changes a field and never resets
 * anything. `min/max/step` of the selection narrow the range of a numeric field; for
 * other types they are ignored. Always `apply: 'reset'`, role `factor`.
 */
export function deriveComponentParamDef(
  entry: ComponentParamSelection,
  env: ComponentParamEnv,
  opts: DeriveComponentParamOptions = {},
): ComponentParamVerdict {
  const target: ComponentParamTarget = { address: entry.address, component: entry.component, field: entry.field };
  const key = componentParamKey(target.address, target.component, target.field);
  if (!key) {
    return fail(PROBLEM_SELECTION_INVALID,
      `'${String(entry.component)}.${String(entry.field)}' at '${String(entry.address)}' is not a usable component field`, null);
  }
  const where = `${target.component}.${target.field}`;
  if (!env.resolves(target.address)) return fail('unresolved', `no node at '${target.address}'`, key);

  const resolver = componentParamResolverOf(target.component);
  const info = resolver ? resolver(target) : env.schemaField(componentBaseType(target.component), target.field);
  if (!info) return fail(PROBLEM_SELECTION_INVALID, `'${where}' is not a field of '${target.component}'`, key);
  if (info.readonly) return fail(PROBLEM_SELECTION_INVALID, `'${where}' is read-only`, key);
  if (info.signal) return fail(PROBLEM_SELECTION_INVALID, `'${where}' is a signal binding`, key);
  if (info.refType) return fail(PROBLEM_SELECTION_INVALID, `'${where}' is a reference`, key);
  if (info.deprecated) return fail(PROBLEM_SELECTION_INVALID, `'${where}' is deprecated`, key);
  const type = PLANNING_TYPES[info.type];
  if (!type) return fail(PROBLEM_SELECTION_INVALID, `'${where}' is a ${info.type} — only number, integer, boolean and enum fields can be planning parameters`, key);
  if (type === 'enum' && (!info.enum || info.enum.length === 0)) {
    return fail(PROBLEM_SELECTION_INVALID, `'${where}' is an enum without options`, key);
  }

  const reconfig = env.reconfigOf(target);
  if (!reconfig) {
    return fail(PROBLEM_SELECTION_UNSUPPORTED,
      `'${target.component}' has no way to take a changed '${target.field}' over at the structural reset`, key);
  }

  const numeric = type === 'number' || type === 'integer';
  const def: PlanningParamDef = {
    key,
    label: entry.label ?? `${env.nodeLabel(target.address)} · ${target.field}`,
    type,
    default: false, // set below
    group: entry.group ?? COMPONENT_PLANNING_GROUP,
    apply: 'reset',
    role: 'factor',
    target: { address: target.address, component: target.component, field: target.field },
  };
  if (info.unit) def.unit = info.unit;
  if (info.description) def.description = info.description;
  if (type === 'enum') def.options = info.enum!.map((id) => ({ id, label: id }));
  if (numeric) {
    if (entry.min !== undefined) {
      if (!isFiniteNumber(entry.min)) return fail(PROBLEM_SELECTION_INVALID, `min of '${where}' is not a number`, key);
      def.min = entry.min;
    }
    if (entry.max !== undefined) {
      if (!isFiniteNumber(entry.max)) return fail(PROBLEM_SELECTION_INVALID, `max of '${where}' is not a number`, key);
      def.max = entry.max;
    }
    if (def.min !== undefined && def.max !== undefined && def.min > def.max) {
      return fail(PROBLEM_SELECTION_INVALID, `range [${def.min}, ${def.max}] of '${where}' is not an interval`, key);
    }
    if (entry.step !== undefined) {
      if (!isFiniteNumber(entry.step) || entry.step <= 0) return fail(PROBLEM_SELECTION_INVALID, `step of '${where}' is not a positive number`, key);
      def.step = entry.step;
    }
  }
  if (opts.order !== undefined) def.order = opts.order;
  if (opts.hidden) def.ui = { hidden: true };

  const stored = env.documentValue(target);
  const rawDefault = stored !== undefined ? stored : info.default;
  if (rawDefault === undefined) return fail(PROBLEM_SELECTION_INVALID, `'${where}' has neither a stored value nor a schema default`, key);
  const checkedDefault = checkPlanningValue(def, rawDefault);
  if (!checkedDefault.ok) {
    return fail(PROBLEM_SELECTION_INVALID, `stored value of '${where}' does not fit: ${checkedDefault.error}`, key);
  }
  def.default = checkedDefault.value;

  const current = env.currentValue(target);
  if (current !== undefined) {
    const checkedInitial = checkPlanningValue(def, current);
    if (checkedInitial.ok && checkedInitial.value !== def.default) def.initial = checkedInitial.value;
  }
  return { ok: true, key, effectiveKey: `${COMPONENT_PLANNING_OWNER}.${key}`, def, reconfig };
}

// ─── Read / write ──────────────────────────────────────────────────────────
// The one writer moved to `core/params/rv-param-field.ts` (plan-2013 Phase 1):
// `writeComponentField`, `unsetComponentField`, `readComponentField`.
