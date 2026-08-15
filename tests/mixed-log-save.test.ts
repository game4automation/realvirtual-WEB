// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-711 §9.4 — a MIXED log must not lose either half (F4).
 *
 * Two mechanisms, one promise. The spike showed that the scene's own writer
 * silently drops all eleven asset-lineage kinds (`materialise` →
 * `applyForwardPure`'s tolerance branch, MESSUNG b1), so with a shared document
 * every write from the scene side during an editor session would persist half a
 * document without a word. Phase 2+3 answers it twice over:
 *
 *  - **Autosave suspension (R2-Q1).** While the document is projected into the
 *    editor the scene's debounced body write does not run at all — it would bake
 *    against the wrong tree AND drop the editor's ops. The work is remembered
 *    (`hasUnpersistedWork` keeps telling the truth, so no new tab-close window
 *    opens) and flushed when the document comes back, with the authored bytes
 *    as the new bake source.
 *  - **Editor-save routing (R2-F-A).** The Save button, Ctrl+S and the MCP save
 *    tool all reach the write through `AssetDocument`. At a bound document that
 *    write has to be the SCENE writer — body slot plus catalogue row, addressed
 *    by `sceneId` — and never the `relPath` / `exportAssetGlb` path, which would
 *    drop an authored GLB into `models/` and leave the scene untouched.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { RVViewer } from '../src/core/rv-viewer';

// ─── The world outside (mocked, as in save-document-routing) ────────────

const h = vi.hoisted(() => ({
  /** What `getSceneStore()` answers — swapped per test. */
  sceneStore: null as unknown,
}));

vi.mock('../src/core/hmi/scene/scene-store-singleton', () => ({
  getSceneStore: () => h.sceneStore,
}));

const backend = {
  kind: 'browser' as const,
  id: 'backend-1',
  writable: true,
  isActive: true,
  writeBlob: vi.fn(async () => {}),
  async listDocuments() { return []; },
};

vi.mock('../src/core/project/project-store', () => ({
  getProjectStore: () => ({
    getBackend: () => backend,
    getProject: () => ({ id: 'prj_one', documents: [] }),
  }),
}));

const exportSpy = vi.fn();
vi.mock('../src/core/editor/rv-asset-glb-export', async (original) => {
  const actual = await original<typeof import('../src/core/editor/rv-asset-glb-export')>();
  return {
    ...actual,
    exportAssetGlb: async (root: unknown, name?: string) => {
      exportSpy(root, name);
      return new TextEncoder().encode(`GLB:${name}`).buffer;
    },
  };
});

import { saveDocument, decideSaveVerb } from '../src/core/editor/rv-save-document';
import { SceneStore } from '../src/core/hmi/scene/scene-store';
import { sceneDocumentBase } from '../src/core/editor/active-asset-store';
import { AssetDocument } from '../src/core/editor/rv-asset-document';
import { __clearDraftStoresForTests } from '../src/core/ops/rv-document-drafts';
import type { AssetBase } from '../src/core/editor/rv-asset-document';
import type { RvScenePrimitiveOp } from '../src/core/ops/rv-unified-ops';

// ─── Doubles ────────────────────────────────────────────────────────────

/** The scene store as `saveDocument` sees it, plus a log of what was called. */
function makeSceneFacade(sceneId: string, opts?: { dirty?: boolean }) {
  const calls: string[] = [];
  return {
    calls,
    lineage: 'scene' as const,
    getSnapshot: () => ({
      draft: { name: 'Line 1' },
      saved: { id: sceneId },
      isDraft: false,
      dirty: opts?.dirty ?? true,
      transient: false,
    }),
    async save() { calls.push('save'); return 'saved' as const; },
    async saveAs(name: string) { calls.push(`saveAs:${name}`); return sceneId; },
  };
}

/** The editor facade, reduced to what the save path reads. */
function makeBoundDoc(base: AssetBase) {
  return {
    name: 'Line 1',
    base,
    dirty: true,
    document: {
      opCount: 3,
      runExclusive<T>(work: () => Promise<T>): Promise<T> { return work(); },
      markSaved() {},
    },
    async markSaved() {},
  };
}

function makeViewer() {
  return {
    currentModelRoot: { name: 'Line 1' },
    renderer: {}, scene: {},
    emit: () => {},
    getPlugin: () => undefined,
  };
}

let opSeq = 0;
const sceneOp = (value: number): RvScenePrimitiveOp => ({
  id: `op_mix_${++opSeq}`, ts: 10_000, schemaV: 1,
  kind: 'setField',
  nodePath: 'Asset/Box', componentType: 'Drive', fieldName: `Field${value}`, value, prev: 0,
});

function makeSceneViewer(): RVViewer {
  const v = {
    availableModels: [] as { url: string; label: string }[],
    currentScene: null as unknown,
    currentModelUrl: null as string | null,
    registry: null,
    modes: { activeMode: 'planner', has: () => true, setMode: () => {}, subscribe: () => () => {} },
    loadScene: async () => {},
    loadEmptyScene: async () => {},
    getPlugin: () => undefined,
    markRenderDirty() {},
    emit() {},
  };
  return v as unknown as RVViewer;
}

beforeEach(async () => {
  await __clearDraftStoresForTests();
  localStorage.clear();
  h.sceneStore = null;
  backend.writeBlob.mockClear();
  exportSpy.mockClear();
});

// ─── Editor-save routing (R2-F-A) ───────────────────────────────────────

describe('Editor-Save am gebundenen Dokument routet auf SceneStore.save()', () => {
  it('reaches the SCENE writer and never the relPath/export path', async () => {
    const facade = makeSceneFacade('scene_1');
    h.sceneStore = facade;

    const doc = makeBoundDoc(sceneDocumentBase('scene_1', 'Line 1'));
    const result = await saveDocument(makeViewer() as never, doc as never, {});

    expect(result.kind).toBe('saved');
    expect(facade.calls).toEqual(['save']);
    // The two things a mis-route would show: an authored GLB export, and a
    // blob written to a project path. Neither may happen for a scene.
    expect(exportSpy).not.toHaveBeenCalled();
    expect(backend.writeBlob).not.toHaveBeenCalled();
    // No `relPath` is reported, because a scene has none — it is addressed by
    // catalogue id (`decideSaveVerb` states the same thing).
    if (result.kind === 'saved') expect(result.relPath).toBe('');
  });

  it('is BLOCKED when the store no longer holds that scene', async () => {
    h.sceneStore = makeSceneFacade('scene_OTHER');
    const doc = makeBoundDoc(sceneDocumentBase('scene_1', 'Line 1'));

    const result = await saveDocument(makeViewer() as never, doc as never, {});

    // Saving "the scene document" into whatever scene happens to be open is the
    // mis-binding the identity work exists to prevent.
    expect(result.kind).toBe('blocked');
    expect(backend.writeBlob).not.toHaveBeenCalled();
  });

  it('is BLOCKED when no scene store exists at all', async () => {
    h.sceneStore = null;
    const doc = makeBoundDoc(sceneDocumentBase('scene_1', 'Line 1'));
    const result = await saveDocument(makeViewer() as never, doc as never, {});
    expect(result.kind).toBe('blocked');
  });

  it('the verb says SAVE and carries no relPath, whichever lineage asks', () => {
    const decision = decideSaveVerb(
      { lineage: 'asset', base: sceneDocumentBase('scene_1', 'Line 1'), name: 'Line 1' },
      backend as never,
    );
    expect(decision.verb).toBe('save');
    expect(decision.relPath).toBeUndefined();
  });

  it('a clean scene is a no-op, not a write', async () => {
    const facade = makeSceneFacade('scene_1', { dirty: false });
    h.sceneStore = facade;
    const doc = makeBoundDoc(sceneDocumentBase('scene_1', 'Line 1'));
    const result = await saveDocument(makeViewer() as never, doc as never, {});
    expect(result.kind).toBe('no-op');
    expect(facade.calls).toEqual([]);
  });
});

// ─── Autosave suspension (R2-Q1) ────────────────────────────────────────

describe('Szenen-Autosave waehrend der Editor-Projektion', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  /**
   * A store with a bindable identity.
   *
   * `documentIdentity()` is spied rather than produced, because producing one
   * means a real save: a `scene-glb` base is minted by `_commitBody` from a
   * bake plus a body write. What this file is about is what happens AFTER the
   * handover, and the identity rule itself is pinned in
   * `same-document-base.test.ts` and `shared-instance-transition.test.ts`.
   */
  async function bindableStore() {
    const store = new SceneStore(makeSceneViewer());
    await store.newEmpty();
    vi.spyOn(store, 'documentIdentity')
      .mockReturnValue(sceneDocumentBase('scene_1', 'Line 1'));
    return store;
  }

  it('does not run while suspended, and hasUnpersistedWork keeps telling the truth', async () => {
    const store = await bindableStore();
    await store.applyOp(sceneOp(1));
    expect(store.hasUnpersistedWork()).toBe(true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(store.hasUnpersistedWork(), 'the ordinary debounce ran').toBe(false);

    const handover = store.beginProjectionHandover();
    expect(handover).not.toBeNull();
    expect(store.projectionSuspended).toBe(true);

    // An edit made through the OTHER projection reaches this document.
    await store.applyOp(sceneOp(2));
    await vi.advanceTimersByTimeAsync(3000);

    // Nothing was written — the bake would have read the editor's tree and
    // dropped the asset half — and the work is still owed, so the page guard
    // is not quietly disarmed for the whole editor session.
    expect(store.projectionSuspended).toBe(true);
    expect(store.hasUnpersistedWork()).toBe(true);

    store.dispose();
  });

  it('flushes on the way back', async () => {
    const store = await bindableStore();
    const handover = store.beginProjectionHandover()!;
    await store.applyOp(sceneOp(1));
    expect(store.hasUnpersistedWork()).toBe(true);

    handover.release();
    expect(store.projectionSuspended).toBe(false);
    // Re-armed, not written on the spot: the flush means "the change is
    // announced now" and goes through the one path that knows about transient
    // workspaces and the debounce.
    expect(store.hasUnpersistedWork()).toBe(true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(store.hasUnpersistedWork()).toBe(false);

    store.dispose();
  });

  it('carries a write that was already scheduled when the binding started', async () => {
    const store = await bindableStore();
    await store.applyOp(sceneOp(1));
    // The timer is armed and has NOT fired — exactly the debounce window.
    const handover = store.beginProjectionHandover()!;
    expect(store.hasUnpersistedWork(), 'the scheduled write was not dropped').toBe(true);

    await vi.advanceTimersByTimeAsync(3000);
    expect(store.hasUnpersistedWork()).toBe(true);

    handover.release();
    await vi.advanceTimersByTimeAsync(3000);
    expect(store.hasUnpersistedWork()).toBe(false);
    store.dispose();
  });

  it('refuses a second handover while one is open', async () => {
    const store = await bindableStore();
    expect(store.beginProjectionHandover()).not.toBeNull();
    expect(store.beginProjectionHandover()).toBeNull();
    store.dispose();
  });

  it('a bound editor op does not arm the scene writer either', async () => {
    const store = await bindableStore();
    const handover = store.beginProjectionHandover()!;

    // The editor authoring against the SHARED document — the exact path R2-Q1
    // is about, driven through the real facade rather than through `applyOp`.
    const editorViewer = {
      scene: {}, registry: null,
      signalStore: null, transportManager: null,
      currentModelRoot: null,
      markRenderDirty() {}, markShadowsDirty() {},
      emit() {}, on() { return () => {}; },
      rebuildGroupedBvh() {}, refitRaycastSubtrees() {},
    } as unknown as RVViewer;
    const bound = new AssetDocument(editorViewer, {
      id: 'asset_bound', name: 'Line 1',
      base: handover.base, adopt: handover.document,
    });
    bound.renameDocument('Line 1 renamed');
    await vi.advanceTimersByTimeAsync(3000);

    expect(store.projectionSuspended).toBe(true);
    expect(store.hasUnpersistedWork()).toBe(true);

    bound.dispose();
    handover.release();
    store.dispose();
  });
});
