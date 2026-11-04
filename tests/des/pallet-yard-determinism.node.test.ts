// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-630 9.9b: HEAVY, reviewer load window only. No measurements at import time.
// S10 uses isolated child processes; it is NOT excluded by the normal Node config.
// Explicit opt-in here (like RV_PLAN501_ACCEPTANCE) prevents accidental suite execution:
// PowerShell: $env:RV_PLAN630_DETERMINISM='1'; $env:RV_TEST_FILE_TIMEOUT_SECONDS='12000'
// npm run test:node -- tests/des/pallet-yard-determinism.node.test.ts
// Expect roughly a minute per child including browser boot (unmeasured); ten children.
import { describe, expect, it } from 'vitest';
import { runChildVitest } from './_child-vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PALLET_YARD_OWNER, rateKeyOf, SHIP_EVERY_KEY } from '../../src/plugins/models/PalletYard/parameters';
import type { PlanningChange } from '../../src/core/planning/rv-planning-registry';

const WV = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ASSETS = join(WV, 'tests/des/fixtures/s10');
const RATE = `${PALLET_YARD_OWNER}.${rateKeyOf('A1')}`;
const PAUSE = `${PALLET_YARD_OWNER}.${SHIP_EVERY_KEY}`;
interface Change { simTime: number; key: string; to: number }
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

// Same S10 out-of-tree copy/config and spawn style; unique directory preserves all evidence.
function prepare(): string {
  const parent = join(WV, 'node_modules/.m3-s10');
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, 'determinism-'));
  const root = WV.replace(/\\/g, '/');
  const relative = dir.slice(WV.length + 1).replace(/\\/g, '/');
  const rewrite = (s: string) => s.split('__PUBLIC_ROOT__').join(root).split('node_modules/.m3').join(relative);
  writeFileSync(join(dir, 'm3-palletyard.test.ts'), rewrite(readFileSync(join(ASSETS, 'determinism-run.test.ts.txt'), 'utf8')));
  // Reuse the unmodified M3 config; a thin wrapper injects env/JSON into its browser fixture.
  writeFileSync(join(dir, 'vitest.m3.config.ts'), rewrite(readFileSync(join(ASSETS, 'vitest.m3.config.ts.txt'), 'utf8')));
  writeFileSync(join(dir, 'vitest.det.config.ts'), `
import base from './vitest.m3.config';
import { readFileSync } from 'node:fs';
export default (env: any) => {
  const c = base(env);
  if (process.env.RV_DET_REPLAY && process.env.RV_DET_PROTOCOL) throw new Error('Choose protocol OR replay');
  c.define = { ...c.define, RV_DET_INPUT: JSON.stringify({
    simSec: Number(process.env.RV_DET_SIM_SEC),
    protocol: JSON.parse(process.env.RV_DET_PROTOCOL || '[]'),
    replay: process.env.RV_DET_REPLAY ? JSON.parse(readFileSync(process.env.RV_DET_REPLAY, 'utf8')) : null,
  }) };
  return c;
};
`);
  return dir;
}

function run(dir: string, name: string, protocol: Change[] = [], replay?: string): Result {
  const outPath = join(dir, `${name}.json`);
  const env = { RV_DET_SIM_SEC: '14400',
    RV_DET_OUT: outPath, RV_DET_PROTOCOL: replay ? '' : JSON.stringify(protocol), RV_DET_REPLAY: replay ?? '' };
  const out = runChildVitest('pallet-yard-determinism', [
    '--config', join(dir, 'vitest.det.config.ts'), join(dir, 'm3-palletyard.test.ts')], {
    env, logFile: join(dir, `${name}.log`), label: name,
  });
  const match = out.match(/DET_RESULT (\{.*\})/);
  if (!match) throw new Error(`Missing DET_RESULT in ${name}:\n${out.slice(-4000)}`);
  const result = JSON.parse(match[1]) as Result;
  // Browser cannot use node:fs: transport its JSON exactly as S10 does, then persist it.
  writeFileSync(env.RV_DET_OUT, JSON.stringify(result, null, 2));
  return result;
}

function same(a: Result, b: Result): void {
  for (const key of ['counters', 'kpis', 'orders', 'changeLog', 'releases'] as const) expect(b[key], key).toEqual(a[key]);
}

describe.skipIf(process.env.RV_PLAN630_DETERMINISM !== '1')('plan-630 9.9b process determinism', () => {
  it('live repeat, no-change control, recorded replay, rate zero and exact release boundary', () => {
    const dir = prepare();
    console.log('Determinism evidence: ' + dir);
    const protocol = [{ simTime: 1800, key: RATE, to: 70 }, { simTime: 3600, key: PAUSE, to: 900 }];
    const first = run(dir, 'run-1', protocol);
    same(first, run(dir, 'run-2', protocol));
    expect(first.changeLog.map(({ simTime, key, from, to }) => ({ simTime, key, from, to }))).toEqual([
      { ...protocol[0], from: 40 }, { ...protocol[1], from: 1200 },
    ]);
    const control = run(dir, 'run-3-control');
    expect(control.changeLog).toEqual([]);
    expect(control.counters).not.toEqual(first.counters);
    const replayPath = join(dir, 'recorded-changes.json');
    writeFileSync(replayPath, JSON.stringify(first.changeLog));
    same(first, run(dir, 'run-4-replay', [], replayPath));

    for (const kind of ['free', 'blocked'] as const) {
      const stop = kind === 'free' ? control.freeAt : control.blockedAt;
      expect(stop, `control must actually observe A1 ${kind}`).not.toBeNull();
      if (stop === null) throw new Error(`No ${kind} state in control`);
      const restart = stop + 300;
      expect(restart).toBeLessThan(14400 - 180);
      const zeroProtocol = [{ simTime: stop, key: RATE, to: 0 }, { simTime: restart, key: RATE, to: 40 }];
      const a = run(dir, `zero-${kind}-1`, zeroProtocol);
      same(a, run(dir, `zero-${kind}-2`, zeroProtocol));
      expect(a.submissions[0][kind]).toBe(true);
      expect(a.changeLog.map(({ simTime, to }) => ({ simTime, to }))).toEqual([
        { simTime: stop, to: 0 }, { simTime: restart, to: 40 },
      ]);
      // A release AT stop precedes the change by contract. None may occur afterwards while disabled.
      expect(a.releases.filter(t => t > stop && t < restart)).toEqual([]);
      const resumed = a.releases.filter(t => t >= restart);
      expect(resumed.length).toBeGreaterThan(1);
      expect(resumed.filter(t => t === restart).length).toBeLessThanOrEqual(1);
      for (let i = 1; i < resumed.length; i++) expect(resumed[i] - resumed[i - 1]).toBeGreaterThanOrEqual(90 - 1e-8);
    }

    // Use an ACTUAL successful A1 release in the unchanged run, not an assumed order-ready time.
    const edgeAt = control.releases.find(t => t >= 90);
    expect(edgeAt).toBeDefined();
    if (edgeAt === undefined) throw new Error('Control has no A1 release boundary');
    const edge = run(dir, 'edge-live', [{ simTime: edgeAt, key: RATE, to: 70 }]);
    expect(edge.releases).toContain(edgeAt);
    expect(edge.changeLog).toHaveLength(1);
    expect(edge.changeLog[0].simTime).toBe(edgeAt);
    const edgePath = join(dir, 'edge-recorded-changes.json');
    writeFileSync(edgePath, JSON.stringify(edge.changeLog));
    same(edge, run(dir, 'edge-replay', [], edgePath));
  }, 11_000_000);
});
