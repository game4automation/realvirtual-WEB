// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { expect, test } from 'playwright/test';

test.describe('rv-embed production artifact', () => {
  test('loads the Draco vignette, enforces mobile single-sim and disposes on SPA removal', async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 390, height: 844 });

    const decoderResponses: string[] = [];
    const workerUrls: string[] = [];
    page.on('worker', (worker) => workerUrls.push(worker.url()));
    page.on('response', (response) => {
      const url = response.url();
      if (url.includes('/draco/')) decoderResponses.push(url);
    });

    await page.goto('/test/index.html');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
    await expect(page.locator('rv-embed')).toHaveCount(2);
    await expect(page.locator('[data-check="bundle"]')).toHaveAttribute('data-state', 'ok');
    await expect(page.locator('[data-check="instances"]')).toContainText('2 / 2 ready', {
      timeout: 90_000,
    });
    await expect(page.locator('#errors')).toBeEmpty();

    expect(decoderResponses.some((url) => url.endsWith('/draco/draco_decoder.wasm'))).toBe(true);
    await expect.poll(async () => page.evaluate(() => (
      (window as typeof window & {
        __rvEmbedTest: { workers: string[] };
      }).__rvEmbedTest.workers.length
    ))).toBeGreaterThan(0);
    expect(workerUrls.length).toBeGreaterThan(0);

    const before = await page.evaluate(() => (
      (window as typeof window & {
        __rvEmbedTest: { viewers: Array<{ fixedTickCount: number }> };
      }).__rvEmbedTest.viewers.map((viewer) => viewer.fixedTickCount)
    ));
    await page.waitForTimeout(750);
    const after = await page.evaluate(() => (
      (window as typeof window & {
        __rvEmbedTest: { viewers: Array<{ fixedTickCount: number }> };
      }).__rvEmbedTest.viewers.map((viewer) => viewer.fixedTickCount)
    ));
    const advancing = after.filter((value, index) => value > before[index]);
    expect(advancing).toHaveLength(1);

    await page.evaluate(() => {
      document.querySelector('#vignettes')?.replaceChildren();
    });
    await expect.poll(async () => page.evaluate(() => (
      (window as typeof window & {
        __rvEmbedTest: { viewers: Array<{ isDisposed: boolean }> };
      }).__rvEmbedTest.viewers.every((viewer) => viewer.isDisposed)
    ))).toBe(true);

    const disposedTicks = await page.evaluate(() => (
      (window as typeof window & {
        __rvEmbedTest: { viewers: Array<{ fixedTickCount: number }> };
      }).__rvEmbedTest.viewers.map((viewer) => viewer.fixedTickCount)
    ));
    await page.waitForTimeout(300);
    const finalTicks = await page.evaluate(() => (
      (window as typeof window & {
        __rvEmbedTest: { viewers: Array<{ fixedTickCount: number }> };
      }).__rvEmbedTest.viewers.map((viewer) => viewer.fixedTickCount)
    ));
    expect(finalTicks).toEqual(disposedTicks);
  });
});
