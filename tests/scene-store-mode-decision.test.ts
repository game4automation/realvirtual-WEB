// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-513 §9.4 — `SceneStore.openDocument` applies the row's declared mode
 * unless the caller says it decided the mode itself (`modeDecidedByCaller`).
 *
 * The direct paths — `?doc=` in main.ts, MCP `web_document_open`, the CONNECT
 * embed — never go through the dashboard's chain and must behave exactly as
 * before, even with a contradicting last mode on record (F12). The behaviour
 * is pinned on the SceneStore itself, and a source guard pins that none of
 * those callers opts in.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import MAIN_SOURCE from '../src/main.ts?raw';
import MCP_PROJECT_TOOLS_SOURCE from '../src/plugins/mcp-bridge/rv-mcp-project-tools.ts?raw';
import CONNECT_EMBED_SOURCE from '../src/plugins/connect-embed/connect-embed-actions.ts?raw';

vi.mock('../src/core/hmi/scene/rv-scene-glb-io', () => ({
  readSceneGlbBody: vi.fn(async () => null),
  writeSceneGlbBody: vi.fn(async () => ({ revision: 'rev1', target: 'opfs' as const })),
  dropSceneGlbBody: vi.fn(async () => {}),
  sceneGlbBodyRevision: vi.fn(async () => null),
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
import { __resetRecentsSnapshot } from '../src/core/project/rv-project-recents-store';
import {
  DOCUMENT_MODES_DB_NAME, __closeDocumentModesDb, setDocumentMode,
} from '../src/core/project/rv-document-mode-store';
import { installFakeDocumentProject, type FakeDocumentProject } from './helpers/fake-document-project';

const PROJECT_ID = 'prj_mode_decision';
const DOC_ID = 'doc_planner';

function makeViewer() {
  const setMode = vi.fn((id: string) => { v.modes.activeMode = id; });
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
    modes: { has: () => true, setMode, activeMode: 'hmi' as string | null, lockedMode: null },
    getPlugin: () => undefined,
    loadScene: async (s: RvScene) => { v.loaded.push(s); v.currentScene = s; },
    loadEmptyScene: async () => { v.currentScene = null; },
    on: () => () => {},
  };
  return v;
}

let project: FakeDocumentProject;
let viewer: ReturnType<typeof makeViewer>;
let store: SceneStore;
let urlBefore: string;

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
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () => new Response(new ArrayBuffer(8), { status: 200 }),
  );
  project = installFakeDocumentProject({
    id: PROJECT_ID,
    documents: [
      { id: DOC_ID, path: 'models/Line.glb', name: 'Line', section: 'models', mode: 'planner' },
    ],
  });
  viewer = makeViewer();
  store = new SceneStore(viewer as unknown as ConstructorParameters<typeof SceneStore>[0]);
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

describe('SceneStore.openDocument — who decides the mode', () => {
  it('without the option the row\'s mode is applied, even with a contradicting last mode on record (F12)', async () => {
    await setDocumentMode('browser', PROJECT_ID, DOC_ID, 'editor');
    await store.openDocument(DOC_ID);
    expect(viewer.modes.setMode).toHaveBeenCalledTimes(1);
    expect(viewer.modes.setMode).toHaveBeenCalledWith('planner');
    expect(viewer.modes.activeMode).toBe('planner');
  });

  it('with modeDecidedByCaller the mode is left alone', async () => {
    await store.openDocument(DOC_ID, { modeDecidedByCaller: true });
    expect(viewer.modes.setMode).not.toHaveBeenCalled();
    expect(viewer.modes.activeMode).toBe('hmi');
  });

  it('openScene forwards the option', async () => {
    await store.openScene(DOC_ID, { modeDecidedByCaller: true });
    expect(viewer.modes.setMode).not.toHaveBeenCalled();
    await store.openScene(DOC_ID);
    expect(viewer.modes.setMode).toHaveBeenCalledWith('planner');
  });
});

describe('the direct paths do not opt in (F12)', () => {
  it('main.ts: the ?doc= route opens without the option', () => {
    const route = MAIN_SOURCE.slice(MAIN_SOURCE.indexOf('await sceneStore.openDocument(urlDoc'));
    expect(route.slice(0, route.indexOf(';'))).toBe('await sceneStore.openDocument(urlDoc)');
    // The only opt-in in main.ts is the remembered-pair resume (F9).
    expect(MAIN_SOURCE.match(/modeDecidedByCaller/g)).toHaveLength(1);
  });

  it('MCP project tools and the CONNECT embed never set it', () => {
    expect(MCP_PROJECT_TOOLS_SOURCE).toContain('store.openDocument(doc.id)');
    expect(MCP_PROJECT_TOOLS_SOURCE).not.toContain('modeDecidedByCaller');
    expect(CONNECT_EMBED_SOURCE).toContain('scenes.openDocument(documentId');
    expect(CONNECT_EMBED_SOURCE).not.toContain('modeDecidedByCaller');
  });
});
