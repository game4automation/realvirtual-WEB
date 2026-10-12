// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * `bakeSceneToGlb` refuses, with a reason, before it writes anything.
 *
 * The refusals matter more than the happy path here: a bake that half-succeeds
 * would leave a GLB in the project that looks like the scene and is not, and a
 * bake that fails without saying why leaves the user with nowhere to go. Each
 * case below asserts BOTH the reason and that no file was written.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SceneStore } from '../src/core/hmi/scene/scene-store';
import type { RvScene, SceneBase } from '../src/core/hmi/scene/rv-scene-types';
import { freshOpId } from '../src/core/hmi/scene/rv-scene-edits';
import type { RVViewer } from '../src/core/rv-viewer';
import { getProjectStore } from '../src/core/project/project-store';
import type { ProjectBackend } from '../src/core/project/backends/project-backend';
import type { RvProject } from '../src/core/project/rv-project-types';

const builtinDemo: SceneBase = { kind: 'builtin', url: '/models/Demo.glb', label: 'Demo' };

function makeViewer() {
  const v = {
    loadScenes: [] as RvScene[],
    availableModels: [{ url: '/models/Demo.glb', label: 'Demo' }],
    currentScene: null as RvScene | null,
    currentModelUrl: null as string | null,
    registry: {
      getGltfNodeIndex: () => 0,
      // Empty = "no names captured", which skips the source-identity check.
      // The check itself is covered in rv-scene-settings-into-model.node.test.ts.
      getGltfNodeNames: () => [],
      getNode: () => undefined,
      // Every component instance at a path. Empty is the honest answer for a
      // mock scene that has no live instances — and it has to be ANSWERED:
      // `reapplySchemaForComponent` calls it for every setField op.
      getComponentsAt: () => [],
    },
    loadScene: vi.fn(async (s: RvScene) => {
      v.loadScenes.push(s);
      v.currentScene = s;
      v.currentModelUrl = s.base.kind === 'builtin' ? s.base.url : 'empty:';
    }),
    loadEmptyScene: vi.fn(async () => {}),
    getPlugin: () => undefined,
  };
  return v;
}

/** A writable backend that records every write, so "nothing written" is testable. */
function fakeBackend(overrides: Partial<ProjectBackend> = {}): ProjectBackend & { writes: string[] } {
  const writes: string[] = [];
  return {
    kind: 'browser', id: 'test', writable: true, isActive: true, writes,
    listDocuments: async () => [],
    writeDocument: async (ref: string | { path: string }) => {
      writes.push(typeof ref === 'string' ? ref : ref.path);
      return { revision: 'rev' };
    },
    // The adoption re-reads what was just written (plan-709 §2.5). Serving the
    // same fixture back keeps the happy path actually reachable in these tests.
    //
    // Only for a path this backend actually wrote — `null` is the contract's
    // "no such document" and what every sibling fake returns. Answering with
    // bytes for EVERY path tells `planDocument` that every candidate name is
    // taken, and its unbounded rename probe then spins forever on resolved
    // promises: the page never yields to the timer queue, so even a per-test
    // timeout cannot fire and the whole browser suite wedges (2026-09-09).
    readDocument: async (ref: string | { path: string }) => {
      const path = typeof ref === 'string' ? ref : ref.path;
      if (!writes.includes(path)) return null;
      return { bytes: demoGlbBytes(), meta: { id: '', name: path, path }, revision: 'rev' };
    },
    ...overrides,
  } as unknown as ProjectBackend & { writes: string[] };
}

/**
 * Install the backend AND the project that owns it — both halves, always.
 *
 * `commitDocuments` writes its rows into the PROJECT and returns early when
 * there is none, so a writable backend with no project mints documents whose
 * rows go nowhere: `newEmpty()` then throws on the document it just created.
 * That pairing is not a state the product can reach.
 */
function setBackend(
  backend: ProjectBackend | null,
  documents: Array<{ id: string; name: string; path: string }> = [],
): void {
  const store = getProjectStore() as unknown as {
    _backend: ProjectBackend | null;
    _project: RvProject | null;
  };
  store._backend = backend;
  store._project = backend === null ? null : ({
    schemaVersion: 3, id: 'prj_preflight', name: 'Pre-flight fixture', documents,
  } as unknown as RvProject);
}

const opBase = () => ({ id: freshOpId(), ts: Date.now(), schemaV: 1 as const });

/** A property override — the one op kind that can actually be written in. */
const setSpeedOp = (value = 250) => ({
  ...opBase(), kind: 'setField' as const,
  nodePath: 'Machine', componentType: 'Drive', fieldName: 'TargetSpeed', value, prev: 100,
});

/** A minimal valid single-node GLB, served to the store's `fetch`. */
function demoGlbBytes(): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'Machine' }],
  }));
  const padded = (json.byteLength + 3) & ~3;
  const out = new Uint8Array(20 + padded);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.byteLength, true);
  view.setUint32(12, padded, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.fill(0x20, 20, 20 + padded);
  out.set(json, 20);
  return out;
}

/** Stub `fetch` for the source GLB, optionally stalling until released. */
function stubGlbFetch(): { release: () => void; started: Promise<void>; restore: () => void } {
  const original = globalThis.fetch;
  let releaseGate: () => void = () => {};
  const gate = new Promise<void>((r) => { releaseGate = r; });
  let markStarted: () => void = () => {};
  const started = new Promise<void>((r) => { markStarted = r; });

  globalThis.fetch = (async () => {
    markStarted();
    await gate;
    return { ok: true, status: 200, arrayBuffer: async () => demoGlbBytes().buffer } as unknown as Response;
  }) as typeof fetch;

  return { release: releaseGate, started, restore: () => { globalThis.fetch = original; } };
}

describe('saveSettingsIntoModel pre-flight', () => {
  let store: SceneStore;
  let viewer: ReturnType<typeof makeViewer>;

  beforeEach(async () => {
    localStorage.clear();
    viewer = makeViewer();
    store = new SceneStore(viewer as unknown as RVViewer);
    await store.openBuiltin(builtinDemo.url, 'Demo');
  });

  it('reports that a scene without overrides has nothing to bake', async () => {
    const backend = fakeBackend();
    setBackend(backend);
    expect(await store.saveSettingsIntoModel('Demo')).toEqual({ kind: 'nothing-to-save' });
    expect(backend.writes).toEqual([]);
  });

  it('refuses a scene with planner placements and names what is in the way', async () => {
    const backend = fakeBackend();
    setBackend(backend);
    await store.applyOp({
      ...opBase(), kind: 'addPlacement',
      placement: {
        id: 'p1', catalogId: 'c1', glbUrl: '/lib/Conveyor.glb', label: 'Conveyor',
        position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
      },
    });

    const outcome = await store.saveSettingsIntoModel('Demo');
    expect(outcome.kind).toBe('structural-ops');
    if (outcome.kind !== 'structural-ops') throw new Error('unreachable');
    expect(outcome.details).toContain('1 planner placement');
    // Refused BEFORE the backend was touched — the ordering is the point.
    expect(backend.writes).toEqual([]);
  });

  it('explains that a read-only bundled project cannot be written to', async () => {
    setBackend(fakeBackend({ kind: 'bundled', writable: false }));
    await store.applyOp(setSpeedOp());

    const outcome = await store.saveSettingsIntoModel('Demo');
    expect(outcome.kind).toBe('no-writable-project');
    if (outcome.kind !== 'no-writable-project') throw new Error('unreachable');
    expect(outcome.reason).toMatch(/ships with the application/);
  });

  it('says so when no project is open at all', async () => {
    setBackend(null);
    await store.applyOp(setSpeedOp());
    expect(await store.saveSettingsIntoModel('Demo')).toEqual({
      kind: 'no-writable-project', reason: 'No project is open.',
    });
  });

  it('refuses an empty scene, which has no model file to write into', async () => {
    // Read-only on purpose. Since plan-716 F5 "New" MINTS a document wherever
    // it can, so a writable project leaves a builtin base with a real file
    // behind it. An empty base — the thing this test is about — is what
    // `newEmpty()` falls back to when there is nowhere to put a document.
    setBackend(fakeBackend({ writable: false }));
    await store.newEmpty();
    expect(await store.saveSettingsIntoModel('Untitled')).toEqual({ kind: 'no-model-base' });
  });
});

describe('saveSettingsIntoModel is transactional', () => {
  let store: SceneStore;
  let viewer: ReturnType<typeof makeViewer>;

  beforeEach(async () => {
    localStorage.clear();
    viewer = makeViewer();
    store = new SceneStore(viewer as unknown as RVViewer);
    await store.openBuiltin(builtinDemo.url, 'Demo');
  });

  it('does not let an edit land mid-write and then erase it', async () => {
    // The whole write runs inside the op queue. If it only drained the queue up
    // front, this op would apply to the live scene during the fetch and then be
    // wiped by the empty op log the adoption installs.
    const backend = fakeBackend();
    setBackend(backend);
    await store.applyOp(setSpeedOp(250));

    const glbFetch = stubGlbFetch();
    try {
      const writing = store.saveSettingsIntoModel('Demo');
      await glbFetch.started;

      let opApplied = false;
      const lateOp = store.applyOp(setSpeedOp(999)).then(() => { opApplied = true; });
      // The op must still be queued behind the write, not applied during it.
      await Promise.resolve();
      expect(opApplied).toBe(false);

      glbFetch.release();
      await writing;
      await lateOp;
    } finally {
      glbFetch.restore();
    }
  });

  it('abandons adoption when the scene was switched during the write', async () => {
    const backend = fakeBackend();
    setBackend(backend);
    await store.applyOp(setSpeedOp());

    const glbFetch = stubGlbFetch();
    try {
      const writing = store.saveSettingsIntoModel('Demo');
      await glbFetch.started;
      // Scene loads bypass the op queue, so this really can happen.
      await store.newEmpty();
      glbFetch.release();

      const outcome = await writing;
      expect(outcome.kind).toBe('scene-changed');
      // The file is complete and stays; only the adoption was skipped.
      // `newEmpty()` mints a document of its own (plan-716 F5) and so writes
      // too. The claim here is about the BAKED file: written once, left alone.
      expect(backend.writes.filter(p => p === 'models/Demo.glb'))
        .toEqual(['models/Demo.glb']);
    } finally {
      glbFetch.restore();
    }
  });

  it('removes the written file when a later step fails', async () => {
    const deleted: string[] = [];
    const backend = fakeBackend({
      deleteDocument: async (relPath: string) => { deleted.push(relPath); },
    } as Partial<ProjectBackend>);
    setBackend(backend);
    // The written file cannot be resolved back → failure AFTER writeDocument
    // succeeded. Since plan-709 §2.5 the adoption re-resolves through
    // `resolveAssetSource` (bytes, or a URL with an owner), not `resolveAssetUrl`.
    (getProjectStore() as unknown as { resolveAssetSource: (p: string) => Promise<null> })
      .resolveAssetSource = async () => null;
    await store.applyOp(setSpeedOp());

    const glbFetch = stubGlbFetch();
    glbFetch.release();
    try {
      const outcome = await store.saveSettingsIntoModel('Demo');
      expect(outcome.kind).toBe('error');
      // An orphan in models/ looks exactly like a finished delivery.
      expect(deleted).toEqual(['models/Demo.glb']);
    } finally {
      glbFetch.restore();
    }
  });

  it('reports the deduplicated filename, not the requested one', async () => {
    const backend = fakeBackend();
    // The name taken lives in the PROJECT, not in a backend listing of its own
    // (plan-744 §8): `uniqueModelFileName` reads the store's snapshot, so a
    // bake no longer pays for a full directory walk to answer a filename
    // question about a folder the store has already enumerated.
    setBackend(backend, [{ id: 'doc_demo', name: 'Demo', path: 'models/Demo.glb' }]);
    (getProjectStore() as unknown as {
      resolveAssetSource: (p: string) => Promise<{ kind: 'bytes'; bytes: ArrayBuffer }>;
    }).resolveAssetSource = async () => ({
      kind: 'bytes', bytes: demoGlbBytes().buffer as ArrayBuffer,
    });
    await store.applyOp(setSpeedOp());

    const glbFetch = stubGlbFetch();
    glbFetch.release();
    try {
      const outcome = await store.saveSettingsIntoModel('Demo');
      expect(outcome.kind).toBe('saved');
      if (outcome.kind !== 'saved') throw new Error('unreachable');
      expect(outcome.fileName).toBe('Demo_1.glb');
      expect(outcome.relPath).toBe('models/Demo_1.glb');
      expect(backend.writes).toEqual(['models/Demo_1.glb']);
    } finally {
      glbFetch.restore();
    }
  });
});
