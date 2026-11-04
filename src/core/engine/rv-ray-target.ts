// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * RayTarget — make a node visible to ray sensors (plan-664 Phase 2).
 *
 * A ray sensor sees what MOVES: material units, vehicle hulls, and nodes marked
 * with this component. Static scene geometry is deliberately NOT a candidate —
 * mesh-exact static hits need their own allocation-free path through the pick
 * structure and are Phase 8. Until then this marker is the way to put a wall, a
 * rack, a fence or a reflector in front of a scanner: one component, and the
 * node's bounding box becomes an obstacle.
 *
 * `Dynamic` is the whole configuration that matters. A marked node that never
 * moves measures its box ONCE, which costs nothing per scan; a node that is
 * carried, driven or re-posed measures it again each tick. Getting this wrong in
 * the cheap direction is visible (the obstacle lags behind its mesh), getting it
 * wrong in the expensive direction is not — hence the default `false` and an
 * explicit opt-in.
 *
 * WEB-only: there is no Unity counterpart and therefore no rv-ODT `$def`; the
 * schema lives inline here, like `WebLabel` and `NodeKnowledge`.
 */

import { Box3, type Object3D } from 'three';
import type { ComponentContext, ComponentSchema, RVComponent } from './rv-component-registry';
import { registerComponent } from './rv-component-registry';
import type { RayTargetBox } from './rv-ray-scene-query';

/** Component type name — the rv_extras key and the registry key. */
export const RAY_TARGET_TYPE = 'RayTarget';

/** Inline schema — WEB-only, no rv-ODT `$def` (see file doc). */
export const RAY_TARGET_SCHEMA: ComponentSchema = {
  Enabled: { type: 'boolean', default: true },
  Dynamic: { type: 'boolean', default: false },
};

/** Registered targets in registration order — read by `rv-ray-scene-query`. */
const _targets: RVRayTarget[] = [];
/** The boxes handed to a scan; rebuilt only when the registration changes. */
let _boxes: RayTargetBox[] = [];
let _boxesStale = true;
/** `now` of the last dynamic refresh, so several sensors in one tick refresh once. */
let _refreshedAt = Number.NaN;

export class RVRayTarget implements RVComponent {
  static readonly schema = RAY_TARGET_SCHEMA;

  readonly node: Object3D;
  isOwner = true;

  Enabled = true;
  Dynamic = false;

  /** World AABB handed to the scan — re-measured per tick only while `Dynamic`. */
  readonly box = new Box3();
  private _measured = false;

  constructor(node: Object3D) {
    this.node = node;
  }

  init(_ctx: ComponentContext): void {
    this.node.userData._rvType = RAY_TARGET_TYPE;
    _targets.push(this);
    _boxesStale = true;
  }

  /**
   * Re-measure the world box. A static target does this on its first scan: the
   * node's final world matrix is only certain after the loader has placed and
   * re-parented everything, and measuring lazily needs no second init pass (and
   * `onSceneReady` runs on the `loadGLB` path only).
   */
  measure(): void {
    this.box.setFromObject(this.node, true);
    this._measured = true;
  }

  /**
   * Bring the box up to date: measure if it has not happened yet or if this
   * target moves, and collapse it while the target is disabled.
   *
   * Collapsing CLEARS `_measured`, so re-enabling a static target measures again
   * instead of keeping the empty box forever — switching `Enabled` must not need
   * a reload.
   */
  refresh(): void {
    if (!this.Enabled) { this.box.makeEmpty(); this._measured = false; return; }
    if (this.Dynamic || !this._measured) this.measure();
  }

  dispose(): void {
    const i = _targets.indexOf(this);
    if (i >= 0) _targets.splice(i, 1);
    this._measured = false;
    _boxesStale = true;
  }
}

/**
 * Bring every enabled target up to date for the scans of sim time `now` and
 * return the candidate boxes.
 *
 * Called by each ray sensor before its own scan; the `now` guard makes the work
 * happen once per tick no matter how many sensors ask, which is what keeps a
 * yard with three scanners from measuring the same crate three times.
 */
export function rayTargetBoxes(now: number): readonly RayTargetBox[] {
  if (_boxesStale) {
    _boxes = _targets.map((t) => ({ node: t.node, box: t.box }));
    _boxesStale = false;
    _refreshedAt = Number.NaN;
  }
  if (now !== _refreshedAt) {
    _refreshedAt = now;
    // A disabled target keeps its entry and is filtered by its collapsed box —
    // an empty Box3 has `min > max`, which the slab test rejects for every ray.
    for (let i = 0; i < _targets.length; i++) _targets[i].refresh();
  }
  return _boxes;
}

/** Number of registered targets (diagnostics / tests). */
export function rayTargetCount(): number {
  return _targets.length;
}

registerComponent({
  type: RAY_TARGET_TYPE,
  displayName: 'Ray Target',
  schema: RVRayTarget.schema,
  capabilities: {
    authorable: true,
    pick: 'select',
    ui: { filter: 'Sensors', category: 'sensors', badge: '#66bb6a' },
  },
  create: (node) => new RVRayTarget(node),
  afterCreate: (_inst, node) => { node.userData._rvType = RAY_TARGET_TYPE; },
});
