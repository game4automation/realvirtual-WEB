// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-556 — the CLI side of the HMI recording (`scripts/lib/rv-record-hmi.mjs` and the option
 * rules in `scripts/rv-record-video.mjs`): `--hmi` / `--hmi-open` / `--still` / `--at` /
 * `--keep-frames` rules and the raster output contract (F1/F5a/F5b), the manifest hash staying
 * golden with the HMI off and naming `hmi` on a mismatch (F8, N2), the pair-complete resume scan
 * (F8), the Node half of the frame hook with its generation token (F9), the shared mux helper
 * forwarding codec / bitrate / abort (F5a) and the unsupported `--hmi-open` refusal (F1).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CliUsageError, cinematicBaseManifest, engineOptions, hmiOptionsOf, parseArgs, recordOptions, stillOptions,
} from '../scripts/rv-record-video.mjs';
import {
  checkFreshOutDir, createHmiFrameWriter, deleteCompositeFrames, enterRecordingPage, hmiFileName, muxFrameDir,
  scanPairs, stillLayerPath,
} from '../scripts/lib/rv-record-hmi.mjs';
import { RESUME_FIELDS, compareManifest, frameFileName, resumeRefusal } from '../src/core/engine/rv-cinematic-manifest.mjs';

/** Smallest valid PNG (1×1). */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/eL9GtQAAAABJRU5ErkJggg==', 'base64');

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rv-hmi-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const args = (...a: string[]) => parseArgs(a).opts;
const usageOf = (f: () => unknown): string => {
  try { f(); } catch (e) { if (e instanceof CliUsageError) return (e as Error).message; throw e; }
  return '(no usage error)';
};

describe('--hmi / --hmi-open (F1)', () => {
  it('default off: no HMI fields, the --out-dir / --mp4 refusal of a raster run stays', () => {
    const o = recordOptions(args('--seconds', '1'));
    expect('hmi' in o).toBe(false);
    expect(hmiOptionsOf(args('--seconds', '1'), 'high')).toMatchObject({ mode: 'off', on: false, open: [], still: null });
    expect(usageOf(() => recordOptions(args('--out-dir', dir)))).toMatch(/--out-dir is only valid with --quality cinematic/);
    expect(usageOf(() => recordOptions(args('--hmi', 'off', '--mp4', 'x.mp4')))).toMatch(/--mp4 is only valid with --quality cinematic/);
  });

  it('values composite | layer | off; anything else is refused', () => {
    expect(usageOf(() => recordOptions(args('--hmi', 'overlay')))).toMatch(/--hmi must be one of off, composite, layer/);
    const o = recordOptions(args('--hmi', 'layer', '--out-dir', dir, '--mp4', 'x.mp4', '--size', '640x360'));
    expect(o).toMatchObject({ hmi: 'layer', hmiOpen: [], viewport: { width: 640, height: 360 } });
    // the HMI fields are manifest data, never engine options
    expect(engineOptions(o)).not.toHaveProperty('hmi');
    expect(engineOptions(o)).not.toHaveProperty('viewport');
  });

  it('--hmi-open needs the HMI on and is parsed as a list', () => {
    expect(usageOf(() => recordOptions(args('--hmi-open', 'op1')))).toMatch(/--hmi-open needs --hmi composite or --hmi layer/);
    const o = recordOptions(args('--hmi', 'composite', '--hmi-open', 'op1, connect', '--out-dir', dir, '--mp4', 'x.mp4'));
    expect(o.hmiOpen).toEqual(['op1', 'connect']);
  });

  it('F5a: a raster HMI run requires --out-dir AND --mp4', () => {
    expect(usageOf(() => recordOptions(args('--hmi', 'composite', '--mp4', 'x.mp4')))).toMatch(/needs --out-dir <new dir>/);
    expect(usageOf(() => recordOptions(args('--hmi', 'layer', '--out-dir', dir)))).toMatch(/needs --mp4 <file>/);
    // cinematic keeps its own rule (--out-dir required, --mp4 optional)
    expect(() => recordOptions(args('--quality', 'cinematic', '--hmi', 'composite', '--out-dir', dir))).not.toThrow();
  });

  it('--keep-frames only with composite; true | false', () => {
    expect(usageOf(() => recordOptions(args('--hmi', 'layer', '--out-dir', dir, '--mp4', 'x.mp4', '--keep-frames', 'false'))))
      .toMatch(/only valid with --hmi composite/);
    expect(hmiOptionsOf(args('--hmi', 'composite', '--out-dir', dir, '--mp4', 'x', '--keep-frames', 'false'), 'high').keepFrames).toBe(false);
    expect(usageOf(() => recordOptions(args('--hmi', 'composite', '--out-dir', dir, '--mp4', 'x', '--keep-frames', 'no')))).toMatch(/true or false/);
  });

  it('--hmi-timeout is bounded and needs the HMI', () => {
    expect(hmiOptionsOf(args('--hmi', 'composite', '--out-dir', dir, '--mp4', 'x', '--hmi-timeout', '5'), 'high').timeoutMs).toBe(5000);
    expect(usageOf(() => recordOptions(args('--hmi-timeout', '5')))).toMatch(/needs --hmi/);
  });
});

describe('--still / --at (F5b)', () => {
  it('one image: refused with --seconds / --frames / --out-dir / --mp4; --at only with --still', () => {
    for (const k of ['--seconds', '--frames', '--out-dir', '--mp4']) {
      expect(usageOf(() => recordOptions(args('--still', 'a.png', k, '1')))).toMatch(/--still cannot be combined/);
    }
    expect(usageOf(() => recordOptions(args('--at', '1')))).toMatch(/--at is only valid with --still/);
    expect(usageOf(() => recordOptions(args('--still', 'a.jpg')))).toMatch(/needs a \.png/);
  });

  it('--at 0 = no step; --at 0.51 = 31 steps; 3840×2160 output, raster and cinematic (no --out-dir needed)', () => {
    const r = recordOptions(args('--still', 'a.png', '--size', '3840x2160'));
    const h0 = hmiOptionsOf(args('--still', 'a.png'), 'high');
    expect(h0.steps).toBe(0);
    const h = hmiOptionsOf(args('--still', 'a.png', '--at', '0.51'), 'high');
    expect(h.steps).toBe(31);
    expect(stillOptions(engineOptions(r), h)).toEqual({ width: 3840, height: 2160, quality: 'high', resetSimulation: true, steps: 31 });
    const c = recordOptions(args('--still', 'a.png', '--quality', 'cinematic', '--samples', '8', '--hmi', 'layer'));
    const so = stillOptions(engineOptions(c), hmiOptionsOf(args('--still', 'a.png'), 'cinematic'));
    expect(so).toMatchObject({ quality: 'cinematic', samples: 8, resetSimulation: true });
    expect(so).not.toHaveProperty('motionBlur');
    expect(stillLayerPath('/x/shot.png')).toBe('/x/shot-hmi.png');
  });
});

describe('manifest (F8, N2)', () => {
  const cine = ['--quality', 'cinematic', '--out-dir', 'x', '--size', '160x90', '--fps', '30', '--seconds', '1'];

  it('with the HMI off the options hash stays the golden plan-554 value', () => {
    expect(cinematicBaseManifest(recordOptions(args(...cine)), null).optionsHash).toBe('b67724e0ff3fc523');
    expect(cinematicBaseManifest(recordOptions(args(...cine, '--hmi', 'off')), null).optionsHash).toBe('b67724e0ff3fc523');
    expect(cinematicBaseManifest(recordOptions(args(...cine)), null)).not.toHaveProperty('hmi');
  });

  it('hmi, hmiOpen and viewport change the hash when on and are readable copies', () => {
    const off = cinematicBaseManifest(recordOptions(args(...cine)), null);
    const comp = cinematicBaseManifest(recordOptions(args(...cine, '--hmi', 'composite')), null);
    const layer = cinematicBaseManifest(recordOptions(args(...cine, '--hmi', 'layer')), null);
    const opened = cinematicBaseManifest(recordOptions(args(...cine, '--hmi', 'composite', '--hmi-open', 'op1')), null);
    const bigger = cinematicBaseManifest(recordOptions(args(...cine.slice(0, 4), '--size', '320x180', '--fps', '30', '--seconds', '1', '--hmi', 'composite')), null);
    const hashes = new Set([off, comp, layer, opened].map((m) => m.optionsHash));
    expect(hashes.size).toBe(4);
    expect(bigger.optionsHash).not.toBe(comp.optionsHash);
    expect(comp).toMatchObject({ hmi: 'composite', hmiOpen: [], viewport: { width: 160, height: 90 } });
  });

  it('a resume names "hmi" for an off / composite mismatch in both directions', () => {
    const off = cinematicBaseManifest(recordOptions(args(...cine)), null);
    const comp = cinematicBaseManifest(recordOptions(args(...cine, '--hmi', 'composite')), null);
    expect(compareManifest(off, comp)).toMatch(/"hmi" differs \(stored "off", now "composite"\)/);
    expect(compareManifest(comp, off)).toMatch(/"hmi" differs \(stored "composite", now "off"\)/);
    expect(resumeRefusal(comp, comp, 3)).toBeNull();
    // an existing folder without hmi resumes an off run exactly as before
    expect(compareManifest(off, off)).toBeNull();
  });

  it.each(['hmi', 'hmiOpen', 'viewport', 'layoutFingerprint'])('"%s" is a resume field before optionsHash', (f) => {
    expect(RESUME_FIELDS.indexOf(f)).toBeGreaterThan(-1);
    expect(RESUME_FIELDS.indexOf(f)).toBeLessThan(RESUME_FIELDS.indexOf('optionsHash'));
  });
});

describe('pair-complete resume scan (F8)', () => {
  const put = (name: string, bytes: Buffer = PNG) => writeFileSync(join(dir, name), bytes);

  it('crash between frame-i and hmi-i (either order) → resume at i, both rewritten', () => {
    for (let i = 0; i < 3; i++) { put(frameFileName(i)); put(hmiFileName(i)); }
    put(frameFileName(3)); // hmi-3 missing
    expect(scanPairs(dir, 6, { layer: true }).firstIncomplete).toBe(3);
    rmSync(join(dir, frameFileName(3)));
    put(hmiFileName(3)); // frame-3 missing, hmi-3 orphan
    expect(scanPairs(dir, 6, { layer: true }).firstIncomplete).toBe(3);
  });

  it('a truncated hmi-i counts as missing; orphans after the first gap do not move the resume point', () => {
    for (let i = 0; i < 4; i++) { put(frameFileName(i)); put(hmiFileName(i)); }
    put(hmiFileName(1), PNG.subarray(0, 20));
    put(frameFileName(5)); put(hmiFileName(5));
    expect(scanPairs(dir, 6, { layer: true }).firstIncomplete).toBe(1);
    // composite: only frame-i counts (there is no hmi-i)
    expect(scanPairs(dir, 6, { layer: false }).firstIncomplete).toBe(4);
  });
});

describe('raster output contract (F5a)', () => {
  it('a raster HMI run needs a fresh --out-dir (missing or empty)', () => {
    expect(() => checkFreshOutDir(join(dir, 'new'))).not.toThrow();
    expect(() => checkFreshOutDir(dir)).not.toThrow();
    writeFileSync(join(dir, 'old.txt'), 'x');
    expect(() => checkFreshOutDir(dir)).toThrow(/is not empty/);
  });

  it('--keep-frames false deletes composites only, never hmi-*', () => {
    for (let i = 0; i < 3; i++) { writeFileSync(join(dir, frameFileName(i)), PNG); writeFileSync(join(dir, hmiFileName(i)), PNG); }
    deleteCompositeFrames(dir, 3);
    expect(readdirSync(dir).sort()).toEqual([hmiFileName(0), hmiFileName(1), hmiFileName(2)]);
  });
});

/** A Playwright page stand-in: screenshots, evaluate, exposeFunction, route, download. */
function fakePage(o: { shot?: (opts: Record<string, unknown>) => Promise<Buffer> } = {}) {
  const calls: { shots: Record<string, unknown>[]; evals: unknown[]; exposed: Record<string, (...a: unknown[]) => unknown> } = { shots: [], evals: [], exposed: {} };
  const page = {
    calls,
    screenshot: async (opts: Record<string, unknown>) => { calls.shots.push(opts); return o.shot ? o.shot(opts) : PNG; },
    evaluate: async (fn: unknown, arg?: unknown) => { calls.evals.push(arg ?? String(fn)); return page.evalResult(fn, arg); },
    evalResult: (_fn: unknown, _arg: unknown): unknown => undefined,
    exposeFunction: async (name: string, f: (...a: unknown[]) => unknown) => { calls.exposed[name] = f; },
    route: async () => undefined,
    unroute: async () => undefined,
    waitForEvent: async () => ({ saveAs: async (p: string) => { writeFileSync(p, Buffer.from('mp4')); } }),
  };
  return page;
}

describe('Node half of the frame hook (F5/F6/F9)', () => {
  it('composite writes frame-i; layer switches the layer mode around an omitBackground shot and writes hmi-i', async () => {
    const p1 = fakePage();
    const w1 = createHmiFrameWriter({ page: p1 as never, dir, mode: 'composite', timeoutMs: 1000 });
    await w1.expose();
    expect(await p1.calls.exposed.__rvHmiFrame(0, w1.generation)).toBeNull();
    expect(existsSync(join(dir, frameFileName(0)))).toBe(true);
    expect(p1.calls.shots[0]).toMatchObject({ animations: 'allow', timeout: 1000 });

    const p2 = fakePage();
    const w2 = createHmiFrameWriter({ page: p2 as never, dir, mode: 'layer', timeoutMs: 1000 });
    await w2.expose();
    expect(await p2.calls.exposed.__rvHmiFrame(4, w2.generation)).toBeNull();
    expect(existsSync(join(dir, hmiFileName(4)))).toBe(true);
    expect(p2.calls.shots[0]).toMatchObject({ omitBackground: true, animations: 'allow' });
    expect(p2.calls.evals.length).toBe(2); // layer mode on, off
  });

  it('generation token: a callback after stop() — or of an older generation — writes nothing', async () => {
    let release: () => void = () => undefined;
    const slow = new Promise<Buffer>((r) => { release = () => r(PNG); });
    const p = fakePage({ shot: () => slow });
    const w = createHmiFrameWriter({ page: p as never, dir, mode: 'composite', timeoutMs: 1000 });
    await w.expose();
    const gen = w.generation;
    const pending = p.calls.exposed.__rvHmiFrame(7, gen) as Promise<string | null>;
    w.stop(); // the run timed out / was aborted while the screenshot was in flight
    release();
    expect(await pending).toMatch(/stale/);
    expect(existsSync(join(dir, frameFileName(7)))).toBe(false);
    expect(await p.calls.exposed.__rvHmiFrame(8, gen)).toMatch(/stale/);
  });

  it('a screenshot failure is returned as the frame error (the page throws it, the run stops)', async () => {
    const p = fakePage({ shot: async () => { throw new Error('Timeout 1000ms exceeded'); } });
    const w = createHmiFrameWriter({ page: p as never, dir, mode: 'composite', timeoutMs: 1000 });
    await w.expose();
    expect(await p.calls.exposed.__rvHmiFrame(0, w.generation)).toMatch(/HMI frame 0: Timeout 1000ms exceeded/);
  });
});

describe('shared mux helper (F5a)', () => {
  it('forwards codec, bitrate and the abort handle; verifies the saved MP4', async () => {
    const p = fakePage();
    p.evalResult = () => ({ codec: 'hvc1.1.6.L123.B0', bitrate: 3_000_000, sizeBytes: 3, frames: 3, hardwareAcceleration: 'x' });
    const out = join(dir, 'out.mp4');
    const r = await muxFrameDir(p as never, {
      dir, frames: 3, fps: 30, width: 160, height: 90, out, codec: 'hevc', bitrate: 3_000_000,
      verify: async () => ({ frames: 3, duration: 0.1, width: 160, height: 90 }),
    });
    expect(p.calls.evals[0]).toMatchObject({ frames: 3, fps: 30, width: 160, height: 90, codec: 'hevc', bitrate: 3_000_000, name: 'out.mp4' });
    // the page side installs window.__rvRecordAbort and passes its signal
    expect(String((muxFrameDir as unknown as { toString(): string }).toString())).toMatch(/window\.__rvRecordAbort = ac[\s\S]*signal: ac\.signal/);
    expect(r.check.frames).toBe(3);
    expect(existsSync(out)).toBe(true);
  });
});

describe('--hmi-open with an unsupported id (F1/F4)', () => {
  it('is refused as a usage error naming the supported list', async () => {
    const p = fakePage();
    p.evalResult = () => ({ error: '--hmi-open: unsupported panel id "hierarchy" — supported: op1, connect.', usage: true });
    await expect(enterRecordingPage(p as never, { open: ['hierarchy'] })).rejects.toMatchObject({
      usage: true, message: expect.stringMatching(/supported: op1, connect/),
    });
  });

  it('a hidden page is refused before the first frame (F9)', async () => {
    const p = fakePage();
    p.evalResult = () => ({ error: 'The recording page is hidden — page screenshots need a visible page (keep the window / RDP session visible).' });
    await expect(enterRecordingPage(p as never, { open: [] })).rejects.toThrow(/hidden/);
  });
});

