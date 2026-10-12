// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-record-hmi.mjs — the HMI side of `npm run record` (plan-556).
 *
 * `--hmi composite|layer|off` (default off) puts the React HMI into the recording, frame-synchronous
 * with the plant. The page does the per-frame settle (viewer.recordingHmi: underlay snapshot of the
 * encoded 3D frame, recording ticks, commit barrier, animation freeze); this module does everything
 * Playwright and the file system own:
 *
 *  - option rules (`hmiCliOptions`): modes, `--hmi-open`, `--still` / `--at`, `--keep-frames`,
 *    the raster output contract (fresh `--out-dir` + `--mp4` with the HMI on, F5a);
 *  - the page setup: viewport = output size (DSF 1), boot cleanup seeded via `addInitScript`;
 *  - the Node half of the frame hook (`createHmiFrameWriter`): `page.screenshot` of the composite
 *    (`frame-%06d.png`) or of the HMI alone with alpha (`hmi-%06d.png`), atomic writes, every
 *    screenshot bounded, a generation token so a late callback never writes (F9);
 *  - the pair-complete resume scan of a cinematic layer run (`scanPairs`, F8);
 *  - the shared mux helper (`muxFrameDir`): PNG folder → MP4 in the page, codec / bitrate / abort
 *    forwarded, frame count verified (F5a).
 *
 * Tested by tests/rv-record-video-hmi.node.test.ts. No shebang (vite-node + CRLF, plan-503).
 */

import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { frameFileName, isCompletePng } from '../../src/core/engine/rv-cinematic-manifest.mjs';

/** Values of `--hmi`. */
export const HMI_MODES = ['off', 'composite', 'layer'];
/** Default bound of one settle / screenshot step (s) — `--hmi-timeout`. */
export const DEFAULT_HMI_TIMEOUT_S = 30;

/** `hmi-000042.png` for index 42 (the HMI layer of frame 42). */
export function hmiFileName(index) {
  return `hmi-${String(index).padStart(6, '0')}.png`;
}

/** `<name>-hmi.png` next to a still `<name>.png` (layer still). */
export function stillLayerPath(file) {
  return /\.png$/i.test(file) ? file.replace(/\.png$/i, '-hmi.png') : `${file}-hmi.png`;
}

/**
 * The HMI options of the CLI (F1/F5a/F5b), validated. `fail(msg)` is the usage error (throws).
 * Returns `{ mode, on, open, still, at, steps, keepFrames, timeoutMs }`.
 */
export function hmiCliOptions(opts, quality, fail) {
  const mode = opts.hmi ?? 'off';
  if (!HMI_MODES.includes(mode)) fail(`--hmi must be one of ${HMI_MODES.join(', ')}`);
  const on = mode !== 'off';
  let open = [];
  if (opts['hmi-open'] !== undefined) {
    if (!on) fail('--hmi-open needs --hmi composite or --hmi layer');
    open = String(opts['hmi-open']).split(',').map((s) => s.trim()).filter(Boolean);
    if (open.length === 0) fail('--hmi-open needs at least one panel id');
  }
  const still = opts.still !== undefined ? String(opts.still) : null;
  if (still !== null) {
    for (const k of ['seconds', 'frames', 'out-dir', 'mp4']) {
      if (opts[k] !== undefined) fail(`--still cannot be combined with --${k} (a still is one image, no frame folder, no MP4)`);
    }
    if (!/\.png$/i.test(still)) fail('--still needs a .png file');
  }
  let at = 0;
  if (opts.at !== undefined) {
    if (still === null) fail('--at is only valid with --still');
    at = Number(opts.at);
    if (!(Number.isFinite(at) && at >= 0 && at <= 3600)) fail('--at must be between 0 and 3600 (seconds)');
  }
  let keepFrames = true;
  if (opts['keep-frames'] !== undefined) {
    if (mode !== 'composite' || still !== null) fail('--keep-frames is only valid with --hmi composite (the hmi-*.png of a layer run are the product)');
    if (opts['keep-frames'] !== 'true' && opts['keep-frames'] !== 'false') fail('--keep-frames must be true or false');
    keepFrames = opts['keep-frames'] === 'true';
  }
  if (on && still === null && quality !== 'cinematic') {
    // F5a: both raster HMI modes write a fresh frame folder and need the MP4 path.
    if (!opts['out-dir']) fail(`--hmi ${mode} needs --out-dir <new dir> (${mode === 'composite' ? 'composite frames' : 'hmi-*.png layer'} go there)`);
    if (!opts.mp4) fail(`--hmi ${mode} needs --mp4 <file>`);
  }
  let timeoutS = DEFAULT_HMI_TIMEOUT_S;
  if (opts['hmi-timeout'] !== undefined) {
    if (!on) fail('--hmi-timeout needs --hmi composite or --hmi layer');
    timeoutS = Number(opts['hmi-timeout']);
    if (!(timeoutS >= 1 && timeoutS <= 600)) fail('--hmi-timeout must be between 1 and 600 (seconds)');
  }
  return { mode, on, open, still, at, steps: Math.round(at * 60), keepFrames, timeoutMs: Math.round(timeoutS * 1000) };
}

/** Throws unless `dir` does not exist or is empty (raster HMI runs write a fresh folder, F5a). */
export function checkFreshOutDir(dir) {
  if (!existsSync(dir)) return;
  if (!statSync(dir).isDirectory()) throw new Error(`--out-dir ${dir} is a file — give a new folder.`);
  const entries = readdirSync(dir);
  if (entries.length > 0) {
    throw new Error(`--out-dir ${dir} is not empty (${entries.length} entries) — a raster HMI recording writes a fresh folder (no raster resume). Use a new --out-dir.`);
  }
}

/**
 * Boot cleanup of the recording page (F2), run via `context.addInitScript`: welcome / terms seeded,
 * the dev-server banner closed by its own button on every mount.
 */
export function bootCleanupInitScript() {
  try {
    localStorage.setItem('rv-terms-accepted', '1');
    localStorage.setItem('rv-welcome-dismissed', '1');
  } catch { /* opaque origin: nothing to seed */ }
  const dismissed = new WeakSet();
  const closeBanner = () => {
    const button = document.querySelector('button[aria-label="Hide dev server banner until reload"]');
    if (button && !dismissed.has(button)) {
      dismissed.add(button);
      button.click();
    }
  };
  new MutationObserver(closeBanner).observe(document, { childList: true, subtree: true });
}

function writeAtomic(file, bytes) {
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, file);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    throw new Error(`Could not write ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return file;
}

/** Writes `frame-<i>.png` atomically. */
export function writeFramePng(dir, index, bytes) {
  return writeAtomic(join(dir, frameFileName(index)), bytes);
}

/** Writes `hmi-<i>.png` atomically. */
export function writeHmiPng(dir, index, bytes) {
  return writeAtomic(join(dir, hmiFileName(index)), bytes);
}

function completeFile(file) {
  return existsSync(file) && isCompletePng(readFileSync(file));
}

/**
 * Pair-complete scan (F8): frame `i` is done when `frame-i` is a complete PNG and — in layer mode —
 * `hmi-i` too. Returns `{ firstIncomplete, complete }` (complete = number of leading done frames).
 * Orphans after the first incomplete frame (either kind) are rewritten by the resumed run.
 */
export function scanPairs(dir, frames, { layer }) {
  let i = 0;
  for (; i < frames; i++) {
    if (!completeFile(join(dir, frameFileName(i)))) break;
    if (layer && !completeFile(join(dir, hmiFileName(i)))) break;
  }
  return { firstIncomplete: i, complete: i };
}

/**
 * The Node half of the frame hook (F5/F6/F9). `expose()` installs `window.__rvHmiFrame(i, gen)`,
 * which the page calls after the settle: composite → `frame-i`, layer → `hmi-i` (layer mode on
 * around the screenshot). Returns null or an error message (the page throws it). `stop()` bumps
 * the generation: a callback of an older generation writes nothing.
 */
export function createHmiFrameWriter({ page, dir, mode, timeoutMs, onWritten }) {
  let generation = 1;
  let stopped = false;
  const shot = (o) => page.screenshot({ animations: 'allow', caret: 'initial', timeout: timeoutMs, ...o });
  const onFrame = async (i, gen) => {
    if (stopped || gen !== generation) return 'stale recording callback (the run was stopped)';
    try {
      if (mode === 'composite') {
        const png = await shot({});
        if (stopped || gen !== generation) return 'stale recording callback (the run was stopped)';
        writeFramePng(dir, i, png);
      } else {
        await page.evaluate(() => window.viewer.recordingHmi.setLayerMode(true));
        let png;
        try {
          png = await shot({ omitBackground: true });
        } finally {
          await page.evaluate(() => window.viewer.recordingHmi.setLayerMode(false)).catch(() => undefined);
        }
        if (stopped || gen !== generation) return 'stale recording callback (the run was stopped)';
        writeHmiPng(dir, i, png);
      }
      onWritten?.(i);
      return null;
    } catch (e) {
      return `HMI frame ${i}: ${e instanceof Error ? e.message : String(e)}`;
    }
  };
  return {
    get generation() { return generation; },
    async expose() { await page.exposeFunction('__rvHmiFrame', onFrame); },
    stop() { stopped = true; generation++; },
  };
}

/**
 * Page side of the frame hook, serialisable for `page.evaluate`: underlay → settle → Node
 * screenshot. `cfg` = `{ gen, timeoutMs }`. Installed as `window.__rvHmiHook`.
 */
export function installPageHook(cfg) {
  window.__rvHmiHook = async (i, info) => {
    const api = window.viewer.recordingHmi;
    api.setUnderlay(info.snapshot);
    await api.settle(info.simTimeMs, { timeoutMs: cfg.timeoutMs, signal: info.signal });
    const why = await window.__rvHmiFrame(i, cfg.gen);
    if (why) throw new Error(why);
  };
}

/**
 * Enters the recording HMI in the page (F1/F2/F3/F9): refuses unsupported `--hmi-open` ids with
 * the supported list, requires a visible document, prints the `unsupported panel visible` warnings.
 */
export async function enterRecordingPage(page, { open }) {
  const r = await page.evaluate(({ open }) => {
    const api = window.viewer?.recordingHmi;
    if (!api) return { error: 'This viewer has no recording HMI (viewer.recordingHmi) — update the viewer.' };
    const why = api.validateOpen(open);
    if (why) return { error: why, usage: true };
    if (document.visibilityState !== 'visible') {
      return { error: `The recording page is ${document.visibilityState} — page screenshots need a visible page (keep the window / RDP session visible).` };
    }
    const res = api.enter({ open });
    const rect = document.getElementById('rv-viewport')?.getBoundingClientRect();
    return { warnings: res.warnings, viewport: { width: innerWidth, height: innerHeight }, rect: rect ? { width: rect.width, height: rect.height } : null };
  }, { open });
  if (r.error) {
    const e = new Error(r.error);
    if (r.usage) e.usage = true;
    throw e;
  }
  for (const w of r.warnings) console.warn(`rv-record-video: WARNING — ${w}`);
  return r;
}

/** Leaves the recording HMI (always in `finally`; a closed page is ignored). */
export async function exitRecordingPage(page) {
  try { await page.evaluate(() => window.viewer?.recordingHmi?.exit()); } catch { /* page gone */ }
}

/** Frame count / duration / size of an MP4 (mediabunny demux). */
export async function countFrames(file) {
  const mb = await import('mediabunny');
  const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BufferSource(readFileSync(file)) });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('no video track in the MP4');
  const sink = new mb.EncodedPacketSink(track);
  let n = 0;
  for (let p = await sink.getFirstPacket(); p; p = await sink.getNextPacket(p)) n++;
  return { frames: n, duration: await input.computeDuration(), width: track.displayWidth, height: track.displayHeight };
}

/**
 * The shared mux (F5a): `<dir>/<prefix>-%06d.png` → MP4 through `viewer.muxVideoFrames` in the
 * page — codec and bitrate forwarded, the CLI's abort (`window.__rvRecordAbort`) honoured — saved
 * via Playwright's download event to `out`, frame count verified. Returns `{ mux, check, size }`.
 */
export async function muxFrameDir(page, { dir, frames, fps, width, height, out, codec, bitrate, fileName = frameFileName, verify = countFrames }) {
  await page.unroute('**/__rv_mux_frame/**').catch(() => undefined);
  await page.route('**/__rv_mux_frame/**', (route) => {
    const i = Number(new URL(route.request().url()).pathname.split('/').pop());
    const file = join(dir, fileName(i));
    if (!Number.isInteger(i) || !existsSync(file)) return route.fulfill({ status: 404, body: 'missing' });
    return route.fulfill({ status: 200, contentType: 'image/png', body: readFileSync(file) });
  });
  const downloadP = page.waitForEvent('download', { timeout: 0 });
  const mux = await page.evaluate(async ({ frames, fps, width, height, codec, bitrate, name }) => {
    const ac = new AbortController();
    window.__rvRecordAbort = ac;
    const r = await window.viewer.muxVideoFrames({
      frames, fps, width, height,
      ...(codec ? { codec } : {}),
      ...(bitrate ? { bitrate } : {}),
      signal: ac.signal,
      getFrame: async (i) => {
        const res = await fetch(new URL(`__rv_mux_frame/${i}`, location.href).href);
        if (!res.ok) throw new Error(`frame ${i}: HTTP ${res.status}`);
        return res.blob();
      },
    });
    const href = URL.createObjectURL(new Blob([r.bytes], { type: 'video/mp4' }));
    const a = document.createElement('a');
    a.href = href;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 120_000);
    const { bytes, ...rest } = r;
    return { ...rest, sizeBytes: bytes.byteLength };
  }, { frames, fps, width, height, codec: codec ?? null, bitrate: bitrate ?? null, name: out.split(/[\\/]/).pop() });
  const download = await downloadP;
  await download.saveAs(out);
  const check = await verify(out);
  return { mux, check, size: statSync(out).size };
}

/** Deletes `frame-*.png` of a composite folder — only after a verified mux (F5a), never `hmi-*`. */
export function deleteCompositeFrames(dir, frames) {
  for (let i = 0; i < frames; i++) rmSync(join(dir, frameFileName(i)), { force: true });
}
