// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * reconnect-policy — shared exponential-backoff policy for industrial
 * interface reconnects.
 *
 * Single source of truth for the backoff constants and formula used by both
 * the main-thread interfaces (base-industrial-interface.ts) and the worker
 * transport (signal-transport-core.ts). This module is deliberately DOM-free
 * and UI-free so it can run inside a Worker.
 */

/** Initial reconnect delay in milliseconds. */
export const RECONNECT_INITIAL_MS = 500;

/** Upper bound for the reconnect delay in milliseconds. */
export const RECONNECT_MAX_MS = 30_000;

/** Exponential growth factor per attempt. */
export const RECONNECT_FACTOR = 2.0;

/** Exponential backoff delay for reconnect attempt `attempt` (zero-based). */
export function reconnectDelay(attempt: number): number {
  const delay = RECONNECT_INITIAL_MS * Math.pow(RECONNECT_FACTOR, attempt);
  return Math.min(delay, RECONNECT_MAX_MS);
}
