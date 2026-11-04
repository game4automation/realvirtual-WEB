// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * UI Context Store — Data-driven visibility for HMI elements.
 *
 * Manages a set of active "contexts" (e.g. 'fpv', 'planner', 'maintenance', 'xr')
 * and a map of visibility rules per UI element. Components subscribe via
 * `useUIVisible()` (useSyncExternalStore) — zero overhead when contexts don't change.
 *
 * Composes with existing `hmiVisible` (H key) toggle via AND logic in App.tsx:
 *   {hmiVisible && showKpiBar && <KpiBar />}
 */

import { useSyncExternalStore } from 'react';

// ─── Types ──────────────────────────────────────────────────────────────

/** Well-known context identifiers + extensible via any string. */
export type UIContext = 'fpv' | 'planner' | 'maintenance' | 'xr' | 'kiosk' | string;

/** Visibility rule for a named UI element. */
export interface UIVisibilityRule {
  /** Element is hidden when ANY of these contexts is active. */
  hiddenIn?: UIContext[];
  /** Element is visible ONLY when ALL of these contexts are active. */
  shownOnlyIn?: UIContext[];
  /** Element is visible ONLY when AT LEAST ONE of these contexts is active (OR
   *  semantics). Used for multi-mode plugins (e.g. `['mode:hmi','mode:des']`)
   *  where exactly one mode context is ever active. Combined with `shownOnlyIn`
   *  / `hiddenIn` via AND. */
  shownOnlyInAny?: UIContext[];
}

// ─── Module-Level Singleton State ───────────────────────────────────────

let _activeContexts = new Set<string>();
let _registeredRules = new Map<string, UIVisibilityRule>();
const _listeners = new Set<() => void>();

/** Immutable snapshot for useSyncExternalStore — replaced on every change. */
let _snapshot: ReadonlySet<string> = new Set<string>();

/** Rule version counter — bumped on registerUIElement so components re-evaluate. */
let _ruleVersion = 0;

/** Combined version used as the useSyncExternalStore snapshot key. */
let _storeVersion = 0;

// ─── Internal: Notification ─────────────────────────────────────────────

function _notify(): void {
  _snapshot = new Set(_activeContexts);
  _storeVersion++;
  for (const fn of _listeners) fn();
}

// ─── Context Management ─────────────────────────────────────────────────

/** Add a context to the active set. No-op if already active. */
export function activateContext(ctx: UIContext): void {
  if (_activeContexts.has(ctx)) return;
  _activeContexts.add(ctx);
  _notify();
}

/** Remove a context from the active set. No-op if not active. */
export function deactivateContext(ctx: UIContext): void {
  if (!_activeContexts.has(ctx)) return;
  _activeContexts.delete(ctx);
  _notify();
}

/** Convenience: activate or deactivate a context. */
export function setContext(ctx: UIContext, active: boolean): void {
  if (active) activateContext(ctx);
  else deactivateContext(ctx);
}

/** Check whether a context is currently active. */
export function isContextActive(ctx: UIContext): boolean {
  return _activeContexts.has(ctx);
}

/** Get an immutable snapshot of all active contexts. */
export function getActiveContexts(): ReadonlySet<string> {
  return _snapshot;
}

/**
 * Clear all contexts except the given initial ones.
 * Called on model switch as a safety net to prevent stale contexts.
 */
export function resetDynamicContexts(initialContexts?: string[]): void {
  const keep = new Set(initialContexts ?? []);
  _activeContexts = new Set(keep);
  _notify();
}

// ─── Rule Registration ──────────────────────────────────────────────────

/**
 * Register (or override) a visibility rule for a named UI element.
 * Later calls overwrite earlier rules for the same ID.
 *
 * IMPORTANT: SlotRenderer calls this DURING render for entries carrying a
 * `visibilityRule` (plan-198 mode-gated slots inject one). Notifying on every
 * call would bump the context store mid-render and re-trigger SlotRenderer →
 * infinite render loop (page hangs). So we no-op when the rule object is
 * unchanged (same reference) — slot entries hold a stable rule object across
 * renders, so the first registration notifies once and subsequent renders skip.
 */
export function registerUIElement(id: string, rule: UIVisibilityRule): void {
  if (_registeredRules.get(id) === rule) return; // unchanged → no notify (prevents render loop)
  _registeredRules.set(id, rule);
  _ruleVersion++;
  _notify(); // trigger re-evaluation in subscribed components
}

/**
 * Register `rule` as the code-declared default for `id` unless a rule already
 * exists (a deployment override or an earlier default wins) — the non-React
 * twin of what {@link useUIVisible} does on its first call. No notification:
 * the effective visibility of an id nobody had registered does not change for
 * any subscriber that already evaluated it through `useUIVisible`.
 */
export function ensureUIElementRule(id: string, rule: UIVisibilityRule): void {
  if (!_registeredRules.has(id)) _registeredRules.set(id, rule);
}

/** The rule currently registered for `id` (config override or code default), if any. */
export function getUIElementRule(id: string): UIVisibilityRule | undefined {
  return _registeredRules.get(id);
}

// ─── Visibility Evaluation (Pure Function) ──────────────────────────────

/**
 * Evaluate whether a UI element should be visible given the active contexts.
 *
 * Precedence:
 *   1. Unknown element (no rule) → visible
 *   2. `shownOnlyInAny` defined and NO listed context active → hidden (OR gate)
 *   3. `shownOnlyIn` defined and not ALL listed contexts active → hidden
 *   4. `hiddenIn` — if ANY listed context is active → hidden
 *   5. Otherwise → visible
 */
export function isUIElementVisible(id: string, contexts: ReadonlySet<string>): boolean {
  const rule = _registeredRules.get(id);
  if (!rule) return true; // no rule = always visible
  return evaluateVisibilityRule(rule, contexts);
}

/**
 * Pure evaluator for an arbitrary `UIVisibilityRule` against the active
 * contexts — same precedence as `isUIElementVisible` but operates on a rule
 * object directly, no registration / id required.
 *
 * Use this in places that hold rules inline (e.g. UISlotEntry.visibilityRule)
 * and want to gate rendering without going through the registry.
 */
export function evaluateVisibilityRule(
  rule: UIVisibilityRule,
  contexts: ReadonlySet<string>,
): boolean {
  if (rule.shownOnlyInAny && rule.shownOnlyInAny.length > 0) {
    const anyPresent = rule.shownOnlyInAny.some((c) => contexts.has(c));
    if (!anyPresent) return false;
  }
  if (rule.shownOnlyIn && rule.shownOnlyIn.length > 0) {
    const allPresent = rule.shownOnlyIn.every((c) => contexts.has(c));
    if (!allPresent) return false;
  }
  if (rule.hiddenIn && rule.hiddenIn.length > 0) {
    for (const c of rule.hiddenIn) {
      if (contexts.has(c)) return false;
    }
  }
  return true;
}

// ─── React Hooks ────────────────────────────────────────────────────────

/**
 * Subscribe to store changes (useSyncExternalStore compatible).
 * Exported as `_subscribe` for testing.
 */
export function _subscribe(listener: () => void): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

/**
 * React hook: returns whether a UI element is visible in the current context.
 *
 * If a `rule` is provided and the element is not yet registered, it registers
 * the rule as the default (code-declared default, can be overridden by config).
 */
export function useUIVisible(id: string, rule?: UIVisibilityRule): boolean {
  // Register default rule on first call (idempotent — later config overrides win)
  if (rule && !_registeredRules.has(id)) {
    _registeredRules.set(id, rule);
  }

  return useSyncExternalStore(
    _subscribe,
    () => isUIElementVisible(id, _snapshot),
  );
}

/** React hook: returns the current set of active contexts. */
export function useActiveContexts(): ReadonlySet<string> {
  return useSyncExternalStore(
    _subscribe,
    () => _snapshot,
  );
}

// ─── Test Helpers ───────────────────────────────────────────────────────

/** Test-only: reset all state for test isolation. */
export function _resetStore(): void {
  _activeContexts = new Set();
  _registeredRules = new Map();
  _snapshot = new Set();
  _storeVersion = 0;
  _ruleVersion = 0;
  _listeners.clear();
}
