// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * signal-display-store.ts — user preferences for how signal chips + tooltips render.
 *
 * Persisted in localStorage (survives reload). Configured under Settings ▸ Interfaces:
 *  - chipVariant: the global signal-chip display variant (plan-246 F2/F3)
 *      'full'     → name (dot notation) + type label + value ("Conveyor.Start OutBool ●")
 *      'standard' → name + value                             ("Conveyor.Start ●")
 *      'minimal'  → I/O direction + value                    ("O ●")
 *    Every SignalBadge without an explicit `variant` prop renders with this
 *    global default; a `variant` prop on the badge wins over the global setting.
 *  - tooltip: which extra lines are visible in the signal hover tooltip
 *    (the name is always shown).
 *
 * Migration: the pre-plan-246 setting `chipTypeLabel: 'full' | 'short' | 'none'`
 * is migrated on load (full→full, short→standard, none→minimal) and re-persisted
 * under the new key — no stale API remains.
 */

import { useSyncExternalStore } from 'react';

/** The three normalized signal-chip display variants (plan-246 F2). */
export type SignalChipVariant = 'full' | 'standard' | 'minimal';

export interface SignalTooltipFields {
  value: boolean;    // "Input · Bool · True"
  address: boolean;  // "%I0.6 · MQTT" + interface origin
  comment: boolean;  // free-text comment
  binding: boolean;  // "Sensor · Conveyor01/EndStop" (all bindings, clickable)
}

export interface SignalDisplaySettings {
  chipVariant: SignalChipVariant;
  tooltip: SignalTooltipFields;
}

const STORAGE_KEY = 'rv-signal-display';

const DEFAULTS: SignalDisplaySettings = {
  chipVariant: 'full',
  tooltip: { value: true, address: true, comment: true, binding: true },
};

/**
 * Resolve the chip variant from a persisted (possibly legacy) settings blob.
 * Pure & exported for tests. Accepts the new `chipVariant` key directly and
 * migrates the legacy `chipTypeLabel` values: full→full, short→standard,
 * none→minimal. Anything unknown falls back to the default ('full').
 */
export function migrateChipVariant(parsed: {
  chipVariant?: unknown;
  chipTypeLabel?: unknown;
}): SignalChipVariant {
  const v = parsed.chipVariant;
  if (v === 'full' || v === 'standard' || v === 'minimal') return v;
  const legacy = parsed.chipTypeLabel;
  if (legacy === 'full') return 'full';
  if (legacy === 'short') return 'standard';
  if (legacy === 'none') return 'minimal';
  return DEFAULTS.chipVariant;
}

let state = loadInitial();
const listeners = new Set<() => void>();

function loadInitial(): SignalDisplaySettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<SignalDisplaySettings> & { chipTypeLabel?: unknown };
    return {
      chipVariant: migrateChipVariant(parsed),
      tooltip: { ...DEFAULTS.tooltip, ...(parsed.tooltip ?? {}) },
    };
  } catch {
    return DEFAULTS;
  }
}

function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
}

function notify() {
  for (const fn of listeners) fn();
}

/** Non-React read of the current settings (stable ref until a change). */
export function getSignalDisplaySettings(): SignalDisplaySettings {
  return state;
}

/** Set the global signal-chip display variant (persisted). */
export function setChipVariant(variant: SignalChipVariant): void {
  if (state.chipVariant === variant) return;
  state = { ...state, chipVariant: variant };
  persist();
  notify();
}

/** Toggle one tooltip field on/off (persisted). */
export function setTooltipField(key: keyof SignalTooltipFields, value: boolean): void {
  if (state.tooltip[key] === value) return;
  state = { ...state, tooltip: { ...state.tooltip, [key]: value } };
  persist();
  notify();
}

/** React hook — re-renders on any change. */
export function useSignalDisplaySettings(): SignalDisplaySettings {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => state,
  );
}
