// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// DES audit (seed/disturbance/snapshot inventory, 2026-10-31): does determinism hold under the
// same disturbance protocol? Reuses the plan-630 9.9b determinism harness/fixture
// (tests/des/fixtures/s10/determinism-run.test.ts.txt), disturbing the fleet the only way that
// exists today — Active=false on a vehicle, read once at bind (see pallet-yard-active.test.ts) —
// instead of a live rate/pause change.
// HEAVY, reviewer load window only. No measurements at import time.
// Explicit opt-in (like RV_PLAN630_DETERMINISM) prevents accidental suite execution:
// PowerShell: $env:RV_DISTURBANCE_DETERMINISM='1'; $env:RV_TEST_FILE_TIMEOUT_SECONDS='6000'
// npm run test:node -- tests/des/pallet-yard-determinism-disturbance.node.test.ts
import { describe, expect, it } from 'vitest';
import { runChildVitest } from './_child-vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlanningChange } from '../../src/core/planning/rv-planning-registry';

const WV = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ASSETS = join(WV, 'tests/des/fixtures/s10');
interface Result {
  counters: Record<string, number>;
  kpis: Record<string, number | null>;
  changeLog: PlanningChange[];
  orders: Array<{ id: number; source: string; destination: string | null; created: number; done: number; vehicle: string | null }>;
  releases: number[];
  freeAt: number | null;
  blockedAt: number | null;
  submissions: Array<{ simTime: number; free: boolean; blocked: boolean }>;
}

// Same S10 out-of-tree copy/config and spawn style as pallet-yard-determinism.node.test.ts.
function prepare(): string {
  const parent = join(WV, 'node_modules/.m3-s10');
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, 'disturbance-'));
  const root = WV.replace(/\\/g, '/');
  const relative = dir.slice(WV.length + 1).replace(/\\/g, '/');
  const rewrite = (s: string) => s.split('__PUBLIC_ROOT__').join(root).split('node_modules/.m3').join(relative);
  writeFileSync(join(dir, 'm3-palletyard.test.ts'), rewrite(readFileSync(join(ASSETS, 'determinism-run.test.ts.txt'), 'utf8')));
  writeFileSync(join(dir, 'vitest.m3.config.ts'), rewrite(readFileSync(join(ASSETS, 'vitest.m3.config.ts.txt'), 'utf8')));
  writeFileSync(join(dir, 'vitest.det.config.ts'), `
import base from './vitest.m3.config';
export default (env: any) => {
  const c = base(env);
  c.define = { ...c.define, RV_DET_INPUT: JSON.stringify({
    simSec: Number(process.env.RV_DET_SIM_SEC),
    protocol: [],
    replay: null,
    activeOff: JSON.parse(process.env.RV_DET_ACTIVE_OFF || '[]'),
  }) };
  return c;
};
`);
  return dir;
}

function run(dir: string, name: string, activeOff: string[] = []): Result {
  const outPath = join(dir, `${name}.json`);
  const env = { RV_DET_SIM_SEC: '14400',
    RV_DET_OUT: outPath, RV_DET_ACTIVE_OFF: JSON.stringify(activeOff) };
  const out = runChildVitest('pallet-yard-determinism-disturbance', [
    '--config', join(dir, 'vitest.det.config.ts'), join(dir, 'm3-palletyard.test.ts')], {
    env, logFile: join(dir, `${name}.log`), label: name,
  });
  const match = out.match(/DET_RESULT (\{.*\})/);
  if (!match) throw new Error(`Missing DET_RESULT in ${name}:\n${out.slice(-4000)}`);
  const result = JSON.parse(match[1]) as Result;
  writeFileSync(env.RV_DET_OUT, JSON.stringify(result, null, 2));
  return result;
}

function same(a: Result, b: Result): void {
  for (const key of ['counters', 'kpis', 'orders', 'changeLog', 'releases'] as const) expect(b[key], key).toEqual(a[key]);
}

describe.skipIf(process.env.RV_DISTURBANCE_DETERMINISM !== '1')('DES audit: determinism under the Active disturbance protocol', () => {
  it('two runs with one vehicle disabled before bind are bit-identical; the yard still ships', () => {
    const dir = prepare();
    console.log('Disturbance-determinism evidence: ' + dir);
    const disturbed = run(dir, 'disturbed-1', ['Stapler_2']);
    same(disturbed, run(dir, 'disturbed-2', ['Stapler_2']));
    // Recovery sanity: the disturbed yard still ships orders without the disabled vehicle.
    expect(disturbed.orders.length).toBe(50);
    expect(disturbed.orders.every(o => o.vehicle !== 'Stapler_2')).toBe(true);
    // And it genuinely differs from an undisturbed run — this is not a no-op disturbance.
    const control = run(dir, 'control');
    expect(disturbed.counters).not.toEqual(control.counters);
  }, 11_000_000);
});
