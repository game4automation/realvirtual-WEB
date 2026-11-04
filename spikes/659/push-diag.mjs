// plan-659 diagnostic — HOW HARD, and HOW LONG, is the push?
// 5 presses of the plate button at the dial's default. Per press: the strength
// carried by the signal, the edge count, the lateral velocity step of the base
// (finite difference against SIM time, so a wall-clock hiccup cannot fake it)
// and the duration the robot is actually down, in SIM seconds.
import { chromium } from 'playwright';

const PORT = 5659;
const URL = `http://localhost:${PORT}/?projectUrl=/spike-659-duck/&doc=doc_rv_walker_659`;
const PRESSES = Number((process.argv.includes('--n') && process.argv[process.argv.indexOf('--n')+1]) || 5);
const browser = await chromium.launch({ headless: true, args: ['--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('pageerror', (e) => console.log('PAGEERR', e.message));
await page.addInitScript(() => { try { localStorage.setItem('rv-terms-accepted','1'); localStorage.setItem('rv-welcome-dismissed','1'); localStorage.setItem('rv-auto-quality-applied','1'); } catch {} });
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__rvViewer, { timeout: 120000 });
await page.waitForFunction(() => !!window.__rvMuJoCo && window.__rvMuJoCo.report().status === 'running', { timeout: 180000 });
try { await page.getByRole('button', { name: 'OK', exact: true }).click({ timeout: 4000 }); } catch {}

const res = await page.evaluate(async (presses) => {
  const api = window.__rvMuJoCo;
  const st = () => api.report().state;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  const btn = [...document.querySelectorAll('button, [role="button"]')]
    .find((b) => /^\s*push\s*$/i.test(b.textContent || ''));
  for (let p = 0; p < presses; p++) {
    api.reset();
    await sleep(5000);                      // settle into a gait
    const trace = [];
    const pre = st();
    btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    btn.click();
    const diagBefore = api.pushDiag();
    for (let i = 0; i < 120; i++) {         // ~6 s of wall clock
      await sleep(50);
      const s = st();
      trace.push({ t: s.simTimeS, y: s.base[1], x: s.base[0], h: s.baseHeightM, fallen: s.fallen, pol: s.activePolicy });
    }
    // Lateral velocity step: the largest |dy/dt_sim| in the 0.3 s of sim right
    // after the press, against the same quantity in the 0.3 s before it.
    const t0 = trace[0].t;
    const vel = [];
    for (let i = 1; i < trace.length; i++) {
      const dt = trace[i].t - trace[i-1].t;
      if (dt > 1e-6) vel.push({ t: trace[i].t - t0, v: (trace[i].y - trace[i-1].y) / dt });
    }
    const early = vel.filter((v) => v.t <= 0.35).map((v) => Math.abs(v.v));
    const down = trace.filter((s) => s.fallen);
    const downFor = down.length ? down[down.length-1].t - down[0].t : 0;
    const minH = Math.min(...trace.map((s) => s.h));
    out.push({
      strengthSignal: api.signals().RobotPushStrength,
      edges: api.pushDiag().count - diagBefore.count + 1,
      lastStrength: api.pushDiag().lastStrength,
      peakLateralV: early.length ? Math.max(...early) : 0,
      downForSimS: Number(downFor.toFixed(2)),
      minHeightMm: Math.round(minH * 1000),
      fellAtAll: down.length > 0,
      recovered: trace[trace.length-1].h > 0.11,
      policyAfter: trace[trace.length-1].pol,
    });
  }
  return out;
}, PRESSES);

console.log('strength |edges| peakLatV |downFor| minH | fell | recov');
for (const r of res) console.log(`${r.strengthSignal.toFixed(2)}     |  ${r.edges}   | ${r.peakLateralV.toFixed(2)} m/s | ${r.downForSimS}s  | ${r.minHeightMm}mm | ${r.fellAtAll} | ${r.recovered}`);
const fell = res.filter((r) => r.fellAtAll).length;
const avgDown = res.reduce((a,r) => a + r.downForSimS, 0) / res.length;
console.log(`SUMMARY fell ${fell}/${res.length}, mean time down ${avgDown.toFixed(2)} s sim`);
await browser.close();
