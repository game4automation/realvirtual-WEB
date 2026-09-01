// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-716 Phase 0 — the characterisation net for the FOUR open paths.
 *
 * ## What this file is, and what it deliberately is not
 *
 * It is a BASELINE, not a specification. Every assertion below records what the
 * four open paths do **today**, on main, before the GLB-only document model
 * collapses them into `openDocument()`. §9.3 diffs the Phase-3 behaviour against
 * exactly these statements; a line that changes there has to be justified in the
 * plan, and a line that changes by accident is the regression this file exists
 * to make loud.
 *
 * The four paths (plan-716 §2.5, R1-A2):
 *
 * | path | today | after plan-716 |
 * |---|---|---|
 * | `openScene(id)` | scene catalogue row + id-keyed OPFS body | thin forward to `openDocument` |
 * | `openBuiltin(url, label)` | fresh draft over a base URL — bundled demo **and** the `rvproject:` sentinel | thin forward |
 * | boot with no project | ~~bundled backend~~ → **"My Workspace"** (re-pinned, Phase 1) | unchanged from here on |
 * | `openTransient(scene)` | foreign content, writes nothing | **UNCHANGED in every phase** |
 *
 * ## Why the assertions are about STATE and KEYS, not internals
 *
 * The plan deletes `_save()`'s row path, the three backends' `listScenes()`,
 * `mergeSceneTiers`, `TieredSceneEntry` and the `scn_` minting. Pinning any of
 * those would pin the thing being removed, and the net would have to be rewritten
 * with the change it is supposed to police. So what is pinned is what an outside
 * observer can see and what plan-716 promises to preserve or to translate:
 * the snapshot the UI renders, the identity published to the cross-mode handle,
 * the `?scene=` value in the address bar, the localStorage pointer, and the
 * **body slot name** the autosave writes (the three draft forms of §2.3e — the
 * migration has to move exactly these strings).
 *
 * ## Why the GLB io and the bake are mocked
 *
 * Same reason as `rv-scene-transient.test.ts`: since plan-397 the autosave is a
 * GLB body written through `rv-scene-glb-io`, so a test watching only
 * localStorage would declare the transient seam correct while the real
 * persistence path ran underneath it. Mocking the io module turns "which slot
 * was written" into a recorded argument — which is precisely the fact §2.3e
 * needs. The bake is mocked because the bytes are irrelevant here, and
 * `rv-scene-executors` because this file is about routing and persistence, not
 * about what an op does to a scene graph.
 *
 * The filesystem seams are mocked to `null` so the projectless boot pin is
 * deterministic: browser-mode vitest shares one origin across test files, and a
 * workspace handle another file granted would otherwise resolve a folder project
 * here and turn the bundled fallback into a flake.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  /** Slot name → bytes, as the OPFS/project body store would answer. */
  bodies: new Map<string, Uint8Array>(),
  /** Every body write, in order — the §2.3e slot-name pin. */
  writes: [] as { slot: string; name: string }[],
  revision: 0,
}));

vi.mock('../src/core/hmi/scene/rv-scene-glb-io', () => ({
  readSceneGlbBody: vi.fn(async (sceneId: string) => {
    const glb = h.bodies.get(sceneId);
    return glb ? { glb, revision: `rev-${sceneId}`, target: 'opfs' as const } : null;
  }),
  writeSceneGlbBody: vi.fn(async (write: { sceneId: string; name: string }) => {
    h.writes.push({ slot: write.sceneId, name: write.name });
    return { revision: `rev${++h.revision}`, target: 'opfs' as const };
  }),
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

vi.mock('../src/core/engine/rv-local-filesystem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/engine/rv-local-filesystem')>();
  return { ...actual, getFolderHandle: async () => null, putHandle: async () => {} };
});

vi.mock('../src/core/project/rv-project-workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/project/rv-project-workspace')>();
  return { ...actual, getWorkspaceHandle: async () => null };
});

import { SceneStore } from '../src/core/hmi/scene/scene-store';
import { initSceneStore, getSceneStore } from '../src/core/hmi/scene/scene-store-singleton';
import {
  makeDraftScene,
  baseKeyOf,
  type RvScene,
  type SceneBase,
} from '../src/core/hmi/scene/rv-scene-types';
import {
  readActiveId,
  writeScene,
  listMetas,
  clearAllScenes,
  setDraftScope,
} from '../src/core/hmi/scene/rv-scene-storage';
import { getOpenDocumentBase, setOpenDocumentBase } from '../src/core/editor/active-asset-store';
import {
  LS_KEY_LAST_PROJECT,
  ProjectStore,
  getProjectStore,
  resetProjectStore,
} from '../src/core/project/project-store';
import { BundledBackend, SAMPLE_PROJECT_ID } from '../src/core/project/backends/bundled-backend';
import {
  WORKSPACE_DEFAULT_PROJECT_ID,
  WORKSPACE_DEFAULT_PROJECT_NAME,
} from '../src/core/project/rv-workspace-default';
import { clearSceneMutationListeners } from '../src/core/hmi/scene/rv-scene-mutations';
import { projectAssetUrl } from '../src/core/project/rv-project-asset-source';
import { escalateSharedGlb } from '../src/core/share/rv-share-escalate';
import { buildSharedGlbInfo } from '../src/core/share/rv-share-meta';
import type { RvScenePrimitiveOp } from '../src/core/ops/rv-unified-ops';
import { legacySceneId } from './helpers/legacy-scene-id';

// ─── Harness ────────────────────────────────────────────────────────────

const DEMO_URL = '/models/Demo.glb';
const DEMO_BASE: SceneBase = { kind: 'builtin', url: DEMO_URL, label: 'Demo' };

interface FakeViewer {
  loadScene: (s: RvScene) => Promise<void>;
  loadEmptyScene: () => Promise<void>;
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
  loadOpts: unknown[];
  failNextLoad: boolean;
}

function makeViewer(): FakeViewer {
  const v: FakeViewer = {
    loaded: [],
    loadOpts: [],
    failNextLoad: false,
    availableModels: [{ url: DEMO_URL, label: 'Demo' }],
    availablePublishedScenes: [],
    currentScene: null,
    currentModelUrl: DEMO_URL,
    // Null on purpose: `_adoptFromLoadedGlb` returns immediately without a
    // model root, and adoption is another plan's seam.
    currentModelRoot: null,
    registry: { getGltfNodeNames: () => [], getGltfNodeIndex: () => -1 },
    lastLoadResult: null,
    modes: { has: () => true, setMode: vi.fn() },
    loadScene: vi.fn(async (s: RvScene, _mode?: unknown, opts?: unknown) => {
      if (v.failNextLoad) { v.failNextLoad = false; throw new Error('that GLB could not be parsed'); }
      v.loaded.push(s);
      v.loadOpts.push(opts ?? null);
      v.currentScene = s;
    }),
    loadEmptyScene: vi.fn(async () => { v.currentScene = null; }),
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

/** The `?scene=` value currently in the address bar, or null. */
function urlSceneParam(): string | null {
  return new URLSearchParams(window.location.search).get('scene');
}

/**
 * EVERY localStorage key/value, not a hand-picked three.
 *
 * The transient pin has to be byte-identical (plan-716 §9.3), and a fingerprint
 * of three known keys would pass for a store that wrote a fourth.
 */
function fullStorage(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    out[k] = localStorage.getItem(k) ?? '';
  }
  return out;
}

/** Let the 2 s debounced autosave fire and its dynamic-import chain settle. */
async function letAutosaveRun(): Promise<void> {
  await vi.advanceTimersByTimeAsync(2500);
  for (let i = 0; i < 25; i++) await vi.advanceTimersByTimeAsync(1);
}

let viewer: FakeViewer;
let store: SceneStore;
let urlBefore: string;

beforeEach(() => {
  urlBefore = window.location.href;
  localStorage.clear();
  clearSceneMutationListeners();
  clearAllScenes();
  setDraftScope(null);
  setOpenDocumentBase(null);
  resetProjectStore();
  h.bodies.clear();
  h.writes.length = 0;
  h.revision = 0;
  // `_ensureBaseBytes` fetches the base GLB before it can bake. The bytes do not
  // matter — the bake is mocked — but the fetch has to succeed or every
  // persistence assertion would pass for the wrong reason.
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
  setOpenDocumentBase(null);
  clearSceneMutationListeners();
  clearAllScenes();
  setDraftScope(null);
  resetProjectStore();
  window.history.replaceState(window.history.state, '', urlBefore);
});

// ─── Path 1: openScene — the scene-catalogue path ───────────────────────

describe('plan-716 Phase 0 — openScene (scene catalogue)', () => {
  it('openScene_UnknownId_ThrowsNamed', async () => {
    // The sentence, not just the rejection: `openDocument` inherits this seam
    // and the dashboard/MCP callers match on it.
    await expect(store.openScene('scn_nope')).rejects.toThrow('Scene scn_nope not found');
  });

  it('openScene_CatalogueRow_BecomesTheSavedDocument', async () => {
    const seeded = writeScene({ ...makeDraftScene(DEMO_BASE, 'Cell 7'), id: legacySceneId() });

    await store.openScene(seeded.id);

    const snap = store.getSnapshot();
    expect(snap.saved?.id).toBe(seeded.id);
    expect(snap.saved?.name).toBe('Cell 7');
    expect(snap.isDraft).toBe(false);
    expect(snap.dirty).toBe(false);
    expect(snap.transient).toBe(false);
    expect(viewer.loaded).toHaveLength(1);
  });

  it('openScene_WritesTheActivePointerAndTheSceneUrlParam', async () => {
    const seeded = writeScene({ ...makeDraftScene(DEMO_BASE, 'Cell 7'), id: legacySceneId() });

    await store.openScene(seeded.id);

    // Two identity surfaces the alias map has to keep working (§2.4, F4):
    // the localStorage pointer read by `readActiveId()` on the next boot …
    expect(readActiveId()).toBe(seeded.id);
    expect(localStorage.getItem('rv-scenes/active')).toBe(JSON.stringify({ id: seeded.id }));
    // … and the address bar, which carries the RAW scene id (not `builtin:`).
    expect(urlSceneParam()).toBe(seeded.id);
    expect(seeded.id.startsWith('scn_')).toBe(true);
  });

  it('openScene_GlbBasedRow_PublishesASceneDocumentIdentity', async () => {
    // The identity plan-716 Phase 4 collapses into the single `document` kind.
    // A `scene-glb` base is the shape a saved scene collapses to after its
    // first bake, so this is the normal steady state of a saved scene.
    const id = legacySceneId();
    const base: SceneBase = { kind: 'scene-glb', sceneId: id, label: 'Baked' };
    h.bodies.set(id, new Uint8Array([1, 2, 3, 4]));
    writeScene({ ...makeDraftScene(base, 'Baked'), id });

    await store.openScene(id);

    // plan-716 Phase 4 collapsed the kind (§2.6). The identity is the same
    // fact — same id, same name, same two writers agreeing — under the one
    // name owned content has now; `path` is `''` because this document is
    // addressed by id through the body slot.
    expect(store.documentIdentity()).toEqual({
      kind: 'document', documentId: id, path: '', name: 'Baked',
    });
    expect(getOpenDocumentBase()).toEqual({
      kind: 'document', documentId: id, path: '', name: 'Baked',
    });
  });

  it('openScene_BuiltinBasedRow_PublishesTheBuiltinModelIdentityInstead', async () => {
    // Characterisation, not endorsement: a saved row whose base is still a
    // built-in URL answers `builtinModel`, NOT `sceneDocument` — the narrow
    // condition in `_loadIntoWorkspace` keys on `base.kind === 'scene-glb'`.
    // Phase 4 has to decide what the one `document` kind answers here.
    const seeded = writeScene({ ...makeDraftScene(DEMO_BASE, 'Unbaked'), id: legacySceneId() });

    await store.openScene(seeded.id);

    expect(store.documentIdentity()).toEqual({
      kind: 'builtinModel', url: DEMO_URL, name: 'Unbaked',
    });
  });

  it('openScene_AutosaveWritesTheIdKeyedDraftSlot', async () => {
    // Draft "Form C" of §2.3e — `draft/<scn_id>`. The migration renames exactly
    // this string to `draft/<documentId>`, so the string is the pin.
    const seeded = writeScene({ ...makeDraftScene(DEMO_BASE, 'Cell 7'), id: legacySceneId() });
    await store.openScene(seeded.id);

    await store.applyOp(anOp());
    await letAutosaveRun();

    expect(h.writes.map(w => w.slot)).toEqual([`draft/${seeded.id}`]);
  });
});

// ─── Path 2: openBuiltin — bundled demo and the rvproject: sentinel ─────

describe('plan-716 Phase 0 — openBuiltin (bundled demo)', () => {
  it('openBuiltin_FreshDraftOverTheBase', async () => {
    await store.openBuiltin(DEMO_URL, 'Demo');

    const snap = store.getSnapshot();
    expect(snap.draft?.base).toEqual(DEMO_BASE);
    expect(snap.saved).toBeNull();
    expect(snap.isDraft).toBe(true);
    expect(snap.dirty).toBe(false);
    expect(snap.transient).toBe(false);
  });

  it('openBuiltin_ClearsTheActivePointerAndWritesBuiltinFilenameUrl', async () => {
    // Pre-fill: "cleared" and "never written" are different facts, and only a
    // pre-filled pointer can tell them apart.
    const seeded = writeScene({ ...makeDraftScene(DEMO_BASE, 'Mine'), id: legacySceneId() });
    await store.openScene(seeded.id);
    expect(readActiveId()).toBe(seeded.id);

    await store.openBuiltin(DEMO_URL, 'Demo');

    // A draft owns no scene id, so the pointer is CLEARED — today's documented
    // behaviour of the non-transient path.
    expect(readActiveId()).toBeNull();
    // The url value is the FILENAME form main.ts's boot matcher compares
    // against `entries`, never the full path.
    expect(urlSceneParam()).toBe('builtin:Demo.glb');
  });

  it('openBuiltin_UpdateUrlFalse_LeavesTheAddressBarAlone', async () => {
    // The boot path's option: a bare `/` must stay a bare `/`.
    const before = window.location.search;
    await store.openBuiltin(DEMO_URL, 'Demo', { updateUrl: false });
    expect(window.location.search).toBe(before);
  });

  it('openBuiltin_PublishesTheBuiltinModelIdentity', async () => {
    await store.openBuiltin(DEMO_URL, 'Demo');
    expect(store.documentIdentity()).toEqual({ kind: 'builtinModel', url: DEMO_URL, name: 'Demo' });
    expect(getOpenDocumentBase()).toEqual({ kind: 'builtinModel', url: DEMO_URL, name: 'Demo' });
  });

  it('openBuiltin_AutosaveWritesTheBaseKeyedDraftSlot', async () => {
    // Draft "Form B" of §2.3e — `draft/<baseKey>`, the slot an UNSAVED
    // workspace owns. `baseKeyOf` is asserted alongside the literal so a change
    // to either side is visible.
    await store.openBuiltin(DEMO_URL, 'Demo');

    await store.applyOp(anOp());
    await letAutosaveRun();

    expect(baseKeyOf(DEMO_BASE)).toBe('builtin:%2Fmodels%2FDemo.glb');
    expect(h.writes.map(w => w.slot)).toEqual(['draft/builtin:%2Fmodels%2FDemo.glb']);
  });

  it('openEmpty_ForwardsToTheEmptyBaseAndTheEmptyUrlValue', async () => {
    // `openEmpty` is the third thing `openDocument` absorbs (F5); pinned here
    // because it shares `openBuiltin`'s draft mechanics exactly.
    await store.openEmpty();

    expect(store.getSnapshot().draft?.base).toEqual({ kind: 'empty' });
    expect(urlSceneParam()).toBe('empty');
    expect(readActiveId()).toBeNull();
    expect(baseKeyOf({ kind: 'empty' })).toBe('empty');
  });
});

describe('plan-716 Phase 0 — openBuiltin (rvproject: project asset)', () => {
  const REL = 'models/Belt.glb';
  const SENTINEL = projectAssetUrl(REL);

  it('the sentinel is the literal the SceneBase carries', () => {
    expect(SENTINEL).toBe('rvproject:models/Belt.glb');
  });

  it('rvproject_ResolvesBytesThroughTheProjectStoreAndKeepsTheSentinelAsIdentity', async () => {
    const bytes = new ArrayBuffer(8);
    const spy = vi.spyOn(getProjectStore(), 'resolveAssetSource')
      .mockResolvedValue({ kind: 'bytes', bytes });

    await store.openBuiltin(SENTINEL, 'Belt');

    // Re-resolved on EVERY load by relative path — that is what makes discard,
    // draft restore and reload work on the same base instead of a dead blob URL.
    expect(spy).toHaveBeenCalledWith(REL);
    expect(viewer.loadOpts[0]).toEqual({ identityUrl: SENTINEL, data: bytes });
    expect(store.getSnapshot().draft?.base).toEqual({ kind: 'builtin', url: SENTINEL, label: 'Belt' });
  });

  it('rvproject_DropsTheSceneUrlParamEntirely', async () => {
    vi.spyOn(getProjectStore(), 'resolveAssetSource')
      .mockResolvedValue({ kind: 'bytes', bytes: new ArrayBuffer(8) });
    // Something to remove, so "deleted" is distinguishable from "never set".
    await store.openBuiltin(DEMO_URL, 'Demo');
    expect(urlSceneParam()).toBe('builtin:Demo.glb');

    await store.openBuiltin(SENTINEL, 'Belt');

    // A bytes-source URL has no address a reload could be pointed at, so the
    // parameter is dropped rather than written as a dead value.
    expect(urlSceneParam()).toBeNull();
  });

  it('rvproject_PublishesNoCrossModeIdentity', async () => {
    vi.spyOn(getProjectStore(), 'resolveAssetSource')
      .mockResolvedValue({ kind: 'bytes', bytes: new ArrayBuffer(8) });

    await store.openBuiltin(SENTINEL, 'Belt');

    // Today a project asset opened through the SceneStore is anonymous to the
    // cross-mode handle: `isBytesSourceUrl` excludes it from `builtinModel` and
    // there is no saved id. The dashboard writes `projectDocument` after the
    // call returns — which is precisely the second identity Phase 4 collapses.
    expect(store.documentIdentity()).toBeNull();
    expect(getOpenDocumentBase()).toBeNull();
  });

  it('rvproject_UnreadableAsset_ThrowsNamedAndLoadsNothing', async () => {
    vi.spyOn(getProjectStore(), 'resolveAssetSource').mockResolvedValue(null);

    await expect(store.openBuiltin(SENTINEL, 'Belt'))
      .rejects.toThrow('"Belt" could not be read from this project.');
    expect(viewer.loaded).toHaveLength(0);
  });
});

// ─── Path 3: the projectless boot opens "My Workspace" ──────────────────

/**
 * plan-716 **Phase 1 — DELIBERATELY RE-PINNED** (§2.2 / F2).
 *
 * Phase 0 recorded the old truth here: a boot with no project fell through to
 * the read-only bundled demo, and `resolveActiveProject` had no `BrowserBackend`
 * branch at all. That is the hole Phase 1 fills, and re-pinning it is what this
 * characterisation file is FOR — the Phase-0 comments below say so in as many
 * words ("The Phase-1 diff is exactly this expectation flipping").
 *
 * Every other pin in this file is untouched. The two facts Phase 0 recorded
 * alongside the backend kind still hold and are still asserted: booting writes
 * no `rv-project/last` pointer, and it creates no scene rows.
 */
describe('plan-716 Phase 1 — boot with no project (My Workspace)', () => {
  function bundled(): BundledBackend {
    return new BundledBackend({
      models: [{ url: DEMO_URL, label: 'Demo' }],
      // `publishedScenes` is gone with the synthetic manifest (plan-735 3b).
      fetchImpl: (async () => (
        { ok: false, status: 404, json: async () => null } as unknown as Response
      )) as typeof fetch,
    });
  }

  it('boot_NoProject_ResolvesTheWritableWorkspaceProject', async () => {
    // RE-PINNED from `'bundled'` / `SAMPLE_PROJECT_ID` (Phase 1, §2.2).
    const ps = new ProjectStore();
    const resolved = await ps.resolveActiveProject({ bundledBackend: bundled() });

    expect(resolved.kind).toBe('browser');
    expect(resolved.backend.kind).toBe('browser');
    expect(resolved.project?.id).toBe(WORKSPACE_DEFAULT_PROJECT_ID);
    expect(resolved.project?.name).toBe(WORKSPACE_DEFAULT_PROJECT_NAME);
    expect(resolved.backend.writable).toBe(true);
    // UNCHANGED pin: read-only at this point in boot — `activate()` belongs to
    // `hydrateProjectScenes()`, after the store is attached. The new branch
    // writes nothing of its own here either.
    expect(resolved.backend.isActive).toBe(false);
    await ps.closeProject();
  });

  it('boot_NoProject_MintsTheBrowserWorkspaceProject', async () => {
    // The hole Phase 1 filled, inverted. Phase 0 asserted `not.toBe('browser')`
    // and explained that `resolveActiveProject` had no `BrowserBackend` branch
    // at all; §2.2 added exactly that branch, before the bundled fallback.
    const ps = new ProjectStore();
    const resolved = await ps.resolveActiveProject({ bundledBackend: bundled() });

    expect(resolved.backend.kind).toBe('browser');
    // UNCHANGED: an empty catalogue still yields no scenes, and booting still
    // records nothing as "the project to reopen" — that pointer is written for
    // folder projects only.
    expect(resolved.scenes).toEqual([]);
    expect(localStorage.getItem(LS_KEY_LAST_PROJECT)).toBeNull();
    await ps.closeProject();
  });

  it('boot_NoProject_ThreeRestartsAgreeAndCreateNothing', async () => {
    // The x3-restart pin, now against the workspace id (Risiko 7): the id is a
    // constant, so three boots address ONE project and no second home is minted.
    const ids: (string | undefined)[] = [];
    for (let i = 0; i < 3; i++) {
      const ps = new ProjectStore();
      const resolved = await ps.resolveActiveProject({ bundledBackend: bundled() });
      ids.push(resolved.project?.id);
      await ps.closeProject();
    }

    expect(ids).toEqual([
      WORKSPACE_DEFAULT_PROJECT_ID,
      WORKSPACE_DEFAULT_PROJECT_ID,
      WORKSPACE_DEFAULT_PROJECT_ID,
    ]);
    // UNCHANGED pins.
    expect(localStorage.getItem(LS_KEY_LAST_PROJECT)).toBeNull();
    // No document / scene rows appeared as a side effect of booting.
    expect(listMetas()).toEqual([]);
  });

  it('boot_ExplicitDeployProject_StillResolvesAsBundled', async () => {
    // F2's second half, and the reason the old pin above could be flipped
    // safely: the bundled tier did not go away, it stopped being the default.
    //
    // RE-SOURCED by plan-735. It used to point `bundled()` — a 404 deploy root —
    // at this and expect `prj_sample`, which was the SYNTHETIC manifest the
    // backend invented for a deploy that published nothing. There is no such
    // manifest now, so the fixture publishes one, which is what every real
    // channel does.
    const ps = new ProjectStore();
    const manifest = { schemaVersion: 2, id: 'prj_deploy', name: 'Deploy', documents: [] };
    const resolved = await ps.resolveActiveProject({
      workspaceDefault: false,
      bundledBackend: new BundledBackend({
        fetchImpl: (async (input: RequestInfo | URL) => (
          String(input).endsWith('project.json')
            ? { ok: true, status: 200, json: async () => manifest } as unknown as Response
            : { ok: false, status: 404, json: async () => null } as unknown as Response
        )) as typeof fetch,
      }),
    });

    expect(resolved.kind).toBe('bundled');
    expect(resolved.project?.id).toBe('prj_deploy');
    await ps.closeProject();
  });

  it('boot_NoProject_TheSceneStoreStillOpensTheBundledDemoBuiltin', async () => {
    // What the boot chain actually shows the user with no project and no
    // `?scene=`: the first built-in, opened WITHOUT rewriting the address bar.
    const ps = new ProjectStore();
    await ps.resolveActiveProject({ bundledBackend: bundled() });

    const before = window.location.search;
    await store.openBuiltin(DEMO_URL, 'Demo', { updateUrl: false });

    expect(store.getSnapshot().draft?.base).toEqual(DEMO_BASE);
    expect(window.location.search).toBe(before);
    expect(readActiveId()).toBeNull();
    await ps.closeProject();
  });
});

// ─── Path 4: openTransient — the pin that must never move ───────────────

/**
 * plan-716 pins this path BYTE-IDENTICAL (Entscheidungs-Log, F5, §9.3).
 *
 * A transient workspace is a SOURCE, not a document: it is not migrated, not
 * collapsed, and not routed through `openDocument`. Every phase of the plan has
 * to leave these assertions untouched — including §9.2's explicit requirement
 * that a transient session writes **no draft slots at all**.
 */
describe('plan-716 Phase 0 — openTransient (unchanged in every phase)', () => {
  const FOREIGN = 'https://files.example.test/cell.glb';
  const foreignScene = (name = 'Pick & Place Cell'): RvScene =>
    makeDraftScene({ kind: 'builtin', url: FOREIGN, label: name }, name);

  /** The visitor's own world, so "overwritten" is visible and not just "absent". */
  function givenTheVisitorHasWork(): Record<string, string> {
    const seeded = writeScene({ ...makeDraftScene(DEMO_BASE, 'Mine'), id: legacySceneId() });
    localStorage.setItem('rv-scenes/active', JSON.stringify({ id: seeded.id }));
    localStorage.setItem('rv-scenes/draft/empty', JSON.stringify({ marker: 'his own draft' }));
    return fullStorage();
  }

  it('transient_LeavesEveryLocalStorageKeyByteIdentical', async () => {
    const before = givenTheVisitorHasWork();

    await store.openTransient(foreignScene());

    expect(fullStorage()).toEqual(before);
    expect(store.isTransient()).toBe(true);
    expect(store.getSnapshot().transient).toBe(true);
  });

  it('transient_WritesNoDraftSlotEverAfterEditingAndWaiting', async () => {
    // §9.2's named pin. The migration's Draft-Form inventory (A/B/C) is
    // COMPLETE only if a transient session contributes none — this is the
    // assumption §2.3 rests on, asserted rather than assumed.
    const before = givenTheVisitorHasWork();
    await store.openTransient(foreignScene());

    for (let i = 0; i < 3; i++) {
      await store.applyOp(anOp());
      await letAutosaveRun();
    }

    expect(h.writes).toEqual([]);
    expect(fullStorage()).toEqual(before);
  });

  it('transient_DoesNotTouchTheUrlAndHasNoDocumentIdentity', async () => {
    const before = window.location.search;

    await store.openTransient(foreignScene());

    expect(window.location.search).toBe(before);
    expect(store.documentIdentity()).toBeNull();
  });

  it('transient_STILL_publishesTheCrossModeHandle (characterisation, not endorsement)', async () => {
    // A Phase-0 FINDING, recorded exactly as it behaves.
    //
    // `documentIdentity()` bails out on `transient`, but the
    // `setOpenDocumentBase(...)` block at the end of `_loadIntoWorkspace` does
    // NOT — it runs for every open, and a transient scene over an ordinary http
    // URL satisfies its `builtin && !isBytesSourceUrl` branch. So a shared link
    // DOES overwrite the process-global "what is on screen" handle with the
    // foreign file, while the visitor's own workspace is what the handle
    // described a moment earlier.
    //
    // Nothing is persisted, so the plan-386 F7 promise ("leaves no trace on the
    // visitor") holds for STORAGE — and the code comment beside the call says
    // exactly that. This handle is the one observable exception, and it matters
    // to plan-716 because Phase 4 collapses precisely these kinds: whoever
    // rewrites that block must decide deliberately whether the transient case
    // keeps publishing, rather than discovering it by accident.
    //
    // ── PHASE 4 DECIDED: it keeps publishing. This pin does not move. ─────
    //
    // The reasoning is in full beside the code (scene-store.ts,
    // `_loadIntoWorkspace`). In one line: what gets published here is a SOURCE
    // kind, which is exactly what plan-716's "sources are not documents"
    // doctrine says a transient open is showing — so the honest answer to
    // "what is on screen" is this, and guarding the block would instead
    // reintroduce the "editor opens Untitled over loaded content" defect the
    // block was written to fix.
    await store.openTransient(foreignScene());

    expect(getOpenDocumentBase()).toEqual({
      kind: 'builtinModel',
      url: FOREIGN,
      name: 'Pick & Place Cell',
    });
  });

  it('transient_NEVER_publishesADocumentKind (the plan-716 §2.6 doctrine, enforced)', async () => {
    // The invariant that makes the decision above safe rather than merely
    // convenient, asserted rather than argued: a transient open may publish a
    // SOURCE, and may never publish an owned `document`. `saved` is null on the
    // transient path, so the document branch of that block is unreachable — but
    // "unreachable by construction" is exactly the kind of claim that rots, and
    // a `document` published here would hand a visitor's editor a write target
    // for somebody else's file.
    for (const scene of [foreignScene(), foreignScene('Another')]) {
      await store.openTransient(scene);
      expect(getOpenDocumentBase()?.kind).not.toBe('document');
      expect(store.documentIdentity()).toBeNull();
    }
  });

  it('transient_OverABytesSourceBase_publishesNothing', async () => {
    // The other half of the same branch: a base whose URL carries bytes rather
    // than identity clears the handle. Pinned so the asymmetry above is
    // provably about `isBytesSourceUrl` and not about transience.
    await store.openTransient(makeDraftScene(
      { kind: 'builtin', url: 'blob:https://example.test/deadbeef', label: 'Blobbed' },
      'Blobbed',
    ));

    expect(getOpenDocumentBase()).toBeNull();
  });

  it('transient_RefusesAnIncomingOpLog', async () => {
    const scene = foreignScene();
    const withOps: RvScene = { ...scene, edits: { ...scene.edits, ops: [anOp()] } };

    await expect(store.openTransient(withOps))
      .rejects.toThrow(/transient scene carries no op log of its own/);
  });

  it('transient_FailedLoad_RestoresTheWorkspaceAndStorage', async () => {
    await store.openBuiltin(DEMO_URL, 'Demo');
    const nameBefore = store.getSnapshot().draft?.name;
    const storageBefore = fullStorage();

    viewer.failNextLoad = true;
    await expect(store.openTransient(foreignScene('Hostile'))).rejects.toThrow(/could not be parsed/);

    expect(store.getSnapshot().draft?.name).toBe(nameBefore);
    expect(store.isTransient()).toBe(false);
    expect(fullStorage()).toEqual(storageBefore);
  });

  it('transient_ThenNormalOpen_PersistenceComesBack', async () => {
    await store.openTransient(foreignScene());
    expect(store.isTransient()).toBe(true);

    await store.openBuiltin(DEMO_URL, 'Demo');
    await store.applyOp(anOp());
    await letAutosaveRun();

    expect(store.isTransient()).toBe(false);
    expect(h.writes.map(w => w.slot)).toEqual(['draft/builtin:%2Fmodels%2FDemo.glb']);
  });
});

/**
 * The real caller, through the module plan-716 names as the fourth open path.
 *
 * `rv-share-escalate.ts:171/175` are the two `openTransient()` call sites, and
 * the plan promises both stay untouched. Driving them end-to-end (rather than
 * calling `openTransient` directly) is what makes the promise checkable: a phase
 * that quietly re-routed the escalation through `openDocument` would still pass
 * the direct pins above.
 */
describe('plan-716 Phase 0 — rv-share-escalate reaches openTransient and persists nothing', () => {
  let escalateViewer: FakeViewer;

  beforeEach(() => {
    // The singleton has no reset by design; `initSceneStore` is idempotent, so
    // one store serves this block and is re-baselined per test.
    escalateViewer = makeViewer();
    initSceneStore(escalateViewer as unknown as Parameters<typeof initSceneStore>[0]);
  });

  it('escalate_SceneLevel_OpensTransientWithoutWritingAnything', async () => {
    const shared = getSceneStore()!;
    await shared.openBuiltin(DEMO_URL, 'Demo');      // the visitor's own work
    h.writes.length = 0;
    const before = fullStorage();

    const result = await escalateSharedGlb(buildSharedGlbInfo({
      url: 'https://files.example.test/plant.glb',
      userData: { rv_share: { v: 1, name: 'Plant', level: 'model' } },
    }));

    expect(result.kind).toBe('scene');
    expect(shared.isTransient()).toBe(true);
    expect(h.writes).toEqual([]);
    expect(fullStorage()).toEqual(before);
  });

  it('escalate_PlacementLevel_KeepsTheOpInMemoryOnly', async () => {
    const shared = getSceneStore()!;
    await shared.openBuiltin(DEMO_URL, 'Demo');
    h.writes.length = 0;
    const before = fullStorage();

    const result = await escalateSharedGlb(buildSharedGlbInfo({
      url: 'https://files.example.test/gripper.glb',
      userData: { rv_share: { v: 1, name: 'Gripper', level: 'component' } },
    }));

    expect(result.kind).toBe('placement');
    expect(result.placementId).toBeTruthy();
    // The op is a normal entry in the in-memory log — undoable, never written.
    expect(shared.getSnapshot().canUndo).toBe(true);
    await letAutosaveRun();
    expect(h.writes).toEqual([]);
    expect(fullStorage()).toEqual(before);
  });
});
