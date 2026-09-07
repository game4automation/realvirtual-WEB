// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-465 §9.8 — CI smoke for the synthetic-line scenario.
 *
 * This test asserts that a large line BUILDS AND RUNS without errors. It makes
 * NO statement about scale, and it must not: headless Chromium renders through
 * SwiftShader, where frame times are a property of the software rasteriser
 * rather than of the viewer (§5.2). Frame numbers are therefore logged, never
 * asserted, and the run is graded on a functional criterion instead —
 * `mode=smoke`: parts are spawned, a sensor switches, simulated time advances
 * (SOL R2#5).
 *
 * The belt speed is deliberately high: under SwiftShader the whole page runs at
 * a small fraction of real time, and at 1 m/s no part would reach a sensor
 * inside the smoke window. 5 m/s keeps the functional criterion about the
 * SOFTWARE rather than about the CI machine's rasteriser.
 */

import { test, expect } from 'playwright/test';

interface SmokeResults {
  scenario?: string;
  mode?: string;
  pass: boolean;
  reason?: string;
  plan?: {
    valid: boolean;
    reason?: string;
    capacityMUs: number;
    spawnCapMUs: number;
    fillTimeS: number;
    sourceIntervalS: number;
    surfaces: number;
    sensors: number;
    pools: number;
  };
  probe?: {
    frameMs: { p50: number; p95: number; p99: number; max: number; count: number };
    stepMs: { p95: number; max: number; count: number };
    transportMs: { p95: number };
    lostSimSeconds: number;
    last?: { liveMUs: number; drawCalls: number; triangles: number; pools: number };
  };
  stationarity?: {
    reached: boolean;
    reason: string;
    spawnRate: number;
    sinkRate: number;
    liveMUs: number;
    sensorEverTriggered: boolean;
  };
}

test('perf: 2400-MU synthetic line builds and runs clean', async ({ page }) => {
  test.setTimeout(300_000);

  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });

  await page.goto(
    '/?perf&scenario=line&mode=smoke&mu=2400&duration=30&sensors=1&speed=5000&lanes=24&segments=9&seglen=5',
    { waitUntil: 'domcontentloaded' },
  );

  const handle = await page.waitForFunction(
    () => (window as unknown as { __PERF_RESULTS__?: unknown }).__PERF_RESULTS__,
    { timeout: 240_000, polling: 1000 },
  );
  const perf = await handle.jsonValue() as SmokeResults;

  console.log('\n=== Synthetic line smoke (plan-465) ===');
  console.log(`Plan: valid=${perf.plan?.valid} capacity=${perf.plan?.capacityMUs} `
    + `spawnCap=${perf.plan?.spawnCapMUs} fill=${perf.plan?.fillTimeS?.toFixed(1)}s `
    + `interval=${perf.plan?.sourceIntervalS?.toFixed(3)}s`);
  console.log(`Topology: ${perf.plan?.surfaces} surfaces, ${perf.plan?.sensors} sensors, ${perf.plan?.pools} pools`);
  if (perf.probe) {
    // Logged only — SwiftShader frame times are not a viewer measurement.
    console.log(`Frame p50/p95/p99/max: ${perf.probe.frameMs.p50.toFixed(1)} / `
      + `${perf.probe.frameMs.p95.toFixed(1)} / ${perf.probe.frameMs.p99.toFixed(1)} / `
      + `${perf.probe.frameMs.max.toFixed(1)} ms over ${perf.probe.frameMs.count} frames`);
    console.log(`Step p95 ${perf.probe.stepMs.p95.toFixed(2)} ms, transport p95 `
      + `${perf.probe.transportMs.p95.toFixed(2)} ms, lost sim ${perf.probe.lostSimSeconds.toFixed(2)} s`);
    console.log(`Live MUs ${perf.probe.last?.liveMUs}, draws ${perf.probe.last?.drawCalls}`);
  }
  console.log(`Stationarity: ${perf.stationarity?.reason}`);
  if (perf.reason) console.log(`Reason: ${perf.reason}`);

  const criticalErrors = errors.filter(
    (e) => !e.includes('favicon.ico') && !e.includes('net::ERR_')
      && !e.includes('ResizeObserver') && !e.includes('rvproject:')
      && !e.includes('409 (Conflict)'),
  );
  expect(criticalErrors).toEqual([]);

  // The configuration must be BUILDABLE — an invalid plan is a real regression
  // (it means capacity, spawn cap or gate arithmetic changed under us).
  expect(perf.scenario).toBe('line');
  expect(perf.plan?.valid).toBe(true);
  expect(perf.plan?.pools).toBeGreaterThan(0);

  // Functional criterion: the line actually ran.
  expect(perf.stationarity?.spawnRate).toBeGreaterThan(0);
  expect(perf.stationarity?.sensorEverTriggered).toBe(true);
  expect(perf.probe?.stepMs.count).toBeGreaterThan(0);   // simulated time advanced
  expect(perf.probe?.frameMs.count).toBeGreaterThan(0);
  expect(perf.pass).toBe(true);
});
