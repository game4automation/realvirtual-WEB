// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * structure-baseline — the structure of a runtime stage snapshot, captured in
 * the same synchronous pass as the export tree, and the per-sample check
 * against it (plan-2239 Phase 3, § 2.6 + spike 2026-11-05).
 *
 * The USD live link streams LOCAL matrices per node index. A node that was
 * re-parented, renamed, added or removed since the snapshot would get its new
 * local matrix applied under the OLD USD parent (wrong world pose), or not at
 * all. The baseline records, per exported node: the parent OBJECT, the name and
 * the number of structural children; the live-link guard compares the live
 * scene against it and remounts on any difference.
 *
 * ONE filter decides what a structural child is — for the capture AND for every
 * check (gate round 2: two filters gave baseline 2 / check 0 = endless remount):
 *
 *   isStructChild(c) = !isStageHelper(c) && !exclude.has(c) && !isMu(c)
 *                      && (c.visible || templates.has(c))
 *
 * MUs are never structural: gripping re-parents them (motion, not structure);
 * the tracker poses them in world space.
 *
 * CSR fast path (binding since the spike, 0.14 ms median on 18 225 nodes vs.
 * 1.9–3.7 ms for filtering every child each sample): besides the filtered
 * count, the capture keeps every node's RAW child list (pointer + visible bit)
 * as one compressed-sparse-row array. A check compares the raw children by
 * pointer first; the filter runs only for a node whose raw children differ
 * (an MU or helper came or went, a child turned (in)visible). On that slow path
 * the check compares the IDENTITY of the structural children with the capture
 * (count, then membership through the capture's own index — order-independent),
 * so a swap of equal count (A hidden, B shown) is a change too. The check
 * allocates nothing.
 */

import type { Object3D } from 'three';

const HELPER_FLAGS = [
  '_isSourceGhost', '_isGhostOverlay', '_isSourcePreview', '_isSourceMarker',
  '_highlightOverlay', '_rvGizmo', '_rvGizmoOverlay', '_rvWebLabel', '_rvLabelSprite',
  '_rvLabelPlate', '_agentEyeOverlay', '_tankFillViz', '_pipeFlowViz', '_puHighlightViz',
  '_isSplat', '_muPool', '_rvGroundPlane', '_rvGroundReflector', '_rvRuntimeVisual',
] as const;

/** True for runtime helpers that never belong in the sync stage. */
export function isStageHelper(node: Object3D): boolean {
  const ud = node.userData;
  if (ud) for (let i = 0; i < HELPER_FLAGS.length; i++) if (ud[HELPER_FLAGS[i]]) return true;
  const t = node as unknown as Record<string, boolean | undefined>;
  return !!(t.isInstancedMesh || t.isLine || t.isPoints || t.isSprite || t.isLight || t.isCamera);
}

/** The sets the structural filter reads. */
export interface StructureFilter {
  /** Spawned clone MUs (and anything else) left out of the snapshot. */
  readonly exclude: ReadonlySet<Object3D>;
  /** MU template nodes: exported (and counted) although hidden at runtime. */
  readonly templates: ReadonlySet<Object3D>;
  /** True for an MU node (pre-placed or spawned) — never structural. */
  isMu(node: Object3D): boolean;
}

/** THE structural-child filter, shared by capture and check. */
export function isStructChild(c: Object3D, f: StructureFilter): boolean {
  // Pure AND: the cheap set lookups first, the helper flag scan last.
  return !f.exclude.has(c) && !f.isMu(c) && (c.visible || f.templates.has(c)) && !isStageHelper(c);
}

/** Number of structural children of `node`. */
export function countStructChildren(node: Object3D, f: StructureFilter): number {
  const ch = node.children;
  let k = 0;
  for (let j = 0; j < ch.length; j++) if (isStructChild(ch[j], f)) k++;
  return k;
}

/** Structure of the exported nodes, index = node index of the snapshot. */
export interface StructureBaseline {
  /** The live nodes (the snapshot's node table, never copied). */
  readonly nodes: readonly Object3D[];
  /** `node.parent` at capture — the real object, also for the root. */
  readonly parentRef: ReadonlyArray<Object3D | null>;
  readonly names: readonly string[];
  /** Structural children at capture (see {@link isStructChild}). */
  readonly childCount: Int32Array;
  /** CSR: raw children of node i are `raw[rawStart[i] .. rawStart[i] + rawLen[i])`. */
  readonly raw: readonly Object3D[];
  /** `visible` of every raw child at capture (1/0). */
  readonly rawVis: Uint8Array;
  readonly rawStart: Int32Array;
  readonly rawLen: Int32Array;
  /** Structural children at capture → their position in {@link raw} (slow-path identity check). */
  readonly structAt: ReadonlyMap<Object3D, number>;
}

/** Capture the structure of `nodes` now. Allocates (once per mount / detection). */
export function captureStructure(nodes: readonly Object3D[], f: StructureFilter): StructureBaseline {
  const n = nodes.length;
  const parentRef = new Array<Object3D | null>(n);
  const names = new Array<string>(n);
  const childCount = new Int32Array(n);
  const rawStart = new Int32Array(n);
  const rawLen = new Int32Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) total += nodes[i].children.length;
  const raw = new Array<Object3D>(total);
  const rawVis = new Uint8Array(total);
  const structAt = new Map<Object3D, number>();
  let k = 0;
  for (let i = 0; i < n; i++) {
    const node = nodes[i];
    parentRef[i] = node.parent;
    names[i] = node.name;
    const ch = node.children;
    rawStart[i] = k;
    rawLen[i] = ch.length;
    let count = 0;
    for (let j = 0; j < ch.length; j++, k++) {
      const c = ch[j];
      raw[k] = c;
      rawVis[k] = c.visible ? 1 : 0;
      if (isStructChild(c, f)) { count++; structAt.set(c, k); }
    }
    childCount[i] = count;
  }
  return { nodes, parentRef, names, childCount, raw, rawVis, rawStart, rawLen, structAt };
}

/**
 * True when the structural children of node `i` are the very objects the
 * capture counted (any order). Slow path only; no allocation.
 */
function sameStructChildren(ref: StructureBaseline, i: number, f: StructureFilter): boolean {
  const ch = ref.nodes[i].children;
  const s = ref.rawStart[i];
  const e = s + ref.rawLen[i];
  let count = 0;
  for (let j = 0; j < ch.length; j++) {
    const c = ch[j];
    if (!isStructChild(c, f)) continue;
    const at = ref.structAt.get(c);
    // A structural child the capture did not count at THIS node (new, or shown).
    if (at === undefined || at < s || at >= e) return false;
    count++;
  }
  // Every current one was counted then; equal counts = the same set.
  return count === ref.childCount[i];
}

/**
 * First node index whose structure differs from `ref`, or -1. No allocation.
 * `skipParent[i] = 1` exempts node i from the parent check (pre-placed MUs:
 * gripping re-parents them, a sink detaches them).
 */
export function findStructureChange(ref: StructureBaseline, f: StructureFilter, skipParent?: Uint8Array): number {
  const { nodes, parentRef, names, childCount, raw, rawVis, rawStart, rawLen } = ref;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if ((n.parent !== parentRef[i] && !(skipParent && skipParent[i] === 1)) || n.name !== names[i]) return i;
    const ch = n.children;
    const len = ch.length;
    let same = len === rawLen[i];
    if (same) {
      const s = rawStart[i];
      for (let j = 0; j < len; j++) {
        const c = ch[j];
        if (c !== raw[s + j] || (c.visible ? 1 : 0) !== rawVis[s + j]) { same = false; break; }
      }
    }
    if (!same && !sameStructChildren(ref, i, f)) return i;
  }
  return -1;
}

/** What changed at a node index reported by {@link findStructureChange}. */
export type StructureChangeKind = 're-parent' | 'removed' | 'rename' | 'child added' | 'child removed' | 'child replaced';

export interface StructureChange {
  kind: StructureChangeKind;
  index: number;
  /** Name of the node at capture (for the status line). */
  name: string;
}

/** Classify the change at `index` (diagnostics only, may allocate). */
export function describeStructureChange(ref: StructureBaseline, f: StructureFilter, index: number, skipParent?: Uint8Array): StructureChange {
  const n = ref.nodes[index];
  const name = ref.names[index];
  let kind: StructureChangeKind;
  if (n.parent !== ref.parentRef[index] && !(skipParent && skipParent[index] === 1)) kind = n.parent === null ? 'removed' : 're-parent';
  else if (n.name !== name) kind = 'rename';
  else {
    const now = countStructChildren(n, f);
    kind = now > ref.childCount[index] ? 'child added' : now < ref.childCount[index] ? 'child removed' : 'child replaced';
  }
  return { kind, index, name };
}
