// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { expect, test } from 'playwright/test';

test('saves browser diagnostics JSON without CONNECT', async ({ page }) => {
  const downloadPromise = page.waitForEvent('download');
  await page.goto('/');
  await page.getByTitle('Settings').click();
  await page.getByRole('tab', { name: 'Help & diagnostics' }).click();
  await page.getByRole('button', { name: 'Save diagnostics…' }).click();
  await expect(page.getByTestId('diagnostics-counts')).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^rv-diagnostics-.*\.json$/);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  expect(payload).toHaveProperty('environment');
  expect(payload).toHaveProperty('entries');
});
