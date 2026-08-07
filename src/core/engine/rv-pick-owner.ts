// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-pick-owner — shared "owning component" walk for exact-node picking.
 *
 * Editor-mode picks resolve to the EXACT mesh node (see
 * rv-instance-pick-index.ts); the owning component node (e.g. the Drive an
 * axis sub-mesh belongs to) is surfaced separately via this helper — used by
 * the MCP pick response (ownerPath/ownerComponents) and the editor selection
 * UI's owner breadcrumb chip.
 */

import type { Object3D } from 'three';
import type { NodeRegistry } from './rv-node-registry';

export interface PickOwner {
  /** Registry path of the nearest node (self included) carrying rv components. */
  path: string;
  /** Component schema keys on that node (possibly `_N`-deduped, e.g. `Drive_1`). */
  components: string[];
  node: Object3D;
}

/**
 * Walk up from `node` (INCLUDING itself) to the nearest node whose
 * `userData.realvirtual` carries at least one component key and that is
 * registered. Returns null when nothing in the chain has components.
 * A node that is itself the owner (has components) returns itself.
 */
export function findPickOwner(node: Object3D, registry: NodeRegistry): PickOwner | null {
  for (let cur: Object3D | null = node; cur; cur = cur.parent) {
    const rv = cur.userData?.realvirtual as Record<string, unknown> | undefined;
    if (rv && typeof rv === 'object') {
      const components = Object.keys(rv);
      if (components.length > 0) {
        const path = registry.getPathForNode(cur);
        if (path) return { path, components, node: cur };
      }
    }
  }
  return null;
}
