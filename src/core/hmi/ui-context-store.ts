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
 */
export function registerUIElement(id: string, rule: UIVisibilityRule): void {
  _registeredRules.set(id, rule);
  _ruleVersion++;
  _notify(); // trigger re-evaluation in subscribed components
}

// ─── Visibility Evaluation (Pure Function) ──────────────────────────────

/**
 * Evaluate whether a UI element should be visible given the active contexts.
 *
 * Precedence:
 *   1. Unknown element (no rule) → visible
 *   2. `shownOnlyIn` defined and not ALL listed contexts active → hidden
 *   3. `hiddenIn` — if ANY listed context is active → hidden
 *   4. Otherwise → visible
 */
export function isUIElementVisible(id: string, contexts: ReadonlySet<string>): boolean {
  const rule = _registeredRules.get(id);
  if (!rule) return true; // no rule = always visible

  // shownOnlyIn: requires ALL listed contexts to be active
  if (rule.shownOnlyIn && rule.shownOnlyIn.length > 0) {
    const allPresent = rule.shownOnlyIn.every((c) => contexts.has(c));
    if (!allPresent) return false;
  }

  // hiddenIn: hidden when ANY listed context is active
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
