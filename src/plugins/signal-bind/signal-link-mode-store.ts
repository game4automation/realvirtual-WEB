// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { readLocalStorage, writeLocalStorage } from '../../core/rv-safe-storage';

import { getSignalDragPhase, subscribeSignalDrag } from '../../core/hmi/signal-drag-store';

export const SIGNAL_LINK_MODE_STORAGE_KEY = 'rv-layout-signal-link-mode';

export interface SignalLinkModeSnapshot {
  explicit: boolean;
  active: boolean;
}

let initialized = false;
let explicit = false;
/** Link mode rests (DES, plan-2010): `explicit` is kept, `active` ignores it. */
let suspended = false;
let snapshot: SignalLinkModeSnapshot = { explicit: false, active: false };
const listeners = new Set<() => void>();

function readPersistedExplicit(): boolean {
  try {
    return readLocalStorage(SIGNAL_LINK_MODE_STORAGE_KEY) === 'true';
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
    active: computeActive(),
  };
}

/** The switch counts unless the mode rests; a running signal drag always counts. */
function computeActive(): boolean {
  return (explicit && !suspended) || getSignalDragPhase() === 'dragging';
}

function publishIfChanged(): void {
  ensureInitialized();
  const active = computeActive();
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
    writeLocalStorage(SIGNAL_LINK_MODE_STORAGE_KEY, String(enabled));
  } catch {
    // Persistence is best-effort; the in-memory mode remains usable.
  }
  publishIfChanged();
}

/**
 * Let the link mode rest (`true`) or apply again (`false`) — plan-2010. Used
 * while the workspace is DES: the toolbar switch is not offered there, so a mode
 * that was left on in the planner must neither draw badges nor swallow object
 * tooltips. Only `active` changes: the stored switch (`explicit`, localStorage)
 * is untouched, and an inspector drag-link in progress still counts.
 */
export function setSignalLinkModeSuspended(value: boolean): void {
  ensureInitialized();
  if (suspended === value) return;
  suspended = value;
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
  suspended = false;
  snapshot = { explicit: false, active: false };
  listeners.clear();
}
