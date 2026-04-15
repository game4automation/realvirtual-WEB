// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * React hook for generic object hover state.
 *
 * Works with any hoverable object type (Drive, Sensor, MU, etc.)
 * registered via RaycastManager.registerTargets().
 *
 * Usage:
 *   const hover = useHoveredObject();
 *   if (hover) {
 *     console.log(hover.nodeType, hover.nodePath);
 *   }
 */

import { useState, useEffect } from 'react';
import { useViewer } from './use-viewer';
import type { Object3D } from 'three';

export interface ObjectHoverState {
  /** The hovered Three.js node. */
  node: Object3D;
  /** Type of the node (e.g. 'Drive', 'Sensor', 'MU'). */
  nodeType: string;
  /** Hierarchy path of the node. */
  nodePath: string;
  /** Pointer position in screen coordinates. */
  pointer: { x: number; y: number };
  /** 3D world-space hit point on the mesh surface. */
  hitPoint: [number, number, number] | null;
  /** The actual mesh that was hit. */
  mesh: Object3D;
}

/**
 * Returns the currently hovered object (or null).
 * Listens to 'object-hover' and 'object-unhover' events from RaycastManager.
 *
 * Optionally filter by nodeType:
 *   const sensor = useHoveredObject('Sensor');
 */
export function useHoveredObject(filterType?: string): ObjectHoverState | null {
  const viewer = useViewer();
  const [state, setState] = useState<ObjectHoverState | null>(null);

  useEffect(() => {
    const offHover = viewer.on('object-hover', (data: ObjectHoverState | null) => {
      if (!data) {
        setState(null);
        return;
      }
      if (filterType && data.nodeType !== filterType) return;
      setState(data);
    });

    const offUnhover = viewer.on('object-unhover', () => {
      setState(null);
    });

    return () => { offHover(); offUnhover(); };
  }, [viewer, filterType]);

  return state;
}
