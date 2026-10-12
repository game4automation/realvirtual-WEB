// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-537 — deterministic video capture, end to end on a real viewer:
 * the MP4 is demuxed / decoded with mediabunny (sample count, timestamps,
 * duration, size, motion), the sim time per frame, determinism of two runs,
 * the time model at 30 and 60 fps, option validation, the session lifecycle
 * (abort, concurrent capture, failure, model change), the frame-failure path
 * through the REAL renderer pass, the size contract (DPR, queued resize,
 * WebLabel height), deadline + byte budget, the quality mode and the encoder
 * ladder.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, PerspectiveCamera, Vector3 } from 'three';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import {
  decodeFrame, demuxMp4, loadVideoFixture, lumaStdDev, meanAbsDiff, meanLuma, SLIDE_PATH,
} from './helpers/video-capture-fixture';
import {
  CAPTURE_SHADOW_MAP_SIZE,
  captureStill,
  codecLadder,
  computeSupersample,
  defaultBitrate,
  defaultCaptureFileName,
  defaultVideoFileName,
  downloadBytes,
  downloadVideo,
  isRecording,
  jitterOffsets,
  MUX_ABORTED_MESSAGE,
  muxVideoFrames,
  normalizeVideoOptions,
  recordVideo,
  selectEncoderConfig,
  type VideoRecordOptions,
} from '../src/core/engine/rv-video-capture';
import { PP_SCALE } from '../src/core/rv-post-processing';
import {
  McpVideoTools, estimateRenderSeconds, parseViewList, videoToolOptions,
} from '../src/plugins/mcp-bridge/rv-mcp-video-tools';
import type { RVViewer } from '../src/core/rv-viewer';

let handle: TestViewerHandle;
let viewer: RVViewer;

beforeAll(async () => {
  handle = await createTestViewer('webgl', { width: 400, height: 300 });
  viewer = handle.viewer;
  await loadVideoFixture(viewer);
}, 120_000);

afterAll(() => handle?.dispose());

beforeEach(async () => {
  if (!viewer.currentModelRoot) await loadVideoFixture(viewer);
  viewer.resetSimulation();
});

const SMALL: VideoRecordOptions = {
  width: 320, height: 240, fps: 30, seconds: 1, warmupSeconds: 0.5, quality: 'standard',
  path: { kind: 'fixed' },
};

function slideX(): number {
  const n = viewer.registry!.getNode(SLIDE_PATH)!;
  n.updateMatrixWorld(true);
  return n.getWorldPosition(new Vector3()).x;
}

function loopRunning(v: RVViewer): boolean {
  return (v as unknown as { loop: { running: boolean } }).loop.running;
}

describe('recordVideo — MP4, frames, time model (F2/F2e/F3/F4/F8)', () => {
  it('30 fps × 1 s → exactly 30 samples at i/30, 1 s long, 320×240; sim = warmup + 1 s; the drive moved', async () => {
    const x0 = slideX();
    const t0 = viewer.simTime;
    const r = await recordVideo(viewer, SMALL);
    expect(r.frames).toBe(30);
    expect(r.warmupSteps).toBe(30);
    expect(r.simStart - t0).toBeCloseTo(0.5, 9);
    expect(r.simEnd - r.simStart).toBeCloseTo(1, 9);
    expect(r.codec.startsWith('avc1.')).toBe(true);
    const mp4 = await demuxMp4(r.bytes);
    expect(mp4.samples).toBe(30);
    expect(mp4.width).toBe(320);
    expect(mp4.height).toBe(240);
    expect(mp4.duration).toBeCloseTo(1, 6);
    mp4.timestamps.forEach((ts, i) => expect(ts).toBeCloseTo(i / 30, 6));
    // 500 mm/s for 1.5 s of sim time (Unity +X is glTF −X, hence the
    // magnitude), within one fixed step (8.3 mm) for the drive's start tick.
    expect(Math.abs(Math.abs(slideX() - x0) - 0.75)).toBeLessThan(0.5 / 60 + 1e-9);
  }, 60_000);

  it('decoded frames are not black and first and last differ (motion, no frozen repeats)', async () => {
    const r = await recordVideo(viewer, SMALL);
    const first = await decodeFrame(r.bytes, 0);
    const last = await decodeFrame(r.bytes, 29 / 30);
    expect(first.width).toBe(320);
    expect(meanLuma(first.data)).toBeGreaterThan(10);
    // not a uniform (black / white / cleared) buffer — the scene is in it
    expect(lumaStdDev(first.data)).toBeGreaterThan(5);
    expect(lumaStdDev(last.data)).toBeGreaterThan(5);
    expect(meanAbsDiff(first.data, last.data)).toBeGreaterThan(0.5);
  }, 60_000);

  it('two runs from the same start state: identical samples, timestamps and sim time per frame', async () => {
    const run = async () => {
      viewer.resetSimulation();
      const sims: number[] = [];
      const base = viewer.simTime;
      const r = await recordVideo(viewer, { ...SMALL, onProgress: () => { sims.push(viewer.simTime - base); } });
      return { r, sims, mp4: await demuxMp4(r.bytes) };
    };
    const a = await run();
    const b = await run();
    expect(b.mp4.samples).toBe(a.mp4.samples);
    expect(b.mp4.timestamps).toEqual(a.mp4.timestamps);
    expect(b.sims.length).toBe(30);
    b.sims.forEach((s, i) => expect(s).toBeCloseTo(a.sims[i], 12));
    // frame i shows warmup + (i+1)/fps
    a.sims.forEach((s, i) => expect(s).toBeCloseTo(0.5 + (i + 1) / 30, 9));
  }, 90_000);

  it('60 fps → exactly one fixed step per frame', async () => {
    const steps: number[] = [];
    let last = viewer.simTime;
    const r = await recordVideo(viewer, {
      ...SMALL, fps: 60, warmupSeconds: 0,
      onProgress: () => { steps.push(Math.round((viewer.simTime - last) * 60)); last = viewer.simTime; },
    });
    expect(r.frames).toBe(60);
    expect(steps.every((s) => s === 1)).toBe(true);
    expect((await demuxMp4(r.bytes)).samples).toBe(60);
  }, 60_000);

  it('rejects fps 24, a non-integer frame count and a > 512 MB estimate — viewer untouched', async () => {
    const before = viewer.camera.position.clone();
    await expect(recordVideo(viewer, { ...SMALL, fps: 24 })).rejects.toThrow(/fps 24/);
    await expect(recordVideo(viewer, { ...SMALL, seconds: 1.01 })).rejects.toThrow(/whole number of frames/);
    await expect(recordVideo(viewer, { ...SMALL, seconds: 120, bitrate: 50_000_000 })).rejects.toThrow(/in-memory limit/);
    await expect(recordVideo(viewer, { ...SMALL, width: 321 })).rejects.toThrow(/even/);
    expect(viewer.isCapturing).toBe(false);
    expect(loopRunning(viewer)).toBe(true);
    expect(viewer.camera.position.equals(before)).toBe(true);
  });
});

describe('lifecycle (F2b/F5b/F10)', () => {
  it('an abort mid-way restores loop, size, DPR, camera, controls and selection; no bytes', async () => {
    const gl = viewer.renderer as unknown as { getPixelRatio(): number; domElement: HTMLCanvasElement };
    const canvas = gl.domElement;
    const w0 = canvas.width; const h0 = canvas.height; const dpr0 = gl.getPixelRatio();
    const cam = viewer.camera;
    const pos0 = cam.position.clone(); const q0 = cam.quaternion.clone();
    const tgt0 = viewer.controls.target.clone();
    viewer.selectionManager.select(SLIDE_PATH);
    const ac = new AbortController();
    let sawRenderSize = '';
    const p = recordVideo(viewer, {
      ...SMALL, path: { kind: 'orbit' }, signal: ac.signal,
      onProgress: (i) => {
        sawRenderSize = `${canvas.width}x${canvas.height}`;
        expect(viewer.selectionManager.selectedPaths.length).toBe(0);
        if (i === 4) ac.abort();
      },
    });
    await expect(p).rejects.toThrow(/aborted/);
    expect(sawRenderSize).toBe('320x240');
    expect(viewer.isCapturing).toBe(false);
    expect(isRecording(viewer)).toBe(false);
    expect(loopRunning(viewer)).toBe(true);
    expect(canvas.width).toBe(w0);
    expect(canvas.height).toBe(h0);
    expect(gl.getPixelRatio()).toBe(dpr0);
    expect(cam.position.distanceTo(pos0)).toBeLessThan(1e-12);
    expect(cam.quaternion.angleTo(q0)).toBeLessThan(1e-6);
    expect(viewer.controls.target.distanceTo(tgt0)).toBeLessThan(1e-12);
    expect(viewer.controls.enabled).toBe(true);
    expect([...viewer.selectionManager.selectedPaths]).toEqual([SLIDE_PATH]);
    viewer.selectionManager.clear();
  }, 60_000);

  it('a loop that was stopped before stays stopped', async () => {
    const loop = (viewer as unknown as { loop: { stop(): void; start(): void } }).loop;
    loop.stop();
    try {
      const r = await recordVideo(viewer, { ...SMALL, seconds: 0.2 });
      expect(r.frames).toBe(6);
      expect(loopRunning(viewer)).toBe(false);
    } finally {
      loop.start();
    }
  }, 60_000);

  it('a second concurrent capture is rejected; a capture after a failed one works', async () => {
    const first = recordVideo(viewer, SMALL);
    await expect(recordVideo(viewer, SMALL)).rejects.toThrow(/already running/);
    await first;
    await expect(recordVideo(viewer, { ...SMALL, path: { kind: 'orbit', target: 'Cell/Nope' } })).rejects.toThrow(/not found/);
    expect(isRecording(viewer)).toBe(false);
    const ok = await recordVideo(viewer, SMALL);
    expect(ok.frames).toBe(30);
  }, 90_000);

  it('a model change during the capture aborts it cleanly', async () => {
    const p = recordVideo(viewer, {
      ...SMALL, onProgress: (i) => { if (i === 3) viewer.clearModel(); },
    });
    await expect(p).rejects.toThrow(/model was changed/);
    expect(viewer.isCapturing).toBe(false);
    expect(loopRunning(viewer)).toBe(true);
    await loadVideoFixture(viewer);
  }, 90_000);
});

describe('frame failure through the real render pass (F2d)', () => {
  it('a throwing object in the scene pass fails the recording; no bytes, viewer restored', async () => {
    const bomb = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshBasicMaterial());
    let armed = false;
    bomb.onBeforeRender = () => { if (armed) throw new Error('injected render failure'); };
    viewer.currentModelRoot!.add(bomb);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const p = recordVideo(viewer, { ...SMALL, onProgress: (i) => { if (i === 2) armed = true; } });
      await expect(p).rejects.toThrow(/Frame 3 failed to render/);
      expect(viewer.isCapturing).toBe(false);
      expect(loopRunning(viewer)).toBe(true);
    } finally {
      armed = false;
      bomb.removeFromParent();
      err.mockRestore();
    }
  }, 60_000);
});

describe('size (F2c)', () => {
  it('DPR 2 → output exactly the requested physical size; DPR and buffer come back', async () => {
    const gl = viewer.renderer as unknown as { getPixelRatio(): number; setPixelRatio(r: number): void; setSize(w: number, h: number, s: boolean): void; domElement: HTMLCanvasElement };
    gl.setPixelRatio(2);
    gl.setSize(400, 300, false);
    try {
      const r = await recordVideo(viewer, SMALL);
      const mp4 = await demuxMp4(r.bytes);
      expect([mp4.width, mp4.height]).toEqual([320, 240]);
      expect(gl.getPixelRatio()).toBe(2);
      expect(gl.domElement.width).toBe(800);
    } finally {
      gl.setPixelRatio(1);
      gl.setSize(400, 300, false);
    }
  }, 60_000);

  it('a window resize during the capture is queued and applied afterwards; WebLabels use the capture height', async () => {
    const h = await createTestViewer('webgl', { width: 400, height: 300, autoResize: true });
    try {
      await loadVideoFixture(h.viewer);
      const canvas = h.viewer.renderer.domElement as HTMLCanvasElement;
      const upd = vi.spyOn(h.viewer.webLabelManager, 'update');
      const sizes: string[] = [];
      await recordVideo(h.viewer, {
        ...SMALL,
        onProgress: async (i) => {
          if (i === 2) {
            h.container.style.width = '500px';
            window.dispatchEvent(new Event('resize'));
            await new Promise((r) => setTimeout(r, 30));
          }
          sizes.push(`${canvas.width}x${canvas.height}`);
        },
      });
      expect(new Set(sizes)).toEqual(new Set(['320x240']));
      expect(canvas.width).toBe(500);
      expect(upd.mock.calls.some((c) => c[1] === 240)).toBe(true);
    } finally {
      h.dispose();
    }
  }, 120_000);
});

describe('deadline + byte budget (F2f/F2g)', () => {
  it('a job slower than its deadline fails, the viewer is restored, the lock released', async () => {
    const p = recordVideo(viewer, {
      ...SMALL, deadlineMs: 250,
      onProgress: () => new Promise((r) => setTimeout(r, 40)),
    });
    await expect(p).rejects.toThrow(/deadline/);
    expect(isRecording(viewer)).toBe(false);
    expect(loopRunning(viewer)).toBe(true);
  }, 60_000);

  it('estimate within budget but actual encoder bytes above it → clean abort', async () => {
    // Inflate every chunk the REAL encoder emits to 200 kB: the actual-bytes
    // counter (not the estimate) must stop the recording.
    class InflatingEncoder extends VideoEncoder {
      constructor(init: VideoEncoderInit) {
        super({
          ...init,
          output: (chunk, meta) => init.output(
            new Proxy(chunk, { get: (t, k) => (k === 'byteLength' ? 200_000 : Reflect.get(t, k, t)) }) as EncodedVideoChunk,
            meta,
          ),
        });
      }
    }
    const p = recordVideo(viewer, { ...SMALL, bitrate: 200_000, maxBytes: 100_000 }, { VideoEncoder: InflatingEncoder });
    await expect(p).rejects.toThrow(/exceeded the in-memory limit/);
    expect(isRecording(viewer)).toBe(false);
    expect(loopRunning(viewer)).toBe(true);
  }, 60_000);
});

describe('quality mode (F11)', () => {
  it('high at 320×240 renders 640×480, encodes 320×240 and restores PP scale, shadow map, outlines, DPR', async () => {
    const pp = (viewer as unknown as { _postProcessing: { bufferScale: number } })._postProcessing;
    const dirLight = (viewer as unknown as { dirLight: { castShadow: boolean; shadow: { mapSize: { x: number } } } }).dirLight;
    const castBefore = dirLight.castShadow;
    dirLight.castShadow = true;
    const shadow0 = dirLight.shadow.mapSize.x;
    const thick0 = viewer.outlineManager.getStatusStyle().edgeThickness;
    let renderSize = '';
    let ppDuring = 0;
    let shadowDuring = 0;
    let thickDuring = 0;
    try {
      const r = await recordVideo(viewer, {
        ...SMALL, quality: 'high',
        onProgress: () => {
          const s = viewer.captureRenderSize!;
          renderSize = `${s.width}x${s.height}`;
          ppDuring = pp.bufferScale;
          shadowDuring = dirLight.shadow.mapSize.x;
          thickDuring = viewer.outlineManager.getStatusStyle().edgeThickness;
        },
      });
      expect(r.supersample).toBe(2);
      expect(renderSize).toBe('640x480');
      expect(ppDuring).toBe(1);
      expect(shadowDuring).toBe(CAPTURE_SHADOW_MAP_SIZE);
      expect(thickDuring).toBe(thick0 * 2);
      const mp4 = await demuxMp4(r.bytes);
      expect([mp4.width, mp4.height, mp4.samples]).toEqual([320, 240, 30]);
      expect(pp.bufferScale).toBe(PP_SCALE);
      expect(dirLight.shadow.mapSize.x).toBe(shadow0);
      expect(viewer.outlineManager.getStatusStyle().edgeThickness).toBe(thick0);
      expect((viewer.renderer as unknown as { getPixelRatio(): number }).getPixelRatio()).toBe(1);
    } finally {
      dirLight.castShadow = castBefore;
    }
  }, 60_000);

  it('quality state is restored after an abort as well', async () => {
    const pp = (viewer as unknown as { _postProcessing: { bufferScale: number } })._postProcessing;
    const thick0 = viewer.outlineManager.getStyle().edgeThickness;
    const ac = new AbortController();
    await expect(recordVideo(viewer, {
      ...SMALL, quality: 'high', signal: ac.signal, onProgress: (i) => { if (i === 1) ac.abort(); },
    })).rejects.toThrow(/aborted/);
    expect(pp.bufferScale).toBe(PP_SCALE);
    expect(viewer.outlineManager.getStyle().edgeThickness).toBe(thick0);
    expect(viewer.captureRenderSize).toBeNull();
  }, 60_000);

  it('the supersample factor is reduced when the GPU limit is smaller than output × 2', async () => {
    expect(computeSupersample(1920, 1080, 2, { maxTextureSize: 16384, maxRenderbufferSize: 16384, maxViewportWidth: 16384, maxViewportHeight: 16384 })).toBe(2);
    expect(computeSupersample(1920, 1080, 2, { maxTextureSize: 2048, maxRenderbufferSize: 16384, maxViewportWidth: 16384, maxViewportHeight: 16384 })).toBe(1);
    expect(computeSupersample(3840, 2160, 2, { maxTextureSize: 16384, maxRenderbufferSize: 16384, maxViewportWidth: 16384, maxViewportHeight: 16384 })).toBe(2);
    expect(computeSupersample(3840, 2160, 3, { maxTextureSize: 16384, maxRenderbufferSize: 16384, maxViewportWidth: 16384, maxViewportHeight: 16384 })).toBe(2);
    const spy = vi.spyOn(viewer, 'getCaptureGpuLimits').mockReturnValue({
      maxTextureSize: 500, maxRenderbufferSize: 500, maxViewportWidth: 500, maxViewportHeight: 500,
    });
    try {
      const r = await recordVideo(viewer, { ...SMALL, quality: 'high' });
      expect(r.supersample).toBe(1);
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  it('max with jitter 4 renders 4× per frame with 4 distinct view offsets and clears the offset', async () => {
    const spy = vi.spyOn(viewer, 'captureRenderFrame');
    const offsets: string[] = [];
    const cam = viewer.camera as PerspectiveCamera;
    const origSet = cam.setViewOffset.bind(cam);
    const setSpy = vi.spyOn(cam, 'setViewOffset').mockImplementation((fw, fh, x, y, w, h) => {
      offsets.push(`${x.toFixed(4)},${y.toFixed(4)}`);
      origSet(fw, fh, x, y, w, h);
    });
    try {
      const r = await recordVideo(viewer, { ...SMALL, seconds: 0.2, quality: 'max', jitter: 4 } as VideoRecordOptions);
      expect(r.jitter).toBe(4);
      // warmup render + 6 frames × 4 sub-renders
      expect(spy.mock.calls.length).toBe(1 + 6 * 4);
      expect(new Set(offsets.slice(0, 4)).size).toBe(4);
      expect(offsets.slice(0, 4)).toEqual(offsets.slice(4, 8)); // fixed pattern per frame
      expect(cam.view === null || cam.view.enabled === false).toBe(true);
    } finally {
      spy.mockRestore();
      setSpy.mockRestore();
    }
  }, 60_000);

  it('a thin diagonal line: standard draws aliased dark dots, high a continuous faint line (intermediate tones)', async () => {
    // A 6 mm dark bar (≈ 0.3 px wide) on the floor, seen from the top.
    const bar = new Mesh(new BoxGeometry(2.5, 0.002, 0.006), new MeshBasicMaterial({ color: 0x000000 }));
    bar.rotation.y = Math.PI / 9;
    bar.position.set(0, 0.06, 1.0);
    viewer.currentModelRoot!.add(bar);
    const tones = async (quality: 'standard' | 'high'): Promise<{ strong: number; faint: number }> => {
      viewer.resetSimulation();
      const r = await recordVideo(viewer, {
        ...SMALL, seconds: 0.2, warmupSeconds: 0, quality, bitrate: 8_000_000,
        path: { kind: 'presets', views: [{ view: 'top', hold: 1 }] },
      });
      const f = await decodeFrame(r.bytes, 0);
      const luma = (i: number) => Math.round((f.data[i] + f.data[i + 1] + f.data[i + 2]) / 3);
      // Floor tone = histogram mode below the light background.
      const hist = new Array<number>(256).fill(0);
      for (let i = 0; i < f.data.length; i += 4) hist[luma(i)]++;
      let floor = 60;
      for (let l = 60; l < 150; l++) if (hist[l] > hist[floor]) floor = l;
      let strong = 0;
      let faint = 0;
      for (let i = 0; i < f.data.length; i += 4) {
        const d = floor - luma(i);
        if (d > 60) strong++;
        else if (d > 6) faint++;
      }
      return { strong, faint };
    };
    try {
      const std = await tones('standard');
      const high = await tones('high');
      expect(std.strong).toBeGreaterThan(0);
      expect(high.strong).toBeLessThan(std.strong);
      expect(high.faint).toBeGreaterThan(std.faint);
    } finally {
      bar.removeFromParent();
    }
  }, 90_000);
});

describe('encoder ladder (F3)', () => {
  it('falls back down the ladder and fails clearly when nothing is supported', async () => {
    const seen: string[] = [];
    const fake = {
      isConfigSupported: async (c: VideoEncoderConfig) => {
        seen.push(`${c.codec}/${c.hardwareAcceleration}`);
        return { supported: c.codec.startsWith('avc1.4D') && c.hardwareAcceleration === 'prefer-software', config: c };
      },
    };
    const cfg = await selectEncoderConfig({ codec: 'avc', width: 1920, height: 1080, fps: 60, bitrate: 40e6 }, fake);
    expect(cfg.codec.startsWith('avc1.4D')).toBe(true);
    expect(cfg.hardwareAcceleration).toBe('prefer-software');
    expect(seen[0]).toBe('avc1.64002A/prefer-hardware'); // High @ 4.2 for 1080p60 first
    const none = { isConfigSupported: async (c: VideoEncoderConfig) => ({ supported: false, config: c }) };
    await expect(selectEncoderConfig({ codec: 'avc', width: 320, height: 240, fps: 30, bitrate: 1e6 }, none))
      .rejects.toThrow(/No supported avc encoder/);
    await expect(selectEncoderConfig({ codec: 'avc', width: 320, height: 240, fps: 30, bitrate: 1e6 }, {} as never))
      .rejects.toThrow(/no WebCodecs VideoEncoder/);
  });

  it('chooses the H.264 level from size and frame rate', () => {
    expect(codecLadder('avc', 1920, 1080, 30)[0]).toBe('avc1.640028'); // 4.0
    expect(codecLadder('avc', 1920, 1080, 60)[0]).toBe('avc1.64002A'); // 4.2
    expect(codecLadder('avc', 3840, 2160, 30)[0]).toBe('avc1.640033'); // 5.1
    expect(codecLadder('avc', 1080, 1080, 60)[0]).toBe('avc1.64002A');
  });

  it('defaults: 1080p60 = 40 Mbit/s, 4K30 ≈ 60 Mbit/s; normalised options', () => {
    expect(defaultBitrate(1920, 1080, 60)).toBe(40_000_000);
    expect(Math.abs(defaultBitrate(3840, 2160, 30) - 60_000_000)).toBeLessThan(1_500_000);
    const n = normalizeVideoOptions({ seconds: 40 });
    expect([n.width, n.height, n.fps, n.frames, n.warmupSteps, n.quality, n.supersample]).toEqual([1920, 1080, 60, 2400, 180, 'high', 2]);
    expect(jitterOffsets(4).length).toBe(4);
  });
});

describe('MCP web_record_video (F7)', () => {
  it('maps and validates the flat arguments', () => {
    expect(parseViewList('iso:3:1, front , cam1:2')).toEqual([
      { view: 'iso', transition: 3, hold: 1 }, { view: 'front' }, { view: 'cam1', transition: 2 },
    ]);
    const o = videoToolOptions({ seconds: 2, fps: 30, path: 'orbit', sweepDeg: 90, orbitHeight: 1.5, quality: 'max' });
    expect(o.path).toEqual({ kind: 'orbit', sweepDeg: 90, height: 1.5 });
    expect(o.quality).toBe('max');
    expect(() => videoToolOptions({ seconds: 2, path: 'presets' })).toThrow(/needs views/);
    expect(() => videoToolOptions({ seconds: 2, path: 'spiral' })).toThrow(/Unknown path/);
  });

  it('returns validation errors and the runtime-guard refusal as JSON, viewer untouched', async () => {
    const tool = new McpVideoTools(() => viewer);
    const bad = JSON.parse(await tool.webRecordVideo(1, 24));
    expect(bad.error).toMatch(/fps 24/);
    const long = JSON.parse(await tool.webRecordVideo(600, 60, 3840, 2160, 'orbit', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'max', 5_000_000));
    expect(long.error).toMatch(/too long for one tool call/);
    expect(long.estimatedRenderSeconds).toBeGreaterThan(300);
    expect(viewer.isCapturing).toBe(false);
    expect(estimateRenderSeconds({ frames: 60, subRenders: 1, renderPixels: 1e6, canvasPixels: 1e6, liveFrameMs: 10, warmupSteps: 0 }))
      .toBeCloseTo(60 * (10 + 2) / 1000, 6);
  });

  it('records, delivers a file and returns the summary — never the bytes', async () => {
    const tool = new McpVideoTools(() => viewer);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      const raw = await tool.webRecordVideo(0.5, 30, 320, 240, 'fixed', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 0.25, 'standard', undefined, undefined, 'mcp-test');
      const res = JSON.parse(raw);
      expect(res.error).toBeUndefined();
      expect(res.frames).toBe(15);
      expect(res.sizeBytes).toBeGreaterThan(0);
      expect(res.path ?? res.download).toMatch(/mcp-test[.]mp4$/);
      expect(raw.length).toBeLessThan(2000);
      expect(Object.keys(res)).not.toContain('bytes');
    } finally {
      click.mockRestore();
    }
  }, 60_000);
});

// ─── plan-557 F8 — file name + download helpers shared by video and still ─────

describe('capture file name + download (plan-557 F8)', () => {
  const fixed = new Date(2026, 9, 6, 7, 8, 9);

  it('defaultCaptureFileName(base, ext) → <model>-YYYYMMDD-HHMMSS.<ext>; the video name is unchanged', () => {
    expect(defaultCaptureFileName('Station', 'png', fixed)).toBe('Station-20261006-070809.png');
    expect(defaultCaptureFileName('models/Demo Cell.glb', '.png', fixed)).toBe('models_Demo_Cell-20261006-070809.png');
    expect(defaultCaptureFileName('', 'png', fixed)).toBe('recording-20261006-070809.png');
    expect(defaultVideoFileName('Station', fixed)).toBe('Station-20261006-070809.mp4');
  });

  it('downloadBytes sets the MIME type and the name; downloadVideo delegates with video/mp4', async () => {
    const types: string[] = [];
    const names: string[] = [];
    const create = vi.spyOn(URL, 'createObjectURL').mockImplementation((b: Blob | MediaSource) => {
      types.push((b as Blob).type);
      return `blob:${location.origin}/test-${types.length}`;
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    try {
      downloadBytes(new Uint8Array([1, 2, 3]), 'a.png', 'image/png');
      downloadVideo(new Uint8Array([4]), 'b.mp4');
      expect(types).toEqual(['image/png', 'video/mp4']);
      expect(names).toEqual(['a.png', 'b.mp4']);
      expect(document.querySelector('a[download]')).toBeNull();
    } finally {
      create.mockRestore();
      click.mockRestore();
    }
  });
});

// ─── plan-551 F8 / F12 / F23 — the frame mux: cancel never hangs, real byte cap ─────

describe('muxVideoFrames cancel + byte cap (plan-551)', () => {
  type Ctl = { queue: number; flush: Promise<void>; chunkBytes: number; closed: boolean; cancelled: boolean; finalized: boolean; encoded: number };
  function fakes(ctl: Ctl) {
    class FakeEncoder extends EventTarget {
      static async isConfigSupported(c: VideoEncoderConfig) { return { supported: true, config: c }; }
      state = 'unconfigured';
      constructor(private readonly init: VideoEncoderInit) { super(); }
      get encodeQueueSize() { return ctl.queue; }
      configure() { this.state = 'configured'; }
      encode() {
        ctl.encoded++;
        this.init.output({ byteLength: ctl.chunkBytes, copyTo() { /* fake */ } } as unknown as EncodedVideoChunk, {} as EncodedVideoChunkMetadata);
      }
      flush() { return ctl.flush; }
      close() { this.state = 'closed'; ctl.closed = true; }
    }
    const mb = {
      BufferTarget: class { buffer: ArrayBuffer | null = new ArrayBuffer(8); },
      Output: class {
        addVideoTrack() { /* fake */ }
        async start() { /* fake */ }
        async finalize() { ctl.finalized = true; }
        async cancel() { ctl.cancelled = true; }
      },
      Mp4OutputFormat: class { constructor(_o: unknown) { /* fake */ } },
      EncodedVideoPacketSource: class { async add() { /* fake */ } },
      EncodedPacket: { fromEncodedChunk: (c: unknown) => c },
    };
    return { VideoEncoder: FakeEncoder as unknown as typeof VideoEncoder, mediabunny: mb as never };
  }
  const ctlOf = (o: Partial<Ctl> = {}): Ctl => ({ queue: 0, flush: Promise.resolve(), chunkBytes: 1000, closed: false, cancelled: false, finalized: false, encoded: 0, ...o });
  let png: Blob;
  beforeAll(async () => { const c = new OffscreenCanvas(16, 16); c.getContext('2d')!.fillRect(0, 0, 16, 16); png = await c.convertToBlob({ type: 'image/png' }); });
  const base = (signal?: AbortSignal) => ({ frames: 6, fps: 30, width: 16, height: 16, bitrate: 200_000, getFrame: async () => png, signal });

  it('backpressure waits on the encoder, not on a timer (no setTimeout in the mux)', async () => {
    const src = (await import('../src/core/engine/rv-video-capture?raw')).default as string;
    const mux = src.slice(src.indexOf('export async function muxVideoFrames'), src.indexOf('/** Default MP4 file name'))
      .replace(/^\s*\/\/.*$/gm, '');
    expect(mux).not.toMatch(/setTimeout/);
  });

  it('a stalled encoder queue ends on cancel: rejects, encoder closed, output cancelled', async () => {
    const ctl = ctlOf({ queue: 99 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 80);
    await expect(muxVideoFrames(base(ac.signal), fakes(ctl))).rejects.toThrow(MUX_ABORTED_MESSAGE);
    expect(ctl.closed).toBe(true);
    expect(ctl.cancelled).toBe(true);
    expect(ctl.finalized).toBe(false);
  });

  it('a hanging flush ends on cancel', async () => {
    const ctl = ctlOf({ flush: new Promise<void>(() => { /* never */ }) });
    const ac = new AbortController();
    const p = muxVideoFrames({ ...base(ac.signal), onProgress: (i, n) => { if (i === n - 1) setTimeout(() => ac.abort(), 50); } }, fakes(ctl));
    await expect(p).rejects.toThrow(MUX_ABORTED_MESSAGE);
    expect(ctl.encoded).toBe(6);
    expect(ctl.finalized).toBe(false);
    expect(ctl.cancelled).toBe(true);
  });

  it('cancel on the last frame writes nothing', async () => {
    const ctl = ctlOf();
    const ac = new AbortController();
    const p = muxVideoFrames({ ...base(ac.signal), onProgress: (i, n) => { if (i === n - 1) ac.abort(); } }, fakes(ctl));
    await expect(p).rejects.toThrow(MUX_ABORTED_MESSAGE);
    expect(ctl.finalized).toBe(false);
  });

  it('estimate within budget but encoder output above it → budget error (actual bytes counted)', async () => {
    const ctl = ctlOf({ chunkBytes: 60_000 });
    await expect(muxVideoFrames({ ...base(), maxBytes: 100_000 }, fakes(ctl))).rejects.toThrow(/exceeded the in-memory limit/);
    expect(ctl.finalized).toBe(false);
    // the estimate itself still refuses up front (F12)
    await expect(muxVideoFrames({ ...base(), frames: 300, bitrate: 40_000_000, maxBytes: 1_000_000 }, fakes(ctlOf()))).rejects.toThrow(/Estimated video size/);
  });

  it('a clean run finalizes and returns the bytes', async () => {
    const ctl = ctlOf();
    const r = await muxVideoFrames(base(), fakes(ctl));
    expect(ctl.finalized).toBe(true);
    expect(r.frames).toBe(6);
    expect(r.bytes.byteLength).toBe(8);
  });
});

// ─── plan-556: frame hook (HMI recording) ────────────────────────────────

describe('recordVideo — frameHook (plan-556 F5/F6/F9/F10, N2)', () => {
  /** RGBA pixels of a bitmap (copied before the engine closes it). */
  async function pixels(bitmap: ImageBitmap): Promise<Uint8ClampedArray> {
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
  }

  it.each(['standard', 'high', 'max'] as const)('%s: the snapshot is the encoded frame i; the hook is awaited before the next step', async (quality) => {
    const snaps: Uint8ClampedArray[] = [];
    const sims: number[] = [];
    let stepsDuringHook = 0;
    const r = await recordVideo(viewer, {
      ...SMALL, quality, seconds: 0.2, jitter: 2,
      frameHook: async (i, info) => {
        expect(info.snapshot.width).toBe(320);
        expect(info.snapshot.height).toBe(240);
        expect(info.timestampUs).toBe(Math.round(i * 1e6 / 30));
        const before = viewer.simTime;
        if (i < 2) snaps.push(await pixels(info.snapshot));
        sims.push(info.simTimeMs);
        await new Promise((res) => setTimeout(res, 15));
        if (viewer.simTime !== before) stepsDuringHook++;
      },
    } as VideoRecordOptions);
    expect(stepsDuringHook).toBe(0);
    expect(sims.length).toBe(6);
    sims.forEach((s, i) => expect(s / 1000 - (sims[0] / 1000)).toBeCloseTo(i / 30, 9));
    // layer path: the MP4 comes from the unchanged encoder, frame i = snapshot i (codec tolerance)
    expect((await demuxMp4(r.bytes)).samples).toBe(6);
    for (const i of [0, 1]) {
      const dec = await decodeFrame(r.bytes, i / 30);
      expect(meanAbsDiff(dec.data, snaps[i])).toBeLessThan(6);
    }
  }, 90_000);

  it("'skip' (composite): no encoder, no MP4 bytes, every frame hooked", async () => {
    let n = 0;
    const r = await recordVideo(viewer, { ...SMALL, seconds: 0.2, frameHook: () => { n++; }, frameHookEncode: 'skip' });
    expect(n).toBe(6);
    expect(r.bytes.byteLength).toBe(0);
    expect(r.codec).toBe('none');
    expect(viewer.isCapturing).toBe(false);
  }, 60_000);

  it("'replace' (dialog encoder seam): replacement frames are restamped to i/fps, originals closed, randomized latency → exactly N frames", async () => {
    const made: VideoFrame[] = [];
    const r = await recordVideo(viewer, {
      ...SMALL, seconds: 0.4, frameHookEncode: 'replace',
      frameHook: async (i, info) => {
        await new Promise((res) => setTimeout(res, Math.floor(Math.random() * 25)));
        // a deliberately wrong timestamp — the engine owns the time base
        const f = new VideoFrame(info.snapshot, { timestamp: 999_999 + i, duration: 1 });
        made.push(f);
        return f;
      },
    });
    const mp4 = await demuxMp4(r.bytes);
    expect(mp4.samples).toBe(12);
    mp4.timestamps.forEach((ts, i) => expect(ts).toBeCloseTo(i / 30, 6));
    expect(mp4.duration).toBeCloseTo(12 / 30, 6);
    // the hook's frames were consumed (closed) by the engine
    for (const f of made) expect(f.format).toBeNull();
  }, 60_000);

  it("'replace' refuses a frame of another size; a hook that returns nothing stops the run", async () => {
    await expect(recordVideo(viewer, {
      ...SMALL, seconds: 0.1, frameHookEncode: 'replace',
      frameHook: () => {
        const c = new OffscreenCanvas(100, 100);
        c.getContext('2d')!.fillRect(0, 0, 100, 100);
        return new VideoFrame(c, { timestamp: 0 });
      },
    })).rejects.toThrow(/is 100x100, expected 320x240/);
    await expect(recordVideo(viewer, { ...SMALL, seconds: 0.1, frameHookEncode: 'replace', frameHook: () => undefined }))
      .rejects.toThrow(/returned no frame/);
    expect(viewer.isCapturing).toBe(false);
  }, 60_000);

  it('a hook that never resolves ends at its timeout; viewer restored; a late frame is closed', async () => {
    const t0 = performance.now();
    await expect(recordVideo(viewer, {
      ...SMALL, seconds: 0.1, frameHookTimeoutMs: 300,
      frameHook: () => new Promise<void>(() => { /* never */ }),
    })).rejects.toThrow(/did not finish within/);
    expect(performance.now() - t0).toBeLessThan(10_000);
    expect(viewer.isCapturing).toBe(false);
    expect(isRecording(viewer)).toBe(false);
    expect(loopRunning(viewer)).toBe(true);
  }, 60_000);

  it('abort during the hook → "Recording aborted", viewer restored', async () => {
    const ac = new AbortController();
    await expect(recordVideo(viewer, {
      ...SMALL, seconds: 0.2, signal: ac.signal,
      frameHook: (i) => (i === 1 ? new Promise<void>(() => { ac.abort(); }) : undefined),
    })).rejects.toThrow(/^Recording aborted/);
    expect(viewer.isCapturing).toBe(false);
  }, 60_000);

  it('rejects an unknown frameHookEncode', async () => {
    await expect(recordVideo(viewer, { ...SMALL, seconds: 0.1, frameHook: () => undefined, frameHookEncode: 'nope' as never }))
      .rejects.toThrow(/Unknown frameHookEncode/);
    expect(viewer.isCapturing).toBe(false);
  }, 30_000);
});

describe('captureStill — reset + steps + frame hook (plan-556 F5b)', () => {
  it('--at 0 = the reset state (no step); --at 0.51 = 31 fixed steps after the reset; the hook gets the image', async () => {
    // Let the live simulation run away from the load state first.
    await new Promise((r) => setTimeout(r, 200));
    viewer.resetSimulation();
    const reset = viewer.simTime;
    const x0 = slideX();
    await new Promise((r) => setTimeout(r, 200));
    const a = await captureStill(viewer, { width: 320, height: 240, quality: 'standard', resetSimulation: true, steps: 0 });
    expect(a.simTime).toBe(reset);
    expect(slideX()).toBeCloseTo(x0, 9);
    let hooked: { w: number; h: number; png: number; sim: number } | null = null;
    const b = await captureStill(viewer, {
      width: 320, height: 240, quality: 'standard', resetSimulation: true, steps: Math.round(0.51 * 60),
      frameHook: ({ snapshot, png, simTimeMs }) => { hooked = { w: snapshot.width, h: snapshot.height, png: png.byteLength, sim: simTimeMs }; },
    });
    expect(b.simTime - reset).toBeCloseTo(31 / 60, 9);
    expect(hooked).toEqual({ w: 320, h: 240, png: b.png.byteLength, sim: b.simTime * 1000 });
    expect(viewer.isCapturing).toBe(false);
  }, 60_000);

  it('rejects a negative or fractional step count', async () => {
    await expect(captureStill(viewer, { width: 320, height: 240, quality: 'standard', steps: -1 })).rejects.toThrow(/steps must be/);
    await expect(captureStill(viewer, { width: 320, height: 240, quality: 'standard', steps: 1.5 })).rejects.toThrow(/steps must be/);
  });
});
