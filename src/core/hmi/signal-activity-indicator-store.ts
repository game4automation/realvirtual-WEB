// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * signal-activity-indicator-store.ts — feature flag for the signal-list activity
 * indicator (plan-234 Phase 4, §10-H).
 *
 * When ON (the default), the ConnectPanel signal list dims inactive signals
 * (stale / no-source) and shows a status icon + text hint. When OFF, the list
 * renders exactly as before (no opacity change, no status icons) — a runtime
 * rollback that keeps Phases 1–3 untouched.
 *
 * Tiny global store persisted in localStorage, modeled on hmi-visibility-store.
 */

import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'rv-signal-activity-indicator';

let enabled = loadInitial();
const listeners = new Set<() => void>();

function loadInitial(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    // Default ON: only an explicit '0' turns it off.
    return raw === null ? true : raw === '1';
  } catch {
    return true;
  }
}

function notify() {
  for (const fn of listeners) fn();
}

/** Enable/disable the signal-list activity indicator (persisted). */
export function setSignalActivityIndicator(value: boolean): void {
  if (enabled === value) return;
  enabled = value;
  try { localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0'); } catch { /* ignore */ }
  notify();
}

/** Toggle the signal-list activity indicator (persisted). */
export function toggleSignalActivityIndicator(): void {
  setSignalActivityIndicator(!enabled);
}

/** Current feature-flag value (non-React read). */
export function getSignalActivityIndicator(): boolean {
  return enabled;
}

/** Subscribe to feature-flag changes (non-React). Returns an unsubscribe fn. */
export function subscribeSignalActivityIndicator(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** React hook — triggers re-render when the flag changes. */
export function useSignalActivityIndicator(): boolean {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => enabled,
  );
}
