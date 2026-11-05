// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { PluginContextImpl, type PluginContext } from '../src/core/rv-plugin-context';
import { SceneFacadeImpl } from '../src/core/facades/scene-facade';
import { CameraFacadeImpl } from '../src/core/facades/camera-facade';
import { ControlsFacadeImpl } from '../src/core/facades/controls-facade';
import { SimLoopFacadeImpl } from '../src/core/facades/sim-loop-facade';
import { Mesh, Object3D } from 'three';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { DES_RECORD_REFUSAL, installStageRecordCapabilities } from '../src/core/facades/stage-record-facades';

describe('PluginContextImpl (plan-182 Phase 4a)', () => {
  function makeMockViewer(): never {
    return {
      signalStore: { get: () => null, set: () => {}, setMany: () => {}, subscribe: () => () => {} },
      registry: { getNode: () => null, getPathForNode: () => null, forEachNode: () => {} },
      transportManager: null,
      connectionState: 'Disconnected' as const,
      camera: null,
      controls: null,
      renderer: null,
      drives: [],
      isSimulationPaused: false,
      emit: () => {},
      on: () => () => {},
      setSimulationPaused: () => {},
      clearPauseReasons: () => {},
      animateCameraTo: () => {},
      fitToNodes: () => {},
      focusByPath: () => {},
      clearFocus: () => {},
      highlightByPath: () => {},
      clearHighlight: () => {},
      loadModel: () => Promise.resolve({}),
      clearModel: () => {},
    } as never;
  }

  it('exposes scene, camera, controls, simLoop as sub-facades', () => {
    const ctx = new PluginContextImpl(makeMockViewer());
    expect(ctx.scene).toBeInstanceOf(SceneFacadeImpl);
    expect(ctx.camera).toBeInstanceOf(CameraFacadeImpl);
    expect(ctx.controls).toBeInstanceOf(ControlsFacadeImpl);
    expect(ctx.simLoop).toBeInstanceOf(SimLoopFacadeImpl);
  });

  it('shares the viewer sim loop, also for per-plugin contexts (ticks must reach fixedUpdate)', () => {
    const viewer = makeMockViewer() as unknown as { _simLoop: SimLoopFacadeImpl };
    viewer._simLoop = new SimLoopFacadeImpl(viewer as never);
    const ctx = new PluginContextImpl(viewer as never);
    expect(ctx.simLoop).toBe(viewer._simLoop);
    expect(ctx.forPlugin('plc').simLoop).toBe(viewer._simLoop);
  });

  it('transport is null when transportManager is null', () => {
    const ctx = new PluginContextImpl(makeMockViewer());
    expect(ctx.transport).toBeNull();
  });

  it('transport is lazy-cached and re-created when manager pointer changes', () => {
    const mgr1 = { surfaces: [] };
    const mgr2 = { surfaces: [] };
    const viewer = makeMockViewer() as unknown as { transportManager: object | null };
    viewer.transportManager = mgr1;
    const ctx = new PluginContextImpl(viewer as never);
    const t1 = ctx.transport;
    const t2 = ctx.transport;
    expect(t1).toBe(t2);  // same instance on second call

    viewer.transportManager = mgr2;  // new pointer
    const t3 = ctx.transport;
    expect(t3).not.toBe(t1);
  });

  it('signals/nodes are live getters (reflect changes)', () => {
    const viewer = makeMockViewer() as unknown as { signalStore: unknown };
    const ctx = new PluginContextImpl(viewer as never);
    expect(ctx.signals).not.toBeNull();
    viewer.signalStore = null;
    expect(ctx.signals).toBeNull();
  });

  it('events returns the viewer (no cast, since RVViewer extends EventEmitter)', () => {
    const viewer = makeMockViewer();
    const ctx = new PluginContextImpl(viewer);
    expect(ctx.events).toBe(viewer);
  });

  // -- plan-2229 Phase 3: recording capabilities (plugins rule 1) --

  describe('plan-2229 stage / simTime / simCapture / loadGeneration', () => {
    let unregister: () => void = () => {};
    beforeEach(() => { unregister = installStageRecordCapabilities(); });
    afterEach(() => unregister());

    function modelViewer() {
      const root = new Object3D(); root.name = 'Model';
      const preNode = new Mesh(); preNode.name = 'Pre'; root.add(preNode);
      const spawnNode = new Mesh(); spawnNode.name = 'Spawned'; root.add(spawnNode);
      const tm = new RVTransportManager();
      const pre = new RVMovingUnit(preNode, 'doc'); pre.preplaced = true;
      tm.registerPreplaced(pre, root);
      const spawned = new RVMovingUnit(spawnNode, 'Source1');
      tm.mus.push(pre, spawned); // an activated pre-placed MU is in both lists
      const viewer = makeMockViewer() as unknown as Record<string, unknown>;
      Object.assign(viewer, {
        transportManager: tm, currentModelRoot: root, loadGeneration: 7, simTime: 1.5, simulationKernel: null,
        whenSceneReady: () => Promise.resolve(),
      });
      return { viewer, root, tm, pre, spawned };
    }

    it('not installed = undefined (USD recorder not loaded); contexts made BEFORE and AFTER the install see them', () => {
      unregister();
      const { viewer } = modelViewer();
      const before: PluginContext = new PluginContextImpl(viewer as never);
      expect(before.stage).toBeUndefined();
      expect(before.simTime).toBeUndefined();
      expect(before.simCapture).toBeUndefined();
      expect(before.loadGeneration).toBeUndefined();
      expect(before.whenSceneReady).toBeUndefined();
      unregister = installStageRecordCapabilities();
      const after: PluginContext = new PluginContextImpl(viewer as never).forPlugin('usd-anim-recorder');
      for (const ctx of [before, after]) {
        expect(ctx.stage).not.toBeNull();
        expect(ctx.simTime!.poseTime).toBe(1.5);
        expect(typeof ctx.simCapture!.preflight).toBe('function');
      }
      expect(before.simTime).toBe(before.simTime); // cached per context
      unregister();
      expect(before.simTime).toBeUndefined();
      expect(after.stage).toBeUndefined();
    });

    it('ownership: overlapping installs, stale and repeated cleanups never strip a live owner', () => {
      unregister(); // the beforeEach owner leaves; nothing installed now
      const { viewer } = modelViewer();
      const ctx: PluginContext = new PluginContextImpl(viewer as never);
      const a = installStageRecordCapabilities();
      const facade = ctx.simTime;
      const b = installStageRecordCapabilities();
      a(); // install A, install B, uninstall A: B still owns them
      expect(ctx.simTime).toBe(facade); // a live context keeps working, same cached facade
      expect(ctx.loadGeneration).toBe(7);
      a(); a(); // repeated stale cleanup: no effect
      expect(ctx.simCapture).toBeDefined();
      b();
      expect(ctx.simTime).toBeUndefined(); // the last owner removes them
      b();
      const c = installStageRecordCapabilities(); // reinstall after cleanup
      expect(ctx.simTime!.poseTime).toBe(1.5);
      // a stale cleanup never deletes descriptors installed by someone else
      c();
      const foreign = { configurable: true, get: () => 'foreign' };
      Object.defineProperty(PluginContextImpl.prototype, 'simTime', foreign);
      const d = installStageRecordCapabilities();
      Object.defineProperty(PluginContextImpl.prototype, 'simTime', foreign); // overwritten later by another party
      d();
      expect((ctx as unknown as { simTime: unknown }).simTime).toBe('foreign');
      delete (PluginContextImpl.prototype as unknown as Record<string, unknown>).simTime;
      unregister = installStageRecordCapabilities();
    });

    it('stage is null without a model and collects every MU once, pre-placed first', () => {
      const empty: PluginContext = new PluginContextImpl(makeMockViewer());
      expect(empty.stage).toBeNull();
      const { viewer, root, pre, spawned } = modelViewer();
      const ctx: PluginContext = new PluginContextImpl(viewer as never);
      const snap = ctx.stage!.collect()!;
      expect(snap.generation).toBe(7);
      expect(snap.input.root).toBe(root);
      expect(snap.mus.map((m) => [m.muId, m.preplaced, m.node?.name])).toEqual([
        [pre.id, true, 'Pre'], [spawned.id, false, 'Spawned'],
      ]);
      // Timeline form: every MU node is left out of the hierarchy, the pre-placed one is listed.
      expect(snap.input.exclude.has(pre.node)).toBe(true);
      expect(snap.input.exclude.has(spawned.node)).toBe(true);
      expect(snap.input.preplaced.map((p) => p.muId)).toEqual([pre.id]);
      const seen: number[] = [];
      ctx.stage!.forEachMu((mu) => seen.push(mu.id));
      expect(seen).toEqual([pre.id, spawned.id]);
      expect(ctx.stage!.muEntry(spawned)).toEqual({ muId: spawned.id, node: spawned.node, template: null, preplaced: false });
    });

    it('simTime: continuous = viewer.simTime; DES = render clock + refusal; no kernel = none', () => {
      const { viewer } = modelViewer();
      const ctx: PluginContext = new PluginContextImpl(viewer as never);
      expect(ctx.simTime!.kernel).toBe('none');
      viewer.simulationKernel = { desControl: () => null };
      expect(ctx.simTime!.kernel).toBe('continuous');
      expect(ctx.simTime!.poseTime).toBe(1.5);
      expect(ctx.simTime!.recordRefusal).toBeNull();
      expect(typeof ctx.simTime!.speed).toBe('number');
      viewer.simulationKernel = { desControl: () => ({ simTime: 0, renderClock: 0.1 }) };
      expect(ctx.simTime!.kernel).toBe('des');
      expect(ctx.simTime!.poseTime).toBe(0.1);
      expect(ctx.simTime!.recordRefusal).toBe(DES_RECORD_REFUSAL);
    });

    it('simCapture: preflight refusal, step = captureStep(n, 1/60), end exactly once', () => {
      const { viewer } = modelViewer();
      const calls: string[] = [];
      let refuse: string | null = 'Video capture supports the continuous simulation only (DES mode is active).';
      Object.assign(viewer, {
        capturePreflight: () => refuse,
        beginCapture: (o: { width: number; height: number; frameDt: number }) => calls.push(`begin ${o.width}x${o.height} ${o.frameDt.toFixed(4)}`),
        captureStep: (n: number, dt: number) => calls.push(`step ${n} ${dt.toFixed(4)}`),
        endCapture: () => calls.push('end'),
        captureAbortReason: null,
        renderer: { getSize: (v: { set(x: number, y: number): unknown }) => v.set(640, 480) },
      });
      const ctx: PluginContext = new PluginContextImpl(viewer as never);
      expect(ctx.simCapture!.preflight()).toBe(refuse);
      expect(ctx.simCapture!.begin()).toEqual({ refusal: refuse });
      expect(calls).toEqual([]); // the preflight is pure
      refuse = null;
      const begun = ctx.simCapture!.begin();
      if (!('session' in begun)) throw new Error('expected a session');
      begun.session.step(1);
      begun.session.end();
      begun.session.end();
      expect(calls).toEqual(['begin 640x480 0.0167', 'step 1 0.0167', 'end']);
      expect(() => begun.session.step(1)).toThrow();
    });

    it('loadGeneration, whenSceneReady and nodes.getAddressForNode come from the viewer', () => {
      const { viewer } = modelViewer();
      const ready = Promise.resolve();
      viewer.whenSceneReady = () => ready;
      viewer.registry = { getNode: () => null, getPathForNode: () => null, forEachNode: () => {}, getAddressForNode: () => '#id' };
      const ctx: PluginContext = new PluginContextImpl(viewer as never);
      expect(ctx.loadGeneration).toBe(7);
      viewer.loadGeneration = 8;
      expect(ctx.loadGeneration).toBe(8);
      expect(ctx.whenSceneReady!()).toBe(ready);
      expect(ctx.nodes!.getAddressForNode(new Object3D())).toBe('#id');
    });
  });
});
