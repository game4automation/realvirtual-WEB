// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-527 §9.3 — the replace-from-outside machinery (`rv-document-replace`),
 * salvaged from the abandoned Blender branch (1776f3bd) for plan-764 (LOP #171).
 *
 * Runs the REAL sequence (`replaceDocument`) against the REAL production deps
 * (`createViewerReplaceDeps`) over a real `SceneStore` and a project fixture
 * with a real compare-and-swap (`installFakeDocumentProject`). Only the viewer
 * is a double — its `loadScene` reads the GLB it is handed, so a test can make
 * one specific file fail to load or leave a placement missing. Draco, corrupt
 * BIN chunks and missing magic go through the viewer's own `GLTFLoader`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Group, Mesh, BoxGeometry, MeshStandardMaterial, Vector3 } from 'three';

const h = vi.hoisted(() => ({
  bodies: new Map<string, Uint8Array>(),
  revision: 0,
}));

vi.mock('../src/core/hmi/scene/rv-scene-live-sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/hmi/scene/rv-scene-live-sync')>();
  return { ...actual, reportSceneMovedToDocument: () => {}, reportSceneConflict: () => {} };
});

vi.mock('../src/core/hmi/scene/rv-scene-glb-io', () => ({
  readSceneGlbBody: vi.fn(async (slot: string) => {
    const glb = h.bodies.get(slot);
    return glb ? { glb, revision: `rev-${slot}`, target: 'opfs' as const } : null;
  }),
  writeSceneGlbBody: vi.fn(async (write: { sceneId: string; glb: Uint8Array }) => {
    h.bodies.set(write.sceneId, write.glb);
    return { revision: `rev${++h.revision}`, target: 'opfs' as const };
  }),
  dropSceneGlbBody: vi.fn(async (slot: string) => { h.bodies.delete(slot); }),
  sceneGlbBodyRevision: vi.fn(async (slot: string) => (h.bodies.has(slot) ? `rev-${slot}` : null)),
}));

vi.mock('../src/core/hmi/scene/rv-scene-glb-bake', () => ({
  // A self-contained GLB the fake viewer can read the marker of — built inline:
  // a factory must not import project modules (they import this one back).
  bakeIntoGlb: vi.fn(async () => {
    const json = new TextEncoder().encode(JSON.stringify({
      asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'saved-by-web' }],
    }));
    const pad = (json.byteLength + 3) & ~3;
    const glb = new Uint8Array(20 + pad);
    const dv = new DataView(glb.buffer);
    dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, glb.byteLength, true);
    dv.setUint32(12, pad, true); dv.setUint32(16, 0x4e4f534a, true);
    glb.fill(0x20, 20); glb.set(json, 20);
    return { glb, warnings: [], writtenReferences: [] };
  }),
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
import { clearAllScenes, setDraftScope } from '../src/core/hmi/scene/rv-scene-storage';
import { clearSceneMutationListeners } from '../src/core/hmi/scene/rv-scene-mutations';
import { setActiveAssetContext, setOpenDocumentBase } from '../src/core/editor/active-asset-store';
import { DocumentLockedError, ERR_DOCUMENT_LOCKED } from '../src/core/editor/rv-asset-document';
import * as leafLock from '../src/core/editor/rv-document-lock';
import { resetProjectStore } from '../src/core/project/project-store';
import { clearAllDocumentAliases } from '../src/core/project/rv-doc-alias';
import { revisionOfBytes } from '../src/core/project/rv-scene-record';
import { setSceneCamera } from '../src/core/engine/rv-asset-reference';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { getProblems, resetProblemsForTests } from '../src/core/hmi/problems-store';
import type { RvScenePrimitiveOp } from '../src/core/ops/rv-unified-ops';
import type { RvScene } from '../src/core/hmi/scene/rv-scene-types';
import {
  createViewerReplaceDeps,
  replaceDocument,
  replaceStatus,
  resetReplaceOperationsForTests,
  REPLACE_PROBLEM_CODE,
  type ReplaceArgs,
  type ReplaceResult,
} from '../src/plugins/mcp-bridge/rv-document-replace';
import {
  fakeGlb,
  installFakeDocumentProject,
  type FakeDocumentProject,
} from './helpers/fake-document-project';

// ─── Harness ────────────────────────────────────────────────────────────

const PROJECT_ID = 'prj_blender';
const A = { id: 'doc_a', path: 'models/CellA.glb', name: 'CellA' };
const B = { id: 'doc_b', path: 'models/CellB.glb', name: 'CellB' };
const SESSION = 'page:1';
const STAGING = '/api/blender/staging/tok123';

/** The node name a fixture GLB carries — what the fake viewer reads to decide how a load behaves. */
function markerOf(bytes: ArrayBuffer | Uint8Array | undefined): string | null {
  if (!bytes) return null;
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.byteLength < 20) return null;
  const len = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(12, true);
  try {
    const json = JSON.parse(new TextDecoder().decode(u8.subarray(20, 20 + len))) as { nodes?: { name?: string }[] };
    return json.nodes?.[0]?.name ?? null;
  } catch {
    return null;
  }
}

interface FakeViewer {
  loaded: { scene: RvScene; marker: string | null }[];
  camera: { position: Vector3 };
  controls: { target: Vector3; update(): void };
  currentModelRoot: Group | null;
  currentModelUrl: string | null;
  modes: { activeMode: string; has(): boolean; setMode(): void };
  emitted: { event: string; data: unknown }[];
  invalidated: string[];
  instances: Set<{ identity?: boolean; baked: { assetId: string; url: string } }>;
  /** Markers whose load throws. */
  throwOn: Set<string>;
  /** Markers whose load leaves one placement missing. */
  missingOn: Set<string>;
  missing: number;
  sceneReadyCalls: number;
  [key: string]: unknown;
}

function makeViewer(): FakeViewer {
  const v: FakeViewer = {
    loaded: [],
    camera: { position: new Vector3(1, 2, 3) },
    controls: { target: new Vector3(0, 0.5, 0), update: () => {} },
    currentModelRoot: null,
    currentModelUrl: null,
    modes: { activeMode: 'viewer', has: () => true, setMode: () => {} },
    emitted: [],
    invalidated: [],
    instances: new Set(),
    throwOn: new Set(),
    missingOn: new Set(),
    missing: 0,
    sceneReadyCalls: 0,
    availableModels: [],
    availablePublishedScenes: [],
    currentScene: null,
    registry: { getGltfNodeNames: () => [], getGltfNodeIndex: () => -1, getPathForNode: () => null, getNode: () => null },
    lastLoadResult: null,
    getPlugin: () => undefined,
    cancelCameraAnimation: () => {},
    markRenderDirty: () => {},
    emit: (event: string, data: unknown) => { v.emitted.push({ event, data }); },
    whenSceneReady: async () => { v.sceneReadyCalls++; },
    loadEmptyScene: async () => {},
    placements: {
      get progress() { return { state: 'idle', total: 0, materialized: 0, pending: 0, missing: v.missing }; },
      whenMaterialized: async () => {},
      sourceOf: (ref: { catalogId: string }) =>
        (ref.catalogId === `project:${A.path}` ? { key: `resolved:project:${A.path}` } : null),
      modelCache: { invalidate: (key: string) => { v.invalidated.push(key); } },
    },
    bakeRegistry: { get instances() { return v.instances; } },
    loadScene: async (scene: RvScene, _trust?: unknown, opts?: { data?: ArrayBuffer; identityUrl?: string }) => {
      const marker = markerOf(opts?.data);
      v.currentModelUrl = opts?.identityUrl ?? null;
      // The document preset a real load would animate to — a reload that keeps
      // the camera has to undo exactly this.
      v.camera.position.set(100, 100, 100);
      v.controls.target.set(50, 0, 50);
      if (marker && v.throwOn.has(marker)) throw new Error(`load of ${marker} failed`);
      v.missing = marker && v.missingOn.has(marker) ? 1 : 0;
      const root = new Group();
      setSceneCamera(root, { px: 100, py: 100, pz: 100, tx: 50, ty: 0, tz: 50 });
      v.currentModelRoot = root;
      v.loaded.push({ scene, marker });
    },
  };
  return v;
}

function anOp(value = 42): RvScenePrimitiveOp {
  return {
    id: `op_${value}_${Math.random().toString(36).slice(2)}`,
    ts: Date.now(), schemaV: 1, kind: 'setField',
    nodePath: 'Conv1', componentType: 'Drive', fieldName: 'TargetSpeed',
    value, prev: 0,
  } as RvScenePrimitiveOp;
}

let project: FakeDocumentProject;
let viewer: FakeViewer;
let store: SceneStore;
/** Bytes the staging slot serves; `null` = 404. */
let staged: Uint8Array | null;
let fetches: string[];
let gate: Promise<void> | null;

function deps(extra: { validateTimeoutMs?: number; validateLoader?: never } = {}) {
  return () => createViewerReplaceDeps(viewer, SESSION, {
    sceneStore: () => store,
    fetchStaged: async (url) => {
      fetches.push(url);
      if (gate) await gate;
      if (!staged) throw new Error('HTTP 404');
      return staged;
    },
    validateTimeoutMs: extra.validateTimeoutMs ?? 20_000,
    ...(extra.validateLoader ? { validateLoader: extra.validateLoader } : {}),
  });
}

function args(over: Partial<ReplaceArgs> = {}): ReplaceArgs {
  return {
    operationId: `op-${Math.random().toString(36).slice(2)}`,
    projectId: PROJECT_ID,
    documentId: A.id,
    stagingUrl: STAGING,
    expectedRevision: 'any',
    ...over,
  };
}

function replace(a: ReplaceArgs, d = deps()): Promise<ReplaceResult> {
  return replaceDocument(a, d, { sessionId: SESSION });
}

async function revOf(path: string): Promise<string> {
  return revisionOfBytes(project.files.get(path)!);
}

function fail(r: ReplaceResult): Extract<ReplaceResult, { ok: false }> {
  expect(r.ok, JSON.stringify(r)).toBe(false);
  return r as Extract<ReplaceResult, { ok: false }>;
}

function ok(r: ReplaceResult): Extract<ReplaceResult, { ok: true }> {
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return r as Extract<ReplaceResult, { ok: true }>;
}

/** The (untyped) decode seam of three's DRACOLoader that GLTFLoader's KHR_draco path calls. */
interface DecodeHook { decodeGeometry(buffer: ArrayBuffer, taskConfig?: unknown): Promise<unknown> }

/** A real GLB with one box mesh (positions + indices in a BIN chunk). */
async function meshGlb(): Promise<Uint8Array> {
  const root = new Group();
  root.name = 'Pushed';
  const box = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
  box.name = 'Box';
  root.add(box);
  return new Uint8Array(await objectToGlb(root));
}

/** `bytes` with its BIN chunk cut in half — the JSON still promises the full buffer. */
function truncateBin(bytes: Uint8Array): Uint8Array {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLen = dv.getUint32(12, true);
  const binHeader = 20 + jsonLen;
  const binLen = dv.getUint32(binHeader, true);
  const keep = (Math.floor(binLen / 2) + 3) & ~3;
  const out = new Uint8Array(binHeader + 8 + keep);
  out.set(bytes.subarray(0, binHeader + 8 + keep));
  const ov = new DataView(out.buffer);
  ov.setUint32(8, out.byteLength, true);
  ov.setUint32(binHeader, keep, true);
  return out;
}

/** A GLB whose only primitive is KHR_draco_mesh_compression over garbage bytes. */
function brokenDracoGlb(): Uint8Array {
  const bin = new Uint8Array(16).fill(0xab);
  const json = new TextEncoder().encode(JSON.stringify({
    asset: { version: '2.0' },
    extensionsUsed: ['KHR_draco_mesh_compression'],
    extensionsRequired: ['KHR_draco_mesh_compression'],
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'Broken', mesh: 0 }],
    meshes: [{ primitives: [{
      attributes: { POSITION: 0 },
      extensions: { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: 0 } } },
    }] }],
    accessors: [{ componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 1] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 16 }],
    buffers: [{ byteLength: 16 }],
  }));
  const jsonPad = (json.byteLength + 3) & ~3;
  const total = 12 + 8 + jsonPad + 8 + bin.byteLength;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jsonPad, true); dv.setUint32(16, 0x4e4f534a, true);
  out.fill(0x20, 20, 20 + jsonPad); out.set(json, 20);
  dv.setUint32(20 + jsonPad, bin.byteLength, true); dv.setUint32(24 + jsonPad, 0x004e4942, true);
  out.set(bin, 28 + jsonPad);
  return out;
}

beforeEach(() => {
  localStorage.clear();
  clearAllScenes();
  clearAllDocumentAliases();
  setDraftScope(null);
  clearSceneMutationListeners();
  setOpenDocumentBase(null);
  setActiveAssetContext(null);
  resetProjectStore();
  resetProblemsForTests();
  resetReplaceOperationsForTests();
  h.bodies.clear();
  h.revision = 0;
  staged = fakeGlb('pushed');
  fetches = [];
  gate = null;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(new ArrayBuffer(8), { status: 200 }));
  project = installFakeDocumentProject({
    id: PROJECT_ID,
    documents: [
      { ...A, section: 'models' } as never,
      { ...B, section: 'models' } as never,
    ],
    files: { [A.path]: fakeGlb('a-v1'), [B.path]: fakeGlb('b-v1') },
  });
  viewer = makeViewer();
  store = new SceneStore(viewer as unknown as ConstructorParameters<typeof SceneStore>[0]);
});

afterEach(() => {
  vi.restoreAllMocks();
  store.dispose();
  project.restore();
  resetProjectStore();
  setActiveAssetContext(null);
  clearAllScenes();
});

// ─── 1–2: revision ──────────────────────────────────────────────────────

describe('plan-527 §9.3 — revision precondition', () => {
  it('writes with the matching expectedRevision and answers the new revision', async () => {
    const before = await revOf(A.path);
    const r = ok(await replace(args({ expectedRevision: before })));
    expect(markerOf(project.files.get(A.path))).toBe('pushed');
    expect(r.revision).toBe(await revOf(A.path));
    expect(r.revision).not.toBe(before);
    expect(r.reloaded).toBe('none');
    expect(project.writes.at(-1)).toEqual({ relPath: A.path, expected: before });
  });

  it('a stale revision is a revision-conflict and leaves the file; "any" writes', async () => {
    const r = fail(await replace(args({ expectedRevision: 'f'.repeat(64) })));
    expect(r.reason).toBe('revision-conflict');
    expect(markerOf(project.files.get(A.path))).toBe('a-v1');
    ok(await replace(args({ expectedRevision: 'any' })));
    expect(markerOf(project.files.get(A.path))).toBe('pushed');
  });
});

// ─── 3–4: local changes win ─────────────────────────────────────────────

describe('plan-527 §9.3 — WEB wins (local-changes), also with "any"', () => {
  it('the open target is dirty → local-changes, nothing written', async () => {
    await store.openDocument(A.id);
    await store.applyOp(anOp());
    const r = fail(await replace(args()));
    expect(r.reason).toBe('local-changes');
    expect(markerOf(project.files.get(A.path))).toBe('a-v1');
    expect(fetches).toEqual([]);
  });

  it('a draft of the open target → local-changes', async () => {
    await store.openDocument(A.id);
    h.bodies.set(`draft/${A.id}`, fakeGlb('draft'));
    expect(fail(await replace(args())).reason).toBe('local-changes');
    expect(markerOf(project.files.get(A.path))).toBe('a-v1');
  });

  it('document A CLOSED with a draft, B open: a push on A with "any" → local-changes, file and draft untouched', async () => {
    await store.openDocument(B.id);
    const draft = fakeGlb('a-draft');
    h.bodies.set(`draft/${A.id}`, draft);
    const r = fail(await replace(args({ documentId: A.id, expectedRevision: 'any' })));
    expect(r.reason).toBe('local-changes');
    expect(markerOf(project.files.get(A.path))).toBe('a-v1');
    expect(h.bodies.get(`draft/${A.id}`)).toBe(draft);
    expect(project.writes).toEqual([]);
  });

  it('the asset editor holds the target (save lock / test run) → local-changes', async () => {
    for (const kind of ['save', 'test-run'] as const) {
      viewer.modes.activeMode = 'editor';
      setActiveAssetContext({
        viewer: viewer as never,
        doc: { base: { kind: 'document', documentId: A.id, path: A.path, name: A.name }, lockOwner: { kind, startedAt: 0 } } as never,
      });
      const r = fail(await replace(args({ expectedRevision: 'any' })));
      expect(r.reason, kind).toBe('local-changes');
      expect(markerOf(project.files.get(A.path)), kind).toBe('a-v1');
    }
  });

  it('a second replace while the first holds the document → local-changes', async () => {
    await store.openDocument(A.id);
    let open!: () => void;
    gate = new Promise((r) => { open = r; });
    const first = replace(args());
    await vi.waitFor(() => expect(fetches.length).toBe(1));
    const second = fail(await replace(args()));
    expect(second.reason).toBe('local-changes');
    open();
    ok(await first);
  });
});

// ─── the replace lock ───────────────────────────────────────────────────

describe('plan-527 §9.3 — the replace lock refuses edit, undo and save while it runs', () => {
  it('delayed fetch/decode: edit, undo and scene save are refused, all possible again afterwards', async () => {
    await store.openDocument(A.id);
    let open!: () => void;
    gate = new Promise((r) => { open = r; });
    const running = replace(args());
    await vi.waitFor(() => expect(fetches.length).toBe(1));

    const edit = await store.applyOp(anOp(7)).catch((e: unknown) => e);
    const undo = await store.undo().catch((e: unknown) => e);
    const save = await store.save().catch((e: unknown) => e);
    for (const refused of [edit, undo, save]) {
      expect(refused).toBeInstanceOf(DocumentLockedError);
      expect((refused as DocumentLockedError).code).toBe(ERR_DOCUMENT_LOCKED);
      expect((refused as DocumentLockedError).owner.kind).toBe('replace');
    }
    expect(store.document.ops).toHaveLength(0);

    open();
    ok(await running);
    expect(store.replaceLockOwner).toBeNull();
    await store.applyOp(anOp(8));
    expect(store.document.ops).toHaveLength(1);
    await store.undo();
    expect(store.document.ops).toHaveLength(0);
  });
});

describe('plan-764 port — every scene-store mutation entry under the replace lock', () => {
  /** Run `fn` and return what it threw/rejected with, or `null` when it went through. */
  async function outcome(fn: () => unknown): Promise<unknown> {
    try { await fn(); return null; } catch (e) { return e; }
  }

  // The negative control (LOP #174): the SAME call is refused under the lock and
  // NOT refused without it. A refusal-only test stays green on a store that
  // refuses everything; a success-only test stays green on one that refuses
  // nothing.
  const entries: Array<[string, () => unknown]> = [
    ['applyOp', () => store.applyOp(anOp(3))],
    ['undo', () => store.undo()],
    ['redo', () => store.redo()],
    ['save', () => store.save()],
    ['saveAs', () => store.saveAs('Copy of A')],
    ['discard', () => store.discard()],
    ['saveSettingsIntoModel', () => store.saveSettingsIntoModel('A settings')],
    ['restoreStaleDraft (plan-546, not on the branch)', () => store.restoreStaleDraft(A.id)],
  ];

  for (const [name, call] of entries) {
    it(`${name}: refused while held, not refused once released`, async () => {
      await store.openDocument(A.id);
      const token = await store.tryLockForReplace();
      expect(token).not.toBeNull();

      const refused = await outcome(call);
      expect(refused).toBeInstanceOf(DocumentLockedError);
      expect((refused as DocumentLockedError).code).toBe(ERR_DOCUMENT_LOCKED);
      expect((refused as DocumentLockedError).owner.kind).toBe('replace');
      expect(store.document.ops).toHaveLength(0);

      store.unlockReplace(token);
      expect(store.replaceLockOwner).toBeNull();
      // Whatever else the call may answer in this fixture, it is no longer the lock.
      expect(await outcome(call)).not.toBeInstanceOf(DocumentLockedError);
    });
  }

  it('applyOp really lands once released (the positive half is not vacuous)', async () => {
    await store.openDocument(A.id);
    const token = await store.tryLockForReplace();
    await store.applyOp(anOp(4)).catch(() => {});
    expect(store.document.ops).toHaveLength(0);
    store.unlockReplace(token);
    await store.applyOp(anOp(4));
    expect(store.document.ops).toHaveLength(1);
  });

  it('a second lock is refused, a foreign token releases nothing', async () => {
    await store.openDocument(A.id);
    const token = await store.tryLockForReplace();
    expect(await store.tryLockForReplace()).toBeNull();
    store.unlockReplace({ kind: 'replace', token: Symbol('foreign'), generation: token!.generation });
    expect(store.replaceLockOwner?.kind).toBe('replace');
    store.unlockReplace(token);
    expect(store.replaceLockOwner).toBeNull();
  });
});

describe('plan-764 port — ONE DocumentLockedError across both lineages', () => {
  it("the asset document re-exports the leaf module's class, not a copy", () => {
    expect(DocumentLockedError).toBe(leafLock.DocumentLockedError);
    expect(ERR_DOCUMENT_LOCKED).toBe(leafLock.ERR_DOCUMENT_LOCKED);
  });

  it("a scene-store refusal is caught as the asset document's DocumentLockedError", async () => {
    await store.openDocument(A.id);
    const token = await store.tryLockForReplace();
    let caught: unknown = null;
    try { await store.undo(); } catch (e) { caught = e; }
    store.unlockReplace(token);
    // Imported from rv-asset-document; thrown by scene-store via rv-document-lock.
    expect(caught instanceof DocumentLockedError).toBe(true);
    expect(caught instanceof leafLock.DocumentLockedError).toBe(true);
  });
});

// ─── identity, idempotency, origin ──────────────────────────────────────

describe('plan-527 §9.3 — project, operation and origin binding', () => {
  it('a projectId of another project (identical bytes and document id) → project-mismatch', async () => {
    staged = project.files.get(A.path)!;
    const r = fail(await replace(args({ projectId: 'prj_other', expectedRevision: await revOf(A.path) })));
    expect(r.reason).toBe('project-mismatch');
    expect(project.writes).toEqual([]);
    expect(fetches).toEqual([]);
  });

  it('the same operationId twice → the first result, ONE write (also while the first still decodes)', async () => {
    let open!: () => void;
    gate = new Promise((r) => { open = r; });
    const a = args();
    const first = replace(a);
    const concurrent = replace(a);
    open();
    const [r1, r2] = await Promise.all([first, concurrent]);
    expect(r2).toEqual(r1);
    const r3 = await replace(a);
    expect(r3).toEqual(r1);
    expect(project.writes.filter((w) => w.relPath === A.path)).toHaveLength(1);
    expect(fetches).toHaveLength(1);
  });

  it('a reused operationId for another document → duplicate-operation, nothing written', async () => {
    const a = args();
    ok(await replace(a));
    const r = fail(await replace({ ...a, documentId: B.id }));
    expect(r.reason).toBe('duplicate-operation');
    expect(markerOf(project.files.get(B.path))).toBe('b-v1');
  });

  it('a stagingUrl of a foreign origin → foreign-origin, no fetch', async () => {
    const r = fail(await replace(args({ stagingUrl: 'https://evil.example/api/blender/staging/x' })));
    expect(r.reason).toBe('foreign-origin');
    expect(fetches).toEqual([]);
    expect(project.writes).toEqual([]);
  });

  it('status: pending while running, done afterwards; another session and an unknown id are unknown-operation', async () => {
    let open!: () => void;
    gate = new Promise((r) => { open = r; });
    const a = args();
    const running = replace(a);
    expect(replaceStatus(a.operationId, SESSION).status).toBe('pending');
    open();
    const result = await running;
    expect(replaceStatus(a.operationId, SESSION)).toMatchObject({ status: 'done', result });
    const other = replaceStatus(a.operationId, 'page:2');
    expect(other.status).toBe('unknown-operation');
    expect(other.detail).toMatch(/does NOT mean|another bridge session/i);
    expect(replaceStatus('never-seen', SESSION).status).toBe('unknown-operation');
  });
});

// ─── 5: full parse ──────────────────────────────────────────────────────

describe('plan-527 §9.3 — invalid GLBs are refused before the write', () => {
  it('bytes without the GLB magic → invalid-glb', async () => {
    staged = new TextEncoder().encode('this is not a glb at all, just text');
    expect(fail(await replace(args())).reason).toBe('invalid-glb');
    expect(project.writes).toEqual([]);
  });

  it('valid JSON with a truncated BIN chunk → invalid-glb', async () => {
    const good = await meshGlb();
    staged = good;
    ok(await replace(args()));               // the untouched fixture loads
    project.writes.length = 0;
    staged = truncateBin(good);
    expect(fail(await replace(args())).reason).toBe('invalid-glb');
    expect(project.writes).toEqual([]);
  });

  it('a Draco primitive the decoder rejects → invalid-glb, nothing written', async () => {
    // The viewer's GLTFLoader + KHR_draco path, with a Draco loader whose decode
    // fails the way the real decoder reports a corrupt stream. (The real worker
    // cannot be started inside the vitest browser runner.)
    const draco = new DRACOLoader();
    const decodes: number[] = [];
    (draco as unknown as DecodeHook).decodeGeometry = async (buffer: ArrayBuffer) => {
      decodes.push(buffer.byteLength);
      throw new Error('THREE.DRACOLoader: Decoding failed: Not a Draco file.');
    };
    const loader = new GLTFLoader();
    loader.setDRACOLoader(draco);
    staged = brokenDracoGlb();
    const r = fail(await replace(args(), deps({ validateLoader: loader as never })));
    expect(r.reason).toBe('invalid-glb');
    expect(r.detail).toMatch(/Decoding failed/);
    expect(decodes).toEqual([16]);
    expect(project.writes).toEqual([]);
  });

  it('a Draco decoder that never answers → invalid-glb after the parse budget, nothing written', async () => {
    const draco = new DRACOLoader();
    (draco as unknown as DecodeHook).decodeGeometry = () => new Promise(() => {});
    const loader = new GLTFLoader();
    loader.setDRACOLoader(draco);
    staged = brokenDracoGlb();
    const r = fail(await replace(args(), deps({ validateLoader: loader as never, validateTimeoutMs: 300 })));
    expect(r.reason).toBe('invalid-glb');
    expect(r.detail).toMatch(/did not finish/);
    expect(project.writes).toEqual([]);
    expect(store.replaceLockOwner).toBeNull();
  });
});

// ─── 7–8: reload and its proof ──────────────────────────────────────────

describe('plan-527 §9.3 — reload with the camera kept, restore on failure', () => {
  it('open document: camera position/target unchanged (1e-6), preset not applied, undo history empty', async () => {
    await store.openDocument(A.id);
    // An ordinary open DOES persist the document preset — the control.
    expect(localStorage.getItem('rv-camera-start:CellA')).not.toBeNull();
    localStorage.removeItem('rv-camera-start:CellA');
    await store.applyOp(anOp(1));
    await store.save();
    expect(store.document.ops.length).toBeGreaterThan(0);
    viewer.camera.position.set(1, 2, 3);
    viewer.controls.target.set(0, 0.5, 0);

    const r = ok(await replace(args({ expectedRevision: await revOf(A.path) })));
    expect(r.reloaded).toBe('open-document');
    expect(viewer.loaded.at(-1)?.marker).toBe('pushed');
    expect(viewer.camera.position.distanceTo(new Vector3(1, 2, 3))).toBeLessThan(1e-6);
    expect(viewer.controls.target.distanceTo(new Vector3(0, 0.5, 0))).toBeLessThan(1e-6);
    expect(localStorage.getItem('rv-camera-start:CellA')).toBeNull();
    expect(store.document.ops).toHaveLength(0);
    expect(store.canUndo()).toBe(false);
    expect(store.canRedo()).toBe(false);
    expect(store.getSnapshot().dirty).toBe(false);
  });

  it('the reload throws after the write → previous bytes back, reload-failed-restored, the old document is shown again', async () => {
    await store.openDocument(A.id);
    viewer.throwOn.add('pushed');
    const r = fail(await replace(args()));
    expect(r.reason).toBe('reload-failed-restored');
    expect(markerOf(project.files.get(A.path))).toBe('a-v1');
    expect(viewer.loaded.at(-1)?.marker).toBe('a-v1');
    expect(r.revision).toBe(await revOf(A.path));
    expect(getProblems().some((p) => p.code === REPLACE_PROBLEM_CODE)).toBe(true);
    expect(store.replaceLockOwner).toBeNull();
  });

  it('a nested placement no longer loads (missing rises) → restore → reload-failed-restored', async () => {
    await store.openDocument(A.id);
    expect(viewer.missing).toBe(0);
    viewer.missingOn.add('pushed');
    const r = fail(await replace(args()));
    expect(r.reason).toBe('reload-failed-restored');
    expect(r.detail).toMatch(/placement/);
    expect(markerOf(project.files.get(A.path))).toBe('a-v1');
    expect(viewer.missing).toBe(0);
  });

  it('…and when the restore fails too → restore-failed, never a success', async () => {
    await store.openDocument(A.id);
    viewer.missingOn.add('pushed');
    const write = project.backend.writeDocument.bind(project.backend);
    let n = 0;
    (project.backend as { writeDocument: typeof write }).writeDocument = async (ref, bytes, o) => {
      if (++n === 2) throw new Error('disk full');
      return write(ref, bytes, o);
    };
    const r = fail(await replace(args()));
    expect(r.reason).toBe('restore-failed');
    expect(r.detail).toMatch(/disk full/);
    expect(getProblems().find((p) => p.code === REPLACE_PROBLEM_CODE)?.severity).toBe('error');
    expect(store.replaceLockOwner).toBeNull();
  });

  it('the same document stays open → reloaded as before, no reloadSkipped (LOP #180 control)', async () => {
    await store.openDocument(A.id);
    const r = ok(await replace(args()));
    expect(r.reloaded).toBe('open-document');
    expect(r.reloadSkipped).toBeUndefined();
    expect(viewer.loaded.at(-1)?.marker).toBe('pushed');
  });

  it('a placement in the open document references the pushed document → placementsRebaked: 1, scene ready afterwards', async () => {
    await store.openDocument(B.id);
    const key = `resolved:project:${A.path}`;
    viewer.instances.add({ identity: false, baked: { assetId: key, url: 'blob:rv/a' } });
    viewer.instances.add({ identity: false, baked: { assetId: 'resolved:project:other.glb', url: 'blob:rv/o' } });
    const loadsBefore = viewer.loaded.length;
    const readyBefore = viewer.sceneReadyCalls;
    const r = ok(await replace(args({ documentId: A.id })));
    expect(r.reloaded).toBe('placements');
    expect(r.placementsRebaked).toBe(1);
    expect(viewer.invalidated).toEqual([key]);
    expect(viewer.loaded.length).toBe(loadsBefore + 1);
    expect(viewer.loaded.at(-1)?.marker).toBe('b-v1');
    expect(viewer.sceneReadyCalls).toBeGreaterThan(readyBefore);
    expect(viewer.emitted.some((e) => e.event === 'document-saved'
      && (e.data as { relPath: string }).relPath === A.path)).toBe(true);
  });
});

// ─── LOP #180: a document switch during the replace ─────────────────────

describe('plan-764 LOP #180 — another document opened while the replace runs', () => {
  it('the file is written, the other document is NOT reloaded and keeps its draft; result document-switched', async () => {
    await store.openDocument(A.id);
    let open!: () => void;
    gate = new Promise((r) => { open = r; });
    const running = replace(args());
    await vi.waitFor(() => expect(fetches.length).toBe(1));

    // The user opens B (which has a draft) while A's bytes are still being fetched.
    h.bodies.set(`draft/${B.id}`, fakeGlb('b-draft'));
    await store.openDocument(B.id);
    expect(store.openDocumentId).toBe(B.id);
    const loadsBefore = viewer.loaded.length;

    open();
    const r = ok(await running);
    expect(r.reloaded).toBe('none');
    expect(r.reloadSkipped).toBe('document-switched');
    expect(r.detail).toMatch(/Open the document to see it/);
    // A's file IS written…
    expect(markerOf(project.files.get(A.path))).toBe('pushed');
    expect(r.revision).toBe(await revOf(A.path));
    // …and B was neither reloaded nor lost its draft.
    expect(viewer.loaded.length).toBe(loadsBefore);
    expect(viewer.loaded.at(-1)?.marker).not.toBe('pushed');
    expect(store.openDocumentId).toBe(B.id);
    expect(markerOf(h.bodies.get(`draft/${B.id}`))).toBe('b-draft');
    expect(store.replaceLockOwner).toBeNull();
    expect(getProblems().some((p) => p.code === REPLACE_PROBLEM_CODE)).toBe(false);
  });

  it('the store alone: a reload under a lock taken on A answers document-switched once B is open', async () => {
    await store.openDocument(A.id);
    const token = await store.tryLockForReplace();
    expect(token).not.toBeNull();
    h.bodies.set(`draft/${B.id}`, fakeGlb('b-draft'));
    await store.openDocument(B.id);
    const loads = viewer.loaded.length;
    expect(await store.reloadOpenDocumentForReplace(token!)).toBe('document-switched');
    expect(viewer.loaded.length).toBe(loads);
    expect(markerOf(h.bodies.get(`draft/${B.id}`))).toBe('b-draft');
    store.unlockReplace(token);
  });

  it('the store alone: the locked document still open → reloaded (unchanged behaviour)', async () => {
    await store.openDocument(A.id);
    const token = await store.tryLockForReplace();
    expect(await store.reloadOpenDocumentForReplace(token!)).toBe('reloaded');
    store.unlockReplace(token);
  });
});

// ─── plan-764: the in-page bytes entry ──────────────────────────────────

describe('plan-764 — in-page bytes instead of a staging URL', () => {
  it('writes the bytes through the same sequence: no fetch, full parse, reload', async () => {
    await store.openDocument(A.id);
    const r = ok(await replace(args({ stagingUrl: undefined, bytes: fakeGlb('in-page') })));
    expect(fetches).toEqual([]);
    expect(markerOf(project.files.get(A.path))).toBe('in-page');
    expect(r.reloaded).toBe('open-document');
    expect(viewer.loaded.at(-1)?.marker).toBe('in-page');
  });

  it('bytes that are no GLB → invalid-glb, nothing written', async () => {
    const r = fail(await replace(args({ stagingUrl: undefined, bytes: new TextEncoder().encode('not a glb at all') })));
    expect(r.reason).toBe('invalid-glb');
    expect(project.writes).toEqual([]);
  });

  it('neither or both sources → refused, nothing written', async () => {
    expect(fail(await replace(args({ stagingUrl: undefined }))).reason).toBe('not-found');
    expect(fail(await replace(args({ bytes: fakeGlb('x') }))).reason).toBe('not-found');
    expect(project.writes).toEqual([]);
    expect(fetches).toEqual([]);
  });

  it('WEB still wins: a dirty open document → local-changes; a stale revision → revision-conflict', async () => {
    await store.openDocument(A.id);
    await store.applyOp(anOp());
    expect(fail(await replace(args({ stagingUrl: undefined, bytes: fakeGlb('x') }))).reason).toBe('local-changes');
    await store.discard();
    expect(fail(await replace(args({
      stagingUrl: undefined, bytes: fakeGlb('x'), expectedRevision: 'f'.repeat(64),
    }))).reason).toBe('revision-conflict');
    expect(markerOf(project.files.get(A.path))).toBe('a-v1');
  });
});

// ─── plan-764: the export context's replaceDocument ─────────────────────

describe('plan-764 — DocumentExportContext.replaceDocument is the replace sequence', () => {
  it('binds the open scene document: writes, reloads, and passes the ReplaceResult through', async () => {
    const { plannerDocumentExportContext } = await import('../src/core/hmi/scene/scene-document-view');
    await store.openDocument(A.id);
    const ctx = plannerDocumentExportContext(store, A.name, () => PROJECT_ID, viewer);
    expect(ctx.replaceDocument).toBeTypeOf('function');
    const r = await ctx.replaceDocument!(fakeGlb('applied'), 'any', { projectId: PROJECT_ID, documentId: A.id });
    expect(r).toMatchObject({ ok: true, reloaded: 'open-document' });
    expect(markerOf(project.files.get(A.path))).toBe('applied');
  });

  it('refuses through the sequence: dirty → local-changes (no override of it exists)', async () => {
    const { plannerDocumentExportContext } = await import('../src/core/hmi/scene/scene-document-view');
    await store.openDocument(A.id);
    await store.applyOp(anOp());
    const ctx = plannerDocumentExportContext(store, A.name, () => PROJECT_ID, viewer);
    const r = await ctx.replaceDocument!(fakeGlb('applied'), 'any', { projectId: PROJECT_ID, documentId: A.id });
    expect(r).toMatchObject({ ok: false, reason: 'local-changes' });
    expect(markerOf(project.files.get(A.path))).toBe('a-v1');
  });
});
