// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-778 9.2 — the library project loader.
 *
 * Folder libraries run through the REAL `FolderBackend` (non-activated,
 * `writable:false`, `id:'folder:<projectId>'`) over `FakeDir` handles — that is
 * also the confirmation of the Phase-1 spike: a backend that was never
 * activated reads its manifest (through the store's own migration ladder),
 * lists its documents and hands out document URLs.
 */
import { describe, it, expect } from 'vitest';
import { FolderBackend } from '../src/core/project/backends/folder-backend';
import { ensureHandlePermission } from '../src/core/engine/rv-local-filesystem';
import type { ProjectBackend } from '../src/core/project/backends/project-backend';
import type { RvProject } from '../src/core/project/rv-project-types';
import {
  LibraryProjectLoader,
  githubRawBase,
  hostedBaseOf,
  type LibraryBackendFactory,
  type LibraryProjectLoaderDeps,
} from '../src/core/library/library-project-loader';
import { REALVIRTUAL_LIBRARY_PROJECT_ID } from '../src/core/library/library-origin';
import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';
import { fakeGlb, fakeLibraryProject } from './helpers/fake-document-project';

const NOW = '2026-11-03T00:00:00.000Z';

/** A project folder on "disk": manifest + one GLB per document. */
function projectFolder(dirName: string, id: string, opts: {
  name?: string; docs?: string[]; libraries?: unknown[];
} = {}): FakeDir {
  const dir = new FakeDir(dirName);
  const docs = opts.docs ?? ['pump'];
  dir.seedText('project.json', JSON.stringify({
    schemaVersion: 2, id, name: opts.name ?? dirName, canonicalName: dirName.toLowerCase(),
    createdAt: NOW, modifiedAt: NOW,
    documents: docs.map((d) => ({ id: `doc_${d}`, path: `models/${d}.glb`, name: d })),
    ...(opts.libraries ? { libraries: opts.libraries } : {}),
  }));
  const models = dir.seedDir('models');
  for (const d of docs) models.seedBytes(`${d}.glb`, fakeGlb(`${id}:${d}`));
  return dir;
}

function projectA(libraries: unknown[]): RvProject {
  return { schemaVersion: 2, id: 'prj_a', name: 'A', canonicalName: 'a', libraries } as unknown as RvProject;
}

interface Env {
  deps: LibraryProjectLoaderDeps;
  folders: Map<string, FakeDir>;
  browsers: Map<string, ProjectBackend>;
  remotes: Map<string, ProjectBackend>;
  remoteCalls: string[];
  built: ProjectBackend[];
}

function env(over: Partial<LibraryProjectLoaderDeps> = {}): Env {
  const folders = new Map<string, FakeDir>();
  const browsers = new Map<string, ProjectBackend>();
  const remotes = new Map<string, ProjectBackend>();
  const remoteCalls: string[] = [];
  const built: ProjectBackend[] = [];
  const factory: LibraryBackendFactory = {
    folder: (handle, projectId) => {
      const b = new FolderBackend(handle, { writable: false, id: `folder:${projectId}` });
      built.push(b);
      return b;
    },
    browser: (projectId) => browsers.get(projectId) ?? null,
    remote: (base) => {
      remoteCalls.push(base);
      const b = remotes.get(base);
      if (b) return b;
      return { readManifest: async () => null } as unknown as ProjectBackend;
    },
  };
  return {
    folders, browsers, remotes, remoteCalls, built,
    deps: {
      factory,
      getLinkedHandle: async (id) => (folders.has(id) ? asDirHandle(folders.get(id)!) : null),
      hasReadPermission: async (h) => (await ensureHandlePermission(h, { mode: 'read', prompt: false })) !== null,
      builtinBaseUrl: () => null,
      ...over,
    },
  };
}

describe('plan-778 9.2 — locations', () => {
  it('folder with a read grant: ready via folder, real non-activated FolderBackend, documents listed', async () => {
    const e = env();
    e.folders.set('prj_b', projectFolder('Shared', 'prj_b', { docs: ['pump', 'valve'] }));
    const loader = new LibraryProjectLoader(e.deps);
    loader.setProject(projectA([{ projectId: 'prj_b' }]));
    await loader.whenSettled();
    const b = loader.getNode('prj_b')!;
    expect(b.state.kind).toBe('ready');
    if (b.state.kind !== 'ready') return;
    expect(b.state.via).toBe('folder');
    expect(b.label).toBe('Shared');
    expect(b.state.backend!.id).toBe('folder:prj_b');
    expect(b.state.backend!.isActive).toBe(false);
    expect(b.state.documents.map((d) => d.id).sort()).toEqual(['doc_pump', 'doc_valve']);
    const blob = await b.state.backend!.readDocumentUrl('models/pump.glb');
    expect(blob).not.toBeNull();
    blob!.release();
  });

  it('folder handle without a grant: locked, and NO permission prompt is made', async () => {
    const e = env();
    const dir = projectFolder('Shared', 'prj_b');
    dir.permissions.read = 'prompt';
    e.folders.set('prj_b', dir);
    const loader = new LibraryProjectLoader(e.deps);
    loader.setProject(projectA([{ projectId: 'prj_b' }]));
    await loader.whenSettled();
    expect(loader.getNode('prj_b')!.state.kind).toBe('locked');
    expect(dir.requestPermissionCalls).toBe(0);
  });

  it('folder denied: locked as well (failed and denied look alike)', async () => {
    const e = env();
    const dir = projectFolder('Shared', 'prj_b');
    dir.permissions.read = 'denied';
    e.folders.set('prj_b', dir);
    const loader = new LibraryProjectLoader(e.deps);
    loader.setProject(projectA([{ projectId: 'prj_b' }]));
    await loader.whenSettled();
    expect(loader.getNode('prj_b')!.state.kind).toBe('locked');
  });

  it('browser project: ready via browser', async () => {
    const e = env();
    e.browsers.set('prj_b', fakeLibraryProject({ id: 'prj_b', kind: 'browser', documents: [{ id: 'd1', path: 'd1' }] }).backend);
    const loader = new LibraryProjectLoader(e.deps);
    loader.setProject(projectA([{ projectId: 'prj_b' }]));
    await loader.whenSettled();
    const n = loader.getNode('prj_b')!;
    expect(n.state.kind === 'ready' && n.state.via).toBe('browser');
  });

  it('hosted hint: the folder URL of the hint is read; ready via hosted', async () => {
    const e = env();
    e.remotes.set('https://cdn/libs/b/', fakeLibraryProject({ id: 'prj_b', kind: 'bundled', documents: [{ id: 'd1', path: 'd1.glb' }] }).backend);
    const loader = new LibraryProjectLoader(e.deps);
    loader.setProject(projectA([{ projectId: 'prj_b', hint: 'https://cdn/libs/b/project.json' }]));
    await loader.whenSettled();
    const n = loader.getNode('prj_b')!;
    expect(n.state.kind === 'ready' && n.state.via).toBe('hosted');
    expect(e.remoteCalls).toEqual(['https://cdn/libs/b/']);
    expect(hostedBaseOf('https://cdn/libs/b')).toBe('https://cdn/libs/b/');
    expect(githubRawBase('https://github.com/game4automation/realvirtual-Library.git')?.rawBase)
      .toBe('https://raw.githubusercontent.com/game4automation/realvirtual-Library/HEAD/');
    expect(githubRawBase('https://github.com/o/r/tree/main/sub/')?.rawBase)
      .toBe('https://raw.githubusercontent.com/o/r/main/sub/');
  });

  it('nothing anywhere: unknown (a folder-name hint never resolves)', async () => {
    const loader = new LibraryProjectLoader(env().deps);
    loader.setProject(projectA([{ projectId: 'prj_b', hint: 'Shared' }]));
    await loader.whenSettled();
    expect(loader.getNode('prj_b')!.state.kind).toBe('unknown');
  });

  it('built-in realvirtual library: always present, resolvable, placeable only when listed (Decision C)', async () => {
    const e = env({ builtinBaseUrl: () => 'https://app/library/' });
    e.remotes.set('https://app/library/', fakeLibraryProject({
      id: REALVIRTUAL_LIBRARY_PROJECT_ID, name: 'realvirtual Library', kind: 'bundled',
      documents: [{ id: 'pallethandling-chainconveyor-1m', path: 'PalletHandling/ChainConveyor-1m.glb' }],
    }).backend);
    const loader = new LibraryProjectLoader(e.deps);
    loader.setProject(null);   // no project at all — embed / share link / free GLB
    await loader.whenSettled();
    let rv = loader.getNode(REALVIRTUAL_LIBRARY_PROJECT_ID)!;
    expect(rv.state.kind === 'ready' && rv.state.via).toBe('builtin');
    expect([rv.direct, rv.placeable]).toEqual([false, false]);

    loader.setProject(projectA([{ projectId: REALVIRTUAL_LIBRARY_PROJECT_ID }]));
    rv = loader.getNode(REALVIRTUAL_LIBRARY_PROJECT_ID)!;
    expect([rv.direct, rv.placeable, rv.state.kind]).toEqual([true, true, 'ready']);   // carried over, no flicker
  });
});

describe('plan-778 9.2 — identity, graph and lifecycle', () => {
  it('id mismatch: error naming both projects', async () => {
    const e = env();
    e.folders.set('prj_b', projectFolder('Motors', 'prj_motors', { name: 'Motors' }));
    const loader = new LibraryProjectLoader(e.deps);
    loader.setProject(projectA([{ projectId: 'prj_b', label: 'SharedConveyors' }]));
    await loader.whenSettled();
    const n = loader.getNode('prj_b')!;
    expect(n.state.kind).toBe('error');
    if (n.state.kind === 'error') {
      expect(n.state.reason).toContain('prj_motors');
      expect(n.state.reason).toContain('prj_b');
      expect(n.state.reason).toContain('Motors');
    }
  });

  it('A → B → C: C is transitive, not placeable, needed by B', async () => {
    const e = env();
    e.folders.set('prj_b', projectFolder('B', 'prj_b', { libraries: [{ projectId: 'prj_c' }] }));
    e.folders.set('prj_c', projectFolder('C', 'prj_c'));
    const loader = new LibraryProjectLoader(e.deps);
    loader.setProject(projectA([{ projectId: 'prj_b' }]));
    await loader.whenSettled();
    const c = loader.getNode('prj_c')!;
    expect(c.state.kind).toBe('ready');
    expect([c.direct, c.placeable, c.neededBy, c.depth]).toEqual([false, false, ['prj_b'], 2]);
    expect(loader.getNodes().map((n) => n.projectId)).toEqual(['prj_b', REALVIRTUAL_LIBRARY_PROJECT_ID, 'prj_c']);
  });

  it('A → B → A and A → A are harmless: A is never a library of itself; B loads once', async () => {
    const e = env();
    const b = projectFolder('B', 'prj_b', { libraries: [{ projectId: 'prj_a' }, { projectId: 'prj_b' }] });
    e.folders.set('prj_b', b);
    // "Loads once" = B's backend is opened once (its own listing re-reads the
    // manifest internally — that is the backend's business, not a second load).
    const loader = new LibraryProjectLoader(e.deps);
    loader.setProject(projectA([{ projectId: 'prj_b' }, { projectId: 'prj_a' }, { projectId: 'prj_b' }]));
    await loader.whenSettled();
    expect(loader.getNode('prj_a')).toBeNull();
    expect(loader.getNodes().filter((n) => n.projectId === 'prj_b')).toHaveLength(1);
    expect(e.built.map((x) => x.id)).toEqual(['folder:prj_b']);
  });

  it('a chain deeper than 16 libraries is refused at level 17', async () => {
    const e = env();
    for (let i = 1; i <= 17; i++) {
      e.folders.set(`prj_l${i}`, projectFolder(`L${i}`, `prj_l${i}`, i < 17 ? { libraries: [{ projectId: `prj_l${i + 1}` }] } : {}));
    }
    const loader = new LibraryProjectLoader(e.deps);
    loader.setProject(projectA([{ projectId: 'prj_l1' }]));
    await loader.whenSettled();
    expect(loader.getNode('prj_l16')!.state.kind).toBe('ready');
    const deepest = loader.getNode('prj_l17')!;
    expect(deepest.depth).toBe(17);
    expect(deepest.state.kind).toBe('error');
  });

  it('a project switch mid-load publishes nothing of the old load into the next project', async () => {
    const e = env();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = fakeLibraryProject({ id: 'prj_b', kind: 'browser' }).backend;
    const read = slow.readManifest.bind(slow);
    (slow as { readManifest: () => Promise<RvProject | null> }).readManifest = async () => { await gate; return read(); };
    e.browsers.set('prj_b', slow);
    const loader = new LibraryProjectLoader(e.deps);
    loader.setProject(projectA([{ projectId: 'prj_b' }]));
    expect(loader.getNode('prj_b')!.state.kind).toBe('pending');   // synchronous, before any await
    loader.setProject({ ...projectA([]), id: 'prj_x' } as RvProject);
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(loader.getNode('prj_b')).toBeNull();
  });

  it('invalidate (Grant / Locate): locked → ready without a new project switch', async () => {
    const e = env();
    const dir = projectFolder('B', 'prj_b');
    dir.permissions.read = 'prompt';
    e.folders.set('prj_b', dir);
    const loader = new LibraryProjectLoader(e.deps);
    loader.setProject(projectA([{ projectId: 'prj_b' }]));
    await loader.whenSettled();
    expect(loader.getNode('prj_b')!.state.kind).toBe('locked');
    dir.permissions.read = 'granted';
    loader.invalidate('prj_b');
    expect(loader.getNode('prj_b')!.state.kind).toBe('pending');
    await loader.whenSettled();
    expect(loader.getNode('prj_b')!.state.kind).toBe('ready');
  });

  it('runtime read failure: ready → error; invalidate retries', async () => {
    const e = env();
    e.folders.set('prj_b', projectFolder('B', 'prj_b'));
    const loader = new LibraryProjectLoader(e.deps);
    loader.setProject(projectA([{ projectId: 'prj_b' }]));
    await loader.whenSettled();
    loader.markError('prj_b', 'folder gone');
    expect(loader.getNode('prj_b')!.state).toEqual({ kind: 'error', reason: 'folder gone' });
    loader.invalidate('prj_b');
    await loader.whenSettled();
    expect(loader.getNode('prj_b')!.state.kind).toBe('ready');
  });

  it('an empty library is ready with 0 documents', async () => {
    const e = env();
    e.folders.set('prj_b', projectFolder('B', 'prj_b', { docs: [] }));
    const loader = new LibraryProjectLoader(e.deps);
    loader.setProject(projectA([{ projectId: 'prj_b' }]));
    await loader.whenSettled();
    const n = loader.getNode('prj_b')!;
    expect(n.state.kind === 'ready' && n.state.documents.length).toBe(0);
  });

  it('backend ids are unique per library even when both folders share a name', async () => {
    const e = env();
    e.folders.set('prj_b', projectFolder('Library', 'prj_b'));
    e.folders.set('prj_c', projectFolder('Library', 'prj_c'));
    const loader = new LibraryProjectLoader(e.deps);
    loader.setProject(projectA([{ projectId: 'prj_b' }, { projectId: 'prj_c' }]));
    await loader.whenSettled();
    expect(e.built.map((b) => b.id).sort()).toEqual(['folder:prj_b', 'folder:prj_c']);
  });
});

describe('plan-778 review fixes — loader', () => {
  it('C1: the built-in library URL resolves against the document (base "./", sub-path deploy, CONNECT)', async () => {
    const { builtinLibraryBaseUrl } = await import('../src/core/library/library-project-backends');
    expect(builtinLibraryBaseUrl('./', 'https://web.realvirtual.io/abc123/index.html?model=x'))
      .toBe('https://web.realvirtual.io/abc123/library/');
    expect(builtinLibraryBaseUrl('./', 'https://web.realvirtual.io/abc123/'))
      .toBe('https://web.realvirtual.io/abc123/library/');
    expect(builtinLibraryBaseUrl('./', 'http://127.0.0.1:5100/webviewer/#k=1'))
      .toBe('http://127.0.0.1:5100/webviewer/library/');
    expect(builtinLibraryBaseUrl('/', 'http://localhost:5173/some/page'))
      .toBe('http://localhost:5173/library/');
    expect(builtinLibraryBaseUrl('/sub', 'https://h/sub/x'))
      .toBe('https://h/sub/library/');
    expect(builtinLibraryBaseUrl('./', null)).toBe('./library/');
  });

  it('C2: re-expanding a carried library never drops its transitive sources from a publish', async () => {
    const e = env();
    e.browsers.set('prj_b', fakeLibraryProject({ id: 'prj_b', kind: 'browser', libraries: [{ projectId: 'prj_c' }] as RvProject['libraries'] }).backend);
    e.browsers.set('prj_c', fakeLibraryProject({ id: 'prj_c', kind: 'browser', documents: [{ id: 'd', path: 'd.glb' }] }).backend);
    e.browsers.set('prj_x', fakeLibraryProject({ id: 'prj_x', kind: 'browser' }).backend);
    e.browsers.set('prj_y', fakeLibraryProject({ id: 'prj_y', kind: 'browser' }).backend);
    const loader = new LibraryProjectLoader(e.deps);
    loader.setProject(projectA([{ projectId: 'prj_b' }, { projectId: 'prj_x' }]));
    await loader.whenSettled();
    expect(loader.getNode('prj_c')!.state.kind).toBe('ready');

    const cStates: string[] = [];
    loader.subscribe(() => { cStates.push(loader.getNode('prj_c')?.state.kind ?? 'MISSING'); });
    loader.invalidate('prj_x');                                                     // retry another library
    await loader.whenSettled();
    loader.setProject(projectA([{ projectId: 'prj_b' }, { projectId: 'prj_x' }, { projectId: 'prj_y' }]));   // attach one more
    await loader.whenSettled();
    expect(cStates.length).toBeGreaterThan(0);
    expect(cStates.every((k) => k === 'ready')).toBe(true);
    expect(loader.getNode('prj_c')!.neededBy).toEqual(['prj_b']);
  });

  it('C3: a delivered (trimmed) copy of B does not leak into the next project, which gets its full linked B', async () => {
    const trimmed = fakeLibraryProject({ id: 'prj_b', name: 'B (delivered)', kind: 'folder', documents: [{ id: 'doc_pump', path: 'models/pump.glb' }] });
    const e = env({ openRelative: async () => ({ backend: trimmed.backend, via: 'folder' }) });
    const loader = new LibraryProjectLoader(e.deps);
    loader.setProject(projectA([{ projectId: 'prj_b', hint: 'libraries/prj_b/project.json' }]));
    await loader.whenSettled();
    let b = loader.getNode('prj_b')!;
    expect(b.state.kind === 'ready' && b.state.delivered).toBe(true);

    // The user now has B linked locally, and opens P, which lists B without a hint.
    e.folders.set('prj_b', projectFolder('B', 'prj_b', { docs: ['pump', 'valve', 'motor'] }));
    loader.setProject({ ...projectA([{ projectId: 'prj_b' }]), id: 'prj_p' } as RvProject);
    await loader.whenSettled();
    b = loader.getNode('prj_b')!;
    expect(b.state.kind).toBe('ready');
    if (b.state.kind !== 'ready') return;
    expect(b.state.via).toBe('folder');
    expect(b.state.delivered).toBeUndefined();
    expect(b.state.documents.map((d) => d.id).sort()).toEqual(['doc_motor', 'doc_pump', 'doc_valve']);
  });

  it('C3: a re-read of the SAME project keeps its delivered copy (no flicker on save)', async () => {
    const trimmed = fakeLibraryProject({ id: 'prj_b', kind: 'folder', documents: [{ id: 'doc_pump', path: 'models/pump.glb' }] });
    const loader = new LibraryProjectLoader(env({ openRelative: async () => ({ backend: trimmed.backend, via: 'folder' }) }).deps);
    const a = projectA([{ projectId: 'prj_b', hint: 'libraries/prj_b/project.json' }]);
    loader.setProject(a);
    await loader.whenSettled();
    loader.setProject({ ...a });
    expect(loader.getNode('prj_b')!.state.kind).toBe('ready');
  });
});
