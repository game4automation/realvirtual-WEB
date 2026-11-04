// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2212 §9.7 - the PalletYard ShippingMonitor as a Script-KPI, end to end on the bundled demo.
 *
 * The bundled demo document loads WITHOUT `?scripts` (demo trust rule): its `ShippingMonitor`
 * WebComponent runs on the DES clock, publishes `self.statValue('Late shipments')`, and the demo
 * experiment file carries the KPI definition `def:late-shipments`. The spec drives the same path
 * the Experiments panel and the MCP tools use (`experiment.*` commands): short stop time, two
 * replications per column, Run all, then reads the four columns' KPI values.
 *
 *   - every column (Base, 2 AGVs, 4 AGVs, No downtime) has a value for "Late shipments";
 *   - "No downtime" has fewer late shipments than Base (the breakdowns are the cause);
 *   - after a page reload and a second Run all the values are identical (seeded, every replication
 *     restarts the script from its initial state).
 *
 *   npx playwright test e2e/palletyard-shipping-monitor.spec.ts
 *   RV_E2E_PORT=5612 npx playwright test e2e/palletyard-shipping-monitor.spec.ts   # worktree dev server
 *   RV_E2E_NO_EMBED=1 ...   # viewer-only: skips the embed preview server (no dist-embed needed)
 */

import { test, expect } from 'playwright/test';
import type { Page } from 'playwright/test';

const DEMO = '/?projectUrl=%2Fdemo-realvirtual%2F&doc=doc_palletyard_hzmdb6&mode=des';
const KPI = 'def:late-shipments';
const END_TIME_S = 7200;
const REPLICATIONS = 2;
const COLUMNS = ['Base', 'v:palletyard-2-agvs', 'v:palletyard-4-agvs', 'v:palletyard-no-downtime'];

interface Values { [column: string]: { mean: number; n: number } }

async function openDemo(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try { localStorage.setItem('rv-welcome-dismissed', 'true'); localStorage.setItem('rv-auto-quality-applied', 'true'); } catch { /* private mode */ }
  });
  await page.goto(DEMO, { waitUntil: 'domcontentloaded' });
  // The model may load twice during boot (project handover); wait for the script instance, not just the URL.
  await page.waitForFunction(() => {
    const v = (window as unknown as { viewer?: { currentModelUrl?: string; getPlugin?(id: string): { instances?: Array<{ ok: boolean }> } | undefined } }).viewer;
    return /PalletYard/.test(v?.currentModelUrl ?? '') && (v?.getPlugin?.('web-component')?.instances ?? []).some(i => i.ok);
  }, undefined, { timeout: 120_000 });
}

/** Runs experiment commands inside the page (`ui` origin, like the panel). */
function exec<T>(page: Page, calls: Array<[string, Record<string, unknown>]>): Promise<T[]> {
  return page.evaluate(async (list) => {
    const { commandRegistry } = await import(/* @vite-ignore */ '/src/core/hmi/rv-command-registry.ts');
    const viewer = (window as unknown as { viewer: unknown }).viewer;
    const out: unknown[] = [];
    for (const [id, args] of list) {
      const r = await commandRegistry.execute(id, args, { origin: 'ui', viewer } as never);
      out.push(JSON.parse(JSON.stringify(r)));
    }
    return out;
  }, calls) as Promise<T[]>;
}

type Result = { ok: boolean; reason?: string; value?: any };

async function readValues(page: Page): Promise<Values> {
  const [res] = await exec<Result>(page, [['experiment.results', { kpis: [KPI, 'def:pallets-out'], history: false }]]);
  expect(res.ok, res.reason).toBe(true);
  const values: Values = {};
  for (const col of res.value.columns as Array<{ column: string; kpis: Array<{ id: string; mean: number; n: number }> }>) {
    const k = col.kpis.find(x => x.id === KPI);
    if (k) values[col.column] = { mean: k.mean, n: k.n };
  }
  return values;
}

/** Short settings for every column, then the call the panel's "Run all" makes; returns the KPI values. */
async function runAllShort(page: Page): Promise<Values> {
  const [, listed] = await exec<Result>(page, [['experiment.settings.set', { endTime: END_TIME_S }], ['experiment.list', {}]]);
  expect((listed.value.columns as Array<{ key: string }>).map(c => c.key)).toEqual(COLUMNS);
  const setup: Array<[string, Record<string, unknown>]> = COLUMNS.map(column => ['experiment.column.set', { column, replicationCount: REPLICATIONS }]);
  for (const r of await exec<Result>(page, setup)) expect(r.ok, r.reason).toBe(true);
  const [run] = await exec<Result>(page, [['experiment.run', { scope: 'all' }]]);
  expect(run.ok, run.reason).toBe(true);
  return readValues(page);
}

test('PalletYard ShippingMonitor: Late shipments in all four columns, No downtime below Base, identical after reload', async ({ page }) => {
  test.setTimeout(1_200_000);
  await openDemo(page);

  // The bundled demo ran the script without ?scripts, on the DES clock.
  const script = await page.evaluate(() => {
    const v = (window as unknown as { viewer: { getPlugin(id: string): { instances: Array<{ nodePath: string; ok: boolean; adapter?: { mode?: string } }> } } }).viewer;
    return v.getPlugin('web-component').instances.map(i => ({ path: i.nodePath, ok: i.ok, mode: i.adapter?.mode }));
  });
  expect(script).toEqual([{ path: 'PalletYard/PalletYardRoot/ShippingMonitor', ok: true, mode: 'des' }]);

  const first = await runAllShort(page);
  expect(Object.keys(first).sort()).toEqual([...COLUMNS].sort());
  for (const column of COLUMNS) {
    expect(first[column].n, `${column}: valid replications`).toBe(REPLICATIONS);
    expect(Number.isFinite(first[column].mean), `${column}: Late shipments has a value`).toBe(true);
  }
  expect(first.Base.mean, 'Base has late shipments (breakdowns starve the shipping)').toBeGreaterThan(0);
  expect(first['v:palletyard-no-downtime'].mean, 'No downtime ships late less often than Base').toBeLessThan(first.Base.mean);

  // Reload (the project file re-imports the columns without results), run again: the same values.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openDemo(page);
  expect(await runAllShort(page)).toEqual(first);
});
