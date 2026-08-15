// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-710 §9.3 — ONE op-draft writer.
 *
 * Before this phase an edit could land in either of two stores depending on
 * whether anyone had bound the document to a stack frame, a third writer baked
 * scene bytes, and a fourth (`RvDraftAutosave`) was finished code nobody
 * instantiated. What is pinned here is the state after the contract:
 *
 *  - one edit ⇒ exactly ONE record, in `frames`, and nothing in the retired slot;
 *  - the debounce is unchanged (2000 ms, restarted per edit);
 *  - the SCENE keeps its own baked-bytes autosave, hung on the same `onChanged`
 *    seam — a second FORM of persistence, deliberately, not a second op writer;
 *  - a record left in the retired slot is not offered back and does not crash;
 *  - a shelf entry written BEFORE the merge still unshelves and replays.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Scene, Group, Object3D } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { AssetDocument } from '../src/core/editor/rv-asset-document';
import type { AssetDraft } from '../src/core/editor/rv-asset-draft-storage';
import {
  __clearDraftStoresForTests,
  DRAFT_STORE_LEGACY,
  DRAFT_STORE_SHELF,
  LEGACY_DRAFT_KEY,
  listAllDocumentDrafts,
  listShelvedDocumentDrafts,
  loadDocumentDraft,
  openDraftDb,
  unshelveDocumentDraft,
} from '../src/core/ops/rv-document-drafts';
import {
  assetDraftOfFrame,
  chooseEditorDraft,
  chooseRecoveryRoot,
} from '../src/core/editor/rv-editor-draft-recovery';
import { SceneStore } from '../src/core/hmi/scene/scene-store';
import {
  libraryDocumentBase,
} from '../src/core/editor/active-asset-store';

// ─── Fixture ────────────────────────────────────────────────────────────

function makeViewer() {
  const scene = new Scene();
  const model = new Group();
  model.name = 'Asset';
  scene.add(model);

  const box = new Object3D();
  box.name = 'Box';
  box.userData.realvirtual = { Drive: { TargetSpeed: 50 } };
  model.add(box);

  const registry = new NodeRegistry();
  model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));

  const viewer = {
    scene,
    registry,
    signalStore: null,
    transportManager: null,
    get currentModelRoot() { return model; },
    markRenderDirty() {},
    markShadowsDirty() {},
    emit() {},
    on() { return () => {}; },
    rebuildGroupedBvh() {},
    refitRaycastSubtrees() {},
  } as unknown as RVViewer;

  return { viewer, box, boxPath: NodeRegistry.computeNodePath(box) };
}

/** Read the retired slot directly — production code no longer names this key. */
async function readLegacySlot(): Promise<AssetDraft | null> {
  const db = await openDraftDb();
  try {
    return await new Promise<AssetDraft | null>((resolve, reject) => {
      const tx = db.transaction(DRAFT_STORE_LEGACY, 'readonly');
      const req = tx.objectStore(DRAFT_STORE_LEGACY).get(LEGACY_DRAFT_KEY);
      req.onsuccess = () => resolve((req.result as AssetDraft | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

async function writeRaw(store: string, key: IDBValidKey, value: unknown): Promise<void> {
  const db = await openDraftDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

// ─── One writer ─────────────────────────────────────────────────────────

describe('one op-draft writer', () => {
  beforeEach(async () => {
    await __clearDraftStoresForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('one edit ⇒ exactly ONE frame record, and nothing in the retired slot', async () => {
    const { viewer, boxPath } = makeViewer();
    const doc = AssetDocument.newUntitled(viewer);

    doc.setField(boxPath, 'Drive', 'TargetSpeed', 200, 50);
    await vi.advanceTimersByTimeAsync(0);
    await doc.whenIdle();
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(0);

    const all = await listAllDocumentDrafts();
    expect(all).toHaveLength(1);
    expect(all[0].ops).toHaveLength(1);
    expect(await readLegacySlot()).toBeNull();
    doc.dispose();
  });

  it('nothing reaches storage before the 2000 ms debounce elapses', async () => {
    const { viewer, boxPath } = makeViewer();
    const doc = AssetDocument.newUntitled(viewer);

    doc.setField(boxPath, 'Drive', 'TargetSpeed', 200, 50);
    await vi.advanceTimersByTimeAsync(0);
    await doc.whenIdle();

    await vi.advanceTimersByTimeAsync(1999);
    expect(await listAllDocumentDrafts()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(await listAllDocumentDrafts()).toHaveLength(1);
    doc.dispose();
  });

  it('a whole editing run still writes ONE record — the debounce restarts', async () => {
    const { viewer, boxPath } = makeViewer();
    const doc = AssetDocument.newUntitled(viewer);

    for (let i = 0; i < 5; i++) {
      doc.setField(boxPath, 'Drive', 'TargetSpeed', 100 + i, 50);
      await vi.advanceTimersByTimeAsync(1000);
    }
    await doc.whenIdle();
    expect(await listAllDocumentDrafts()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(0);
    expect(await listAllDocumentDrafts()).toHaveLength(1);
    doc.dispose();
  });

  it('a document undone back to its baseline CLEARS its slot instead of writing one', async () => {
    const { viewer, boxPath } = makeViewer();
    const doc = AssetDocument.newUntitled(viewer);

    doc.setField(boxPath, 'Drive', 'TargetSpeed', 200, 50);
    await vi.advanceTimersByTimeAsync(0);
    await doc.whenIdle();
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(0);
    expect(await loadDocumentDraft(doc.draftFrame)).not.toBeNull();

    await doc.undo();
    expect(doc.dirty).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(0);

    // A clean document that left a record behind is work recovery would offer
    // back that the user has already taken back themselves.
    expect(await loadDocumentDraft(doc.draftFrame)).toBeNull();
    doc.dispose();
  });

  it('a suspended document writes nothing — and flushDraft still can', async () => {
    const { viewer, boxPath } = makeViewer();
    const doc = AssetDocument.newUntitled(viewer);
    doc.suspendAutosave();

    doc.setField(boxPath, 'Drive', 'TargetSpeed', 200, 50);
    await vi.advanceTimersByTimeAsync(0);
    await doc.whenIdle();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await listAllDocumentDrafts()).toHaveLength(0);

    // The exit guard's path: no announced change is pending, and it must still
    // land — this is why the writer has an explicit `writeNow`.
    await doc.flushDraft();
    expect(await listAllDocumentDrafts()).toHaveLength(1);
    doc.dispose();
  });
});

// ─── The retired slot ───────────────────────────────────────────────────

describe('the retired legacy slot', () => {
  beforeEach(async () => {
    await __clearDraftStoresForTests();
  });

  it('is never written, however much the document is edited', async () => {
    const { viewer, boxPath } = makeViewer();
    const doc = AssetDocument.newUntitled(viewer);
    doc.setField(boxPath, 'Drive', 'TargetSpeed', 1, 50);
    await doc.whenIdle();
    await doc.flushDraft();
    await doc.markSaved(libraryDocumentBase('Custom/a.glb'));

    expect(await readLegacySlot()).toBeNull();
    doc.dispose();
  });

  it('a leftover record there is NOT offered back — recovery sees nothing', async () => {
    const leftover: AssetDraft = {
      shell: { id: 'old', name: 'Ancient', base: { kind: 'empty' }, createdAt: 1 },
      ops: [],
      savedAt: 9_999_999,
    };
    await writeRaw(DRAFT_STORE_LEGACY, LEGACY_DRAFT_KEY, leftover);

    // The whole reader chain, exactly as the editor runs it.
    const root = chooseRecoveryRoot(await listAllDocumentDrafts(), null);
    expect(root).toBeNull();
    expect(chooseEditorDraft(null)).toBeNull();
  });
});

// ─── Shelf compatibility (§2.3) ─────────────────────────────────────────

describe('shelf compatibility across the merge', () => {
  beforeEach(async () => {
    await __clearDraftStoresForTests();
  });

  it('a shelf entry written BEFORE the merge unshelves and replays', async () => {
    // The pre-merge record: `AssetDraft` shape (no key/frame/depth), keyed by
    // `shell.id`, ops in the then-current asset vocabulary. Every asset-lineage
    // kind is an identity cast across the merge — the single reshaped kind is
    // the SCENE transform, which cannot occur in an asset document. That is why
    // this is readable with no migration and no read-side branch.
    const preMerge: AssetDraft = {
      shell: { id: 'shelved-1', name: 'Pre-merge', base: { kind: 'empty' }, createdAt: 1000 },
      ops: [
        {
          id: 'op-1', ts: 1, schemaV: 1, kind: 'setField',
          nodePath: 'Asset/Box', componentType: 'Drive',
          fieldName: 'TargetSpeed', value: 777, prev: 50,
        },
        {
          id: 'op-2', ts: 2, schemaV: 1, kind: 'renameNode',
          nodePath: 'Asset/Box', name: 'Crate', prevName: 'Box',
        },
      ] as unknown as AssetDraft['ops'],
      savedAt: 4242,
    };
    await writeRaw(DRAFT_STORE_SHELF, preMerge.shell.id, preMerge);

    const listed = await listShelvedDocumentDrafts();
    expect(listed.map((d) => d.shell.id)).toEqual(['shelved-1']);

    const record = await unshelveDocumentDraft('shelved-1');
    expect(record).not.toBeNull();
    // The one narrowing on the way back: `assetDraftOfFrame` refuses a base the
    // editor cannot open. A pre-merge entry passes it untouched.
    const restored = assetDraftOfFrame(record!)!;
    expect(restored.ops).toHaveLength(2);

    // …and the ops still drive the executors. This is the part the identity
    // argument is actually about: read is cheap, REPLAY is the claim.
    const { viewer, box } = makeViewer();
    const doc = new AssetDocument(viewer, { ...restored.shell });
    await doc.replayOps(restored.ops);

    expect((box.userData.realvirtual as { Drive: { TargetSpeed: number } }).Drive.TargetSpeed)
      .toBe(777);
    expect(box.name).toBe('Crate');
    doc.dispose();
  });
});

// ─── The scene keeps its own FORM of persistence ────────────────────────

describe('the scene lineage is not a second op-draft writer', () => {
  beforeEach(async () => {
    await __clearDraftStoresForTests();
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('a scene edit arms the GLB body autosave and writes NO op-draft record', async () => {
    // §2.3, made observable: the scene keeps a second FORM of persistence
    // (baked bytes) hung on the same `onChanged` seam, and it is deliberately
    // not a second writer into the op keyspace — a scene has no occurrence
    // chain, so it has no key here at all. Inventing one would be a plan-711
    // stack decision taken early and badly.
    const store = new SceneStore(makeSceneStoreViewer());
    await store.newEmpty();

    await store.applyOp({
      id: 'op-scene-1', ts: 10_000, schemaV: 1, kind: 'setField',
      nodePath: 'Asset/Box', componentType: 'Drive', fieldName: 'TargetSpeed',
      value: 200, prev: 50,
    } as unknown as Parameters<SceneStore['applyOp']>[0]);

    expect(store.hasUnpersistedWork()).toBe(true);   // the bake timer is armed
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.hasUnpersistedWork()).toBe(false);  // …and it fired

    expect(await listAllDocumentDrafts()).toHaveLength(0);
    store.dispose();
  });
});

function makeSceneStoreViewer(): RVViewer {
  const v = {
    availableModels: [] as { url: string; label: string }[],
    currentScene: null as unknown,
    currentModelUrl: null as string | null,
    registry: null,
    loadScene: async () => { v.currentModelUrl = 'empty:'; },
    loadEmptyScene: async () => { v.currentModelUrl = null; },
    getPlugin: () => undefined,
    markRenderDirty() {},
    emit() {},
  };
  return v as unknown as RVViewer;
}
