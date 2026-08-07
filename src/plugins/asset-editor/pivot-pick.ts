// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * pivot-pick — the Transform section's "Pivot to Object" eyedropper tool.
 *
 * `startPivotPick` arms a modal pick: the canvas cursor becomes the colorize
 * (eyedropper) icon and the NEXT left-click on a 3D object moves the currently
 * selected object's pivot to that object's center (children preserved, via
 * transform-actions.pivotToObjectCenter). Escape or right-click cancels.
 *
 * The pick is MODAL — it swallows pointerdown/up on window-capture so the
 * viewer's normal click-select and the editor's marquee never fire for the
 * picking gesture (mirrors the transform gizmo's window-capture pointerup
 * pre-emption). Orbit is suspended for the brief pick; cancel to re-navigate.
 */

import type { RVViewer } from '../../core/rv-viewer';
import type { AssetDocument } from '../../core/editor/rv-asset-document';
import { pivotToObjectCenter } from './kinematics/transform-actions';

// Colorize (eyedropper) glyph as a cursor — white fill + dark outline so it
// reads on any background. Hotspot at the dropper tip (bottom-left).
const EYEDROPPER_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>" +
  "<path d='M20.71 5.63l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-3.12 3.12-1.93-1.91-1.41 1.41 " +
  "1.42 1.42L3 16.25V21h4.75l8.92-8.92 1.42 1.42 1.41-1.41-1.92-1.92 3.12-3.12c.4-.4.4-1.03.01-1.42z" +
  "M6.92 19L5 17.08l8.06-8.06 1.92 1.92L6.92 19z' fill='#ffffff' stroke='#1b1b1b' " +
  "stroke-width='1.1' stroke-linejoin='round'/></svg>";
const EYEDROPPER_CURSOR = `url("data:image/svg+xml;base64,${btoa(EYEDROPPER_SVG)}") 3 21, crosshair`;

/** Squared pointer travel above which a press counts as an orbit/drag, not a pick. */
const DRAG_THRESHOLD_SQ = 4 * 4;

/** Disposer of the currently-armed pick, or null when idle. */
let _active: (() => void) | null = null;

/** True while a pivot pick is armed (drives the button's active styling). */
export function isPivotPickActive(): boolean {
  return _active !== null;
}

/** Cancel the armed pick (no-op when idle). */
export function cancelPivotPick(): void {
  _active?.();
}

/**
 * Arm "pivot to object": the next 3D click moves `sourcePath`'s pivot to the
 * clicked object's center. Re-arming cancels any prior pick. Esc / right-click
 * / clicking the source object itself all cancel or no-op safely.
 */
export function startPivotPick(viewer: RVViewer, doc: AssetDocument, sourcePath: string): void {
  cancelPivotPick(); // only one pick at a time
  const canvas = viewer.renderer?.domElement as HTMLCanvasElement | undefined;
  if (!canvas) return;

  const prevCursor = canvas.style.cursor;
  canvas.style.cursor = EYEDROPPER_CURSOR;

  let downPos: { x: number; y: number } | null = null;

  const dispose = () => {
    if (_active !== dispose) return;
    _active = null;
    canvas.style.cursor = prevCursor;
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('keydown', onKey, true);
    canvas.removeEventListener('contextmenu', onContext, true);
  };

  // Swallow the press so neither orbit, marquee, nor the viewer's click-select
  // bookkeeping runs; remember the position to tell a click from a drag.
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    downPos = { x: e.clientX, y: e.clientY };
  };

  const onUp = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const start = downPos; downPos = null;
    if (start) {
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (dx * dx + dy * dy > DRAG_THRESHOLD_SQ) return; // drag → stay armed
    }
    const hit = viewer.raycastManager?.raycastForRVNodeDetailed(e);
    const path = hit?.path ?? null;
    if (!path) return;              // clicked empty space → stay armed
    if (path === sourcePath) return; // clicked itself → nothing to do
    dispose();
    void pivotToObjectCenter(viewer, doc, sourcePath, path);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); dispose(); }
  };

  // Right-click cancels without opening the editor context menu.
  const onContext = (e: MouseEvent) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    dispose();
  };

  _active = dispose;
  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('keydown', onKey, true);
  canvas.addEventListener('contextmenu', onContext, true);
}
