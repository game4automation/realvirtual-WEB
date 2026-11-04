// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * path-network-signal — the module signal `network-changed` (plan-628 E12):
 * fired after a completed document change of the path network (commit, undo,
 * redo). Own module so the visualizer can listen without importing the
 * commands (which import the visualizer).
 */

const changeListeners = new Set<() => void>();

/** Subscribe to "the path network changed" (commit, undo, redo). Returns the unsubscribe. */
export function onPathNetworkChanged(cb: () => void): () => void {
  changeListeners.add(cb);
  return () => { changeListeners.delete(cb); };
}

/** Notify every listener; a failing listener does not stop the others. */
export function emitPathNetworkChanged(): void {
  for (const cb of [...changeListeners]) {
    try { cb(); } catch (e) { console.error('[path-network] network-changed listener failed:', e); }
  }
}
