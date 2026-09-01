// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { expect, test, type Locator, type Page } from 'playwright/test';

const embedSettings = {
  defaultModel: '',
  ui: { initialContexts: ['connect-embed'] },
  diagnostics: { diagnoseUrl: 'http://localhost:5100', notesUrl: 'http://localhost:5100' },
};

const SIGNAL_HINT_SEEN_KEY = 'rv-connect-embed-signal-hint-seen';
const PERSISTENCE_TEST_NAME = 'signal hint stays dismissed after reloading and restarting the demo';

test.beforeEach(async ({ page }, testInfo) => {
  await page.addInitScript(({ clearSignalHintSeenKey, signalHintSeenKey }) => {
    localStorage.setItem('rv-welcome-dismissed', '1');
    if (clearSignalHintSeenKey) localStorage.removeItem(signalHintSeenKey);
  }, {
    clearSignalHintSeenKey: testInfo.title !== PERSISTENCE_TEST_NAME,
    signalHintSeenKey: SIGNAL_HINT_SEEN_KEY,
  });
  await page.route('**/settings.json*', (route) => route.fulfill({ json: embedSettings }));
});

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function getBoundingBox(locator: Locator, label: string): Promise<Rect> {
  const bounds = await locator.boundingBox();
  expect(bounds, `${label} must have a bounding box`).not.toBeNull();
  return bounds!;
}

function boxesOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width
    && a.x + a.width > b.x
    && a.y < b.y + b.height
    && a.y + a.height > b.y;
}

/**
 * Wait until the demo is up. Since plan-373 the running demo has no chip and no
 * top-right close button, so the proof is that the gate is gone — not that an
 * overlay appeared. The hint is asserted separately because one test deliberately
 * runs with the hint already dismissed.
 */
async function waitForDemoRunning(page: Page) {
  await expect(page.getByTestId('connect-embed-gate')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByText('DEMO · Standalone')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Close scene' })).toHaveCount(0);
}

/** Open the Models panel from the activity bar (the only place to close the scene). */
async function openModelsPanel(page: Page): Promise<Locator> {
  await page.getByTestId('FolderOpenIcon').click();
  const row = page.getByText('DemoRealvirtualWeb', { exact: true });
  await expect(row).toBeVisible();
  return row;
}

async function startStandaloneDemo(page: Page, forceStart = false) {
  await page.goto('/');
  await expect(page.getByTestId('connect-embed-gate')).toBeVisible();
  await expect(page.getByTestId('connect-embed-start')).toBeVisible();
  await expect(page.locator('[data-testid="top-bar"]')).toHaveCount(0);

  const startButton = page.getByTestId('connect-embed-start');
  if (forceStart) await startButton.dispatchEvent('click');
  else await startButton.click();
  await waitForDemoRunning(page);
  await expect(page.getByTestId('connect-embed-signal-hint')).toContainText('Hold Shift');

  const autoQualityOk = page.getByTestId('auto-quality-ok');
  await autoQualityOk.waitFor({ state: 'visible', timeout: 2_000 }).catch(() => undefined);
  if (await autoQualityOk.isVisible()) {
    await autoQualityOk.click();
    await expect(autoQualityOk).toHaveCount(0);
  }
}

function getConnectPanel(page: Page): Locator {
  return page.locator('[data-ui-panel]').filter({
    has: page.getByText('realvirtual CONNECT', { exact: true }),
  }).first();
}

async function getKpiArea(page: Page): Promise<Locator> {
  const oeeKpi = page.getByText('OEE', { exact: true })
    .locator('xpath=ancestor::*[@data-ui-panel][1]');
  await expect(oeeKpi).toBeVisible();
  const kpiArea = oeeKpi.locator('xpath=..');
  await expect(kpiArea).toBeVisible();
  await expect(kpiArea.locator(':scope > [data-ui-panel]')).toHaveCount(4);
  return kpiArea;
}

async function expectDesktopHintLayout(page: Page, expectedPanelWidth: number) {
  const hint = page.getByTestId('connect-embed-signal-hint');
  const connectPanel = getConnectPanel(page);
  const kpiArea = await getKpiArea(page);

  await expect(connectPanel).toBeVisible();
  const hintBounds = await getBoundingBox(hint, 'signal hint');
  const connectPanelBounds = await getBoundingBox(connectPanel, 'CONNECT panel');
  const kpiBounds = await getBoundingBox(kpiArea, 'KPI area');

  expect(Math.round(connectPanelBounds.width)).toBe(expectedPanelWidth);
  expect(boxesOverlap(hintBounds, kpiBounds)).toBe(false);
  expect(hintBounds.x).toBeGreaterThanOrEqual(connectPanelBounds.x + connectPanelBounds.width);
}

test('minimal gate loads and closes the standalone CONNECT demo from the model row', async ({ page }) => {
  await startStandaloneDemo(page);
  await expectDesktopHintLayout(page, 360);

  // The close action lives where the user opened the scene — on the active row.
  const row = await openModelsPanel(page);
  await row.hover();
  await page.getByTestId('connect-embed-close-scene').click();

  await expect(page.getByTestId('connect-embed-gate')).toBeVisible();
  // The models panel stays open and the start info comes back (plan-373 F9).
  await expect(page.getByText('DemoRealvirtualWeb', { exact: true })).toBeVisible();
  await expect(page.getByTestId('connect-embed-start')).toBeVisible();

  await page.reload();
  await expect(page.getByTestId('connect-embed-start')).toBeVisible();
});

test('the demo row starts, closes and restarts the demo', async ({ page }) => {
  await startStandaloneDemo(page);

  const row = await openModelsPanel(page);
  await row.hover();
  await page.getByTestId('connect-embed-close-scene').click();
  await expect(page.getByTestId('connect-embed-gate')).toBeVisible();

  // Clicking the row itself runs the same state machine as the start button.
  await page.getByText('DemoRealvirtualWeb', { exact: true }).click();
  await waitForDemoRunning(page);
});

test('the row close action is keyboard reachable and carries an accessible name', async ({ page }) => {
  await startStandaloneDemo(page);
  await openModelsPanel(page);

  const close = page.getByTestId('connect-embed-close-scene');
  await expect(close).toHaveAttribute('aria-label', /Close DemoRealvirtualWeb/);

  await close.focus();
  await expect(close).toBeFocused();
  // Focus must reveal it exactly like hover does (WCAG 2.1.1).
  await expect(close).toHaveCSS('opacity', '1');

  await page.keyboard.press('Enter');
  await expect(page.getByTestId('connect-embed-gate')).toBeVisible();
});

test('on a coarse pointer the row close action is permanently visible and 44 px', async ({ browser }) => {
  const context = await browser.newContext({
    hasTouch: true,
    viewport: { width: 900, height: 800 },
  });
  const page = await context.newPage();
  await page.addInitScript((key) => {
    localStorage.setItem('rv-welcome-dismissed', '1');
    localStorage.removeItem(key);
  }, SIGNAL_HINT_SEEN_KEY);
  await page.route('**/settings.json*', (route) => route.fulfill({ json: embedSettings }));

  await startStandaloneDemo(page);
  await openModelsPanel(page);

  const close = page.getByTestId('connect-embed-close-scene');
  await expect(close).toBeVisible();          // no hover involved
  await expect(close).toHaveCSS('opacity', '1');
  const bounds = await getBoundingBox(close, 'row close action');
  expect(bounds.width).toBeGreaterThanOrEqual(44);
  expect(bounds.height).toBeGreaterThanOrEqual(44);

  await context.close();
});

test('signal hint stays clear of a maximally wide CONNECT panel', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('rv-connect-panel-width', '640');
  });

  await startStandaloneDemo(page);
  await expectDesktopHintLayout(page, 640);
});

test('signal hint is visible and unobstructed after closing the mobile CONNECT panel', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await startStandaloneDemo(page, true);

  const connectPanel = getConnectPanel(page);
  await expect(connectPanel).toBeVisible();
  await connectPanel.getByRole('button', { name: 'Close panel' }).click();
  await expect(connectPanel).toHaveCount(0);

  const hint = page.getByTestId('connect-embed-signal-hint');
  await expect(hint).toBeVisible();
  const hintBounds = await getBoundingBox(hint, 'mobile signal hint');

  expect(hintBounds.x).toBeGreaterThanOrEqual(0);
  expect(hintBounds.y).toBeGreaterThanOrEqual(0);
  expect(hintBounds.x + hintBounds.width).toBeLessThanOrEqual(390);
  expect(hintBounds.y + hintBounds.height).toBeLessThanOrEqual(844);

  const centerIsHint = await hint.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const elementAtCenter = document.elementFromPoint(
      bounds.left + bounds.width / 2,
      bounds.top + bounds.height / 2,
    );
    return elementAtCenter !== null
      && (elementAtCenter === element || element.contains(elementAtCenter));
  });
  expect(centerIsHint).toBe(true);
});

test(PERSISTENCE_TEST_NAME, async ({ page }) => {
  await startStandaloneDemo(page);
  await expect.poll(
    () => page.evaluate((key) => localStorage.getItem(key), SIGNAL_HINT_SEEN_KEY),
  ).toBe('1');

  await page.reload();
  await expect(page.getByTestId('connect-embed-gate')).toBeVisible();
  await page.getByTestId('connect-embed-start').click();
  await waitForDemoRunning(page);
  await expect(page.getByTestId('connect-embed-signal-hint')).toHaveCount(0);
});

test('missing embedded model reports load-error and offers retry', async ({ page }) => {
  await page.route('**/DemoRealvirtualWeb.glb', (route) => route.fulfill({ status: 404 }));
  await page.goto('/');
  await page.getByTestId('connect-embed-start').click();
  await expect(page.getByTestId('connect-embed-error')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
});

test.fixme('ConveyorEntry1 live handover, disconnect hold, unbind, and standalone resume', async ({ page }) => {
  // Requires the CONNECT WebSocket fixture used by the published-exe release gate.
  // The headless GLB contract is covered by connect-embed-demo-model.node.test.ts:
  // DemoCell/Conveyors/ConveyorEntry1 -> Drive_Simple.Forward.
  await page.goto('/');
});
