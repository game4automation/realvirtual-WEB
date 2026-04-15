// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * React hooks for drive state.
 *
 * Usage:
 *   const drives = useDrives();                  // all drives
 *   const { drive, clientX, clientY } = useHoveredDrive();  // hovered drive + pointer pos
 *   const focused = useFocusedDrive();            // drive pinned by card click
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

/** Returns the current list of drives. Updates on model-loaded / model-cleared. */
export function useDrives(): RVDrive[] {
  const viewer = useViewer();
  const [drives, setDrives] = useState<RVDrive[]>(() => viewer.drives);

  useEffect(() => {
    // Sync in case model was loaded before component mounted
    setDrives(viewer.drives);

    const offLoaded = viewer.on('model-loaded', () => setDrives([...viewer.drives]));
    const offCleared = viewer.on('model-cleared', () => setDrives([]));
    return () => { offLoaded(); offCleared(); };
  }, [viewer]);

  return drives;
}

/** Returns the currently hovered drive (or null) with pointer position. */
export function useHoveredDrive(): DriveHoverState {
  const viewer = useViewer();
  const [state, setState] = useState<DriveHoverState>({ drive: null, clientX: 0, clientY: 0 });

  useEffect(() => {
    const off = viewer.on('drive-hover', (data: DriveHoverState) => {
      setState(data);
    });
    return off;
  }, [viewer]);

  return state;
}

/** Returns the drive pinned by a card click / focusByPath (or null). */
export function useFocusedDrive(): DriveFocusState {
  const viewer = useViewer();
  const [state, setState] = useState<DriveFocusState>({ drive: null, node: null });

  useEffect(() => {
    const off = viewer.on('drive-focus', (data: DriveFocusState) => {
      setState(data);
    });
    return off;
  }, [viewer]);

  return state;
}
