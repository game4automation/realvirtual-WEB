// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * event-queue-window-store — tiny shared open-state for the DES Event Queue
 * window. PUBLIC so the DES toolbar button (public `DESControllerToolbar`) and
 * the private window overlay (`@rv-private/.../event-queue-overlay`) share one
 * source of truth across the repo boundary: the button toggles, the private
 * overlay renders the actual `DESEventQueueWindow` when open.
 *
 * `useSyncExternalStore`-compatible (subscribe + a stable getSnapshot).
 */

let _open = false;
const _listeners = new Set<() => void>();
function _emit(): void { for (const l of _listeners) l(); }

/** Subscribe to open-state changes (useSyncExternalStore). */
export function subscribeEventQueueWindow(listener: () => void): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

/** Current open state (useSyncExternalStore getSnapshot). */
export function isEventQueueWindowOpen(): boolean { return _open; }

/** Toggle the window. */
export function toggleEventQueueWindow(): void { _open = !_open; _emit(); }

/** Explicitly set the open state. */
export function setEventQueueWindowOpen(open: boolean): void {
  if (_open === open) return;
  _open = open;
  _emit();
}
