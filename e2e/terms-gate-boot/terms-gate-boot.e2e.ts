// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2209 §9.4(c) — the REAL boot (main.ts module start, init, model
 * resolution) of a demo build with `__RV_TERMS_GATE__ === 'demo'`, while
 * `localStorage` and `sessionStorage` throw on EVERY access, all the way to a
 * loaded model. createTestViewer cannot prove this: it skips main.ts, which is
 * where the unguarded storage reads were (SOL R1 #1, R2 #1).
 *
 * Needs a built demo bundle (RV_DEMO_NOTICE=1). Default folder `../dist-demo`
 * next to this repo; `RV_TERMS_BOOT_DIST` overrides it. Served by an own static
 * server on a free port — no dev server, nothing reused.
 *
 *   npm run e2e:terms-boot
 */

import { test, expect, type Page } from 'playwright/test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStaticServer, type StaticServer } from './_static-server';
import { criticalErrors } from '../_viewer-ready';

const DIST = resolve(process.env.RV_TERMS_BOOT_DIST ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist-demo'));
const DOC = 'doc_test-des-turntable-loop_1y3v7m0';
const SEARCH = `?doc=${DOC}&mode=des`;

interface Probe { denials: string[]; uncaught: string[]; unhandled: string[] }

let server: StaticServer;

test.beforeAll(async () => {
  // Fail, never skip: a missing or wrong bundle is a finding, not a green run.
  if (!existsSync(join(DIST, 'index.html'))) {
    throw new Error(`terms-boot: no built bundle at ${DIST} — build with RV_DEMO_NOTICE=1 or set RV_TERMS_BOOT_DIST`);
  }
  const assets = readdirSync(join(DIST, 'assets'));
  const hasGate = assets.some(f => f.endsWith('.js') && readFileSync(join(DIST, 'assets', f), 'utf8').includes('rv-terms-gate-root'));
  if (!hasGate) throw new Error(`terms-boot: ${DIST} carries no terms gate — not a demo build (RV_DEMO_NOTICE=1)?`);
  server = await startStaticServer(DIST);
});

test.afterAll(async () => { await server?.close(); });

/** What the page recorded: who touched storage (call sites), uncaught errors, unhandled rejections. */
async function probe(page: Page): Promise<Probe> {
  return page.evaluate(() => (window as unknown as { __rvProbe: Probe }).__rvProbe);
}

test('demo terms gate: throwing storage, accept, model loads, URL untouched', async ({ page }) => {
  // BEFORE any app script: storage throws on every access, webdriver reads false
  // (otherwise the gate's Playwright skip would make this test prove nothing).
  await page.addInitScript(() => {
    const p: Probe = { denials: [], uncaught: [], unhandled: [] };
    (window as unknown as { __rvProbe: Probe }).__rvProbe = p;
    const deny = () => {
      // Call site for the diagnosis — a DOMException carries no useful stack.
      if (p.denials.length < 200) p.denials.push(String(new Error('denied').stack).split('\n').slice(2, 5).join(' | '));
      throw new DOMException('storage denied by test', 'SecurityError');
    };
    for (const name of ['localStorage', 'sessionStorage']) {
      Object.defineProperty(window, name, { get: deny, configurable: true });
    }
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true });
    Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
    window.addEventListener('error', (e) => { p.uncaught.push(`${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`); });
    window.addEventListener('unhandledrejection', (e) => {
      const r = e.reason as { message?: string; stack?: string } | undefined;
      p.unhandled.push(String(r?.stack ?? r?.message ?? r));
    });
  });
  await page.route(/googletagmanager\.com|google-analytics\.com|analytics\.google\.com/, route => route.abort());

  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', err => pageErrors.push(err.message));
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  const diagnose = async (e: Error): Promise<never> => {
    const p = await probe(page).catch(() => undefined);
    throw new Error([
      e.message,
      `pageerror: ${JSON.stringify(pageErrors)}`,
      `console: ${JSON.stringify(consoleErrors)}`,
      `uncaught: ${JSON.stringify(p?.uncaught)}`,
      `unhandled: ${JSON.stringify(p?.unhandled, null, 1)}`,
      `storage call sites: ${JSON.stringify(p?.denials, null, 1)}`,
    ].join('\n'));
  };

  await page.goto(`${server.baseUrl}${SEARCH}`);

  // The test setup really holds inside the page.
  expect(await page.evaluate(() => {
    const throws = (f: () => unknown) => { try { f(); return false; } catch { return true; } };
    return {
      local: throws(() => window.localStorage), session: throws(() => window.sessionStorage),
      webdriver: navigator.webdriver,
    };
  })).toEqual({ local: true, session: true, webdriver: false });

  // (a) the gate blocks the boot: dialog up, no viewer yet.
  await expect(page.locator('#rv-terms-gate-root')).toBeAttached({ timeout: 30_000 }).catch(diagnose);
  const accept = page.getByTestId('rv-terms-gate-accept');
  await expect(accept).toBeVisible();
  await expect(accept).toHaveText('Accept and start demo');
  await expect(page.getByTestId('rv-terms-gate-link')).toHaveAttribute('href', 'https://realvirtual.io/en/terms/#part-b');
  expect(await page.evaluate(() => !!(window as unknown as { viewer?: unknown }).viewer)).toBe(false);
  const before = await page.evaluate(() => ({ search: location.search, hash: location.hash }));
  expect(before).toEqual({ search: SEARCH, hash: '' });

  await accept.click();
  await expect(page.getByTestId('rv-terms-gate')).toBeHidden({ timeout: 10_000 });

  // Analytics gate only when settings.json names a GA id; answer it if it shows.
  const analyticsAccept = page.getByRole('button', { name: 'Accept', exact: true });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await analyticsAccept.isVisible().catch(() => false)) { await analyticsAccept.click(); break; }
    if (await page.evaluate(() => !!(window as unknown as { viewer?: unknown }).viewer)) break;
    await page.waitForTimeout(250);
  }

  // (c) all the way to a loaded model — the app's own model-loaded condition
  // (e2e/_viewer-ready.ts), then the scene-ready promise.
  await page.waitForFunction(() => {
    const viewer = (window as unknown as { viewer?: { currentModelUrl?: string | null } }).viewer;
    return !!viewer?.currentModelUrl && !!document.getElementById('loading-overlay')?.classList.contains('hidden');
  }, undefined, { timeout: 120_000 }).catch(diagnose);
  await page.evaluate(() => (window as unknown as { viewer: { whenSceneReady(): Promise<void> } }).viewer.whenSceneReady());
  const modelUrl = await page.evaluate(() => (window as unknown as { viewer: { currentModelUrl: string } }).viewer.currentModelUrl);
  expect(modelUrl).toContain('.glb');

  // (b) the deep link survived the gate.
  expect(await page.evaluate(() => ({ search: location.search, hash: location.hash }))).toEqual(before);

  // No uncaught error, no unhandled rejection, no critical console error.
  const p = await probe(page);
  expect(pageErrors, 'pageerror').toEqual([]);
  expect(p.uncaught, 'uncaught').toEqual([]);
  expect(p.unhandled, 'unhandledrejection').toEqual([]);
  expect(consoleErrors.filter(e => /Uncaught|unhandled/i.test(e)), 'console: uncaught/unhandled').toEqual([]);
  const critical = criticalErrors(consoleErrors);
  if (critical.length) await diagnose(new Error(`console errors: ${critical.length}`));
});
