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
 import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { Scene, Group, Object3D, Mesh, BoxGeometry, MeshStandardMaterial, PerspectiveCamera, Vector3 } from 'three';
import { installEditorArena } from '../src/core/editor/rv-editor-arena-install';
import type { EditorArenaInstall } from '../src/core/editor/rv-editor-arena-install';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { AssetDocument } from '../src/core/editor/rv-asset-document';
import { __clearDraftStoresForTests } from '../src/core/ops/rv-document-drafts';
import { InPlaceTestSession, PENDING_REPLAY_REFUSAL } from '@rv-private/plugins/asset-editor/in-place-test-session';
import { saveAssetAs } from '@rv-private/plugins/asset-editor/save-flow';
import { _resetSceneTransition } from '../src/core/hmi/scene-transition-store';
import { projectDocumentBase } from '../src/core/editor/active-asset-store';
import type { RvOp } from '../src/core/ops/rv-unified-ops';

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

interface LoadCall { url: string; options?: { preserveHierarchy?: boolean; preserveAuthoringHierarchy?: boolean } }

function makeEnv(opts?: {
  loadImpl?: (call: LoadCall) => Promise<void>;
  /** plan-774 F3: what `whenSceneReady()` does (default: resolve at once). */
  readyImpl?: () => Promise<void>;
}) {
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
  /** plan-774 F3: every authoring join, in call order — `ready:<n loads so far>`. */
  const joins: string[] = [];
  let currentRoot: Object3D = model;
  let editorTestActive = false;
  const camera = new PerspectiveCamera();
  camera.position.set(4, 3, 5);
  const controls = { target: new Vector3(1, 1, 1), update() {} };

  const viewer = {
    scene,
    camera,
    controls,
    cancelCameraAnimation() {},
    registry,
    signalStore: null,
    transportManager: null,
    get currentModelRoot() { return currentRoot; },
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
    async loadModel(url: string, options?: { preserveHierarchy?: boolean; preserveAuthoringHierarchy?: boolean }) {
      const call = { url, options };
      loads.push(call);
      hooks.order.push('load');
      // Loading frames the camera anew, as the real viewer does.
      camera.position.set(40, 30, 50);
      controls.target.set(0, 0, 0);
      if (opts?.loadImpl) await opts.loadImpl(call);
      return {} as never;
    },
    // plan-774 F3: the authoring join (`loadAuthoringModel`) waits here.
    async whenSceneReady() {
      joins.push(`ready:${loads.length}`);
      hooks.order.push('join');
      if (opts?.readyImpl) await opts.readyImpl();
    },
    placements: { progress: { total: 0, pending: 0 } },
    runtime: {
      beginEditorTest() { runtimeCalls.push('begin'); editorTestActive = true; },
      endEditorTest() { runtimeCalls.push('end'); editorTestActive = false; },
      get isEditorTestActive() { return editorTestActive; },
    },
  } as unknown as RVViewer;

  const boxPath = NodeRegistry.computeNodePath(box);
  return {
    viewer, model, box, boxPath, emitted, loads, runtimeCalls, joins, camera, controls,
    /** Replace the viewer's model root (another document took the viewer). */
    swapRoot(next: Object3D) { currentRoot = next; },
  };
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
    const doc = scratchAssetDocument(env.viewer);
    const { session, swaps } = makeSession(env, doc);

    await session.start();

    expect(session.state).toBe('running');
    expect(session.isRunning).toBe(true);
    expect(env.runtimeCalls).toEqual(['begin']);
    expect(env.loads).toHaveLength(1);
    // The TEST load uses the default (runtime) configuration, not the
    // authoring one — it must behave like the planner/HMI after a save.
    expect(env.loads[0].options?.preserveHierarchy).toBeUndefined();
    // plan-727: the test run must see the RUNTIME view — including the kinematic
    // re-parenting a planner/HMI would see after a save. Neither flag is set.
    expect(env.loads[0].options?.preserveAuthoringHierarchy).toBeUndefined();
    expect(swaps).toHaveLength(1);
    doc.dispose();
  });

  it('keeps the user camera across start and stop although both loads re-frame it', async () => {
    const env = makeEnv();
    const doc = scratchAssetDocument(env.viewer);
    const { session } = makeSession(env, doc);

    await session.start();
    expect(env.camera.position.toArray()).toEqual([4, 3, 5]);
    expect(env.controls.target.toArray()).toEqual([1, 1, 1]);

    // The user moves the view during the run; stop keeps THAT pose.
    env.camera.position.set(7, 2, 6);
    env.controls.target.set(2, 0, 1);
    await session.stop();
    expect(env.loads).toHaveLength(2);
    expect(env.camera.position.toArray()).toEqual([7, 2, 6]);
    expect(env.controls.target.toArray()).toEqual([2, 0, 1]);
    doc.dispose();
  });

  it('emits asset-editor-pre-export BEFORE the export, and a preview actually restores', async () => {
    const env = makeEnv();
    const doc = scratchAssetDocument(env.viewer);
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
    const doc = scratchAssetDocument(env.viewer);
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
    const doc = scratchAssetDocument(env.viewer);
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
    const doc = scratchAssetDocument(env.viewer);
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
    const doc = scratchAssetDocument(env.viewer);
    const replaySpy = vi.spyOn(doc, 'replayOps');
    const { session, reinits } = makeSession(env, doc);

    await session.start();
    await session.stop();

    expect(session.state).toBe('idle');
    expect(env.runtimeCalls).toEqual(['begin', 'end']);
    expect(env.loads).toHaveLength(2);
    expect(env.loads[1].options?.preserveHierarchy).toBe(true);
    // plan-727: the restore returns to the authoring view, which never mutates
    // the hierarchy.
    expect(env.loads[1].options?.preserveAuthoringHierarchy).toBe(true);
    // plan-774 F6: the stop re-instantiates the test run's placements from the
    // kept bakes; the start is a plain runtime load (no option — the viewer's
    // default, which keeps as well).
    expect((env.loads[1].options as { keepBaked?: boolean } | undefined)?.keepBaked).toBe(true);
    expect((env.loads[0].options as { keepBaked?: boolean } | undefined)?.keepBaked).toBeUndefined();
    // The restore is a blob re-load + metadata hand-back (R1-2).
    expect(replaySpy).not.toHaveBeenCalled();
    expect(reinits).toHaveLength(1);
    // plan-774 F3: the restore is an AUTHORING load and joins its placements
    // (after the second load, before the reinit). plan-769 Phase 7 (D24): the
    // test-scene load of start() is a runtime load, and it joins too — before
    // the run is declared `running`.
    expect(env.joins).toEqual(['ready:1', 'ready:2']);
    doc.dispose();
  });

  it('plan-774 F3: the restore waits for the join before it hands the history back', async () => {
    let releaseJoin!: () => void;
    const joinGate = new Promise<void>((r) => { releaseJoin = r; });
    let gated = false;
    const env = makeEnv({ readyImpl: () => (gated ? joinGate : Promise.resolve()) });
    const doc = scratchAssetDocument(env.viewer);
    const { session, reinits } = makeSession(env, doc);

    await session.start();
    gated = true;
    const stopping = session.stop();
    await new Promise((r) => setTimeout(r, 20));
    // Loaded, but the placements have not settled — nothing handed back yet.
    expect(env.loads).toHaveLength(2);
    expect(reinits).toHaveLength(0);
    expect(session.state).toBe('restoring');
    releaseJoin();
    await stopping;
    expect(reinits).toHaveLength(1);
    expect(session.state).toBe('idle');
    doc.dispose();
  });

  it('plan-774 F3: a document switch during the restore join is a silent supersede — no history hand-back', async () => {
    let swapDuringJoin = false;
    const env = makeEnv({
      readyImpl: async () => { if (swapDuringJoin) env.swapRoot(new Group()); },
    });
    const doc = scratchAssetDocument(env.viewer);
    const restoreSpy = vi.spyOn(doc, 'restoreFromSnapshot');
    const { session, reinits, errors } = makeSession(env, doc);

    await session.start();
    swapDuringJoin = true;
    await session.stop();
    expect(restoreSpy).not.toHaveBeenCalled();
    expect(reinits).toHaveLength(0);
    expect(errors).toHaveLength(0);
    expect(session.state).toBe('idle');
    doc.dispose();
  });

  it('review round 2 R7: in a DESCENDED child both loads hold the kept window (holdKept); at the root neither does', async () => {
    for (const descended of [true, false]) {
      const env = makeEnv();
      const doc = scratchAssetDocument(env.viewer);
      const session = new InPlaceTestSession({ viewer: env.viewer, getDocument: () => doc, isDescended: () => descended });
      await session.start();
      await session.stop();
      const opts = env.loads.map((l) => (l.options as { holdKept?: boolean; keepBaked?: boolean } | undefined));
      expect(opts.map((o) => o?.holdKept === true), `descended=${descended}`).toEqual([descended, descended]);
      expect(opts[1]?.keepBaked).toBe(true);
      session.dispose();
      doc.dispose();
    }
  });

  it('edit → save → test → stop leaves the document CLEAN', async () => {
    const env = makeEnv();
    const doc = scratchAssetDocument(env.viewer);
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
    const doc = scratchAssetDocument(env.viewer);
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
    const doc = scratchAssetDocument(env.viewer);
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

  it('restores original file indices after a test export adds and reorders nodes', async () => {
    const env = makeEnv({ loadImpl: async () => {
      env.viewer.registry!.setGltfNodeIndices(
        new Map([[env.model, 0], [created, 1], [env.box, 2]]),
        ['Asset', 'Created', 'Box'],
      );
    } });
    const registry = env.viewer.registry!;
    registry.setGltfNodeIndices(new Map([[env.model, 0], [env.box, 1]]), ['Asset', 'Box']);
    const created = new Object3D();
    created.name = 'Created';
    env.model.add(created);
    registry.registerNode('Asset/Created', created);
    const doc = scratchAssetDocument(env.viewer);
    const { session } = makeSession(env, doc);

    for (let run = 0; run < 2; run++) {
      await session.start();
      expect(registry.getGltfNodeIndex(env.boxPath)).toBe(2);
      await session.stop();
      expect(session.state).toBe('idle');
      expect(registry.getGltfNodeNames()).toEqual(['Asset', 'Box']);
      expect(registry.getGltfNodeIndex(env.boxPath)).toBe(1);
      expect(registry.getGltfNodeIndex('Asset/Created')).toBeNull();
    }
    doc.dispose();
  });

  it('stop without a run is a no-op', async () => {
    const env = makeEnv();
    const doc = scratchAssetDocument(env.viewer);
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
    const doc = scratchAssetDocument(env.viewer);
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
    const doc = scratchAssetDocument(env.viewer);
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
    const doc = scratchAssetDocument(env.viewer);
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
    const doc = scratchAssetDocument(env.viewer);
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
    const doc = scratchAssetDocument(env.viewer);
    const { session, errors } = makeSession(env, doc);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await session.start();

    expect(session.isRunning).toBe(false);
    expect(env.runtimeCalls).not.toContain('begin');
    expect(errors).toHaveLength(1);
    // The snapshot existed already, so the authoring scene was put back.
    expect(env.loads).toHaveLength(2);
    expect(env.loads[1].options?.preserveHierarchy).toBe(true);
    // plan-727: the restore returns to the authoring view, which never mutates
    // the hierarchy.
    expect(env.loads[1].options?.preserveAuthoringHierarchy).toBe(true);
    error.mockRestore();
    doc.dispose();
  });

  it('a failing export ends in failed without touching the scene', async () => {
    const env = makeEnv();
    const doc = scratchAssetDocument(env.viewer);
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

  it('plan-774 review fix E3: start is refused (with the reason) while a recovered draft tail is pending', async () => {
    const env = makeEnv();
    const doc = scratchAssetDocument(env.viewer);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A recovered op that waits for placed content which has not arrived (and never will here).
    env.box.userData.realvirtual = { ...(env.box.userData.realvirtual ?? {}), Note: { Text: '' } };
    const op = {
      id: 'op-tail', ts: 1, origin: 'asset', kind: 'setField',
      nodePath: env.boxPath, componentType: 'Note', fieldName: 'Text', value: 'x', prev: '',
    } as unknown as RvOp;
    await doc.replayOps([op], { gate: { needsWait: () => true, wait: () => new Promise<boolean>(() => {}) }, waitBudgetMs: 150 });
    expect(doc.hasPendingReplay).toBe(true);
    const { session, errors } = makeSession(env, doc);

    await session.start();

    expect(session.state).toBe('idle');
    expect(env.loads).toHaveLength(0);
    expect(errors).toEqual([PENDING_REPLAY_REFUSAL]);
    expect(doc.lockOwner, 'no lock was taken').toBeNull();
    // After the wait's budget the tail is kept unapplied in the history and the queue is free.
    await doc.document.whenIdle();
    expect(doc.hasPendingReplay).toBe(false);
    expect(doc.document.ops.map((o) => o.id)).toEqual(['op-tail']);
    warn.mockRestore();
    doc.dispose();
  });

  it('every blob URL is revoked — success, cancellation and failure alike', async () => {
    // Success round trip.
    const env = makeEnv();
    const doc = scratchAssetDocument(env.viewer);
    const { session } = makeSession(env, doc);
    await session.start();
    await session.stop();

    // Failing load.
    let failNext = true;
    const env2 = makeEnv({
      loadImpl: async () => { if (failNext) { failNext = false; throw new Error('boom'); } },
    });
    const doc2 = scratchAssetDocument(env2.viewer);
    const { session: session2 } = makeSession(env2, doc2);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await session2.start();
    error.mockRestore();

    expect(revokeSpy.mock.calls.length).toBe(createSpy.mock.calls.length);
    doc.dispose();
    doc2.dispose();
  });
});

describe('InPlaceTestSession — editor arenas around the scene swap (plan-766 Schritt 5)', () => {
  // The editor plugin disposes its arenas in `onBeforeSceneSwap` and rebuilds
  // them in `onEditorReinit` (`_uninstallAuthoringTools` / `_installAuthoringTools`).
  // Wired here exactly like that, against a mock viewer with a real mesh, so the
  // ORDER is pinned: no arena may exist while either scene load runs, and the
  // restored tree is batched again afterwards.
  function arenaEnv() {
    const seen: Array<{ phase: string; arena: unknown; mask: number; arenasInScene: number }> = [];
    const holder: { mesh: Mesh | null } = { mesh: null };
    let envRef: ReturnType<typeof makeEnv> | null = null;
    const arenasInScene = () => {
      let n = 0;
      envRef!.viewer.scene.traverse((o) => { if (o.userData?._rvEditorArena) n++; });
      return n;
    };
    const env = makeEnv({
      loadImpl: async (call) => {
        seen.push({
          phase: call.options?.preserveHierarchy ? 'restore' : 'test',
          arena: (envRef!.viewer as unknown as { editorArena: unknown }).editorArena ?? null,
          mask: holder.mesh!.layers.mask,
          arenasInScene: arenasInScene(),
        });
      },
    });
    envRef = env;
    const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: 0x808080 }));
    mesh.name = 'Part';
    env.model.add(mesh);
    holder.mesh = mesh;
    (env.viewer as unknown as { editorArena: unknown }).editorArena = null;
    return { env, mesh, seen, arenasInScene };
  }

  it('disposes the arenas BEFORE the test-scene load and rebuilds them AFTER the restore', async () => {
    const { env, mesh, seen, arenasInScene } = arenaEnv();
    const doc = scratchAssetDocument(env.viewer);
    let install: EditorArenaInstall | null = installEditorArena(env.viewer, doc.executor);
    expect(install).not.toBeNull();
    expect(env.viewer.editorArena).toBe(install!.manager);
    expect(mesh.layers.mask).toBe(0);
    expect(arenasInScene()).toBe(1);
    const firstManager = install!.manager;
    const disposeSpy = vi.spyOn(firstManager, 'dispose');

    const session = new InPlaceTestSession({
      viewer: env.viewer,
      getDocument: () => doc,
      onBeforeSceneSwap: () => { hooks.order.push('swap'); install?.dispose(); install = null; },
      onEditorReinit: () => { install = installEditorArena(env.viewer, doc.executor); hooks.order.push('reinit'); },
      onError: () => {},
    });

    await session.start();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(hooks.order.indexOf('swap')).toBeLessThan(hooks.order.indexOf('load'));
    // While the test scene loads: no manager in the slot, sources on their
    // own layer again, no arena object left in the scene.
    expect(seen[0]).toEqual({ phase: 'test', arena: null, mask: 1, arenasInScene: 0 });

    await session.stop();
    expect(seen[1]).toEqual({ phase: 'restore', arena: null, mask: 1, arenasInScene: 0 });
    expect(hooks.order.lastIndexOf('load')).toBeLessThan(hooks.order.indexOf('reinit'));
    // Restored and batched again — by a NEW manager on the restored tree.
    expect(install).not.toBeNull();
    expect(install!.manager).not.toBe(firstManager);
    expect(env.viewer.editorArena).toBe(install!.manager);
    expect(mesh.layers.mask).toBe(0);
    expect(arenasInScene()).toBe(1);

    install!.dispose();
    expect(env.viewer.editorArena).toBeNull();
    expect(mesh.layers.mask).toBe(1);
    expect(arenasInScene()).toBe(0);
    doc.dispose();
  });

  it('an install attaches to the document executor: replay is bracketed into ONE rebuild', async () => {
    const { env } = arenaEnv();
    const doc = scratchAssetDocument(env.viewer);
    const install = installEditorArena(env.viewer, doc.executor)!;
    const rebuild = vi.spyOn(install.manager, 'rebuild');
    doc.executor.beginReplay();
    expect(install.ops.suspended).toBe(true);
    doc.executor.beginReplay(); // nested
    doc.executor.endReplay();
    expect(rebuild).not.toHaveBeenCalled();
    doc.executor.endReplay();
    expect(install.ops.suspended).toBe(false);
    expect(rebuild).toHaveBeenCalledTimes(1);
    // The real seam: RvDocument.replayOps brackets through the unified executor.
    await doc.replayOps([]);
    expect(rebuild).toHaveBeenCalledTimes(2);
    expect(doc.executor.replaying).toBe(false);
    install.dispose();
    doc.dispose();
  });

  it('an install inside an open replay bracket (recompose reload) waits for the bracket, then builds once', () => {
    const { env } = arenaEnv();
    const doc = scratchAssetDocument(env.viewer);
    doc.executor.beginReplay();
    const install = installEditorArena(env.viewer, doc.executor)!;
    expect(install.ops.suspended).toBe(true);
    const rebuild = vi.spyOn(install.manager, 'rebuild');
    doc.executor.endReplay();
    expect(install.ops.suspended).toBe(false);
    expect(rebuild).toHaveBeenCalledTimes(1);
    // A dispose while held must not leave a dangling suspend or build.
    doc.executor.beginReplay();
    install.dispose();
    doc.executor.endReplay();
    expect(rebuild).toHaveBeenCalledTimes(1);
    doc.dispose();
  });
});

describe('saveAssetAs — test-run guard', () => {
  // During a test run `viewer.currentModelRoot` is the materialised test scene
  // with runtime poses; a save accepted then bakes those poses into the GLB as
  // the authored zero position (the 2026-08-22 delta robot incident). The save
  // must refuse for the same span the edit guard covers: while
  // `isAutosaveSuspended` marks the document as held by a test run.
  it('refuses a save while a test run holds the document', async () => {
    const env = makeEnv();
    const doc = scratchAssetDocument(env.viewer);
    const { session } = makeSession(env, doc);
    await session.start();
    expect(doc.isAutosaveSuspended).toBe(true);

    const outcome = await saveAssetAs({ viewer: env.viewer, doc }, doc.name || 'Asset');

    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') {
      expect(outcome.reason).toMatch(/test run/i);
    }
    await session.stop();
    expect(doc.isAutosaveSuspended).toBe(false);
    doc.dispose();
  });
});
