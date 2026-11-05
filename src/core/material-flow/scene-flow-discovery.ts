// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * scene-flow-discovery.ts — the scene rule on top of the dual discovery in `registry.ts`.
 *
 * Its own module (not `registry.ts`) because the registry is on the startup path and both users
 * load on demand: the DES scene binding and the private experiment Base key.
 */

import type { Object3D } from 'three';
import type { MaterialFlowDefinition } from './define-material-flow';
import { resolveNodeMaterialFlows } from './registry';

/** True if `node` is the ROOT of a placed LayoutObject (carries the marker). */
function isLayoutObjectRoot(node: Object3D): boolean {
  const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
  return !!(rv && rv.LayoutObject);
}

/**
 * The definitions a scene node binds to in DES — {@link resolveNodeMaterialFlows} with the scene
 * rule for the match name: a placed LayoutObject root matches by its asset name (node name minus
 * the `_N` duplicate suffix), every other node by payload only. The DES scene binding binds through
 * this, and the experiment Base key reads the effective component types through it, so both see
 * the same components (a name-only `RobotHandling_1` placement included). Pure.
 */
export function sceneNodeMaterialFlows(node: Object3D): MaterialFlowDefinition[] {
  return resolveNodeMaterialFlows(node, isLayoutObjectRoot(node) ? node.name.replace(/_\d+$/, '') : '');
}
