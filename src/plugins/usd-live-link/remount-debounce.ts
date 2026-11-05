// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Remount debounce of the USD live link (plan-2239 Phase 3): the quiet time
 * after the last structure change before the remount. Lives in the lazy
 * session / menu chunks, not in the entry-side store (plan-779 eager ratchet);
 * the store persists the raw value, every reader clamps.
 */

export const LIVE_LINK_MIN_REMOUNT_MS = 250;
export const LIVE_LINK_MAX_REMOUNT_MS = 5000;
export const LIVE_LINK_DEFAULT_REMOUNT_MS = 750;

/** Clamp a remount debounce into the supported range (default for anything not a number). */
export function clampRemountMs(ms: unknown): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return LIVE_LINK_DEFAULT_REMOUNT_MS;
  return Math.min(LIVE_LINK_MAX_REMOUNT_MS, Math.max(LIVE_LINK_MIN_REMOUNT_MS, Math.round(ms)));
}
