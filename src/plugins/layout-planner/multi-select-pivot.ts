// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * multi-select-pivot.ts — Multi-selection pivot group for the Layout Planner.
 *
 * Extracted from the monolithic index.ts. Manages the centroid-pivot Group
 * that allows rigid-body translation/rotation of multiple selected layout
 * instances as a unit.
 */

import { Group, Vector3, MathUtils } from 'three';
import type { Object3D, Scene } from 'three';

import type { RVViewer } from '../../core/rv-viewer';
import type { LayoutStore } from './rv-layout-store';
import type { FloorGizmo } from './floor-gizmo';
import { freshOpId } from '../../core/hmi/scene/rv-scene-edits';
import { getSceneStore } from '../../core/hmi/scene/scene-store-singleton';

// ─── Dependency interface ────────────────────────────────────────────

export interface MultiSelectPivotDeps {
  scene: Scene;
  store: LayoutStore;
  transformControls: FloorGizmo;
  viewer: RVViewer;
  idByObject: WeakMap<Object3D, string>;
}

// ─── Pivot manager ───────────────────────────────────────────────────

export class MultiSelectPivot {
  private _pivot: Group | null = null;
  private _members: { obj: Object3D; originalParent: Object3D }[] = [];

  // Own pre-allocated vectors — NOT shared with CanvasInteractionManager
  private _centroid = new Vector3();
  private _temp = new Vector3();

  constructor(private deps: MultiSelectPivotDeps) {}

  /**
   * Build or teardown the pivot for the current selection state.
   *
   * - 0 selected  → detach gizmo
   * - 1 selected  → attach gizmo directly to the object
   * - >1 selected → build a centroid pivot, re-parent members preserving
   *   world transforms, attach gizmo to the pivot
   *
   * @param selectedIds  Resolved layout-instance Object3Ds for the selection
   * @param objectMap    The plugin's id→Object3D map (for snap settings)
   * @param gridEnabled  Whether grid snapping is active
   * @param gridSizeMm   Grid step size in millimeters
   */
  syncToSelection(
    objs: Object3D[],
    gridEnabled: boolean,
    gridSizeMm: number,
    rotationSnapDeg: number,
  ): void {
    const tc = this.deps.transformControls;

    // If the selection is being torn down WHILE a gizmo drag is still in flight
    // (e.g. ESC pressed mid-drag, which clears the selection synchronously),
    // flush the in-progress member transforms to the store first. Otherwise
    // tearDown() re-parents members at their dragged world pose but the store
    // keeps the pre-drag pose — visual and persisted state silently diverge and
    // the layout corrupts on the next save/undo/reload. Guarded by isDragging so
    // it is a no-op for ordinary selection changes (clicks, shift-add, box-select).
    if (tc.isDragging && this._pivot && this._members.length > 0) {
      this.writeTransformsOnDragEnd();
    }

    // Always tear down any prior pivot before deciding the new attachment.
    this.tearDown();

    if (objs.length === 0) {
      tc.detach();
    } else if (objs.length === 1) {
      tc.attach(objs[0]);
    } else {
      // Centroid pivot
      const pivot = new Group();
      pivot.name = '_layoutSelectionPivot';
      const centroid = this._centroid.set(0, 0, 0);
      for (const o of objs) {
        o.getWorldPosition(this._temp);
        centroid.add(this._temp);
      }
      centroid.divideScalar(objs.length);
      pivot.position.copy(centroid);
      this.deps.scene.add(pivot);

      // Members stay under their own parents while merely selected, so the
      // hierarchy keeps showing them in place; they are parked under the pivot
      // only for the duration of a gizmo drag (parkMembers / drag end).
      for (const o of objs) {
        const originalParent = o.parent;
        if (!originalParent) continue;
        this._members.push({ obj: o, originalParent });
      }
      this._pivot = pivot;
      tc.attach(pivot);
    }

    // Snap settings follow the planner grid. A 0 mm step turns translation
    // snapping off (null) while rotation snap stays governed by gridEnabled.
    if (gridEnabled) {
      tc.setTranslationSnap(gridSizeMm > 0 ? gridSizeMm / 1000 : null);
      tc.setRotationSnap(MathUtils.degToRad(rotationSnapDeg));
    } else {
      tc.setTranslationSnap(null);
      tc.setRotationSnap(null);
    }
  }

  /**
   * Flush all member transforms to the store after a drag-end.
   *
   * CRITICAL CONTRACT: Must be called synchronously BEFORE tearDown().
   * No async/await between flush and tearDown — otherwise a synchronous
   * 'selection-changed' event from pivot.attach() could trigger tearDown
   * prematurely and corrupt the pivot state.
   *
   * Steps:
   *   1. Re-attach each member to its original parent (preserves world transform)
   *   2. Write each member's local transform to the store
   *   3. Recenter the pivot at the new centroid with identity rotation
   *   4. Re-attach members to the pivot for the next drag
   */
  writeTransformsOnDragEnd(): void {
    const pivot = this._pivot;
    if (!pivot || this._members.length === 0) return;

    // Step 1+2: detach to original parents, write transforms.
    for (const m of this._members) {
      if (m.obj.parent !== m.originalParent) {
        m.originalParent.attach(m.obj);
        this._relink(m.obj);
      }
      const id = this.deps.idByObject.get(m.obj);
      if (id) this._writeMember(id, m.obj);
    }

    // Step 3: recenter the pivot at the new centroid with identity orientation.
    const centroid = this._centroid.set(0, 0, 0);
    for (const { obj } of this._members) {
      obj.getWorldPosition(this._temp);
      centroid.add(this._temp);
    }
    centroid.divideScalar(this._members.length);
    pivot.position.copy(centroid);
    pivot.quaternion.identity();
    pivot.scale.set(1, 1, 1);
    pivot.updateMatrixWorld(true);
    // Members stay under their original parents until the next drag starts.
  }

  /**
   * Park every member under the pivot (world transform preserved) so a gizmo
   * drag moves them rigidly. Called at drag start; drag end restores them.
   */
  parkMembers(): void {
    const pivot = this._pivot;
    if (!pivot) return;
    pivot.updateMatrixWorld(true);
    for (const m of this._members) {
      if (m.obj.parent === pivot) continue;
      pivot.attach(m.obj);
      this._relink(m.obj);
    }
  }

  /** Write a single member's local transform (position + Euler) to the store
   *  AND emit a `transformPlacement` op so multi-select drags participate
   *  in undo/redo (one op per affected member; coalesced by SceneStore). */
  private _writeMember(id: string, obj: Object3D): void {
    // Capture current pose for undo (defensively — test stubs don't always
    // implement getSnapshot).
    let prev: { position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number] } | null = null;
    if (typeof this.deps.store.getSnapshot === 'function') {
      const prevSnap = this.deps.store.getSnapshot().placed.find(c => c.id === id);
      prev = prevSnap
        ? { position: [...prevSnap.position] as [number, number, number],
            rotation: [...prevSnap.rotation] as [number, number, number],
            scale: [...prevSnap.scale] as [number, number, number] }
        : null;
    }

    const newPos: [number, number, number] = [obj.position.x, obj.position.y, obj.position.z];
    const newRot: [number, number, number] = [
      MathUtils.radToDeg(obj.rotation.x),
      MathUtils.radToDeg(obj.rotation.y),
      MathUtils.radToDeg(obj.rotation.z),
    ];

    this.deps.store.updateTransform(id, newPos, newRot);
    this.deps.store.autoSave();

    const sceneStore = getSceneStore();
    const prevPose = prev ?? {
      position: [0, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
    };
    if (sceneStore) {
      void sceneStore.applyOp({
        id: freshOpId(), ts: Date.now(), schemaV: 1,
        kind: 'transformPlacement', placementId: id,
        position: newPos, rotation: newRot, scale: [...prevPose.scale],
        prev: prevPose,
      });
    }
  }

  /**
   * Restore each pivot member to its original parent (preserving world
   * transform) and remove the pivot from the scene.
   */
  tearDown(): void {
    if (!this._pivot) return;
    for (const { obj, originalParent } of this._members) {
      if (obj.parent === originalParent) continue;
      originalParent.attach(obj);
      this._relink(obj);
    }
    this._members.length = 0;
    this._pivot.parent?.remove(this._pivot);
    this._pivot = null;
  }

  /** Re-record the bake nesting of a member that changed parent (plan-774):
   *  out of the model root's placement while held by the pivot, back on
   *  restore. The drag-end detour (`writeTransformsOnDragEnd`) re-parks the
   *  members synchronously and needs none. */
  private _relink(obj: Object3D): void {
    // Optional chain: test hosts hand in a viewer stub without a registry.
    this.deps.viewer?.bakeRegistry?.relinkSubtree?.(obj);
  }

  /** True when a multi-select pivot is active. */
  get isActive(): boolean { return this._pivot !== null; }

  /** Number of members in the active pivot. */
  get memberCount(): number { return this._members.length; }

  /**
   * Look up the original (pre-pivot) parent of `obj`. Returns null if `obj`
   * isn't held by this pivot. Used by `applyTransformById` so the executor
   * can momentarily detach an obj back to its layout-root frame, set
   * placement-record-local values, and re-park in the pivot — preserving
   * world transform across the round-trip.
   */
  getOriginalParent(obj: Object3D): Object3D | null {
    const m = this._members.find(x => x.obj === obj);
    return m ? m.originalParent : null;
  }
}
