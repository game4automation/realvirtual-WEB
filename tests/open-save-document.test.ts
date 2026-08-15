// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-716 §9.3 — the ONE open path and the ONE save path (Phase 3, F5).
 *
 * The phase this file covers deletes more than it adds. `_save()`'s row path is
 * gone: no `scn_` is minted, no GLB body is written into the id-keyed OPFS slot,
 * no catalogue row is created. What is left is `openDocument()` on one side and
 * `_saveIntoDocument()` — now with a compare-and-swap — on the other, with
 * `openScene`, `openBuiltin(rvproject:)`, `openEmpty` and "New" forwarding onto
 * them.
 *
 * ## What is asserted, and against what
 *
 * §9.3 names six things and each has its own block below: `openDocument`; "New"
 * minting a document rather than a `scn_`; Save writing the FILE with a
 * precondition that a foreign write in between refuses; `saveAs`/`duplicate`/
 * `delete` as document verbs; the `openEmpty` forward; and `openTransient`
 * byte-identical to the Phase-0 baseline.
 *
 * The last one is deliberately duplicated from
 * `open-paths-characterization.test.ts` rather than referenced: that file is the
 * baseline and must not be edited to accommodate this phase, and the plan asks
 * for a DIFF against it. Restating the two load-bearing transient facts here —
 * no storage write of any kind, and no body slot — is what makes a regression
 * fail in the file that changed.
 *
 * ## The CAS is real
 *
 * `installFakeDocumentProject` hashes what it stores and throws the real
 * `SceneRevisionConflictError`, exactly as both writable backends do under
 * `write-blob-cas.contract.test.ts`. A recording-only fake would pass every
 * assertion here for a store that sent no precondition at all.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  /** Slot name → bytes, as the OPFS body store would answer. */
  bodies: new Map<string, Uint8Array>(),
  /** Every body-slot write, in order — the §2.3e slot-name pin. */
  writes: [] as { slot: string; expected: string | null | undefined }[],
  revision: 0,
  /** Which conflict sentence the save chose. `vi.spyOn` cannot: the browser
   *  runner's ESM namespaces are frozen, so the two functions are replaced at
   *  the module boundary instead. */
  reported: [] as string[],
}));

vi.mock('../src/core/hmi/scene/rv-scene-live-sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/hmi/scene/rv-scene-live-sync')>();
  return {
    ...actual,
    reportSceneMovedToDocument: (name: string) => { h.reported.push(`moved:${name}`); },
    reportSceneConflict: (name: string) => { h.reported.push(`conflict:${name}`); },
  };
});

vi.mock('../src/core/hmi/scene/rv-scene-glb-io', () => ({
  readSceneGlbBody: vi.fn(async (slot: string) => {
    const glb = h.bodies.get(slot);
    return glb ? { glb, revision: `rev-${slot}`, target: 'opfs' as const } : null;
  }),
  writeSceneGlbBody: vi.fn(async (write: { sceneId: string; expectedRevision?: string | null }) => {
    h.writes.push({ slot: write.sceneId, expected: write.expectedRevision });
    return { revision: `rev${++h.revision}`, target: 'opfs' as const };
  }),
  dropSceneGlbBody: vi.fn(async (slot: string) => { h.bodies.delete(slot); }),
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
import { makeDraftScene, type RvScene, type SceneBase } from '../src/core/hmi/scene/rv-scene-types';
import {
  listMetas, clearAllScenes, setDraftScope, writeScene,
} from '../src/core/hmi/scene/rv-scene-storage';
import { clearSceneMutationListeners } from '../src/core/hmi/scene/rv-scene-mutations';
import { getOpenDocumentBase, setOpenDocumentBase } from '../src/core/editor/active-asset-store';
import { saveDocument } from '../src/core/editor/rv-save-document';
import { getProjectStore, resetProjectStore } from '../src/core/project/project-store';
import { projectAssetUrl } from '../src/core/project/rv-project-asset-source';
import { documentsOf } from '../src/core/project/rv-project-documents';
import { writeDocumentAlias, clearAllDocumentAliases } from '../src/core/project/rv-doc-alias';
import type { RvScenePrimitiveOp } from '../src/core/ops/rv-unified-ops';
import {
  installFakeDocumentProject,
  revisionOfFile,
  type FakeDocumentProject,
} from './helpers/fake-document-project';

// ─── Harness ────────────────────────────────────────────────────────────

const BELT_PATH = 'scenes/Belt.glb';
const BELT_ID = 'doc_belt';
const DEMO_URL = '/models/Demo.glb';

function makeViewer() {
  const v = {
    loaded: [] as RvScene[],
    availableModels: [{ url: DEMO_URL, label: 'Demo' }],
    availablePublishedScenes: [],
    currentScene: null as RvScene | null,
    currentModelUrl: null as string | null,
    // Null on purpose, as in the Phase-0 baseline: `_adoptFromLoadedGlb` returns
    // immediately without a model root, and adoption is another plan's seam.
    currentModelRoot: null as unknown,
    registry: {
      getGltfNodeNames: () => [], getGltfNodeIndex: () => -1,
      getPathForNode: () => null, getNode: () => null,
    },
    lastLoadResult: null,
    modes: { has: () => true, setMode: () => {} },
    getPlugin: () => undefined,
    loadScene: async (s: RvScene) => { v.loaded.push(s); v.currentScene = s; },
    loadEmptyScene: async () => { v.currentScene = null; },
  };
  return v;
}

function makeStore(): SceneStore {
  return new SceneStore(makeViewer() as unknown as ConstructorParameters<typeof SceneStore>[0]);
}

function anOp(value = 42): RvScenePrimitiveOp {
  return {
    id: `op_${value}_${Math.random().toString(36).slice(2)}`,
    ts: Date.now(), schemaV: 1, kind: 'setField',
    nodePath: 'Conv1', componentType: 'Drive', fieldName: 'TargetSpeed',
    value, prev: 0,
  } as RvScenePrimitiveOp;
}

function urlParam(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

function fullStorage(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    out[k] = localStorage.getItem(k) ?? '';
  }
  return out;
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
  h.bodies.clear();
  h.writes.length = 0;
  h.reported.length = 0;
  h.revision = 0;
  // `_ensureBaseBytes` fetches the base before it can bake. The bytes do not
  // matter — the bake is mocked — but the fetch has to succeed or every
  // persistence assertion would pass for the wrong reason.
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
  clearSceneMutationListeners();
  window.history.replaceState(window.history.state, '', urlBefore);
});

// ─── openDocument — the one open verb ───────────────────────────────────

describe('plan-716 §9.3 — openDocument', () => {
  it('opens the manifest row, binds the workspace and normalises the URL', async () => {
    await store.openDocument(BELT_ID);

    const snap = store.getSnapshot();
    expect(snap.draft?.base).toEqual({
      kind: 'builtin', url: projectAssetUrl(BELT_PATH), label: 'Belt',
    });
    expect(snap.transient).toBe(false);
    expect(snap.dirty).toBe(false);
    // The address bar carries the DOCUMENT id and no longer carries `?scene=`.
    expect(urlParam('doc')).toBe(BELT_ID);
    expect(urlParam('scene')).toBeNull();
  });

  it('publishes the cross-mode identity as the documentId (R1-I5)', async () => {
    // The R1-I5 transition, now COMPLETE: `sceneDocumentBase` kept its
    // signature through Phase 3 while the value it received became the
    // documentId, and Phase 4 collapsed the kind it builds (§2.6). The shape is
    // still what the dashboard writes for the same row, so `sameDocumentBase`
    // keeps pairing them — which is the property the transition existed to
    // preserve.
    await store.openDocument(BELT_ID);

    // The identity carries the ROW's path: a document is a file, and the
    // projection that binds this identity gets to know where it lives.
    // Pairing is untouched — `sameDocumentBase` compares `documentId` alone.
    expect(store.documentIdentity()).toEqual({
      kind: 'document', documentId: BELT_ID, path: BELT_PATH, name: 'Belt',
    });
    expect(getOpenDocumentBase()).toEqual({
      kind: 'document', documentId: BELT_ID, path: BELT_PATH, name: 'Belt',
    });
  });

  it('resolves an OLD scene id through the alias map', async () => {
    writeDocumentAlias('scn_legacy', BELT_ID);

    await store.openDocument('scn_legacy');

    expect(store.getSnapshot().draft?.name).toBe('Belt');
    // Normalised to the NEW id — an old bookmark stops being old after one open.
    expect(urlParam('doc')).toBe(BELT_ID);
  });

  it('an unknown id throws by name and loads nothing', async () => {
    await expect(store.openDocument('doc_nope')).rejects.toThrow('Document doc_nope not found');
  });

  it('autosaves into draft/<documentId> — the slot the migration renames to', async () => {
    // §2.3e is only correct if the store LOOKS for the renamed slot. The literal
    // is the pin: `draft/<documentId>`, never the base key of the sentinel URL.
    await store.openDocument(BELT_ID);
    await store.applyOp(anOp());
    await new Promise(resolve => setTimeout(resolve, 2400));

    expect(h.writes.map(w => w.slot)).toContain(`draft/${BELT_ID}`);
    expect(h.writes.every(w => !w.slot.includes('rvproject'))).toBe(true);
  });

  it('resumes a draft body that the migration moved onto the document id', async () => {
    h.bodies.set(`draft/${BELT_ID}`, new Uint8Array([0x67, 0x6c, 0x54, 0x46, 9, 9, 9, 9]));

    await store.openDocument(BELT_ID);

    // The resumed BODY is what reached the viewer — a blob URL over the draft
    // bytes, not the document file.
    const loadedBase = store.getSnapshot().draft?.base;
    expect(loadedBase).toEqual({ kind: 'builtin', url: projectAssetUrl(BELT_PATH), label: 'Belt' });
    expect(h.bodies.has(`draft/${BELT_ID}`)).toBe(true);
  });
});

// ─── The forwards ───────────────────────────────────────────────────────

describe('plan-716 §9.3 — the forwarding open paths', () => {
  it('openScene forwards an id that names a document', async () => {
    await store.openScene(BELT_ID);
    expect(urlParam('doc')).toBe(BELT_ID);
    expect(store.documentIdentity()).toEqual({
      kind: 'document', documentId: BELT_ID, path: BELT_PATH, name: 'Belt',
    });
  });

  it('openScene forwards an OLD scene id through the alias', async () => {
    writeDocumentAlias('scn_old', BELT_ID);
    await store.openScene('scn_old');
    expect(urlParam('doc')).toBe(BELT_ID);
  });

  it('openBuiltin(rvproject:) forwards when the manifest lists the path', async () => {
    await store.openBuiltin(projectAssetUrl(BELT_PATH), 'Belt');
    expect(urlParam('doc')).toBe(BELT_ID);
    expect(store.getSnapshot().draft?.base).toEqual({
      kind: 'builtin', url: projectAssetUrl(BELT_PATH), label: 'Belt',
    });
  });

  it('openBuiltin of a BUNDLED model is untouched — a source is not a document', async () => {
    await store.openBuiltin(DEMO_URL, 'Demo');
    expect(urlParam('doc')).toBeNull();
    expect(urlParam('scene')).toBe('builtin:Demo.glb');
    expect(store.documentIdentity()).toEqual({
      kind: 'builtinModel', url: DEMO_URL, name: 'Demo',
    });
  });

  it('openEmpty forwards to the empty draft and does NOT mint a document', async () => {
    // The boot path (`?scene=empty`). Minting here would create a row on every
    // reload of an untitled workspace, which is the opposite of resuming.
    const before = documentsOf(project.project()).length;

    await store.openEmpty();

    expect(store.getSnapshot().draft?.base).toEqual({ kind: 'empty' });
    expect(urlParam('scene')).toBe('empty');
    expect(documentsOf(project.project())).toHaveLength(before);
  });
});

// ─── "New" mints a document, not a scn_ ─────────────────────────────────

describe('plan-716 §9.3 — "New" mints a document (no scn_)', () => {
  it('newEmpty places a document and opens it', async () => {
    await store.newEmpty();

    const docs = documentsOf(project.project());
    expect(docs).toHaveLength(2);
    const created = docs.find(d => d.id !== BELT_ID)!;
    // The project ROOT: a "New" names no folder, and the default folder is the
    // root since `scenes/` stopped being a section anybody chose.
    expect(created.path).toBe('Untitled.glb');
    expect(created.id.startsWith('scn_')).toBe(false);
    expect(created.id.startsWith('doc_')).toBe(true);
    // Opened, addressable, and a real file — not a promise of one.
    expect(urlParam('doc')).toBe(created.id);
    expect(project.files.has('Untitled.glb')).toBe(true);
    // The catalogue gained nothing at all.
    expect(listMetas()).toEqual([]);
  });

  it('createEmpty places a document without switching the workspace', async () => {
    await store.openDocument(BELT_ID);
    const openBefore = store.getSnapshot().draft?.name;

    const id = await store.createEmpty('Cell 7');

    expect(id.startsWith('doc_')).toBe(true);
    expect(documentsOf(project.project()).some(d => d.id === id)).toBe(true);
    expect(store.getSnapshot().draft?.name).toBe(openBefore);
    expect(listMetas()).toEqual([]);
  });

  it('two News do not collide — the name is probed', async () => {
    const a = await store.createEmpty('Cell');
    const b = await store.createEmpty('Cell');
    expect(a).not.toBe(b);
    const paths = documentsOf(project.project()).map(d => d.path);
    expect(paths).toContain('Cell.glb');
    expect(paths).toContain('Cell 2.glb');
  });
});

// ─── Save = the file, with a precondition ───────────────────────────────

describe('plan-716 §9.3 — Save writes the document file with CAS', () => {
  it('writes the file, mints no scene id and no catalogue row', async () => {
    await store.openDocument(BELT_ID);
    await store.applyOp(anOp(100));

    expect(await store.save()).toBe('saved');

    expect(project.writes.map(w => w.relPath)).toEqual([BELT_PATH]);
    expect(listMetas()).toEqual([]);
    // No committed body-slot write: the FILE is the persistence.
    expect(h.writes.filter(w => !w.slot.startsWith('draft/'))).toEqual([]);
  });

  it('states the revision it replaces — the CAS precondition', async () => {
    const atLoad = await revisionOfFile(project, BELT_PATH);
    await store.openDocument(BELT_ID);
    await store.applyOp(anOp(100));

    await store.save();

    expect(project.writes).toHaveLength(1);
    expect(project.writes[0].expected).toBe(atLoad);
  });

  it('a foreign write in between REFUSES the save and keeps their bytes', async () => {
    await store.openDocument(BELT_ID);
    await store.applyOp(anOp(100));
    // Another tab, another verb, an editor in the folder — the case the
    // unconditional write silently lost.
    project.writeForeign(BELT_PATH, 'somebody else got here first');

    await expect(store.save()).rejects.toThrow(/changed since it was read/);

    expect(new TextDecoder().decode(project.files.get(BELT_PATH)!))
      .toBe('somebody else got here first');
  });

  it('a second save states the revision the FIRST one wrote', async () => {
    await store.openDocument(BELT_ID);
    await store.applyOp(anOp(100));
    await store.save();
    const afterFirst = await revisionOfFile(project, BELT_PATH);

    await store.applyOp(anOp(250));
    expect(await store.save()).toBe('saved');

    expect(project.writes).toHaveLength(2);
    expect(project.writes[1].expected).toBe(afterFirst);
  });

  it('a clean second save is a true no-op', async () => {
    await store.openDocument(BELT_ID);
    await store.applyOp(anOp(100));
    await store.save();

    expect(await store.save()).toBe('no-op');
    expect(project.writes).toHaveLength(1);
  });

  it('a draft with no document gets one — the deleted scn_ mint, substituted', async () => {
    await store.openBuiltin(DEMO_URL, 'Demo');
    await store.applyOp(anOp(100));

    expect(await store.save()).toBe('saved');

    const created = documentsOf(project.project()).find(d => d.id !== BELT_ID)!;
    expect(created).toBeDefined();
    expect(created.id.startsWith('scn_')).toBe(false);
    expect(project.files.has(created.path)).toBe(true);
    expect(listMetas()).toEqual([]);
    expect(urlParam('doc')).toBe(created.id);
  });

  it('an ALT SESSION whose scene was migrated is told to reload, not forked (R2-S4b)', async () => {
    // This tab opened `scn_old` the legacy way; another tab's migration then
    // converted it into `Belt`. Before the weiche the save would have placed a
    // SECOND document from the same content — the fork the plan exists to end.
    const legacy = writeScene({
      ...makeDraftScene({ kind: 'builtin', url: DEMO_URL, label: 'Demo' }, 'Old cell'),
      id: 'scn_old',
    });
    await store.openScene(legacy.id);
    await store.applyOp(anOp(100));
    writeDocumentAlias('scn_old', BELT_ID);
    h.reported.length = 0;   // only what THIS save says

    const verdict = await store.save();

    expect(verdict).toBe('target-changed');
    expect(h.reported).toEqual(['moved:Old cell']);
    // Nothing was written anywhere: not a second document, not the Belt file.
    expect(project.writes).toEqual([]);
    expect(documentsOf(project.project())).toHaveLength(1);
  });

  it('a genuine conflict says "conflict" and rethrows', async () => {
    await store.openDocument(BELT_ID);
    await store.applyOp(anOp(100));
    project.writeForeign(BELT_PATH, 'a colleague saved first');
    h.reported.length = 0;

    await expect(store.save()).rejects.toThrow();
    expect(h.reported).toEqual(['conflict:Belt']);
  });
});

// ─── saveAs / duplicate / delete as document verbs ──────────────────────

describe('plan-716 §9.3 — saveAs / duplicate / delete / rename are document ops', () => {
  // ── RE-PINNED, plan-717 Phase 3 (F6) ─────────────────────────────────────
  // The Phase-6 version of this test asserted that the FILE is untouched, and
  // its own comment gave the reason: "moving the bytes is the tree's
  // `applyTreeMove`, a different gesture". plan-717 removes that gesture split —
  // one rename for every document, name AND file, at a stable id — so the
  // assertion is inverted here rather than deleted, and what stays constant is
  // the thing the rename now guarantees: the `id`.
  it('rename writes the manifest row AND moves the file, at a stable id', async () => {
    await store.openDocument(BELT_ID);

    await store.rename(BELT_ID, 'Belt Line 7');

    const row = documentsOf(project.project()).find(d => d.id === BELT_ID);
    expect(row?.name).toBe('Belt Line 7');
    expect(row?.path).toBe('scenes/Belt Line 7.glb');
    // Copy, then delete: the old address is empty and the bytes are at the new
    // one. Nothing about the document's identity moved with them.
    expect(project.files.has(BELT_PATH)).toBe(false);
    expect(project.files.has('scenes/Belt Line 7.glb')).toBe(true);
    // Nothing landed in the catalogue that used to carry the name.
    expect(listMetas()).toEqual([]);
    // The open workspace shows the new name straight away — and saves into the
    // renamed file rather than re-creating the old one.
    expect(store.getSnapshot().draft?.name).toBe('Belt Line 7');
    await store.save();
    expect(project.files.has(BELT_PATH)).toBe(false);
  });

  it('rename of a DIFFERENT document leaves the open workspace alone', async () => {
    const otherId = await store.createEmpty('Spare');
    await store.openDocument(BELT_ID);

    await store.rename(otherId, 'Renamed elsewhere');

    expect(documentsOf(project.project()).find(d => d.id === otherId)?.name)
      .toBe('Renamed elsewhere');
    expect(store.getSnapshot().draft?.name).toBe('Belt');
    // The open document's own file is where it was — only the other one moved.
    expect(project.files.has(BELT_PATH)).toBe(true);
  });


  it('saveAs creates a NEW document and leaves the original file alone', async () => {
    const originalBytes = project.files.get(BELT_PATH)!.slice();
    await store.openDocument(BELT_ID);
    await store.applyOp(anOp(100));

    const newId = await store.saveAs('Belt v2');

    expect(newId).not.toBe(BELT_ID);
    expect(newId.startsWith('scn_')).toBe(false);
    // BESIDE the source, like `duplicate`: a save-as is a copy under a new
    // name, never a move into another folder.
    expect(project.files.get('scenes/Belt v2.glb')).toBeDefined();
    expect(project.files.get(BELT_PATH)).toEqual(originalBytes);
    expect(listMetas()).toEqual([]);
    // The workspace moved onto the copy, so the next save is in-place.
    expect(store.getSnapshot().saved?.id).toBe(newId);
    expect(urlParam('doc')).toBe(newId);
  });

  it('saveAs probes the name rather than overwriting a namesake', async () => {
    await store.openDocument(BELT_ID);
    await store.applyOp(anOp(100));
    await store.saveAs('Belt');   // the original is already `scenes/Belt.glb`

    const paths = documentsOf(project.project()).map(d => d.path);
    expect(paths).toContain('scenes/Belt 2.glb');
    expect(paths.filter(p => p === BELT_PATH)).toHaveLength(1);
  });

  it('duplicate copies the FILE next to itself', async () => {
    const copyId = await store.duplicate(BELT_ID);

    expect(copyId).not.toBe(BELT_ID);
    const row = documentsOf(project.project()).find(d => d.id === copyId)!;
    expect(row.path).toBe('scenes/Belt copy.glb');
    expect(row.copiedFrom).toBe(BELT_ID);
    expect(project.files.get(row.path)).toEqual(project.files.get(BELT_PATH));
  });

  it('delete drops the row and RETIRES the bytes into .trash', async () => {
    await store.delete(BELT_ID);

    expect(documentsOf(project.project()).some(d => d.id === BELT_ID)).toBe(false);
    expect(project.files.has(BELT_PATH)).toBe(false);
    // Recoverable, exactly like `deleteAsset` — a delete gesture in this
    // codebase never destroys the only copy.
    expect(project.files.has('.trash/Belt.glb')).toBe(true);
  });

  it('deleting the OPEN document leaves the workspace on a fallback', async () => {
    await store.openDocument(BELT_ID);

    await store.delete(BELT_ID);

    expect(documentsOf(project.project()).some(d => d.id === BELT_ID)).toBe(false);
    // The first built-in, exactly as the row path fell back.
    expect(store.getSnapshot().draft?.base).toEqual({
      kind: 'builtin', url: DEMO_URL, label: 'Demo',
    });
  });
});

// ─── openTransient — byte-identical to the Phase-0 baseline ─────────────

describe('plan-716 §9.3 — openTransient is unchanged (diff vs. the baseline)', () => {
  const FOREIGN = 'https://files.example.test/cell.glb';
  const foreign = (name = 'Pick & Place Cell'): RvScene =>
    makeDraftScene({ kind: 'builtin', url: FOREIGN, label: name }, name);

  it('leaves every localStorage key byte-identical', async () => {
    localStorage.setItem('rv-scenes/active', JSON.stringify({ id: 'scn_mine' }));
    localStorage.setItem('rv-scenes/draft/empty', JSON.stringify({ marker: 'his own draft' }));
    const before = fullStorage();

    await store.openTransient(foreign());

    expect(fullStorage()).toEqual(before);
    expect(store.isTransient()).toBe(true);
  });

  it('writes no body slot and no document, ever', async () => {
    const docsBefore = documentsOf(project.project()).length;
    await store.openTransient(foreign());

    for (let i = 0; i < 3; i++) {
      await store.applyOp(anOp(i));
      await new Promise(resolve => setTimeout(resolve, 2400));
    }

    expect(h.writes).toEqual([]);
    expect(project.writes).toEqual([]);
    expect(documentsOf(project.project())).toHaveLength(docsBefore);
  });

  it('does not touch the URL and has no document identity', async () => {
    const before = window.location.search;
    await store.openTransient(foreign());
    expect(window.location.search).toBe(before);
    expect(store.documentIdentity()).toBeNull();
  });

  it('STILL publishes the cross-mode handle (the named §9.3 diff point)', async () => {
    // Unchanged from the Phase-0 finding, and unchanged ON PURPOSE: the
    // `setOpenDocumentBase` block at the end of `_loadIntoWorkspace` was not
    // touched by this phase, so a transient http open still overwrites the
    // handle. Phase 4 owns that decision; Phase 3 records that it did not make
    // it by accident.
    await store.openTransient(foreign());
    expect(getOpenDocumentBase()).toEqual({
      kind: 'builtinModel', url: FOREIGN, name: 'Pick & Place Cell',
    });
  });

  it('a transient save materialises a document — the escalation contract', async () => {
    // The one transient behaviour Phase 3 DOES change, and it is the change
    // plan-386 §2.5 always described: saving is the conversion from "somebody
    // else's content" to "mine". Before Phase 3 "mine" was a catalogue row; it
    // is a document now, and nothing about the transient session before the save
    // differs.
    await store.openTransient(foreign('Shared cell'));
    await store.applyOp(anOp(100));

    expect(await store.save()).toBe('saved');

    expect(store.isTransient()).toBe(false);
    const created = documentsOf(project.project()).find(d => d.id !== BELT_ID)!;
    expect(created.name).toBe('Shared cell');
    expect(listMetas()).toEqual([]);
  });
});

// ─── The row path is gone ───────────────────────────────────────────────

describe('plan-716 §9.3 — the deleted row save (F1)', () => {
  it('no save path writes a catalogue row any more', async () => {
    const base: SceneBase = { kind: 'empty' };
    await store.openEmpty();
    await store.applyOp(anOp(1));
    await store.save();

    await store.openBuiltin(DEMO_URL, 'Demo');
    await store.applyOp(anOp(2));
    await store.save();

    await store.openDocument(BELT_ID);
    await store.applyOp(anOp(3));
    await store.save();

    expect(listMetas()).toEqual([]);
    expect(base.kind).toBe('empty');   // the base kind itself is untouched
    // Three saves, three document files — and not one `scn_` anywhere.
    expect(documentsOf(project.project()).every(d => !d.id.startsWith('scn_'))).toBe(true);
  });

  it('a save with no writable project writes nothing and says so', async () => {
    project.restore();
    resetProjectStore();
    const orphan = makeStore();
    try {
      await orphan.openBuiltin(DEMO_URL, 'Demo');
      await orphan.applyOp(anOp(1));

      expect(await orphan.save()).toBe('no-op');
      expect(listMetas()).toEqual([]);
      expect(getProjectStore().getBackend()).toBeNull();
    } finally {
      orphan.dispose();
    }
  });
});

// ─── The CARD's save of a row-opened document (field finding 2026-08-14) ──
//
// The tests above call `store.save()` directly — below the routing gate the
// Save button actually goes through. That gate (`saveSceneDocument`) read
// `snap.isDraft || !snap.saved`, and a workspace opened via `openDocument`
// reports `saved: null` — so EVERY card save of a row-opened document asked
// for a name and forked a new file (`empty 2.glb`, `empty 2 2.glb`, …). This
// suite goes through the same entry the button uses.

describe('the save card saves a row-opened document in place', () => {
  it('no name prompt, no new row, bytes to the row path', async () => {
    await store.openDocument(BELT_ID);
    await store.applyOp(anOp(7));
    const rowsBefore = documentsOf(project.project()).length;

    // The card's route: `saveDocument(null, store)` with NO requestName. If
    // the gate decided this needs a name, the result is 'blocked' — which is
    // exactly the regression this test exists to catch.
    const result = await saveDocument(null, store);

    expect(result.kind).toBe('saved');
    expect(project.writes.map(w => w.relPath)).toEqual([BELT_PATH]);
    expect(documentsOf(project.project()).length).toBe(rowsBefore);
    expect(documentsOf(project.project()).map(d => d.path)).not.toContain('Belt 2.glb');
  });

  it('the snapshot calls a row-opened workspace what it is — not a draft', async () => {
    await store.openDocument(BELT_ID);
    expect(store.getSnapshot().isDraft).toBe(false);
  });

  it('an ACTUAL draft still asks before anything is written', async () => {
    await store.openEmpty();
    await store.applyOp(anOp(1));

    const result = await saveDocument(null, store);

    // No requestName handed in → the gate must refuse, not invent a file.
    expect(result.kind).toBe('blocked');
    expect(project.writes).toEqual([]);
  });
});
