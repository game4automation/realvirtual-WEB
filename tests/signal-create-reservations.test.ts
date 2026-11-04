// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Pending signal-name reservations of the asset editor's signal creation.
 *
 * `createSignalNode` used to remember every name it ever handed out in a
 * module-level set that was never cleared — a name freed by a rename, a delete
 * or by closing and reopening the editor still cost a `_1` suffix for the rest
 * of the page's life. Reservations are now per document and live only while the
 * creating ops are pending.
 */

import { describe, it, expect } from 'vitest';
import type { RVViewer } from '../src/core/rv-viewer';
import type { AssetDocument } from '../src/core/editor/rv-asset-document';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import {
  createSignalNode, createVerbatimSignalNodes, pendingSignalNamesForTest,
} from '@rv-private/plugins/asset-editor/kinematics/create-actions';

/**
 * Fake AssetDocument whose `addComponent` reaches the store only on the op
 * queue (a later microtask), like the real fire-and-forget op. `failNext`
 * makes the next transaction throw after its body ran (rollback path).
 */
function makeDoc(store: SignalStore) {
  let queue: Promise<void> = Promise.resolve();
  let counter = 0;
  const names: string[] = [];
  const state = { failNext: false };
  const doc = {
    async withTransaction(_label: string, fn: () => Promise<void>) {
      await fn();
      if (state.failNext) {
        state.failNext = false;
        await queue;
        throw new Error('rolled back');
      }
    },
    async createEmptyNode(parentPath: string | null, baseName: string) {
      counter++;
      return `${parentPath ?? ''}/${baseName}#${counter}`;
    },
    addComponent(nodePath: string, baseType: string, fields: Record<string, unknown>) {
      queue = queue.then(() => {
        const name = fields['Name'] as string;
        names.push(name);
        store.register(name, nodePath, false, baseType);
      });
      return baseType;
    },
    whenIdle() { return queue; },
  };
  return { doc: doc as unknown as AssetDocument, names, state };
}

function makeViewer(store: SignalStore): RVViewer {
  return {
    signalStore: store,
    selectionManager: { select: () => undefined },
  } as unknown as RVViewer;
}

describe('signal creation reservations (document-scoped, pending only)', () => {
  it('reuses a name freed by a rename/delete in the same page', async () => {
    const store = new SignalStore();
    const viewer = makeViewer(store);
    const { doc, names } = makeDoc(store);

    await createSignalNode(viewer, doc, 'Cell', 'PLCInputBool', 'X');
    expect(names).toEqual(['X']);
    expect(pendingSignalNamesForTest(doc)).toEqual([]);

    // Rename / delete releases X in the store.
    store.unregisterPath(store.registeredPaths('X')[0], 'X');
    expect(store.registeredPaths('X')).toEqual([]);

    await createSignalNode(viewer, doc, 'Cell', 'PLCInputBool', 'X');
    expect(names).toEqual(['X', 'X']);
  });

  it('a fresh document (editor reopen) starts without reservations', async () => {
    const store = new SignalStore();
    const viewer = makeViewer(store);
    const first = makeDoc(store);
    await createSignalNode(viewer, first.doc, 'Cell', 'PLCOutputFloat', 'Y');
    store.unregisterPath(store.registeredPaths('Y')[0], 'Y');

    const second = makeDoc(store);
    await createSignalNode(viewer, second.doc, 'Cell', 'PLCOutputFloat', 'Y');
    expect(second.names).toEqual(['Y']);
  });

  it('two pending creations in one document stay distinct', async () => {
    const store = new SignalStore();
    const viewer = makeViewer(store);
    const { doc, names } = makeDoc(store);
    await Promise.all([
      createSignalNode(viewer, doc, 'Cell', 'PLCInputBool', 'Z'),
      createSignalNode(viewer, doc, 'Cell', 'PLCInputBool', 'Z'),
    ]);
    expect([...names].sort()).toEqual(['Z', 'Z_1']);
    expect(pendingSignalNamesForTest(doc)).toEqual([]);
  });

  it('a pending verbatim name is skipped by a concurrent default creation', async () => {
    const store = new SignalStore();
    const viewer = makeViewer(store);
    const { doc, names } = makeDoc(store);
    await Promise.all([
      createVerbatimSignalNodes(viewer, doc, 'Cell', [{ name: 'V', sigType: 'PLCInputBool' }]),
      createSignalNode(viewer, doc, 'Cell', 'PLCInputBool', 'V'),
    ]);
    expect([...names].sort()).toEqual(['V', 'V_1']);
    expect(pendingSignalNamesForTest(doc)).toEqual([]);
  });

  it('releases the reservation when the transaction rolls back', async () => {
    const store = new SignalStore();
    const viewer = makeViewer(store);
    const { doc, state } = makeDoc(store);
    state.failNext = true;
    await expect(createSignalNode(viewer, doc, 'Cell', 'PLCInputBool', 'R')).rejects.toThrow('rolled back');
    expect(pendingSignalNamesForTest(doc)).toEqual([]);
  });
});
