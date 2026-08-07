// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { Object3D } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import { NodeRegistry } from '../../core/engine/rv-node-registry';
import { getBindEligibility, type BindEligibility, type SlotScope } from '../../core/engine/rv-binding-slot-resolver';

export type SignalBindTarget =
  | { kind: 'placed'; placedId: string; nodePath?: undefined; node: Object3D; label?: string }
  | { kind: 'node'; nodePath: string; placedId?: undefined; node: Object3D; label?: string };

interface PlannerLike {
  id: string;
  findPlacedAncestor: (node: Object3D) => { id: string; root: Object3D } | null;
}

export function signalBindTargetId(target: SignalBindTarget): string {
  return target.kind === 'placed' ? target.placedId : target.nodePath;
}

/**
 * Slot resolution scope of a target: a Planner placement is ONE aggregate
 * element (its inner nodes are never separate targets), a free node owns only
 * its own slots — every slot-carrying descendant is its own target here, so
 * aggregating would repeat it on every ancestor (nested robot axes).
 */
export function slotScopeForTarget(target: SignalBindTarget): SlotScope {
  return target.kind === 'placed' ? 'aggregate' : 'own';
}

/** Resolve the nearest component target, keeping Planner placements as one aggregate element. */
export function findSignalBindTarget(viewer: RVViewer, node: Object3D): SignalBindTarget | null {
  const manager = viewer.signalBindingManager;
  if (!manager) return null;

  const planner = viewer.getPlugin<PlannerLike>('layout-planner');
  const placed = planner?.findPlacedAncestor(node) ?? null;
  if (placed) {
    const target: SignalBindTarget = { kind: 'placed', placedId: placed.id, node: placed.root, label: placed.root.name };
    return manager.getElementSlots(placed.id, placed.root, 'aggregate').length > 0 ? target : null;
  }

  for (let current: Object3D | null = node; current; current = current.parent) {
    const nodePath = viewer.registry?.getPathForNode(current) ?? NodeRegistry.computeNodePath(current);
    if (!nodePath) continue;
    if (manager.getElementSlots(nodePath, current, 'own').length > 0) {
      return { kind: 'node', nodePath, node: current, label: current.name };
    }
  }
  return null;
}

/** Fail-closed instance eligibility, including declared JS behavior ownership. */
export function signalBindEligibility(viewer: RVViewer, target: SignalBindTarget): BindEligibility {
  const structural = getBindEligibility(target.node, viewer.registry!);
  if (!structural.eligible) return structural;

  const active = viewer.behaviors.getActiveBinds();
  const objectKey = target.kind === 'placed' ? target.placedId : undefined;
  const controlling = active.find((binding) =>
    binding.objectKey === undefined || (objectKey !== undefined && binding.objectKey === objectKey));
  if (controlling) {
    return { eligible: false, reason: `controlled by JavaScript behavior ${controlling.behaviorId}` };
  }
  return { eligible: true };
}

export function findBindableAncestor(viewer: RVViewer, node: Object3D): SignalBindTarget | null {
  const target = findSignalBindTarget(viewer, node);
  return target && signalBindEligibility(viewer, target).eligible ? target : null;
}
