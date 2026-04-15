// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tooltip utility functions — projection and viewport clamping.
 *
 * Extracted from DriveTooltip.tsx for reuse across all tooltip types.
 * Pre-allocates temp vectors for GC-free projection in hot paths.
 */

import { Vector3, Box3, type Mesh, type Object3D, type Camera } from 'three';

/** Minimal renderer interface — only what tooltip projection needs. */
interface HasDomElement { readonly domElement: HTMLCanvasElement; }

// Pre-allocated temp vectors for GC-free projection
const _tempVec = new Vector3();
const _tempBox = new Box3();

/** Result of projecting a 3D object to screen coordinates. */
export interface ScreenProjection {
  /** Screen X in pixels (relative to renderer canvas). */
  x: number;
  /** Screen Y in pixels (relative to renderer canvas). */
  y: number;
  /** Whether the object is in front of the camera (visible). */
  visible: boolean;
}

/**
 * Project a 3D object's world position to screen (pixel) coordinates.
 *
 * Uses the renderer's domElement bounding rect for canvas-relative calculation,
 * so this works correctly even when the canvas is not fullscreen.
 *
 * Returns `visible: false` when the object is behind the camera (z > 1).
 */
export function projectToScreen(
  object: Object3D,
  camera: Camera,
  renderer: HasDomElement,
): ScreenProjection {
  object.updateWorldMatrix(true, true);

  // For container nodes (no geometry), use bounding box center of child meshes.
  // This prevents tooltips from appearing at the transform origin of empty nodes.
  const isMesh = !!(object as unknown as { isMesh?: boolean }).isMesh;
  if (!isMesh) {
    _tempBox.makeEmpty();
    let found = false;
    object.traverse((child) => {
      if ((child as Mesh).isMesh && (child as Mesh).geometry?.attributes?.position) {
        child.getWorldPosition(_tempVec);
        _tempBox.expandByPoint(_tempVec);
        found = true;
      }
    });
    if (found) {
      _tempBox.getCenter(_tempVec);
      _tempVec.project(camera);
      if (_tempVec.z > 1) return { x: 0, y: 0, visible: false };
      const rect = renderer.domElement.getBoundingClientRect();
      return {
        x: (_tempVec.x * 0.5 + 0.5) * rect.width + rect.left,
        y: (-_tempVec.y * 0.5 + 0.5) * rect.height + rect.top,
        visible: true,
      };
    }
  }

  object.getWorldPosition(_tempVec);
  _tempVec.project(camera);

  // Behind-camera check: projected z > 1 means behind
  if (_tempVec.z > 1) {
    return { x: 0, y: 0, visible: false };
  }

  const rect = renderer.domElement.getBoundingClientRect();
  return {
    x: (_tempVec.x * 0.5 + 0.5) * rect.width + rect.left,
    y: (-_tempVec.y * 0.5 + 0.5) * rect.height + rect.top,
    visible: true,
  };
}

/**
 * Convert a world-space point to an Object3D's local space.
 * Used to store tooltip anchors that track object movement.
 */
export function worldToLocal(
  worldPoint: [number, number, number],
  target: Object3D,
): [number, number, number] {
  target.updateWorldMatrix(true, false);
  _tempVec.set(worldPoint[0], worldPoint[1], worldPoint[2]);
  target.worldToLocal(_tempVec);
  return [_tempVec.x, _tempVec.y, _tempVec.z];
}

/**
 * Project a 3D point to screen (pixel) coordinates.
 *
 * If `localTarget` is provided, `point` is treated as local-space
 * coordinates of that object — transformed by its current matrixWorld
 * each call so the projected position tracks object movement.
 * Otherwise `point` is treated as a fixed world-space position.
 */
export function projectPointToScreen(
  point: [number, number, number],
  camera: Camera,
  renderer: HasDomElement,
  localTarget?: Object3D,
): ScreenProjection {
  _tempVec.set(point[0], point[1], point[2]);
  if (localTarget) {
    localTarget.updateWorldMatrix(true, false);
    _tempVec.applyMatrix4(localTarget.matrixWorld);
  }
  _tempVec.project(camera);

  if (_tempVec.z > 1) {
    return { x: 0, y: 0, visible: false };
  }

  const rect = renderer.domElement.getBoundingClientRect();
  return {
    x: (_tempVec.x * 0.5 + 0.5) * rect.width + rect.left,
    y: (-_tempVec.y * 0.5 + 0.5) * rect.height + rect.top,
    visible: true,
  };
}

/**
 * Clamp a tooltip position to stay within the viewport on all 4 edges.
 *
 * @param x - Tooltip left position in pixels
 * @param y - Tooltip top position in pixels
 * @param tooltipWidth - Estimated tooltip width in pixels
 * @param tooltipHeight - Estimated tooltip height in pixels
 * @param margin - Minimum margin from viewport edges in pixels
 * @param viewWidth - Viewport width in pixels
 * @param viewHeight - Viewport height in pixels
 * @returns Clamped { x, y } position
 */
export function clampToViewport(
  x: number,
  y: number,
  tooltipWidth: number,
  tooltipHeight: number,
  margin: number,
  viewWidth: number,
  viewHeight: number,
): { x: number; y: number } {
  // Clamp right edge
  const clampedX = Math.min(x, viewWidth - tooltipWidth - margin);
  // Clamp left edge
  const finalX = Math.max(clampedX, margin);

  // Y is the BOTTOM of the tooltip (CSS transform: translateY(-100%) renders upward).
  // Ensure top edge (y - tooltipHeight) doesn't go above margin.
  // Ensure bottom edge (y) doesn't go below viewHeight - margin.
  let finalY = Math.min(y, viewHeight - margin);
  // If top edge would go off screen, push down so top is at margin
  if (finalY - tooltipHeight < margin) {
    finalY = margin + tooltipHeight;
  }

  return { x: finalX, y: finalY };
}
