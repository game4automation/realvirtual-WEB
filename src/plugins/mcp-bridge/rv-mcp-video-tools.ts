// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-video-tools — `web_record_video` (plan-537 F7): a deterministic,
 * frame-by-frame MP4 of the loaded model, recorded in the browser.
 *
 * The bytes never cross the bridge (2 MiB WebSocket cap): the MP4 is written
 * into the open project (`recordings/<name>.mp4`) when it is writable, else the
 * browser downloads it. The tool cannot be cancelled (CONNECT has no cancel
 * path to the browser, F10); instead it refuses jobs whose estimated render
 * time × 2 exceeds the 600 s tool limit, and every capture carries a local
 * deadline of 540 s (F2g) so a CONNECT timeout can never leave a capture or
 * its lock behind.
 *
 * Delegate class of McpBridgePlugin (see rv-mcp-instances.ts).
 */

import type { RVViewer } from '../../core/rv-viewer';
import { McpTool, McpParam } from '../../core/engine/rv-mcp-tools';
import type {
  CameraPathSpec, VideoCodecChoice, VideoQuality, VideoRecordOptions,
} from '../../core/engine/rv-video-capture';

/** Answer to `quality: 'cinematic'` — the path-traced recording is CLI-only (plan-550 F6/F14). */
export const CINEMATIC_MCP_ERROR = 'quality "cinematic" (path traced) is not available through MCP — a cinematic clip renders for minutes to hours and resumes from frames on disk. Record it with the CLI: npm run record -- <viewer url> --quality cinematic --out-dir <dir> [--samples 64] [--denoise aux|noaux|off].';

/** Tool timeout (ms) — the bridge maximum. */
export const VIDEO_TOOL_TIMEOUT_MS = 600_000;
/** Local capture deadline (ms) — below the bridge limit (F2g). */
export const VIDEO_TOOL_DEADLINE_MS = 540_000;

/** Raw tool arguments (primitives only — McpToolRegistry maps nothing else). */
export interface VideoToolArgs {
  seconds?: number;
  fps?: number;
  width?: number;
  height?: number;
  path?: string;
  views?: string;
  target?: string;
  radiusScale?: number;
  sweepDeg?: number;
  startDeg?: number;
  orbitHeight?: number;
  easing?: string;
  fov?: number;
  warmup?: number;
  quality?: string;
  bitrate?: number;
  codec?: string;
  name?: string;
}

/**
 * Parse `views` — `"iso:3:1, front, cam1:2"` = view[:transition[:hold]], comma
 * separated — into the presets spec.
 */
export function parseViewList(raw: string): Array<{ view: string; transition?: number; hold?: number }> {
  return raw.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    const [view, tr, hold] = part.split(':').map((x) => x.trim());
    const out: { view: string; transition?: number; hold?: number } = { view };
    if (tr !== undefined && tr !== '') out.transition = Number(tr);
    if (hold !== undefined && hold !== '') out.hold = Number(hold);
    return out;
  });
}

/** Map the flat tool arguments onto `VideoRecordOptions` (validation happens in the engine). */
export function videoToolOptions(a: VideoToolArgs): VideoRecordOptions {
  const kind = (a.path ?? 'orbit').trim().toLowerCase();
  let path: CameraPathSpec;
  if (kind === 'orbit') {
    path = {
      kind: 'orbit',
      ...(a.target ? { target: a.target } : {}),
      ...(typeof a.radiusScale === 'number' ? { radiusScale: a.radiusScale } : {}),
      ...(typeof a.sweepDeg === 'number' ? { sweepDeg: a.sweepDeg } : {}),
      ...(typeof a.startDeg === 'number' ? { startDeg: a.startDeg } : {}),
      ...(typeof a.orbitHeight === 'number' ? { height: a.orbitHeight } : {}),
      ...(a.easing === 'inOut' || a.easing === 'none' ? { easing: a.easing } : {}),
      ...(typeof a.fov === 'number' ? { fov: a.fov } : {}),
    };
  } else if (kind === 'presets') {
    const views = parseViewList(a.views ?? '');
    if (views.length === 0) throw new Error('path=presets needs views, e.g. "iso, front:3:1, cam1".');
    path = { kind: 'presets', views, ...(typeof a.fov === 'number' ? { fov: a.fov } : {}) };
  } else if (kind === 'fixed') {
    path = { kind: 'fixed' };
  } else {
    throw new Error(`Unknown path "${a.path}" — use orbit, presets or fixed.`);
  }
  if (typeof a.seconds !== 'number') throw new Error('seconds is required.');
  return {
    seconds: a.seconds,
    ...(typeof a.fps === 'number' ? { fps: a.fps } : {}),
    ...(typeof a.width === 'number' ? { width: a.width } : {}),
    ...(typeof a.height === 'number' ? { height: a.height } : {}),
    ...(typeof a.warmup === 'number' ? { warmupSeconds: a.warmup } : {}),
    ...(typeof a.bitrate === 'number' ? { bitrate: a.bitrate } : {}),
    ...(a.codec ? { codec: a.codec as VideoCodecChoice } : {}),
    ...(a.quality ? { quality: a.quality as VideoQuality } : {}),
    path,
  };
}

/**
 * Conservative render-time estimate in seconds: the viewer's current live
 * frame time (≥ 4 ms, vsync included — deliberately pessimistic) scaled by the
 * pixel ratio of the capture render size to the live canvas, times sub-renders
 * per frame, plus the warmup steps and an encode allowance.
 */
export function estimateRenderSeconds(p: {
  frames: number; subRenders: number; renderPixels: number; canvasPixels: number;
  liveFrameMs: number; warmupSteps: number;
}): number {
  const perRenderMs = Math.max(4, p.liveFrameMs) * Math.max(1, p.renderPixels / Math.max(1, p.canvasPixels));
  const encodeMs = p.renderPixels * 2e-6; // ≈ 2 ms per megapixel
  return (p.frames * (p.subRenders * perRenderMs + encodeMs) + p.warmupSteps * 1) / 1000;
}

export class McpVideoTools {
  constructor(private readonly getViewer: () => RVViewer | undefined) {}

  @McpTool('Record a deterministic MP4 of the 3D canvas: the simulation advances exactly 1/fps per frame, so the video is smooth regardless of real-time FPS or a hidden tab. Saved to recordings/<name>.mp4 in a writable project, else downloaded; returns path, frames, size — never bytes. Not cancellable: jobs estimated above the 600 s limit are refused.', { readOnly: false, timeoutMs: VIDEO_TOOL_TIMEOUT_MS })
  async webRecordVideo(
    @McpParam('seconds', 'Sim seconds encoded; × fps must be whole.') seconds: number,
    @McpParam('fps', '30 | 60 (default).', 'number', false) fps?: number,
    @McpParam('width', 'Even px (1920).', 'number', false) width?: number,
    @McpParam('height', 'Even px (1080).', 'number', false) height?: number,
    @McpParam('path', 'orbit (default) | presets | fixed.', 'string', false) path?: string,
    @McpParam('views', 'presets: "iso, front:3:1, cam1" = view[:transition[:hold]] s.', 'string', false) views?: string,
    @McpParam('target', 'orbit: node path (default model).', 'string', false) target?: string,
    @McpParam('radiusScale', 'orbit: × fitted radius.', 'number', false) radiusScale?: number,
    @McpParam('sweepDeg', 'orbit: degrees (360).', 'number', false) sweepDeg?: number,
    @McpParam('startDeg', 'orbit: start azimuth, 0 = front.', 'number', false) startDeg?: number,
    @McpParam('orbitHeight', 'orbit: m above centre.', 'number', false) orbitHeight?: number,
    @McpParam('easing', 'orbit: none | inOut.', 'string', false) easing?: string,
    @McpParam('fov', 'Degrees.', 'number', false) fov?: number,
    @McpParam('warmup', 'Sim seconds before frame 0 (3).', 'number', false) warmup?: number,
    @McpParam('quality', 'standard | high (default) | max.', 'string', false) quality?: string,
    @McpParam('bitrate', 'Bit/s (1080p60: 40 M).', 'number', false) bitrate?: number,
    @McpParam('codec', 'avc (default) | hevc | av1 | vp9.', 'string', false) codec?: string,
    @McpParam('name', 'File name without .mp4.', 'string', false) name?: string,
  ): Promise<string> {
    const viewer = this.getViewer();
    if (!viewer) return JSON.stringify({ error: 'No viewer' });
    // plan-550: a cinematic (path-traced) recording takes minutes to hours per clip and writes
    // frames to disk with resume — far beyond one tool call. It is CLI-only.
    if (typeof quality === 'string' && quality.trim().toLowerCase() === 'cinematic') {
      return JSON.stringify({ error: CINEMATIC_MCP_ERROR });
    }
    const engine = await import('../../core/engine/rv-video-capture');
    let options: VideoRecordOptions;
    let norm: ReturnType<typeof engine.normalizeVideoOptions>;
    try {
      options = videoToolOptions({
        seconds, fps, width, height, path, views, target, radiusScale, sweepDeg, startDeg,
        orbitHeight, easing, fov, warmup, quality, bitrate, codec,
      });
      norm = engine.normalizeVideoOptions(options);
    } catch (e) {
      return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
    }
    const pre = engine.isRecording(viewer) ? 'A video capture is already running on this viewer.' : viewer.capturePreflight();
    if (pre) return JSON.stringify({ error: pre });

    // Runtime guard (F10): estimate × 2 must stay below the tool limit.
    const ss = norm.supersample > 1
      ? engine.computeSupersample(norm.width, norm.height, norm.supersample, viewer.getCaptureGpuLimits())
      : 1;
    const canvas = viewer.renderer.domElement as HTMLCanvasElement;
    const estimate = estimateRenderSeconds({
      frames: norm.frames,
      subRenders: norm.jitter > 0 ? norm.jitter : 1,
      renderPixels: norm.width * ss * norm.height * ss,
      canvasPixels: (canvas.width || 1) * (canvas.height || 1),
      liveFrameMs: viewer.currentFrameTime || 16.7,
      warmupSteps: norm.warmupSteps,
    });
    const limitS = VIDEO_TOOL_TIMEOUT_MS / 1000;
    if (estimate * 2 > limitS) {
      return JSON.stringify({
        error: `Estimated render time ${estimate.toFixed(0)} s is too long for one tool call (limit ${limitS} s with a 2× safety margin). Shorten seconds, lower width/height or quality — or record with the CLI (npm run record), which has no time limit.`,
        estimatedRenderSeconds: +estimate.toFixed(1),
      });
    }

    let result;
    try {
      result = await engine.recordVideo(viewer, { ...options, deadlineMs: VIDEO_TOOL_DEADLINE_MS });
    } catch (e) {
      return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
    }

    const modelName = (viewer.currentModelUrl ?? '').split(/[\\/]/).pop() ?? 'recording';
    const fileName = name && name.trim()
      ? `${name.trim().replace(/\.mp4$/i, '').replace(/[^a-zA-Z0-9_-]+/g, '_')}.mp4`
      : engine.defaultVideoFileName(modelName);
    const summary = {
      frames: result.frames,
      seconds: result.seconds,
      fps: result.fps,
      width: result.width,
      height: result.height,
      sizeBytes: result.bytes.byteLength,
      codec: result.codec,
      quality: result.quality,
      supersample: result.supersample,
      jitter: result.jitter,
      renderSeconds: result.renderSeconds,
      simStart: +result.simStart.toFixed(4),
      simEnd: +result.simEnd.toFixed(4),
    };

    const { getProjectStore } = await import('../../core/project/project-store');
    const backend = getProjectStore().getBackend();
    if (backend?.writable) {
      const relPath = `recordings/${fileName}`;
      try {
        await backend.writeDocument(relPath, result.bytes, { expectedRevision: 'any' });
        return JSON.stringify({ path: relPath, ...summary });
      } catch (e) {
        engine.downloadVideo(result.bytes, fileName);
        return JSON.stringify({
          download: fileName, ...summary,
          saveError: `Could not write "${relPath}": ${e instanceof Error ? e.message : String(e)} — downloaded instead.`,
        });
      }
    }
    engine.downloadVideo(result.bytes, fileName);
    return JSON.stringify({ download: fileName, ...summary });
  }
}
