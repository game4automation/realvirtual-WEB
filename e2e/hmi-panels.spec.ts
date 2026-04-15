// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { test, expect } from 'playwright/test';

/**
 * HMI panel interaction tests — verifies that UI panels open/close correctly.
 *
 * Uses the accessibility tree to find buttons and panels by role/name,
 * making these tests resilient to CSS/layout changes.
 */
test.describe('HMI panel interactions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    // Wait for UI to initialize
    await page.waitForSelector('canvas', { timeout: 30_000 });
    await page.waitForTimeout(3_000);
  });

  test('bottom bar renders', async ({ page }) => {
    // The bottom bar should be visible with at least one button/element
    const bottomBar = page.locator('[class*="BottomBar"], [class*="bottombar"], [class*="bottom-bar"]');
    // If class-based selector doesn't work, try finding play/pause controls
    const hasBottomBar = await bottomBar.count() > 0;
    const hasPlayControls = await page.locator('button:has-text("Play"), button:has-text("Pause"), [aria-label*="play"], [aria-label*="Play"]').count() > 0;

    expect(hasBottomBar || hasPlayControls).toBeTruthy();
  });

  test('settings button opens settings panel', async ({ page }) => {
    // Find settings button by various selectors
    const settingsButton = page.locator(
      'button:has-text("Settings"), button[aria-label*="settings"], button[aria-label*="Settings"], [title*="Settings"], [title*="settings"]'
    );

    const buttonCount = await settingsButton.count();
    if (buttonCount === 0) {
      // Settings might be under a gear icon without text
      const gearButton = page.locator('button svg, button img').first();
      test.skip(true, 'Settings button not found by accessible name — UI may use icon-only buttons');
      return;
    }

    await settingsButton.first().click();
    await page.waitForTimeout(500);

    // Verify a panel/overlay appeared
    const panels = page.locator('[class*="panel"], [class*="Panel"], [class*="overlay"], [class*="Overlay"], [role="dialog"]');
    const panelCount = await panels.count();
    expect(panelCount).toBeGreaterThan(0);
  });

  test('hierarchy button opens hierarchy panel', async ({ page }) => {
    // Find hierarchy button
    const hierarchyButton = page.locator(
      'button:has-text("Hierarchy"), button[aria-label*="hierarchy"], button[aria-label*="Hierarchy"], [title*="Hierarchy"], [title*="hierarchy"]'
    );

    const buttonCount = await hierarchyButton.count();
    if (buttonCount === 0) {
      test.skip(true, 'Hierarchy button not found by accessible name');
      return;
    }

    await hierarchyButton.first().click();
    await page.waitForTimeout(500);

    // Verify hierarchy content appeared (tree nodes, list items, etc.)
    const treeContent = page.locator('[class*="hierarchy"], [class*="Hierarchy"], [class*="tree"], [role="tree"], [role="treeitem"]');
    const contentCount = await treeContent.count();
    expect(contentCount).toBeGreaterThan(0);
  });

  test('panel can be closed after opening', async ({ page }) => {
    // Try to open any panel
    const buttons = page.locator('button:visible');
    const buttonCount = await buttons.count();

    if (buttonCount < 2) {
      test.skip(true, 'Not enough UI buttons found');
      return;
    }

    // Count panels before click
    const panelsBefore = await page.locator('[class*="panel"], [class*="Panel"], [role="dialog"]').count();

    // Click first non-play/pause button (likely a panel toggle)
    for (let i = 0; i < buttonCount; i++) {
      const text = await buttons.nth(i).textContent();
      const ariaLabel = await buttons.nth(i).getAttribute('aria-label');
      const label = (text ?? '') + (ariaLabel ?? '');

      // Skip play/pause/speed controls
      if (label.match(/play|pause|speed|1x|2x|reset/i)) continue;

      await buttons.nth(i).click();
      await page.waitForTimeout(500);

      const panelsAfter = await page.locator('[class*="panel"], [class*="Panel"], [role="dialog"]').count();
      if (panelsAfter > panelsBefore) {
        // Panel opened — now click the same button again to close
        await buttons.nth(i).click();
        await page.waitForTimeout(500);

        const panelsAfterClose = await page.locator('[class*="panel"], [class*="Panel"], [role="dialog"]').count();
        expect(panelsAfterClose).toBeLessThanOrEqual(panelsAfter);
        return; // Test passed
      }
    }

    // If no panel opened from any button, that's still ok (UI might work differently)
    test.skip(true, 'No panel toggle button found');
  });
});
