// plan-659 spike — Phase 2 browser smoke. The acceptance of the phase, run.
//
//   node spikes/659/browser-smoke.mjs [--sim 60] [--port 5659] [--headed]
//
// It does, in this order and for a reason:
//   1. open demo.html WITHOUT autostart and prove the lazy-load claim from the
//      NETWORK log: no mujoco.wasm, no ort-*.wasm, and in particular no
//      `jsep` binary at any point (finding M10);
//   2. activate, i.e. import the two libraries, compile the MJCF and build both
//      ONNX sessions;
//   3. run the parity self-test of the browser chain against the Phase-0
//      fixtures — the question Phase 1 left open;
//   4. walk for `--sim` seconds of SIMULATED time at vx = 0.25 m/s (the value
//      Phase 0 measured; at 0.2 the duck does not start a gait) and record
//      real-time factor, policy latency, per-frame cost and droppedSimTime;
//   5. take the screenshot;
//   6. trip a physics step on purpose and prove the page survives the fail-off.
//
// Everything it measures lands in `phase2-report.json` next to this file.

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const SIM_SECONDS = Number(arg('sim', '60'));
const PORT = Number(arg('port', '5659'));
const HEADED = process.argv.includes('--headed');
const VX = Number(arg('vx', '0.25'));
const URL_BASE = `http://localhost:${PORT}/spikes/659/demo.html`;

const report = {
  startedAt: new Date().toISOString(),
  url: URL_BASE,
  simSecondsRequested: SIM_SECONDS,
  vx: VX,
};

const browser = await chromium.launch({
  headless: !HEADED,
  args: [
    // A headless tab that is treated as backgrounded throttles
    // requestAnimationFrame to 1 Hz, which would measure the throttle, not the
    // simulation.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const requests = [];
page.on('request', (r) => requests.push({ url: r.url(), at: Date.now() }));
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

const wasmHits = (list) =>
  list.filter((r) => /mujoco.*\.wasm|ort-wasm[^/]*\.wasm/i.test(r.url)).map((r) => r.url);

try {
  // ── 1. boot without activation ────────────────────────────────────────────
  await page.goto(URL_BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__rvDuck && window.__rvDuck.status === 'ready', {
    timeout: 120_000,
  });
  const beforeActivation = wasmHits(requests);
  report.lazyLoad = {
    wasmRequestsBeforeActivation: beforeActivation,
    passed: beforeActivation.length === 0,
  };
  report.jointsBound = await page.evaluate(() => window.__rvDuck.joints());

  // ── 2. activate ───────────────────────────────────────────────────────────
  const activateT0 = Date.now();
  await page.evaluate(() => window.__rvDuck.activate());
  await page.waitForFunction(
    () => ['running', 'error', 'failed'].includes(window.__rvDuck.status),
    { timeout: 300_000 },
  );
  report.activationMs = Date.now() - activateT0;
  const status = await page.evaluate(() => window.__rvDuck.status);
  if (status !== 'running') {
    report.error = await page.evaluate(() => window.__rvDuck.error);
    throw new Error(`activation ended in status '${status}': ${report.error}`);
  }
  const afterActivation = wasmHits(requests);
  report.lazyLoad.wasmRequestsAfterActivation = afterActivation;
  report.lazyLoad.jsepRequested = afterActivation.some((u) => /jsep/i.test(u));

  // Sizes of what was actually fetched, straight from the resource timings.
  report.wasmTransfer = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .filter((e) => /\.wasm($|\?)/i.test(e.name))
      .map((e) => ({
        url: e.name,
        transferSize: e.transferSize,
        encodedBodySize: e.encodedBodySize,
        decodedBodySize: e.decodedBodySize,
        durationMs: Math.round(e.duration),
      })),
  );

  // ── 3. parity of the browser chain ────────────────────────────────────────
  report.parity = await page.evaluate(() => window.__rvDuck.parity());

  // ── 4. the run ────────────────────────────────────────────────────────────
  await page.evaluate((vx) => {
    window.__rvDuck.setVx(vx);
    window.__rvDuck.reset();
    window.__rvDuck.beginMeasurement();
  }, VX);

  const runT0 = Date.now();
  let last = 0;
  for (;;) {
    const m = await page.evaluate(() => window.__rvDuck.metrics());
    if (m.simTimeS - last >= 10) {
      last = m.simTimeS;
      process.stdout.write(
        `  sim ${m.simTimeS.toFixed(1)} s | rtf ${m.realTimeFactor.toFixed(2)} | ` +
          `dist ${m.duck.distanceM.toFixed(3)} m | h ${(m.duck.baseHeightM * 1000).toFixed(0)} mm | ` +
          `falls ${m.duck.fallCount} | dropped ${(m.droppedSimTimeS * 1000).toFixed(0)} ms\n`,
      );
    }
    if (m.status !== 'running') throw new Error(`run left 'running': ${m.status} — ${m.error}`);
    if (m.simTimeS >= SIM_SECONDS) break;
    if (Date.now() - runT0 > (SIM_SECONDS * 1000) * 4 + 120_000) {
      throw new Error(`run did not reach ${SIM_SECONDS} s of sim time in time`);
    }
    await page.waitForTimeout(1000);
  }
  report.run = await page.evaluate(() => window.__rvDuck.metrics());

  // ── 5. the picture ────────────────────────────────────────────────────────
  const shot = resolve(HERE, 'phase2-screenshot.png');
  mkdirSync(dirname(shot), { recursive: true });
  await page.screenshot({ path: shot });
  report.screenshot = shot;
  const shotHud = resolve(HERE, 'phase2-screenshot-closeup.png');
  // A second frame from a tighter viewport — the duck is 12 cm tall, so a
  // close-up is what actually shows whether it stands or sprawls.
  await page.setViewportSize({ width: 900, height: 700 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: shotHud });
  report.screenshotCloseup = shotHud;

  // ── 6. fall and recovery ──────────────────────────────────────────────────
  // Phase 1 measured the thresholds headless: this policy absorbs a 0.5 m/s
  // lateral push and falls at 1.0 m/s. The push here is deliberately harder
  // than the fall threshold, because what is being tested is the state machine
  // (debounced detection → stand session → back to walking), not the policy.
  await page.evaluate(() => {
    window.__rvDuck.reset();
  });
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.__rvDuck.push(1.5));
  const recoveryT0 = Date.now();
  let recovery = null;
  for (;;) {
    const m = await page.evaluate(() => window.__rvDuck.metrics());
    if (m.duck.fallCount > 0 && m.duck.recoveries > 0) {
      recovery = { ...m.duck, recovered: true };
      break;
    }
    if (Date.now() - recoveryT0 > 30_000) {
      recovery = { ...m.duck, recovered: false };
      break;
    }
    await page.waitForTimeout(500);
  }
  report.recovery = recovery;
  await page.screenshot({ path: resolve(HERE, "phase2-screenshot-recovery.png") });

  // ── 7. fail-off ───────────────────────────────────────────────────────────
  await page.evaluate(() => window.__rvDuck.failNextStep());
  await page.waitForFunction(() => window.__rvDuck.status === 'failed', { timeout: 20_000 });
  const aliveAfterFailure = await page.evaluate(async () => {
    const before = window.__rvDuck.metrics().fps;
    await new Promise((r) => setTimeout(r, 1200));
    const after = window.__rvDuck.metrics();
    return { fpsBefore: before, fpsAfter: after.fps, status: after.status, error: after.error };
  });
  report.failOff = { ...aliveAfterFailure, passed: aliveAfterFailure.fpsAfter > 5 };

  report.consoleErrors = consoleErrors;
  report.ok = true;
} catch (err) {
  report.ok = false;
  report.failure = String(err);
  report.consoleErrors = consoleErrors;
  try {
    await page.screenshot({ path: resolve(HERE, 'phase2-failure.png') });
  } catch {
    /* page may be gone */
  }
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync(resolve(HERE, 'phase2-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}

const r = report;
console.log('\n── plan-659 Phase 2 browser smoke ──────────────────────────────');
console.log(`ok                       : ${r.ok}`);
if (r.failure) console.log(`failure                  : ${r.failure}`);
if (r.run) {
  console.log(`sim time / wall clock    : ${r.run.simTimeS.toFixed(1)} s / ${r.run.wallClockS.toFixed(1)} s`);
  console.log(`real-time factor         : ${r.run.realTimeFactor.toFixed(3)}`);
  console.log(`distance                 : ${r.run.duck.distanceM.toFixed(3)} m (x ${r.run.duck.displacementXM.toFixed(3)} m)`);
  console.log(`falls / recoveries       : ${r.run.duck.fallCount} / ${r.run.duck.recoveries}`);
  console.log(`base height min / end    : ${(r.run.duck.baseHeightMinM * 1000).toFixed(1)} / ${(r.run.duck.baseHeightM * 1000).toFixed(1)} mm`);
  console.log(`policy latency med / p95 : ${r.run.policyLatencyMs.median.toFixed(3)} / ${r.run.policyLatencyMs.p95.toFixed(3)} ms`);
  console.log(`frame cost med / p95     : ${r.run.frameCostMs.median.toFixed(3)} / ${r.run.frameCostMs.p95.toFixed(3)} ms`);
  console.log(`dropped sim time         : ${(r.run.droppedSimTimeS * 1000).toFixed(1)} ms (stalls ${r.run.policyStalls})`);
  console.log(`fps                      : ${r.run.fps.toFixed(1)}`);
}
if (r.parity) {
  console.log(`parity obs / action      : ${r.parity.maxObsDelta.toExponential(3)} / ${r.parity.maxActionDelta.toExponential(3)}`);
}
if (r.lazyLoad) {
  console.log(`lazy-load clean          : ${r.lazyLoad.passed} (jsep requested: ${r.lazyLoad.jsepRequested})`);
}
if (r.recovery) {
  console.log(
    `fall + recovery          : falls ${r.recovery.fallCount}, recoveries ${r.recovery.recoveries}, ` +
      `recovered ${r.recovery.recovered}, policy now ${r.recovery.activePolicy}`,
  );
}
if (r.failOff) console.log(`fail-off survived        : ${r.failOff.passed}`);
if (r.screenshot) console.log(`screenshot               : ${r.screenshot}`);
console.log('────────────────────────────────────────────────────────────────');
