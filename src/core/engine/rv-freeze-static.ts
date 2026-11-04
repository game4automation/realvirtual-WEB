// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-freeze-static.ts — Prune the per-frame matrix recursion on large scenes.
 *
 * On a big CAD model the scene graph holds tens of thousands of structural
 * Group nodes. Three.js walks ALL of them every frame in
 * `scene.updateMatrixWorld()` — measured as the dominant CPU cost (~2x the
 * render-loop time on the large CAD line, ~40 ms/frame), paid even when nothing
 * moves and again on every post-processing pass that re-renders the scene.
 *
 * This pass sets `matrixWorldAutoUpdate = false` AND `matrixAutoUpdate = false`
 * on every node that is provably static. Three.js (r185) has no recursion gate:
 * `updateMatrixWorld` visits every child and re-composes the LOCAL matrix of
 * every node with `matrixAutoUpdate`, whatever `matrixWorldAutoUpdate` says —
 * freezing only the world flag left ~23k static nodes composing a matrix
 * per frame and per pass (profile 2026-09-17). Every thaw site
 * (`ensureMovableTransform`, placement materialize, scene-button bind, chain
 * clones, the editor's drive preview) re-enables both flags together.
 *
 * This pass is the LAST WORD on BOTH flags, in both directions (plan-673): a
 * local mover gets `matrixAutoUpdate = true` FORCED on, everything else gets it
 * forced off. Until plan-673 the pass could only tighten — a local mover was
 * merely exempted — so a `false` written by an earlier pass survived, and a
 * `FreeBody` obstacle whose `position` the MuJoCo mirror had advanced 506.0 mm
 * drew at 0.0000 mm (live walker demo, 40.8 s). If you add a pass that writes
 * `matrixAutoUpdate` AFTER this one, that claim stops being true and this
 * comment has to change with it.
 * A node is kept DYNAMIC iff it,
 * one of its ancestors, or one of its descendants carries a component whose
 * bake role is `chunk` (a mover: Drive(*), Kinematic, Grip, SceneButtonMoveable,
 * ChainElement, PlacementMeta …) or `keep` (runtime-mutated originals: Source,
 * Sink, MU, TransportSurface, Chain, ribbon web …) — see `bakeRoleOf()` in
 * rv-component-registry.ts and {@link isMoverNode}. That closure keeps alive:
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
 * MUST run AFTER kinematic re-parenting and the bake, on the FINAL hierarchy — earlier the parent chains (and therefore the mover closure)
 * are not yet correct. World matrices are computed once up front so every frozen
 * node holds its correct, final transform.
 */

import type { Object3D } from 'three';
import { bakeRoleOf } from './rv-component-registry';

/**
 * Which component keeps a node matrix-dynamic is no longer a key list here but
 * the component's own `capabilities.bake` (plan-753 §2.3): every type whose
 * role is `chunk` or `keep` is a mover. The reasons the old list carried live
 * on in the declarations — e.g. `SceneButtonMoveable` (plan-417: the cap
 * translates on click, and the component's own thaw in `_bind()` ran BEFORE
 * this pass and was overwritten by it) and `PlacementMeta` (plan-397 phase 6:
 * a baked planner placement moves as one unit; freezing its frame nodes made a
 * drag move only the rolls, 2026-09-01 DemoPlanner). Types without a component
 * module (`PlacementMeta`, `Cam`) are registered in rv-scene-loader.ts.
 * The Phase-1 `LEGACY_KEEP_OVERRIDE` (TransportSurface / Sink / Cam kept
 * dynamic for the arena batcher) went with that batcher in plan-753 Phase 4b —
 * the registry roles are the only source now.
 *
 * An authored `rv.BakeRole` extras value on a node overrides the type role.
 */

/**
 * plan-460 F11: a `RibbonRoller` with `SpinMode: Texture` deliberately does NOT
 * move — it scrolls its mantle map and leaves the node quaternion alone, which
 * makes it the one web component that may be frozen. Any other value, and a
 * missing field, keep the plan-459 behaviour (dynamic). Passed to `bakeRoleOf`
 * as the skip predicate so the roller's `keep` role is ignored for THAT node
 * only (it stays `keep` for the batcher, which has no per-instance UV offset).
 *
 * `RibbonDancer` extends the roller but TRANSLATES, so it must never qualify —
 * hence the exact `RibbonRoller` type rather than a loose `Ribbon` prefix.
 */
function isTextureRoller(type: string, config: unknown): boolean {
  return type === 'RibbonRoller' && (config as { SpinMode?: unknown }).SpinMode === 'Texture';
}

export interface FreezeStaticResult {
  /** Nodes whose matrixWorldAutoUpdate was turned off. */
  frozen: number;
  /** Nodes kept dynamic (movers + their ancestors + their descendants). */
  dynamic: number;
  /** Total nodes visited. */
  total: number;
  /** The dynamic closure itself — movers, their ancestors and descendants.
   *  Everything else is provably static (input of the ghost data tree). */
  dynamicNodes: ReadonlySet<Object3D>;
}

/** True for a placement root, or a node carrying a component with bake role `chunk` or `keep`. */
export function isMoverNode(node: Object3D): boolean {
  // Already-bound scene-button cap mesh: `RVSceneButtonMoveable._bind()` stamps
  // this marker on the animated mesh even when the extras live on a parent node,
  // and it survives a re-freeze after a runtime placement.
  if (node.userData?._rvSceneButtonMesh === true) return true;
  // A placement root moves as ONE unit, whatever stamp it carries. A RELOADED
  // reference node has `PlacementMeta` (a `chunk` role) from the GLB; a LIVE
  // drop (`PlacementInstancer.materialize` → `stampPlacementMarkers`) and a
  // NESTED placement root carry only the runtime markers `_layoutId` /
  // `_layoutNestedOf`. Without this the placement freeze (integratePlacedContent
  // F13) froze a live-dropped conveyor's frame chunks while the drive nodes
  // stayed dynamic — a drag moved the rolls and left the frame behind
  // (2026-09-24, tests/placement-move-follows-root.test.ts).
  const ud = node.userData;
  if (typeof ud?._layoutId === 'string' || typeof ud?._layoutNestedOf === 'string') return true;
  const role = bakeRoleOf(node, isTextureRoller);
  return role === 'chunk' || role === 'keep';
}

/**
 * Freeze `matrixWorldAutoUpdate` on every provably-static node. Returns counts
 * for diagnostics. Pure with respect to the graph topology — only the
 * `matrixWorldAutoUpdate` and `matrixAutoUpdate` flags change, and this pass
 * sets BOTH of them in both directions (see the file header: a local mover is
 * forced dynamic, everything else forced static). Nothing is re-parented, no
 * transform is written. See the file header for the contract.
 */
export function freezeStaticMatrices(
  root: Object3D,
  extraMovers?: readonly Object3D[],
  /** `extraMoversReparented`: a RUNTIME load re-parented the kinematic group
   *  members under their axis — they ride along and nobody writes their local
   *  transform, so they need no per-frame local re-compose. An authoring load
   *  moves them by world delta (writes `position`), so there they stay local
   *  movers (the default). */
  opts?: { extraMoversReparented?: boolean },
): FreezeStaticResult {
  // Compute every world matrix once so frozen nodes keep their final transform.
  root.updateMatrixWorld(true);

  // Closure of "dynamic": each mover keeps itself, all ancestors and all
  // descendants live. Ancestor walks short-circuit once they hit a node already
  // marked dynamic, so the whole pass stays ~O(nodes).
  const dynamic = new Set<Object3D>();
  // Nodes whose LOCAL transform is written at runtime: the movers themselves.
  // Their ancestors and descendants only need a live WORLD matrix — their
  // local matrix is as constant as a static node's, so they stop re-composing
  // it (16k nodes under the large CAD line's 169 drives, per frame AND per pass).
  const localMovers = new Set<Object3D>();
  const keepAlive = (node: Object3D, writesLocal = true): void => {
    if (writesLocal) localMovers.add(node);
    for (let a: Object3D | null = node; a && !dynamic.has(a); a = a.parent) {
      dynamic.add(a);
    }
    node.traverse((c) => dynamic.add(c));
  };
  root.traverse((node) => {
    if (isMoverNode(node)) keepAlive(node, true);
  });
  // plan-727: kinematic group members handed in by the caller. The closure above
  // asks a PHYSICAL question — is a mover in my parent chain or my subtree? — and
  // an authoring load answers "no" for a group member, because nothing was
  // re-parented under the axis. The member is still moved by that axis (rigidly,
  // by world delta), so freezing it — or any of its ancestors, which are the
  // recursion gate — would leave the drive running and the geometry standing
  // still. Purely additive: this can only keep MORE nodes dynamic.
  if (extraMovers) for (const node of extraMovers) keepAlive(node, opts?.extraMoversReparented !== true);

  let frozen = 0;
  let total = 0;
  root.traverse((node) => {
    total++;
    if (dynamic.has(node)) {
      if (localMovers.has(node)) {
        // plan-673: FORCE the flag on, do not merely skip the freeze. A local
        // mover's whole point is that something writes its `position` /
        // `quaternion` at runtime, and with `matrixAutoUpdate = false` Three.js
        // never re-composes the local matrix, so the write reaches neither
        // `matrix` nor `matrixWorld` nor the drawn chunk. Exempting it here was
        // not enough, because an EARLIER pass can already have turned the flag
        // off: `processMeshes()` in rv-scene-loader.ts classifies a mesh static
        // from a key list that does not know every pose-writing component, and
        // `makeTemplateNode()` (rv-bake-pipeline.ts) copies that `false` into
        // the baked template. Measured on the walker demo before this line: an
        // obstacle `FreeBody` whose `position` had advanced 506.0 mm drew at
        // 0.0000 mm; the identical write with the flag on drew the full
        // 300.00 mm of the control. Forcing it here makes this pass the actual
        // last word on `matrixAutoUpdate` instead of a one-way ratchet, so the
        // NEXT component type missing from that key list is a performance
        // regression at worst, not an invisible frozen body.
        node.matrixAutoUpdate = true;
      } else if (node !== root) {
        node.matrixAutoUpdate = false;
      }
      return;
    }
    // Local matrices are current (the forced update above composed them).
    node.matrixAutoUpdate = false;
    if (node.matrixWorldAutoUpdate) {
      node.matrixWorldAutoUpdate = false;
      frozen++;
    }
  });

  return { frozen, dynamic: dynamic.size, total, dynamicNodes: dynamic };
}
