// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { readLocalStorage, removeLocalStorage, writeLocalStorage } from '../../core/rv-safe-storage';

/**
 * snap-toolbar-store — Persisted "Show all snap-points" toggle.
 *
 * Mirrors the layout-planner's localStorage-backed booleans (rv-layout-store).
 */

import { useSyncExternalStore } from 'react';

const LS_KEY = 'rv-snap-show-all-v1';

interface SnapToolbarState {
  showAllSnaps: boolean;
}

function _readInitial(): SnapToolbarState {
  try {
    const v = readLocalStorage(LS_KEY);
    return { showAllSnaps: v === 'true' };
  } catch {
    return { showAllSnaps: false };
  }
}

let _state: SnapToolbarState = _readInitial();
const _listeners = new Set<() => void>();

function _notify(): void {
  for (const fn of _listeners) fn();
}

export const snapToolbarStore = {
  getState(): SnapToolbarState {
    return _state;
  },

  subscribe(listener: () => void): () => void {
    _listeners.add(listener);
    return () => { _listeners.delete(listener); };
  },

  setShowAllSnaps(show: boolean): void {
    if (_state.showAllSnaps === show) return;
    _state = { showAllSnaps: show };
    try { writeLocalStorage(LS_KEY, show ? 'true' : 'false'); } catch { /* ignore */ }
    _notify();
  },

  /** Test-only: reset state and clear localStorage. */
  _reset(): void {
    _state = { showAllSnaps: false };
    try { removeLocalStorage(LS_KEY); } catch { /* ignore */ }
    _notify();
  },
};

export function useSnapToolbarState(): SnapToolbarState {
  return useSyncExternalStore(snapToolbarStore.subscribe, snapToolbarStore.getState);
}
