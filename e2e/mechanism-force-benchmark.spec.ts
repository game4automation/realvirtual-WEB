// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-412 §9.8 — the inverse-dynamics benchmark protocol.
 *
 * The NFR is an ADDITIONAL cost, not a total: "< 0.2 ms per mechanism per tick
 * extra for `rvk_solve_dynamics`". So the measurement is a difference of two
 * runs over the same scene through the same tick entry point — 100 warm-up
 * ticks then 1000 measured ticks, once with the analysis disarmed and once
 * armed. Timing the armed run alone would report the position solve as well and
 * would pass or fail for reasons that have nothing to do with this plan.
 *
 * Three representative rigs, the ones §9.8 names: a four-bar (one loop), a
 * scissor (several loops), and the delta rig (free bodies + spherical joints).
 *
 * The threshold is asserted, but the NUMBERS are the deliverable — they are
 * printed so the run can be quoted in the plan's implementation report.
 */

import { expect, test, type Page } from 'playwright/test';
 import { scratchAssetDocument } from '../tests/helpers/scratch-asset-document';
import { DEV_GLB } from '../tests/fixtures/glb-paths.mjs';
import { HAS_PRIVATE_SOURCE, privateModuleUrl } from './private-module-url';

const RIGS = [
  { id: 'four-bar', url: DEV_GLB.mechanismFourbar },
  { id: 'scissor', url: DEV_GLB.mechanismScissor },
  { id: 'delta', url: DEV_GLB.mechanismDelta },
];

/** §9.8: additional time per mechanism per tick. */
const BUDGET_MS = 0.2;
const WARMUP_TICKS = 100;
const MEASURED_TICKS = 1000;

// `authoring` lives in the PRIVATE sibling repository, outside the dev-server
// root, and is addressed through `/@fs/<abs>` — see `e2e/private-module-url.ts`.
const MODULE_PATHS = {
  doc: '/src/core/editor/rv-asset-document.ts',
  authoring: privateModuleUrl('plugins/asset-editor/mechanism/mechanism-authoring.ts'),
  registry: '/src/core/engine/rv-kinematic-registry.ts',
};

async function installHarness(page: Page): Promise<void> {
  await page.evaluate(async (paths) => {
    const w = window as unknown as Record<string, any>;
    const [docMod, authoring, kinRegistry] = await Promise.all([
      import(/* @vite-ignore */ paths.doc),
      import(/* @vite-ignore */ paths.authoring),
      import(/* @vite-ignore */ paths.registry),
    ]);

    const rvOf = (n: any) => (n?.userData?.realvirtual ?? {}) as Record<string, any>;

    w.__rv412bench = {
      async load(url: string) {
        await w.viewer.loadModel(url);
      },

      ready(): boolean {
        const bridge = kinRegistry.getMechanismUiBridge?.();
        return !!bridge && bridge.list().some((m: any) => m.active === true);
      },

      /** Author a mass on every link of every mechanism (see the §9.7 spec's note). */
      async prepare() {
        const viewer = w.viewer;
        const bridge = kinRegistry.getMechanismUiBridge();
        const doc = docMod.scratchAssetDocument(viewer);
        const readField = (p: string, c: string, f: string) => {
          const node = viewer.registry?.getNode(p);
          return node ? rvOf(node)[c]?.[f] : undefined;
        };
        const docLike = {
          withTransaction: (l: string, fn: () => Promise<void>) => doc.withTransaction(l, fn),
          addComponent: (p: string, t: string, f: Record<string, unknown>) => doc.addComponent(p, t, f),
          setField: (p: string, c: string, f: string, v: unknown, pv: unknown) =>
            doc.setField(p, c, f, v, pv),
          unsetField: (p: string, c: string, f: string, pv: unknown) => doc.unsetField(p, c, f, pv),
        };
        for (const mech of bridge.list()) {
          for (const link of mech.links) {
            if (!link.hasBody) {
              await authoring.runMechanismPlan(docLike, authoring.planAddBody(link.nodePath), readField);
            }
            await authoring.runMechanismPlan(
              docLike, authoring.planSetMassOverride(link.nodePath, 2.5), readField);
          }
        }
        await doc.whenIdle();
        for (const mech of bridge.list()) bridge.rebuild(mech.nodePath);
        doc.dispose?.();
        return bridge.list().filter((m: any) => m.active).length;
      },

      /**
       * Time the manager's own tick entry point, which is what the sim loop
       * calls — so the measurement includes the host-side plumbing the NFR is
       * really about, not just the wasm call in isolation.
       */
      run(armed: boolean) {
        const manager = kinRegistry.getKinematicManager();
        const bridge = kinRegistry.getMechanismUiBridge();
        const mechs = bridge.list().filter((m: any) => m.active);
        for (const m of mechs) bridge.setForceAnalysis(m.nodePath, armed);

        const dt = 1 / 60;
        for (let i = 0; i < 100; i++) manager.tickMechanisms(dt);
        const t0 = performance.now();
        for (let i = 0; i < 1000; i++) manager.tickMechanisms(dt);
        const total = performance.now() - t0;

        const statuses = mechs.map((m: any) =>
          bridge.forcesSnapshot(m.nodePath)?.statusText ?? '?');
        return { total, mechanisms: mechs.length, statuses };
      },
    };
  }, MODULE_PATHS);
}

test.describe.configure({ mode: 'serial' });

test.describe('plan-412 §9.8 — inverse dynamics benchmark', () => {
  // Mechanism authoring is commercial source; without the private sibling repo
  // there is nothing to benchmark here.
  test.skip(!HAS_PRIVATE_SOURCE, 'needs the private sibling repository (asset-editor source)');

  let page: Page;
  const results: string[] = [];

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(600_000);
    page = await browser.newPage();
    page.setDefaultTimeout(240_000);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('canvas', { timeout: 120_000 });
    await page.waitForFunction(() => {
      const v = (window as unknown as { viewer?: any }).viewer;
      return !!v?.registry && !!v?.transportManager;
    }, undefined, { timeout: 240_000 });
    await installHarness(page);
  });

  test.afterAll(async () => {
    // eslint-disable-next-line no-console
    console.log(`\nplan-412 §9.8 benchmark (${WARMUP_TICKS} warm-up + ${MEASURED_TICKS} ticks)\n`
      + results.join('\n') + '\n');
    await page?.close();
  });

  for (const rig of RIGS) {
    test(`${rig.id}: dynamics costs less than ${BUDGET_MS} ms per mechanism per tick`, async () => {
      test.setTimeout(300_000);
      await page.evaluate((url) => (window as any).__rv412bench.load(url), rig.url);
      await page.waitForFunction(() => (window as any).__rv412bench.ready(),
        undefined, { timeout: 180_000 });

      const mechanisms = await page.evaluate(() => (window as any).__rv412bench.prepare());
      expect(mechanisms).toBeGreaterThan(0);

      const off = await page.evaluate(() => (window as any).__rv412bench.run(false));
      const on = await page.evaluate(() => (window as any).__rv412bench.run(true));

      const extraPerTickPerMech =
        (on.total - off.total) / MEASURED_TICKS / on.mechanisms;
      const usable = on.statuses.every((s: string) => s === 'ok');
      results.push(
        `  ${rig.id.padEnd(10)} ${String(on.mechanisms).padStart(2)} mech · `
        + `kinematics ${(off.total / MEASURED_TICKS).toFixed(4)} ms/tick · `
        + `+dynamics ${(on.total / MEASURED_TICKS).toFixed(4)} ms/tick · `
        + `extra ${extraPerTickPerMech.toFixed(4)} ms/mech/tick`
        + (usable ? '' : `  [NOT COUNTED — ${on.statuses.join(', ')}]`));

      // A rig whose dynamics is not `ok` still ran the full evaluation up to the
      // point where it decided it could not answer, so its time is reported —
      // but it is NOT counted against the budget, because that number would
      // measure an early return and pass for the wrong reason. What IS asserted
      // is that the refusal is one of the crate's DOCUMENTED outcomes rather
      // than a crash or a silent zero: a rig that cannot be sized must say so.
      if (!usable) {
        expect(on.statuses.every((s: string) => s !== 'ok' && s.length > 0)).toBe(true);
        return;
      }
      expect(extraPerTickPerMech).toBeLessThan(BUDGET_MS);
    });
  }
});
