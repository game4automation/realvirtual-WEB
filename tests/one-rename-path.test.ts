// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-717 §9.4 — ONE create / rename / move path, for every document.
 *
 * Phase 3 removes the last place where a "scene" and a "library asset" were
 * handled by different machinery. Four verbs collapse onto the document ops and
 * the tree move, and every one of them now keeps the row's `id` — which is what
 * turns "a rename breaks no reference" from a claim about the manifest into a
 * property the reference resolver can be asked about.
 *
 * Five blocks, and each one answers a different question:
 *
 *  A. **The rename itself.** Row name AND file name change; the id does not.
 *     Collision → probe, never overwrite. The crash half of copy+delete has a
 *     defined, tested outcome.
 *  B. **A rename with the document OPEN.** The draft slot and `?doc=` are
 *     id-based and untouched; the workspace re-points at the new file so the
 *     next save writes it; a foreign write into the destination refuses.
 *  C. **F8, end to end.** A pre-717 `assetId` — the path derivation a saved GLB
 *     carries — still resolves through `rv-glb-reference-resolver` after the
 *     file has been adopted AND renamed. Not a manifest assertion: the real
 *     resolver, over a real OPFS backend, returning real bytes.
 *  D. **Create through one substructure**, for both kinds of target folder.
 *  E. **Duplicate and delete as row verbs** — the copy inherits the filing, the
 *     delete retires row and bytes together.
 *
 * ## Why the scene mocks
 *
 * Blocks A/B drive `SceneStore.rename`, and a store that cannot bake cannot
 * save — so the same three module mocks `open-save-document.test.ts` installs
 * are installed here. They are about the BAKE, never about persistence: every
 * blob write in this file goes through the real fake backend, with its real
 * compare-and-swap.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  /** Every body-slot write, in order — proves the draft slot stays id-based. */
  writes: [] as { slot: string }[],
  revision: 0,
}));

vi.mock('../src/core/hmi/scene/rv-scene-glb-io', () => ({
  readSceneGlbBody: vi.fn(async () => null),
  writeSceneGlbBody: vi.fn(async (write: { sceneId: string }) => {
    h.writes.push({ slot: write.sceneId });
    return { revision: `rev${++h.revision}`, target: 'opfs' as const };
  }),
  dropSceneGlbBody: vi.fn(async () => {}),
  sceneGlbBodyRevision: vi.fn(async () => null),
}));

vi.mock('../src/core/hmi/scene/rv-scene-glb-bake', () => ({
  bakeIntoGlb: vi.fn(async () => ({
    glb: new Uint8Array([0x67, 0x6c, 0x54, 0x46, 1, 2, 3, 4]),
    warnings: [],
    writtenReferences: [],
  })),
  makeRegistryBakeResolver: vi.fn(() => ({})),
  bakeRequiresFullPath: vi.fn(() => false),
}));

vi.mock('../src/core/hmi/scene/rv-scene-executors', () => ({
  applyForward: vi.fn(async () => undefined),
  applyInverse: vi.fn(async () => undefined),
  writeUserDataField: vi.fn(),
  deleteUserDataField: vi.fn(),
  reapplySchemaForComponent: vi.fn(),
}));

import { SceneStore } from '../src/core/hmi/scene/scene-store';
import type { RvScene } from '../src/core/hmi/scene/rv-scene-types';
import { clearAllScenes, setDraftScope } from '../src/core/hmi/scene/rv-scene-storage';
import { clearSceneMutationListeners } from '../src/core/hmi/scene/rv-scene-mutations';
import { setOpenDocumentBase } from '../src/core/editor/active-asset-store';
import {
  BrowserBackend,
} from '../src/core/project/backends/browser-backend';
import {
  getProjectStore,
  resetProjectStore,
  type ProjectStore,
} from '../src/core/project/project-store';
import {
  createDocument,
  duplicateDocument,
  retireDocument,
} from '../src/core/project/rv-document-ops';
import { documentsOf } from '../src/core/project/rv-project-documents';
import { previewAssetId } from '../src/core/project/rv-asset-identity';
import { applyTreeMove, type TreeMoveIO } from '../src/core/project/rv-project-tree-move';
import type { TreeMovePlan } from '../src/core/project/rv-project-tree';
import { createReferenceResolver } from '../src/core/engine/rv-glb-reference-resolver';
import type { ResolveContext } from '../src/core/engine/rv-glb-compose';
import {
  newDocumentFolderFor,
  newDocumentNameFor,
} from '../src/core/hmi/projects/dashboard-documents';
import { clearAllDocumentAliases } from '../src/core/project/rv-doc-alias';
import { clearAllBlobs } from '../src/core/storage/rv-opfs-blobs';
import { clearAllSceneOwners } from '../src/core/project/rv-scene-owner';
import type { ProjectBackend } from '../src/core/project/backends/project-backend';
import type { RvDocumentEntry, RvProject } from '../src/core/project/rv-project-types';
import {
  installFakeDocumentProject,
  type FakeDocumentProject,
} from './helpers/fake-document-project';
import { writeBlobDocument } from './helpers/document-io';
import { arrayBufferOf } from '../src/core/project/rv-scene-record';

// ─── Harness ────────────────────────────────────────────────────────────

const BELT_PATH = 'scenes/Belt.glb';
const BELT_ID = 'doc_belt';

function makeViewer() {
  const v = {
    availableModels: [],
    availablePublishedScenes: [],
    currentScene: null as RvScene | null,
    currentModelUrl: null as string | null,
    currentModelRoot: null as unknown,
    registry: {
      getGltfNodeNames: () => [], getGltfNodeIndex: () => -1,
      getPathForNode: () => null, getNode: () => null,
    },
    lastLoadResult: null,
    modes: { has: () => true, setMode: () => {} },
    getPlugin: () => undefined,
    loadScene: async (s: RvScene) => { v.currentScene = s; },
    loadEmptyScene: async () => { v.currentScene = null; },
  };
  return v;
}

function makeStore(): SceneStore {
  return new SceneStore(makeViewer() as unknown as ConstructorParameters<typeof SceneStore>[0]);
}

function rowOf(project: FakeDocumentProject, id: string): RvDocumentEntry | undefined {
  return documentsOf(project.project()).find(d => d.id === id);
}

function urlParam(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

let project: FakeDocumentProject;
let store: SceneStore;
let urlBefore: string;

beforeEach(() => {
  urlBefore = window.location.href;
  localStorage.clear();
  clearAllScenes();
  clearAllDocumentAliases();
  setDraftScope(null);
  clearSceneMutationListeners();
  setOpenDocumentBase(null);
  resetProjectStore();
  h.writes.length = 0;
  h.revision = 0;
  // `_ensureBaseBytes` fetches the base before it can bake. The bytes do not
  // matter — the bake is mocked — but the fetch has to succeed.
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () => new Response(new ArrayBuffer(8), { status: 200 }),
  );
  project = installFakeDocumentProject({
    documents: [{ id: BELT_ID, path: BELT_PATH, name: 'Belt', section: 'scenes' }],
  });
  store = makeStore();
});

afterEach(() => {
  vi.restoreAllMocks();
  store.dispose();
  project.restore();
  resetProjectStore();
  clearAllScenes();
  clearAllDocumentAliases();
  setOpenDocumentBase(null);
  window.history.replaceState(null, '', urlBefore);
});

// ─── A. The rename: name, file, and the id that does not move ───────────

describe('plan-717 F6 — a rename moves the name and the file, never the id', () => {
  it('renames the row AND the file at a stable id', async () => {
    await store.rename(BELT_ID, 'Belt Line 7');

    const row = rowOf(project, BELT_ID);
    expect(row?.id).toBe(BELT_ID);                 // the whole point
    expect(row?.name).toBe('Belt Line 7');
    expect(row?.path).toBe('scenes/Belt Line 7.glb');
    expect(project.files.has(BELT_PATH)).toBe(false);
    expect(project.files.has('scenes/Belt Line 7.glb')).toBe(true);
  });

  it('renaming a LIBRARY asset is the same call with the same guarantees', async () => {
    // "Scene = asset" at the level of the verb: nothing below branches on the
    // folder, and this is the assertion that says so.
    const roll = await createDocument(getProjectStore(), 'Roll2m', { folder: 'library/parts' });
    await store.rename(roll.documentId, 'Roll 2000');

    const row = rowOf(project, roll.documentId);
    expect(row?.id).toBe(roll.documentId);
    expect(row?.name).toBe('Roll 2000');
    expect(row?.path).toBe('library/parts/Roll 2000.glb');
    expect(project.files.has('library/parts/Roll2m.glb')).toBe(false);
  });

  it('a taken name is PROBED, never overwritten', async () => {
    await createDocument(getProjectStore(), 'Spare', { folder: 'scenes' });

    await store.rename(BELT_ID, 'Spare');

    const row = rowOf(project, BELT_ID);
    // The suffix reaches the display name too, or two cards read "Spare" and
    // only the file names tell them apart.
    expect(row?.path).toBe('scenes/Spare 2.glb');
    expect(row?.name).toBe('Spare 2');
    // The namesake is untouched — the refusal a create-only write guarantees.
    expect(documentsOf(project.project()).filter(d => d.path === 'scenes/Spare.glb'))
      .toHaveLength(1);
  });

  it('renaming a row back onto its own file stem is not a collision', async () => {
    // The `exclude` case: the row's display name drifted away from its stem, and
    // renaming it back must land ON the stem rather than on "<stem> 2".
    await store.rename(BELT_ID, 'Belt Line 7');
    await store.rename(BELT_ID, 'Belt');

    expect(rowOf(project, BELT_ID)?.path).toBe(BELT_PATH);
    expect(project.files.has('scenes/Belt Line 7.glb')).toBe(false);
  });

  it('an empty name is a no-op, not an "Untitled"', async () => {
    await store.rename(BELT_ID, '   ');
    expect(rowOf(project, BELT_ID)?.name).toBe('Belt');
    expect(rowOf(project, BELT_ID)?.path).toBe(BELT_PATH);
  });

  it('the row name and the file stem can never disagree after a rename', async () => {
    // A name full of path separators sanitises — and BOTH halves take the
    // sanitised value, because a card reading "a/b" over a file called "a_b.glb"
    // is the divergence F6 exists to end.
    await store.rename(BELT_ID, 'a/b');

    const row = rowOf(project, BELT_ID);
    expect(row?.path).toBe('scenes/a_b.glb');
    expect(row?.name).toBe('a_b');
  });

  it('a row whose file is already gone renames its name only', async () => {
    project.files.delete(BELT_PATH);

    await store.rename(BELT_ID, 'Belt Line 7');

    const row = rowOf(project, BELT_ID);
    expect(row?.name).toBe('Belt Line 7');
    expect(row?.path).toBe(BELT_PATH);         // no byte to move, no path to change
    expect(project.files.has('scenes/Belt Line 7.glb')).toBe(false);
  });

  // ── The crash half of copy+delete (S5 / §9.4) ──────────────────────────
  //
  // The chosen behaviour, stated once: the row is repointed only AFTER the
  // delete, so a delete that fails abandons the rename and says so. What is
  // left is the original file, the original row and a stray copy — the same
  // trade the cross-source move makes ("a duplicate is a tidy-up, a loss is
  // not"), and the reason the failure needs no repair machinery: the stray is
  // an unregistered file, so the next adopt run registers it as its own
  // document with its own id. Nothing points anywhere it should not.
  it('a failed delete abandons the rename, reports both paths and keeps the row', async () => {
    const deleteDocument = vi.spyOn(project.backend, 'deleteDocument')
      .mockRejectedValue(new Error('permission revoked'));

    await expect(store.rename(BELT_ID, 'Belt Line 7')).rejects.toThrow(/could not be removed/);
    expect(deleteDocument).toHaveBeenCalledWith(BELT_PATH);

    const row = rowOf(project, BELT_ID);
    // The row still describes the file that is still there.
    expect(row?.path).toBe(BELT_PATH);
    expect(row?.name).toBe('Belt');
    expect(project.files.has(BELT_PATH)).toBe(true);
    // The stray copy exists and is registered to nobody — which is exactly what
    // makes it adoptable as a new document rather than a second row for this one.
    expect(project.files.has('scenes/Belt Line 7.glb')).toBe(true);
    expect(documentsOf(project.project()).filter(d => d.path === 'scenes/Belt Line 7.glb'))
      .toHaveLength(0);
  });
});

// ─── B. A rename with the document open ─────────────────────────────────

describe('plan-717 Risiko 6 — renaming the OPEN document', () => {
  it('keeps the id-based surfaces and re-points the save target', async () => {
    await store.openDocument(BELT_ID);
    expect(urlParam('doc')).toBe(BELT_ID);
    h.writes.length = 0;

    await store.rename(BELT_ID, 'Belt Line 7');

    // Id-based and therefore untouched: the URL parameter and the document id.
    expect(urlParam('doc')).toBe(BELT_ID);
    expect(store.getSnapshot().draft?.name).toBe('Belt Line 7');

    // The autosave slot is still named after the document ID, not after a base
    // key derived from the (now changed) path.
    await store.applyOp({
      id: 'op_1', ts: Date.now(), schemaV: 1, kind: 'setField',
      nodePath: 'Conv1', componentType: 'Drive', fieldName: 'TargetSpeed', value: 1, prev: 0,
    } as never);
    await new Promise(resolve => setTimeout(resolve, 2400));   // the autosave debounce
    expect(h.writes.map(w => w.slot)).toContain(`draft/${BELT_ID}`);
    // Never a base key: that one derives from the path and would have moved.
    expect(h.writes.every(w => !w.slot.includes('rvproject'))).toBe(true);

    // And the next in-place save writes the RENAMED file, without re-creating
    // the old one — which is what the carried CAS precondition buys.
    project.writes.length = 0;
    await store.save();
    expect(project.writes.map(w => w.relPath)).toEqual(['scenes/Belt Line 7.glb']);
    expect(project.files.has(BELT_PATH)).toBe(false);
  });

  it('a foreign write into the destination REFUSES the rename', async () => {
    const destination = 'scenes/Belt Line 7.glb';
    await store.openDocument(BELT_ID);

    // The race the create-only write exists for: the probe saw a free name, and
    // by the time the bytes are written somebody else has taken it.
    const realRead = project.backend.readDocument.bind(project.backend);
    let probed = false;
    vi.spyOn(project.backend, 'readDocument').mockImplementation(async (ref) => {
      const path = typeof ref === 'string' ? ref : ref.path;
      if (path === destination && !probed) { probed = true; return null; }
      return realRead(ref);
    });
    project.writeForeign(destination, 'a colleague got there first');

    await expect(store.rename(BELT_ID, 'Belt Line 7')).rejects.toThrow();

    // Nothing moved, and their bytes are theirs.
    expect(rowOf(project, BELT_ID)?.path).toBe(BELT_PATH);
    expect(rowOf(project, BELT_ID)?.name).toBe('Belt');
    expect(project.files.has(BELT_PATH)).toBe(true);
    expect(new TextDecoder().decode(project.files.get(destination)!))
      .toBe('a colleague got there first');
  });
});

// ─── C. F8 end to end, through the real reference resolver ──────────────

describe('plan-717 F8 — a pre-717 assetId survives adopt AND rename', () => {
  const ROLL = 'library/parts/Roll2m.glb';
  const RENAMED = 'library/parts/Roll2000.glb';
  let backend: BrowserBackend;
  let opfsStore: ProjectStore;
  let seq = 0;

  beforeEach(async () => {
    localStorage.clear();
    clearAllScenes();
    clearAllSceneOwners();
    await clearAllBlobs();
    resetProjectStore();

    const id = `prj_one_rename_${seq++}`;
    backend = new BrowserBackend(id, { requestPersistence: false });
    await backend.activate();
    const manifest = {
      schemaVersion: 3, id, name: 'Rename fixture', documents: [],
    } as unknown as RvProject;
    await backend.writeManifest(manifest);
    await writeBlobDocument(backend, ROLL, new Blob([fakeGlbBytes() as BlobPart]));

    // The same injection seam the adopt tests use — but into the SINGLETON,
    // because `rv-glb-reference-resolver` reaches for `getProjectStore()` and
    // that reach is the thing under test.
    opfsStore = getProjectStore();
    const privates = opfsStore as unknown as { _backend: ProjectBackend | null; _project: RvProject | null };
    privates._backend = backend;
    privates._project = manifest;
  });

  afterEach(async () => {
    resetProjectStore();
    await backend.deactivate().catch(() => {});
    await clearAllBlobs();
  });

  /** A tiny self-contained GLB — the resolver hashes and signature-checks it. */
  function fakeGlbBytes(): Uint8Array {
    const json = new TextEncoder().encode(JSON.stringify({
      asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }], nodes: [],
    }));
    const pad = (json.byteLength + 3) & ~3;
    const out = new Uint8Array(12 + 8 + pad);
    const view = new DataView(out.buffer);
    view.setUint32(0, 0x46546c67, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, out.byteLength, true);
    view.setUint32(12, pad, true);
    view.setUint32(16, 0x4e4f534a, true);
    out.fill(0x20, 20, 20 + pad);
    out.set(json, 20);
    return out;
  }

  const CONTEXT: ResolveContext = {
    baseUrl: '', occurrence: 'root/Ref', depth: 0, resolvedPath: '',
  };

  it('resolves after the adopt, and still resolves after the rename', async () => {
    // What a GLB saved before plan-717 carries: the path derivation the catalog
    // handed out while the file had no row at all.
    const savedAssetId = previewAssetId(ROLL);
    const resolve = createReferenceResolver();

    // ── after adopt ──
    const summary = await opfsStore.adoptDiscoveredDocuments();
    expect(summary.adopted).toBe(1);
    const adopted = documentsOf(opfsStore.getProject()).find(d => d.path === ROLL);
    expect(adopted?.id).toBe(savedAssetId);       // §2.5: adoption takes the path id

    const before = await resolve({ assetId: savedAssetId }, CONTEXT);
    expect(before?.bytes.byteLength).toBeGreaterThan(0);

    // ── after rename, through the ONE rename route ──
    const io: TreeMoveIO = {
      readBytes: async p => {
        const bytes = (await backend.readDocument(p))?.bytes ?? null;
        return bytes ? new Blob([arrayBufferOf(bytes)]) : null;
      },
      writeBytes: (p, b) => writeBlobDocument(backend, p, b),
      deleteBytes: p => backend.deleteDocument(p),
      readManifest: async () => opfsStore.getProject(),
      writeManifest: async next => {
        await opfsStore.replaceManifest(next);
        await backend.writeManifest(next);
      },
    };
    await applyTreeMove(io, {
      from: ROLL, to: RENAMED, documentId: savedAssetId,
      descendants: [], rewritesDocsIndex: false,
    } as unknown as TreeMovePlan);

    const row = documentsOf(opfsStore.getProject()).find(d => d.id === savedAssetId);
    expect(row?.path).toBe(RENAMED);
    expect(row?.name).toBe('Roll2000');

    const after = await resolve({ assetId: savedAssetId }, CONTEXT);
    expect(after?.bytes.byteLength).toBe(before!.bytes.byteLength);
    expect(after?.sha256).toBe(before!.sha256);
  });

  it('a re-adopt after the rename does NOT mint a second row for the same file', async () => {
    const savedAssetId = previewAssetId(ROLL);
    await opfsStore.adoptDiscoveredDocuments();

    const io: TreeMoveIO = {
      readBytes: async p => {
        const bytes = (await backend.readDocument(p))?.bytes ?? null;
        return bytes ? new Blob([arrayBufferOf(bytes)]) : null;
      },
      writeBytes: (p, b) => writeBlobDocument(backend, p, b),
      deleteBytes: p => backend.deleteDocument(p),
      readManifest: async () => opfsStore.getProject(),
      writeManifest: async next => {
        await opfsStore.replaceManifest(next);
        await backend.writeManifest(next);
      },
    };
    await applyTreeMove(io, {
      from: ROLL, to: RENAMED, documentId: savedAssetId,
      descendants: [], rewritesDocsIndex: false,
    } as unknown as TreeMovePlan);

    await opfsStore.adoptDiscoveredDocuments();

    const rows = documentsOf(opfsStore.getProject());
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(savedAssetId);
    expect(rows[0].path).toBe(RENAMED);
    // The resolver's manifest hop still answers with the one row there is.
    const resolved = await createReferenceResolver()({ assetId: savedAssetId }, CONTEXT);
    expect(resolved).not.toBeNull();
  });
});

// ─── D. Create: one substructure, both kinds of target folder (F7) ──────

describe('plan-717 F7 — "New" is one call, whatever folder is in view', () => {
  // The callsite pin R1-T9 asks for. The DECISION lives in
  // `newDocumentFolderFor` and the WRITE in `createDocument`; between them
  // there is nothing left for the host to branch on, which is why pinning the
  // pair is pinning the callsite.

  it('the folder in view is the whole decision', () => {
    // EVERY folder of the open project, not just `library/`: the rule used to
    // recognise that one subtree and send `models/`, a hand-made folder and the
    // root itself to `scenes/`, which put a new asset where nobody was looking.
    expect(newDocumentFolderFor('prj_a', 'prj_a')).toBe('');
    expect(newDocumentFolderFor('prj_a', 'prj_a/scenes')).toBe('scenes');
    expect(newDocumentFolderFor('prj_a', 'prj_a/models')).toBe('models');
    expect(newDocumentFolderFor('prj_a', 'prj_a/anything/deep')).toBe('anything/deep');
    expect(newDocumentFolderFor('prj_a', 'prj_a/library')).toBe('library');
    expect(newDocumentFolderFor('prj_a', 'prj_a/library/parts')).toBe('library/parts');
    expect(newDocumentFolderFor('prj_a', 'prj_a/library/parts/rollers'))
      .toBe('library/parts/rollers');
    // A catalog root is somebody else's tree, and a project that is not open
    // has no folder at all — those two fall back to the project ROOT. It used
    // to be `scenes/`, the last place the old section layout could file a
    // document without anybody choosing it.
    expect(newDocumentFolderFor('prj_a', 'global:acme/library')).toBe('');
    expect(newDocumentFolderFor(null, 'prj_a/library/parts')).toBe('');
    expect(newDocumentFolderFor('prj_a', null)).toBe('');
  });

  it('proposes ONE name, whatever the folder', () => {
    // "Untitled" in scenes/ and "New asset" elsewhere was a scene/asset split
    // surviving in the one place the user reads it.
    expect(newDocumentNameFor('')).toBe('Untitled');
    expect(newDocumentNameFor('scenes')).toBe('Untitled');
    expect(newDocumentNameFor('library/parts')).toBe('Untitled');
  });

  it('creates a file AND a row in one go, in the scenes folder', async () => {
    const folder = newDocumentFolderFor('prj_fake_documents', 'prj_fake_documents/scenes');
    const created = await createDocument(getProjectStore(), newDocumentNameFor(folder), { folder });

    const row = rowOf(project, created.documentId);
    expect(row?.path).toBe('scenes/Untitled.glb');
    // plan-736 F3: nothing is stamped beside the path. The row used to carry
    // `section: 'scenes'` here, derived from that very path.
    expect(row?.section).toBeUndefined();
    expect(project.files.has('scenes/Untitled.glb')).toBe(true);
  });

  it('creates a document in the project ROOT when the root is in view', async () => {
    // The empty folder is a real target, not "unspecified" — the create must
    // not quietly redirect it to a section on the way through.
    const folder = newDocumentFolderFor('prj_fake_documents', 'prj_fake_documents');
    expect(folder).toBe('');
    const created = await createDocument(getProjectStore(), newDocumentNameFor(folder), { folder });

    const row = rowOf(project, created.documentId);
    expect(row?.path).toBe('Untitled.glb');
    expect(project.files.has('Untitled.glb')).toBe(true);
    // A rename stays in the root: a rename is not a move (`documentFolderOf`).
    await store.rename(created.documentId, 'Cell');
    expect(rowOf(project, created.documentId)?.path).toBe('Cell.glb');
  });

  it('creates a file AND a row in one go, in a library sub-folder', async () => {
    const folder = newDocumentFolderFor('prj_fake_documents', 'prj_fake_documents/library/parts');
    const created = await createDocument(getProjectStore(), newDocumentNameFor(folder), { folder });

    const row = rowOf(project, created.documentId);
    expect(row?.path).toBe('library/parts/Untitled.glb');
    // The FOLDER is where the document is, and since plan-736 it is the only
    // place that says so — a second, stored answer could disagree with it.
    expect(row?.section).toBeUndefined();
    expect(project.files.has('library/parts/Untitled.glb')).toBe(true);
    // ...and it is a document like any other: it renames through the same verb.
    await store.rename(created.documentId, 'Roller');
    expect(rowOf(project, created.documentId)?.path).toBe('library/parts/Roller.glb');
  });

  it('two clicks in the same folder produce two documents, never a collision', async () => {
    const folder = newDocumentFolderFor('prj_fake_documents', 'prj_fake_documents/library');
    const a = await createDocument(getProjectStore(), newDocumentNameFor(folder), { folder });
    const b = await createDocument(getProjectStore(), newDocumentNameFor(folder), { folder });

    expect(a.documentId).not.toBe(b.documentId);
    expect(rowOf(project, a.documentId)?.path).toBe('library/Untitled.glb');
    expect(rowOf(project, b.documentId)?.path).toBe('library/Untitled 2.glb');
  });
});

// ─── E. Duplicate and delete as row verbs (§2.7) ────────────────────────

describe('plan-717 §2.7 — duplicate and delete go through the row', () => {
  it('the duplicate is a new id that inherits the filing', async () => {
    const source = await createDocument(getProjectStore(), 'Roll2m', { folder: 'library/parts' });
    // The filing as the Collections editor writes it since Phase 2.
    await getProjectStore().applyManifestDelta(current => ({
      ...current,
      documents: documentsOf(current).map(d => (
        d.id === source.documentId ? { ...d, collections: ['Conveyors', 'Approved'] } : d
      )),
    }));

    const copy = await duplicateDocument(getProjectStore(), source.documentId);

    const row = rowOf(project, copy.documentId);
    expect(copy.documentId).not.toBe(source.documentId);
    expect(row?.path).toBe('library/parts/Roll2m copy.glb');
    expect(row?.copiedFrom).toBe(source.documentId);
    // What makes a duplicate useful as a starting point — carried from the ROW
    // now, where `duplicateAsset` used to carry it from the sidecar.
    expect(row?.collections).toEqual(['Conveyors', 'Approved']);
    // A copy of the list, not the list: editing one must not edit the other.
    expect(row?.collections).not.toBe(rowOf(project, source.documentId)?.collections);
  });

  it('the delete retires the row AND the bytes', async () => {
    const doc = await createDocument(getProjectStore(), 'Roll2m', { folder: 'library/parts' });

    expect(await retireDocument(getProjectStore(), doc.documentId)).toBe(true);

    expect(rowOf(project, doc.documentId)).toBeUndefined();
    expect(project.files.has('library/parts/Roll2m.glb')).toBe(false);
    // Recoverable on purpose: a delete gesture in this codebase is never terminal.
    expect(project.files.has('.trash/Roll2m.glb')).toBe(true);
  });

  it('retiring an id that names no row is not an error', async () => {
    expect(await retireDocument(getProjectStore(), 'doc_ghost')).toBe(false);
  });
});
