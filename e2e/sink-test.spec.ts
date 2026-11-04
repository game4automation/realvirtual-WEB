// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The Sink consumes MUs that travelled the conveyors — driven by the
 * deterministic test clock (plan-600 F1), not by the wall clock.
 *
 * What changed against the polling version: no `waitForTimeout`, no polling of
 * `/__api/debug/transport` (asynchronous and cached), and the fast-forward goes
 * to **120 s of simulation time** instead of ~20 s of wall clock. The first
 * sink consumption was MEASURED at `simTime = 88.6 s` (spike 2026-10-13), so a
 * 20 s horizon never reached it and the old spec only ever passed because the
 * live loop had already been running during the page load.
 *
 * Cost, so nobody is surprised: ~3600 rendered frames per run.
 *
 * **plan-601 F1:** the spec is watched by {@link watchJourney}, so an invariant
 * violation during the run makes it red instead of scrolling past in the
 * console. The two tests below it are the PROOF that the watcher works — one
 * injects a synchronous violation (I1), the other a deferred one (I5), and each
 * catches the expected assertion error deliberately and then restores a clean
 * state so the regular run stays green.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { test, expect } from 'playwright/test';
import { advanceSimSeconds, readTransport, withTestClock } from './_clock';
import { captureAssertion, watchJourney } from './_journey';
import { waitForViewerReady } from './_viewer-ready';

/** Simulation seconds to fast-forward. First consumption measured at 88.6 s. */
const HORIZON_SECONDS = 120;

/** The dev project's default document — named explicitly, never implied. */
const DEMO_URL = '/?model=DemoRealvirtualWeb.glb';

test('sink consumes MUs from conveyor end', async ({ page }) => {
  test.setTimeout(420_000);

  const journey = watchJourney(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForViewerReady(page);

  const transport = await withTestClock(page, async () => {
    const advanced = await advanceSimSeconds(page, HORIZON_SECONDS);
    // The clock is exact: 120 s at 60 Hz is 7200 steps, rendered 2 per frame.
    expect(advanced.steps).toBe(HORIZON_SECONDS * 60);
    expect(advanced.frames).toBe((HORIZON_SECONDS * 60) / 2);
    expect(advanced.simTime).toBeCloseTo(HORIZON_SECONDS, 6);
    return readTransport(page);
  });

  console.log(`[sink-test] after ${HORIZON_SECONDS} s sim: ${JSON.stringify(transport)}`);

  expect(transport.spawned).toBeGreaterThan(0);
  expect(transport.consumed).toBeGreaterThan(0);

  await journey.assertClean();
});

/**
 * plan-601 test 9.1 — a SYNCHRONOUS violation (I1) makes a journey red.
 *
 * I1 is measured inside the checkpoint itself (`checkInvariants`), so a mode
 * switch with a non-finite transform in the registry reports immediately.
 */
test('an injected synchronous invariant violation makes the journey red', async ({ page }) => {
  test.setTimeout(180_000);

  const journey = watchJourney(page);
  await page.goto(DEMO_URL, { waitUntil: 'domcontentloaded' });
  await waitForViewerReady(page);

  // The journey must be clean BEFORE the injection, otherwise the red below
  // would prove nothing about the injection.
  await journey.assertClean();

  // Injure, trip the checkpoint and repair in ONE synchronous evaluate: a
  // non-finite transform that survives into a rendered frame poisons the
  // spatial grid and produces unrelated console errors for the rest of the run.
  const injectedPath = await page.evaluate(() => {
    const v = (window as any).viewer;
    let hit: { path: string; node: any } | null = null;
    v.registry.forEachNode((path: string, node: any) => {
      if (!hit && node?.position) hit = { path, node };
    });
    if (!hit) return null;
    const { path, node } = hit as { path: string; node: any };
    const x = node.position.x;
    node.position.x = NaN;
    // The checkpoint: `mode-changing` / `mode-changed` both run I1 synchronously.
    v.modes.setMode('commissioning');
    node.position.x = x;
    return path;
  });
  expect(injectedPath, 'the registry must expose at least one node to injure').not.toBeNull();

  const failure = await captureAssertion(journey);
  expect(failure, 'the watcher must turn the injected I1 violation into an assertion error').not.toBeNull();
  expect(failure!.message).toContain('I1');
  expect(failure!.message).toContain(injectedPath!);

  // Return, let everything the injection caused arrive, forget it — and then
  // the regular run must be green again.
  await page.evaluate(async () => { await (window as any).viewer.modes.requestMode('hmi'); });
  await journey.settle();
  journey.reset();
  await journey.assertClean();
});

/**
 * plan-601 test 9.2 — a DEFERRED violation (I5) makes a journey red.
 *
 * **This is the test that proves 2.1.** The leaked geometry exists long before
 * the comparison, but the finding is only produced at the next actually
 * rendered frame after the return into the baseline's UI state. A watcher that
 * merely filtered the already-collected errors would be green here.
 *
 * The document is LOADED EXPLICITLY rather than taken from the boot, and that
 * is not cosmetic: the boot load arms the I3/I5 baseline while `activeMode` is
 * still `null` (`main.ts` applies the mode AFTER the model loads), so the
 * baseline's `uiKey` is `none|-|-` and `invariantsOnRenderedFrame` skips every
 * later comparison — MEASURED 2026-10-14, a leak of three geometries stayed
 * silent over a full return cycle. After an explicit load the baseline carries
 * the real UI state and the comparison runs. Reported as a plan-600 finding.
 *
 * The listener registration must sit BEFORE `loadModel` for the same reason
 * `e2e/invariants-layout-reference.spec.ts` gives: `whenPlacementsMaterialized()`
 * can still be settled from the previous load.
 */
test('an injected deferred invariant violation makes the journey red', async ({ page }) => {
  test.setTimeout(180_000);

  const journey = watchJourney(page);
  await page.goto(DEMO_URL, { waitUntil: 'domcontentloaded' });
  await waitForViewerReady(page);
  await journey.assertClean();

  // Load the document with the mode already applied, and take the baseline's
  // marker: `placements-materialized` plus one actually rendered frame.
  await page.evaluate(async () => {
    const v = (window as any).viewer;
    const settled = new Promise<void>((resolve) => { v.on('placements-materialized', () => resolve()); });
    await v.loadModel('demo-realvirtual/DemoRealvirtualWeb.glb');
    await settled;
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
  });
  await journey.settle();

  // The artificial leak: cloned geometries that nobody disposes. Cloning an
  // existing mesh's geometry and material keeps this spec free of a THREE
  // import in page context. Three of them, so the finding cannot be confused
  // with a single-geometry fluctuation.
  const leaked = await page.evaluate(() => {
    const v = (window as any).viewer;
    let source: any = null;
    v.scene.traverse((o: any) => { if (!source && o.isMesh && o.geometry && o.material) source = o; });
    if (!source) return 0;
    const kept: any[] = [];
    for (let i = 0; i < 3; i++) {
      const mesh = new source.constructor(source.geometry.clone(), source.material);
      mesh.name = `rv601-leaked-geometry-${i}`;
      mesh.frustumCulled = false;
      v.scene.add(mesh);
      kept.push(mesh);
    }
    (window as any).__rv601Leak = kept;
    return kept.length;
  });
  expect(leaked, 'the scene must contain a mesh to clone from').toBe(3);
  await journey.settle();

  // A FULL return cycle: the deferred comparison needs the baseline's UI state.
  for (const mode of ['commissioning', 'hmi']) {
    await page.evaluate((m: string) => (window as any).viewer.modes.requestMode(m), mode);
    await journey.settle();
  }

  const failure = await captureAssertion(journey);
  expect(failure, 'the watcher must turn the deferred I5 violation into an assertion error').not.toBeNull();
  expect(failure!.message).toContain('I5 geometries');
  expect(failure!.message).toContain('deferred');

  // Dispose the leak so the page is clean again, then re-assert.
  await page.evaluate(() => {
    for (const mesh of (window as any).__rv601Leak as any[]) {
      mesh.parent?.remove(mesh);
      mesh.geometry.dispose();
    }
    delete (window as any).__rv601Leak;
  });
  await journey.settle();
  journey.reset();
  await journey.assertClean();
});
