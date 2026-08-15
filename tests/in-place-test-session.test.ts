// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * InPlaceTestSession (plan-410 F5/F6) — the editor's run-it-here mode.
 *
 * The invariants under test are the ones the plan calls binding:
 *  - materialisation goes through the REAL export path, and the pre-export
 *    event is emitted BEFORE it, so preview poses cannot bake in (R2-1);
 *  - the restore re-loads the frozen blob and re-attaches metadata, and NEVER
 *    replays the op log — `edit → save → test → stop` must leave the document
 *    clean (R1-2), `edit → undo → test → stop` must keep the redo stack (R2-3);
 *  - a cancellation that lands mid-`await` (slow export, slow load) makes the
 *    stale continuation touch nothing (R2-4);
 *  - every path revokes its blob URL, and `abortSync` never restores a scene.
 *
 * The GLB export is mocked so its TIMING can be controlled; everything else —
 * the document, its op log, its undo/redo — is real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Scene, Group, Object3D } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { AssetDocument } from '../src/core/editor/rv-asset-document';
import { __clearDraftStoresForTests } from '../src/core/ops/rv-document-drafts';
import { InPlaceTestSession } from '@rv-private/plugins/asset-editor/in-place-test-session';
import { _resetSceneTransition } from '../src/core/hmi/scene-transition-store';
import { projectDocumentBase } from '../src/core/editor/active-asset-store';

const hooks = vi.hoisted(() => ({
  /** Replaced per test to control WHEN the export resolves. */
  exportImpl: async (): Promise<ArrayBuffer> => new ArrayBuffer(16),
  order: [] as string[],
}));

vi.mock('../src/core/editor/rv-asset-glb-export', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/editor/rv-asset-glb-export')>();
  return {
    ...actual,
    exportAssetGlb: async () => {
      hooks.order.push('export');
      return hooks.exportImpl();
    },
  };
});

interface LoadCall { url: string; options?: { preserveHierarchy?: boolean } }

function makeEnv(opts?: { loadImpl?: (call: LoadCall) => Promise<void> }) {
  const scene = new Scene();
  const model = new Group();
  model.name = 'Asset';
  scene.add(model);
  const box = new Object3D();
  box.name = 'Box';
  box.userData.realvirtual = { Drive: { TargetSpeed: 50 } };
  model.add(box);

  const registry = new NodeRegistry();
  model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));

  const emitted: Array<{ event: string; data: unknown }> = [];
  const eventListeners = new Map<string, Set<(d: unknown) => void>>();
  const loads: LoadCall[] = [];
  const runtimeCalls: string[] = [];
  let editorTestActive = false;

  const viewer = {
    scene,
    registry,
    signalStore: null,
    transportManager: null,
    get currentModelRoot() { return model; },
    markRenderDirty() {},
    markShadowsDirty() {},
    rebuildGroupedBvh() {},
    highlightPolicy: null,
    emit(event: string, data: unknown) {
      emitted.push({ event, data });
      hooks.order.push(`emit:${event}`);
      for (const fn of [...(eventListeners.get(event) ?? [])]) fn(data);
    },
    on(event: string, fn: (d: unknown) => void) {
      let set = eventListeners.get(event);
      if (!set) { set = new Set(); eventListeners.set(event, set); }
      set.add(fn);
      return () => { set!.delete(fn); };
    },
    async loadModel(url: string, options?: { preserveHierarchy?: boolean }) {
      const call = { url, options };
      loads.push(call);
      hooks.order.push('load');
      if (opts?.loadImpl) await opts.loadImpl(call);
      return {} as never;
    },
    runtime: {
      beginEditorTest() { runtimeCalls.push('begin'); editorTestActive = true; },
      endEditorTest() { runtimeCalls.push('end'); editorTestActive = false; },
      get isEditorTestActive() { return editorTestActive; },
    },
  } as unknown as RVViewer;

  const boxPath = NodeRegistry.computeNodePath(box);
  return { viewer, model, box, boxPath, emitted, loads, runtimeCalls };
}

function makeSession(env: ReturnType<typeof makeEnv>, doc: AssetDocument, extra?: {
  onEditorReinit?: () => void;
}) {
  const reinits: number[] = [];
  const swaps: number[] = [];
  const errors: string[] = [];
  const session = new InPlaceTestSession({
    viewer: env.viewer,
    getDocument: () => doc,
    onBeforeSceneSwap: () => { swaps.push(1); hooks.order.push('swap'); },
    onEditorReinit: () => { reinits.push(1); extra?.onEditorReinit?.(); },
    onError: (message) => { errors.push(message); },
  });
  return { session, reinits, swaps, errors };
}

let revokeSpy: ReturnType<typeof vi.spyOn>;
let createSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  hooks.order.length = 0;
  hooks.exportImpl = async () => new ArrayBuffer(16);
  _resetSceneTransition();
  await __clearDraftStoresForTests();
  createSpy = vi.spyOn(URL, 'createObjectURL');
  revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
});

afterEach(() => {
  createSpy.mockRestore();
  revokeSpy.mockRestore();
});

describe('InPlaceTestSession — start', () => {
  it('materialises through the export path, loads the blob and attaches the runtime', async () => {
    const env = makeEnv();
    const doc = AssetDocument.newUntitled(env.viewer);
    const { session, swaps } = makeSession(env, doc);

    await session.start();

    expect(session.state).toBe('running');
    expect(session.isRunning).toBe(true);
    expect(env.runtimeCalls).toEqual(['begin']);
    expect(env.loads).toHaveLength(1);
    // The TEST load uses the default (runtime) configuration, not the
    // authoring one — it must behave like the planner/HMI after a save.
    expect(env.loads[0].options?.preserveHierarchy).toBeUndefined();
    expect(swaps).toHaveLength(1);
    doc.dispose();
  });

  it('emits asset-editor-pre-export BEFORE the export, and a preview actually restores', async () => {
    const env = makeEnv();
    const doc = AssetDocument.newUntitled(env.viewer);
    const { session } = makeSession(env, doc);

    // Stand-in for DriveDragPreview/JogController: holds a preview pose and
    // drops it when the event arrives.
    let previewActive = true;
    let previewActiveAtExport: boolean | null = null;
    env.viewer.on('asset-editor-pre-export', () => { previewActive = false; });
    hooks.exportImpl = async () => {
      previewActiveAtExport = previewActive;
      return new ArrayBuffer(16);
    };

    await session.start();

    expect(env.emitted.find((e) => e.event === 'asset-editor-pre-export')?.data)
      .toEqual({ source: 'test-session' });
    // Order, not mere presence (R2-1).
    expect(hooks.order.indexOf('emit:asset-editor-pre-export'))
      .toBeLessThan(hooks.order.indexOf('export'));
    expect(previewActiveAtExport).toBe(false);
    doc.dispose();
  });

  it('drains the op queue before exporting', async () => {
    const env = makeEnv();
    const doc = AssetDocument.newUntitled(env.viewer);
    const original = doc.whenIdle.bind(doc);
    doc.whenIdle = () => { hooks.order.push('whenIdle'); return original(); };
    const { session } = makeSession(env, doc);

    doc.setField(env.boxPath, 'Drive', 'TargetSpeed', 200, 50);
    await session.start();

    expect(hooks.order.indexOf('whenIdle')).toBeLessThan(hooks.order.indexOf('export'));
    // The op landed before the snapshot was taken.
    expect((env.box.userData.realvirtual as Record<string, Record<string, unknown>>).Drive.TargetSpeed)
      .toBe(200);
    doc.dispose();
  });

  it('a second start while running is a no-op with a warning', async () => {
    const env = makeEnv();
    const doc = AssetDocument.newUntitled(env.viewer);
    const { session } = makeSession(env, doc);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await session.start();
    await session.start();

    expect(warn).toHaveBeenCalled();
    expect(env.loads).toHaveLength(1);
    expect(env.runtimeCalls).toEqual(['begin']);
    warn.mockRestore();
    doc.dispose();
  });

  it('suspends autosave for the duration of the run', async () => {
    const env = makeEnv();
    const doc = AssetDocument.newUntitled(env.viewer);
    const { session } = makeSession(env, doc);

    await session.start();
    expect(doc.isAutosaveSuspended).toBe(true);

    await session.stop();
    expect(doc.isAutosaveSuspended).toBe(false);
    doc.dispose();
  });
});

describe('InPlaceTestSession — stop restores the authoring state', () => {
  it('re-loads the frozen blob with the authoring configuration and never replays ops', async () => {
    const env = makeEnv();
    const doc = AssetDocument.newUntitled(env.viewer);
    const replaySpy = vi.spyOn(doc, 'replayOps');
    const { session, reinits } = makeSession(env, doc);

    await session.start();
    await session.stop();

    expect(session.state).toBe('idle');
    expect(env.runtimeCalls).toEqual(['begin', 'end']);
    expect(env.loads).toHaveLength(2);
    expect(env.loads[1].options?.preserveHierarchy).toBe(true);
    // The restore is a blob re-load + metadata hand-back (R1-2).
    expect(replaySpy).not.toHaveBeenCalled();
    expect(reinits).toHaveLength(1);
    doc.dispose();
  });

  it('edit → save → test → stop leaves the document CLEAN', async () => {
    const env = makeEnv();
    const doc = AssetDocument.newUntitled(env.viewer);
    const { session } = makeSession(env, doc);

    doc.setField(env.boxPath, 'Drive', 'TargetSpeed', 200, 50);
    await doc.whenIdle();
    expect(doc.dirty).toBe(true);

    await doc.markSaved(projectDocumentBase('library/Custom/A.glb', 'A'), 'A');
    expect(doc.dirty).toBe(false);
    const opCountAfterSave = doc.getSnapshot().opCount;

    await session.start();
    await session.stop();

    // A replay-based restore would re-apply the already-baked op and make this
    // dirty again — the exact regression R1-2 describes.
    expect(doc.dirty).toBe(false);
    expect(doc.getSnapshot().opCount).toBe(opCountAfterSave);
    expect(doc.base).toEqual(projectDocumentBase('library/Custom/A.glb', 'A'));
    expect(doc.name).toBe('A');
    doc.dispose();
  });

  it('edit → undo → test → stop keeps the redo stack intact', async () => {
    const env = makeEnv();
    const doc = AssetDocument.newUntitled(env.viewer);
    const { session } = makeSession(env, doc);

    doc.setField(env.boxPath, 'Drive', 'TargetSpeed', 200, 50);
    await doc.whenIdle();
    await doc.undo();

    const before = doc.getSnapshot();
    expect(before.canRedo).toBe(true);

    await session.start();
    await session.stop();

    const after = doc.getSnapshot();
    expect(after.canRedo).toBe(true);
    expect(after.redoLabel).toBe(before.redoLabel);
    expect(after.canUndo).toBe(before.canUndo);
    expect(after.dirty).toBe(before.dirty);
    doc.dispose();
  });

  it('a dirty document stays dirty across the round trip', async () => {
    const env = makeEnv();
    const doc = AssetDocument.newUntitled(env.viewer);
    const { session } = makeSession(env, doc);

    doc.setField(env.boxPath, 'Drive', 'TargetSpeed', 200, 50);
    await doc.whenIdle();
    const opCount = doc.getSnapshot().opCount;

    await session.start();
    await session.stop();

    expect(doc.dirty).toBe(true);
    expect(doc.getSnapshot().opCount).toBe(opCount);
    doc.dispose();
  });

  it('stop without a run is a no-op', async () => {
    const env = makeEnv();
    const doc = AssetDocument.newUntitled(env.viewer);
    const { session } = makeSession(env, doc);

    await session.stop();

    expect(session.state).toBe('idle');
    expect(env.loads).toHaveLength(0);
    doc.dispose();
  });
});

describe('InPlaceTestSession — cancellation', () => {
  it('abortSync during a SLOW EXPORT: the stale continuation loads and attaches nothing', async () => {
    const env = makeEnv();
    const doc = AssetDocument.newUntitled(env.viewer);
    const { session } = makeSession(env, doc);

    let releaseExport!: () => void;
    hooks.exportImpl = () => new Promise<ArrayBuffer>((resolve) => {
      releaseExport = () => resolve(new ArrayBuffer(16));
    });

    const started = session.start();
    // Let start() reach the export await.
    await new Promise((r) => setTimeout(r, 0));

    session.abortSync();          // guard-free exit lands here
    releaseExport();
    await started;

    expect(env.loads).toHaveLength(0);
    expect(env.runtimeCalls).not.toContain('begin');
    expect(session.isRunning).toBe(false);
    doc.dispose();
  });

  it('abortSync during a SLOW LOAD: the run never reaches running', async () => {
    let releaseLoad!: () => void;
    const env = makeEnv({
      loadImpl: () => new Promise<void>((resolve) => { releaseLoad = resolve; }),
    });
    const doc = AssetDocument.newUntitled(env.viewer);
    const { session } = makeSession(env, doc);

    const started = session.start();
    await new Promise((r) => setTimeout(r, 0));

    session.abortSync();
    releaseLoad();
    await started;

    expect(session.isRunning).toBe(false);
    expect(env.runtimeCalls).not.toContain('begin');
    doc.dispose();
  });

  it('abortSync detaches and does NOT restore the scene (that owner is _deactivate)', async () => {
    const env = makeEnv();
    const doc = AssetDocument.newUntitled(env.viewer);
    const { session } = makeSession(env, doc);

    await session.start();
    const loadsDuringRun = env.loads.length;

    session.abortSync();

    expect(env.runtimeCalls).toEqual(['begin', 'end']);
    expect(env.loads).toHaveLength(loadsDuringRun);  // no restore load
    expect(doc.isAutosaveSuspended).toBe(false);     // draft writing resumes
    doc.dispose();
  });

  it('dispose is an abort that leaves nothing attached', async () => {
    const env = makeEnv();
    const doc = AssetDocument.newUntitled(env.viewer);
    const { session } = makeSession(env, doc);

    await session.start();
    session.dispose();

    expect(env.runtimeCalls).toEqual(['begin', 'end']);
    doc.dispose();
  });
});

describe('InPlaceTestSession — failure paths', () => {
  it('a failing load ends in failed, detaches, reports, and attempts the restore', async () => {
    let failNext = true;
    const env = makeEnv({
      loadImpl: async () => {
        if (failNext) { failNext = false; throw new Error('parse error'); }
      },
    });
    const doc = AssetDocument.newUntitled(env.viewer);
    const { session, errors } = makeSession(env, doc);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await session.start();

    expect(session.isRunning).toBe(false);
    expect(env.runtimeCalls).not.toContain('begin');
    expect(errors).toHaveLength(1);
    // The snapshot existed already, so the authoring scene was put back.
    expect(env.loads).toHaveLength(2);
    expect(env.loads[1].options?.preserveHierarchy).toBe(true);
    error.mockRestore();
    doc.dispose();
  });

  it('a failing export ends in failed without touching the scene', async () => {
    const env = makeEnv();
    const doc = AssetDocument.newUntitled(env.viewer);
    const { session, errors } = makeSession(env, doc);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    hooks.exportImpl = async () => { throw new Error('non-serialisable userData'); };

    await session.start();

    expect(session.state).toBe('failed');
    expect(env.loads).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(doc.isAutosaveSuspended).toBe(false);
    error.mockRestore();
    doc.dispose();
  });

  it('start without a document is refused', async () => {
    const env = makeEnv();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const session = new InPlaceTestSession({ viewer: env.viewer, getDocument: () => null });

    await session.start();

    expect(session.state).toBe('idle');
    expect(env.loads).toHaveLength(0);
    warn.mockRestore();
  });

  it('every blob URL is revoked — success, cancellation and failure alike', async () => {
    // Success round trip.
    const env = makeEnv();
    const doc = AssetDocument.newUntitled(env.viewer);
    const { session } = makeSession(env, doc);
    await session.start();
    await session.stop();

    // Failing load.
    let failNext = true;
    const env2 = makeEnv({
      loadImpl: async () => { if (failNext) { failNext = false; throw new Error('boom'); } },
    });
    const doc2 = AssetDocument.newUntitled(env2.viewer);
    const { session: session2 } = makeSession(env2, doc2);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await session2.start();
    error.mockRestore();

    expect(revokeSpy.mock.calls.length).toBe(createSpy.mock.calls.length);
    doc.dispose();
    doc2.dispose();
  });
});
