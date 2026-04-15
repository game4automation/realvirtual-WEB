// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { test, expect } from 'playwright/test';

/**
 * Verify that the Sink consumes MUs after they travel through conveyors.
 * Waits up to 60s for at least 1 MU to be consumed.
 */
test('sink consumes MUs from conveyor end', async ({ page }) => {
  test.setTimeout(120_000);

  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas', { timeout: 30_000 });

  // Wait for model to load and simulation to start
  await page.waitForTimeout(5_000);

  // Poll transport stats until consumed > 0 or timeout
  let consumed = 0;
  let spawned = 0;
  let activeMUs = 0;
  const startTime = Date.now();
  const maxWait = 60_000; // 60 seconds for MU to traverse conveyors

  while (Date.now() - startTime < maxWait) {
    const response = await page.request.get('/__api/debug/transport');
    const transport = await response.json();
    spawned = transport.spawned ?? 0;
    consumed = transport.consumed ?? 0;
    activeMUs = transport.activeMUs ?? 0;

    console.log(`[${((Date.now() - startTime) / 1000).toFixed(1)}s] Spawned: ${spawned}, Consumed: ${consumed}, Active: ${activeMUs}`);

    if (consumed > 0) break;
    await page.waitForTimeout(2_000);
  }

  console.log(`\nFinal: Spawned=${spawned}, Consumed=${consumed}, Active=${activeMUs}`);

  // Check that at least something spawned
  expect(spawned).toBeGreaterThan(0);

  // The key assertion: sink should have consumed at least 1 MU
  expect(consumed).toBeGreaterThan(0);

  // No critical errors
  const critical = errors.filter(
    e => !e.includes('favicon') && !e.includes('ResizeObserver') && !e.includes('net::ERR_'),
  );
  expect(critical).toHaveLength(0);
});
