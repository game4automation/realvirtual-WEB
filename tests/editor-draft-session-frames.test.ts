// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-616 Teil 2 — the editor's crash recovery leaves out the drafts a BOUND
 * editor wrote in this page session (LOP #196).
 *
 * The defect, measured on the demo scene: the scene's identity is
 * `builtinModel`, which has no shared draft frame, so a bound editor writes its
 * draft under an instance-keyed frame (`asset_<id>`). `_loadRecoverableDraft`
 * only left out the SHARED frame (`live`, null here), offered the record back,
 * and the bind branch (`!draft`) was skipped: the second editor entry built a
 * second document out of the first entry's draft.
 *
 * Every case drives the REAL `AssetEditorPlugin._resolveOpenPlan` (template:
 * `editor-draft-conflict.test.ts`) against a fake scene store, and the session
 * claims are made through the REAL writer (`RvDraftAutosave` with and without
 * `boundDoc`), so the seam under test is the one production uses.
 *
 * - 9.2  claimed record of the living document → bind, no draft, record kept
 *        (`it.each` over `builtinModel` and `document`; red before plan-616)
 * - 9.2  descend stack (root + child) → both left out
 * - 9.4  (i) unclaimed crash draft, (ii) other projectId, (iii) unbound fork
 *        writer, (iv) another living document → all offered
 * - 9.8  scene rebuilt in the same page (same `SceneStore`, same RvDocument
 *        object, history replaced by the open) → offered again
 *
 * 9.6 (F6, cleanup in `_dropSharedDraftIfClean`) is NOT here: F6 was not
 * implemented (optional per plan; the claim registry cannot see the in-flight
 * write of an already disposed facade, so "delete after `_inFlight`" could not
 * be proven).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** The scene store as the open chain sees it — EMPTY unless a case fills it. */
const sceneStoreHolder = vi.hoisted(() => ({ store: null as unknown }));
vi.mock('../src/core/hmi/scene/scene-store-singleton', () => ({
  getSceneStore: () => sceneStoreHolder.store,
}));

import type { AssetDraft } from '../src/core/editor/rv-asset-draft-storage';
import type { AssetBase } from '../src/core/editor/rv-asset-document';
import type { RvDocument } from '../src/core/ops/rv-document';
import type { RVViewer } from '../src/core/rv-viewer';
import {
  __clearDraftStoresForTests,
  RvDraftAutosave,
  isLiveSessionDraft,
  listAllDocumentDrafts,
  loadDocumentDraft,
  noteSessionDraftWrite,
  sharedDocumentFrame,
  type RvDraftFrameKey,
} from '../src/core/ops/rv-document-drafts';
import { chooseRecoveryRoot } from '../src/core/editor/rv-editor-draft-recovery';
import { sceneDocumentBase, setOpenDocumentBase } from '../src/core/editor/active-asset-store';
import { SceneStore } from '../src/core/hmi/scene/scene-store';
import { AssetEditorPlugin } from '@rv-private/plugins/asset-editor/index';
import { takePendingAssetOpen } from '@rv-private/plugins/asset-editor/shared/pending-open-store';
import { clearLastEditedAsset } from '@rv-private/plugins/asset-editor/last-edited-asset-store';

// ─── Fixtures ───────────────────────────────────────────────────────────

const DEMO_URL = '/demo-realvirtual/DemoRealvirtualWeb.glb';
/** The identity the demo scene answers with — the case that forked. */
const BUILTIN_SCENE: AssetBase = { kind: 'builtinModel', url: DEMO_URL, name: 'DemoRealvirtualWeb' };
/** A saved scene — the shared-frame case that already worked (must not change). */
const DOCUMENT_SCENE: AssetBase = sceneDocumentBase('scene_7', 'Line 7');

/**
 * `projectId: null` on BOTH sides: no project is open in this file, and
 * `chooseRecoveryRoot` scopes by it — a record under any other id would be
 * ignored and every case would silently assert "nothing to recover".
 */
const instanceFrame = (rootDocumentId: string, occurrence = '', projectId: string | null = null): RvDraftFrameKey => ({
  projectId, rootDocumentId, occurrence,
});

function fakeSceneStore(identity: AssetBase, living: object | null) {
  const store = {
    handover: { document: living, base: identity, name: 'Scene' } as unknown,
    handoverCalls: 0,
    living,
    documentIdentity: () => identity,
    livingDocument: () => store.living,
    beginProjectionHandover() {
      store.handoverCalls++;
      return store.handover;
    },
  };
  return store;
}

/**
 * A dirty document as the autosave sees it — the fields `flush` reads: `dirty`
 * and the draft recipe `draftOps` (plan-774 review fix E3: history + pending
 * replay tail; `ops` kept for readers of the history).
 */
function dirtyDoc(tag: string): RvDocument {
  const ops = [{
    id: `${tag}-op`, ts: 1, schemaV: 1, kind: 'setField',
    nodePath: 'Box', componentType: 'Drive', fieldName: 'TargetSpeed', value: 1, prev: 0,
  }];
  return {
    dirty: true,
    ops,
    get draftOps() { return [...ops]; },
  } as unknown as RvDocument;
}

/**
 * Write a draft through the PRODUCTION writer. `boundTo` is what a bound
 * `AssetDocument` passes as `boundDoc`; null is an unbound (fork) facade.
 */
async function writeThroughAutosave(
  frame: RvDraftFrameKey,
  base: AssetBase,
  boundTo: object | null,
): Promise<void> {
  const autosave = new RvDraftAutosave({
    frame,
    shell: () => ({ id: frame.rootDocumentId, name: 'Edited', base, createdAt: 1000 }),
    ...(boundTo ? { boundDoc: () => boundTo } : {}),
  });
  await autosave.writeNow(dirtyDoc(frame.rootDocumentId));
  autosave.dispose();
}

/** `_resolveOpenPlan` is private by design; the test drives it deliberately. */
function resolveOpenPlan(plugin: AssetEditorPlugin) {
  return (plugin as unknown as {
    _resolveOpenPlan(): Promise<{ base: AssetBase | null; draft: AssetDraft | null; bind?: unknown }>;
  })._resolveOpenPlan();
}

beforeEach(async () => {
  takePendingAssetOpen();
  clearLastEditedAsset();
  setOpenDocumentBase(null);
  sceneStoreHolder.store = null;
  await __clearDraftStoresForTests();
});

afterEach(() => {
  sceneStoreHolder.store = null;
});

// ─── 9.2 — a bound writer's record of the living document is left out ────

describe('plan-616 9.2 — session drafts of the living document do not block the bind', () => {
  it.each([
    {
      kind: 'builtinModel',
      identity: BUILTIN_SCENE,
      // What a bound editor on the demo writes: an instance-keyed frame.
      frame: instanceFrame('asset_1700000000001'),
      // Without the session filter the editor WOULD offer this record — the
      // precondition that makes this case red on the pre-plan-616 code.
      offeredWhenUnclaimed: true,
    },
    {
      kind: 'document',
      identity: DOCUMENT_SCENE,
      // A shared identity writes the identity-keyed frame; left out by `live`
      // already. Pinned so plan-616 cannot change it.
      frame: sharedDocumentFrame(DOCUMENT_SCENE)!,
      offeredWhenUnclaimed: false,
    },
  ])('$kind: binds, offers no draft, keeps the record', async ({ identity, frame, offeredWhenUnclaimed }) => {
    const living = {};
    await writeThroughAutosave(frame, identity, living);

    // Non-vacuity: the record is really there, under the frame and project the
    // open chain scopes by, and for builtinModel the editor would pick it.
    const records = await listAllDocumentDrafts();
    expect(records).toHaveLength(1);
    expect(records[0].frame).toEqual(frame);
    expect(chooseRecoveryRoot(records, null) !== null).toBe(offeredWhenUnclaimed);
    expect(isLiveSessionDraft(records[0], living)).toBe(true);

    setOpenDocumentBase(identity);
    const store = fakeSceneStore(identity, living);
    sceneStoreHolder.store = store;

    const plan = await resolveOpenPlan(new AssetEditorPlugin());

    expect(plan.draft).toBeNull();
    expect(plan.bind).toBe(store.handover);
    expect(store.handoverCalls).toBe(1);
    // Left out, NOT deleted.
    expect(await loadDocumentDraft(frame)).not.toBeNull();
  });

  it('a descend stack (root + child) of the living document is left out as a whole', async () => {
    const living = {};
    const root = instanceFrame('asset_1700000000002');
    const child = instanceFrame('asset_1700000000002', 'Cell_1');
    // The bound root writer claims the stack; the child is written by its own
    // (unbound) facade, exactly as a descent produces it.
    await writeThroughAutosave(root, BUILTIN_SCENE, living);
    await writeThroughAutosave(child, BUILTIN_SCENE, null);
    expect(await listAllDocumentDrafts()).toHaveLength(2);

    setOpenDocumentBase(BUILTIN_SCENE);
    const store = fakeSceneStore(BUILTIN_SCENE, living);
    sceneStoreHolder.store = store;

    const plan = await resolveOpenPlan(new AssetEditorPlugin());

    expect(plan.draft).toBeNull();
    expect(plan.bind).toBe(store.handover);
    expect(await loadDocumentDraft(root)).not.toBeNull();
    expect(await loadDocumentDraft(child)).not.toBeNull();
  });
});

// ─── 9.4 — every other draft is still offered (F4) ───────────────────────

describe('plan-616 9.4 — drafts that are NOT this session\'s bound work are still offered', () => {
  async function expectOffered(store: ReturnType<typeof fakeSceneStore>, frame: RvDraftFrameKey) {
    setOpenDocumentBase(BUILTIN_SCENE);
    sceneStoreHolder.store = store;
    const plan = await resolveOpenPlan(new AssetEditorPlugin());
    expect(plan.draft).not.toBeNull();
    expect(plan.draft!.shell.id).toBe(frame.rootDocumentId);
    // …and it blocks the bind, exactly as before (known limit, plan §1).
    expect(plan.bind ?? null).toBeNull();
    expect(store.handoverCalls).toBe(0);
  }

  it('(i) an unclaimed record (crash draft from an earlier page) is offered', async () => {
    const living = {};
    const frame = instanceFrame('asset_1700000000010');
    // Written by a bound writer of ANOTHER page — nothing claims it here.
    await writeThroughAutosave(frame, BUILTIN_SCENE, null);
    expect(isLiveSessionDraft({ frame }, living)).toBe(false);

    await expectOffered(fakeSceneStore(BUILTIN_SCENE, living), frame);
  });

  it('(ii) same rootDocumentId under another projectId does not count', async () => {
    const living = {};
    const frame = instanceFrame('asset_1700000000011');
    await writeThroughAutosave(frame, BUILTIN_SCENE, null);
    // The claim names the same root id, but in another project.
    noteSessionDraftWrite(living, instanceFrame('asset_1700000000011', '', 'prj_other'));
    expect(isLiveSessionDraft({ frame }, living)).toBe(false);

    await expectOffered(fakeSceneStore(BUILTIN_SCENE, living), frame);
  });

  it('(iii) the draft of an UNBOUND fork editor is never hidden', async () => {
    const living = {};
    const frame = instanceFrame('asset_1700000000012');
    // An autosave without `boundDoc` — what a facade built from a draft has.
    await writeThroughAutosave(frame, BUILTIN_SCENE, null);
    expect(isLiveSessionDraft({ frame }, living)).toBe(false);

    await expectOffered(fakeSceneStore(BUILTIN_SCENE, living), frame);
  });

  it('(iv) a claim of ANOTHER living document does not hide the record', async () => {
    const before = {};
    const frame = instanceFrame('asset_1700000000013');
    await writeThroughAutosave(frame, BUILTIN_SCENE, before);
    expect(isLiveSessionDraft({ frame }, before)).toBe(true);

    // The scene now lends a different document object.
    await expectOffered(fakeSceneStore(BUILTIN_SCENE, {}), frame);
  });

  it('a store without `livingDocument` keeps the pre-plan-616 chain (defensive read)', async () => {
    const frame = instanceFrame('asset_1700000000014');
    await writeThroughAutosave(frame, BUILTIN_SCENE, {});
    const store = fakeSceneStore(BUILTIN_SCENE, null) as Partial<ReturnType<typeof fakeSceneStore>>;
    delete store.livingDocument;

    setOpenDocumentBase(BUILTIN_SCENE);
    sceneStoreHolder.store = store;
    const plan = await resolveOpenPlan(new AssetEditorPlugin());
    expect(plan.draft?.shell.id).toBe(frame.rootDocumentId);
  });
});

// ─── 9.8 — a scene rebuilt in the same page offers the draft again ───────

/** A viewer good enough for `SceneStore.openBuiltin` (no bake, no registry). */
function makeSceneViewer() {
  const v = {
    availableModels: [{ url: DEMO_URL, label: 'Demo' }],
    availablePublishedScenes: [],
    currentScene: null as unknown,
    currentModelUrl: null as string | null,
    currentModelRoot: null as unknown,
    registry: {
      getGltfNodeNames: () => [], getGltfNodeIndex: () => -1,
      getPathForNode: () => null, getNode: () => null,
    },
    lastLoadResult: null,
    modes: { has: () => true, setMode: () => {}, activeMode: 'hmi', subscribe: () => () => {} },
    getPlugin: () => undefined,
    loadScene: async (s: unknown) => { v.currentScene = s; },
    loadEmptyScene: async () => { v.currentScene = null; },
    markRenderDirty() {},
    emit() {},
  };
  return v as unknown as RVViewer;
}

describe('plan-616 9.8 — a scene rebuilt in the same page offers the bound draft again', () => {
  it('the same RvDocument object, a replaced history, and the draft is offered', async () => {
    const real = new SceneStore(makeSceneViewer());
    try {
      await real.openBuiltin(DEMO_URL, 'Demo', { updateUrl: false });
      const living = real.livingDocument();
      expect(living).not.toBeNull();

      // A bound editor visit with an edit leaves its draft behind.
      const frame = instanceFrame('asset_1700000000020');
      await writeThroughAutosave(frame, BUILTIN_SCENE, living);
      expect(isLiveSessionDraft({ frame }, living)).toBe(true);

      // The same URL is opened again: the store keeps its ONE document object
      // (the plan assumed a new one — the code refutes it) but installs a new
      // history, which is what has to release the claim.
      await real.openBuiltin(DEMO_URL, 'Demo', { updateUrl: false });
      expect(real.livingDocument()).toBe(living);
      expect(isLiveSessionDraft({ frame }, real.livingDocument())).toBe(false);

      const store = fakeSceneStore(BUILTIN_SCENE, real.livingDocument());
      setOpenDocumentBase(BUILTIN_SCENE);
      sceneStoreHolder.store = store;
      const plan = await resolveOpenPlan(new AssetEditorPlugin());

      expect(plan.draft?.shell.id).toBe(frame.rootDocumentId);
      expect(store.handoverCalls).toBe(0);
    } finally {
      (real as unknown as { dispose?: () => void }).dispose?.();
    }
  });
});
