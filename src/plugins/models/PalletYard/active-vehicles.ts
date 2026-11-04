// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { Object3D } from 'three';
import { findByNameInSubtree } from '@rv/core/engine/rv-traverse-utils';
import { clearProblem, reportProblem } from '@rv/core/hmi/problems-store';

export const NO_ACTIVE_AGV_PROBLEM_CODE = 'pallet-yard-no-active-agv';

/** The ids whose `Agv.Active` is on (missing = on), in configuration order — no side effects. */
export function readActiveYardVehicles(root: Object3D, ids: readonly string[]): string[] {
  return ids.filter(id => findByNameInSubtree(root, id)?.userData.realvirtual?.Agv?.Active !== false);
}

/** Snapshot once at bind; missing nodes remain eligible for normal bind diagnostics. */
export function activeYardVehicles(root: Object3D, ids: readonly string[]): string[] {
  const active = readActiveYardVehicles(root, ids);
  if (active.length) clearProblem(NO_ACTIVE_AGV_PROBLEM_CODE);
  else reportProblem({
    id: NO_ACTIVE_AGV_PROBLEM_CODE, code: NO_ACTIVE_AGV_PROBLEM_CODE, severity: 'warning',
    title: 'No active AGV — the pallet yard cannot run.',
    detail: 'No active AGV — the pallet yard cannot run. Switch Active on for at least one vehicle and reset.',
  });
  return active;
}

/** Carry the binding snapshot into run creation without re-reading live properties. */
export const boundYardVehicles = new WeakMap<object, readonly string[]>();
