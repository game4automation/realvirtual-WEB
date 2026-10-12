// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-551 F5 / F17 / F24 — the shared cinematic manifest module (`src/core/engine/
 * rv-cinematic-manifest.mjs`): portable (no imports at all), the CLI's re-export shim keeps the
 * Node adapter, the CLI's synchronous digest and the browser's WebCrypto digest give the same
 * hash, and the CLI base-manifest hash stays bit-identical to plan-550 (golden values).
 */

import { describe, expect, it } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  CLI_WORDING, RESUME_FIELDS, cinematicBaseManifestAsync, classifyFrameNames, compareManifest, frameFileName,
  frameIndexOf, isCompletePng, optionsHashAsync, optionsHashSync, resumePoint, resumeRefusal, stableStringify,
} from '../src/core/engine/rv-cinematic-manifest.mjs';
import * as shim from '../scripts/lib/rv-cinematic-frames.mjs';
import { cinematicBaseManifest, recordOptions } from '../scripts/rv-record-video.mjs';

const nodeDigest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const webDigest = async (bytes: Uint8Array): Promise<string> =>
  [...new Uint8Array(await webcrypto.subtle.digest('SHA-256', bytes as never))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Smallest valid PNG (1×1). */
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/eL9GtQAAAABJRU5ErkJggg==', 'base64'));

describe('shared module is portable (F17)', () => {
  it('has no imports and touches no Node or DOM API', () => {
    const src = readFileSync(new URL('../src/core/engine/rv-cinematic-manifest.mjs', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/\brequire\(|\bBuffer\b|node:|\bdocument\.|\bwindow\./);
  });

  it('the CLI shim re-exports the portable rules and keeps the fs adapter', () => {
    expect(shim.frameFileName).toBe(frameFileName);
    expect(shim.compareManifest).toBe(compareManifest);
    expect(shim.RESUME_FIELDS).toBe(RESUME_FIELDS);
    for (const fn of ['scanFrames', 'writeFrameAtomic', 'readManifest', 'writeManifest', 'checkDiskSpace', 'sha256', 'optionsHash']) {
      expect(typeof (shim as Record<string, unknown>)[fn], fn).toBe('function');
    }
  });
});

describe('frame names and PNG completeness on Uint8Array (F5)', () => {
  it('names, parses, classifies', () => {
    expect(frameFileName(7)).toBe('frame-000007.png');
    expect(frameIndexOf('frame-000007.png')).toBe(7);
    const c = classifyFrameNames(['frame-000002.png', 'frame-000000.png', 'notes.txt', 'frame-000001.png.tmp', 'frame-000009.png', 'frame-000003.png.crswap'], 5);
    expect(c.present).toEqual([0, 2]);
    expect(c.tempFiles).toEqual(['frame-000001.png.tmp']);
    expect(resumePoint(c.present, 5)).toEqual({ existing: [0, 2], firstMissing: 1, gaps: [1] });
  });

  it('a complete PNG passes, a truncated one fails — plain Uint8Array, no Buffer', () => {
    expect(isCompletePng(PNG)).toBe(true);
    expect(isCompletePng(PNG.subarray(0, PNG.length - 1))).toBe(false);
    expect(isCompletePng(new Uint8Array(4))).toBe(false);
  });
});

describe('hashes (F24)', () => {
  it('stableStringify sorts keys and drops undefined', () => {
    expect(stableStringify({ b: 1, a: [{ d: 2, c: undefined }] })).toBe('{"a":[{"d":2}],"b":1}');
  });

  it('Node sync digest and WebCrypto async digest give the same options hash', async () => {
    const o = { width: 1, height: 2, samples: 64, path: { kind: 'orbit', center: [1, 2, 3] } };
    const sync = optionsHashSync(o, nodeDigest);
    expect(await optionsHashAsync(o, webDigest)).toBe(sync);
    expect(shim.optionsHash(o)).toBe(sync);
  });

  it('golden: the CLI base manifest hash (plan-553 look options, plan-554 motion blur are part of it)', async () => {
    // plan-550 golden was 6c034fe5d015c365 / cf1f186d76fe2776 — plan-553 F7 added the look options
    // (look, dof, fStop, vignette, materialPresets, materialOverrides) to the hash on purpose: a
    // plan-550 folder is refused naming "lookOptions" instead of being resumed with another look.
    // plan-553 golden was 27545a68d785d5a2 / 0df664197505d3f7 — plan-554 F7 added the requested
    // motion blur on purpose (also for a run without blur): a pre-554 folder is refused naming
    // "motionBlur".
    const opts = recordOptions({ quality: 'cinematic', 'out-dir': 'x', size: '160x90', fps: '30', seconds: '1' });
    expect(cinematicBaseManifest(opts, null).optionsHash).toBe('b67724e0ff3fc523');
    expect(cinematicBaseManifest(opts, 'abc').optionsHash).toBe('94824ed1c3a1f5f3');
    expect(shim.optionsHash({ width: 1, height: 2, samples: 64 })).toBe('4b455fd6dfdf7d7b');
    // The browser builds the same manifest with WebCrypto.
    expect(await cinematicBaseManifestAsync(opts as never, null, webDigest)).toEqual(cinematicBaseManifest(opts, null));
  });
});

describe('manifest guard (F5/F13)', () => {
  const base = { version: 1, optionsHash: 'a', frames: 60, cameraPath: { kind: 'orbit' } };

  it('compareManifest names the field, in the caller\'s wording', () => {
    const msg = compareManifest(base, { ...base, frames: 30 }, { place: 'This folder', advice: 'Use a different folder.' });
    expect(msg).toMatch(/^This folder holds frames of a different recording: "frames" differs .*Use a different folder\.$/);
    expect(compareManifest(base, { ...base, frames: 30 })).toContain(CLI_WORDING.advice);
  });

  it('resumeRefusal: fresh folder ok, frames without manifest refused, foreign manifest refused, same recording ok', () => {
    expect(resumeRefusal(null, base, 0)).toBeNull();
    expect(resumeRefusal(base, { ...base, frames: 30 }, 0)).toBeNull(); // no frames yet → start over
    expect(resumeRefusal(null, base, 3)).toMatch(/no cinematic\.json/);
    expect(resumeRefusal({ ...base, optionsHash: 'b' }, base, 3)).toMatch(/"optionsHash" differs/);
    expect(resumeRefusal(base, base, 3)).toBeNull();
  });
});
