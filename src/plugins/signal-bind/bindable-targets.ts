// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { Object3D } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import type { NodeRegistry } from '../../core/engine/rv-node-registry';
import type { SignalBindingManager } from '../../core/engine/rv-signal-binding-manager';
import { BINDING_SLOT_RV_KEYS } from '../../core/engine/rv-binding-slot-resolver';
import {
  findSignalBindTarget,
  signalBindEligibility,
  signalBindTargetId,
  type SignalBindTarget,
} from './signal-bind-target';

export interface BindableTarget {
  id: string;
  kind: 'placed' | 'node';
  node: Object3D;
  target: SignalBindTarget;
}

interface PlannerLike {
  id: string;
  store: { getSnapshot: () => { placed: ReadonlyArray<{ id: string }> } };
  getPlacedRootById: (id: string) => Object3D | null;
  findPlacedAncestor: (node: Object3D) => { id: string; root: Object3D } | null;
}

export interface BindableTargetViewerLike {
  registry: NodeRegistry | null;
  signalBindingManager: SignalBindingManager | null;
  behaviors: RVViewer['behaviors'];
  getPlugin: RVViewer['getPlugin'];
}

function hasResolverComponent(node: Object3D): boolean {
  const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
  if (!rv) return false;
  for (const key of BINDING_SLOT_RV_KEYS) {
    if (rv[key] !== undefined) return true;
  }
  return false;
}

/** Payload-free discovery for persistent signal-link-mode badges. */
export function enumerateAllBindableTargets(viewer: BindableTargetViewerLike): BindableTarget[] {
  const manager = viewer.signalBindingManager;
  const registry = viewer.registry;
  if (!manager || !registry) return [];

  const candidates: Object3D[] = [];
  registry.forEachNode((_path, node) => {
    if (hasResolverComponent(node)) candidates.push(node);
  });

  const planner = viewer.getPlugin<PlannerLike>('layout-planner');
  if (planner) {
    for (const placed of planner.store.getSnapshot().placed) {
      const root = planner.getPlacedRootById(placed.id);
      if (root) candidates.push(root);
    }
  }

  const seen = new Set<string>();
  const targets: BindableTarget[] = [];
  for (const candidate of candidates) {
    const target = findSignalBindTarget(viewer as RVViewer, candidate);
    if (!target || !signalBindEligibility(viewer as RVViewer, target).eligible) continue;
    const id = signalBindTargetId(target);
    if (seen.has(id) || manager.getElementSlots(id, target.node).length === 0) continue;
    seen.add(id);
    targets.push({ id, kind: target.kind, node: target.node, target });
  }
  return targets;
}
