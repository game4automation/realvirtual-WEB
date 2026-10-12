// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-731 Phase 5 (F7) — the boot manifest is preloaded, and only once.
 *
 * plan-598 Phase 2: the preload is no longer a STATIC tag in `index.html` — the
 * deploy writes the one matching tag per channel (scripts/_bunny-lib.mjs
 * `manifestPreloadFor`; demo: `demo-realvirtual/project.json`). The dev server
 * therefore serves NO manifest preload, and what stays pinned here is the part
 * that holds on every channel: the boot asks for the demo manifest exactly
 * ONCE (the early discovery and the project resolution share one request,
 * plan-598 F3) and Chrome reports no unused preload. The deploy-time tag itself
 * is pinned in tests/bunny-deploy.node.test.ts and e2e/hosted-preload.spec.ts.
 *
 * ── WHY THIS IS AN E2E AND NOT A UNIT TEST ──────────────────────────────────
 * A `<link rel="preload">` is a claim about a NETWORK TRACE, and nothing below
 * a real browser can check it. Asserting that the tag is in `index.html` would
 * assert the edit, not the effect — and the effect is precisely what is easy to
 * get wrong: a preload whose options do not match the later `fetch()` is not
 * merely useless, it downloads the file TWICE. Chrome reports that as a console
 * warning ("preload not used") and nothing else, so a silent regression here
 * costs a round trip on every single boot and shows up nowhere.
 *
 * The options must match `BundledBackend._fetchJson()`, which issues
 * `fetch(url, { cache: 'no-cache' })`:
 *   - `as="fetch"`   — without it Chrome discards the entry outright;
 *   - `crossorigin`  — a `fetch()` with no explicit `credentials` is
 *                      `same-origin`, i.e. the anonymous preload mode.
 *
 * ── EXPECTATION DAMPER (plan-731 5b) ────────────────────────────────────────
 * The gain is capped at ONE round trip and cannot be more. The start document
 * is not known until the manifest has been parsed (`main.ts`), so the chain
 * manifest → start document → GLB is strictly serial by data dependency; a
 * preload can start the first link earlier, never overlap it with the third.
 * This test therefore pins CORRECTNESS (one request, preload honoured), not a
 * duration — a wall-clock assertion in CI would be a flake generator.
 */

import { test, expect } from 'playwright/test';

test('the boot manifest is preloaded and fetched exactly once', async ({ page }) => {
  // Every request for the manifest, however it was issued. `?` tolerated: a
  // cache-buster would still be the same document.
  const manifestRequests: string[] = [];
  page.on('request', (req) => {
    const path = new URL(req.url()).pathname;
    if (path === '/demo-realvirtual/project.json') manifestRequests.push(req.url());
  });

  // Chrome's "preload not used" verdict arrives as a console warning and is the
  // only signal that the options mismatched.
  const preloadWarnings: string[] = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (/preload/i.test(text) && /not used|unused|ignored/i.test(text)) {
      preloadWarnings.push(text);
    }
  });

  // Armed before the navigation, so it covers the whole boot (see point 5).
  const bootErrors: string[] = [];
  page.on('pageerror', (err) => bootErrors.push(String(err)));

  await page.goto('/');
  await page.waitForSelector('canvas');

  // 1. plan-598: no STATIC manifest preload in the committed index.html — a
  //    wrong one ("preloaded but not used") is worse than none; the deploy
  //    injects the right one per channel.
  await expect(page.locator('link[rel="preload"][href$="project.json"]')).toHaveCount(0);

  // 2. It was actually USED. This is the assertion the whole file exists for:
  //    a mismatched preload produces a second request and this warning.
  expect(preloadWarnings, preloadWarnings.join('\n')).toEqual([]);

  // 3. And the boot really did want it — a preload for a file nobody fetches is
  //    a wasted request, which is the opposite failure.
  expect(manifestRequests.length).toBeGreaterThan(0);

  // 4. Exactly one transfer. Two would mean the preload missed and the fetch
  //    went to the network again — the doubled-download regression.
  expect(manifestRequests.length, `requests: ${manifestRequests.join(', ')}`).toBe(1);

  // 5. And the boot still WORKS — F4 for Phase 5: a performance change that
  //    alters the visible boot is not a performance change. The `waitForSelector`
  //    above is most of that evidence already; what it cannot see is a boot that
  //    reached the canvas and then threw, which is how a broken manifest read
  //    would present. The listener is armed before `goto`, so it sees the whole
  //    boot and not just the tail of it.
  expect(bootErrors, bootErrors.join(' | ')).toEqual([]);
});
