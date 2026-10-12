// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-557 — the still image (`captureStill`) on a real viewer: the state of the call is the
 * image (no sim step, a running simulation and a delayed lock included), the lock refusal, the
 * size contract (odd sizes, limits), the restore after success / failure / cancel, pixel parity
 * with the video frame of the same quality, the WebLabel reference height of a viewport still,
 * the orthographic refusal of cinematic, and the cinematic lifecycle against a FAKE frame source
 * (one setup / one renderFrame with `abortInFrame` / one dispose, cancel and timeout of the async
 * setup) — plus the unchanged video abort contract.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, Scene, Vector3 } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { loadVideoFixture, lumaStdDev, meanAbsDiff, SLIDE_PATH } from './helpers/video-capture-fixture';
import {
  STILL_BUSY_MESSAGE,
  STILL_ORTHO_MESSAGE,
  captureStill,
  fitStillSize,
  isRecording,
  normalizeStillOptions,
  recordVideo,
  stillBackstopMs,
  type StillCaptureOptions,
  type VideoQuality,
} from '../src/core/engine/rv-video-capture';
import {
  isAbortError,
  raceAbortable,
  registerCinematicRenderer,
  type CinematicFrameContext,
  type CinematicFrameSource,
  type CinematicFrameStats,
} from '../src/core/engine/rv-cinematic-hook';
import type { RVViewer } from '../src/core/rv-viewer';

let handle: TestViewerHandle;
let viewer: RVViewer;

/** 1×1 PNG. */
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/eL9GtQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

const SMALL: StillCaptureOptions = { width: 320, height: 240, quality: 'standard' };

function loopRunning(v: RVViewer): boolean {
  return (v as unknown as { loop: { running: boolean } }).loop.running;
}

function slideX(v: RVViewer = viewer): number {
  const n = v.registry!.getNode(SLIDE_PATH)!;
  n.updateMatrixWorld(true);
  return n.getWorldPosition(new Vector3()).x;
}

/** Width / height from the IHDR chunk of a PNG. */
function pngSize(png: Uint8Array): [number, number] {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return [dv.getUint32(16), dv.getUint32(20)];
}

async function pngPixels(png: Uint8Array): Promise<Uint8ClampedArray> {
  const bmp = await createImageBitmap(new Blob([png as BlobPart], { type: 'image/png' }));
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return ctx.getImageData(0, 0, c.width, c.height).data;
}

async function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > timeoutMs) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(async () => {
  handle = await createTestViewer('webgl', { width: 400, height: 300 });
  viewer = handle.viewer;
  await loadVideoFixture(viewer);
}, 120_000);

afterAll(() => {
  registerCinematicRenderer(null);
  handle?.dispose();
});

beforeEach(async () => {
  if (!viewer.currentModelRoot) await loadVideoFixture(viewer);
  registerCinematicRenderer(null);
});

afterEach(() => {
  expect(viewer.isCapturing).toBe(false);
  expect(isRecording(viewer)).toBe(false);
});

// ─── Exact state (F2) ──────────────────────────────────────────────────────

describe('exact state — no sim step, synchronous take-over (F2, SOL #1)', () => {
  it('a running simulation and a lock that answers 200 ms later: the image shows the state of the call', async () => {
    viewer.resetSimulation();
    // The live loop runs the simulation: wait until it advances.
    const tStart = viewer.simTime;
    await until(() => viewer.simTime > tStart + 0.05);
    const step = vi.spyOn(viewer, 'captureStep');
    let released = false;
    let atLock: { sim: number; x: number } | null = null;
    const t0 = viewer.simTime;
    const x0 = slideX();
    try {
      const p = captureStill(viewer, {
        ...SMALL,
        acquire: () => new Promise((resolve) => setTimeout(() => {
          atLock = { sim: viewer.simTime, x: slideX() };
          resolve({ release: () => { released = true; } });
        }, 200)),
      });
      // Taken over in the calling task — before any await.
      expect(viewer.isCapturing).toBe(true);
      expect(loopRunning(viewer)).toBe(false);
      const r = await p;
      expect(atLock).toEqual({ sim: t0, x: x0 });
      expect(r.simTime).toBe(t0);
      expect(step).not.toHaveBeenCalled();
      expect(released).toBe(true);
      expect(pngSize(r.png)).toEqual([320, 240]);
      // Afterwards the simulation runs on from there.
      expect(loopRunning(viewer)).toBe(true);
      await until(() => viewer.simTime > t0);
    } finally {
      step.mockRestore();
    }
  }, 60_000);

  it('a refused lock (acquire → null): busy error, nothing returned, viewer restored, loop running', async () => {
    const end = vi.spyOn(viewer, 'endCapture');
    try {
      await expect(captureStill(viewer, { ...SMALL, acquire: async () => null })).rejects.toThrow(STILL_BUSY_MESSAGE);
      expect(end).toHaveBeenCalledTimes(1);
      expect(loopRunning(viewer)).toBe(true);
      expect(STILL_BUSY_MESSAGE).toMatch(/busy/);
    } finally {
      end.mockRestore();
    }
  });
});

// ─── Size (F3) ─────────────────────────────────────────────────────────────

describe('size (F3)', () => {
  it('an odd viewport size is kept exactly (no 4:2:0 rule)', async () => {
    const r = await captureStill(viewer, { width: 1001, height: 563, quality: 'standard' });
    expect(pngSize(r.png)).toEqual([1001, 563]);
  }, 60_000);

  it('rejects edges above 8192 px or above the pixel limit with the reason; fits a viewport into the limits', () => {
    expect(() => normalizeStillOptions({ width: 9000, height: 100 })).toThrow(/16\.\.8192/);
    expect(() => normalizeStillOptions({ width: 8192, height: 8192 })).toThrow(/render limit/);
    expect(() => normalizeStillOptions({ width: 320.5, height: 240 })).toThrow(/whole pixels/);
    expect(() => normalizeStillOptions({ ...SMALL, samples: 64 })).toThrow(/cinematic/);
    expect(fitStillSize(1001, 563)).toEqual({ width: 1001, height: 563, scaled: false });
    const big = fitStillSize(10000, 6000);
    expect(big.scaled).toBe(true);
    expect(big.width).toBeLessThanOrEqual(8192);
    expect(big.width * big.height).toBeLessThanOrEqual(7680 * 4320);
    expect(Math.abs(big.width / big.height - 10000 / 6000)).toBeLessThan(0.01);
  });
});

// ─── Restore ───────────────────────────────────────────────────────────────

describe('restore after success, failure and cancel', () => {
  const snapshot = () => {
    const gl = viewer.renderer as unknown as { getPixelRatio(): number; domElement: HTMLCanvasElement };
    return {
      w: gl.domElement.width, h: gl.domElement.height, dpr: gl.getPixelRatio(),
      pos: viewer.camera.position.clone(), quat: viewer.camera.quaternion.clone(), target: viewer.controls.target.clone(),
    };
  };
  const expectRestored = (s: ReturnType<typeof snapshot>) => {
    const gl = viewer.renderer as unknown as { getPixelRatio(): number; domElement: HTMLCanvasElement };
    expect(loopRunning(viewer)).toBe(true);
    expect([gl.domElement.width, gl.domElement.height, gl.getPixelRatio()]).toEqual([s.w, s.h, s.dpr]);
    expect(viewer.camera.position.distanceTo(s.pos)).toBeLessThan(1e-12);
    expect(viewer.camera.quaternion.angleTo(s.quat)).toBeLessThan(1e-6);
    expect(viewer.controls.target.distanceTo(s.target)).toBeLessThan(1e-12);
    expect(viewer.controls.enabled).toBe(true);
    expect([...viewer.selectionManager.selectedPaths]).toEqual([SLIDE_PATH]);
  };

  it('success, a render failure and a cancel all hand the viewer back unchanged (selection included)', async () => {
    viewer.selectionManager.select(SLIDE_PATH);
    const s0 = snapshot();
    try {
      await captureStill(viewer, { ...SMALL, quality: 'high' });
      expectRestored(s0);

      const bomb = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshBasicMaterial());
      bomb.onBeforeRender = () => { throw new Error('injected render failure'); };
      viewer.currentModelRoot!.add(bomb);
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await expect(captureStill(viewer, SMALL)).rejects.toThrow(/failed to render/);
      } finally {
        bomb.removeFromParent();
        err.mockRestore();
      }
      expectRestored(s0);

      const ac = new AbortController();
      const p = captureStill(viewer, { ...SMALL, signal: ac.signal, acquire: () => new Promise(() => { /* never */ }) });
      setTimeout(() => ac.abort(), 30);
      const e = await p.catch((x: unknown) => x);
      expect(isAbortError(e)).toBe(true);
      expectRestored(s0);
    } finally {
      viewer.selectionManager.clear();
    }
  }, 60_000);
});

// ─── WebLabel reference (F2c) ─────────────────────────────────────────────

describe('WebLabel size of a viewport still (F2c, SOL #5, R2 #3)', () => {
  it('reference = CSS height × output / drawing buffer at renderer DPR 1 and 1.5 (capped 2), also when shrunk; a fixed size keeps the output height', async () => {
    const gl = viewer.renderer as unknown as { setPixelRatio(r: number): void; setSize(w: number, h: number, s: boolean): void; domElement: HTMLCanvasElement };
    const upd = vi.spyOn(viewer.webLabelManager, 'update');
    const refOf = async (o: StillCaptureOptions): Promise<number> => {
      upd.mockClear();
      await captureStill(viewer, o);
      expect(upd).toHaveBeenCalled();
      return upd.mock.calls[upd.mock.calls.length - 1][1];
    };
    try {
      for (const dpr of [1, 1.5]) {
        gl.setPixelRatio(dpr);
        gl.setSize(400, 300, false);
        const css = gl.domElement.clientHeight;
        const bw = gl.domElement.width;
        const bh = gl.domElement.height;
        expect(bh).toBe(Math.round(300 * dpr));
        // The viewport still: drawing-buffer size → the label fraction of the image = on screen.
        const full = await refOf({ width: bw, height: bh, quality: 'standard', labelReference: 'viewport' });
        expect(full / bh).toBeCloseTo(css / bh, 9);
        expect(full).toBeCloseTo(css, 9);
        // Shrunk by the limits (half the buffer): the same on-screen proportion.
        const half = await refOf({ width: Math.round(bw / 2), height: Math.round(bh / 2), quality: 'standard', labelReference: 'viewport' });
        expect(half / Math.round(bh / 2)).toBeCloseTo(css / bh, 6);
        // A fixed resolution: the video contract (relative to the output height).
        expect(await refOf({ width: 320, height: 240, quality: 'standard' })).toBe(240);
      }
    } finally {
      upd.mockRestore();
      gl.setPixelRatio(1);
      gl.setSize(400, 300, false);
    }
  }, 60_000);
});

// ─── Pixel parity with the video (F5, SOL #6/#7) ────────────────────────────

/** A scene where nothing moves: the video's one sim step is image-neutral. */
async function staticFixtureGlb(): Promise<ArrayBuffer> {
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
  cell.add(box('Post', [0.2, 1.2, 0.2], 0x3060c0, [1.2, 0.6, -1.2]));
  const bar = box('Bar', [2.5, 0.05, 0.03], 0x101010, [0, 0.3, 0.5]);
  bar.rotation.y = Math.PI / 9;
  cell.add(bar);
  cell.add(box('Block', [0.5, 0.5, 0.5], 0xd02020, [-1, 0.25, 0]));
  return (await new GLTFExporter().parseAsync(scene, { binary: true })) as ArrayBuffer;
}

describe('pixel parity with the video frame of the same quality (F5)', () => {
  let h2: TestViewerHandle;
  beforeAll(async () => {
    h2 = await createTestViewer('webgl', { width: 400, height: 300 });
    await h2.viewer.loadModel('static-fixture.glb', { data: await staticFixtureGlb() });
  }, 120_000);
  afterAll(() => h2?.dispose());

  /** The unencoded encoder input of a one-frame video (the reference). */
  async function videoFrame0(quality: VideoQuality): Promise<Uint8ClampedArray> {
    let pixels: Uint8ClampedArray | null = null;
    class CapturingEncoder extends VideoEncoder {
      encode(frame: VideoFrame, opts?: VideoEncoderEncodeOptions): void {
        if (!pixels) {
          const c = new OffscreenCanvas(frame.displayWidth, frame.displayHeight);
          const ctx = c.getContext('2d')!;
          ctx.drawImage(frame, 0, 0);
          pixels = ctx.getImageData(0, 0, c.width, c.height).data;
        }
        super.encode(frame, opts);
      }
    }
    await recordVideo(h2.viewer, {
      width: 320, height: 240, fps: 30, seconds: 1 / 30, warmupSeconds: 0, quality, path: { kind: 'fixed' },
    }, { VideoEncoder: CapturingEncoder });
    if (!pixels) throw new Error('no frame reached the encoder');
    return pixels;
  }

  it.each(['standard', 'high', 'max'] as const)('%s: mean deviation < 2/255', async (quality) => {
    const ref = await videoFrame0(quality);
    const still = await captureStill(h2.viewer, { width: 320, height: 240, quality });
    const px = await pngPixels(still.png);
    expect(px.length).toBe(ref.length);
    expect(lumaStdDev(px)).toBeGreaterThan(5); // the scene is in it (not a cleared buffer)
    expect(meanAbsDiff(px, ref)).toBeLessThan(2);
  }, 60_000);

  it('high and max with GPU limits that cap the supersample to 1: still identical to the video (jitter still active for max)', async () => {
    const spy = vi.spyOn(h2.viewer, 'getCaptureGpuLimits').mockReturnValue({
      maxTextureSize: 500, maxRenderbufferSize: 500, maxViewportWidth: 500, maxViewportHeight: 500,
    });
    const renders = vi.spyOn(h2.viewer, 'captureRenderFrame');
    try {
      for (const quality of ['high', 'max'] as const) {
        const ref = await videoFrame0(quality);
        renders.mockClear();
        const still = await captureStill(h2.viewer, { width: 320, height: 240, quality });
        expect(still.supersample).toBe(1);
        expect(still.jitter).toBe(quality === 'max' ? 4 : 0);
        // warm-up render + one render (high) / four jittered sub-renders (max)
        expect(renders.mock.calls.length).toBe(quality === 'max' ? 5 : 2);
        expect(meanAbsDiff(await pngPixels(still.png), ref)).toBeLessThan(2);
      }
    } finally {
      spy.mockRestore();
      renders.mockRestore();
    }
  }, 90_000);
});

// ─── Cinematic (F6/F7, FakeSource) ────────────────────────────────────────

class FakeSource implements CinematicFrameSource {
  readonly info = { renderer: 'fake', tracerVersion: '0', denoiserVersion: 'none' };
  setups = 0;
  renders: CinematicFrameContext[] = [];
  disposes = 0;
  failRender = false;
  /** When set, setup waits for it. */
  setupGate: Promise<void> | null = null;
  async setup() {
    this.setups++;
    if (this.setupGate) await this.setupGate;
    return { tracedMeshes: 3, triangles: 36, skipped: {}, missing: [], adapter: 'fake', setupMs: 1 };
  }
  async renderFrame(_i: number, ctx: CinematicFrameContext) {
    this.renders.push(ctx);
    if (this.failRender) throw new Error('fake render failure');
    const stats: CinematicFrameStats = { samples: 4, ms: 2, traceMs: 1, denoiseMs: 0, sceneChange: 'none' };
    return { png: PNG, stats };
  }
  async dispose() { this.disposes++; }
}

describe('cinematic still with a fake frame source (F6/F7)', () => {
  let source: FakeSource;
  beforeEach(() => {
    source = new FakeSource();
    registerCinematicRenderer(async () => source);
  });

  it('exactly one setup, one renderFrame with abortInFrame, one dispose; no sim step; the PNG of the source', async () => {
    const step = vi.spyOn(viewer, 'captureStep');
    try {
      const r = await captureStill(viewer, { width: 160, height: 90, quality: 'cinematic', samples: 64, denoise: 'off' });
      expect([source.setups, source.renders.length, source.disposes]).toEqual([1, 1, 1]);
      expect(source.renders[0]).toMatchObject({ abortInFrame: true });
      expect(source.renders[0].focusDistance).toBeGreaterThan(0);
      expect(r.png).toEqual(PNG);
      expect(r.samples).toBe(64);
      expect(step).not.toHaveBeenCalled();
      expect(loopRunning(viewer)).toBe(true);
    } finally {
      step.mockRestore();
    }
  }, 60_000);

  it('a throwing renderFrame still disposes the source and restores the viewer', async () => {
    source.failRender = true;
    await expect(captureStill(viewer, { width: 160, height: 90, quality: 'cinematic' })).rejects.toThrow(/fake render failure/);
    expect(source.disposes).toBe(1);
    expect(loopRunning(viewer)).toBe(true);
  }, 60_000);

  it('the backstop scales with pixels × samples (1024 spp in 4K is not cut off)', () => {
    expect(stillBackstopMs(3840, 2160, 1024)).toBeGreaterThan(1_800_000);
    expect(stillBackstopMs(160, 90, 4)).toBe(360_000);
  });

  it('a hanging setup ends on cancel within 5 s; the lease is released; a late setup result is disposed', async () => {
    let open!: () => void;
    source.setupGate = new Promise<void>((r) => { open = r; });
    let released = 0;
    const ac = new AbortController();
    const p = captureStill(viewer, {
      width: 160, height: 90, quality: 'cinematic', signal: ac.signal,
      acquire: async () => ({ release: () => { released++; } }),
    });
    await until(() => source.setups === 1);
    const t0 = performance.now();
    ac.abort();
    const e = await p.catch((x: unknown) => x);
    expect(isAbortError(e)).toBe(true);
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(viewer.isCapturing).toBe(false);
    expect(loopRunning(viewer)).toBe(true);
    expect(released).toBe(1);
    expect(source.disposes).toBe(1);
    expect(source.renders.length).toBe(0);
    open(); // the setup resolves late → disposed again (its device would leak otherwise)
    await until(() => source.disposes === 2);
  }, 60_000);

  it('a hanging setup without cancel fails after the setup timeout', async () => {
    source.setupGate = new Promise<void>(() => { /* never */ });
    await expect(captureStill(viewer, { width: 160, height: 90, quality: 'cinematic', setupTimeoutMs: 150 }))
      .rejects.toThrow(/did not finish within/);
    expect(source.disposes).toBe(1);
    expect(loopRunning(viewer)).toBe(true);
  }, 60_000);

  it('without a provider: the commercial-feature refusal, viewer untouched', async () => {
    registerCinematicRenderer(null);
    const begin = vi.spyOn(viewer, 'beginCapture');
    try {
      await expect(captureStill(viewer, { width: 160, height: 90, quality: 'cinematic' })).rejects.toThrow(/commercial feature/);
      expect(begin).not.toHaveBeenCalled();
    } finally {
      begin.mockRestore();
    }
  });
});

describe('orthographic camera (F2b, R2 #4)', () => {
  it('cinematic is refused in the preflight (beginCapture never runs); raster works', async () => {
    const source = new FakeSource();
    registerCinematicRenderer(async () => source);
    const begin = vi.spyOn(viewer, 'beginCapture');
    viewer.projection = 'orthographic';
    try {
      await until(() => (viewer.camera as { isOrthographicCamera?: boolean }).isOrthographicCamera === true);
      await expect(captureStill(viewer, { width: 160, height: 90, quality: 'cinematic' })).rejects.toThrow(STILL_ORTHO_MESSAGE);
      expect(begin).not.toHaveBeenCalled();
      expect(source.setups).toBe(0);
      const r = await captureStill(viewer, SMALL);
      expect(pngSize(r.png)).toEqual([320, 240]);
      expect(begin).toHaveBeenCalledTimes(1);
    } finally {
      begin.mockRestore();
      viewer.projection = 'perspective';
      await until(() => (viewer.camera as { isPerspectiveCamera?: boolean }).isPerspectiveCamera === true);
    }
  }, 60_000);
});

// ─── The video contract stays (SOL #4) ─────────────────────────────────────

describe('video abort contract unchanged (F7, SOL #4)', () => {
  it('a cinematic video passes no abortInFrame; an abort during frame 1 lets frame 1 finish and be written, then stops', async () => {
    const ctxs: CinematicFrameContext[] = [];
    const ac = new AbortController();
    const src: CinematicFrameSource = {
      info: { renderer: 'fake', tracerVersion: '0', denoiserVersion: 'none' },
      setup: async () => ({ tracedMeshes: 1, triangles: 12, skipped: {}, missing: [], adapter: 'fake', setupMs: 1 }),
      renderFrame: async (i, ctx) => {
        ctxs.push(ctx);
        if (i === 1) ac.abort();
        return { png: PNG, stats: { samples: 4, ms: 2, traceMs: 1, denoiseMs: 0, sceneChange: 'none' } };
      },
      dispose: async () => { /* nothing */ },
    };
    registerCinematicRenderer(async () => src);
    const written: number[] = [];
    viewer.resetSimulation();
    await expect(recordVideo(viewer, {
      width: 160, height: 90, fps: 30, seconds: 0.2, warmupSeconds: 0, quality: 'cinematic', samples: 4, denoise: 'off',
      path: { kind: 'fixed' }, signal: ac.signal,
      frameSink: (i) => { written.push(i); },
    })).rejects.toThrow(/aborted/);
    expect(ctxs.every((c) => c.abortInFrame === undefined)).toBe(true);
    expect(written).toEqual([0, 1]);
  }, 60_000);
});

describe('raceAbortable — the loser never surfaces (plan-557 Abnahme 9.6)', () => {
  it('a rejection of the input AFTER the abort won stays silent; one before the abort passes through unchanged', async () => {
    const seen: unknown[] = [];
    const onRejection = (e: PromiseRejectionEvent): void => { seen.push(e.reason); };
    window.addEventListener('unhandledrejection', onRejection);
    try {
      // Loser: aborted first, the input rejects later (like a mapAsync after device.destroy()).
      const ac = new AbortController();
      let rejectLate!: (e: unknown) => void;
      const late = new Promise<never>((_, rej) => { rejectLate = rej; });
      const raced = raceAbortable(late, { signal: ac.signal, abortMessage: 'gone' });
      ac.abort();
      const e = await raced.catch((x: unknown) => x);
      expect(isAbortError(e)).toBe(true);
      rejectLate(new DOMException('Buffer was unmapped before mapping was resolved.', 'AbortError'));
      // A throwing onLate after a lost race is logged, not rethrown.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* quiet */ });
      const ac2 = new AbortController();
      let resolveLate!: (v: number) => void;
      const raced2 = raceAbortable(new Promise<number>((res) => { resolveLate = res; }), {
        signal: ac2.signal, onLate: () => { throw new Error('release failed'); },
      });
      ac2.abort();
      await raced2.catch(() => undefined);
      resolveLate(1);
      await new Promise((res) => setTimeout(res, 50));
      expect(seen).toEqual([]);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
      // Winner: the input's own error is NOT swallowed.
      const boom = new Error('real failure');
      await expect(raceAbortable(Promise.reject(boom), { signal: new AbortController().signal })).rejects.toBe(boom);
    } finally {
      window.removeEventListener('unhandledrejection', onRejection);
    }
  });
});
