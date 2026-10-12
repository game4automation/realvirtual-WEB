// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-cinematic-frames.mjs — the on-disk side of a cinematic recording (plan-550 F3/F10).
 *
 * A cinematic run writes one PNG per frame into an out dir (`frame-000000.png`, …) plus a
 * manifest `cinematic.json`. A restarted run resumes at the first missing frame — but only
 * when the manifest still describes the same recording; any difference refuses the resume
 * and names the field. Frames are written atomically (`.png.tmp` → rename) so a crash never
 * leaves a half-written `frame-*.png`; the last frame is still validated on resume (PNG
 * signature + IEND) because the disk itself may have lost the tail.
 *
 * This file is the Node file-system adapter (fs + crypto); the portable rules come from
 * src/core/engine/rv-cinematic-manifest.mjs (plan-551) and are re-exported. Tested by
 * tests/rv-record-video-cinematic.node.test.ts and tests/rv-cinematic-manifest.node.test.ts.
 */

import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, statfsSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  classifyFrameNames, isCompletePng, frameFileName, optionsHashSync, resumePoint, MANIFEST_NAME,
  BYTES_PER_FRAME_ESTIMATE, DISK_MARGIN,
} from '../../src/core/engine/rv-cinematic-manifest.mjs';

// The portable rules (names, PNG check, manifest guard, hashes, durations) live in the shared
// module the viewer's "Record video" dialog uses too (plan-551 F5/F24); this file keeps the
// Node file-system adapter and re-exports the rest so the CLI and its tests stay unchanged.
export {
  MANIFEST_NAME, MANIFEST_VERSION, BYTES_PER_FRAME_ESTIMATE, DISK_MARGIN, RESUME_FIELDS,
  frameFileName, frameIndexOf, isCompletePng, compareManifest, formatDuration, stableStringify,
} from '../../src/core/engine/rv-cinematic-manifest.mjs';

/**
 * Scans the out dir: which of the `frames` frames exist, the first missing index (the
 * resume point) and stray temp files. The highest existing frame is validated; a broken
 * one is deleted and counts as missing (re-rendered).
 *
 * @returns {{ existing: number[], firstMissing: number, gaps: number[], removedBroken: string|null, tempFiles: string[] }}
 */
export function scanFrames(dir, frames) {
  const { present: found, tempFiles } = classifyFrameNames(existsSync(dir) ? readdirSync(dir) : [], frames);
  const present = new Set(found);
  let removedBroken = null;
  const last = found[found.length - 1];
  if (last !== undefined) {
    const file = join(dir, frameFileName(last));
    if (!isCompletePng(readFileSync(file))) {
      rmSync(file, { force: true });
      present.delete(last);
      removedBroken = frameFileName(last);
    }
  }
  const { existing, firstMissing, gaps } = resumePoint(present, frames);
  return { existing, firstMissing, gaps, removedBroken, tempFiles };
}

/** Removes leftover `.png.tmp` files of an interrupted write. */
export function removeTempFiles(dir, names) {
  for (const n of names) rmSync(join(dir, n), { force: true });
}

/** Writes one frame atomically: `<name>.tmp` then rename. Throws a clear error on failure. */
export function writeFrameAtomic(dir, index, bytes) {
  const file = join(dir, frameFileName(index));
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, file);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    throw new Error(`Could not write ${file}: ${e instanceof Error ? e.message : String(e)} — frames written so far stay valid; free disk space and run again to resume.`);
  }
  return file;
}

/** sha256 hex of a buffer / string. */
export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Stable hash of the recording options that change the image or the timing. Order of
 * keys does not matter (keys are sorted). Synchronous wrapper around the shared async-capable
 * rule — the browser computes the same value with `crypto.subtle` (plan-551 F24).
 */
export function optionsHash(options) {
  return optionsHashSync(options, sha256);
}

export function readManifest(dir) {
  const file = join(dir, MANIFEST_NAME);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${e instanceof Error ? e.message : String(e)}) — delete it to start over.`);
  }
}

/** Writes the manifest atomically. */
export function writeManifest(dir, manifest) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, MANIFEST_NAME);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

/**
 * Throws when the disk holding `dir` has less free space than the remaining frames need
 * (`remaining × BYTES_PER_FRAME_ESTIMATE × DISK_MARGIN`). `statfs` is injectable for tests.
 */
export function checkDiskSpace(dir, remainingFrames, statfs = statfsSync) {
  const need = Math.ceil(remainingFrames * BYTES_PER_FRAME_ESTIMATE * DISK_MARGIN);
  let free;
  try {
    const s = statfs(dir);
    free = Number(s.bavail) * Number(s.bsize);
  } catch {
    return { need, free: null }; // unknown filesystem — do not block the run
  }
  if (free < need) {
    throw new Error(`Not enough disk space in ${dir}: ${(free / 1048576).toFixed(0)} MB free, ${(need / 1048576).toFixed(0)} MB needed for ${remainingFrames} frames.`);
  }
  return { need, free };
}

/** Total size of the frame files in bytes. */
export function framesBytes(dir, frames) {
  let total = 0;
  for (let i = 0; i < frames; i++) {
    const f = join(dir, frameFileName(i));
    if (existsSync(f)) total += statSync(f).size;
  }
  return total;
}
