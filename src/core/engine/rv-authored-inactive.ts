// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-authored-inactive.ts — the authored "inactive" state of a node (plan-2016 S5).
 *
 * Unity writes `activeSelf` into every node's rv-extras. A node authored with
 * `activeSelf: false` (a GameObject switched off in the scene — typically a
 * variant group of an MU template, e.g. the blow-moulding line `Tube` / `FassMitButzen` /
 * `Fass` under `Source_Schlauch`) loads hidden, like in Unity.
 *
 * Besides `.visible = false` the node gets `userData._rvInactive = true`, a plain
 * flag that `Object3D.clone()` copies (userData is JSON-cloned) and that
 * `stripComponentMetadata` keeps. A spawned MU clone, whose subtree is forced
 * visible by the Source, restores exactly these nodes as hidden, and the MU size
 * measure (`computeTemplateAABBInfo`) skips them — a hidden variant must not
 * enlarge the MU box the sensors see. `MUSwitcher` turns them on at runtime.
 */

import type { Object3D } from 'three';

/** `userData` flag: the node was authored inactive (`activeSelf === false`). */
export const RV_INACTIVE_KEY = '_rvInactive';

/** True when the node's rv-extras author it inactive (`activeSelf === false`). */
export function isAuthoredInactiveExtras(rv: Record<string, unknown> | undefined | null): boolean {
  return rv?.['activeSelf'] === false;
}

/**
 * Hide `node` and stamp {@link RV_INACTIVE_KEY} when its rv-extras author it
 * inactive. Returns true when the node is (now) authored inactive.
 */
export function applyAuthoredInactive(node: Object3D): boolean {
  const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
  if (!isAuthoredInactiveExtras(rv)) return false;
  node.visible = false;
  node.userData[RV_INACTIVE_KEY] = true;
  return true;
}

/**
 * Unity `GameObject.SetActive(active)` for a node (plan-2016 S5 fix): shows or
 * hides it AND keeps {@link RV_INACTIVE_KEY} in step, so a node switched on at
 * runtime (MUSwitcher) counts for the MU size again and a node switched off
 * stops counting.
 */
export function setNodeActive(node: Object3D, active: boolean): void {
  node.visible = active;
  if (active) delete node.userData[RV_INACTIVE_KEY];
  else node.userData[RV_INACTIVE_KEY] = true;
}

/**
 * True when `node` or an ancestor strictly below `root` carries
 * {@link RV_INACTIVE_KEY}. The root's own flag does NOT count: whether the root
 * is active is the instance's concern — a Source activates the root of every
 * clone it spawns (Unity `Source.Generate` → `SetActive(true)`), so an MU
 * template authored inactive as a whole still has a size.
 */
export function isInactiveWithin(node: Object3D, root: Object3D): boolean {
  let n: Object3D | null = node;
  while (n && n !== root) {
    if (n.userData?.[RV_INACTIVE_KEY] === true) return true;
    n = n.parent;
  }
  return false;
}

/** True when any node strictly below `root` carries {@link RV_INACTIVE_KEY}. */
export function hasInactiveDescendant(root: Object3D): boolean {
  let found = false;
  root.traverse((n) => {
    if (!found && n !== root && n.userData?.[RV_INACTIVE_KEY] === true) found = true;
  });
  return found;
}
