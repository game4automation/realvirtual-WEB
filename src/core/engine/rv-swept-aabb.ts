// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-swept-aabb.ts — the shared swept-AABB contact clamp (plan-521 Phase 2).
 *
 * Extracted verbatim from `RVTransportStopper.clampTravel()` so the stopper and
 * the `Zone` Block effect run ONE contact rule. Behaviour is unchanged:
 *
 *  - an empty obstacle never clamps;
 *  - a part that already overlaps the obstacle may move out (a lowered stopper
 *    must not trap a part that was inside it when it came down);
 *  - a new contact stops the part just short of penetration (0.1 mm), without
 *    tunnelling through the obstacle on long timesteps.
 */

import type { Box3, Vector3 } from 'three';
import type { AABB } from './rv-aabb';

const AXES = ['x', 'y', 'z'] as const;

/**
 * Swept AABB contact of `mu` moving `distance` (metres) along the unit vector
 * `direction` against the static world box `bounds`. Returns the allowed travel
 * (≤ `distance`).
 */
export function sweptClamp(bounds: Box3, mu: AABB, direction: Vector3, distance: number): number {
  if (bounds.isEmpty()) return distance;
  let enter = -Infinity, leave = Infinity;
  for (const axis of AXES) {
    const d = direction[axis];
    if (Math.abs(d) < 1e-9) {
      if (mu.max[axis] <= bounds.min[axis] || mu.min[axis] >= bounds.max[axis]) return distance;
      continue;
    }
    const a = (bounds.min[axis] - mu.max[axis]) / d;
    const b = (bounds.max[axis] - mu.min[axis]) / d;
    enter = Math.max(enter, Math.min(a, b));
    leave = Math.min(leave, Math.max(a, b));
  }
  // Existing overlap may move out; a lowered stopper must not trap a part
  // that was already inside it. New contacts stop just short of penetration.
  if (leave < enter || enter < -1e-7 || enter > distance) return distance;
  return Math.max(0, enter - 1e-4);
}
