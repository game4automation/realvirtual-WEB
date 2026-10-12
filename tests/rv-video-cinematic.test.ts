// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-550 F1–F3, F9, F11, F14 — the cinematic branch of the deterministic
 * capture, driven by a FAKE frame source (no GPU, no path tracer): the frame
 * sink gets exactly `frames − startFrame` PNGs with their indices, a resumed
 * run reaches the same simulation state per frame as an uninterrupted one
 * (MU count / positions, drive position, sim time), the raster path is
 * unchanged, a build without a provider refuses with the commercial-feature
 * message, an abort / a resumable error leaves the frames written so far, and
 * the viewer is restored in every case.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Mesh, MeshStandardMaterial, Object3D, Scene, Vector3 } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { SLIDE_PATH } from './helpers/video-capture-fixture';
import { normalizeMotionBlur, normalizeVideoOptions, recordVideo, resolveSetupBlur, withBackstop, type VideoRecordOptions } from '../src/core/engine/rv-video-capture';
import { cameraSubTime, createCameraPathPose, createOrbitPath, createPresetPath } from '../src/core/engine/rv-video-camera-path';
import {
  CINEMATIC_UNAVAILABLE_MESSAGE,
  CinematicResumableError,
  cinematicStallTimeoutMs,
  isResumableCinematicError,
  registerCinematicRenderer,
  type CinematicFrameSource,
  type CinematicFrameStats,
  type CinematicLookRequest,
  CINEMATIC_DEFAULT_FSTOP,
  CINEMATIC_DEFAULT_LOOK,
  CINEMATIC_DEFAULT_VIGNETTE,
  CINEMATIC_DEFAULT_BLUR_SUBFRAMES,
  CINEMATIC_DEFAULT_MOTION_BLUR,
  CINEMATIC_DEFAULT_SHUTTER_DEG,
  watchdogElapsedMs,
  type CinematicFrameContext,
  type CinematicMotionRecorder,
  type CinematicSetupInfo,
} from '../src/core/engine/rv-cinematic-hook';
import { LOOK_OPTION_DEFAULTS, MOTION_BLUR_DEFAULTS, compareManifest } from '../src/core/engine/rv-cinematic-manifest.mjs';
import type { RVViewer } from '../src/core/rv-viewer';

let handle: TestViewerHandle;
let viewer: RVViewer;

/** The plan-537 fixture plus a Source that spawns an MU every 0.2 s. */
async function cinematicFixtureGlb(): Promise<ArrayBuffer> {
  const box = (name: string, size: [number, number, number], color: number, pos: [number, number, number]): Mesh => {
    const m = new Mesh(new BoxGeometry(...size), new MeshStandardMaterial({ color, roughness: 0.6 }));
    m.name = name;
    m.position.set(...pos);
    return m;
  };
  const scene = new Scene();
  const cell = new Object3D();
  cell.name = 'Cell';
  scene.add(cell);
  cell.add(box('Floor', [4, 0.1, 4], 0x808890, [0, -0.05, 0]));
  const slide = new Object3D();
  slide.name = 'Slide';
  slide.position.set(-1.2, 0.25, 0);
  slide.userData.realvirtual = { Drive: { Direction: 'LinearX', TargetSpeed: 500, JogForward: true } };
  slide.add(box('Block', [0.5, 0.5, 0.5], 0xd02020, [0, 0, 0]));
  cell.add(slide);
  const feeder = box('Feeder', [0.1, 0.1, 0.1], 0x20a040, [1, 0.3, 1]);
  // Unity Source semantics (an `Enabled` field) — spawns on the interval without a transport surface.
  feeder.userData.realvirtual = { Source: { Enabled: true, GenerateMU: true, AutomaticGeneration: true, Interval: 0.2 } };
  cell.add(feeder);
  return (await new GLTFExporter().parseAsync(scene, { binary: true })) as ArrayBuffer;
}

/** 1×1 PNG. */
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/eL9GtQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

interface FrameState { sim: number; slideX: number; mus: string[] }

/** What the fake source sees at each rendered frame. */
function stateOf(v: RVViewer): FrameState {
  const node = v.registry!.getNode(SLIDE_PATH)!;
  const p = new Vector3();
  const mus = (v.transportManager?.mus ?? []).map((mu) => {
    mu.getWorldPosition(p);
    return `${p.x.toFixed(5)},${p.y.toFixed(5)},${p.z.toFixed(5)}`;
  });
  return { sim: v.simTime, slideX: node.getWorldPosition(new Vector3()).x, mus };
}

class FakeSource implements CinematicFrameSource {
  readonly info = { renderer: 'fake', tracerVersion: '0', denoiserVersion: 'none' };
  setupAt: number | null = null;
  disposed = false;
  readonly states = new Map<number, FrameState>();
  failAt = -1;
  constructor(private readonly v: RVViewer) {}
  async setup(): Promise<CinematicSetupInfo> {
    this.setupAt = this.v.simTime;
    return { tracedMeshes: 3, triangles: 36, skipped: {}, missing: [], adapter: 'fake', setupMs: 1 };
  }
  async renderFrame(i: number) {
    if (i === this.failAt) throw new CinematicResumableError(`Frame ${i} stalled: fake`);
    this.states.set(i, stateOf(this.v));
    const stats: CinematicFrameStats = { samples: 4, ms: 2, traceMs: 1, denoiseMs: 0, sceneChange: 'none' };
    return { png: PNG, stats };
  }
  async dispose() { this.disposed = true; }
}

let source: FakeSource | null = null;

function loopRunning(v: RVViewer): boolean {
  return (v as unknown as { loop: { running: boolean } }).loop.running;
}

const BASE: VideoRecordOptions = {
  width: 160, height: 90, fps: 30, seconds: 0.5, warmupSeconds: 0.25, quality: 'cinematic', samples: 4,
  denoise: 'off', path: { kind: 'fixed' },
};

async function run(extra: Partial<VideoRecordOptions> = {}): Promise<{ indices: number[]; result: Awaited<ReturnType<typeof recordVideo>> }> {
  const indices: number[] = [];
  const result = await recordVideo(viewer, {
    ...BASE,
    frameSink: (i, png) => { expect(png.byteLength).toBeGreaterThan(8); indices.push(i); },
    ...extra,
  });
  return { indices, result };
}

beforeAll(async () => {
  handle = await createTestViewer('webgl', { width: 400, height: 300 });
  viewer = handle.viewer;
  await viewer.loadModel('cinematic-fixture.glb', { data: await cinematicFixtureGlb() });
}, 120_000);

afterAll(() => {
  registerCinematicRenderer(null);
  handle?.dispose();
});

beforeEach(() => {
  viewer.resetSimulation();
  source = null;
  registerCinematicRenderer(async () => (source = new FakeSource(viewer)));
});

afterEach(() => {
  expect(viewer.isCapturing).toBe(false);
});

describe('options (F1/F14)', () => {
  it('cinematic normalises without supersample / jitter / byte budget; defaults 64 spp + aux', () => {
    const n = normalizeVideoOptions({ seconds: 10, fps: 30, quality: 'cinematic', maxBytes: 1 });
    expect(n.supersample).toBe(1);
    expect(n.jitter).toBe(0);
    expect(n.samples).toBe(64);
    expect(n.denoise).toBe('aux');
    expect(n.startFrame).toBe(0);
    expect(() => normalizeVideoOptions({ seconds: 1, fps: 30, quality: 'cinematic', startFrame: 30 })).toThrow(/startFrame/);
    expect(() => normalizeVideoOptions({ seconds: 1, fps: 30, quality: 'cinematic', denoise: 'x' as never })).toThrow(/denoise/);
    expect(() => normalizeVideoOptions({ seconds: 1, fps: 30, quality: 'high', samples: 8 })).toThrow(/cinematic/);
    // raster qualities unchanged
    expect(normalizeVideoOptions({ seconds: 1, fps: 30, quality: 'max' }).jitter).toBe(4);
  });

  it('watchdog rule: first frame 300 s, then 10 × the last frame, at least 120 s', () => {
    expect(cinematicStallTimeoutMs(null)).toBe(300_000);
    expect(cinematicStallTimeoutMs(5_000)).toBe(120_000);
    expect(cinematicStallTimeoutMs(22_000)).toBe(220_000);
  });
});

describe('no provider (community build)', () => {
  it('refuses cinematic with the commercial-feature message and leaves the viewer untouched', async () => {
    registerCinematicRenderer(null);
    await expect(run()).rejects.toThrow(CINEMATIC_UNAVAILABLE_MESSAGE);
    expect(loopRunning(viewer)).toBe(true);
  });
});

describe('frame sink (F3)', () => {
  it('receives exactly frames − startFrame PNGs with their indices; restores the viewer; disposes the source', async () => {
    const all = await run();
    expect(all.indices).toEqual(Array.from({ length: 15 }, (_, i) => i));
    expect(all.result.bytes.byteLength).toBe(0);
    expect(all.result.cinematic!.framesRendered).toBe(15);
    expect(source!.disposed).toBe(true);
    expect(loopRunning(viewer)).toBe(true);

    viewer.resetSimulation();
    const resumed = await run({ startFrame: 5 });
    expect(resumed.indices).toEqual(Array.from({ length: 10 }, (_, i) => i + 5));
    expect(resumed.result.cinematic!.startFrame).toBe(5);
  }, 60_000);

  it('the context fingerprint reaches onCinematicContext before the warmup; a throw there refuses the run', async () => {
    let ctxSim = -1;
    let setupSim = -1;
    let fp: Record<string, unknown> | null = null;
    const r = await run({ onCinematicContext: (c) => { fp = c as never; ctxSim = viewer.simTime; }, onCinematicSetup: () => { setupSim = viewer.simTime; } });
    // before the warmup (0.25 s) — the setup runs after it
    expect(ctxSim).toBeLessThan(setupSim);
    expect(setupSim).toBeCloseTo(r.result.simStart, 9);
    expect(fp).toMatchObject({ renderer: 'fake', hdr: 'envmaps/empty_warehouse_01_1k.hdr' });
    expect(String((fp as { modelHash: string } | null)?.modelHash)).toMatch(/^[0-9a-f]{32}$/);
    expect(String((fp as { hdrHash: string } | null)?.hdrHash)).toMatch(/^[0-9a-f]{64}$/);

    viewer.resetSimulation();
    await expect(run({ onCinematicContext: () => { throw new Error('"modelHash" differs'); } })).rejects.toThrow(/modelHash/);
    expect(source!.disposed).toBe(true);
  }, 60_000);
});

describe('resume equivalence (F9)', () => {
  it('a run resumed at frame k reaches the same MU positions, drive position and sim time per frame', async () => {
    await run({ seconds: 1 });
    const full = source!.states;
    expect(full.get(29)!.mus.length).toBeGreaterThan(2); // the source spawned
    viewer.resetSimulation();
    const k = 17;
    await run({ seconds: 1, startFrame: k });
    const resumed = source!.states;
    expect([...resumed.keys()][0]).toBe(k);
    for (let i = k; i < 30; i++) {
      const a = full.get(i)!;
      const b = resumed.get(i)!;
      expect(b.sim).toBeCloseTo(a.sim, 12);
      expect(b.slideX).toBeCloseTo(a.slideX, 9);
      expect(b.mus).toEqual(a.mus);
    }
  }, 60_000);
});

describe('stops (F3/F11)', () => {
  it('an abort after frame i leaves frames 0..i delivered and restores the viewer', async () => {
    const ac = new AbortController();
    const indices: number[] = [];
    await expect(recordVideo(viewer, {
      ...BASE,
      signal: ac.signal,
      frameSink: (i) => { indices.push(i); if (i === 3) ac.abort(); },
    })).rejects.toThrow(/Recording aborted/);
    expect(indices).toEqual([0, 1, 2, 3]);
    expect(source!.disposed).toBe(true);
    expect(loopRunning(viewer)).toBe(true);
  }, 60_000);

  it('a resumable source error (stall / device lost) propagates as resumable after the frames before it', async () => {
    registerCinematicRenderer(async () => {
      source = new FakeSource(viewer);
      source.failAt = 6;
      return source;
    });
    const indices: number[] = [];
    const err = await recordVideo(viewer, { ...BASE, frameSink: (i) => { indices.push(i); } }).catch((e) => e);
    expect(isResumableCinematicError(err)).toBe(true);
    expect(indices).toEqual([0, 1, 2, 3, 4, 5]);
    expect(source!.disposed).toBe(true);
    expect(loopRunning(viewer)).toBe(true);
  }, 60_000);

  it('a source whose dispose throws never skips endCapture', async () => {
    registerCinematicRenderer(async () => {
      const s = new FakeSource(viewer);
      s.dispose = async () => { throw new Error('dispose failed'); };
      return s;
    });
    await run();
    expect(viewer.isCapturing).toBe(false);
    expect(loopRunning(viewer)).toBe(true);
  }, 60_000);

  it('a cinematic request without frameSink is refused before the capture starts', async () => {
    await expect(recordVideo(viewer, BASE)).rejects.toThrow(/frameSink/);
  });
});

describe('detached buffers (F4) — the copy waits for the async BVH build', () => {
  it('recordVideo awaits whenBvhIdle before the fingerprint and before the scene copy', async () => {
    const order: string[] = [];
    const own = viewer as unknown as { whenBvhIdle?: (t?: number) => Promise<void> };
    const proto = Object.getPrototypeOf(viewer).whenBvhIdle as (t?: number) => Promise<void>;
    own.whenBvhIdle = async (t?: number) => { order.push('idle'); await proto.call(viewer, t); order.push('idle-done'); };
    registerCinematicRenderer(async () => {
      const s = new FakeSource(viewer);
      const setup = s.setup.bind(s);
      s.setup = async () => { order.push('setup'); return setup(); };
      return (source = s);
    });
    try {
      await run({ onCinematicContext: () => { order.push('context'); } });
    } finally {
      delete own.whenBvhIdle;
    }
    // before the fingerprint (it samples positions) and again before the copy
    expect(order).toEqual(['idle', 'idle-done', 'context', 'idle', 'idle-done', 'setup']);
  }, 60_000);

  it('BVHBuildPort.whenIdle resolves only after every queued build', async () => {
    const { createInlineBVHPort } = await import('../src/core/engine/rv-bvh-build-port');
    const port = createInlineBVHPort();
    let done = 0;
    for (let i = 0; i < 3; i++) void port.generate(new BoxGeometry(1, 1, 1, 8, 8, 8)).then(() => { done++; });
    await port.whenIdle!();
    expect(done).toBe(3);
    port.dispose();
  });
});

describe('raster path unchanged', () => {
  it('quality standard still encodes an MP4 with a provider registered', async () => {
    const r = await recordVideo(viewer, { ...BASE, quality: 'standard', samples: undefined, denoise: undefined, width: 160, height: 96 });
    expect(r.bytes.byteLength).toBeGreaterThan(100);
    expect(r.cinematic).toBeUndefined();
    expect(source).toBeNull();
  }, 60_000);
});

// ─── plan-551 ──────────────────────────────────────────────────────────────

describe('cinematic start = simulation reset (plan-551 F19)', () => {
  it('a resumed run with resetSimulation equals an uninterrupted one although the live sim ran on in between', async () => {
    await run({ seconds: 1, resetSimulation: true });
    const full = source!.states;
    // The interrupted UI run hands the viewer back: the live loop keeps simulating.
    const after = viewer.simTime;
    await new Promise((r) => setTimeout(r, 600));
    const drifted = viewer.simTime > after;
    const k = 13;
    await run({ seconds: 1, startFrame: k, resetSimulation: true });
    const resumed = source!.states;
    for (let i = k; i < 30; i++) {
      const a = full.get(i)!;
      const b = resumed.get(i)!;
      expect(b.sim).toBeCloseTo(a.sim, 12);
      expect(b.slideX).toBeCloseTo(a.slideX, 9);
      expect(b.mus).toEqual(a.mus);
    }
    // Control: without the reset the drifted state leaks into the resumed frames.
    if (drifted) {
      await new Promise((r) => setTimeout(r, 300));
      await run({ seconds: 1, startFrame: k });
      expect(source!.states.get(k)!.sim).not.toBeCloseTo(full.get(k)!.sim, 6);
    }
  }, 60_000);

  it('the camera is resolved BEFORE the reset (from the current view)', async () => {
    const order: string[] = [];
    const v = viewer as unknown as Record<string, unknown>;
    const reset = viewer.resetSimulation.bind(viewer);
    const camState = viewer.getCameraState.bind(viewer);
    v.resetSimulation = () => { order.push('reset'); reset(); };
    v.getCameraState = () => { order.push('camera'); return camState(); };
    let first: number[] = [];
    try {
      await run({
        resetSimulation: true,
        path: { kind: 'orbit', fromCurrentView: true },
        onCinematicContext: (c) => { first = c.cameraPoses[0]; },
      });
    } finally {
      delete v.resetSimulation;
      delete v.getCameraState;
    }
    expect(order.indexOf('camera')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('camera')).toBeLessThan(order.indexOf('reset'));
    // first pose = the camera the user looked through (the capture restores it afterwards)
    const cam = viewer.getCameraState().position;
    expect(first[0]).toBeCloseTo(cam.x, 3);
    expect(first[2]).toBeCloseTo(cam.z, 3);
  }, 60_000);
});

describe('resolved camera in the fingerprint (plan-551 F20)', () => {
  it('cameraPoses carry position, target, fov, projection and zoom', async () => {
    let poses: number[][] = [];
    await run({ path: { kind: 'fixed', position: [3, 2, 1], target: [0, 0, 0], fov: 40 }, onCinematicContext: (c) => { poses = c.cameraPoses; } });
    expect(poses).toHaveLength(3);
    expect(poses[0]).toEqual([3, 2, 1, 0, 0, 0, 40, 0, 1]);
  }, 60_000);
});

describe('hidden tab (plan-551 F22)', () => {
  let hidden = false;
  beforeAll(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  });
  afterAll(() => {
    delete (document as unknown as { hidden?: boolean }).hidden;
  });
  const setHidden = (h: boolean): void => {
    hidden = h;
    document.dispatchEvent(new Event('visibilitychange'));
  };

  it('watchdogElapsedMs is 0 while hidden and restarts when the tab comes back', () => {
    const t0 = performance.now() - 10_000;
    setHidden(true);
    expect(watchdogElapsedMs(t0)).toBe(0);
    setHidden(false);
    expect(watchdogElapsedMs(t0)).toBeLessThan(50);
  });

  it('the capture backstop does not fire while hidden; it fires when visible', async () => {
    setHidden(true);
    let settle!: (v: string) => void;
    const slow = new Promise<string>((r) => { settle = r; });
    const guarded = withBackstop(slow, 100, 7);
    setTimeout(() => { setHidden(false); settle('done'); }, 400);
    await expect(guarded).resolves.toBe('done');
    // visible all along → resumable stall error
    const stuck = withBackstop(new Promise<string>(() => { /* never */ }), 100, 8);
    const err = await stuck.catch((e) => e);
    expect(isResumableCinematicError(err)).toBe(true);
    expect(String(err.message)).toMatch(/Frame 8 did not finish/);
  });
});

// ─── plan-553 F6/F7: look options, resolved look in the fingerprint, DoF focus ──────────────

/** A frame source with looks: `resolveLook` answers from a mutable table (tests change it). */
class LookSource extends FakeSource {
  static table: Record<string, { hdr: string | null; params: Record<string, unknown> }> = {};
  static lookVersion = 1;
  setupOptions: Record<string, unknown> | null = null;
  readonly focus: Array<number | undefined> = [];
  resolveLook(req: CinematicLookRequest) {
    const t = LookSource.table[req.look] ?? { hdr: null, params: {} };
    return { look: req.look, hdr: t.hdr, params: t.params, lookVersion: LookSource.lookVersion, materialVersion: 1, fallbacks: [] };
  }
  override async setup(...args: unknown[]) {
    this.setupOptions = args[1] as Record<string, unknown>;
    return super.setup();
  }
  override async renderFrame(i: number, ctx?: { focusDistance?: number }) {
    this.focus.push(ctx?.focusDistance);
    return super.renderFrame(i);
  }
}

/** A data: URL HDR stand-in (the capture only hashes its bytes). */
const hdrData = (text: string): string => `data:application/octet-stream;base64,${btoa(text)}`;

describe('look options (plan-553 F7)', () => {
  let lookSource: LookSource | null = null;
  beforeEach(() => {
    LookSource.table = {
      studio: { hdr: hdrData('studio-hdr-v1'), params: { exposure: 1, lights: 3 } },
      viewer: { hdr: null, params: {} },
    };
    LookSource.lookVersion = 1;
    registerCinematicRenderer(async () => (lookSource = new LookSource(viewer)));
  });

  const contextOf = async (extra: Partial<VideoRecordOptions> = {}): Promise<Record<string, unknown>> => {
    let ctx: Record<string, unknown> = {};
    viewer.resetSimulation();
    await run({ seconds: 2 / 30, onCinematicContext: (c) => { ctx = c as never; }, ...extra });
    return ctx;
  };

  it('defaults: studio, vignette 0.15, DoF off, presets on; the hook defaults equal the manifest mirror', () => {
    const n = normalizeVideoOptions({ seconds: 1, fps: 30, quality: 'cinematic' });
    expect(n.look).toEqual({ look: 'studio', dof: false, fStop: 5.6, vignette: 0.15, materialPresets: true, materialOverrides: null });
    expect(LOOK_OPTION_DEFAULTS).toEqual({ look: CINEMATIC_DEFAULT_LOOK, vignette: CINEMATIC_DEFAULT_VIGNETTE, fStop: CINEMATIC_DEFAULT_FSTOP });
    expect(() => normalizeVideoOptions({ seconds: 1, fps: 30, quality: 'cinematic', look: 'disco' as never })).toThrow(/Unknown look/);
    expect(() => normalizeVideoOptions({ seconds: 1, fps: 30, quality: 'cinematic', vignette: 0.9 })).toThrow(/vignette/);
    expect(() => normalizeVideoOptions({ seconds: 1, fps: 30, quality: 'high', look: 'studio' })).toThrow(/cinematic/);
    expect(() => normalizeVideoOptions({ seconds: 1, fps: 30, quality: 'cinematic', materialOverrides: { rules: [{ match: '(', preset: 'glass' }] } })).toThrow(/regular expression/);
  });

  it('the setup receives the look options and the sampled camera path (frame 0 first)', async () => {
    viewer.resetSimulation();
    await run({ seconds: 2 / 30, dof: true, fStop: 2.8, vignette: 0.1, path: { kind: 'fixed', position: [3, 2, 1], target: [0, 0, 0] } });
    const o = lookSource!.setupOptions!;
    expect(o).toMatchObject({ look: 'studio', dof: true, fStop: 2.8, vignette: 0.1, materialPresets: true, materialOverrides: null });
    const samples = o.cameraSamples as Array<{ position: number[]; target: number[] }>;
    expect(samples.length).toBe(17);
    expect(samples[0]).toEqual({ position: [3, 2, 1], target: [0, 0, 0] });
    expect(String(o.hdrUrl)).toMatch(/^data:/); // the look HDR
  }, 60_000);

  it('the fingerprint holds the RESOLVED look: HDR bytes, params, versions, output options, override content', async () => {
    const a = await contextOf();
    expect(a.hdr).toBe(LookSource.table.studio.hdr);
    expect(a.look).toMatchObject({ name: 'studio', params: { exposure: 1, lights: 3 }, lookVersion: 1, materialVersion: 1, dof: false, fStop: null, vignette: 0.15, materialPresets: true, overridesHash: null });

    // same look name, other HDR bytes → hdrHash differs
    LookSource.table.studio.hdr = hdrData('studio-hdr-v2');
    const b = await contextOf();
    expect(b.hdrHash).not.toBe(a.hdrHash);
    expect(compareManifest(a, { ...a, hdr: a.hdr, hdrHash: b.hdrHash })).toMatch(/"hdrHash" differs/);

    // same look name, other parameters / look version → "look" differs
    LookSource.table.studio = { hdr: a.hdr as string, params: { exposure: 1.2, lights: 3 } };
    const c = await contextOf();
    expect(c.hdrHash).toBe(a.hdrHash);
    expect(compareManifest(a, c)).toMatch(/"look" differs/);
    LookSource.table.studio = { hdr: a.hdr as string, params: { exposure: 1, lights: 3 } };
    LookSource.lookVersion = 2;
    expect(compareManifest(a, await contextOf())).toMatch(/"look" differs/);
    LookSource.lookVersion = 1;

    // override CONTENT enters the fingerprint (key order irrelevant)
    const o1 = await contextOf({ materialOverrides: { rules: [{ match: 'pane', preset: 'glass', params: { roughness: 0.1, ior: 1.4 } }] } });
    const o2 = await contextOf({ materialOverrides: { rules: [{ preset: 'glass', match: 'pane', params: { ior: 1.4, roughness: 0.1 } }] } });
    const o3 = await contextOf({ materialOverrides: { rules: [{ match: 'pane', preset: 'paint' }] } });
    const h = (x: Record<string, unknown>): unknown => (x.look as { overridesHash: unknown }).overridesHash;
    expect(h(o1)).toMatch(/^[0-9a-f]{32}$/);
    expect(h(o2)).toBe(h(o1));
    expect(h(o3)).not.toBe(h(o1));
    expect(compareManifest(o1, o3)).toMatch(/"look" differs/);
  }, 120_000);

  it('--hdr wins over the look HDR (documented precedence); the look stays', async () => {
    const override = hdrData('my-own-hdr');
    const ctx = await contextOf({ hdr: override });
    expect(ctx.hdr).toBe('override');
    expect((ctx.look as { name: string }).name).toBe('studio');
    expect(String(lookSource!.setupOptions!.hdrUrl)).toBe(override);
  }, 60_000);

  it('the viewer look without its own HDR uses the viewer preset file', async () => {
    const ctx = await contextOf({ look: 'viewer' });
    expect(ctx.hdr).toBe('envmaps/empty_warehouse_01_1k.hdr');
  }, 60_000);

  it('a frame source without looks is fingerprinted as the viewer look (plan-550 sources)', async () => {
    registerCinematicRenderer(async () => (source = new FakeSource(viewer)));
    const ctx = await contextOf();
    expect(ctx.look).toMatchObject({ name: 'viewer', lookVersion: 0 });
  }, 60_000);
});

describe('depth-of-field focus per frame (plan-553 F6)', () => {
  let lookSource: LookSource | null = null;
  const PRESETS = { kind: 'presets' as const, views: [{ view: 'iso', transition: 0, hold: 0.2 }, { view: 'top', transition: 0.6, hold: 0.2 }] };
  beforeEach(() => {
    LookSource.table = { studio: { hdr: null, params: {} } };
    registerCinematicRenderer(async () => (lookSource = new LookSource(viewer)));
  });

  it('fixed: |position − target| every frame', async () => {
    viewer.resetSimulation();
    await run({ dof: true, path: { kind: 'fixed', position: [3, 4, 0], target: [0, 0, 0] } });
    expect(lookSource!.focus).toHaveLength(15);
    for (const f of lookSource!.focus) expect(f).toBeCloseTo(5, 6);
  }, 60_000);

  it('orbit: the orbit centre stays the focus target', async () => {
    viewer.resetSimulation();
    await run({ dof: true, path: { kind: 'orbit', center: [0, 0, 0], radius: 4, height: 3, sweepDeg: 90 } });
    for (const f of lookSource!.focus) expect(f).toBeCloseTo(5, 4);
  }, 60_000);

  it('presets: the focus follows the interpolated target; a resumed run gets the same focus per frame', async () => {
    viewer.resetSimulation();
    const all = await run({ dof: true, seconds: 1, path: PRESETS });
    const focus = lookSource!.focus as number[];
    expect(focus).toHaveLength(all.indices.length);
    for (const f of focus) expect(f).toBeGreaterThan(0);
    viewer.resetSimulation();
    await run({ dof: true, seconds: 1, startFrame: 10, path: PRESETS });
    const resumed = lookSource!.focus as number[];
    expect(resumed.map((f) => +f.toFixed(6))).toEqual(focus.slice(10).map((f) => +f.toFixed(6)));
  }, 120_000);
});

// ─── plan-554: motion blur — options, snapshot hook sequence, camera sub-times ────────────────

describe('motion blur options (plan-554 F1/F8, N3)', () => {
  it('defaults on / 180° / 8; the hook defaults equal the manifest mirror; ranges; shutter 0 = off', () => {
    expect(normalizeVideoOptions({ seconds: 1, fps: 30, quality: 'cinematic' }).motionBlur).toEqual({ enabled: true, shutterDeg: 180, subFrames: 8 });
    expect(MOTION_BLUR_DEFAULTS).toEqual({ enabled: CINEMATIC_DEFAULT_MOTION_BLUR, shutterDeg: CINEMATIC_DEFAULT_SHUTTER_DEG, subFrames: CINEMATIC_DEFAULT_BLUR_SUBFRAMES });
    const off = { enabled: false, shutterDeg: 0, subFrames: 1 };
    expect(normalizeMotionBlur({ shutterDeg: 0 })).toEqual(off);
    expect(normalizeMotionBlur({ enabled: false, shutterDeg: 270 })).toEqual(off);
    expect(normalizeMotionBlur({ shutterDeg: 360, subFrames: 2 })).toEqual({ enabled: true, shutterDeg: 360, subFrames: 2 });
    expect(normalizeMotionBlur({ subFrames: 32 }).subFrames).toBe(32);
    for (const bad of [{ shutterDeg: -1 }, { shutterDeg: 361 }, { subFrames: 1 }, { subFrames: 33 }, { subFrames: 2.5 }]) {
      expect(() => normalizeMotionBlur(bad)).toThrow(/motionBlur/);
    }
    // raster recordings refuse the blur options
    expect(() => normalizeVideoOptions({ seconds: 1, fps: 30, quality: 'high', motionBlur: { enabled: true } })).toThrow(/cinematic/);
  });

  it('the resolved blur: off without a request (no reason), the source answer, else off naming the missing support', () => {
    expect(resolveSetupBlur(null, undefined)).toEqual({ resolved: 'off', reason: null, subFrames: 1 });
    expect(resolveSetupBlur({ enabled: false, shutterDeg: 0, subFrames: 1 }, { resolved: 'pathA-v1', reason: null, subFrames: 8 }).resolved).toBe('off');
    expect(resolveSetupBlur({ enabled: true, shutterDeg: 180, subFrames: 8 }, undefined)).toMatchObject({ resolved: 'off', reason: expect.stringMatching(/does not support/) });
    expect(resolveSetupBlur({ enabled: true, shutterDeg: 180, subFrames: 8 }, { resolved: 'pathA-v1', reason: null, subFrames: 4 })).toEqual({ resolved: 'pathA-v1', reason: null, subFrames: 4 });
  });
});

describe('camera sub-times and cuts (plan-554 F3b)', () => {
  it('cutTimes() lists only zero-transition boundaries; a cut inside the shutter holds the post-cut pose; frame 0 clamps', () => {
    const k = (x: number) => ({ position: new Vector3(x, 1, 5), target: new Vector3(0, 0, 0), hold: 1 });
    const path = createPresetPath({ keyframes: [{ ...k(0), transition: 0 }, { ...k(10), transition: 0 }, { ...k(20), transition: 2 }], fov: null });
    expect(path.cutTimes()).toEqual([1]); // keyframe 1 is a cut at t = 1; keyframe 2 is a 2 s move
    expect(createOrbitPath({ center: new Vector3(), radius: 1, height: 0, startDeg: 0, sweepDeg: 90, duration: 1, easing: 'none', fov: null }).cutTimes()).toEqual([]);
    // shutter [1.01 − 0.02, 1.01] contains the cut → the post-cut pose for the early sub-time
    const t = cameraSubTime(1.01, -0.02, path.cutTimes());
    expect(t).toBe(1);
    expect(path.pose(t, createCameraPathPose()).position.x).toBe(10);
    expect(path.pose(0.99, createCameraPathPose()).position.x).toBe(0); // what a cut-blind shutter would have mixed in
    // a positive-transition boundary (t = 4) is continuous — blurred, not clamped
    expect(cameraSubTime(4.01, -0.02, path.cutTimes())).toBeCloseTo(3.99, 12);
    // frame 0 has no past
    expect(cameraSubTime(0, -1 / 60, [])).toBe(0);
  });
});

/** A frame source with a motion recorder: logs the hook sequence and the sub-time camera. */
class MotionSource extends FakeSource {
  static resolved: 'pathA-v1' | 'off' = 'pathA-v1';
  static withRecorder = true;
  readonly calls: string[] = [];
  setupOptions: Record<string, unknown> | null = null;
  readonly cameras: Array<{ frame: number; offset: number; x: number; z: number; focus: number }> = [];
  async setup(...args: unknown[]): Promise<CinematicSetupInfo> {
    this.setupOptions = args[1] as Record<string, unknown>;
    const info = await super.setup();
    return this.setupOptions.motionBlur ? { ...info, motionBlur: { resolved: MotionSource.resolved, reason: null, subFrames: 4 } } : info;
  }
  motionRecorder(): CinematicMotionRecorder | null {
    if (!MotionSource.withRecorder) return null;
    return {
      beginFrame: () => { this.calls.push('begin'); },
      afterStep: () => { this.calls.push('step'); },
      afterRender: () => { this.calls.push('render'); },
    };
  }
  override async renderFrame(i: number, ctx?: CinematicFrameContext) {
    this.calls.push(`frame${i}${ctx?.cameraAt ? '+cam' : ''}`);
    if (ctx?.cameraAt) {
      for (const offset of [-1 / 30, -1 / 60, 0]) {
        const focus = ctx.cameraAt(offset);
        const p = viewer.camera.position;
        this.cameras.push({ frame: i, offset, x: p.x, z: p.z, focus });
      }
    }
    return super.renderFrame(i);
  }
}

describe('snapshot hook in advance(i) (plan-554 F2, N1, N3)', () => {
  let motionSource: MotionSource | null = null;
  beforeEach(() => {
    MotionSource.resolved = 'pathA-v1';
    MotionSource.withRecorder = true;
    registerCinematicRenderer(async () => (motionSource = source = new MotionSource(viewer)));
  });

  it('blur on: begin → one hook per single step → render, per RENDERED frame only (not in the fast-forward)', async () => {
    const r = await run({ startFrame: 5 });
    const calls = motionSource!.calls;
    expect(calls.filter((c) => c === 'begin')).toHaveLength(10);
    expect(calls.filter((c) => c === 'step')).toHaveLength(20); // 30 fps = 2 steps per frame
    expect(calls.filter((c) => c === 'render')).toHaveLength(10);
    expect(calls.slice(0, 5)).toEqual(['begin', 'step', 'step', 'render', 'frame5+cam']);
    expect(motionSource!.setupOptions!.motionBlur).toEqual({ shutterDeg: 180, subFrames: 8, fps: 30 });
    expect(r.result.cinematic!.setup.motionBlur).toEqual({ resolved: 'pathA-v1', reason: null, subFrames: 4 });
  }, 60_000);

  it('blur off (N3): no hook call, no camera sub-times, no blur option for the source; resolved off without a reason', async () => {
    const r = await run({ motionBlur: { enabled: false } });
    expect(motionSource!.calls.every((c) => /^frame\d+$/.test(c))).toBe(true);
    expect(motionSource!.setupOptions!.motionBlur).toBeUndefined();
    expect(r.result.cinematic!.setup.motionBlur).toEqual({ resolved: 'off', reason: null, subFrames: 1 });
  }, 60_000);

  it('a source that resolves off, or offers no recorder, gets no hook calls; the run says why', async () => {
    MotionSource.resolved = 'off';
    let r = await run();
    expect(motionSource!.calls.some((c) => c === 'begin' || c.endsWith('+cam'))).toBe(false);
    MotionSource.resolved = 'pathA-v1';
    MotionSource.withRecorder = false;
    viewer.resetSimulation();
    r = await run();
    expect(motionSource!.calls.some((c) => c === 'begin' || c.endsWith('+cam'))).toBe(false);
    expect(r.result.cinematic!.setup.motionBlur).toMatchObject({ resolved: 'off', reason: expect.stringMatching(/no motion recorder/) });
    // a plan-553 source (no blur support at all)
    registerCinematicRenderer(async () => (source = new FakeSource(viewer)));
    viewer.resetSimulation();
    let setupInfo: CinematicSetupInfo | null = null;
    await run({ onCinematicSetup: (info) => { setupInfo = info; } });
    expect(setupInfo!.motionBlur).toMatchObject({ resolved: 'off', reason: expect.stringMatching(/does not support/) });
  }, 60_000);

  it('N1: single steps under the hook reach the same simulation state per frame as blur off (30 and 60 fps)', async () => {
    for (const fps of [30, 60]) {
      viewer.resetSimulation();
      await run({ fps, seconds: 1, motionBlur: { enabled: false } });
      const off = motionSource!.states;
      viewer.resetSimulation();
      await run({ fps, seconds: 1 });
      const on = motionSource!.states;
      expect(motionSource!.calls.filter((c) => c === 'step')).toHaveLength(60);
      expect(on.size).toBe(off.size);
      for (const [i, a] of off) {
        const b = on.get(i)!;
        expect(b.sim).toBe(a.sim);
        expect(b.slideX).toBe(a.slideX);
        expect(b.mus).toEqual(a.mus);
      }
    }
  }, 120_000);

  it('cameraAt evaluates the camera PATH at frame time + offset (orbit with easing; frame 0 clamped); focus = |position − target|', async () => {
    const spec = { kind: 'orbit' as const, center: [0, 0, 0] as [number, number, number], radius: 4, height: 3, startDeg: 0, sweepDeg: 90, easing: 'inOut' as const };
    await run({ path: spec });
    const ref = createOrbitPath({ center: new Vector3(), radius: 4, height: 3, startDeg: 0, sweepDeg: 90, duration: 0.5, easing: 'inOut', fov: null });
    const pose = createCameraPathPose();
    const cams = motionSource!.cameras;
    expect(cams.length).toBe(15 * 3);
    for (const c of cams) {
      ref.pose(Math.max(0, c.frame / 30 + c.offset), pose);
      expect(c.x).toBeCloseTo(pose.position.x, 9);
      expect(c.z).toBeCloseTo(pose.position.z, 9);
      expect(c.focus).toBeCloseTo(5, 9);
    }
    // frame 0: every negative offset is the start pose
    const f0 = cams.filter((c) => c.frame === 0);
    expect(new Set(f0.map((c) => c.x.toFixed(9))).size).toBe(1);
    // a later frame: the shutter really moves the camera
    const f7 = cams.filter((c) => c.frame === 7);
    expect(f7[0].x).not.toBeCloseTo(f7[2].x, 6);
  }, 60_000);
});
