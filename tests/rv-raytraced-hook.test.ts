// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-762 § 9.4 / § 9.10 — the ray traced core hook and the viewer-side
 * lifecycle of the mode.
 *
 *  1. Registry (Phase 1 hull, now typed): lazy factory, replacement, the
 *     refusal text, the live render-mode gate, the constants.
 *  2. `RaytracedModeController` with fake deps (no renderer): the epoch race
 *     (exit during a pending factory / setup), toggles, the fatal rule, the
 *     scene wait, stale hosts, frame() exceptions, resize 0×0, stats.
 *  3. A REAL viewer on `webgpu-gl` with `hasCompute` forced (F18) and a fake
 *     backend: enter / frame per TSL render / exit / setup failure / pending
 *     race / toggle / onFatal after a user switch / model-cleared →
 *     placements-materialized / resize / dispose / frame() throws while the
 *     loop keeps rendering / device.lost / the wireframe gate (F17).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getRaytracedBackend,
  inactiveRaytracedStats,
  registerRaytracedBackend,
  RAYTRACED_DEFAULT_PIXEL_BUDGET,
  RAYTRACED_HISTORY_CAP,
  RAYTRACED_MEASURE_BVH,
  RAYTRACED_MEASURE_KERNEL,
  RAYTRACED_MEASURE_UPDATE,
  RAYTRACED_TARGET_SAMPLES,
  RAYTRACED_UNAVAILABLE_MESSAGE,
  type RaytracedBackend,
  type RaytracedSceneHost,
} from '../src/core/engine/rv-raytraced-hook';
import {
  RaytracedModeController,
  type RaytracedControllerDeps,
  type RaytracedPipelineLike,
} from '../src/core/engine/rv-raytraced-host';
import { availableRenderModes } from '../src/core/rv-render-modes';
import { setRenderMode } from '../src/core/hmi/render-mode-controller';
import type { RVViewer } from '../src/core/rv-viewer';
import {
  createFakeRaytracedBackend,
  fakeRaytracedBackendFactory,
  fakeRenderViewer,
  type FakeRaytracedBackend,
} from './helpers/fake-render-viewer';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { loadVideoFixture } from './helpers/video-capture-fixture';

const VIEWER_TEST_TIMEOUT = 90_000;

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Let pending microtasks and the controller's macrotask yield run. */
async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => { setTimeout(r, 0); });
}

afterEach(() => registerRaytracedBackend(null));

// ─── 1. Registry ─────────────────────────────────────────────────────────────

describe('rv-raytraced-hook registry (plan-762 F4)', () => {
  it('has no backend registered by default (community build)', () => {
    expect(getRaytracedBackend()).toBeNull();
  });

  it('registers and unregisters a factory without calling it', () => {
    let calls = 0;
    const factory = async (): Promise<RaytracedBackend> => { calls++; return createFakeRaytracedBackend(); };
    registerRaytracedBackend(factory);
    expect(getRaytracedBackend()).toBe(factory);
    registerRaytracedBackend(null);
    expect(getRaytracedBackend()).toBeNull();
    expect(calls).toBe(0); // the factory is lazy — only a mode entry may call it
  });

  it('a later registration replaces the earlier one', () => {
    const a = async (): Promise<RaytracedBackend> => createFakeRaytracedBackend();
    const b = async (): Promise<RaytracedBackend> => createFakeRaytracedBackend();
    registerRaytracedBackend(a);
    registerRaytracedBackend(b);
    expect(getRaytracedBackend()).toBe(b);
  });

  it('exposes the refusal text, the constants and the measure names', () => {
    expect(RAYTRACED_UNAVAILABLE_MESSAGE).toBe('Ray traced rendering is not available in this build.');
    expect(RAYTRACED_HISTORY_CAP).toBe(64);
    expect(RAYTRACED_TARGET_SAMPLES).toBe(256);
    expect(RAYTRACED_DEFAULT_PIXEL_BUDGET).toBe(0.25);
    expect([RAYTRACED_MEASURE_BVH, RAYTRACED_MEASURE_UPDATE, RAYTRACED_MEASURE_KERNEL])
      .toEqual(['rv:raytraced-bvh', 'rv:raytraced-update', 'rv:raytraced-kernel']);
    expect(inactiveRaytracedStats(3)).toMatchObject({
      active: false, ready: false, epoch: 3, historyFrames: 0, targetSamples: 256, pixelBudget: 0.25, cap: 64, lastError: null,
    });
  });

  it('feeds the live render-mode gate: registration flips backendRegistered on the next read', () => {
    const viewer = fakeRenderViewer({ hasCompute: true });
    expect(viewer.renderModeContext).toEqual({ hasCompute: true, backendRegistered: false });
    expect(availableRenderModes(viewer.renderModeContext).map((m) => m.id)).not.toContain('raytraced');
    registerRaytracedBackend(fakeRaytracedBackendFactory);
    expect(viewer.renderModeContext).toEqual({ hasCompute: true, backendRegistered: true });
    expect(availableRenderModes(viewer.renderModeContext).map((m) => m.id)).toContain('raytraced');
  });
});

// ─── 2. Controller with fake deps ────────────────────────────────────────────

interface FakeDeps extends RaytracedControllerDeps {
  modeActive: boolean;
  ready: boolean;
  fallbacks: number;
  warnings: string[];
  statuses: Array<string | null>;
  pipe: RaytracedPipelineLike & { raytraced: unknown; irradianceSets: unknown[]; reprojections: Array<[number[] | null, unknown]> };
  backends: FakeRaytracedBackend[];
  makeBackend: () => Promise<RaytracedBackend>;
}

function fakeDeps(): FakeDeps {
  const placeholder = { isTexture: true, name: 'placeholder' };
  const pipe = {
    raytraced: null as unknown,
    irradianceSets: [] as unknown[],
    reprojections: [] as Array<[number[] | null, unknown]>,
    raytracedIrradiance: placeholder,
    raytracedGBuffer: null,
    setRaytraced(t: unknown) { pipe.raytraced = t; },
    setRaytracedIrradiance(t: unknown) { pipe.irradianceSets.push(t); },
    setRaytracedReprojection(vp: Float32Array | null, g: unknown) { pipe.reprojections.push([vp ? Array.from(vp) : null, g]); },
  } as unknown as FakeDeps['pipe'];
  const d: FakeDeps = {
    modeActive: true,
    ready: true,
    fallbacks: 0,
    warnings: [],
    statuses: [],
    pipe,
    backends: [],
    makeBackend: async () => {
      const b = createFakeRaytracedBackend();
      d.backends.push(b);
      return b;
    },
    factory: () => () => d.makeBackend(),
    ensurePipeline: () => pipe,
    pipeline: () => pipe,
    isModeActive: () => d.modeActive,
    sceneReady: () => d.ready,
    whenSceneReady: () => Promise.resolve(),
    fallbackToDefault: () => { d.fallbacks++; d.modeActive = false; },
    requestRender: () => {},
    status: (t) => { d.statuses.push(t); },
    subscribe: () => () => {},
    warn: (m) => { d.warnings.push(m); },
    yieldMacrotask: () => Promise.resolve(),
    scene: {
      renderer: {},
      scene: {} as RaytracedSceneHost['scene'],
      camera: () => ({}) as ReturnType<RaytracedSceneHost['camera']>,
      modelRoot: () => null,
      environment: () => ({ hdrUrl: 'x.hdr', rotation: {} as never, intensity: 1 }),
      groundPlane: () => null,
      deviceLimits: () => null,
    },
  };
  return d;
}

describe('RaytracedModeController (plan-762 F7, fake deps)', () => {
  it('enters: factory → status → setup → ready, composite bound once', async () => {
    const d = fakeDeps();
    const c = new RaytracedModeController(d);
    await c.enter();
    expect(d.backends).toHaveLength(1);
    expect(d.backends[0].calls.setup).toBe(1);
    expect(c.ready).toBe(true);
    expect(c.phase).toBe('ready');
    expect(d.pipe.raytraced, 'enabled with the placeholder until the backend binds').toBe(d.pipe.raytracedIrradiance);
    expect(d.statuses).toEqual(['Building ray tracing structure…', null]);
    expect(c.stats()).toMatchObject({ active: true, ready: true, epoch: c.epoch, phase: 'ready' });
  });

  it('a second enter() while live is a no-op', async () => {
    const d = fakeDeps();
    const c = new RaytracedModeController(d);
    await c.enter();
    await c.enter();
    expect(d.backends).toHaveLength(1);
  });

  it('exit during a pending setup disposes exactly once and never enables the composite', async () => {
    const d = fakeDeps();
    const gate = deferred<void>();
    d.makeBackend = async () => {
      const b = createFakeRaytracedBackend({ setup: () => gate.promise });
      d.backends.push(b);
      return b;
    };
    const c = new RaytracedModeController(d);
    const entering = c.enter();
    await flush();
    expect(d.backends[0].calls.setup).toBe(1);
    c.exit();
    gate.resolve();
    await entering;
    expect(d.backends[0].calls.dispose).toBe(1);
    expect(d.pipe.raytraced).toBeNull();
    expect(c.ready).toBe(false);
    expect(c.backend).toBeNull();
  });

  it('exit during a pending factory disposes the late backend', async () => {
    const d = fakeDeps();
    const gate = deferred<RaytracedBackend>();
    d.makeBackend = () => gate.promise;
    const c = new RaytracedModeController(d);
    const entering = c.enter();
    c.exit();
    const late = createFakeRaytracedBackend();
    gate.resolve(late);
    await entering;
    expect(late.calls.setup).toBe(0);
    expect(late.calls.dispose).toBe(1);
    expect(c.backend).toBeNull();
  });

  it('toggle exit → enter yields two setups and exactly one living backend', async () => {
    const d = fakeDeps();
    const c = new RaytracedModeController(d);
    await c.enter();
    c.exit();
    await c.enter();
    expect(d.backends.map((b) => b.calls.setup)).toEqual([1, 1]);
    expect(d.backends.map((b) => b.disposed)).toEqual([true, false]);
    expect(c.backend).toBe(d.backends[1]);
  });

  it('setup failure → warning, backend disposed, default mode one microtask later', async () => {
    const d = fakeDeps();
    d.makeBackend = async () => {
      const b = createFakeRaytracedBackend({ setup: async () => { throw new Error('boom'); } });
      d.backends.push(b);
      return b;
    };
    const c = new RaytracedModeController(d);
    await c.enter();
    expect(d.backends[0].calls.dispose).toBe(1);
    expect(d.warnings.join()).toMatch(/setup failed: boom/);
    await flush(1);
    expect(d.fallbacks).toBe(1);
    expect(c.stats()).toMatchObject({ active: false, lastError: 'setup failed: boom' });
  });

  it('a stale onFatal (the user already left) changes nothing', async () => {
    const d = fakeDeps();
    const c = new RaytracedModeController(d);
    await c.enter();
    const host = d.backends[0].host!;
    c.exit(); // user switched to toon
    d.modeActive = false;
    host.onFatal('late failure');
    await flush(1);
    expect(d.fallbacks).toBe(0);
    expect(d.warnings).toEqual([]);
  });

  it('onFatal after the user re-entered does not tear down the new entry', async () => {
    const d = fakeDeps();
    const c = new RaytracedModeController(d);
    await c.enter();
    const oldHost = d.backends[0].host!;
    c.exit();
    await c.enter();
    oldHost.onFatal('stale');
    await flush(1);
    expect(c.ready).toBe(true);
    expect(d.backends[1].disposed).toBe(false);
    expect(d.fallbacks).toBe(0);
  });

  it('without a ready scene it waits; onSceneReady enters', async () => {
    const d = fakeDeps();
    d.ready = false;
    const c = new RaytracedModeController(d);
    await c.enter();
    expect(d.backends).toHaveLength(0);
    expect(c.phase).toBe('waiting-scene');
    d.ready = true;
    c.onSceneReady();
    await flush();
    expect(d.backends).toHaveLength(1);
    expect(c.ready).toBe(true);
  });

  it('model-cleared drops the backend but keeps waiting; scene ready re-enters', async () => {
    const d = fakeDeps();
    const c = new RaytracedModeController(d);
    await c.enter();
    c.onModelCleared();
    expect(d.backends[0].calls.dispose).toBe(1);
    expect(d.pipe.raytraced).toBeNull();
    expect(c.phase).toBe('waiting-scene');
    c.onSceneReady();
    await flush();
    expect(d.backends).toHaveLength(2);
    expect(d.backends[1].calls.setup).toBe(1);
  });

  it('no factory → the unavailable message, fallback', async () => {
    const d = fakeDeps();
    d.factory = () => null;
    const c = new RaytracedModeController(d);
    await c.enter();
    await flush(1);
    expect(d.warnings.join()).toContain(RAYTRACED_UNAVAILABLE_MESSAGE);
    expect(d.fallbacks).toBe(1);
  });

  it('no TSL pipeline → fatal before the factory runs', async () => {
    const d = fakeDeps();
    d.ensurePipeline = () => null;
    const c = new RaytracedModeController(d);
    await c.enter();
    await flush(1);
    expect(d.backends).toHaveLength(0);
    expect(d.fallbacks).toBe(1);
  });

  it('frame() exceptions become onFatal, never escape', async () => {
    const d = fakeDeps();
    d.makeBackend = async () => {
      const b = createFakeRaytracedBackend({ frame: () => { throw new Error('kernel'); } });
      d.backends.push(b);
      return b;
    };
    const c = new RaytracedModeController(d);
    await c.enter();
    expect(() => c.frame()).not.toThrow();
    expect(c.backend).toBeNull();
    await flush(1);
    expect(d.fallbacks).toBe(1);
  });

  it('resize forwards real sizes only and notifies host resize listeners', async () => {
    const d = fakeDeps();
    const c = new RaytracedModeController(d);
    await c.enter();
    const onResize = vi.fn();
    d.backends[0].host!.on('resize', onResize);
    c.resize(0, 0);
    c.resize(640, 0);
    c.resize(800, 600);
    expect(d.backends[0].calls.resize).toEqual([[800, 600]]);
    expect(onResize).toHaveBeenCalledTimes(1);
  });

  it('host irradiance binds through the pipeline only while live', async () => {
    const d = fakeDeps();
    const c = new RaytracedModeController(d);
    await c.enter();
    const host = d.backends[0].host!;
    const tex = { isTexture: true } as never;
    host.setIrradianceTexture(tex);
    expect(d.pipe.irradianceSets).toEqual([tex]);
    c.exit();
    host.setIrradianceTexture(tex);
    expect(d.pipe.irradianceSets).toEqual([tex]);
    expect(host.gbuffer()).toBeNull();
  });

  it('host irradiance reprojection (plan-767 F9) is copied, forwarded while live and dropped on exit', async () => {
    const d = fakeDeps();
    const c = new RaytracedModeController(d);
    await c.enter();
    const host = d.backends[0].host!;
    const geo = { isTexture: true, name: 'geo' } as never;
    const vp = new Float32Array(16).fill(2);
    host.setIrradianceReprojection(vp, geo);
    vp.fill(3); // the host keeps its own copy
    expect(d.pipe.reprojections.at(-1)).toEqual([new Array(16).fill(2), geo]);
    host.setIrradianceReprojection(null, null);
    expect(d.pipe.reprojections.at(-1)).toEqual([null, null]);
    c.exit();
    const n = d.pipe.reprojections.length;
    host.setIrradianceReprojection(vp, geo);
    expect(d.pipe.reprojections.length).toBe(n);
  });

  it('dispose() disposes the backend and blocks later entries', async () => {
    const d = fakeDeps();
    const c = new RaytracedModeController(d);
    await c.enter();
    c.dispose();
    expect(d.backends[0].calls.dispose).toBe(1);
    await c.enter();
    expect(d.backends).toHaveLength(1);
  });
});

// ─── 3. Real viewer (webgpu-gl, hasCompute forced) ───────────────────────────

let handle: TestViewerHandle | null = null;
afterEach(() => {
  handle?.dispose();
  handle = null;
});

interface RtViewerInternals {
  _raytraced: RaytracedModeController;
  _postProcessing: { useTslPost: boolean; tslPost: { raytracedReady: boolean; raytracedMix: number } | null };
  _onWebGPUDeviceLost(info: { reason?: string | null; message?: string }): void;
}

async function rtViewer(opts: { autoResize?: boolean } = {}): Promise<RVViewer> {
  handle = await createTestViewer('webgpu-gl', { autoResize: opts.autoResize ?? false });
  const viewer = handle.viewer;
  Object.defineProperty(viewer, 'hasCompute', { value: true, configurable: true });
  viewer.loop.stop();
  await loadVideoFixture(viewer);
  await viewer.whenSceneReady();
  return viewer;
}

function internals(viewer: RVViewer): RtViewerInternals {
  return viewer as unknown as RtViewerInternals;
}

/** Register a factory that records every backend it hands out. */
function recordingFactory(overrides: Partial<RaytracedBackend> = {}): FakeRaytracedBackend[] {
  const made: FakeRaytracedBackend[] = [];
  registerRaytracedBackend(async () => {
    const b = createFakeRaytracedBackend(overrides);
    made.push(b);
    return b;
  });
  return made;
}

describe('ray traced mode in a real viewer (plan-762 § 9.4 / § 9.10, webgpu-gl)', () => {
  it('enter → one setup; frame() once per TSL render; exit → one dispose', async () => {
    const viewer = await rtViewer();
    const made = recordingFactory();
    setRenderMode(viewer, 'raytraced');
    expect(viewer.renderMode).toBe('raytraced');
    await flush();
    expect(made).toHaveLength(1);
    expect(made[0].calls.setup).toBe(1);
    const pp = internals(viewer)._postProcessing;
    expect(pp.tslPost?.raytracedReady).toBe(true);
    expect(pp.useTslPost).toBe(true);
    expect(viewer.raytracedStats).toMatchObject({ active: true, ready: true, phase: 'ready' });

    const before = made[0].calls.frame;
    const afterBefore = made[0].calls.afterRender;
    made[0].calls.order.length = 0;
    expect(viewer.renderFrameForCapture()).toBe(true);
    expect(viewer.renderFrameForCapture()).toBe(true);
    expect(made[0].calls.frame - before).toBe(2);
    // plan-767 F3 / M3: afterRender once per dispatching render, AFTER the pipeline render
    expect(made[0].calls.afterRender - afterBefore).toBe(2);
    expect(made[0].calls.order).toEqual(['frame', 'afterRender', 'frame', 'afterRender']);
    expect(made[0].host!.gbuffer(), 'the MRT pass rendered → a G-buffer exists').not.toBeNull();

    setRenderMode(viewer, 'default');
    expect(made[0].calls.dispose).toBe(1);
    expect(pp.tslPost?.raytracedReady).toBe(false);
    viewer.renderFrameForCapture();
    expect(made[0].calls.frame - before).toBe(2);
    expect(viewer.raytracedStats.active).toBe(false);
  }, VIEWER_TEST_TIMEOUT);

  it('Shaded with shadows → Ray traced → Shaded keeps rendering (plan-767 run 4: no disposed ShadowNode)', async () => {
    // three r185: castShadow = false with the light still in the scene makes AnalyticLightNode.setup
    // dispose the SHARED ShadowNode; back in Shaded the render-object cache key is the old one, the
    // cached builder state still holds the disposed node and every frame threw in updateShadow
    // (grey canvas until reload). Node renderers now gate shadows by renderer.shadowMap.enabled only.
    const viewer = await rtViewer();
    viewer.currentModelRoot?.traverse((o) => { if ((o as { isMesh?: boolean }).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    const errors: string[] = [];
    const err = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
    try {
      setRenderMode(viewer, 'default');
      viewer.shadowEnabled = true;
      const dirLight = (viewer as unknown as { dirLight: { castShadow: boolean } }).dirLight;
      expect(viewer.renderFrameForCapture()).toBe(true);
      expect(viewer.renderFrameForCapture()).toBe(true);
      recordingFactory();
      setRenderMode(viewer, 'raytraced');
      await flush();
      viewer.renderFrameForCapture();
      viewer.renderFrameForCapture();
      expect(viewer.shadowEnabled).toBe(false);
      expect(dirLight.castShadow, 'castShadow is never cleared on a node renderer').toBe(true);
      setRenderMode(viewer, 'default');
      viewer.shadowEnabled = true;
      expect(viewer.renderFrameForCapture()).toBe(true);
      expect(viewer.renderFrameForCapture()).toBe(true);
      // shadows off → on inside Shaded hit the same cache path
      viewer.shadowEnabled = false;
      viewer.renderFrameForCapture();
      viewer.shadowEnabled = true;
      viewer.renderFrameForCapture();
      expect(errors.filter((e) => /render pass failed|updateShadow|depthTexture|Destroyed texture/i.test(e))).toEqual([]);
    } finally {
      err.mockRestore();
    }
  }, VIEWER_TEST_TIMEOUT);

  it('discards a backend whose setup resolves after the mode was left', async () => {
    const viewer = await rtViewer();
    const gate = deferred<void>();
    const made = recordingFactory({ setup: () => gate.promise });
    setRenderMode(viewer, 'raytraced');
    await flush();
    expect(made[0].calls.setup).toBe(1);
    setRenderMode(viewer, 'default');
    gate.resolve();
    await flush();
    expect(made[0].calls.dispose).toBe(1);
    expect(internals(viewer)._postProcessing.tslPost?.raytracedReady ?? false).toBe(false);
  }, VIEWER_TEST_TIMEOUT);

  it('raytraced → toon → raytraced: two setups, one living backend', async () => {
    const viewer = await rtViewer();
    const made = recordingFactory();
    setRenderMode(viewer, 'raytraced');
    await flush();
    setRenderMode(viewer, 'toon');
    setRenderMode(viewer, 'raytraced');
    await flush();
    expect(made.map((b) => b.calls.setup)).toEqual([1, 1]);
    expect(made.map((b) => b.disposed)).toEqual([true, false]);
  }, VIEWER_TEST_TIMEOUT);

  it('setup failure → warning and the default mode', async () => {
    const viewer = await rtViewer();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      recordingFactory({ setup: async () => { throw new Error('no adapter limits'); } });
      setRenderMode(viewer, 'raytraced');
      await flush();
      expect(viewer.renderMode).toBe('default');
      expect(warn.mock.calls.flat().join(' ')).toMatch(/Ray traced mode failed: setup failed: no adapter limits/);
      expect(viewer.raytracedStats).toMatchObject({ active: false, lastError: 'setup failed: no adapter limits' });
    } finally {
      warn.mockRestore();
    }
  }, VIEWER_TEST_TIMEOUT);

  it('onFatal after a user switch does not override the user mode', async () => {
    const viewer = await rtViewer();
    const made = recordingFactory();
    setRenderMode(viewer, 'raytraced');
    await flush();
    const host = made[0].host!;
    setRenderMode(viewer, 'toon');
    host.onFatal('late');
    await flush();
    expect(viewer.renderMode).toBe('toon');
  }, VIEWER_TEST_TIMEOUT);

  it('frame() throwing → default mode, the render loop keeps rendering (no recovery path)', async () => {
    const viewer = await rtViewer();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      recordingFactory({ frame: () => { throw new Error('kernel exploded'); } });
      setRenderMode(viewer, 'raytraced');
      await flush();
      expect(viewer.renderFrameForCapture(), 'the frame itself must not fail').toBe(true);
      await flush();
      expect(viewer.renderMode).toBe('default');
      expect(viewer.renderFrameForCapture()).toBe(true);
    } finally {
      warn.mockRestore();
    }
  }, VIEWER_TEST_TIMEOUT);

  it('model-cleared → dispose, mode stays; the next placements-materialized → setup again', async () => {
    const viewer = await rtViewer();
    const made = recordingFactory();
    setRenderMode(viewer, 'raytraced');
    await flush();
    let materialized = 0;
    viewer.on('placements-materialized', () => { materialized++; });
    let setupsAtModelLoaded = -1;
    viewer.on('model-loaded', () => { setupsAtModelLoaded = made.length; });

    viewer.clearModel();
    expect(made[0].calls.dispose).toBe(1);
    expect(viewer.renderMode).toBe('raytraced');
    expect(internals(viewer)._postProcessing.tslPost?.raytracedReady).toBe(false);
    expect(viewer.raytracedStats.phase).toBe('waiting-scene');

    await loadVideoFixture(viewer);
    await viewer.whenSceneReady();
    await flush();
    expect(materialized).toBeGreaterThan(0);
    expect(setupsAtModelLoaded, 'not rebuilt at model-loaded').toBe(1);
    expect(made).toHaveLength(2);
    expect(made[1].calls.setup).toBe(1);
    expect(made[1].disposed).toBe(false);
  }, VIEWER_TEST_TIMEOUT);

  it('entering without a model does not set up until the scene is ready', async () => {
    handle = await createTestViewer('webgpu-gl');
    const viewer = handle.viewer;
    Object.defineProperty(viewer, 'hasCompute', { value: true, configurable: true });
    viewer.loop.stop();
    const made = recordingFactory();
    setRenderMode(viewer, 'raytraced');
    await flush();
    expect(made).toHaveLength(0);
    expect(viewer.raytracedStats.phase).toBe('waiting-scene');
    await loadVideoFixture(viewer);
    await viewer.whenSceneReady();
    await flush();
    expect(made).toHaveLength(1);
    expect(made[0].calls.setup).toBe(1);
  }, VIEWER_TEST_TIMEOUT);

  it('resize → backend.resize(w, h) in drawing-buffer pixels', async () => {
    const viewer = await rtViewer({ autoResize: true });
    const made = recordingFactory();
    setRenderMode(viewer, 'raytraced');
    await flush();
    handle!.container.style.width = '400px';
    handle!.container.style.height = '300px';
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    await flush();
    const pr = (viewer.renderer as unknown as { getPixelRatio(): number }).getPixelRatio();
    expect(made[0].calls.resize).toContainEqual([Math.floor(400 * pr), Math.floor(300 * pr)]);
  }, VIEWER_TEST_TIMEOUT);

  it('viewer.dispose() → backend.dispose()', async () => {
    const viewer = await rtViewer();
    const made = recordingFactory();
    setRenderMode(viewer, 'raytraced');
    await flush();
    handle!.dispose();
    handle = null;
    expect(made[0].calls.dispose).toBe(1);
    void viewer;
  }, VIEWER_TEST_TIMEOUT);

  it('device.lost: "destroyed" is ignored, any other reason emits renderer-context-lost and drops the backend', async () => {
    const viewer = await rtViewer();
    const made = recordingFactory();
    setRenderMode(viewer, 'raytraced');
    await flush();
    let lost = 0;
    viewer.on('renderer-context-lost', () => { lost++; });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      internals(viewer)._onWebGPUDeviceLost({ reason: 'destroyed' });
      expect(lost).toBe(0);
      expect(made[0].calls.dispose).toBe(0);
      internals(viewer)._onWebGPUDeviceLost({ reason: 'unknown', message: 'TDR' });
      expect(lost).toBe(1);
      expect(made[0].calls.dispose).toBe(1);
    } finally {
      errSpy.mockRestore();
    }
  }, VIEWER_TEST_TIMEOUT);

  it('F17: wireframe pauses frame() and sets the composite mix to 0', async () => {
    const viewer = await rtViewer();
    const made = recordingFactory();
    viewer.modes
      .register({ id: 'viewer', label: 'Viewer', order: 5 })
      .register({ id: 'editor', label: 'Editor', order: 40, runtime: 'detached' });
    setRenderMode(viewer, 'raytraced');
    await flush();
    const tsl = internals(viewer)._postProcessing.tslPost!;
    viewer.renderFrameForCapture();
    expect(tsl.raytracedMix).toBe(1);
    const frames = made[0].calls.frame;

    viewer.modes.setMode('editor');
    viewer.wireframe = true;
    expect(viewer.wireframeActive).toBe(true);
    expect(viewer.renderMode).toBe('raytraced');
    viewer.renderFrameForCapture();
    expect(made[0].calls.frame).toBe(frames);
    expect(tsl.raytracedMix).toBe(0);

    viewer.wireframe = false;
    viewer.renderFrameForCapture();
    expect(made[0].calls.frame).toBe(frames + 1);
    expect(tsl.raytracedMix).toBe(1);
  }, VIEWER_TEST_TIMEOUT);

  it('requestRender from inside frame() keeps the viewer dirty for the next frame (F11)', async () => {
    const viewer = await rtViewer();
    let host: RaytracedSceneHost | null = null;
    recordingFactory({
      setup: async (h) => { host = h; },
      frame: () => { host?.requestRender(); },
    });
    setRenderMode(viewer, 'raytraced');
    await flush();
    viewer.renderFrameForCapture();
    expect((viewer as unknown as { _renderDirty: boolean })._renderDirty).toBe(true);
  }, VIEWER_TEST_TIMEOUT);
});
