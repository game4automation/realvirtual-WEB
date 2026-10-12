// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-513 §9.3 — a document's last mode is written by the OPEN FUNNEL, not by
 * call sites, and kept honest by the `mode-changed` tracking.
 *
 * The harness of `recent-documents-recording.test.ts`, for the same reason: the
 * thing that can be wrong is WHERE the write happens, so every assertion goes
 * through the real `SceneStore` into a real IndexedDB:
 *
 *  - an open records the live mode, a later switch overwrites it (F1/F2);
 *  - inside an open-intent scope the INTENT is recorded, never the handoff's
 *    park mode, and the tracking is inert (F1/F2);
 *  - Save-as and the first save of a draft record the NEW document (F1);
 *  - a kiosk and a demo record nothing, and a project opened as a demo loses
 *    the entries it had (F3, SOL R2 F4).
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
import { getProjectStore, resetProjectStore } from '../src/core/project/project-store';
import { clearAllDocumentAliases } from '../src/core/project/rv-doc-alias';
import { __resetRecentsSnapshot, withOpenIntentMode } from '../src/core/project/rv-project-recents-store';
import {
  DOCUMENT_MODES_DB_NAME,
  __closeDocumentModesDb,
  attachDocumentModeTracking,
  loadDocumentModes,
  readDocumentMode,
  setDocumentMode,
} from '../src/core/project/rv-document-mode-store';
import { installFakeDocumentProject, type FakeDocumentProject } from './helpers/fake-document-project';

const PROJECT_ID = 'prj_modes_funnel';
const BELT_ID = 'doc_belt';
const CELL_ID = 'doc_cell';

type ModeListener = (data: { from: string | null; to: string }) => void;

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
    on: (_e: 'mode-changed', cb: ModeListener) => {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
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

function setup(activeMode: string | null = 'hmi', lockedMode: string | null = null) {
  viewer = makeViewer(activeMode, lockedMode);
  store = new SceneStore(viewer as unknown as ConstructorParameters<typeof SceneStore>[0]);
}

/** main.ts's wiring, reduced to the fake project. */
function track() {
  attachDocumentModeTracking(viewer, () => ({
    projectId: PROJECT_ID,
    backend: 'browser',
    documentId: store.openDocumentId,
    isDemo: getProjectStore().getProject()?.kind === 'demo',
  }));
}

/** The funnel fires its write and does not await it — wait for it to land. */
async function modeOf(documentId: string, expected: string | null) {
  await vi.waitFor(async () => {
    expect(await readDocumentMode('browser', PROJECT_ID, documentId)).toBe(expected);
  });
}

async function dropModeDb() {
  __closeDocumentModesDb();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DOCUMENT_MODES_DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  urlBefore = window.location.href;
  localStorage.clear();
  __resetRecentsSnapshot();
  await dropModeDb();
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
      { id: BELT_ID, path: 'scenes/Belt.glb', name: 'Belt', section: 'scenes' },
      { id: CELL_ID, path: 'models/Cell.glb', name: 'Cell', section: 'models' },
    ],
  });
  setup();
});

afterEach(async () => {
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
  await dropModeDb();
  window.history.replaceState(window.history.state, '', urlBefore);
});

describe('the funnel and the tracking write the last mode', () => {
  it('an open in the HMI writes hmi; a switch to the editor writes editor', async () => {
    track();
    await store.openDocument(BELT_ID);
    await modeOf(BELT_ID, 'hmi');

    viewer.emitModeChanged('editor');
    await modeOf(BELT_ID, 'editor');
  });

  it('a switch only touches the OPEN document', async () => {
    track();
    await store.openDocument(CELL_ID);
    await store.openDocument(BELT_ID);
    viewer.emitModeChanged('des');
    await modeOf(BELT_ID, 'des');
    await modeOf(CELL_ID, 'hmi');
  });
});

describe('the open-intent scope', () => {
  it('records the intent T, not the park mode, and the tracking is inert inside', async () => {
    track();
    await withOpenIntentMode('editor', async () => {
      viewer.emitModeChanged('viewer');          // the handoff's park
      await store.openDocument(BELT_ID);
    });
    await modeOf(BELT_ID, 'editor');
    // Nothing ever recorded `viewer` — not for the document, not for anyone.
    const all = await loadDocumentModes();
    expect([...all.values()].map(r => r.mode)).not.toContain('viewer');
  });
});

describe('a new identity without a load', () => {
  it('Save-as records the COPY', async () => {
    await store.openDocument(BELT_ID);
    await modeOf(BELT_ID, 'hmi');
    viewer.modes.activeMode = 'planner';

    const copyId = await store.saveAs('Belt copy');

    await modeOf(copyId, 'planner');
  });

  it('the first save of a draft places a document and records it', async () => {
    // Foreign content (a source, not a document): no identity until the save
    // plans one — the `plannedName` branch of `_saveIntoDocument`.
    await store.openBuiltin('/models/Foreign.glb', 'Foreign', { updateUrl: false });
    expect(store.openDocumentId).toBeNull();
    viewer.modes.activeMode = 'des';

    await store.save();

    const placed = store.openDocumentId;
    expect(placed).toBeTruthy();
    await modeOf(placed!, 'des');
  });
});

describe('kiosk and demo', () => {
  it('a kiosk records nothing, by open or by switch', async () => {
    setup('hmi', 'hmi');
    track();
    await store.openDocument(BELT_ID);
    viewer.emitModeChanged('planner');
    // Give a stray write every chance to land before asserting its absence.
    await readDocumentMode('browser', PROJECT_ID, BELT_ID);
    await new Promise(r => setTimeout(r, 50));
    expect((await loadDocumentModes()).size).toBe(0);
  });

  it('a demo records nothing and a project opened as a demo loses its entries', async () => {
    await setDocumentMode('browser', PROJECT_ID, BELT_ID, 'editor');
    await setDocumentMode('browser', PROJECT_ID, CELL_ID, 'planner');
    // The same project, now open AS a demo.
    const privates = getProjectStore() as unknown as { _project: { kind?: string } };
    privates._project = { ...privates._project, kind: 'demo' };
    track();

    await store.openDocument(BELT_ID);
    viewer.emitModeChanged('des');

    await vi.waitFor(async () => { expect((await loadDocumentModes()).size).toBe(0); });
    await new Promise(r => setTimeout(r, 50));
    expect((await loadDocumentModes()).size).toBe(0);
  });
});
