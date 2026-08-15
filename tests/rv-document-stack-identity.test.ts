// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-document-stack-identity.test.ts — plan-703 §9.5b.
 *
 * The same asset, twice in one stack. That is legal: composition is a DAG, and
 * `A → B → A` is only a cycle when it is the SAME resolution path
 * (`rv-glb-compose.ts` scopes `visited` per path). What must never happen is
 * the two frames sharing anything — the house counter-example is
 * `scene-store-singleton.ts`, whose per-id instance cache is exactly the shape
 * that would let an edit down here rewrite the history up there.
 *
 * Two op logs, two dirty bits, two undo stacks; and once the lower one saves,
 * the upper one is reported as stale rather than quietly carried on.
 */

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import { RvDocumentStack } from '../src/core/ops/rv-document-stack';
import { RvDescendController, type RvRecomposeHost } from '../src/core/ops/rv-document-recompose';
import { makeOpFixture } from './helpers/rv-op-fixtures';
import {
  createStackTestViewer,
  nodeIn,
  TestStackDocument,
  type StackTestViewer,
} from './helpers/stack-test-viewer';

const GRIPPER = 'asset-gripper';

interface Harness {
  viewer: StackTestViewer;
  stack: RvDocumentStack;
  controller: RvDescendController;
  /** Bottom frame: the gripper, opened directly. */
  lower: TestStackDocument;
  /** Middle frame: a station that references the gripper again. */
  middle: TestStackDocument;
  /** Top frame: the SAME asset as `lower`, reached through a different path. */
  upper: TestStackDocument;
  roots: { middle: Object3D; upper: Object3D };
}

/** A → B → A, over two different resolution paths. */
function harness(): Harness {
  const viewer = createStackTestViewer();
  const stack = new RvDocumentStack({ viewer, projectId: 'proj' });
  const sceneRoot = nodeIn(viewer.scene, 'Gripper');
  const middleRoot = nodeIn(sceneRoot, 'Station');
  const upperRoot = nodeIn(middleRoot, 'Gripper-again');

  const lower = new TestStackDocument('doc-gripper-1', 'Gripper');
  const middle = new TestStackDocument('doc-station', 'Station');
  const upper = new TestStackDocument('doc-gripper-2', 'Gripper');

  stack.pushRoot({ doc: lower, assetId: GRIPPER, name: 'Gripper' });
  stack.push({
    doc: middle, assetId: 'asset-station', name: 'Station',
    referenceNodeId: 'ref-station', isolatedRoots: [middleRoot], suppressedOverrides: 0,
  });
  stack.push({
    doc: upper, assetId: GRIPPER, name: 'Gripper',
    referenceNodeId: 'ref-gripper', isolatedRoots: [upperRoot], suppressedOverrides: 0,
  });

  const host: RvRecomposeHost = {
    async openChild() { throw new Error('not used'); },
    async reloadFrame(frame) { return { isolatedRoots: frame.isolatedRoots }; },
  };

  return {
    viewer, stack, controller: new RvDescendController(stack, host),
    lower, middle, upper, roots: { middle: middleRoot, upper: upperRoot },
  };
}

describe('Dasselbe Asset zweimal im Stack (§9.5b)', () => {
  it('zwei Frames, zwei Dokument-Identitaeten, eine Asset-Identitaet', () => {
    const h = harness();

    const gripperFrames = h.stack.framesOfAsset(GRIPPER);
    expect(gripperFrames).toHaveLength(2);
    expect(gripperFrames.map((f) => f.documentId)).toEqual(['doc-gripper-1', 'doc-gripper-2']);
    // No instance cache: the two frames hold two different objects.
    expect(gripperFrames[0].doc).not.toBe(gripperFrames[1].doc);
    expect(gripperFrames[0].doc.document).not.toBe(gripperFrames[1].doc.document);
  });

  it('die beiden Frames bekommen getrennte Draft-Slots', () => {
    const h = harness();
    expect(h.lower.draftFrame?.occurrence).toBe('');
    expect(h.upper.draftFrame?.occurrence).toBe('ref-station/ref-gripper');
    // Same root namespace, different keys — an autosave in one cannot reach the
    // other, which is the whole reason the key is not the asset id.
    expect(h.lower.draftFrame?.rootDocumentId).toBe(h.upper.draftFrame?.rootDocumentId);
    expect(h.lower.draftFrame?.occurrence).not.toBe(h.upper.draftFrame?.occurrence);
  });

  it('ein Edit im unteren Frame veraendert den oberen nicht', async () => {
    const h = harness();

    await h.lower.document.applyOp(makeOpFixture('renameNode'));
    await h.lower.document.applyOp(makeOpFixture('setField'));

    expect(h.lower.document.opCount).toBe(2);
    expect(h.lower.document.dirty).toBe(true);
    expect(h.upper.document.opCount).toBe(0);
    expect(h.upper.document.dirty).toBe(false);
    expect(h.upper.document.canUndo()).toBe(false);
  });

  it('zwei Undo-Stacks: ein Undo oben laesst die Ops unten stehen', async () => {
    const h = harness();
    await h.lower.document.applyOp(makeOpFixture('renameNode'));
    await h.upper.document.applyOp(makeOpFixture('setField'));

    await h.upper.document.undo();

    expect(h.upper.document.opCount).toBe(0);
    expect(h.upper.document.canRedo()).toBe(true);
    expect(h.lower.document.opCount).toBe(1);
    expect(h.lower.document.canRedo()).toBe(false);
  });

  it('speichert der untere Frame, gilt der obere als veraltet', () => {
    const h = harness();

    h.stack.markDocumentSaved('doc-gripper-1');

    const upperFrame = h.stack.top!;
    expect(upperFrame.documentId).toBe('doc-gripper-2');
    expect(upperFrame.stale).toBe(true);
    expect(upperFrame.staleReason).toBe('saved-below');
    // The station in between holds a different asset and is unaffected.
    expect(h.stack.frameAt(1)!.stale).toBe(false);
  });

  it('der Pop meldet den veralteten Frame, statt still weiterzumachen', async () => {
    const h = harness();
    h.stack.markDocumentSaved('doc-gripper-1');
    // The upper frame is stale AND clean — nothing blocks the pop itself.
    const outcome = await h.controller.back();

    expect(outcome.status).toBe('ok');
    // …but the frame we landed on is reported, so the UI can offer "discard and
    // reopen" instead of letting the user edit a document that has moved on.
    // (Here the middle frame is the landing site and is NOT stale; the point of
    // the assertion is that the outcome carries the reason at all.)
    expect(outcome).toHaveProperty('staleReason');
  });

  it('landet der Pop AUF dem veralteten Frame, traegt das Ergebnis den Grund', async () => {
    const h = harness();
    // Mark the MIDDLE frame stale, then pop onto it.
    h.stack.markStale(h.stack.frameAt(1)!, 'source-gone');

    const outcome = await h.controller.back();
    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') {
      expect(outcome.frame.documentId).toBe('doc-station');
      expect(outcome.staleReason).toBe('source-gone');
    }
  });
});
