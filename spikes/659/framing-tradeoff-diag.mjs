// plan-659 follow-up — picking the fixed camera's distance.
//
// With the follow off, one number trades against another:
//   close  -> the robot is big and a push is dramatic, but it walks out of
//             frame within seconds and the demo is over;
//   far    -> it stays in frame for the whole parcours, but it is small and the
//             push shrinks with it.
// This measures BOTH at several distances: the on-screen displacement of a
// push, and how much of a 45 s walk the robot stays inside the viewport.

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
  const screenOf = () => {
    const p = trunk.getWorldPosition(new V());
    p.project(v.camera);
    return [(p.x * 0.5 + 0.5) * 1600, (-p.y * 0.5 + 0.5) * 1000];
  };
  // On-screen height of the robot, so "how big is it" is a number too.
  const robotPx = () => {
    const p0 = trunk.getWorldPosition(new V());
    const p1 = p0.clone(); p1.y += 0.25;             // the robot is 25 cm tall
    p0.project(v.camera); p1.project(v.camera);
    return Math.abs((p0.y - p1.y) * 0.5 * 1000);
  };
  const run = async (dist) => {
    api.setFollow(false); api.reset(); await sleep(1200);
    place(dist); await sleep(2800);
    const sizePx = Math.round(robotPx());
    // push visibility
    const s0 = screenOf();
    api.pushFall();
    let pushPx = 0;
    for (let i = 0; i < 40; i++) { await sleep(50); const s = screenOf(); pushPx = Math.max(pushPx, Math.hypot(s[0]-s0[0], s[1]-s0[1])); }
    // stays-in-frame over a long walk, from the same camera
    api.reset(); await sleep(1200); place(dist); await sleep(1500);
    let inFrame = 0; let total = 0; let leftAtS = null;
    const t0 = performance.now();
    while (performance.now() - t0 < 45_000) {
      await sleep(250);
      const [x, y] = screenOf();
      const ok = x > 60 && x < 1540 && y > 60 && y < 940;
      total++; if (ok) inFrame++; else if (leftAtS === null) leftAtS = Math.round((performance.now() - t0) / 1000);
    }
    return {
      distanceM: dist,
      robotHeightPx: sizePx,
      pushScreenPx: Math.round(pushPx),
      inFramePct: Math.round((inFrame / total) * 100),
      leftFrameAtS: leftAtS,
    };
  };
  return [await run(1.1), await run(2.2), await run(3.2)];
});

writeFileSync(resolve(HERE, 'followup-framing-tradeoff.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out, null, 2));
await browser.close();
