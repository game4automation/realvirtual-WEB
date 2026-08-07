// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SnapMarkerRenderer — thin adapter over `viewer.gizmoManager` that creates
 * one sprite gizmo per snap point, plus a single active-hover gizmo.
 *
 * All the heavy lifting (material cache, raycast hookup, scene attachment,
 * dispose semantics) lives in {@link GizmoOverlayManager}. This class only:
 *
 *   1. Maintains the one-to-one map of `snap.id → GizmoHandle`.
 *   2. Forwards visibility / occupied / show-all toggles to the right handles.
 *   3. Owns the shared "circle + plus" CanvasTexture that paints the marker.
 *
 * Markers are parented to the snap-point Object3D so they follow whatever
 * placement, gizmo drag or undo moves the owner. They are excluded from
 * raycasting so they cannot steal hover events from the underlying scene.
 */

import type { RVViewer } from '../../core/rv-viewer';
import type { SnapPoint, SnapPointRegistry } from '../../core/engine/rv-snap-point-registry';
import type { GizmoHandle } from '../../core/engine/rv-gizmo-manager';
import { applyScreenSpaceScale } from '../../core/engine/rv-screen-space-scale';
import { makeSnapMarkerTexture, _disposeSnapMarkerTextures } from './snap-marker-texture';

/** Initial world size before the first per-frame screen-space rescale. */
const IDLE_MARKER_SIZE_M = 0.06;
const ACTIVE_MARKER_SIZE_M = 0.10;
/** Constant on-screen marker size in pixels (applied per frame, like the
 *  transform gizmo). Markers therefore keep the same size at any zoom. The
 *  hover marker grows only slightly over idle (minimal grow). */
const IDLE_MARKER_PX = 13;
const ACTIVE_MARKER_PX = 15;
const OCCUPIED_OPACITY = 0.5;
const IDLE_OPACITY = 0.95;
const COLOR_IDLE = 0x4fc34f;        // planner green (matches the gizmo/outline)
const COLOR_OCCUPIED = 0x808080;    // grey for occupied
/** Opacity for the dragged object's own snaps (faint hint during drag). */
const DRAG_MOVING_OPACITY = 0.4;
/** Distinct colour for a snap that an approaching moving snap can mate with. */
const COLOR_DRAG_MATCH = 0xffd24a;  // gold — stands out from the green moving snaps
/** renderOrder above everything else; the active sprite sits one slot higher. */
const RENDER_ORDER_IDLE = 2000;
const RENDER_ORDER_ACTIVE = 2001;
/** The hierarchy-driven highlight sits above the active sprite. */
const RENDER_ORDER_HIGHLIGHT = 2002;
/** Hierarchy snap-highlight: larger marker + distinct cyan so it reads clearly
 *  against the green idle markers (matches the inspector's LIVE_STATE_COLOR). */
const HIGHLIGHT_MARKER_SIZE_M = 0.14;
const HIGHLIGHT_MARKER_PX = 22;
const COLOR_HIGHLIGHT = 0x4dd0e1;


export class SnapMarkerRenderer {
  private readonly viewer: RVViewer;
  private readonly registry: SnapPointRegistry;

  /** Per-snap idle gizmo handle. */
  private handleBySnapId: Map<string, GizmoHandle> = new Map();
  /** Logical "this snap should be shown by proximity" state. */
  private visibleBySnapId: Map<string, boolean> = new Map();
  /** Last applied occupied state — used to decide whether `update()` is needed. */
  private occupiedBySnapId: Map<string, boolean> = new Map();

  /** Single gizmo handle for the active-hover highlight (re-created per hover). */
  private activeHandle: GizmoHandle | null = null;
  /** Snap currently shown as active — used to avoid redundant rebuilds. */
  private activeSnapId: string | null = null;

  /** Single gizmo handle for the hierarchy-driven highlight (hover/select of a
   *  snap node in the hierarchy browser). Independent of `activeHandle` (drag
   *  proximity) and of `enabled` (works outside planner mode). */
  private highlightHandle: GizmoHandle | null = null;
  /** Snap currently highlighted from the hierarchy, or null. */
  private highlightSnapId: string | null = null;

  /** Snap ids whose idle handle is currently overridden by a drag hint
   *  (faint-moving or gold-match). Reset back to idle style on clear. */
  private _dragStyled: Set<string> = new Set();

  private enabled = false;
  private showAllIdle = false;

  constructor(viewer: RVViewer, registry: SnapPointRegistry) {
    this.viewer = viewer;
    this.registry = registry;
  }

  /**
   * Recreate the per-snap gizmo set from the current registry. Cheap enough
   * to call on every placement; each handle is one sprite. Old handles are
   * disposed so GPU material refs stay bounded.
   */
  rebuild(_snapCount: number): void {
    this._teardown();

    const all = this.registry.getAll();
    if (all.length === 0) return;

    const tex = makeSnapMarkerTexture('none');
    const gizmoMgr = this.viewer.gizmoManager;

    for (const sp of all) {
      const handle = gizmoMgr.create(sp.object3D, {
        shape: 'sprite',
        color: sp.occupied ? COLOR_OCCUPIED : COLOR_IDLE,
        opacity: sp.occupied ? OCCUPIED_OPACITY : IDLE_OPACITY,
        spriteTexture: tex,
        worldSize: IDLE_MARKER_SIZE_M,
        attachToNode: true,
        excludeFromRaycast: true,
        depthTest: false,
        renderOrder: RENDER_ORDER_IDLE,
        // Start invisible until proximity-show or showAllIdle flips us on.
        visible: false,
      });
      this.handleBySnapId.set(sp.id, handle);
      this.visibleBySnapId.set(sp.id, false);
      this.occupiedBySnapId.set(sp.id, sp.occupied);
    }

    if (this.showAllIdle && this.enabled) this.refreshAll();
    this.viewer.markRenderDirty?.();
  }

  /** Sync internal indices when snaps are added/removed without rebuild. */
  syncToRegistry(): void {
    this.rebuild(this.registry.size);
  }

  /** Show/hide a single snap marker by id.
   *  Occupied snaps are NEVER shown — once a placement has taken the slot,
   *  the marker is suppressed entirely (the spot is no longer available). */
  setVisibility(snapId: string, visible: boolean): void {
    const handle = this.handleBySnapId.get(snapId);
    if (!handle) return;
    this.visibleBySnapId.set(snapId, visible);
    const sp = this.registry.getById(snapId);
    if (sp?.occupied) {
      handle.setVisible(false);
      return;
    }
    const effective = this.enabled && (this.showAllIdle || visible);
    handle.setVisible(effective);
  }

  /** Hide every idle marker. */
  hideAll(): void {
    for (const id of this.handleBySnapId.keys()) {
      this.setVisibility(id, false);
    }
  }

  /** Refresh every handle from registry state (occupied changes, mode flips).
   *  Occupied snaps are forced hidden regardless of the per-snap visible flag. */
  refreshAll(): void {
    for (const [id, handle] of this.handleBySnapId) {
      const sp = this.registry.getById(id);
      if (!sp) { handle.setVisible(false); continue; }
      this.occupiedBySnapId.set(id, sp.occupied);
      if (sp.occupied) { handle.setVisible(false); continue; }
      const visible = this.visibleBySnapId.get(id) ?? false;
      handle.setVisible(this.enabled && (this.showAllIdle || visible));
    }
    this.viewer.markRenderDirty?.();
  }

  /** Show the active highlight at the given snap. */
  showActive(snap: SnapPoint): void {
    if (!this.enabled) return;
    if (this.activeSnapId === snap.id && this.activeHandle) {
      this.activeHandle.setVisible(true);
      return;
    }
    // Rebuild whenever the hovered snap changes — gizmos are parented to a
    // specific node, so re-targeting means a fresh handle.
    if (this.activeHandle) {
      this.activeHandle.dispose();
      this.activeHandle = null;
    }
    this.activeHandle = this.viewer.gizmoManager.create(snap.object3D, {
      shape: 'sprite',
      // The 'plus' texture bakes its own green disc + white glyph → render it
      // untinted so the white glyph stays white on the green background.
      color: 0xffffff,
      opacity: 1.0,
      // Only the hover marker carries the "+" icon.
      spriteTexture: makeSnapMarkerTexture('plus'),
      worldSize: ACTIVE_MARKER_SIZE_M,
      attachToNode: true,
      excludeFromRaycast: true,
      depthTest: false,
      renderOrder: RENDER_ORDER_ACTIVE,
      visible: true,
      category: 'markers',
    });
    this.activeSnapId = snap.id;
    this.viewer.markRenderDirty?.();
  }

  /** Hide the active highlight. */
  hideActive(): void {
    if (this.activeHandle) {
      this.activeHandle.setVisible(false);
      this.viewer.markRenderDirty?.();
    }
  }

  /**
   * Highlight a single snap in 3D from the hierarchy browser (hover or select),
   * or clear it with `null`. Shows a larger cyan marker at the snap so an
   * otherwise-empty snap Empty becomes visible (the mesh-outline highlighter
   * can't outline a node with no geometry). Works regardless of planner mode
   * (`enabled`) — the hierarchy is always usable. Idempotent on the same id.
   */
  highlight(snapId: string | null): void {
    if (snapId === this.highlightSnapId) {
      if (snapId && this.highlightHandle) this.highlightHandle.setVisible(true);
      return;
    }
    // Re-target: dispose the old handle (gizmos are parented to a specific node).
    if (this.highlightHandle) {
      this.highlightHandle.dispose();
      this.highlightHandle = null;
    }
    this.highlightSnapId = snapId;
    if (!snapId) {
      this.viewer.markRenderDirty?.();
      return;
    }
    const sp = this.registry.getById(snapId);
    if (!sp) { this.viewer.markRenderDirty?.(); return; }
    this.highlightHandle = this.viewer.gizmoManager.create(sp.object3D, {
      shape: 'sprite',
      color: COLOR_HIGHLIGHT,
      opacity: 1.0,
      spriteTexture: makeSnapMarkerTexture('plus'),
      worldSize: HIGHLIGHT_MARKER_SIZE_M,
      attachToNode: true,
      excludeFromRaycast: true,
      depthTest: false,
      renderOrder: RENDER_ORDER_HIGHLIGHT,
      visible: true,
      category: 'markers',
    });
    this.viewer.markRenderDirty?.();
  }

  /**
   * Per-frame: keep every visible marker at a constant on-screen pixel size
   * (idle/drag markers at IDLE_MARKER_PX, the hover marker at ACTIVE_MARKER_PX)
   * regardless of camera distance / zoom — same approach as the FloorGizmo.
   * Cheap no-op when disabled or when no camera/renderer is available.
   */
  updateScreenSize(): void {
    if (!this.enabled) return;
    const camera = this.viewer.camera;
    const renderer = this.viewer.renderer;
    if (!camera || !renderer) return;
    const h = renderer.domElement.clientHeight;
    for (const handle of this.handleBySnapId.values()) {
      if (!handle.root.visible) continue;
      applyScreenSpaceScale(handle.root, IDLE_MARKER_PX, camera, h);
    }
    if (this.activeHandle?.root.visible) {
      applyScreenSpaceScale(this.activeHandle.root, ACTIVE_MARKER_PX, camera, h);
    }
    if (this.highlightHandle?.root.visible) {
      applyScreenSpaceScale(this.highlightHandle.root, HIGHLIGHT_MARKER_PX, camera, h);
    }
  }

  /**
   * Drag-time hints: show the dragged object's own snaps faintly (`movingIds`)
   * and any approaching compatible match emphasised in gold (`targetIds`).
   * Reuses each snap's existing idle handle (no gizmo churn). Snaps that were
   * hinted on a previous call but are absent now are restored to their idle
   * look. Occupied snaps are never hinted. No-op when the renderer is disabled.
   */
  setDragHints(movingIds: Iterable<string>, targetIds: Iterable<string>): void {
    if (!this.enabled) {
      if (this._dragStyled.size > 0) this.clearDragHints();
      return;
    }
    const next = new Set<string>();
    // Targets first so a target also present in movingIds keeps the gold style.
    for (const id of targetIds) {
      const handle = this.handleBySnapId.get(id);
      if (!handle) continue;
      if (this.registry.getById(id)?.occupied) continue;
      handle.setVisible(true);
      handle.update({ color: COLOR_DRAG_MATCH, opacity: IDLE_OPACITY });
      next.add(id);
    }
    for (const id of movingIds) {
      if (next.has(id)) continue;
      const handle = this.handleBySnapId.get(id);
      if (!handle) continue;
      if (this.registry.getById(id)?.occupied) continue;
      handle.setVisible(true);
      handle.update({ color: COLOR_IDLE, opacity: DRAG_MOVING_OPACITY });
      next.add(id);
    }
    // Restore any snap that was hinted before but isn't now.
    for (const id of this._dragStyled) {
      if (!next.has(id)) this._resetIdleStyle(id);
    }
    this._dragStyled = next;
    this.viewer.markRenderDirty?.();
  }

  /** Clear all drag hints, restoring each affected snap to its idle look. */
  clearDragHints(): void {
    if (this._dragStyled.size === 0) return;
    for (const id of this._dragStyled) this._resetIdleStyle(id);
    this._dragStyled.clear();
    this.viewer.markRenderDirty?.();
  }

  /** Restore a single snap's handle to its canonical idle colour/opacity and
   *  the visibility `refreshAll` would give it (occupied / showAllIdle aware). */
  private _resetIdleStyle(id: string): void {
    const handle = this.handleBySnapId.get(id);
    if (!handle) return;
    const sp = this.registry.getById(id);
    const occupied = sp?.occupied ?? false;
    handle.update({
      color: occupied ? COLOR_OCCUPIED : COLOR_IDLE,
      opacity: occupied ? OCCUPIED_OPACITY : IDLE_OPACITY,
    });
    const visible = this.visibleBySnapId.get(id) ?? false;
    handle.setVisible(this.enabled && !occupied && (this.showAllIdle || visible));
  }

  /** Enable/disable the entire renderer (e.g. mode switch). */
  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    if (on) this.refreshAll();
    else {
      // Hide everything without losing the logical visibility state.
      for (const handle of this.handleBySnapId.values()) handle.setVisible(false);
      this.hideActive();
      this._dragStyled.clear();
    }
    this.viewer.markRenderDirty?.();
  }

  /** Toggle "always show idle markers" mode. */
  setShowAllIdle(on: boolean): void {
    if (this.showAllIdle === on) return;
    this.showAllIdle = on;
    this.refreshAll();
  }

  /** Update occupied state. Occupied snaps are hidden entirely (no separate
   *  "greyed out" style — the slot is gone). When freed, the marker only
   *  reappears via the next setVisibility/refreshAll cycle. */
  setOccupied(snapId: string, occupied: boolean): void {
    this.occupiedBySnapId.set(snapId, occupied);
    const handle = this.handleBySnapId.get(snapId);
    if (!handle) return;
    if (occupied) {
      handle.setVisible(false);
    } else {
      const visible = this.visibleBySnapId.get(snapId) ?? false;
      handle.setVisible(this.enabled && (this.showAllIdle || visible));
    }
  }

  /** Full dispose — call on plugin teardown or model unload. */
  dispose(): void {
    this._teardown();
    if (this.activeHandle) {
      this.activeHandle.dispose();
      this.activeHandle = null;
    }
    this.activeSnapId = null;
    if (this.highlightHandle) {
      this.highlightHandle.dispose();
      this.highlightHandle = null;
    }
    this.highlightSnapId = null;
    // The shared CanvasTexture stays alive across re-inits (module-level
    // singleton). Disposing it would leave the next plugin instance with a
    // dead reference; the few-KB texture is fine to keep until page reload.
  }

  // ── Test helpers ───────────────────────────────────────────────────

  /** Returns the GizmoHandle for the given snap id, or undefined. */
  getHandleFor(snapId: string): GizmoHandle | undefined {
    return this.handleBySnapId.get(snapId);
  }
  /** Returns the currently-hovered snap id, or null. */
  getActiveSnapId(): string | null { return this.activeSnapId; }
  /** Returns the currently hierarchy-highlighted snap id, or null. */
  getHighlightSnapId(): string | null { return this.highlightSnapId; }
  /** Test helper — the live highlight gizmo handle (or null). */
  getHighlightHandle(): GizmoHandle | undefined { return this.highlightHandle ?? undefined; }
  /** Currently in "always show idle" mode? */
  isShowAllIdle(): boolean { return this.showAllIdle; }
  /** Renderer enabled (planner mode)? */
  isEnabled(): boolean { return this.enabled; }
  /** Test helper — current number of idle handles. */
  getIdleHandleCount(): number { return this.handleBySnapId.size; }

  // ── Internals ──────────────────────────────────────────────────────

  private _teardown(): void {
    for (const handle of this.handleBySnapId.values()) {
      handle.dispose();
    }
    this.handleBySnapId.clear();
    this.visibleBySnapId.clear();
    this.occupiedBySnapId.clear();
    this._dragStyled.clear();
  }
}

/** Test-only helper: drop the shared marker textures (delegates to the shared
 *  texture module — kept for backwards compatibility with older test imports). */
export function _disposeSharedCircleTexture(): void {
  _disposeSnapMarkerTextures();
}
