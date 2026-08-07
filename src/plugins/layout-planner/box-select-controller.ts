// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * BoxSelectController — rubber-band marquee selection for the layout planner.
 *
 * Owns the overlay `<div>`, pointer-state machine, and lifecycle. The actual
 * geometry hit-test is delegated to `box-select-hit.ts` — keep this file
 * focused on DOM and event plumbing so the testable logic stays pure.
 *
 * Wiring:
 *   - `LayoutPlannerPlugin._attachToViewer` constructs once, calls `attach()`.
 *   - `CanvasInteractionManager.onDirectPointerDown` delegates to `start(e)`
 *     when the pointer-down lands on empty canvas (no layout-instance hit
 *     and no placement entry).
 *   - The controller takes over: captures the pointer, listens move/up/keydown
 *     on `window` / `document`, draws the overlay, and on release calls
 *     `viewer.selectionManager.selectPaths(...)` with the modifier-aware
 *     combined selection.
 *   - `LayoutPlannerPlugin.dispose` calls `dispose()` BEFORE the canvas
 *     interaction manager disposes, so window listeners come off cleanly.
 */

import type { Object3D } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import type { BoxSelectRegistryLike, BoxSelectMuEntry, ClientRect } from './box-select-hit';
import { computeBoxSelectPaths, combineSelection } from './box-select-hit';

const MIN_RECT_SIDE_PX = 4;

/** Marquee overlay colors (CSS color strings). */
export interface MarqueeColors {
  /** Dashed border color, e.g. `rgba(79, 195, 79, 0.95)`. */
  border: string;
  /** Translucent fill color, e.g. `rgba(79, 195, 79, 0.12)`. */
  fill: string;
}

/** Planner-green marquee (the historical default). */
const DEFAULT_MARQUEE_COLORS: MarqueeColors = {
  border: 'rgba(79, 195, 79, 0.95)',
  fill: 'rgba(79, 195, 79, 0.12)',
};

export interface BoxSelectControllerDeps {
  viewer: RVViewer;
  canvas: HTMLCanvasElement;
  /** Live reference — the planner mutates this Map; we re-read on commit.
   *  Ignored when `getObjectMap` is supplied. Optional so callers whose set of
   *  selectable roots is recomputed per-commit (e.g. the asset editor, whose
   *  model root is swapped on every asset load) can pass `getObjectMap` instead. */
  objectMap?: ReadonlyMap<string, Object3D>;
  /** Optional getter that returns the selectable-roots map fresh on every
   *  commit. Takes precedence over `objectMap`. Use this when the map cannot be
   *  a stable live reference (the editor rebuilds it from `viewer.currentModelRoot`,
   *  which changes on each asset load). */
  getObjectMap?: () => ReadonlyMap<string, Object3D>;
  /** Marquee overlay colors. Defaults to planner green. */
  marqueeColors?: MarqueeColors;
  /** Optional getter re-read at the START of every drag, so the marquee can
   *  change color with a mode (the editor's Auto Assign turns it pink).
   *  Takes precedence over `marqueeColors` when it returns non-null. */
  getMarqueeColors?: () => MarqueeColors | null;
  /** Optional commit interceptor. Called instead of the default
   *  `selectionManager.selectPaths(...)` when it returns true — lets a caller
   *  consume the marquee result for something other than selection (the
   *  editor's Auto Assign adds the boxed paths to a kinematic's group). */
  onCommit?: (paths: string[], mods: { shift: boolean; ctrl: boolean }) => boolean;
  /** Getter — `viewer.registry` is REPLACED on each model load (rv-viewer
   *  assigns `this.registry = result.registry` in `loadModel`), so we must
   *  read it fresh on every commit. Caching the reference at construction
   *  used to leave the marquee silently resolving to zero paths after the
   *  first model switch. */
  getRegistry: () => BoxSelectRegistryLike | null;
  /** Returns true when planner mode is active (else `start` is a no-op). */
  getActive: () => boolean;
  /** Spawned-MU entries to include in the marquee (`{ node, path }`), or null. */
  getMuMap: () => Iterable<BoxSelectMuEntry> | null;
}

export class BoxSelectController {
  private _div: HTMLDivElement | null = null;
  private _active = false;
  private _startX = 0;
  private _startY = 0;
  private _pointerId: number | null = null;
  // Bound handler refs — lets `start` add and `_finish` / `dispose` remove
  // the SAME function reference. Without this `removeEventListener` would
  // be a no-op (it'd see different bound copies on each invocation).
  private readonly _onMove = (e: PointerEvent) => this._handleMove(e);
  private readonly _onUp = (e: PointerEvent) => this._handleUp(e);
  private readonly _onKey = (e: KeyboardEvent) => this._handleKey(e);
  // Saved before disabling so we can restore the user's prior choice instead
  // of force-enabling controls that may have been off for other reasons.
  private _prevControlsEnabled = true;

  constructor(private deps: BoxSelectControllerDeps) {}

  /** Mount the overlay div. Idempotent under HMR. */
  attach(): void {
    if (this._div) return;
    const parent = this.deps.canvas.parentElement;
    if (!parent) return;
    const colors = this.deps.marqueeColors ?? DEFAULT_MARQUEE_COLORS;
    const div = document.createElement('div');
    div.setAttribute('data-rv-box-select', '');
    div.style.position = 'absolute';
    div.style.pointerEvents = 'none';
    div.style.border = `1px dashed ${colors.border}`;
    div.style.background = colors.fill;
    div.style.zIndex = '10';
    div.style.display = 'none';
    div.style.left = '0';
    div.style.top = '0';
    div.style.width = '0';
    div.style.height = '0';
    parent.appendChild(div);
    this._div = div;
  }

  /** Tear down — removes the div and any active listeners. */
  dispose(): void {
    if (this._active) this._cancel();
    if (this._div?.parentElement) {
      this._div.parentElement.removeChild(this._div);
    }
    this._div = null;
  }

  /**
   * Called by `CanvasInteractionManager` when a pointer-down lands on empty
   * canvas. Captures the pointer, disables OrbitControls, attaches the
   * move/up/keydown listeners. Does NOT show the overlay until the user has
   * crossed `MIN_RECT_SIDE_PX` to keep tiny clicks invisible.
   */
  start(e: PointerEvent): void {
    if (!this.deps.getActive() || !this._div) return;
    if (this._active) return;
    // Box-select is a mouse-only rubber-band gesture. On touch/pen a drag on
    // empty canvas must orbit/pan the camera (OrbitControls). Starting the
    // marquee there disables the controls and captures the pointer, which is
    // why touch interaction in the 3D scene appeared "dead" — so skip it.
    if (e.pointerType !== 'mouse') return;
    // Re-read the marquee color per drag so a mode change (editor Auto Assign)
    // is reflected without re-attaching the overlay.
    const dynamic = this.deps.getMarqueeColors?.();
    if (dynamic) {
      this._div.style.border = `1px dashed ${dynamic.border}`;
      this._div.style.background = dynamic.fill;
    } else {
      const base = this.deps.marqueeColors ?? DEFAULT_MARQUEE_COLORS;
      this._div.style.border = `1px dashed ${base.border}`;
      this._div.style.background = base.fill;
    }
    this._active = true;
    this._startX = e.clientX;
    this._startY = e.clientY;
    this._pointerId = e.pointerId;
    // Disable orbit controls; remember prior state.
    this._prevControlsEnabled = this.deps.viewer.controls.enabled;
    this.deps.viewer.controls.enabled = false;
    try {
      this.deps.canvas.setPointerCapture(e.pointerId);
    } catch {
      // Pointer capture can fail (e.g. pointer already released) — proceed.
    }
    window.addEventListener('pointermove', this._onMove);
    // CAPTURE phase: the viewer registers a `pointerup` listener directly on
    // the canvas (rv-viewer.ts) that calls `selectionManager.clear()` for any
    // pointerup whose drag distance is below the 8 px threshold. That handler
    // would wipe the marquee selection we commit here. Listening in capture
    // phase + calling `stopImmediatePropagation()` in _handleUp routes the
    // event to us first and prevents the canvas listener from ever seeing it.
    window.addEventListener('pointerup', this._onUp, { capture: true });
    document.addEventListener('keydown', this._onKey);
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private _handleMove(e: PointerEvent): void {
    if (!this._active || !this._div) return;
    const dx = e.clientX - this._startX;
    const dy = e.clientY - this._startY;
    const w = Math.abs(dx);
    const h = Math.abs(dy);
    if (w < MIN_RECT_SIDE_PX && h < MIN_RECT_SIDE_PX) {
      this._div.style.display = 'none';
      return;
    }
    // Compute rect relative to canvas's offset parent (= this._div's parent).
    const parent = this._div.parentElement;
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();
    const left = Math.min(this._startX, e.clientX) - parentRect.left;
    const top = Math.min(this._startY, e.clientY) - parentRect.top;
    this._div.style.left = `${left}px`;
    this._div.style.top = `${top}px`;
    this._div.style.width = `${w}px`;
    this._div.style.height = `${h}px`;
    this._div.style.display = 'block';
  }

  private _handleUp(e: PointerEvent): void {
    if (!this._active) return;
    const dx = e.clientX - this._startX;
    const dy = e.clientY - this._startY;
    const w = Math.abs(dx);
    const h = Math.abs(dy);
    const sufficientDrag = w >= MIN_RECT_SIDE_PX || h >= MIN_RECT_SIDE_PX;

    if (sufficientDrag) {
      // Stop the event before it reaches the canvas-level pointerup listener
      // in rv-viewer.ts. That listener treats short-distance pointerups
      // (≤ 8 px) as "click on empty space" and calls `selectionManager.clear()`,
      // which would wipe the marquee selection we're about to commit. We are
      // already in capture phase (see start()), so stopImmediatePropagation
      // here prevents the canvas's bubble-phase listener from running at all.
      e.stopImmediatePropagation();

      // Build canvas-client rectangle. The hit function will call
      // canvas.getBoundingClientRect itself to convert to NDC.
      const rect: ClientRect = {
        l: Math.min(this._startX, e.clientX),
        t: Math.min(this._startY, e.clientY),
        w,
        h,
      };
      const registry = this.deps.getRegistry();
      const objectMap = this.deps.getObjectMap
        ? this.deps.getObjectMap()
        : this.deps.objectMap;
      if (!registry || !objectMap) {
        // No registry / selectable set yet (e.g. between scene-clear and the
        // next loadGLB) — skip silently and let the user retry.
        this._finish();
        return;
      }
      const marquee = computeBoxSelectPaths(
        this.deps.viewer.camera,
        this.deps.canvas,
        rect,
        objectMap,
        registry,
        this.deps.getMuMap(),
      );
      const mods = { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
      // A consumer may claim the boxed paths (editor Auto Assign adds them to
      // a kinematic's group); only fall through to selection when it doesn't.
      if (!this.deps.onCommit?.(marquee, mods)) {
        const current = this.deps.viewer.selectionManager.getSnapshot().selectedPaths;
        this.deps.viewer.selectionManager.selectPaths(combineSelection(current, marquee, mods));
      }
    }
    // sufficientDrag === false: a tiny click on empty canvas. Leave selection
    // untouched here — let the canvas's existing empty-space-click handler
    // run normally so single clicks on empty canvas still clear selection.

    this._finish();
  }

  private _handleKey(e: KeyboardEvent): void {
    if (!this._active) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      this._cancel();
    }
  }

  /** Common teardown shared by commit / cancel paths. */
  private _finish(): void {
    if (this._div) this._div.style.display = 'none';
    this.deps.viewer.controls.enabled = this._prevControlsEnabled;
    if (this._pointerId !== null) {
      try { this.deps.canvas.releasePointerCapture(this._pointerId); } catch {
        // Already released — safe to ignore.
      }
    }
    window.removeEventListener('pointermove', this._onMove);
    window.removeEventListener('pointerup', this._onUp, { capture: true });
    document.removeEventListener('keydown', this._onKey);
    this._active = false;
    this._pointerId = null;
  }

  private _cancel(): void {
    this._finish();
  }
}
