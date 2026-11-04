// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-instance-scope-component.ts — the `InstanceScope` marker (plan-559 Phase 2a).
 *
 * An embedded copy of an asset (part of the document, not a planner placement)
 * opens its own signal scope with this marker on its root: the signals the
 * runtime GENERATES below it (behavior signals, material-flow `Flow.*`, a
 * sensor's occupied signal, persisted `Generated` leaves) are prefixed with the
 * NAME of `PrefixNode` — the marker node itself when the field is empty —
 * exactly like a placed copy is prefixed with its placement root name.
 * Authored signal names stay raw (plan-589 rule).
 *
 * The scoping itself is read straight from the extras by `rv-instance-scope.ts`
 * (dependency-free, because signals are named during the load traversal, before
 * this component exists). This module only makes the marker a real component:
 * schema from rv-ODT, inspector / MCP authorable, and a claim on its node so the
 * destructive bake keeps the scope root.
 */

import type { Object3D } from 'three';
import type { ComponentSchema, RVComponent } from './rv-component-registry';
import { loadSchemaFromSpec, registerComponent, setComponentInstance } from './rv-component-registry';
import { INSTANCE_SCOPE_TYPE, invalidateInstanceScopeMarker } from './rv-instance-scope';

/** The marker component (pure data, no runtime behaviour). */
export class RVInstanceScope implements RVComponent {
  static readonly schema: ComponentSchema = loadSchemaFromSpec(INSTANCE_SCOPE_TYPE);

  readonly node: Object3D;
  isOwner = true;
  /** Resolved by the generic reference pass; the scoping reads the raw extras. */
  PrefixNode: Object3D | null = null;

  constructor(node: Object3D) {
    this.node = node;
  }

  init(): void { /* data only */ }

  /** A field edit re-resolves the prefix on the next naming (a reload renames the signals). */
  reapplyConfig(): void {
    invalidateInstanceScopeMarker(this.node);
  }
}

registerComponent({
  type: INSTANCE_SCOPE_TYPE,
  displayName: 'Instance Scope',
  schema: RVInstanceScope.schema,
  capabilities: { authorable: true, ui: { badge: '#5c6bc0', category: 'signals' } },
  create: (node) => new RVInstanceScope(node),
  afterCreate: (instance, node) => setComponentInstance(node, instance),
});
