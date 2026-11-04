// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { bumpModelEditEpoch } from '../engine/rv-model-edit-epoch';
import { isDesRunConfigField } from '../material-flow/des-manager-settings';
/**
 * rv-param-field — one component field as the parameter apply service sees it
 * (plan-2013 §2.3, Phase 1). Lazy: reached only through `import()`.
 *
 * - **Admission** ({@link checkFieldValue}): address-free (Gate R1 #1). A field can carry a
 *   parameter value when its schema type is `number | integer | boolean | enum`, it is not
 *   read-only, not a signal, not a reference, not deprecated, and its component type
 *   declares how a written value reaches the running model (`paramApply`: `des-extras` |
 *   `rebuild`). Rule moved from `deriveComponentParamDef` (plan-630 §2.14).
 * - **The one writer** ({@link writeComponentField}, {@link unsetComponentField}): the
 *   only functions that write a parameter value into `userData.realvirtual[component]`.
 *   `unset` removes a field the document never had (Gate R1 #3) instead of writing a value.
 * - **Base values** ({@link readBaseValue}): `value` | `absent` (schema default applies).
 *   A missing node is not a base value — callers see `null` from the resolver.
 * - **Tables** a component type registers into: field resolvers (plan-2003 `Values.<key>`),
 *   rebuild handlers (structural fields, plan-630 P7 `PalletYard.Size`) and cross-field
 *   validators.
 *
 * Nothing here knows variants or experiments.
 */

/** A value a parameter can take. `string` = an enum option. */
export type ParamValue = number | boolean | string;

/** One field of one component on one node. */
export interface FieldKey {
  /** Full NodeRegistry address (`#<NodeId>` | `<p>#<id>`, plan-769). */
  readonly address: string;
  /** rv_extras key, e.g. `Source`. */
  readonly component: string;
  /** Field name or dotted path (`Values.<key>`). */
  readonly field: string;
}

/** What the apply should make true for one field. `unset` = back to "field absent". */
export type FieldOp = (FieldKey & { readonly op: 'set'; readonly value: ParamValue }) | (FieldKey & { readonly op: 'unset' });

/** The value a field had before anyone wrote a parameter into it. */
export type BaseValue = { readonly kind: 'value'; readonly value: ParamValue } | { readonly kind: 'absent' };

/** How a written value reaches the running model. */
export type ParamApplyPath = 'des-extras' | 'rebuild';

/** What the schema (or a type resolver) says about one field. */
export interface ParamFieldInfo {
  type: string;
  unit?: string;
  enum?: readonly string[];
  default?: unknown;
  readonly?: boolean;
  signal?: string;
  refType?: string;
  deprecated?: boolean;
}

/** Outcome of {@link checkFieldValue}. */
export type FieldVerdict =
  | { ok: true; mode: ParamApplyPath; info: ParamFieldInfo }
  | { ok: false; reason: 'type' | 'readonly' | 'signal' | 'unsupported' | 'out-of-range' | 'locked'; detail: string };

/** The schema side of admission — injectable so the rules stay Node-testable. */
export interface ParamFieldEnv {
  /** Field info of `component.field`, or null when it is not a field of that component. */
  fieldInfo(component: string, field: string): ParamFieldInfo | null;
  /** How a written value of `component.field` reaches the model; null = it does not. */
  applyPathOf(component: string, field: string): ParamApplyPath | null;
}

const VALID_SEGMENT = /^[A-Za-z0-9_-]+$/;  // same alphabet as plan-630's selection keys
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);

/** A usable component key (`Source`, `Drive_1`). */
export function isValidComponentName(component: unknown): component is string {
  return typeof component === 'string' && VALID_SEGMENT.test(component) && !FORBIDDEN.has(component);
}

/** A usable field path (`Interval`, `Values.speed`); never a prototype key. */
export function isValidFieldPath(field: unknown): field is string {
  return typeof field === 'string' && field.length > 0
    && field.split('.').every((s) => VALID_SEGMENT.test(s) && !FORBIDDEN.has(s));
}

/** `Drive_1` → `Drive`. */
export function baseComponentType(component: string): string {
  return component.replace(/_\d+$/, '');
}

/** Stable map key of a {@link FieldKey}. */
export function fieldKeyId(k: FieldKey): string {
  return `${k.address}|${k.component}|${k.field}`;
}

// ─── Registration tables ───────────────────────────────────────────────────

/** Field info for ONE type when its schema does not describe the field (plan-2003 K1). */
export type ParamFieldResolver = (component: string, field: string) => ParamFieldInfo | null;

/** Context of a rebuild handler — runs INSIDE the apply transaction (one reset). */
export interface ParamRebuildContext {
  readonly documentLoadId: string;
  /** Aborted when the document changes — stop and touch nothing of the next document. */
  readonly signal: AbortSignal;
  /** Waits until placements the handler started are materialised. */
  awaitPlacements(): Promise<void>;
}

/** Rebuilds the structure of one component type for the given structural ops. */
export type ParamRebuildHandler = (ops: readonly FieldOp[], ctx: ParamRebuildContext) => Promise<void> | void;

/** Cross-field rule of one component: candidate field values → field → message (empty = fine). */
export type ParamValidator = (candidate: Readonly<Record<string, unknown>>, address: string) => Record<string, string>;

const resolvers = new Map<string, ParamFieldResolver>();
const rebuilds = new Map<string, ParamRebuildHandler>();
const validators = new Map<string, ParamValidator>();

function register<T>(map: Map<string, T>, type: string, v: T): () => void {
  map.set(type, v);
  return () => { if (map.get(type) === v) map.delete(type); };
}
function lookup<T>(map: Map<string, T>, component: string): T | undefined {
  return map.get(component) ?? map.get(baseComponentType(component));
}

/** Registers a field resolver for a component type. Returns the unregister. */
export function registerParamFieldResolver(componentType: string, r: ParamFieldResolver): () => void {
  return register(resolvers, componentType, r);
}
/** Registers the rebuild handler of a structural component type. Returns the unregister. */
export function registerParamRebuild(componentType: string, h: ParamRebuildHandler): () => void {
  return register(rebuilds, componentType, h);
}
/** Registers the cross-field validator of a component type. Returns the unregister. */
export function registerParamValidator(componentType: string, v: ParamValidator): () => void {
  return register(validators, componentType, v);
}
/** The field resolver of a component key (exact, then base type). */
export function paramFieldResolverOf(component: string): ParamFieldResolver | undefined { return lookup(resolvers, component); }
/** The rebuild handler of a component key (exact, then base type). */
export function paramRebuildOf(component: string): ParamRebuildHandler | undefined { return lookup(rebuilds, component); }
/** The validator of a component key (exact, then base type). */
export function paramValidatorOf(component: string): ParamValidator | undefined { return lookup(validators, component); }

// ─── Admission ─────────────────────────────────────────────────────────────

const ADMITTED_TYPES = new Set(['number', 'integer', 'boolean', 'enum']);

/**
 * Address-free check (Gate R1 #1): may `component.field` carry `value`? `value === null`
 * checks only the field (an `unset`). No node is needed — a field on a node a rebuild
 * creates later is checked before the rebuild.
 */
export function checkFieldValue(env: ParamFieldEnv, component: string, field: string, value: ParamValue | null): FieldVerdict {
  const where = `${component}.${field}`;
  if (!isValidComponentName(component) || !isValidFieldPath(field)) {
    return { ok: false, reason: 'unsupported', detail: `'${where}' is not a usable component field` };
  }
  const info = paramFieldResolverOf(component)?.(component, field) ?? env.fieldInfo(component, field);
  if (!info) return { ok: false, reason: 'unsupported', detail: `'${where}' is not a field of '${component}'` };
  if (info.readonly) return { ok: false, reason: 'readonly', detail: `'${where}' is read-only` };
  if (info.signal) return { ok: false, reason: 'signal', detail: `'${where}' is a signal binding` };
  if (info.refType) return { ok: false, reason: 'unsupported', detail: `'${where}' is a reference` };
  if (info.deprecated) return { ok: false, reason: 'unsupported', detail: `'${where}' is deprecated` };
  if (!ADMITTED_TYPES.has(info.type)) {
    return { ok: false, reason: 'type', detail: `'${where}' is a ${info.type} — only number, integer, boolean and enum fields can vary` };
  }
  if (info.type === 'enum' && !(info.enum && info.enum.length > 0)) {
    return { ok: false, reason: 'type', detail: `'${where}' is an enum without options` };
  }
  const mode = env.applyPathOf(component, field);
  if (!mode) return { ok: false, reason: 'unsupported', detail: `'${component}' has no way to take a changed '${field}' over` };
  if (value === null) return { ok: true, mode, info };
  switch (info.type) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, reason: 'type', detail: `'${where}' needs a finite number` };
      break;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) return { ok: false, reason: 'type', detail: `'${where}' needs an integer` };
      break;
    case 'boolean':
      if (typeof value !== 'boolean') return { ok: false, reason: 'type', detail: `'${where}' needs true or false` };
      break;
    case 'enum':
      if (typeof value !== 'string' || !info.enum!.includes(value)) {
        return { ok: false, reason: 'out-of-range', detail: `'${where}' must be one of ${info.enum!.join(', ')}` };
      }
      break;
  }
  return { ok: true, mode, info };
}

// ─── Read / write (the one writer) ─────────────────────────────────────────

/** A node as far as the writer is concerned. */
export interface ComponentFieldHost {
  userData: Record<string, unknown>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The value of `component`/`field` (nested path) on a node; `undefined` when absent. */
export function readComponentField(node: ComponentFieldHost, component: string, field: string): unknown {
  const rv = node.userData?.realvirtual;
  if (!isRecord(rv) || !Object.prototype.hasOwnProperty.call(rv, component)) return undefined;
  let cur: unknown = rv[component];
  for (const seg of field.split('.')) {
    if (!isRecord(cur) || !Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** The base value of a field on a node: a scalar it carries, else `absent`. */
export function readBaseValue(node: ComponentFieldHost, component: string, field: string): BaseValue {
  const v = readComponentField(node, component, field);
  return typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string'
    ? { kind: 'value', value: v }
    : { kind: 'absent' };
}

/**
 * THE writer of a parameter value into a node's rv_extras: creates
 * `userData.realvirtual[component]` and the intermediate objects of a dotted path,
 * writes the leaf. Returns whether the value changed. Throws on an invalid name or a path
 * segment holding a non-object (never overwrites a value with an object).
 */
export function writeComponentField(node: ComponentFieldHost, component: string, field: string, value: ParamValue): boolean {
  if (!isValidComponentName(component) || !isValidFieldPath(field)) {
    throw new Error(`invalid component field '${component}.${field}'`);
  }
  const ud = node.userData as Record<string, unknown>;
  if (!isRecord(ud.realvirtual)) ud.realvirtual = {};
  const rv = ud.realvirtual as Record<string, unknown>;
  if (!isRecord(rv[component])) {
    if (rv[component] !== undefined) throw new Error(`'${component}' on this node is not a component object`);
    rv[component] = {};
  }
  const segs = field.split('.');
  let cur = rv[component] as Record<string, unknown>;
  for (let i = 0; i < segs.length - 1; i++) {
    const next = cur[segs[i]];
    if (next === undefined) cur[segs[i]] = {};
    else if (!isRecord(next)) throw new Error(`'${segs.slice(0, i + 1).join('.')}' of '${component}' is not an object`);
    cur = cur[segs[i]] as Record<string, unknown>;
  }
  const leaf = segs[segs.length - 1];
  if (cur[leaf] === value) return false;
  cur[leaf] = value;
  if (!isDesRunConfigField(component, field)) bumpModelEditEpoch('component-field');
  return true;
}

/**
 * Removes a field (back to "absent", the schema default applies). Prototype-safe: only own
 * properties are touched. Intermediate objects of a dotted path that became empty are
 * removed too; the component object itself stays. Returns whether something was removed.
 */
export function unsetComponentField(node: ComponentFieldHost, component: string, field: string): boolean {
  if (!isValidComponentName(component) || !isValidFieldPath(field)) {
    throw new Error(`invalid component field '${component}.${field}'`);
  }
  const rv = node.userData?.realvirtual;
  if (!isRecord(rv) || !Object.prototype.hasOwnProperty.call(rv, component) || !isRecord(rv[component])) return false;
  const segs = field.split('.');
  const chain: Array<Record<string, unknown>> = [rv[component] as Record<string, unknown>];
  for (let i = 0; i < segs.length - 1; i++) {
    const cur = chain[chain.length - 1];
    if (!Object.prototype.hasOwnProperty.call(cur, segs[i]) || !isRecord(cur[segs[i]])) return false;
    chain.push(cur[segs[i]] as Record<string, unknown>);
  }
  const leafParent = chain[chain.length - 1];
  const leaf = segs[segs.length - 1];
  if (!Object.prototype.hasOwnProperty.call(leafParent, leaf)) return false;
  delete leafParent[leaf];
  if (!isDesRunConfigField(component, field)) bumpModelEditEpoch('component-field');
  for (let i = chain.length - 1; i >= 1; i--) {
    if (Object.keys(chain[i]).length > 0) break;
    delete chain[i - 1][segs[i - 1]];
  }
  return true;
}

/** Applies one op through the one writer. Returns whether the node changed. */
export function writeFieldOp(node: ComponentFieldHost, op: FieldOp): boolean {
  return op.op === 'set'
    ? writeComponentField(node, op.component, op.field, op.value)
    : unsetComponentField(node, op.component, op.field);
}

/** The op that brings a field back to `base`. */
export function restoreOp(k: FieldKey, base: BaseValue): FieldOp {
  return base.kind === 'value'
    ? { address: k.address, component: k.component, field: k.field, op: 'set', value: base.value }
    : { address: k.address, component: k.component, field: k.field, op: 'unset' };
}
