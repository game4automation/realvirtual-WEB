// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { Object3D } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import type { SignalDragPayload } from '../../core/hmi/signal-drag-store';
import { BINDING_SLOT_RV_KEYS } from '../../core/engine/rv-binding-slot-resolver';
import { plcKindOf, slotAcceptsSignal } from './drop-accept';
import {
  findSignalBindTarget,
  signalBindEligibility,
  signalBindTargetId,
  type SignalBindTarget,
} from './signal-bind-target';

export interface CompatibleTarget {
  /** Stable id returned by signalBindTargetId(target). */
  id: string;
  kind: 'placed' | 'node';
  /** Root Object3D used as the gizmo anchor. */
  node: Object3D;
  /** The same target representation consumed by the bind popover. */
  target: SignalBindTarget;
  /** Number of slots accepting the current payload. Always at least one. */
  compatibleSlotCount: number;
}

interface PlannerLike {
  id: string;
  store: {
    getSnapshot: () => { placed: ReadonlyArray<{ id: string }> };
  };
  getPlacedRootById: (id: string) => Object3D | null;
}

function hasResolverComponent(node: Object3D): boolean {
  const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
  if (!rv) return false;
  for (const key of BINDING_SLOT_RV_KEYS) {
    if (rv[key] !== undefined) return true;
  }
  return false;
}

/**
 * Enumerate all bind targets compatible with one dragged CONNECT signal.
 * Discovery is deliberately registry-wide because GLB drive behaviors are
 * pending components and are not registered under their behavior type.
 */
export function enumerateCompatibleTargets(
  viewer: RVViewer,
  payload: SignalDragPayload,
): CompatibleTarget[] {
  const manager = viewer.signalBindingManager;
  const registry = viewer.registry;
  if (!manager || !registry) return [];
  if (plcKindOf(payload.plcType) === 'unknown' || payload.direction === 'unknown') return [];

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
  const compatible: CompatibleTarget[] = [];
  for (const candidate of candidates) {
    const target = findSignalBindTarget(viewer, candidate);
    if (!target || !signalBindEligibility(viewer, target).eligible) continue;
    const id = signalBindTargetId(target);
    if (seen.has(id)) continue;

    const slots = manager.getElementSlots(id, target.node);
    let compatibleSlotCount = 0;
    for (const slot of slots) {
      if (slot.kind === 'unavailable') continue;
      if (slotAcceptsSignal(slot, payload)) compatibleSlotCount++;
    }
    if (compatibleSlotCount === 0) continue;

    seen.add(id);
    compatible.push({ id, kind: target.kind, node: target.node, target, compatibleSlotCount });
  }
  return compatible;
}
