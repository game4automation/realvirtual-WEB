// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-655 F1/F3/F4 — libraries per MCP, one parts list, snap-attach for
 * project parts.
 *
 *  - attach / detach / list through the ONE sequence in
 *    `project-library-attach.ts` (the dashboard dialog and `library.*` run it):
 *    catalog first, manifest only on success, rollback on a 404, a write error,
 *    a read-only project or a project switch during the fetch; detach manifest
 *    first; idempotent re-attach; reopen restores it.
 *  - `web_catalog_list` lists catalog entries AND project documents with `source`.
 *  - `layout.snapAttach` accepts a project part by `project:<path>` AND by its
 *    documentId, indexed through its library source (no glbUrl).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { queryCommand } from './helpers/query-command';
import { Object3D } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { LibraryStore } from '../src/core/library/library-store';
import {
  attachLibraryToProject,
  detachLibraryFromProject,
  listLibraries,
  PROJECT_READ_ONLY,
  PROJECT_SWITCHED,
  NO_PROJECT_OPEN,
  EMPTY_URL,
  type AttachProjectStoreLike,
} from '../src/core/library/project-library-attach';
import { readProjectLibraries } from '../src/core/library/project-libraries';
import type { RvProject } from '../src/core/project/rv-project-types';
import { CommandRegistry } from '../src/core/hmi/rv-command-registry';
import { EMPTY_TARGET, ensureLibraryCommandsRegistered } from '../src/core/library/library-commands';
import { ensurePlannerCommandsRegistered } from '../src/plugins/layout-planner/planner-commands';
import { registerLibrarySourceProvider, type LibrarySource } from '../src/core/library/library-source-registry';
import { PROJECT_LIBRARY_PROVIDER_ID } from '../src/core/library/project-library-provider';
import type { LibraryCatalogEntry } from '../src/core/library/library-types';
import { McpSceneTools } from '../src/plugins/mcp-bridge/rv-mcp-scene-tools';
import { clearCache as clearSnapIndex } from '../src/plugins/snap-point/library-snap-index';
import type { RVViewer } from '../src/core/rv-viewer';

// A URL catalog served by the test server (plan-778 Phase 4: the bundled
// library catalog.json is gone — the realvirtual library is a project now, and
// URL catalogs keep their catalog.json format for external libraries).
const CATALOG = '/tests/fixtures/library-catalog/catalog.json';
const MISSING = '/library/plan-655-does-not-exist.json';

/** In-memory project store double with switchable failure modes. */
class FakeProjectStore implements AttachProjectStoreLike {
  project: RvProject | null;
  backend: object | null = {};
  mode: 'ok' | 'throw' | 'readonly' = 'ok';
  writes = 0;
  constructor(id = 'p1') {
    this.project = { id, name: `Project ${id}`, version: 1 } as unknown as RvProject;
  }
  getProject(): RvProject | null { return this.project; }
  getBackend(): unknown { return this.backend; }
  async applyManifestDelta(apply: (c: RvProject) => RvProject): Promise<RvProject | null> {
    if (this.mode === 'readonly') return null;
    if (this.mode === 'throw') throw new Error('disk full');
    this.writes++;
    this.project = apply(this.project as RvProject);
    return this.project;
  }
}

const stores: LibraryStore[] = [];
function freshLibrary(): LibraryStore {
  const s = new LibraryStore();
  stores.push(s);
  return s;
}

afterEach(() => {
  for (const s of stores.splice(0)) for (const u of [...s.catalogUrls]) s.removeCatalog(u);
});

describe('plan-655 F1 — attach / detach / list (one sequence for UI and MCP)', () => {
  it('attach loads the catalog FIRST, then writes project.json.libraries[]; list shows it', async () => {
    const project = new FakeProjectStore();
    const library = freshLibrary();
    const r = await attachLibraryToProject(CATALOG, 'Standard', { project, library });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.entries).toBeGreaterThan(5);
    expect(readProjectLibraries(project.project)).toEqual([CATALOG]);
    expect(project.project!.libraries![0].label).toBe('Standard');
    const list = listLibraries({ project, library });
    expect(list.libraries).toEqual([
      expect.objectContaining({ url: CATALOG, scope: 'project', loaded: true, label: 'Standard' }),
    ]);
  });

  it('a 404 URL is reported and rolled back — nothing in the manifest, nothing loaded', async () => {
    const project = new FakeProjectStore();
    const library = freshLibrary();
    const r = await attachLibraryToProject(MISSING, null, { project, library });
    expect(r.ok).toBe(false);
    expect(project.writes).toBe(0);
    expect(library.catalogUrls).not.toContain(MISSING);
  });

  it('a manifest write that THROWS rolls the subscription back', async () => {
    const project = new FakeProjectStore();
    project.mode = 'throw';
    const library = freshLibrary();
    const r = await attachLibraryToProject(CATALOG, null, { project, library });
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('disk full') });
    expect(library.catalogUrls).not.toContain(CATALOG);
  });

  it('a read-only project refuses and rolls back', async () => {
    const project = new FakeProjectStore();
    project.mode = 'readonly';
    const library = freshLibrary();
    const r = await attachLibraryToProject(CATALOG, null, { project, library });
    expect(r).toEqual({ ok: false, reason: PROJECT_READ_ONLY });
    expect(library.catalogUrls).not.toContain(CATALOG);
  });

  it('a project switch DURING the fetch writes nothing into the next project', async () => {
    const project = new FakeProjectStore('p1');
    const library = freshLibrary();
    const realAdd = library.addCatalog.bind(library);
    library.addCatalog = async (url, origin) => {
      await realAdd(url, origin);
      project.project = { id: 'p2', name: 'Other', version: 1 } as unknown as RvProject;
    };
    const r = await attachLibraryToProject(CATALOG, null, { project, library });
    expect(r).toEqual({ ok: false, reason: PROJECT_SWITCHED });
    expect(project.writes).toBe(0);
    expect(readProjectLibraries(project.project)).toEqual([]);
    expect(library.catalogUrls).not.toContain(CATALOG);
  });

  it('re-attaching is idempotent; reopening the project restores the library', async () => {
    const project = new FakeProjectStore();
    const library = freshLibrary();
    await attachLibraryToProject(CATALOG, null, { project, library });
    const again = await attachLibraryToProject(CATALOG, null, { project, library });
    expect(again.ok && again.alreadyAttached).toBe(true);
    expect(readProjectLibraries(project.project)).toEqual([CATALOG]);
    // "Reopen": a fresh store applies the manifest.
    const reopened = freshLibrary();
    await reopened.applyProjectLibraries(readProjectLibraries(project.project));
    expect(reopened.catalogs.get(CATALOG)?.entries.length).toBeGreaterThan(5);
  });

  it('detach writes the manifest FIRST — a failed write leaves the library attached and loaded', async () => {
    const project = new FakeProjectStore();
    const library = freshLibrary();
    await attachLibraryToProject(CATALOG, null, { project, library });
    project.mode = 'throw';
    const failed = await detachLibraryFromProject(CATALOG, { project, library });
    expect(failed.ok).toBe(false);
    expect(readProjectLibraries(project.project)).toEqual([CATALOG]);
    expect(library.catalogUrls).toContain(CATALOG);
    project.mode = 'ok';
    const ok = await detachLibraryFromProject(CATALOG, { project, library });
    expect(ok.ok).toBe(true);
    expect(readProjectLibraries(project.project)).toEqual([]);
    expect(library.catalogUrls).not.toContain(CATALOG);
  });

  it('refuses without a project / without a url', async () => {
    const project = new FakeProjectStore();
    project.project = null;
    expect(await attachLibraryToProject(CATALOG, null, { project, library: freshLibrary() }))
      .toEqual({ ok: false, reason: NO_PROJECT_OPEN });
    expect(await attachLibraryToProject('  ', null, { project, library: freshLibrary() }))
      .toEqual({ ok: false, reason: EMPTY_URL });
  });

  it('library.attach / library.detach are registry commands with the MCP mirror of web_library_*', () => {
    const reg = new CommandRegistry();
    ensureLibraryCommandsRegistered(reg);
    expect(reg.get('library.attach')?.mcp?.tool).toBe('web_library_attach');
    expect(reg.get('library.detach')?.mcp?.tool).toBe('web_library_detach');
    const viewer = { modes: { activeMode: 'planner' } } as unknown as RVViewer;
    // plan-778 F10: `url` is no longer the only target — an empty call names both (projectId or url).
    expect(reg.enabled('library.attach', { url: '' }, viewer)).toEqual({ reason: EMPTY_TARGET });
  });
});

// ─── F3 / F4: one parts list, snap-attach for project parts ─────────────

/** A minimal GLB: a part with an input and an output snap of typeId "curve". */
async function curveGlbUrl(): Promise<string> {
  const root = new Object3D(); root.name = 'Curve';
  const inSnap = new Object3D(); inSnap.name = 'Snap-XN-curve';
  const outSnap = new Object3D(); outSnap.name = 'Snap-ZP-curve';
  outSnap.position.set(1, 0, 1);
  root.add(inSnap, outSnap);
  const data = (await new GLTFExporter().parseAsync(root, { binary: true })) as ArrayBuffer;
  return URL.createObjectURL(new Blob([data], { type: 'model/gltf-binary' }));
}

const PART: LibraryCatalogEntry = {
  id: 'project:library/Interroll/Curve.glb',
  documentId: 'doc-curve-1',
  name: 'Curve',
  category: 'custom',
  glbUrl: '',
  localPath: 'library/Interroll/Curve.glb',
};

function installProjectSource(resolveUrl: () => Promise<string>): () => void {
  const source: LibrarySource = {
    id: 'p1', label: 'Demo', kind: 'project', writable: true, loaded: true,
    listEntries: () => [PART],
    getEntry: (id) => (id === PART.id || id === PART.documentId ? PART : null),
    resolveAsset: async () => ({ url: await resolveUrl() }),
  };
  return registerLibrarySourceProvider({
    id: PROJECT_LIBRARY_PROVIDER_ID,
    listSources: () => [source],
    subscribe: () => () => {},
  });
}

function stubViewer(catalogEntries: LibraryCatalogEntry[], placed: Array<{ entry: LibraryCatalogEntry; own: string }>): RVViewer {
  const targetRoot = new Object3D(); targetRoot.name = 'Curve_1';
  const targetSnapNode = new Object3D(); targetSnapNode.name = 'Snap-ZP-curve';
  targetRoot.add(targetSnapNode);
  const targetSnap = {
    id: 't', object3D: targetSnapNode, ownerRoot: targetRoot, typeId: 'curve', flow: 'out',
    dir: { axis: 'Z', sign: 'P', code: 'ZP' }, occupied: false,
  };
  const planner = {
    store: { getSnapshot: () => ({ catalogs: new Map([['/lib/catalog.json', { version: '1.0', name: 'Lib', entries: catalogEntries }]]) }) },
    getPlacedRootById: (id: string) => (id === 'placed-1' ? targetRoot : null),
    placeAtSnap: async (entry: LibraryCatalogEntry, _t: unknown, own: string) => { placed.push({ entry, own }); return `new-${placed.length}`; },
  };
  const snapPlugin = { getRegistry: () => ({ getByOwnerRoot: (r: Object3D) => (r === targetRoot ? [targetSnap] : []) }) };
  return {
    modes: { activeMode: 'planner' },
    getPlugin: (id: string) => (id === 'layout-planner' ? planner : id === 'snap-point' ? snapPlugin : undefined),
    selectionManager: { getSnapshot: () => ({ selectedPaths: [] }) },
  } as unknown as RVViewer;
}

describe('plan-655 F3/F4 — one parts list, snap-attach for project parts', () => {
  let unregister: (() => void) | null = null;
  afterEach(() => { unregister?.(); unregister = null; clearSnapIndex(); });

  it('web_catalog_list lists catalog entries AND project documents, each with its source; filters work', async () => {
    unregister = installProjectSource(curveGlbUrl);
    const lib: LibraryCatalogEntry = { id: 'pallethandling-cartonbox', name: 'Carton Box', category: 'custom', glbUrl: '/x.glb' };
    const viewer = stubViewer([lib], []);
    const all = await queryCommand(viewer, 'library.catalogList') as Array<Record<string, unknown>>;
    expect(all).toEqual(expect.arrayContaining([
      expect.objectContaining({ catalogId: 'pallethandling-cartonbox', source: 'catalog', library: '/lib/catalog.json' }),
      expect.objectContaining({ catalogId: PART.id, source: 'project', documentId: 'doc-curve-1', path: PART.localPath }),
    ]));
    const onlyProject = await queryCommand(viewer, 'library.catalogList', { source: 'project' }) as Array<Record<string, unknown>>;
    expect(onlyProject.map((e) => e.source)).toEqual(['project']);
    const q = await queryCommand(viewer, 'library.catalogList', { query: 'carton' }) as Array<Record<string, unknown>>;
    expect(q.map((e) => e.catalogId)).toEqual(['pallethandling-cartonbox']);
  });

  for (const key of [PART.id, PART.documentId!]) {
    it(`layout.snapAttach chains a project part by ${key === PART.id ? 'project:<path>' : 'documentId'} (Ausgang → Eingang)`, async () => {
      let resolves = 0;
      unregister = installProjectSource(async () => { resolves++; return curveGlbUrl(); });
      const placed: Array<{ entry: LibraryCatalogEntry; own: string }> = [];
      const viewer = stubViewer([], placed);
      const reg = new CommandRegistry();
      ensurePlannerCommandsRegistered(reg);
      const r = await reg.execute('layout.snapAttach', { targetId: 'placed-1', catalogId: key, targetSnapName: null, flow: null },
        { origin: 'mcp', viewer });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(placed).toHaveLength(1);
      expect(placed[0].entry.id).toBe(PART.id);
      // The target is an OUTPUT, so the new curve mates with its INPUT snap.
      expect(placed[0].own).toBe('Snap-XN-curve');
      expect(resolves).toBeGreaterThan(0);
      expect((r as { value: { catalogId: string } }).value.catalogId).toBe(PART.id);
    });
  }
});
