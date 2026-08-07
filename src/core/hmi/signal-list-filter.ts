// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * signal-list-filter.ts — pure, testable filtering for the ConnectPanel signal
 * list (plan-234 §3.4 / F8).
 *
 * The permanent "Filter signals…" text field is replaced by a collapsible filter
 * panel that bundles a text search with three facets: **Active** (activity
 * state), **Type** (Bool / Int / Float) and **Connected** (source connection).
 * All matching logic lives here as framework-agnostic functions (no React, no
 * MUI, no `Date.now()`) so it can be unit-tested directly and reused by the
 * `rows`-useMemo without pulling UI concerns into the hot path.
 */

import type { SignalActivity } from '../engine/rv-signal-activity';

/** The reduced PLC type kind used by the Type facet (empty when unknown). */
export type PlcTypeKind = 'Bool' | 'Int' | 'Float' | '';

/**
 * How an interface signal is coupled to the loaded model — the two coupling
 * mechanisms an operator needs to tell apart:
 *   - `auto`   — a model component references this exact signal NAME (defined in
 *               the GLB, e.g. `WebSensor.SignalBool = "MC02.07Q00B"`). Automatic,
 *               no user action: same name ⇒ coupled.
 *   - `manual` — the user LINKED a placed element's slot to this CONNECT signal in
 *               the Layout Planner (SignalBindingManager). Explicit, name-independent.
 *   - `none`   — neither: the signal is not used by the model (orphaned).
 */
export type SignalBindingKind = 'auto' | 'manual' | 'none';

/**
 * Filter state for the signal list. Replaces the old plain `filter: string`.
 *   - `text`      case-insensitive substring on name OR protocolAddress.
 *   - `active`    activity facet: all | active | inactive.
 *   - `types`     type facet: empty set = all types; otherwise membership test.
 *   - `connected` connection facet: all | connected | disconnected.
 *   - `binding`   model-coupling facet: all | auto | manual | none (see
 *                 {@link SignalBindingKind}). Purely static — never re-evaluated
 *                 on the value tick (see {@link filterNeedsActivity}).
 */
export interface SignalFilterState {
  text: string;
  active: 'all' | 'active' | 'inactive';
  types: Set<PlcTypeKind>;
  connected: 'all' | 'connected' | 'disconnected';
  binding: 'all' | SignalBindingKind;
  /** Historian facet: `'recorded'` shows only signals with the persisted Record flag (plan-209). */
  recorded: 'all' | 'recorded';
}

/** A fresh filter state with nothing selected (the "no filter" baseline). */
export function emptySignalFilterState(): SignalFilterState {
  return { text: '', active: 'all', types: new Set(), connected: 'all', binding: 'all', recorded: 'all' };
}

/**
 * Reduce a full PLC type (e.g. `PLCInputBool`, `PLCOutputFloat`) to the coarse
 * kind used by the Type facet. Mirrors the `Bool`/`Int`/`Float` split used by
 * `signalTypePhrase` — note `Int` is checked before `Float` (they are disjoint
 * substrings, but the order is kept identical to the badge helper for parity).
 */
export function plcTypeKind(plcType: string | undefined): PlcTypeKind {
  const t = plcType ?? '';
  if (t.includes('Bool')) return 'Bool';
  if (t.includes('Int')) return 'Int';
  if (t.includes('Float')) return 'Float';
  return '';
}

/**
 * Whether an {@link SignalActivity} counts as "active" for the Active facet.
 * Matches the plan mapping: `live` / `supplied` / `local` are active; `stale`
 * and `no-source` are inactive.
 */
export function activityIsActive(activity: SignalActivity): boolean {
  return activity === 'live' || activity === 'supplied' || activity === 'local';
}

/** Input row shape evaluated by {@link matchesSignalFilter}. */
export interface SignalFilterInput {
  name: string;
  protocolAddress: string;
  /** Coarse PLC kind (from {@link plcTypeKind}). */
  plcTypeKind: PlcTypeKind;
  /** Current activity state (from `signalStore.getActivity`). */
  activity: SignalActivity;
  /** Whether the signal's supplying source is currently connected. */
  connected: boolean;
  /** How the signal is coupled to the model (auto / manual / none). */
  binding: SignalBindingKind;
  /** Whether the signal carries the persisted historian Record flag (plan-209). */
  recorded: boolean;
}

/**
 * Pure predicate: does a signal pass the current filter? All facets are ANDed.
 *
 *   - **text**      — empty passes; otherwise a case-insensitive substring must
 *                     match `name` OR `protocolAddress` (identical to the old
 *                     permanent text field).
 *   - **active**    — `'active'` requires {@link activityIsActive}; `'inactive'`
 *                     requires NOT active; `'all'` always passes.
 *   - **types**     — empty set passes any type; otherwise `plcTypeKind` must be
 *                     a member of the set.
 *   - **connected** — `'connected'` requires `connected === true`; `'disconnected'`
 *                     requires `connected === false`; `'all'` always passes.
 *   - **binding**   — `'all'` always passes; otherwise the signal's coupling kind
 *                     (auto / manual / none) must equal the selected value.
 */
export function matchesSignalFilter(input: SignalFilterInput, f: SignalFilterState): boolean {
  // text — substring on name OR protocolAddress
  const q = f.text.trim().toLowerCase();
  if (q) {
    const hit =
      input.name.toLowerCase().includes(q) ||
      input.protocolAddress.toLowerCase().includes(q);
    if (!hit) return false;
  }

  // active facet
  if (f.active !== 'all') {
    const active = activityIsActive(input.activity);
    if (f.active === 'active' && !active) return false;
    if (f.active === 'inactive' && active) return false;
  }

  // type facet (empty set = all)
  if (f.types.size > 0 && !f.types.has(input.plcTypeKind)) return false;

  // connected facet
  if (f.connected === 'connected' && !input.connected) return false;
  if (f.connected === 'disconnected' && input.connected) return false;

  // binding facet (model coupling): 'all' passes, else must equal the signal's kind
  if (f.binding !== 'all' && f.binding !== input.binding) return false;

  // recorded facet (historian): static, config-driven — never re-evaluated on the value tick
  if (f.recorded === 'recorded' && !input.recorded) return false;

  return true;
}

/**
 * Count of active (non-default) facets, shown as the trigger badge so hidden
 * filters stay visible (A11y / expectability). A non-empty text counts as one;
 * `active`/`connected` count when not `'all'`; a non-empty `types` set counts.
 */
export function activeFilterCount(f: SignalFilterState): number {
  let n = 0;
  if (f.text.trim().length > 0) n++;
  if (f.active !== 'all') n++;
  if (f.types.size > 0) n++;
  if (f.connected !== 'all') n++;
  if (f.binding !== 'all') n++;
  if (f.recorded !== 'all') n++;
  return n;
}

/** True when any facet is active (used to generalize group-empty hiding). */
export function isSignalFilterActive(f: SignalFilterState): boolean {
  return activeFilterCount(f) > 0;
}

/**
 * True when the filter depends on time-variant facets (Active or Connected).
 * When false the filtering is purely static (text/type/binding) and does NOT need
 * to be re-evaluated on the value tick — the performance guard for plan-234 §5.2:
 * the facet filtering must not run at 60 Hz over hundreds/thousands of signals.
 * The `binding` facet is static (bindings change only on model load / planner edit,
 * not per value tick) so it is deliberately excluded here.
 */
export function filterNeedsActivity(f: SignalFilterState): boolean {
  return f.active !== 'all' || f.connected !== 'all';
}
