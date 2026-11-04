// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
/**
 * logo-cell-soak-viewer.mjs - plan-2219 A2: logo cell stability in the REAL viewer.
 *
 * Starts its OWN Vite (free port 52NN, RV_VITE_OPEN=0, never a browser window, never CONNECT),
 * launches ONE headless Chromium, loads the cell GLB through the normal app path (smooth-motion
 * provider active, real SimulationLoop on requestAnimationFrame - NOT the test harness), and counts
 * scans/logos with the same definitions as the logo-cell model acceptance test (A1):
 *   - first scan = first Barcode_Ok of a box id, follow-up scan = every later one
 *   - forbidden loss = a logo vanishes / is marked for removal below y 0.78 m, not via LogoUnload
 *   - minimum volume = floor(T / 600 * 36) - 2 ; minimum follow-ups = max(1, minimum - distinct boxes)
 *     (one shared definition: scripts/lib/rv-logo-cell-acceptance.mjs, plan-2219 E14)
 * The viewer only runs in real time (fixed 1/60 s steps from rAF, no fast mode), so a run of T sim
 * seconds takes about T wall seconds (more under CPU throttling). Duration is measured in viewer.simTime.
 *
 * Usage:
 *   node scripts/logo-cell-soak-viewer.mjs --duration 300 --throttle 1
 *   node scripts/logo-cell-soak-viewer.mjs --duration 60 --shots <dir>   # also writes close-up screenshots
 * Options: --duration <sim s> (300) --throttle <CPU rate> (1) --port <n> (auto 5200-5299)
 *          --model <url path> (required, or env RV_CELL_MODEL; e.g. /private-assets/<project>/Cell.glb) --shots <dir> --keep-going
 * Output: one JSON line prefixed "CELL_SOAK_RESULT ". Exit 0 = pass, 1 = fail, 2 = run error.
 * PLAYWRIGHT_BROWSERS_PATH defaults to C:\ms-playwright when that folder exists.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cellMinimumFollowUps, cellMinimumVolume } from './lib/rv-logo-cell-acceptance.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const duration = Number(arg('duration', '300'));
const throttle = Number(arg('throttle', '1'));
const modelUrl = arg('model', process.env.RV_CELL_MODEL ?? '');
if (!modelUrl) { console.error('logo-cell-soak-viewer: --model <url path> or RV_CELL_MODEL is required'); process.exit(2); }
const shotsDir = arg('shots', '');
const wallLimitS = duration * (throttle > 1 ? 8 : 3) + 240;

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync('C:\\ms-playwright')) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = 'C:\\ms-playwright';
}
const { chromium } = await import('playwright');

function freePort(start) {
  return new Promise((ok, fail) => {
    const tryPort = (p) => {
      if (p > start + 99) return fail(new Error('no free port'));
      const s = createServer();
      s.once('error', () => tryPort(p + 1));
      s.once('listening', () => s.close(() => ok(p)));
      s.listen(p, '0.0.0.0');
    };
    tryPort(start);
  });
}

const port = Number(arg('port', '0')) || await freePort(5200);
const base = `http://localhost:${port}`;
const vite = spawn(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(port), '--strictPort'], {
  cwd: root, env: { ...process.env, RV_VITE_OPEN: '0' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
let viteLog = '';
vite.stdout.on('data', (d) => { viteLog += d; });
vite.stderr.on('data', (d) => { viteLog += d; });
let browser;
function stopOwn() {
  try { browser?.close().catch(() => {}); } catch { /* ignore */ }
  if (vite.pid) {
    // Own process tree only (the PID we spawned and its children).
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(vite.pid), '/T', '/F'], { stdio: 'ignore' });
    else { try { vite.kill('SIGTERM'); } catch { /* ignore */ } }
  }
}
process.on('exit', stopOwn);
process.on('SIGINT', () => { stopOwn(); process.exit(2); });

async function waitHttp(url, ms) {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(url); if (r.ok || r.status < 500) return; } catch { /* not up yet */ }
    if (Date.now() - t0 > ms) throw new Error(`vite not reachable at ${url} after ${ms} ms\n${viteLog.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

// In-page observer: installed on the viewer's POST tick, i.e. after every fixed step of the real loop.
function installObserver({ duration }) {
  const v = window.viewer;
  const tm = v.transportManager;
  const gate = tm.sensors.find((s) => s.node.name === 'LightGate_Scanning');
  const unload = tm.sinks.find((s) => s.node.name === 'LogoUnload');
  if (!gate) throw new Error('cell: scanning gate absent (expected LightGate_Scanning)');
  if (!unload) throw new Error('cell: logo sink absent (expected LogoUnload)');
  const THREE_POS = () => v.scene.position.clone(); // vector factory without importing three
  const isLogo = (mu) => !/^Box-/.test(mu.node.name) && /logo/i.test(mu.node.name);
  const S = window.__cellSoak = {
    done: false, startSim: v.simTime, endSim: 0, steps: 0, boxes: new Set(), firstScans: [], followUps: [],
    losses: [], error: null, logoMus: 0,
  };
  const lastPositions = new Map();
  const consumed = new Set();
  const lostIds = new Set();
  unload.subscribeConsumed((mu) => { consumed.add(mu.id); });
  const pos = (mu) => mu.getWorldPosition(THREE_POS());
  const remember = (mu) => { if (isLogo(mu)) lastPositions.set(mu.id, pos(mu)); };
  const checkLoss = (id, p) => {
    if (!consumed.has(id) && p.y < 0.78 && !lostIds.has(id)) {
      lostIds.add(id);
      S.losses.push({ id, x: +p.x.toFixed(4), y: +p.y.toFixed(4), z: +p.z.toFixed(4), simT: +(v.simTime - S.startSim).toFixed(2) });
    }
  };
  tm.addPhysicsMUHook({ onMUDisposed(accessor) { const mu = tm.mus.find((m) => m === accessor); if (mu) remember(mu); } });
  for (const mu of tm.mus) remember(mu);
  let previous = false;
  v._simLoop.onTick(2 /* TickStage.POST */, () => {
    if (S.done) return;
    try {
      S.steps++;
      const live = new Set();
      for (const mu of tm.mus) {
        if (!isLogo(mu)) continue;
        live.add(mu.id);
        remember(mu);
        if (mu.markedForRemoval) checkLoss(mu.id, lastPositions.get(mu.id));
      }
      for (const [id, p] of lastPositions) {
        if (live.has(id)) continue;
        checkLoss(id, p);
        lastPositions.delete(id);
        consumed.delete(id);
      }
      S.logoMus = live.size;
      const ok = v.signalStore?.get('Barcode_Ok') === true;
      if (ok && !previous) {
        const box = gate.occupiedMU;
        if (!box || !/^Box-/.test(box.node.name)) {
          S.error = `Barcode_Ok box ${box?.node.name ?? 'absent'} (expected Box-* in LightGate_Scanning)`;
        } else {
          box.aabb.update();
          const min = box.aabb.min, max = box.aabb.max;
          const loads = new Set();
          if ('loadedMus' in box) for (const mu of box.loadedMus) if (isLogo(mu)) loads.add(mu.id);
          for (const mu of tm.mus) {
            if (!isLogo(mu)) continue;
            const p = pos(mu);
            if (p.x >= min.x && p.x <= max.x && p.y >= min.y && p.y <= max.y && p.z >= min.z && p.z <= max.z) loads.add(mu.id);
          }
          const scan = { boxId: box.id, logos: loads.size, simT: +(v.simTime - S.startSim).toFixed(1) };
          (S.boxes.has(box.id) ? S.followUps : S.firstScans).push(scan);
          S.boxes.add(box.id);
        }
      }
      previous = ok;
      if (v.simTime - S.startSim >= duration) { S.done = true; S.endSim = v.simTime; }
    } catch (e) { S.error = String(e && e.stack || e); S.done = true; S.endSim = v.simTime; }
  });
}

let result;
let exitCode = 2;
try {
  await waitHttp(`${base}/`, 120_000);
  // Identity of the GLB actually served to the viewer.
  const glbResp = await fetch(`${base}${modelUrl}`);
  if (!glbResp.ok) throw new Error(`${modelUrl}: HTTP ${glbResp.status}`);
  const sha256 = createHash('sha256').update(Buffer.from(await glbResp.arrayBuffer())).digest('hex');

  browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: shotsDir ? { width: 1280, height: 720 } : { width: 640, height: 360 } });
  const page = await ctx.newPage();
  const consoleLines = [];
  page.on('console', (m) => { const t = m.text(); if (/\[Parity\]|error|warn/i.test(t) && consoleLines.length < 60) consoleLines.push(`${m.type()}: ${t.slice(0, 300)}`); });
  // Uncaught exceptions during the measured run fail the verdict (a throwing subsystem must not pass as stable).
  let measuring = false;
  const runPageErrors = [];
  page.on('pageerror', (e) => {
    if (consoleLines.length < 60) consoleLines.push(`pageerror: ${String(e).slice(0, 300)}`);
    if (measuring && runPageErrors.length < 20) runPageErrors.push(String(e && e.stack || e).slice(0, 500));
  });
  const cdp = await ctx.newCDPSession(page);
  if (throttle !== 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });

  await page.goto(`${base}/?model=${encodeURIComponent(modelUrl)}`, { waitUntil: 'domcontentloaded' });
  // A cold Vite re-optimises dependencies and reloads the page (state lost). Let it settle, then load fresh.
  const quiet = async (ms) => {
    let last = viteLog.length, since = Date.now();
    while (Date.now() - since < ms) {
      await new Promise((r) => setTimeout(r, 1000));
      if (viteLog.length !== last) { last = viteLog.length; since = Date.now(); }
    }
  };
  await page.waitForFunction(() => !!window.viewer, null, { timeout: 300_000 }).catch(() => {});
  await quiet(10_000);
  // Hold the real loop from the moment window.viewer is assigned, i.e. before the model starts loading.
  await page.addInitScript(() => {
    let v;
    Object.defineProperty(window, 'viewer', { configurable: true, get: () => v, set: (x) => { v = x; try { x.loop.setPaused('cell-soak', true); } catch { /* ignore */ } } });
  });
  await page.goto(`${base}/?model=${encodeURIComponent(modelUrl)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.viewer && !!window.viewer.transportManager, null, { timeout: 300_000 });
  await page.evaluate(() => window.viewer.whenSceneReady());
  const preSim = await page.evaluate(() => { window.viewer.loop.setPaused('cell-soak', true); return window.viewer.simTime; });
  // Same readiness as the A1 harness: PLC programs deployed, physics world built, smooth-motion provider ready.
  const ready = await page.evaluate(async () => {
    const v = window.viewer;
    const tm = v.transportManager;
    if (!tm.sensors.some((s) => s.node.name === 'LightGate_Scanning') || !tm.sinks.some((s) => s.node.name === 'LogoUnload')) throw new Error('gate or sink absent');
    const plc = v.getPlugin('plc');
    if (plc) await plc.whenProgramsReady();
    const pz = v.getPlugin('physics-zone');
    const t0 = performance.now();
    while (pz && !pz.active && performance.now() - t0 < 120000) {
      if (pz.buildPromise) await pz.buildPromise.catch(() => {});
      else await new Promise((r) => setTimeout(r, 100));
    }
    const sm = (await import('/src/core/engine/rv-smooth-motion-port.ts')).smoothMotionRegistry;
    return { plc: !!plc, physics: pz ? !!pz.active : null, smoothMotion: sm.state, smoothDetail: sm.failureDetail };
  });
  if (ready.smoothMotion !== 'ready') throw new Error('smooth-motion provider not ready: ' + JSON.stringify(ready));
  if (ready.physics === false) throw new Error('physics world not built: ' + JSON.stringify(ready));
  const info = await page.evaluate((preSim) => ({ preSim, ready: null,
    model: window.viewer.currentModelUrl ?? null,
    paused: window.viewer.loop.isPaused ?? null,
  }), preSim);
  info.ready = ready;
  measuring = true;
  await page.evaluate(installObserver, { duration });
  await page.evaluate(() => window.viewer.loop.setPaused('cell-soak', false));

  const wall0 = Date.now();
  let shotsTaken = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    const st = await page.evaluate(() => {
      const S = window.__cellSoak;
      return { done: S.done, sim: window.viewer.simTime - S.startSim, scans: S.firstScans.length + S.followUps.length, losses: S.losses.length, error: S.error };
    });
    if (shotsDir && shotsTaken < 6 && st.scans >= 2 + shotsTaken * 2) {
      mkdirSync(shotsDir, { recursive: true });
      await page.screenshot({ path: join(shotsDir, `soak-${Math.round(st.sim)}s.png`) });
      shotsTaken++;
    }
    if (st.done) break;
    if ((Date.now() - wall0) / 1000 > wallLimitS) { await page.evaluate(() => { window.__cellSoak.error = 'wall limit exceeded'; window.__cellSoak.done = true; window.__cellSoak.endSim = window.viewer.simTime; }); break; }
  }
  const S = await page.evaluate(() => {
    const s = window.__cellSoak;
    return { startSim: s.startSim, endSim: s.endSim, steps: s.steps, boxes: [...s.boxes], firstScans: s.firstScans, followUps: s.followUps, losses: s.losses, error: s.error };
  });
  const wallS = (Date.now() - wall0) / 1000;
  const minimumVolume = cellMinimumVolume(duration);
  const minimumFollowUps = cellMinimumFollowUps(minimumVolume, S.boxes.length);
  const total = S.firstScans.length + S.followUps.length;
  const withThree = S.followUps.filter((s) => s.logos === 3).length;
  const checks = {
    volume: total >= minimumVolume,
    followUps: S.followUps.length >= minimumFollowUps,
    allThree: withThree === S.followUps.length,
    noLoss: S.losses.length === 0,
    noError: !S.error,
    noPageError: runPageErrors.length === 0,
  };
  const parityLines = consoleLines.filter((l) => l.includes('[Parity]'));
  result = {
    sha256, modelUrl, durationSim: duration, throttle, simSeconds: +(S.endSim - S.startSim).toFixed(1), wallSeconds: +wallS.toFixed(1), fixedSteps: S.steps,
    scans: total, distinctBoxes: S.boxes.length, firstScans: S.firstScans.length, followUps: S.followUps.length,
    followUpsWith3: withThree, forbiddenLosses: S.losses, minimumVolume, minimumFollowUps,
    followUpLogos: S.followUps.map((s) => s.logos), firstScanLogos: S.firstScans.map((s) => s.logos),
    parityLines, error: S.error, pageErrors: runPageErrors, info, checks, pass: Object.values(checks).every(Boolean), consoleSample: consoleLines.slice(0, 10),
  };
  exitCode = result.pass ? 0 : 1;
} catch (e) {
  result = { error: String(e && e.stack || e), durationSim: duration, throttle, pass: false, viteTail: viteLog.slice(-800) };
  exitCode = 2;
} finally {
  stopOwn();
}
console.log(`CELL_SOAK_RESULT ${JSON.stringify(result)}`);
process.exit(exitCode);
