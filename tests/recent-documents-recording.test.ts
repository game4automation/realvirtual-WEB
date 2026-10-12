// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-478 §9.3 — the ring is written by the OPEN FUNNEL, not by call sites.
 *
 * Same argument as `document-open-remembers-session.test.ts` makes for the
 * resume pair, and the same harness: a unit test of `recordRecentForOpen`
 * passes happily while the feature is dead in the product, because the thing
 * that can be wrong is WHERE it is called from. So every assertion here goes
 * through the real `SceneStore`:
 *
 *  - an ordinary open records (F1) and carries the live mode (F1b);
 *  - a kiosk records nothing at all (F5);
 *  - **Save-as and the first save of a draft record too (R3-6)** — no load
 *    happens on either, so the funnel never sees them, and a ring that missed
 *    them would keep sending the user back to the file they saved AWAY from;
 *  - an ordinary in-place save records NOTHING, because it changes no identity;
 *  - the mode tracking, attached the way `main.ts` attaches it BEFORE the mode
 *    boot, stamps the boot mode onto the document that is open (R3-5).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => ({ bodies: new Map<string, Uint8Array>() }));

vi.mock('../src/core/hmi/scene/rv-scene-glb-io', () => ({
  readSceneGlbBody: vi.fn(async (slot: string) => {
    const glb = h.bodies.get(slot);
    return glb ? { glb, revision: `rev-${slot}`, target: 'opfs' as const } : null;
  }),
  writeSceneGlbBody: vi.fn(async () => ({ revision: 'rev1', target: 'opfs' as const })),
  dropSceneGlbBody: vi.fn(async (slot: string) => { h.bodies.delete(slot); }),
  sceneGlbBodyRevision: vi.fn(async () => null),
}));

vi.mock('../src/core/hmi/scene/rv-scene-glb-bake', () => ({
  bakeIntoGlb: vi.fn(async () => ({
    glb: new Uint8Array([0x67, 0x6c, 0x54, 0x46, 1, 2, 3, 4]),
    warnings: [],
    writtenReferences: [],
  })),
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
import type { RvScene } from '../src/core/hmi/scene/rv-scene-types';
import { clearAllScenes, setDraftScope } from '../src/core/hmi/scene/rv-scene-storage';
import { clearSceneMutationListeners } from '../src/core/hmi/scene/rv-scene-mutations';
import { setOpenDocumentBase } from '../src/core/editor/active-asset-store';
import { resetProjectStore } from '../src/core/project/project-store';
import { clearAllDocumentAliases } from '../src/core/project/rv-doc-alias';
import {
  attachRecentsModeTracking,
  readRecents,
  LS_KEY_RECENT_DOCUMENTS,
  __resetRecentsSnapshot,
} from '../src/core/project/rv-project-recents-store';
import {
  fakeGlb,
  installFakeDocumentProject,
  type FakeDocumentProject,
} from './helpers/fake-document-project';
import { stableDocumentId } from '../src/core/project/rv-project-documents';

const PROJECT_ID = 'prj_recents_funnel';
const BELT_PATH = 'scenes/Belt.glb';
const BELT_ID = 'doc_belt';
const CELL_PATH = 'models/Cell.glb';
const CELL_ID = 'doc_cell';

type ModeListener = (data: { from: string | null; to: string }) => void;

/**
 * A viewer whose mode manager is a plain settable field plus an event bus —
 * the two things the recording reads (`activeMode`, `lockedMode`) and the one
 * thing the tracking listens on.
 */
function makeViewer(activeMode: string | null = 'hmi', lockedMode: string | null = null) {
  const listeners = new Set<ModeListener>();
  const v = {
    loaded: [] as RvScene[],
    availableModels: [],
    availablePublishedScenes: [],
    currentScene: null as RvScene | null,
    currentModelUrl: null as string | null,
    currentModelRoot: null as unknown,
    registry: {
      getGltfNodeNames: () => [], getGltfNodeIndex: () => -1,
      getPathForNode: () => null, getNode: () => null,
    },
    lastLoadResult: null,
    modes: { has: () => true, setMode: () => {}, activeMode, lockedMode },
    getPlugin: () => undefined,
    loadScene: async (s: RvScene) => { v.loaded.push(s); v.currentScene = s; },
    loadEmptyScene: async () => { v.currentScene = null; },
    /** The `mode-changed` bus `attachRecentsModeTracking` subscribes to. */
    on: (_e: 'mode-changed', cb: ModeListener) => {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    /** What `ModeManager.setMode` does, reduced to what this test needs. */
    emitModeChanged(to: string) {
      const from = v.modes.activeMode;
      v.modes.activeMode = to;
      for (const l of [...listeners]) l({ from, to });
    },
  };
  return v;
}

let project: FakeDocumentProject;
let viewer: ReturnType<typeof makeViewer>;
let store: SceneStore;
let urlBefore: string;

function makeStore(v: ReturnType<typeof makeViewer>): SceneStore {
  return new SceneStore(v as unknown as ConstructorParameters<typeof SceneStore>[0]);
}

function setup(activeMode: string | null = 'hmi', lockedMode: string | null = null) {
  viewer = makeViewer(activeMode, lockedMode);
  store = makeStore(viewer);
}

beforeEach(() => {
  urlBefore = window.location.href;
  localStorage.clear();
  __resetRecentsSnapshot();
  clearAllScenes();
  clearAllDocumentAliases();
  setDraftScope(null);
  clearSceneMutationListeners();
  setOpenDocumentBase(null);
  resetProjectStore();
  h.bodies.clear();
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () => new Response(new ArrayBuffer(8), { status: 200 }),
  );
  project = installFakeDocumentProject({
    id: PROJECT_ID,
    documents: [
      { id: BELT_ID, path: BELT_PATH, name: 'Belt', section: 'scenes' },
      { id: CELL_ID, path: CELL_PATH, name: 'Cell', section: 'models' },
    ],
  });
  setup();
});

afterEach(() => {
  vi.restoreAllMocks();
  store.dispose();
  project.restore();
  resetProjectStore();
  clearAllScenes();
  clearAllDocumentAliases();
  setOpenDocumentBase(null);
  clearSceneMutationListeners();
  localStorage.clear();
  __resetRecentsSnapshot();
  window.history.replaceState(window.history.state, '', urlBefore);
});

// ─── F1 / F1b — the funnel records ───────────────────────────────────────

describe('openDocument writes the ring', () => {
  it('records the document, its project, its backend and the live mode', async () => {
    await store.openDocument(BELT_ID);

    expect(readRecents()).toHaveLength(1);
    expect(readRecents()[0]).toMatchObject({
      projectId: PROJECT_ID,
      documentId: BELT_ID,
      documentName: 'Belt',
      // The verb that brings this project back — the fake project is a browser
      // one, and `openProjectById` routes on exactly this.
      backend: 'browser',
      mode: 'hmi',
    });
  });

  // T3 (plan-482 F3), site 1 of 3. The path recorded must be the very string
  // `openDocument` handed to `projectAssetUrl` — not a lookalike, and above all
  // not `undefined`, which is what a forgotten parameter looks like.
  it('records the project-relative path the open itself used', async () => {
    await store.openDocument(BELT_ID);
    expect(readRecents()[0].documentPath).toBe(BELT_PATH);

    await store.openDocument(CELL_ID);
    expect(readRecents()[0].documentPath).toBe(CELL_PATH);
  });

  it('a second open moves to the front; a re-open does not duplicate', async () => {
    await store.openDocument(BELT_ID);
    await store.openDocument(CELL_ID);
    await store.openDocument(BELT_ID);

    expect(readRecents().map(e => e.documentId)).toEqual([BELT_ID, CELL_ID]);
  });

  it('publishes the open document id, which is what the tracking reads', async () => {
    expect(store.openDocumentId).toBeNull();
    await store.openDocument(BELT_ID);
    expect(store.openDocumentId).toBe(BELT_ID);
  });
});

// ─── F5 — kiosk ──────────────────────────────────────────────────────────

describe('a kiosk deployment', () => {
  it('records nothing and retags nothing, however the document was opened', async () => {
    setup('hmi', 'hmi');
    attachRecentsModeTracking(viewer, () => ({
      projectId: PROJECT_ID, documentId: store.openDocumentId,
    }));

    await store.openDocument(BELT_ID);
    viewer.emitModeChanged('planner');

    expect(readRecents()).toEqual([]);
    expect(localStorage.getItem(LS_KEY_RECENT_DOCUMENTS)).toBeNull();
  });
});

// ─── R3-5 — the tracking is attached BEFORE the mode boot ────────────────

describe('R3-5 — mode tracking attached before the mode boot', () => {
  it('stamps the BOOT mode onto the document the boot opened', async () => {
    // main.ts order: subscribe, resume the document, then boot the mode. The
    // document therefore loads under the PREVIOUS session's mode and the boot
    // event is the only statement about where the user actually is.
    attachRecentsModeTracking(viewer, () => ({
      projectId: PROJECT_ID, documentId: store.openDocumentId,
    }));
    await store.openDocument(BELT_ID);
    expect(readRecents()[0].mode).toBe('hmi');

    viewer.emitModeChanged('planner');            // the mode boot

    expect(readRecents()[0]).toMatchObject({ documentId: BELT_ID, mode: 'planner' });
  });

  it('a mode the user settles in later retags only the OPEN document', async () => {
    attachRecentsModeTracking(viewer, () => ({
      projectId: PROJECT_ID, documentId: store.openDocumentId,
    }));
    await store.openDocument(CELL_ID);
    await store.openDocument(BELT_ID);

    viewer.emitModeChanged('des');

    expect(readRecents().map(e => [e.documentId, e.mode]))
      .toEqual([[BELT_ID, 'des'], [CELL_ID, 'hmi']]);
  });

  it('a mode change with nothing open writes nothing at all', () => {
    attachRecentsModeTracking(viewer, () => ({
      projectId: PROJECT_ID, documentId: store.openDocumentId,
    }));
    viewer.emitModeChanged('planner');
    expect(readRecents()).toEqual([]);
  });
});

// ─── R3-6 — a new document identity, without a load ──────────────────────

describe('R3-6 — Save-as and the first save of a draft', () => {
  it('Save-as records the COPY at the head, leaving the source in the list', async () => {
    await store.openDocument(BELT_ID);
    expect(readRecents().map(e => e.documentId)).toEqual([BELT_ID]);

    const copyId = await store.saveAs('Belt copy');

    // A "save as" is a fork: the copy is what the user is working on now, and
    // the original is still a real file worth coming back to.
    expect(readRecents().map(e => e.documentId)).toEqual([copyId, BELT_ID]);
    expect(readRecents()[0]).toMatchObject({ documentName: 'Belt copy', projectId: PROJECT_ID });
  });

  it('an ordinary in-place save changes no identity and records nothing', async () => {
    await store.openDocument(BELT_ID);
    const before = readRecents();

    await store.save();

    // Same single entry, same everything: the ring's order must not churn
    // every time the user presses Ctrl+S.
    expect(readRecents().map(e => e.documentId)).toEqual(before.map(e => e.documentId));
    expect(readRecents()).toHaveLength(1);
  });

  it('the first save of a fresh draft places a document AND records it', async () => {
    await store.newEmpty();
    // `newEmpty` mints a document through the funnel since plan-716 F5, so the
    // ring already names it; the assertion that matters is that the SAVE which
    // gives it a file does not lose it.
    const opened = store.openDocumentId;
    expect(opened).not.toBeNull();

    await store.save();

    expect(readRecents()[0].documentId).toBe(opened);
  });

  // T3 (plan-482 F3), sites 2 and 3. Both are asserted against the path the
  // BACKEND was actually asked to write, so the test cannot drift into
  // agreeing with itself about a path the file never had.
  it('Save-as records the path the copy was written to', async () => {
    await store.openDocument(BELT_ID);
    const writesBefore = project.writes.length;

    await store.saveAs('Belt copy');

    const written = project.writes.slice(writesBefore).map(w => w.relPath);
    expect(readRecents()[0].documentPath).toBeTruthy();
    expect(written).toContain(readRecents()[0].documentPath);
  });

  it('the first save of a draft records the path it was placed at', async () => {
    await store.newEmpty();
    const writesBefore = project.writes.length;

    await store.save();

    const written = project.writes.slice(writesBefore).map(w => w.relPath);
    expect(readRecents()[0].documentPath).toBeTruthy();
    expect(written).toContain(readRecents()[0].documentPath);
  });
});

// ─── T3, the two cases the ordinary fixture walks straight past ──────────

describe('T3 — recording sites the happy path does not exercise', () => {
  it('an open that ADOPTS the row still records a path', async () => {
    // The field case from `_documentRowOrAdopt`: a GLB dropped into an open
    // project through the file explorer. It has bytes and no manifest row, so
    // the first lookup misses; the card shows a DERIVED row whose id is minted
    // from the path, and the adopt run mints the same id. The branch has to
    // yield a path just like the hit branch — `undefined` here would poison
    // the ring with a row that can never say where it came from.
    const DROPPED = 'models/Dropped.glb';
    project.files.set(DROPPED, fakeGlb('Dropped'));
    (project.backend as unknown as {
      statDocuments(): Promise<{ path: string; size: number }[]>;
    }).statDocuments = async () => [...project.files.keys()]
      .map(path => ({ path, size: project.files.get(path)!.byteLength }));

    const adoptedId = stableDocumentId(DROPPED);
    expect(project.documents().map(d => d.id)).not.toContain(adoptedId);

    await store.openDocument(adoptedId);

    expect(readRecents()[0]).toMatchObject({
      documentId: adoptedId,
      documentPath: DROPPED,
    });
  });

  it('a bundled document is recorded with its path too', async () => {
    // A shipped demo document: same funnel, different backend kind. It is the
    // kind that is read-only and skipped by the rescan, so it is worth stating
    // that its ring row is complete rather than assuming it.
    (project.backend as unknown as { kind: string }).kind = 'bundled';

    await store.openDocument(BELT_ID);

    expect(readRecents()[0]).toMatchObject({
      backend: 'bundled',
      documentId: BELT_ID,
      documentPath: BELT_PATH,
    });
  });
});


// ─── T4, way 2 of 2 — SceneStore.rename (plan-482 §2.7) ──────────────────

/**
 * The second, INDEPENDENT way a document changes place. `SceneStore.rename`
 * copies the bytes, deletes the old file and patches the manifest row entirely
 * on its own — it never touches `applyTreeMove` — so a fix that only handled
 * the tree move would leave the ring lying here.
 */
describe('rename re-points the recents ring', () => {
  it('re-points a row that is NOT the head, without resorting the list', async () => {
    await store.openDocument(CELL_ID);
    await store.openDocument(BELT_ID);
    const before = readRecents();
    expect(before.map(e => e.documentId)).toEqual([BELT_ID, CELL_ID]);

    await store.rename(CELL_ID, 'Cell renamed');

    const after = readRecents();
    // Only the path of the renamed row moved. A rename is not an open: the
    // order, the mode and the timestamps are the same list as before.
    expect(after.map(e => e.documentId)).toEqual([BELT_ID, CELL_ID]);
    expect(after.map(e => e.openedAt)).toEqual(before.map(e => e.openedAt));
    expect(after.map(e => e.mode)).toEqual(before.map(e => e.mode));
    expect(after[0].documentPath).toBe(BELT_PATH);
    expect(after[1].documentPath).not.toBe(CELL_PATH);
    // and it is the path the file actually has now
    expect(project.documents().find(d => d.id === CELL_ID)?.path)
      .toBe(after[1].documentPath);
  });

  it('a rename that moves no file leaves the recorded path alone', async () => {
    await store.openDocument(BELT_ID);
    const before = readRecents()[0].documentPath;

    // Renaming to the name it already has plans no destination, so no bytes
    // move — and a ring entry must not be rewritten for a non-event.
    await store.rename(BELT_ID, 'Belt');

    expect(readRecents()[0].documentPath).toBe(before);
  });
});
