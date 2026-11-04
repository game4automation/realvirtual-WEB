// plan-659 follow-up — WHY is the robot plate taller in a used browser than
// the `height` in its config says?
//
// The config declares `width: 290`, `height: 288`, and `panel-fit-diag.mjs`
// measures exactly that — in a FRESH profile. Thomas sees a window roughly
// twice as tall with a large empty field under the tiles. This file measures
// both profiles side by side, because the difference between them IS the
// answer:
//
//   fresh   — no `rv-panel-geo:<panelId>` entry, so `defaultHeight` applies
//   used    — an entry from an EARLIER, larger version of the same panel id,
//             which FloatingPanel restores unconditionally (it only clamps
//             against MIN_H and the viewport, never against the config)
//
// A `resizable` window renders `height: size.h`; a content-high one renders
// `height: 'auto'` and cannot be affected by a stored height at all. That is
// the fix the numbers below argue for.

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const URL = 'http://localhost:5659/?projectUrl=/spike-659-duck/&doc=doc_rv_walker_659';
const PANEL_ID = 'robot-locomotion-panel';
/** What the FIRST version of this plate (330x470, six rows) left behind. */
const STALE = { x: 64, y: 120, w: 330, h: 470 };

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
});

async function measure(label, seedGeometry) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.addInitScript(([geo, panelId]) => {
    try {
      localStorage.setItem('rv-terms-accepted', '1');
      localStorage.setItem('rv-welcome-dismissed', '1');
      localStorage.setItem('rv-auto-quality-applied', '1');
      if (geo) localStorage.setItem(`rv-panel-geo:${panelId}`, JSON.stringify(geo));
    } catch { /* ignore */ }
  }, [seedGeometry, PANEL_ID]);
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__rvViewer, { timeout: 120_000 });
  await page.waitForFunction(() => !!window.__rvMuJoCo && window.__rvMuJoCo.report().status === 'running', { timeout: 180_000 });
  try { await page.getByRole('button', { name: 'OK', exact: true }).click({ timeout: 4000 }); } catch { /* ignore */ }
  await page.waitForTimeout(2500);

  const out = await page.evaluate(() => {
    const win = [...document.querySelectorAll('[data-ui-panel]')].find((p) => /robot/i.test(p.textContent || ''));
    if (!win) return { found: false };
    const box = win.getBoundingClientRect();
    const legend = win.querySelector('[data-part="key-legend"]');
    const last = legend ?? win.querySelector('[data-part="device-grid"]');
    return {
      found: true,
      cssHeight: getComputedStyle(win).height,
      windowHeightPx: Math.round(box.height),
      windowWidthPx: Math.round(box.width),
      // The gap between the last content row and the bottom of the window:
      // the "large empty field" in plain numbers.
      emptyBelowContentPx: last ? Math.round(box.bottom - last.getBoundingClientRect().bottom) : null,
      hasKeyLegend: !!legend,
      keyLegendRows: legend ? legend.querySelectorAll('[data-part="key-legend-row"]').length : 0,
      statusText: win.querySelector('[data-part="state-text"]')?.textContent ?? null,
    };
  });
  await page.screenshot({ path: resolve(HERE, `panel-height-${label}.png`) });
  try {
    const win = page.locator('[data-ui-panel]').filter({ hasText: 'Robot' }).first();
    await win.screenshot({ path: resolve(HERE, `panel-height-${label}-closeup.png`) });
  } catch { /* ignore */ }
  await page.close();
  return out;
}

const report = {
  staleGeometrySeed: STALE,
  fresh: await measure('fresh', null),
  used: await measure('used', STALE),
};
writeFileSync(resolve(HERE, 'followup-panel-height.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
await browser.close();
