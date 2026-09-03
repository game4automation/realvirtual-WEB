// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Adopt-on-open — a GLB copied into an OPEN project is a savable document.
 *
 * Field finding (wmyb, 2026-09-02): a customer copy-pastes GLBs into their
 * project folder through the file explorer while the viewer is running. The
 * file shows up (a folder listing derives a card for every asset on disk) and
 * opens fine, but the workspace has no manifest row behind it — so the later
 * save runs with `expectedRevision: null` ("this is new") and fails its own
 * precondition against the very file it came from:
 * `"models/Machine.glb" already exists — expected it to be new.`
 *
 * The fix is one recovery in the open path (`_documentRowOrAdopt`): when the
 * id resolves to no manifest row, run `rescanDocuments()` once — which runs
 * the plan-717 adopt verb and writes the row — and retry. It works because
 * both the derived listing id and the adopt-minted id are
 * `stableDocumentId(path)`, so the id that just missed is the id the adopt
 * creates.
 *
 * Harness is the `open-save-document.test.ts` one: the fake document project
 * with a REAL CAS, plus a `statDocuments()` patch so the adopt scan can see
 * the copied file (the stock fake reports no stats at all).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  bodies: new Map<string, Uint8Array>(),
}));

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
import { clearAllScenes, setDraftScope } from '../src/core/hmi/scene/rv-scene-storage';
import { clearSceneMutationListeners } from '../src/core/hmi/scene/rv-scene-mutations';
import { setOpenDocumentBase } from '../src/core/editor/active-asset-store';
import { resetProjectStore } from '../src/core/project/project-store';
import { stableDocumentId, type DocumentStat } from '../src/core/project/rv-project-documents';
import { clearAllDocumentAliases } from '../src/core/project/rv-doc-alias';
import type { RvScenePrimitiveOp } from '../src/core/ops/rv-unified-ops';
import {
  installFakeDocumentProject,
  fakeGlb,
  type FakeDocumentProject,
} from './helpers/fake-document-project';

// ─── Harness ────────────────────────────────────────────────────────────

const BELT_PATH = 'scenes/Belt.glb';
const BELT_ID = 'doc_belt';
/** The file the customer copies in — bytes on disk, no manifest row. */
const COPIED_PATH = 'models/Machine.glb';

function makeViewer() {
  const v = {
    loaded: [] as unknown[],
    availableModels: [],
    availablePublishedScenes: [],
    currentScene: null as unknown,
    currentModelUrl: null as string | null,
    currentModelRoot: null as unknown,
    registry: {
      getGltfNodeNames: () => [], getGltfNodeIndex: () => -1,
      getPathForNode: () => null, getNode: () => null,
    },
    lastLoadResult: null,
    modes: { has: () => true, setMode: () => {} },
    getPlugin: () => undefined,
    loadScene: async (s: unknown) => { v.loaded.push(s); v.currentScene = s; },
    loadEmptyScene: async () => { v.currentScene = null; },
  };
  return v;
}

function anOp(value = 42): RvScenePrimitiveOp {
  return {
    id: `op_${value}_${Math.random().toString(36).slice(2)}`,
    ts: Date.now(), schemaV: 1, kind: 'setField',
    nodePath: 'Conv1', componentType: 'Drive', fieldName: 'TargetSpeed',
    value, prev: 0,
  } as RvScenePrimitiveOp;
}

/**
 * Make the fake backend's scan see its own files — the stock fixture answers
 * `statDocuments: []`, which the adopt verb reads as "the scan learnt
 * nothing". With this patch the fixture behaves like a folder backend whose
 * disk holds exactly `fixture.files`.
 */
function statFromFiles(fixture: FakeDocumentProject): void {
  (fixture.backend as unknown as { statDocuments(): Promise<DocumentStat[]> })
    .statDocuments = async () =>
      [...fixture.files.entries()].map(([path, bytes]) => ({ path, size: bytes.byteLength }));
}

let project: FakeDocumentProject;
let store: SceneStore;
let urlBefore: string;

beforeEach(() => {
  urlBefore = window.location.href;
  localStorage.clear();
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
    documents: [{ id: BELT_ID, path: BELT_PATH, name: 'Belt', section: 'scenes' }],
    files: { [COPIED_PATH]: fakeGlb('Machine') },
  });
  statFromFiles(project);
  store = new SceneStore(makeViewer() as unknown as ConstructorParameters<typeof SceneStore>[0]);
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
  window.history.replaceState(window.history.state, '', urlBefore);
});

// ─── Adopt-on-open ──────────────────────────────────────────────────────

describe('adopt-on-open — a file copied into the open project', () => {
  const copiedId = stableDocumentId(COPIED_PATH);

  it('openScene of the derived id adopts a row and binds the document', async () => {
    // Before the open, the manifest knows nothing about the copied file.
    expect(project.documents().some(d => d.path === COPIED_PATH)).toBe(false);

    await store.openScene(copiedId);

    // The adopt verb wrote a real row — same id the derived card carried.
    const row = project.documents().find(d => d.path === COPIED_PATH);
    expect(row).toBeDefined();
    expect(row!.id).toBe(copiedId);
    // The workspace is BOUND to it, which is what the save needs.
    expect(store.documentIdentity()).toMatchObject({
      kind: 'document', documentId: copiedId, path: COPIED_PATH,
    });
  });

  it('the save after such an open writes in place instead of "expected it to be new"', async () => {
    await store.openScene(copiedId);
    await store.applyOp(anOp(100));

    expect(await store.save()).toBe('saved');

    // In place, to the copied file's own path — not a fork, not a conflict.
    expect(project.writes.map(w => w.relPath)).toEqual([COPIED_PATH]);
    // The precondition was the file's real revision, never null-for-new.
    expect(project.writes[0].expected).not.toBeNull();
  });

  it('openDocument recovers the same way — every open route shares the rescue', async () => {
    await store.openDocument(copiedId);
    expect(project.documents().some(d => d.id === copiedId)).toBe(true);
  });

  it('a genuinely unknown id still throws after the one rescan', async () => {
    await expect(store.openDocument('doc_nope')).rejects.toThrow('Document doc_nope not found');
    // The rescan it triggered adopted the copied file as a side effect — that
    // is fine and deliberate; what matters is that no phantom row appeared for
    // the missing id.
    expect(project.documents().some(d => d.id === 'doc_nope')).toBe(false);
  });
});
