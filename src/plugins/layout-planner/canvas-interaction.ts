// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * canvas-interaction.ts — Canvas event handling for the Layout Planner.
 *
 * Extracted from the monolithic _wireCanvasEvents() closure in index.ts.
 * Owns all pointer, keyboard, drag-over/drop, blur/visibility listeners
 * that operate on the 3D canvas while the planner is active.
 */

import { Raycaster, Vector2 } from 'three';
import type { Object3D, Mesh } from 'three';

import type { RVViewer } from '../../core/rv-viewer';
import { DRAG_THRESHOLD_PX } from '../../core/engine/rv-constants';
import { pointerToNDC } from '../../core/engine/rv-pointer-utils';
import { type LibraryCatalogEntry, type LayoutStore } from './rv-layout-store';
import type { FloorGizmo } from './floor-gizmo';
import { findLayoutAncestor, isLockedLayoutInstance, isMuSelectable } from './layout-predicates';
import type { BoxSelectController } from './box-select-controller';
import type { BboxSnapController } from './bbox-snap';

// ─── Dependency interface ────────────────────────────────────────────

export interface CanvasInteractionDeps {
  viewer: RVViewer;
  store: LayoutStore;
  canvas: HTMLCanvasElement;
  objectMap: ReadonlyMap<string, Object3D>;
  idByObject: WeakMap<Object3D, string>;
  floorPlane: Mesh;
  transformControls: FloorGizmo | null;
  modelRoot: Object3D | null;
  getPlacementEntry(): LibraryCatalogEntry | null;
  setDragEntry(entry: LibraryCatalogEntry | null): void;
  getDragEntry(): LibraryCatalogEntry | null;
  /** Instantiate + register the live draft for `entry` (idempotent, async). */
  startDraft(entry: LibraryCatalogEntry): void;
  /** Move the live draft to a raw floor XZ (bbox/grid snap + snap-point +
   *  drop-to-surface). No-op until the async build produced the draft. */
  moveDraft(rawX: number, rawZ: number): boolean;
  /** Commit the live draft as a placement at the final floor `coords` (or the
   *  draft's current position when null). Ensures the draft exists first. */
  commitDraft(entry: LibraryCatalogEntry, coords: [number, number] | null): Promise<string | null>;
  /** Tear down the uncommitted live draft (cancelled drag / Esc / mode off). */
  cancelDraft(): void;
  /** Hide the draft without tearing it down (drag left the window). */
  hideDraft(): void;
  /** Mark synchronously in `onDrop` that the drop committed the draft, so the
   *  dragend-fired `setDragEntry(null)` keeps the node instead of cancelling. */
  markDropCommitted(): void;
  removeSelected(): void;
  duplicateSelected(): Promise<string | null>;
  copySelected(): number;
  pasteClipboard(): Promise<string[]>;
  selectObjectById(id: string | null): void;
  isActive(): boolean;
  /** Marquee (rubber-band) controller. Owned by the planner, used here to
   *  start a marquee drag when pointer-down lands on empty canvas. */
  boxSelect: BoxSelectController;
  /** Magnetic bbox snap controller, shared with FloorGizmo via the gizmo's
   *  custom-snap callback. Used here to snap the ghost during drag-in /
   *  click-to-place so the preview matches the post-place re-drag behaviour. */
  bboxSnap: BboxSnapController;
}

// ─── Manager ─────────────────────────────────────────────────────────

interface DragCandidate {
  target: Object3D;
  path: string;
  startX: number;
  startY: number;
  started: boolean;
}

export class CanvasInteractionManager {
  private _unsubs: (() => void)[] = [];

  // Own pre-allocated vectors — NOT shared with MultiSelectPivot
  private _raycaster = new Raycaster();
  private _mouse = new Vector2();
  // dragCandidate migrated from _wireCanvasEvents closure scope to instance field
  private _dragCandidate: DragCandidate | null = null;

  constructor(private deps: CanvasInteractionDeps) {}

  /** Disarm bbox snap if armed. Idempotent. Used on dispose; the planner's
   *  draft commit/cancel disarm during normal flow. */
  private _disarmBbox(): void {
    if (this.deps.bboxSnap.isArmed) this.deps.bboxSnap.disarm();
  }

  /** Wire all canvas/document/window events. Call once after model loaded. */
  wire(): void {
    const { viewer, canvas, store, floorPlane } = this.deps;

    const DIRECT_DRAG_THRESHOLD_SQ = DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX;

    // ── Direct-drag translation on layout objects, OR marquee on empty canvas ──
    //
    // Single pointer-down handler so we don't race with a separate listener.
    // Decision tree:
    //   1. Placement-mode active   → fall through to onPointerUp's place flow.
    //   2. Modifier key held       → fall through (Shift/Ctrl reserved for the
    //                                marquee modifiers AT RELEASE time, but NOT
    //                                for arming a direct-drag).
    //   3. Pointer-down on a layout instance → arm direct-drag (existing behavior).
    //   4. Else (empty canvas)     → start the marquee.
    const onDirectPointerDown = (e: PointerEvent) => {
      if (!this.deps.isActive() || e.button !== 0) return;
      if (this.deps.getPlacementEntry()) return;

      // The FloorGizmo registers its own `pointerdown` listener on the same
      // canvas BEFORE this manager wires up (planner constructs the gizmo
      // first). When the user clicks on a gizmo handle, the gizmo's handler
      // synchronously sets `_dragging` — so by the time we run, isDragging
      // already reflects the gesture. Bail out to keep the marquee from
      // starting underneath the in-flight transform drag.
      if (this.deps.transformControls?.isDragging) return;

      // Same story for a DES path handle (plan-447): the path visualizer wires
      // its `pointerdown` in `init()` — before this manager, which wires in
      // `onModelLoaded` — so a handle grab has already armed by the time we run.
      // Its handles are not layout instances, so the raycast below would miss
      // them and start a marquee underneath the geometry drag. Looked up by
      // plugin id (structural type, no import) so neither plugin knows the
      // other's module.
      // (`typeof` guard: test viewers are hand-rolled stubs that carry only the
      // members the planner used to touch.)
      const pathViz = typeof viewer.getPlugin === 'function'
        ? viewer.getPlugin<{ id: string; isDragging: boolean }>('path-visualizer')
        : undefined;
      if (pathViz?.isDragging) return;

      const layoutObjs = [...this.deps.objectMap.values()];

      // Resolve a layout-instance hit (if any) up front. The result determines
      // whether we arm direct-drag OR start a marquee.
      let hitRoot: Object3D | null = null;
      let hitPath: string | null = null;
      if (layoutObjs.length > 0) {
        pointerToNDC(e.clientX, e.clientY, canvas, this._mouse);
        this._raycaster.setFromCamera(this._mouse, viewer.camera);
        const hits = this._raycaster.intersectObjects(layoutObjs, true);
        if (hits.length > 0) {
          const root = findLayoutAncestor(hits[0].object);
          if (root && !isLockedLayoutInstance(root)) {
            const p = viewer.registry?.getPathForNode(root) ?? null;
            if (p) { hitRoot = root; hitPath = p; }
          }
        }
      }

      // Modifier-held (Shift/Ctrl/Meta) on a layout instance: do nothing — let
      // the global selection pipeline handle add/toggle on click. We can't arm
      // direct-drag because Shift+drag means "add to marquee selection" and
      // would be ambiguous if it ALSO moved the object.
      if (hitRoot && (e.shiftKey || e.ctrlKey || e.metaKey)) return;

      if (hitRoot && hitPath) {
        this._dragCandidate = {
          target: hitRoot, path: hitPath,
          startX: e.clientX, startY: e.clientY,
          started: false,
        };
        viewer.controls.enabled = false;
        return;
      }

      // Over a spawned MU (registered selectable scene node)? Do NOT start a
      // marquee — let the global click pipeline select it (MUs are select +
      // outline + delete, not movable, so no direct-drag is armed). Without
      // this, a zero-size marquee on pointer-up could clear the MU selection.
      // Hover already ran via the global RaycastManager this frame.
      const hovered = viewer.raycastManager?.hoveredNode;
      if (hovered && isMuSelectable(hovered)) return;

      // Nothing hit → empty canvas → start marquee.
      this.deps.boxSelect.start(e);
    };

    const onDirectPointerMove = (e: PointerEvent) => {
      if (!this._dragCandidate || this._dragCandidate.started) return;
      const dx = e.clientX - this._dragCandidate.startX;
      const dy = e.clientY - this._dragCandidate.startY;
      if (dx * dx + dy * dy < DIRECT_DRAG_THRESHOLD_SQ) return;

      this._dragCandidate.started = true;

      const snap = viewer.selectionManager.getSnapshot();
      if (!snap.selectedPaths.includes(this._dragCandidate.path)) {
        viewer.selectionManager.select(this._dragCandidate.path);
      }

      this.deps.transformControls?.beginExternalDrag(e, 'disc');
    };

    const onDirectPointerUp = (_e: PointerEvent) => {
      if (!this._dragCandidate) return;
      viewer.controls.enabled = true;
      this._dragCandidate = null;
    };

    canvas.addEventListener('pointerdown', onDirectPointerDown);
    canvas.addEventListener('pointermove', onDirectPointerMove);
    window.addEventListener('pointerup', onDirectPointerUp);
    this._unsubs.push(
      () => canvas.removeEventListener('pointerdown', onDirectPointerDown),
      () => canvas.removeEventListener('pointermove', onDirectPointerMove),
      () => window.removeEventListener('pointerup', onDirectPointerUp),
    );

    // ── Pointer click for click-to-place mode only ──
    const onPointerUp = (e: PointerEvent) => {
      if (!this.deps.isActive()) return;
      if (e.button !== 0) return;

      const placementEntry = this.deps.getPlacementEntry();
      if (!placementEntry) return;

      pointerToNDC(e.clientX, e.clientY, canvas, this._mouse);
      this._raycaster.setFromCamera(this._mouse, viewer.camera);

      const floorHits = this._raycaster.intersectObject(floorPlane);
      if (floorHits.length === 0) return;

      // Commit the live draft at the click location — the planner ensures it
      // exists, positions it (snap + drop-to-surface), and records the placement.
      this.deps.commitDraft(placementEntry, [floorHits[0].point.x, floorHits[0].point.z])
        .catch(err => console.error('[LayoutPlanner] Failed to place:', err));
    };

    canvas.addEventListener('pointerup', onPointerUp);
    this._unsubs.push(() => canvas.removeEventListener('pointerup', onPointerUp));

    // ── Mouse move drives the live draft in click-to-place mode ──
    const onPointerMove = (e: PointerEvent) => {
      if (!this.deps.isActive()) return;
      const placementEntry = this.deps.getPlacementEntry();
      if (!placementEntry) {
        // Not in click-to-place mode. Tear down a lingering click-draft (no-op
        // if none). Guard against an in-flight HTML5 drag (native drag
        // suppresses pointer events anyway — belt-and-braces).
        if (!this.deps.getDragEntry()) this.deps.cancelDraft();
        return;
      }

      this.deps.startDraft(placementEntry);

      pointerToNDC(e.clientX, e.clientY, canvas, this._mouse);
      this._raycaster.setFromCamera(this._mouse, viewer.camera);

      const floorHits = this._raycaster.intersectObject(floorPlane);
      if (floorHits.length > 0) {
        this.deps.moveDraft(floorHits[0].point.x, floorHits[0].point.z);
      }
    };

    canvas.addEventListener('pointermove', onPointerMove);
    this._unsubs.push(() => canvas.removeEventListener('pointermove', onPointerMove));

    // ── Keyboard shortcuts ──
    const onKeyDown = (e: KeyboardEvent) => {
      if (!this.deps.isActive()) return;
      const tag = (document.activeElement?.tagName ?? '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

      switch (e.key) {
        case 'g':
        case 'G':
          store.setMode('translate');
          break;
        case 'r':
        case 'R':
          store.setMode('rotate');
          break;
        case 'Delete':
        case 'Backspace':
          // removeSelected handles both layout placements and spawned MUs
          // (mixed selections delete together).
          this.deps.removeSelected();
          break;
        case 'Escape':
          this.deps.selectObjectById(null);
          store.setPlacementMode(null);
          this.deps.cancelDraft();
          this._disarmBbox();
          viewer.markRenderDirty();
          break;
        case 'd':
        case 'D':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            this.deps.duplicateSelected();
          }
          break;
        case 'c':
        case 'C':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            this.deps.copySelected();
          }
          break;
        case 'v':
        case 'V':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            this.deps.pasteClipboard();
          }
          break;
      }
    };

    document.addEventListener('keydown', onKeyDown);
    this._unsubs.push(() => document.removeEventListener('keydown', onKeyDown));

    // ── HTML5 Drag & Drop ──
    //
    // The dragged object is a FULLY registered live draft (instantiated on
    // drag-enter): the planner's `moveDraft` runs the same per-frame pipeline as
    // a post-placement re-drag — bbox + grid snap, snap-point port mating, and
    // drop-to-surface — so the dragged object behaves exactly like a placed one.
    const onDragOver = (e: DragEvent) => {
      const entry = this.deps.getDragEntry();
      if (!this.deps.isActive() || !entry) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';

      this.deps.startDraft(entry);

      pointerToNDC(e.clientX, e.clientY, canvas, this._mouse);
      this._raycaster.setFromCamera(this._mouse, viewer.camera);
      const hits = this._raycaster.intersectObject(floorPlane);
      if (hits.length > 0) {
        this.deps.moveDraft(hits[0].point.x, hits[0].point.z);
      }
    };

    const onDragLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) {
        // Drag left the window — hide (not tear down) so re-entry reuses it.
        this.deps.hideDraft();
        viewer.markRenderDirty();
      }
    };

    const onDrop = (e: DragEvent) => {
      if (!this.deps.isActive()) return;
      e.preventDefault();

      // The live draft was instantiated from the FULL cached entry at drag-enter,
      // so commit it directly — no minimal-entry reconstruction, no re-clone.
      const entry = this.deps.getDragEntry();
      if (!entry) return;

      pointerToNDC(e.clientX, e.clientY, canvas, this._mouse);
      this._raycaster.setFromCamera(this._mouse, viewer.camera);
      const hits = this._raycaster.intersectObject(floorPlane);
      const coords: [number, number] | null = hits.length > 0
        ? [hits[0].point.x, hits[0].point.z]
        : null;

      // Mark committed SYNCHRONOUSLY (before the async commit): the dragend that
      // fires right after drop must see this so `setDragEntry(null)` keeps the
      // node instead of tearing it down.
      this.deps.markDropCommitted();

      this.deps.commitDraft(entry, coords).catch(err =>
        console.error('[LayoutPlanner] Failed to place component:', err),
      );
      // Do NOT setDragEntry(null) here — dragend (handleDragEnd) fires next and
      // balances the edit-pause.
    };

    document.addEventListener('dragover', onDragOver);
    document.addEventListener('dragleave', onDragLeave);
    document.addEventListener('drop', onDrop);
    this._unsubs.push(() => document.removeEventListener('dragover', onDragOver));
    this._unsubs.push(() => document.removeEventListener('dragleave', onDragLeave));
    this._unsubs.push(() => document.removeEventListener('drop', onDrop));

    // ── Blur/visibility handlers to restore controls ──
    const onBlur = () => {
      viewer.controls.enabled = true;
    };
    const onVisChange = () => {
      if (document.hidden) {
        viewer.controls.enabled = true;
      }
    };

    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisChange);
    this._unsubs.push(() => window.removeEventListener('blur', onBlur));
    this._unsubs.push(() => document.removeEventListener('visibilitychange', onVisChange));
  }

  /** Remove all event listeners registered by wire(). */
  dispose(): void {
    for (const unsub of this._unsubs) unsub();
    this._unsubs.length = 0;
    this._dragCandidate = null;
    // Drop bbox snap arm + its window keydown/keyup listeners — leaving
    // them attached would leak across plugin re-init.
    this._disarmBbox();
  }
}
