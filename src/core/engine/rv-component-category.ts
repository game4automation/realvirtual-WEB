// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-component-category — the ONE answer to "which coarse category does a
 * component type belong to, and under which fine label" (plan-597).
 *
 * Two levels:
 *   - category (`ui.category`, coarse) — a hierarchy filter chip and a search
 *     result group, in the fixed {@link CATEGORY_ORDER}.
 *   - label (`ui.filter`, fine) — the second level inside a category (the ▾
 *     menu of the hierarchy chip).
 *
 * Resolution cascade per type key, memoised per key and invalidated by the
 * capability epoch (`getCapabilitiesEpoch()`):
 *   1. the exact key's registered capabilities,
 *   2. else the base type (`_\d+$` stripped — the `_N` dedup convention),
 *   3. else the built-in rule table below (types without a capability
 *      declaration: PLC signals, LogicStep_*, Drive_* subtypes, Source/Sink/MU …),
 *   4. else `{ category: 'other', label: typeKey }`.
 * A declared category id outside {@link CATEGORY_ORDER} is normalised to
 * `other` (one DEV warning per type); its `ui.filter` stays the label.
 *
 * The built-in rules are deliberately NOT registered via `registerCapabilities`:
 * a registration would also populate the visibility auto-filters.
 */

import { getCapabilities, getCapabilitiesEpoch, getRegisteredCapabilities } from './rv-component-registry';

export type CategoryId =
  | 'drives' | 'sensors' | 'transport' | 'material-flow' | 'process' | 'robotics'
  | 'signals' | 'logic' | 'hmi' | 'physics' | 'info' | 'other';

/** Fixed chip + search-group order. Never sorted by count. */
export const CATEGORY_ORDER: readonly CategoryId[] = Object.freeze([
  'drives', 'sensors', 'transport', 'material-flow', 'process', 'robotics',
  'signals', 'logic', 'hmi', 'physics', 'info', 'other',
] as const);

/** English UI label per category. */
export const CATEGORY_LABEL: Readonly<Record<CategoryId, string>> = Object.freeze({
  drives: 'Drives',
  sensors: 'Sensors',
  transport: 'Transport',
  'material-flow': 'Material flow',
  process: 'Process',
  robotics: 'Robotics',
  signals: 'Signals',
  logic: 'Logic',
  hmi: 'HMI',
  physics: 'Physics',
  info: 'Info',
  other: 'Other',
});

export interface TypeCategory {
  category: CategoryId;
  /** Fine label: `ui.filter` ?? rule label ?? type key. */
  label: string;
}

const CATEGORY_SET: ReadonlySet<string> = new Set<string>(CATEGORY_ORDER);

/** True for a known category id. */
export function isCategoryId(id: string): id is CategoryId {
  return CATEGORY_SET.has(id);
}

/** Rank of a category in {@link CATEGORY_ORDER} (unknown → after 'other'). */
export function categoryRank(id: string): number {
  const i = CATEGORY_ORDER.indexOf(id as CategoryId);
  return i === -1 ? CATEGORY_ORDER.length : i;
}

interface BuiltinRule {
  /** Exact key, or a prefix when `prefix` is true. */
  match: string;
  prefix?: boolean;
  category: CategoryId;
  /** Fixed label, or a function of the key; absent = the type key. */
  label?: string | ((key: string) => string);
}

/**
 * Types without a capability declaration of their own. Exact rules are checked
 * before prefix rules; the first match wins.
 */
const BUILTIN_RULES: readonly BuiltinRule[] = [
  // Drives
  { match: 'DrivePulseEncoder', category: 'drives', label: 'Pulse Encoders' },
  { match: 'DrivesRecorder', category: 'drives', label: 'Recorders' },
  { match: 'Drive_', prefix: true, category: 'drives' },
  // Material flow
  { match: 'Source', category: 'material-flow', label: 'Sources' },
  { match: 'Sink', category: 'material-flow', label: 'Sinks' },
  { match: 'MU', category: 'material-flow', label: 'MUs' },
  { match: 'DES', prefix: true, category: 'material-flow' },
  // Robotics
  { match: 'Grip', category: 'robotics', label: 'Grips' },
  { match: 'GripTarget', category: 'robotics', label: 'Grip Targets' },
  // Signals
  { match: 'ConnectSignal', category: 'signals' },
  { match: 'PLCInput', prefix: true, category: 'signals' },
  { match: 'PLCOutput', prefix: true, category: 'signals' },
  // Logic
  { match: 'RVPlcProgram', category: 'logic', label: 'PLC Programs' },
  { match: 'LogicStep_', prefix: true, category: 'logic', label: (k) => k.slice('LogicStep_'.length) || k },
  // HMI (Web* markers without a filter of their own)
  { match: 'WebSafetyDoor', category: 'hmi', label: 'Safety Doors' },
  { match: 'WebDiagnostics', category: 'hmi', label: 'Diagnostics' },
  { match: 'WebOperatorPanel', category: 'hmi', label: 'Operator Panels' },
  { match: 'SceneButtonMoveable', category: 'hmi', label: 'Buttons' },
  // Physics
  { match: 'BoxCollider', category: 'physics', label: 'Box Colliders' },
  { match: 'WebPhysicsZone', category: 'physics', label: 'Physics Zones' },
];

const EXACT_RULES = new Map<string, BuiltinRule>();
const PREFIX_RULES: BuiltinRule[] = [];
for (const rule of BUILTIN_RULES) {
  if (rule.prefix) PREFIX_RULES.push(rule);
  else EXACT_RULES.set(rule.match, rule);
}

function ruleFor(key: string): BuiltinRule | null {
  const exact = EXACT_RULES.get(key);
  if (exact) return exact;
  for (const rule of PREFIX_RULES) {
    if (key.length > rule.match.length && key.startsWith(rule.match)) return rule;
  }
  return null;
}

function ruleLabel(rule: BuiltinRule, key: string): string {
  if (typeof rule.label === 'function') return rule.label(key);
  return rule.label ?? key;
}

const INSTANCE_SUFFIX = /_\d+$/;

const cache = new Map<string, TypeCategory>();
let cacheEpoch = -1;
const warnedUnknown = new Set<string>();

function resolve(typeKey: string): TypeCategory {
  const registered = getRegisteredCapabilities();
  let capsKey: string | null = registered.has(typeKey) ? typeKey : null;
  const base = typeKey.replace(INSTANCE_SUFFIX, '');
  if (capsKey === null && base !== typeKey && registered.has(base)) capsKey = base;

  const ui = capsKey !== null ? getCapabilities(capsKey).ui : null;
  const declared = ui?.category ?? null;
  const filterLabel = ui?.filter ?? null;

  if (declared !== null) {
    if (isCategoryId(declared)) return { category: declared, label: filterLabel ?? capsKey ?? typeKey };
    if (import.meta.env.DEV && !warnedUnknown.has(typeKey)) {
      warnedUnknown.add(typeKey);
      console.warn(`[rv] ui.category '${declared}' of '${typeKey}' is not a known category — shown under 'other'`);
    }
    return { category: 'other', label: filterLabel ?? typeKey };
  }

  // The base key first: `LogicStep_Delay_1` is a second `LogicStep_Delay`, not
  // a type of its own, and must land under the same label.
  let ruleKey = base;
  let rule = ruleFor(base);
  if (rule === null && base !== typeKey) {
    rule = ruleFor(typeKey);
    ruleKey = typeKey;
  }
  if (rule) {
    return { category: rule.category, label: filterLabel ?? ruleLabel(rule, ruleKey) };
  }
  return { category: 'other', label: filterLabel ?? typeKey };
}

/**
 * Category + fine label of a component type key. Memoised per key; the memo is
 * dropped whenever a capability registration changes the registry.
 */
export function categoryOf(typeKey: string): TypeCategory {
  const epoch = getCapabilitiesEpoch();
  if (epoch !== cacheEpoch) {
    cache.clear();
    cacheEpoch = epoch;
  }
  let hit = cache.get(typeKey);
  if (hit === undefined) {
    hit = Object.freeze(resolve(typeKey)) as TypeCategory;
    cache.set(typeKey, hit);
  }
  return hit;
}

/** Drop the memo and the DEV warning set (test-only). */
export function _resetCategoryCacheForTesting(): void {
  cache.clear();
  cacheEpoch = -1;
  warnedUnknown.clear();
}
