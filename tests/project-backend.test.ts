// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * project-backend.test — plan-372 §9.1.
 *
 * One contract, several implementations. What is pinned here:
 *
 *  - the bundled backend is `writable === false` and every write method throws;
 *  - it yields a complete project with **no** filesystem API present at all —
 *    the Safari/Firefox/iPad proof, simulated inside Chromium by removing
 *    `showDirectoryPicker` (see §9.25 for what that does and does not show);
 *  - the folder backend behaves like the former `FolderReadProvider`;
 *  - renaming `kind` from `'http'` to `'bundled'` breaks no caller of the
 *    read surface.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';
import { glbWrite } from './helpers/scene-write';
import {
  BundledBackend,
  publishedSceneId,
  SAMPLE_PROJECT_ID,
} from '../src/core/project/backends/bundled-backend';
import { FolderBackend } from '../src/core/project/backends/folder-backend';
import {
  assertWritable,
  BackendNotWritableError,
  type ProjectBackend,
  type ProjectReadProvider,
} from '../src/core/project/backends/project-backend';
import { isSupported } from '../src/core/engine/rv-local-filesystem';
import { sceneGlbRelPathFor, type RvProject } from '../src/core/project/rv-project-types';
import {
  assetDocumentsOf,
  sceneDocumentsOf,
} from '../src/core/project/rv-project-documents';
import type { RvScene } from '../src/core/hmi/scene/rv-scene-types';

// ─── Fixtures ───────────────────────────────────────────────────────────

const scene = (id: string, name: string): RvScene => ({
  id,
  name,
  createdAt: '2025-01-01T00:00:00.000Z',
  modifiedAt: '2025-01-01T00:00:00.000Z',
  schemaVersion: 3,
  base: { kind: 'empty' },
  edits: { ops: [], settings: { catalogUrls: [], gridSizeMm: 500 } },
});

function folderWith(scenes: RvScene[] = []): FakeDir {
  const root = new FakeDir('customer');
  const manifest: RvProject = {
    schemaVersion: 1,
    id: 'prj_folder',
    name: 'Customer',
    scenes: scenes.map(s => ({ id: s.id, name: s.name, path: sceneGlbRelPathFor(s) })),
    models: [{ path: 'models/press.glb', label: 'Press' }],
    library: [{ path: 'library/Custom/gripper.glb' }],
  };
  root.seedText('project.json', JSON.stringify(manifest));
  const dir = root.seedDir('scenes');
  for (const s of scenes) dir.seedText(sceneGlbRelPathFor(s).split('/')[1]!, JSON.stringify(s));
  return root;
}

/**
 * Minimal fetch double serving a fixed path map.
 *
 * `arrayBuffer` matters now: since plan-413 phase 6 a scene body is fetched as
 * bytes and there is no JSON branch left to fall back to.
 */
function fakeFetch(files: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const key = Object.keys(files).find(k => url.endsWith(k));
    if (!key) {
      return {
        ok: false, status: 404,
        json: async () => null,
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as Response;
    }
    const value = files[key];
    return {
      ok: true, status: 200,
      json: async () => value,
      arrayBuffer: async () =>
        new TextEncoder().encode(
          typeof value === 'string' ? value : JSON.stringify(value),
        ).buffer,
    } as unknown as Response;
  }) as typeof fetch;
}

// ─── Bundled ────────────────────────────────────────────────────────────

describe('BundledBackend', () => {
  it('is never writable and reports kind bundled', () => {
    const b = new BundledBackend({ fetchImpl: fakeFetch({}) });
    expect(b.kind).toBe('bundled');
    expect(b.writable).toBe(false);
  });

  it('throws from every write method', async () => {
    const b = new BundledBackend({ fetchImpl: fakeFetch({}) });
    await expect(b.writeScene()).rejects.toBeInstanceOf(BackendNotWritableError);
    await expect(b.deleteScene()).rejects.toBeInstanceOf(BackendNotWritableError);
    await expect(b.writeBlob()).rejects.toBeInstanceOf(BackendNotWritableError);
  });

  it('activating it does not make it writable', async () => {
    const b = new BundledBackend({ fetchImpl: fakeFetch({}) });
    await b.activate();
    expect(b.isActive).toBe(true);
    await expect(b.writeScene()).rejects.toBeInstanceOf(BackendNotWritableError);
  });

  it('synthesises the Sample manifest when the deploy has no project.json', async () => {
    const b = new BundledBackend({
      fetchImpl: fakeFetch({}),
      models: [{ url: '/models/Demo.glb', label: 'Demo' }],
      publishedScenes: [
        { file: 'DemoPlanner.scene.glb', urlName: 'DemoPlanner', label: 'Demo Planner' },
      ],
    });
    const p = await b.readManifest();
    expect(p?.id).toBe(SAMPLE_PROJECT_ID);
    expect(assetDocumentsOf(p, 'models')[0]?.label).toBe('Demo');
    expect(sceneDocumentsOf(p)[0]?.id).toBe(publishedSceneId('DemoPlanner'));
    expect(sceneDocumentsOf(p)[0]?.path).toBe('scenes/DemoPlanner.scene.glb');
  });

  it('published scene ids are stable across instances', async () => {
    const make = () => new BundledBackend({
      fetchImpl: fakeFetch({}),
      publishedScenes: [{ file: 'A.scene.glb', urlName: 'A', label: 'A' }],
    });
    const first = sceneDocumentsOf(await make().readManifest())[0]?.id;
    const second = sceneDocumentsOf(await make().readManifest())[0]?.id;
    expect(first).toBe(second);
  });

  it('prefers a deployed project.json and keeps its own sections', async () => {
    const b = new BundledBackend({
      fetchImpl: fakeFetch({
        'project.json': {
          schemaVersion: 1,
          id: 'prj_customer_deploy',
          name: 'CustomerX',
          models: [{ path: 'models/Line.glb', label: 'Line' }],
        },
      }),
      models: [{ url: '/models/Demo.glb', label: 'Demo' }],
    });
    const p = await b.readManifest();
    expect(p?.id).toBe('prj_customer_deploy');
    // A deploy manifest is foreign and unconverted; its legacy arrays are
    // derived into documents on the way in and dropped afterwards.
    expect(assetDocumentsOf(p, 'models')).toMatchObject([
      { path: 'models/Line.glb', label: 'Line' },
    ]);
    expect((p as Record<string, unknown>).models).toBeUndefined();
  });

  it('fills the sections a deploy manifest leaves empty', async () => {
    const b = new BundledBackend({
      fetchImpl: fakeFetch({
        'project.json': { schemaVersion: 1, id: 'prj_deploy', name: 'Deploy' },
      }),
      models: [{ url: '/models/Demo.glb', label: 'Demo' }],
    });
    expect((await b.listModels())[0]?.label).toBe('Demo');
  });

  it('reads a scene body over fetch as bytes, and refuses a JSON path', async () => {
    const b = new BundledBackend({
      fetchImpl: fakeFetch({ 'scenes/x.scene.glb': 'glb:scn_x' }),
    });
    const record = await b.readScene('scenes/x.scene.glb');
    expect(new TextDecoder().decode(record!.glb)).toBe('glb:scn_x');
    // F10: a deploy that still publishes `.scene.json` is told so, rather than
    // being served a body nothing downstream can read.
    await expect(b.readScene('scenes/junk.json')).rejects.toThrow(/6\.3\.16/);
  });

  it('resolves a blob url with nothing to revoke', async () => {
    const b = new BundledBackend({ baseUrl: '/app/', fetchImpl: fakeFetch({}) });
    const resolved = await b.readBlobUrl('models/A.glb');
    expect(resolved?.url).toBe('/app/models/A.glb');
    expect(() => resolved?.release()).not.toThrow();
  });

  it('leaves an absolute url alone', async () => {
    const b = new BundledBackend({ baseUrl: '/app/', fetchImpl: fakeFetch({}) });
    const resolved = await b.readBlobUrl('https://cdn.example/x.glb');
    expect(resolved?.url).toBe('https://cdn.example/x.glb');
  });

  it('a missing deploy file is not an error', async () => {
    const b = new BundledBackend({ fetchImpl: fakeFetch({}) });
    expect(await b.readSettings()).toBeNull();
  });
});

// ─── The Safari/Firefox proof ───────────────────────────────────────────

describe('BundledBackend without a filesystem API', () => {
  let saved: unknown;

  beforeEach(() => {
    saved = (window as unknown as Record<string, unknown>).showDirectoryPicker;
    delete (window as unknown as Record<string, unknown>).showDirectoryPicker;
  });

  afterEach(() => {
    if (saved !== undefined) {
      (window as unknown as Record<string, unknown>).showDirectoryPicker = saved;
    }
  });

  it('isSupported() is false — the branch under test is the non-Chromium one', () => {
    expect(isSupported()).toBe(false);
  });

  it('still yields a full project, so no browser is left without one', async () => {
    const b = new BundledBackend({
      fetchImpl: fakeFetch({}),
      models: [{ url: '/models/Demo.glb', label: 'Demo' }],
      publishedScenes: [{ file: 'A.scene.glb', urlName: 'A', label: 'A' }],
    });
    expect(await b.readManifest()).not.toBeNull();
    expect(sceneDocumentsOf(await b.readManifest())).toHaveLength(1);
    expect(await b.listModels()).toHaveLength(1);
    await b.activate();
    expect(b.isActive).toBe(true);
  });
});

// ─── Folder ─────────────────────────────────────────────────────────────

describe('FolderBackend', () => {
  it('reads manifest, scene and settings like the former FolderReadProvider', async () => {
    const s = scene('scn_a', 'A');
    const root = folderWith([s]);
    root.seedDir('settings').seedText(
      'project-settings.json',
      JSON.stringify({ $schema: 'rv-settings-bundle/1.0' }),
    );
    const b = new FolderBackend(asDirHandle(root), { writable: true });

    expect((await b.readManifest())?.id).toBe('prj_folder');
    expect(new TextDecoder().decode((await b.readScene(sceneGlbRelPathFor(s)))!.glb))
      .toContain('scn_a');
    expect(await b.readSettings()).toEqual({ $schema: 'rv-settings-bundle/1.0' });
    expect(b.kind).toBe('folder');
  });

  it('lists scenes from the manifest', async () => {
    const b = new FolderBackend(asDirHandle(folderWith([scene('scn_a', 'A')])), { writable: true });
    expect((sceneDocumentsOf(await b.readManifest())).map(e => e.id)).toEqual(['scn_a']);
  });

  // The library is a tree living NEXT TO models/, and it is walked recursively:
  // its folders are what the provider turns into collection chips.
  it('walks the library tree recursively, ignoring non-assets and sidecars', async () => {
    const root = folderWith([scene('scn_a', 'A')]);
    const library = root.seedDir('library');
    library.seedText('catalog.json', '{}');                        // not an asset
    library.seedDir('Custom').seedText('gripper.glb', 'GLB');
    library.seedDir('PalletHandling').seedText('Pallet.glb', 'GLB');
    library.seedDir('.thumbnails').seedText('Pallet.png', 'PNG');  // sidecar
    root.seedDir('models').seedText('press.glb', 'GLB');           // a model, not library
    const b = new FolderBackend(asDirHandle(root), { writable: true });

    expect((await b.listLibrary()).map(e => e.path)).toEqual([
      'library/Custom/gripper.glb',
      'library/PalletHandling/Pallet.glb',
    ]);
  });

  it('reads a blob several folders deep', async () => {
    const root = folderWith();
    root.seedDir('library').seedDir('PalletHandling').seedText('Pallet.glb', 'GLB');
    const b = new FolderBackend(asDirHandle(root), { writable: true });
    const resolved = await b.readBlobUrl('library/PalletHandling/Pallet.glb');
    expect(resolved?.url.startsWith('blob:')).toBe(true);
    resolved?.release();
  });

  // Models are folder-driven: dropping a GLB into models/ IS adding it to the
  // project, and a manifest entry only decorates the file it names.
  it('lists models from the models/ folder, with the manifest as metadata', async () => {
    const root = folderWith([scene('scn_a', 'A')]);
    const models = root.seedDir('models');
    models.seedText('press.glb', 'GLB');
    models.seedText('undeclared.glb', 'GLB');
    models.seedText('notes.txt', 'text');            // non-GLB — never a model
    models.seedDir('library').seedText('part.glb', 'GLB');  // catalog, not a base model
    const b = new FolderBackend(asDirHandle(root), { writable: true });

    const listed = await b.listModels();
    expect(listed.map(e => e.path)).toEqual(['models/press.glb', 'models/undeclared.glb']);
    // The manifest declares models/press.glb; its label rides along.
    expect(listed.find(e => e.path === 'models/press.glb')?.label).toBeDefined();
  });

  it('drops a manifest model whose file is gone, rather than listing a phantom', async () => {
    const b = new FolderBackend(asDirHandle(folderWith([scene('scn_a', 'A')])), { writable: true });
    // The fixture manifest names models/press.glb but seeds no models/ folder.
    expect(await b.listModels()).toEqual([]);
  });

  it('an unreadable manifest yields null, not a throw', async () => {
    const b = new FolderBackend(asDirHandle(new FakeDir('empty')), { writable: true });
    expect(await b.readManifest()).toBeNull();
    expect(sceneDocumentsOf(await b.readManifest())).toEqual([]);
  });

  it('resolves and releases an object url for a blob', async () => {
    const root = folderWith();
    root.seedDir('models').seedText('press.glb', 'GLB');
    const b = new FolderBackend(asDirHandle(root), { writable: true });
    const resolved = await b.readBlobUrl('models/press.glb');
    expect(resolved?.url.startsWith('blob:')).toBe(true);
    expect(() => resolved?.release()).not.toThrow();
    expect(await b.readBlobUrl('models/missing.glb')).toBeNull();
  });

  it('a read-only folder refuses writes even once active', async () => {
    const b = new FolderBackend(asDirHandle(folderWith()), { writable: false });
    await b.activate();
    await expect(b.writeScene('scenes/a.scene.glb', glbWrite('scn_a', 'A')))
      .rejects.toBeInstanceOf(BackendNotWritableError);
  });
});

// ─── The shared contract ────────────────────────────────────────────────

describe('contract', () => {
  it('every backend satisfies ProjectBackend and the read surface', async () => {
    const backends: ProjectBackend[] = [
      new BundledBackend({ fetchImpl: fakeFetch({}) }),
      new FolderBackend(asDirHandle(folderWith()), { writable: true }),
    ];
    for (const b of backends) {
      // A read-only consumer sees exactly the members it always saw — this is
      // the assignment that would fail if `kind` had been narrowed wrongly.
      const reader: ProjectReadProvider = b;
      expect(typeof reader.readManifest).toBe('function');
      expect(typeof reader.readScene).toBe('function');
      expect(typeof reader.readSettings).toBe('function');
      expect(['bundled', 'browser', 'folder']).toContain(reader.kind);
      expect(typeof b.id).toBe('string');
      expect(b.isActive).toBe(false);
      await expect(b.flush()).resolves.toBeUndefined();
    }
  });

  it('assertWritable tells the two refusal reasons apart', () => {
    expect(() => assertWritable({ id: 'x', writable: false, isActive: true })).toThrow(/read-only/);
    expect(() => assertWritable({ id: 'x', writable: true, isActive: false })).toThrow(/not active/);
    expect(() => assertWritable({ id: 'x', writable: true, isActive: true })).not.toThrow();
  });
});

// Libraries are explicit-only: no boot path reads the deploy catalog on its
// own. `listLibrary` returns exactly what a deployed manifest declares as
// `library[]` — a deploy that declares nothing has no library, even when a
// `library/catalog.json` sits on the deploy root.
describe('BundledBackend library', () => {
  const catalog = {
    entries: [
      { id: 'a', name: 'Roll Conveyor 1m', glbUrl: 'PalletHandling/RollConveyor-1m.glb' },
      { id: 'b', name: 'Turntable', glbUrl: 'PalletHandling/Turntable.glb' },
    ],
  };

  it('never reads the deploy catalog implicitly — undeclared means empty', async () => {
    const b = new BundledBackend({ fetchImpl: fakeFetch({ 'library/catalog.json': catalog }) });
    expect(await b.listLibrary()).toEqual([]);
  });

  it('yields an empty library when the deploy root has no catalog', async () => {
    const b = new BundledBackend({ fetchImpl: fakeFetch({}) });
    expect(await b.listLibrary()).toEqual([]);
  });

  it('a manifest that declares its own library[] keeps it', async () => {
    const b = new BundledBackend({
      fetchImpl: fakeFetch({
        'project.json': {
          schemaVersion: 1, id: 'prj_x', name: 'X',
          library: [{ path: 'library/only-this.glb' }],
        },
        'library/catalog.json': catalog,
      }),
    });
    expect((await b.listLibrary()).map(e => e.path)).toEqual(['library/only-this.glb']);
  });

  it('declares no library subscription in the synthetic demo manifest', async () => {
    const b = new BundledBackend({ fetchImpl: fakeFetch({}) });
    expect((await b.readManifest())?.libraries).toBeUndefined();
  });
});

// ─── documents[] listing (plan-413 §2.4) ────────────────────────────────

describe('listDocuments / statDocuments', () => {
  it('folds scenes, models and library into one list, each with its section', async () => {
    const root = folderWith([scene('scn_a', 'A')]);
    root.seedDir('models').seedText('press.glb', 'glb');
    root.seedDir('library').seedDir('Custom').seedText('gripper.glb', 'glb');
    const b = new FolderBackend(asDirHandle(root), { writable: false });

    const docs = await b.listDocuments();
    expect(docs.map(d => [d.section, d.path])).toEqual([
      ['scenes', sceneGlbRelPathFor(scene('scn_a', 'A'))],
      ['models', 'models/press.glb'],
      ['library', 'library/Custom/gripper.glb'],
    ]);
    // Every document has an id — the mandatory one of F2, minted from the path
    // where the legacy entry had none.
    for (const d of docs) expect(d.id.trim()).not.toBe('');
  });

  it('returns the same ids on two consecutive calls', async () => {
    // A random id per call would make this list unselectable in the UI.
    const root = folderWith([scene('scn_a', 'A')]);
    root.seedDir('models').seedText('press.glb', 'glb');
    const b = new FolderBackend(asDirHandle(root), { writable: false });
    expect((await b.listDocuments()).map(d => d.id))
      .toEqual((await b.listDocuments()).map(d => d.id));
  });

  it('stats every file it lists, and nothing it does not', async () => {
    const root = folderWith([scene('scn_a', 'A')]);
    root.seedDir('models').seedText('press.glb', 'glb-bytes');
    const b = new FolderBackend(asDirHandle(root), { writable: false });

    const stats = await b.statDocuments();
    const model = stats.find(s => s.path === 'models/press.glb');
    expect(model?.size).toBe('glb-bytes'.length);
    // `library/Custom/gripper.glb` is declared in the manifest but absent on
    // disk: no file, no stat, and the scan therefore leaves its entry alone.
    expect(stats.find(s => s.path === 'library/Custom/gripper.glb')).toBeUndefined();
  });

  it('the bundled backend lists documents but is never scanned', async () => {
    const b = new BundledBackend({
      fetchImpl: fakeFetch({
        'project.json': {
          schemaVersion: 1, id: 'prj_x', name: 'X',
          models: [{ path: 'models/a.glb' }],
        },
      }),
    });
    expect((await b.listDocuments()).map(d => d.path)).toContain('models/a.glb');
    // Read-only bytes cannot drift from the manifest that describes them, and
    // `fetch` has no mtime worth trusting — so there is nothing to scan.
    expect(await b.statDocuments()).toEqual([]);
  });
});
