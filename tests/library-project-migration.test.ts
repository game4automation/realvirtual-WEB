// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-778 9.11 — the realvirtual library reference migration (F14).
 *
 * Pure rules (`rv-project-library-migration`), the store hook that applies them
 * on the first manifest-writing save of a writable project, the customer rule
 * (Decision B: Problems row + `library.migrate`, never an automatic write) and
 * `newProject()` pre-listing the library.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';
import {
  getProjectStore,
  resetProjectStore,
  type ProjectSnapshot,
  type ProjectStore,
} from '../src/core/project/project-store';
import type { ProjectBackend } from '../src/core/project/backends/project-backend';
import { newProject, type RvProject } from '../src/core/project/rv-project-types';
import {
  LIBRARY_PROJECT_MIGRATION_MARKER,
  hasLegacyRealvirtualLibraryUrl,
  isMigratableLibraryUrl,
  libraryReferenceUpdatePending,
  migrateLibraryProject,
  readLibraryMigrationMarker,
  rollbackLibraryMigration,
} from '../src/core/project/rv-project-library-migration';
import {
  applyLibraryReferenceUpdate,
  installLibraryReferenceUpdate,
  libraryReferenceUpdateProblemId,
  LIBRARY_MIGRATE_COMMAND,
  migrateRefusal,
  NOTHING_TO_UPDATE,
} from '../src/core/library/library-reference-update';
import { clearProblem, getProblem } from '../src/core/hmi/problems-store';
import { CommandRegistry } from '../src/core/hmi/rv-command-registry';
import { ensureLibraryCommandsRegistered, setLibraryCommandDepsForTests } from '../src/core/library/library-commands';
import { readLibraryRefs } from '../src/core/library/project-libraries';

const ID = 'prj_realvirtual_library';
const NOW = () => '2026-11-03T12:00:00.000Z';

function project(libraries?: unknown, extra: Record<string, unknown> = {}): RvProject {
  return {
    schemaVersion: 2, id: 'prj_a', name: 'Plant A', canonicalName: 'plant-a', documents: [],
    ...(libraries !== undefined ? { libraries } : {}), ...extra,
  } as unknown as RvProject;
}

// ─── Pure rules ─────────────────────────────────────────────────────────

describe('migrateLibraryProject — URL forms', () => {
  const FORMS = [
    'library/catalog.json',
    '/library/catalog.json',
    './library/catalog.json',
    'https://web.realvirtual.io/library/catalog.json',
    'HTTPS://WEB.REALVIRTUAL.IO/Library/Catalog.json',
    'https://realvirtual.io/library/catalog.json',
    'https://web.realvirtual.io/demo/library/catalog.json?v=3',
    'http://localhost:5173/library/catalog.json',
    'http://127.0.0.1:5100/library/catalog.json',
    'http://[::1]:5173/app/library/catalog.json',
    'https://github.com/game4automation/realvirtual-Library',
    'https://github.com/game4automation/realvirtual-Library/',
    'https://github.com/game4automation/realvirtual-Library.git',
    'https://github.com/game4automation/realvirtual-Library/tree/main',
    'https://github.com/game4automation/realvirtual-Library/tree/main/PalletHandling',
    'HTTPS://GitHub.com/Game4Automation/realvirtual-library/',
  ];

  for (const url of FORMS) {
    it(`converts ${url}`, () => {
      const r = migrateLibraryProject(project([{ url, label: 'Lib', extra: { keep: 1 }, other: true }]), { now: NOW });
      expect(r.outcome).toBe('migrated');
      expect(r.converted).toBe(1);
      expect(readLibraryRefs(r.project)).toEqual([
        { projectId: ID, label: 'Lib', extra: { keep: 1 }, other: true, hint: url },
      ]);
      expect((r.project.libraries?.[0] as Record<string, unknown>).url).toBeUndefined();
    });
  }

  it('converts a bare string entry', () => {
    const r = migrateLibraryProject(project(['library/catalog.json']), { now: NOW });
    expect(r.project.libraries).toEqual([{ projectId: ID, hint: 'library/catalog.json' }]);
  });

  it('leaves external catalogs untouched, still sets the marker', () => {
    const external = [{ url: '/_tmp/interroll/catalog.json', label: 'Interroll' }, { url: 'https://acme.example/parts/catalog.json' }];
    const r = migrateLibraryProject(project(external), { now: NOW });
    expect(r.outcome).toBe('migrated');
    expect(r.converted).toBe(0);
    expect(r.project.libraries).toEqual(external);
    expect(readLibraryMigrationMarker(r.project)?.replaced).toEqual([]);
  });

  it('a partner host serving its own …/library/catalog.json stays a URL entry (host restriction)', () => {
    const partner = [
      { url: 'https://partner.example/library/catalog.json', label: 'Partner' },
      { url: 'https://realvirtual.io.partner.example/library/catalog.json' },
      { url: 'https://notrealvirtual.io/library/catalog.json' },
      { url: '//partner.example/library/catalog.json' },
    ];
    for (const { url } of partner) expect(isMigratableLibraryUrl(url), url).toBe(false);
    const r = migrateLibraryProject(project(partner), { now: NOW });
    expect(r.converted).toBe(0);
    expect(r.project.libraries).toEqual(partner);
  });

  it('the app\'s own origin counts as a realvirtual host', () => {
    const own = `${window.location.origin}/some/base/library/catalog.json`;
    expect(isMigratableLibraryUrl(own)).toBe(true);
    const r = migrateLibraryProject(project([{ url: own }]), { now: NOW });
    expect(r.project.libraries).toEqual([{ projectId: ID, hint: own }]);
  });

  it('keeps entry order and converts only the realvirtual entry among others', () => {
    const r = migrateLibraryProject(project([
      { url: 'https://x.example/a.json' }, { url: 'library/catalog.json' }, { projectId: 'prj_b' },
    ]), { now: NOW });
    expect(r.project.libraries).toEqual([
      { url: 'https://x.example/a.json' }, { projectId: ID, hint: 'library/catalog.json' }, { projectId: 'prj_b' },
    ]);
  });

  it('two realvirtual URL entries collapse into one id entry; rollback brings both back', () => {
    const before = project([{ url: 'library/catalog.json' }, { url: 'https://github.com/game4automation/realvirtual-Library' }]);
    const r = migrateLibraryProject(before, { now: NOW });
    expect(r.project.libraries).toEqual([{ projectId: ID, hint: 'library/catalog.json' }]);
    expect(r.converted).toBe(2);
    expect(rollbackLibraryMigration(r.project)).toEqual(before);
  });

  it('an id entry that is already listed absorbs the URL entry', () => {
    const r = migrateLibraryProject(project([{ projectId: ID, label: 'Mine' }, { url: 'library/catalog.json' }]), { now: NOW });
    expect(r.project.libraries).toEqual([{ projectId: ID, label: 'Mine' }]);
  });
});

describe('migrateLibraryProject — absent / explicit empty / marker', () => {
  it('libraries ABSENT → the realvirtual library is added, marker in the same result', () => {
    const r = migrateLibraryProject(project(), { now: NOW });
    expect(r.outcome).toBe('migrated');
    expect(r.added).toBe(true);
    expect(r.project.libraries).toEqual([{ projectId: ID, label: 'realvirtual Library' }]);
    expect(r.project[LIBRARY_PROJECT_MIGRATION_MARKER]).toMatchObject({ at: NOW(), added: true, hadLibraries: false });
  });

  it('an explicit [] stays [] (the user removed it) — marker only', () => {
    const r = migrateLibraryProject(project([]), { now: NOW });
    expect(r.outcome).toBe('migrated');
    expect(r.added).toBe(false);
    expect(r.project.libraries).toEqual([]);
    expect(readLibraryMigrationMarker(r.project)).not.toBeNull();
  });

  it('two runs are idempotent: the second is "already" and returns the same object', () => {
    const first = migrateLibraryProject(project([{ url: 'library/catalog.json' }]), { now: NOW });
    const second = migrateLibraryProject(first.project, { now: NOW });
    expect(second.outcome).toBe('already');
    expect(second.project).toBe(first.project);
  });

  it('a removal after the migration is not undone (marker holds, also when libraries disappears)', () => {
    const migrated = migrateLibraryProject(project(), { now: NOW }).project;
    const { libraries: _gone, ...removed } = migrated as Record<string, unknown>;
    const again = migrateLibraryProject(removed as unknown as RvProject, { now: NOW });
    expect(again.outcome).toBe('already');
    expect((again.project as RvProject).libraries).toBeUndefined();
  });
});

describe('rollbackLibraryMigration', () => {
  it('restores the replaced URL entry verbatim and drops the marker', () => {
    const before = project([{ url: 'library/catalog.json', label: 'Lib', odd: 1 }]);
    const after = migrateLibraryProject(before, { now: NOW }).project;
    expect(rollbackLibraryMigration(after)).toEqual(before);
  });

  it('removes an entry the migration added; libraries disappears again when it was absent', () => {
    const before = project();
    const after = migrateLibraryProject(before, { now: NOW }).project;
    expect(rollbackLibraryMigration(after)).toEqual(before);
  });

  it('does not resurrect a library the user removed meanwhile; a project without marker is returned as is', () => {
    const before = project([{ url: 'library/catalog.json' }]);
    const after = migrateLibraryProject(before, { now: NOW }).project;
    const removed = { ...after, libraries: [] } as RvProject;
    expect(rollbackLibraryMigration(removed).libraries).toEqual([]);
    expect(rollbackLibraryMigration(before)).toBe(before);
  });

  it('keeps a pre-existing id entry with its label and brings the absorbed URL entry back (review E9)', () => {
    const before = project([{ projectId: ID, label: 'Mine' }, { url: 'library/catalog.json' }]);
    const after = migrateLibraryProject(before, { now: NOW }).project;
    expect(rollbackLibraryMigration(after)).toEqual(before);
  });
});

describe('customer projects (Decision B)', () => {
  const customer = () => project([{ url: 'https://github.com/game4automation/realvirtual-Library' }], { kind: 'customer' });

  it('are skipped by the automatic migration and flagged as update-pending', () => {
    const c = customer();
    const r = migrateLibraryProject(c, { now: NOW });
    expect(r.outcome).toBe('skipped');
    expect(r.project).toBe(c);
    expect(libraryReferenceUpdatePending(c)).toBe(true);
    expect(libraryReferenceUpdatePending(project([{ url: 'library/catalog.json' }]))).toBe(false);    // not a customer
    expect(libraryReferenceUpdatePending(project([{ url: '/_tmp/x/catalog.json' }], { kind: 'customer' }))).toBe(false); // nothing to convert
  });

  it('force (the user clicked Update) migrates them', () => {
    const r = migrateLibraryProject(customer(), { force: true, now: NOW });
    expect(r.outcome).toBe('migrated');
    expect(r.project.libraries).toEqual([{ projectId: ID, hint: 'https://github.com/game4automation/realvirtual-Library' }]);
    expect(libraryReferenceUpdatePending(r.project)).toBe(false);
    expect(hasLegacyRealvirtualLibraryUrl(r.project)).toBe(false);
  });
});

describe('newProject()', () => {
  it('pre-lists the realvirtual library and is born migrated, so a removal is final', () => {
    const p = newProject('Fresh');
    expect(p.libraries).toEqual([{ projectId: ID, label: 'realvirtual Library' }]);
    expect(readLibraryMigrationMarker(p)).toMatchObject({ born: true });
    const removed = { ...p } as Record<string, unknown>;
    delete removed.libraries;
    expect(migrateLibraryProject(removed as unknown as RvProject).outcome).toBe('already');
  });
});

// ─── The store hook: first manifest-writing save ─────────────────────────

const MANIFEST = 'project.json';

async function readDisk(dir: FakeDir): Promise<RvProject> {
  const file = await (await dir.getFileHandle(MANIFEST)).getFile();
  return JSON.parse(await file.text()) as RvProject;
}

async function harness(manifest: RvProject, opts: { writable?: boolean } = {}): Promise<{ store: ProjectStore; dir: FakeDir }> {
  resetProjectStore();
  const store = getProjectStore();
  const dir = new FakeDir('plant');
  const backend = { kind: 'folder', id: 'fake', writable: opts.writable !== false, writeManifest: undefined } as unknown as ProjectBackend;
  const internals = store as unknown as {
    _backend: unknown; _dir: unknown; _project: RvProject | null; _snapshot: ProjectSnapshot; _userDocuments: unknown[];
  };
  internals._backend = backend;
  internals._dir = asDirHandle(dir);
  const handle = await dir.getFileHandle(MANIFEST, { create: true });
  const w = await handle.createWritable();
  await w.write(JSON.stringify(manifest, null, 2));
  await w.close();
  internals._project = manifest;
  internals._userDocuments = [];
  internals._snapshot = { ...store.getSnapshot(), project: manifest, documents: [], writable: opts.writable !== false, backendKind: 'folder' } as unknown as ProjectSnapshot;
  return { store, dir };
}

describe('the store applies it on the first manifest-writing save', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { resetProjectStore(); });

  it('converts the URL and writes the marker in the SAME write; the second save changes nothing more', async () => {
    const { store, dir } = await harness(project([{ url: 'library/catalog.json', label: 'Lib' }]));
    await store.applyManifestDelta((c) => ({ ...c, description: 'touched' } as RvProject));
    const disk = await readDisk(dir);
    expect(disk.libraries).toEqual([{ projectId: ID, label: 'Lib', hint: 'library/catalog.json' }]);
    expect(disk[LIBRARY_PROJECT_MIGRATION_MARKER]).toBeDefined();
    expect((disk as Record<string, unknown>).description).toBe('touched');
    expect(store.getProject()?.libraries).toEqual(disk.libraries);

    const markerBefore = JSON.stringify(disk[LIBRARY_PROJECT_MIGRATION_MARKER]);
    await store.applyManifestDelta((c) => ({ ...c, description: 'again' } as RvProject));
    const disk2 = await readDisk(dir);
    expect(disk2.libraries).toEqual(disk.libraries);
    expect(JSON.stringify(disk2[LIBRARY_PROJECT_MIGRATION_MARKER])).toBe(markerBefore);
  });

  it('adds the library to a project without libraries[]; removing it in a later save sticks', async () => {
    const { store, dir } = await harness(project());
    await store.applyManifestDelta((c) => ({ ...c, description: 'x' } as RvProject));
    expect((await readDisk(dir)).libraries).toEqual([{ projectId: ID, label: 'realvirtual Library' }]);

    await store.applyManifestDelta((c) => {
      const { libraries: _l, ...rest } = c as Record<string, unknown>;
      return rest as unknown as RvProject;
    });
    await store.applyManifestDelta((c) => ({ ...c, description: 'y' } as RvProject));
    expect((await readDisk(dir)).libraries).toBeUndefined();
  });

  it('a user removal inside the very first save is not undone', async () => {
    const { store, dir } = await harness(project([{ url: 'library/catalog.json' }]));
    await store.applyManifestDelta((c) => ({ ...c, libraries: [] } as unknown as RvProject));
    await store.applyManifestDelta((c) => ({ ...c, description: 'z' } as RvProject));
    expect((await readDisk(dir)).libraries).toEqual([]);
  });

  it('a read-only project is skipped: no migration, nothing written', async () => {
    const original = project([{ url: 'library/catalog.json' }]);
    const { store, dir } = await harness(original, { writable: false });
    await store.applyManifestDelta((c) => ({ ...c, description: 'x' } as RvProject));
    expect(await readDisk(dir)).toEqual(original);
  });

  it('a customer project is never written on its own', async () => {
    const original = project([{ url: 'https://github.com/game4automation/realvirtual-Library/' }], { kind: 'customer' });
    const { store, dir } = await harness(original);
    await store.applyManifestDelta((c) => ({ ...c, description: 'x' } as RvProject));
    const disk = await readDisk(dir);
    expect(disk.libraries).toEqual(original.libraries);
    expect(disk[LIBRARY_PROJECT_MIGRATION_MARKER]).toBeUndefined();
  });
});

// ─── Customer: Problems row + library.migrate ────────────────────────────

describe('customer: Problems row "Library reference can be updated" and library.migrate', () => {
  afterEach(() => {
    resetProjectStore();
    setLibraryCommandDepsForTests(null);
    clearProblem(libraryReferenceUpdateProblemId('prj_a'));
  });

  const customer = () => project([{ url: 'https://github.com/game4automation/realvirtual-Library/', label: 'Lib' }], { kind: 'customer' });

  it('shows an info row with Update for a writable customer project; Update writes through applyManifestDelta', async () => {
    const { store, dir } = await harness(customer());
    const stop = installLibraryReferenceUpdate(store as never);
    const row = getProblem(libraryReferenceUpdateProblemId('prj_a'))!;
    expect(row).toBeDefined();
    expect([row.severity, row.code, row.quiet]).toEqual(['info', 'library-reference-update', true]);
    expect(row.title).toBe('Library reference can be updated');
    expect(row.action).toEqual({ label: 'Update', commandId: LIBRARY_MIGRATE_COMMAND, args: {} });

    // The row alone writes nothing.
    expect((await readDisk(dir)).libraries).toEqual(customer().libraries);

    const registry = new CommandRegistry();
    ensureLibraryCommandsRegistered(registry);
    setLibraryCommandDepsForTests({ project: store as never });
    const viewer = { modes: { activeMode: 'planner' }, getPlugin: () => undefined } as never;
    const result = await registry.execute(LIBRARY_MIGRATE_COMMAND, {}, { origin: 'ui', viewer });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) expect(result.value).toMatchObject({ ok: true, converted: 1 });

    const disk = await readDisk(dir);
    expect(disk.libraries).toEqual([{ projectId: ID, label: 'Lib', hint: 'https://github.com/game4automation/realvirtual-Library/' }]);
    expect(disk[LIBRARY_PROJECT_MIGRATION_MARKER]).toBeDefined();
    expect(getProblem(libraryReferenceUpdateProblemId('prj_a'))).toBeUndefined();   // pending is gone → row cleared
    stop();
  });

  it('no row for a read-only customer project or a non-customer project; refusal texts name why', async () => {
    const ro = await harness(customer(), { writable: false });
    const stop = installLibraryReferenceUpdate(ro.store as never);
    expect(getProblem(libraryReferenceUpdateProblemId('prj_a'))).toBeUndefined();
    expect(migrateRefusal(ro.store as never)).toMatch(/read-only/);
    stop();

    const normal = await harness(project([{ url: 'library/catalog.json' }]));
    const stop2 = installLibraryReferenceUpdate(normal.store as never);
    expect(getProblem(libraryReferenceUpdateProblemId('prj_a'))).toBeUndefined();
    stop2();
  });

  it('a second Update says there is nothing to update', async () => {
    const { store } = await harness(customer());
    expect((await applyLibraryReferenceUpdate(store as never)).ok).toBe(true);
    expect(await applyLibraryReferenceUpdate(store as never)).toEqual({ ok: false, reason: NOTHING_TO_UPDATE });
    expect(migrateRefusal(store as never)).toBe(NOTHING_TO_UPDATE);
  });
});

// ─── plan-778 review E1 — detach by URL on an unmigrated project's first save ──

describe('review E1: a realvirtual URL detach is never undone by the migration fold', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { resetProjectStore(); setLibraryCommandDepsForTests(null); });

  const STUB_VIEWER = { modes: { activeMode: 'planner' }, getPlugin: () => undefined } as never;
  const FAKE_LIBRARY_STORE = {
    addCatalog: async () => {}, removeCatalog: () => {}, applyProjectLibraries: async () => {},
    catalogUrls: [], catalogErrors: new Map(), catalogs: new Map(), getOrigin: () => null,
  } as never;

  for (const url of ['library/catalog.json', 'https://github.com/game4automation/realvirtual-Library/']) {
    it(`library.detach {url: ${url}} on the first save: the library is gone on disk, marker set`, async () => {
      const { store, dir } = await harness(project([{ url }, { url: 'https://partner.example/catalog.json' }]));
      setLibraryCommandDepsForTests({ project: store as never, library: FAKE_LIBRARY_STORE });
      const reg = new CommandRegistry();
      ensureLibraryCommandsRegistered(reg);
      const r = await reg.execute('library.detach', { url }, { origin: 'ui', viewer: STUB_VIEWER });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      const disk = await readDisk(dir);
      expect(disk.libraries).toEqual([{ url: 'https://partner.example/catalog.json' }]);
      expect(disk[LIBRARY_PROJECT_MIGRATION_MARKER]).toBeDefined();
      // A later save does not bring it back.
      await store.applyManifestDelta((c) => ({ ...c, description: 'later' } as RvProject));
      expect((await readDisk(dir)).libraries).toEqual([{ url: 'https://partner.example/catalog.json' }]);
    });
  }

  it('detaching prj_realvirtual_library drops the id AND every realvirtual URL entry in ONE delta (customer project, no fold)', async () => {
    const { store, dir } = await harness(project([
      { url: '/library/catalog.json' },
      { url: 'https://github.com/game4automation/realvirtual-Library.git' },
      { url: 'https://partner.example/catalog.json' },
    ], { kind: 'customer' }));
    setLibraryCommandDepsForTests({ project: store as never, library: FAKE_LIBRARY_STORE });
    const reg = new CommandRegistry();
    ensureLibraryCommandsRegistered(reg);
    expect(reg.enabled('library.detach', { projectId: ID }, STUB_VIEWER)).toBe(true);
    const r = await reg.execute('library.detach', { projectId: ID }, { origin: 'ui', viewer: STUB_VIEWER });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect((await readDisk(dir)).libraries).toEqual([{ url: 'https://partner.example/catalog.json' }]);
  });
});

describe('review E6: the realvirtual library project itself', () => {
  it('is never migrated — no self-entry, no marker', () => {
    const lib = { ...project(), id: ID, name: 'realvirtual Library' } as RvProject;
    const r = migrateLibraryProject(lib, { now: NOW });
    expect(r.outcome).toBe('skipped');
    expect(r.project).toBe(lib);
    expect(r.project.libraries).toBeUndefined();
    expect(readLibraryMigrationMarker(r.project)).toBeNull();
  });
});

describe('review E8: library.migrate counts on a non-customer project', () => {
  afterEach(() => { resetProjectStore(); });

  it('reports what was converted although the store fold migrated first', async () => {
    const { store, dir } = await harness(project([{ url: 'library/catalog.json' }, { url: 'https://partner.example/catalog.json' }]));
    const r = await applyLibraryReferenceUpdate(store as never);
    expect(r).toEqual({ ok: true, converted: 1, added: false, hadLegacyUrl: true });
    const disk = await readDisk(dir);
    expect(disk.libraries).toEqual([
      { projectId: ID, hint: 'library/catalog.json' },
      { url: 'https://partner.example/catalog.json' },
    ]);
  });
});
