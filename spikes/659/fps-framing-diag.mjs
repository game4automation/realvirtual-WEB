// plan-659 follow-up — does the wider fixed-camera framing cost frame rate?
//
// The headless run rasterises on the CPU (SwiftShader), so the bill is fill
// rate: a camera 3.2 m back shows roughly three times the ground the 1.1 m
// close-up did. This measures the same scene, same simulation, at both
// distances, by moving the camera only.

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const URL = 'http://localhost:5659/?projectUrl=/spike-659-duck/&doc=doc_rv_walker_659';
const browser = await chromium.launch({
  headless: true,
  args: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.addInitScript(() => {
  try {
    localStorage.setItem('rv-terms-accepted', '1');
    localStorage.setItem('rv-welcome-dismissed', '1');
    localStorage.setItem('rv-auto-quality-applied', '1');
  } catch { /* ignore */ }
});
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__rvViewer, { timeout: 120_000 });
await page.waitForFunction(() => !!window.__rvMuJoCo && window.__rvMuJoCo.report().status === 'running', { timeout: 180_000 });
try { await page.getByRole('button', { name: 'OK', exact: true }).click({ timeout: 4000 }); } catch { /* ignore */ }

const out = await page.evaluate(async () => {
  const api = window.__rvMuJoCo; const v = window.__rvViewer;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let trunk = null; v.scene.traverse((n) => { if (!trunk && n.userData?.rv_free_joint) trunk = n; });
  const V = trunk.position.constructor;
  const place = (dist) => {
    const t = trunk.getWorldPosition(new V());
    v.controls.target.copy(t);
    v.camera.position.set(t.x, t.y + dist * 0.55, t.z + dist * 0.84);
    v.camera.lookAt(t);
    v.controls.update?.();
  };
  const measure = async (dist, ms) => {
    api.setFollow(false);
    api.reset();
    await sleep(1500);
    place(dist);
    await sleep(2500);               // warm-up after the camera move
    const t = [];
    let last = performance.now();
    await new Promise((done) => {
      const t0 = last;
      const step = () => {
        const now = performance.now();
        t.push(now - last); last = now;
        if (now - t0 >= ms) { done(); return; }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    t.sort((a, b) => a - b);
    const med = t[Math.floor(t.length / 2)];
    return { distanceM: dist, frames: t.length, medianFrameMs: Number(med.toFixed(1)), fps: Number((1000 / med).toFixed(1)) };
  };
  const close = await measure(1.1, 8000);
  const wide = await measure(3.2, 8000);
  const closeAgain = await measure(1.1, 8000);   // guards against drift
  return { close, wide, closeAgain };
});

writeFileSync(resolve(HERE, 'followup-fps-framing.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out, null, 2));
await browser.close();
