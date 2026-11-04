// plan-659 follow-up — does the plate's content FIT the box it starts in, and
// do the selector position marks still collide?
//
// Both were real defects found by looking at the rendered window rather than at
// the config: the bottom legend row was clipped, and "STOP"/"RUN" overlapped in
// a 54 px cell.

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
await page.waitForTimeout(2500);

const out = await page.evaluate(() => {
  const win = [...document.querySelectorAll('[data-ui-panel]')].find((p) => /robot/i.test(p.textContent || ''));
  const box = win.getBoundingClientRect();
  // The scroller the window puts around its content.
  const scrollers = [...win.querySelectorAll('*')].filter((e) => e.scrollHeight > e.clientHeight + 1);
  const grid = win.querySelector('[data-part="device-grid"]');
  const gridBox = grid.getBoundingClientRect();

  // Do any two position marks of a selector overlap horizontally?
  const collisions = [];
  for (const group of win.querySelectorAll('[role="radiogroup"]')) {
    const marks = [...group.querySelectorAll('[role="radio"]')].map((m) => ({
      text: m.textContent, box: m.getBoundingClientRect(),
    }));
    if (marks.length === 2) {
      const gap = Math.round(marks[1].box.left - marks[0].box.right);
      if (gap < 0) collisions.push({ group: group.getAttribute('aria-label'), marks: marks.map((m) => m.text), gapPx: gap });
    }
  }

  // Is anything clipped at the bottom of the window?
  const lastLegend = [...win.querySelectorAll('[data-part="legend"]')].pop();
  const lastBox = lastLegend?.getBoundingClientRect();
  const clippedPx = lastBox ? Math.round(lastBox.bottom - box.bottom) : null;

  return {
    width: Math.round(box.width),
    height: Math.round(box.height),
    gridBottomOverflowPx: Math.round(gridBox.bottom - box.bottom),
    scrollerOverflowPx: scrollers.map((e) => e.scrollHeight - e.clientHeight),
    lastLegendText: lastLegend?.textContent ?? null,
    lastLegendClippedPx: clippedPx,
    markCollisions: collisions,
    selectorLabels: [...win.querySelectorAll('[role="radiogroup"]')].map((g) => ({
      label: g.getAttribute('aria-label'),
      marks: [...g.querySelectorAll('[role="radio"]')].map((m) => m.textContent),
    })),
  };
});

await page.screenshot({ path: resolve(HERE, 'followup-panel-fit.png') });
try {
  const win = page.locator('[data-ui-panel]').filter({ hasText: 'Robot' }).first();
  await win.screenshot({ path: resolve(HERE, 'followup-panel-closeup.png') });
} catch { /* ignore */ }
writeFileSync(resolve(HERE, 'followup-panel-fit.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out, null, 2));
await browser.close();
