// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-780 R6 / 9.4 — a save into library B regenerates the document's
 * thumbnail INTO B, through B's backend (`finishLibraryDocumentSave` ←
 * `saveDocument`):
 *
 *  - the stale sidecar B's row pointed at is replaced: new sidecar written in
 *    B, B's row points at it, the old file is gone;
 *  - a thumbnail failure never fails the save, and never touches the open
 *    project A (no sidecar, no row change in A).
 *
 * The real thumbnail writer runs; only the GPU render and the image encode are
 * stood in (`thumbnail-renderer`, `rv-thumbnail-encode`).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Mesh, Object3D, Scene } from 'three';

const h = vi.hoisted(() => ({ store: null as unknown, encodeFails: false, renders: 0 }));

vi.mock('../src/core/project/project-store', () => ({
  getProjectStore: () => h.store,
}));

vi.mock('../src/core/editor/rv-asset-glb-export', async (original) => {
  const actual = await original<typeof import('../src/core/editor/rv-asset-glb-export')>();
  return {
    ...actual,
    exportAssetGlb: async (_root: unknown, name?: string) => new TextEncoder().encode(`GLB:${name}`).buffer,
  };
});

vi.mock('../src/core/thumbnails/thumbnail-renderer', () => ({
  ThumbnailRenderer: class {
    async render(): Promise<HTMLCanvasElement> {
      h.renders++;
      const canvas = document.createElement('canvas');
      canvas.width = 4; canvas.height = 4;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#f00';
      ctx.fillRect(0, 0, 4, 4);
      return canvas;
    }
    dispose(): void {}
  },
}));

vi.mock('../src/core/thumbnails/rv-thumbnail-encode', () => ({
  THUMBNAIL_WEBP_QUALITY: 0.85,
  encodeThumbnail: async () => {
    if (h.encodeFails) throw new Error('encoder exploded');
    return { bytes: new TextEncoder().encode('NEW-PICTURE'), ext: 'webp', hash8: '1234abcd' };
  },
}));

import { FolderBackend } from '../src/core/project/backends/folder-backend';
import type { ProjectBackend } from '../src/core/project/backends/project-backend';
import type { RvProject } from '../src/core/project/rv-project-types';
import { LibraryProjectLoader, setLibraryProjectLoader } from '../src/core/library/library-project-loader';
import { installLibraryProjectsProvider, uninstallLibraryProjectsProvider } from '../src/core/library/library-projects-provider';
import { resetLibrarySourceRegistryForTests } from '../src/core/library/library-source-registry';
import {
  grantLibraryWrite,
  libraryDocumentBaseOf,
  librarySaveBackend,
  releaseLibraryWriteGrants,
} from '../src/core/library/library-document-edit';
import { forgetSavedRevisions, noteLoadedRevision, saveDocument } from '../src/core/editor/rv-save-document';
import type { AssetBase } from '../src/core/editor/rv-asset-document';
import { thumbnailSidecarPath } from '../src/core/library/library-types';
import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';
import { fakeGlb } from './helpers/fake-document-project';

const idleTail = Promise.resolve();

const PUMP = 'models/pump';
const PATH = 'models/pump.glb';
const STALE = thumbnailSidecarPath(PUMP, 'deadbeef', 'webp');
const FRESH = thumbnailSidecarPath(PUMP, '1234abcd', 'webp');

/** The text of the file at `rel` (e.g. `.thumbnails/x.webp`) inside `root`, or null. */
async function fileAt(root: FakeDir, rel: string): Promise<string | null> {
  const parts = rel.split('/');
  let dir: FakeDir = root;
  for (const p of parts.slice(0, -1)) {
    if (!dir.has(p)) return null;
    dir = await dir.getDirectoryHandle(p);
  }
  return dir.readText(parts[parts.length - 1]);
}

async function rowOf(dir: FakeDir): Promise<Record<string, unknown>> {
  const m = JSON.parse((await dir.readText('project.json'))!) as { documents: Array<Record<string, unknown>> };
  return m.documents.find((d) => d.id === PUMP)!;
}

/** A (open, writable) holds its own `models/pump`; B (library) holds the same id with a STALE thumbnail. */
async function world(): Promise<{ a: FakeDir; b: FakeDir; aManifest: string }> {
  const a = new FakeDir('Shared');
  a.seedText('project.json', JSON.stringify({
    schemaVersion: 2, id: 'prj_a', name: 'Plant A', canonicalName: 'a', createdAt: 'x', modifiedAt: 'x',
    libraries: [{ projectId: 'prj_b' }],
    documents: [{ id: PUMP, path: PATH, name: 'Local pump' }],
  }));
  a.seedDir('models').seedBytes('pump.glb', fakeGlb('a:pump'));
  const aBackend = new FolderBackend(asDirHandle(a), { writable: true });
  await aBackend.activate();

  const b = new FakeDir('Shared');
  b.seedText('project.json', JSON.stringify({
    schemaVersion: 2, id: 'prj_b', name: 'SharedConveyors', canonicalName: 'shared', createdAt: 'x', modifiedAt: 'x',
    documents: [{ id: PUMP, path: PATH, name: 'Pump', thumbnail: STALE }],
  }));
  b.seedDir('models').seedBytes('pump.glb', fakeGlb('b:pump'));
  const [staleDir, staleName] = [STALE.slice(0, STALE.lastIndexOf('/')), STALE.slice(STALE.lastIndexOf('/') + 1)];
  b.seedDir(staleDir).seedText(staleName, 'OLD-PICTURE');
  b.permissions.readwrite = 'prompt';

  const loader = new LibraryProjectLoader({
    factory: {
      folder: (handle, id) => new FolderBackend(handle, { writable: false, id: `folder:${id}` }),
      browser: () => null,
      remote: () => null as unknown as ProjectBackend,
    },
    getLinkedHandle: async (id) => (id === 'prj_b' ? asDirHandle(b) : null),
    hasReadPermission: async () => true,
    builtinBaseUrl: () => null,
  });
  setLibraryProjectLoader(loader);
  installLibraryProjectsProvider(loader);
  const aManifest = (await a.readText('project.json'))!;
  const project = JSON.parse(aManifest) as RvProject;
  loader.setProject(project);
  await loader.whenSettled();
  h.store = { getBackend: () => aBackend, getProject: () => project };
  return { a, b, aManifest };
}

function makeDoc(base: AssetBase) {
  const doc = {
    name: 'Pump', base, dirty: true, lockOwner: null, isBound: false,
    tryLock: () => ({ kind: 'save', token: Symbol('stub'), generation: 1 }),
    unlock: () => {},
    renameDocument: (n: string) => { doc.name = n; },
    document: { whenIdle: () => idleTail, opCount: 2, runExclusive: <T>(w: () => Promise<T>) => w(), markSaved: () => {} },
    async markSaved(next: AssetBase) { doc.base = next; doc.dirty = false; },
  };
  return doc;
}

/** A viewer the thumbnail writer can render: renderer with a live context, a scene, a drawable root. */
function renderableViewer() {
  const root = new Object3D(); root.name = 'Pump';
  root.add(new Mesh());
  return {
    renderer: { getContext: () => ({ isContextLost: () => false }) },
    scene: new Scene(),
    currentModelRoot: root,
    emit: () => {},
    getPlugin: () => undefined,
  };
}

async function saveIntoB(): Promise<{ kind: string }> {
  const base = libraryDocumentBaseOf('prj_b', PUMP)!;
  await noteLoadedRevision(librarySaveBackend('prj_b'), PATH);
  expect((await grantLibraryWrite('prj_b')).ok).toBe(true);
  return saveDocument(renderableViewer() as never, makeDoc(base) as never) as Promise<{ kind: string }>;
}

afterEach(() => {
  forgetSavedRevisions();
  releaseLibraryWriteGrants();
  uninstallLibraryProjectsProvider();
  resetLibrarySourceRegistryForTests();
  setLibraryProjectLoader(null);
  h.store = null;
  h.encodeFails = false;
  h.renders = 0;
});

describe('plan-780 R6 — a library save regenerates the thumbnail into B', () => {
  it('the stale sidecar is replaced: new picture in B, B\'s row points at it, the old file is gone; A is untouched', async () => {
    const w = await world();
    const result = await saveIntoB();
    expect(result.kind, JSON.stringify(result)).toBe('saved');
    expect(h.renders).toBe(1);

    expect(await fileAt(w.b, FRESH)).toBe('NEW-PICTURE');
    expect((await rowOf(w.b)).thumbnail).toBe(FRESH);
    expect(await fileAt(w.b, STALE)).toBeNull();

    // A: same id, same path — nothing of the save describes it.
    expect(await w.a.readText('project.json')).toBe(w.aManifest);
    expect(await fileAt(w.a, FRESH)).toBeNull();
    expect(await fileAt(w.a, 'models/pump.glb')).toBe(new TextDecoder().decode(fakeGlb('a:pump')));
  });

  it('a thumbnail failure does not fail the save and does not touch A', async () => {
    const w = await world();
    h.encodeFails = true;
    const result = await saveIntoB();
    expect(result.kind, JSON.stringify(result)).toBe('saved');
    // The bytes are in B either way.
    expect(await fileAt(w.b, PATH)).toBe('GLB:Pump');
    // No new picture; the stale pointer no longer claims to describe the file.
    expect(await fileAt(w.b, FRESH)).toBeNull();
    expect((await rowOf(w.b)).thumbnail).toBeUndefined();

    expect(await w.a.readText('project.json')).toBe(w.aManifest);
    expect(await fileAt(w.a, FRESH)).toBeNull();
  });
});
