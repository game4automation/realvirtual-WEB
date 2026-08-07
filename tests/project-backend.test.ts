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
import { sceneRelPathFor, type RvProject } from '../src/core/project/rv-project-types';
import type { RvScene } from '../src/core/hmi/scene/rv-scene-types';

// ─── Fixtures ───────────────────────────────────────────────────────────

const scene = (id: string, name: string): RvScene => ({
  id,
  name,
  createdAt: '2025-01-01T00:00:00.000Z',
  modifiedAt: '2025-01-01T00:00:00.000Z',
  schemaVersion: 2,
  base: { kind: 'empty' },
  edits: { ops: [], settings: { catalogUrls: [], gridSizeMm: 500 } },
});

function folderWith(scenes: RvScene[] = []): FakeDir {
  const root = new FakeDir('customer');
  const manifest: RvProject = {
    schemaVersion: 1,
    id: 'prj_folder',
    name: 'Customer',
    scenes: scenes.map(s => ({ id: s.id, name: s.name, path: sceneRelPathFor(s) })),
    models: [{ path: 'models/press.glb', label: 'Press' }],
    library: [{ path: 'library/Custom/gripper.glb' }],
  };
  root.seedText('project.json', JSON.stringify(manifest));
  const dir = root.seedDir('scenes');
  for (const s of scenes) dir.seedText(sceneRelPathFor(s).split('/')[1]!, JSON.stringify(s));
  return root;
}

/** Minimal fetch double serving a fixed path map. */
function fakeFetch(files: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const key = Object.keys(files).find(k => url.endsWith(k));
    if (!key) return { ok: false, status: 404, json: async () => null } as unknown as Response;
    return { ok: true, status: 200, json: async () => files[key] } as unknown as Response;
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
        { file: 'DemoPlanner.scene.json', urlName: 'DemoPlanner', label: 'Demo Planner' },
      ],
    });
    const p = await b.readManifest();
    expect(p?.id).toBe(SAMPLE_PROJECT_ID);
    expect(p?.models?.[0]?.label).toBe('Demo');
    expect(p?.scenes?.[0]?.id).toBe(publishedSceneId('DemoPlanner'));
    expect(p?.scenes?.[0]?.path).toBe('scenes/DemoPlanner.scene.json');
  });

  it('published scene ids are stable across instances', async () => {
    const make = () => new BundledBackend({
      fetchImpl: fakeFetch({}),
      publishedScenes: [{ file: 'A.scene.json', urlName: 'A', label: 'A' }],
    });
    const first = (await make().listScenes())[0]?.id;
    const second = (await make().listScenes())[0]?.id;
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
    expect(p?.models).toEqual([{ path: 'models/Line.glb', label: 'Line' }]);
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

  it('reads a scene body over fetch and rejects a non-scene', async () => {
    const s = scene('scn_x', 'X');
    const b = new BundledBackend({
      fetchImpl: fakeFetch({ 'scenes/x.scene.json': s, 'scenes/junk.json': { hello: 1 } }),
    });
    expect((await b.readScene('scenes/x.scene.json'))?.id).toBe('scn_x');
    expect(await b.readScene('scenes/junk.json')).toBeNull();
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
      publishedScenes: [{ file: 'A.scene.json', urlName: 'A', label: 'A' }],
    });
    expect(await b.readManifest()).not.toBeNull();
    expect(await b.listScenes()).toHaveLength(1);
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
    expect((await b.readScene(sceneRelPathFor(s)))?.name).toBe('A');
    expect(await b.readSettings()).toEqual({ $schema: 'rv-settings-bundle/1.0' });
    expect(b.kind).toBe('folder');
  });

  it('lists scenes from the manifest', async () => {
    const b = new FolderBackend(asDirHandle(folderWith([scene('scn_a', 'A')])), { writable: true });
    expect((await b.listScenes()).map(e => e.id)).toEqual(['scn_a']);
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
    expect(await b.listScenes()).toEqual([]);
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
    await expect(b.writeScene('scenes/a.scene.json', scene('scn_a', 'A')))
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

// The Assets tab was empty on every deploy and on the default boot: the
// synthetic manifest declares `libraries[]` (the subscription) but never
// `library[]` (the contents), and there is no folder to walk over HTTP.
describe('BundledBackend library', () => {
  const catalog = {
    entries: [
      { id: 'a', name: 'Roll Conveyor 1m', glbUrl: 'PalletHandling/RollConveyor-1m.glb' },
      { id: 'b', name: 'Turntable', glbUrl: 'PalletHandling/Turntable.glb' },
      { id: 'c', name: 'Remote', glbUrl: 'https://cdn.example/x.glb' },
    ],
  };

  it('reads the deploy catalog and roots entries under library/', async () => {
    const b = new BundledBackend({ fetchImpl: fakeFetch({ 'library/catalog.json': catalog }) });
    const lib = await b.listLibrary();
    expect(lib.map(e => e.path)).toEqual([
      'library/PalletHandling/RollConveyor-1m.glb',
      'library/PalletHandling/Turntable.glb',
      'https://cdn.example/x.glb',
    ]);
    expect(lib[0]?.label).toBe('Roll Conveyor 1m');
  });

  // The library is bundled (`public/library/`), so the deploy root is the only
  // place it is ever read from — there is no second, dev-only mount to fall back
  // to. A deploy without a catalog simply has no bundled library.
  it('yields an empty library when the deploy root has no catalog', async () => {
    const b = new BundledBackend({ fetchImpl: fakeFetch({}) });
    expect(await b.listLibrary()).toEqual([]);
  });

  it('a manifest that curates its own library[] wins over the catalog', async () => {
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
});
