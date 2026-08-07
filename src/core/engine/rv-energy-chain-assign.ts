// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-energy-chain-assign.ts — automatic anchor/follower assignment for
 * `EnergyChain` (plan-362 §2.5, requirement F3).
 *
 * Which of the two chain ends moves is the ONE quantity the geometry cannot
 * give away: both open strand ends look exactly alike, they only differ by
 * which one is bolted to something that travels. `rv-energy-chain-path.ts`
 * therefore measures everything else and reports both ends neutrally; this
 * module answers the remaining question from the SCENE CONTEXT.
 *
 * ## The two stages
 *
 * 1. **Drive context.** Every `Drive` whose travel direction is parallel to the
 *    chain's measured drive axis is a candidate. The chain end that lies inside
 *    (or nearest to) that drive's moved subtree is the moving one.
 * 2. **Kinematic membership.** With no matching drive, the same proximity test
 *    runs against the nodes that carry a `Kinematic` extra — the other way a
 *    subtree gets moved in this viewer.
 *
 * A third stage from the plan — watching for relative motion at runtime and
 * latching onto whatever moves first — is deliberately NOT implemented. It
 * would need a per-frame scan of the whole scene for a node moving relative to
 * the chain (there is no candidate set left once stages 1 and 2 came up empty),
 * which contradicts the allocation-free tick, and its "latch and never revise"
 * rule would happily lock onto an unrelated passing MU and stay wrong forever.
 * Finding nothing and holding the CAD rest pose (F5) is strictly better than
 * that.
 *
 * ## Two rules that keep this from guessing
 *
 * - **Ambiguity margin.** The two strand ends sit `2R` apart. A candidate only
 *   decides when the nearer end beats the farther one by at least `R`; a big
 *   carriage box that swallows both ends decides nothing and is skipped.
 * - **Proximity gate.** A candidate further away than the chain's own length
 *   cannot plausibly be what this chain follows and is ignored, however well
 *   its axis matches.
 *
 * Everything is computed in the CHAIN-LOCAL BIND FRAME (plan §2.8), never in
 * world space, and nothing here looks at a node NAME or a child index — the
 * reference chain's children are called `28`/`31` (CAD import order).
 */

import { Box3, Matrix4, Object3D, Quaternion, Vector3 } from 'three';
import type { NodeRegistry } from './rv-node-registry';
import type { RVDrive } from './rv-drive';
import {
  RV_CHAIN_PROXY,
  RV_CHAIN_SKIN,
  RV_CHAIN_SOURCE,
  traverseMeshes,
} from './rv-traverse-utils';

/** How the moving end of a chain was determined. */
export type AssignmentStage = 'reference' | 'drive' | 'kinematic' | 'none';

/** The two open strand ends of a chain, in bind-frame coordinates. */
export interface StrandEnds {
  /** Open end of the strand at the SMALLER transverse coordinate. */
  low: Vector3;
  /** Open end of the strand at the LARGER transverse coordinate. */
  high: Vector3;
}

export interface AutoFollowerInput {
  /** The node carrying the component — origin of the bind frame. */
  chainRoot: Object3D;
  registry: NodeRegistry;
  ends: StrandEnds;
  /** Index of the drive axis in the bind frame (0/1/2). */
  uIndex: number;
  /** Bend radius in bind-frame units — half the strand separation. */
  bendRadius: number;
  /** Total centerline length in bind-frame units — the proximity gate. */
  chainLength: number;
}

export interface AutoFollowerResult {
  /** The scene node the chain should follow. */
  node: Object3D;
  /** `true` when the moving strand is the one at the larger transverse coordinate. */
  movingIsHigh: boolean;
  stage: 'drive' | 'kinematic';
  /** Bind-frame distance from the candidate to the moving end (0 = inside). */
  distance: number;
}

/**
 * How parallel a drive's travel direction must be to the chain's drive axis.
 * `0.99` is roughly 8° — enough slack for CAD misalignment, nowhere near
 * enough to let a perpendicular axis through.
 */
const AXIS_PARALLEL_MIN = 0.99;

// Scratch — this runs at rigging time, not per frame, but the allocations are
// free to avoid and the module has no reentrancy.
const _box = new Box3();
const _probe = new Vector3();
const _axis = new Vector3();
const _quat = new Quaternion();
const _parentQuat = new Quaternion();

interface Probe {
  ends: StrandEnds;
  bindInv: Matrix4;
  margin: number;
  maxDistance: number;
}

interface Candidate {
  node: Object3D;
  movingIsHigh: boolean;
  distance: number;
}

/**
 * Find the node the chain's moving end follows, or `null` when the scene gives
 * no unambiguous answer — in which case the caller degrades to the CAD rest
 * pose (F5). Never throws.
 */
export function findAutoFollower(input: AutoFollowerInput): AutoFollowerResult | null {
  const { chainRoot, registry } = input;
  chainRoot.updateWorldMatrix(true, false);

  const probe: Probe = {
    ends: input.ends,
    bindInv: new Matrix4().copy(chainRoot.matrixWorld).invert(),
    margin: input.bendRadius,
    maxDistance: input.chainLength,
  };
  const bindQuatInv = chainRoot.getWorldQuaternion(new Quaternion()).invert();

  // ── Stage 1: drive context ────────────────────────────────────────
  let best: Candidate | null = null;
  for (const { instance } of registry.getAll<RVDrive>('Drive')) {
    const node = instance?.node;
    if (!node || !isMotionCandidate(node, chainRoot)) continue;
    if (!travelsAlongAxis(instance, input.uIndex, bindQuatInv)) continue;
    const hit = probeSubtree(node, probe);
    if (hit && (!best || hit.distance < best.distance)) best = hit;
  }
  if (best) return { ...best, stage: 'drive' };

  // ── Stage 2: kinematic membership ─────────────────────────────────
  const seen = new Set<Object3D>();
  registry.forEachNode((path, node) => {
    if (seen.has(node)) return;
    const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
    if (!rv || !rv['Kinematic']) return;
    seen.add(node);
    if (!isMotionCandidate(node, chainRoot)) return;
    // A kinematic node driven along an axis the chain does NOT run on cannot be
    // what this chain follows — skipping it here is what keeps stage 2 from
    // quietly re-admitting the drives stage 1 just rejected.
    const drive = registry.getByPath<RVDrive>('Drive', path);
    if (drive && !travelsAlongAxis(drive, input.uIndex, bindQuatInv)) return;
    const hit = probeSubtree(node, probe);
    if (hit && (!best || hit.distance < best.distance)) best = hit;
  });
  if (best) return { ...(best as Candidate), stage: 'kinematic' };

  return null;
}

/**
 * Distance from a candidate's moved subtree to each strand end, decided per
 * MESH rather than over one subtree box: a gantry carriage modelled as several
 * parts otherwise collapses into a single box that swallows both ends and
 * decides nothing.
 *
 * Returns `null` when the candidate is too far away or cannot tell the two ends
 * apart — "no answer" is a valid, and here the only honest, outcome.
 */
function probeSubtree(root: Object3D, probe: Probe): Candidate | null {
  root.updateWorldMatrix(true, true);

  let dLow = Infinity;
  let dHigh = Infinity;
  let meshes = 0;

  traverseMeshes(root, (mesh) => {
    const ud = mesh.userData as Record<string, unknown>;
    if (ud[RV_CHAIN_PROXY] || ud[RV_CHAIN_SKIN] || ud[RV_CHAIN_SOURCE] || ud._rvGizmo) return;
    if (!mesh.geometry?.getAttribute('position')) return;
    meshes++;
    _box.setFromObject(mesh).applyMatrix4(probe.bindInv);
    const dl = _box.distanceToPoint(probe.ends.low);
    const dh = _box.distanceToPoint(probe.ends.high);
    if (dl < dLow) dLow = dl;
    if (dh < dHigh) dHigh = dh;
  });

  if (meshes === 0) {
    // A pure transform node (very common for an axis node) still has a usable
    // position — fall back to its origin rather than discarding the candidate.
    _probe.setFromMatrixPosition(root.matrixWorld).applyMatrix4(probe.bindInv);
    dLow = _probe.distanceTo(probe.ends.low);
    dHigh = _probe.distanceTo(probe.ends.high);
  }
  if (!Number.isFinite(dLow) || !Number.isFinite(dHigh)) return null;

  const near = Math.min(dLow, dHigh);
  if (near > probe.maxDistance) return null;
  if (Math.max(dLow, dHigh) - near < probe.margin) return null;

  return { node: root, movingIsHigh: dHigh < dLow, distance: near };
}

/**
 * Whether a linear drive travels parallel to the chain's drive axis.
 *
 * The drive's axis is authored in the node's own frame with `ReverseDirection`
 * already applied; `applyToNode()` rotates it by the node's HOME orientation
 * and adds it to `node.position`, which lives in the PARENT's frame — so the
 * world direction is `parentWorldQuat · homeQuat · axis`. Compared as `|dot|`,
 * because a chain does not care which way along its axis the carriage travels.
 */
function travelsAlongAxis(drive: RVDrive, uIndex: number, bindQuatInv: Quaternion): boolean {
  if (drive.isRotary) return false;
  drive.getAxis(_axis);
  if (_axis.lengthSq() < 1e-6) return false; // Direction === Virtual
  _axis.applyQuaternion(drive.getHomeLocalQuaternion(_quat));
  const parent = drive.node.parent;
  if (parent) _axis.applyQuaternion(parent.getWorldQuaternion(_parentQuat));
  _axis.applyQuaternion(bindQuatInv).normalize();
  return Math.abs(_axis.getComponent(uIndex)) >= AXIS_PARALLEL_MIN;
}

/**
 * A node may only stand in for the moving end when it moves RELATIVE to the
 * chain root. An ancestor carries the whole chain along (no relative motion,
 * and it could never distinguish the two ends); a descendant is part of the
 * chain itself.
 */
function isMotionCandidate(node: Object3D, chainRoot: Object3D): boolean {
  if (node === chainRoot) return false;
  return !isAncestorOf(node, chainRoot) && !isAncestorOf(chainRoot, node);
}

function isAncestorOf(candidate: Object3D, node: Object3D): boolean {
  let cur: Object3D | null = node.parent;
  while (cur) {
    if (cur === candidate) return true;
    cur = cur.parent;
  }
  return false;
}
