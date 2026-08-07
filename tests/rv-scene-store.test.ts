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
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SceneStore } from '../src/core/hmi/scene/scene-store';
import {
  type RvScene,
  type SceneBase,
  newSceneId,
  makeDraftScene,
} from '../src/core/hmi/scene/rv-scene-types';
import {
  readScene,
  writeScene,
  readDraft,
  writeDraft,
  listMetas,
  readActiveId,
} from '../src/core/hmi/scene/rv-scene-storage';

// ─── Fake viewer ────────────────────────────────────────────────────────

interface FakeViewer {
  loadScene: (s: RvScene) => Promise<void>;
  loadEmptyScene: () => Promise<void>;
  getPlugin: <T>(id: string) => T | undefined;
  availableModels: { url: string; label: string }[];
  currentScene: RvScene | null;
  currentModelUrl: string | null;
  loadScenes: RvScene[];
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

  beforeEach(() => {
    localStorage.clear();
    viewer = makeViewer();
    // Cast the fake viewer; SceneStore only uses the methods/fields above.
    store = new SceneStore(viewer as unknown as ConstructorParameters<typeof SceneStore>[0]);
  });

  // ─── Catalogue ────────────────────────────────────────────────────────

  describe('catalogue', () => {
    it('mirrors viewer.availableModels into builtins', () => {
      const snap = store.getSnapshot();
      expect(snap.builtins).toHaveLength(2);
      expect(snap.builtins[0].label).toBe('Demo');
    });

    it('starts with empty My Scenes', () => {
      expect(store.listScenes()).toEqual([]);
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

    it('restores an autosaved per-base draft if one exists', async () => {
      const draftWithEdits: RvScene = {
        ...makeDraftScene(builtinDemo, 'Demo'),
        edits: {
          ops: [{
            id: 'op_seed', ts: 1, schemaV: 1, kind: 'setField',
            nodePath: 'Conv1', componentType: 'Drive',
            fieldName: 'TargetSpeed', value: 999, prev: 100,
          }],
          settings: { catalogUrls: [], gridSizeMm: 500 },
        },
      };
      writeDraft(builtinDemo, draftWithEdits);

      await store.openBuiltin('/models/Demo.glb', 'Demo');
      const snap = store.getSnapshot();
      expect(snap.draft?.edits.ops).toHaveLength(1);
      expect(snap.draft?.edits.ops[0].kind).toBe('setField');
      // Restored built-in draft has no associated saved scene — its clean
      // baseline is the unmodified GLB (empty op log). The restored ops
      // are deltas from that, so the workspace is dirty on open and the
      // UI surfaces "Unsaved" until the user explicitly saves or discards.
      expect(snap.dirty).toBe(true);
      expect(viewer.loadScenes[0].edits.ops).toHaveLength(1);
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
    it('save() promotes a draft into a saved scene with a fresh id', async () => {
      await store.openBuiltin('/models/Demo.glb', 'Demo');
      // Manually mutate draft: pretend the user changed the name.
      const before = store.getSnapshot().draft!;
      // Simulate a name override.
      Object.assign(before, { name: 'My Robot Cell' });
      await store.save();

      const snap = store.getSnapshot();
      expect(snap.saved).not.toBeNull();
      expect(snap.saved!.id).toMatch(/^scn_/);
      expect(snap.saved!.id).not.toBe('draft');
      expect(snap.dirty).toBe(false);
      expect(listMetas()).toHaveLength(1);
      expect(readActiveId()).toBe(snap.saved!.id);
    });

    it('save() on an existing scene updates in place (same id)', async () => {
      // Seed a saved scene
      const seeded = writeScene({
        ...makeDraftScene(builtinDemo, 'Existing'),
        id: newSceneId(),
      });
      await store.openScene(seeded.id);
      // Apply an op so save has something to persist.
      await store.applyOp({
        id: 'op_test', ts: Date.now(), schemaV: 1, kind: 'setField',
        nodePath: 'Conv1', componentType: 'Drive', fieldName: 'TargetSpeed',
        value: 200, prev: 100,
      });
      await store.save();
      const snap = store.getSnapshot();
      expect(snap.saved!.id).toBe(seeded.id);
      expect(readScene(seeded.id)?.edits.ops).toHaveLength(1);
      expect(listMetas()).toHaveLength(1);
      expect(snap.dirty).toBe(false);   // baseline reset
    });

    it('saveAs always creates a new id', async () => {
      const seeded = writeScene({
        ...makeDraftScene(builtinDemo, 'A'),
        id: newSceneId(),
      });
      await store.openScene(seeded.id);
      const newId = await store.saveAs('B');
      expect(newId).not.toBe(seeded.id);
      expect(listMetas()).toHaveLength(2);
      expect(store.getSnapshot().saved?.name).toBe('B');
    });
  });

  // ─── Discard / Rename / Duplicate / Delete ─────────────────────────────

  describe('discard', () => {
    it('reloads the saved snapshot when one exists', async () => {
      const seeded = writeScene({
        ...makeDraftScene(builtinDemo, 'A'),
        id: newSceneId(),
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
      // Persist as draft first so discard has something to clear.
      writeDraft(builtinDemo, store.getSnapshot().draft!);
      await store.discard();
      expect(readDraft(builtinDemo)).toBeNull();
    });
  });

  describe('rename', () => {
    it('renames a saved scene and updates index + active state', async () => {
      const seeded = writeScene({
        ...makeDraftScene(builtinDemo, 'A'),
        id: newSceneId(),
      });
      await store.openScene(seeded.id);
      store.rename(seeded.id, 'A Renamed');
      expect(readScene(seeded.id)?.name).toBe('A Renamed');
      expect(store.getSnapshot().saved?.name).toBe('A Renamed');
    });
  });

  describe('duplicate', () => {
    it('produces a new entry with a fresh id, parentId set', () => {
      const seeded = writeScene({
        ...makeDraftScene(builtinDemo, 'A'),
        id: newSceneId(),
      });
      const dupId = store.duplicate(seeded.id);
      const dup = readScene(dupId)!;
      expect(dup.id).not.toBe(seeded.id);
      expect(dup.parentId).toBe(seeded.id);
      expect(dup.name).toMatch(/copy/i);
    });
  });

  // The dashboard catalogues rather than switches: creating a scene must add a
  // row WITHOUT replacing the open workspace, and must persist so a reload
  // keeps it. (newEmpty() is the other half of the pair and does switch.)
  describe('createEmpty', () => {
    it('adds a saved scene without touching the workspace', async () => {
      await store.openBuiltin(builtinDemo.url, builtinDemo.label);
      const before = store.getSnapshot().draft;

      const id = store.createEmpty();

      const created = readScene(id)!;
      expect(created.base.kind).toBe('empty');
      expect(store.listScenes().some(m => m.id === id)).toBe(true);
      // The open workspace is untouched — no switch, so no dirty prompt owed.
      expect(store.getSnapshot().draft?.id).toBe(before?.id);
    });

    it('does not collide when called twice', () => {
      const a = store.createEmpty();
      const b = store.createEmpty();
      expect(a).not.toBe(b);
      expect(readScene(a)!.name).not.toBe(readScene(b)!.name);
    });
  });

  describe('delete', () => {
    it('removes a non-active scene from index and storage', async () => {
      const a = writeScene({ ...makeDraftScene(builtinDemo, 'A'), id: newSceneId() });
      const b = writeScene({ ...makeDraftScene(builtinDemo, 'B'), id: newSceneId() });
      await store.openScene(a.id);
      await store.delete(b.id);
      expect(readScene(b.id)).toBeNull();
      expect(listMetas().map(m => m.id)).toEqual([a.id]);
    });

    it('falls back to first builtin when deleting the active scene', async () => {
      const a = writeScene({ ...makeDraftScene(empty, 'A'), id: newSceneId() });
      await store.openScene(a.id);
      await store.delete(a.id);
      const snap = store.getSnapshot();
      // Active fell back to first built-in (Demo).
      expect(snap.draft?.base.kind).toBe('builtin');
      expect((snap.draft?.base as { kind: 'builtin'; url: string }).url).toBe('/models/Demo.glb');
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

    it('newEmpty + saveAs creates a named empty scene', async () => {
      await store.newEmpty();
      const id = await store.saveAs('Empty A');
      expect(id).toMatch(/^scn_/);
      expect(readScene(id)?.base.kind).toBe('empty');
      expect(readScene(id)?.name).toBe('Empty A');
    });

    it('exportSceneJSON triggers a download', () => {
      const seeded = writeScene({ ...makeDraftScene(builtinDemo, 'A'), id: newSceneId() });
      const orig = URL.createObjectURL;
      const created: string[] = [];
      URL.createObjectURL = (b: Blob) => {
        const u = `blob:fake-${created.length}`;
        created.push(u);
        return u;
      };
      try {
        store.exportSceneJSON(seeded.id);
        expect(created.length).toBeGreaterThan(0);
      } finally {
        URL.createObjectURL = orig;
      }
    });
  });

});
