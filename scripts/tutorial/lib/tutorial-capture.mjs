// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Tutorial recorder (plan-2004) — recording, encoding and the measurements at the finished MP4.
 *
 * Three hard facts from the spike live in here, each one costing a run otherwise:
 *  - the mjpeg raw stream needs `-f image2pipe -c:v mjpeg`; WITHOUT the explicit input codec this
 *    ffmpeg aborts with "unknown codec", and it has no `rawvideo` muxer at all.
 *  - the frame count is read with `ffprobe -count_frames` (`nb_read_frames`) — the ONE instrument.
 *    `countFrames()` from `scripts/lib/rv-record-hmi.mjs` counts mediabunny `EncodedPacketSink`
 *    PACKETS, a different size, and with a threshold that has no tolerance the identity of the
 *    instrument is load-bearing. It is not used here, not even as a cross-check: two instruments
 *    mean two truths.
 *  - the upward search for ffmpeg does NOT carry on its own: the binaries live in `E:\remotion`,
 *    a SIBLING of the workspace that no upward search reaches, and `RV_FFMPEG`/`RV_FFPROBE` are
 *    unset on the dev machine. Hence `RV_REMOTION_ROOT` as the third stage and the rule that every
 *    documented run passes `--ffmpeg`/`--ffprobe` explicitly.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { mad8x8 } from './tutorial-events.mjs';

/**
 * Pulls the raw video payloads out of an AVI stream.
 *
 * WHY THIS EXISTS AT ALL — spike finding (7): this ffmpeg has NO `rawvideo` muxer, so `-f rawvideo`
 * simply fails. The documented way to read pixels back is `-c:v rawvideo -f avi` and parsing the
 * `00dc` chunks, which is what this does. Chunks are padded to an even length.
 */
export function aviRawChunks(buffer) {
  const payloads = [];
  // `RIFF....AVI ` then a chunk tree; the stream-0 data chunks carry the fourcc `00dc`.
  for (let i = 0; i + 8 <= buffer.length;) {
    const fourcc = buffer.toString('latin1', i, i + 4);
    const size = buffer.readUInt32LE(i + 4);
    if (fourcc === 'RIFF' || fourcc === 'LIST') {
      // Container chunk: step over its own 12-byte header and descend.
      i += 12;
      continue;
    }
    const body = i + 8;
    if (body + size > buffer.length) break;
    if (fourcc === '00dc' || fourcc === '00db') payloads.push(buffer.subarray(body, body + size));
    i = body + size + (size % 2);
  }
  return payloads;
}

/**
 * Every decoder/probe child `run()` has started and that has not exited yet. A run that is aborted
 * after the take (ffprobe, the stamp/marker/motion readers, still extraction) ends them through
 * `killActiveChildren()` — otherwise a hung child would keep the runner and its server alive.
 */
const activeChildren = new Set();

/** Teardown: kills every still running child started by `run()`; returns how many were signalled. */
export function killActiveChildren() {
  let signalled = 0;
  for (const child of activeChildren) {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); signalled++; }
  }
  return signalled;
}

/** Runs a binary and collects stdout/stderr; rejects with the tail of stderr on a non-zero exit. */
export function run(binary, args, { input = undefined, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    activeChildren.add(child);
    child.once('close', () => activeChildren.delete(child));
    child.once('error', () => activeChildren.delete(child));
    const out = [];
    const err = [];
    let outBytes = 0;
    child.stdout.on('data', (chunk) => {
      outBytes += chunk.length;
      if (outBytes <= maxBuffer) out.push(chunk);
    });
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const stderr = Buffer.concat(err).toString('utf8');
      if (code !== 0) {
        reject(new Error(`${binary} exited ${code}: ${stderr.split('\n').slice(-12).join('\n')}`));
        return;
      }
      resolvePromise({ stdout: Buffer.concat(out), stderr });
    });
    if (input !== undefined) {
      child.stdin.on('error', () => { /* ffmpeg closed the pipe early; the exit code decides */ });
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

function compositorBinary(root, name) {
  const modules = join(root, 'node_modules', '@remotion');
  if (!existsSync(modules)) return null;
  let entries;
  try { entries = readdirSync(modules); } catch { return null; }
  for (const entry of entries) {
    if (!entry.startsWith('compositor-')) continue;
    for (const candidate of [join(modules, entry, `${name}.exe`), join(modules, entry, name)]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * `--ffmpeg` > `RV_FFMPEG` > `RV_REMOTION_ROOT` > upward search from the WEBVIEWER REPO for
 * `node_modules/@remotion/compositor-*\/ffmpeg(.exe)`.
 *
 * `--ffprobe` > `RV_FFPROBE` > next to the ffmpeg that was found. `ffprobe.exe` sits in the same
 * directory as `ffmpeg.exe`, so the one instrument of Gate A needs no new dependency.
 *
 * Returns `{ ffmpeg, ffprobe, source }`; throws when either stays unresolved — the caller turns
 * that into Exit 2 in step 1, before anything happens.
 */
export function resolveEncoders({ ffmpeg, ffprobe, repoRoot, env = process.env } = {}) {
  let ffmpegPath = null;
  let source = null;

  if (ffmpeg) { ffmpegPath = resolve(ffmpeg); source = '--ffmpeg'; }
  else if (env.RV_FFMPEG) { ffmpegPath = resolve(env.RV_FFMPEG); source = 'RV_FFMPEG'; }
  else if (env.RV_REMOTION_ROOT) {
    ffmpegPath = compositorBinary(resolve(env.RV_REMOTION_ROOT), 'ffmpeg');
    source = 'RV_REMOTION_ROOT';
  }
  if (!ffmpegPath && repoRoot) {
    let dir = resolve(repoRoot);
    for (;;) {
      const found = compositorBinary(dir, 'ffmpeg');
      if (found) { ffmpegPath = found; source = 'upward search'; break; }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  if (!ffmpegPath || !existsSync(ffmpegPath)) {
    throw new Error([
      'no ffmpeg could be resolved.',
      'Resolution order: --ffmpeg > RV_FFMPEG > RV_REMOTION_ROOT > upward search from the WebViewer repo',
      'for node_modules/@remotion/compositor-*/ffmpeg(.exe).',
      'The upward search does NOT carry on this machine: the binaries live in a SIBLING of the workspace',
      '(E:\\remotion), which an upward search never reaches. Pass --ffmpeg and --ffprobe explicitly, e.g.',
      '  --ffmpeg "E:/remotion/node_modules/@remotion/compositor-win32-x64-msvc/ffmpeg.exe"',
      '  --ffprobe "E:/remotion/node_modules/@remotion/compositor-win32-x64-msvc/ffprobe.exe"',
      'or set RV_REMOTION_ROOT to the Remotion repo.',
    ].join('\n'));
  }

  let ffprobePath = null;
  if (ffprobe) ffprobePath = resolve(ffprobe);
  else if (env.RV_FFPROBE) ffprobePath = resolve(env.RV_FFPROBE);
  else {
    for (const candidate of [join(dirname(ffmpegPath), 'ffprobe.exe'), join(dirname(ffmpegPath), 'ffprobe')]) {
      if (existsSync(candidate)) { ffprobePath = candidate; break; }
    }
  }
  if (!ffprobePath || !existsSync(ffprobePath)) {
    throw new Error([
      'no ffprobe could be resolved, and it is the ONE instrument of Gate A (nb_read_frames).',
      'Resolution order: --ffprobe > RV_FFPROBE > next to the resolved ffmpeg.',
      `ffmpeg was resolved from ${source}: ${ffmpegPath}`,
    ].join('\n'));
  }
  return { ffmpeg: ffmpegPath, ffprobe: ffprobePath, source };
}

/**
 * Encodes the collected JPEG frames into the MP4 — CFR, GOP 30, faststart.
 *
 * `-f image2pipe -c:v mjpeg` is mandatory (see the module header) and
 * `scale=in_range=pc:out_range=tv` keeps the full-range JPEGs from being clipped.
 */
export function createEncoder({ ffmpeg, fps, out }) {
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(fps),
    '-i', 'pipe:0',
    '-vf', 'scale=in_range=pc:out_range=tv,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-g', String(fps),
    '-movflags', '+faststart',
    out,
  ];
  const child = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  const stderr = [];
  let settled = false;
  let spawnError = null;
  const closed = new Promise((resolvePromise) => child.once('close', resolvePromise));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.on('error', (error) => { spawnError = error; });
  child.stdin.on('error', () => { /* ffmpeg's exit status carries the useful diagnosis */ });

  return {
    async write(buffer) {
      if (settled) throw new Error('createEncoder.write: encoder is already finished');
      if (child.stdin.write(buffer)) return;
      // Wait for 'drain' — but never past ffmpeg's end: a killed encoder (teardown `abort()`, or a
      // crash) emits no 'drain', and a write parked on it would hang the run forever.
      // Neither branch may reject on its own: the loser of the race stays pending and would become
      // an unhandled rejection later.
      const outcome = await Promise.race([
        once(child.stdin, 'drain').then(() => 'drain', () => 'stdin-error'),
        closed.then(() => 'closed'),
      ]);
      if (outcome !== 'drain') throw new Error(`ffmpeg ${outcome === 'closed' ? `ended (code ${child.exitCode})` : 'stdin failed'} while a frame was pending`);
    },
    async finish() {
      if (settled) throw new Error('createEncoder.finish: encoder is already finished');
      settled = true;
      child.stdin.end();
      const code = await closed;
      if (spawnError) throw spawnError;
      if (code !== 0) {
        const tail = Buffer.concat(stderr).toString('utf8').split('\n').slice(-12).join('\n');
        throw new Error(`${ffmpeg} exited ${code}: ${tail}`);
      }
      return out;
    },
    /** Teardown only: ends ffmpeg without waiting for a finished file (the run is already lost). */
    abort() {
      settled = true;
      try { child.stdin.destroy(); } catch { /* already closed */ }
      if (child.exitCode === null && child.signalCode === null) child.kill();
      return closed;
    },
  };
}

export async function encodeFrames({ ffmpeg, frames, fps, out }) {
  if (!Array.isArray(frames) || frames.length === 0) throw new Error('encodeFrames: no frames captured');
  const encoder = createEncoder({ ffmpeg, fps, out });
  for (const frame of frames) await encoder.write(frame);
  return encoder.finish();
}

/**
 * Gate A's ONE measurement: decoded frames of the finished MP4.
 *
 * Reads `stream=nb_read_frames` — the very instrument that produced the reference number 2700 in
 * `runC-90b.analysis.log`.
 */
export async function probeFrames(ffprobe, mp4) {
  const { stdout } = await run(ffprobe, [
    '-v', 'error', '-select_streams', 'v:0', '-count_frames',
    '-show_entries', 'stream=nb_read_frames,r_frame_rate,width,height,duration',
    '-of', 'json', mp4,
  ]);
  const parsed = JSON.parse(stdout.toString('utf8'));
  const stream = parsed.streams?.[0];
  if (!stream) throw new Error(`ffprobe found no video stream in ${mp4}`);
  const frames = Number(stream.nb_read_frames);
  if (!Number.isInteger(frames) || frames <= 0) throw new Error(`ffprobe returned an unusable nb_read_frames (${String(stream.nb_read_frames)}) for ${mp4}`);
  return {
    frames,
    frameRate: stream.r_frame_rate ?? null,
    width: Number(stream.width) || null,
    height: Number(stream.height) || null,
    duration: stream.duration === undefined ? null : Number(stream.duration),
  };
}

/**
 * Gate C's measurement at the finished MP4 — the metric is EXACTLY this chain:
 * `crop` on the region -> `scale=8:8:flags=area` -> `format=gray`; per frame pair
 * `mad = sum|cur - prev| / 64` on the 8-BIT GREY SCALE 0…255.
 *
 * The downscale filter is PART of the metric, not taste: `flags=area` averages the 400x400 crop
 * onto 8x8; another filter shifts the values, and because the valid run has a `medianDiff` of only
 * 0.031 at a `maxDiff` of 98.359 the distribution is bimodal and the threshold is shift-sensitive.
 *
 * Returns `{ diffs, thumbnails }` — `diffs` has `frames - 1` entries, which is Gate C's
 * denominator.
 */
export async function measureMotion({ ffmpeg, mp4, region }) {
  const { stdout } = await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error',
    '-i', mp4,
    '-vf', `crop=${region.w}:${region.h}:${region.x}:${region.y},scale=8:8:flags=area,format=gray`,
    '-c:v', 'rawvideo', '-pix_fmt', 'gray', '-f', 'avi', 'pipe:1',
  ]);
  const thumbnails = aviRawChunks(stdout).map((chunk) => new Uint8Array(chunk.subarray(0, 64)));
  const count = thumbnails.length;
  if (count < 2) throw new Error(`motion measurement read only ${count} thumbnail(s) from ${mp4} — nothing to compare`);
  const diffs = [];
  for (let i = 1; i < count; i++) diffs.push(mad8x8(thumbnails[i - 1], thumbnails[i]));
  return { diffs, thumbnails, frames: count };
}

/**
 * Extracts ONE frame of the finished MP4 by frame number, as JPEG.
 *
 * The same ffmpeg as for encoding — no second instrument, no browser. Used for the decoder control
 * frame and for every still of the contact sheet (A9).
 */
export async function extractFrame({ ffmpeg, mp4, frame, out, quality = 3 }) {
  await run(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', mp4,
    // Addressed BY FRAME NUMBER, and `trim` is the only way to do that with this binary:
    // the Remotion ffmpeg build ships a REDUCED filter set that has NO `select` filter at all
    // (`-filters` lists only colorspace, crop, format, scale, trim), so the usual
    // `select=eq(n\,N)` dies as "No option name near 'eq(n,10)'". Measured 2026-10-26 against
    // `rv-tmp/spike-676/enc-test.mp4`: `trim=start_frame=N:end_frame=N+1` returns a DISTINCT,
    // index-addressed frame per N, while an `-ss (N+0.5)/fps` seek returns a different frame and
    // is therefore not frame-accurate here. `trim` also needs no comma escaping, so there is no
    // shell-versus-spawn quoting trap left in this call.
    '-vf', `trim=start_frame=${frame}:end_frame=${frame + 1}`,
    // `-fps_mode passthrough` replaces `-vsync 0` (deprecated since ffmpeg 5.1, removed in 9):
    // Remotion's 7.1 and a system ffmpeg 9 both accept it.
    '-fps_mode', 'passthrough', '-frames:v', '1', '-q:v', String(quality),
    out,
  ]);
  return out;
}

/** The 8x8 grey thumbnail of the region for ONE jpeg — the decoder control frame's input. */
export async function thumbnailOf({ ffmpeg, image, region }) {
  const { stdout } = await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error',
    '-i', image,
    '-vf', `crop=${region.w}:${region.h}:${region.x}:${region.y},scale=8:8:flags=area,format=gray`,
    '-c:v', 'rawvideo', '-pix_fmt', 'gray', '-frames:v', '1', '-f', 'avi', 'pipe:1',
  ]);
  const chunks = aviRawChunks(stdout);
  if (chunks.length === 0 || chunks[0].length < 64) {
    throw new Error(`control thumbnail of ${image} returned ${chunks[0]?.length ?? 0} bytes, expected 64`);
  }
  return new Uint8Array(chunks[0].subarray(0, 64));
}

/**
 * The frame stamp strip — 16 black/white blocks forming a 16-bit counter, read back from the
 * decoded video.
 *
 * It lies ABOVE the marker (H1): in the spike the marker overlay covered the stamp through nothing
 * but stacking order and hid 6 stamps per marker, which is why `runC-90b` reports
 * `stampStrictlyPlusOne: false`. With the stamp on top the `+1` sequence is checkable over the
 * WHOLE run, markers included, and no marker-aware exception is needed in the oracle — such an
 * exception would cover a real stamp dropout, the very error class Gate A exists to find.
 */
export const STAMP = Object.freeze({ x: 0, y: 0, w: 320, h: 20, bits: 16 });

/** Reads the stamp of every frame; returns the decoded counter values in frame order. */
export async function readStamps({ ffmpeg, mp4 }) {
  const blockWidth = STAMP.w / STAMP.bits;
  // One grey pixel per bit: crop the strip, then scale to 16x1 with `area` so each pixel averages
  // its own block.
  const { stdout } = await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error',
    '-i', mp4,
    '-vf', `crop=${STAMP.w}:${STAMP.h}:${STAMP.x}:${STAMP.y},scale=${STAMP.bits}:1:flags=area,format=gray`,
    '-c:v', 'rawvideo', '-pix_fmt', 'gray', '-f', 'avi', 'pipe:1',
  ]);
  const stamps = [];
  for (const chunk of aviRawChunks(stdout)) {
    let value = 0;
    for (let bit = 0; bit < STAMP.bits; bit++) {
      // LSB first, white = 1: the on-page painter uses the same order. The threshold sits in the
      // middle of the 8-bit range; pure black/white blocks leave nothing marginal to resolve.
      if (chunk[bit] >= 128) value |= 1 << bit;
    }
    stamps.push(value);
  }
  return { stamps, blockWidth };
}

/**
 * The stamp sequence must be contiguous `+1` over the whole run — NO exception.
 *
 * The stamp is a 16-bit counter, so it wraps every 65536 frames; the comparison is therefore
 * modulo 2^16.
 */
export function stampsContiguous(stamps) {
  if (!Array.isArray(stamps) || stamps.length < 2) return { contiguous: false, firstBreak: 0, reason: 'fewer than two stamps read' };
  for (let i = 1; i < stamps.length; i++) {
    if (((stamps[i - 1] + 1) & 0xffff) !== stamps[i]) {
      return { contiguous: false, firstBreak: i, reason: `stamp ${stamps[i - 1]} at frame ${i - 1} is followed by ${stamps[i]} at frame ${i}, expected ${(stamps[i - 1] + 1) & 0xffff}` };
    }
  }
  return { contiguous: true, firstBreak: null, reason: null };
}

/**
 * The marker probe region — OUTSIDE the stamp strip, so stamp and marker never read each other.
 *
 * The spike position (`markerX: 60, markerY: 600`, record-c.mjs:137) is the obvious choice: the
 * stamp strip occupies `[0;320) x [0;20)`, this sits well below it.
 */
export const MARKER_PROBE = Object.freeze({ x: 60, y: 600, w: 8, h: 8 });

/**
 * The reserved marker colour. Magenta, not white: a white full-area overlay is indistinguishable
 * from bright UI, and the spike counted its markers as `magentaFrameCount`.
 */
export const MARKER_RGB = Object.freeze({ r: 255, g: 0, b: 255 });

/** Per-frame flag "the marker area shows the reserved colour", read back from the finished MP4. */
export async function readMarkerFrames({ ffmpeg, mp4 }) {
  const { stdout } = await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error',
    '-i', mp4,
    '-vf', `crop=${MARKER_PROBE.w}:${MARKER_PROBE.h}:${MARKER_PROBE.x}:${MARKER_PROBE.y},scale=1:1:flags=area,format=rgb24`,
    '-c:v', 'rawvideo', '-pix_fmt', 'rgb24', '-f', 'avi', 'pipe:1',
  ]);
  const flags = [];
  for (const chunk of aviRawChunks(stdout)) {
    // Generous per-channel tolerance: the yuv420p round trip shifts saturated magenta by a few
    // counts, while nothing in the UI comes anywhere near "red high, green low, blue high".
    flags.push(chunk[0] > 180 && chunk[1] < 90 && chunk[2] > 180);
  }
  return flags;
}

/**
 * Onset frame of the first and the last marker window: the first frame of the leading run of
 * marker frames, and the first frame of the trailing one.
 *
 * `null` when a window is missing — Gate B turns that into `marker-mismatch`, because an onset
 * that cannot be read is not an onset that matches.
 */
export function markerOnsets(flags) {
  let start = null;
  for (let i = 0; i < flags.length; i++) if (flags[i]) { start = i; break; }

  // The END window does NOT touch the last frame of the run, and assuming it does is a measured
  // error: with the spike's numbers the end marker runs 2691..2696 of 2700, so frames 2697..2699
  // are the TAIL and carry no marker (which is exactly why the end marker SEGMENT is
  // `[onset; frames)` while the visible window is six frames). A backward scan that stops at the
  // first non-marker frame therefore returns `null` for every real run. What is wanted is the
  // first frame of the LAST run of marker frames.
  let end = null;
  for (let i = flags.length - 1; i >= 0; i--) {
    if (!flags[i]) continue;
    end = i;
    while (end > 0 && flags[end - 1]) end--;
    break;
  }
  if (start !== null && end !== null && end <= start) end = start;
  return { start, end, count: flags.filter(Boolean).length };
}

/** Last-modified time of the finished `--dist`, for the run log (no freshness check is defined). */
export function distInfo(dist) {
  try {
    return { path: dist, mtime: statSync(join(dist, 'index.html')).mtime.toISOString() };
  } catch {
    return { path: dist, mtime: null };
  }
}
