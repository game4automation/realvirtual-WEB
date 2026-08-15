// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * §9.6 — the outermost-reference selection rule (plan-703 Phase 7, §2.4.1).
 *
 * Renderer-free by construction: the rule is a pure function of (hit, source,
 * drill level) over an `Object3D` parent chain, so the whole of decision 22 can
 * be checked against three nested references built by hand — no GLB, no
 * `WebGLRenderer`, no picking. That is deliberate rather than convenient: the
 * rule must NOT live in the picking path (`doc-render-picking.md` §2.4 rule 1),
 * and a test that needed a raycast to reach it would be evidence that it does.
 */
import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import { setAssetReference } from '../src/core/engine/rv-asset-reference';
import {
  RvReferenceDrill,
  isInsideReference,
  outermostReference,
  referenceChain,
  resolveReferenceSelection,
} from '../src/core/engine/rv-reference-scope';

/**
 * root
 *  +- plain
 *     +- refA           (AssetReference "A")  <- outermost
 *        +- midA
 *           +- refB     (AssetReference "B")
 *              +- midB
 *                 +- refC  (AssetReference "C")
 *                    +- leaf                  <- the click target
 */
function buildThreeDeep() {
  const root = new Object3D(); root.name = 'root';
  const plain = new Object3D(); plain.name = 'plain'; root.add(plain);
  const refA = new Object3D(); refA.name = 'refA'; plain.add(refA);
  const midA = new Object3D(); midA.name = 'midA'; refA.add(midA);
  const refB = new Object3D(); refB.name = 'refB'; midA.add(refB);
  const midB = new Object3D(); midB.name = 'midB'; refB.add(midB);
  const refC = new Object3D(); refC.name = 'refC'; midB.add(refC);
  const leaf = new Object3D(); leaf.name = 'leaf'; refC.add(leaf);

  setAssetReference(refA, { assetId: 'A' });
  setAssetReference(refB, { assetId: 'B' });
  setAssetReference(refC, { assetId: 'C' });
  return { root, plain, refA, midA, refB, midB, refC, leaf };
}

describe('reference chain', () => {
  it('lists the enclosing references OUTERMOST first', () => {
    const t = buildThreeDeep();
    expect(referenceChain(t.leaf, t.root).map((n) => n.name)).toEqual(['refA', 'refB', 'refC']);
  });

  it('is inclusive — a reference node appears in its own chain', () => {
    const t = buildThreeDeep();
    expect(referenceChain(t.refC, t.root).map((n) => n.name)).toEqual(['refA', 'refB', 'refC']);
  });

  it('stops at the boundary rather than climbing out of the document', () => {
    const t = buildThreeDeep();
    // Boundary at refB: refA sits above it and must not be reported.
    expect(referenceChain(t.leaf, t.refB).map((n) => n.name)).toEqual(['refB', 'refC']);
  });

  it('ignores an embedded reference — the flat export already inlined it', () => {
    const t = buildThreeDeep();
    setAssetReference(t.refB, { assetId: 'B', embedded: true });
    expect(referenceChain(t.leaf, t.root).map((n) => n.name)).toEqual(['refA', 'refC']);
  });

  it('is empty for the open file’s own content', () => {
    const t = buildThreeDeep();
    expect(referenceChain(t.plain, t.root)).toEqual([]);
    expect(isInsideReference(t.plain, t.root)).toBe(false);
    expect(outermostReference(t.plain, t.root)).toBeNull();
  });

  it('isInsideReference agrees with the chain, including on the reference itself', () => {
    const t = buildThreeDeep();
    expect(isInsideReference(t.leaf, t.root)).toBe(true);
    expect(isInsideReference(t.refA, t.root)).toBe(true);
    expect(isInsideReference(t.root, t.root)).toBe(false);
  });
});

describe('resolveReferenceSelection — decision 22', () => {
  it('a click three references deep selects the OUTERMOST reference', () => {
    const t = buildThreeDeep();
    const r = resolveReferenceSelection(t.leaf, 'viewport', 0, t.root);
    expect(r.node.name).toBe('refA');
    expect(r.resolved).toBe(true);
    expect(r.drillLevel).toBe(0);
  });

  it('one level in selects the next reference inward', () => {
    const t = buildThreeDeep();
    expect(resolveReferenceSelection(t.leaf, 'viewport', 1, t.root).node.name).toBe('refB');
    expect(resolveReferenceSelection(t.leaf, 'viewport', 2, t.root).node.name).toBe('refC');
  });

  it('past the last reference the hit itself is selected', () => {
    const t = buildThreeDeep();
    const r = resolveReferenceSelection(t.leaf, 'viewport', 3, t.root);
    expect(r.node).toBe(t.leaf);
    expect(r.resolved).toBe(false);
  });

  it('clamps a drill level beyond the chain instead of returning nothing', () => {
    const t = buildThreeDeep();
    const r = resolveReferenceSelection(t.leaf, 'viewport', 99, t.root);
    expect(r.node).toBe(t.leaf);
    expect(r.drillLevel).toBe(3);
  });

  it('source "tree" does NOT resolve — the tree shows the real structure', () => {
    const t = buildThreeDeep();
    const r = resolveReferenceSelection(t.leaf, 'tree', 0, t.root);
    expect(r.node).toBe(t.leaf);
    expect(r.resolved).toBe(false);
    // ...and it stays unresolved at any drill level, because the drill is a
    // viewport gesture and the tree has no use for it.
    expect(resolveReferenceSelection(t.leaf, 'tree', 2, t.root).node).toBe(t.leaf);
  });

  it('source "api" resolves like the viewport', () => {
    const t = buildThreeDeep();
    expect(resolveReferenceSelection(t.leaf, 'api', 0, t.root).node.name).toBe('refA');
  });

  it('leaves a hit outside any reference exactly where it is', () => {
    const t = buildThreeDeep();
    const r = resolveReferenceSelection(t.plain, 'viewport', 0, t.root);
    expect(r.node).toBe(t.plain);
    expect(r.resolved).toBe(false);
  });
});

describe('RvReferenceDrill — click / double-click / Escape', () => {
  it('click selects the outermost, double-click goes in, Escape comes back out', () => {
    const t = buildThreeDeep();
    const drill = new RvReferenceDrill();

    expect(drill.select(t.leaf, 'viewport', t.root).node.name).toBe('refA');
    expect(drill.drillIn(t.leaf, t.root).node.name).toBe('refB');
    expect(drill.drillIn(t.leaf, t.root).node.name).toBe('refC');
    expect(drill.drillOut(t.leaf, t.root).node.name).toBe('refB');
    expect(drill.drillOut(t.leaf, t.root).node.name).toBe('refA');
  });

  it('Escape at the outermost stays there — it never selects past the reference', () => {
    const t = buildThreeDeep();
    const drill = new RvReferenceDrill();
    drill.select(t.leaf, 'viewport', t.root);
    drill.drillOut(t.leaf, t.root);
    expect(drill.drillOut(t.leaf, t.root).node.name).toBe('refA');
    expect(drill.drillLevel).toBe(0);
  });

  it('drilling past the innermost reference reaches the hit and stops there', () => {
    const t = buildThreeDeep();
    const drill = new RvReferenceDrill();
    drill.select(t.leaf, 'viewport', t.root);
    drill.drillIn(t.leaf, t.root);
    drill.drillIn(t.leaf, t.root);
    expect(drill.drillIn(t.leaf, t.root).node).toBe(t.leaf);
    expect(drill.drillIn(t.leaf, t.root).node).toBe(t.leaf);
    expect(drill.drillLevel).toBe(3);
  });

  it('a click on a DIFFERENT object starts at the outermost again', () => {
    const t = buildThreeDeep();
    const drill = new RvReferenceDrill();
    drill.select(t.leaf, 'viewport', t.root);
    drill.drillIn(t.leaf, t.root);
    expect(drill.drillLevel).toBe(1);

    const other = new Object3D(); other.name = 'other'; t.midB.add(other);
    expect(drill.select(other, 'viewport', t.root).node.name).toBe('refA');
    expect(drill.drillLevel).toBe(0);
  });

  it('repeated clicks on the SAME object do not walk inwards by themselves', () => {
    const t = buildThreeDeep();
    const drill = new RvReferenceDrill();
    expect(drill.select(t.leaf, 'viewport', t.root).node.name).toBe('refA');
    expect(drill.select(t.leaf, 'viewport', t.root).node.name).toBe('refA');
    expect(drill.select(t.leaf, 'viewport', t.root).node.name).toBe('refA');
  });

  it('reset() forgets the level and the anchor', () => {
    const t = buildThreeDeep();
    const drill = new RvReferenceDrill();
    drill.select(t.leaf, 'viewport', t.root);
    drill.drillIn(t.leaf, t.root);
    drill.reset();
    expect(drill.drillLevel).toBe(0);
    expect(drill.anchor).toBeNull();
    expect(drill.select(t.leaf, 'viewport', t.root).node.name).toBe('refA');
  });
});
