// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-collision-role.ts — the `CollisionRole` marker component (plan-394).
 *
 * A node carrying this component becomes a **collision body**: the union of all
 * effectively visible, non-deformed meshes in its subtree, cut off at the next
 * descendant that carries a role of its own (a robot's body ends at its
 * gripper). While the simulation runs, {@link RVCollisionManager} checks every
 * pair of bodies with DIFFERENT roles against each other.
 *
 * Configuration is deliberately minimal — one dropdown per node, seven fixed
 * english role names, default `None`. There are no group names, no exclusion
 * matrix and no per-pair settings (user decision 2026-08-06; the seventh role
 * `Cutter` was added by plan-409, user decision 2026-08-07).
 *
 * The component itself owns no geometry and no per-frame work: it only
 * registers/unregisters its node with the viewer-owned manager, exactly like
 * `RVLamp` does with `LampManager`.
 */

import type { Box3, Object3D } from 'three';
import type { ComponentContext, ComponentSchema, RVComponent } from './rv-component-registry';
import { registerComponent, setComponentInstance, loadSchemaFromSpec } from './rv-component-registry';

/**
 * Role identifiers. English, NOT localized (user decision 2026-08-06).
 * `None` is first and is the default — a node without a role takes part in no
 * collision check at all.
 *
 * `Cutter` (plan-409) is APPENDED, never inserted: the order is mirrored
 * verbatim in both rv-odt.json enums and in the `enum(...)` cells of
 * specification.md, and `spec-tables-sync.test.ts` compares them literally.
 * A cutting tool gets its own role rather than reusing `Tool` because identical
 * roles never collide — a tool changer's gripper (`Tool`) must still be checked
 * against the milling cutter it grabs.
 */
export const COLLISION_ROLES = [
  'None', 'Tool', 'Workpiece', 'Machine', 'Robot', 'Environment', 'Cutter',
] as const;

export type CollisionRoleName = (typeof COLLISION_ROLES)[number];

const ROLE_SET: ReadonlySet<string> = new Set<string>(COLLISION_ROLES);

/** Defensive parse of an arbitrary value into a role name. Unknown → `'None'`. */
export function toCollisionRole(value: unknown): CollisionRoleName {
  return typeof value === 'string' && ROLE_SET.has(value)
    ? (value as CollisionRoleName)
    : 'None';
}

/**
 * A component whose real material extent is NOT the extent of its authored
 * meshes — today exactly `MachiningVolume` (plan-409 F4).
 *
 * The moment machining starts, `attachGrid()` HIDES the authored workpiece and
 * the dynamic chunk meshes stand in for it. Those chunks never join a body (F3:
 * they have no BVH and would degrade the whole body to a box test), and the
 * hidden originals fail the visibility rule — so without this seam the
 * workpiece would silently VANISH from collision detection at exactly the
 * moment a crash matters most.
 */
export interface StockBoundsSource {
  /** The node the returned box is expressed in. */
  readonly node: Object3D;
  /**
   * Current stock extent in this node's OWN LOCAL space, in three.js units
   * (meters) — the collision manager transforms it with `node.matrixWorld`,
   * which keeps it correct under rotation and non-uniform scale.
   *
   * `null` means "my authored meshes represent me right now" (no grid attached,
   * or the render was torn down again): the body then falls back to its normal
   * per-mesh union, with full triangle precision.
   */
  getStockBoundsLocal(): Box3 | null;
}

/**
 * Narrow slice of {@link RVCollisionManager} the component talks to — declared
 * here so `ComponentContext` and the loader can reference the manager without
 * importing its (heavier) implementation module.
 */
export interface CollisionRoleRegistrar {
  /** (Re-)declare `node` as a body with `role`. `'None'` removes it from the
   *  participating set but keeps it known, so a later change re-arms cheaply. */
  register(node: Object3D, role: CollisionRoleName): void;
  /** Drop `node` from the registry (component disposed / node removed). */
  unregister(node: Object3D): void;
  /** Flag for a rebuild at the next tick head. Callers that re-parent scene
   *  nodes across body boundaries (RVGrip attaching a picked MU under the
   *  gripper) must call this so the F16 ancestor relation — "a body is never
   *  checked against a body it is nested in" — follows the live hierarchy. */
  invalidate(): void;
  /** Declare a live stock-extent provider (plan-409 F4). Optional so the
   *  narrow test fakes of plan-394 keep satisfying this interface. */
  registerStockBounds?(source: StockBoundsSource): void;
  /** Drop a previously declared stock-extent provider. */
  unregisterStockBounds?(source: StockBoundsSource): void;
}

/** The `CollisionRole` component. Pure marker — no per-frame work. */
export class RVCollisionRole implements RVComponent {
  // Loaded from the rv-ODT specification (schema/v1/rv-odt.json).
  // An INLINE `{ type: 'enum', default: 'None' }` would NOT work: applySchema
  // only maps a string when `enumMap` exists, so every authored role would fall
  // back to the default silently. loadSchemaFromSpec builds the identity map.
  static readonly schema: ComponentSchema = loadSchemaFromSpec('CollisionRole');

  readonly node: Object3D;
  isOwner = true;

  /** Schema-populated. Same name as the component (not `Role`) because
   *  `ENUM_FIELDS` is indexed by the bare field name across ALL components. */
  CollisionRole: CollisionRoleName = 'None';

  private _registrar: CollisionRoleRegistrar | null = null;

  constructor(node: Object3D) {
    this.node = node;
  }

  init(ctx: ComponentContext): void {
    this._registrar = ctx.collisionManager ?? null;
    this.CollisionRole = toCollisionRole(this.CollisionRole);
    this._registrar?.register(this.node, this.CollisionRole);
  }

  /** Re-apply after an inspector edit re-wrote the schema field. */
  reapplyConfig(): void {
    this.CollisionRole = toCollisionRole(this.CollisionRole);
    this._registrar?.register(this.node, this.CollisionRole);
  }

  /** Live inspector edit — takes effect on the next tick via the dirty flag. */
  setLiveField(fieldName: string, value: unknown): boolean {
    if (fieldName !== 'CollisionRole') return false;
    this.CollisionRole = toCollisionRole(value);
    this._registrar?.register(this.node, this.CollisionRole);
    return true;
  }

  getLiveState(): Record<string, unknown> {
    return { CollisionRole: this.CollisionRole };
  }

  dispose(): void {
    this._registrar?.unregister(this.node);
    this._registrar = null;
  }
}

// ─── Self-register ──────────────────────────────────────────────────────

registerComponent({
  type: 'CollisionRole',
  displayName: 'Collision Role',
  schema: RVCollisionRole.schema,
  capabilities: {
    authorable: true,        // addable in the asset editor (schema-complete)
    badgeColor: '#ff7043',
    filterLabel: 'Collision Roles',
  },
  create: (node) => new RVCollisionRole(node),
  afterCreate: (inst, node) => setComponentInstance(node, inst),
});
