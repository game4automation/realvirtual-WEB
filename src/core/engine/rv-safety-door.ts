// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-safety-door.ts — Minimal demo visualization for WebSafetyDoor extras.
 *
 * Renders an amber outline around the door mesh (local), plus a floor halo
 * and a "SAFETY DOOR — OPEN" text label both delegated to the shared
 * GizmoOverlayManager (plan-154). Overlay-only — no state machine, no
 * signals, no drive observation. See plan-155 for the full minimal-scope
 * rationale and extension points.
 *
 * Visibility model (demo):
 *  - Hidden by default (no clutter).
 *  - Strictly bound to a single viewer event: 'safety-door:show-all' carries
 *    a boolean — true reveals every safety-door gizmo, false hides them all.
 *    UI plugins emit this event (e.g. from a "N safety doors open" warning
 *    tile: extended → true, collapsed → false).
 */

import {
  Object3D,
  Group,
  Mesh,
  EdgesGeometry,
  LineSegments,
  LineBasicMaterial,
} from 'three';
import {
  registerComponent,
  type RVComponent,
  type ComponentContext,
  type ComponentSchema,
} from './rv-component-registry';
import { HIGHLIGHT_OVERLAY_LAYER } from './rv-group-registry';
import type { GizmoHandle } from './rv-gizmo-manager';

const AMBER = 0xffa726;
const LABEL_TEXT = 'SAFETY DOOR — OPEN';

/** Viewer event payload for the global show-all toggle. */
type ShowAllPayload = { show: boolean };

/**
 * RVSafetyDoor — minimal demo overlay component.
 *
 * Always shows one visual state ("Safety Door, Open"). No signals,
 * no state machine, no drive observation. Designed to be extended
 * incrementally (see plan-155 §5).
 */
export class RVSafetyDoor implements RVComponent {
  static readonly schema: ComponentSchema = {
    HazardZoneRadius: { type: 'number', default: 1500 }, // mm
    LabelHeight:      { type: 'number', default: 200 },  // mm above floor
  };

  readonly node: Object3D;
  isOwner = true;

  // Properties — exact C# Inspector field names
  HazardZoneRadius = 1500;
  LabelHeight = 200;

  private overlayGroup: Group | null = null;
  private outline: LineSegments | null = null;
  private haloGizmo: GizmoHandle | null = null;
  private labelGizmo: GizmoHandle | null = null;
  private unsubShowAll: (() => void) | null = null;

  constructor(node: Object3D) {
    this.node = node;
  }

  init(_ctx: ComponentContext): void {
    // Phase 7 (early init) — only set up things that don't depend on the final
    // child hierarchy. Halo + label are deferred to onSceneReady() because the
    // door panel mesh is reparented under this.node by the Kinematic pass.
    this.overlayGroup = new Group();
    this.overlayGroup.name = `safetydoor:${this.node.name}`;
    this.overlayGroup.layers.set(HIGHLIGHT_OVERLAY_LAYER);
    this.node.add(this.overlayGroup);
  }

  onSceneReady(ctx: ComponentContext): void {
    // Phase 8d (post-kinematic) — children are now in their final position,
    // so the gizmo manager will compute the correct subtree AABB.

    // 1. Outline — built now that the door panel mesh is parented to us
    if (this.overlayGroup) {
      this.outline = this.buildOutline();
      if (this.outline) this.overlayGroup.add(this.outline);
    }

    // 2 + 3. Halo and label via the shared GizmoOverlayManager (plan-154).
    if (!ctx.gizmoManager) {
      console.warn('[RVSafetyDoor] gizmoManager missing — halo and label skipped');
      return;
    }

    // Floor halo — flat amber disc at the door's footprint
    this.haloGizmo = ctx.gizmoManager.create(this.node, {
      shape: 'floor-disk',
      color: AMBER,
      opacity: 0.25,
      radius: Math.max(0.001, this.HazardZoneRadius / 1000), // mm → m
    });

    // Text label — anchored to the bbox bottom, LabelHeight above floor
    this.labelGizmo = ctx.gizmoManager.create(this.node, {
      shape: 'text',
      text: LABEL_TEXT,
      color: AMBER,
      opacity: 1.0,
      textAnchor: 'bottom',
      textOffsetY: this.LabelHeight / 1000, // mm → m
    });

    // Subscribe to the visibility event. Hidden until UI emits show=true.
    this.applyVisibility(false);
    if (ctx.events) {
      this.unsubShowAll = ctx.events.on('safety-door:show-all', (data) => {
        this.applyVisibility(((data as ShowAllPayload | undefined)?.show) === true);
      });
    }
  }

  private applyVisibility(visible: boolean): void {
    this.haloGizmo?.setVisible(visible);
    this.labelGizmo?.setVisible(visible);
    if (this.outline) this.outline.visible = visible;
  }

  private buildOutline(): LineSegments | null {
    let firstMesh: Mesh | null = null;
    this.node.traverse((c) => {
      if (!firstMesh && (c as Mesh).isMesh) firstMesh = c as Mesh;
    });
    if (!firstMesh) return null;
    const edges = new EdgesGeometry((firstMesh as Mesh).geometry, 30);
    const mat = new LineBasicMaterial({ color: AMBER, depthTest: false });
    const line = new LineSegments(edges, mat);
    line.renderOrder = 999;
    line.layers.set(HIGHLIGHT_OVERLAY_LAYER);
    return line;
  }

  dispose(): void {
    this.unsubShowAll?.();
    this.unsubShowAll = null;
    // Local outline overlay
    if (this.overlayGroup) {
      this.overlayGroup.removeFromParent();
      this.outline?.geometry.dispose();
      (this.outline?.material as LineBasicMaterial | undefined)?.dispose();
      this.overlayGroup = null;
      this.outline = null;
    }
    // Gizmo-managed halo + label
    this.haloGizmo?.dispose();
    this.labelGizmo?.dispose();
    this.haloGizmo = null;
    this.labelGizmo = null;
  }
}

// Self-register for auto-discovery by the scene loader.
// `type` matches the GLB extras key (Unity class name `WebSafetyDoor`),
// while `displayName` is what the WebViewer hierarchy / inspector shows.
registerComponent({
  type: 'WebSafetyDoor',
  displayName: 'SafetyDoor',
  schema: RVSafetyDoor.schema,
  capabilities: {
    hoverable: false,
    selectable: false,
  },
  create: (node) => new RVSafetyDoor(node),
});
