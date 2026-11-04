// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * demo-welcome.e2e.mjs — plan-646 F14 / §9: the public-demo welcome window against LOCALLY
 * BUILT artifacts, never against the CDN.
 *
 *   node tests/e2e/demo-welcome.e2e.mjs --demo-dist <dist of --demo --path demo> \
 *        --dev-dist <dist of --demo --path dev> [--port 0] [--shots <dir>]
 *
 * Both dists come from bunny-deploy's staging (`stageAndBuild`, no upload) with the bases
 * `/demo/` and `/dev/`; this script serves them on its own static server (a free port, never
 * 5173) and drives ONE Chromium:
 *
 *   demo  — fresh profile: the window and the welcome screen / Projects dashboard are never
 *           visible at the same time, the window follows once those are gone; ✕ closes,
 *           a reload opens it again, Escape closes; `?welcome=0` suppresses it.
 *   dev   — the window never appears and its marker is not in the DOM.
 *
 * `--shots <dir>` additionally writes desktop 1440 / phone 390 screenshots with the window open
 * and one with `?welcome=0`. Exit 0 = all checks green, 1 = a check failed, 2 = usage error.
 */

import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { chromium } from 'playwright';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain',
  '.woff2': 'font/woff2', '.hdr': 'application/octet-stream', '.ktx2': 'image/ktx2',
};
const DIALOG = '[data-testid="rv-demo-welcome"]';
const WELCOME_SCREEN = '#welcome-title';
const PROJECTS = '[data-testid="projects-header-subtitle"]';

function parseArgs(argv) {
  const out = { port: 0, shots: null, demoDist: null, devDist: null };
  for (let i = 0; i < argv.length; i++) {
    const [key, value] = [argv[i], argv[i + 1]];
    if (key === '--demo-dist') { out.demoDist = resolve(value); i++; }
    else if (key === '--dev-dist') { out.devDist = resolve(value); i++; }
    else if (key === '--port') { out.port = Number(value); i++; }
    else if (key === '--shots') { out.shots = resolve(value); i++; }
  }
  return out;
}

//! Serves `/demo/*` and `/dev/*` from the two dists, SPA fallback to index.html.
function startServer(roots, port) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const [, prefix, ...rest] = decodeURIComponent(url.pathname).split('/');
    const root = roots[prefix];
    if (!root) { res.writeHead(404).end(); return; }
    let file = normalize(join(root, ...rest));
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    if (!existsSync(file) || statSync(file).isDirectory()) {
      const index = join(file, 'index.html');
      if (existsSync(index)) file = index;
      else if (extname(file)) { res.writeHead(404).end(); return; }
      else file = join(root, 'index.html');
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolveListen) => server.listen(port, '127.0.0.1', () => resolveListen(server)));
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function visible(page, selector) {
  return page.locator(selector).first().isVisible().catch(() => false);
}

async function waitBooted(page, timeoutMs = 120_000) {
  await page.waitForFunction(() => !!window.viewer, undefined, { timeout: timeoutMs });
}

//! Polls for `ms`: records whether the window ever shared the screen with a higher startup dialog.
async function watchStartup(page, ms) {
  let overlap = false;
  let sawWindow = false;
  let sawHigher = false;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const [win, welcome, projects] = await Promise.all([visible(page, DIALOG), visible(page, WELCOME_SCREEN), visible(page, PROJECTS)]);
    if (win) sawWindow = true;
    if (welcome || projects) sawHigher = true;
    if (win && (welcome || projects)) overlap = true;
    if (sawWindow && !welcome && !projects) break;
    await page.waitForTimeout(100);
  }
  return { overlap, sawWindow, sawHigher };
}

//! Clears the higher-priority startup dialogs a fresh profile shows, checking for overlap each step.
async function clearHigherDialogs(page) {
  let overlap = false;
  let sawHigher = false;
  for (let round = 0; round < 6; round++) {
    const state = await watchStartup(page, 4_000);
    overlap ||= state.overlap;
    sawHigher ||= state.sawHigher;
    if (await visible(page, '[data-testid="welcome-dismiss"]')) {
      await page.getByTestId('welcome-dismiss').first().click().catch(() => {});
      continue;
    }
    if (await visible(page, PROJECTS)) {
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(500);
      if (await visible(page, PROJECTS)) break; // the dashboard is the page itself here — stop clearing
      continue;
    }
    if (await visible(page, '[data-testid="auto-quality-ok"]')) {
      await page.getByTestId('auto-quality-ok').first().click().catch(() => {});
      continue;
    }
    break;
  }
  return { overlap, sawHigher };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.demoDist || !args.devDist || !existsSync(join(args.demoDist, 'index.html')) || !existsSync(join(args.devDist, 'index.html'))) {
    console.error('usage: node tests/e2e/demo-welcome.e2e.mjs --demo-dist <dir> --dev-dist <dir> [--port 0] [--shots <dir>]');
    return 2;
  }
  const server = await startServer({ demo: args.demoDist, dev: args.devDist }, args.port);
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`[demo-welcome-e2e] serving ${base}/demo/ and ${base}/dev/`);
  const browser = await chromium.launch();
  try {
    // ── demo: fresh profile ────────────────────────────────────────────────
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(`${base}/demo/`, { waitUntil: 'domcontentloaded' });
    await waitBooted(page);
    const first = await clearHigherDialogs(page);
    check('demo: never on top of the welcome screen / Projects dashboard', !first.overlap,
      first.sawHigher ? 'a higher startup dialog was shown first and cleared' : 'no higher startup dialog was shown');
    await page.locator(DIALOG).waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {});
    check('demo: window opens on start', await visible(page, DIALOG));
    const role = await page.locator(DIALOG).getAttribute('role').catch(() => null);
    const label = await page.locator(DIALOG).evaluate((el) => document.getElementById(el.getAttribute('aria-labelledby') ?? '')?.textContent ?? '').catch(() => '');
    check('demo: labelled dialog', role === 'dialog' && label.includes('every feature is unlocked'), `${role} / ${label}`);
    if (args.shots) {
      mkdirSync(args.shots, { recursive: true });
      await page.screenshot({ path: join(args.shots, 'demo-welcome-desktop-1440.png') });
    }
    await page.locator(`${DIALOG} button[aria-label="Close"]`).click();
    await page.locator(DIALOG).waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
    check('demo: ✕ closes', !(await visible(page, DIALOG)));

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitBooted(page);
    await clearHigherDialogs(page);
    await page.locator(DIALOG).waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {});
    check('demo: reload opens it again (no seen flag)', await visible(page, DIALOG));
    await page.keyboard.press('Escape');
    await page.locator(DIALOG).waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
    check('demo: Escape closes', !(await visible(page, DIALOG)));

    await page.goto(`${base}/demo/?welcome=0`, { waitUntil: 'domcontentloaded' });
    await waitBooted(page);
    await clearHigherDialogs(page);
    await page.waitForTimeout(3_000);
    check('demo: ?welcome=0 suppresses it', !(await visible(page, DIALOG)) && (await page.locator(DIALOG).count()) === 0);
    if (args.shots) await page.screenshot({ path: join(args.shots, 'demo-welcome-suppressed-1440.png') });
    await context.close();

    // ── demo: phone width ──────────────────────────────────────────────────
    if (args.shots) {
      const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      const p = await phone.newPage();
      await p.goto(`${base}/demo/`, { waitUntil: 'domcontentloaded' });
      await waitBooted(p);
      await clearHigherDialogs(p);
      await p.locator(DIALOG).waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {});
      const box = await p.locator(DIALOG).boundingBox().catch(() => null);
      const scrollW = await p.evaluate(() => document.documentElement.scrollWidth);
      check('phone 390: window fits the viewport', !!box && box.x >= 0 && box.x + box.width <= 390 && scrollW <= 390,
        box ? `x=${Math.round(box.x)} w=${Math.round(box.width)} scrollWidth=${scrollW}` : 'not visible');
      await p.screenshot({ path: join(args.shots, 'demo-welcome-phone-390.png') });
      await phone.close();
    }

    // ── dev: the window never appears ──────────────────────────────────────
    const dev = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const d = await dev.newPage();
    await d.goto(`${base}/dev/`, { waitUntil: 'domcontentloaded' });
    await waitBooted(d);
    await clearHigherDialogs(d);
    await d.waitForTimeout(3_000);
    check('dev: window never appears', (await d.locator('[data-rv-demo-welcome]').count()) === 0);
    await dev.close();
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`[demo-welcome-e2e] ${results.length - failed.length}/${results.length} checks passed`);
  return failed.length ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }, (error) => { console.error(error); process.exitCode = 1; });
