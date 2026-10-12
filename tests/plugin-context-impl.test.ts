// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { PluginContextImpl } from '../src/core/rv-plugin-context';
import { SceneFacadeImpl } from '../src/core/facades/scene-facade';
import { CameraFacadeImpl } from '../src/core/facades/camera-facade';
import { ControlsFacadeImpl } from '../src/core/facades/controls-facade';
import { SimLoopFacadeImpl } from '../src/core/facades/sim-loop-facade';

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
});
