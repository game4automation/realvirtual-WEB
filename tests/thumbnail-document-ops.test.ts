// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-776 §9.3 — the thumbnail through every write a document goes through.
 *
 * A fake writable project (`helpers/fake-document-project.ts`, real CAS) and a
 * real WebGL renderer: the save sequence (F3), its failure rule (#10), the
 * pointer write (F4, P6), copy/duplicate/retire (F5), MCP replace (F6), the
 * delete-safety rule and the scene save through the scene store (P5).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The scene store's bake and body slots are not what this file is about — the
// same stand-ins `scene-save-as-name.test.ts` uses.
vi.mock('../src/core/hmi/scene/rv-scene-glb-io', () => ({
  readSceneGlbBody: async () => null,
  writeSceneGlbBody: async () => ({ revision: 'rev', target: 'opfs' }),
  dropSceneGlbBody: async () => {},
  sceneGlbBodyRevision: async () => null,
}));
vi.mock('../src/core/hmi/scene/rv-scene-glb-bake', () => ({
  bakeIntoGlb: async () => ({
    glb: new Uint8Array([0x67, 0x6c, 0x54, 0x46, 1, 2, 3, 4]), warnings: [], writtenReferences: [],
  }),
  makeRegistryBakeResolver: () => ({}),
  bakeRequiresFullPath: () => false,
}));
vi.mock('../src/core/hmi/scene/rv-scene-executors', () => ({
  applyForward: async () => undefined,
  applyInverse: async () => undefined,
  writeUserDataField: () => {},
  deleteUserDataField: () => {},
  reapplySchemaForComponent: () => {},
}));

import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Scene, WebGLRenderer } from 'three';
import {
  dropDocumentThumbnail,
  writeDocumentThumbnail,
  type ThumbnailViewer,
} from '../src/core/thumbnails/rv-thumbnail-write';
import { getProjectStore, resetProjectStore } from '../src/core/project/project-store';
import { duplicateDocument, retireDocument } from '../src/core/project/rv-document-ops';
import { copyDocumentAcrossSources } from '../src/core/library/library-asset-ops';
import { BrowserBackend } from '../src/core/project/backends/browser-backend';
import { SceneStore } from '../src/core/hmi/scene/scene-store';
import { clearAllScenes } from '../src/core/hmi/scene/rv-scene-storage';
import { clearAllDocumentAliases } from '../src/core/project/rv-doc-alias';
import { legacyThumbnailSidecarPath } from '../src/core/library/library-types';
import type { DocumentTransferSide } from '../src/core/project/rv-document-transfer';
import type { ProjectBackend } from '../src/core/project/backends/project-backend';
import type { RvDocumentEntry, RvProject } from '../src/core/project/rv-project-types';
import {
  documentHost,
  fakeGlb,
  installFakeDocumentProject,
  type FakeDocumentProject,
} from './helpers/fake-document-project';

const HASHED = /^\.thumbnails\/doc_a\.[0-9a-f]{8}\.webp$/;
const OLD = '.thumbnails/doc_a.11111111.webp';
const LEGACY = legacyThumbnailSidecarPath('doc_a');

function row(id: string, path: string, extra: Partial<RvDocumentEntry> = {}): RvDocumentEntry {
  return { id, path, name: id, ...extra } as RvDocumentEntry;
}

let renderer: WebGLRenderer;
let viewer: ThumbnailViewer;
let project: FakeDocumentProject;

function makeViewer(): ThumbnailViewer {
  const scene = new Scene();
  const root = new Group();
  root.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial({ color: 0x30a060 })));
  scene.add(root);
  scene.updateMatrixWorld(true);
  return { renderer, scene, currentModelRoot: root };
}

const rowOf = (id: string) => project.documents().find(d => d.id === id);
const sidecars = () => [...project.files.keys()].filter(p => p.startsWith('.thumbnails/'));

beforeEach(() => {
  localStorage.clear();
  resetProjectStore();
  renderer = new WebGLRenderer({ canvas: document.createElement('canvas'), alpha: true });
  viewer = makeViewer();
  project = installFakeDocumentProject({
    documents: [row('doc_a', 'models/A.glb', { thumbnail: OLD })],
    files: { [OLD]: new Uint8Array([1, 2, 3]), [LEGACY]: new Uint8Array([4]) },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  project.restore();
  resetProjectStore();
  renderer.dispose();
});

// ─── The save sequence (F3) ─────────────────────────────────────────────

describe('writeDocumentThumbnail — the save sequence', () => {
  it('writes the hashed WebP, points the row at it, deletes the previous and the legacy sidecar', async () => {
    const pointer = await writeDocumentThumbnail({
      viewer, store: getProjectStore(), backend: project.backend, documentId: 'doc_a',
    });
    expect(pointer).toMatch(HASHED);
    expect(project.files.has(pointer!)).toBe(true);
    expect(rowOf('doc_a')?.thumbnail).toBe(pointer);
    expect(project.files.has(OLD)).toBe(false);
    expect(project.files.has(LEGACY)).toBe(false);
  });

  it('a render that throws removes the pointer and the old sidecar — never a stale picture', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = new Group();
    broken.clone = () => { throw new Error('boom'); };
    const pointer = await writeDocumentThumbnail({
      viewer: { ...viewer, currentModelRoot: broken }, store: getProjectStore(), backend: project.backend,
      documentId: 'doc_a',
    });
    expect(pointer).toBeNull();
    expect(rowOf('doc_a')?.thumbnail).toBeUndefined();
    expect(project.files.has(OLD)).toBe(false);
    expect(sidecars()).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('every save path renders the same viewer document into the same sidecar shape (P5)', async () => {
    const pointer = await writeDocumentThumbnail({
      viewer, store: getProjectStore(), backend: project.backend, documentId: 'doc_a',
    });
    expect(pointer).toMatch(HASHED);
    expect(rowOf('doc_a')?.thumbnail).toBe(pointer);
  });

  it('an empty scene or a lost context writes nothing and removes the pointer (#10)', async () => {
    const empty: ThumbnailViewer = { renderer, scene: new Scene(), currentModelRoot: new Group() };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await writeDocumentThumbnail({
      viewer: empty, store: getProjectStore(), backend: project.backend, documentId: 'doc_a',
    })).toBeNull();
    expect(rowOf('doc_a')?.thumbnail).toBeUndefined();
    expect(sidecars()).toEqual([]);

    const lost = { getContext: () => ({ isContextLost: () => true }) };
    expect(await writeDocumentThumbnail({
      viewer: { ...viewer, renderer: lost }, store: getProjectStore(), backend: project.backend,
      documentId: 'doc_a',
    })).toBeNull();
    expect(sidecars()).toEqual([]);
  });

  it('a read-only backend or a document without a row: no render, no pointer write, no throw', async () => {
    const ro = { ...project.backend, writable: false } as ProjectBackend;
    const writesBefore = project.writes.length;
    expect(await writeDocumentThumbnail({
      viewer, store: getProjectStore(), backend: ro, documentId: 'doc_a',
    })).toBeNull();
    expect(await writeDocumentThumbnail({
      viewer, store: getProjectStore(), backend: project.backend, documentId: 'doc_nope',
    })).toBeNull();
    expect(project.writes.length).toBe(writesBefore);
    expect(rowOf('doc_a')?.thumbnail).toBe(OLD);
  });

  it('Safari fallback: an encoder that answers PNG writes .png and deletes the previous .webp', async () => {
    const original = HTMLCanvasElement.prototype.toBlob;
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
      this: HTMLCanvasElement, cb: BlobCallback,
    ) {
      original.call(this, cb, 'image/png');   // asked for WebP, hands back PNG
    });
    const pointer = await writeDocumentThumbnail({
      viewer, store: getProjectStore(), backend: project.backend, documentId: 'doc_a',
    });
    expect(pointer).toMatch(/^\.thumbnails\/doc_a\.[0-9a-f]{8}\.png$/);
    expect(project.files.has(OLD)).toBe(false);
  });

  it('delete safety: a hand-edited pointer to a GLB or a URL is never deleted', async () => {
    project.files.set('models/x.glb', fakeGlb('x'));
    for (const foreign of ['../models/x.glb', 'models/x.glb', 'https://cdn.example/a.webp']) {
      await getProjectStore().setDocumentThumbnail('doc_a', foreign);
      await writeDocumentThumbnail({
        viewer, store: getProjectStore(), backend: project.backend, documentId: 'doc_a',
      });
    }
    expect(project.files.has('models/x.glb')).toBe(true);
  });

  it('delete safety: the same id in another source is never touched by a save here', async () => {
    const other = installFakeDocumentProject({
      id: 'prj_other',
      documents: [row('doc_a', 'models/A.glb', { thumbnail: OLD })],
      files: { [OLD]: new Uint8Array([9]) },
    });
    const otherFiles = other.files;
    other.restore();
    project = installFakeDocumentProject({
      documents: [row('doc_a', 'models/A.glb', { thumbnail: OLD })],
      files: { [OLD]: new Uint8Array([1]) },
    });
    await writeDocumentThumbnail({
      viewer, store: getProjectStore(), backend: project.backend, documentId: 'doc_a',
    });
    expect(project.files.has(OLD)).toBe(false);
    expect(otherFiles.has(OLD)).toBe(true);
  });
});

// ─── The pointer write (F4, P6, R-05) ───────────────────────────────────

describe('setDocumentThumbnail — one merging manifest write', () => {
  it('survives an interleaved adopt stat delta, in memory and on disk', async () => {
    const store = getProjectStore();
    const ptr = '.thumbnails/doc_a.22222222.webp';
    await Promise.all([
      store.setDocumentThumbnail('doc_a', ptr),
      store.applyManifestDelta(current => ({
        ...current,
        documents: (current.documents ?? []).map(d => (d.id === 'doc_a' ? { ...d, sizeBytes: 42 } : d)),
      })),
    ]);
    const onDisk = (await project.backend.readManifest())!.documents!.find(d => d.id === 'doc_a')!;
    expect(onDisk.thumbnail).toBe(ptr);
    expect((onDisk as RvDocumentEntry).sizeBytes).toBe(42);
    expect(rowOf('doc_a')?.thumbnail).toBe(ptr);
  });

  it('survives a rescan in both orders', async () => {
    const store = getProjectStore();
    await store.setDocumentThumbnail('doc_a', '.thumbnails/doc_a.33333333.webp');
    await store.rescanDocuments();
    expect(store.getSnapshot().documents.find(d => d.id === 'doc_a')?.thumbnail)
      .toBe('.thumbnails/doc_a.33333333.webp');
    await store.rescanDocuments();
    await store.setDocumentThumbnail('doc_a', '.thumbnails/doc_a.44444444.webp');
    expect(store.getSnapshot().documents.find(d => d.id === 'doc_a')?.thumbnail)
      .toBe('.thumbnails/doc_a.44444444.webp');
    expect((await project.backend.readManifest())!.documents!.find(d => d.id === 'doc_a')!.thumbnail)
      .toBe('.thumbnails/doc_a.44444444.webp');
  });

  it('a metadata rewrite keeps the pointer (F6: classify spreads the row)', async () => {
    const store = getProjectStore();
    project.files.set('models/A.glb', fakeGlb('A'));
    await store.setDocumentThumbnail('doc_a', OLD);   // publishes the row
    await store.rescanDocuments();                    // the captured rows the verb updates
    await store.setDocumentClassification('doc_a', { v: 1, level: 'assembly', tags: ['x'] });
    // The display rows (what the cards read): classification changed, pointer kept.
    const shown = store.getSnapshot().documents.find(d => d.id === 'doc_a');
    expect(shown?.classification).toBeDefined();
    expect(shown?.thumbnail).toBe(OLD);
    expect(rowOf('doc_a')?.thumbnail).toBe(OLD);
  });

  it('a browser project persists the pointer in its stored manifest — it survives a reload', async () => {
    project.restore();
    const backend = new BrowserBackend('prj_776_browser', { requestPersistence: false });
    await backend.activate();
    const manifest: RvProject = {
      schemaVersion: 3, id: 'prj_776_browser', name: 'B', documents: [row('doc_b', 'B.glb')],
    } as RvProject;
    await backend.writeManifest(manifest);
    const privates = getProjectStore() as unknown as { _backend: ProjectBackend | null; _project: RvProject | null };
    privates._backend = backend;
    privates._project = manifest;
    await getProjectStore().setDocumentThumbnail('doc_b', '.thumbnails/doc_b.55555555.webp');

    const reloaded = new BrowserBackend('prj_776_browser', { requestPersistence: false });
    const rows = (await reloaded.readManifest())!.documents!;
    expect(rows.find(d => d.id === 'doc_b')?.thumbnail).toBe('.thumbnails/doc_b.55555555.webp');
    privates._backend = null;
    privates._project = null;
  });
});

// ─── Document ops (F5, F6) ──────────────────────────────────────────────

describe('document ops — copy the bytes, delete the file, never carry a pointer', () => {
  it('duplicate gets its own sidecar and pointer; retire deletes the sidecar', async () => {
    const target = await duplicateDocument(documentHost(), 'doc_a');
    const copy = rowOf(target.documentId)!;
    expect(copy.thumbnail).toMatch(/^\.thumbnails\/.+\.11111111\.webp$/);
    expect(copy.thumbnail).not.toBe(OLD);
    expect(project.files.has(copy.thumbnail!)).toBe(true);

    await retireDocument(documentHost(), target.documentId);
    expect(project.files.has(copy.thumbnail!)).toBe(false);
    expect(project.files.has(OLD)).toBe(true);        // the source keeps its own
  });

  it('a cross-source copy whose sidecar copy fails lands WITHOUT a pointer (R-06)', async () => {
    const glb = fakeGlb('A');
    const side = (label: string, files: Map<string, Uint8Array>, rows: RvDocumentEntry[]): DocumentTransferSide => ({
      label, backendId: label, writable: true,
      async readDocumentUrl(p: string) {
        const bytes = files.get(p);
        if (!bytes) return null;
        const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
        return { url, release: () => URL.revokeObjectURL(url) };
      },
      async writeDocument(p: string, bytes: Uint8Array) { files.set(p, bytes); return { revision: 'r' }; },
      async deleteDocument(p: string) { files.delete(p); },
      async listDocuments() { return rows; },
      async updateManifestEntry(apply) { rows.splice(0, rows.length, ...apply(rows)); return true; },
    });
    // The source names a sidecar it does NOT have.
    const sourceFiles = new Map([['library/A.glb', glb]]);
    const targetFiles = new Map<string, Uint8Array>();
    const targetRows: RvDocumentEntry[] = [];
    const doc = row('doc_a', 'library/A.glb', { thumbnail: OLD });
    const result = await copyDocumentAcrossSources(
      { source: side('src', sourceFiles, [doc]), target: side('dst', targetFiles, targetRows), close: async () => {} },
      doc,
    );
    expect(result.kind).toBe('ok');
    expect(targetRows).toHaveLength(1);
    expect(targetRows[0].thumbnail).toBeUndefined();
  });

  it('an MCP replace of a document that is not loaded drops the pointer and deletes the sidecar', async () => {
    await dropDocumentThumbnail({ store: getProjectStore(), backend: project.backend, documentId: 'doc_a' });
    expect(rowOf('doc_a')?.thumbnail).toBeUndefined();
    expect(project.files.has(OLD)).toBe(false);
  });
});

// ─── The scene store (F3 hook points) ───────────────────────────────────

describe('SceneStore — saveAs renders, rename does not', () => {
  function makeSceneViewer() {
    const v = {
      ...viewer,
      loadScenes: [] as unknown[],
      availableModels: [],
      availablePublishedScenes: [],
      currentScene: null as unknown,
      currentModelUrl: null as string | null,
      registry: {
        getGltfNodeNames: () => [], getGltfNodeIndex: () => -1,
        getPathForNode: () => null, getNode: () => null, getComponentsAt: () => [],
      },
      lastLoadResult: null,
      modes: { has: () => true, setMode: () => {} },
      getPlugin: () => undefined,
      loadScene: async (s: unknown) => { v.currentScene = s; },
      loadEmptyScene: async () => { v.currentScene = null; },
    };
    return v;
  }

  beforeEach(() => {
    clearAllScenes();
    clearAllDocumentAliases();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(new ArrayBuffer(8), { status: 200 }));
  });

  it('saveAs (the _createDocument path) writes a sidecar + pointer and refreshes by publish alone', async () => {
    const urlBefore = window.location.href;
    const store = new SceneStore(makeSceneViewer() as unknown as ConstructorParameters<typeof SceneStore>[0]);
    let published = 0;
    const off = getProjectStore().subscribe(() => { published++; });
    try {
      await store.openEmpty();
      const id = await store.saveAs('Thumb Scene');
      const saved = rowOf(id)!;
      expect(saved.thumbnail).toMatch(/^\.thumbnails\/.+\.[0-9a-f]{8}\.webp$/);
      expect(project.files.has(saved.thumbnail!)).toBe(true);
      expect(published).toBeGreaterThan(0);

      // rename() is a byte copy under a new path — the id-keyed sidecar needs nothing.
      const before = sidecars().length;
      await store.rename(id, 'Renamed Scene');
      expect(sidecars().length).toBe(before);
      expect(rowOf(id)?.thumbnail).toBe(saved.thumbnail);
    } finally {
      off();
      clearAllScenes();
      window.history.replaceState(window.history.state, '', urlBefore);
    }
  });
});
