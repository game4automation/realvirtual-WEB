// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * EditorTransformTool — binds the shared TransformGizmo (IK-gizmo design:
 * axis arrows + rotation rings + centre free-move, overlay-layer rendered,
 * screen-constant size) to the editor selection and commits `transformNode`
 * ops to the AssetDocument on drag end.
 *
 * - Single selection: gizmo in the node's local frame (like an IK target).
 * - Multi selection: pivot at the world centroid with world axes; the drag
 *   delta applies to every selected node (descendants of other selected
 *   nodes are excluded — they follow their transformed ancestor). Commit is
 *   ONE undo unit (withTransaction).
 * - The gizmo lives on HIGHLIGHT_OVERLAY_LAYER, so it never receives the
 *   selection outline or SSAO, and it cannot be hovered/selected/marqueed.
 */

import type { Object3D } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import type { AssetDocument } from '../../core/editor/rv-asset-document';
import type { NodeTransform } from '../../core/editor/rv-asset-ops';
import { assetOpHeader } from '../../core/editor/rv-asset-ops';
import { TransformGizmo } from '../../core/engine/rv-transform-gizmo';
import { pruneDescendantPaths } from './delete-selection';
import { getPivotMode, subscribePivotMode } from './pivot-mode-store';

function snapshotTransform(node: Object3D): NodeTransform {
  return {
    position: node.position.toArray() as [number, number, number],
    quaternion: node.quaternion.toArray() as [number, number, number, number],
    scale: node.scale.toArray() as [number, number, number],
  };
}

export class EditorTransformTool {
  private readonly viewer: RVViewer;
  private readonly doc: AssetDocument;
  private gizmo: TransformGizmo | null = null;
  /** Selected node paths the gizmo is attached to (descendant-pruned). */
  private attachedPaths: string[] = [];
  /** Local TRS per path at drag start — the `prev` payload of the commit. */
  private dragStart: Map<string, NodeTransform> | null = null;
  private unsubSelection: (() => void) | null = null;
  private unsubPivotMode: (() => void) | null = null;

  constructor(viewer: RVViewer, doc: AssetDocument) {
    this.viewer = viewer;
    this.doc = doc;
  }

  install(): void {
    this.gizmo = new TransformGizmo(this.viewer, {
      onDragStart: (nodes) => {
        const snap = new Map<string, NodeTransform>();
        for (const node of nodes) {
          const path = this.viewer.registry?.getPathForNode(node);
          if (path) snap.set(path, snapshotTransform(node));
        }
        this.dragStart = snap;
      },
      onDragEnd: (nodes, moved) => {
        const prevByPath = this.dragStart;
        this.dragStart = null;
        if (!moved || !prevByPath) return;
        void this._commit(nodes, prevByPath);
      },
    });

    // Anchor mode (Pivot/Center) follows the toolbar toggle.
    this.gizmo.pivotMode = getPivotMode();
    this.unsubPivotMode = subscribePivotMode(() => {
      if (this.gizmo) this.gizmo.pivotMode = getPivotMode();
    });

    this.unsubSelection = this.viewer.selectionManager.subscribe(() => this._syncSelection());
    this._syncSelection();
  }

  /**
   * True while the pointer is over a gizmo handle or a drag is in progress.
   * The box-select controller checks this on pointer-down so a press on the
   * gizmo starts a drag instead of a marquee (the gizmo also claims handle
   * presses itself via a capture-phase listener — this is belt & braces).
   */
  get isEngaged(): boolean {
    return this.gizmo?.isEngaged ?? false;
  }

  /** Per-render update — screen-constant sizing + pivot follow. Call from onRender. */
  update(): void {
    this.gizmo?.update();
  }

  uninstall(): void {
    this.unsubSelection?.();
    this.unsubSelection = null;
    this.unsubPivotMode?.();
    this.unsubPivotMode = null;
    this.gizmo?.dispose();
    this.gizmo = null;
    this.attachedPaths = [];
    this.dragStart = null;
    this.viewer.markRenderDirty();
  }

  /** Commit the finished drag as transformNode op(s) — one undo unit. */
  private async _commit(nodes: readonly Object3D[], prevByPath: Map<string, NodeTransform>): Promise<void> {
    const changes: { path: string; current: NodeTransform; prev: NodeTransform }[] = [];
    for (const node of nodes) {
      const path = this.viewer.registry?.getPathForNode(node);
      const prev = path ? prevByPath.get(path) : undefined;
      if (!path || !prev) continue;
      const current = snapshotTransform(node);
      if (JSON.stringify(prev) !== JSON.stringify(current)) changes.push({ path, current, prev });
    }
    if (changes.length === 0) return;
    if (changes.length === 1) {
      // Single node keeps the plain op (and its 500 ms coalescing window).
      this.doc.transformNode(changes[0].path, changes[0].current, changes[0].prev);
      return;
    }
    await this.doc.withTransaction(`Transform ${changes.length} objects`, async () => {
      for (const { path, current, prev } of changes) {
        await this.doc.applyOp({
          ...assetOpHeader(), kind: 'transformNode', nodePath: path, transform: current, prev,
        });
      }
    });
  }

  private _syncSelection(): void {
    if (!this.gizmo) return;
    // Never mid-drag: SelectionManager can't change during a gizmo drag (the
    // gizmo claims the pointer), but guard anyway.
    if (this.gizmo.isDragging) return;

    const sel = [...this.viewer.selectionManager.selectedPaths].filter((path) => {
      const node = this.viewer.registry?.getNode(path);
      return !!node && node !== this.viewer.currentModelRoot;
    });
    // Descendants of other selected paths follow their transformed ancestor —
    // transforming both would apply the delta twice.
    const paths = pruneDescendantPaths(sel);

    if (paths.length === 0) {
      if (this.attachedPaths.length > 0) {
        this.gizmo.detach();
        this.attachedPaths = [];
      }
      return;
    }
    if (paths.length === this.attachedPaths.length && paths.every((p, i) => p === this.attachedPaths[i])) {
      return; // unchanged
    }
    const nodes: Object3D[] = [];
    for (const p of paths) {
      const n = this.viewer.registry?.getNode(p);
      if (n) nodes.push(n);
    }
    this.gizmo.attach(nodes);
    this.attachedPaths = paths;
  }
}
