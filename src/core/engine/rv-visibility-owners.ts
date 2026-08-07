// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-visibility-owners.ts — auto-filter component-node collection.
 *
 * Historical note: this module used to also build the visibility-OWNER
 * resolver for the plan-294 static merge passes (chunks parented per group /
 * auto-filter root). That machinery was retired when the static merge moved
 * to BatchedMesh arenas with per-instance visibility (setVisibleAt via the
 * BatchVisibilityService) — no owners, no chunk parenting. What remains is
 * the single-source auto-filter node collection shared with
 * `AutoFilterRegistry.build()`.
 *
 * IMPORTANT: auto-filter roots are derived from the SAME source as
 * `AutoFilterRegistry.build()` — `getRegisteredCapabilities()` + NodeRegistry —
 * NOT from `userData._rvType` (components like IKPath/IKTarget/RobotIK/
 * TransportSurface register a filterLabel without setting _rvType, and a node
 * can be registered under multiple types).
 */

import type { Object3D } from 'three';
import type { NodeRegistry } from './rv-node-registry';
import { getRegisteredCapabilities } from './rv-component-registry';

/**
 * Auto-filter node collection per component type: every scene node of every
 * component type with a `filterLabel` capability — the exact node set
 * AutoFilterRegistry.setVisible toggles. SINGLE SOURCE shared by
 * AutoFilterRegistry.build() and the owner resolver so the two can never
 * drift apart (SOL-R2-1). Types with zero resolvable nodes are omitted.
 */
export function getAutoFilterNodesByType(
  nodeRegistry: NodeRegistry | null | undefined,
): Map<string, Object3D[]> {
  const out = new Map<string, Object3D[]>();
  if (!nodeRegistry) return out;
  for (const [type, caps] of getRegisteredCapabilities()) {
    if (!caps.filterLabel) continue;
    const nodes: Object3D[] = [];
    for (const inst of nodeRegistry.getAll(type)) {
      const node = nodeRegistry.getNode(inst.path);
      if (node) nodes.push(node);
    }
    if (nodes.length > 0) out.set(type, nodes);
  }
  return out;
}

/** Flat union of {@link getAutoFilterNodesByType} across all types. */
export function getAutoFilterRootNodes(nodeRegistry: NodeRegistry | null | undefined): Object3D[] {
  const out: Object3D[] = [];
  for (const nodes of getAutoFilterNodesByType(nodeRegistry).values()) {
    out.push(...nodes);
  }
  return out;
}
