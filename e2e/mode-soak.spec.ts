// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * The mode soak (plan-601 F3, tests 9.5 / 9.6) — 50 complete return cycles of
 * ONE mode pair, compared at EVERY return point.
 *
 * **The soak contract (plan 2.2), binding:**
 *
 * | Item | Value |
 * |---|---|
 * | pair | `hmi` <-> `commissioning`, one pair rather than all |
 * | cycle | `hmi -> commissioning -> hmi` is ONE; **50** of them |
 * | resting state | model loaded, placements materialised, simulation NOT running, panels closed |
 * | baseline | after the completed load and one rendered frame |
 * | comparison point | every return into `hmi`, after a rendered frame, at the same mode AND the same panel configuration |
 * | rules | `registry.size.nodes` equal; `renderer.info.memory.geometries` / `textures` equal; listeners per signal name NOT higher |
 * | tolerance | none — equality, not a band |
 *
 * Compared at every return, not only at the end: a finding that appears in
 * between and closes again before the end would otherwise be invisible.
 *
 * **No test clock.** The capture refuses WebGPU/XR, demands
 * `logicRunState === 'active'` and falsifies exactly the render cycles a mode
 * switch needs. The soak runs on real frames, with the simulation PAUSED by a
 * named reason instead — so no spawned MU can move a counter the contract
 * compares with zero tolerance. `resetSimulation()` is not called: plan-600
 * § 5.6 measured that it may be called exactly once.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { test, expect, type Page } from 'playwright/test';
import { watchJourney, type JourneyWatcher } from './_journey';
import { waitForViewerReady } from './_viewer-ready';

/** The dev project's default document — named explicitly, never implied. */
const DEMO_URL = '/?model=DemoRealvirtualWeb.glb';

/** The layout document with DELAYED materialising references (test 9.6). */
const LAYOUT_MODEL = 'demo-realvirtual/DemoPlanner.glb';

/** Binding by plan 2.2 — never lowered to speed a run up. */
const CYCLES = 50;

/** The pause reason the soak holds while it cycles. */
const PAUSE_REASON = 'rv601-soak';

interface Sample {
  mode: string | null;
  left: string | null;
  right: string | null;
  nodes: number;
  geometries: number;
  textures: number;
  listeners: Record<string, number>;
}

/** Everything the soak compares, in one round trip. */
async function sample(page: Page): Promise<Sample> {
  return page.evaluate(() => {
    const v = (window as any).viewer;
    const mem = v.renderer?.info?.memory;
    const counts = v.signalStore?.listenerCounts?.() ?? new Map<string, number>();
    return {
      mode: v.modes.activeMode ?? null,
      left: v.leftPanelManager?.getActive?.('left') ?? null,
      right: v.leftPanelManager?.getActive?.('right') ?? null,
      nodes: v.registry?.size?.nodes ?? -1,
      geometries: mem?.geometries ?? -1,
      textures: mem?.textures ?? -1,
      listeners: Object.fromEntries(counts) as Record<string, number>,
    };
  });
}

/**
 * The comparison rules of the contract, as violation messages. Empty = clean.
 * Equality for nodes and renderer resources, "not higher" per signal name.
 */
function compare(base: Sample, now: Sample): string[] {
  const out: string[] = [];
  if (now.mode !== base.mode) out.push(`mode: ${base.mode} -> ${now.mode}`);
  if (now.left !== base.left || now.right !== base.right) {
    out.push(`panels: ${base.left}|${base.right} -> ${now.left}|${now.right}`);
  }
  if (now.nodes !== base.nodes) out.push(`nodes: ${base.nodes} -> ${now.nodes}`);
  if (now.geometries !== base.geometries) out.push(`geometries: ${base.geometries} -> ${now.geometries}`);
  if (now.textures !== base.textures) out.push(`textures: ${base.textures} -> ${now.textures}`);
  for (const [name, count] of Object.entries(now.listeners)) {
    const was = base.listeners[name] ?? 0;
    if (count > was) out.push(`listeners ${name}: ${was} -> ${count}`);
  }
  return out;
}

/** Waits until the current load's placements are idle — the load-bound marker. */
async function waitForPlacementsIdle(page: Page, timeoutMs = 60_000): Promise<void> {
  await page.waitForFunction(() => {
    const state = (window as any).viewer.placements?.state;
    return state === undefined || state === 'idle';
  }, undefined, { timeout: timeoutMs });
}

/**
 * Brings the page into the resting state of the contract and returns the
 * baseline.
 *
 * `warmUpCycles` matters and is not a tolerance: MEASURED 2026-10-14, the
 * FIRST entry into `commissioning` creates the node
 * `DemoRealvirtualWebglb/Simulation`, which stays — a one-time lazy global
 * (every later cycle keeps the count). Without one warm-up cycle the soak
 * would report that single allocation on cycle 1 and never reach its subject,
 * which is drift over many cycles. After the warm-up the comparison has NO
 * tolerance at all.
 */
async function restingBaseline(
  page: Page,
  journey: JourneyWatcher,
  { cyclePair, warmUpCycles = 1 }: { cyclePair: readonly [string, string]; warmUpCycles?: number },
): Promise<Sample> {
  await waitForPlacementsIdle(page);
  await page.evaluate((reason: string) => {
    (window as any).viewer.setSimulationPaused(reason, true);
  }, PAUSE_REASON);

  const [home, away] = cyclePair;
  expect(await page.evaluate((m: string) => (window as any).viewer.modes.requestMode(m), home)).toBe(true);
  await journey.settle();

  for (let i = 0; i < warmUpCycles; i++) {
    for (const mode of [away, home]) {
      expect(await page.evaluate((m: string) => (window as any).viewer.modes.requestMode(m), mode)).toBe(true);
      await journey.settle();
    }
  }

  const base = await sample(page);
  // Resting state: the panels must be closed, otherwise the comparison would
  // be anchored on a UI state nobody asked for.
  expect(base.left, 'the left panel must be closed in the resting state').toBeNull();
  expect(base.right, 'the right panel must be closed in the resting state').toBeNull();
  expect(base.mode).toBe(home);
  return base;
}

/** One complete return cycle `home -> away -> home`, settled at every step. */
async function cycle(page: Page, journey: JourneyWatcher, home: string, away: string): Promise<void> {
  for (const mode of [away, home]) {
    const accepted = await page.evaluate((m: string) => (window as any).viewer.modes.requestMode(m), mode);
    expect(accepted, `requestMode('${mode}') must be accepted`).toBe(true);
    await journey.settle();
  }
}

test(`${CYCLES} return cycles hmi <-> commissioning leave no drift`, async ({ page }) => {
  test.setTimeout(1_800_000);

  const journey = watchJourney(page);
  await page.goto(DEMO_URL, { waitUntil: 'domcontentloaded' });
  await waitForViewerReady(page);

  const base = await restingBaseline(page, journey, { cyclePair: ['hmi', 'commissioning'] });
  console.log(`[mode-soak] baseline: ${JSON.stringify({ ...base, listeners: Object.keys(base.listeners).length })}`);

  for (let i = 1; i <= CYCLES; i++) {
    await cycle(page, journey, 'hmi', 'commissioning');
    const now = await sample(page);
    const drift = compare(base, now);
    expect(drift, `drift at return point ${i} of ${CYCLES}`).toEqual([]);
    if (i % 10 === 0) console.log(`[mode-soak] cycle ${i}: nodes=${now.nodes} geometries=${now.geometries} textures=${now.textures}`);
  }

  await journey.assertClean();
});

/**
 * plan-601 test 9.6 — the soak's comparison must distinguish.
 *
 * (a) A document whose references materialise LATE (`DemoPlanner.glb`) plus
 *     the modes' own legitimate resources must NOT trigger — the same false
 *     alarm `e2e/invariants-layout-reference.spec.ts` guards for I5.
 * (b) An artificially leaked geometry MUST trigger, measured by the very same
 *     `compare()` the soak uses.
 */
test('delayed materialisation stays silent while an artificial leak is caught', async ({ page }) => {
  test.setTimeout(600_000);

  const journey = watchJourney(page);
  await page.goto(DEMO_URL, { waitUntil: 'domcontentloaded' });
  await waitForViewerReady(page);

  // (a) The layout document, loaded with the mode already applied.
  const placed = await page.evaluate(async (url: string) => {
    const v = (window as any).viewer;
    const settled = new Promise<any>((resolve) => { v.on('placements-materialized', (info: any) => resolve(info)); });
    await v.loadModel(url);
    const info = await settled;
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    return info;
  }, LAYOUT_MODEL);
  expect(placed.materialized, 'DemoPlanner.glb must place references — otherwise this proves nothing').toBeGreaterThan(0);

  const base = await restingBaseline(page, journey, { cyclePair: ['hmi', 'commissioning'] });
  console.log(`[mode-soak 9.6] baseline on the layout document: nodes=${base.nodes} geometries=${base.geometries} textures=${base.textures}`);

  for (let i = 1; i <= 3; i++) {
    await cycle(page, journey, 'hmi', 'commissioning');
    const drift = compare(base, await sample(page));
    expect(drift, `a layout document must not drift (return point ${i})`).toEqual([]);
  }

  // (b) The artificial leak: cloned geometries nobody disposes.
  const leaked = await page.evaluate(() => {
    const v = (window as any).viewer;
    let source: any = null;
    v.scene.traverse((o: any) => { if (!source && o.isMesh && o.geometry && o.material) source = o; });
    if (!source) return 0;
    const kept: any[] = [];
    for (let i = 0; i < 3; i++) {
      const mesh = new source.constructor(source.geometry.clone(), source.material);
      mesh.name = `rv601-soak-leak-${i}`;
      mesh.frustumCulled = false;
      v.scene.add(mesh);
      kept.push(mesh);
    }
    (window as any).__rv601SoakLeak = kept;
    return kept.length;
  });
  expect(leaked).toBe(3);

  await cycle(page, journey, 'hmi', 'commissioning');
  const withLeak = compare(base, await sample(page));
  console.log(`[mode-soak 9.6] drift with the artificial leak: ${JSON.stringify(withLeak)}`);
  expect(withLeak.some((d) => d.startsWith('geometries:')), 'the leak must be caught by the same comparison').toBe(true);

  // Dispose it again so nothing of the injection outlives the test.
  await page.evaluate(() => {
    for (const mesh of (window as any).__rv601SoakLeak as any[]) {
      mesh.parent?.remove(mesh);
      mesh.geometry.dispose();
    }
    delete (window as any).__rv601SoakLeak;
  });
  await cycle(page, journey, 'hmi', 'commissioning');
  expect(compare(base, await sample(page)), 'after disposal the comparison must be clean again').toEqual([]);
});
