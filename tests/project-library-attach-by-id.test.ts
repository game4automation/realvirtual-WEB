// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-778 9.7 — attach / detach a library PROJECT by id (F10/F11, Decision D).
 *
 *  - `attachProjectLibrary` / `detachProjectLibrary` keep the transaction
 *    contract of the URL route: identity re-checked at the write (a project
 *    switch writes nothing into the next project), read-only refused, write
 *    errors reported, idempotent; every other `libraries[]` entry survives;
 *  - `library.attach` / `library.detach` take `projectId` XOR `url`; the
 *    legacy `/library/catalog.json` URL maps to `prj_realvirtual_library`;
 *  - detach counts the placements that name the library (the confirmation)
 *    and deletes none; attaching again makes them resolve again;
 *  - `library.list` carries `libraryProjects` rows with scope / state / neededBy.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { RvProject } from '../src/core/project/rv-project-types';
import {
  attachProjectLibrary,
  attachedLibraryProjectIdsOf,
  BAD_PROJECT_ID,
  countLibraryPlacements,
  detachConfirmationMessage,
  detachProjectLibrary,
  libraryProjectIdsOf,
  libraryRemovalKeepsAvailable,
  listLibraries,
  listLibraryProjectRows,
  PROJECT_READ_ONLY,
  PROJECT_SWITCHED,
  projectNotAttached,
  SELF_LIBRARY,
  type AttachProjectStoreLike,
} from '../src/core/library/project-library-attach';
import { readLibraryRefs } from '../src/core/library/project-libraries';
import { CommandRegistry } from '../src/core/hmi/rv-command-registry';
import {
  EMPTY_TARGET,
  ensureLibraryCommandsRegistered,
  setLibraryCommandDepsForTests,
  URL_OR_PROJECT_ID,
} from '../src/core/library/library-commands';
import {
  LIBRARY_PROJECTS_PROVIDER_ID,
  REALVIRTUAL_LIBRARY_PROJECT_ID,
  findQualifiedOrigin,
  isBundledRealvirtualCatalogUrl,
} from '../src/core/library/library-origin';
import { LibraryProjectLoader, type LibraryProjectLoaderDeps } from '../src/core/library/library-project-loader';
import { installLibraryProjectsProvider, uninstallLibraryProjectsProvider } from '../src/core/library/library-projects-provider';
import type { ProjectBackend } from '../src/core/project/backends/project-backend';
import type { RVViewer } from '../src/core/rv-viewer';
import { fakeLibraryProject } from './helpers/fake-document-project';

/** In-memory project store double (the same shape as plan-655's). */
class FakeProjectStore implements AttachProjectStoreLike {
  project: RvProject | null;
  backend: object | null = {};
  mode: 'ok' | 'throw' | 'readonly' = 'ok';
  /** Swap the open project right before the delta is applied (a switch during the write queue). */
  switchBeforeWrite: RvProject | null = null;
  writes = 0;
  constructor(libraries: unknown[] = [], id = 'prj_a') {
    this.project = { id, name: `Project ${id}`, libraries } as unknown as RvProject;
  }
  getProject(): RvProject | null { return this.project; }
  getBackend(): unknown { return this.backend; }
  async applyManifestDelta(apply: (c: RvProject) => RvProject): Promise<RvProject | null> {
    if (this.mode === 'readonly') return null;
    if (this.mode === 'throw') throw new Error('disk full');
    if (this.switchBeforeWrite) { this.project = this.switchBeforeWrite; this.backend = {}; }
    const next = apply(this.project as RvProject);
    if (next !== this.project) this.writes++;
    this.project = next;
    return this.project;
  }
}

const VIEWER_WITH = (placed: Array<{ providerId?: string; sourceId?: string }>): RVViewer => ({
  modes: { activeMode: 'planner' },
  getPlugin: (id: string) => (id === 'layout-planner' ? { store: { getSnapshot: () => ({ placed }) } } : undefined),
} as unknown as RVViewer);

afterEach(() => {
  setLibraryCommandDepsForTests(null);
  uninstallLibraryProjectsProvider();
});

describe('plan-778 9.7 — attach / detach by projectId', () => {
  it('attach writes {projectId,label,hint}; URL entries and unknown keys survive; idempotent', async () => {
    const store = new FakeProjectStore([{ url: 'https://x/catalog.json', label: 'X', extra: 1 }]);
    const r = await attachProjectLibrary({ projectId: 'prj_b', label: 'SharedConveyors', hint: 'SharedConveyors' }, { project: store });
    expect(r).toEqual({
      ok: true, projectId: 'prj_b', label: 'SharedConveyors', hint: 'SharedConveyors', alreadyAttached: false, libraries: ['prj_b'],
    });
    expect(readLibraryRefs(store.project)).toEqual([
      { url: 'https://x/catalog.json', label: 'X', extra: 1 },
      { projectId: 'prj_b', label: 'SharedConveyors', hint: 'SharedConveyors' },
    ]);
    const again = await attachProjectLibrary({ projectId: 'prj_b', label: 'Renamed' }, { project: store });
    expect(again.ok && again.alreadyAttached).toBe(true);
    expect(again.ok && again.label).toBe('SharedConveyors');   // the stored label stays
    expect(store.writes).toBe(1);
  });

  it('a project switch before the write lands nothing in the next project', async () => {
    const store = new FakeProjectStore();
    const next = { id: 'prj_other', name: 'Other', libraries: [] } as unknown as RvProject;
    store.switchBeforeWrite = next;
    const r = await attachProjectLibrary({ projectId: 'prj_b' }, { project: store });
    expect(r).toEqual({ ok: false, reason: PROJECT_SWITCHED });
    expect(readLibraryRefs(next)).toEqual([]);
    expect(store.writes).toBe(0);
  });

  it('read-only A refused; write error reported; self and path-like ids refused', async () => {
    const ro = new FakeProjectStore();
    ro.mode = 'readonly';
    expect(await attachProjectLibrary({ projectId: 'prj_b' }, { project: ro })).toEqual({ ok: false, reason: PROJECT_READ_ONLY });
    const broken = new FakeProjectStore();
    broken.mode = 'throw';
    const failed = await attachProjectLibrary({ projectId: 'prj_b' }, { project: broken });
    expect(!failed.ok && failed.reason).toContain('disk full');
    const store = new FakeProjectStore();
    expect(await attachProjectLibrary({ projectId: 'prj_a' }, { project: store })).toEqual({ ok: false, reason: SELF_LIBRARY });
    expect(await attachProjectLibrary({ projectId: '../evil' }, { project: store })).toEqual({ ok: false, reason: BAD_PROJECT_ID });
    expect(store.writes).toBe(0);
  });

  it('detach removes only that entry; refuses one that is not attached; carries the placement count', async () => {
    const store = new FakeProjectStore([{ projectId: 'prj_b' }, { projectId: 'prj_c' }, { url: '/x/catalog.json' }]);
    expect(await detachProjectLibrary('prj_z', { project: store })).toEqual({ ok: false, reason: projectNotAttached('prj_z') });
    const r = await detachProjectLibrary('prj_b', { project: store, placements: 3 });
    expect(r).toEqual({ ok: true, projectId: 'prj_b', libraries: ['prj_c'], placements: 3 });
    expect(readLibraryRefs(store.project)).toEqual([{ projectId: 'prj_c' }, { url: '/x/catalog.json' }]);
  });

  it('the confirmation counts the placements whose qualifier names the library — legacy ones are not counted', () => {
    const placed = [
      { providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: 'prj_b' },
      { providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: 'prj_b' },
      { providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: 'prj_c' },
      { providerId: 'global', sourceId: 'prj_b' },
      {},
    ];
    expect(countLibraryPlacements(placed, 'prj_b')).toBe(2);
    expect(detachConfirmationMessage('SharedConveyors', 12))
      .toBe('12 placements use this library and will show as missing. Nothing is deleted; adding the library again restores them.');
    expect(detachConfirmationMessage('SharedConveyors', 1)).toContain('1 placement uses this library');
  });
});

describe('plan-778 9.7 — library.attach / library.detach commands', () => {
  it('projectId XOR url; the legacy bundled catalog URL attaches the realvirtual library project', async () => {
    const store = new FakeProjectStore([{ url: 'https://x/catalog.json' }]);
    setLibraryCommandDepsForTests({ project: store });
    const reg = new CommandRegistry();
    ensureLibraryCommandsRegistered(reg);
    const viewer = VIEWER_WITH([]);
    expect(reg.enabled('library.attach', {}, viewer)).toEqual({ reason: EMPTY_TARGET });
    expect(reg.enabled('library.attach', { url: 'https://x/catalog.json', projectId: 'prj_b' }, viewer)).toEqual({ reason: URL_OR_PROJECT_ID });
    expect(isBundledRealvirtualCatalogUrl('/library/catalog.json')).toBe(true);
    expect(isBundledRealvirtualCatalogUrl('https://web.realvirtual.io/app/library/catalog.json')).toBe(true);
    expect(isBundledRealvirtualCatalogUrl(`${window.location.origin}/app/library/catalog.json`)).toBe(true);
    // A partner's own catalog at the same path is the partner's library, not the shim.
    expect(isBundledRealvirtualCatalogUrl('https://partner.example/library/catalog.json')).toBe(false);
    expect(isBundledRealvirtualCatalogUrl('https://github.com/game4automation/realvirtual-Library')).toBe(false);

    const shim = await reg.execute('library.attach', { url: '/library/catalog.json' }, { origin: 'mcp', viewer });
    expect(shim.ok, JSON.stringify(shim)).toBe(true);
    expect(readLibraryRefs(store.project)).toEqual([
      { url: 'https://x/catalog.json' },
      { projectId: REALVIRTUAL_LIBRARY_PROJECT_ID, label: 'realvirtual Library' },
    ]);
    // …and detaching by the same legacy URL removes the project entry (no URL entry left to match).
    const off = await reg.execute('library.detach', { url: '/library/catalog.json' }, { origin: 'mcp', viewer });
    expect(off.ok, JSON.stringify(off)).toBe(true);
    expect(readLibraryRefs(store.project)).toEqual([{ url: 'https://x/catalog.json' }]);
  });

  it('a manifest that still lists the bundled URL (unmigrated) detaches it by URL', async () => {
    const store = new FakeProjectStore([{ url: '/library/catalog.json' }, { projectId: 'prj_b' }]);
    setLibraryCommandDepsForTests({ project: store, library: {
      addCatalog: async () => {}, removeCatalog: () => {}, applyProjectLibraries: async () => {},
      catalogUrls: [], catalogErrors: new Map(), catalogs: new Map(), getOrigin: () => null,
    } as never });
    const reg = new CommandRegistry();
    ensureLibraryCommandsRegistered(reg);
    const r = await reg.execute('library.detach', { url: '/library/catalog.json' }, { origin: 'ui', viewer: VIEWER_WITH([]) });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(readLibraryRefs(store.project)).toEqual([{ projectId: 'prj_b' }]);
  });

  it('detach by projectId reports how many placements stay as missing', async () => {
    const store = new FakeProjectStore([{ projectId: 'prj_b' }]);
    setLibraryCommandDepsForTests({ project: store });
    const reg = new CommandRegistry();
    ensureLibraryCommandsRegistered(reg);
    const viewer = VIEWER_WITH([
      { providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: 'prj_b' },
      { providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: 'prj_b' },
    ]);
    const r = await reg.execute('library.detach', { projectId: 'prj_b' }, { origin: 'ui', viewer });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ projectId: 'prj_b', placements: 2, libraries: [] });
  });
});

describe('plan-778 9.7 — re-attach restores, library.list rows', () => {
  function loaderWith(backends: Record<string, ProjectBackend>): LibraryProjectLoader {
    const deps: LibraryProjectLoaderDeps = {
      factory: {
        folder: () => { throw new Error('no folders here'); },
        browser: (id) => backends[id] ?? null,
        remote: () => ({ readManifest: async () => null }) as never,
      },
      builtinBaseUrl: () => null,
    };
    return new LibraryProjectLoader(deps);
  }

  it('a qualified placement stops resolving on detach and resolves again on re-attach (nothing deleted)', async () => {
    const b = fakeLibraryProject({ id: 'prj_b', name: 'SharedConveyors', kind: 'browser', documents: [{ id: 'models/pump', path: 'models/pump.glb' }] });
    const loader = loaderWith({ prj_b: b.backend });
    installLibraryProjectsProvider(loader);
    const store = new FakeProjectStore([{ projectId: 'prj_b' }]);
    const ref = { assetId: 'models/pump', providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: 'prj_b' };
    const placed = [{ providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: 'prj_b' }];

    loader.setProject(store.project);
    await loader.whenSettled();
    expect(findQualifiedOrigin(ref)?.registered.source.id).toBe('prj_b');

    expect((await detachProjectLibrary('prj_b', { project: store, placements: countLibraryPlacements(placed, 'prj_b') })).ok).toBe(true);
    loader.setProject(store.project);   // main.ts follows the manifest the same way
    await loader.whenSettled();
    expect(findQualifiedOrigin(ref)).toBeNull();   // → missing-reference placeholder
    expect(placed).toHaveLength(1);                // the placement record is untouched

    expect((await attachProjectLibrary({ projectId: 'prj_b' }, { project: store })).ok).toBe(true);
    loader.setProject(store.project);
    await loader.whenSettled();
    expect(findQualifiedOrigin(ref)?.registered.source.id).toBe('prj_b');
    loader.dispose();
  });

  it('library.list rows: direct then transitive, with scope, state, neededBy and the repair', async () => {
    const b = fakeLibraryProject({
      id: 'prj_b', name: 'SharedConveyors', kind: 'browser', documents: [{ id: 'd1', path: 'd1.glb' }],
      libraries: [{ projectId: 'prj_motors', label: 'Motors' }],
    });
    const loader = loaderWith({ prj_b: b.backend });
    loader.setProject({ id: 'prj_a', name: 'A', libraries: [{ projectId: 'prj_b' }] } as unknown as RvProject);
    await loader.whenSettled();
    expect(listLibraryProjectRows(loader)).toEqual([
      {
        projectId: 'prj_b', label: 'SharedConveyors', scope: 'direct', state: 'ready', neededBy: [],
        hint: null, entries: 1, error: null, repair: null,
      },
      {
        projectId: 'prj_motors', label: 'Motors', scope: 'transitive', state: 'unknown', neededBy: ['SharedConveyors'],
        hint: null, entries: 0, error: 'Unknown on this computer.', repair: 'library.locate',
      },
    ]);
    // The built-in realvirtual library (resolution-only, unlisted) is not a row.
    expect(listLibraryProjectRows(loader).some((r) => r.projectId === REALVIRTUAL_LIBRARY_PROJECT_ID)).toBe(false);
    const store = new FakeProjectStore();
    const list = listLibraries({ project: store, library: {
      addCatalog: async () => {}, removeCatalog: () => {}, applyProjectLibraries: async () => {},
      catalogUrls: [], catalogErrors: new Map(), catalogs: new Map(), getOrigin: () => null,
    } as never, loader });
    expect(list.libraryProjects.map((r) => r.projectId)).toEqual(['prj_b', 'prj_motors']);
    loader.dispose();
  });
});

describe('plan-778 review U1/U2', () => {
  afterEach(() => { setLibraryCommandDepsForTests(null); uninstallLibraryProjectsProvider(); });

  it('U1: the realvirtual library and a library another one still needs stay available — no "will show as missing"', async () => {
    const b = fakeLibraryProject({ id: 'prj_b', name: 'Conveyors', libraries: [{ projectId: 'prj_c' }] as RvProject['libraries'] });
    const c = fakeLibraryProject({ id: 'prj_c', name: 'Motors' });
    const loader = new LibraryProjectLoader({
      factory: { folder: () => { throw new Error('x'); }, browser: (id) => ({ prj_b: b.backend, prj_c: c.backend } as Record<string, ProjectBackend>)[id] ?? null, remote: () => ({ readManifest: async () => null }) as unknown as ProjectBackend },
      builtinBaseUrl: () => null,
    });
    loader.setProject({ id: 'prj_a', name: 'A', libraries: [{ projectId: 'prj_b' }, { projectId: 'prj_c' }, { projectId: REALVIRTUAL_LIBRARY_PROJECT_ID }] } as unknown as RvProject);
    await loader.whenSettled();

    expect(libraryRemovalKeepsAvailable(loader, 'prj_c')).toEqual({ neededBy: 'Conveyors' });
    expect(libraryRemovalKeepsAvailable(loader, REALVIRTUAL_LIBRARY_PROJECT_ID)).toEqual({ builtin: true });
    expect(libraryRemovalKeepsAvailable(loader, 'prj_b')).toBeNull();   // nothing else needs B

    const keepsC = detachConfirmationMessage('Motors', 3, libraryRemovalKeepsAvailable(loader, 'prj_c'));
    expect(keepsC).not.toContain('missing');
    expect(keepsC).toContain("'Conveyors' still needs it");
    expect(keepsC).toContain('3 placements use this library and keep working');
    const keepsRv = detachConfirmationMessage('realvirtual Library', 0, { builtin: true });
    expect(keepsRv).toContain('always available');
    expect(keepsRv).not.toContain('restores');
    // Count 0 without a keeper: no "restores them" sentence.
    expect(detachConfirmationMessage('Conveyors', 0)).toBe("No placement uses the library 'Conveyors'. Nothing is deleted.");
  });

  it('U2: an unmigrated bundled URL counts as the attached realvirtual library — Remove enabled, attach writes no second entry', async () => {
    const store = new FakeProjectStore([{ url: 'library/catalog.json', label: 'Std' }], 'prj_cust');
    (store.project as unknown as Record<string, unknown>).kind = 'customer';
    expect(attachedLibraryProjectIdsOf(store.project)).toEqual([REALVIRTUAL_LIBRARY_PROJECT_ID]);
    expect(libraryProjectIdsOf(store.project)).toEqual([]);

    setLibraryCommandDepsForTests({ project: store });
    const reg = new CommandRegistry();
    ensureLibraryCommandsRegistered(reg);
    const viewer = VIEWER_WITH([]);
    expect(reg.enabled('library.detach', { projectId: REALVIRTUAL_LIBRARY_PROJECT_ID }, viewer)).toBe(true);

    const again = await attachProjectLibrary({ projectId: REALVIRTUAL_LIBRARY_PROJECT_ID }, { project: store });
    expect(again.ok && again.alreadyAttached).toBe(true);
    expect(store.writes).toBe(0);
    expect(readLibraryRefs(store.project)).toEqual([{ url: 'library/catalog.json', label: 'Std' }]);
  });
});
