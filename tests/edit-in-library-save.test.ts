// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-778 9.17 — Edit in library saves into library B, never into A (F16,
 * Decision 3, Stab 3, Stab 4).
 *
 *  - The save verb of a `libraryDocument` is decided on B's backend, not on the
 *    open project's: read-only (and saying why, naming B) until Edit in library
 *    granted write access; refused outright for a hosted / built-in B.
 *  - The grant is `requestPermission({mode:'readwrite'})` on B's folder; the
 *    save then writes B's file with the revision the OPEN path recorded under
 *    B's backend id (`folder:<projectId>`) — a foreign write in between is a
 *    conflict — and B's row gets the new hash. A's same-path, same-id document
 *    in a SAME-NAMED folder (`folder:Shared` vs `folder:prj_b`) is untouched and
 *    keeps its own ledger.
 *  - Drafts of B's document are keyed by B's project id: A's draft of its
 *    same-id document is a different record, recovery offers B's only while B is
 *    a library of A, and both survive a reload (re-read from IndexedDB).
 *  - The editor's Save on a library document without a grant asks first
 *    (private `runSaveFlow`): Cancel asks the browser nothing, confirm grants
 *    and writes into B.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => ({ store: null as unknown }));

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

vi.mock('../src/core/thumbnails/rv-thumbnail-write', async () =>
  (await import('./helpers/mock-thumbnail-write')).mockThumbnailWriteModule());

import { FolderBackend } from '../src/core/project/backends/folder-backend';
import type { ProjectBackend } from '../src/core/project/backends/project-backend';
import type { RvProject } from '../src/core/project/rv-project-types';
import { LibraryProjectLoader, setLibraryProjectLoader } from '../src/core/library/library-project-loader';
import { installLibraryProjectsProvider, uninstallLibraryProjectsProvider } from '../src/core/library/library-projects-provider';
import { resetLibrarySourceRegistryForTests } from '../src/core/library/library-source-registry';
import {
  grantLibraryWrite,
  libraryDocumentBaseOf,
  libraryEditRefusal,
  librarySaveBackend,
  releaseLibraryWriteGrants,
  LIBRARY_ROW_REFRESH_COMMAND,
  libraryRowStaleProblemId,
  recoverableLibraryIds,
} from '../src/core/library/library-document-edit';
import { getProblem } from '../src/core/hmi/problems-store';
import { commandRegistry } from '../src/core/hmi/rv-command-registry';
import { decideSaveVerb, forgetSavedRevisions, noteLoadedRevision, saveDocument } from '../src/core/editor/rv-save-document';
import { revisionOfBytes } from '../src/core/project/rv-scene-record';
import type { AssetBase } from '../src/core/editor/rv-asset-document';
import {
  clearDocumentDraft,
  listAllDocumentDrafts,
  saveDocumentDraft,
} from '../src/core/ops/rv-document-drafts';
import { assetDraftOfFrame, chooseRecoveryRoot } from '../src/core/editor/rv-editor-draft-recovery';
import { REALVIRTUAL_LIBRARY_PROJECT_ID } from '../src/core/library/library-origin';
import { runSaveFlow } from '@rv-private/plugins/asset-editor/save-flow';
import { getPendingDialog } from '@rv-private/plugins/asset-editor/editor-dialog-store';
import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';
import { fakeGlb } from './helpers/fake-document-project';

const PUMP = 'models/pump';
const PATH = 'models/pump.glb';

interface World {
  a: FakeDir;
  b: FakeDir;
  aBackend: FolderBackend;
  loader: LibraryProjectLoader;
}

async function fileText(dir: FakeDir, sub: string, name: string): Promise<string | null> {
  return dir.readTextAt(sub, name);
}

async function manifestOf(dir: FakeDir): Promise<{ documents: Array<Record<string, unknown>> }> {
  return JSON.parse((await dir.readText('project.json'))!);
}

/**
 * A (open, writable) and B (library, linked folder) — both folders named
 * "Shared", both holding `models/pump.glb` under the document id `models/pump`.
 */
async function world(opts: { bVia?: 'folder' | 'hosted'; freshHandles?: boolean } = {}): Promise<World> {
  const a = new FakeDir('Shared');
  a.seedText('project.json', JSON.stringify({
    schemaVersion: 2, id: 'prj_a', name: 'Plant A', canonicalName: 'a', createdAt: 'x', modifiedAt: 'x',
    libraries: [{ projectId: 'prj_b' }],
    documents: [{ id: PUMP, path: PATH, name: 'Local pump' }],
  }));
  a.seedDir('models').seedBytes('pump.glb', fakeGlb('a:pump'));
  const aBackend = new FolderBackend(asDirHandle(a), { writable: true });   // id `folder:Shared`
  await aBackend.activate();

  const b = new FakeDir('Shared');
  b.seedText('project.json', JSON.stringify({
    schemaVersion: 2, id: 'prj_b', name: 'SharedConveyors', canonicalName: 'shared', createdAt: 'x', modifiedAt: 'x',
    documents: [{ id: PUMP, path: PATH, name: 'Pump', sha256: 'f'.repeat(64) }],
  }));
  b.seedDir('models').seedBytes('pump.glb', fakeGlb('b:pump'));
  b.permissions.readwrite = 'prompt';   // read granted, write needs Edit in library

  const hosted = new FolderBackend(asDirHandle(b), { writable: false, id: 'remote:https://hosted.test/prj_b/' });
  const loader = new LibraryProjectLoader({
    factory: {
      folder: (handle, id) => new FolderBackend(handle, { writable: false, id: `folder:${id}` }),
      browser: () => null,
      // A hosted B: same bytes, served read-only from a URL.
      remote: () => hosted as unknown as ProjectBackend,
    },
    // `freshHandles`: every read hands out a NEW wrapper of the same folder — what IndexedDB's
    // structured clone does after an `invalidate` (plan-778 review E2).
    getLinkedHandle: async (id) => (id === 'prj_b' && opts.bVia !== 'hosted'
      ? (opts.freshHandles ? freshWrapper(b) : asDirHandle(b))
      : null),
    hasReadPermission: async () => true,
    builtinBaseUrl: () => null,
  });
  setLibraryProjectLoader(loader);
  installLibraryProjectsProvider(loader);
  const project = JSON.parse((await a.readText('project.json'))!) as RvProject;
  if (opts.bVia === 'hosted') project.libraries = [{ projectId: 'prj_b', hint: 'https://hosted.test/prj_b/' }];
  loader.setProject(project);
  await loader.whenSettled();

  h.store = {
    getBackend: () => aBackend,
    getProject: () => project,
  };
  return { a, b, aBackend, loader };
}

/** A distinct handle object whose every member goes to `dir` (a structured-clone stand-in). */
function freshWrapper(dir: FakeDir): FileSystemDirectoryHandle {
  return new Proxy(dir, {
    get: (t, k) => { const v = (t as unknown as Record<string | symbol, unknown>)[k]; return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v; },
    set: (t, k, v) => { (t as unknown as Record<string | symbol, unknown>)[k] = v; return true; },
  }) as unknown as FileSystemDirectoryHandle;
}

interface FakeDoc {
  name: string;
  base: AssetBase;
  dirty: boolean;
  lockOwner: null;
  isBound: boolean;
  tryLock: () => { kind: string; token: symbol; generation: number };
  unlock: () => void;
  renameDocument: (n: string) => void;
  document: { opCount: number; runExclusive<T>(w: () => Promise<T>): Promise<T>; markSaved(): void };
  markSaved(base: AssetBase, name?: string): Promise<void>;
}

function makeDoc(base: AssetBase): FakeDoc {
  const doc: FakeDoc = {
    name: 'Pump',
    base,
    dirty: true,
    lockOwner: null,
    isBound: false,
    tryLock: () => ({ kind: 'save', token: Symbol('stub'), generation: 1 }),
    unlock: () => {},
    renameDocument: (n) => { doc.name = n; },
    document: { opCount: 2, runExclusive: (w) => w(), markSaved: () => {} },
    async markSaved(next) { doc.base = next; doc.dirty = false; },
  };
  return doc;
}

const viewer = {
  currentModelRoot: { name: 'Pump' },
  emit: () => {},
  getPlugin: () => undefined,
};

beforeEach(() => {
  forgetSavedRevisions();
});

afterEach(() => {
  releaseLibraryWriteGrants();
  uninstallLibraryProjectsProvider();
  resetLibrarySourceRegistryForTests();
  setLibraryProjectLoader(null);
  h.store = null;
});

describe('plan-778 9.17 — the save verb is decided on B', () => {
  it('a library document is read-only until Edit in library granted, and says so naming B', async () => {
    const w = await world();
    const base = libraryDocumentBaseOf('prj_b', PUMP)!;
    expect(base).toMatchObject({ kind: 'libraryDocument', libraryProjectId: 'prj_b', documentId: PUMP, path: PATH });
    // The caller hands in A's (writable) backend — the verb ignores it for a library document.
    const verb = decideSaveVerb({ lineage: 'editor', base, name: 'Pump' }, w.aBackend);
    expect(verb.verb).toBe('blocked');
    expect(verb.reason).toContain("library 'SharedConveyors'");
    expect(libraryEditRefusal('prj_b')).toBeNull();   // a local folder library CAN be asked

    const grant = await grantLibraryWrite('prj_b');
    expect(grant.ok).toBe(true);
    expect(w.b.requestPermissionCalls).toBe(1);
    expect(w.b.permissions.readwrite).toBe('granted');
    const backend = librarySaveBackend('prj_b')!;
    expect([backend.id, backend.writable]).toEqual(['folder:prj_b', true]);
    expect(decideSaveVerb({ lineage: 'editor', base, name: 'Pump' }, w.aBackend)).toEqual({ verb: 'save', relPath: PATH });
  });

  it('a denied grant writes nothing and keeps the document read-only', async () => {
    const w = await world();
    w.b.grantOnRequest = 'denied';
    const grant = await grantLibraryWrite('prj_b');
    expect(grant).toMatchObject({ ok: false });
    expect((grant as { reason: string }).reason).toContain('was not granted');
    expect(librarySaveBackend('prj_b')?.writable).toBe(false);
  });

  it('a hosted B is refused: no prompt, no write, the reason points at Copy into project', async () => {
    const w = await world({ bVia: 'hosted' });
    expect(w.loader.getNode('prj_b')?.state).toMatchObject({ kind: 'ready', via: 'hosted' });
    const refusal = libraryEditRefusal('prj_b');
    expect(refusal).toContain('published online');
    expect(refusal).toContain('Copy into project');
    const grant = await grantLibraryWrite('prj_b');
    expect(grant.ok).toBe(false);
    expect(w.b.requestPermissionCalls).toBe(0);

    const base = libraryDocumentBaseOf('prj_b', PUMP)!;
    const result = await saveDocument(viewer as never, makeDoc(base) as never);
    expect(result).toMatchObject({ kind: 'blocked' });
    expect(await fileText(w.b, 'models', 'pump.glb')).toBe(new TextDecoder().decode(fakeGlb('b:pump')));
  });

  it('the built-in realvirtual library is refused by name', () => {
    const loader = new LibraryProjectLoader({
      factory: { folder: () => { throw new Error('x'); }, browser: () => null, remote: () => ({ readManifest: async () => null }) as unknown as ProjectBackend },
      builtinBaseUrl: () => null,
    });
    setLibraryProjectLoader(loader);
    // A ready built-in node, as the loader publishes it.
    (loader as unknown as { _nodes: Map<string, unknown> })._nodes.set(REALVIRTUAL_LIBRARY_PROJECT_ID, {
      projectId: REALVIRTUAL_LIBRARY_PROJECT_ID, label: 'realvirtual Library', direct: true, placeable: true, neededBy: [], depth: 1,
      state: { kind: 'ready', via: 'builtin', backend: null, project: null, documents: [] },
    });
    expect(libraryEditRefusal(REALVIRTUAL_LIBRARY_PROJECT_ID)).toContain('realvirtual library ships with the application');
  });
});

describe('plan-778 9.17 — the save writes into B with B\'s revision, never into A', () => {
  it('writes B\'s file and row; A\'s same-path same-id document in a same-named folder is untouched', async () => {
    const w = await world();
    const base = libraryDocumentBaseOf('prj_b', PUMP)!;
    // The open path records what the user looks at — under B's backend id …
    await noteLoadedRevision(librarySaveBackend('prj_b'), PATH);
    // … and A's same-named folder has a ledger of its own (`folder:Shared`).
    await noteLoadedRevision(w.aBackend, PATH);
    expect(w.aBackend.id).toBe('folder:Shared');
    expect((await grantLibraryWrite('prj_b')).ok).toBe(true);

    const doc = makeDoc(base);
    const result = await saveDocument(viewer as never, doc as never);
    expect(result).toMatchObject({ kind: 'saved', relPath: PATH, copied: false });
    expect((result as { base: AssetBase }).base).toMatchObject({ kind: 'libraryDocument', libraryProjectId: 'prj_b', documentId: PUMP });

    expect(await fileText(w.b, 'models', 'pump.glb')).toBe('GLB:Pump');
    expect(await fileText(w.a, 'models', 'pump.glb')).toBe(new TextDecoder().decode(fakeGlb('a:pump')));
    const row = (await manifestOf(w.b)).documents.find((d) => d.id === PUMP)!;
    expect(row.sha256).toBe(await revisionOfBytes(new TextEncoder().encode('GLB:Pump')));
    expect(row.sizeBytes).toBe('GLB:Pump'.length);
    expect((await manifestOf(w.a)).documents.find((d) => d.id === PUMP)!.sha256).toBeUndefined();

    // The loader re-read B: A's library source now knows the new version.
    await w.loader.whenSettled();
    const state = w.loader.getNode('prj_b')!.state;
    expect(state.kind === 'ready' && state.documents.find((d) => d.id === PUMP)?.sha256).toBe(row.sha256);
  });

  it('a foreign write into B between open and save is a conflict (expectedRevision = what was opened)', async () => {
    const w = await world();
    const base = libraryDocumentBaseOf('prj_b', PUMP)!;
    await noteLoadedRevision(librarySaveBackend('prj_b'), PATH);
    expect((await grantLibraryWrite('prj_b')).ok).toBe(true);
    (await w.b.getDirectoryHandle('models')).seedBytes('pump.glb', fakeGlb('b:pump-changed-elsewhere'));

    const result = await saveDocument(viewer as never, makeDoc(base) as never);
    expect(result.kind).toBe('conflict');
    expect(await fileText(w.b, 'models', 'pump.glb')).toBe(new TextDecoder().decode(fakeGlb('b:pump-changed-elsewhere')));
  });

  it('"Save as…" of a library document is refused (Copy into project is the fork)', async () => {
    await world();
    expect((await grantLibraryWrite('prj_b')).ok).toBe(true);
    const result = await saveDocument(viewer as never, makeDoc(libraryDocumentBaseOf('prj_b', PUMP)!) as never, {
      forceNamePrompt: true, requestName: async () => 'Other',
    });
    expect(result).toMatchObject({ kind: 'blocked' });
    expect((result as { reason: string }).reason).toContain('Copy into project');
  });
});

describe('plan-778 9.17 — drafts of B are keyed by B (Stab 4)', () => {
  it('B\'s draft and A\'s same-id draft are two records; recovery offers B\'s only while B is a library', async () => {
    const libraryBase = { kind: 'libraryDocument' as const, libraryProjectId: 'prj_b', documentId: PUMP, path: PATH, name: 'Pump', libraryLabel: 'SharedConveyors' };
    const ownBase = { kind: 'document' as const, documentId: PUMP, path: PATH, name: 'Local pump' };
    const bFrame = { projectId: 'prj_b', rootDocumentId: 'asset_b1', occurrence: '' };
    const aFrame = { projectId: 'prj_a', rootDocumentId: 'asset_a1', occurrence: '' };
    try {
      await saveDocumentDraft({ frame: aFrame, shell: { id: 'asset_a1', name: 'Local pump', base: ownBase, createdAt: 1 }, ops: [], savedAt: 100 });
      await saveDocumentDraft({ frame: bFrame, shell: { id: 'asset_b1', name: 'Pump', base: libraryBase, createdAt: 1 }, ops: [], savedAt: 200 });

      // "After a reload": everything read back from IndexedDB.
      const records = (await listAllDocumentDrafts()).filter((r) => r.shell.base.kind !== 'sceneGlbSlot'
        && ['asset_a1', 'asset_b1'].includes(r.frame.rootDocumentId));
      expect(records).toHaveLength(2);
      const b = records.find((r) => r.frame.projectId === 'prj_b')!;
      const a = records.find((r) => r.frame.projectId === 'prj_a')!;
      expect(b.key).not.toBe(a.key);
      expect(assetDraftOfFrame(b)?.shell.base).toEqual(libraryBase);
      expect(a.shell.base).toEqual(ownBase);

      // Open project A with B as its library: B's (newer) draft is offered.
      expect(chooseRecoveryRoot(records, 'prj_a', ['prj_b'])).toEqual({ projectId: 'prj_b', rootDocumentId: 'asset_b1' });
      // B no longer a library of A: only A's own draft.
      expect(chooseRecoveryRoot(records, 'prj_a', [])).toEqual({ projectId: 'prj_a', rootDocumentId: 'asset_a1' });
    } finally {
      await clearDocumentDraft(bFrame).catch(() => {});
      await clearDocumentDraft(aFrame).catch(() => {});
    }
  });
});

describe('plan-778 9.17 — the editor\'s Save asks before writing into B (private save flow)', () => {
  it('Cancel asks the browser nothing; confirm grants inside the click and saves into B', async () => {
    const w = await world();
    const base = libraryDocumentBaseOf('prj_b', PUMP)!;
    await noteLoadedRevision(librarySaveBackend('prj_b'), PATH);

    // Cancel.
    const cancelled = runSaveFlow({ viewer: viewer as never, doc: makeDoc(base) as never });
    await vi.waitFor(() => expect(getPendingDialog()?.kind).toBe('library-save'));
    const dialog = getPendingDialog() as { title: string; message: string; resolve(c: boolean): void };
    expect(dialog.title).toBe("Save changes into library 'SharedConveyors'?");
    expect(dialog.message).toBe("Save changes into library 'SharedConveyors'? Every project that uses it gets the change.");
    dialog.resolve(false);
    expect(await cancelled).toBe(false);
    expect(w.b.requestPermissionCalls).toBe(0);
    expect(await fileText(w.b, 'models', 'pump.glb')).toBe(new TextDecoder().decode(fakeGlb('b:pump')));

    // Confirm: `resolve(true)` IS the click — the prompt is asked synchronously inside it.
    const saving = runSaveFlow({ viewer: viewer as never, doc: makeDoc(base) as never });
    await vi.waitFor(() => expect(getPendingDialog()?.kind).toBe('library-save'));
    (getPendingDialog() as { resolve(c: boolean): void }).resolve(true);
    expect(w.b.requestPermissionCalls).toBe(1);
    expect(await saving).toBe(true);
    expect(await fileText(w.b, 'models', 'pump.glb')).toBe('GLB:Pump');
    expect(await fileText(w.a, 'models', 'pump.glb')).toBe(new TextDecoder().decode(fakeGlb('a:pump')));
  });
});

describe('plan-778 review E2 / E3', () => {
  it('E2: the write grant survives the re-read after a save (fresh handle clone): two saves, ONE prompt, never "not available"', async () => {
    const w = await world({ freshHandles: true });
    const base = libraryDocumentBaseOf('prj_b', PUMP)!;
    await noteLoadedRevision(librarySaveBackend('prj_b'), PATH);
    expect((await grantLibraryWrite('prj_b')).ok).toBe(true);
    const granted = librarySaveBackend('prj_b')!;

    const first = await saveDocument(viewer as never, makeDoc(base) as never);
    expect(first.kind).toBe('saved');
    // The loader re-reads B right now (pending) — the save target is still the grant.
    expect(librarySaveBackend('prj_b')).toBe(granted);
    await w.loader.whenSettled();
    expect(librarySaveBackend('prj_b')).toBe(granted);
    expect(decideSaveVerb({ lineage: 'editor', base, name: 'Pump' }, w.aBackend)).toEqual({ verb: 'save', relPath: PATH });

    const doc2 = makeDoc(base);
    doc2.name = 'Pump';
    const second = await saveDocument(viewer as never, doc2 as never);
    expect(second.kind, JSON.stringify(second)).toBe('saved');
    // No second Edit-in-library prompt was needed for the second save.
    expect(w.b.requestPermissionCalls).toBe(1);
    expect(librarySaveBackend('prj_b')).toBe(granted);
  });

  it('E5: a project switch drops the grant', async () => {
    const w = await world();
    expect((await grantLibraryWrite('prj_b')).ok).toBe(true);
    expect(librarySaveBackend('prj_b')?.writable).toBe(true);
    w.loader.setProject({ schemaVersion: 2, id: 'prj_other', name: 'Other', libraries: [{ projectId: 'prj_b' }] } as unknown as RvProject);
    await w.loader.whenSettled();
    expect(librarySaveBackend('prj_b')?.writable).toBe(false);
  });

  it('E3: a row update that fails after the bytes were written raises a Problems row whose Retry re-hashes the file', async () => {
    const w = await world();
    const base = libraryDocumentBaseOf('prj_b', PUMP)!;
    await noteLoadedRevision(librarySaveBackend('prj_b'), PATH);
    expect((await grantLibraryWrite('prj_b')).ok).toBe(true);
    w.b.failures.fail({ point: 'write', name: 'project.json', times: 1 });

    const result = await saveDocument(viewer as never, makeDoc(base) as never);
    expect(result.kind).toBe('saved');
    expect(await fileText(w.b, 'models', 'pump.glb')).toBe('GLB:Pump');
    expect((await manifestOf(w.b)).documents.find((d) => d.id === PUMP)!.sha256).toBe('f'.repeat(64));
    const id = libraryRowStaleProblemId('prj_b', PATH);
    const row = getProblem(id)!;
    expect(row).toBeTruthy();
    expect(row.action).toMatchObject({ label: 'Retry', commandId: LIBRARY_ROW_REFRESH_COMMAND, args: { projectId: 'prj_b', path: PATH } });

    const retried = await commandRegistry.execute(row.action!.commandId, row.action!.args, { origin: 'ui', viewer: viewer as never });
    expect(retried.ok, JSON.stringify(retried)).toBe(true);
    expect((await manifestOf(w.b)).documents.find((d) => d.id === PUMP)!.sha256)
      .toBe(await revisionOfBytes(new TextEncoder().encode('GLB:Pump')));
    expect(getProblem(id)).toBeUndefined();
  });
});

describe('plan-778 review E7: draft recovery offers only savable libraries', () => {
  it('a folder B is offered; built-in / hosted / delivered / browser are not; pending and locked keep their offer', async () => {
    const w = await world();
    const ready = w.loader.getNode('prj_b')!;
    const node = (projectId: string, state: unknown) => ({ ...ready, projectId, label: projectId, state }) as typeof ready;
    const nodes = [
      ready,
      node('prj_builtin', { kind: 'ready', via: 'builtin', backend: null, project: null, documents: [] }),
      node('prj_hosted', { kind: 'ready', via: 'hosted', backend: null, project: null, documents: [] }),
      node('prj_browser', { kind: 'ready', via: 'browser', backend: null, project: null, documents: [] }),
      node('prj_delivered', { ...(ready.state as object), delivered: true }),
      node('prj_pending', { kind: 'pending' }),
      node('prj_locked', { kind: 'locked', handle: null }),
      node('prj_unknown', { kind: 'unknown' }),
    ];
    // libraryEditRefusal reads the loader's node for the label only; the state comes from the node handed in.
    expect(recoverableLibraryIds(nodes)).toEqual(['prj_b', 'prj_pending', 'prj_locked']);
  });
});

