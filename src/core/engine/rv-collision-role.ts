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
 * Configuration is deliberately minimal — one dropdown per node, six fixed
 * english role names, default `None`. There are no group names, no exclusion
 * matrix and no per-pair settings (user decision 2026-08-06).
 *
 * The component itself owns no geometry and no per-frame work: it only
 * registers/unregisters its node with the viewer-owned manager, exactly like
 * `RVLamp` does with `LampManager`.
 */

import type { Object3D } from 'three';
import type { ComponentContext, ComponentSchema, RVComponent } from './rv-component-registry';
import { registerComponent, setComponentInstance, loadSchemaFromSpec } from './rv-component-registry';

/**
 * Role identifiers. English, NOT localized (user decision 2026-08-06).
 * `None` is first and is the default — a node without a role takes part in no
 * collision check at all.
 */
export const COLLISION_ROLES = [
  'None', 'Tool', 'Workpiece', 'Machine', 'Robot', 'Environment',
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
