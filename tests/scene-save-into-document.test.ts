// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * GLBs only (scene = asset) — a workspace opened from a project document saves
 * back INTO that document.
 *
 * What this pins shut: `_save()` used to mint a scene id for EVERY unsaved
 * workspace, so opening `models/Belt.glb`, editing the layout and pressing
 * Save forked the user's file into a second, scene-shaped copy — the file on
 * disk never changed, and the project silently gained a "scene" that was
 * really the document under another name. With `_saveIntoDocument`:
 *
 *  - the bytes replace the document's own file (`backend.writeDocument` at the
 *    manifest path) — no scene id, no catalogue row, no body-slot commit;
 *  - a clean second save is a true no-op, and an edited one writes the SAME
 *    file again;
 *  - a base the manifest does not list keeps the fork-into-catalogue path
 *    byte-identical (the guard, so nothing else regresses).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  /** slot → revision, as the fake body store sees it. */
  bodies: new Map<string, string>(),
  writes: [] as { slot: string; expected: string | null | undefined }[],
}));

let nextRevision = 0;

vi.mock('../src/core/hmi/scene/rv-scene-glb-io', () => ({
  readSceneGlbBody: async (slot: string) =>
    (h.bodies.has(slot)
      ? { glb: new Uint8Array([0x67, 0x6c, 0x54, 0x46]), revision: h.bodies.get(slot)!, target: 'opfs' }
      : null),
  writeSceneGlbBody: async (write: { sceneId: string; expectedRevision?: string | null }) => {
    h.writes.push({ slot: write.sceneId, expected: write.expectedRevision });
    const revision = `rev${++nextRevision}`;
    h.bodies.set(write.sceneId, revision);
    return { revision, target: 'opfs' };
  },
  dropSceneGlbBody: async (slot: string) => { h.bodies.delete(slot); },
  sceneGlbBodyRevision: async (sceneId: string) => h.bodies.get(sceneId) ?? null,
}));

vi.mock('../src/core/hmi/scene/rv-scene-glb-bake', () => ({
  bakeIntoGlb: async () => ({ glb: new Uint8Array([1, 2, 3, 4]), warnings: [], writtenReferences: [] }),
  makeRegistryBakeResolver: () => ({}),
  bakeRequiresFullPath: () => false,
}));

import { SceneStore } from '../src/core/hmi/scene/scene-store';
import { listMetas } from '../src/core/hmi/scene/rv-scene-storage';
import { getProjectStore } from '../src/core/project/project-store';
import { projectAssetUrl } from '../src/core/project/rv-project-asset-source';
import type { RvProject } from '../src/core/project/rv-project-types';
import type { ProjectBackend } from '../src/core/project/backends/project-backend';
import type { RvScene } from '../src/core/hmi/scene/rv-scene-types';
import type { RVViewer } from '../src/core/rv-viewer';

const PATH = 'models/Belt.glb';

/** A minimal self-contained binary GLB (same builder as model-load-no-object-url). */
function glb(doc: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(doc));
  const jsonPad = (json.byteLength + 3) & ~3;
  const total = 12 + 8 + jsonPad;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);      // 'glTF'
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonPad, true);
  view.setUint32(16, 0x4e4f534a, true);     // 'JSON'
  out.fill(0x20, 20, 20 + jsonPad);
  out.set(json, 20);
  return out;
}

const DOC_GLB = glb({
  asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
  nodes: [{ name: 'Machine' }],
});

function makeViewer() {
  const v = {
    availableModels: [] as unknown[],
    availablePublishedScenes: [],
    currentScene: null as RvScene | null,
    currentModelUrl: null as string | null,
    // `children: []` is load-bearing since plan-736, not decoration. The fake
    // backend used to have `readBlobBytes` but no `readScene`, so
    // `readSceneGlbBody()` threw on it and the open fell through to OPFS before
    // ever adopting from a loaded GLB. There is ONE read now, so the same double
    // serves both callers, the open gets as far as `collectPlacementNodes`, and
    // the root it walks has to be walkable. The test double was incomplete; the
    // unification is what made that visible.
    currentModelRoot: { name: 'root', children: [] as unknown[] },
    registry: {
      getGltfNodeNames: () => [], getGltfNodeIndex: () => -1,
      getPathForNode: () => null, getNode: () => null,
    },
    lastLoadResult: null,
    modes: { has: () => true, setMode: () => {} },
    getPlugin: () => undefined,
    loadScene: async (s: RvScene) => { v.currentScene = s; },
    loadEmptyScene: async () => {},
  };
  return v;
}

/** A writable backend that records blob writes and serves the one document. */
function fakeBackend() {
  const blobWrites: { relPath: string; size: number }[] = [];
  const bytes = DOC_GLB;
  const backend = {
    kind: 'browser', id: 'test', writable: true, isActive: true,
    listModels: async () => [],
    listDocuments: async () => [],
    readDocument: async (ref: string | { path: string }) => {
      const relPath = typeof ref === 'string' ? ref : ref.path;
      return relPath === PATH
        ? { bytes: new Uint8Array(bytes), meta: { id: '', name: PATH, path: PATH }, revision: 'rev' }
        : null;
    },
    readDocumentUrl: async () => null,
    writeDocument: async (ref: string | { path: string }, written: Uint8Array) => {
      const relPath = typeof ref === 'string' ? ref : ref.path;
      blobWrites.push({ relPath, size: written.byteLength });
      return { revision: 'rev' };
    },
  } as unknown as ProjectBackend;
  return { backend, blobWrites };
}

function inject(backend: ProjectBackend | null, project: RvProject | null): void {
  const store = getProjectStore() as unknown as {
    _backend: ProjectBackend | null; _project: RvProject | null;
  };
  store._backend = backend;
  store._project = project;
}

function projectWith(documents: RvProject['documents']): RvProject {
  return { schemaVersion: 3, id: 'prj_test', name: 'Test', documents } as RvProject;
}

/** An edit, so a save has something to persist. */
async function edit(store: SceneStore, value: number): Promise<void> {
  await store.applyOp({
    id: `op_${value}`, ts: Date.now(), schemaV: 1, kind: 'setField',
    nodePath: 'Conv1', componentType: 'Drive', fieldName: 'TargetSpeed',
    value, prev: 0,
  } as never);
}

async function openDocumentWorkspace(store: SceneStore): Promise<void> {
  await store.openBuiltin(projectAssetUrl(PATH), 'Belt');
  // What `_loadIntoWorkspace` does for a real load: the resolved bytes become
  // the bake source, so a save never re-fetches the sentinel URL.
  store.adoptProjectedBaseBytes(new ArrayBuffer(8));
}

beforeEach(() => {
  localStorage.clear();
  h.bodies.clear();
  h.writes.length = 0;
  nextRevision = 0;
  inject(null, null);
});

describe('save into the project document (GLBs only — scene = asset)', () => {
  it('writes the document file, mints NO scene id and NO catalogue row', async () => {
    const { backend, blobWrites } = fakeBackend();
    inject(backend, projectWith([{ id: 'doc_belt', path: PATH, name: 'Belt' }]));
    const store = new SceneStore(makeViewer() as unknown as RVViewer);
    await openDocumentWorkspace(store);
    await edit(store, 100);

    const verdict = await store.save();

    expect(verdict).toBe('saved');
    expect(blobWrites.map(w => w.relPath)).toEqual([PATH]);
    expect(listMetas()).toHaveLength(0);
    // No committed body-slot write either — the file IS the persistence.
    expect(h.writes.filter(w => !w.slot.startsWith('draft/'))).toHaveLength(0);
  });

  it('a clean second save is a no-op; an edited one writes the SAME file again', async () => {
    const { backend, blobWrites } = fakeBackend();
    inject(backend, projectWith([{ id: 'doc_belt', path: PATH, name: 'Belt' }]));
    const store = new SceneStore(makeViewer() as unknown as RVViewer);
    await openDocumentWorkspace(store);
    await edit(store, 100);
    await store.save();

    expect(await store.save()).toBe('no-op');
    expect(blobWrites).toHaveLength(1);

    await edit(store, 250);
    expect(await store.save()).toBe('saved');
    expect(blobWrites.map(w => w.relPath)).toEqual([PATH, PATH]);
    expect(listMetas()).toHaveLength(0);
  });

  // PORTED (plan-716 Phase 3, F1/F5). These two used to assert that a workspace
  // the manifest does not name "keeps the fork-into-catalogue path" — mint a
  // `scn_`, write a body slot, add a catalogue row. That path is DELETED. The
  // statement they were really making survives and is what is asserted now:
  // a workspace with no document of its own does not silently write into
  // somebody else's file. It gets a document of its OWN instead.

  it('a project path the manifest does not list gets its own document', async () => {
    const { backend, blobWrites } = fakeBackend();
    inject(backend, projectWith([]));
    const store = new SceneStore(makeViewer() as unknown as RVViewer);
    await openDocumentWorkspace(store);
    await edit(store, 100);

    const verdict = await store.save();

    expect(verdict).toBe('saved');
    // Its own path (in the project root, the default folder), never the
    // unlisted `models/Belt.glb` it was opened from.
    expect(blobWrites.map(w => w.relPath)).toEqual(['Belt.glb']);
    expect(listMetas()).toEqual([]);
  });

  it('a non-project builtin gets its own document too', async () => {
    const { backend, blobWrites } = fakeBackend();
    inject(backend, projectWith([{ id: 'doc_belt', path: PATH, name: 'Belt' }]));
    const store = new SceneStore(makeViewer() as unknown as RVViewer);
    await store.openBuiltin('/models/Demo.glb', 'Demo');
    store.adoptProjectedBaseBytes(new ArrayBuffer(8));
    await edit(store, 100);

    const verdict = await store.save();

    expect(verdict).toBe('saved');
    // A new document — and emphatically NOT the Belt document it is not.
    expect(blobWrites.map(w => w.relPath)).toEqual(['Demo.glb']);
    expect(listMetas()).toEqual([]);
  });
});
