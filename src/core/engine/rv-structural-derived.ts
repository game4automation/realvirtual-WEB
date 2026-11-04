// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-structural-derived — what a structural rebuild leaves behind, and the lock
 * that keeps it out of the saved document (plan-681 §2.2 / §2.3).
 *
 * A model that rebuilds its own structure at runtime (the PalletYard size:
 * modules, conveyors, stackers, the generated path graph) does it TRANSIENTLY
 * inside `viewer.structuralEdit()`: no op log, no undo, not saved — the saved
 * document stays the instance it was loaded as. Two facts make that safe:
 *
 *  - **Generated nodes** carry `extras.realvirtual.Generated = { owner }`: the
 *    composition owns them, `replaceRuntimeSubtree(owner, …)` replaces exactly
 *    those, the path-network tools treat them read-only (`composition-owned`).
 *  - **Derived roots** — every root a rebuild created, moved or reconfigured —
 *    carry `userData._rvStructuralDerived = <owner>` (runtime only, never
 *    written). An authoring op whose target lies at or below such a root, or a
 *    STRUCTURAL op on an ancestor that would carry one along, is refused BEFORE
 *    it applies: `structural-derived-locked` ("Part of the size-derived layout —
 *    change the size instead"). Scene and history stay untouched; a derived
 *    state can never sneak into a saved op.
 *
 * Pure: the lookup of a path is injected, so the rule is node-testable.
 */

import type { Object3D } from 'three';
import type { RvOp } from '../ops/rv-unified-ops';
import { opTargetPaths, isStructuralOpKind } from '../ops/rv-reference-guard';

/** userData key of a derived root — runtime only (underscore keys are never exported). */
export const STRUCTURAL_DERIVED_KEY = '_rvStructuralDerived';
/** userData key of a loaded root's transform before its first structural move. */
export const STRUCTURAL_ORIGIN_KEY = '_rvStructuralOrigin';
/** Refusal code of the lock. */
export const STRUCTURAL_DERIVED_LOCKED = 'structural-derived-locked';
/** What the user reads. */
export const STRUCTURAL_DERIVED_TEXT = 'Part of the size-derived layout — change the size instead';

// ─── Generated marker ─────────────────────────────────────────────────────

/** The composition owner of a generated node (`Generated.owner`), or null. */
export function generatedOwnerOf(node: Object3D | null | undefined): string | null {
  const rv = node ? (node.userData as { realvirtual?: Record<string, unknown> } | undefined)?.realvirtual : undefined;
  const g = rv?.['Generated'];
  if (!g || typeof g !== 'object') return null;
  const o = (g as Record<string, unknown>)['owner'];
  return typeof o === 'string' && o ? o : null;
}

// ─── Derived roots ────────────────────────────────────────────────────────

/** Mark `root` as derived by `owner`'s structural rebuild. */
export function markStructuralDerived(root: Object3D, owner: string): void {
  root.userData[STRUCTURAL_DERIVED_KEY] = owner;
}

/** Remove the derived mark (the root is back at its source state). */
export function clearStructuralDerived(root: Object3D): void {
  delete root.userData[STRUCTURAL_DERIVED_KEY];
}

/** The owner whose rebuild derived `node` or one of its ancestors, or null. */
export function structuralDerivedOwnerOf(node: Object3D | null | undefined): string | null {
  for (let cur: Object3D | null | undefined = node; cur; cur = cur.parent) {
    const v = cur.userData?.[STRUCTURAL_DERIVED_KEY];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

/** True when a derived root lies strictly below `node`. */
export function hasStructuralDerivedBelow(node: Object3D): boolean {
  let found = false;
  node.traverse((d) => {
    if (found || d === node) return;
    if (typeof d.userData?.[STRUCTURAL_DERIVED_KEY] === 'string') found = true;
  });
  return found;
}

/** Every node under (and including) `root` that carries the derived mark of `owner`. */
export function structuralDerivedRoots(root: Object3D, owner: string): Object3D[] {
  const out: Object3D[] = [];
  root.traverse((d) => { if (d.userData?.[STRUCTURAL_DERIVED_KEY] === owner) out.push(d); });
  return out;
}

// ─── The lock ─────────────────────────────────────────────────────────────

/** Why an op is refused. */
export interface StructuralDerivedRefusal {
  code: typeof STRUCTURAL_DERIVED_LOCKED;
  owner: string;
  nodePath: string;
  message: string;
}

/**
 * Is `op` refused by the derived lock? Checks every target path of the op (a
 * composite with all its children, `opTargetPaths`): a target at or below a
 * derived root is refused; a STRUCTURAL op on an ancestor of a derived root is
 * refused too (it would delete / move / reparent the derived root with it). A
 * target that does not resolve is not this rule's business.
 */
export function structuralDerivedRefusal(
  op: RvOp,
  locate: (path: string) => Object3D | null,
): StructuralDerivedRefusal | null {
  const structuralKinds = collectKinds(op);
  for (const path of opTargetPaths(op)) {
    let node = locate(path);
    if (!node) {
      // A path that does not resolve yet (the target of an `addNode` /
      // `createNode` / copy): the op lands under its nearest existing ancestor,
      // and a node created below a derived root is derived content too (Codex
      // review #3). A path nothing of which resolves is not this rule's business.
      const anchor = nearestExisting(path, locate);
      if (anchor) {
        const owner = structuralDerivedOwnerOf(anchor);
        if (owner) return refusal(owner, path);
      }
      continue;
    }
    const owner = structuralDerivedOwnerOf(node);
    if (owner) return refusal(owner, path);
    if (structuralKinds && hasStructuralDerivedBelow(node)) {
      let below: string | null = null;
      node.traverse((d) => { if (!below) below = structuralDerivedOwnerOf(d); });
      return refusal(below ?? 'unknown', path);
    }
  }
  return null;
}

/** The nearest ancestor path of `path` (by `/` segments) that resolves, or null. */
function nearestExisting(path: string, locate: (path: string) => Object3D | null): Object3D | null {
  let p = path;
  for (let cut = p.lastIndexOf('/'); cut > 0; cut = p.lastIndexOf('/')) {
    p = p.slice(0, cut);
    const n = locate(p);
    if (n) return n;
  }
  return null;
}

/** True when the op (or a child of a composite) is a structural kind. */
function collectKinds(op: RvOp): boolean {
  if (op.kind === 'composite') return op.ops.some(collectKinds);
  return isStructuralOpKind(op.kind);
}

function refusal(owner: string, nodePath: string): StructuralDerivedRefusal {
  return {
    code: STRUCTURAL_DERIVED_LOCKED,
    owner,
    nodePath,
    message: `${STRUCTURAL_DERIVED_TEXT} (${nodePath})`,
  };
}

/** The error an op entry rejects with when the lock refuses. */
export class StructuralDerivedLockedError extends Error {
  readonly code = STRUCTURAL_DERIVED_LOCKED;
  readonly refusal: StructuralDerivedRefusal;
  constructor(refusal: StructuralDerivedRefusal) {
    super(`${STRUCTURAL_DERIVED_LOCKED}: ${refusal.message}`);
    this.name = 'StructuralDerivedLockedError';
    this.refusal = refusal;
  }
}

// ─── Kernel API types (rv-viewer.ts) ─────────────────────────────────────

/** One placement a structural rebuild puts into the scene (`viewer.structural.place`). */
export interface StructuralPlacementSpec {
  /** Registry path of the parent (e.g. `PalletYardRoot`). */
  parentPath: string;
  /** Node name = signal scope (`Conveyor_V3`, `Stapler_5`). */
  name: string;
  /** Authored identity of the reference node (`pallet-yard-Conveyor_V3`). */
  nodeId: string;
  assetRef: { assetId: string; path: string };
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale?: [number, number, number];
  /** Further `userData.realvirtual` of the reference node (Agv, station tag, AssetOverrides …). */
  extras?: Record<string, unknown>;
}

/** Result of `viewer.replaceRuntimeSubtree`. */
export interface ReplaceRuntimeSubtreeResult {
  removed: number;
  created: number;
  /** `parentPath/name` of every spec that could not be created. */
  failed: string[];
  /** The created nodes, in spec order. */
  nodes: Object3D[];
}
