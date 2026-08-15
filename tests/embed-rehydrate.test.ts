// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * embed-rehydrate.test.ts — plan-326 AP1 spike measurements (browser).
 *
 * 1. Headless boot: the production RVEmbedViewer facade loads a real GLB through
 *    the production scene loader and ticks the real engine (drives move,
 *    signals exist) WITHOUT RVViewer / React / plugins.
 * 2. Context-recycling rehydration: renderer disposed + context force-lost,
 *    then a fresh renderer re-binds the live scene and renders its first
 *    frame — the latency of that step is the AP1 metric for the < 1 s
 *    rehydration budget (plan 3.5 P.3). Runs N rounds, reports the median
 *    to the console for the Go/No-Go evidence.
 *
 * NOTE: headless Chromium renders via SwiftShader (software GL) — absolute
 * shader-compile/upload times are PESSIMISTIC vs. real GPUs.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { RVEmbedViewer } from '../src/embed/rv-embed-viewer';
import { DEV_GLB } from './fixtures/glb-paths.mjs';

const GLB_URL = DEV_GLB.tests;
const SMALL_GLB_URL = DEV_GLB.physicsZone;
const VIGNETTE_URL = '/embed/vignettes/conveyor-sensor.glb';

async function glbAvailable(url: string): Promise<boolean> {
  try {
    const head = await fetch(url, { method: 'HEAD' });
    return head.ok;
  } catch {
    return false;
  }
}

async function pickModelUrl(): Promise<string | null> {
  if (await glbAvailable(GLB_URL)) return GLB_URL;
  if (await glbAvailable(SMALL_GLB_URL)) return SMALL_GLB_URL;
  return null;
}

let viewer: RVEmbedViewer | null = null;

afterEach(() => {
  viewer?.dispose();
  viewer = null;
});

describe('rv-embed spike (plan-326 AP1)', () => {
  it('boots the real engine headless: components constructed, sim ticks, signals live', async () => {
    const url = await pickModelUrl();
    if (!url) {
      console.warn('[embed-spike] no test GLB served — skipping');
      return;
    }
    viewer = new RVEmbedViewer({ width: 320, height: 200 });
    const result = await viewer.loadModel(url);

    // Real component construction through the production loader:
    expect(result.signalStore).toBeTruthy();
    expect(result.transportManager).toBeTruthy();
    expect(result.drives.length).toBeGreaterThan(0);
    expect(viewer.signalStore).toBe(result.signalStore);

    // Tick the fixed-step pipeline manually (no RAF): a jogging drive moves.
    const drive = result.drives.find((d) => !d.isTransportSurface) ?? result.drives[0];
    const before = drive.currentPosition;
    if (drive.targetSpeed <= 0) drive.targetSpeed = 100; // guard: authored TargetSpeed may be 0
    drive.jogForward = true;
    for (let i = 0; i < 60; i++) viewer.step(1 / 60);
    drive.jogForward = false;
    expect(drive.currentPosition).not.toBe(before);
  }, 240_000);

  it('measures context-recycling rehydration latency (suspend → resume, median of 5)', async () => {
    const url = await pickModelUrl();
    if (!url) {
      console.warn('[embed-spike] no test GLB served — skipping');
      return;
    }
    viewer = new RVEmbedViewer({ width: 640, height: 400 });
    await viewer.loadModel(url);
    // Warm first frame on the initial context (uploads + compiles once).
    viewer.step(1 / 60);

    const ROUNDS = 5;
    const samples: number[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      viewer.suspendContext();
      const { firstFrameMs } = viewer.resumeContext();
      samples.push(firstFrameMs);
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    console.log(
      `[embed-spike] rehydration samples (ms): ${samples.map((s) => s.toFixed(0)).join(', ')} — median ${median.toFixed(0)} ms`,
    );

    // Generous CI bound (SwiftShader) — the < 1 s product budget is assessed
    // in the AP1 report from the logged median, not enforced here.
    expect(median).toBeLessThan(15_000);
    // Engine survives recycling: sim still ticks on the fresh renderer.
    viewer.step(1 / 60);
  }, 240_000);

  it('runs the AP3 conveyor vignette standalone: source spawns, drives move, sensor switches', async () => {
    if (!await glbAvailable(VIGNETTE_URL)) {
      throw new Error(`AP3 vignette is not served: ${VIGNETTE_URL}`);
    }
    let directorError: string | null = null;
    viewer = new RVEmbedViewer({
      width: 640,
      height: 400,
      director: 'conveyor-loop',
      directorEvents: {
        error: (detail) => {
          directorError = detail.message;
        },
      },
    });
    const result = await viewer.loadModel(VIGNETTE_URL);

    expect(result.transportManager.sources).toHaveLength(1);
    expect(result.transportManager.sensors.length).toBeGreaterThanOrEqual(2);
    expect(result.drives).toHaveLength(4);
    expect(result.drives.every((drive) => drive.jogForward)).toBe(true);

    let sensorSwitched = false;
    const unsubscribe = result.signalStore.subscribe('EntryConveyorSensor', (value) => {
      if (value === true) sensorSwitched = true;
    });
    // Step render-free: this test asserts on simulation state, never on pixels.
    // Rendering all ~1200 frames would cost ~90 s inside dispose() under
    // headless SwiftShader (see step()'s note) and blow the afterEach budget.
    for (let index = 0; index < 12 * 60 && !sensorSwitched; index++) {
      viewer.step(1 / 60, { render: false });
    }
    // Advance beyond the complete 7.1-second sequence so every named director
    // step executes and the loop starts its next iteration.
    for (let index = 0; index < 8 * 60; index++) {
      viewer.step(1 / 60, { render: false });
    }
    unsubscribe();
    // One real frame, so the render path is still exercised end to end.
    viewer.step(1 / 60);

    expect(result.transportManager.totalSpawned).toBeGreaterThan(0);
    expect(result.transportManager.mus.length).toBeGreaterThan(0);
    expect(result.drives.some((drive) => drive.currentPosition > 0)).toBe(true);
    expect(sensorSwitched).toBe(true);
    expect(directorError).toBeNull();
  }, 240_000);
});
