// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SceneStore tests — workspace lifecycle, draft persistence, dirty tracking.
 *
 * Uses a minimal fake RVViewer that records the scenes passed to loadScene.
 * The full plugin infrastructure (planner / overlay editor / camera) is
 * exercised separately by their own tests; here we focus on:
 *   - openScene / openBuiltin / newEmpty / forkFromBase
 *   - save / saveAs / discard / rename / duplicate / delete
 *   - per-base draft autosave-and-restore
 *   - dirty flag behaviour via markDirty (subscription wiring is integration-tested)
 *
 * ## plan-716 Phase 3 — partially ported (§9.0)
 *
 * The plan's disposition for this file is "portieren → open-save-document.test.ts-
 * Familie", and that is what happened: every case that asserted on the DELETED
 * row save (a `scn_` mint, a catalogue row, a body slot) moved to
 * `open-save-document.test.ts`, where it is restated against the document file.
 * What stays here is the mechanics that survive the phase untouched — the
 * workspace lifecycle, the fork, the draft slots, rename, and the catalogue
 * fallbacks that live until Phase 6 deletes the catalogue itself.
 *
 * The cases that DO still call a save verb install a writable project, because
 * since Phase 3 a save writes a document file and needs somewhere to put it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Phase 3: a save BAKES and writes the result as a document file. The bytes are
// irrelevant to every case in this file, and baking for real would need a live
// Three.js scene — which is exactly what the fake viewer exists to avoid.
vi.mock('../src/core/hmi/scene/rv-scene-glb-bake', () => ({
  bakeIntoGlb: async () => ({
    glb: new Uint8Array([0x67, 0x6c, 0x54, 0x46, 1, 2, 3, 4]),
    warnings: [],
    writtenReferences: [],
  }),
  makeRegistryBakeResolver: () => ({}),
  bakeRequiresFullPath: () => false,
}));
import { deadDraftKey, deadSlotExists, seedDeadDraft } from './helpers/dead-draft-slots';
import { SceneStore } from '../src/core/hmi/scene/scene-store';
import {
  type RvScene,
  type SceneBase,
  makeDraftScene,
} from '../src/core/hmi/scene/rv-scene-types';
import {
  readScene,
  writeScene,
  listMetas,
  readActiveId,
} from '../src/core/hmi/scene/rv-scene-storage';
import { documentsOf } from '../src/core/project/rv-project-documents';
import { resetProjectStore } from '../src/core/project/project-store';
import {
  installFakeDocumentProject,
  type FakeDocumentProject,
} from './helpers/fake-document-project';
import { legacySceneId } from './helpers/legacy-scene-id';

// ─── Fake viewer ────────────────────────────────────────────────────────

interface FakeViewer {
  loadScene: (s: RvScene) => Promise<void>;
  loadEmptyScene: () => Promise<void>;
  getPlugin: <T>(id: string) => T | undefined;
  availableModels: { url: string; label: string }[];
  currentScene: RvScene | null;
  currentModelUrl: string | null;
  /**
   * `openDocument` records the active mode with the session pointer, so a fake
   * viewer that has no `modes` makes every document open throw on the way out.
   * Present since plan-716 Phase 6 — before it, this file reached that verb only
   * on the paths that already failed here.
   */
  modes: { has: (id: string) => boolean; setMode: (id: string) => void; activeMode: string | null };
  loadScenes: RvScene[];
  registry: unknown;
  currentModelRoot: unknown;
  lastLoadResult: unknown;
}

function makeViewer(): FakeViewer {
  const v: FakeViewer = {
    // The bake needs a registry to resolve names against; mocked bake, real
    // guard (`_bakeCurrent` returns null without one).
    registry: { getGltfNodeNames: () => [], getGltfNodeIndex: () => -1 },
    currentModelRoot: null,
    lastLoadResult: null,
    loadScenes: [],
    availableModels: [
      { url: '/models/Demo.glb', label: 'Demo' },
      { url: '/models/Tests.glb', label: 'Tests' },
    ],
    currentScene: null,
    currentModelUrl: null,
    modes: { has: () => false, setMode: () => {}, activeMode: null },
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

const builtinDemo: SceneBase = { kind: 'builtin', url: '/models/Demo.glb', label: 'Demo' };
const empty: SceneBase = { kind: 'empty' };

describe('SceneStore', () => {
  let viewer: FakeViewer;
  let store: SceneStore;
  /** Installed per test — see the file header for why it is not global. */
  let project: FakeDocumentProject | null = null;

  beforeEach(() => {
    localStorage.clear();
    resetProjectStore();
    project = null;
    viewer = makeViewer();
    // Cast the fake viewer; SceneStore only uses the methods/fields above.
    store = new SceneStore(viewer as unknown as ConstructorParameters<typeof SceneStore>[0]);
  });

  afterEach(() => {
    project?.restore();
    resetProjectStore();
  });

  // ─── Catalogue ────────────────────────────────────────────────────────

  describe('catalogue', () => {
    it('mirrors viewer.availableModels into builtins', () => {
      const snap = store.getSnapshot();
      expect(snap.builtins).toHaveLength(2);
      expect(snap.builtins[0].label).toBe('Demo');
    });

    it('has no scene catalogue at all — the accessor is gone (plan-716 Phase 6)', () => {
      expect('listScenes' in store).toBe(false);
      expect('listBuiltins' in store).toBe(false);
    });
  });

  // ─── Workspace ────────────────────────────────────────────────────────

  describe('openBuiltin', () => {
    it('produces a fresh draft when no per-base draft exists', async () => {
      await store.openBuiltin('/models/Demo.glb', 'Demo');
      const snap = store.getSnapshot();
      expect(snap.draft?.base).toEqual(builtinDemo);
      expect(snap.saved).toBeNull();
      expect(snap.isDraft).toBe(true);
      expect(snap.dirty).toBe(false);                // fresh open is clean
      expect(viewer.loadScenes).toHaveLength(1);
      expect(viewer.loadScenes[0].edits.ops).toEqual([]);
    });

    it('ignores a leftover op-log draft slot (plan-413 phase 6)', async () => {
      // A previous release could autosave an op log here. That reader is gone:
      // an autosave is a GLB body, and resuming a JSON op log would mean two
      // formats claiming the same workspace. The slot is simply not consulted.
      seedDeadDraft(builtinDemo);

      await store.openBuiltin('/models/Demo.glb', 'Demo');
      const snap = store.getSnapshot();
      expect(snap.draft?.edits.ops).toEqual([]);
      expect(snap.dirty).toBe(false);
      expect(viewer.loadScenes[0].edits.ops).toEqual([]);
    });
  });

  describe('newEmpty', () => {
    it('produces an empty-base draft', async () => {
      await store.newEmpty();
      const snap = store.getSnapshot();
      expect(snap.draft?.base.kind).toBe('empty');
      expect(snap.isDraft).toBe(true);
    });
  });

  // ─── Save / Save As ───────────────────────────────────────────────────

  describe('save / saveAs', () => {
    // PORTED (plan-716 Phase 3, §9.0). The two cases that pinned the row save —
    // "promotes a draft into a saved scene with a fresh `scn_` id" and "updates
    // in place, catalogue row carries the op log" — now live in
    // `open-save-document.test.ts` against the document file. What is kept here
    // is the surviving statement of each: a save makes the workspace clean and
    // named, and `saveAs` always produces a DIFFERENT document.

    it('save() promotes a draft into a saved document', async () => {
      project = installFakeDocumentProject();
      await store.openBuiltin('/models/Demo.glb', 'Demo');
      await store.applyOp({
        id: 'op_promote', ts: Date.now(), schemaV: 1, kind: 'setField',
        nodePath: 'Conv1', componentType: 'Drive', fieldName: 'TargetSpeed',
        value: 200, prev: 100,
      });

      await store.save();

      const snap = store.getSnapshot();
      expect(snap.saved).not.toBeNull();
      expect(snap.saved!.id).not.toBe('draft');
      expect(snap.dirty).toBe(false);
      // RE-PINNED: a document row, never a catalogue row and never a `scn_`.
      expect(snap.saved!.id.startsWith('scn_')).toBe(false);
      expect(documentsOf(project.project())).toHaveLength(1);
      expect(listMetas()).toEqual([]);
    });

    it('saveAs always creates a new id', async () => {
      project = installFakeDocumentProject();
      const seeded = writeScene({
        ...makeDraftScene(builtinDemo, 'A'),
        id: legacySceneId(),
      });
      await store.openScene(seeded.id);
      const newId = await store.saveAs('B');
      expect(newId).not.toBe(seeded.id);
      expect(documentsOf(project.project())).toHaveLength(1);
      expect(store.getSnapshot().saved?.name).toBe('B');
    });
  });

  // ─── Discard / Rename / Duplicate / Delete ─────────────────────────────

  describe('discard', () => {
    it('reloads the saved snapshot when one exists', async () => {
      const seeded = writeScene({
        ...makeDraftScene(builtinDemo, 'A'),
        id: legacySceneId(),
      });
      await store.openScene(seeded.id);
      Object.assign(store.getSnapshot().draft!, { name: 'B (unsaved)' });
      const callsBefore = viewer.loadScenes.length;
      await store.discard();
      // discard reloads the saved scene → another loadScene call.
      expect(viewer.loadScenes.length).toBeGreaterThan(callsBefore);
      expect(store.getSnapshot().saved?.name).toBe('A');
    });

    it('on a fresh draft (no saved), reloads the bare base', async () => {
      await store.openBuiltin('/models/Demo.glb', 'Demo');
      Object.assign(store.getSnapshot().draft!, { name: 'My edits' });
      // Nothing writes this slot any more, but discard still has to sweep what
      // an earlier release left in it — otherwise a stale key outlives the
      // scene it belonged to forever.
      const key = seedDeadDraft(builtinDemo);
      await store.discard();
      expect(deadSlotExists(key)).toBe(false);
    });
  });

  // ── rename / duplicate / createEmpty / delete are DOCUMENT ops ──────────
  //
  // Four describe blocks stood here, each exercising the catalogue fallback of
  // one verb, and each already labelled "kept until Phase 6". The verbs no
  // longer have a catalogue branch to take: `duplicate`, `delete` and
  // `createEmpty` refuse an id that names no document, and `rename` writes the
  // manifest row. Their coverage is the §9.3 family in
  // `open-save-document.test.ts`, against a project they can actually write to.

  describe('the catalogue verbs refuse what is not a document', () => {
    it('duplicate and delete throw on a bare catalogue row', async () => {
      const seeded = writeScene({
        ...makeDraftScene(builtinDemo, 'A'),
        id: legacySceneId(),
      });
      await expect(store.duplicate(seeded.id)).rejects.toThrow(/not found/i);
      await expect(store.delete(seeded.id)).rejects.toThrow(/not found/i);
      // Refused, not half-done: the row and its body are exactly as they were.
      expect(readScene(seeded.id)?.name).toBe('A');
    });

    it('rename is a no-op for an id with no manifest row', async () => {
      const seeded = writeScene({
        ...makeDraftScene(builtinDemo, 'A'),
        id: legacySceneId(),
      });
      await store.rename(seeded.id, 'A Renamed');
      expect(readScene(seeded.id)?.name).toBe('A');
    });

    it('createEmpty says so when there is nowhere to put a document', async () => {
      await expect(store.createEmpty()).rejects.toThrow(/writable project/i);
      expect(listMetas()).toEqual([]);
    });
  });

  // ─── markGlbActive / boot path ────────────────────────────────────────

  describe('markGlbActive', () => {
    it('synthesizes a draft for the given builtin and updates viewer.currentScene', () => {
      store.markGlbActive('/models/Demo.glb', 'Demo');
      const snap = store.getSnapshot();
      expect(snap.draft?.base).toEqual(builtinDemo);
      expect(viewer.currentScene?.base).toEqual(builtinDemo);
    });

    it('is idempotent for the same base', () => {
      store.markGlbActive('/models/Demo.glb', 'Demo');
      const before = store.getSnapshot().draft;
      store.markGlbActive('/models/Demo.glb', 'Demo');
      const after = store.getSnapshot().draft;
      expect(after).toBe(before);
    });
  });

  // ─── Open / save / export flows ───────────────────────────────────────

  describe('open / save / export flows', () => {
    it('openBuiltin loads the GLB base into the draft', async () => {
      await store.openBuiltin('/models/Demo.glb', 'Demo');
      const snap = store.getSnapshot();
      expect(snap.draft?.base).toEqual(builtinDemo);
    });

    it('newEmpty + saveAs creates a named empty document', async () => {
      // RE-PINNED (Phase 3): both halves became document verbs. `newEmpty`
      // MINTS a document, and `saveAs` copies it under the given name — so the
      // project ends with two rows and the second one carries the name.
      project = installFakeDocumentProject();
      await store.newEmpty();
      const id = await store.saveAs('Empty A');

      expect(id).toMatch(/^doc_/);
      const row = documentsOf(project.project()).find(d => d.id === id)!;
      expect(row.name).toBe('Empty A');
      expect(row.path).toBe('scenes/Empty A.glb');
      expect(listMetas()).toEqual([]);
    });

    // `exportSceneJSON` went with the JSON scene reader (plan-413 phase 6):
    // a v3 catalogue row describes a body it does not carry, so the file it
    // produced could not be opened anywhere. `Export .glb…` is the verb now.
  });
});
