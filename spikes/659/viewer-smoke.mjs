// plan-659 Phase 2b — the acceptance, run IN THE REAL VIEWER (not on the spike page).
//
//   node spikes/659/viewer-smoke.mjs [--sim 60] [--port 5659] [--headed]
//
// It opens the demo DOCUMENT of the demo PROJECT through the normal viewer
// entry (`/?projectUrl=…&doc=…`), so everything a real scene brings is in the
// loop: the destructive bake, the node registry, the drive loop, the plugin
// system. In order:
//
//   1. lazy-load: nothing mujoco/ort is requested before the model declares
//      `rv_mujoco` (and the 26.8 MB `jsep` binary is never requested at all);
//   2. the plugin activates and binds 14 drives;
//   3. ADDRESSABILITY: every joint resolves by PATH in the NodeRegistry and
//      carries a Drive there — the thing the bake used to destroy;
//   4. a `--sim` second run: distance, falls, frame rate, dropped sim time;
//   5. screenshot + `phase2b-report.json`.
//
// WHAT COUNTS AS PASSED lives in `smoke-acceptance.mjs` — its own module so
// the criterion can be unit-tested instead of only ever being exercised by
// the 60 s run it decides. Short version: falling in the obstacle field is
// EXPECTED, getting stuck is the failure.

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureSpikeDeps } from './ensure-deps.mjs';
import { evaluateAcceptance } from './smoke-acceptance.mjs';

// The out-of-band mujoco/ORT packages are pruned by any `npm install --no-save`
// in either tree; restore them before the run instead of failing in the browser
// with a 404 on `/node_modules/@mujoco/mujoco/mujoco.wasm`. No-op when present.
ensureSpikeDeps();

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const SIM_SECONDS = Number(arg('sim', '60'));
const PORT = Number(arg('port', '5659'));
const HEADED = process.argv.includes('--headed');
const DOC = 'doc_rv_walker_659';
const URL = `http://localhost:${PORT}/?projectUrl=/spike-659-duck/&doc=${DOC}`;

const report = { startedAt: new Date().toISOString(), url: URL, simSecondsRequested: SIM_SECONDS };

const browser = await chromium.launch({
  headless: !HEADED,
  args: [
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

const requests = [];
page.on('request', (r) => requests.push(r.url()));
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

const wasmHits = (list) => list.filter((u) => /mujoco[^/]*\.wasm|ort-wasm[^/]*\.wasm/i.test(u));

let ok = false;
try {
  // ── 1. boot ───────────────────────────────────────────────────────────────
  // The beta/licence gate is a once-per-browser dialog (`rv-terms-accepted`).
  // A fresh Playwright profile always sees it and it covers the canvas, so the
  // screenshot would show the dialog instead of the robot. Seeding the key is
  // the same answer a human gives once by clicking "Accept & continue".
  // `rv-welcome-dismissed` is the same for the welcome pitch that opens on top
  // of it ("Got it"). Both are normal first-visit dialogs of the viewer — a
  // human clicks them away once per browser.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('rv-terms-accepted', '1');
      localStorage.setItem('rv-welcome-dismissed', '1');
      // The auto-quality notice ("Performance mode enabled") also covers the
      // canvas on a first visit; headless Chromium always triggers it (CPU
      // rasteriser). Same class of once-per-device dialog.
      localStorage.setItem('rv-auto-quality-applied', '1');
    } catch { /* ignore */ }
  });
  await page.goto(URL, { waitUntil: 'load' });
  // The viewer handle exists long before the model is baked; the plugin handle
  // appears only after activation.
  await page.waitForFunction(() => !!window.__rvViewer, { timeout: 120_000 });
  report.wasmBeforeModel = wasmHits(requests);

  await page.waitForFunction(
    () => !!window.__rvMuJoCo && window.__rvMuJoCo.report().status === 'running',
    { timeout: 180_000 },
  );
  report.activation = await page.evaluate(() => {
    const r = window.__rvMuJoCo.report();
    return { status: r.status, joints: r.joints, baseBound: r.baseBound, jointNames: r.jointNames };
  });
  const wasm = wasmHits(requests);
  report.lazyLoad = {
    requested: wasm,
    jsepRequested: wasm.some((u) => /jsep/i.test(u)),
    // Nothing may have been fetched before the model was there; after
    // activation exactly the two plain binaries.
    passed: wasm.length === 2 && !wasm.some((u) => /jsep/i.test(u)),
  };

  // The auto-quality notice ignores the storage seed in a headless run (the CPU
  // rasteriser is detected at boot), so it is clicked away like a human would.
  // It covers exactly the centre of the canvas — where the robot is.
  try {
    await page.getByRole('button', { name: 'OK', exact: true }).click({ timeout: 4000 });
  } catch { /* not shown — fine */ }

  // ── 3. addressability in the NodeRegistry ────────────────────────────────
  report.registry = await page.evaluate(() => {
    const viewer = window.__rvViewer;
    const registry = viewer.registry;
    const out = { joints: [], missing: [], driveCount: viewer.drives.length };
    for (const drive of viewer.drives) {
      const joint = drive.node?.userData?.rv_joint;
      if (!joint) continue;
      const path = registry.getPathForNode(drive.node);
      const byPath = path ? registry.getNode(path) : null;
      const compByPath = path ? registry.getByPath('Drive', path) : null;
      out.joints.push({
        name: joint.name ?? drive.node.name,
        path,
        resolvesByPath: byPath === drive.node,
        driveByPath: compByPath === drive,
        positionOverwrite: drive.positionOverwrite === true,
      });
    }
    out.joints.sort((a, b) => (a.path ?? '').localeCompare(b.path ?? ''));
    return out;
  });
  report.registry.allAddressable =
    report.registry.joints.length === 14
    && report.registry.joints.every((j) => j.resolvesByPath && j.driveByPath && j.positionOverwrite);

  // ── 4. the run ───────────────────────────────────────────────────────────
  const start = await page.evaluate(() => {
    const r = window.__rvMuJoCo.report();
    return { simTimeS: r.state.simTimeS, distanceM: r.state.distanceM, wall: performance.now() };
  });
  // Sample frame rate from the page itself (rAF), not from the driver.
  await page.evaluate(() => {
    window.__rvFrames = { n: 0, t0: performance.now(), last: performance.now(), dts: [] };
    const tick = () => {
      const now = performance.now();
      window.__rvFrames.dts.push(now - window.__rvFrames.last);
      window.__rvFrames.last = now;
      window.__rvFrames.n++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  const samples = [];
  const deadline = Date.now() + SIM_SECONDS * 1000 + 5000;
  while (Date.now() < deadline) {
    const s = await page.evaluate(() => {
      const r = window.__rvMuJoCo.report();
      return {
        sim: r.state.simTimeS, d: r.state.distanceM, h: r.state.baseHeightM, f: r.state.fallCount,
        // Where the base IS (MuJoCo ground plane) — what the stall detector
        // reads; `distanceM` is displacement from the start and says nothing
        // about a robot walking a curve.
        x: r.state.base[0], y: r.state.base[1],
        // How upright it was and which policy was driving — the two the stall
        // report is read with.
        gz: r.state.projectedGravityZ, policy: r.state.activePolicy,
      };
    });
    samples.push({ at: Date.now(), ...s });
    if (s.sim - start.simTimeS >= SIM_SECONDS) break;
    await page.waitForTimeout(1000);
  }

  const end = await page.evaluate(() => {
    const r = window.__rvMuJoCo.report();
    const dts = window.__rvFrames.dts.slice(1);
    const sorted = [...dts].sort((a, b) => a - b);
    const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? NaN;
    return {
      state: r.state,
      stats: { ...r.stats, latenciesMs: undefined },
      latencies: r.stats.latenciesMs.slice(-512),
      frames: {
        count: window.__rvFrames.n,
        wallS: (performance.now() - window.__rvFrames.t0) / 1000,
        medianFrameMs: pct(0.5),
        p95FrameMs: pct(0.95),
      },
      wall: performance.now(),
    };
  });

  const lat = [...end.latencies].sort((a, b) => a - b);
  const latPct = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] ?? NaN;
  report.run = {
    simSeconds: end.state.simTimeS - start.simTimeS,
    wallSeconds: (end.wall - start.wall) / 1000,
    realTimeFactor: (end.state.simTimeS - start.simTimeS) / ((end.wall - start.wall) / 1000),
    distanceM: end.state.distanceM - start.distanceM,
    falls: end.state.fallCount,
    recoveries: end.state.recoveries,
    baseHeightMinMm: end.state.baseHeightMinM * 1000,
    finite: end.state.finite,
    activePolicy: end.state.activePolicy,
    fps: end.frames.count / end.frames.wallS,
    medianFrameMs: end.frames.medianFrameMs,
    p95FrameMs: end.frames.p95FrameMs,
    droppedSimTimeS: end.stats.droppedSimTimeS,
    policySteps: end.stats.policySteps,
    policyStalls: end.stats.policyStalls,
    nonFiniteActions: end.stats.nonFiniteActions,
    policyLatencyMedianMs: latPct(0.5),
    policyLatencyP95Ms: latPct(0.95),
  };
  report.samples = samples;

  // ── 5. evidence ───────────────────────────────────────────────────────────
  const shot = resolve(HERE, 'phase2b-viewer.png');
  await page.screenshot({ path: shot });
  report.screenshot = shot;

  report.consoleErrors = consoleErrors;

  // ── 6. the verdict ───────────────────────────────────────────────────────
  const verdict = evaluateAcceptance(report.run, samples, {
    lazyLoad: report.lazyLoad, registry: report.registry,
  });
  report.stall = verdict.stall;
  report.acceptance = verdict.acceptance;
  ok = verdict.ok;
} catch (e) {
  report.error = e instanceof Error ? `${e.message}\n${e.stack}` : String(e);
  try { await page.screenshot({ path: resolve(HERE, 'phase2b-viewer-error.png') }); } catch { /* ignore */ }
  report.consoleErrors = consoleErrors;
} finally {
  await browser.close();
}

report.ok = ok;
report.finishedAt = new Date().toISOString();
writeFileSync(resolve(HERE, 'phase2b-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ok, run: report.run, registry: report.registry && {
  joints: report.registry.joints.length, allAddressable: report.registry.allAddressable,
}, lazyLoad: report.lazyLoad, stall: report.stall, acceptance: report.acceptance,
  error: report.error, consoleErrors: (report.consoleErrors ?? []).slice(0, 10) }, null, 2));
process.exit(ok ? 0 : 1);
