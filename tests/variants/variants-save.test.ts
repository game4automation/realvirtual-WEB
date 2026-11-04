// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Object3D } from 'three';
import { SceneStore } from '../../src/core/hmi/scene/scene-store';
import { bakeIntoGlb } from '../../src/core/hmi/scene/rv-scene-glb-bake';
import { materialise } from '../../src/core/hmi/scene/rv-scene-edits';
import { parseGlbChunks } from '../../src/core/persistence/rv-glb-chunks';
import { setVariantsSaveProvider } from '../../src/core/hmi/rv-run-lease';
import { VariantStore } from '../../src/core/variants/rv-variant-store';
import { saveDocument } from '../../src/core/editor/rv-save-document';
import { createVariantsRuntime, type VariantsRuntime, type VariantsViewer } from '../../src/plugins/variants/variants-runtime';
import type { RvScene } from '../../src/core/hmi/scene/rv-scene-types';
import type { RVViewer } from '../../src/core/rv-viewer';
import type { ProjectBackend } from '../../src/core/project/backends/project-backend';
import {
  fakeGlb, installFakeDocumentProject, type FakeDocumentProject,
} from '../helpers/fake-document-project';

const DOC = { id: 'doc_variants', name: 'Cell', path: 'Cell.glb' };
type Json = { scenes: Array<{ extras?: { realvirtual?: Record<string, unknown> } }> };
const blockOf = (bytes: Uint8Array): unknown =>
  (parseGlbChunks(bytes).json as unknown as Json).scenes[0].extras?.realvirtual?.Variants;

function makeViewer() {
  const node = new Object3D();
  node.name = 'Cell';
  node.userData.realvirtual = { Transform: { x: 0 } };
  const root = new Object3D();
  root.add(node);
  const viewer = {
    availableModels: [] as unknown[], availablePublishedScenes: [],
    currentScene: null as RvScene | null, currentModelUrl: null as string | null,
    currentModelRoot: root, lastLoadResult: null,
    registry: {
      getGltfNodeNames: () => ['Cell'], getGltfNodeIndex: (path: string) => path === 'Cell' ? 0 : -1,
      getGltfLocation: (path: string) => path === 'Cell' ? { sourceKey: '', index: 0 } : null,
      getPathForNode: (n: Object3D) => n === node ? 'Cell' : null,
      getNode: (path: string) => path === 'Cell' ? node : null,
    },
    modes: { has: () => true, setMode: () => {} }, getPlugin: () => undefined,
    loadScene: async (scene: RvScene) => { viewer.currentScene = scene; },
    loadEmptyScene: async () => { viewer.currentScene = null; },
    markRenderDirty() {},
  };
  return viewer as unknown as RVViewer;
}

function makeVariants(): VariantStore {
  return new VariantStore({
    apply: async () => ({ ok: true, written: [], unresolved: [], captured: [] }),
    readBase: () => ({ kind: 'value', value: 10 }),
  });
}

function bindVariants(store: VariantStore): void {
  setVariantsSaveProvider({
    payload: () => store.snapshot(), dirty: () => store.dirty,
    markSaved: (payload) => store.markSaved(payload),
  });
}

async function layout(store: SceneStore, value: number): Promise<void> {
  await store.applyOp({
    id: `op_variant_save_${value}_${Math.random()}`, ts: Date.now(), schemaV: 1,
    kind: 'setField', nodePath: 'Cell', componentType: 'Transform', fieldName: 'x',
    value, prev: value - 1,
  } as never);
}

let project: FakeDocumentProject;
let scene: SceneStore;

async function open(bytes = fakeGlb('Cell')): Promise<void> {
  project = installFakeDocumentProject({ documents: [DOC], files: { [DOC.path]: bytes } });
  scene = new SceneStore(makeViewer());
  await scene.openDocument(DOC.id);
}

beforeEach(() => { localStorage.clear(); setVariantsSaveProvider(null); });
afterEach(() => {
  setVariantsSaveProvider(null);
  scene?.dispose();
  project?.restore();
  localStorage.clear();
});

describe('plan-2013 9.6 — normal document save includes variants', () => {
  it('routes variant Save through the normal document save, so its next layout save does not conflict', async () => {
    await open();
    let runtime: VariantsRuntime | null = null;
    const normalSave = vi.fn(() => saveDocument(null, scene));
    const runtimeViewer = makeViewer();
    try {
      runtime = createVariantsRuntime({
        viewer: () => runtimeViewer as unknown as VariantsViewer,
        documentLoadId: () => 'doc_variants',
        saveDocument: normalSave,
      });
      await runtime.bindDocument({ userData: {} }, { applyActive: false });
      runtime.create('Fast');

      await expect(runtime.save()).resolves.toMatchObject({ persistedTo: 'glb', revision: expect.any(Number) });
      expect(normalSave).toHaveBeenCalledTimes(1);
      await layout(scene, 1);
      await expect(scene.save()).resolves.toBe('saved');
    } finally {
      runtime?.dispose();
    }
  });

  it('reports session persistence when the normal document save is blocked by a read-only target', async () => {
    const runtimeViewer = makeViewer();
    const runtime = createVariantsRuntime({
      viewer: () => runtimeViewer as unknown as VariantsViewer,
      documentLoadId: () => 'read-only',
      saveDocument: async () => ({ kind: 'blocked', reason: 'This project is read-only.' }),
    });
    try {
      await runtime.bindDocument({ userData: {} }, { applyActive: false });
      runtime.create('Fast');
      await expect(runtime.save()).resolves.toMatchObject({ persistedTo: 'session', revision: expect.any(Number) });
    } finally {
      runtime.dispose();
    }
  });

  it('saves dirty variants into the GLB, marks exactly that snapshot clean, and is not a no-op', async () => {
    await open();
    const variants = makeVariants();
    const id = (variants.create('Fast') as { id: string }).id;
    await variants.set(id, { address: '#source', component: 'Source', field: 'Interval' }, 4);
    bindVariants(variants);

    expect(await scene.save()).toBe('saved');
    expect((blockOf(project.files.get(DOC.path)!) as { variants: unknown[] }).variants).toHaveLength(1);
    expect(variants.dirty).toBe(false);
  });

  it('keeps an edit made while the file write is in flight dirty', async () => {
    await open();
    const variants = makeVariants();
    variants.create('Fast');
    bindVariants(variants);
    const backend = project.backend as ProjectBackend & { writeDocument: ProjectBackend['writeDocument'] };
    const write = backend.writeDocument!.bind(backend);
    let release!: () => void;
    let entered!: () => void;
    const writing = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    backend.writeDocument = async (...args) => { entered(); await gate; return write(...args); };

    const saving = scene.save();
    await writing;
    variants.rename(variants.block.variants[0].id, 'Changed during save');
    release();
    expect(await saving).toBe('saved');
    expect(variants.dirty).toBe(true);
  });

  it('keeps a pre-existing block untouched when no runtime/provider is bound', async () => {
    const block = { version: 1, active: null, variants: [{ id: 'v1', name: 'Existing', revision: 0, overrides: [] }] };
    const source = (await bakeIntoGlb(fakeGlb('Cell'), materialise([]), { locate: () => null }, { variants: block })).glb;
    await open(source);
    await layout(scene, 1);

    expect(await scene.save()).toBe('saved');
    expect(blockOf(project.files.get(DOC.path)!)).toEqual(block);
  });

  it('leaves a block it could not read untouched although a runtime is bound (e.g. by variant.list)', async () => {
    const block = { version: 99, future: true };
    const source = (await bakeIntoGlb(fakeGlb('Cell'), materialise([]), { locate: () => null }, { variants: block })).glb;
    await open(source);
    let runtime: VariantsRuntime | null = null;
    const runtimeViewer = makeViewer();
    try {
      runtime = createVariantsRuntime({ viewer: () => runtimeViewer as unknown as VariantsViewer, documentLoadId: () => 'doc_variants' });
      await runtime.bindDocument({ userData: { realvirtual: { Variants: block } } }, { applyActive: false });
      await layout(scene, 1);

      expect(await scene.save()).toBe('saved');
      expect(blockOf(project.files.get(DOC.path)!)).toEqual(block);
    } finally {
      runtime?.dispose();
    }
  });

  it('re-supplies a clean block on later layout saves and keeps a removed block removed', async () => {
    await open();
    const variants = makeVariants();
    const id = (variants.create('Fast') as { id: string }).id;
    bindVariants(variants);
    await scene.save();
    expect(blockOf(project.files.get(DOC.path)!)).toBeDefined();

    await layout(scene, 1);
    await scene.save();
    expect(blockOf(project.files.get(DOC.path)!)).toBeDefined();

    await variants.remove(id);
    await scene.save();
    expect(blockOf(project.files.get(DOC.path)!)).toBeUndefined();
    await layout(scene, 2);
    await scene.save();
    expect(blockOf(project.files.get(DOC.path)!)).toBeUndefined();
  });

  it('includes variants in the existing unsaved-changes snapshot used by document switching', async () => {
    await open();
    const variants = makeVariants();
    bindVariants(variants);
    variants.create('Unsaved');
    scene.refreshExternalState();

    expect(scene.getSnapshot().dirty).toBe(true);
  });
});
