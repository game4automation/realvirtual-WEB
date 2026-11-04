// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-645 L8 / R2-5 — S10 made machine-checkable. Runs the PalletYard soak (3 sim days) and the
// plan-559 M3 measurement (8 h) each as its OWN browser-vitest process and compares their
// `SOAK_RESULT` / `M3_RESULT` lines with `fixtures/s10/s10-manifest.json`.
// A missing manifest / asset / result line or a run that did not finish is a FAIL, never a skip.
//
// Heavy (two browser runs, ~1 min each incl. boot): run on its own, in a load window —
//   npm run test:node -- tests/des/pallet-yard-s10-compare.node.test.ts
// The children inherit RV_TEST_LOCK_HELD from this process (global-lock-guard), so they do not
// wait on the machine-wide test lock this run already holds.
// Baselines and measurement scripts live in tests/des/fixtures/s10.
import { describe, expect, it } from 'vitest';
import { runChildVitest } from './_child-vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WV = resolve(HERE, '../..');
const PUBLIC_ROOT = WV.replace(/\\/g, '/') + '/';

interface Manifest {
  soak: { test: string; resultLine: string; expected: Record<string, unknown> };
  m3: { script: string; config: string; scriptPathPrefix: string; baseline: string; resultLine: string; compare: string[] };
}

function resultLine(out: string, tag: string): Record<string, unknown> {
  const m = out.match(new RegExp(`${tag} (\\{.*\\})`));
  if (!m) throw new Error(`no ${tag} line in the child output:\n${out.slice(-4000)}`);
  return JSON.parse(m[1]) as Record<string, unknown>;
}

function pick(o: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], o);
}

const ASSETS = join(HERE, 'fixtures/s10');

// V1-D1b: the runner now enables series by default for these finite-duration runs.
// Existing fixed baselines (including desEvents) therefore also guard recorder neutrality.
describe('plan-645 S10: soak + M3 against the fixed manifest', () => {
  it('assets are present (a missing asset is a FAIL)', () => {
    expect(existsSync(ASSETS), 'checked-in S10 fixtures').toBe(true);
    expect(existsSync(join(ASSETS, 's10-manifest.json')), 's10-manifest.json').toBe(true);
  });

  it('soak (3 sim days, own process) matches the manifest', () => {
    const man = JSON.parse(readFileSync(join(ASSETS, 's10-manifest.json'), 'utf8')) as Manifest;
    const out = runChildVitest('s10-soak', [man.soak.test]);
    const got = resultLine(out, man.soak.resultLine);
    expect(got).toEqual(man.soak.expected);
  }, 960_000);

  it('M3 (8 h, own process) matches assets/plan-559/baseline-palletyard.json', () => {
    const base = ASSETS;
    const man = JSON.parse(readFileSync(join(base, 's10-manifest.json'), 'utf8')) as Manifest;
    const script = readFileSync(resolve(base, man.m3.script), 'utf8');
    const config = readFileSync(resolve(base, man.m3.config), 'utf8');
    const baseline = JSON.parse(readFileSync(resolve(base, man.m3.baseline), 'utf8')) as { result: Record<string, unknown> };
    // Resolve the public-root placeholder for this standalone checkout.
    const dir = join(WV, 'node_modules', '.m3-s10');
    mkdirSync(dir, { recursive: true });
    const rewrite = (s: string): string => s.split(man.m3.scriptPathPrefix).join(PUBLIC_ROOT).split('__PUBLIC_ROOT__').join(WV.replace(/\\/g, '/')).split('node_modules/.m3').join('node_modules/.m3-s10');
    writeFileSync(join(dir, 'm3-palletyard.test.ts'), rewrite(script));
    writeFileSync(join(dir, 'vitest.m3.config.ts'), rewrite(config));
    const out = runChildVitest('s10-m3', ['--config', join(dir, 'vitest.m3.config.ts'), join(dir, 'm3-palletyard.test.ts')]);
    const got = resultLine(out, man.m3.resultLine);
    for (const k of man.m3.compare) expect(pick(got, k), k).toEqual(pick(baseline.result, k));
  }, 960_000);
});
