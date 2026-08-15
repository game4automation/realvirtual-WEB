// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * React hooks for drive state.
 *
 * Hover and focus are derived from the generic `object-hover` /
 * `object-focus` / `object-blur` events plus the registry — there are
 * no drive-specific hover/focus events any more.
 *
 * Usage:
 *   const drives = useDrives();                              // all drives
 *   const { drive, clientX, clientY } = useHoveredDrive();   // hovered drive + pointer pos
 *   const focused = useFocusedDrive();                       // drive pinned by card click / focusByPath
 */

import { useState, useEffect } from 'react';
import { useViewer } from './use-viewer';
import type { RVDrive } from '../core/engine/rv-drive';
import type { Object3D } from 'three';

export interface DriveHoverState {
  drive: RVDrive | null;
  clientX: number;
  clientY: number;
}

export interface DriveFocusState {
  drive: RVDrive | null;
  node: Object3D | null;
}

/** Returns the current list of drives. Updates on model-loaded / model-cleared
 *  and on every runtime change of the collection (`drives-changed`, plan-411
 *  Phase 1) — a drive added in the asset editor shows up in the list at once. */
export function useDrives(): RVDrive[] {
  const viewer = useViewer();
  const [drives, setDrives] = useState<RVDrive[]>(() => viewer.drives);

  useEffect(() => {
    // Sync in case model was loaded before component mounted
    setDrives(viewer.drives);

    const offLoaded = viewer.on('model-loaded', () => setDrives([...viewer.drives]));
    const offCleared = viewer.on('model-cleared', () => setDrives([]));
    const offChanged = viewer.on('drives-changed', () => setDrives([...viewer.drives]));
    return () => { offLoaded(); offCleared(); offChanged(); };
  }, [viewer]);

  return drives;
}

/** Returns the currently hovered drive (or null) with pointer position.
 *  Derived from `object-hover`: filters by `nodeType === 'Drive'` and
 *  resolves the RVDrive instance via the node registry. */
export function useHoveredDrive(): DriveHoverState {
  const viewer = useViewer();
  const [state, setState] = useState<DriveHoverState>({ drive: null, clientX: 0, clientY: 0 });

  useEffect(() => {
    return viewer.on('object-hover', (data) => {
      if (!data) {
        setState({ drive: null, clientX: 0, clientY: 0 });
        return;
      }
      if (data.nodeType !== 'Drive') {
        setState((prev) => prev.drive ? { drive: null, clientX: data.pointer.x, clientY: data.pointer.y } : prev);
        return;
      }
      const drive = viewer.registry?.findInParent<RVDrive>(data.node, 'Drive') ?? null;
      setState({ drive, clientX: data.pointer.x, clientY: data.pointer.y });
    });
  }, [viewer]);

  return state;
}

/** Returns the drive pinned by a card click / focusByPath (or null).
 *  Reads `viewer.focusedDrive` / `viewer.focusedNode` and re-syncs on
 *  `object-focus` / `object-blur` / `model-cleared`. */
export function useFocusedDrive(): DriveFocusState {
  const viewer = useViewer();
  const [state, setState] = useState<DriveFocusState>(
    () => ({ drive: viewer.focusedDrive, node: viewer.focusedNode }),
  );

  useEffect(() => {
    const sync = () => setState({ drive: viewer.focusedDrive, node: viewer.focusedNode });
    sync();
    const offFocus = viewer.on('object-focus', sync);
    const offBlur = viewer.on('object-blur', sync);
    const offCleared = viewer.on('model-cleared', sync);
    return () => { offFocus(); offBlur(); offCleared(); };
  }, [viewer]);

  return state;
}
