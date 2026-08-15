// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Draft conflict + draft shelf (plan-410 F3), on the ONE keyspace (plan-710 §2.3).
 *
 * Two things are under test, and the second is the one that matters:
 *  1. the SHELF as storage — atomic move, survives a reopen, untouched by the
 *     next document's autosave, removed only on an explicit discard;
 *  2. the editor's OPEN CHAIN (`_resolveOpenPlan`), which is the real decision
 *     logic: pending > draft > shelf offer > last-edited > empty, with the
 *     conflict dialog in between — including the case where shelving FAILS, in
 *     which case the requested asset must NOT be opened (review finding R2-6).
 *
 * ## What plan-710 Phase 2 changed here
 *
 * Every case used to seed its state through the legacy single slot
 * (`saveAssetDraft`), because that is what the reader looked at. There is one
 * writer and one keyspace now, so the whole seeding mechanism goes through the
 * per-frame store: {@link seedDraft} writes the record that
 * `chooseRecoveryRoot` → `planStackRecovery` will find. The DECISIONS asserted
 * below are unchanged — which is the point of rewriting the seeding rather than
 * the expectations.
 *
 * The chain is exercised on the real plugin object: `_resolveOpenPlan` touches
 * only stores and dialogs, never the viewer, so it needs no scene.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The scene store, as the open chain sees it (plan-711 §2.2).
 *
 * Mocked at module level and EMPTY by default, so every case written before the
 * bind existed resolves exactly as it did: `getSceneStore()` answered null in
 * this file already (no singleton is installed in a unit test), and the holder
 * reproduces that until a case fills it in.
 */
const sceneStoreHolder = vi.hoisted(() => ({ store: null as unknown }));
vi.mock('../src/core/hmi/scene/scene-store-singleton', () => ({
  getSceneStore: () => sceneStoreHolder.store,
}));

import type { AssetDraft } from '../src/core/editor/rv-asset-draft-storage';
import {
  __clearDraftStoresForTests,
  discardShelvedDocumentDraft,
  listShelvedDocumentDrafts,
  loadDocumentDraft,
  saveDocumentDraft,
  shelveDocumentDraft,
  unshelveDocumentDraft,
  type RvDraftFrameKey,
} from '../src/core/ops/rv-document-drafts';
import type { AssetBase } from '../src/core/editor/rv-asset-document';
import { AssetEditorPlugin } from '@rv-private/plugins/asset-editor/index';
import { setPendingAssetOpen, takePendingAssetOpen } from '@rv-private/plugins/asset-editor/pending-open-store';
import {
  getPendingDialog,
  subscribeEditorDialogs,
  type DraftConflictChoice,
  type ShelvedDraftChoice,
} from '@rv-private/plugins/asset-editor/editor-dialog-store';
import {
  saveLastEditedAsset,
  clearLastEditedAsset,
} from '@rv-private/plugins/asset-editor/last-edited-asset-store';
import {
  libraryDocumentBase,
  projectDocumentBase,
  sceneDocumentBase,
  setOpenDocumentBase,
} from '../src/core/editor/active-asset-store';

const REQUESTED: AssetBase = projectDocumentBase('library/Custom/Requested.glb', 'Requested');
/** What the planner has on screen when the user switches to the editor. */
const ON_SCREEN: AssetBase = projectDocumentBase('models/Conveyor.glb', 'Conveyor');
const LAST_EDITED: AssetBase = projectDocumentBase('library/Custom/Last.glb', 'Last');
/** A SAVED SCENE on screen — the one identity that can be BOUND (plan-711). */
const SCENE_ON_SCREEN: AssetBase = sceneDocumentBase('scene_7', 'Line 7');

/**
 * The two calls the bind branch makes on the store, and nothing else.
 *
 * Deliberately not a `SceneStore`: what this file tests is the ORDER of the
 * open chain, and building a real store would drag a viewer, a project backend
 * and a bake into a test about precedence. The handover's own contract lives in
 * `mixed-log-save.test.ts` and `shared-instance-transition.test.ts`.
 */
function fakeSceneStore(identity: AssetBase, opts: { refuse?: boolean } = {}) {
  const store = {
    handover: { document: {}, base: identity, name: 'Line 7' } as unknown,
    handoverCalls: 0,
    documentIdentity: () => identity,
    beginProjectionHandover() {
      store.handoverCalls++;
      return opts.refuse ? null : store.handover;
    },
  };
  return store;
}

function makeDraft(id: string, name: string, opCount = 2): AssetDraft {
  return {
    shell: { id, name, base: { kind: 'empty' }, createdAt: 1000 },
    ops: Array.from({ length: opCount }, (_, i) => ({
      id: `${id}-op${i}`, kind: 'setField', nodePath: 'Box', componentType: 'Drive',
      fieldName: 'TargetSpeed', value: i, prev: 0,
    })) as unknown as AssetDraft['ops'],
    savedAt: 2000,
  };
}

/**
 * The frame a seeded draft lives in.
 *
 * `projectId: null` because these tests run with no project open, and that is
 * its own namespace rather than a wildcard — `chooseRecoveryRoot` scopes by it,
 * so a seed under any other id would be correctly ignored and every case here
 * would silently assert "nothing to recover".
 */
const frameOf = (draft: AssetDraft, occurrence = ''): RvDraftFrameKey => ({
  projectId: null, rootDocumentId: draft.shell.id, occurrence,
});

/** Put a draft where the editor's crash recovery will find it. */
async function seedDraft(draft: AssetDraft, occurrence = ''): Promise<void> {
  await saveDocumentDraft({
    frame: frameOf(draft, occurrence),
    shell: draft.shell,
    ops: draft.ops,
    savedAt: draft.savedAt,
  });
}

/** Shelve a draft the way the open chain does — one transaction, both stores. */
async function shelve(draft: AssetDraft): Promise<void> {
  await shelveDocumentDraft({
    frame: frameOf(draft), shell: draft.shell, ops: draft.ops, savedAt: draft.savedAt,
  });
}

/** Answer the next dialog of `kind` automatically; returns an unsubscribe. */
function autoAnswer(kind: string, answer: unknown): () => void {
  const off = subscribeEditorDialogs(() => {
    const pending = getPendingDialog();
    if (pending?.kind === kind) {
      (pending as unknown as { resolve: (v: unknown) => void }).resolve(answer);
    }
  });
  return off;
}

let unsubDialog: (() => void) | null = null;

beforeEach(async () => {
  takePendingAssetOpen();
  clearLastEditedAsset();
  setOpenDocumentBase(null);
  // No scene store unless a case installs one — the pre-plan-711 world.
  sceneStoreHolder.store = null;
  await __clearDraftStoresForTests();
});

afterEach(() => {
  unsubDialog?.();
  unsubDialog = null;
});

// ─── The shelf as storage ─────────────────────────────────────────────────

describe('draft shelf storage', () => {
  it('shelving moves the draft: shelf holds it, the frame slot is empty', async () => {
    const draft = makeDraft('doc-1', 'Untitled-3');
    await seedDraft(draft);

    await shelve(draft);

    expect(await loadDocumentDraft(frameOf(draft))).toBeNull();
    const shelved = await listShelvedDocumentDrafts();
    expect(shelved).toHaveLength(1);
    expect(shelved[0].shell.id).toBe('doc-1');
    expect(shelved[0].ops).toHaveLength(2);
  });

  it('a failed shelving leaves the frame slot untouched (transaction abort)', async () => {
    const draft = makeDraft('doc-1', 'Untitled-3');
    await seedDraft(draft);

    // A function is not structured-cloneable — IndexedDB rejects the put, and
    // the surrounding transaction (put + delete) must take the delete with it.
    const poisoned = {
      ...draft,
      ops: [...draft.ops, { id: 'bad', kind: 'setField', notClonable: () => {} }],
    } as unknown as AssetDraft;

    await expect(shelve(poisoned)).rejects.toBeTruthy();

    // The draft is still exactly where it was — nothing was lost.
    const main = await loadDocumentDraft(frameOf(draft));
    expect(main?.shell.id).toBe('doc-1');
    expect(await listShelvedDocumentDrafts()).toHaveLength(0);
  });

  it("the next document's autosave cannot touch the shelf", async () => {
    const shelvedDraft = makeDraft('doc-1', 'Shelved');
    await seedDraft(shelvedDraft);
    await shelve(shelvedDraft);

    // The newly opened document autosaves into ITS OWN frame, repeatedly.
    const next = makeDraft('doc-2', 'New doc', 1);
    await seedDraft(next);
    await seedDraft(makeDraft('doc-2', 'New doc', 5));

    expect((await loadDocumentDraft(frameOf(next)))?.shell.id).toBe('doc-2');
    const shelved = await listShelvedDocumentDrafts();
    expect(shelved).toHaveLength(1);
    expect(shelved[0].shell.id).toBe('doc-1');
    expect(shelved[0].ops).toHaveLength(2);  // untouched
  });

  it('a shelved draft survives a fresh database connection (simulated restart)', async () => {
    await shelve(makeDraft('doc-1', 'Survivor'));

    // Every call here opens its own connection — this IS the reopen.
    const shelved = await listShelvedDocumentDrafts();
    expect(shelved[0].shell.name).toBe('Survivor');
  });

  it('unshelve returns the draft AND removes it from the shelf', async () => {
    await shelve(makeDraft('doc-1', 'A'));
    const restored = await unshelveDocumentDraft('doc-1');
    expect(restored?.shell.name).toBe('A');
    expect(await listShelvedDocumentDrafts()).toHaveLength(0);
  });

  it('unshelving an unknown id yields null and changes nothing', async () => {
    await shelve(makeDraft('doc-1', 'A'));
    expect(await unshelveDocumentDraft('nope')).toBeNull();
    expect(await listShelvedDocumentDrafts()).toHaveLength(1);
  });

  it('only an explicit discard deletes a shelved draft', async () => {
    await shelve(makeDraft('doc-1', 'A'));
    await shelve(makeDraft('doc-2', 'B'));
    await discardShelvedDocumentDraft('doc-1');
    const left = await listShelvedDocumentDrafts();
    expect(left.map((d) => d.shell.id)).toEqual(['doc-2']);
  });

  it('reads a PRE-MERGE shelf entry unchanged — the key and the shape both survived', async () => {
    // What an older build wrote: an `AssetDraft` (no key/frame/depth fields),
    // keyed by `shell.id`, with ops in the then-current asset vocabulary. Every
    // asset-lineage op kind is byte-identical across the merge, so this is
    // readable without a migration — the §2.3 argument, pinned.
    const legacyShaped = makeDraft('doc-old', 'Written before the merge');
    await seedRawShelfEntry(legacyShaped);

    const shelved = await listShelvedDocumentDrafts();
    expect(shelved.map((d) => d.shell.id)).toEqual(['doc-old']);
    const restored = await unshelveDocumentDraft('doc-old');
    expect(restored!.shell.name).toBe('Written before the merge');
    expect(restored!.ops).toHaveLength(2);
    expect(restored!.ops[0].kind).toBe('setField');
  });
});

/** Write a shelf record in the OLD (`AssetDraft`) shape, bypassing the writer. */
async function seedRawShelfEntry(draft: AssetDraft): Promise<void> {
  const { openDraftDb, DRAFT_STORE_SHELF } =
    await import('../src/core/ops/rv-document-drafts');
  const db = await openDraftDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DRAFT_STORE_SHELF, 'readwrite');
      tx.objectStore(DRAFT_STORE_SHELF).put(draft, draft.shell.id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

// ─── The open chain ───────────────────────────────────────────────────────

/** `_resolveOpenPlan` is private by design; the test drives it deliberately. */
function resolveOpenPlan(plugin: AssetEditorPlugin) {
  return (plugin as unknown as {
    _resolveOpenPlan(): Promise<{
      base: AssetBase | null;
      draft: AssetDraft | null;
      /** The scene's living document, when the chain decided to BIND (plan-711). */
      bind?: unknown;
    }>;
  })._resolveOpenPlan();
}

describe('editor open chain', () => {
  it('pending alone opens the request', async () => {
    setPendingAssetOpen(REQUESTED);
    const plan = await resolveOpenPlan(new AssetEditorPlugin());
    expect(plan.base).toEqual(REQUESTED);
    expect(plan.draft).toBeNull();
  });

  it('draft alone reopens the draft (crash recovery, unchanged)', async () => {
    await seedDraft(makeDraft('doc-1', 'Recovered'));
    const plan = await resolveOpenPlan(new AssetEditorPlugin());
    expect(plan.base).toBeNull();
    expect(plan.draft?.shell.name).toBe('Recovered');
  });

  it('pending + draft asks, and "continue draft" drops the request', async () => {
    const draft = makeDraft('doc-1', 'Untitled-3');
    await seedDraft(draft);
    setPendingAssetOpen(REQUESTED);
    unsubDialog = autoAnswer('draft-conflict', 'continue-draft' satisfies DraftConflictChoice);

    const plan = await resolveOpenPlan(new AssetEditorPlugin());

    expect(plan.draft?.shell.id).toBe('doc-1');
    expect(plan.base).toBeNull();
    // Nothing was shelved, nothing discarded.
    expect(await listShelvedDocumentDrafts()).toHaveLength(0);
    expect(await loadDocumentDraft(frameOf(draft))).not.toBeNull();
  });

  it('pending + draft, "discard draft" clears it and opens the request', async () => {
    const draft = makeDraft('doc-1', 'Untitled-3');
    await seedDraft(draft);
    setPendingAssetOpen(REQUESTED);
    unsubDialog = autoAnswer('draft-conflict', 'discard-draft' satisfies DraftConflictChoice);

    const plan = await resolveOpenPlan(new AssetEditorPlugin());

    expect(plan.base).toEqual(REQUESTED);
    expect(plan.draft).toBeNull();
    expect(await loadDocumentDraft(frameOf(draft))).toBeNull();
    expect(await listShelvedDocumentDrafts()).toHaveLength(0);
  });

  it('pending + draft, "open requested" shelves the draft first', async () => {
    const draft = makeDraft('doc-1', 'Untitled-3');
    await seedDraft(draft);
    setPendingAssetOpen(REQUESTED);
    unsubDialog = autoAnswer('draft-conflict', 'open-requested' satisfies DraftConflictChoice);

    const plan = await resolveOpenPlan(new AssetEditorPlugin());

    expect(plan.base).toEqual(REQUESTED);
    expect(await loadDocumentDraft(frameOf(draft))).toBeNull();
    const shelved = await listShelvedDocumentDrafts();
    expect(shelved.map((d) => d.shell.id)).toEqual(['doc-1']);
  });

  it('a failed shelving does NOT open the requested asset — the draft wins', async () => {
    const draft = makeDraft('doc-1', 'Untitled-3');
    await seedDraft(draft);

    // Make the shelf write fail, so the put+delete transaction aborts and the
    // draft stays in its frame. Opening the request anyway would let ITS
    // autosave overwrite that frame two seconds later (review finding R2-6).
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function patched(
      this: IDBObjectStore, value: unknown, key?: IDBValidKey,
    ) {
      if (this.name === 'shelf') throw new DOMException('poisoned', 'DataCloneError');
      return originalPut.call(this, value, key) as never;
    } as typeof IDBObjectStore.prototype.put;

    try {
      setPendingAssetOpen(REQUESTED);
      unsubDialog = autoAnswer('draft-conflict', 'open-requested' satisfies DraftConflictChoice);

      const plan = await resolveOpenPlan(new AssetEditorPlugin());

      expect(plan.base).toBeNull();
      expect(plan.draft).not.toBeNull();
    } finally {
      IDBObjectStore.prototype.put = originalPut;
    }
    expect(await listShelvedDocumentDrafts()).toHaveLength(0);
    expect(await loadDocumentDraft(frameOf(draft))).not.toBeNull();
  });

  it('without pending or draft the shelf is OFFERED, never auto-opened', async () => {
    await shelve(makeDraft('doc-9', 'Set aside'));
    saveLastEditedAsset(LAST_EDITED);
    let asked = false;
    unsubDialog = subscribeEditorDialogs(() => {
      const p = getPendingDialog();
      if (p?.kind === 'shelved-drafts') {
        asked = true;
        (p as unknown as { resolve: (v: ShelvedDraftChoice) => void }).resolve({ action: 'later' });
      }
    });

    const plan = await resolveOpenPlan(new AssetEditorPlugin());

    expect(asked).toBe(true);
    // "Later" leaves the shelf alone and falls through to last-edited.
    expect(plan.base).toEqual(LAST_EDITED);
    expect(await listShelvedDocumentDrafts()).toHaveLength(1);
  });

  it('restoring from the shelf opens that draft and empties the shelf entry', async () => {
    await shelve(makeDraft('doc-9', 'Set aside'));
    unsubDialog = subscribeEditorDialogs(() => {
      const p = getPendingDialog();
      if (p?.kind === 'shelved-drafts') {
        (p as unknown as { resolve: (v: ShelvedDraftChoice) => void })
          .resolve({ action: 'restore', id: 'doc-9' });
      }
    });

    const plan = await resolveOpenPlan(new AssetEditorPlugin());

    expect(plan.draft?.shell.name).toBe('Set aside');
    expect(await listShelvedDocumentDrafts()).toHaveLength(0);
  });

  it('discarding from the shelf falls through to last-edited', async () => {
    await shelve(makeDraft('doc-9', 'Set aside'));
    saveLastEditedAsset(LAST_EDITED);
    unsubDialog = subscribeEditorDialogs(() => {
      const p = getPendingDialog();
      if (p?.kind === 'shelved-drafts') {
        (p as unknown as { resolve: (v: ShelvedDraftChoice) => void })
          .resolve({ action: 'discard', id: 'doc-9' });
      }
    });

    const plan = await resolveOpenPlan(new AssetEditorPlugin());

    expect(plan.base).toEqual(LAST_EDITED);
    expect(await listShelvedDocumentDrafts()).toHaveLength(0);
  });

  it('nothing anywhere → last-edited', async () => {
    saveLastEditedAsset(LAST_EDITED);
    const plan = await resolveOpenPlan(new AssetEditorPlugin());
    expect(plan.base).toEqual(LAST_EDITED);
  });

  it('nothing at all → empty document (both null)', async () => {
    const plan = await resolveOpenPlan(new AssetEditorPlugin());
    expect(plan.base).toBeNull();
    expect(plan.draft).toBeNull();
  });

  it('a live frame draft outranks both the shelf and last-edited', async () => {
    await shelve(makeDraft('doc-9', 'Shelved'));
    await seedDraft(makeDraft('doc-1', 'Live draft'));
    saveLastEditedAsset(LAST_EDITED);

    const plan = await resolveOpenPlan(new AssetEditorPlugin());

    expect(plan.draft?.shell.name).toBe('Live draft');
    expect(plan.base).toBeNull();
    // The shelf was not even consulted.
    expect(await listShelvedDocumentDrafts()).toHaveLength(1);
  });

  it('a LEGACY record is not offered back — and does not crash the open', async () => {
    // The negative case of the user decision (§2.3): a draft left in the retired
    // `drafts/current` slot by an older build is discarded, not migrated. With
    // the frame keyspace empty the chain must fall through as if nothing were
    // there — no phantom card, no error.
    await seedLegacySlot(makeDraft('doc-legacy', 'Very old work'));
    saveLastEditedAsset(LAST_EDITED);

    const plan = await resolveOpenPlan(new AssetEditorPlugin());

    expect(plan.draft).toBeNull();
    expect(plan.base).toEqual(LAST_EDITED);
  });
});

/** Write into the retired single slot, which production code no longer names. */
async function seedLegacySlot(draft: AssetDraft): Promise<void> {
  const { openDraftDb, DRAFT_STORE_LEGACY, LEGACY_DRAFT_KEY } =
    await import('../src/core/ops/rv-document-drafts');
  const db = await openDraftDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DRAFT_STORE_LEGACY, 'readwrite');
      tx.objectStore(DRAFT_STORE_LEGACY).put(draft, LEGACY_DRAFT_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

// ─── The document already on screen (plan-703, Lauf 14) ───────────────────

/**
 * Switching modes must not change WHAT is open — the bug this covers was
 * opening a GLB in the planner, switching to the editor, and getting an empty
 * "Untitled" on top of it.
 */
describe('open chain: the document already on screen', () => {
  it('beats last-edited: the mode switch keeps the file in the viewport', async () => {
    saveLastEditedAsset(LAST_EDITED);
    setOpenDocumentBase(ON_SCREEN);

    const plan = await resolveOpenPlan(new AssetEditorPlugin());

    expect(plan.base).toEqual(ON_SCREEN);
    expect(plan.draft).toBeNull();
  });

  it('beats the shelf, which is not even offered', async () => {
    await shelve(makeDraft('doc-9', 'Shelved'));
    setOpenDocumentBase(ON_SCREEN);

    const plan = await resolveOpenPlan(new AssetEditorPlugin());

    expect(plan.base).toEqual(ON_SCREEN);
    expect(await listShelvedDocumentDrafts()).toHaveLength(1);
  });

  it('an explicit "Edit asset" click still outranks it', async () => {
    setOpenDocumentBase(ON_SCREEN);
    setPendingAssetOpen(REQUESTED);

    const plan = await resolveOpenPlan(new AssetEditorPlugin());

    expect(plan.base).toEqual(REQUESTED);
  });

  it('with nothing on screen the chain is unchanged: last-edited wins', async () => {
    saveLastEditedAsset(LAST_EDITED);
    setOpenDocumentBase(null);

    const plan = await resolveOpenPlan(new AssetEditorPlugin());

    expect(plan.base).toEqual(LAST_EDITED);
  });

  it('does NOT silently discard a crash draft — it raises the same question', async () => {
    await seedDraft(makeDraft('doc-1', 'Unsaved work'));
    setOpenDocumentBase(ON_SCREEN);

    const plugin = new AssetEditorPlugin();
    unsubDialog = autoAnswer('draft-conflict', 'continue-draft' satisfies DraftConflictChoice);
    const plan = await resolveOpenPlan(plugin);

    // The draft was chosen, so the document on screen steps aside — the point
    // is that the choice happened at all rather than the draft vanishing.
    expect(plan.draft?.shell.name).toBe('Unsaved work');
    expect(plan.base).toBeNull();
  });

  it('shelving the draft opens the document on screen', async () => {
    await seedDraft(makeDraft('doc-1', 'Unsaved work'));
    setOpenDocumentBase(ON_SCREEN);

    const plugin = new AssetEditorPlugin();
    unsubDialog = autoAnswer('draft-conflict', 'open-requested' satisfies DraftConflictChoice);
    const plan = await resolveOpenPlan(plugin);

    expect(plan.base).toEqual(ON_SCREEN);
    expect(await listShelvedDocumentDrafts()).toHaveLength(1);
  });

  // ── plan-711 §9.8: the same chain when the document can be BOUND ──────
  //
  // A scene the store still holds is not opened from bytes at all — the living
  // `RvDocument` crosses over instead (§2.2). That makes it a fourth outcome of
  // this one chain, and it has to take its place in the SAME order: an explicit
  // request still wins, and a crash draft still gets asked about rather than
  // being answered by a silent bind.

  it('binds instead of opening when the store still holds that scene', async () => {
    setOpenDocumentBase(SCENE_ON_SCREEN);
    const store = fakeSceneStore(SCENE_ON_SCREEN);
    sceneStoreHolder.store = store;

    const plan = await resolveOpenPlan(new AssetEditorPlugin());

    expect(plan.bind).toBe(store.handover);
    // Nothing to LOAD: a bind is not an open, and a `sceneDocument` reaching
    // `_loadBase` would be the branch that does not exist.
    expect(plan.base).toBeNull();
    expect(plan.draft).toBeNull();
  });

  it('a crash draft still outranks the bind — the question is asked, not skipped', async () => {
    await seedDraft(makeDraft('doc-1', 'Unsaved work'));
    setOpenDocumentBase(SCENE_ON_SCREEN);
    const store = fakeSceneStore(SCENE_ON_SCREEN);
    sceneStoreHolder.store = store;

    const plan = await resolveOpenPlan(new AssetEditorPlugin());

    expect(plan.draft?.shell.name).toBe('Unsaved work');
    expect(plan.bind ?? null).toBeNull();
    // And the scene was never handed over, so it keeps writing its own body.
    expect(store.handoverCalls).toBe(0);
  });

  it('an explicit "Edit asset" click outranks the bind, exactly as it does an open', async () => {
    setOpenDocumentBase(SCENE_ON_SCREEN);
    setPendingAssetOpen(REQUESTED);
    const store = fakeSceneStore(SCENE_ON_SCREEN);
    sceneStoreHolder.store = store;

    const plan = await resolveOpenPlan(new AssetEditorPlugin());

    expect(plan.base).toEqual(REQUESTED);
    expect(plan.bind ?? null).toBeNull();
    expect(store.handoverCalls).toBe(0);
  });

  it('a DIFFERENT scene does not bind — and does not fall through as a load either', async () => {
    setOpenDocumentBase(SCENE_ON_SCREEN);
    sceneStoreHolder.store = fakeSceneStore(sceneDocumentBase('scene_OTHER', 'Other'));
    saveLastEditedAsset(LAST_EDITED);

    const plan = await resolveOpenPlan(new AssetEditorPlugin());

    // The identity comparison is conservative by design (risk 8): no match, no
    // bind — and a scene identity may never reach `_loadBase`, so the chain
    // falls through to what it did before plan-711.
    expect(plan.bind ?? null).toBeNull();
    expect(plan.base).toEqual(LAST_EDITED);
  });

  it('a store that refuses the handover leaves the chain unchanged', async () => {
    setOpenDocumentBase(SCENE_ON_SCREEN);
    const store = fakeSceneStore(SCENE_ON_SCREEN, { refuse: true });
    sceneStoreHolder.store = store;
    saveLastEditedAsset(LAST_EDITED);

    const plan = await resolveOpenPlan(new AssetEditorPlugin());

    expect(store.handoverCalls).toBe(1);
    expect(plan.bind ?? null).toBeNull();
    expect(plan.base).toEqual(LAST_EDITED);
  });
});
