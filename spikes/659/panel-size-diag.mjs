// plan-659 follow-up — the operator window's start size, before and after.
//
//   node spikes/659/panel-size-diag.mjs [--port 5659]
//
// Measures the rendered box of the robot's operator window on a FRESH profile
// (a remembered geometry would hide the change), checks it is still not
// closable, and takes the proof shot.
//
// `resizeHandle` is now expected to be 0 and the drag block below is dead: the
// plate went back to content-high, because a `resizable` window restores its
// stored geometry over the config's `height` for ever
// (`panel-height-diag.mjs`). Kept as written so the number stays comparable
// with the earlier runs.

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const PORT = Number(arg('port', '5659'));
const URL = `http://localhost:${PORT}/?projectUrl=/spike-659-duck/&doc=doc_rv_walker_659`;

const browser = await chromium.launch({
  headless: !process.argv.includes('--headed'),
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
try { await page.getByRole('button', { name: 'OK', exact: true }).click({ timeout: 4000 }); } catch { /* not shown */ }
await page.waitForTimeout(2500);

const out = await page.evaluate(() => {
  const panels = [...document.querySelectorAll('[data-ui-panel]')];
  const win = panels.find((p) => /robot/i.test(p.textContent || ''));
  const box = win?.getBoundingClientRect();
  const grid = win?.querySelector('[data-part="device-grid"]');
  const titleButtons = win ? [...win.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') || b.title || b.textContent).filter(Boolean) : [];
  return {
    panelCount: panels.length,
    found: !!win,
    width: box ? Math.round(box.width) : null,
    height: box ? Math.round(box.height) : null,
    areaPx2: box ? Math.round(box.width * box.height) : null,
    gridRows: grid ? new Set([...grid.querySelectorAll('[data-cell]')].map((c) => c.getAttribute('data-cell').split(':')[0])).size : null,
    cells: grid ? grid.querySelectorAll('[data-cell]').length : null,
    sliders: win ? win.querySelectorAll('[data-device="setpoint-slider"]').length : null,
    readouts: win ? win.querySelectorAll('[data-device="digital-readout"]').length : null,
    stackLight: win ? win.querySelectorAll('[data-device="stack-light"]').length : null,
    statusText: win?.querySelector('[data-part="state-text"]')?.textContent ?? null,
    resizeHandle: win ? win.querySelectorAll('[data-resize-handle="true"]').length : 0,
    closable: titleButtons.some((t) => /close/i.test(t)),
    titleButtons,
    configErrors: window.__rvMuJoCo.panelConfigErrors(),
  };
});

// Still resizable: drag the handle and see the box grow.
if (out.resizeHandle > 0) {
  const handle = page.locator('[data-ui-panel] [data-resize-handle="true"]').last();
  const b = await handle.boundingBox();
  if (b) {
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + 150, b.y + 120, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    out.afterResize = await page.evaluate(() => {
      const win = [...document.querySelectorAll('[data-ui-panel]')].find((p) => /robot/i.test(p.textContent || ''));
      const box = win?.getBoundingClientRect();
      return box ? { width: Math.round(box.width), height: Math.round(box.height) } : null;
    });
  }
}

await page.screenshot({ path: resolve(HERE, 'followup-panel.png') });
const win = page.locator('[data-ui-panel]').filter({ hasText: 'Robot' }).first();
try { await win.screenshot({ path: resolve(HERE, 'followup-panel-closeup.png') }); } catch { /* ignore */ }
writeFileSync(resolve(HERE, 'followup-panel.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out, null, 2));
await browser.close();
