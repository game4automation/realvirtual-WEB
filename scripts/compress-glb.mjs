// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Compress GLB geometry with `KHR_draco_mesh_compression` (plan-749 phase 2).
 *
 * Draco is aimed at the one part of a realvirtual demo asset that is still raw:
 * on `DemoRealvirtualWeb.glb` the geometry is 90,3 % of the BIN chunk (27,0 MB
 * of 30,0 MB) while the embedded images are 9,7 % and already compressed. That
 * split is why this script does Draco and nothing else — KTX2/basisu would
 * address under a tenth of the file and is explicitly out of scope.
 *
 * ## This is a MANUAL asset step, not a build or deploy step
 *
 * It must never be wired into `bunny-deploy.mjs` / `_bunny-lib.mjs`. Those sign
 * GLBs (`scripts/rv-sign-glb.mjs`, Ed25519 over the canonical bytes), and any
 * transformation of the bytes AFTER signing invalidates every signature.
 * Compression therefore runs first, in `public/`, and the deploy then signs the
 * Draco bytes on its own. `refuseSignedInput` below turns that ordering from a
 * comment into a guard: a GLB that already carries `rv_sig` is refused.
 *
 * Vite serves `public/` verbatim, so replacing the file in place is also what
 * makes the dev server deliver the compressed asset — there is no second path
 * to wire up and no selection logic in the viewer. Every viewer load path that
 * reads a project GLB already has a `DRACOLoader` attached
 * (`src/core/engine/rv-glb-parse.ts:29-51`).
 *
 * ## Usage
 *
 * ```
 * node scripts/compress-glb.mjs public/demo-realvirtual/DemoRealvirtualWeb.glb
 * node scripts/compress-glb.mjs in.glb --out out.glb      # do not replace
 * node scripts/compress-glb.mjs in.glb --dry-run          # measure only
 * node scripts/compress-glb.mjs in.glb --force            # re-encode Draco input
 * ```
 *
 * Quantization is lossy on normals, UVs and tangents, so re-running the script
 * over its own output would compound the error. It refuses that by default;
 * `--force` is the deliberate override.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { draco } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';

import { readGlb } from './lib/rv-glb.mjs';

export const DRACO_EXTENSION = 'KHR_draco_mesh_compression';

/**
 * Draco quantization used for realvirtual assets.
 *
 * Positions get 14 bits — Draco quantizes per primitive over that primitive's
 * own bounding box, so 14 bits is ~1/16384 of a single part's extent, far below
 * anything visible on machine geometry. Normals stay at 10 bits because hard
 * CAD edges are the first thing a coarse normal grid shows. EDGEBREAKER is the
 * connectivity method for closed manifold meshes, which machine parts are.
 */
export const DEFAULT_DRACO_OPTIONS = Object.freeze({
  method: 'edgebreaker',
  encodeSpeed: 5,
  decodeSpeed: 5,
  quantizePosition: 14,
  quantizeNormal: 10,
  quantizeTexcoord: 12,
  quantizeColor: 8,
  quantizeGeneric: 12,
});

let ioPromise = null;

/**
 * One `NodeIO` for the process, with the Draco encoder AND decoder registered.
 * The decoder is not optional: reading a GLB that already carries Draco (the
 * `--force` path, and every test that re-reads our own output) needs it.
 */
export async function getIO() {
  if (!ioPromise) {
    ioPromise = (async () => {
      const [decoder, encoder] = await Promise.all([
        draco3d.createDecoderModule(),
        draco3d.createEncoderModule(),
      ]);
      return new NodeIO()
        .registerExtensions(ALL_EXTENSIONS)
        .registerDependencies({ 'draco3d.decoder': decoder, 'draco3d.encoder': encoder });
    })();
  }
  return ioPromise;
}

/**
 * Read the JSON chunk of a GLB without a full glTF parse — the shared reader
 * of `scripts/lib/rv-glb.mjs` (plan-587). Its guards are a superset of the
 * hand-written ones (both length directions, every chunk length) and its
 * messages are named: a non-GLB now says "not a GLB" instead of the
 * misleading "malformed GLB header" the combined magic/version check produced.
 */
export function readGlbJson(input) {
  return readGlb(input).json;
}

/** True when the GLB declares `KHR_draco_mesh_compression`. */
export function hasDraco(input) {
  const used = readGlbJson(input).extensionsUsed;
  return Array.isArray(used) && used.includes(DRACO_EXTENSION);
}

/**
 * True when the GLB carries an `rv_sig` in its default scene extras — i.e. it
 * has already been signed and must not be transformed any more.
 * Mirrors `getDefaultSceneExtras` in `scripts/rv-sign-glb.mjs`.
 */
export function isSigned(input) {
  const json = readGlbJson(input);
  const scene = Array.isArray(json.scenes) ? json.scenes[json.scene ?? 0] : null;
  const extras = scene?.extras;
  return Boolean(extras && typeof extras === 'object' && !Array.isArray(extras) && 'rv_sig' in extras);
}

/**
 * Compress GLB bytes with Draco and return the new bytes plus a measurement.
 *
 * @param {Uint8Array|ArrayBuffer|Buffer} input raw GLB bytes
 * @param {{force?: boolean, refuseSignedInput?: boolean, dracoOptions?: object}} [options]
 * @returns {Promise<{bytes: Buffer, bytesBefore: number, bytesAfter: number, ratio: number, skipped: boolean, reason?: string}>}
 */
export async function compressGlbBytes(input, options = {}) {
  const { force = false, refuseSignedInput = true, dracoOptions } = options;
  const source = Buffer.from(input);
  const bytesBefore = source.length;

  if (refuseSignedInput && isSigned(source)) {
    throw new Error(
      'refusing to compress a signed GLB: rv_sig is present, and re-encoding the bytes '
      + 'would invalidate the signature. Compress first, sign afterwards.',
    );
  }
  if (!force && hasDraco(source)) {
    return {
      bytes: source,
      bytesBefore,
      bytesAfter: bytesBefore,
      ratio: 1,
      skipped: true,
      reason: `already declares ${DRACO_EXTENSION}`,
    };
  }

  const io = await getIO();
  const document = await io.readBinary(source);
  await document.transform(draco({ ...DEFAULT_DRACO_OPTIONS, ...dracoOptions }));
  const bytes = Buffer.from(await io.writeBinary(document));

  return {
    bytes,
    bytesBefore,
    bytesAfter: bytes.length,
    ratio: bytes.length / bytesBefore,
    skipped: false,
  };
}

/**
 * Compress one file. Writes in place unless `out` is given; `dryRun` measures
 * without writing anything.
 */
export async function compressGlbFile(filePath, options = {}) {
  const { out, dryRun = false, ...rest } = options;
  const result = await compressGlbBytes(readFileSync(filePath), rest);
  const target = out ?? filePath;
  if (!dryRun && !result.skipped) writeFileSync(target, result.bytes);
  return { ...result, path: filePath, target, written: !dryRun && !result.skipped };
}

function formatPercent(ratio) {
  return `${((1 - ratio) * 100).toFixed(1)} %`;
}

async function runCli() {
  const args = process.argv.slice(2);
  const files = [];
  let out = null;
  let dryRun = false;
  let force = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--out') { out = args[++i]; continue; }
    if (arg === '--dry-run') { dryRun = true; continue; }
    if (arg === '--force') { force = true; continue; }
    if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    files.push(arg);
  }
  if (files.length === 0) {
    throw new Error('Usage: node scripts/compress-glb.mjs [--out <file>] [--dry-run] [--force] <file.glb> [...]');
  }
  if (out && files.length > 1) throw new Error('--out takes a single input file');

  for (const file of files) {
    const started = Date.now();
    const result = await compressGlbFile(file, { out, dryRun, force });
    const label = basename(file);
    if (result.skipped) {
      console.log(`${label}: skipped — ${result.reason} (use --force to re-encode)`);
      continue;
    }
    console.log(
      `${label}: ${result.bytesBefore} -> ${result.bytesAfter} B`
      + ` (-${formatPercent(result.ratio)}, factor ${(result.bytesBefore / result.bytesAfter).toFixed(2)}x)`
      + ` in ${((Date.now() - started) / 1000).toFixed(1)} s`
      + `${result.written ? '' : ' [dry run, nothing written]'}`,
    );
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli().catch((error) => {
    console.error(`[compress-glb] ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
