// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-signal-activity — pure, testable derivation of a signal's activity state.
 *
 * Framework-agnostic (no Three.js, no React, no `Date.now()`). The state is
 * purely **connection-based**: `stale` means the supplying interface is *not
 * connected*, never merely that the value has not changed for a while. A signal
 * whose interface is up stays `live` no matter how long its value stays
 * constant (a static bool must not decay to `stale`).
 *
 * Levels of information:
 *   - **Connected?** Does the signal have a source (`SignalMeta.source`) and is
 *     the supplying interface currently connected?
 *   - **Ever written?** `lastUpdateTs` only distinguishes `live` (at least one
 *     real write) from `supplied` (connected, nothing received yet). It is NOT
 *     compared against a freshness window.
 *
 * The resulting `SignalActivity` distinguishes supplied/live signals from
 * locally simulated (standalone), disconnected (`stale`) and truly dead
 * (`no-source`) signals so the HMI can render them distinctly.
 */

/**
 * Discrete activity state of a signal.
 *   - `live`      — supplied by a connected source and written at least once.
 *   - `supplied`  — assigned to a connected source, but no update received yet.
 *   - `local`     — no interface; locally simulated (normal & active in standalone).
 *   - `stale`     — source known but the supplying interface is disconnected.
 *   - `no-source` — no interface and no activity — a "dead" signal.
 */
export type SignalActivity = 'live' | 'supplied' | 'local' | 'stale' | 'no-source';

/** Input to {@link deriveSignalActivity}. All time values in milliseconds. */
export interface SignalActivityInput {
  /** Whether the signal has a `SignalMeta.source` (assigned to an interface). */
  hasSource: boolean;
  /** Whether the supplying interface is currently connected. */
  sourceConnected: boolean;
  /** Timestamp of the last real adapter/sim write, or undefined if never written. */
  lastUpdateTs: number | undefined;
  /** Current viewer operating mode. */
  mode: 'standalone' | 'live' | 'direct';
}

/**
 * Derive the activity state of a signal from its connection state alone.
 *
 * Rules:
 *   - Standalone mode without a source → `local` (locally simulated, not dead).
 *   - Source present & connected → `live` if it was ever written, else `supplied`.
 *     No freshness window: a connected signal never decays to `stale` just
 *     because its value stopped changing.
 *   - Source present but disconnected → `stale` (the only cause of `stale`).
 *   - Otherwise (no source, live/direct mode) → `no-source`.
 */
export function deriveSignalActivity(i: SignalActivityInput): SignalActivity {
  // Standalone with no interface: normal locally simulated signal — active, not dead.
  if (i.mode === 'standalone' && !i.hasSource) {
    return 'local';
  }

  if (i.hasSource) {
    // Source known but interface disconnected → stale (regardless of last value).
    if (!i.sourceConnected) {
      return 'stale';
    }
    // Connected: live once anything has been written, otherwise still supplied.
    return i.lastUpdateTs !== undefined ? 'live' : 'supplied';
  }

  // No source in live/direct mode — nothing supplies this signal.
  return 'no-source';
}

// ── Pure display helpers (plan-234 Phase 4, ISA-101 gray-first + A11y) ──────

/**
 * Whether an activity state should be rendered as *inactive* (dimmed) in the
 * signal list. Only `stale` and `no-source` are inactive; `live`, `supplied`
 * and `local` are normal/active. Pure & testable (no React).
 */
export function activityIsInactive(activity: SignalActivity): boolean {
  return activity === 'stale' || activity === 'no-source';
}

/** Opacity applied to a signal row for a given activity — inactive rows are dimmed. */
export const INACTIVE_ROW_OPACITY = 0.45;

/**
 * Row opacity for an activity state: {@link INACTIVE_ROW_OPACITY} for inactive
 * (stale / no-source) signals, `1` otherwise. Pure & testable.
 */
export function activityOpacity(activity: SignalActivity): number {
  return activityIsInactive(activity) ? INACTIVE_ROW_OPACITY : 1;
}

/**
 * Classification of the status marker a row should show for an activity state
 * (A11y: never color alone — pairs with opacity + a text hint in the row).
 *   - `stale`     → `'warn'`  (a warning triangle — source known but no fresh data)
 *   - `no-source` → `'empty'` (a "no data" / ∅ marker — nothing supplies this signal)
 *   - live / supplied / local → `'none'` (normal state, no extra marker)
 *
 * The concrete MUI icon is chosen in the component from this pure classification.
 */
export type SignalStatusMarker = 'warn' | 'empty' | 'none';

/** Map a {@link SignalActivity} to its row {@link SignalStatusMarker}. Pure & testable. */
export function activityStatusMarker(activity: SignalActivity): SignalStatusMarker {
  if (activity === 'stale') return 'warn';
  if (activity === 'no-source') return 'empty';
  return 'none';
}

/**
 * Short A11y text hint accompanying the status marker (never rely on color/icon
 * alone). Empty for the normal (active) states so the row stays neutral.
 *   - `stale`     → "stale"
 *   - `no-source` → "no data"
 *   - otherwise   → ""
 */
export function activityStatusHint(activity: SignalActivity): string {
  if (activity === 'stale') return 'stale';
  if (activity === 'no-source') return 'no data';
  return '';
}
