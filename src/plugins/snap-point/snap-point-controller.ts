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
 * Pointer owners (plan-628 8.2): things the viewer's raycast does not hover,
 * such as a path line, reveal their snaps through an injected resolver
 * ({@link SnapPointController.setPointerOwnerResolver}) that maps the pointer
 * to owner roots. A path line's owner is the holder of its two end snaps, so
 * hovering the line shows its free ends with the same marker as any GLB snap.
 *
 * Pinned owners (plan-628 8.8): {@link SnapPointController.setPinnedOwners}
 * keeps the free snaps of some owners revealed without hover — the selected
 * path block and the ends a block move freed.
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
import { DRAG_THRESHOLD_PX } from '../../core/engine/rv-constants';

/** Pixel radius around a visible marker that still counts as "on a marker". */
export const DEFAULT_PIXEL_THRESHOLD = 36;
/** How long markers stay visible after the cursor leaves their owning asset. */
export const DEFAULT_GRACE_MS = 600;
/**
 * Pixel radius around a marker within which a CLICK opens the picker.
 *
 * Deliberately much smaller than {@link DEFAULT_PIXEL_THRESHOLD}, which is the
 * hover/highlight radius. The marker is drawn 13–15 px wide; a click radius of
 * 36 px covered half of a 1 m conveyor at planner zoom, so selecting the part
 * opened the picker, and the popup then sat on top of the part the user was
 * about to drag (field finding 2026-09-25). The part owns its own pixels; the
 * picker owns the marker's.
 */
export const DEFAULT_CLICK_RADIUS_PX = 12;

export interface SnapControllerOptions {
  pixelThreshold?: number;
  graceMs?: number;
  clickRadiusPx?: number;
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
  private readonly clickRadiusPx: number;

  private canvas: HTMLCanvasElement | null = null;
  private active = false;

  /** Asset currently considered "hovered" by the viewer's raycast manager. */
  private hoveredOwner: Object3D | null = null;
  /** plan-628 8.2: owner roots under the pointer that the raycast does not see (path lines). */
  private pointerOwners: readonly Object3D[] = [];
  private pointerOwnerResolver: ((clientX: number, clientY: number) => readonly Object3D[]) | null = null;
  /** plan-628 8.8: owner roots whose free snaps stay revealed without hover (selected path block, freed ends). */
  private pinnedOwners: readonly Object3D[] = [];
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
  private readonly onMouseUpBound: (e: MouseEvent) => void;
  private readonly onKeyDownBound: (e: KeyboardEvent) => void;

  /**
   * A press that landed on a marker, waiting for its release (2026-09-25).
   *
   * The picker used to open on MOUSEDOWN. The planner arms its direct-drag on
   * the same press (`pointerdown`), so grabbing a conveyor within the marker
   * radius moved it AND left the picker standing after the drop — and the
   * popup then swallowed the next press: "the conveyor cannot be moved". A
   * marker press is therefore only a CANDIDATE here; the picker opens on the
   * release, and only when the pointer stayed put (a click, not a drag).
   */
  private pendingPick: { snap: SnapPoint; x: number; y: number } | null = null;
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
    this.clickRadiusPx = opts?.clickRadiusPx ?? DEFAULT_CLICK_RADIUS_PX;

    this.onMouseMoveBound = this._onMouseMove.bind(this);
    this.onMouseDownBound = this._onMouseDown.bind(this);
    this.onMouseUpBound = this._onMouseUp.bind(this);
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
    // On the window: a drag that ends off the canvas must still resolve the
    // candidate (to nothing), or the next canvas press would inherit it.
    window.addEventListener('mouseup', this.onMouseUpBound);
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
    else this._revealPinned();
  }

  deactivate(): void {
    if (!this.active) return;
    this.active = false;

    if (this.canvas) {
      this.canvas.removeEventListener('mousemove', this.onMouseMoveBound);
      this.canvas.removeEventListener('mousedown', this.onMouseDownBound);
    }
    window.removeEventListener('mouseup', this.onMouseUpBound);
    window.removeEventListener('keydown', this.onKeyDownBound);
    this.canvas = null;
    this.pendingPick = null;

    if (this.unsubObjectHover) { this.unsubObjectHover(); this.unsubObjectHover = null; }
    if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    if (this.graceTimer !== null) { clearTimeout(this.graceTimer); this.graceTimer = null; }
    this.dirty = false;
    this.hoveredOwner = null;
    this.pointerOwners = [];
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

  /**
   * plan-628 8.2: install (or clear) the pointer-owner resolver. Called on every
   * canvas mousemove with client coordinates; returns the owner roots whose
   * snaps the pointer reveals (empty = none).
   */
  setPointerOwnerResolver(fn: ((clientX: number, clientY: number) => readonly Object3D[]) | null): void {
    this.pointerOwnerResolver = fn;
  }

  /**
   * plan-628 8.8: owner roots whose FREE snaps stay revealed without hover or
   * grace (the selected path block, ends freed by a move). Replaces the
   * previous set; empty clears.
   */
  setPinnedOwners(owners: readonly Object3D[]): void {
    this.pinnedOwners = owners;
    if (!this.active) return;
    this.reapplyReveals();
  }

  /**
   * Re-derive the revealed markers from hover, pointer owners and pins — after
   * the marker renderer was rebuilt (new handles start hidden) or the pins
   * changed.
   */
  reapplyReveals(): void {
    if (!this.active) return;
    if (snapToolbarStore.getState().showAllSnaps) { this._revealAllSnaps(); return; }
    this._hideAllReveals();
    if (this.hoveredOwner) this._addOwnerReveals(this.hoveredOwner);
    for (const o of this.pointerOwners) this._addOwnerReveals(o);
    this._revealPinned();
    this.dirty = true;
    this._scheduleTick();
  }

  /** Test helper: feed a synthetic pointer-owner result (what the resolver returns). */
  testPointerOwners(owners: readonly Object3D[]): void {
    this._setPointerOwners(owners);
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
    } else if (this.pointerOwners.length > 0) {
      // Left the asset but the pointer still rests on a path line: show its ends.
      this._revealOwners(this.pointerOwners);
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
    this._addOwnerReveals(owner);
    this._revealPinned();
    this.dirty = true;
    this._scheduleTick();
  }

  /** plan-628 8.2: the pointer-owner set changed (path line entered / left). */
  private _setPointerOwners(owners: readonly Object3D[]): void {
    const same = owners.length === this.pointerOwners.length
      && owners.every((o, i) => o === this.pointerOwners[i]);
    if (same) return;
    this.pointerOwners = owners;
    if (this.hoveredOwner) return; // the raycast-hovered asset owns the reveal
    if (owners.length > 0) {
      if (this.graceTimer !== null) { clearTimeout(this.graceTimer); this.graceTimer = null; }
      this._revealOwners(owners);
    } else {
      this._startGrace();
    }
  }

  private _revealOwners(owners: readonly Object3D[]): void {
    if (!snapToolbarStore.getState().showAllSnaps) this._hideAllReveals();
    for (const owner of owners) this._addOwnerReveals(owner);
    this._revealPinned();
    this.dirty = true;
    this._scheduleTick();
  }

  /** Reveal the free snaps of one owner (no hide first). */
  private _addOwnerReveals(owner: Object3D): void {
    for (const sp of this.registry.getByOwnerRoot(owner)) {
      if (sp.occupied) continue;
      if (!sp.object3D.parent) continue;
      this.revealedSnapIds.add(sp.id);
      this.markerRenderer.setVisibility(sp.id, true);
    }
  }

  /** plan-628 8.8: the pinned owners' free snaps (added on top of any reveal). */
  private _revealPinned(): void {
    for (const owner of this.pinnedOwners) this._addOwnerReveals(owner);
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
      if (this.hoveredOwner !== null || this.pointerOwners.length > 0) return;
      const px = this._proximityWithinThreshold();
      if (px) {
        // Still hovering a marker — keep them on; the proximity tick will
        // re-arm the grace once the cursor leaves the marker.
        return;
      }
      this._hideAllReveals();
      this._revealPinned();
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
    if (this.pointerOwnerResolver) this._setPointerOwners(this.pointerOwnerResolver(e.clientX, e.clientY));
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
    // The CLICK radius, not the hover radius: a press on the part itself is a
    // selection or a drag and belongs to the planner.
    if (dist > this.clickRadiusPx) return;

    // Not `stopPropagation`, not `preventDefault`: the press may be the start
    // of a planner drag, and that drag belongs to the planner. Whether this
    // was a click is decided on release.
    this.pendingPick = { snap: sp, x: e.clientX, y: e.clientY };
  }

  private _onMouseUp(e: MouseEvent): void {
    const pending = this.pendingPick;
    this.pendingPick = null;
    if (!pending || e.button !== 0) return;

    // Moved past the planner's own drag threshold = a drag happened; the
    // planner moved the part and the picker has no business appearing.
    const dx = e.clientX - pending.x;
    const dy = e.clientY - pending.y;
    if (dx * dx + dy * dy >= DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;

    // The snap may have been paired or removed during the press.
    if (pending.snap.occupied || !pending.snap.object3D.parent) return;

    snapHoverStore.openPicker(pending.snap, { x: e.clientX, y: e.clientY });
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
