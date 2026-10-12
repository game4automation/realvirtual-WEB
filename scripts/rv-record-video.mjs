// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-record-video — `npm run record` (plan-537 F6).
 *
 * Opens the viewer in its OWN Chrome window (GPU, MCP bridge disabled with
 * `mcpPort=1`), waits until the scene is ready, runs the deterministic capture
 * (`viewer.recordVideo`) via `page.evaluate`, receives the MP4 through
 * Playwright's `download` event (no bytes over CDP) and saves it. Afterwards the
 * file is demuxed and the frame count is verified against fps × seconds.
 *
 * The capture does not depend on rAF or the compositor, so the window may be
 * hidden, occluded or on a minimised RDP desktop.
 *
 *   npm run record -- http://localhost:5173/?project=prj_sample&doc=doc_x --seconds 40
 *   npm run record -- --project prj_sample --doc doc_x --size 1080x1080 --fps 60 --seconds 40
 *
 * Options:
 *   <url>                  viewer URL (default --base + ?project/&doc)
 *   --base <url>           dev server root (default http://localhost:5173/)
 *   --project <id> --doc <id>
 *   --path orbit|presets|fixed   (default orbit)
 *   --views "iso,front:3:1,cam1" presets: view[:transition[:hold]]
 *   --target <node path>   orbit centre (default model bounds)
 *   --orbit-from-view      orbit around the current view's target at its distance and height (plan-551 F3)
 *   --radius-scale <n>  --sweep <deg>  --start <deg>  --orbit-height <m>  --easing none|inOut  --fov <deg>
 *   --size WxH (1920x1080)  --fps 30|60 (60)  --seconds <s> (10)  --warmup <s> (3)
 *   --quality standard|high|max (high)  --jitter <n>  --bitrate <bit/s>  --codec avc|hevc|av1|vp9
 *   --out <file.mp4>       (default recordings/<model>-<timestamp>.mp4 under the cwd)
 *   --browser chrome|chromium (chrome)   --headless   --load-timeout <s> (180)
 *
 * Cinematic (plan-550, commercial builds): `--quality cinematic --out-dir <dir>` path traces every
 * frame (three-gpu-pathtracer on WebGPU), writes it as `<dir>/frame-%06d.png` the moment it is
 * done and muxes the MP4 at the end. A run started again with the same options RESUMES at the first
 * missing frame (`<dir>/cinematic.json` guards that it is the same recording).
 *   --samples <n> (64)   --denoise aux|noaux|off (aux)   --hdr <file.hdr>   --out-dir <dir> (required)
 *   --mp4 <file> (default <dir>/<model>.mp4)
 * Look (plan-553): --look studio|viewer|hall|outdoor (studio; viewer = the viewer's environment
 *   preset and lights, the plan-550 image)   --vignette <0..0.5> (0.15, 0 = off)   --dof (depth of
 *   field, focus on the camera target)   --fstop <n> (5.6)   --no-material-presets
 *   --material-overrides <cinematic-materials.json>. `--hdr` replaces the look's HDR (the look's
 *   lights, floor and tone curve stay).
 * Motion blur (plan-554, default on): --motion-blur on|off   --shutter <deg 0..360> (180; 0 = off)
 *   --blur-subframes <2..32> (8). A resume refuses a folder rendered with another requested OR
 *   resolved blur (checked again after the scene setup, before the first frame).
 *
 * HMI (plan-556): --hmi composite|layer|off (off) puts the React HMI into the video, frame-synchronous
 *   with the plant (viewport = output size, viewer chrome hidden, simulation reset at the start).
 *   composite = page screenshot per frame (3D underlay + HMI) → `<out-dir>/frame-%06d.png` → `--mp4`;
 *   layer = the 3D MP4 as without HMI + `<out-dir>/hmi-%06d.png` (HMI alone, straight alpha).
 *   Raster HMI runs need a NEW --out-dir and --mp4; cinematic resumes as before (layer: frame + hmi
 *   pairs). --hmi-open <id,...> expands operator panels / opens the CONNECT panel;
 *   --keep-frames true|false (composite, default true); --hmi-timeout <s> (30) bounds every settle /
 *   screenshot. --still <file.png> [--at <s>] = ONE image after a reset + round(at·60) steps
 *   (raster or cinematic, any --hmi; layer also writes <file>-hmi.png).
 *
 * Exit codes: 0 ok, 1 recording/verification failed, 2 usage error,
 *             3 cinematic run stopped but resumable (Ctrl+C, stalled frame, lost GPU) — run again.
 * No shebang in `scripts/*.mjs` (vite-node + CRLF, plan-503).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkDiskSpace, compareManifest, formatDuration, isCompletePng, optionsHash, readManifest,
  removeTempFiles, scanFrames, sha256, writeFrameAtomic, writeManifest,
} from './lib/rv-cinematic-frames.mjs';
import {
  blurManifestFields, cinematicBaseManifestWith, cinematicHashedOptions, resumeRefusal,
} from '../src/core/engine/rv-cinematic-manifest.mjs';
import {
  checkFreshOutDir, countFrames, createHmiFrameWriter, deleteCompositeFrames, enterRecordingPage, exitRecordingPage,
  bootCleanupInitScript, hmiCliOptions, hmiFileName, installPageHook, muxFrameDir, scanPairs, stillLayerPath,
} from './lib/rv-record-hmi.mjs';

/** Exit code of a cinematic run that stopped but can be resumed (plan-550 F11). */
export const EXIT_RESUMABLE = 3;

/** A usage error (exit code 2) — thrown, so the option rules are testable. */
export class CliUsageError extends Error {}

function usage(msg) {
  throw new CliUsageError(msg ?? 'invalid arguments');
}

function printUsage(msg) {
  if (msg) console.error(`rv-record-video: ${msg}`);
  console.error('usage: npm run record -- [<url>] [--project <id> --doc <id>] [--path orbit|presets|fixed] [--size 1920x1080] [--fps 60] [--seconds 10] [--quality high] [--out file.mp4]');
  console.error('       npm run record -- … --quality cinematic --out-dir <dir> [--samples 64] [--denoise aux|noaux|off] [--hdr file.hdr]');
  console.error('         [--look studio|viewer|hall|outdoor] [--vignette 0.15] [--dof] [--fstop 5.6] [--no-material-presets] [--material-overrides file.json]');
  console.error('         [--motion-blur on|off] [--shutter 180] [--blur-subframes 8]');
  console.error('       npm run record -- … --hmi composite|layer [--hmi-open id,…] --out-dir <new dir> --mp4 <file> [--keep-frames true|false]');
  console.error('       npm run record -- … --still <file.png> [--at <s>] [--hmi composite|layer|off]');
}

/** Parse argv into { url, opts }. Exported shape kept flat on purpose. */
export function parseArgs(argv) {
  const opts = {};
  let url = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      if (url) usage(`unexpected argument "${a}"`);
      url = a;
      continue;
    }
    const key = a.slice(2);
    if (key === 'headless') { opts.headless = true; continue; }
    if (key === 'orbit-from-view') { opts['orbit-from-view'] = true; continue; }
    if (key === 'dof') { opts.dof = true; continue; }
    if (key === 'no-material-presets') { opts['no-material-presets'] = true; continue; }
    const val = argv[++i];
    if (val === undefined) usage(`${a} needs a value`);
    opts[key] = val;
  }
  return { url, opts };
}

function num(v, name) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) usage(`${name} must be a number`);
  return n;
}

/** Build the viewer URL: the MCP bridge is always disabled (mcpPort=1). */
export function buildUrl(url, opts) {
  const base = opts.base ?? 'http://localhost:5173/';
  const u = new URL(url ?? base);
  if (!url) {
    if (opts.project) u.searchParams.set('project', opts.project);
    if (opts.doc) u.searchParams.set('doc', opts.doc);
  }
  u.searchParams.set('mcpPort', '1');
  return u.toString();
}

/** Map CLI options onto VideoRecordOptions (validated again in the browser). */
export function recordOptions(opts) {
  const size = (opts.size ?? '1920x1080').toLowerCase().split('x').map(Number);
  if (size.length !== 2 || !size.every((n) => Number.isFinite(n) && n > 0)) usage('--size must be WxH');
  const kind = opts.path ?? 'orbit';
  let path;
  if (kind === 'orbit') {
    path = { kind: 'orbit' };
    if (opts.target) path.target = opts.target;
    if (opts['orbit-from-view'] === true) path.fromCurrentView = true;
    if (opts['radius-scale'] !== undefined) path.radiusScale = num(opts['radius-scale'], '--radius-scale');
    if (opts.sweep !== undefined) path.sweepDeg = num(opts.sweep, '--sweep');
    if (opts.start !== undefined) path.startDeg = num(opts.start, '--start');
    if (opts['orbit-height'] !== undefined) path.height = num(opts['orbit-height'], '--orbit-height');
    if (opts.easing) path.easing = opts.easing;
    if (opts.fov !== undefined) path.fov = num(opts.fov, '--fov');
  } else if (kind === 'presets') {
    if (!opts.views) usage('--path presets needs --views');
    path = {
      kind: 'presets',
      views: opts.views.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
        const [view, tr, hold] = s.split(':');
        const v = { view };
        if (tr) v.transition = Number(tr);
        if (hold) v.hold = Number(hold);
        return v;
      }),
    };
    if (opts.fov !== undefined) path.fov = num(opts.fov, '--fov');
  } else if (kind === 'fixed') {
    path = { kind: 'fixed' };
    if (opts['orbit-from-view'] === true) usage('--orbit-from-view needs --path orbit');
  } else {
    usage(`unknown --path "${kind}"`);
  }
  const o = {
    width: size[0], height: size[1],
    fps: num(opts.fps, '--fps') ?? 60,
    seconds: num(opts.seconds, '--seconds') ?? 10,
    warmupSeconds: num(opts.warmup, '--warmup') ?? 3,
    quality: opts.quality ?? 'high',
    path,
  };
  if (opts.jitter !== undefined) o.jitter = num(opts.jitter, '--jitter');
  if (opts.bitrate !== undefined) o.bitrate = num(opts.bitrate, '--bitrate');
  if (opts.codec) o.codec = opts.codec;
  // plan-556: the HMI options (validated here; they enter the manifest only when the HMI is on).
  const hmi = hmiCliOptions(opts, o.quality, usage);
  if (hmi.on) {
    o.hmi = hmi.mode;
    o.hmiOpen = hmi.open;
    o.viewport = { width: o.width, height: o.height };
  }
  if (o.quality === 'cinematic') {
    o.samples = num(opts.samples, '--samples') ?? 64;
    if (!Number.isInteger(o.samples) || o.samples < 1) usage('--samples must be a positive integer');
    o.denoise = opts.denoise ?? 'aux';
    if (!['aux', 'noaux', 'off'].includes(o.denoise)) usage('--denoise must be aux, noaux or off');
    if (!opts['out-dir'] && hmi.still === null) usage('--quality cinematic needs --out-dir <dir> (frames + resume manifest live there)');
    if (opts.hdr && !existsSync(opts.hdr)) usage(`--hdr file not found: ${opts.hdr}`);
    // plan-553 look options — validated again in the browser (normalizeLookRequest).
    o.look = opts.look ?? 'studio';
    if (!CLI_LOOKS.includes(o.look)) usage(`--look must be one of ${CLI_LOOKS.join(', ')}`);
    if (opts.vignette !== undefined) {
      o.vignette = num(opts.vignette, '--vignette');
      if (!(o.vignette >= 0 && o.vignette <= 0.5)) usage('--vignette must be between 0 and 0.5');
    }
    if (opts.dof === true) o.dof = true;
    if (opts.fstop !== undefined) {
      if (o.dof !== true) usage('--fstop needs --dof');
      o.fStop = num(opts.fstop, '--fstop');
      if (!(o.fStop >= 0.5 && o.fStop <= 64)) usage('--fstop must be between 0.5 and 64');
    }
    if (opts['no-material-presets'] === true) o.materialPresets = false;
    if (opts['material-overrides'] !== undefined) o.materialOverrides = readOverrides(opts['material-overrides']);
    o.motionBlur = motionBlurOptions(opts);
  } else {
    for (const k of [
      'samples', 'denoise', 'hdr', 'out-dir', 'mp4', 'look', 'vignette', 'dof', 'fstop', 'no-material-presets', 'material-overrides',
      'motion-blur', 'shutter', 'blur-subframes',
    ]) {
      // plan-556 F5a: a raster HMI run writes a frame folder + an MP4 — only then are these valid.
      if (hmi.on && (k === 'out-dir' || k === 'mp4')) continue;
      if (opts[k] !== undefined) usage(`--${k} is only valid with --quality cinematic`);
    }
  }
  if (hmi.still !== null && o.quality === 'cinematic') {
    for (const k of ['motion-blur', 'shutter', 'blur-subframes']) {
      if (opts[k] !== undefined) usage(`--${k} is not valid with --still (a still has no shutter)`);
    }
  }
  return o;
}

/** The HMI / still options of an argv option map (plan-556; `recordOptions` validated them already). */
export function hmiOptionsOf(opts, quality) {
  return hmiCliOptions(opts, quality, usage);
}

/** The VideoRecordOptions without the CLI-only HMI fields (they are manifest data, not engine options). */
export function engineOptions(options) {
  const { hmi: _h, hmiOpen: _o, viewport: _v, ...rest } = options;
  return rest;
}

/** The still options of a recording option set (plan-556 F5b): no camera path, no time, no blur. */
export function stillOptions(options, hmi) {
  const o = {
    width: options.width, height: options.height, quality: options.quality,
    resetSimulation: true, steps: hmi.steps,
  };
  if (options.jitter !== undefined) o.jitter = options.jitter;
  if (options.quality === 'cinematic') {
    for (const k of ['samples', 'denoise', 'look', 'dof', 'fStop', 'vignette', 'materialPresets', 'materialOverrides']) {
      if (options[k] !== undefined) o[k] = options[k];
    }
  }
  return o;
}

/**
 * plan-554 F8: `--motion-blur on|off`, `--shutter <deg>`, `--blur-subframes <n>` → the
 * `motionBlur` option (validated again in the browser by `normalizeMotionBlur`). Defaults are
 * left to the page (on, 180°, 8) so the CLI and the dialog hash the same request.
 */
export function motionBlurOptions(opts) {
  const mb = {};
  const flag = opts['motion-blur'];
  if (flag !== undefined) {
    if (flag !== 'on' && flag !== 'off') usage('--motion-blur must be on or off');
    mb.enabled = flag === 'on';
  }
  if (opts.shutter !== undefined) {
    mb.shutterDeg = num(opts.shutter, '--shutter');
    if (!(mb.shutterDeg >= 0 && mb.shutterDeg <= 360)) usage('--shutter must be between 0 and 360 (degrees)');
  }
  if (opts['blur-subframes'] !== undefined) {
    mb.subFrames = num(opts['blur-subframes'], '--blur-subframes');
    if (!Number.isInteger(mb.subFrames) || mb.subFrames < 2 || mb.subFrames > 32) usage('--blur-subframes must be an integer between 2 and 32');
  }
  return mb;
}

/**
 * plan-554 F7: the second resume compare, after the page's scene setup and before the first
 * frame — the RESOLVED blur of this run against the stored one. Returns the refusal or null.
 */
export function setupBlurRefusal(stored, info, resuming, wording) {
  if (!resuming) return null;
  return compareManifest(stored, blurManifestFields(info?.motionBlur), wording);
}

/** Looks of the cinematic render (mirror of CINEMATIC_LOOKS in rv-cinematic-hook.ts). */
const CLI_LOOKS = ['studio', 'viewer', 'hall', 'outdoor'];

/** Reads and checks a `cinematic-materials.json` (plan-553 F3c); its CONTENT enters the fingerprint. */
export function readOverrides(file) {
  if (!existsSync(file)) usage(`--material-overrides file not found: ${file}`);
  let v;
  try {
    v = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    usage(`--material-overrides ${file} is not valid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!v || typeof v !== 'object' || !Array.isArray(v.rules)) usage(`--material-overrides ${file} needs a "rules" array`);
  for (const r of v.rules) {
    if (!r || typeof r.match !== 'string' || typeof r.preset !== 'string') usage(`--material-overrides ${file}: every rule needs "match" and "preset" strings`);
  }
  return v;
}

/**
 * The part of the manifest the CLI knows before the page opens. Everything that changes the
 * image or the timing goes into `optionsHash`; the readable copies make a refusal name the field.
 */
export function cinematicBaseManifest(options, hdrFileHash) {
  // Shared with the viewer's "Record video" dialog (plan-551 F5): same fields, same hash.
  return cinematicBaseManifestWith(options, optionsHash(cinematicHashedOptions(options, hdrFileHash)));
}

async function main() {
  let parsed;
  try {
    const { url: rawUrl, opts } = parseArgs(process.argv.slice(2));
    if (!rawUrl && !opts.doc && !opts.project && !opts.base) usage('give a viewer URL or --project/--doc');
    const options = recordOptions(opts);
    parsed = { rawUrl, opts, options, hmi: hmiOptionsOf(opts, options.quality) };
  } catch (e) {
    if (e instanceof CliUsageError) {
      printUsage(e.message);
      process.exitCode = 2;
      return;
    }
    throw e;
  }
  const { rawUrl, opts, options, hmi } = parsed;
  const url = buildUrl(rawUrl, opts);
  const frames = Math.round(options.seconds * options.fps);
  const browserName = opts.browser ?? 'chrome';
  const loadTimeoutMs = (num(opts['load-timeout'], '--load-timeout') ?? 180) * 1000;
  // plan-556 F2: with the HMI (or a still) the browser viewport IS the output (CSS px, DSF 1).
  const outputViewport = hmi.on || hmi.still !== null;

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    ...(browserName === 'chrome' ? { channel: 'chrome' } : {}),
    headless: opts.headless === true,
    args: [
      '--ignore-gpu-blocklist',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      // Cinematic: the path tracer runs on its own WebGPU device next to the WebGL viewer.
      ...(options.quality === 'cinematic' ? ['--enable-unsafe-webgpu'] : []),
    ],
  });
  let page = null;
  let hmiEntered = false;
  const onSigint = async () => {
    console.error('\nrv-record-video: aborting …');
    try { await page?.evaluate(() => window.__rvRecordAbort?.abort()); } catch { /* page gone */ }
  };
  process.once('SIGINT', onSigint);
  try {
    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: outputViewport ? { width: options.width, height: options.height } : { width: 1280, height: 800 },
      ...(outputViewport ? { deviceScaleFactor: 1 } : {}),
    });
    if (outputViewport) await context.addInitScript(bootCleanupInitScript);
    page = await context.newPage();
    page.on('pageerror', (e) => console.error(`[page] ${e.message}`));
    console.log(`rv-record-video: opening ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: loadTimeoutMs });
    await page.waitForFunction(() => {
      const v = window.viewer;
      return !!v && !!v.currentModelRoot && typeof v.recordVideo === 'function';
    }, null, { timeout: loadTimeoutMs, polling: 500 });
    await page.evaluate(() => window.viewer.whenSceneReady());
    const model = await page.evaluate(() => window.viewer.currentModelUrl ?? 'recording');
    if (hmi.on) {
      const r = await enterRecordingPage(page, { open: hmi.open });
      hmiEntered = true;
      // The recording shell mounts; one frame later the panels have their layout.
      await page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))));
      if (r.rect && (Math.abs(r.rect.width - options.width) > 1 || Math.abs(r.rect.height - options.height) > 1)) {
        throw new Error(`The viewport is ${r.rect.width}x${r.rect.height}, the output ${options.width}x${options.height} — the composite would be distorted.`);
      }
      console.log(`rv-record-video: HMI ${hmi.mode}${hmi.open.length ? ` · opened ${hmi.open.join(', ')}` : ''} · viewport ${r.viewport.width}x${r.viewport.height}`);
    }
    if (hmi.still !== null) {
      process.exitCode = await runStill({ page, opts, options, hmi });
      return;
    }
    if (options.quality === 'cinematic') {
      process.exitCode = await runCinematic({ page, url, opts, options, model, hmi });
      return;
    }
    if (hmi.on) {
      process.exitCode = await runRasterHmi({ page, url, opts, options, model, hmi });
      return;
    }

    let lastPct = -1;
    await page.exposeFunction('__rvRecordProgress', (i, n) => {
      const pct = Math.floor(((i + 1) / n) * 100);
      if (pct !== lastPct && (pct % 5 === 0 || i + 1 === n)) {
        lastPct = pct;
        process.stdout.write(`\r  frame ${i + 1}/${n} (${pct} %)`);
      }
    });

    const base = modelBaseName(model);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const fileName = `${base}-${stamp}.mp4`;
    const out = resolve(opts.out ?? `recordings/${fileName}`);
    mkdirSync(dirname(out), { recursive: true });

    console.log(`rv-record-video: recording ${frames} frames ${options.width}x${options.height}@${options.fps} (${options.quality}, ${options.path.kind})`);
    const downloadP = page.waitForEvent('download', { timeout: 0 });
    const summary = await page.evaluate(async ({ options, fileName }) => {
      const ac = new AbortController();
      window.__rvRecordAbort = ac;
      const every = Math.max(1, Math.round(options.fps / 2));
      const r = await window.viewer.recordVideo({
        ...options,
        signal: ac.signal,
        onProgress: (i, n) => { if (i % every === 0 || i + 1 === n) void window.__rvRecordProgress(i, n); },
      });
      const blob = new Blob([r.bytes], { type: 'video/mp4' });
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 120_000);
      const { bytes, ...rest } = r;
      return { ...rest, sizeBytes: bytes.byteLength };
    }, { options: engineOptions(options), fileName });
    process.stdout.write('\n');
    const download = await downloadP;
    await download.saveAs(out);

    const check = await countFrames(out);
    const size = statSync(out).size;
    console.log(`rv-record-video: ${out}`);
    console.log(`  frames ${check.frames}/${frames}, duration ${check.duration.toFixed(3)} s, ${check.width}x${check.height}, ${(size / 1048576).toFixed(2)} MB`);
    console.log(`  codec ${summary.codec} (${summary.hardwareAcceleration}), quality ${summary.quality} ss=${summary.supersample} jitter=${summary.jitter}, render ${summary.renderSeconds} s`);
    writeFileSync(`${out}.json`, JSON.stringify({ file: out, url, ...summary, verifiedFrames: check.frames, sizeBytes: size }, null, 2));
    if (check.frames !== frames) {
      console.error(`rv-record-video: FRAME COUNT MISMATCH — expected ${frames}, got ${check.frames}`);
      process.exitCode = 1;
    }
  } catch (e) {
    console.error(`\nrv-record-video: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = e?.usage ? 2 : 1;
  } finally {
    process.off('SIGINT', onSigint);
    if (hmiEntered && page) await exitRecordingPage(page);
    await browser.close();
  }
}

function modelBaseName(model) {
  return String(model).split(/[\\/]/).pop().replace(/\.[a-z0-9]+$/i, '').replace(/[^a-zA-Z0-9_-]+/g, '_') || 'recording';
}

/** Progress printer of HMI frames (every 5 %). */
function hmiProgress(frames, label) {
  let lastPct = -1;
  return (i) => {
    const pct = Math.floor(((i + 1) / frames) * 100);
    if (pct !== lastPct && (pct % 5 === 0 || i + 1 === frames)) {
      lastPct = pct;
      process.stdout.write(`\r  ${label} ${i + 1}/${frames} (${pct} %)`);
    }
  };
}

/**
 * Raster recording WITH the HMI (plan-556 F5/F5a/F6): a fresh `--out-dir`, the simulation reset at
 * the start, per frame the same-task snapshot as underlay + HMI settle + a page screenshot.
 * composite → `frame-%06d.png` (no encoder in the page) → muxed to `--mp4`; layer → the MP4 from the
 * unchanged encoder path + `hmi-%06d.png`. Returns the exit code.
 */
async function runRasterHmi({ page, url, opts, options, model, hmi }) {
  const outDir = resolve(opts['out-dir']);
  checkFreshOutDir(outDir);
  mkdirSync(outDir, { recursive: true });
  const frames = Math.round(options.seconds * options.fps);
  const out = resolve(opts.mp4);
  mkdirSync(dirname(out), { recursive: true });
  const layer = hmi.mode === 'layer';
  const writer = createHmiFrameWriter({
    page, dir: outDir, mode: hmi.mode, timeoutMs: hmi.timeoutMs, onWritten: hmiProgress(frames, layer ? 'hmi layer' : 'composite'),
  });
  await writer.expose();
  await page.evaluate(installPageHook, { gen: writer.generation, timeoutMs: hmi.timeoutMs });
  console.log(`rv-record-video: recording ${frames} frames ${options.width}x${options.height}@${options.fps} (${options.quality}, ${options.path.kind}) with HMI ${hmi.mode} — model ${modelBaseName(model)}`);
  console.log(`  out dir ${outDir}`);
  const downloadP = layer ? page.waitForEvent('download', { timeout: 0 }) : null;
  let summary;
  try {
    summary = await page.evaluate(async ({ options, layer, hookTimeoutMs, fileName }) => {
      const ac = new AbortController();
      window.__rvRecordAbort = ac;
      const r = await window.viewer.recordVideo({
        ...options,
        // F2: the sim start must not depend on the load time (spike: 20 s vs 7 s without a reset).
        resetSimulation: true,
        signal: ac.signal,
        frameHook: window.__rvHmiHook,
        frameHookEncode: layer ? 'before' : 'skip',
        frameHookTimeoutMs: hookTimeoutMs,
      });
      if (layer) {
        const href = URL.createObjectURL(new Blob([r.bytes], { type: 'video/mp4' }));
        const a = document.createElement('a');
        a.href = href;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(href), 120_000);
      }
      const { bytes, ...rest } = r;
      return { ...rest, sizeBytes: bytes.byteLength };
    }, { options: engineOptions(options), layer, hookTimeoutMs: hmi.timeoutMs * 4, fileName: basename(out) });
  } finally {
    // F9: no callback of this run writes anything any more.
    writer.stop();
  }
  process.stdout.write('\n');

  let check;
  if (layer) {
    const download = await downloadP;
    await download.saveAs(out);
    check = await countFrames(out);
    let hmiFiles = 0;
    for (let i = 0; i < frames; i++) if (existsSync(join(outDir, hmiFileName(i)))) hmiFiles++;
    if (hmiFiles !== frames) throw new Error(`Only ${hmiFiles}/${frames} hmi-*.png were written to ${outDir}.`);
    console.log(`  ${frames} HMI layer PNGs (straight alpha) in ${outDir}`);
  } else {
    const scan = scanPairs(outDir, frames, { layer: false });
    if (scan.firstIncomplete < frames) throw new Error(`Composite frame ${scan.firstIncomplete} is missing in ${outDir} — cannot mux.`);
    const r = await muxFrameDir(page, {
      dir: outDir, frames, fps: options.fps, width: options.width, height: options.height, out,
      codec: options.codec, bitrate: options.bitrate,
    });
    check = r.check;
    summary = { ...summary, codec: r.mux.codec, hardwareAcceleration: r.mux.hardwareAcceleration, bitrate: r.mux.bitrate };
  }
  const size = statSync(out).size;
  console.log(`rv-record-video: ${out}`);
  console.log(`  frames ${check.frames}/${frames}, duration ${check.duration.toFixed(3)} s, ${check.width}x${check.height}, ${(size / 1048576).toFixed(2)} MB, codec ${summary.codec}`);
  writeFileSync(`${out}.json`, JSON.stringify({
    file: out, url, ...summary, hmi: hmi.mode, hmiOpen: hmi.open, outDir, verifiedFrames: check.frames, sizeBytes: size,
  }, null, 2));
  if (check.frames !== frames) {
    console.error(`rv-record-video: FRAME COUNT MISMATCH — expected ${frames}, got ${check.frames}`);
    return 1;
  }
  if (!layer && !hmi.keepFrames) {
    deleteCompositeFrames(outDir, frames);
    console.log(`  composite frames deleted after the verified mux (--keep-frames false)`);
  }
  return 0;
}

/**
 * Still image (plan-556 F5b): simulation reset, exactly `round(at · 60)` fixed steps, one render of
 * that state (raster quality or one cinematic trace), with `--hmi composite|layer` the underlay +
 * settle + page screenshot. Writes `--still` (and `<file>-hmi.png` for layer). Returns the exit code.
 */
async function runStill({ page, opts, options, hmi }) {
  const file = resolve(hmi.still);
  mkdirSync(dirname(file), { recursive: true });
  const layerFile = stillLayerPath(file);
  let hdrUrl = null;
  if (options.quality === 'cinematic') {
    const gpuOk = await page.evaluate(async () => {
      const gpu = navigator.gpu;
      return !!gpu && !!(await gpu.requestAdapter().catch(() => null));
    });
    if (!gpuOk) throw new Error('WebGPU is not available in this browser — a cinematic still needs Chrome with WebGPU.');
    if (opts.hdr) {
      const hdrFile = resolve(opts.hdr);
      const hdrBytes = readFileSync(hdrFile);
      await page.route('**/__rv_cinematic_hdr/**', (route) => route.fulfill({ status: 200, contentType: 'application/octet-stream', body: hdrBytes }));
      hdrUrl = new URL(`__rv_cinematic_hdr/${encodeURIComponent(basename(hdrFile))}`, page.url()).href;
    }
  }
  let generation = 1;
  if (hmi.on) {
    await page.exposeFunction('__rvHmiStill', async (gen) => {
      if (gen !== generation) return 'stale recording callback (the run was stopped)';
      try {
        if (hmi.mode === 'composite') {
          const png = await page.screenshot({ animations: 'allow', caret: 'initial', timeout: hmi.timeoutMs });
          if (gen !== generation) return 'stale recording callback (the run was stopped)';
          writeFileSync(file, png);
        } else {
          await page.evaluate(() => window.viewer.recordingHmi.setLayerMode(true));
          let png;
          try {
            png = await page.screenshot({ animations: 'allow', caret: 'initial', omitBackground: true, timeout: hmi.timeoutMs });
          } finally {
            await page.evaluate(() => window.viewer.recordingHmi.setLayerMode(false)).catch(() => undefined);
          }
          if (gen !== generation) return 'stale recording callback (the run was stopped)';
          writeFileSync(layerFile, png);
        }
        return null;
      } catch (e) {
        return `HMI still: ${e instanceof Error ? e.message : String(e)}`;
      }
    });
  }
  console.log(`rv-record-video: still ${options.width}x${options.height} (${options.quality}) at ${hmi.at} s (${hmi.steps} steps after a reset)${hmi.on ? ` with HMI ${hmi.mode}` : ''}`);
  let r;
  try {
    r = await page.evaluate(async ({ so, hmiMode, gen, timeoutMs, hdrUrl }) => {
      const ac = new AbortController();
      window.__rvRecordAbort = ac;
      const toB64 = (u8) => {
        let s = '';
        for (let k = 0; k < u8.length; k += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(k, k + 0x8000));
        return btoa(s);
      };
      const res = await window.viewer.captureStill({
        ...so,
        ...(hdrUrl ? { hdr: hdrUrl } : {}),
        signal: ac.signal,
        ...(hmiMode !== 'off' ? {
          frameHook: async ({ snapshot, simTimeMs, signal }) => {
            const api = window.viewer.recordingHmi;
            api.setUnderlay(snapshot);
            await api.settle(simTimeMs, { timeoutMs, signal });
            const why = await window.__rvHmiStill(gen);
            if (why) throw new Error(why);
          },
        } : {}),
      });
      return {
        png: hmiMode === 'composite' ? null : toB64(res.png),
        width: res.width, height: res.height, simTime: res.simTime, renderSeconds: res.renderSeconds,
        quality: res.quality, samples: res.samples,
      };
    }, { so: stillOptions(engineOptions(options), hmi), hmiMode: hmi.mode, gen: generation, timeoutMs: hmi.timeoutMs, hdrUrl });
  } finally {
    generation++;
  }
  if (r.png) writeFileSync(file, Buffer.from(r.png, 'base64'));
  if (!existsSync(file) || !isCompletePng(readFileSync(file))) throw new Error(`The still ${file} was not written completely.`);
  console.log(`rv-record-video: ${file}${hmi.mode === 'layer' ? ` + ${layerFile}` : ''}`);
  console.log(`  ${r.width}x${r.height}, sim time ${r.simTime.toFixed(3)} s, ${r.quality}${r.samples ? ` ${r.samples} spp` : ''}, render ${r.renderSeconds} s`);
  return 0;
}

/**
 * Cinematic run (plan-550 F3/F6/F10/F11): frames → PNG files in the out dir, resume at the first
 * missing frame, manifest guard, MP4 mux at the end. Returns the process exit code.
 * plan-556 F7/F8: with `--hmi composite` the frame file IS the composite (the tracer PNG only lives
 * as the underlay; an unfinished composite is traced again on resume); with `--hmi layer` frame
 * `i` is done only when `frame-i` AND `hmi-i` are complete — the resume starts at the first
 * incomplete pair and rewrites both.
 */
async function runCinematic({ page, url, opts, options, model, hmi }) {
  const outDir = resolve(opts['out-dir']);
  mkdirSync(outDir, { recursive: true });
  const frames = Math.round(options.seconds * options.fps);
  const hdrFile = opts.hdr ? resolve(opts.hdr) : null;
  const hdrBytes = hdrFile ? readFileSync(hdrFile) : null;
  const base = cinematicBaseManifest(options, hdrBytes ? sha256(hdrBytes) : null);
  const composite = hmi.mode === 'composite';
  const layer = hmi.mode === 'layer';

  // ── Resume check before anything expensive ──
  const stored = readManifest(outDir);
  const scan = scanFrames(outDir, frames);
  if (scan.tempFiles.length) removeTempFiles(outDir, scan.tempFiles);
  const resuming = scan.existing.length > 0;
  {
    const why = resumeRefusal(stored, base, scan.existing.length, { place: outDir, advice: 'Use a new --out-dir or delete the frames to start over.' });
    if (why) throw new Error(why);
  }
  if (scan.removedBroken) console.log(`rv-record-video: ${scan.removedBroken} was incomplete — it is rendered again`);
  if (scan.gaps.length) {
    console.log(`rv-record-video: frames ${scan.gaps.slice(0, 5).join(', ')}${scan.gaps.length > 5 ? ', …' : ''} are missing — rendering resumes at ${scan.firstMissing}`);
  }
  let startFrame = scan.firstMissing;
  if (layer) {
    // F8: a frame is done only as a validated pair (frame-i + hmi-i, both complete PNGs).
    const pairs = scanPairs(outDir, frames, { layer: true });
    if (pairs.firstIncomplete < startFrame) {
      console.log(`rv-record-video: frame ${pairs.firstIncomplete} has no complete HMI layer — rendering resumes there (both files are rewritten)`);
      startFrame = pairs.firstIncomplete;
    }
  }
  let manifest = {
    ...(resuming ? stored : {}),
    ...base,
    url,
    hdrFile: hdrFile ? basename(hdrFile) : null,
    createdAt: (resuming && stored.createdAt) || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    framesDone: startFrame,
    complete: false,
  };
  writeManifest(outDir, manifest);

  if (startFrame < frames) {
    checkDiskSpace(outDir, (frames - startFrame) * (layer ? 2 : 1));
    const gpuOk = await page.evaluate(async () => {
      const gpu = navigator.gpu;
      return !!gpu && !!(await gpu.requestAdapter().catch(() => null));
    });
    if (!gpuOk) {
      throw new Error('WebGPU is not available in this browser — cinematic render needs Chrome with WebGPU (the CLI starts it with --enable-unsafe-webgpu; check chrome://gpu).');
    }

    let hdrUrl = null;
    if (hdrBytes) {
      await page.route('**/__rv_cinematic_hdr/**', (route) => route.fulfill({ status: 200, contentType: 'application/octet-stream', body: hdrBytes }));
      hdrUrl = new URL(`__rv_cinematic_hdr/${encodeURIComponent(basename(hdrFile))}`, page.url()).href;
    }

    await page.exposeFunction('__rvCinematicContext', (ctx) => {
      if (resuming) {
        const why = compareManifest(stored, ctx);
        if (why) return why;
        if (Array.isArray(ctx.unseededRandomness) && ctx.unseededRandomness.length) {
          console.warn(`rv-record-video: WARNING — the model uses unseeded randomness (${ctx.unseededRandomness.join('; ')}); resumed frames may differ visually from an uninterrupted run.`);
        }
      }
      manifest = { ...manifest, ...ctx, updatedAt: new Date().toISOString() };
      writeManifest(outDir, manifest);
      return null;
    });
    await page.exposeFunction('__rvCinematicSetup', (info) => {
      // plan-554 F7: the resolved blur is known only now — refuse a mismatching resume before anything is written.
      const why = setupBlurRefusal(stored, info, resuming);
      if (why) return why;
      manifest = { ...manifest, setup: info, missingMeshes: info.missing ?? [], ...blurManifestFields(info.motionBlur), updatedAt: new Date().toISOString() };
      writeManifest(outDir, manifest);
      console.log(`  scene: ${info.tracedMeshes} meshes, ${Math.round(info.triangles).toLocaleString('en-US')} triangles, setup ${(info.setupMs / 1000).toFixed(1)} s, GPU ${info.adapter}`);
      const mb = info.motionBlur;
      if (mb?.resolved && mb.resolved !== 'off') console.log(`  motion blur: ${mb.resolved}, ${mb.subFrames} sub-frames`);
      else if (mb?.reason) console.warn(`rv-record-video: NOTE — motion blur is off for this run: ${mb.reason}`);
      if (info.look) {
        const presets = Object.entries(info.materialPresets ?? {}).map(([k, n]) => `${k} ${n}`).join(', ');
        console.log(`  look: ${info.look}${presets ? ` · material presets: ${presets}` : ''}`);
      }
      if (info.degraded?.length) console.warn(`rv-record-video: NOTE — degraded: ${info.degraded.join('; ')}`);
      if (info.missing?.length) {
        console.warn(`rv-record-video: WARNING — ${info.missing.length} mesh(es) could not be copied and are NOT in the video: ${info.missing.slice(0, 10).join(', ')}${info.missing.length > 10 ? ', …' : ''} (listed in cinematic.json → missingMeshes)`);
      }
    });
    const t0 = Date.now();
    let rendered = 0;
    let msSum = 0;
    const frameDone = (i) => {
      manifest = { ...manifest, framesDone: i + 1, updatedAt: new Date().toISOString() };
      writeManifest(outDir, manifest);
    };
    await page.exposeFunction('__rvCinematicFrame', (i, b64, stats) => {
      // composite: the tracer frame is only the underlay — the frame file is the HMI screenshot.
      if (b64 !== null) {
        const bytes = Buffer.from(b64, 'base64');
        if (!isCompletePng(bytes)) throw new Error(`Frame ${i}: the page delivered an incomplete PNG.`);
        writeFrameAtomic(outDir, i, bytes);
      }
      rendered++;
      msSum += stats.ms;
      if (!hmi.on) frameDone(i);
      const avg = msSum / rendered / 1000;
      const eta = avg * (frames - i - 1);
      console.log(`  frame ${i + 1}/${frames} · ${stats.samples} spp · ${(stats.ms / 1000).toFixed(1)} s (trace ${(stats.traceMs / 1000).toFixed(1)} s, denoise ${(stats.denoiseMs / 1000).toFixed(1)} s, ${stats.sceneChange}) · avg ${avg.toFixed(1)} s/frame · ETA ${formatDuration(eta)}`);
    });
    let writer = null;
    if (hmi.on) {
      // The pair (or the composite) is complete only after the HMI file — framesDone follows it.
      writer = createHmiFrameWriter({ page, dir: outDir, mode: hmi.mode, timeoutMs: hmi.timeoutMs, onWritten: frameDone });
      await writer.expose();
      await page.evaluate(installPageHook, { gen: writer.generation, timeoutMs: hmi.timeoutMs });
    }

    const blur = base.motionBlur;
    console.log(`rv-record-video: cinematic ${frames} frames ${options.width}x${options.height}@${options.fps}, ${options.samples} spp, denoise ${options.denoise}, look ${options.look}${options.dof ? `, DoF f/${options.fStop ?? 5.6}` : ''}, motion blur ${blur.enabled ? `${blur.shutterDeg}° × ${blur.subFrames}` : 'off'}${hmi.on ? `, HMI ${hmi.mode}` : ''}${startFrame > 0 ? ` — resuming at frame ${startFrame}` : ''}`);
    console.log(`  out dir ${outDir}`);
    console.log('  the scene setup blocks the page for a while (station ≈ 10 s, large models ≈ 40 s); Ctrl+C takes effect after the current frame.');
    let r;
    try {
      r = await page.evaluate(async ({ options, startFrame, hdrUrl, hmiOn, composite, hookTimeoutMs }) => {
        const ac = new AbortController();
        window.__rvRecordAbort = ac;
        const toB64 = (u8) => {
          let s = '';
          for (let k = 0; k < u8.length; k += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(k, k + 0x8000));
          return btoa(s);
        };
        try {
          const res = await window.viewer.recordVideo({
            ...options,
            startFrame,
            ...(hdrUrl ? { hdr: hdrUrl } : {}),
            // plan-556 F2: with the HMI the run starts from the load state, independent of the load time.
            ...(hmiOn ? { resetSimulation: true, frameHook: window.__rvHmiHook, frameHookTimeoutMs: hookTimeoutMs } : {}),
            signal: ac.signal,
            onCinematicContext: async (ctx) => {
              const why = await window.__rvCinematicContext(ctx);
              if (why) throw new Error(why);
            },
            onCinematicSetup: async (info) => {
              const why = await window.__rvCinematicSetup(info);
              if (why) throw new Error(why);
            },
            frameSink: (i, png, stats) => window.__rvCinematicFrame(i, composite ? null : toB64(png), stats),
          });
          return { ok: true, renderSeconds: res.renderSeconds };
        } catch (e) {
          const message = String(e?.message ?? e);
          return { ok: false, error: message, resumable: e?.resumable === true, aborted: /^Recording aborted/.test(message) };
        }
      }, { options: engineOptions(options), startFrame, hdrUrl, hmiOn: hmi.on, composite, hookTimeoutMs: hmi.timeoutMs * 4 });
    } finally {
      writer?.stop();
    }
    if (!r.ok) {
      const done = layer ? scanPairs(outDir, frames, { layer: true }).firstIncomplete : scanFrames(outDir, frames).firstMissing;
      if (r.resumable || r.aborted || hmi.on) {
        // With the HMI a stalled settle / screenshot (hidden window, F9) is resumable too.
        console.error(`\nrv-record-video: ${r.error}`);
        console.error(`rv-record-video: stopped with ${done}/${frames} frames on disk — run the same command again to resume.`);
        return EXIT_RESUMABLE;
      }
      throw new Error(r.error);
    }
    console.log(`rv-record-video: ${rendered} frames rendered in ${formatDuration((Date.now() - t0) / 1000)}`);
  } else {
    console.log(`rv-record-video: all ${frames} frames are on disk — muxing only`);
  }

  // ── Mux: PNG frames → MP4 in the page (WebCodecs + mediabunny, the shared helper) ──
  const final = scanFrames(outDir, frames);
  if (final.firstMissing < frames) throw new Error(`Frame ${final.firstMissing} is missing in ${outDir} — cannot mux.`);
  if (layer && scanPairs(outDir, frames, { layer: true }).firstIncomplete < frames) {
    throw new Error(`An HMI layer frame is missing in ${outDir} — run the same command again to complete it.`);
  }
  const out = resolve(opts.mp4 ?? join(outDir, `${modelBaseName(model)}.mp4`));
  mkdirSync(dirname(out), { recursive: true });
  const { mux, check, size } = await muxFrameDir(page, {
    dir: outDir, frames, fps: options.fps, width: options.width, height: options.height, out,
    codec: options.codec, bitrate: options.bitrate,
  });
  console.log(`rv-record-video: ${out}`);
  console.log(`  frames ${check.frames}/${frames}, duration ${check.duration.toFixed(3)} s, ${check.width}x${check.height}, ${(size / 1048576).toFixed(2)} MB, codec ${mux.codec}`);
  if (layer) console.log(`  ${frames} HMI layer PNGs (straight alpha) in ${outDir}`);
  manifest = { ...readManifest(outDir), complete: check.frames === frames, mp4: out, mp4Bytes: size, updatedAt: new Date().toISOString() };
  writeManifest(outDir, manifest);
  if (check.frames !== frames) {
    console.error(`rv-record-video: FRAME COUNT MISMATCH — expected ${frames}, got ${check.frames}`);
    return 1;
  }
  if (composite && !hmi.keepFrames) {
    deleteCompositeFrames(outDir, frames);
    console.log('  composite frames deleted after the verified mux (--keep-frames false)');
  }
  return 0;
}

const isMain = !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) void main();
