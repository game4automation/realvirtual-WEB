// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * key-badge-store — Blender-style "screencast keys" badge state.
 *
 * Shows which shortcut keys the user hit, as a chord: pressing S in the
 * editor shows `S`; picking Identical with I extends it to `S › I` plus the
 * resolved action label. Rendered by KeyBadgeLayer in the lower-left corner
 * of the viewport; auto-hides after a short delay (timer resets on every
 * push, so fast chords stay visible as one unit).
 *
 * Module singleton following the instruction-store pattern:
 * useSyncExternalStore-compatible subscribe/getSnapshot + plain push
 * functions callable from non-React code (key handlers, menu layer).
 */

import { useSyncExternalStore } from 'react';

export interface KeyBadgeSnapshot {
  /** Chord keys in press order, e.g. ['S', 'I']. */
  keys: readonly string[];
  /** Label of the action the chord resolved to (null while incomplete). */
  label: string | null;
  /** Monotonic sequence — lets the layer restart fade animations per push. */
  seq: number;
}

const HIDE_DELAY_MS = 1800;

let snapshot: KeyBadgeSnapshot | null = null;
let seq = 0;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function armHideTimer(): void {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    hideTimer = null;
    snapshot = null;
    notify();
  }, HIDE_DELAY_MS);
}

/** Start a new chord with a single key (e.g. the S that opened a picker). */
export function showKeyBadge(key: string, label?: string): void {
  snapshot = { keys: [key], label: label ?? null, seq: ++seq };
  armHideTimer();
  notify();
}

/** Extend the visible chord (or start a new one when none is visible). */
export function appendKeyBadge(key: string, label?: string): void {
  const keys = snapshot ? [...snapshot.keys, key] : [key];
  snapshot = { keys, label: label ?? null, seq: ++seq };
  armHideTimer();
  notify();
}

/** Hide immediately (rarely needed — the timer handles the normal case). */
export function hideKeyBadge(): void {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (snapshot) {
    snapshot = null;
    notify();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Current badge state (null while hidden) — non-React consumers and tests. */
export function getKeyBadgeSnapshot(): KeyBadgeSnapshot | null {
  return snapshot;
}

/** React hook for KeyBadgeLayer. */
export function useKeyBadge(): KeyBadgeSnapshot | null {
  return useSyncExternalStore(subscribe, getKeyBadgeSnapshot);
}
