// plan-659 follow-up — the proof shot: the robot walking in the fixed camera,
// with the small plate. Also captures the moment right after a push, which is
// the thing that was invisible before.

import { chromium } from 'playwright';
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

await page.waitForTimeout(12_000);                       // let it walk a stretch
await page.screenshot({ path: resolve(HERE, 'followup-walking.png') });

await page.evaluate(() => window.__rvMuJoCo.pushFall());  // shove it over
await page.waitForTimeout(900);
await page.screenshot({ path: resolve(HERE, 'followup-pushed.png') });
await page.waitForTimeout(3500);                          // and up again
await page.screenshot({ path: resolve(HERE, 'followup-recovered.png') });

console.log(JSON.stringify(await page.evaluate(() => window.__rvMuJoCo.report().state), null, 2));
await browser.close();
