// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-runtime-clone.ts — the ONE strip every runtime clone of a model node goes
 * through (a Source-spawned MU, its ghost, a Chain element).
 *
 * `Object3D.clone()` JSON-round-trips `userData`, so a clone inherits the
 * template's rv extras and a later `processExtras` would build live components
 * on it. The strip removes the extras — and keeps, as plain `userData` keys,
 * every fact of them a runtime consumer still needs:
 *
 *   - the group labels (MUSwitcher, plan-2016 S5),
 *   - the parsed colliders, "own object" and "MU root" (sensor and collider
 *     walks, plan-2016 S5),
 *   - the Unity layer (raycast sensors, plan-2016 S6c),
 *   - the bake role the template's components DECLARE (`RV_CLONE_BAKE_ROLE_KEY`):
 *     `bakeRoleOf()` answers with it, so `freezeStaticMatrices` sees a clone as
 *     the mover its template is (contract-bake-picking rule 6 — the component
 *     declares the role, nobody lists clone types centrally). Without it a Chain
 *     element clone counted as a plain descendant of the `keep` Chain node, got
 *     `matrixAutoUpdate` forced off, and the chain stood still while its drive
 *     ran (customer flow-wrapper model, 2026-11-06).
 */

import type { Object3D } from 'three';
import { groupLabelsOf, RV_GROUP_LABELS_KEY } from './rv-mu-group-labels';
import { getColliderExtras, RV_COLLIDERS_KEY, RV_IS_MU_KEY, RV_OWN_OBJECT_KEY } from './rv-collider-extras';
import { RV_LAYER_KEY } from './rv-layers';
import { stripIdentity } from './rv-decode-identity';
import { bakeRoleOf, RV_CLONE_BAKE_ROLE_KEY } from './rv-component-registry';

/** Strip the rv extras (and the copied identity) from a runtime clone subtree,
 *  keeping the facts listed in the file header. Idempotent. */
export function stripRuntimeCloneExtras(obj: Object3D): void {
  // plan-769 F10 / Inventory C: a clone is no node of any file — its copied
  // identity (decode seed + authored NodeId) goes with the extras.
  stripIdentity(obj);
  obj.traverse((child) => {
    const ud = child.userData;
    if (!ud) return;
    const labels = groupLabelsOf(child);
    if (labels.length > 0) ud[RV_GROUP_LABELS_KEY] = [...labels];
    const colliders = getColliderExtras(child);
    if (colliders.length > 0) ud[RV_COLLIDERS_KEY] = JSON.parse(JSON.stringify(colliders));
    const rv = ud.realvirtual as Record<string, unknown> | undefined;
    if (rv && typeof rv === 'object') {
      ud[RV_OWN_OBJECT_KEY] = true;
      if (rv['MU']) ud[RV_IS_MU_KEY] = true;
      if (typeof rv['layer'] === 'number') ud[RV_LAYER_KEY] = rv['layer'];
      const role = bakeRoleOf(child);
      if (role) ud[RV_CLONE_BAKE_ROLE_KEY] = role;
    }
    delete ud.realvirtual;
    delete ud._layoutObject;
    delete ud._layoutId;
    delete ud._layoutNestedOf;
    delete ud._layoutNestedId;
  });
}
