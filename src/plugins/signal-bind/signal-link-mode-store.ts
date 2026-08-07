// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { getSignalDragPhase, subscribeSignalDrag } from '../../core/hmi/signal-drag-store';

export const SIGNAL_LINK_MODE_STORAGE_KEY = 'rv-layout-signal-link-mode';

export interface SignalLinkModeSnapshot {
  explicit: boolean;
  active: boolean;
}

let initialized = false;
let explicit = false;
let snapshot: SignalLinkModeSnapshot = { explicit: false, active: false };
const listeners = new Set<() => void>();

function readPersistedExplicit(): boolean {
  try {
    return localStorage.getItem(SIGNAL_LINK_MODE_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;
  explicit = readPersistedExplicit();
  snapshot = {
    explicit,
    active: explicit || getSignalDragPhase() === 'dragging',
  };
}

function publishIfChanged(): void {
  ensureInitialized();
  const active = explicit || getSignalDragPhase() === 'dragging';
  if (snapshot.explicit === explicit && snapshot.active === active) return;
  snapshot = { explicit, active };
  for (const listener of listeners) listener();
}

subscribeSignalDrag(publishIfChanged);

export function getSignalLinkModeSnapshot(): SignalLinkModeSnapshot {
  ensureInitialized();
  return snapshot;
}

export function isSignalLinkModeActive(): boolean {
  return getSignalLinkModeSnapshot().active;
}

export function setSignalLinkModeExplicit(enabled: boolean): void {
  ensureInitialized();
  if (explicit === enabled) return;
  explicit = enabled;
  try {
    localStorage.setItem(SIGNAL_LINK_MODE_STORAGE_KEY, String(enabled));
  } catch {
    // Persistence is best-effort; the in-memory mode remains usable.
  }
  publishIfChanged();
}

export function subscribeSignalLinkMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Test-only reset for deterministic localStorage migration coverage. */
export function _resetSignalLinkModeStoreForTests(): void {
  initialized = false;
  explicit = false;
  snapshot = { explicit: false, active: false };
  listeners.clear();
}
