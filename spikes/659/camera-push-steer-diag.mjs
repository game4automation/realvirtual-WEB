// plan-659 follow-up — the three measurements behind "Nachtrag: Kamera, Push, Steuerung".
//
//   node spikes/659/camera-push-steer-diag.mjs [--port 5659]
//
// 1. CAMERA STILLNESS. Per-frame camera displacement over 10 s of walking, in
//    three conditions: follow off (today's default), follow on (damped,
//    horizontal, dead zone) and — reconstructed from the same run — what the
//    OLD follow would have done, because it copied the trunk's world delta onto
//    the camera 1:1 on all three axes. The trunk delta IS the old camera delta.
// 2. PUSH VISIBILITY. On-screen displacement of the trunk over a push, follow
//    off versus follow on. This is the number that explains the whole report.
// 3. CAMERA-RELATIVE STEERING. Orbit the camera 180 degrees, hold W, and check
//    the robot walks AWAY from the camera in both orientations.
// 4. PANEL SIZE. The operator window's rendered box.

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const PORT = Number(arg('port', '5659'));
const URL = `http://localhost:${PORT}/?projectUrl=/spike-659-duck/&doc=doc_rv_walker_659`;
const report = { startedAt: new Date().toISOString(), url: URL };

const browser = await chromium.launch({
  headless: !process.argv.includes('--headed'),
  args: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.addInitScript(() => {
  try {
    localStorage.setItem('rv-terms-accepted', '1');
    localStorage.setItem('rv-welcome-dismissed', '1');
    localStorage.setItem('rv-auto-quality-applied', '1');
  } catch { /* ignore */ }
});

let ok = false;
try {
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__rvViewer, { timeout: 120_000 });
  await page.waitForFunction(() => !!window.__rvMuJoCo && window.__rvMuJoCo.report().status === 'running', { timeout: 180_000 });
  try { await page.getByRole('button', { name: 'OK', exact: true }).click({ timeout: 4000 }); } catch { /* not shown */ }

  // The default must BE off — that is the fix, not a thing the test switches on.
  report.followDefault = await page.evaluate(() => ({
    signal: window.__rvMuJoCo.signals().RobotCamFollow,
    plugin: window.__rvMuJoCo.camDiag(),
  }));

  // ── 1 + 2 ──────────────────────────────────────────────────────────────
  report.camera = await page.evaluate(async () => {
    const api = window.__rvMuJoCo; const v = window.__rvViewer;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let trunk = null;
    v.scene.traverse((n) => { if (!trunk && n.userData?.rv_free_joint) trunk = n; });
    const V = trunk.position.constructor;
    const std = (xs) => {
      if (xs.length < 2) return 0;
      const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
    };
    // Samples every animation frame for `ms`: camera position and trunk world
    // position. The trunk delta is what the OLD follow put on the camera.
    const sample = async (ms) => {
      const cam = []; const world = [];
      const t0 = performance.now();
      await new Promise((done) => {
        const step = () => {
          cam.push(v.camera.position.toArray());
          world.push(trunk.getWorldPosition(new V()).toArray());
          if (performance.now() - t0 >= ms) { done(); return; }
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      const d = (a) => a.slice(1).map((p, i) => Math.hypot(p[0] - a[i][0], p[1] - a[i][1], p[2] - a[i][2]));
      const dy = (a) => a.slice(1).map((p, i) => p[1] - a[i][1]);
      return {
        frames: cam.length,
        camStepStdMm: Number((std(d(cam)) * 1000).toFixed(3)),
        camStepMaxMm: Number((Math.max(0, ...d(cam)) * 1000).toFixed(3)),
        camYStdMm: Number((std(cam.map((p) => p[1])) * 1000).toFixed(3)),
        // The reconstruction of the old behaviour from the same run.
        oldCamStepStdMm: Number((std(d(world)) * 1000).toFixed(3)),
        oldCamStepMaxMm: Number((Math.max(0, ...d(world)) * 1000).toFixed(3)),
        oldCamYStdMm: Number((std(world.map((p) => p[1])) * 1000).toFixed(3)),
      };
    };
    const screenOf = () => {
      const p = trunk.getWorldPosition(new V());
      p.project(v.camera);
      return [(p.x * 0.5 + 0.5) * 1600, (-p.y * 0.5 + 0.5) * 1000];
    };
    const pushVisibility = async () => {
      api.reset(); await sleep(5000);
      const s0 = screenOf();
      api.pushFall();
      let maxPx = 0;
      for (let i = 0; i < 50; i++) {
        await sleep(50);
        const s = screenOf();
        maxPx = Math.max(maxPx, Math.hypot(s[0] - s0[0], s[1] - s0[1]));
      }
      return Math.round(maxPx);
    };

    // Condition A — the new default: follow OFF.
    api.setFollow(false); api.reset(); await sleep(4000);
    const off = await sample(10_000);
    const offPushPx = await pushVisibility();

    // Condition B — follow ON, the damped version.
    api.setFollow(true); api.reset(); await sleep(4000);
    const on = await sample(10_000);
    const onPushPx = await pushVisibility();

    api.setFollow(false);
    return {
      followOff: { ...off, pushScreenPx: offPushPx },
      followOnDamped: { ...on, pushScreenPx: onPushPx },
    };
  });

  // ── 3. camera-relative steering ────────────────────────────────────────
  report.steering = await page.evaluate(async () => {
    const api = window.__rvMuJoCo; const v = window.__rvViewer;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const base = () => api.report().state.base;
    // Orbit the camera to a given azimuth around the robot, keeping distance.
    const placeCamera = (deg) => {
      const t = v.controls.target;
      const r = 1.4; const a = (deg * Math.PI) / 180;
      v.camera.position.set(t.x + r * Math.sin(a), t.y + 0.7, t.z + r * Math.cos(a));
      v.camera.lookAt(t);
      v.controls.update?.();
    };
    // Hold W for `ms` and report the travel direction in the WORLD (MuJoCo xy).
    const holdW = async (ms) => {
      const p0 = base();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', bubbles: true }));
      await sleep(ms);
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'w', bubbles: true }));
      await sleep(300);
      const p1 = base();
      return [p1[0] - p0[0], p1[1] - p0[1]];
    };
    // The camera's own ground forward, converted into MuJoCo xy the way the
    // plugin does it, so "did it walk away from the camera" is checkable.
    const camForwardMujoco = () => {
      const V = v.camera.position.constructor;
      const f = new V().copy(v.controls.target).sub(v.camera.position);
      f.y = 0; f.normalize();
      let trunk = null; v.scene.traverse((n) => { if (!trunk && n.userData?.rv_free_joint) trunk = n; });
      const parent = trunk.parent;
      if (parent) {
        const q = parent.getWorldQuaternion(new v.camera.quaternion.constructor()).invert();
        f.applyQuaternion(q);
      }
      return [f.x, f.y];
    };
    const trial = async (deg) => {
      api.reset(); await sleep(3500);
      placeCamera(deg);
      await sleep(400);
      const fwd = camForwardMujoco();
      const moved = await holdW(6000);
      const len = Math.hypot(moved[0], moved[1]) || 1e-9;
      // cos of the angle between where the camera looks and where it walked.
      const cos = (fwd[0] * moved[0] + fwd[1] * moved[1]) / len;
      return { cameraAzimuthDeg: deg, travelM: Number(len.toFixed(3)), alignWithCameraForward: Number(cos.toFixed(3)) };
    };
    return { trials: [await trial(0), await trial(180), await trial(90)] };
  });

  // ── 4. panel size ──────────────────────────────────────────────────────
  report.panel = await page.evaluate(() => {
    const win = document.querySelector('[data-panel-id="robot-locomotion-panel"]')
      ?? [...document.querySelectorAll('*')].find((e) => e.getAttribute?.('data-panel-id') === 'robot-locomotion-panel');
    const grid = document.querySelector('[data-part="device-grid"]');
    const box = win?.getBoundingClientRect();
    return {
      found: !!win,
      width: box ? Math.round(box.width) : null,
      height: box ? Math.round(box.height) : null,
      devices: grid ? grid.querySelectorAll('[data-device]').length : null,
      cells: grid ? grid.querySelectorAll('[data-cell]').length : null,
      configErrors: window.__rvMuJoCo.panelConfigErrors(),
      stackLights: document.querySelectorAll('[data-device="stack-light"]').length,
    };
  });

  report.consoleErrors = errors;
  ok = true;
} finally {
  report.ok = ok;
  await page.screenshot({ path: resolve(HERE, 'followup-camera-push-steer.png') });
  writeFileSync(resolve(HERE, 'followup-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
console.log(JSON.stringify(report, null, 2));
