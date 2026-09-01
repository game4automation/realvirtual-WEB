// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-386 §9.7 — the shared link, end to end.
 *
 * The unit suites prove each piece: the fetch and its byte budget, the boot
 * branch and its precedence, the trust gates, the upload state machine against
 * a contract stub. What they cannot prove is the one thing a recipient
 * experiences — paste a URL into a browser, and the machine is there.
 *
 * The GLB is served from the dev server itself (`/models/…`). Same origin
 * sidesteps CORS, which is deliberate: CORS behaviour is measured against real
 * hosts and documented in doc-deploy.md, and an E2E that also depended on a
 * third party would fail for reasons that have nothing to do with this code.
 */

import { test, expect } from 'playwright/test';
import { DEV_GLB } from '../tests/fixtures/glb-paths.mjs';
import { DEV_ASSETS_SKIP_REASON, HAS_DEV_ASSETS } from './dev-assets';

/**
 * Derived from `baseURL` rather than hardcoded: the share fetch demands an
 * ABSOLUTE http(s) URL (the scheme whitelist runs before anything touches the
 * network), and hardcoding the port would tie the spec to one dev-server
 * configuration.
 */
function sharedGlbUrl(baseURL: string | undefined): string {
  return new URL(DEV_GLB.europalletEmpty, baseURL ?? 'http://localhost:5177').href;
}

function shareLink(baseURL: string | undefined): string {
  return `/?glb=${encodeURIComponent(sharedGlbUrl(baseURL))}`;
}

/** Wait until the viewer has actually put something on screen. */
async function waitForViewer(page: import('playwright/test').Page): Promise<void> {
  await page.waitForSelector('canvas', { timeout: 30_000 });
  await page.waitForTimeout(3_000);
}

test.describe('plan-386 §9.7 — shared GLB link', () => {
  // plan-395: the model is in the private Development project, so a public
  // checkout has nothing to load. Playwright reports this as `skipped`.
  test.skip(!HAS_DEV_ASSETS, DEV_ASSETS_SKIP_REASON);

  test('e2e_ShareLink_OpensInViewer', async ({ page, baseURL }) => {
    test.setTimeout(90_000);

    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto(shareLink(baseURL), { waitUntil: 'domcontentloaded' });
    await waitForViewer(page);

    // The card is the visible contract: it appears, and it names where the
    // bytes came from. The origin line is the security measure, so it is the
    // one thing asserted rather than the decoration around it.
    const card = page.locator('[data-testid="shared-glb-info-card"]');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-testid="shared-glb-origin"]'))
      .toContainText(new URL(sharedGlbUrl(baseURL)).host);
    await expect(page.locator('[data-testid="shared-glb-error"]')).toHaveCount(0);

    // Escalation is offered — Phase 3 wired it, and a card without it would be
    // a dead end for anyone who wants to work with what he was sent.
    await expect(page.locator('[data-testid="shared-glb-open-in-app"]')).toBeVisible();

    const critical = errors.filter(e =>
      !e.includes('favicon.ico') && !e.includes('net::ERR_')
      && !e.includes('ResizeObserver') && !e.includes('404'));
    expect(critical).toHaveLength(0);
  });

  test('e2e_ShareLink_UrlStableOnReloadAndBack', async ({ page, baseURL }) => {
    test.setTimeout(120_000);

    const shared = sharedGlbUrl(baseURL);
    await page.goto(shareLink(baseURL), { waitUntil: 'domcontentloaded' });
    await waitForViewer(page);

    // F18: the canonical URL stays `?glb=`. Anything that rewrote it — a
    // `?scene=` mutation, say — would make the link unbookmarkable and a reload
    // would land somewhere else entirely.
    const afterLoad = new URL(page.url());
    expect(afterLoad.searchParams.get('glb')).toBe(shared);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForViewer(page);
    expect(new URL(page.url()).searchParams.get('glb')).toBe(shared);
    await expect(page.locator('[data-testid="shared-glb-info-card"]')).toBeVisible({ timeout: 20_000 });

    // Navigate away and back: the shared state has to be reproducible from the
    // URL alone, because that is all the recipient was given.
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForViewer(page);
    await page.goBack({ waitUntil: 'domcontentloaded' });
    await waitForViewer(page);
    expect(new URL(page.url()).searchParams.get('glb')).toBe(shared);
  });

  /**
   * The sender's round trip needs a share backend, and the backend lives in
   * another repo (§2.6, R1). Faking it here — patching `window.fetch` from an
   * init script — would assert that Playwright can fill in a dialog, not that
   * the upload works: every rule worth testing (single-use signed URL, the
   * size/hash binding, cross-owner refusal, idempotent confirm, orphan sweep)
   * is enforced *by the server*, and a fake that answers 200 to everything
   * proves none of them.
   *
   * That surface is covered where it can be covered honestly:
   * `tests/rv-share-upload.test.ts` drives the shipped client against
   * `tests/helpers/rv-share-backend-stub.ts`, which runs the state machine for
   * real. Un-skip this once a deployed backend exists and point it at that.
   */
  test.skip('e2e_ShareFlow_UploadThenOpen', async () => {
    // Intentionally empty — see the comment above.
  });
});
