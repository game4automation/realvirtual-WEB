// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-386 §9.4 — the transient workspace seam.
 *
 * ## Why the guards are pre-filled
 *
 * Every "leaves nothing behind" assertion here runs against storage that
 * **already has the visitor's data in it**. Asserting on an empty localStorage
 * would pass for the wrong reason: a store that writes nothing and a store that
 * writes the right thing to a key nobody looked at are indistinguishable when
 * you start from nothing. The defect this seam fixes is not "something appears"
 * — it is "the visitor's own active-scene pointer and draft are *overwritten*"
 * (R5), and only a pre-filled fixture can see that.
 *
 * ## Why the GLB io and the bake are mocked
 *
 * Since plan-397 the autosave writes a GLB body through `rv-scene-glb-io`, not
 * an op log into localStorage. A test that only watched localStorage would have
 * declared this seam correct while the real persistence path ran happily
 * underneath it. Mocking both modules turns "did anything get persisted" into a
 * call count that covers the new path and the old one at once.
 *
 * `rv-scene-executors` is mocked for the same reason in reverse: this file is
 * about persistence, not about what an op does to a scene graph, and a real
 * executor would need a real viewer.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../src/core/hmi/scene/rv-scene-glb-io', () => ({
  readSceneGlbBody: vi.fn(async () => null),
  writeSceneGlbBody: vi.fn(async () => ({ revision: 'rev1', target: 'opfs' })),
  dropSceneGlbBody: vi.fn(async () => undefined),
  sceneGlbBodyRevision: vi.fn(async () => null),
}));

vi.mock('../src/core/hmi/scene/rv-scene-glb-bake', () => ({
  bakeIntoGlb: vi.fn(async () => ({ glb: new Uint8Array([1, 2, 3, 4]), warnings: [] })),
  makeRegistryBakeResolver: vi.fn(() => ({})),
  bakeRequiresFullPath: vi.fn(() => false),
}));

vi.mock('../src/core/hmi/scene/rv-scene-executors', () => ({
  applyForward: vi.fn(async () => undefined),
  applyInverse: vi.fn(async () => undefined),
  writeUserDataField: vi.fn(),
  deleteUserDataField: vi.fn(),
  reapplySchemaForComponent: vi.fn(),
}));

import { SceneStore } from '../src/core/hmi/scene/scene-store';
import { makeDraftScene, type RvScene } from '../src/core/hmi/scene/rv-scene-types';
import type { RvScenePrimitiveOp } from '../src/core/ops/rv-unified-ops';
import { writeSceneGlbBody } from '../src/core/hmi/scene/rv-scene-glb-io';
// plan-716 Phase 3: the two "transient becomes persistent" cases convert into a
// DOCUMENT now. The transient seam itself is untouched — see the block comment
// at those two cases.
import { documentsOf } from '../src/core/project/rv-project-documents';
import { resetProjectStore } from '../src/core/project/project-store';
import { installFakeDocumentProject } from './helpers/fake-document-project';

const LS_ACTIVE = 'rv-scenes/active';
const LS_DRAFT_EMPTY = 'rv-scenes/draft/empty';
const LS_SCENE_DRAFT = 'rv-scenes/scene-draft/scn_mine';

/** What the visitor had before anyone sent him a link. */
const PRE_ACTIVE = JSON.stringify({ id: 'scn_mine' });
const PRE_DRAFT = JSON.stringify({ marker: 'the visitor own draft' });

function sharedScene(name = 'Pick & Place Cell'): RvScene {
  return makeDraftScene({ kind: 'builtin', url: 'https://files.example.test/cell.glb', label: name }, name);
}

interface FakeViewer {
  loadScene: (s: RvScene) => Promise<void>;
  getPlugin: <T>(id: string) => T | undefined;
  availableModels: { url: string; label: string }[];
  availablePublishedScenes: unknown[];
  currentScene: RvScene | null;
  currentModelUrl: string | null;
  currentModelRoot: unknown;
  registry: unknown;
  lastLoadResult: unknown;
  modes: { has: (id: string) => boolean; setMode: (id: string) => void };
  loaded: RvScene[];
  failNextLoad: boolean;
}

function makeViewer(): FakeViewer {
  const v: FakeViewer = {
    loaded: [],
    failNextLoad: false,
    availableModels: [],
    availablePublishedScenes: [],
    currentScene: null,
    currentModelUrl: 'https://files.example.test/cell.glb',
    currentModelRoot: null,
    registry: { getGltfNodeNames: () => [], getGltfNodeIndex: () => -1 },
    lastLoadResult: null,
    modes: { has: () => true, setMode: vi.fn() },
    loadScene: vi.fn(async (s: RvScene) => {
      if (v.failNextLoad) { v.failNextLoad = false; throw new Error('that GLB could not be parsed'); }
      v.loaded.push(s);
      v.currentScene = s;
    }),
    getPlugin: () => undefined,
  };
  return v;
}

function makeStore(viewer: FakeViewer): SceneStore {
  return new SceneStore(viewer as unknown as ConstructorParameters<typeof SceneStore>[0]);
}

function anOp(): RvScenePrimitiveOp {
  return {
    id: `op_${Math.random().toString(36).slice(2)}`,
    ts: Date.now(),
    schemaV: 1,
    kind: 'setField',
    nodePath: 'Root/Thing',
    componentType: 'Drive',
    fieldName: 'speed',
    value: 42,
  } as RvScenePrimitiveOp;
}

/** Everything the seam must not touch, captured verbatim. */
function storageFingerprint(): Record<string, string | null> {
  return {
    active: localStorage.getItem(LS_ACTIVE),
    draftEmpty: localStorage.getItem(LS_DRAFT_EMPTY),
    sceneDraft: localStorage.getItem(LS_SCENE_DRAFT),
  };
}

let viewer: FakeViewer;
let store: SceneStore;

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(LS_ACTIVE, PRE_ACTIVE);
  localStorage.setItem(LS_DRAFT_EMPTY, PRE_DRAFT);
  localStorage.setItem(LS_SCENE_DRAFT, PRE_DRAFT);
  vi.mocked(writeSceneGlbBody).mockClear();
  // `_ensureBaseBytes` fetches the base GLB before it can bake anything. The
  // bytes are irrelevant here — the bake is mocked — but the fetch has to
  // succeed or every persistence assertion would pass for the wrong reason.
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () => new Response(new ArrayBuffer(8), { status: 200 }),
  );
  vi.useFakeTimers();
  viewer = makeViewer();
  store = makeStore(viewer);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  store.dispose();
});

/**
 * Let the debounced autosave (2 s) fire and its promise chain settle.
 *
 * The chain is dynamic-import based (`rv-scene-glb-bake`, `rv-scene-glb-io`,
 * `rv-scene-live-sync`), so advancing the clock once is not enough — the write
 * happens several turns after the timer. Several small advances give those
 * turns without waiting on wall-clock time.
 */
async function letAutosaveRun(): Promise<void> {
  await vi.advanceTimersByTimeAsync(2500);
  for (let i = 0; i < 25; i++) await vi.advanceTimersByTimeAsync(1);
}

/** Positive counterpart: wait until the autosave really did write. */
async function expectAutosaveWrote(): Promise<void> {
  await vi.waitFor(() => { expect(writeSceneGlbBody).toHaveBeenCalled(); }, { timeout: 5000 });
}

describe('plan-386 §9.4 — transient workspace', () => {
  it('transient_KeepsActiveScenePointer', async () => {
    await store.openTransient(sharedScene());

    // The pre-filled pointer is the assertion: `_loadIntoWorkspace` passes
    // `saved = null` on this path, so the un-gated version wrote
    // `setActiveSceneId(null)` and deleted it (R5).
    expect(localStorage.getItem(LS_ACTIVE)).toBe(PRE_ACTIVE);
    expect(store.isTransient()).toBe(true);
    expect(store.getSnapshot().transient).toBe(true);
  });

  it('transient_NoDraftWriteAfterEditAndTimer', async () => {
    await store.openTransient(sharedScene());
    const before = storageFingerprint();

    await store.applyOp(anOp());
    await letAutosaveRun();

    // Neither the old op-log draft keys …
    expect(storageFingerprint()).toEqual(before);
    // … nor the GLB body path plan-397 replaced them with.
    expect(writeSceneGlbBody).not.toHaveBeenCalled();
  });

  it('transient_NoGlbBodyOrPointerWriteOnRepeatedEdits', async () => {
    await store.openTransient(sharedScene());

    for (let i = 0; i < 5; i++) {
      await store.applyOp(anOp());
      await letAutosaveRun();
    }

    expect(writeSceneGlbBody).not.toHaveBeenCalled();
    expect(localStorage.getItem(LS_ACTIVE)).toBe(PRE_ACTIVE);
    expect(localStorage.getItem(LS_DRAFT_EMPTY)).toBe(PRE_DRAFT);
  });

  it('transient_DoesNotMutateUrl', async () => {
    const before = window.location.search;
    await store.openTransient(sharedScene());
    // A `?scene=` written here would replace the shared link, and a reload
    // would point at a scene that does not exist (F18/R11).
    expect(window.location.search).toBe(before);
  });

  it('transient_EditUndoRedoStillWorks', async () => {
    await store.openTransient(sharedScene());

    await store.applyOp(anOp());
    expect(store.getSnapshot().canUndo).toBe(true);

    await store.undo();
    expect(store.getSnapshot().canUndo).toBe(false);
    expect(store.getSnapshot().canRedo).toBe(true);

    await store.redo();
    expect(store.getSnapshot().canUndo).toBe(true);
    // Editing works; only the writing is gone. A viewer who may not move
    // anything is not a viewer.
    expect(writeSceneGlbBody).not.toHaveBeenCalled();
  });

  it('transient_ThenNormalOpen_AutosaveWorksAgain', async () => {
    await store.openTransient(sharedScene());
    expect(store.isTransient()).toBe(true);

    await store.openBuiltin('https://example.test/mine.glb', 'mine');
    expect(store.isTransient()).toBe(false);

    await store.applyOp(anOp());
    await letAutosaveRun();

    // R6 in one assertion: a flag left standing would mean the user edits for
    // an hour with the autosave silently off.
    await expectAutosaveWrote();
  });

  it('transient_ThenMarkGlbActive_ResetsFlag', async () => {
    await store.openTransient(sharedScene());
    // markGlbActive sets the workspace AND the pointer outside
    // `_loadIntoWorkspace`, which is precisely why it is in the contract.
    store.markGlbActive('https://example.test/other.glb', 'other');
    expect(store.isTransient()).toBe(false);
  });

  // ── The two save cases, ported to the one save path (plan-716 Phase 3) ──
  //
  // The TRANSIENT seam is untouched and every pin above is unchanged. What
  // changed is the destination of the conversion: "saving is what turns
  // somebody else's content into mine" (plan-386 §2.5) still holds word for
  // word, but "mine" is a DOCUMENT now, not a catalogue row plus a body slot.
  // So these two need a project to convert INTO, and they assert on the file.

  it('transient_ThenSaveAs_BecomesPersistent', async () => {
    const project = installFakeDocumentProject();
    try {
      await store.openTransient(sharedScene());
      await store.applyOp(anOp());

      const id = await store.saveAs('My copy');

      expect(store.isTransient()).toBe(false);
      expect(id).toBeTruthy();
      // The save actually reached storage — the `_writeBody` safety net must not
      // refuse the write the user explicitly asked for.
      const row = documentsOf(project.project()).find(d => d.id === id)!;
      expect(row.name).toBe('My copy');
      expect(project.files.has(row.path)).toBe(true);
    } finally {
      project.restore();
      resetProjectStore();
    }
  });

  it('transient_ThenSave_BecomesPersistent', async () => {
    const project = installFakeDocumentProject();
    try {
      await store.openTransient(sharedScene());
      await store.applyOp(anOp());

      await store.save();

      expect(store.isTransient()).toBe(false);
      expect(documentsOf(project.project())).toHaveLength(1);
      // User decision 2026-08-30 (plan-719 residual): new documents save to the project root
      expect(project.writes.map(w => w.relPath))
        .toEqual(['Pick & Place Cell.glb']);
    } finally {
      project.restore();
      resetProjectStore();
    }
  });

  it('transient_ThenDiscard_ResetsFlag', async () => {
    await store.openTransient(sharedScene());
    await store.discard();
    expect(store.isTransient()).toBe(false);
  });

  it('transient_FailedLoad_LeavesStateUntouched', async () => {
    // Give the visitor a real workspace first — the thing that must survive.
    await store.openBuiltin('https://example.test/mine.glb', 'mine');
    const nameBefore = store.getSnapshot().draft?.name;
    const storageBefore = storageFingerprint();

    viewer.failNextLoad = true;
    await expect(store.openTransient(sharedScene('Hostile'))).rejects.toThrow(/could not be parsed/);

    // No half state: not the workspace, not the flag, not storage.
    expect(store.getSnapshot().draft?.name).toBe(nameBefore);
    expect(store.isTransient()).toBe(false);
    expect(storageFingerprint()).toEqual(storageBefore);
  });

  it('nonTransient_UnchangedBehaviour', async () => {
    // The regression gate for the invasive change (R12): the ordinary path
    // still writes the pointer and still autosaves.
    await store.openBuiltin('https://example.test/mine.glb', 'mine');
    expect(store.isTransient()).toBe(false);
    expect(store.getSnapshot().transient).toBe(false);

    await store.applyOp(anOp());
    await letAutosaveRun();

    await expectAutosaveWrote();
    // openBuiltin has no saved id, so the pointer is cleared — the documented
    // behaviour of the non-transient path, unchanged by this plan.
    expect(localStorage.getItem(LS_ACTIVE)).not.toBe(PRE_ACTIVE);
  });
});

/**
 * `hasUnpersistedWork()` — would a RELOAD lose this?
 *
 * A different question from `dirty`, and the reason the page-level unload guard
 * exists at all. `dirty` is the routine state of any workspace being worked in;
 * warning about it on every F5 would be the dialog users learn to dismiss. Only
 * two states actually destroy work, and both are pinned here.
 */
describe('hasUnpersistedWork — what a reload would destroy', () => {
  it('a clean transient workspace has nothing at risk', async () => {
    await store.openTransient(sharedScene());
    expect(store.hasUnpersistedWork()).toBe(false);
  });

  it('ANY edit in a transient workspace is at risk — it is never autosaved', async () => {
    await store.openTransient(sharedScene());
    await store.applyOp(anOp());

    expect(store.hasUnpersistedWork()).toBe(true);
    // Still true after the debounce window: the timer was never scheduled, so
    // waiting does not save it. This is the shared-link case — someone binds
    // signals to a demo and presses F5.
    await letAutosaveRun();
    expect(store.hasUnpersistedWork()).toBe(true);
    expect(writeSceneGlbBody).not.toHaveBeenCalled();
  });

  it('undoing back to the baseline takes the risk away again', async () => {
    await store.openTransient(sharedScene());
    await store.applyOp(anOp());
    await store.undo();
    expect(store.hasUnpersistedWork()).toBe(false);
  });

  it('saving a transient workspace ends the risk', async () => {
    const project = installFakeDocumentProject();   // Phase 3: a save needs a home
    try {
      await store.openTransient(sharedScene());
      await store.applyOp(anOp());
      await store.saveAs('Mine');
      await letAutosaveRun();
      expect(store.hasUnpersistedWork()).toBe(false);
    } finally {
      project.restore();
      resetProjectStore();
    }
  });

  it('a normal workspace is at risk only inside the debounce window', async () => {
    await store.openBuiltin('https://example.test/mine.glb', 'mine');
    expect(store.hasUnpersistedWork()).toBe(false);

    await store.applyOp(anOp());
    // The write is scheduled but has not run — a reload right now drops it.
    expect(store.hasUnpersistedWork()).toBe(true);

    await letAutosaveRun();
    await expectAutosaveWrote();
    // Written. Still `dirty` against the saved scene, but nothing would be lost,
    // which is exactly the distinction the guard is built on.
    expect(store.getSnapshot().dirty).toBe(true);
    expect(store.hasUnpersistedWork()).toBe(false);
  });

  it('an empty workspace answers no', () => {
    expect(store.hasUnpersistedWork()).toBe(false);
  });
});
