// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-freeze-static.ts — Prune the per-frame matrix recursion on large scenes.
 *
 * On a big CAD model the scene graph holds tens of thousands of structural
 * Group nodes plus the baked-away source meshes that the merges keep around for
 * hover-highlight. Three.js walks ALL of them every frame in
 * `scene.updateMatrixWorld()` — measured as the dominant CPU cost (~2x the
 * render-loop time on the Mauser line, ~40 ms/frame), paid even when nothing
 * moves and again on every post-processing pass that re-renders the scene.
 *
 * This pass sets `matrixWorldAutoUpdate = false` on every node that is provably
 * static, so Three.js skips it (and, since it is the recursion gate, its whole
 * subtree) in the automatic world-matrix update. A node is kept DYNAMIC iff it,
 * one of its ancestors, or one of its descendants carries a motion / MU-spawn
 * component (see {@link MOVER_KEY}): Drive(*), Kinematic, Grip, TransportSurface,
 * Source, Sink, MU, Cam, SceneButtonMoveable, Chain(Element). That closure keeps
 * alive:
 *   - Drive-driven subtrees (the Drive node + everything under it),
 *   - the chain of ancestors above each Drive (needed so the recursion can reach
 *     it — including the always-dynamic model root, under which runtime MUs are
 *     spawned), and
 *   - kinematic chains and grippers, and
 *   - the animated caps of 3D scene buttons (plan-417).
 * Everything else — disconnected static structure and the hidden highlight
 * source meshes — is frozen.
 *
 * Safety was verified live against the moving demo scene: over a 5 s window with
 * the freeze active, zero frozen node ever changed its world position, while all
 * 33 genuinely-moving meshes kept moving.
 *
 * MUST run AFTER kinematic re-parenting and the static/kinematic merges, on the
 * FINAL hierarchy — earlier the parent chains (and therefore the mover closure)
 * are not yet correct. World matrices are computed once up front so every frozen
 * node holds its correct, final transform.
 */

import type { Object3D } from 'three';

/**
 * rv_extras component keys whose node — together with its ancestors and its
 * whole subtree — must stay matrix-dynamic. Matched case-insensitively against
 * the START of the key, so `Drive_Cylinder`, `Drive_Gear`, `Drive_ErraticPosition`
 * etc. are all covered by `Drive`. Source/Sink/MU/TransportSurface are included
 * because they spawn or carry movable units at runtime.
 *
 * `SceneButtonMoveable` (plan-417) is a mover too: the cap of a 3D scene button
 * translates or rotates on hover/click. It is listed here — and not left to the
 * component's own thaw in `RVSceneButtonMoveable._bind()` — because ORDER made
 * that thaw useless: components are constructed in Phase 8, this pass runs in
 * Phase 11, so the freeze overwrote `matrixWorldAutoUpdate` again right after.
 * Symptom: the signal toggles and the light switches, but the lever never
 * visibly moves. Being on this list makes the cap dynamic regardless of when it
 * is bound.
 *
 * `PlacementMeta` marks a planner placement (plan-397 phase 6): movable and
 * deletable at runtime, exactly like a freshly dragged-in library object —
 * which stays dynamic because it arrives AFTER this pass. Freezing a BAKED
 * placement kept its drive subtrees dynamic (rolls) but froze the sibling
 * frame nodes, and the planner's move paths write via `updateMatrixWorld(true)`,
 * whose force flag never recomputes a `matrixWorldAutoUpdate=false` node —
 * dragging moved only the rolls while the frame stood still (2026-09-01,
 * DemoPlanner, second layer under the same-day batcher exclusion).
 */
const MOVER_KEY = /^(Drive|Kinematic|Grip|TransportSurface|Source|Sink|MU|Cam|SceneButtonMoveable|Chain|PlacementMeta)/i;

export interface FreezeStaticResult {
  /** Nodes whose matrixWorldAutoUpdate was turned off. */
  frozen: number;
  /** Nodes kept dynamic (movers + their ancestors + their descendants). */
  dynamic: number;
  /** Total nodes visited. */
  total: number;
}

/** True if the node itself carries a motion / MU-spawn component. */
function isMoverNode(node: Object3D): boolean {
  // Already-bound scene-button cap mesh: `RVSceneButtonMoveable._bind()` stamps
  // this marker on the animated mesh even when the extras live on a parent node,
  // and it survives a re-freeze after a runtime placement.
  if (node.userData?._rvSceneButtonMesh === true) return true;
  const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
  if (!rv) return false;
  for (const key in rv) {
    if (rv[key] && MOVER_KEY.test(key)) return true;
  }
  return false;
}

/**
 * Freeze `matrixWorldAutoUpdate` on every provably-static node. Returns counts
 * for diagnostics. Pure with respect to the graph topology — only the
 * `matrixWorldAutoUpdate` flags change. See the file header for the contract.
 */
export function freezeStaticMatrices(
  root: Object3D,
  extraMovers?: readonly Object3D[],
): FreezeStaticResult {
  // Compute every world matrix once so frozen nodes keep their final transform.
  root.updateMatrixWorld(true);

  // Closure of "dynamic": each mover keeps itself, all ancestors and all
  // descendants live. Ancestor walks short-circuit once they hit a node already
  // marked dynamic, so the whole pass stays ~O(nodes).
  const dynamic = new Set<Object3D>();
  const keepAlive = (node: Object3D): void => {
    for (let a: Object3D | null = node; a && !dynamic.has(a); a = a.parent) {
      dynamic.add(a);
    }
    node.traverse((c) => dynamic.add(c));
  };
  root.traverse((node) => {
    if (isMoverNode(node)) keepAlive(node);
  });
  // plan-727: kinematic group members handed in by the caller. The closure above
  // asks a PHYSICAL question — is a mover in my parent chain or my subtree? — and
  // an authoring load answers "no" for a group member, because nothing was
  // re-parented under the axis. The member is still moved by that axis (rigidly,
  // by world delta), so freezing it — or any of its ancestors, which are the
  // recursion gate — would leave the drive running and the geometry standing
  // still. Purely additive: this can only keep MORE nodes dynamic.
  if (extraMovers) for (const node of extraMovers) keepAlive(node);

  let frozen = 0;
  let total = 0;
  root.traverse((node) => {
    total++;
    if (dynamic.has(node)) return;
    if (node.matrixWorldAutoUpdate) {
      node.matrixWorldAutoUpdate = false;
      frozen++;
    }
  });

  return { frozen, dynamic: dynamic.size, total };
}
