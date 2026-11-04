// plan-659 clean-up — proof that the operator panel comes OUT OF THE DOCUMENT.
//
//   node spikes/659/panel-document-diag.mjs [--port 5659] [--headed]
//
// The panel used to be an object in the plugin with a React window of its own.
// It is now a `WebOperatorPanel` component inside the GLB, drawn by the
// viewer's own host — the same way the Laser Welding Assembly Station carries
// its panel. This asks the running viewer four things:
//
//   1. the viewer's `webOperatorPanels` host has exactly ONE entry, it names
//      the node of the MODEL it came from, and it has no config errors;
//   2. the plugin has no window of its own left;
//   3. the window is on screen with its devices (the legends are SVG text, so
//      they are read out of the SVG, not out of `innerText`);
//   4. it OPERATES: clicking DRIVE to "Off" stops the robot and clicking it
//      back to "Run" starts it — through the signals, like a hand.
//
// Writes `followup-panel-document.json` + `.png`.

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureSpikeDeps } from './ensure-deps.mjs';

ensureSpikeDeps();

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const PORT = Number(arg('port', '5659'));
const URL = `http://localhost:${PORT}/?projectUrl=/spike-659-duck/&doc=doc_rv_walker_659`;

const out = { url: URL, startedAt: new Date().toISOString() };
const browser = await chromium.launch({ headless: !process.argv.includes('--headed') });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

try {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('rv-terms-accepted', '1');
      localStorage.setItem('rv-welcome-dismissed', '1');
      localStorage.setItem('rv-auto-quality-applied', '1');
    } catch { /* ignore */ }
  });
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(
    () => !!window.__rvMuJoCo && window.__rvMuJoCo.report().status === 'running',
    { timeout: 180_000 },
  );
  // The auto-quality notice covers the canvas on a first visit in a headless
  // run; a human clicks it away once per device.
  try { await page.getByRole('button', { name: 'OK', exact: true }).click({ timeout: 5000 }); } catch { /* not shown */ }
  await page.waitForFunction(
    () => (window.__rvViewer.webOperatorPanels?.entries ?? []).length > 0,
    { timeout: 30_000 },
  );

  // 1 + 2 — where the panel comes from
  out.host = await page.evaluate(() => {
    const v = window.__rvViewer;
    const entries = v.webOperatorPanels?.entries ?? [];
    return {
      entries: entries.map((e) => ({
        nodePath: e.nodePath, panelId: e.panelId, title: e.title, dock: e.dock,
        errors: [...e.errors], signals: e.controller.signalNames.length,
        ready: e.controller.getSnapshot().ready,
      })),
      // Gone with the move: the plugin owned a controller and a React window.
      pluginHasOwnWindow: 'panelController' in (v.getPlugin('mujoco-locomotion') ?? {}),
      pluginPanelErrors: window.__rvMuJoCo.panelConfigErrors(),
    };
  });

  // 3 — on screen. The window is the paper whose title bar says "Robot"; its
  // device legends are SVG text, which `innerText` does not return.
  out.window = await page.evaluate(() => {
    const paper = [...document.querySelectorAll('[class*=MuiPaper]')]
      .find((e) => (e.innerText || '').split('\n')[0]?.trim() === 'Robot');
    if (!paper) return { found: false };
    const r = paper.getBoundingClientRect();
    return {
      found: true,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      svgLegends: [...paper.querySelectorAll('svg text')].map((t) => t.textContent.trim()).filter(Boolean),
      htmlText: (paper.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean),
      radios: paper.querySelectorAll('[role="radio"]').length,
      buttons: paper.querySelectorAll('button').length,
      sliders: paper.querySelectorAll('input[type="range"]').length,
    };
  });

  // 4 — it operates, through the real devices
  const drive = page.getByRole('radiogroup', { name: /^Drive/ });
  const read = () => page.evaluate(() => ({
    status: window.__rvMuJoCo.report().status,
    enable: window.__rvMuJoCo.signals().RobotEnable,
  }));
  out.operate = { before: await read() };
  await drive.getByRole('radio').first().click();
  await page.waitForTimeout(1000);
  out.operate.stopped = await read();
  await drive.getByRole('radio').last().click();
  await page.waitForTimeout(1000);
  out.operate.running = await read();

  await page.screenshot({ path: resolve(HERE, 'followup-panel-document.png') });

  const e0 = out.host.entries[0];
  out.ok = out.host.entries.length === 1
    && e0.nodePath.endsWith('/OperatorPanel')
    && e0.errors.length === 0
    && e0.ready === true
    && out.host.pluginHasOwnWindow === false
    && out.window.found === true
    && out.window.radios >= 4 && out.window.buttons >= 2 && out.window.sliders >= 2
    && out.operate.stopped.status === 'paused' && out.operate.stopped.enable === false
    && out.operate.running.status === 'running' && out.operate.running.enable === true;
} catch (e) {
  out.error = e instanceof Error ? `${e.message}\n${e.stack}` : String(e);
  out.ok = false;
} finally {
  out.consoleErrors = consoleErrors.slice(0, 20);
  await browser.close();
}

writeFileSync(resolve(HERE, 'followup-panel-document.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
