// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-parametric-component.ts — `ParametricComponent` data model (plan-650 Phase 1).
 *
 * A parametric part family: hidden base parts (`_Parts`), a parameter schema
 * (`Params`), the values of the baked variant (`Values`) and a JavaScript rule
 * (`Code`, `generate(values, parts)`). This module only parses, validates and
 * normalizes the rv_extras record and declares the type's capabilities — the
 * generator runtime, the assembly core, the bake step and the inspector are
 * later phases.
 *
 * Wire format: schema/v1/rv-odt.json `$defs.ParametricComponent`
 * (specification.md §7a.67). This file is the executable SSOT of the inner
 * shape of `Params` / `Values`, which the schema loader carries as plain JSON.
 *
 * Parameters are never bound to signals (plan-650 F14): a signal-like parameter
 * type or a signal binding on a parameter definition is a parse error.
 */

import { registerCapabilities, registerInstanceFieldResolver, registerPreBakeHook, type FieldDescriptor } from './rv-component-registry';
import { registerCadProvider } from '../editor/rv-cad-provider';

// ─── Types ───────────────────────────────────────────────────────

/** The rv_extras key of the component. */
export const PARAMETRIC_COMPONENT_TYPE = 'ParametricComponent';

/** Default name of the hidden child that carries the base parts. */
export const DEFAULT_PARTS_ROOT = '_Parts';

/** Default name of the child that carries the baked variant. */
export const DEFAULT_GENERATED_ROOT = '_Generated';

/** The only rule-API contract version defined so far. */
export const PARAMETRIC_API_VERSION = 1;

export type ParamType = 'number' | 'int' | 'bool' | 'enum';
export type ParamUnit = 'mm' | 'deg' | '';
export type ParamValue = number | boolean | string;

/** One entry of `ParametricComponent.Params`. */
export interface ParamDef {
  Name: string;
  Label?: string;
  Type: ParamType;
  Unit?: ParamUnit;
  Min?: number;
  Max?: number;
  Step?: number;
  Enum?: (number | string)[];
  Default: ParamValue;
}

/** `rv_extras.ParametricComponent` on the family node. */
export interface ParametricComponentExtras {
  ApiVersion: 1;
  Params: ParamDef[];
  Values: Record<string, ParamValue>;
  Code: string;
  CodeHash: string;
  PartsRoot?: string;
  GeneratedRoot?: string;
  BakedInputHash?: string;
  DesignResource?: string;
  /**
   * plan-650 Phase 5b (R2-3): the child families this family's rules may
   * place, DECLARED up front so the parent `InputHash` is known before the
   * generator runs. A `children[]` entry naming a family not listed here is
   * refused (`parametric-undeclared-child`). Absent = no children.
   */
  Uses?: ParametricUse[];
}

/** One declared child family (plan-650 Phase 5b). */
export interface ParametricUse {
  /** The key `children[].family` names — the child asset's catalog / project id (`AssetReference.assetId`). */
  Family: string;
  /** NodeId of the family node INSIDE the child asset — the key of the child's `AssetOverrides.byNodeId`. */
  FamilyNodeId: string;
  /** Document hash of the child family; changing the child document changes the parent `InputHash`. */
  DocHash: string;
  /** Optional relative path fallback (`AssetReference.path`); never for a project document (plan-780 R4). */
  Path?: string;
  /** plan-780 R4: qualifier when the child is another project's document. */
  ProviderId?: string;
  SourceId?: string;
}

/** Most declared child families per family. */
export const MAX_PARAMETRIC_USES = 32;

export type ParseParametricResult =
  | { ok: true; value: ParametricComponentExtras }
  | { ok: false; errors: string[] };

// ─── Parse / validate ────────────────────────────────────────────

const PARAM_TYPES: readonly ParamType[] = ['number', 'int', 'bool', 'enum'];
const PARAM_UNITS: readonly ParamUnit[] = ['mm', 'deg', ''];
/** Names that would collide with Object.prototype when used as a `Values` key. */
const FORBIDDEN_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const SIGNAL_REJECTION = 'parameters cannot be bound to signals (plan-650 F14)';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isParamValue(v: unknown): v is ParamValue {
  return isFiniteNumber(v) || typeof v === 'boolean' || typeof v === 'string';
}

/** True when a parameter definition tries to bind to a PLC signal. */
function looksSignalBound(raw: Record<string, unknown>): boolean {
  if (typeof raw.Type === 'string' && /signal|plc/i.test(raw.Type)) return true;
  for (const key of Object.keys(raw)) {
    if (/signal|binding/i.test(key)) return true;
  }
  const def = raw.Default;
  return isRecord(def) && (def.type === 'ComponentReference' || typeof def.path === 'string');
}

/**
 * Parse and validate one `Params` entry. Errors are appended to `errors`
 * (prefixed with the entry's position and name); returns null when invalid.
 */
function parseParamDef(raw: unknown, index: number, errors: string[]): ParamDef | null {
  if (!isRecord(raw)) {
    errors.push(`Params[${index}]: not an object`);
    return null;
  }
  const name = typeof raw.Name === 'string' ? raw.Name : '';
  const where = `Params[${index}]${name ? ` "${name}"` : ''}`;
  const before = errors.length;

  if (!name.trim() || name !== name.trim()) errors.push(`${where}: Name must be a non-empty string without surrounding spaces`);
  else if (FORBIDDEN_NAMES.has(name)) errors.push(`${where}: Name "${name}" is reserved`);

  if (looksSignalBound(raw)) {
    errors.push(`${where}: ${SIGNAL_REJECTION}`);
    return null;
  }

  const type = raw.Type as ParamType;
  if (!PARAM_TYPES.includes(type)) {
    errors.push(`${where}: Type must be one of ${PARAM_TYPES.join(', ')} (got ${JSON.stringify(raw.Type)})`);
    return null;
  }

  if (raw.Label !== undefined && typeof raw.Label !== 'string') errors.push(`${where}: Label must be a string`);
  if (raw.Unit !== undefined && !PARAM_UNITS.includes(raw.Unit as ParamUnit)) {
    errors.push(`${where}: Unit must be one of "mm", "deg", "" (got ${JSON.stringify(raw.Unit)})`);
  }

  const numeric = type === 'number' || type === 'int';
  for (const key of ['Min', 'Max', 'Step'] as const) {
    if (raw[key] === undefined) continue;
    if (!numeric) errors.push(`${where}: ${key} is only allowed for number/int parameters`);
    else if (!isFiniteNumber(raw[key])) errors.push(`${where}: ${key} must be a finite number`);
  }
  if (raw.Enum !== undefined && type !== 'enum') errors.push(`${where}: Enum is only allowed for enum parameters`);

  const def: ParamDef = { Name: name, Type: type, Default: raw.Default as ParamValue };
  if (typeof raw.Label === 'string') def.Label = raw.Label;
  if (PARAM_UNITS.includes(raw.Unit as ParamUnit)) def.Unit = raw.Unit as ParamUnit;

  if (numeric) {
    if (isFiniteNumber(raw.Min)) def.Min = raw.Min;
    if (isFiniteNumber(raw.Max)) def.Max = raw.Max;
    if (isFiniteNumber(raw.Step)) def.Step = raw.Step;
    if (def.Min !== undefined && def.Max !== undefined && def.Min > def.Max) {
      errors.push(`${where}: Min (${def.Min}) is greater than Max (${def.Max})`);
    }
    if (def.Step !== undefined && !(def.Step > 0)) errors.push(`${where}: Step must be > 0`);
    const d = raw.Default;
    if (!isFiniteNumber(d)) {
      errors.push(`${where}: Default must be a finite number`);
    } else if (type === 'int' && !Number.isInteger(d)) {
      errors.push(`${where}: Default ${d} is not an integer`);
    } else if ((def.Min !== undefined && d < def.Min) || (def.Max !== undefined && d > def.Max)) {
      errors.push(`${where}: Default ${d} is outside [${def.Min ?? '-inf'}, ${def.Max ?? 'inf'}]`);
    } else if (errors.length === before && normalizeNumber(def, d) !== d) {
      errors.push(`${where}: Default ${d} is not on the Step grid (${def.Step})`);
    }
  } else if (type === 'bool') {
    if (typeof raw.Default !== 'boolean') errors.push(`${where}: Default must be true or false`);
  } else {
    const list = raw.Enum;
    if (!Array.isArray(list) || list.length === 0) {
      errors.push(`${where}: Enum must be a non-empty array`);
    } else if (!list.every((v) => isFiniteNumber(v) || typeof v === 'string')) {
      errors.push(`${where}: Enum entries must be numbers or strings`);
    } else if (new Set(list).size !== list.length) {
      errors.push(`${where}: Enum contains duplicate values`);
    } else {
      def.Enum = [...list] as (number | string)[];
      if (!def.Enum.includes(raw.Default as number | string)) {
        errors.push(`${where}: Default ${JSON.stringify(raw.Default)} is not one of Enum`);
      }
    }
  }

  return errors.length === before ? def : null;
}

/**
 * Parse an `rv_extras.ParametricComponent` record defensively.
 *
 * Unknown fields are ignored; absent optional fields take their defaults
 * (`ApiVersion` 1, `Params` [], `Values` {}, `Code`/`CodeHash` '',
 * `PartsRoot` '_Parts', `GeneratedRoot` '_Generated'). `Values` keeps only
 * primitive entries (number/boolean/string) — use {@link normalizeValues} to
 * check them against the schema. Every problem is reported, not just the first.
 */
export function parseParametricComponent(raw: unknown): ParseParametricResult {
  if (!isRecord(raw)) return { ok: false, errors: ['ParametricComponent: not an object'] };
  const errors: string[] = [];

  const apiVersion = raw.ApiVersion ?? PARAMETRIC_API_VERSION;
  if (apiVersion !== PARAMETRIC_API_VERSION) {
    errors.push(`ApiVersion ${JSON.stringify(apiVersion)} is not supported (expected ${PARAMETRIC_API_VERSION})`);
  }

  const params: ParamDef[] = [];
  const rawParams = raw.Params ?? [];
  if (!Array.isArray(rawParams)) {
    errors.push('Params must be an array');
  } else {
    const seen = new Set<string>();
    rawParams.forEach((entry, i) => {
      const def = parseParamDef(entry, i, errors);
      if (!def) return;
      if (seen.has(def.Name)) {
        errors.push(`Params[${i}] "${def.Name}": duplicate parameter name`);
        return;
      }
      seen.add(def.Name);
      params.push(def);
    });
  }

  const values: Record<string, ParamValue> = {};
  const rawValues = raw.Values ?? {};
  if (!isRecord(rawValues)) {
    errors.push('Values must be an object');
  } else {
    for (const [key, v] of Object.entries(rawValues)) {
      if (!FORBIDDEN_NAMES.has(key) && isParamValue(v)) values[key] = v;
    }
  }

  const strings: Record<'Code' | 'CodeHash' | 'PartsRoot' | 'GeneratedRoot', string> = {
    Code: '', CodeHash: '', PartsRoot: DEFAULT_PARTS_ROOT, GeneratedRoot: DEFAULT_GENERATED_ROOT,
  };
  for (const key of Object.keys(strings) as (keyof typeof strings)[]) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof v !== 'string') errors.push(`${key} must be a string`);
    else if ((key === 'PartsRoot' || key === 'GeneratedRoot') && !v.trim()) errors.push(`${key} must not be empty`);
    else strings[key] = v;
  }
  if (strings.PartsRoot === strings.GeneratedRoot) errors.push('PartsRoot and GeneratedRoot must differ');

  const value: ParametricComponentExtras = {
    ApiVersion: PARAMETRIC_API_VERSION,
    Params: params,
    Values: values,
    Code: strings.Code,
    CodeHash: strings.CodeHash,
    PartsRoot: strings.PartsRoot,
    GeneratedRoot: strings.GeneratedRoot,
  };
  for (const key of ['BakedInputHash', 'DesignResource'] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof v !== 'string') errors.push(`${key} must be a string`);
    else value[key] = v;
  }
  const uses = parseUses(raw.Uses, errors);
  if (uses) value.Uses = uses;

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

/** `Uses` (plan-650 Phase 5b): unique `Family` keys, non-empty strings. */
function parseUses(raw: unknown, errors: string[]): ParametricUse[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) { errors.push('Uses must be an array'); return undefined; }
  if (raw.length > MAX_PARAMETRIC_USES) { errors.push(`Uses has ${raw.length} entries, limit ${MAX_PARAMETRIC_USES}`); return undefined; }
  const out: ParametricUse[] = [];
  const seen = new Set<string>();
  raw.forEach((e, i) => {
    if (!isRecord(e)) { errors.push(`Uses[${i}] must be an object`); return; }
    const s = (k: string): string | null => {
      const v = e[k];
      if (typeof v !== 'string' || !v.trim()) { errors.push(`Uses[${i}].${k} must be a non-empty string`); return null; }
      return v;
    };
    const fam = s('Family'); const nodeId = s('FamilyNodeId'); const doc = s('DocHash');
    if (!fam || !nodeId || !doc) return;
    if (seen.has(fam)) { errors.push(`Uses[${i}] "${fam}": duplicate family`); return; }
    seen.add(fam);
    const use: ParametricUse = { Family: fam, FamilyNodeId: nodeId, DocHash: doc };
    if (e.Path !== undefined) {
      if (typeof e.Path !== 'string') errors.push(`Uses[${i}].Path must be a string`);
      else use.Path = e.Path;
    }
    // plan-780 R4: an optional qualifier pair — both halves or neither.
    if (typeof e.ProviderId === 'string' && e.ProviderId && typeof e.SourceId === 'string' && e.SourceId) {
      use.ProviderId = e.ProviderId;
      use.SourceId = e.SourceId;
    }
    out.push(use);
  });
  return out;
}

// ─── Normalize ───────────────────────────────────────────────────

/** Remove binary floating-point noise (0.1 * 3) without touching real digits. */
function clean(v: number): number {
  const r = Number(v.toPrecision(12));
  return r === 0 ? 0 : r; // also folds -0 into 0
}

/** Clamp, snap to the Step grid (from Min, else 0) and round int — in that order, grid kept inside the bounds. */
function normalizeNumber(def: ParamDef, input: number): number {
  const min = def.Min ?? -Infinity;
  const max = def.Max ?? Infinity;
  let v = Math.min(max, Math.max(min, input));
  if (def.Step !== undefined && def.Step > 0) {
    const base = def.Min ?? 0;
    let k = Math.round(clean((v - base) / def.Step));
    if (base + k * def.Step > max) k -= 1;
    if (base + k * def.Step < min) k += 1;
    v = clean(base + k * def.Step);
    v = Math.min(max, Math.max(min, v)); // Step wider than the range
  }
  if (def.Type === 'int') {
    v = Math.round(v);
    if (v > max) v = Math.floor(max);
    if (v < min) v = Math.ceil(min);
  }
  return clean(v);
}

function fail(def: ParamDef, raw: unknown, expected: string): never {
  throw new Error(`ParametricComponent: value ${JSON.stringify(raw)} for parameter "${def.Name}" is not ${expected}`);
}

/**
 * Normalize raw parameter values against validated definitions (from
 * {@link parseParametricComponent}).
 *
 * Per definition, in definition order (the result's key order — deterministic
 * for hashing): a missing value takes `Default`; number/int values are clamped
 * to Min/Max, snapped to the Step grid (measured from Min, else 0) and int
 * values rounded; numeric strings are accepted. bool accepts true/false (also
 * as strings). An enum value outside `Enum` throws an Error naming the
 * parameter — it is never clamped. Keys without a definition are ignored.
 */
export function normalizeValues(
  defs: readonly ParamDef[],
  values: Readonly<Record<string, unknown>>,
): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const def of defs) {
    if (FORBIDDEN_NAMES.has(def.Name)) throw new Error(`ParametricComponent: parameter name "${def.Name}" is reserved`);
    const given = Object.prototype.hasOwnProperty.call(values, def.Name) ? values[def.Name] : undefined;
    const raw = given ?? def.Default;
    switch (def.Type) {
      case 'number':
      case 'int': {
        const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
        if (!isFiniteNumber(n)) fail(def, raw, 'a finite number');
        out[def.Name] = normalizeNumber(def, n);
        break;
      }
      case 'bool': {
        if (raw === true || raw === 'true') out[def.Name] = true;
        else if (raw === false || raw === 'false') out[def.Name] = false;
        else fail(def, raw, 'true or false');
        break;
      }
      case 'enum': {
        const list = def.Enum ?? [];
        let hit: number | string | undefined;
        if (list.includes(raw as number | string)) hit = raw as number | string;
        else if (typeof raw === 'string' || isFiniteNumber(raw)) hit = list.find((e) => String(e) === String(raw));
        if (hit === undefined) fail(def, raw, `one of [${list.map((e) => JSON.stringify(e)).join(', ')}]`);
        out[def.Name] = hit;
        break;
      }
      default:
        throw new Error(`ParametricComponent: parameter "${def.Name}" has unsupported Type ${JSON.stringify(def.Type)}`);
    }
  }
  return out;
}

// ─── Inspector rows (§2.7) ───────────────────────────────────────

/** Prefix of the per-parameter inspector rows: `Values.<Name>`. */
export const VALUES_FIELD_PREFIX = 'Values.';

/** The inspector descriptor of one parameter (unit, bounds, step, enum choices, default). */
export function paramFieldDescriptor(def: ParamDef): FieldDescriptor {
  const base = { default: def.Default, label: def.Label || def.Name, unit: def.Unit || undefined };
  switch (def.Type) {
    case 'bool': return { ...base, type: 'boolean' };
    case 'enum': return {
      ...base, type: 'enum',
      enumMap: Object.fromEntries((def.Enum ?? []).map((e) => [String(e), e])),
    };
    default: return {
      ...base, type: 'number',
      min: def.Min, max: def.Max, step: def.Step ?? (def.Type === 'int' ? 1 : undefined),
    };
  }
}

// `getFieldDescriptor('ParametricComponent', 'Values.BF', data)` → the row of parameter BF.
registerInstanceFieldResolver(PARAMETRIC_COMPONENT_TYPE, (fieldName, data) => {
  if (!fieldName.startsWith(VALUES_FIELD_PREFIX)) return undefined;
  const name = fieldName.slice(VALUES_FIELD_PREFIX.length);
  const parsed = parseParametricComponent(data);
  if (!parsed.ok) return undefined;
  const def = parsed.value.Params.find((p) => p.Name === name);
  return def ? paramFieldDescriptor(def) : undefined;
});

// ─── Generated subtree ───────────────────────────────────────────

interface NodeLike { name: string; parent: NodeLike | null; userData: Record<string, unknown> }

/**
 * The family node whose generated subtree (`GeneratedRoot`, default `_Generated`)
 * contains `node` — the generated root itself or anything below it — or null.
 * Cheap ancestor walk, no validation (F10 manual-attach guard).
 */
export function generatedFamilyOf<T extends NodeLike>(node: T): T | null {
  let child: NodeLike = node;
  let parent = node.parent;
  while (parent) {
    const pc = (parent.userData?.realvirtual as Record<string, unknown> | undefined)?.[PARAMETRIC_COMPONENT_TYPE];
    if (isRecord(pc)) {
      const gen = typeof pc.GeneratedRoot === 'string' && pc.GeneratedRoot ? pc.GeneratedRoot : DEFAULT_GENERATED_ROOT;
      if (child.name === gen) return parent as T;
    }
    child = parent;
    parent = parent.parent;
  }
  return null;
}

// ─── Capabilities ────────────────────────────────────────────────

// `claimsNode: true` keeps the family node through a destructive bake (plan-755 D7) — its
// rv_extras must survive for placements.
//
// PROVISIONAL (plan-650 Phase 4, orchestrator decision 2026-10-21, pending Thomas): NOT in the
// Add-Component menu until the feature is usable end to end — an empty ParametricComponent has
// no parts, rules or schema. Families are created with `web_editor_parametric_define`. To show
// it in the menu again, flip this one flag to `true`.
const PARAMETRIC_AUTHORABLE = false;
registerCapabilities(PARAMETRIC_COMPONENT_TYPE, { authorable: PARAMETRIC_AUTHORABLE, claimsNode: true });

// ─── Draft replay of a variant whose cache entry is gone ─────────────────

// The `importCad` of a regenerated `_Generated` subtree carries `CADLink.File = '<name>.parametric'`
// → format 'parametric'. On a cache miss the executor asks this provider, which regenerates the
// variant from the family's base parts (the heavy module loads only then).
registerCadProvider('parametric', {
  derived: true,
  importFile: () => Promise.reject(new Error('a parametric variant is generated, not imported from a file')),
  retessellate: async (cadlink, ctx) => {
    const m = await import('../editor/rv-parametric-regenerate');
    return m.rebuildParametricGlb(cadlink, ctx?.modelRoot ?? null);
  },
});

// ─── Pre-bake: the base parts never reach a bake (plan-650 Phase 5) ──────

// `_Parts` is authoring data: the rule reads it, the drawn variant is `_Generated`. Every
// destructive bake — the main model (`loadGLB`) and every placement (`ModelCache`) — runs
// `prepareAndBake`, so this one hook keeps the hidden parts out of every chunk (they would
// otherwise survive as `keep` meshes in each variant). The asset editor never bakes and keeps
// them. Registered AFTER `registerCapabilities` (which rebuilds the type from the defaults).
registerPreBakeHook(PARAMETRIC_COMPONENT_TYPE, (node, extras) => {
  const pc = extras[PARAMETRIC_COMPONENT_TYPE];
  const partsName = isRecord(pc) && typeof pc.PartsRoot === 'string' && pc.PartsRoot ? pc.PartsRoot : DEFAULT_PARTS_ROOT;
  for (const child of [...node.children]) if (child.name === partsName) node.remove(child);
});

// ─── Standstill guard (§2.6a) ────────────────────────────────────────────

/** The narrow view of the viewer the standstill guard reads. */
export interface StandstillView {
  readonly runtime?: {
    readonly state: string;
    readonly desControl?: { readonly renderClock?: number } | null;
  } | null;
  readonly simTime?: number;
}

/**
 * THE standstill guard of plan-650 (§2.6a, same rule as plan-453): the
 * generator may run when the runtime is `detached`, or `paused` with no
 * simulation time passed (`simTime === 0` and DES render clock 0; without a DES
 * control the clock counts as 0). A host without a runtime (headless tests)
 * has nothing running and is allowed; no viewer at all is not.
 */
export function canRegenerate(viewer: StandstillView | null | undefined): boolean {
  if (!viewer) return false;
  const rt = viewer.runtime;
  if (!rt) return true;
  if (rt.state === 'detached') return true;
  if (rt.state !== 'paused') return false;
  return (viewer.simTime ?? 0) === 0 && (rt.desControl?.renderClock ?? 0) === 0;
}

// ─── Per-placement values (plan-650 Phase 5) ─────────────────────────────

/** One family of a placement with the values its override asks for. */
export interface ParametricRequest {
  /** NodeId of the family node inside the placed asset. */
  familyNodeId: string;
  /** The override's raw `ParametricComponent.Values` (normalized by the variant step). */
  values: Readonly<Record<string, unknown>>;
}

/**
 * The parametric requests carried by a placement's `AssetOverrides`:
 * `byAddress['#<familyNodeId>'].ParametricComponent.Values` (plan-769), sorted by NodeId.
 * Only a family of the placed asset itself (`#id`) — a nested address belongs to an
 * inner placement, which bakes its own variant. Cheap and import-free — every placement asks it.
 */
export function parametricRequestsOf(
  overrides: {
    byAddress?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    /** Legacy (pre-769) layout records: read as `#<id>`; a `byAddress` entry wins. */
    byNodeId?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  } | null | undefined,
): ParametricRequest[] {
  const entries = new Map<string, Readonly<Record<string, unknown>>>();
  for (const [id, patch] of Object.entries(overrides?.byNodeId ?? {})) entries.set(id, patch);
  for (const [address, patch] of Object.entries(overrides?.byAddress ?? {})) {
    if (address.lastIndexOf('#') === 0) entries.set(address.slice(1), patch);
  }
  if (entries.size === 0) return [];
  const out: ParametricRequest[] = [];
  for (const [familyNodeId, patch] of entries) {
    const pc = patch?.[PARAMETRIC_COMPONENT_TYPE];
    if (!isRecord(pc) || !isRecord(pc.Values)) continue;
    out.push({ familyNodeId, values: pc.Values });
  }
  out.sort((a, b) => (a.familyNodeId < b.familyNodeId ? -1 : a.familyNodeId > b.familyNodeId ? 1 : 0));
  return out;
}

/** Key-sorted JSON of plain data — the request identity inside the model cache. */
export function canonicalRequestKey(requests: readonly ParametricRequest[]): string {
  const sortDeep = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortDeep);
    if (isRecord(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
    return v;
  };
  return JSON.stringify(requests.map((r) => [r.familyNodeId, sortDeep(r.values)]));
}

type ValuesChangedListener = (viewer: unknown, nodePath: string) => void;
const valuesListeners = new Set<ValuesChangedListener>();

/**
 * `ParametricComponent.Values` of a node changed through a scene op (do, undo
 * or redo of a `setField` / `unsetField`). The placement module listens and
 * re-materialises the placement with the new variant.
 */
export function onParametricValuesChanged(listener: ValuesChangedListener): () => void {
  valuesListeners.add(listener);
  return () => { valuesListeners.delete(listener); };
}

/** Called by the scene executors after a write to `ParametricComponent.Values`. */
export function emitParametricValuesChanged(viewer: unknown, nodePath: string): void {
  for (const l of [...valuesListeners]) {
    try { l(viewer, nodePath); } catch (e) { console.warn('[parametric] values listener failed:', e); }
  }
}

/** Marker on a placement root: the request key its current instance was built for. */
export const PARAMETRIC_BUILT_KEY = '_rvParamKey';

/** Stamp the parametric request key a placement root's instance was built for (`overrides` → requests). */
export function stampParametricBuiltKey(
  root: { userData: Record<string, unknown> },
  overrides: Parameters<typeof parametricRequestsOf>[0],
): void {
  root.userData[PARAMETRIC_BUILT_KEY] = canonicalRequestKey(parametricRequestsOf(overrides));
}
