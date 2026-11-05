// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Object3D, Scene, AnimationClip, VectorKeyframeTrack, QuaternionKeyframeTrack, type KeyframeTrack } from 'three';
import { USDZExporter } from 'three/examples/jsm/exporters/USDZExporter.js';
import { strFromU8, unzipSync } from 'three/examples/jsm/libs/fflate.module.js';

interface HeapRun { before: number; after: number; bufferPeak: number; outputBytes: number; renamed: number; unmatched: number[]; digest: string; peak?: number }
interface GcEvent { reason: string; start_object_size: number; end_object_size: number }
function measure(modulePath: string, inputPath: string, optionsPath: string, output = 'text'): HeapRun[] {
  const runs: HeapRun[] = [];
  // Separate children avoid stale stack roots and GC trace attribution across
  // runs. Each run collects synchronously AFTER loading/compiling its inputs.
  for (let iteration = 0; iteration < 3; iteration++) {
    const child = spawnSync(process.execPath, ['--expose-gc', '--trace-gc-nvp', resolve('tests/helpers/usd-post-memory-probe.mjs'), modulePath, inputPath, optionsPath, output], { encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    expect(child.error).toBeUndefined(); expect(child.status, child.stderr).toBe(0);
    const measured: HeapRun[] = JSON.parse(readFileSync(inputPath + '.results.json', 'utf8'));
    expect(measured).toHaveLength(1);
    const run = measured[0];
    const events: GcEvent[] = child.stdout.split('\n').flatMap((line) => {
      const record = /GC: (\{.*\})/.exec(line); return record ? [JSON.parse(record[1])] : [];
    });
    if (events.length) {
      let collection = -1;
      events.forEach((gc, index) => { if (gc.reason === 'testing') collection = index; });
      expect(collection).toBeGreaterThanOrEqual(0);
      // A major collection may emit more than one trace record; use its LAST
      // record, then count every allocation-triggered GC within the post-pass.
      for (const gc of events.slice(collection + 1)) run.peak = Math.max(run.peak ?? run.after, gc.start_object_size, gc.end_object_size);
    } else expect(child.stdout).toContain('total_size_before=');
    runs.push({ ...run, peak: Math.max(run.after, run.peak ?? 0) - run.before + run.bufferPeak });
  }
  return runs;
}

const BASELINE = resolve('tests/fixtures/usd-stage-post.df9f64a8.ts.txt');
const CURRENT = resolve('src/core/usd/usd-stage-post.ts');
function comparePeak(label: string, input: string, inputPath: string, optionsPath: string): void {
  const bytes = Buffer.byteLength(input);
  const before = measure(BASELINE, inputPath, optionsPath);
  const after = measure(CURRENT, inputPath, optionsPath, 'chunks');
  for (const run of [...before, ...after]) {
    expect(run.digest).toBe(before[0].digest); expect(run.unmatched).toEqual([]);
  }
  const oldPeak = Math.max(...before.map((r) => r.peak!)), newPeak = Math.max(...after.map((r) => r.peak!));
  console.log(`[usd-post-memory] ${label}: input=${bytes} B; before=${(oldPeak / bytes).toFixed(2)}x; after=${(newPeak / bytes).toFixed(2)}x (${newPeak} B); 3 GC-separated runs, maximum heap + buffer growth`);
  expect(newPeak).toBeLessThanOrEqual(4 * bytes);
}

describe('USD post-pass full-duration memory regression', () => {
  it('matches ba0c6f3d byte-for-byte on real exporter output and stays below 4x input bytes', async () => {
    const scene = new Scene(), tracks: KeyframeTrack[] = [];
    // Three real animated prims, every TRS channel, full 600 s @30 fps.
    // No synthetic repeated text: the installed exporter produces the payload.
    for (let i = 0; i < 3; i++) {
      const node = new Object3D(); node.name = `_rvN${i}`; scene.add(node);
      const times = Float32Array.from({ length: 18001 }, (_, frame) => frame / 30);
      const position = new Float32Array(times.length * 3), orient = new Float32Array(times.length * 4), scale = new Float32Array(times.length * 3);
      for (let frame = 0; frame < times.length; frame++) {
        const angle = frame / 1800;
        position.set([7 + i + frame / 1000, 8 + Math.sin(angle), 9 + Math.cos(angle)], frame * 3);
        orient.set([0, Math.sin(angle / 2), 0, Math.cos(angle / 2)], frame * 4);
        scale.set([1 + frame / 18000, 2 + Math.sin(angle) / 4, 3 + Math.cos(angle) / 4], frame * 3);
      }
      tracks.push(new VectorKeyframeTrack(`${node.uuid}.position`, times, position));
      tracks.push(new QuaternionKeyframeTrack(`${node.uuid}.quaternion`, times, orient));
      tracks.push(new VectorKeyframeTrack(`${node.uuid}.scale`, times, scale));
    }
    const archive = await new USDZExporter().parseAsync(scene, { animations: [new AnimationClip('full-duration', 600, tracks)], animationFrameRate: 30, includeAnchoringProperties: false });
    const input = strFromU8(unzipSync(new Uint8Array(archive))['model.usda']);
    const bytes = Buffer.byteLength(input);
    expect(bytes).toBeGreaterThan(6 * 1024 * 1024);
    expect(input).toContain('endTimeCode = 18000');
    const dir = mkdtempSync(join(tmpdir(), 'rv-usd-post-memory-'));
    try {
      const inputPath = join(dir, 'model.usda'), optionsPath = join(dir, 'options.json');
      writeFileSync(inputPath, input);
      writeFileSync(optionsPath, JSON.stringify({ finalNames: ['Axis', 'Material_42', 'Body'], prims: [
        [0, { customData: { address: '#root' }, visibilitySamples: [[0, 'invisible'], [15, 'inherited'], [18000, 'invisible']] }],
        [1, { customData: { address: 'p#Material_42', runtime: 'mu' } }], [2, { visibility: 'invisible' }],
      ] }));
      const before = measure(resolve('tests/fixtures/usd-stage-post.ba0c6f3d.ts.txt'), inputPath, optionsPath);
      const after = measure(resolve('src/core/usd/usd-stage-post.ts'), inputPath, optionsPath);
      for (const run of [...before, ...after]) {
        expect(run.digest).toBe(before[0].digest); expect(run.renamed).toBe(3); expect(run.unmatched).toEqual([]);
      }
      const oldPeak = Math.max(...before.map((r) => r.peak!)), newPeak = Math.max(...after.map((r) => r.peak!));
      console.log(`[usd-post-memory] input=${bytes} B; old peak growth=${oldPeak} B (${(oldPeak / bytes).toFixed(2)}x); new peak growth=${newPeak} B (${(newPeak / bytes).toFixed(2)}x); 3 runs each with explicit GC`);
      // Input is already resident. 4x allows the joined output (up to UTF-16),
      // temporary slices/header edits and runtime variation, but no per-number objects.
      expect(newPeak).toBeLessThanOrEqual(4 * bytes);
      const animationOptionsPath = join(dir, 'animation-options.json');
      writeFileSync(animationOptionsPath, JSON.stringify({ finalNames: ['Axis', 'Material_42', 'Body'],
        time: { endTimeCode: 18000, fps: 30 }, blenderVisibilityCompat: true, fixSubsetFamily: true,
        prims: [0, 1, 2].map((i) => [i, {
          translate: { defaultValue: Array.from(tracks[i * 3].values.slice(0, 3)),
            frames: Array.from({ length: 18001 }, (_, f) => f), values: Array.from(tracks[i * 3].values) },
          orient: { defaultValue: Array.from(tracks[i * 3 + 1].values.slice(0, 4)),
            frames: Array.from({ length: 18001 }, (_, f) => f), values: Array.from(tracks[i * 3 + 1].values) },
          scale: { defaultValue: Array.from(tracks[i * 3 + 2].values.slice(0, 3)),
            frames: Array.from({ length: 18001 }, (_, f) => f), values: Array.from(tracks[i * 3 + 2].values) },
          visibilitySamples: [[0, 'invisible'], [15, 'inherited'], [18000, 'invisible']],
        }]),
      }));
      comparePeak('all TRS + visibility + time', input, inputPath, animationOptionsPath);
      const unicodeOptions = JSON.parse(readFileSync(animationOptionsPath, 'utf8'));
      unicodeOptions.prims.forEach(([i, data]: [number, Record<string, unknown>]) => { data.customData = { address: `工場/設備#部品_${i}_🚚` }; });
      const unicodePath = join(dir, 'unicode-options.json');
      writeFileSync(unicodePath, JSON.stringify(unicodeOptions));
      comparePeak('all TRS / Unicode addresses', input, inputPath, unicodePath);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 120000);

  for (const unicode of [false, true]) it(`translation-only hall, 600 s, Unicode addresses ${unicode}`, async () => {
    const scene = new Scene(), tracks: KeyframeTrack[] = [], prims = [];
    const frames = Array.from({ length: 18001 }, (_, f) => f);
    const times = Float32Array.from(frames, (f) => f / 30);
    const names = Array.from({ length: 9 }, (_, i) => `Axis_${i}`);
    for (let i = 0; i < names.length; i++) {
      const node = new Object3D(); node.name = `_rvN${i}`; scene.add(node);
      const positions = new Float64Array(times.length * 3);
      for (const frame of frames) positions.set([1234.567891 + frame / 137.1234 + i,
        1499.987654 + Math.sin(frame / 711) * 100, -1800.765432 + Math.cos(frame / 1221) * 50], frame * 3);
      tracks.push(new VectorKeyframeTrack(`${node.uuid}.position`, times, positions));
      prims.push([i, {
        customData: { address: unicode ? `工場/設備#部品_${i}_🚚` : `p#part_${i}` },
        translate: { defaultValue: [...positions.slice(0, 3)], frames, values: [...positions] },
      }]);
    }
    const archive = await new USDZExporter().parseAsync(scene, { animations: [new AnimationClip('hall', 600, tracks)], animationFrameRate: 30, includeAnchoringProperties: false });
    const input = strFromU8(unzipSync(new Uint8Array(archive))['model.usda']);
    const dir = mkdtempSync(join(tmpdir(), 'rv-usd-hall-memory-'));
    try {
      const inputPath = join(dir, 'model.usda'), optionsPath = join(dir, 'options.json');
      writeFileSync(inputPath, input); writeFileSync(optionsPath, JSON.stringify({ finalNames: names, prims, time: { endTimeCode: 18000, fps: 30 } }));
      comparePeak(unicode ? 'hall / Unicode addresses' : 'hall / ASCII addresses', input, inputPath, optionsPath);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 120000);
});
