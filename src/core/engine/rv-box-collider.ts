// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-box-collider.ts — RVBoxCollider, the authorable `BoxCollider` (plan-525).
 *
 * A collider node carries exactly ONE box (`center` / `size`, metres, Unity
 * convention: `center.x` is written left-handed and negated on read, exactly
 * like every Unity export). Several boxes = several collider nodes. The data
 * key is the existing top-level `BoxCollider` extras key, so Unity exports and
 * web-authored models share one parser (`rv-collider-extras.ts`) and one
 * meaning — sensors, sources, sinks and transport surfaces keep reading their
 * box through `AABB.fromBoxCollider`, the physics plugin turns it into a fixed
 * box inside a `WebPhysicsZone`, and a `WebPhysicsZone` on the same node takes
 * its volume from it.
 *
 * What this component adds on top of the data:
 *  - it is `authorable` (Quick Edit palette, inspector "Add Component",
 *    `web_editor_add_component`, `web_component_schema`);
 *  - a yellow wireframe gizmo while authoring (asset editor, editor test run,
 *    runtime additions by the editor) — never in a delivered viewer, never
 *    pickable, never exported (gizmo roots carry `_rvGizmo`);
 *  - `reapplyConfig()` as the live hook: a field edit, a handle preview, an
 *    undo moves the gizmo AND re-derives the volume of a `WebPhysicsZone` on the
 *    same node (plan-525 §2.4b).
 *
 * `claimsNode: false` stays: a `BoxCollider` alone never keeps a MESH node alive
 * through the destructive bake. An authored collider lives on an EMPTY node —
 * the editor creates a child `Collider` when a box is added to a mesh — and
 * such a node survives on its own (`rv-bake-survival.ts`, authored collider rule).
 */

import { Vector3 } from 'three';
import type { Object3D } from 'three';
import type { ComponentContext, ComponentSchema, RVComponent } from './rv-component-registry';
import {
  loadSchemaFromSpec, registerComponent, removeComponentInstance, setComponentInstance,
} from './rv-component-registry';
import type { GizmoHandle, GizmoOverlayManager } from './rv-gizmo-manager';
import { NodeRegistry } from './rv-node-registry';
import { syncPhysicsZoneBounds } from './rv-physics-zone';

/** Wireframe / face colour of the collider gizmo (plan-525 §3.2). */
export const BOX_COLLIDER_COLOR = 0xf5c542;
/** Collider thinner than this (m) along any axis risks tunnelling (plan-525 §8). */
export const BOX_COLLIDER_MIN_THICKNESS_M = 0.003;
/** Explicit authoring defaults (m, Unity convention) — the rv-ODT `$def` has none. */
export const BOX_COLLIDER_DEFAULT_CENTER = Object.freeze({ x: 0, y: 0, z: 0 });
export const BOX_COLLIDER_DEFAULT_SIZE = Object.freeze({ x: 0.1, y: 0.1, z: 0.1 });

export class RVBoxCollider implements RVComponent {
  static readonly schema: ComponentSchema = loadSchemaFromSpec('BoxCollider');

  readonly node: Object3D;
  isOwner = true;

  // ── Schema fields (applySchema: `center` arrives in glTF space — X already
  //    negated through the `unityCoords` flag; `size` is unsigned) ──
  /** Box centre in node-local glTF coordinates, metres. */
  center = new Vector3(0, 0, 0);
  /** Box size along the local axes, metres. */
  size = new Vector3(0.1, 0.1, 0.1);

  private _gizmoManager: GizmoOverlayManager | null = null;
  private _edges: GizmoHandle | null = null;
  private _faces: GizmoHandle | null = null;
  private _registry: NodeRegistry | null = null;

  constructor(node: Object3D) {
    this.node = node;
  }

  init(ctx: ComponentContext): void {
    this._registry = ctx.registry;
    // A collider is an annotation next to the node's real component: never let
    // it be the node's single `_rvComponentInstance` (tooltips, mechanism
    // lookups and the event dispatcher read that slot). Construction order is
    // registration order, so a factory registered after this one would lose
    // the slot to the collider — hand it on once every factory has run.
    this._yieldPrimaryInstance();
    // Gizmo only on authoring loads (asset editor + its test run; the loader
    // passes `authoring: true`) and on the runtime construction path the editor
    // uses for Add Component / undo (no `authoring` flag at all). A delivered
    // viewer (`authoring: false`) never draws collider boxes.
    if (ctx.gizmoManager && ctx.authoring !== false) {
      this._gizmoManager = ctx.gizmoManager;
      this.attachGizmo(ctx.gizmoManager);
    }
  }

  /**
   * Field edit on the live instance (inspector, editor `setField`, undo, handle
   * preview): move the gizmo and re-derive the volume of a `WebPhysicsZone` on
   * the same node from these values.
   */
  reapplyConfig(): void {
    this._syncGizmo();
    this.notifyZone();
  }

  /** Push this box into a `WebPhysicsZone` on the same node (plan-525 §2.4b). */
  notifyZone(): void {
    const registry = this._registry;
    if (!registry) return;
    syncPhysicsZoneBounds(registry, NodeRegistry.computeNodePath(this.node), this.center, this.size);
  }

  /** True when the box is thinner than {@link BOX_COLLIDER_MIN_THICKNESS_M} along any axis. */
  get isThin(): boolean {
    const s = this.size;
    return Math.min(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z)) < BOX_COLLIDER_MIN_THICKNESS_M;
  }

  /**
   * Show the gizmo only when the component owning this box on the same node
   * (Sensor, WebPhysicsZone, …) has `ShowGizmo` on. A collider without such an
   * owner always shows its box. Called by the owner after a `ShowGizmo` change
   * (via `syncColliderGizmo`) and on every gizmo sync here.
   */
  syncGizmoVisibility(): void {
    if (!this._edges) return;
    const visible = this._gizmoOwner()?.ShowGizmo !== false;
    this._edges.setVisible(visible);
    this._faces?.setVisible(visible);
  }

  /** Gizmo handles (tests / tooling). */
  get gizmo(): { edges: GizmoHandle | null; faces: GizmoHandle | null } {
    return { edges: this._edges, faces: this._faces };
  }

  /** Create the wireframe (edges + 10 % faces) under the node. Idempotent. */
  attachGizmo(gizmoManager: GizmoOverlayManager): void {
    this._gizmoManager = gizmoManager;
    if (this._edges) return;
    this._edges = gizmoManager.create(this.node, {
      kind: 'box-collider-edges', shape: 'box', color: BOX_COLLIDER_COLOR, opacity: 0.9,
      attachToNode: true, excludeFromRaycast: true, category: 'colliders', depthTest: false,
    });
    this._faces = gizmoManager.create(this.node, {
      kind: 'box-collider-faces', shape: 'transparent-shell', color: BOX_COLLIDER_COLOR, opacity: 0.1,
      excludeFromRaycast: true, category: 'colliders', depthTest: false,
    });
    // The shell shape is scene-parented; hang it under the node so it follows.
    this.node.add(this._faces.root);
    this._syncGizmo();
  }

  dispose(): void {
    this._edges?.dispose();
    this._faces?.dispose();
    this._edges = null;
    this._faces = null;
    this._gizmoManager = null;
    this._registry = null;
    removeComponentInstance(this.node, this);
  }

  private _syncGizmo(): void {
    const e = this._edges;
    if (!e) return;
    const s = this.size;
    e.root.position.copy(this.center);
    e.root.scale.set(Math.max(Math.abs(s.x), 1e-4), Math.max(Math.abs(s.y), 1e-4), Math.max(Math.abs(s.z), 1e-4));
    const f = this._faces;
    if (f) {
      f.root.position.copy(e.root.position);
      f.root.scale.copy(e.root.scale);
    }
    this.syncGizmoVisibility();
  }

  /** The other component on this node that carries a boolean `ShowGizmo`. */
  private _gizmoOwner(): { ShowGizmo: boolean } | null {
    const ud = this.node.userData as Record<string, unknown>;
    const list = (ud._rvComponentInstances as unknown[] | undefined)
      ?? (ud._rvComponentInstance ? [ud._rvComponentInstance] : []);
    for (const inst of list) {
      if (inst !== this && typeof (inst as { ShowGizmo?: unknown })?.ShowGizmo === 'boolean') {
        return inst as { ShowGizmo: boolean };
      }
    }
    return null;
  }

  private _yieldPrimaryInstance(): void {
    const ud = this.node.userData as Record<string, unknown>;
    if (ud._rvComponentInstance !== this) return;
    const list = ud._rvComponentInstances as object[] | undefined;
    if (!list || list.length < 2) return;
    // Remove + re-append: the next instance becomes `_rvComponentInstance`,
    // this one stays in the ordered list (at the end).
    removeComponentInstance(this.node, this);
    setComponentInstance(this.node, this);
  }
}

registerComponent({
  type: 'BoxCollider',
  displayName: 'Box Collider',
  schema: RVBoxCollider.schema,
  // plan-755 D7 stays: a BoxCollider alone is an annotation for the bake.
  capabilities: { authorable: true, claimsNode: false, ui: { badge: '#f5c542' } },
  create: (node) => new RVBoxCollider(node),
});
