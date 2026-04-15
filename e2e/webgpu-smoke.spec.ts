// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { test, expect } from 'playwright/test';

// Smoke test: verify both WebGL and WebGPU modes boot without errors.
// Headless Chromium lacks real WebGPU → WebGPU mode falls back to WebGL backend.
// We still check that no JS errors occur and the "Ready" log appears.

for (const mode of ['webgl', 'webgpu'] as const) {
  test(`${mode}: viewer boots and loads demo scene without errors`, async ({ page }) => {
    const errors: string[] = [];
    const logs: string[] = [];

    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => {
      const text = msg.text();
      logs.push(`[${msg.type()}] ${text}`);
      if (msg.type() === 'error') errors.push(text);
    });

    const url = mode === 'webgpu' ? '/?renderer=webgpu' : '/';
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // Wait for "Ready" log (up to 30s for model load)
    await expect(async () => {
      const hasReady = logs.some((l) => l.includes('Ready'));
      expect(hasReady).toBe(true);
    }).toPass({ timeout: 30_000, intervals: [500] });

    // Wait a bit more for any deferred render errors
    await page.waitForTimeout(2000);

    // Filter out known non-critical warnings
    const criticalErrors = errors.filter(
      (e) =>
        !e.includes('favicon.ico') &&
        !e.includes('net::ERR_') &&
        !e.includes('ResizeObserver'),
    );

    console.log(`\n=== ${mode.toUpperCase()} Console Logs ===`);
    for (const l of logs) console.log(l);

    if (criticalErrors.length > 0) {
      console.log(`\n=== ${mode.toUpperCase()} Errors ===`);
      for (const e of criticalErrors) console.log(e);
    }

    expect(criticalErrors).toHaveLength(0);
  });
}
