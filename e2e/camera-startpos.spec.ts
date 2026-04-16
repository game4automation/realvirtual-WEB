// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { test, expect } from '@playwright/test';

test('save and restore camera start position across reload', async ({ page }) => {
  await page.goto('/?model=DemoRealvirtualWeb.glb');
  await page.waitForSelector('canvas');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500); // settle fit-to-bounds

  await page.getByRole('button', { name: /Settings/i }).click();
  await page.getByRole('tab', { name: /Start View/i }).click();
  await page.getByRole('button', { name: /Save current camera/i }).click();
  await expect(page.getByText(/Start view saved/i)).toBeVisible();

  // UI updates immediately (same-tab) — no reload needed
  await expect(page.getByText(/Saved \(user\)/i)).toBeVisible();

  const before = await page.evaluate(() => fetch('/__api/debug').then(r => r.json()));

  await page.reload();
  await page.waitForSelector('canvas');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000); // tween completes (clamped to 1.0s) + buffer

  const after = await page.evaluate(() => fetch('/__api/debug').then(r => r.json()));
  const dx = Math.abs(before.camera.position.x - after.camera.position.x);
  expect(dx).toBeLessThan(0.1);
});

test('Start View tab appears in Settings (EDIT 3)', async ({ page }) => {
  await page.goto('/?model=DemoRealvirtualWeb.glb');
  await page.waitForSelector('canvas');
  await page.getByRole('button', { name: /Settings/i }).click();
  await expect(page.getByRole('tab', { name: /Start View/i })).toBeVisible();
});
