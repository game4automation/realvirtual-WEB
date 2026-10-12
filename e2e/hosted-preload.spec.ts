// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-598 §9.6c (network half) — the deploy-time manifest preload of a HOSTED
 * deploy, as a real network trace from the first byte of the navigation.
 *
 * The dev server is made to look like a hosted deploy by routing: the page HTML
 * gets exactly the tag the deploy would inject (`withManifestPreload` /
 * `manifestPreloadFor` from scripts/_bunny-lib.mjs), `settings.json` names the
 * served project (`projectUrl: 'p/'`) and — for the password case — carries the
 * encryption probe, and `p/project.json` answers with a small manifest.
 *
 *   - Hosted WITHOUT password: exactly ONE request for `p/project.json` (the
 *     preload is consumed by the runtime's fetch) and no "preload not used".
 *   - Hosted WITH password: no preload is injected, and NOTHING project-related
 *     (`p/…`, any `project.json`, any `.glb`) is requested while the password
 *     overlay is up — even with a tracker configured, whose consent dialog must
 *     not cover the password overlay (it is not even mounted yet).
 */

import { test, expect, type Page } from 'playwright/test';
import { manifestPreloadFor, withManifestPreload } from '../scripts/_bunny-lib.mjs';
import {
  encryptGlb, bytesToBase64Url, randomBytes, FRAGMENT_BYTES, PROBE_PLAINTEXT, PROBE_INFO,
} from '../src/core/persistence/rv-crypto-utils';

const MANIFEST = {
  schemaVersion: 2,
  id: 'prj_hosted_598',
  name: 'Hosted 598',
  documents: [],
};

async function probeFor(password: string, fragment: Uint8Array): Promise<string> {
  const env = new Uint8Array(await encryptGlb(new TextEncoder().encode(PROBE_PLAINTEXT), password, fragment, {
    salt: randomBytes(16), iterations: 1000, hkdfInfo: PROBE_INFO,
  }));
  return Buffer.from(env).toString('base64');
}

/** Make the dev server answer like a hosted deploy. */
async function routeHosted(page: Page, { encrypted, probe }: { encrypted: boolean; probe?: string }) {
  // The page itself: what the deploy would publish.
  await page.route((url) => url.pathname === '/' || url.pathname === '/index.html', async (route) => {
    const response = await route.fetch();
    const html = await response.text();
    await route.fulfill({
      response,
      body: withManifestPreload(html, manifestPreloadFor({ kind: 'hosted', encrypted })),
      headers: { ...response.headers(), 'content-type': 'text/html' },
    });
  });
  await page.route((url) => url.pathname === '/settings.json', async (route) => {
    const response = await route.fetch();
    const base = response.ok() ? await response.json().catch(() => ({})) : {};
    const settings = {
      ...base,
      projectUrl: 'p/',
      // A tracker is configured: without plan-598's ordering its consent dialog
      // would be the first thing on screen.
      analytics: { googleAnalyticsId: 'G-E2E598' },
      ...(encrypted ? { encryption: { enabled: true, probe } } : {}),
    };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(settings) });
  });
  await page.route((url) => url.pathname === '/p/project.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MANIFEST) }));
  await page.route(/googletagmanager\.com|google-analytics\.com/, (route) => route.abort());
}

function trace(page: Page) {
  const requests: string[] = [];
  const preloadWarnings: string[] = [];
  page.on('request', (req) => requests.push(new URL(req.url()).pathname));
  page.on('console', (msg) => {
    const text = msg.text();
    if (/preload/i.test(text) && /not used|unused|ignored/i.test(text)) preloadWarnings.push(text);
  });
  return { requests, preloadWarnings };
}

test('hosted without password: p/project.json is preloaded and requested exactly once', async ({ page }) => {
  await routeHosted(page, { encrypted: false });
  const { requests, preloadWarnings } = trace(page);
  await page.goto('/?consent=decline');
  await expect(page.locator('link[rel="preload"][href="p/project.json"]')).toHaveCount(1);
  // The hosted boot resolves the served project (an empty one: the dashboard).
  await page.waitForFunction(() => !!(window as unknown as { viewer?: unknown }).viewer, null, { timeout: 45_000 });
  await page.waitForLoadState('load');
  // Chrome reports an unused preload ~3 s after load.
  await page.waitForTimeout(4_000);
  const manifestHits = requests.filter((p) => p === '/p/project.json');
  expect(manifestHits, requests.join('\n')).toHaveLength(1);
  expect(preloadWarnings, preloadWarnings.join('\n')).toEqual([]);
});

test('hosted WITH password: no project request (preloads included) and no consent dialog before the password', async ({ page }) => {
  const fragment = randomBytes(FRAGMENT_BYTES);
  const probe = await probeFor('geheim-598', fragment);
  await routeHosted(page, { encrypted: true, probe });
  const { requests } = trace(page);
  await page.goto(`/#k=${bytesToBase64Url(fragment)}`);
  await expect(page.locator('#rv-password-gate-root input')).toBeVisible({ timeout: 45_000 });
  // No injected preload on a password deploy.
  await expect(page.locator('link[rel="preload"][href$="project.json"]')).toHaveCount(0);
  // Give the boot every chance to leak something.
  await page.waitForTimeout(3_000);
  const projectish = requests.filter((p) => /^\/p\/|project\.json$|\.glb$/i.test(p));
  expect(projectish, projectish.join('\n')).toEqual([]);
  // Password first: the consent dialog is not on screen (not even mounted).
  await expect(page.locator('#rv-consent-gate-root')).toHaveCount(0);
});
