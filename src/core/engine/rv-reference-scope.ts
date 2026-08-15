// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-reference-scope — "which reference am I inside?" (plan-703 Phase 7,
 * §2.4.1 / §2.4.2).
 *
 * One question, three consumers: the selection rule (a click picks the
 * OUTERMOST enclosing reference, §2.4.1), the hierarchy dimming predicate
 * (a row inside a foreign reference dims, §2.4.2), and the structural guard
 * (a structural op never reaches into a reference, F8).
 *
 * ## Where this must NOT sit
 *
 * Not in the picking path. `doc-render-picking.md` §2.4 rule 1: nothing may get
 * between `_resolveHit` and its gate order. The outermost-reference rule runs
 * **after** the hit is resolved, at the same place the existing viewport
 * resolution (`findLayoutObjectAncestor`, `rv-extras-editor.tsx:283-300`) already
 * runs. This module is a pure `Object3D`-parent walk; it never raycasts, never
 * touches an arena, never reads a batch table.
 *
 * ## The walk is inclusive, and cached the same way
 *
 * `findLayoutObjectAncestor` is documented as "nearest ancestor (inclusive)",
 * and this follows it: clicking the reference node itself must yield that
 * reference, not its parent's. An `embedded` reference is skipped throughout —
 * the flat export inlined the subtree and left the marker as a provenance note,
 * so there is nothing behind it to be "inside of".
 */

import type { Object3D } from 'three';
import { getAssetReference } from './rv-asset-reference';

/** Where a selection request came from — mirrors `SelectionSource`. */
export type ReferenceSelectionSource = 'tree' | 'viewport' | 'api';

/**
 * The unresolved reference nodes enclosing `node`, **outermost first**.
 *
 * Inclusive: `node` itself is the last entry when it is a reference node.
 * `boundary` (typically `viewer.currentModelRoot`) stops the walk; without it
 * the walk runs to the scene root, which for a grafted subtree would climb out
 * of the document.
 */
export function referenceChain(node: Object3D, boundary?: Object3D | null): Object3D[] {
  const chain: Object3D[] = [];
  let current: Object3D | null = node;
  while (current) {
    const ref = getAssetReference(current);
    // `embedded` is not a scope: the subtree is already part of this file.
    if (ref && ref.embedded !== true) chain.push(current);
    if (boundary && current === boundary) break;
    current = current.parent;
  }
  // Collected child→parent; the addressing everywhere else is outermost-first.
  return chain.reverse();
}

/** The outermost enclosing reference node (inclusive), or null. */
export function outermostReference(node: Object3D, boundary?: Object3D | null): Object3D | null {
  return referenceChain(node, boundary)[0] ?? null;
}

/**
 * Is `node` inside (or itself) a reference?
 *
 * The dimming predicate of §2.4.2 in one call. Short-circuits rather than
 * building the chain, because the hierarchy asks it once per visible row.
 */
export function isInsideReference(node: Object3D, boundary?: Object3D | null): boolean {
  let current: Object3D | null = node;
  while (current) {
    const ref = getAssetReference(current);
    if (ref && ref.embedded !== true) return true;
    if (boundary && current === boundary) break;
    current = current.parent;
  }
  return false;
}

// ─── The selection rule (§2.4.1, F10) ───────────────────────────────────

export interface ReferenceSelectionResult {
  /** What should actually be selected. */
  node: Object3D;
  /**
   * How deep into the chain the selection sits. `0` is the outermost
   * reference; `chain.length` means "past the last reference" — the hit itself.
   */
  drillLevel: number;
  /** True when the hit was resolved UP to an enclosing reference. */
  resolved: boolean;
}

/**
 * Resolve a hit to what the user means to select.
 *
 * The rule from decision 22, whole: a click selects the outermost reference; a
 * double-click goes one level in; Escape comes one level out. Expressing it as
 * a pure function of (hit, source, drillLevel) — rather than as a stateful
 * walker — is what makes §9.6 a unit test instead of an interaction test.
 *
 * Source `'tree'` does NOT resolve. The hierarchy shows the real structure and
 * the user clicked a specific row; silently selecting an ancestor there would
 * make the tree disagree with itself. This mirrors the existing
 * `SelectionSource` contract (`rv-extras-editor.tsx:245-272`), where only
 * `'viewport'` walks up.
 */
export function resolveReferenceSelection(
  hit: Object3D,
  source: ReferenceSelectionSource,
  drillLevel: number,
  boundary?: Object3D | null,
): ReferenceSelectionResult {
  if (source === 'tree') return { node: hit, drillLevel: 0, resolved: false };

  const chain = referenceChain(hit, boundary);
  if (chain.length === 0) return { node: hit, drillLevel: 0, resolved: false };

  const level = Math.max(0, Math.min(drillLevel, chain.length));
  return level < chain.length
    ? { node: chain[level], drillLevel: level, resolved: true }
    : { node: hit, drillLevel: level, resolved: false };
}

/**
 * The drill state behind {@link resolveReferenceSelection}.
 *
 * Holds two things and no more: how deep we are, and in which chain. The anchor
 * matters because a drill level is only meaningful relative to one hit — clicking
 * a different object under a different reference must start at the outermost
 * again, or the second click would land mid-chain for no reason the user can see.
 */
export class RvReferenceDrill {
  private _level = 0;
  private _anchor: Object3D | null = null;

  get drillLevel(): number { return this._level; }
  get anchor(): Object3D | null { return this._anchor; }

  /** Forget the drill — a new selection elsewhere, or leaving the mode. */
  reset(): void {
    this._level = 0;
    this._anchor = null;
  }

  /**
   * A plain click. Resets the drill unless it is the same anchor, so repeatedly
   * clicking the same part does not walk inwards by itself — only a
   * double-click does that.
   */
  select(
    hit: Object3D,
    source: ReferenceSelectionSource,
    boundary?: Object3D | null,
  ): ReferenceSelectionResult {
    if (this._anchor !== hit) {
      this._anchor = hit;
      this._level = 0;
    }
    const result = resolveReferenceSelection(hit, source, this._level, boundary);
    this._level = result.drillLevel;
    return result;
  }

  /**
   * Double-click: one level in.
   *
   * Clamped at the chain length, where the selection is the hit itself — there
   * is nothing deeper to drill to, and clamping keeps a fast double-double-click
   * from running the level off into a number nothing can undo.
   */
  drillIn(hit: Object3D, boundary?: Object3D | null): ReferenceSelectionResult {
    if (this._anchor !== hit) { this._anchor = hit; this._level = 0; }
    const chain = referenceChain(hit, boundary);
    this._level = Math.min(this._level + 1, chain.length);
    return resolveReferenceSelection(hit, 'viewport', this._level, boundary);
  }

  /** Escape: one level out, floor 0 (the outermost reference). */
  drillOut(hit: Object3D, boundary?: Object3D | null): ReferenceSelectionResult {
    if (this._anchor !== hit) { this._anchor = hit; this._level = 0; }
    this._level = Math.max(0, this._level - 1);
    return resolveReferenceSelection(hit, 'viewport', this._level, boundary);
  }
}
