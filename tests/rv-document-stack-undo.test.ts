// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-document-stack-undo.test.ts — plan-703 §9.5.
 *
 * Undo is PER FRAME (§2.7.3). An undo in the child can never reach into the
 * parent, an undo after Back touches only the parent, and a frame that is
 * popped with a transaction still open DISCARDS it rather than handing it
 * upwards. The precedent named in §8 is `IOleParentUndoUnit`; the failure it
 * prevents is a composite recorded against the wrong document's history.
 */

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import { RvDocumentStack, type RvStackFrame } from '../src/core/ops/rv-document-stack';
import {
  RvDescendController,
  type RvRecomposeHost,
} from '../src/core/ops/rv-document-recompose';
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
  controller: RvDescendController;
  parentDoc: TestStackDocument;
  childDoc: TestStackDocument;
  childRoot: Object3D;
  /** Frames whose reload the host was asked for. */
  reloaded: RvStackFrame[];
}

function harness(): Harness {
  const viewer = createStackTestViewer();
  const stack = new RvDocumentStack({ viewer, projectId: 'proj' });
  const parentRoot = nodeIn(viewer.scene, 'Plant');
  const childRoot = nodeIn(parentRoot, 'Station');
  const parentDoc = new TestStackDocument('doc-parent', 'Plant');
  const childDoc = new TestStackDocument('doc-child', 'Station');

  const reloaded: RvStackFrame[] = [];
  const host: RvRecomposeHost = {
    async openChild() {
      return { doc: childDoc, name: 'Station', isolatedRoots: [childRoot] };
    },
    async reloadFrame(frame) {
      reloaded.push(frame);
      return { isolatedRoots: frame.isolatedRoots };
    },
  };

  stack.pushRoot({ doc: parentDoc, assetId: 'plant', name: 'Plant' });
  stack.push({
    doc: childDoc, assetId: 'station', name: 'Station',
    referenceNodeId: 'ref-station', isolatedRoots: [childRoot], suppressedOverrides: 0,
  });

  return {
    viewer, stack, controller: new RvDescendController(stack, host),
    parentDoc, childDoc, childRoot, reloaded,
  };
}

describe('Undo ist pro Frame (§9.5)', () => {
  it('Undo im Kind laesst den Op-Log des Elternteils unberuehrt', async () => {
    const h = harness();
    await h.parentDoc.document.applyOp(makeOpFixture('renameNode'));
    await h.childDoc.document.applyOp(makeOpFixture('setField'));
    await h.childDoc.document.applyOp(makeOpFixture('transformNode'));

    await h.childDoc.document.undo();

    expect(h.childDoc.document.opCount).toBe(1);
    expect(h.childDoc.document.canRedo()).toBe(true);
    // The parent neither lost an op nor gained a redo entry.
    expect(h.parentDoc.document.opCount).toBe(1);
    expect(h.parentDoc.document.canRedo()).toBe(false);
    expect(h.parentDoc.document.dirty).toBe(true);
  });

  it('nach Back betrifft Undo nur noch den Elternteil', async () => {
    const h = harness();
    await h.parentDoc.document.applyOp(makeOpFixture('renameNode'));
    await h.childDoc.document.applyOp(makeOpFixture('setField'));

    // The child is dirty, so a plain Back is blocked — that IS the exit guard.
    expect((await h.controller.back()).status).toBe('blocked-dirty');
    const outcome = await h.controller.back({ force: true });
    expect(outcome.status).toBe('ok');

    // The child document is gone; the parent's history is intact and undoable.
    expect(h.childDoc.disposed).toBe(true);
    expect(h.parentDoc.document.canUndo()).toBe(true);
    await h.parentDoc.document.undo();
    expect(h.parentDoc.document.opCount).toBe(0);
    expect(h.parentDoc.document.dirty).toBe(false);
  });

  it('der Frame-Pop mit offener Transaktion verwirft sie, statt sie hochzureichen', async () => {
    const h = harness();
    const parentOpsBefore = h.parentDoc.document.opCount;

    // A structural batch the user never finished.
    h.childDoc.document.beginTransaction('Mehrere Knoten verschieben');
    h.childDoc.document.applyOpDetached(makeOpFixture('transformNode'));
    await h.childDoc.document.whenIdle();
    expect(h.childDoc.document.inTransaction).toBe(true);

    const popped = h.stack.pop()!;
    await popped.doc.document.whenIdle();

    // Rolled back inside the leaving document, and NOTHING crossed over.
    expect(popped.doc.document.inTransaction).toBe(false);
    expect(popped.doc.document.opCount).toBe(0);
    expect(h.childDoc.executor.inverse).toHaveLength(1);
    expect(h.parentDoc.document.opCount).toBe(parentOpsBefore);
    expect(h.parentDoc.document.inTransaction).toBe(false);
  });
});

describe('Back rekomponiert den Elternteil (§2.7.3)', () => {
  it('der Op-Log des Elternteils kommt byte-identisch zurueck — auch der Clean-Punkt', async () => {
    const h = harness();
    await h.parentDoc.document.applyOp(makeOpFixture('renameNode'));
    h.parentDoc.document.markSaved();
    await h.parentDoc.document.applyOp(makeOpFixture('setField'));

    const opsBefore = [...h.parentDoc.document.ops];
    const dirtyBefore = h.parentDoc.document.dirty;
    const forwardBefore = h.parentDoc.executor.forward.length;

    const outcome = await h.controller.back();
    expect(outcome.status).toBe('ok');

    // The host was asked to reload — the measured strategy (§2.7.3).
    expect(h.reloaded.map((f) => f.documentId)).toEqual(['doc-parent']);
    // Both unsaved AND saved ops were re-applied to the fresh tree: the file on
    // disk holds the SAVED bytes, so the log is the only place the rest lives.
    expect(h.parentDoc.executor.forward.length).toBe(forwardBefore + opsBefore.length);
    // The log itself did not grow, and the clean point survived.
    expect(h.parentDoc.document.ops.map((o) => o.id)).toEqual(opsBefore.map((o) => o.id));
    expect(h.parentDoc.document.dirty).toBe(dirtyBefore);
  });

  it('ein SAUBERER Elternteil kommt sauber zurueck', async () => {
    const h = harness();
    await h.parentDoc.document.applyOp(makeOpFixture('renameNode'));
    h.parentDoc.document.markSaved();
    expect(h.parentDoc.document.dirty).toBe(false);

    await h.controller.back();

    // The failure mode plan-410 R1-2 named: replaying a clean document's ops
    // through the LOG would make it dirty again.
    expect(h.parentDoc.document.dirty).toBe(false);
  });

  it('Back am Boden ist ein No-op', async () => {
    const h = harness();
    await h.controller.back();
    expect(h.stack.depth).toBe(1);
    expect((await h.controller.back()).status).toBe('at-root');
    expect(h.stack.depth).toBe(1);
  });
});
