// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * des-stats-window-store.ts — shared open-state for the DES Statistics chart
 * window, so it can be toggled from MULTIPLE places (the toolbar button and an
 * in-scene stats badge click) without prop-drilling. Mirrors the
 * event-queue-window-store pattern (useSyncExternalStore-friendly).
 *
 * PUBLIC (lives in the public package) so the private DES plugin's button and the
 * private in-scene badges can both drive it.
 */

let open = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function isDesStatsWindowOpen(): boolean {
  return open;
}

export function setDesStatsWindowOpen(next: boolean): void {
  if (next === open) return;
  open = next;
  emit();
}

export function toggleDesStatsWindow(): void {
  open = !open;
  emit();
}

export function subscribeDesStatsWindow(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
