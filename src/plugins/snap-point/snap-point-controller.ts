// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SnapPointController — reveals snap-point markers based on which asset
 * the cursor is hovering, then keeps them on for a short grace period
 * so the user can move into the marker and click it.
 *
 * Visibility logic:
 *   1. RaycastManager emits 'object-hover' when the cursor enters an asset.
 *   2. We find every snap in the registry whose `ownerRoot` is `node` (or
 *      an ancestor of it) and reveal those markers.
 *   3. While the cursor stays inside that asset, markers stay on.
 *   4. When 'object-hover' switches to a different asset (or null), we start
 *      a grace timer. If the cursor enters one of OUR visible markers within
 *      the grace period, we keep them on. Otherwise they fade out.
 *
 * Active highlight (green glow):
 *   - The single closest currently-visible snap in screen space gets the
 *     active sprite. Recomputed on mousemove within an asset.
 *
 * Click:
 *   - Left mousedown within the pixel threshold of the active snap opens
 *     the picker popup.
 *
 * Lifecycle: `activate()` installs DOM + viewer event listeners; `deactivate()`
 * removes everything and cancels the RAF / grace timer.
 */

import { Vector3 } from 'three';
import type { Object3D } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import type { SnapPoint, SnapPointRegistry } from '../../core/engine/rv-snap-point-registry';
import type { ObjectHoverData } from '../../core/engine/rv-raycast-manager';
import type { SnapMarkerRenderer } from './snap-marker-renderer';
import { snapHoverStore } from './snap-hover-store';
import { snapToolbarStore } from './snap-toolbar-store';
import { ndcToScreen } from '../../core/engine/rv-ndc';

/** Pixel radius around a visible marker that still counts as "on a marker". */
export const DEFAULT_PIXEL_THRESHOLD = 36;
/** How long markers stay visible after the cursor leaves their owning asset. */
export const DEFAULT_GRACE_MS = 600;

export interface SnapControllerOptions {
  pixelThreshold?: number;
  graceMs?: number;
}

interface ProximityResult {
  snap: SnapPoint | null;
  dist: number;
  screenX: number;
  screenY: number;
}

export class SnapPointController {
  private readonly viewer: RVViewer;
  private readonly registry: SnapPointRegistry;
  private readonly markerRenderer: SnapMarkerRenderer;
  private readonly pixelThreshold: number;
  private readonly graceMs: number;

  private canvas: HTMLCanvasElement | null = null;
  private active = false;

  /** Asset currently considered "hovered" by the viewer's raycast manager. */
  private hoveredOwner: Object3D | null = null;
  /** Snaps currently revealed (by ownerRoot match or grace period). */
  private revealedSnapIds = new Set<string>();
  /** Grace timer handle; null when no grace is pending. */
  private graceTimer: ReturnType<typeof setTimeout> | null = null;

  private rafId: number | null = null;
  private mouseX = -1;
  private mouseY = -1;
  private dirty = false;

  // Pre-allocated temps for the hot path
  private readonly _tmpVec = new Vector3();
  private readonly _tmpVec2 = new Vector3();

  // Bound listeners
  private readonly onMouseMoveBound: (e: MouseEvent) => void;
  private readonly onMouseDownBound: (e: MouseEvent) => void;
  private readonly onKeyDownBound: (e: KeyboardEvent) => void;
  private readonly onObjectHoverBound: (data: ObjectHoverData | null) => void;

  /** Cleanup handle returned by viewer.on('object-hover', …). */
  private unsubObjectHover: (() => void) | null = null;

  constructor(
    viewer: RVViewer,
    registry: SnapPointRegistry,
    markerRenderer: SnapMarkerRenderer,
    opts?: SnapControllerOptions,
  ) {
    this.viewer = viewer;
    this.registry = registry;
    this.markerRenderer = markerRenderer;
    this.pixelThreshold = opts?.pixelThreshold ?? DEFAULT_PIXEL_THRESHOLD;
    this.graceMs = opts?.graceMs ?? DEFAULT_GRACE_MS;

    this.onMouseMoveBound = this._onMouseMove.bind(this);
    this.onMouseDownBound = this._onMouseDown.bind(this);
    this.onKeyDownBound = this._onKeyDown.bind(this);
    this.onObjectHoverBound = this._onObjectHover.bind(this);
  }

  activate(): void {
    if (this.active) return;
    const canvas = this.viewer.renderer?.domElement as HTMLCanvasElement | undefined;
    if (!canvas) return;
    this.canvas = canvas;
    this.active = true;

    canvas.addEventListener('mousemove', this.onMouseMoveBound);
    canvas.addEventListener('mousedown', this.onMouseDownBound);
    window.addEventListener('keydown', this.onKeyDownBound);

    // Subscribe to viewer-level hover events. The viewer's RaycastManager
    // already knows which asset (including layout-placed clones) is under
    // the cursor — reuse that instead of running a parallel raycast.
    type ViewerOn = (
      ev: 'object-hover',
      cb: (d: ObjectHoverData | null) => void
    ) => (() => void);
    const on = (this.viewer as unknown as { on?: ViewerOn }).on;
    if (typeof on === 'function') {
      this.unsubObjectHover = on.call(this.viewer, 'object-hover', this.onObjectHoverBound);
    }

    if (snapToolbarStore.getState().showAllSnaps) this._revealAllSnaps();
  }

  deactivate(): void {
    if (!this.active) return;
    this.active = false;

    if (this.canvas) {
      this.canvas.removeEventListener('mousemove', this.onMouseMoveBound);
      this.canvas.removeEventListener('mousedown', this.onMouseDownBound);
    }
    window.removeEventListener('keydown', this.onKeyDownBound);
    this.canvas = null;

    if (this.unsubObjectHover) { this.unsubObjectHover(); this.unsubObjectHover = null; }
    if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    if (this.graceTimer !== null) { clearTimeout(this.graceTimer); this.graceTimer = null; }
    this.dirty = false;
    this.hoveredOwner = null;
    this.revealedSnapIds.clear();

    snapHoverStore.setHovered(null, Infinity);
    this.markerRenderer.hideActive();
    this.markerRenderer.hideAll();
  }

  dispose(): void { this.deactivate(); }
  isActive(): boolean { return this.active; }

  /** Test helper — feed a synthetic hover event. */
  testHover(node: Object3D | null): void {
    this._onObjectHover(node ? ({ node, nodeType: '', nodePath: '', pointer: { x: 0, y: 0 }, hitPoint: null, mesh: node }) : null);
  }

  /** Test helper — current revealed set (read-only snapshot). */
  getRevealedSnapIds(): ReadonlySet<string> { return this.revealedSnapIds; }

  /** Public proximity tick — useful for testing without RAF. */
  tick(mouseX: number, mouseY: number): ProximityResult {
    this.mouseX = mouseX;
    this.mouseY = mouseY;
    return this._processProximity();
  }

  // ── Hover-event handling ────────────────────────────────────────────

  private _onObjectHover(data: ObjectHoverData | null): void {
    const node = data?.node ?? null;
    const newOwner = node ? this._resolveOwner(node) : null;
    if (newOwner === this.hoveredOwner) return;

    this.hoveredOwner = newOwner;
    if (newOwner) {
      // Enter — show all snaps belonging to this owner immediately.
      if (this.graceTimer !== null) { clearTimeout(this.graceTimer); this.graceTimer = null; }
      this._revealSnapsForOwner(newOwner);
    } else {
      // Leave — start grace timer. If the cursor enters a marker during the
      // grace window the proximity tick keeps everything visible.
      this._startGrace();
    }
  }

  /** Walk up from `node` until a registered snap's ownerRoot matches.
   *  Uses the registry's byOwnerRoot index (O(1) `has` per ancestor)
   *  instead of materialising a Set on every hover. */
  private _resolveOwner(node: Object3D): Object3D | null {
    const owners = this.registry.getOwnerRoots();
    let cur: Object3D | null = node;
    while (cur) {
      if (owners.has(cur)) return cur;
      cur = cur.parent;
    }
    return null;
  }

  private _revealSnapsForOwner(owner: Object3D): void {
    // Honour show-all from the toolbar — those are already on, so just add the
    // owner's snaps on top (set semantics: idempotent).
    const showAll = snapToolbarStore.getState().showAllSnaps;
    if (!showAll) this._hideAllReveals();
    // Use byOwnerRoot index: O(deg) instead of O(n) full scan.
    for (const sp of this.registry.getByOwnerRoot(owner)) {
      if (sp.occupied) continue;
      if (!sp.object3D.parent) continue;
      this.revealedSnapIds.add(sp.id);
      this.markerRenderer.setVisibility(sp.id, true);
    }
    this.dirty = true;
    this._scheduleTick();
  }

  private _revealAllSnaps(): void {
    for (const sp of this.registry.getAll()) {
      if (sp.occupied) continue;
      if (sp.object3D.parent) {
        this.revealedSnapIds.add(sp.id);
        this.markerRenderer.setVisibility(sp.id, true);
      }
    }
  }

  private _hideAllReveals(): void {
    for (const id of this.revealedSnapIds) {
      this.markerRenderer.setVisibility(id, false);
    }
    this.revealedSnapIds.clear();
  }

  private _startGrace(): void {
    if (snapToolbarStore.getState().showAllSnaps) return; // nothing to fade in show-all mode
    if (this.graceTimer !== null) clearTimeout(this.graceTimer);
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      // Only hide if the cursor is NOT currently over one of our markers and
      // no new owner became active in the meantime.
      if (this.hoveredOwner !== null) return;
      const px = this._proximityWithinThreshold();
      if (px) {
        // Still hovering a marker — keep them on; the proximity tick will
        // re-arm the grace once the cursor leaves the marker.
        return;
      }
      this._hideAllReveals();
      this.markerRenderer.hideActive();
      snapHoverStore.setHovered(null, Infinity);
      this.viewer.markRenderDirty?.();
    }, this.graceMs);
  }

  // ── DOM event handling ──────────────────────────────────────────────

  private _onMouseMove(e: MouseEvent): void {
    const rect = this.canvas?.getBoundingClientRect();
    if (!rect) return;
    this.mouseX = e.clientX - rect.left;
    this.mouseY = e.clientY - rect.top;
    this.dirty = true;
    this._scheduleTick();
  }

  private _onMouseDown(e: MouseEvent): void {
    // Left button only, and only if there is a hovered snap close enough.
    if (e.button !== 0) return;
    const state = snapHoverStore.getState();
    if (!state.hovered) return;

    const rect = this.canvas?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const sp = state.hovered;
    const screen = this._computeScreenPos(sp);
    if (!screen) return;
    const dx = screen.x - mx;
    const dy = screen.y - my;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > this.pixelThreshold) return;

    e.stopPropagation();
    e.preventDefault();
    snapHoverStore.openPicker(sp, { x: e.clientX, y: e.clientY });
  }

  private _onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      const state = snapHoverStore.getState();
      if (state.pickerOpen) snapHoverStore.closePicker();
    }
  }

  // ── Proximity (active marker + click target) ────────────────────────

  private _scheduleTick(): void {
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      if (!this.active) return;
      if (!this.dirty) return;
      this.dirty = false;
      this._processProximity();
    });
  }

  private _computeScreenPos(sp: SnapPoint): { x: number; y: number; ndcZ: number } | null {
    if (!this.canvas) return null;
    if (!sp.object3D.parent) return null;
    sp.object3D.updateWorldMatrix(true, false);
    sp.object3D.getWorldPosition(this._tmpVec);
    const cam = this.viewer.camera;
    if (!cam) return null;
    this._tmpVec2.copy(this._tmpVec).project(cam);
    if (this._tmpVec2.z > 1) return null;
    const rect = this.canvas.getBoundingClientRect();
    // Canvas-local pixels — left/top offsets deliberately zero.
    const out = { x: 0, y: 0, ndcZ: this._tmpVec2.z };
    ndcToScreen(this._tmpVec2.x, this._tmpVec2.y, { left: 0, top: 0, width: rect.width, height: rect.height }, out);
    return out;
  }

  /** Whether the cursor is currently within pixelThreshold of any revealed snap. */
  private _proximityWithinThreshold(): boolean {
    if (this.mouseX < 0) return false;
    for (const id of this.revealedSnapIds) {
      const sp = this.registry.getById(id);
      if (!sp) continue;
      const screen = this._computeScreenPos(sp);
      if (!screen) continue;
      const dx = screen.x - this.mouseX;
      const dy = screen.y - this.mouseY;
      if (Math.sqrt(dx * dx + dy * dy) <= this.pixelThreshold) return true;
    }
    return false;
  }

  private _processProximity(): ProximityResult {
    if (!this.canvas) return { snap: null, dist: Infinity, screenX: -1, screenY: -1 };
    if (this.mouseX < 0 || this.mouseY < 0) {
      return { snap: null, dist: Infinity, screenX: -1, screenY: -1 };
    }

    // Pick the closest currently-revealed snap.
    let best: SnapPoint | null = null;
    let bestDist = Infinity;
    let bestScreen: { x: number; y: number } | null = null;
    const candidates = this.revealedSnapIds.size > 0
      ? Array.from(this.revealedSnapIds).map(id => this.registry.getById(id)).filter(Boolean) as SnapPoint[]
      : this.registry.getAll();
    for (const sp of candidates) {
      if (!sp.object3D.parent) continue;
      if (sp.occupied) continue; // occupied snaps are not clickable targets
      const screen = this._computeScreenPos(sp);
      if (!screen) continue;
      const dx = screen.x - this.mouseX;
      const dy = screen.y - this.mouseY;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < bestDist) {
        bestDist = d;
        best = sp;
        bestScreen = { x: screen.x, y: screen.y };
      }
    }

    if (best && bestDist <= this.pixelThreshold) {
      this.markerRenderer.showActive(best);
      snapHoverStore.setHovered(best, bestDist);
    } else {
      this.markerRenderer.hideActive();
      snapHoverStore.setHovered(null, Infinity);
    }

    return {
      snap: best && bestDist <= this.pixelThreshold ? best : null,
      dist: bestDist,
      screenX: bestScreen?.x ?? -1,
      screenY: bestScreen?.y ?? -1,
    };
  }
}

/** Test helper: check if an Object3D is in the scene graph. */
export function isAttached(o: Object3D): boolean {
  return !!o.parent;
}
