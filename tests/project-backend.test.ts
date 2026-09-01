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
import { BundledBackend } from '../src/core/project/backends/bundled-backend';
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

  // ── plan-735 F6: the synthetic manifest is gone, and so is its spec ──────
  //
  // What stood here was the canonical specification of
  // `BundledBackend._syntheticManifest()`: "a deploy with no project.json still
  // yields the Sample project, assembled from the injected models and the
  // `scenes/index.json` catalogue". Both the function and the catalogue are
  // removed, so this is a REPLACEMENT rather than an edit — the old assertions
  // describe behaviour that must no longer exist.
  //
  // The rule now: a deploy root either published a project or it did not, and
  // the viewer never invents the difference away.
  it('returns null when the deploy has no project.json, and says why', async () => {
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
    try {
      const b = new BundledBackend({
        fetchImpl: fakeFetch({}),
        // Injected models are NOT a project. Before plan-735 these two entries
        // were enough to manufacture one; the whole point is that they are not.
        models: [{ url: '/models/Demo.glb', label: 'Demo' }],
      });
      expect(await b.readManifest()).toBeNull();
      expect(b.hasDeployedManifest()).toBe(false);
      // F7: named, not silent — and naming all three indistinguishable causes.
      expect(warnings.join('\n')).toMatch(/project\.json could not be read/);
      expect(warnings.join('\n')).toMatch(/404.*CORS.*file:\/\//s);
    } finally {
      console.warn = warn;
    }
  });

  it('lists nothing when there is no manifest — no invented catalogue', async () => {
    const b = new BundledBackend({
      fetchImpl: fakeFetch({}),
      models: [{ url: '/models/Demo.glb', label: 'Demo' }],
    });
    expect(await b.listModels()).toEqual([]);
    expect(await b.listDocuments()).toEqual([]);
    expect(sceneDocumentsOf(await b.readManifest())).toEqual([]);
  });

  // (The INVALID-manifest half of F6 — a file that is there, parses, and is
  // still not a v2 project — is pinned by the plan-726 F11b block further down,
  // which plan-735 flipped from "falls back to the synthetic demo" to "is
  // null". A bare `{schemaVersion: 2}` would not serve here: `migrateManifest()`
  // mints an id and a name for it, so it is a VALID empty project, not an
  // invalid one.)

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

  // plan-735 Phase 2 (Vektor B, §2.2). This asserted the OPPOSITE: that a
  // manifest declaring no `models` section had one filled in from whatever the
  // build's discovery had found. That fill ran on every valid manifest, which
  // made the build-time glob the silent completion of any customer project that
  // simply did not list its models — remove the glob and those projects boot to
  // an empty viewport. Every manifest declares its own models now, and this
  // pins that nothing is added behind its back.
  it('does not fill a deploy manifest from injected models', async () => {
    const b = new BundledBackend({
      fetchImpl: fakeFetch({
        'project.json': { schemaVersion: 1, id: 'prj_deploy', name: 'Deploy' },
      }),
      models: [{ url: '/models/Demo.glb', label: 'Demo' }],
    });
    expect(await b.listModels()).toEqual([]);
    expect((await b.readManifest())?.id).toBe('prj_deploy');
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

  // Unchanged in substance, re-sourced by plan-735: the project a Safari/iPad
  // visitor gets now comes from the deploy's OWN `project.json` — which every
  // channel publishes — rather than from a manifest the backend invented around
  // injected sources. The claim being proved is the same one: no filesystem
  // API, still a complete project.
  it('still yields a full project, so no browser is left without one', async () => {
    const b = new BundledBackend({
      fetchImpl: fakeFetch({
        'project.json': {
          schemaVersion: 2,
          id: 'prj_deploy',
          name: 'Deploy',
          documents: [
            { id: 'doc_a', name: 'A', path: 'scenes/A.glb', section: 'scenes' },
            { id: 'doc_demo', name: 'Demo', path: 'models/Demo.glb', section: 'models' },
          ],
        },
      }),
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

// ─── plan-726 F11b: the manifest gate, and its voice ────────────────────

/**
 * `readManifest()` had no validation and no logging at all.
 *
 * The only check on the path was `migrateManifest()`'s, which calls
 * `isValidProjectV1()` — and V1 does not look at `documents[]`. So a deploy
 * manifest declaring a document with no `id`, or `documents` as an object,
 * was adopted in silence and then presented as an empty project. Since
 * plan-726 the root `project.json` is what the public demo BOOTS from, so
 * "adopted silently and wrong" became the worst of the three answers.
 *
 * Two properties are pinned here, and they are separate on purpose: the
 * fallback must happen (the demo still loads), and it must be AUDIBLE (the
 * file previously contained zero `console.*` calls, so every failure mode —
 * 404, HTML error page, corrupt JSON, invalid schema — looked identical from
 * outside).
 *
 * The 404 case and "a deployed manifest wins" are already covered above and
 * are deliberately not repeated.
 */

/** A fetch that answers 200 with a body that is not JSON. */
function fetchWithUnparseableBody(): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => { throw new SyntaxError('Unexpected token < in JSON at position 0'); },
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response)) as typeof fetch;
}

describe('BundledBackend manifest validation (plan-726 F11b)', () => {
  let warnings: string[];
  let restoreWarn: typeof console.warn;

  beforeEach(() => {
    warnings = [];
    restoreWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  });
  afterEach(() => { console.warn = restoreWarn; });

  it('falls back and WARNS when project.json is served but is not JSON', async () => {
    const b = new BundledBackend({
      fetchImpl: fetchWithUnparseableBody(),
      models: [{ url: '/models/Demo.glb', label: 'Demo' }],
    });
    const p = await b.readManifest();

    // Not a throw — and, since plan-735, not a plausible-looking substitute
    // either: the deploy served something unreadable, so it has no project.
    expect(p).toBeNull();
    expect(b.hasDeployedManifest()).toBe(false);
    expect(warnings.join('\n')).toMatch(/not valid JSON/i);
  });

  it('falls back and WARNS when project.json is valid JSON but invalid v2', async () => {
    const b = new BundledBackend({
      // Parses, survives `migrateManifest()` (V1 never looks at documents[]),
      // and is still unusable: a document row with no `id`.
      fetchImpl: fakeFetch({
        'project.json': {
          schemaVersion: 2,
          id: 'prj_broken',
          name: 'Broken',
          documents: [{ path: 'models/Line.glb' }],
        },
      }),
      models: [{ url: '/models/Demo.glb', label: 'Demo' }],
    });
    const p = await b.readManifest();

    // Before plan-726 this returned `prj_broken` without a word; before
    // plan-735 it returned the synthetic demo project in its place.
    expect(p).toBeNull();
    expect(b.hasDeployedManifest()).toBe(false);
    expect(warnings.join('\n')).toMatch(/not a valid v2 project manifest/i);
  });

  it('rejects a manifest whose documents[] is not an array', async () => {
    const b = new BundledBackend({
      fetchImpl: fakeFetch({
        'project.json': {
          schemaVersion: 2, id: 'prj_broken', name: 'Broken',
          documents: { 'models/Line.glb': {} },
        },
      }),
    });
    expect(await b.readManifest()).toBeNull();
    expect(b.hasDeployedManifest()).toBe(false);
  });

  it('accepts a VALID manifest silently — the gate is not noisy', async () => {
    const b = new BundledBackend({
      fetchImpl: fakeFetch({
        'project.json': {
          schemaVersion: 2,
          id: 'prj_ok',
          name: 'Fine',
          documents: [{ id: 'doc_line', path: 'models/Line.glb', section: 'models' }],
        },
      }),
    });
    const p = await b.readManifest();

    expect(p?.id).toBe('prj_ok');
    expect(b.hasDeployedManifest()).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('still accepts an UNMIGRATED manifest — validation runs after derivation', async () => {
    // The regression this prevents: validating the raw bytes instead of the
    // derived manifest would reject every pre-phase-6 customer deploy, which
    // legitimately carries `models[]` and no `documents[]` at all.
    const b = new BundledBackend({
      fetchImpl: fakeFetch({
        'project.json': {
          schemaVersion: 1,
          id: 'prj_legacy',
          name: 'Legacy',
          models: [{ path: 'models/Line.glb', label: 'Line' }],
        },
      }),
    });
    const p = await b.readManifest();

    expect(p?.id).toBe('prj_legacy');
    expect(b.hasDeployedManifest()).toBe(true);
    expect(assetDocumentsOf(p, 'models')).toMatchObject([{ path: 'models/Line.glb' }]);
    expect(warnings).toEqual([]);
  });
});
