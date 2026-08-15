// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-702 Phase 3 — the OPEN FUNNEL writes the project's resume pair.
 *
 * ## What was broken, and why a storage unit test could not see it
 *
 * `rememberSession` / `readRememberedSession` were already correct and already
 * tested (`project-open-and-resume.test.ts` — key, encoding, per-project
 * isolation, `forgetRememberedSession`). Every one of those tests passed while
 * the feature was dead in the product, because they call the writer directly.
 * In the running app the writer was called from exactly two places in
 * `ProjectsDashboardHost`, so the pair existed only if the user had opened the
 * document by clicking that particular list — and not after a Save, not on the
 * `?doc=` route, not from an MCP opener, not from the boot resume. `main.ts`
 * then found nothing to resume and fell through to the demo model.
 *
 * So the assertions here are deliberately NOT about `rememberSession`. They are
 * about `SceneStore.openDocument` — the one verb every opening way funnels
 * through since plan-716 §2.5 — and about the two properties that make the fix
 * a fix rather than a third instrumented call site:
 *
 *  1. opening a document RECORDS the session, whichever forward got there;
 *  2. opening something that is NOT a document records nothing, so foreign and
 *     bundled content cannot claim to be the place this project resumes.
 *
 * Without the funnel write, block 1 fails: no key is written at all.
 *
 * The harness is `open-save-document.test.ts`'s, for the same reason it exists
 * there — a document open touches the body store, the bake and the executors,
 * none of which this file is about.
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
import { makeDraftScene, type RvScene } from '../src/core/hmi/scene/rv-scene-types';
import { clearAllScenes, setDraftScope } from '../src/core/hmi/scene/rv-scene-storage';
import { clearSceneMutationListeners } from '../src/core/hmi/scene/rv-scene-mutations';
import { setOpenDocumentBase } from '../src/core/editor/active-asset-store';
import { resetProjectStore } from '../src/core/project/project-store';
import { projectAssetUrl } from '../src/core/project/rv-project-asset-source';
import { writeDocumentAlias, clearAllDocumentAliases } from '../src/core/project/rv-doc-alias';
import { readRememberedSession } from '../src/core/project/rv-project-resume-store';
import {
  installFakeDocumentProject,
  type FakeDocumentProject,
} from './helpers/fake-document-project';

// ─── Harness ────────────────────────────────────────────────────────────

const PROJECT_ID = 'prj_resume_funnel';
const BELT_PATH = 'scenes/Belt.glb';
const BELT_ID = 'doc_belt';
const CELL_PATH = 'models/Cell.glb';
const CELL_ID = 'doc_cell';
const DEMO_URL = '/models/Demo.glb';
const FOREIGN_URL = 'https://files.example.test/somebody-elses.glb';

/** The remembered pair as the BOOT reads it — same key, same parser. */
function remembered(): { asset: string; mode?: string } | null {
  return readRememberedSession(PROJECT_ID);
}

/** The raw key, pinned: the boot in main.ts reads this string and no other. */
function rawPair(): string | null {
  return localStorage.getItem(`rv-project/resume/${PROJECT_ID}`);
}

/** Every resume key present, whichever project id it was keyed under. */
function resumeKeys(): string[] {
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)!;
    if (key.startsWith('rv-project/resume/')) out.push(key);
  }
  return out;
}

/**
 * `asset` is allowed to be the id OR the path — `resolveResumeTarget`'s
 * consumers match against both — so the test asserts what the boot asserts
 * instead of pinning one spelling the funnel is free to choose.
 */
function namesDocument(
  pair: { asset: string } | null,
  row: { id: string; path: string },
): boolean {
  return pair !== null && (pair.asset === row.id || pair.asset === row.path);
}

function makeViewer(activeMode: string | null = 'editor') {
  const v = {
    loaded: [] as RvScene[],
    availableModels: [{ url: DEMO_URL, label: 'Demo' }],
    availablePublishedScenes: [],
    currentScene: null as RvScene | null,
    currentModelUrl: null as string | null,
    currentModelRoot: null as unknown,
    registry: {
      getGltfNodeNames: () => [], getGltfNodeIndex: () => -1,
      getPathForNode: () => null, getNode: () => null,
    },
    lastLoadResult: null,
    modes: { has: () => true, setMode: () => {}, activeMode },
    getPlugin: () => undefined,
    loadScene: async (s: RvScene) => { v.loaded.push(s); v.currentScene = s; },
    loadEmptyScene: async () => { v.currentScene = null; },
  };
  return v;
}

function makeStore(activeMode: string | null = 'editor'): SceneStore {
  return new SceneStore(
    makeViewer(activeMode) as unknown as ConstructorParameters<typeof SceneStore>[0],
  );
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
    id: PROJECT_ID,
    documents: [
      { id: BELT_ID, path: BELT_PATH, name: 'Belt', section: 'scenes' },
      { id: CELL_ID, path: CELL_PATH, name: 'Cell', section: 'models' },
    ],
  });
  store = makeStore();
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
  window.history.replaceState(window.history.state, '', urlBefore);
});

// ─── The funnel records the session ─────────────────────────────────────

describe('plan-702 Phase 3 — openDocument records the resume pair', () => {
  it('writes the pair under the project id, naming the document', async () => {
    expect(rawPair()).toBeNull();

    await store.openDocument(BELT_ID);

    // The BOOT's own reader has to be able to see it — a value only this test
    // can decode would restore nothing.
    const pair = remembered();
    expect(pair).not.toBeNull();
    expect(namesDocument(pair, { id: BELT_ID, path: BELT_PATH })).toBe(true);
  });

  it('records the mode that is active, so the reload comes back in it', async () => {
    await store.openDocument(BELT_ID);
    expect(remembered()?.mode).toBe('editor');
  });

  it('a session with no active mode still records a usable pair', async () => {
    // `rememberedSessionOf` drops an empty mode and the boot then falls back to
    // the globally persisted one — a pair without a mode is valid, not broken.
    const modeless = makeStore(null);
    try {
      await modeless.openDocument(BELT_ID);
      const pair = remembered();
      expect(namesDocument(pair, { id: BELT_ID, path: BELT_PATH })).toBe(true);
      expect(pair?.mode).toBeUndefined();
    } finally {
      modeless.dispose();
    }
  });

  it('a viewer without a mode manager still OPENS — the hint never blocks', async () => {
    // Regression: reading the mode used to be an unguarded `modes.activeMode`,
    // which turned "record where to resume" into a throw for every harness and
    // embedding whose viewer has no mode manager — an open failing because of a
    // convenience. `rv-project-resume-store` states the rule the other way
    // round, and this pins it.
    const bare = new SceneStore({
      ...makeViewer(),
      modes: undefined,
    } as unknown as ConstructorParameters<typeof SceneStore>[0]);
    try {
      await bare.openDocument(BELT_ID);

      expect(bare.getSnapshot().draft?.name).toBe('Belt');
      const pair = remembered();
      expect(namesDocument(pair, { id: BELT_ID, path: BELT_PATH })).toBe(true);
      expect(pair?.mode).toBeUndefined();
    } finally {
      bare.dispose();
    }
  });

  it('the LAST open wins — a switch inside the session re-records', async () => {
    await store.openDocument(BELT_ID);
    await store.openDocument(CELL_ID);

    expect(namesDocument(remembered(), { id: CELL_ID, path: CELL_PATH })).toBe(true);
    expect(namesDocument(remembered(), { id: BELT_ID, path: BELT_PATH })).toBe(false);
  });
});

// ─── Every forward inherits it — that IS the fix ────────────────────────

describe('plan-702 Phase 3 — the forwards inherit the write', () => {
  it('openScene records it (the dashboard no longer has to)', async () => {
    await store.openScene(BELT_ID);
    expect(namesDocument(remembered(), { id: BELT_ID, path: BELT_PATH })).toBe(true);
  });

  it('an OLD scn_ id records it — the case the dashboard call MISSED', async () => {
    // The removed dashboard write looked the row up without alias tolerance, so
    // a migrated id wrote nothing at all. The funnel resolves the alias first.
    writeDocumentAlias('scn_legacy', BELT_ID);

    await store.openScene('scn_legacy');

    expect(namesDocument(remembered(), { id: BELT_ID, path: BELT_PATH })).toBe(true);
  });

  it('openBuiltin(rvproject:) records it — the Models-list route', async () => {
    await store.openBuiltin(projectAssetUrl(CELL_PATH), 'Cell');
    expect(namesDocument(remembered(), { id: CELL_ID, path: CELL_PATH })).toBe(true);
  });

  it('newEmpty records the document it just created', async () => {
    // The Save-shaped path: a document comes into existence and is opened in one
    // gesture, with no dashboard click anywhere near it.
    await store.newEmpty();

    const created = project.documents().find(d => d.id !== BELT_ID && d.id !== CELL_ID)!;
    expect(created).toBeDefined();
    expect(namesDocument(remembered(), created)).toBe(true);
  });
});

// ─── What must NOT be recorded ──────────────────────────────────────────

describe('plan-702 Phase 3 — non-documents record nothing', () => {
  it('a transient open leaves the pair untouched', async () => {
    // Somebody else's GLB behind a shared link. `openTransient` deliberately
    // does not forward onto `openDocument` (§2.5), and the pair must stay on the
    // user's own last document rather than on content that leaves no trace.
    await store.openDocument(BELT_ID);
    const before = rawPair();

    await store.openTransient(
      makeDraftScene({ kind: 'builtin', url: FOREIGN_URL, label: 'Shared cell' }, 'Shared cell'),
    );

    expect(store.isTransient()).toBe(true);
    expect(rawPair()).toBe(before);
  });

  it('a BUNDLED model writes no pair — a source is not a document', async () => {
    await store.openBuiltin(DEMO_URL, 'Demo');
    expect(rawPair()).toBeNull();
  });

  it('a failed open records nothing', async () => {
    await expect(store.openDocument('doc_nope')).rejects.toThrow();
    expect(rawPair()).toBeNull();
  });

  it('without a project there is nothing to key the pair on', async () => {
    project.restore();
    resetProjectStore();
    const orphan = makeStore();
    try {
      // No manifest, so no document either — the open cannot succeed, and the
      // point is that the store reaches that conclusion without writing a pair
      // under some substitute key.
      await expect(orphan.openDocument(BELT_ID)).rejects.toThrow();
      await orphan.openBuiltin(DEMO_URL, 'Demo');

      expect(resumeKeys()).toEqual([]);
    } finally {
      orphan.dispose();
    }
  });
});
