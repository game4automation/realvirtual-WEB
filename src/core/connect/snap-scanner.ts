// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * scanAndRegisterSnaps — traverses an Object3D subtree, parses node names
 * against the Snap-<DIR>-<TYPEID> convention, and registers every match
 * with the SnapPointRegistry.
 *
 * Lives in `src/core/connect/` since plan-633 (F2): the connection core owns
 * the snap vocabulary; `src/plugins/snap-point/` re-exports it unchanged.
 */

import type { Object3D } from 'three';
import type { SnapPoint, SnapPointRegistry } from '../engine/rv-snap-point-registry';
import { parseSnapName, forcesBidiPort } from './snap-name-parser';

/**
 * Walk the subtree, register every node whose name matches Snap-<DIR>-<TYPEID>.
 *
 * @param root      Subtree to scan (typically a GLB root or a placed asset)
 * @param registry  Registry to register into
 * @param ownerRoot Asset root recorded on each snap point. Defaults to `root`.
 * @returns The newly registered SnapPoints.
 */
export function scanAndRegisterSnaps(
  root: Object3D,
  registry: SnapPointRegistry,
  ownerRoot?: Object3D,
): SnapPoint[] {
  const owner = ownerRoot ?? root;
  // Some assets expose BIDIRECTIONAL ports: a conveyor may attach in either
  // flow, and the component behavior decides the role (input vs output) at
  // runtime from the connected transport direction. We keep the authored axis
  // (e.g. `Snap-XP` → axis X) but override the flow to 'bidi' so snap-pairing
  // (in↔out only) doesn't reject an otherwise valid physical connection.
  const added: SnapPoint[] = [];
  root.traverse((node: Object3D) => {
    const parsed = parseSnapName(node.name);
    if (!parsed) return;
    const sp: SnapPoint = {
      id: node.uuid,
      object3D: node,
      dir: parsed.dir,
      typeId: parsed.typeId,
      flow: forcesBidiPort(owner.name, parsed.typeId) ? 'bidi' : parsed.flow,
      ownerRoot: owner,
      scenePath: computeScenePath(node),
      occupied: false,
    };
    registry.register(sp);
    added.push(sp);
  });
  return added;
}

/** Compute a Unity-style hierarchy path 'Root/Child/Snap-ZN-foo'. */
function computeScenePath(node: Object3D): string {
  const parts: string[] = [node.name];
  let p: Object3D | null = node.parent;
  while (p && p.parent) {
    parts.unshift(p.name);
    p = p.parent;
  }
  return parts.join('/');
}
