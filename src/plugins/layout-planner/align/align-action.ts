// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * align-action.ts — evaluation and execution of one Align (plan-779).
 *
 * `evaluateAlign` derives everything the panel and the preview show (world
 * corners, target, delta, whether Align may run) from the current scene, so
 * the result is absolute and repeatable. `runAlign` moves A — or its whole
 * snap chain when chain mode is on, exactly like a gizmo drag — by that delta
 * through `layout.move`, all inside ONE scene-store transaction (= one undo
 * step; nested transactions fold into the outer one).
 */

import { Vector3, type Object3D } from 'three';
import { commandRegistry } from '../../../core/hmi/rv-command-registry';
import { getSceneStore } from '../../../core/hmi/scene/scene-store-singleton';
import type { RVViewer } from '../../../core/rv-viewer';
import { isLockedLayoutInstance } from '../layout-predicates';
import { ALIGN_EPSILON_M, computeAlignDelta, translateInParentFrame } from './align-math';
import { getAlignSnapshot, isSlotAlive, type AlignSlot } from './align-state';

/** The planner surface Align needs (structural — no import of the plugin class). */
interface PlannerLike {
  getPlacedRootById(id: string): Object3D | null;
  findPlacedIdByRoot(root: Object3D): string | null;
  recordParentOf(id: string): Object3D | null;
  store?: { chainModeEnabled?: boolean };
}

/** The snap-point plugin surface Align needs (structural, optional plugin). */
interface SnapLike {
  chainRootsFor(root: Object3D): Object3D[];
  detachAssetConnections(root: Object3D): void;
}

export interface AlignEvaluation {
  cornerA: Vector3 | null;
  cornerB: Vector3 | null;
  /** cornerA + delta — where corner A will land. */
  target: Vector3 | null;
  /** World delta in metres (zero when not computable). */
  delta: Vector3;
  aAlive: boolean;
  bAlive: boolean;
  /** Placement roots that would move (A first). Empty when A is not alive. */
  members: Object3D[];
  /** True when Align would move something. */
  canAlign: boolean;
}

const _delta = new Vector3();
const _tmp = new Vector3();

export function plannerOf(viewer: RVViewer): PlannerLike | null {
  return (viewer.getPlugin('layout-planner') as unknown as PlannerLike | undefined) ?? null;
}

function snapOf(viewer: RVViewer): SnapLike | null {
  const p = viewer.getPlugin('snap-point') as unknown as Partial<SnapLike> | undefined;
  return p && typeof p.chainRootsFor === 'function' && typeof p.detachAssetConnections === 'function'
    ? (p as SnapLike)
    : null;
}

/**
 * Recompute `node.matrixWorld` from the current local transforms of the whole
 * ancestor chain, top-down. A plain `updateWorldMatrix(true, false)` is not
 * enough right after a move: chunk meshes (and any node with
 * `matrixAutoUpdate = false`) are never flagged dirty, so three.js keeps their
 * pre-move world matrix until the next render's scene walk. Nodes frozen with
 * `matrixWorldAutoUpdate = false` keep their authoritative matrix (three.js
 * skips them). Allocation-free; O(depth).
 */
export function forceWorldMatrix(node: Object3D): void {
  if (node.parent) forceWorldMatrix(node.parent);
  node.updateWorldMatrix(false, false, true);
}

/** World position of a slot's corner (world matrices refreshed first). */
export function slotCornerWorld(slot: AlignSlot, out: Vector3): Vector3 {
  forceWorldMatrix(slot.mesh);
  return out.copy(slot.cornerLocal).applyMatrix4(slot.mesh.matrixWorld);
}

export function evaluateAlign(viewer: RVViewer): AlignEvaluation {
  const s = getAlignSnapshot();
  const aAlive = isSlotAlive(s.a);
  const bAlive = isSlotAlive(s.b);
  const cornerA = aAlive && s.a ? slotCornerWorld(s.a, new Vector3()) : null;
  const cornerB = bAlive && s.b ? slotCornerWorld(s.b, new Vector3()) : null;
  const delta = new Vector3();
  let target: Vector3 | null = null;
  let members: Object3D[] = [];
  if (cornerA && cornerB) {
    computeAlignDelta(cornerA, cornerB, s.axes, s.offsetMm, delta);
    target = cornerA.clone().add(delta);
  }
  if (aAlive && s.a?.root) {
    members = snapOf(viewer)?.chainRootsFor(s.a.root) ?? [s.a.root];
    if (members[0] !== s.a.root) members = [s.a.root, ...members.filter((m) => m !== s.a!.root)];
  }
  const anyLocked = members.some((m) => isLockedLayoutInstance(m));
  const anyAxis = s.axes.x || s.axes.y || s.axes.z;
  const canAlign = !!(cornerA && cornerB && anyAxis && !anyLocked && members.length > 0
    && delta.length() >= ALIGN_EPSILON_M);
  return { cornerA, cornerB, target, delta, aAlive, bAlive, members, canAlign };
}

/** Run one Align. Resolves true when something moved. */
export async function runAlign(viewer: RVViewer): Promise<boolean> {
  const ev = evaluateAlign(viewer);
  const s = getAlignSnapshot();
  const planner = plannerOf(viewer);
  if (!ev.canAlign || !planner || !s.a?.root) return false;
  _delta.copy(ev.delta);

  // Resolve every member's new record position BEFORE moving anything.
  const moves: { id: string; x: number; y: number; z: number }[] = [];
  for (const m of ev.members) {
    const id = planner.findPlacedIdByRoot(m);
    const parent = id ? planner.recordParentOf(id) : null;
    if (!id || !parent) return false;
    forceWorldMatrix(parent);
    forceWorldMatrix(m);
    _tmp.setFromMatrixPosition(m.matrixWorld);
    const [x, y, z] = translateInParentFrame(_tmp, parent.matrixWorld, _delta);
    moves.push({ id, x, y, z });
  }

  const chainOn = planner.store?.chainModeEnabled ?? true;
  const aRoot = s.a.root;
  const label = `Align ${s.a.label}`;
  const body = async (): Promise<void> => {
    if (!chainOn) snapOf(viewer)?.detachAssetConnections(aRoot);
    for (const mv of moves) {
      // Rotation omitted on purpose: layout.move keeps the record's rotation.
      const r = await commandRegistry.execute('layout.move', mv, { origin: 'ui', viewer });
      if (!r.ok) throw new Error(r.reason);
    }
  };
  const store = getSceneStore();
  try {
    if (store) await store.withTransaction(label, body);
    else await body();
  } catch (e) {
    console.warn('[align] Align aborted:', e instanceof Error ? e.message : e);
    return false;
  }
  return true;
}
