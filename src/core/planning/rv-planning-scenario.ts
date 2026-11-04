// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-planning-scenario — the scenario block a document carries about its planning
 * parameters (plan-630 §2.8).
 *
 * ```jsonc
 * // scenes[0].extras.realvirtual.PlanningScenarios
 * { "version": 1, "active": "Basis",
 *   "scenarios": { "Basis": {}, "High load": { "palletYard.production.A1.ratePerHour": 60 } } }
 * ```
 *
 * ## Generic on purpose
 *
 * A scenario is a flat map of EFFECTIVE keys (`<owner>.<key>`) to scalar values — the
 * registry's own address space. Nothing here knows an owner: PalletYard, the selected
 * component properties (owner `component`, plan-630 Phase 8) and the ScriptComponent
 * parameters (plan-2003) all land in the same map under their own owner prefix.
 *
 * The one owner-specific field is `selection[]` — WHICH component properties the planning
 * window shows. It is document-wide (the same for every scenario); the values of those
 * properties are ordinary scenario values like any other.
 *
 * ## Only deviations
 *
 * A scenario stores what differs from the declared default of a FACTOR parameter; display
 * switches never. A default changed in a later model version therefore reaches every
 * document that never touched that parameter.
 *
 * ## Never silently repaired
 *
 * {@link parsePlanningScenarios} drops what it cannot use — a malformed key, a non-scalar
 * value, an illegal scenario name — and RETURNS every drop as an issue; the caller reports
 * them. Range and type against the declaration are checked later, by the registry, when the
 * owner declares; there too an invalid value is dropped and reported, never clamped.
 *
 * Pure: no viewer, no Problems store, no React. Runs under the Node test config.
 */

import { isValidPlanningKey, isValidPlanningOwner, type PlanningValue } from './rv-planning-params';
import {
  componentSelectionPayload, parseComponentSelection, type ComponentParamSelection,
} from './rv-planning-component-selection';

// ─── Types ─────────────────────────────────────────────────────────────────

/** Key of the block under `extras.realvirtual` of the default scene. */
export const RV_PLANNING_SCENARIOS_KEY = 'PlanningScenarios';
/** The block version this viewer writes and understands. */
export const PLANNING_SCENARIOS_VERSION = 1;
/** Name of the scenario a document starts with (§2.8 / F5). */
export const DEFAULT_SCENARIO_NAME = 'Basis';
/** Longest accepted scenario name, in characters. */
export const SCENARIO_NAME_MAX = 64;

/** Effective key → value of one scenario (deviations from the defaults only). */
export type PlanningScenarioValues = Readonly<Record<string, PlanningValue>>;

/** The block as stored in the file. */
export interface PlanningScenarioBlock {
  version: 1;
  /** Scenario whose values are the start values when the document loads. */
  active: string;
  scenarios: Readonly<Record<string, PlanningScenarioValues>>;
  /**
   * Existing component properties shown in the planning window (plan-630 §2.14, Phase 8)
   * — document-wide, the same for every scenario. Absent = none (files before Phase 8).
   */
  selection?: readonly ComponentParamSelection[];
}

/** Why something of a stored block was not used. */
export type PlanningScenarioIssueCode =
  | 'block-invalid'          // not an object, or `scenarios` not an object
  | 'version-unsupported'    // written by a newer viewer — not read at all
  | 'scenario-name-invalid'  // empty / too long / control characters
  | 'scenario-invalid'       // a scenario is not an object
  | 'key-invalid'            // not `<owner>.<key>`
  | 'value-invalid'          // not a boolean, finite number or string
  | 'active-missing'         // `active` names no stored scenario
  | 'selection-invalid';     // a `selection[]` entry that cannot be used (Phase 8)

/** One drop, for the Problems panel. */
export interface PlanningScenarioIssue {
  code: PlanningScenarioIssueCode;
  scenario?: string;
  key?: string;
  detail: string;
}

/** Result of reading a block out of `extras.realvirtual`. */
export interface PlanningScenarioParseResult {
  /** The usable block, `null` when the document carries none (or none this viewer can read). */
  block: PlanningScenarioBlock | null;
  issues: PlanningScenarioIssue[];
}

// ─── Names ─────────────────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Checks a scenario name: trimmed, non-empty, at most {@link SCENARIO_NAME_MAX}
 * characters, no control characters. Returns the trimmed name or the reason.
 */
export function checkScenarioName(raw: unknown): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'A scenario name is text.' };
  const name = raw.trim();
  if (!name) return { ok: false, error: 'A scenario needs a name.' };
  if (name.length > SCENARIO_NAME_MAX) return { ok: false, error: `At most ${SCENARIO_NAME_MAX} characters.` };
  if (CONTROL_CHARS.test(name)) return { ok: false, error: 'No control characters in a scenario name.' };
  // A plain-object key that would set the prototype instead of a scenario.
  if (name === '__proto__') return { ok: false, error: `"${name}" is reserved.` };
  return { ok: true, name };
}

/** Does `scenarios` hold a scenario `name` (own property — never one of Object.prototype)? */
export function hasScenario(scenarios: Readonly<Record<string, unknown>>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(scenarios, name);
}

// ─── Keys and values ───────────────────────────────────────────────────────

/** Is `key` an effective key `<owner>.<owner-local key>`? */
export function isEffectivePlanningKey(key: unknown): key is string {
  if (typeof key !== 'string') return false;
  const dot = key.indexOf('.');
  return dot > 0 && isValidPlanningOwner(key.slice(0, dot)) && isValidPlanningKey(key.slice(dot + 1));
}

/** The owner part of an effective key. */
export function ownerOfEffectiveKey(key: string): string {
  const dot = key.indexOf('.');
  return dot > 0 ? key.slice(0, dot) : key;
}

function isScalar(v: unknown): v is PlanningValue {
  return typeof v === 'boolean' || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ─── Block ─────────────────────────────────────────────────────────────────

/** A block with only the empty default scenario — what a document without one behaves as. */
export function emptyScenarioBlock(): PlanningScenarioBlock {
  return { version: 1, active: DEFAULT_SCENARIO_NAME, scenarios: { [DEFAULT_SCENARIO_NAME]: {} } };
}

/**
 * True for a block that says nothing a document without one would not say: only the
 * default scenario, empty, and active. Such a block is not written (one state on disk
 * for "never set" and "set back to the defaults").
 */
export function isEmptyScenarioBlock(block: PlanningScenarioBlock): boolean {
  const names = Object.keys(block.scenarios);
  return (block.selection?.length ?? 0) === 0
    && block.active === DEFAULT_SCENARIO_NAME
    && names.length === 1 && names[0] === DEFAULT_SCENARIO_NAME
    && Object.keys(block.scenarios[DEFAULT_SCENARIO_NAME]).length === 0;
}

/**
 * Reads the block from an `extras.realvirtual` object. Never throws.
 *
 * Absent → `{ block: null, issues: [] }`. A block of another version is not read at all
 * (`version-unsupported`): its keys might mean something else. Everything unusable inside
 * a readable block is dropped one by one and named in `issues`. An `active` that names no
 * stored scenario falls back to the first stored one (or a fresh empty default) — reported.
 */
export function parsePlanningScenarios(rvExtras: unknown): PlanningScenarioParseResult {
  const issues: PlanningScenarioIssue[] = [];
  if (!isRecord(rvExtras) || !(RV_PLANNING_SCENARIOS_KEY in rvExtras)) return { block: null, issues };
  const raw = rvExtras[RV_PLANNING_SCENARIOS_KEY];
  if (!isRecord(raw)) {
    issues.push({ code: 'block-invalid', detail: 'The PlanningScenarios block is not an object; it is ignored.' });
    return { block: null, issues };
  }
  if (raw.version !== PLANNING_SCENARIOS_VERSION) {
    issues.push({
      code: 'version-unsupported',
      detail: `PlanningScenarios version ${String(raw.version)} is not supported by this viewer (expects ${PLANNING_SCENARIOS_VERSION}); `
        + 'it is ignored, and saving scenarios here replaces it.',
    });
    return { block: null, issues };
  }
  if (!isRecord(raw.scenarios)) {
    issues.push({ code: 'block-invalid', detail: 'PlanningScenarios.scenarios is not an object; it is ignored.' });
    return { block: null, issues };
  }

  const scenarios: Record<string, PlanningScenarioValues> = {};
  for (const [rawName, rawValues] of Object.entries(raw.scenarios)) {
    const name = checkScenarioName(rawName);
    if (!name.ok) {
      issues.push({ code: 'scenario-name-invalid', scenario: rawName, detail: `Scenario '${rawName}' dropped: ${name.error}` });
      continue;
    }
    if (!isRecord(rawValues)) {
      issues.push({ code: 'scenario-invalid', scenario: name.name, detail: `Scenario '${name.name}' is not an object; dropped.` });
      continue;
    }
    if (hasScenario(scenarios, name.name)) {
      issues.push({ code: 'scenario-name-invalid', scenario: name.name, detail: `Scenario '${name.name}' appears twice; the second one is dropped.` });
      continue;
    }
    const values: Record<string, PlanningValue> = {};
    for (const [key, value] of Object.entries(rawValues)) {
      if (!isEffectivePlanningKey(key)) {
        issues.push({ code: 'key-invalid', scenario: name.name, key, detail: `'${key}' is not an <owner>.<key> parameter key; dropped.` });
        continue;
      }
      if (!isScalar(value)) {
        issues.push({ code: 'value-invalid', scenario: name.name, key, detail: `Value of '${key}' is not a boolean, number or text; dropped.` });
        continue;
      }
      values[key] = value;
    }
    scenarios[name.name] = values;
  }

  let active = typeof raw.active === 'string' ? raw.active.trim() : '';
  if (!hasScenario(scenarios, active)) {
    const fallback = Object.keys(scenarios)[0] ?? DEFAULT_SCENARIO_NAME;
    issues.push({
      code: 'active-missing',
      scenario: active || undefined,
      detail: `The active scenario '${active}' is not stored; '${fallback}' is used instead.`,
    });
    active = fallback;
    if (!hasScenario(scenarios, active)) scenarios[active] = {};
  }
  const sel = parseComponentSelection(raw.selection);
  for (const detail of sel.issues) issues.push({ code: 'selection-invalid', detail });
  const block: PlanningScenarioBlock = sel.selection.length > 0
    ? { version: 1, active, scenarios, selection: sel.selection }
    : { version: 1, active, scenarios };
  return { block, issues };
}

/**
 * The block with scenario `name` set to `values` (a copy; only the effective-key / scalar
 * entries survive). `activate` makes it the active one.
 */
export function withScenario(
  block: PlanningScenarioBlock,
  name: string,
  values: Readonly<Record<string, unknown>>,
  activate = true,
): PlanningScenarioBlock {
  const clean: Record<string, PlanningValue> = {};
  for (const key of Object.keys(values).sort()) {
    const v = values[key];
    if (isEffectivePlanningKey(key) && isScalar(v)) clean[key] = v;
  }
  return {
    ...block,
    version: 1,
    active: activate ? name : block.active,
    scenarios: { ...block.scenarios, [name]: clean },
  };
}

/** The block with `key` removed from every scenario (a component property taken out of the window). */
export function withoutScenarioKey(block: PlanningScenarioBlock, key: string): PlanningScenarioBlock {
  let changed = false;
  const scenarios: Record<string, PlanningScenarioValues> = {};
  for (const [name, values] of Object.entries(block.scenarios)) {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      const { [key]: _dropped, ...rest } = values;
      scenarios[name] = rest;
      changed = true;
    } else {
      scenarios[name] = values;
    }
  }
  return changed ? { ...block, scenarios } : block;
}

/** The block with another component selection (plan-630 Phase 8); empty removes the field. */
export function withSelection(
  block: PlanningScenarioBlock,
  selection: readonly ComponentParamSelection[],
): PlanningScenarioBlock {
  const { selection: _old, ...rest } = block;
  return selection.length > 0 ? { ...rest, selection: selection.slice() } : rest;
}

/** The block with `active` set (the scenario must exist, else unchanged). */
export function withActiveScenario(block: PlanningScenarioBlock, name: string): PlanningScenarioBlock {
  return hasScenario(block.scenarios, name) ? { ...block, active: name } : block;
}

/** JSON-safe payload of a block, keys of each scenario sorted (stable git diffs). */
export function planningScenariosPayload(block: PlanningScenarioBlock): Record<string, unknown> {
  const scenarios: Record<string, Record<string, PlanningValue>> = {};
  for (const name of Object.keys(block.scenarios)) {
    const values = block.scenarios[name];
    const sorted: Record<string, PlanningValue> = {};
    for (const key of Object.keys(values).sort()) sorted[key] = values[key];
    scenarios[name] = sorted;
  }
  const payload: Record<string, unknown> = { version: PLANNING_SCENARIOS_VERSION, active: block.active, scenarios };
  if (block.selection && block.selection.length > 0) payload.selection = componentSelectionPayload(block.selection);
  return payload;
}

// ─── Deviations of a running session ───────────────────────────────────────

/** The registry slice {@link collectScenarioValues} reads. */
export interface ScenarioValueSource {
  getSnapshot(): {
    owners: ReadonlyArray<{ owner: string }>;
    params: ReadonlyArray<{
      key: string;
      role: 'factor' | 'display';
      value: PlanningValue;
      pending?: PlanningValue;
      def: { default: PlanningValue };
    }>;
  };
  dormant(): Readonly<Record<string, unknown>>;
}

/**
 * What a save writes for the session as it stands: every FACTOR parameter whose effective
 * value (pending / queued value if any, else the committed one) differs from its default,
 * plus every dormant value. A dormant key has no declaration to check it against: it may
 * belong to a model that did not run here (another plugin, a script), or be an instance
 * key that only exists after a pending rebuild (a larger yard's stations). Writing it back
 * keeps it; it was reported (`planning-param-orphaned`) and is never applied unless
 * declared. A dormant VALUE the declaration rejected was dropped before it got here.
 */
export function collectScenarioValues(source: ScenarioValueSource): Record<string, PlanningValue> {
  const snap = source.getSnapshot();
  const out: Record<string, PlanningValue> = {};
  for (const p of snap.params) {
    if (p.role !== 'factor') continue;
    const effective = p.pending !== undefined ? p.pending : p.value;
    if (effective !== p.def.default) out[p.key] = effective;
  }
  for (const [key, value] of Object.entries(source.dormant())) {
    if (Object.prototype.hasOwnProperty.call(out, key) || !isEffectivePlanningKey(key) || !isScalar(value)) continue;
    out[key] = value;
  }
  return out;
}

/** Same keys, same values (order-free)? */
export function sameScenarioValues(a: Readonly<Record<string, unknown>>, b: Readonly<Record<string, unknown>>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && b[k] === a[k]);
}
