// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-planning-params — the declaration model of planning parameters (plan-630 §2.3).
 *
 * A model (a project script, later `definePlantPlugin`, or the selection of existing
 * component properties, `rv-planning-component-params.ts`) DECLARES its planning parameters: key, label, type, unit, range,
 * default, group and — the point of the whole model — its effect `apply: 'live' | 'reset'`.
 * The planning overlay, the MCP tools and the experiment matrix read nothing but this
 * declaration; none of them knows the model.
 *
 * ## Pure on purpose
 *
 * No viewer, no DOM, no React, no Problems store: this module only describes and checks.
 * `parsePlanningDeclaration` RETURNS its findings instead of reporting them, so the registry
 * (or a test) decides where they go. Everything here runs under the Node test config.
 *
 * ## Values are scalars
 *
 * {@link PlanningValue} is a subset of the experiment model's `ParamValue` (plan-265), so a
 * declared parameter is an experiment factor without a schema change (§2.10).
 */

// ─── Types (§2.3) ──────────────────────────────────────────────────────────

/** A parameter value. Subset of `ParamValue` (plan-265) — never `null`. */
export type PlanningValue = boolean | number | string;
/** The value type of a declared parameter. */
export type PlanningParamType = 'number' | 'integer' | 'boolean' | 'enum';
/** When a changed value takes effect: at the next sim instant, or only at the structural reset. */
export type PlanningApply = 'live' | 'reset';
/** `factor` = part of the scenario and of the experiment matrix; `display` = view switch only. */
export type PlanningRole = 'factor' | 'display';
/** Where the current value of a parameter came from. */
export type PlanningOrigin = 'default' | 'scenario' | 'ui' | 'mcp' | 'experiment';

/** One declared planning parameter. */
export interface PlanningParamDef {
  /** Stable, dot-separated, unique within the owner: `'production.A1.ratePerHour'`. */
  key: string;
  label: string;
  type: PlanningParamType;
  /** Display unit: `'Pal/h'`, `'s'`, `'%'`. */
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  /** Options of an `enum` parameter. */
  options?: ReadonlyArray<{ id: string; label: string }>;
  default: PlanningValue;
  /**
   * Start value when the parameter is first declared (plan-630 §2.14, Phase 8): committed
   * with source `default`, WITHOUT a pending value, a log row or any write — so declaring a
   * parameter whose model already runs with another value than its `default` (a component
   * field: `default` = the value the document carries, `initial` = the current effective
   * one) resets nothing. A dormant scenario value still wins. Absent → `default`.
   */
  initial?: PlanningValue;
  /** Overlay group: `'Production load'`, `'Stations'`, `'Fleet'`, `'Display'`. */
  group: string;
  apply: PlanningApply;
  /** Default `'factor'`. */
  role?: PlanningRole;
  description?: string;
  order?: number;
  /**
   * Rendering hints: several booleans with the same `chipRow` form one chip row;
   * `hidden` keeps the parameter out of the planning window (an experiment factor that
   * was declared on demand, plan-2005 Phase 7) — it is still listed, set and applied.
   */
  ui?: { chipRow?: string; hidden?: boolean };
  /**
   * The component property this parameter IS (owner `component`, plan-630 §2.14): full
   * NodeRegistry address, component key, field (path). Carried so nothing has to invert
   * the hashed key; absent for parameters a model declares itself.
   */
  target?: { readonly address: string; readonly component: string; readonly field: string };
}

/** `sim` = deterministic model figure; `measured` = wall clock, not deterministic. */
export type PlanningKpiKind = 'sim' | 'measured';

/** One declared key figure. */
export interface PlanningKpiDef {
  key: string;
  label: string;
  unit?: string;
  kind: PlanningKpiKind;
  decimals?: number;
  /** `null` = not available (e.g. heap size outside Chromium). */
  read(): number | null;
}

/**
 * A live change that is due. The owner applies it at an instant of ITS sim clock and calls
 * `applied(simTime)`; only then the value becomes visible in `values()` and the change log.
 */
export interface PendingLiveChange {
  /** Owner-local key (`'production.A1.ratePerHour'`). */
  key: string;
  /** Effective key (`'palletYard.production.A1.ratePerHour'`). */
  effectiveKey: string;
  from: PlanningValue;
  to: PlanningValue;
  origin: PlanningOrigin;
  /** Sequence number within the run (§2.5 replay contract). */
  seq: number;
}

/**
 * Context handed to `onStructuralReset` (§2.5a). Three SEPARATE identities (Gate R2 #2) —
 * `documentLoadId` is the only one that signals a document change.
 */
export interface StructuralResetContext {
  readonly documentLoadId: string;
  /** Waits for the placements of the owner's last placement request (plan-681; unused in 630). */
  awaitPlacements(): Promise<void>;
  /** Aborted on document change / dispose. */
  readonly signal: AbortSignal;
}

/** What a model declares. */
export interface PlanningDeclaration {
  /** Namespace: effective key = `owner + '.' + key`. Must not contain a dot. */
  owner: string;
  /** Window title, e.g. `'Planning · PalletYard'`. */
  title: string;
  params: readonly PlanningParamDef[];
  kpis?: readonly PlanningKpiDef[];
  /** Cross rules on the owner-local candidate values; returns messages per key (empty = valid). */
  validate?(values: Readonly<Record<string, PlanningValue>>): Record<string, string>;
  /**
   * A live value is due: apply it at a sim instant and report back via `applied(simTime)`.
   * The registry supplies `isValid`; deferred owners must check it immediately before
   * mutating the model. Revert, supersession, reset or owner removal invalidates the change.
   * Optional for compatibility with callers of the original two-argument hook.
   */
  /** Replay passes alreadyScheduled: apply directly without queuing another clock event. */
  onLive?(change: PendingLiveChange, applied: (simTime: number) => void, isValid?: () => boolean, opts?: { alreadyScheduled?: boolean }): void;
  /**
   * Structural reset (§2.5a steps 3-4): reconfigure WHILE the simulation stands still.
   * Rejecting aborts the apply. Without the hook the reset is a plain restart.
   */
  onStructuralReset?(committed: Readonly<Record<string, PlanningValue>>, ctx: StructuralResetContext): Promise<void>;
}

// ─── Declaration check ─────────────────────────────────────────────────────

/** Machine-readable kind of a declaration finding. */
export type PlanningDeclarationErrorCode =
  | 'invalid-declaration'
  | 'invalid-owner'
  | 'invalid-param'
  | 'invalid-key'
  | 'invalid-type'
  | 'invalid-apply'
  | 'invalid-role'
  | 'invalid-range'
  | 'enum-without-options'
  | 'default-invalid'
  | 'default-out-of-range'
  | 'initial-invalid'
  | 'duplicate-key';

/** One finding of {@link parsePlanningDeclaration}. */
export interface PlanningDeclarationError {
  code: PlanningDeclarationErrorCode;
  /** Owner-local key of the offending parameter, when there is one. */
  key?: string;
  message: string;
}

/** Result of {@link parsePlanningDeclaration}. */
export interface PlanningDeclarationParseResult {
  /** The declaration with only the valid parameters; `null` when the declaration itself is unusable. */
  declaration: PlanningDeclaration | null;
  /** Findings in parameter order. A parameter with a finding is left out of `declaration.params`. */
  errors: PlanningDeclarationError[];
}

const PARAM_TYPES: ReadonlySet<string> = new Set(['number', 'integer', 'boolean', 'enum']);
const KEY_PATTERN = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;
const OWNER_PATTERN = /^[A-Za-z0-9_-]+$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Is `key` a well-formed owner-local key (dot-separated, no empty segment)? */
export function isValidPlanningKey(key: unknown): key is string {
  return typeof key === 'string' && KEY_PATTERN.test(key);
}

/** Is `owner` a well-formed owner name (no dot)? */
export function isValidPlanningOwner(owner: unknown): owner is string {
  return typeof owner === 'string' && OWNER_PATTERN.test(owner);
}

/** The effective (registry-wide) key of an owner-local key. */
export function effectivePlanningKey(owner: string, key: string): string {
  return `${owner}.${key}`;
}

/** Role of a parameter with the default applied. */
export function planningRoleOf(def: Pick<PlanningParamDef, 'role'>): PlanningRole {
  return def.role === 'display' ? 'display' : 'factor';
}

/**
 * Checks a declaration defensively and never throws (§2.3): duplicate keys, malformed keys,
 * unknown types/effects, `min > max`, `enum` without options, a default of the wrong type or
 * outside its range. Each offending parameter is left out of the returned declaration and
 * named in `errors`, in parameter order; a duplicate key keeps its FIRST occurrence (even an
 * invalid one — a duplicate is a duplicate regardless of which of the two is broken).
 */
export function parsePlanningDeclaration(input: unknown): PlanningDeclarationParseResult {
  const errors: PlanningDeclarationError[] = [];
  if (!isRecord(input)) {
    return { declaration: null, errors: [{ code: 'invalid-declaration', message: 'declaration is not an object' }] };
  }
  if (!isValidPlanningOwner(input.owner)) {
    return {
      declaration: null,
      errors: [{ code: 'invalid-owner', message: `owner '${String(input.owner)}' must be a non-empty name without dots` }],
    };
  }
  const rawParams = Array.isArray(input.params) ? input.params : [];
  if (!Array.isArray(input.params)) {
    errors.push({ code: 'invalid-declaration', message: 'params is not an array' });
  }

  const seen = new Set<string>();
  const params: PlanningParamDef[] = [];
  for (const raw of rawParams) {
    const finding = checkParam(raw, seen);
    if (finding) { errors.push(finding); continue; }
    const def = raw as PlanningParamDef;
    // `initial` (Phase 8) is optional: an unusable one is dropped and reported, the
    // parameter itself stays (it then starts at its default).
    const initialFinding = checkInitial(def);
    if (initialFinding) {
      errors.push(initialFinding);
      const { initial: _dropped, ...rest } = def;
      params.push(rest);
    } else {
      params.push(def);
    }
  }

  const decl = input as unknown as PlanningDeclaration;
  const kpis = Array.isArray(input.kpis)
    ? (input.kpis as unknown[]).filter((k): k is PlanningKpiDef =>
      isRecord(k) && typeof k.key === 'string' && typeof k.read === 'function'
      && (k.kind === 'sim' || k.kind === 'measured'))
    : undefined;

  return {
    declaration: {
      owner: decl.owner,
      title: typeof input.title === 'string' && input.title !== '' ? input.title : decl.owner,
      params,
      kpis,
      validate: typeof decl.validate === 'function' ? decl.validate : undefined,
      onLive: typeof decl.onLive === 'function' ? decl.onLive : undefined,
      onStructuralReset: typeof decl.onStructuralReset === 'function' ? decl.onStructuralReset : undefined,
    },
    errors,
  };
}

function checkParam(raw: unknown, seen: Set<string>): PlanningDeclarationError | null {
  if (!isRecord(raw)) return { code: 'invalid-param', message: 'parameter is not an object' };
  const key = raw.key;
  if (!isValidPlanningKey(key)) {
    return { code: 'invalid-key', key: typeof key === 'string' ? key : undefined, message: `key '${String(key)}' is not a dot-separated name` };
  }
  if (seen.has(key)) return { code: 'duplicate-key', key, message: `key '${key}' is declared twice` };
  seen.add(key);

  if (typeof raw.type !== 'string' || !PARAM_TYPES.has(raw.type)) {
    return { code: 'invalid-type', key, message: `type '${String(raw.type)}' is not number|integer|boolean|enum` };
  }
  if (raw.apply !== 'live' && raw.apply !== 'reset') {
    return { code: 'invalid-apply', key, message: `apply '${String(raw.apply)}' is not live|reset` };
  }
  if (raw.role !== undefined && raw.role !== 'factor' && raw.role !== 'display') {
    return { code: 'invalid-role', key, message: `role '${String(raw.role)}' is not factor|display` };
  }
  if ((raw.min !== undefined && !isFiniteNumber(raw.min)) || (raw.max !== undefined && !isFiniteNumber(raw.max))
    || (isFiniteNumber(raw.min) && isFiniteNumber(raw.max) && raw.min > raw.max)) {
    return { code: 'invalid-range', key, message: `range [${String(raw.min)}, ${String(raw.max)}] is not a valid interval` };
  }
  if (raw.type === 'enum') {
    const opts = raw.options;
    if (!Array.isArray(opts) || opts.length === 0 || !opts.every((o) => isRecord(o) && typeof o.id === 'string')) {
      return { code: 'enum-without-options', key, message: `enum '${key}' declares no options` };
    }
  }
  const def = raw as unknown as PlanningParamDef;
  const coerced = coercePlanningValue(def, raw.default);
  if (coerced === undefined || coerced !== raw.default) {
    return { code: 'default-invalid', key, message: `default '${String(raw.default)}' is not a ${def.type}` };
  }
  const invalid = validatePlanningValue(def, coerced);
  if (invalid) {
    return {
      code: invalid.code === 'out-of-range' ? 'default-out-of-range' : 'default-invalid',
      key,
      message: `default of '${key}': ${invalid.message}`,
    };
  }
  return null;
}

function checkInitial(def: PlanningParamDef): PlanningDeclarationError | null {
  if (def.initial === undefined) return null;
  const coerced = coercePlanningValue(def, def.initial);
  const invalid = coerced === undefined || coerced !== def.initial ? null : validatePlanningValue(def, coerced);
  if (coerced === undefined || coerced !== def.initial || invalid) {
    return {
      code: 'initial-invalid',
      key: def.key,
      message: `initial of '${def.key}' (${String(def.initial)}) is not a valid value${invalid ? `: ${invalid.message}` : ''} — the default is used`,
    };
  }
  return null;
}

// ─── Coercion and validation ───────────────────────────────────────────────

/**
 * Coerces a raw input (UI field, MCP JSON, scenario block) to the parameter's type:
 * `'90'` → `90`, `'true'` → `true`, `1` → `true` for booleans. Returns `undefined` when the
 * input cannot be read as that type. Does NOT check range, integrality or option membership —
 * that is {@link validatePlanningValue}.
 */
export function coercePlanningValue(def: Pick<PlanningParamDef, 'type'>, raw: unknown): PlanningValue | undefined {
  switch (def.type) {
    case 'number':
    case 'integer': {
      if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
      if (typeof raw === 'string') {
        const s = raw.trim();
        if (s === '') return undefined;
        const n = Number(s);
        return Number.isFinite(n) ? n : undefined;
      }
      return undefined;
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      if (raw === 1 || raw === 0) return raw === 1;
      if (typeof raw === 'string') {
        const s = raw.trim().toLowerCase();
        if (s === 'true' || s === '1') return true;
        if (s === 'false' || s === '0') return false;
      }
      return undefined;
    }
    case 'enum':
      return typeof raw === 'string' ? raw : undefined;
    default:
      return undefined;
  }
}

/** Why a typed value is not acceptable for its parameter. */
export interface PlanningValueError {
  code: 'type' | 'not-integer' | 'out-of-range' | 'unknown-option';
  message: string;
}

/** Checks a typed value against its declaration: type, integrality, range, option. `null` = valid. */
export function validatePlanningValue(def: PlanningParamDef, value: PlanningValue): PlanningValueError | null {
  switch (def.type) {
    case 'number':
    case 'integer': {
      if (!isFiniteNumber(value)) return { code: 'type', message: `expected a number, got '${String(value)}'` };
      if (def.type === 'integer' && !Number.isInteger(value)) {
        return { code: 'not-integer', message: `expected an integer, got ${value}` };
      }
      if ((isFiniteNumber(def.min) && value < def.min) || (isFiniteNumber(def.max) && value > def.max)) {
        return { code: 'out-of-range', message: `${value} is outside [${def.min ?? '-∞'}, ${def.max ?? '∞'}]` };
      }
      return null;
    }
    case 'boolean':
      return typeof value === 'boolean' ? null : { code: 'type', message: `expected a boolean, got '${String(value)}'` };
    case 'enum': {
      if (typeof value !== 'string') return { code: 'type', message: `expected an option id, got '${String(value)}'` };
      const ids = (def.options ?? []).map((o) => o.id);
      return ids.includes(value) ? null : { code: 'unknown-option', message: `'${value}' is not one of ${ids.join('|')}` };
    }
    default:
      return { code: 'type', message: `unknown type '${String((def as PlanningParamDef).type)}'` };
  }
}

/** Coerce + validate in one step: the check every write path (UI, MCP, scenario) goes through. */
export function checkPlanningValue(
  def: PlanningParamDef,
  raw: unknown,
): { ok: true; value: PlanningValue } | { ok: false; error: string } {
  const value = coercePlanningValue(def, raw);
  if (value === undefined) return { ok: false, error: `'${String(raw)}' is not a ${def.type}` };
  const invalid = validatePlanningValue(def, value);
  return invalid ? { ok: false, error: invalid.message } : { ok: true, value };
}
