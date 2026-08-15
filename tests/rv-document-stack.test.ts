// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-document-stack.test.ts — plan-703 §9.4.
 *
 * Push/pop, the parent's op log surviving a descend, the breadcrumb being
 * `occurrenceSegments` rather than a second addressing scheme — and, the point
 * of the file, the THREE-LEVEL case A→B→C, where popping C must put B's
 * isolation back.
 *
 * §9.4 is emphatic that "isolation restored" is not a claim about `.visible`:
 * `isolateNodes` drives the dimming (`groups.setExternalIsolated`) and the pick
 * gate (`RaycastManager.setIsolationGate`) as well, and the round-2 correction
 * to §2.7.2 exists precisely because an earlier draft restored only the
 * visibility list. All three are asserted here, against a real `GroupRegistry`
 * and the production gate predicate (see `helpers/stack-test-viewer.ts`).
 */

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import {
  RvDocumentStack,
  describeSuppressedOverrides,
} from '../src/core/ops/rv-document-stack';
import { occurrenceSegments } from '../src/core/engine/rv-node-id';
import { makeOpFixture } from './helpers/rv-op-fixtures';
import {
  createStackTestViewer,
  nodeIn,
  TestStackDocument,
  type StackTestViewer,
} from './helpers/stack-test-viewer';

interface Harness {
  viewer: StackTestViewer;
  stack: RvDocumentStack;
  /** Isolate roots, one per level. */
  roots: Record<'a' | 'b' | 'c', Object3D>;
  /** A node that is in NO isolate root — the gate's negative case. */
  outsider: Object3D;
}

function harness(projectId: string | null = 'proj'): Harness {
  const viewer = createStackTestViewer();
  const stack = new RvDocumentStack({ viewer, projectId });
  const a = nodeIn(viewer.scene, 'A-root');
  const b = nodeIn(a, 'B-subtree');
  const c = nodeIn(b, 'C-subtree');
  const outsider = nodeIn(viewer.scene, 'Elsewhere');
  return { viewer, stack, roots: { a, b, c }, outsider };
}

/** A→B→C, with the frames' documents named after their level. */
function threeLevels(h: Harness) {
  const docA = new TestStackDocument('doc-a', 'Plant');
  const docB = new TestStackDocument('doc-b', 'Station');
  const docC = new TestStackDocument('doc-c', 'Gripper');
  h.stack.pushRoot({ doc: docA, assetId: 'asset-a', name: 'Plant' });
  h.stack.push({
    doc: docB, assetId: 'asset-b', name: 'Station',
    referenceNodeId: 'ref-b', isolatedRoots: [h.roots.b], suppressedOverrides: 0,
  });
  h.stack.push({
    doc: docC, assetId: 'asset-c', name: 'Gripper',
    referenceNodeId: 'ref-c', isolatedRoots: [h.roots.c], suppressedOverrides: 0,
  });
  return { docA, docB, docC };
}

describe('Stack-Form (§2.7.1)', () => {
  it('pushRoot legt den Boden; ein zweiter Root wird verweigert', () => {
    const h = harness();
    const doc = new TestStackDocument('doc-a');
    h.stack.pushRoot({ doc, assetId: 'asset-a', name: 'Plant' });

    expect(h.stack.depth).toBe(1);
    expect(h.stack.root).toBe(h.stack.top);
    expect(h.stack.root!.occurrence).toBe('');
    expect(h.stack.root!.referenceNodeId).toBeNull();
    // The root owns the whole viewport — it isolates nothing.
    expect(h.viewer.isolateActive).toBe(false);

    expect(() => h.stack.pushRoot({ doc: new TestStackDocument('x'), assetId: 'y', name: 'z' }))
      .toThrow(/already has a root/);
  });

  it('die Occurrence-Kette waechst um genau die Referenzknoten-Id', () => {
    const h = harness();
    threeLevels(h);

    expect(h.stack.frames.map((f) => f.occurrence)).toEqual(['', 'ref-b', 'ref-b/ref-c']);
  });

  it('jeder Frame bekommt einen eigenen Draft-Slot, mit dem WURZEL-Dokument im Key', () => {
    const h = harness('proj');
    const { docA, docB, docC } = threeLevels(h);

    // Namespaced by project + the BOTTOM document, never by this frame's own id
    // — two copies of one project carry byte-identical occurrence chains.
    for (const doc of [docA, docB, docC]) {
      expect(doc.draftFrame?.projectId).toBe('proj');
      expect(doc.draftFrame?.rootDocumentId).toBe('doc-a');
    }
    expect(docA.draftFrame?.occurrence).toBe('');
    expect(docB.draftFrame?.occurrence).toBe('ref-b');
    expect(docC.draftFrame?.occurrence).toBe('ref-b/ref-c');
  });
});

describe('Breadcrumb (§2.7.1) — occurrenceSegments, nicht neu erfunden', () => {
  it('die Krumen entsprechen genau occurrenceSegments der Spitze', () => {
    const h = harness();
    threeLevels(h);

    const crumbs = h.stack.breadcrumb();
    expect(crumbs.map((c) => c.label)).toEqual(['Plant', 'Station', 'Gripper']);

    // The address is not re-derived by the breadcrumb: strip the root crumb and
    // what remains IS the segment list of the top frame's occurrence.
    const segments = occurrenceSegments(h.stack.top!.occurrence);
    expect(crumbs.slice(1).map((c) => c.referenceNodeId)).toEqual(segments);
    expect(crumbs[0].referenceNodeId).toBeNull();
    expect(crumbs.at(-1)!.current).toBe(true);
    expect(crumbs.filter((c) => c.current)).toHaveLength(1);
  });

  it('die Krume traegt den Dirty-Zustand ihres eigenen Frames', async () => {
    const h = harness();
    const { docB } = threeLevels(h);

    await docB.document.applyOp(makeOpFixture('renameNode'));
    const crumbs = h.stack.breadcrumb();
    expect(crumbs.map((c) => c.dirty)).toEqual([false, true, false]);
  });
});

describe('Descend isoliert (§2.7.2)', () => {
  it('der Push isoliert die Wurzeln des neuen Frames — Sichtbarkeit, Dimming, Pick-Gate', () => {
    const h = harness();
    threeLevels(h);

    // 1. visibility
    expect(h.roots.c.visible).toBe(true);
    // 2. dimming: the group registry's external-isolate channel is what the
    //    renderer's 3-pass isolate composition reads.
    expect(h.viewer.groups.isIsolateActive).toBe(true);
    expect(h.viewer.groups.isInIsolatedSubtree(h.roots.c)).toBe(true);
    // 3. pick gate: the production predicate, over the real registry.
    expect(h.viewer.pickGate(h.roots.c)).toBe(true);
    expect(h.viewer.pickGate(h.outsider)).toBe(false);
    // …and the camera followed.
    expect(h.viewer.lastFit).toEqual([h.roots.c]);
  });
});

describe('Pop stellt die Isolation des darunterliegenden Frames wieder her (§9.4)', () => {
  it('A→B→C: der Pop von C isoliert wieder auf Bs Wurzeln', () => {
    const h = harness();
    threeLevels(h);
    expect(h.viewer.groups.isInIsolatedSubtree(h.roots.c)).toBe(true);

    const popped = h.stack.pop()!;
    expect(popped.name).toBe('Gripper');
    expect(h.stack.depth).toBe(2);

    // B's isolate is BACK — and not by writing `.visible` back: all three
    // effects are re-established, because the frame re-CALLS isolateNodes.
    expect(h.viewer.isolateActive).toBe(true);
    expect(h.viewer.groups.isIsolateActive).toBe(true);
    expect(h.viewer.groups.isInIsolatedSubtree(h.roots.b)).toBe(true);
    expect(h.viewer.lastFit).toEqual([h.roots.b]);

    // C's subtree is INSIDE B's, so it stays pickable; the outsider does not.
    expect(h.viewer.pickGate(h.roots.c)).toBe(true);
    expect(h.viewer.pickGate(h.outsider)).toBe(false);
  });

  it('der Pop auf den Root-Frame verlaesst die Isolation ganz', () => {
    const h = harness();
    threeLevels(h);

    h.stack.pop();
    h.stack.pop();

    expect(h.stack.depth).toBe(1);
    expect(h.viewer.isolateActive).toBe(false);
    expect(h.viewer.groups.isIsolateActive).toBe(false);
    // Nothing is gated any more.
    expect(h.viewer.pickGate(h.outsider)).toBe(true);
  });

  it('leerer Stack ⇒ exitIsolate, und der Pop auf leer liefert null', () => {
    const h = harness();
    threeLevels(h);
    h.stack.pop(); h.stack.pop(); h.stack.pop();

    expect(h.stack.depth).toBe(0);
    expect(h.viewer.isolateActive).toBe(false);
    expect(h.stack.pop()).toBeNull();
  });

  it('reisolate() nimmt neue Wurzeln entgegen — der Reload hat den Baum ersetzt', () => {
    const h = harness();
    threeLevels(h);
    h.stack.pop();

    // After a full parent reload the recorded roots are detached objects.
    const rebuiltB = nodeIn(h.roots.a, 'B-subtree-reloaded');
    h.stack.reisolate([rebuiltB]);

    expect(h.viewer.groups.isInIsolatedSubtree(rebuiltB)).toBe(true);
    expect(h.viewer.groups.isInIsolatedSubtree(h.roots.b)).toBe(false);
    expect(h.stack.top!.isolatedRoots).toEqual([rebuiltB]);
  });
});

describe('Der Op-Log des Elternteils ueberlebt den Descend (§9.4)', () => {
  it('Ops im Kind erscheinen nicht im Elternteil', async () => {
    const h = harness();
    const { docA, docB } = threeLevels(h);

    await docA.document.applyOp(makeOpFixture('renameNode'));
    const parentOpsBefore = docA.document.opCount;

    await docB.document.applyOp(makeOpFixture('setField'));
    await docB.document.applyOp(makeOpFixture('transformNode'));

    expect(docA.document.opCount).toBe(parentOpsBefore);
    expect(docA.document.dirty).toBe(true);
    expect(docB.document.opCount).toBe(2);
  });
});

describe('Dirty-Matrix und Exit-Guard (§2.7.3)', () => {
  it('dirtyFrames listet alle dirty Frames, von unten nach oben', async () => {
    const h = harness();
    const { docA, docC } = threeLevels(h);
    await docA.document.applyOp(makeOpFixture('renameNode'));
    await docC.document.applyOp(makeOpFixture('setField'));

    expect(h.stack.anyDirty).toBe(true);
    expect(h.stack.dirtyFrames().map((f) => f.name)).toEqual(['Plant', 'Gripper']);
  });

  it('ein dirty Frame unter der Spitze macht anyDirty wahr — der Guard spannt den ganzen Stack', async () => {
    const h = harness();
    const { docA } = threeLevels(h);
    await docA.document.applyOp(makeOpFixture('renameNode'));

    // The TOP is clean, so a guard that only looked at it would let the project
    // close with the root document's work unsaved.
    expect(h.stack.top!.doc.document.dirty).toBe(false);
    expect(h.stack.anyDirty).toBe(true);
  });
});

describe('Veraltete Frames (§2.7.1)', () => {
  it('speichert ein Frame, gelten die anderen Frames desselben Assets als veraltet', () => {
    const h = harness();
    const docA = new TestStackDocument('doc-a1', 'Gripper');
    const docB = new TestStackDocument('doc-b', 'Station');
    const docA2 = new TestStackDocument('doc-a2', 'Gripper');
    h.stack.pushRoot({ doc: docA, assetId: 'gripper', name: 'Gripper' });
    h.stack.push({
      doc: docB, assetId: 'station', name: 'Station',
      referenceNodeId: 'ref-b', isolatedRoots: [h.roots.b], suppressedOverrides: 0,
    });
    h.stack.push({
      doc: docA2, assetId: 'gripper', name: 'Gripper',
      referenceNodeId: 'ref-c', isolatedRoots: [h.roots.c], suppressedOverrides: 0,
    });

    const affected = h.stack.markDocumentSaved('doc-a1');
    expect(affected.map((f) => f.documentId)).toEqual(['doc-a2']);
    expect(h.stack.frameAt(2)!.stale).toBe(true);
    expect(h.stack.frameAt(2)!.staleReason).toBe('saved-below');
    // The unrelated asset is untouched.
    expect(h.stack.frameAt(1)!.stale).toBe(false);
    // And the saver itself is not stale.
    expect(h.stack.frameAt(0)!.stale).toBe(false);
  });
});

describe('Hinweiszeile zu unterdrueckten Overrides (§2.7.2)', () => {
  it('Singular, Plural, und nichts bei null', () => {
    expect(describeSuppressedOverrides(0)).toBeNull();
    expect(describeSuppressedOverrides(1)).toBe('1 Override dieser Instanz ist ausgeblendet');
    expect(describeSuppressedOverrides(3)).toBe('3 Overrides dieser Instanz sind ausgeblendet');
  });

  it('die Spitze bestimmt die Zeile', () => {
    const h = harness();
    const docA = new TestStackDocument('doc-a');
    const docB = new TestStackDocument('doc-b');
    h.stack.pushRoot({ doc: docA, assetId: 'a', name: 'Plant' });
    expect(h.stack.suppressionNotice()).toBeNull();

    h.stack.push({
      doc: docB, assetId: 'b', name: 'Station',
      referenceNodeId: 'ref-b', isolatedRoots: [h.roots.b], suppressedOverrides: 2,
    });
    expect(h.stack.suppressionNotice()).toBe('2 Overrides dieser Instanz sind ausgeblendet');

    h.stack.pop();
    expect(h.stack.suppressionNotice()).toBeNull();
  });
});

describe('React-Store', () => {
  it('der Snapshot ist stabil und wird von jeder Aenderung invalidiert', async () => {
    const h = harness();
    const { docB } = threeLevels(h);

    const first = h.stack.getSnapshot();
    expect(h.stack.getSnapshot()).toBe(first);
    expect(first.depth).toBe(3);
    expect(first.anyDirty).toBe(false);

    let woken = 0;
    const unsub = h.stack.subscribe(() => { woken++; });
    await docB.document.applyOp(makeOpFixture('setField'));

    expect(woken).toBeGreaterThan(0);
    const second = h.stack.getSnapshot();
    expect(second).not.toBe(first);
    expect(second.anyDirty).toBe(true);
    unsub();
  });

  it('clear() raeumt jeden Frame ab und verlaesst die Isolation', () => {
    const h = harness();
    const { docA, docB, docC } = threeLevels(h);

    h.stack.clear();

    expect(h.stack.depth).toBe(0);
    expect([docA.disposed, docB.disposed, docC.disposed]).toEqual([true, true, true]);
    expect(h.viewer.isolateActive).toBe(false);
  });
});
