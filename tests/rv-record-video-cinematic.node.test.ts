// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-550 F3 / F6 / F10 — the on-disk side of a cinematic recording: frame naming, the first
 * missing frame, the truncated last PNG, atomic writes, the manifest guard (every field named),
 * the disk-space check, the CLI option mapping and the MCP refusal (no new tool parameters).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BYTES_PER_FRAME_ESTIMATE, DISK_MARGIN, RESUME_FIELDS, checkDiskSpace, compareManifest, formatDuration,
  frameFileName, frameIndexOf, isCompletePng, optionsHash, readManifest, scanFrames, writeFrameAtomic, writeManifest,
} from '../scripts/lib/rv-cinematic-frames.mjs';
import { cinematicBaseManifest, recordOptions, setupBlurRefusal } from '../scripts/rv-record-video.mjs';
import { MOTION_BLUR_DEFAULTS, blurManifestFields, cinematicMotionBlurOptions, resumeRefusal } from '../src/core/engine/rv-cinematic-manifest.mjs';

/** Smallest valid PNG (1×1). */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/eL9GtQAAAABJRU5ErkJggg==', 'base64');

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rv-cinematic-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('frame files', () => {
  it('names frames frame-%06d.png and parses them back', () => {
    expect(frameFileName(0)).toBe('frame-000000.png');
    expect(frameFileName(299)).toBe('frame-000299.png');
    expect(frameIndexOf('frame-000042.png')).toBe(42);
    expect(frameIndexOf('frame-42.png')).toBe(-1);
    expect(frameIndexOf('frame-000042.png.tmp')).toBe(-1);
  });

  it('recognises a complete PNG by its signature and IEND chunk', () => {
    expect(isCompletePng(PNG)).toBe(true);
    expect(isCompletePng(PNG.subarray(0, PNG.length - 3))).toBe(false);
    expect(isCompletePng(Buffer.from('not a png at all, really not'))).toBe(false);
  });

  it('first missing frame + gaps; a truncated LAST frame is removed and rendered again', () => {
    for (const i of [0, 1, 2, 4]) writeFileSync(join(dir, frameFileName(i)), PNG);
    writeFileSync(join(dir, frameFileName(5)), PNG.subarray(0, 20));
    writeFileSync(join(dir, `${frameFileName(6)}.tmp`), PNG.subarray(0, 10));
    const scan = scanFrames(dir, 10);
    expect(scan.removedBroken).toBe('frame-000005.png');
    expect(existsSync(join(dir, frameFileName(5)))).toBe(false);
    expect(scan.firstMissing).toBe(3);
    expect(scan.gaps).toEqual([3]);
    expect(scan.existing).toEqual([0, 1, 2, 4]);
    expect(scan.tempFiles).toEqual(['frame-000006.png.tmp']);
  });

  it('a complete run reports firstMissing = frames; an empty dir 0', () => {
    for (let i = 0; i < 3; i++) writeFileSync(join(dir, frameFileName(i)), PNG);
    expect(scanFrames(dir, 3).firstMissing).toBe(3);
    expect(scanFrames(join(dir, 'nope'), 3).firstMissing).toBe(0);
  });

  it('writes atomically: no partial frame-*.png and no .tmp left behind', () => {
    writeFrameAtomic(dir, 7, PNG);
    expect(readdirSync(dir)).toEqual(['frame-000007.png']);
    expect(readFileSync(join(dir, 'frame-000007.png')).equals(PNG)).toBe(true);
  });

  it('a write error names the file and says the frames so far stay valid', () => {
    expect(() => writeFrameAtomic(join(dir, 'missing-subdir'), 0, PNG)).toThrow(/Could not write .*frame-000000\.png.*stay valid/);
  });
});

describe('manifest guard (F10)', () => {
  const base = {
    version: 1, optionsHash: 'a', frames: 300, fps: 30, width: 1920, height: 1080, samples: 64, denoise: 'aux',
    warmupSeconds: 3, cameraPath: { kind: 'orbit' }, model: 'm.glb', modelHash: 'h1', hdr: 'envmaps/x.hdr', hdrHash: 'x',
    environment: { intensity: 0.6 }, lights: [{ intensity: 2 }], renderer: 'r', tracerVersion: '0.0.26',
    denoiserVersion: 'd', seedRule: 's', cameraPoses: [[0, 1]],
  };

  it('accepts an identical manifest (key order irrelevant)', () => {
    const shuffled = Object.fromEntries(Object.entries(base).reverse());
    expect(compareManifest(base, shuffled)).toBeNull();
  });

  it.each(RESUME_FIELDS)('refuses a resume naming the differing field "%s"', (field) => {
    const changed = { ...base, [field]: { different: true } };
    const msg = compareManifest(base, changed);
    expect(msg).toContain(`"${field}" differs`);
  });

  it('fields the current run does not know yet are not compared', () => {
    const { modelHash: _m, ...partial } = base;
    expect(compareManifest(base, partial)).toBeNull();
  });

  it('options hash: stable, order-independent, sensitive to every option', () => {
    const a = optionsHash({ width: 1, height: 2, samples: 64 });
    expect(optionsHash({ samples: 64, height: 2, width: 1 })).toBe(a);
    expect(optionsHash({ width: 1, height: 2, samples: 32 })).not.toBe(a);
  });

  it('round-trips through disk atomically', () => {
    writeManifest(dir, base);
    expect(readManifest(dir)).toEqual(base);
    expect(readdirSync(dir)).toEqual(['cinematic.json']);
    writeFileSync(join(dir, 'cinematic.json'), '{broken');
    expect(() => readManifest(dir)).toThrow(/not valid JSON/);
  });

  it('the CLI base manifest changes its hash with samples, denoise, size, path and the HDR file', () => {
    const opts = recordOptions({ quality: 'cinematic', 'out-dir': dir, size: '160x90', fps: '30', seconds: '1' });
    const m = cinematicBaseManifest(opts, null);
    expect(m).toMatchObject({ frames: 30, fps: 30, width: 160, height: 90, samples: 64, denoise: 'aux' });
    expect(cinematicBaseManifest({ ...opts, samples: 4 }, null).optionsHash).not.toBe(m.optionsHash);
    expect(cinematicBaseManifest({ ...opts, denoise: 'off' }, null).optionsHash).not.toBe(m.optionsHash);
    expect(cinematicBaseManifest(opts, 'abc').optionsHash).not.toBe(m.optionsHash);
    expect(compareManifest(m, cinematicBaseManifest({ ...opts, samples: 4 }, null))).toMatch(/"optionsHash" differs/);
  });
});

describe('disk space (F10)', () => {
  it('refuses when free space < remaining × 1.5 MB × 1.2', () => {
    const need = Math.ceil(100 * BYTES_PER_FRAME_ESTIMATE * DISK_MARGIN);
    const statfs = (free: number) => () => ({ bavail: BigInt(free), bsize: 1n });
    expect(() => checkDiskSpace(dir, 100, statfs(need - 1) as never)).toThrow(/Not enough disk space/);
    expect(checkDiskSpace(dir, 100, statfs(need) as never).need).toBe(need);
    // an unknown filesystem never blocks
    expect(checkDiskSpace(dir, 100, (() => { throw new Error('ENOSYS'); }) as never).free).toBeNull();
  });
});

describe('CLI options (F6)', () => {
  it('maps --quality cinematic with defaults 64 spp + aux and requires --out-dir', () => {
    const o = recordOptions({ quality: 'cinematic', 'out-dir': dir, samples: '4', denoise: 'off', size: '160x90', fps: '30', seconds: '1' });
    expect(o).toMatchObject({ quality: 'cinematic', samples: 4, denoise: 'off', width: 160, height: 90, fps: 30, seconds: 1 });
  });

  it('formats ETAs readably', () => {
    expect(formatDuration(12)).toBe('12 s');
    expect(formatDuration(185)).toBe('3 min 05 s');
    expect(formatDuration(6480)).toBe('1 h 48 min');
  });
});

describe('core stays free of the tracer (F2/F13)', () => {
  it('no AGPL core source imports three-gpu-pathtracer, oidn-web or three/webgpu for the cinematic path', () => {
    const offenders: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.(ts|tsx)$/.test(e.name)) continue;
        const src = readFileSync(p, 'utf8');
        if (/from ['"](three-gpu-pathtracer|oidn-web)(\/[^'"]*)?['"]|import\(['"](three-gpu-pathtracer|oidn-web)/.test(src)) offenders.push(p);
      }
    };
    walk(fileURLToPath(new URL('../src', import.meta.url)));
    expect(offenders).toEqual([]);
  });

  it('the core hook imports neither the viewer nor a plugin (eslint boundaries)', () => {
    const src = readFileSync(new URL('../src/core/engine/rv-cinematic-hook.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/from ['"][^'"]*(rv-viewer|rv-plugin)['"]/);
  });
});

describe('MCP refuses cinematic without new parameters (F14)', () => {
  it('the tool source answers cinematic with the CLI pointer and declares no cinematic parameter', () => {
    const src = readFileSync(new URL('../src/plugins/mcp-bridge/rv-mcp-video-tools.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/CINEMATIC_MCP_ERROR/);
    expect(src).toMatch(/npm run record -- <viewer url> --quality cinematic --out-dir/);
    for (const p of ['samples', 'denoise', 'startFrame', 'outDir', 'hdr']) {
      expect(src).not.toMatch(new RegExp(`@McpParam\\('${p}'`));
    }
  });
});

describe('CLI --orbit-from-view (plan-551 F3)', () => {
  it('maps the flag onto the orbit spec and refuses it for other paths', async () => {
    const { parseArgs } = await import('../scripts/rv-record-video.mjs');
    const { opts } = parseArgs(['--orbit-from-view', '--seconds', '2']);
    expect(recordOptions(opts).path).toEqual({ kind: 'orbit', fromCurrentView: true });
    expect(recordOptions({ seconds: '2' }).path).toEqual({ kind: 'orbit' });
  });

  it('cameraPoses (the resolved camera) is a resume field (F20)', () => {
    expect(RESUME_FIELDS).toContain('cameraPoses');
    const stored = { version: 1, cameraPoses: [[0, 1, 2, 0, 0, 0, 50, 0, 1]] };
    expect(compareManifest(stored, { ...stored, cameraPoses: [[0, 1, 2, 0, 0, 0, 40, 0, 1]] })).toMatch(/"cameraPoses" differs/);
  });
});

describe('CLI look options (plan-553 F7)', () => {
  const cine = { quality: 'cinematic', 'out-dir': 'x', size: '160x90', fps: '30', seconds: '1' };

  it('defaults: studio, no DoF, vignette / presets left to the defaults', () => {
    const o = recordOptions({ ...cine });
    expect(o.look).toBe('studio');
    expect(o.dof).toBeUndefined();
    expect(o.vignette).toBeUndefined();
    expect(o.materialPresets).toBeUndefined();
    expect(cinematicBaseManifest(o, null).lookOptions).toEqual({ look: 'studio', dof: false, fStop: null, vignette: 0.15, materialPresets: true, materialOverrides: null });
  });

  it('maps --look --vignette --dof --fstop --no-material-presets --material-overrides', async () => {
    const { parseArgs } = await import('../scripts/rv-record-video.mjs');
    const file = join(dir, 'cinematic-materials.json');
    writeFileSync(file, JSON.stringify({ rules: [{ match: 'scheibe', preset: 'glass' }] }));
    const { opts } = parseArgs(['--quality', 'cinematic', '--out-dir', dir, '--look', 'outdoor', '--vignette', '0', '--dof', '--fstop', '2.8', '--no-material-presets', '--material-overrides', file]);
    const o = recordOptions(opts);
    expect(o).toMatchObject({ look: 'outdoor', vignette: 0, dof: true, fStop: 2.8, materialPresets: false, materialOverrides: { rules: [{ match: 'scheibe', preset: 'glass' }] } });
  });

  it('every look option changes the options hash; the override CONTENT counts, not the file', () => {
    const o = recordOptions({ ...cine });
    const h = (x: object) => cinematicBaseManifest({ ...o, ...x }, null).optionsHash;
    const base = h({});
    for (const x of [{ look: 'hall' }, { dof: true }, { vignette: 0.2 }, { materialPresets: false }, { materialOverrides: { rules: [] } }]) {
      expect(h(x)).not.toBe(base);
    }
    expect(h({ dof: true, fStop: 2.8 })).not.toBe(h({ dof: true }));
    // explicit defaults hash like omitted ones (CLI and dialog agree)
    expect(h({ look: 'studio', vignette: 0.15, materialPresets: true })).toBe(base);
    expect(h({ materialOverrides: { rules: [{ match: 'a', preset: 'glass' }] } })).not.toBe(h({ materialOverrides: { rules: [{ match: 'a', preset: 'paint' }] } }));
  });

  it('a changed look option refuses a resume naming "lookOptions"; look is a resume field', () => {
    const o = recordOptions({ ...cine });
    const a = cinematicBaseManifest(o, null);
    expect(compareManifest(a, cinematicBaseManifest({ ...o, look: 'hall' }, null))).toMatch(/"lookOptions" differs/);
    expect(RESUME_FIELDS).toContain('look');
    // a plan-550 manifest (no lookOptions) is refused, never resumed with a look
    const { lookOptions: _l, ...old } = a;
    expect(compareManifest(old, a)).toMatch(/"lookOptions" differs/);
  });

});

// ─── plan-554: motion blur options, requested + resolved mode in the manifest ──────────────

describe('CLI motion blur (plan-554 F7/F8)', () => {
  const cine = { quality: 'cinematic', 'out-dir': 'x', size: '160x90', fps: '30', seconds: '1' };

  it('maps --motion-blur / --shutter / --blur-subframes; defaults are left to the page (on, 180°, 8)', async () => {
    const { parseArgs } = await import('../scripts/rv-record-video.mjs');
    expect(recordOptions({ ...cine }).motionBlur).toEqual({});
    expect(cinematicBaseManifest(recordOptions({ ...cine }), null).motionBlur).toEqual({ enabled: true, shutterDeg: 180, subFrames: 8 });
    expect(MOTION_BLUR_DEFAULTS).toEqual({ enabled: true, shutterDeg: 180, subFrames: 8 });
    const { opts } = parseArgs(['--quality', 'cinematic', '--out-dir', dir, '--motion-blur', 'on', '--shutter', '270', '--blur-subframes', '16']);
    expect(recordOptions(opts).motionBlur).toEqual({ enabled: true, shutterDeg: 270, subFrames: 16 });
    expect(recordOptions({ ...cine, 'motion-blur': 'off' }).motionBlur).toEqual({ enabled: false });
  });

  it('every way of switching it off hashes the same (canonical off form); shutter / K change the hash', () => {
    const o = recordOptions({ ...cine });
    const h = (mb: object) => cinematicBaseManifest({ ...o, motionBlur: mb }, null).optionsHash;
    expect(cinematicMotionBlurOptions({ motionBlur: { shutterDeg: 0 } })).toEqual({ enabled: false, shutterDeg: 0, subFrames: 1 });
    expect(h({ enabled: false })).toBe(h({ shutterDeg: 0 }));
    expect(h({ enabled: false, shutterDeg: 270, subFrames: 4 })).toBe(h({ enabled: false }));
    expect(h({})).toBe(h({ enabled: true, shutterDeg: 180, subFrames: 8 })); // explicit defaults = omitted
    for (const mb of [{ enabled: false }, { shutterDeg: 90 }, { shutterDeg: 360 }, { subFrames: 2 }, { subFrames: 32 }]) {
      expect(h(mb)).not.toBe(h({}));
    }
  });

  it('a changed request refuses a resume naming "motionBlur"; a pre-554 folder (no field) is refused', () => {
    const o = recordOptions({ ...cine });
    const a = cinematicBaseManifest(o, null);
    expect(RESUME_FIELDS).toEqual(expect.arrayContaining(['motionBlur', 'resolvedBlur']));
    expect(RESUME_FIELDS.indexOf('motionBlur')).toBeLessThan(RESUME_FIELDS.indexOf('optionsHash'));
    expect(compareManifest(a, cinematicBaseManifest({ ...o, motionBlur: { enabled: false } }, null))).toMatch(/"motionBlur" differs/);
    const { motionBlur: _m, ...old } = a;
    expect(resumeRefusal(old, a, 3)).toMatch(/"motionBlur" differs/);
  });

  it('the resolved mode is compared a second time after setup: supported ↔ fallback refused both ways', () => {
    const stored = { ...cinematicBaseManifest(recordOptions({ ...cine }), null), ...blurManifestFields({ resolved: 'pathA-v1', reason: null, subFrames: 8 }) };
    expect(stored).toMatchObject({ resolvedBlur: 'pathA-v1', blurFallbackReason: null, blurSubFrames: 8 });
    // same resolved mode → resume allowed
    expect(setupBlurRefusal(stored, { motionBlur: { resolved: 'pathA-v1', reason: null, subFrames: 8 } }, true)).toBeNull();
    // supported → fallback refused
    expect(setupBlurRefusal(stored, { motionBlur: { resolved: 'off', reason: 'tracer 0.0.27 not verified', subFrames: 1 } }, true)).toMatch(/"resolvedBlur" differs/);
    // fallback → supported refused
    const storedOff = { ...stored, ...blurManifestFields({ resolved: 'off', reason: 'x', subFrames: 1 }) };
    expect(setupBlurRefusal(storedOff, { motionBlur: { resolved: 'pathA-v1', reason: null, subFrames: 8 } }, true)).toMatch(/"resolvedBlur" differs/);
    // a fresh run never compares
    expect(setupBlurRefusal(storedOff, { motionBlur: { resolved: 'pathA-v1', reason: null, subFrames: 8 } }, false)).toBeNull();
    // a setup info without the field (pre-554 page) resolves to off
    expect(blurManifestFields(undefined)).toEqual({ resolvedBlur: 'off', blurFallbackReason: null, blurSubFrames: 1 });
  });

  it('raster recordings refuse the blur options', () => {
    const src = readFileSync(new URL('../scripts/rv-record-video.mjs', import.meta.url), 'utf8');
    expect(src).toMatch(/'motion-blur', 'shutter', 'blur-subframes',/);
  });
});
