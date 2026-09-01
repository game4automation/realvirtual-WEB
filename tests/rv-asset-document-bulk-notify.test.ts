// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Store notifications across a bulk edit (plan-359 §9.1).
 *
 * The gap this closes: nothing pinned the notification count. `_enqueue` notifies
 * twice per op (busy in, busy out), so a transaction moving 434 nodes fired 868
 * synchronous `useSyncExternalStore` snapshot changes and React aborted the apply
 * with "Maximum update depth exceeded" — mid-transaction, with no rollback in that
 * API, leaving the scene half-rebuilt. The suppression that fixed it shipped
 * without a test; this is that test.
 *
 * Asserted as an ORDERED, DISTINCT state sequence rather than an upper bound: a
 * bound like `<= 3` is also satisfied by ZERO notifications and by states arriving
 * out of order, neither of which is a working store (SOL-Runde 2, Finding 5).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
 import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { Scene, Group, Object3D } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { AssetDocument } from '../src/core/editor/rv-asset-document';
import {
  __clearDraftStoresForTests,
  loadDocumentDraft,
} from '../src/core/ops/rv-document-drafts';

// The autosave assertion needs a call counter, and an ESM namespace cannot be
// spied on in browser mode ("Module namespace is not configurable") — so the
// module is replaced outright, keeping the rest of its exports real.
// Observed through STORAGE rather than through a call counter: since plan-710
// Phase 2 the writer is `RvDraftAutosave`, which calls `saveDocumentDraft` as a
// module-local binding — a `vi.mock` of that export would never be consulted and
// the counter would silently read zero forever. The slot itself cannot lie.
const readDraft = async (doc: AssetDocument) =>
  loadDocumentDraft(doc.draftFrame);

interface StoreState { busy: boolean; dirty: boolean; canUndo: boolean }

function makeMockViewer() {
  const scene = new Scene();
  const model = new Group();
  model.name = 'Asset';
  scene.add(model);
  const registry = new NodeRegistry();
  const viewer = {
    scene,
    registry,
    signalStore: null,
    transportManager: null,
    get currentModelRoot() { return model; },
    markRenderDirty() {}, markShadowsDirty() {},
    emit() {}, on() { return () => {}; },
    rebuildGroupedBvh() {}, refitRaycastSubtrees() {},
    selectionManager: { select() {} },
  } as unknown as RVViewer;
  const register = () => {
    model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  };
  return { viewer, model, registry, register };
}

function addParts(parent: Object3D, count: number): Object3D[] {
  const out: Object3D[] = [];
  for (let i = 0; i < count; i++) {
    const n = new Group();
    n.name = `Part_${i}`;
    n.position.set(i, 0, 0);
    parent.add(n);
    out.push(n);
  }
  return out;
}

/** Collapse consecutive duplicates — the store may legitimately re-notify the
 *  same state, but the ORDER of distinct states is the contract. */
function distinct(seq: StoreState[]): StoreState[] {
  const out: StoreState[] = [];
  for (const s of seq) {
    const last = out[out.length - 1];
    if (!last || last.busy !== s.busy || last.dirty !== s.dirty || last.canUndo !== s.canUndo) {
      out.push(s);
    }
  }
  return out;
}

describe('bulk edit notifications', () => {
  beforeEach(async () => {
    await __clearDraftStoresForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits one coherent snapshot sequence, not one per op', async () => {
    const { viewer, model, register } = makeMockViewer();
    const parts = addParts(model, 100);
    const target = new Group(); target.name = 'Link'; model.add(target);
    register();
    model.updateMatrixWorld(true);
    const doc = scratchAssetDocument(viewer);

    const seq: StoreState[] = [];
    doc.subscribe(() => {
      const s = doc.getSnapshot();
      seq.push({ busy: s.busy, dirty: s.dirty, canUndo: s.canUndo });
    });

    await doc.withTransaction('bulk', async () => {
      await doc.reparentNodesBatch(
        parts.map((p) => NodeRegistry.computeNodePath(p)), 'Asset/Link',
      );
    });

    // Work announced (F6) → recorded and undoable → idle. Nothing in between:
    // the 100 moves themselves publish no intermediate state at all.
    expect(distinct(seq)).toEqual([
      { busy: true, dirty: false, canUndo: false },  // transaction opened
      { busy: true, dirty: true, canUndo: true },    // composite recorded
      { busy: false, dirty: true, canUndo: true },   // queue drained
    ]);

    // Draft autosave is debounced (2000 ms) — a bulk edit must reach storage
    // ONCE, at the end, and carry the ONE composite rather than 100 records.
    expect(await readDraft(doc)).toBeNull();
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(0);
    const written = await readDraft(doc);
    expect(written).not.toBeNull();
    expect(written!.ops).toHaveLength(1);
    doc.dispose();
  });

  it('never notifies more than a handful of times for 100 moves', async () => {
    const { viewer, model, register } = makeMockViewer();
    const parts = addParts(model, 100);
    const target = new Group(); target.name = 'Link'; model.add(target);
    register();
    model.updateMatrixWorld(true);
    const doc = scratchAssetDocument(viewer);

    let notifies = 0;
    doc.subscribe(() => { notifies++; });
    await doc.withTransaction('bulk', async () => {
      await doc.reparentNodesBatch(
        parts.map((p) => NodeRegistry.computeNodePath(p)), 'Asset/Link',
      );
    });

    // The pre-fix behaviour was 2 per op. This is the regression guard proper:
    // a count that scales with the move count fails here.
    expect(notifies).toBeGreaterThan(0);
    expect(notifies).toBeLessThanOrEqual(6);
    doc.dispose();
  });

  it('still notifies per op OUTSIDE a transaction (single edits stay live)', async () => {
    const { viewer, model, register } = makeMockViewer();
    addParts(model, 3);
    register();
    const doc = scratchAssetDocument(viewer);

    let notifies = 0;
    doc.subscribe(() => { notifies++; });
    doc.addComponent('Asset/Part_0', 'Sensor', { Length: 1 });
    await doc.whenIdle();
    expect(notifies).toBeGreaterThanOrEqual(2); // busy in, busy out
    doc.dispose();
  });
});
