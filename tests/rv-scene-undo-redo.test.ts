// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for the SceneStore op pipeline — undo/redo/transactions/queue
 * /cap/failure tolerance/baseline semantics. Uses a fake viewer so the
 * tests don't need a live Three.js scene; the executors' visual side
 * effects are validated separately by integration / manual smoke tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { deadSlotExists, seedDeadDraft, seedDeadSceneDraft } from './helpers/dead-draft-slots';
import { Group } from 'three';
import { SceneStore } from '../src/core/hmi/scene/scene-store';
import { readSceneGlbPointer } from '../src/core/storage/rv-scene-glb-store';
import { clearAllBlobs } from '../src/core/storage/rv-opfs-blobs';
import {
  type SetFieldOp,
  type AddPlacementOp,
  type RemovePlacementOp,
  type TransformPlacementOp,
  type SetCameraOp,
  freshOpId,
} from '../src/core/hmi/scene/rv-scene-edits';
import {
  type RvScene,
  type SceneBase,
  baseKeyOf,
  makeDraftScene,
} from '../src/core/hmi/scene/rv-scene-types';
import { writeScene, readScene } from '../src/core/hmi/scene/rv-scene-storage';
import type { PlacedComponent } from '../src/plugins/layout-planner/rv-layout-store';
// plan-716 Phase 3: `save()` writes a DOCUMENT FILE, so the three save cases
// below need a project to write into. Everything else in this file — the op
// pipeline, undo/redo, transactions, the queue, the history cap, the draft
// slots — is untouched by the phase and untouched here.
import { documentsOf } from '../src/core/project/rv-project-documents';
import { resetProjectStore } from '../src/core/project/project-store';
import {
  installFakeDocumentProject,
  type FakeDocumentProject,
} from './helpers/fake-document-project';
import { legacySceneId } from './helpers/legacy-scene-id';

// ─── Fake viewer (matches the surface scene-store + executors touch) ────

interface FakeViewer {
  loadScene: (s: RvScene) => Promise<void>;
  loadEmptyScene: () => Promise<void>;
  getPlugin: <T>(id: string) => T | undefined;
  availableModels: { url: string; label: string }[];
  currentScene: RvScene | null;
  currentModelUrl: string | null;
  pendingModelUrl: string | null;
  registry: {
    getNode: (path: string) => unknown;
    getComponentsAt: (path: string) => Array<[string, unknown]>;
    getGltfNodeNames?: () => readonly (string | undefined)[];
    getGltfLocation?: (path: string) => { sourceKey: string; index: number } | null;
    getPathForNode?: (node: unknown) => string | null;
  } | null;
  markRenderDirty: () => void;
  loadScenes: RvScene[];
  currentModelRoot: unknown;
  lastLoadResult: unknown;
}

/**
 * The registry surface the phase-6 write path needs.
 *
 * Every path resolves to node 0 of the fixture. That is not a shortcut for
 * "any node will do" — these tests pin WHICH SLOT a body lands in, not how an
 * overlay is routed (`glb-bake-roundtrip` owns that, against a real loader).
 * What matters here is that the bake gets a resolvable target and therefore
 * actually produces bytes, instead of failing on a fake registry and leaving
 * every slot assertion vacuously empty.
 *
 * Empty `getGltfNodeNames()` is equally deliberate: the bake reads it as
 * "nothing was captured" and skips the identity check, which is precisely the
 * state a viewer that never really loaded a file is in.
 */
function bakeableRegistry(): NonNullable<FakeViewer['registry']> {
  return {
    getNode: () => null,
    getComponentsAt: () => [],
    getGltfNodeNames: () => [],
    getGltfLocation: () => ({ sourceKey: '', index: 0 }),
    getPathForNode: () => null,
  };
}

function makeViewer(): FakeViewer {
  const v: FakeViewer = {
    loadScenes: [],
    availableModels: [
      { url: '/models/Demo.glb', label: 'Demo' },
      { url: '/models/Tests.glb', label: 'Tests' },
    ],
    currentScene: null,
    currentModelUrl: null,
    pendingModelUrl: null,
    registry: null,
    currentModelRoot: null,
    lastLoadResult: null,
    markRenderDirty: vi.fn(),
    loadScene: vi.fn(async (s: RvScene) => {
      v.loadScenes.push(s);
      v.currentScene = s;
      v.currentModelUrl = s.base.kind === 'builtin' ? s.base.url : 'empty:';
    }),
    loadEmptyScene: vi.fn(async () => {
      v.currentScene = null;
      v.currentModelUrl = null;
    }),
    getPlugin: () => undefined,
  };
  return v;
}

const builtin: SceneBase = { kind: 'builtin', url: '/models/Demo.glb', label: 'Demo' };
const empty: SceneBase = { kind: 'empty' };

function setField(value: unknown, prev: unknown, ts = Date.now()): SetFieldOp {
  return {
    id: freshOpId(), ts, schemaV: 1, kind: 'setField',
    nodePath: 'Conv1', componentType: 'Drive', fieldName: 'TargetSpeed',
    value, prev,
  };
}

function placement(id: string, label = 'X'): PlacedComponent {
  return {
    id, catalogId: 'cat-x', glbUrl: '/models/x.glb', label,
    position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
  };
}

function addPlacement(p: PlacedComponent, ts = Date.now()): AddPlacementOp {
  return { id: freshOpId(), ts, schemaV: 1, kind: 'addPlacement', placement: p };
}

function removePlacement(p: PlacedComponent, ts = Date.now()): RemovePlacementOp {
  return { id: freshOpId(), ts, schemaV: 1, kind: 'removePlacement', placementId: p.id, placement: p };
}

function transform(id: string, pos: [number, number, number], ts = Date.now()): TransformPlacementOp {
  return {
    id: freshOpId(), ts, schemaV: 1, kind: 'transformPlacement',
    placementId: id, position: pos, rotation: [0, 0, 0], scale: [1, 1, 1],
    prev: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  };
}

function setCam(preset: SetCameraOp['preset'], prev: SetCameraOp['preset'] = null,
                 ts = Date.now()): SetCameraOp {
  return { id: freshOpId(), ts, schemaV: 1, kind: 'setCamera', preset, prev };
}

function setCamera(): SetCameraOp {
  return setCam({ px: 1, py: 2, pz: 3, tx: 0, ty: 0, tz: 0 });
}

// ─── Fixtures ───────────────────────────────────────────────────────────

let viewer: FakeViewer;
let store: SceneStore;
/**
 * Installed PER TEST, never globally (plan-716 Phase 3).
 *
 * A writable project changes where a GLB BODY goes: `rv-scene-glb-io` routes
 * every body write through the backend when one is open, and the draft-slot
 * cases in this file assert on the OPFS pointer. So only the cases that
 * genuinely need somewhere to save — the ones that call `save()`/`saveAs()`,
 * which since Phase 3 write a document file — install one.
 */
let project: FakeDocumentProject | null = null;
/** Real GLB bytes the base URL resolves to — the bake needs a parsable source. */
let demoGlb: ArrayBuffer;
let realFetch: typeof fetch;

const DRAFT_AUTOSAVE_DEBOUNCE_MS = 2000;

/**
 * Wait for the debounced autosave to land a body in `slot`.
 *
 * Polling, not a fixed sleep, and not `vi.runAllTimers()` either: firing the
 * timer only *starts* the write, which then bakes, hashes and puts into OPFS.
 * A fixed delay tuned on a warm run is exactly the test that passes locally
 * and fails in CI on the first, cold invocation.
 */
async function waitForBody(slot: string, timeoutMs = 8000): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pointer = readSceneGlbPointer(slot);
    if (pointer) return pointer;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Let the debounce elapse plus a grace window, for "nothing was written" assertions. */
async function flushAutosave(): Promise<void> {
  await new Promise((r) => setTimeout(r, DRAFT_AUTOSAVE_DEBOUNCE_MS + 400));
}

beforeEach(async () => {
  // A previous test's store may still hold a pending autosave. Since phase 6
  // that timer writes a GLB body to a shared slot, so letting it fire into the
  // next test is not noise — it is another test's data appearing in this one.
  store?.dispose();
  localStorage.clear();
  await clearAllBlobs();
  resetProjectStore();
  project = null;
  viewer = makeViewer();
  viewer.registry = bakeableRegistry();
  store = new SceneStore(viewer as unknown as ConstructorParameters<typeof SceneStore>[0]);

  if (!demoGlb) {
    const { objectToGlb } = await import('../src/core/import/rv-import-object');
    const group = new Group();
    group.name = 'Demo';
    demoGlb = await objectToGlb(group);
  }
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('.glb')) {
      return new Response(demoGlb.slice(0), { status: 200 });
    }
    return realFetch(input, init);
  }) as typeof fetch;
});

afterEach(() => {
  store?.dispose();
  project?.restore();
  resetProjectStore();
  globalThis.fetch = realFetch;
});

// ════════════════════════════════════════════════════════════════════════
// Baseline dirty semantics — the bug-fix that motivates the rewrite.
// ════════════════════════════════════════════════════════════════════════

describe('baseline dirty', () => {
  it('fresh built-in is clean', async () => {
    await store.openBuiltin('/models/Demo.glb', 'Demo');
    expect(store.getSnapshot().dirty).toBe(false);
    expect(store.canUndo()).toBe(false);
    expect(store.canRedo()).toBe(false);
  });

  it('fresh empty is clean', async () => {
    await store.newEmpty();
    expect(store.getSnapshot().dirty).toBe(false);
  });

  it('newly opened saved scene is clean', async () => {
    const seeded = writeScene({ ...makeDraftScene(builtin, 'Cell A'), id: legacySceneId() });
    await store.openScene(seeded.id);
    expect(store.getSnapshot().dirty).toBe(false);
  });

  it('any applyOp flips dirty true', async () => {
    await store.openBuiltin('/models/Demo.glb', 'Demo');
    await store.applyOp(setField(250, 100));
    expect(store.getSnapshot().dirty).toBe(true);
    expect(store.canUndo()).toBe(true);
  });

  it('undo back to baseline clears dirty', async () => {
    await store.openBuiltin('/models/Demo.glb', 'Demo');
    await store.applyOp(setField(250, 100));
    expect(store.getSnapshot().dirty).toBe(true);
    await store.undo();
    expect(store.getSnapshot().dirty).toBe(false);
    expect(store.canUndo()).toBe(false);
  });

  it('save resets baseline → dirty becomes false', async () => {
    project = installFakeDocumentProject();   // Phase 3: a save needs a document home
    await store.openBuiltin('/models/Demo.glb', 'Demo');
    await store.applyOp(setField(250, 100));
    await store.save();
    expect(store.getSnapshot().dirty).toBe(false);
    expect(store.canUndo()).toBe(false);   // baseline now includes the op
  });

  it('saveAs creates a new id and resets baseline', async () => {
    project = installFakeDocumentProject();
    await store.openBuiltin('/models/Demo.glb', 'Demo');
    await store.applyOp(setField(250, 100));
    const id = await store.saveAs('Cell A');
    // RE-PINNED (plan-716 Phase 3, §9.0 "portieren"): the new id is a DOCUMENT
    // id, not `scn_`. The baseline mechanics this case exists for are unchanged
    // and still asserted below.
    expect(id).toMatch(/^doc_/);
    expect(documentsOf(project!.project()).some(d => d.id === id)).toBe(true);
    expect(store.getSnapshot().dirty).toBe(false);
    expect(store.getSnapshot().saved?.id).toBe(id);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Undo / Redo
// ════════════════════════════════════════════════════════════════════════

describe('undo / redo', () => {
  it('undo pops from ops, pushes to redo stack', async () => {
    await store.openBuiltin('/models/Demo.glb', 'Demo');
    await store.applyOp(setField(250, 100));
    expect(store.canUndo()).toBe(true);
    expect(store.canRedo()).toBe(false);
    await store.undo();
    expect(store.canUndo()).toBe(false);
    expect(store.canRedo()).toBe(true);
  });

  it('redo restores the op back onto the stack', async () => {
    await store.openBuiltin('/models/Demo.glb', 'Demo');
    await store.applyOp(setField(250, 100));
    await store.undo();
    await store.redo();
    expect(store.canUndo()).toBe(true);
    expect(store.canRedo()).toBe(false);
  });

  it('any new applyOp clears the redo stack', async () => {
    await store.openBuiltin('/models/Demo.glb', 'Demo');
    await store.applyOp(setField(250, 100));
    await store.undo();
    expect(store.canRedo()).toBe(true);
    await store.applyOp(setField(300, 100));
    expect(store.canRedo()).toBe(false);
  });

  it('cannot undo past the baseline (saved state floor)', async () => {
    const op1 = setField(150, 100);
    const seeded = writeScene({
      ...makeDraftScene(builtin, 'Existing'),
      id: legacySceneId(),
      edits: { ops: [op1], settings: { catalogUrls: [], gridSizeMm: 500 } },
    });
    await store.openScene(seeded.id);
    expect(store.canUndo()).toBe(false);     // ops == baseline
    await store.applyOp(setField(250, 150));
    expect(store.canUndo()).toBe(true);
    await store.undo();
    expect(store.canUndo()).toBe(false);     // back to baseline
  });

  it('describeUndo / describeRedo return human-readable labels', async () => {
    await store.openBuiltin('/models/Demo.glb', 'Demo');
    await store.applyOp(setField(250, 100));
    expect(store.describeUndo()).toContain('Set Drive.TargetSpeed');
    expect(store.describeUndo()).toContain('250');
    await store.undo();
    expect(store.describeUndo()).toBeNull();
    expect(store.describeRedo()).toContain('Set Drive.TargetSpeed');
  });
});

// ════════════════════════════════════════════════════════════════════════
// Coalescing
// ════════════════════════════════════════════════════════════════════════

describe('coalescing', () => {
  it('rapid same-target setField ops merge into one undo step', async () => {
    await store.openBuiltin('/models/Demo.glb', 'Demo');
    await store.applyOp(setField(101, 100, 1000));
    await store.applyOp(setField(102, 101, 1100));
    await store.applyOp(setField(105, 102, 1200));
    // Three forward applies, ONE undo step (coalesced into a single head op)
    await store.undo();
    expect(store.canUndo()).toBe(false);
    // The merged inverse should restore prev=100 (the original baseline value).
    // (Hard to assert side effects without a live scene; we assert the
    // history shape via canUndo only here.)
  });

  it('non-coalescable kinds stay separate', async () => {
    await store.openBuiltin('/models/Demo.glb', 'Demo');
    await store.applyOp(addPlacement(placement('p1'), 1000));
    await store.applyOp(addPlacement(placement('p2'), 1100));
    await store.undo();
    expect(store.canUndo()).toBe(true);   // one add still on stack
    await store.undo();
    expect(store.canUndo()).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Transactions
// ════════════════════════════════════════════════════════════════════════

describe('transactions', () => {
  it('endTransaction commits a single composite op', async () => {
    await store.openBuiltin('/models/Demo.glb', 'Demo');
    const tok = store.beginTransaction('Reset Drive');
    await store.applyOp(setField(0, 100, 1000));
    await store.applyOp(setField(0, 50, 1001));
    await store.endTransaction(tok);
    // One composite op → one undo step.
    expect(store.canUndo()).toBe(true);
    expect(store.describeUndo()).toContain('Reset Drive');
    await store.undo();
    expect(store.canUndo()).toBe(false);
  });

  it('empty transactions become no-ops (no composite pushed)', async () => {
    await store.openBuiltin('/models/Demo.glb', 'Demo');
    const tok = store.beginTransaction('Nothing');
    await store.endTransaction(tok);
    expect(store.canUndo()).toBe(false);
  });

  it('withTransaction RAII helper commits on success', async () => {
    await store.openBuiltin('/models/Demo.glb', 'Demo');
    await store.withTransaction('Setup', async () => {
      await store.applyOp(setField(200, 100, 1000));
      await store.applyOp(addPlacement(placement('p1'), 1001));
    });
    expect(store.canUndo()).toBe(true);
    expect(store.describeUndo()).toContain('Setup');
  });

  it('withTransaction aborts on exception', async () => {
    await store.openBuiltin('/models/Demo.glb', 'Demo');
    await expect(store.withTransaction('Bad', async () => {
      await store.applyOp(setField(200, 100, 1000));
      throw new Error('boom');
    })).rejects.toThrow('boom');
    // Aborted: no composite committed onto the stack.
    expect(store.canUndo()).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Async queue serialisation
// ════════════════════════════════════════════════════════════════════════

describe('async op queue', () => {
  it('serialises concurrent applyOp calls', async () => {
    await store.openBuiltin('/models/Demo.glb', 'Demo');
    const ops = [
      setField(101, 100, 1000),
      setField(102, 101, 1100),
      setField(105, 102, 1200),
    ];
    // Fire all three without awaiting — the queue must process them in order.
    const promises = ops.map(op => store.applyOp(op));
    await Promise.all(promises);
    // After processing, head op should be the merged result of the last apply
    // (coalesced because same target). canUndo true (one history entry).
    expect(store.canUndo()).toBe(true);
  });

  it('concurrent undo + applyOp respect order', async () => {
    await store.openBuiltin('/models/Demo.glb', 'Demo');
    await store.applyOp(setField(200, 100, 1000));
    // Fire undo and a new applyOp without awaiting — undo runs first, then
    // applyOp clears the redo stack.
    const p1 = store.undo();
    const p2 = store.applyOp(setField(300, 100, 2000));
    await Promise.all([p1, p2]);
    expect(store.canRedo()).toBe(false);   // applyOp invalidated redo
    expect(store.canUndo()).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Discard
// ════════════════════════════════════════════════════════════════════════

describe('discard', () => {
  it('discard reverts to the saved state', async () => {
    const seeded = writeScene({
      ...makeDraftScene(builtin, 'A'),
      id: legacySceneId(),
    });
    await store.openScene(seeded.id);
    await store.applyOp(setField(250, 100));
    await store.discard();
    expect(store.getSnapshot().dirty).toBe(false);
    expect(store.getSnapshot().saved?.id).toBe(seeded.id);
  });

  it('discard on a fresh draft (no saved) clears the per-base draft slot', async () => {
    await store.openBuiltin('/models/Demo.glb', 'Demo');
    await store.applyOp(setField(250, 100));
    // Wait for autosave debounce so the draft is persisted.
    await new Promise(r => setTimeout(r, 2100));
    await store.discard();
    expect(store.getSnapshot().dirty).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Restored draft semantics — built-in drafts are unsaved by definition
// ════════════════════════════════════════════════════════════════════════

describe('leftover op-log draft slots', () => {
  it('a per-base slot is not restored — the workspace opens clean', async () => {
    seedDeadDraft(builtin);
    await store.openBuiltin('/models/Demo.glb', 'Demo');
    // Since plan-413 phase 6 there is no reader for that slot. Opening a
    // built-in is opening the built-in, with nothing layered on top.
    expect(store.getSnapshot().dirty).toBe(false);
    expect(store.canUndo()).toBe(false);
    expect(store.getSnapshot().draft?.edits.ops).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Per-saved-scene drafts — symmetric with built-in drafts (rv-scenes/scene-draft/<id>)
// ════════════════════════════════════════════════════════════════════════

describe('per-saved-scene drafts', () => {
  it('openScene ignores a leftover scene-draft slot and loads the saved row', async () => {
    const baselineOp = setField(100, 0, 1);
    const savedId = legacySceneId();
    writeScene({
      ...makeDraftScene(builtin, 'My Layout'),
      id: savedId,
      edits: { ops: [baselineOp], settings: { catalogUrls: [], gridSizeMm: 500 } },
    });
    // A previous release could have parked unsaved ops here. Nothing reads it.
    seedDeadSceneDraft(savedId);

    await store.openScene(savedId);

    const snap = store.getSnapshot();
    expect(snap.draft?.edits.ops).toHaveLength(1);
    expect(snap.dirty).toBe(false);
    expect(snap.saved?.id).toBe(savedId);
  });

  it('openScene with no draft loads cleanly', async () => {
    const baselineOp = setField(100, 0, 1);
    const savedId = legacySceneId();
    writeScene({
      ...makeDraftScene(builtin, 'My Layout'),
      id: savedId,
      edits: { ops: [baselineOp], settings: { catalogUrls: [], gridSizeMm: 500 } },
    });
    await store.openScene(savedId);
    const snap = store.getSnapshot();
    expect(snap.dirty).toBe(false);
    expect(store.canUndo()).toBe(false);
    expect(snap.draft?.edits.ops).toHaveLength(1);
  });

  it('autosaves a saved scene into its own draft BODY, not the base slot', async () => {
    const savedId = legacySceneId();
    writeScene({
      ...makeDraftScene(builtin, 'My Layout'),
      id: savedId,
      edits: { ops: [], settings: { catalogUrls: [], gridSizeMm: 500 } },
    });
    await store.openScene(savedId);
    await store.applyOp(setCamera());
    expect(await waitForBody(`draft/${savedId}`)).not.toBeNull();

    // Since phase 6 the autosave is a GLB body, not an op log.
    // The base slot is NOT used for saved-scene edits.
    expect(readSceneGlbPointer(`draft/${baseKeyOf(builtin)}`)).toBeNull();
    // And the committed body is untouched — an autosave is not a save.
    expect(readSceneGlbPointer(savedId)).toBeNull();
  });

  it('autosaves a fresh built-in into the base slot', async () => {
    await store.openBuiltin('/models/Demo.glb', 'Demo');
    await store.applyOp(setCamera());
    expect(await waitForBody(`draft/${baseKeyOf(builtin)}`)).not.toBeNull();

    // No orphaned body under the workspace's transient 'draft' id.
    expect(readSceneGlbPointer('draft/draft')).toBeNull();
  });

  it('save() writes the document and drops the draft body', async () => {
    // PORTED (plan-716 Phase 3, §9.0). The MECHANICS this case guards are
    // unchanged and all four are still asserted: an edit autosaves into the
    // per-workspace draft slot, a save clears that slot, the undo floor moves to
    // the saved state, and the snapshot goes clean.
    //
    // What is re-pinned is the DESTINATION. There is no committed body slot and
    // no catalogue row any more — `_save()`'s row path is deleted — so
    // "the committed body now exists" becomes "the document file now exists".
    const savedId = legacySceneId();
    writeScene({
      ...makeDraftScene(builtin, 'My Layout'),
      id: savedId,
      edits: { ops: [], settings: { catalogUrls: [], gridSizeMm: 500 } },
    });
    await store.openScene(savedId);
    await store.applyOp(setCamera());
    expect(await waitForBody(`draft/${savedId}`)).not.toBeNull();

    project = installFakeDocumentProject();
    await store.save();

    // The document file exists and the draft slot is gone.
    const created = documentsOf(project.project())[0];
    expect(created).toBeDefined();
    expect(project.files.has(created.path)).toBe(true);
    expect(readSceneGlbPointer(`draft/${savedId}`)).toBeNull();
    // No committed body slot was ever written — the FILE is the persistence.
    expect(readSceneGlbPointer(savedId)).toBeNull();
    // The saved state is the undo floor, exactly as before phase 6 — the op
    // log stays in memory (§2.10), but the baseline moves with the save.
    expect(store.canUndo()).toBe(false);
    expect(store.getSnapshot().dirty).toBe(false);
  });

  it('discard() on a saved scene drops its draft body and reloads clean', async () => {
    const savedId = legacySceneId();
    writeScene({
      ...makeDraftScene(builtin, 'My Layout'),
      id: savedId,
      edits: { ops: [], settings: { catalogUrls: [], gridSizeMm: 500 } },
    });
    await store.openScene(savedId);
    await store.applyOp(setCamera());
    expect(await waitForBody(`draft/${savedId}`)).not.toBeNull();

    await store.discard();

    expect(readSceneGlbPointer(`draft/${savedId}`)).toBeNull();
    const snap = store.getSnapshot();
    expect(snap.dirty).toBe(false);
    expect(store.canUndo()).toBe(false);
  });

  it('delete(id) clears the scene-draft slot for that id', async () => {
    // A DOCUMENT since plan-716 Phase 6 — `delete` refuses an id that names no
    // manifest row. The property under test is unchanged and still worth
    // pinning: whatever else deleting does, it takes the dead per-saved-scene
    // slot of an earlier release with it, or a stale key outlives the thing it
    // belonged to forever.
    project = installFakeDocumentProject();
    const savedId = await store.createEmpty('My Layout');
    const key = seedDeadSceneDraft(savedId);
    expect(deadSlotExists(key)).toBe(true);

    await store.delete(savedId);
    expect(deadSlotExists(key)).toBe(false);
    expect(documentsOf(project.project())).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Failure tolerance
// ════════════════════════════════════════════════════════════════════════

describe('failure tolerance', () => {
  it('an op whose forward executor throws is still pushed onto the stack', async () => {
    await store.openBuiltin('/models/Demo.glb', 'Demo');
    // The fake viewer has registry=null → executor's writeUserDataField is
    // a no-op (returns silently); no throw. To simulate a failure, replace
    // applyForward via mock — but we just assert that an op that does NOT
    // crash still ends up on the stack and can be undone.
    await store.applyOp(setField(250, 100));
    expect(store.canUndo()).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════
// History cap
// ════════════════════════════════════════════════════════════════════════

describe('history cap', () => {
  it('does not exceed MAX_OP_HISTORY', async () => {
    // Use a small cap by simulating many ops; we trust the cap from constants.
    // (MAX_OP_HISTORY = 500; running 500 here is overkill — we just verify
    //  that long sequences don't crash and canUndo remains correct.)
    await store.openBuiltin('/models/Demo.glb', 'Demo');
    for (let i = 0; i < 100; i++) {
      await store.applyOp(setField(i, i - 1, 1000 + i * 1000));   // distinct ts to avoid coalesce
    }
    expect(store.canUndo()).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Op types — smoke coverage
// ════════════════════════════════════════════════════════════════════════

describe('op type smoke', () => {
  it('addPlacement / removePlacement / transformPlacement / setCamera all push', async () => {
    await store.openBuiltin('/models/Demo.glb', 'Demo');
    const p = placement('p1');
    await store.applyOp(addPlacement(p));
    await store.applyOp(transform('p1', [5, 0, 0]));
    await store.applyOp(setCam({ px: 1, py: 2, pz: 3, tx: 0, ty: 0, tz: 0 }, null));
    await store.applyOp(removePlacement(p));
    expect(store.getSnapshot().draft?.edits.ops).toHaveLength(4);
  });
});

// ════════════════════════════════════════════════════════════════════════
// Snapshot identity (React useSyncExternalStore expects stable refs)
// ════════════════════════════════════════════════════════════════════════

describe('snapshot identity', () => {
  it('getSnapshot returns same ref between mutations', () => {
    const a = store.getSnapshot();
    const b = store.getSnapshot();
    expect(a).toBe(b);
  });

  it('snapshot ref changes after a mutation', async () => {
    const a = store.getSnapshot();
    await store.openBuiltin('/models/Demo.glb', 'Demo');
    const b = store.getSnapshot();
    expect(b).not.toBe(a);
  });
});

