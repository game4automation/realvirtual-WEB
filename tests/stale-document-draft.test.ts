// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-546 — a document draft never shadows a newer document file.
 *
 * A document's autosave draft (`draft/<documentId>`) used to be resumed before
 * the file without asking which file it was made from, so a regenerated GLB
 * stayed hidden behind a day-old draft. The draft pointer now carries the file
 * revision it was baked from (`baseSha`); a draft made on an older revision is
 * moved — never deleted — to `draft/~stale/<documentId>/<sha12>`, the FILE is
 * loaded, and a notice offers Restore / Discard.
 *
 * ## What is real here
 *
 * Everything below the scene store that decides anything: `rv-scene-glb-io`,
 * the pointer store (`rv-scene-glb-store`), the OPFS blob store and the
 * live-sync notice bus. Only the bake (bytes are opaque here, but each bake is
 * a DIFFERENT valid GLB so shas move) and the executors are replaced. The
 * project is `installFakeDocumentProject`, whose CAS and revisions are the real
 * SHA-256 the backends compute.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => {
  /** Same shape as `fakeGlb` in the helper — inlined: a mock factory must not
   *  import a module graph that may reach the module it is mocking. */
  const glb = (marker: string): Uint8Array => {
    const json = new TextEncoder().encode(JSON.stringify({
      asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: marker }],
    }));
    const pad = (json.byteLength + 3) & ~3;
    const out = new Uint8Array(20 + pad);
    const view = new DataView(out.buffer);
    view.setUint32(0, 0x46546c67, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, out.byteLength, true);
    view.setUint32(12, pad, true);
    view.setUint32(16, 0x4e4f534a, true);
    out.fill(0x20, 20);
    out.set(json, 20);
    return out;
  };
  return { bake: 0, glb };
});

vi.mock('../src/core/hmi/scene/rv-scene-glb-bake', () => ({
  // A different, self-contained GLB per bake — a saved bake must be a file the
  // next open can read as bytes, and two bakes must not share a sha.
  bakeIntoGlb: vi.fn(async () => ({
    glb: h.glb(`bake${++h.bake}`),
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
import { makeDraftScene, type RvScene } from '../src/core/hmi/scene/rv-scene-types';
import { clearAllScenes, setDraftScope } from '../src/core/hmi/scene/rv-scene-storage';
import { clearSceneMutationListeners } from '../src/core/hmi/scene/rv-scene-mutations';
import { setOpenDocumentBase } from '../src/core/editor/active-asset-store';
import { getProjectStore, resetProjectStore } from '../src/core/project/project-store';
import { projectAssetUrl } from '../src/core/project/rv-project-asset-source';
import { clearAllDocumentAliases } from '../src/core/project/rv-doc-alias';
import { clearAllBlobs, getBlob } from '../src/core/storage/rv-opfs-blobs';
import {
  readSceneGlbPointer,
  writeSceneGlb,
  listSceneGlbSlots,
  LS_KEY_SCENE_GLB_PREFIX,
} from '../src/core/storage/rv-scene-glb-store';
import { setAsideSlotFor, setAsideSlotPrefix } from '../src/core/hmi/scene/rv-scene-glb-io';
import {
  clearSceneSyncNotices,
  onSceneSyncEvent,
  STALE_DRAFT_NOTICE_ID,
  type SceneSyncNotice,
} from '../src/core/hmi/scene/rv-scene-live-sync';
import type { RvScenePrimitiveOp } from '../src/core/ops/rv-unified-ops';
import type { RvDocumentEntry } from '../src/core/project/rv-project-types';
import {
  fakeGlb,
  installFakeDocumentProject,
  revisionOfFile,
  type FakeDocumentProject,
} from './helpers/fake-document-project';

// ─── Harness ────────────────────────────────────────────────────────────

const BELT_PATH = 'scenes/Belt.glb';
const BELT_ID = 'doc_belt';
const GEAR_PATH = 'scenes/Gear.glb';
const GEAR_ID = 'doc_gear';
const DRAFT = `draft/${BELT_ID}`;

interface TestViewer {
  loaded: RvScene[];
  /** Was a stale-draft notice up while `loadScene` ran? (AC 2: after the load.) */
  noticeDuringLoad: (SceneSyncNotice | undefined)[];
  failNextLoad: boolean;
}

let viewer: TestViewer;
let notices: Map<string, SceneSyncNotice>;
let unsubscribe: () => void;

function makeViewer() {
  const v = {
    loaded: [] as RvScene[],
    noticeDuringLoad: [] as (SceneSyncNotice | undefined)[],
    failNextLoad: false,
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
    loadScene: async (s: RvScene) => {
      v.noticeDuringLoad.push(notices.get(STALE_DRAFT_NOTICE_ID));
      v.loaded.push(s);
      if (v.failNextLoad) {
        v.failNextLoad = false;
        throw new Error('bake failed');
      }
      v.currentScene = s;
    },
    loadEmptyScene: async () => { v.currentScene = null; },
  };
  return v;
}

function makeStore(): SceneStore {
  viewer = makeViewer();
  return new SceneStore(viewer as unknown as ConstructorParameters<typeof SceneStore>[0]);
}

function anOp(value = 42): RvScenePrimitiveOp {
  return {
    id: `op_${value}_${Math.random().toString(36).slice(2)}`,
    ts: Date.now(), schemaV: 1, kind: 'setField',
    nodePath: 'Conv1', componentType: 'Drive', fieldName: 'TargetSpeed',
    value, prev: 0,
  } as RvScenePrimitiveOp;
}

interface StorePrivates {
  _flushAutosave(): Promise<void>;
  _draftAutosaveTimer: number | null;
}

/** Run the debounced autosave now instead of waiting two seconds. */
async function flush(s: SceneStore): Promise<void> {
  await (s as unknown as StorePrivates)._flushAutosave();
}

function staleNotice(): Extract<SceneSyncNotice, { kind: 'stale-draft' }> | undefined {
  const n = notices.get(STALE_DRAFT_NOTICE_ID);
  return n?.kind === 'stale-draft' ? n : undefined;
}

function setAside(documentId = BELT_ID): string[] {
  return listSceneGlbSlots(setAsideSlotPrefix(documentId));
}

/** What the last load handed the viewer: the FILE or a resumed draft body. */
function lastLoadWas(): 'file' | 'draft' {
  const url = viewer.loaded[viewer.loaded.length - 1]?.base;
  if (url?.kind !== 'builtin') throw new Error('no builtin load');
  return url.url.startsWith('blob:') ? 'draft' : 'file';
}

/** Seed a draft body as an earlier session would have left it. */
async function seedDraft(
  slot: string,
  marker: string,
  pointer: { baseSha?: string; updatedAt?: string | null } = {},
): Promise<string> {
  const sha = await writeSceneGlb(slot, fakeGlb(marker), pointer.baseSha ? { baseSha: pointer.baseSha } : {});
  if (pointer.updatedAt !== undefined) {
    const key = LS_KEY_SCENE_GLB_PREFIX + slot;
    const raw = JSON.parse(localStorage.getItem(key)!);
    if (pointer.updatedAt === null) delete raw.updatedAt;
    else raw.updatedAt = pointer.updatedAt;
    localStorage.setItem(key, JSON.stringify(raw));
  }
  return sha;
}

function installProject(rows: Partial<Record<string, Partial<RvDocumentEntry>>> = {}): FakeDocumentProject {
  return installFakeDocumentProject({
    documents: [
      { id: BELT_ID, path: BELT_PATH, name: 'Belt', section: 'scenes', ...(rows[BELT_ID] ?? {}) },
      { id: GEAR_ID, path: GEAR_PATH, name: 'Gear', section: 'scenes', ...(rows[GEAR_ID] ?? {}) },
    ] as RvDocumentEntry[],
  });
}

let project: FakeDocumentProject;
let store: SceneStore;
let urlBefore: string;

beforeEach(async () => {
  urlBefore = window.location.href;
  localStorage.clear();
  await clearAllBlobs();
  clearAllScenes();
  clearAllDocumentAliases();
  setDraftScope(null);
  clearSceneMutationListeners();
  setOpenDocumentBase(null);
  resetProjectStore();
  clearSceneSyncNotices();
  notices = new Map();
  unsubscribe = onSceneSyncEvent((ev) => {
    if (ev.type === 'clear') notices.delete(ev.id);
    else notices.set(ev.id, ev.notice);
  });
  h.bake = 0;
  // `_ensureBaseBytes` fetches a URL source's bytes; answer with the file the
  // URL stands for so the revision it re-notes is the file's own.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
    (project.files.get(BELT_PATH) ?? new Uint8Array(8)) as unknown as BodyInit, { status: 200 },
  ));
  project = installProject();
  store = makeStore();
});

afterEach(async () => {
  vi.restoreAllMocks();
  store.dispose();
  unsubscribe();
  clearSceneSyncNotices();
  project.restore();
  resetProjectStore();
  clearAllScenes();
  clearAllDocumentAliases();
  setOpenDocumentBase(null);
  clearSceneMutationListeners();
  localStorage.clear();
  await clearAllBlobs();
  window.history.replaceState(window.history.state, '', urlBefore);
});

// ─── Phase 1 — the stamp ────────────────────────────────────────────────

describe('plan-546 — autosave stamps the file revision (AC 1, AC 12)', () => {
  it('stamps baseSha = the doc:<relPath> revision, and a rewrite keeps it', async () => {
    const fileRev = await revisionOfFile(project, BELT_PATH);
    await store.openDocument(BELT_ID);

    await store.applyOp(anOp(1));
    await flush(store);
    const first = readSceneGlbPointer(DRAFT)!;
    expect(first.baseSha).toBe(fileRev);

    await store.applyOp(anOp(2));
    await flush(store);
    const second = readSceneGlbPointer(DRAFT)!;
    expect(second.sha).not.toBe(first.sha);
    expect(second.baseSha).toBe(fileRev);
  });

  it('plain open, first autosave: baseSha is already set (no fire-and-forget)', async () => {
    const fileRev = await revisionOfFile(project, BELT_PATH);
    await store.openDocument(BELT_ID);
    await store.applyOp(anOp(1));
    // The very first write, straight after the open.
    await flush(store);
    expect(readSceneGlbPointer(DRAFT)?.baseSha).toBe(fileRev);
  });

  it("a kind:'url' source carries the revision too", async () => {
    // A GLB naming a sibling buffer is not self-contained, so the store hands
    // back a URL — from a read whose bytes the backend still hashed.
    const json = new TextEncoder().encode(JSON.stringify({
      asset: { version: '2.0' }, buffers: [{ uri: 'belt.bin', byteLength: 4 }],
    }));
    const pad = (json.byteLength + 3) & ~3;
    const bytes = new Uint8Array(20 + pad);
    const dv = new DataView(bytes.buffer);
    dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, bytes.byteLength, true);
    dv.setUint32(12, pad, true); dv.setUint32(16, 0x4e4f534a, true);
    bytes.fill(0x20, 20); bytes.set(json, 20);
    project.files.set(BELT_PATH, bytes);
    (project.backend as unknown as { readDocumentUrl: unknown }).readDocumentUrl =
      async () => ({ url: 'blob:fake-belt', release: () => {} });

    const source = await getProjectStore().resolveAssetSource(BELT_PATH);
    expect(source?.kind).toBe('url');
    expect(source?.revision).toBe(await revisionOfFile(project, BELT_PATH));

    await store.openDocument(BELT_ID);
    await store.applyOp(anOp(1));
    await flush(store);
    expect(readSceneGlbPointer(DRAFT)?.baseSha).toBe(await revisionOfFile(project, BELT_PATH));
  });

  it('a write without baseSha carries no stamp over from the previous pointer', async () => {
    await seedDraft(DRAFT, 'old', { baseSha: 'feedface' });
    await writeSceneGlb(DRAFT, fakeGlb('new'));
    expect(readSceneGlbPointer(DRAFT)?.baseSha).toBeUndefined();
  });

  it('save, edit, autosave, reopen: no notice (baseSha = the revision after the save)', async () => {
    await store.openDocument(BELT_ID);
    await store.applyOp(anOp(1));
    expect(await store.save()).toBe('saved');
    const savedRev = await revisionOfFile(project, BELT_PATH);

    await store.applyOp(anOp(2));
    await flush(store);
    expect(readSceneGlbPointer(DRAFT)?.baseSha).toBe(savedRev);

    store.dispose();
    store = makeStore();
    await store.openDocument(BELT_ID);

    expect(lastLoadWas()).toBe('draft');
    expect(staleNotice()).toBeUndefined();
    expect(setAside()).toEqual([]);
  });
});

// ─── Phase 1 — the decision ─────────────────────────────────────────────

describe('plan-546 — the stale decision on open (AC 2, 3, 7, 8, 11)', () => {
  it('matching baseSha: resumes, no notice, no move — and a later Save is a real CAS', async () => {
    const fileRev = (await revisionOfFile(project, BELT_PATH))!;
    const sha = await seedDraft(DRAFT, 'mine', { baseSha: fileRev });

    await store.openDocument(BELT_ID);

    expect(lastLoadWas()).toBe('draft');
    expect(readSceneGlbPointer(DRAFT)?.sha).toBe(sha);
    expect(setAside()).toEqual([]);
    expect(staleNotice()).toBeUndefined();

    // AC 7: the revision was noted, so the file changing meanwhile refuses.
    await store.applyOp(anOp(5));
    project.writeForeign(BELT_PATH, 'regenerated elsewhere');
    await expect(store.save()).rejects.toThrow(/changed since it was read/);
    expect(new TextDecoder().decode(project.files.get(BELT_PATH)!)).toBe('regenerated elsewhere');
  });

  it('different baseSha: the FILE loads, the draft is set aside, the notice follows the load', async () => {
    const sha = await seedDraft(DRAFT, 'stale', { baseSha: 'a'.repeat(64) });

    await store.openDocument(BELT_ID);

    expect(lastLoadWas()).toBe('file');
    expect(readSceneGlbPointer(DRAFT)).toBeNull();
    const slot = setAsideSlotFor(BELT_ID, sha);
    expect(slot).toBe(`draft/~stale/${BELT_ID}/${sha.slice(0, 12)}`);
    const entry = readSceneGlbPointer(slot)!;
    expect(entry.sha).toBe(sha);
    expect(entry.baseSha).toBe('a'.repeat(64));
    expect(entry.movedAt).toBeTruthy();
    // Kept, not deleted.
    expect(await getBlob(sha)).not.toBeNull();
    // Reported AFTER the load, not before it.
    expect(viewer.noticeDuringLoad).toEqual([undefined]);
    expect(staleNotice()).toMatchObject({ documentId: BELT_ID, name: 'Belt', variant: 'older-file' });
    expect(staleNotice()!.message).toBe(
      'Your unsaved changes to "Belt" were made on an older version of the file. The newer file is loaded.',
    );
  });

  it('legacy pointer written before the file mtime: stale', async () => {
    project.restore();
    project = installProject({ [BELT_ID]: { mtimeMs: Date.parse('2026-10-02T22:24:00Z') } });
    await seedDraft(DRAFT, 'legacy', { updatedAt: '2026-10-02T18:28:00Z' });

    await store.openDocument(BELT_ID);

    expect(lastLoadWas()).toBe('file');
    expect(setAside()).toHaveLength(1);
    expect(staleNotice()?.documentId).toBe(BELT_ID);
  });

  it('legacy pointer without a row mtimeMs: resumes', async () => {
    await seedDraft(DRAFT, 'legacy', { updatedAt: '2020-01-01T00:00:00Z' });
    await store.openDocument(BELT_ID);
    expect(lastLoadWas()).toBe('draft');
    expect(setAside()).toEqual([]);
    expect(staleNotice()).toBeUndefined();
  });

  it('legacy pointer without updatedAt: resumes', async () => {
    project.restore();
    project = installProject({ [BELT_ID]: { mtimeMs: Date.now() } });
    await seedDraft(DRAFT, 'legacy', { updatedAt: null });
    await store.openDocument(BELT_ID);
    expect(lastLoadWas()).toBe('draft');
    expect(setAside()).toEqual([]);
  });

  it('the file cannot be read: the draft resumes, nothing moves', async () => {
    const sha = await seedDraft(DRAFT, 'stale', { baseSha: 'b'.repeat(64) });
    project.files.delete(BELT_PATH);

    await store.openDocument(BELT_ID);

    expect(lastLoadWas()).toBe('draft');
    expect(readSceneGlbPointer(DRAFT)?.sha).toBe(sha);
    expect(setAside()).toEqual([]);
    expect(staleNotice()).toBeUndefined();
  });

  it('CAS: a draft rewritten between read and move is not moved — it resumes', async () => {
    await seedDraft(DRAFT, 'stale', { baseSha: 'c'.repeat(64) });
    const backend = project.backend as unknown as { readDocument: (r: unknown) => Promise<unknown> };
    const read = backend.readDocument.bind(backend);
    let rewritten = '';
    backend.readDocument = async (ref: unknown) => {
      // Another tab autosaves this very slot while we read the file.
      if (!rewritten) rewritten = await seedDraft(DRAFT, 'other-tab', { baseSha: 'd'.repeat(64) });
      return read(ref);
    };

    await store.openDocument(BELT_ID);

    expect(lastLoadWas()).toBe('draft');
    expect(readSceneGlbPointer(DRAFT)?.sha).toBe(rewritten);
    expect(setAside()).toEqual([]);
    expect(staleNotice()).toBeUndefined();
  });

  it('CAS target already holding the same sha: only the draft pointer is dropped, the file loads', async () => {
    const sha = await seedDraft(DRAFT, 'stale', { baseSha: 'e'.repeat(64) });
    const target = setAsideSlotFor(BELT_ID, sha);
    localStorage.setItem(LS_KEY_SCENE_GLB_PREFIX + target, localStorage.getItem(LS_KEY_SCENE_GLB_PREFIX + DRAFT)!);

    await store.openDocument(BELT_ID);

    expect(lastLoadWas()).toBe('file');
    expect(readSceneGlbPointer(DRAFT)).toBeNull();
    expect(readSceneGlbPointer(target)?.sha).toBe(sha);
    expect(await getBlob(sha)).not.toBeNull();
    expect(staleNotice()?.documentId).toBe(BELT_ID);
  });

  it('a transient open never runs the check', async () => {
    const sha = await seedDraft(DRAFT, 'stale', { baseSha: 'f'.repeat(64) });
    const spy = vi.spyOn(getProjectStore(), 'resolveAssetSource');

    await store.openTransient(makeDraftScene(
      { kind: 'builtin', url: 'https://files.example.test/cell.glb', label: 'Cell' }, 'Cell',
    ));

    expect(spy).not.toHaveBeenCalled();
    expect(readSceneGlbPointer(DRAFT)?.sha).toBe(sha);
    expect(setAside()).toEqual([]);
    expect(staleNotice()).toBeUndefined();
  });
});

// ─── Phase 2 — restore / discard / notice ───────────────────────────────

describe('plan-546 — Restore, Discard and the notice (AC 4, 5, 9, 10, 13, 14)', () => {
  it('Restore without later edits: the old draft is active, stamped with the current file, no notice', async () => {
    const sha = await seedDraft(DRAFT, 'stale', { baseSha: '1'.repeat(64) });
    await store.openDocument(BELT_ID);
    expect(staleNotice()).toBeDefined();

    expect(await store.restoreStaleDraft(BELT_ID)).toBe(true);

    const pointer = readSceneGlbPointer(DRAFT)!;
    expect(pointer.sha).toBe(sha);
    expect(pointer.baseSha).toBe(await revisionOfFile(project, BELT_PATH));
    expect(pointer.movedAt).toBeUndefined();
    expect(lastLoadWas()).toBe('draft');
    expect(setAside()).toEqual([]);
    expect(staleNotice()).toBeUndefined();

    // And the next open resumes it without a notice.
    store.dispose();
    store = makeStore();
    await store.openDocument(BELT_ID);
    expect(lastLoadWas()).toBe('draft');
    expect(staleNotice()).toBeUndefined();
  });

  it('edit after the notice, then Restore: the post-notice draft is flushed and swapped aside, never deleted', async () => {
    const staleSha = await seedDraft(DRAFT, 'stale', { baseSha: '2'.repeat(64) });
    const fileRev = await revisionOfFile(project, BELT_PATH);
    await store.openDocument(BELT_ID);
    await store.applyOp(anOp(7));
    // The debounced autosave is PENDING, not written — Restore must flush it.
    expect((store as unknown as StorePrivates)._draftAutosaveTimer).not.toBeNull();
    expect(readSceneGlbPointer(DRAFT)).toBeNull();

    expect(await store.restoreStaleDraft(BELT_ID)).toBe(true);

    // The restored draft is active, with the current file revision.
    expect(readSceneGlbPointer(DRAFT)).toMatchObject({ sha: staleSha, baseSha: fileRev });
    expect(lastLoadWas()).toBe('draft');
    // The flushed post-notice draft went aside, not away.
    const left = setAside();
    expect(left).toHaveLength(1);
    const swapped = readSceneGlbPointer(left[0])!;
    expect(swapped.sha).not.toBe(staleSha);
    expect(swapped.baseSha).toBe(fileRev);
    expect(await getBlob(swapped.sha)).not.toBeNull();
    // AC 14 — the newest entry is based on the CURRENT file, so the wording says so.
    expect(staleNotice()).toMatchObject({ documentId: BELT_ID, variant: 'other-changes' });
    expect(staleNotice()!.message).toBe('You have other unsaved changes to "Belt".');

    // Reopen: the restored draft resumes (no new move); the notice is re-reported.
    store.dispose();
    store = makeStore();
    clearSceneSyncNotices();
    await store.openDocument(BELT_ID);
    expect(lastLoadWas()).toBe('draft');
    expect(readSceneGlbPointer(DRAFT)?.sha).toBe(staleSha);
    expect(setAside()).toHaveLength(1);
    expect(staleNotice()?.variant).toBe('other-changes');
  });

  it('Discard removes all entries of that document; a second stale draft adds one and deletes nothing', async () => {
    const first = await seedDraft(DRAFT, 'stale-1', { baseSha: '3'.repeat(64) });
    await store.openDocument(BELT_ID);
    expect(setAside()).toHaveLength(1);

    const second = await seedDraft(DRAFT, 'stale-2', { baseSha: '4'.repeat(64) });
    await store.openDocument(BELT_ID);
    expect(setAside()).toHaveLength(2);
    expect(await getBlob(first)).not.toBeNull();
    expect(await getBlob(second)).not.toBeNull();

    expect(await store.discardStaleDraft(BELT_ID)).toBe(2);

    expect(setAside()).toEqual([]);
    expect(await getBlob(first)).toBeNull();
    expect(await getBlob(second)).toBeNull();
    expect(staleNotice()).toBeUndefined();
  });

  it('Restore and Discard with another document open act on their documentId only', async () => {
    const beltStale = await seedDraft(DRAFT, 'belt-stale', { baseSha: '5'.repeat(64) });
    const gearRev = (await revisionOfFile(project, GEAR_PATH))!;
    const gearDraft = await seedDraft(`draft/${GEAR_ID}`, 'gear-mine', { baseSha: gearRev });
    await store.openDocument(BELT_ID);
    expect(setAside()).toHaveLength(1);

    await store.openDocument(GEAR_ID);
    // Opening another document clears the notice (AC 10).
    expect(staleNotice()).toBeUndefined();

    // Discard of Belt touches nothing of Gear.
    const second = await seedDraft(DRAFT, 'belt-stale-2', { baseSha: '6'.repeat(64) });
    localStorage.setItem(
      LS_KEY_SCENE_GLB_PREFIX + setAsideSlotFor(BELT_ID, second),
      JSON.stringify({ ...readSceneGlbPointer(DRAFT), movedAt: new Date(Date.now() + 1000).toISOString() }),
    );
    localStorage.removeItem(LS_KEY_SCENE_GLB_PREFIX + DRAFT);
    expect(setAside()).toHaveLength(2);

    // Restore of Belt while Gear is open: re-opens Belt with its newest entry.
    expect(await store.restoreStaleDraft(BELT_ID)).toBe(true);
    expect(store.openDocumentId).toBe(BELT_ID);
    expect(readSceneGlbPointer(DRAFT)?.sha).toBe(second);
    expect(readSceneGlbPointer(`draft/${GEAR_ID}`)?.sha).toBe(gearDraft);
    expect(setAside(GEAR_ID)).toEqual([]);

    // Open Gear again, then discard Belt's remaining entry from there.
    await store.openDocument(GEAR_ID);
    expect(await store.discardStaleDraft(BELT_ID)).toBe(1);
    expect(setAside()).toEqual([]);
    expect(readSceneGlbPointer(`draft/${GEAR_ID}`)?.sha).toBe(gearDraft);
    expect(readSceneGlbPointer(DRAFT)?.sha).toBe(second);
    expect(await getBlob(beltStale)).toBeNull();
  });

  it('the notice is re-reported on every open while entries exist, and cleared when another document opens', async () => {
    await seedDraft(DRAFT, 'stale', { baseSha: '7'.repeat(64) });
    await store.openDocument(BELT_ID);
    expect(staleNotice()?.documentId).toBe(BELT_ID);

    await store.openDocument(GEAR_ID);
    expect(staleNotice()).toBeUndefined();

    await store.openDocument(BELT_ID);
    expect(staleNotice()?.documentId).toBe(BELT_ID);
    expect(setAside()).toHaveLength(1);
  });

  it('same sha in the live draft and a set-aside entry: Discard keeps the live blob (AC 13)', async () => {
    const sha = await seedDraft(DRAFT, 'twin', { baseSha: '8'.repeat(64) });
    await store.openDocument(BELT_ID);
    expect(setAside()).toHaveLength(1);
    // An identical bake lands in the live draft again.
    expect(await writeSceneGlb(DRAFT, fakeGlb('twin'))).toBe(sha);

    await store.discardStaleDraft(BELT_ID);

    expect(setAside()).toEqual([]);
    expect(readSceneGlbPointer(DRAFT)?.sha).toBe(sha);
    expect(await getBlob(sha)).not.toBeNull();
  });

  it('a failed load of the newer file still sets aside and reports; Restore works afterwards', async () => {
    const sha = await seedDraft(DRAFT, 'stale', { baseSha: '9'.repeat(64) });
    viewer.failNextLoad = true;

    await expect(store.openDocument(BELT_ID)).rejects.toThrow('bake failed');

    expect(readSceneGlbPointer(setAsideSlotFor(BELT_ID, sha))?.sha).toBe(sha);
    expect(staleNotice()?.documentId).toBe(BELT_ID);

    expect(await store.restoreStaleDraft(BELT_ID)).toBe(true);
    expect(lastLoadWas()).toBe('draft');
    expect(readSceneGlbPointer(DRAFT)?.sha).toBe(sha);
    expect(staleNotice()).toBeUndefined();
  });
});

// ─── discard() — the right slot (AC 6) ──────────────────────────────────

describe('plan-546 — discard() drops draft/<documentId> (AC 6)', () => {
  it('after openDocument (saved = null)', async () => {
    await store.openDocument(BELT_ID);
    await store.applyOp(anOp(1));
    await flush(store);
    expect(readSceneGlbPointer(DRAFT)).not.toBeNull();

    await store.discard();

    expect(readSceneGlbPointer(DRAFT)).toBeNull();
    expect(lastLoadWas()).toBe('file');
  });

  it('after a first in-place save (saved set)', async () => {
    await store.openDocument(BELT_ID);
    await store.applyOp(anOp(1));
    expect(await store.save()).toBe('saved');
    await store.applyOp(anOp(2));
    await flush(store);
    expect(readSceneGlbPointer(DRAFT)).not.toBeNull();

    await store.discard();

    expect(readSceneGlbPointer(DRAFT)).toBeNull();
    expect(lastLoadWas()).toBe('file');
    expect(viewer.loaded[viewer.loaded.length - 1].base).toMatchObject({ url: projectAssetUrl(BELT_PATH) });
  });
});
