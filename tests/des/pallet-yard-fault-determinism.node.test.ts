// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-2053 Phase 0: proves the DES-core claim on a REAL PalletYard scene (not the synthetic
// loop scene the spike used) — a `Downtime` node (plan-2051, unchanged) targeting a real AGV
// (`Stapler_2`, same vehicle the existing disturbance test references) via `TargetComponentPath`
// freezes/resumes it deterministically: same seed + same fixed MTBF/MTTR schedule -> bit-identical
// PER metric; a control run without the Downtime node genuinely differs. No new mechanism — reuses
// the plan-630 9.9b / DES-audit determinism harness and the shared `determinism-run.test.ts.txt`
// fixture (fault injection added there as a new, backward-compatible `downtime` field; existing
// callers — plan-630 9.9b, the DES-audit disturbance test — never set it and are unaffected).
// This file does NOT touch tests/des/pallet-yard-s10-compare.node.test.ts (plan-645 M3/soak
// baseline) or its own fixtures (m3-palletyard.test.ts.txt) — that regression stays separately
// verified, unmodified by this plan.
//
// HEAVY, reviewer load window only. No measurements at import time. Explicit opt-in:
// PowerShell: $env:RV_FAULT_DETERMINISM='1'; $env:RV_TEST_FILE_TIMEOUT_SECONDS='6000'
// npm run test:node -- tests/des/pallet-yard-fault-determinism.node.test.ts
import { describe, expect, it } from 'vitest';
import { runChildVitest } from './_child-vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlanningChange } from '../../src/core/planning/rv-planning-registry';

const WV = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ASSETS = join(WV, 'tests/des/fixtures/s10');
const TARGET_VEHICLE = 'Stapler_2'; // same vehicle the existing disturbance test references
const SIM_SEC = 14400;

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

// Same S10 out-of-tree copy/config and spawn style as the other determinism node tests.
function prepare(): string {
  const parent = join(WV, 'node_modules/.m3-s10');
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, 'fault-'));
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
    activeOff: [],
    downtime: process.env.RV_DET_DOWNTIME ? JSON.parse(process.env.RV_DET_DOWNTIME) : null,
  }) };
  return c;
};
`);
  return dir;
}

function run(dir: string, name: string, downtime: { mtbf: number; mttr: number; targetName: string } | null = null): Result {
  const outPath = join(dir, `${name}.json`);
  const env = { RV_DET_SIM_SEC: String(SIM_SEC),
    RV_DET_OUT: outPath, RV_DET_DOWNTIME: downtime ? JSON.stringify(downtime) : '' };
  const out = runChildVitest('pallet-yard-fault-determinism', [
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

describe.skipIf(process.env.RV_FAULT_DETERMINISM !== '1')('plan-2053: AGV fault via Downtime, determinism on a real PalletYard scene', () => {
  it('two runs with the same Downtime-on-Agv schedule are bit-identical; a control run without it differs', () => {
    const dir = prepare();
    console.log('Fault-determinism evidence: ' + dir);
    // mttr must stay well below the harness's 60s (sim time) wait-timeout watchdog
    // (tests/fleet/expect-no-wait-timeouts.ts) — Stapler_2 holds its claimed zone for the
    // full repair duration (plan-2053 §5.4, F2), so a longer mttr trips that generic guard
    // even though the fault itself is working as designed.
    const downtime = { mtbf: 600, mttr: 30, targetName: TARGET_VEHICLE };
    const faulted1 = run(dir, 'faulted-1', downtime);
    same(faulted1, run(dir, 'faulted-2', downtime));
    // Recovery sanity: the yard still ships orders with the faulted vehicle present
    // (it holds everything it had claimed — F2, no release extension — but resumes
    // the same task after each repair, per F3).
    expect(faulted1.orders.length).toBe(50);
    // And it genuinely differs from an undisturbed control run of the SAME scene/seed —
    // this proves the Downtime target actually took effect, PER metric (counters), not
    // as an aggregate/rounded claim.
    const control = run(dir, 'control');
    expect(faulted1.counters).not.toEqual(control.counters);
  }, 11_000_000);
});
