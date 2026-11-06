// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * 6.7.1 finding (2026-11-06): the editor test run of a demo document whose
 * DISPLAY NAME differs from its root name ("… (Kinematics)") could not restore
 * its own scene after Stop. The editor stayed on the test copy and the drive
 * force recording was never stable. Every check at the time opened the file by
 * its path, where the two names agree, so nothing caught it.
 *
 * This journey therefore takes the visitor's way: the project overview, the
 * document's card by its display name, Open, the Editor, Play, Stop. It asserts
 * that the run records drive forces, that the authoring scene comes back under
 * its original root name with nothing in Problems, and that the recorded run is
 * still there after Stop (contract-node-identity rule 13).
 *
 * `window.viewer` is READ for state only; every action is a real click. The
 * test title is part of the runner's contract (scripts/rv-demo-smoke.mjs
 * `JOURNEY_TITLES`, F14) — rename both together.
 */

import { expect, test, type Page } from 'playwright/test';
import { blockAnalytics, collectErrors, criticalErrors, waitForViewerReady } from '../_viewer-ready';
import { EXPECTED_DEMOS, LIVE_BASE_URL } from './_live-target';

/** The demo document with a mechanism and a display name unlike its root. */
const DOCUMENT_PATH = 'Autonox-DELTA-RL5-1900-6kg.glb';

interface ManifestDoc { id: string; name: string; path: string }

async function displayNameOf(path: string): Promise<string> {
  const res = await fetch(`${LIVE_BASE_URL}demo-realvirtual/project.json`, { headers: { 'Cache-Control': 'no-cache' } });
  const manifest = await res.json() as { documents: ManifestDoc[] };
  const doc = manifest.documents.find((d) => d.path === path);
  if (!doc) throw new Error(`editor journey: the demo project no longer lists ${path}`);
  return doc.name;
}

interface RunState { root: string | null; mode: string; samples: number; finite: number; restoreProblems: number }

async function readState(page: Page): Promise<RunState> {
  return page.evaluate(() => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const v = (window as any).viewer;
    // The viewer is briefly absent while the workspace mode switches.
    if (!v) return { root: null, mode: '', samples: 0, finite: 0, restoreProblems: 0 };
    const recorder = v.getPlugin('mechanism-force-recorder')?.recorder;
    const series = recorder?.series ?? [];
    const finite = series.reduce((n: number, s: any) => n + s.values.toArray().filter(Number.isFinite).length, 0);
    const problems = document.querySelectorAll('[data-problem-code="editor-test-restore-failed"]').length;
    return {
      root: v.currentModelRoot?.name ?? null,
      mode: v.modes.activeMode,
      samples: recorder?.timeBuffer.count ?? 0,
      finite,
      restoreProblems: problems,
    };
  });
}

test('editor test run of a display-named demo restores the original and keeps the drive forces', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await blockAnalytics(page);
  const displayName = await displayNameOf(DOCUMENT_PATH);
  // Any demo document opens the bundled project; the journey then navigates like a visitor.
  await page.goto(`?doc=${encodeURIComponent(EXPECTED_DEMOS.hmi)}&welcome=0`, { waitUntil: 'domcontentloaded' });
  await waitForViewerReady(page);

  // 1. Project overview → card by DISPLAY NAME → Open.
  await page.getByRole('button', { name: /^Projects/ }).first().click();
  await page.getByRole('button', { name: new RegExp(`^${displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).first().click();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect.poll(async () => (await readState(page)).root, { timeout: 60_000 }).not.toBeNull();

  // 2. Editor.
  await page.getByRole('button', { name: 'Switch workspace mode' }).click();
  await page.getByRole('menuitem', { name: /^Editor/ }).click();
  await expect.poll(async () => (await readState(page)).mode, { timeout: 30_000 }).toBe('editor');
  const start = page.getByTestId('editor-sim-start');
  await expect(start).toBeVisible({ timeout: 30_000 });
  // The original is what the editor shows right before the run, under the root's own name.
  const originalRoot = (await readState(page)).root;
  expect(originalRoot, 'the editor shows no document').not.toBeNull();

  // 3. Play: the run records drive forces, and the forces stay reachable while it runs.
  await start.click();
  const stop = page.getByTestId('editor-sim-stop');
  await expect(stop).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => (await readState(page)).finite, { timeout: 30_000 }).toBeGreaterThan(30);
  await expect(page.getByRole('button', { name: 'Show drive forces' }), 'the forces vanish while the run runs').toBeVisible();
  const recorded = (await readState(page)).samples;

  // 4. Stop: the original is back under its own root name, nothing in Problems,
  //    and the run just recorded is still readable.
  await stop.click();
  await expect(start).toBeVisible({ timeout: 60_000 });
  const after = await readState(page);
  expect(after.root, 'the editor did not return to the original scene').toBe(originalRoot);
  expect(after.restoreProblems, 'the restore after the test run failed').toBe(0);
  expect(after.samples, 'Stop dropped the recorded run').toBeGreaterThanOrEqual(recorded);

  const restoreErrors = errors.filter((e) => e.includes('restoring the editor after the test run failed'));
  expect(restoreErrors).toEqual([]);
  expect(criticalErrors(errors), 'page/console errors during the editor journey').toEqual([]);
});
