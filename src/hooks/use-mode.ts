// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * useMode — React binding for the workspace ModeManager (plan-198).
 *
 * Subscribes to mode changes via useSyncExternalStore and returns the active
 * mode, the sorted list of registered modes, and a setMode callback.
 *
 * Usage:
 *   const { active, modes, setMode } = useMode();
 */

import { useSyncExternalStore } from 'react';
import { useViewer } from './use-viewer';
import type { ModeId, ModeDescriptor } from '../core/rv-mode-manager';

export interface UseModeResult {
  /** Active mode id, or null before the first switch. */
  active: ModeId | null;
  /** Registered modes, sorted by order (for the dropdown). */
  modes: ModeDescriptor[];
  /**
   * Switch to a mode through the GUARDED path (runs the leaving mode's exit
   * guards, e.g. the asset editor's unsaved-changes prompt). No-op if already
   * active / unknown / switching / locked / vetoed.
   */
  setMode: (id: ModeId) => void;
  /** True when the workspace is locked to a single mode (dropdown hidden). */
  locked: boolean;
}

export function useMode(): UseModeResult {
  const viewer = useViewer();
  // Re-render whenever the active mode (or registry, or lock state) changes.
  useSyncExternalStore(viewer.modes.subscribe, viewer.modes.getSnapshot);
  return {
    active: viewer.modes.activeMode,
    modes: viewer.modes.list(),
    setMode: (id: ModeId) => { void viewer.modes.requestMode(id); },
    locked: viewer.modes.lockedMode !== null,
  };
}
