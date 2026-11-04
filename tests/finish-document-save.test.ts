// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-777 §9.2 — the ONE post-save step (`rv-finish-document-save.ts`).
 *
 * Every save — editor, planner (in place, save as, settings into a model) and
 * MCP replace — ends in `finishDocumentSave`: thumbnail pointer (awaited) →
 * `document-saved` → background rescan. This file pins the order, the guards,
 * that no step can take the next one down, the call placements (P8), the
 * single-flighted rescan (P7) and the MCP replace's early announce.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  log: [] as string[],
  /** What the mocked writer does: return a pointer, return null, or throw. */
  writer: 'ok' as 'ok' | 'throw',
  /** A row the mocked writer adds to the project while it "renders" (null id path). */
  rowAppearsDuringWrite: null as { id: string; path: string; name: string } | null,
  bodies: new Map<string, string>(),
}));

// The save-time thumbnail writer, recording into the shared log. The real one is
// covered by thumbnail-document-ops / thumbnail-write.
vi.mock('../src/core/thumbnails/rv-thumbnail-write', () => ({
  THUMBNAIL_SIZE: 512,
  SCENE_READY_WAIT_MS: 5000,
  isThumbnailExcludedNode: () => false,
  documentContentRoots: () => [],
  renderThumbnailImage: async () => null,
  writeDocumentThumbnail: async (ctx: {
    store: { getProject(): { documents?: unknown[] } | null; setDocumentThumbnail(id: string, p: string | null): Promise<void> };
    documentId?: string | null; relPath?: string | null;
  }) => {
    h.log.push(`thumbnail:${ctx.documentId ?? 'null'}:${ctx.relPath ?? ''}`);
    if (h.writer === 'throw') throw new Error('render exploded');
    if (h.rowAppearsDuringWrite) {
      ctx.store.getProject()?.documents?.push(h.rowAppearsDuringWrite);
    }
    const id = ctx.documentId ?? h.rowAppearsDuringWrite?.id ?? null;
    if (id) await ctx.store.setDocumentThumbnail(id, `.thumbnails/${id}.webp`);
    return id ? `.thumbnails/${id}.webp` : null;
  },
  dropDocumentThumbnail: async (ctx: { documentId: string }) => {
    h.log.push(`drop:${ctx.documentId}`);
  },
}));

vi.mock('../src/core/hmi/scene/rv-scene-glb-io', () => ({
  readSceneGlbBody: async (slot: string) =>
    (h.bodies.has(slot)
      ? { glb: new Uint8Array([0x67, 0x6c, 0x54, 0x46]), revision: h.bodies.get(slot)!, target: 'opfs' }
      : null),
  writeSceneGlbBody: async (write: { sceneId: string }) => {
    h.bodies.set(write.sceneId, 'rev');
    return { revision: 'rev', target: 'opfs' };
  },
  dropSceneGlbBody: async (slot: string) => { h.bodies.delete(slot); },
  sceneGlbBodyRevision: async (sceneId: string) => h.bodies.get(sceneId) ?? null,
}));

vi.mock('../src/core/hmi/scene/rv-scene-glb-bake', () => ({
  bakeIntoGlb: async () => ({ glb: new Uint8Array([1, 2, 3, 4]), warnings: [], writtenReferences: [] }),
  makeRegistryBakeResolver: () => ({}),
  bakeRequiresFullPath: () => false,
}));

import {
  announceDocumentSaved,
  finishDocumentSave,
} from '../src/core/editor/rv-finish-document-save';
import { ProjectStore, getProjectStore } from '../src/core/project/project-store';
import { SceneStore } from '../src/core/hmi/scene/scene-store';
import { projectAssetUrl } from '../src/core/project/rv-project-asset-source';
import {
  replaceDocument,
  resetReplaceOperationsForTests,
  type ReplaceDeps,
  type ReplaceDocumentHandle,
} from '../src/plugins/mcp-bridge/rv-document-replace';
import type { ProjectBackend } from '../src/core/project/backends/project-backend';
import type { RvDocumentEntry, RvProject } from '../src/core/project/rv-project-types';
import type { RvScene } from '../src/core/hmi/scene/rv-scene-types';
import type { RVViewer } from '../src/core/rv-viewer';

const PATH = 'models/Belt.glb';

beforeEach(() => {
  h.log.length = 0;
  h.writer = 'ok';
  h.rowAppearsDuringWrite = null;
  h.bodies.clear();
  localStorage.clear();
});

// ─── Fakes for the unit half ────────────────────────────────────────────

function fakeViewer(opts: { renderer?: boolean; throwOnEmit?: boolean } = {}) {
  return {
    renderer: opts.renderer === false ? undefined : {},
    scene: {},
    emit(event: string, payload: { documentId: string; relPath: string }) {
      h.log.push(`emit:${event}:${payload.documentId}:${payload.relPath}`);
      if (opts.throwOnEmit) throw new Error('listener exploded');
    },
  };
}

function fakeStore(opts: {
  rows?: RvDocumentEntry[];
  rescan?: 'ok' | 'reject' | 'pending' | 'absent';
} = {}) {
  const project = { schemaVersion: 3, id: 'p', name: 'P', documents: opts.rows ?? [] } as RvProject;
  const store: Record<string, unknown> = {
    getProject: () => project,
    setDocumentThumbnail: async (id: string, pointer: string | null) => {
      h.log.push(`pointer:${id}:${pointer}`);
    },
  };
  if (opts.rescan !== 'absent') {
    store.rescanDocuments = () => {
      h.log.push('rescan');
      if (opts.rescan === 'reject') return Promise.reject(new Error('listing failed'));
      if (opts.rescan === 'pending') return new Promise<void>(() => {});
      return Promise.resolve();
    };
  }
  return store as never;
}

const writable = { writable: true } as unknown as ProjectBackend;
const readOnly = { writable: false } as unknown as ProjectBackend;

// ─── 1. The step itself ─────────────────────────────────────────────────

describe('finishDocumentSave — order and guards (plan-777 F5)', () => {
  it('pointer → announce → rescan, and the rescan is NOT awaited', async () => {
    const result = await finishDocumentSave({
      viewer: fakeViewer(),
      store: fakeStore({ rescan: 'pending' }),
      backend: writable,
      documentId: 'doc_a',
      relPath: 'a.glb',
    });
    // A rescan that never settles did not hold the save: we got here.
    expect(result.thumbnail).toBe('.thumbnails/doc_a.webp');
    expect(h.log).toEqual([
      'thumbnail:doc_a:a.glb',
      'pointer:doc_a:.thumbnails/doc_a.webp',
      'emit:document-saved:doc_a:a.glb',
      'rescan',
    ]);
  });

  it('read-only backend → no render, no pointer change; announce and rescan still happen', async () => {
    await finishDocumentSave({
      viewer: fakeViewer(), store: fakeStore(), backend: readOnly, documentId: 'doc_a', relPath: 'a.glb',
    });
    expect(h.log).toEqual(['emit:document-saved:doc_a:a.glb', 'rescan']);
  });

  it('no renderer → no render and the pointer is NOT dropped; announce and rescan still happen', async () => {
    await finishDocumentSave({
      viewer: fakeViewer({ renderer: false }), store: fakeStore(), backend: writable,
      documentId: 'doc_a', relPath: 'a.glb',
    });
    expect(h.log).toEqual(['emit:document-saved:doc_a:a.glb', 'rescan']);
  });

  it('a render failure never skips the announce or the rescan', async () => {
    h.writer = 'throw';
    const result = await finishDocumentSave({
      viewer: fakeViewer(), store: fakeStore(), backend: writable, documentId: 'doc_a', relPath: 'a.glb',
    });
    expect(result.thumbnail).toBeNull();
    expect(h.log).toEqual(['thumbnail:doc_a:a.glb', 'emit:document-saved:doc_a:a.glb', 'rescan']);
  });

  it('a store without rescanDocuments, or a rejecting rescan, never throws — the announce happened', async () => {
    await expect(finishDocumentSave({
      viewer: fakeViewer(), store: fakeStore({ rescan: 'absent' }), backend: writable,
      documentId: 'doc_a', relPath: 'a.glb',
    })).resolves.toBeDefined();
    expect(h.log).toContain('emit:document-saved:doc_a:a.glb');

    h.log.length = 0;
    await expect(finishDocumentSave({
      viewer: fakeViewer(), store: fakeStore({ rescan: 'reject' }), backend: writable,
      documentId: 'doc_a', relPath: 'a.glb',
    })).resolves.toBeDefined();
    expect(h.log).toEqual([
      'thumbnail:doc_a:a.glb', 'pointer:doc_a:.thumbnails/doc_a.webp',
      'emit:document-saved:doc_a:a.glb', 'rescan',
    ]);
  });

  it('a throwing document-saved listener never skips the rescan', async () => {
    await finishDocumentSave({
      viewer: fakeViewer({ throwOnEmit: true }), store: fakeStore(), backend: writable,
      documentId: 'doc_a', relPath: 'a.glb',
    });
    expect(h.log.at(-1)).toBe('rescan');
  });

  it('render:false drops the pointer instead of rendering; announce:false skips the event only', async () => {
    await finishDocumentSave({
      viewer: fakeViewer(), store: fakeStore(), backend: writable,
      documentId: 'doc_a', relPath: 'a.glb', render: false, announce: false,
    });
    expect(h.log).toEqual(['drop:doc_a', 'rescan']);
  });

  it('documentId:null → the id is resolved by path AFTER the writer ran, and announced with it', async () => {
    h.rowAppearsDuringWrite = { id: 'doc_new', path: 'Belt_settings.glb', name: 'Belt_settings' };
    await finishDocumentSave({
      viewer: fakeViewer(), store: fakeStore(), backend: writable, documentId: null, relPath: 'Belt_settings.glb',
    });
    expect(h.log).toContain('emit:document-saved:doc_new:Belt_settings.glb');
  });

  it('documentId:null with no row → no announce, no throw, the rescan still runs', async () => {
    await finishDocumentSave({
      viewer: fakeViewer(), store: fakeStore(), backend: writable, documentId: null, relPath: 'nowhere.glb',
    });
    expect(h.log.some((l) => l.startsWith('emit:'))).toBe(false);
    expect(h.log.at(-1)).toBe('rescan');
  });

  it('announceDocumentSaved tolerates a missing viewer or emit', () => {
    expect(() => announceDocumentSaved(null, { documentId: 'x', relPath: '' })).not.toThrow();
    expect(() => announceDocumentSaved({}, { documentId: 'x', relPath: '' })).not.toThrow();
  });
});

// ─── 2. rescanDocuments: single flight with a dirty re-run (P7) ─────────

describe('ProjectStore.rescanDocuments — single flight + dirty re-run (plan-777 P7)', () => {
  function storeWithListing() {
    const store = new ProjectStore();
    const listings: Array<(rows: RvDocumentEntry[]) => void> = [];
    let running = 0;
    let maxRunning = 0;
    const backend = {
      kind: 'folder', id: 'fake', writable: true, isActive: true,
      listDocuments: () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        return new Promise<RvDocumentEntry[]>((resolve) => {
          listings.push((rows) => { running--; resolve(rows); });
        });
      },
    };
    const privates = store as unknown as {
      _backend: unknown;
      _userDocuments: RvDocumentEntry[];
      _scanSceneExtras(b: unknown, d: RvDocumentEntry[]): Promise<RvDocumentEntry[]>;
      _adoptQuietly(): Promise<void>;
    };
    privates._backend = backend;
    privates._scanSceneExtras = async (_b, d) => d;
    privates._adoptQuietly = async () => {};
    return { store, privates, listings, maxRunning: () => maxRunning };
  }
  const row = (id: string): RvDocumentEntry => ({ id, path: `${id}.glb`, name: id });
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));

  it('a call mid-scan waits for the FOLLOW-UP scan and finds the row that scan listed', async () => {
    const { store, privates, listings, maxRunning } = storeWithListing();
    const first = store.rescanDocuments();
    await tick();
    expect(listings).toHaveLength(1);

    // Two saves land while the first listing runs: one follow-up, joined by both.
    const second = store.rescanDocuments();
    const third = store.rescanDocuments();
    expect(third).toBe(second);
    expect(listings).toHaveLength(1);

    let secondDone = false;
    void second.then(() => { secondDone = true; });
    listings[0]!([row('a')]);
    await first;
    // The running scan listed before the caller's file existed — not the answer.
    expect(secondDone).toBe(false);
    await tick();
    expect(listings).toHaveLength(2);
    listings[1]!([row('a'), row('b')]);
    await second;
    expect(privates._userDocuments.map((d) => d.id)).toEqual(['a', 'b']);
    expect(maxRunning()).toBe(1);
  });

  it('a call after the follow-up started queues the NEXT one — at most one running + one queued', async () => {
    const { store, listings, maxRunning } = storeWithListing();
    const first = store.rescanDocuments();
    await tick();
    const followUp = store.rescanDocuments();
    listings[0]!([]);
    await first;
    await tick();
    expect(listings).toHaveLength(2); // the follow-up is running now
    const next = store.rescanDocuments();
    expect(next).not.toBe(followUp);
    listings[1]!([]);
    await followUp;
    await tick();
    expect(listings).toHaveLength(3);
    listings[2]!([]);
    await next;
    expect(maxRunning()).toBe(1);
  });

  it('two quick saves leave one consistent row set (the newer listing wins)', async () => {
    const { store, privates, listings } = storeWithListing();
    const a = store.rescanDocuments();
    await tick();
    const b = store.rescanDocuments();
    listings[0]!([row('old')]);
    await a;
    await tick();
    listings[1]!([row('old'), row('new')]);
    await b;
    expect(privates._userDocuments.map((d) => d.id)).toEqual(['old', 'new']);
  });

  it('a failing scan does not wedge the single flight: the follow-up still lists, a later call starts fresh', async () => {
    const { store, privates, listings, maxRunning } = storeWithListing();
    let scans = 0;
    privates._scanSceneExtras = async (_b, d) => {
      scans++;
      if (scans === 1) throw new Error('scene extras exploded');
      return d;
    };
    const first = store.rescanDocuments();
    const firstSettled = first.then(() => 'resolved', () => 'rejected');
    await tick();
    const second = store.rescanDocuments();
    listings[0]!([row('a')]);
    expect(await firstSettled).toBe('rejected');
    await tick();
    expect(listings).toHaveLength(2); // the follow-up runs despite the failure
    listings[1]!([row('a'), row('b')]);
    await second;
    expect(privates._userDocuments.map((d) => d.id)).toEqual(['a', 'b']);

    // Flags are clear: a new call starts its own scan, it does not hang on a stale one.
    const third = store.rescanDocuments();
    await tick();
    expect(listings).toHaveLength(3);
    listings[2]!([row('c')]);
    await third;
    expect(privates._userDocuments.map((d) => d.id)).toEqual(['c']);
    expect(maxRunning()).toBe(1);
  });

  it('a project switch during the listing drops the stale result (plan-777 review)', async () => {
    const { store, privates, listings } = storeWithListing();
    let adopted = 0;
    privates._adoptQuietly = async () => { adopted++; };
    const scan = store.rescanDocuments();
    await tick();
    expect(listings).toHaveLength(1);

    // The new project is in place before the old listing returns.
    privates._backend = { kind: 'folder', id: 'other', writable: true, isActive: true, listDocuments: async () => [] };
    privates._userDocuments = [row('new')];
    const snapshotBefore = store.getSnapshot();
    listings[0]!([row('old')]);
    await scan;

    expect(privates._userDocuments.map((d) => d.id)).toEqual(['new']);
    expect(adopted).toBe(0);
    expect(store.getSnapshot()).toBe(snapshotBefore);
    expect(store.getSnapshot().documents.some((d) => d.id === 'old')).toBe(false);
  });
});

// ─── 3. The planner save (P8) ───────────────────────────────────────────

/** A minimal self-contained binary GLB. */
function glb(doc: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(doc));
  const jsonPad = (json.byteLength + 3) & ~3;
  const total = 12 + 8 + jsonPad;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonPad, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.fill(0x20, 20, 20 + jsonPad);
  out.set(json, 20);
  return out;
}

const DOC_GLB = glb({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'Machine' }] });

function plannerViewer() {
  const handlers: Array<(p: { documentId: string; relPath: string }) => void> = [];
  const v = {
    availableModels: [] as unknown[],
    availablePublishedScenes: [],
    currentScene: null as RvScene | null,
    currentModelUrl: null as string | null,
    currentModelRoot: { name: 'root', children: [] as unknown[] },
    registry: {
      getGltfNodeNames: () => [], getGltfNodeIndex: () => -1,
      getPathForNode: () => null, getNode: () => null,
    },
    lastLoadResult: null,
    modes: { has: () => true, setMode: () => {} },
    getPlugin: () => undefined,
    loadScene: async (s: RvScene) => { v.currentScene = s; },
    loadEmptyScene: async () => {},
    /** A cache-only subscriber, like the planner's: counts, never saves. */
    onSaved: handlers,
    emit(event: string, payload: { documentId: string; relPath: string }) {
      if (event !== 'document-saved') return;
      const url = new URL(window.location.href).searchParams.get('doc');
      h.log.push(`announce:${payload.documentId}:${payload.relPath}:scene=${v.currentScene?.id ?? 'none'}:url=${url}`);
      for (const fn of handlers) fn(payload);
    },
  };
  return v;
}

function plannerBackend() {
  const writes: string[] = [];
  const backend = {
    kind: 'browser', id: 'test', writable: true, isActive: true,
    listModels: async () => [],
    listDocuments: async () => [],
    readDocument: async (ref: string | { path: string }) => {
      const relPath = typeof ref === 'string' ? ref : ref.path;
      return relPath === PATH
        ? { bytes: new Uint8Array(DOC_GLB), meta: { id: '', name: PATH, path: PATH }, revision: 'rev' }
        : null;
    },
    readDocumentUrl: async () => null,
    writeDocument: async (ref: string | { path: string }) => {
      writes.push(typeof ref === 'string' ? ref : ref.path);
      return { revision: 'rev' };
    },
  } as unknown as ProjectBackend;
  return { backend, writes };
}

function inject(backend: ProjectBackend | null, project: RvProject | null): void {
  const store = getProjectStore() as unknown as { _backend: ProjectBackend | null; _project: RvProject | null };
  store._backend = backend;
  store._project = project;
}

async function openBelt(store: SceneStore): Promise<void> {
  await store.openBuiltin(projectAssetUrl(PATH), 'Belt');
  store.adoptProjectedBaseBytes(new ArrayBuffer(8));
}

async function edit(store: SceneStore, value: number): Promise<void> {
  await store.applyOp({
    id: `op_${value}`, ts: Date.now(), schemaV: 1, kind: 'setField',
    nodePath: 'Conv1', componentType: 'Drive', fieldName: 'TargetSpeed', value, prev: 0,
  } as never);
}

describe('planner save — one announce at the P8 point (plan-777 P5/P8)', () => {
  function setup() {
    const { backend, writes } = plannerBackend();
    inject(backend, { schemaVersion: 3, id: 'prj_t', name: 'T', documents: [{ id: 'doc_belt', path: PATH, name: 'Belt' }] } as RvProject);
    const rescan = vi.spyOn(getProjectStore(), 'rescanDocuments').mockImplementation(async () => {
      h.log.push('rescan');
    });
    const viewer = plannerViewer();
    const store = new SceneStore(viewer as unknown as RVViewer);
    return { store, viewer, writes, rescan };
  }

  it('in place: announced once, after current scene + URL, then rescan, then _notify', async () => {
    const { store, viewer, writes, rescan } = setup();
    let handled = 0;
    viewer.onSaved.push(() => { handled++; });
    await openBelt(store);
    await edit(store, 100);
    h.log.length = 0;
    const unsub = store.subscribe(() => { h.log.push('notify'); });

    expect(await store.save()).toBe('saved');
    unsub();

    const announces = h.log.filter((l) => l.startsWith('announce:'));
    expect(announces).toEqual([`announce:doc_belt:${PATH}:scene=doc_belt:url=doc_belt`]);
    const at = h.log.indexOf(announces[0]!);
    expect(h.log[at + 1]).toBe('rescan');
    expect(h.log.lastIndexOf('notify')).toBeGreaterThan(at);
    expect(rescan).toHaveBeenCalledTimes(1);
    // The cache-only subscriber ran once and caused no follow-up save (R-03).
    expect(handled).toBe(1);
    expect(writes).toEqual([PATH]);
    rescan.mockRestore();
  });

  it('save as: announced with the COPY\'s identity, after the URL moved to it', async () => {
    const { store, rescan } = setup();
    await openBelt(store);
    await edit(store, 100);
    h.log.length = 0;

    const id = await store.saveAs('Belt copy');

    const announces = h.log.filter((l) => l.startsWith('announce:'));
    expect(announces).toHaveLength(1);
    expect(announces[0]).toMatch(new RegExp(`^announce:${id}:[^:]*Belt copy[^:]*\\.glb:scene=${id}:url=${id}$`));
    expect(rescan).toHaveBeenCalledTimes(1);
    rescan.mockRestore();
  });

  it('"New" without bytes is not a save: no announce, no rescan from the post-save step', async () => {
    const { store, rescan } = setup();
    h.log.length = 0;
    await store.createEmpty('Fresh');
    expect(h.log.filter((l) => l.startsWith('announce:'))).toEqual([]);
    expect(rescan).not.toHaveBeenCalled();
    rescan.mockRestore();
  });

  it('a refused write announces nothing', async () => {
    const { store, rescan } = setup();
    await openBelt(store);
    await edit(store, 100);
    const backend = getProjectStore().getBackend() as unknown as { writeDocument: () => Promise<never> };
    backend.writeDocument = async () => { throw new Error('disk full'); };
    h.log.length = 0;
    await store.save().catch(() => 'threw');
    expect(h.log.filter((l) => l.startsWith('announce:'))).toEqual([]);
    expect(rescan).not.toHaveBeenCalled();
    rescan.mockRestore();
  });
});

// ─── 4. Call placements that are cheaper to pin by source (P8) ──────────

const SOURCES = import.meta.glob(
  ['../src/core/editor/rv-save-document.ts', '../src/core/hmi/scene/scene-store.ts'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;
const sourceOf = (suffix: string): string =>
  Object.entries(SOURCES).find(([p]) => p.endsWith(suffix))![1];

describe('call placements (plan-777 P8)', () => {
  it('editor save: one finishDocumentSave, after markSaved — identity final', () => {
    const src = sourceOf('rv-save-document.ts');
    expect(src.split('await finishDocumentSave(').length - 1).toBe(1);
    const marked = src.indexOf('doc.document.markSaved({ floor: floorAtBakeStart });');
    expect(marked).toBeGreaterThan(0);
    expect(src.indexOf('await finishDocumentSave(')).toBeGreaterThan(marked);
  });

  it('editor bound/slot branch runs no post-save step of its own (the planner tail does)', () => {
    const src = sourceOf('rv-save-document.ts');
    const start = src.indexOf("if (doc.base.kind === 'document' && (!doc.base.path || doc.isBound)) {");
    const end = src.indexOf('§2.10, the second layer', start);
    expect(start).toBeGreaterThan(0);
    const branch = src.slice(start, end);
    expect(branch).toContain('savePlannerDocument(store, opts)');
    expect(branch).not.toContain('finishDocumentSave(');
    expect(branch).not.toMatch(/emit\??\.?\(\s*['"]document-saved/);
  });

  it('planner: _createDocument (shared with "New") runs no post-save step', () => {
    const src = sourceOf('scene-store.ts');
    const start = src.indexOf('  private async _createDocument(');
    const end = src.indexOf('  private _finishSave(', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(src.slice(start, end)).not.toMatch(/_finishSave\(|finishDocumentSave\(/);
  });

  it('planner: settings-into-model finishes with documentId null', () => {
    expect(sourceOf('scene-store.ts')).toContain('await this._finishSave(null, relPath);');
  });
});

// ─── 5. MCP replace: early announce, the rest at the end ────────────────

describe('MCP replace — announce before the reload, thumbnail + rescan at the end (P8)', () => {
  function deps(opts: { open: boolean }): ReplaceDeps {
    const handle: ReplaceDocumentHandle = {
      isDirty: () => false,
      lock: async () => ({}) as never,
      unlock: () => {},
      reload: async () => { h.log.push('reload'); return 'reloaded'; },
    };
    const backend = {
      writable: true,
      readDocument: async () => ({ bytes: new Uint8Array([1]), meta: { id: 'doc_a', name: 'A', path: 'a.glb' }, revision: 'r0' }),
      writeDocument: async () => ({ revision: 'r1' }),
    } as unknown as ProjectBackend;
    return {
      sessionId: () => 's',
      activeProjectId: () => 'prj',
      backend: () => backend,
      findDocument: () => ({ id: 'doc_a', path: 'a.glb', name: 'A' }),
      pageOrigin: () => 'http://localhost',
      fetchStaged: async () => new Uint8Array([2]),
      validateGlb: async () => {},
      hasDraft: async () => false,
      editorHolds: () => false,
      openTarget: () => (opts.open ? handle : null),
      openHost: () => null,
      // Production announces in here (createViewerReplaceDeps) — early.
      invalidate: async () => { h.log.push('announce'); return 0; },
      placementsMissing: () => 0,
      whenSettled: async () => {},
      reportFailure: () => {},
      clearFailure: () => {},
      finishSave: async (_doc, loaded) => { h.log.push(`finish:${loaded ? 'render' : 'drop'}`); },
    };
  }

  beforeEach(() => resetReplaceOperationsForTests());

  it('open document: announce → reload → finish (render)', async () => {
    const r = await replaceDocument(
      { operationId: 'op1', projectId: 'prj', documentId: 'doc_a', bytes: new Uint8Array([2]), expectedRevision: 'any' },
      deps({ open: true }),
    );
    expect(r.ok).toBe(true);
    expect(h.log).toEqual(['announce', 'reload', 'finish:render']);
  });

  it('not loaded: announce, then finish with the pointer dropped', async () => {
    const r = await replaceDocument(
      { operationId: 'op2', projectId: 'prj', documentId: 'doc_a', bytes: new Uint8Array([2]), expectedRevision: 'any' },
      deps({ open: false }),
    );
    expect(r.ok).toBe(true);
    expect(h.log).toEqual(['announce', 'finish:drop']);
  });
});
