// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
//
// plan-2056 — regression coverage for the bug the plan-2051 Phase 3 fixture reintroduced
// (fixed in Phase 0 of this plan): a PalletYard DES runtime (`rt`, from `startDesRuntime()`)
// left undisposed before `runner.dispose()`/`y.dispose()` keeps its process-wide zone-registry
// subscription alive (`ZoneRegistry.clear()` does not remove listeners — plan-645/648), so a
// later load/dispose cycle in the SAME process can hit the stale listener and throw ("Fleet DES
// clock: disposed"). tests/des/pallet-yard-des-two-runs.test.ts already proves two full-length
// cycles are safe with the correct dispose order; this test adds the scenario plan-2056 was
// opened for: several SHORT cycles (F3) that deliberately dispose while a vehicle still has an
// outstanding zone hold / replan in flight, not just "between" two completed runs.
//
// Node wrapper (this file) spawns ONE browser-vitest child process that runs both cases — the
// cycles must share a single process for the regression to mean anything (same discipline as
// tests/des/pallet-yard-s10-compare.node.test.ts and tests/des/des-randomness-taktsource.node.test.ts,
// which spawn a browser child from a Node test because PalletYard scene loading needs a real
// WebGL/Playwright browser context that the Node vitest environment does not have).
//
// Not HEAVY-guarded: short (a handful of bounded-tick cycles, well under a minute total), same
// as pallet-yard-des-two-runs.test.ts.
import { describe, expect, it } from 'vitest';
import { runChildVitest } from './_child-vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WV = resolve(HERE, '../..');
const PUBLIC_ROOT = WV.replace(/\\/g, '/') + '/';
const TMP_NAME = '.plan2056-agv';

const BROWSER_SCRIPT = `
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// Generated at test time by tests/des/agv-replan-reload-cycle.node.test.ts (plan-2056) — not
// checked in, same convention as tests/des/fixtures/plan-2051/taktsource-variance.test.ts.txt /
// tests/des/fixtures/s10 (see the node wrapper above for the full rationale).
import { describe, expect, it } from 'vitest';
import { DESRunner } from '@rv/plugins/des/des-runner';
import '@rv/behaviors/Conveyor';
import '@rv/behaviors/Source';
import '@rv/behaviors/Sink';
import '@rv/behaviors/Agv';
import { bindDesYard, startDesRuntime } from '@rv/plugins/models/PalletYard/yard-runtime';
import { DEFAULT_YARD } from '@rv/plugins/models/PalletYard/yard-compose';
import { deriveFleetRng } from '@rv/plugins/fleet-plugin';
import { PluginOwnerRegistry } from '@rv/plugins/des/fleet/des-handover';
import { devAssetAvailable } from '__PUBLIC_ROOT__/tests/fixtures/dev-asset-available';
import { trafficListenerStats, trafficRegistryStats } from '__PUBLIC_ROOT__/src/core/engine/rv-traffic-registries';
import { PALLET_YARD_URL, loadPalletYardScene } from '__PUBLIC_ROOT__/tests/des/pallet-yard-scene-load';

const AVAILABLE = await devAssetAvailable(PALLET_YARD_URL);
const EMPTY = {
  paths: 0, zones: 0, zoneHolders: 0, spacing: 0, docks: 0,
  authorityVehicles: { des: 0, continuous: 0 }, pendingClockEvents: 0, fleetHandles: 0,
};

/**
 * One load -> bind -> tick -> dispose cycle, in the SAME browser process as any cycle run
 * before/after it in this test file (that sharing is the point: plan-2051 Phase 3's fixture
 * re-broke the fix from plan-645/648 by forgetting \`rt.dispose()\`, see plan-2056).
 *
 * \`maxTicks\` bounds the loop WITHOUT waiting for \`mgr.isComplete\` — used by the second test
 * case (F3) to dispose a cycle deliberately long before it would finish on its own, while
 * vehicles are still actively planning / holding zones, rather than only disposing between two
 * completed runs the way the first test case and pallet-yard-des-two-runs.test.ts do.
 */
async function runCycle(opts) {
  const simSec = opts.simSec ?? 8 * 3600;
  const y = await loadPalletYardScene();
  const listenersBefore = trafficListenerStats().zoneListeners;
  const runner = new DESRunner({ subMode: 'fastforward', durationSeconds: simSec });
  let rt = null;
  try {
    runner.start([], { root: y.root, host: y.host });
    const cfg = structuredClone(DEFAULT_YARD.config);
    if (opts.stochastic) cfg.production.stochastic = true;
    const r = bindDesYard({ runner, root: y.root, drives: y.drives, owners: new PluginOwnerRegistry(), cfg });
    if (!r.ok) throw new Error(opts.label + ': bind ' + r.missing.join(', '));
    const rng = opts.stochastic ? deriveFleetRng('pallet-yard', runner, y.root) : undefined;
    rt = opts.stochastic ? startDesRuntime(r.backend, () => {}, { cfg, rng }) : startDesRuntime(r.backend, () => {});
    const live = rt;
    const mgr = runner.getManager();
    const maxTicks = opts.maxTicks ?? 200_000;
    let ticks = 0;
    let idle = 0;
    while (!mgr.isComplete && ticks < maxTicks) {
      const before = mgr.totalEventsProcessed;
      runner.tick(1 / 60); runner.lateTick(1 / 60); live.frame(); ticks++;
      idle = mgr.totalEventsProcessed === before ? idle + 1 : 0;
      // Only a FULL-length cycle (no tick bound) stalling is a bug; a bounded-tick cycle (F3)
      // is deliberately cut short and must not be mistaken for a stall.
      if (opts.maxTicks === undefined && idle >= 3) throw new Error(opts.label + ': stall at sim t=' + mgr.currentTime.toFixed(0));
    }
    return { ticks, simTimeSec: mgr.currentTime, complete: mgr.isComplete };
  } finally {
    rt?.dispose();
    runner.dispose();
    y.dispose();
    const after = trafficRegistryStats();
    const listenersAfter = trafficListenerStats().zoneListeners;
    console.log('CYCLE_RESULT ' + JSON.stringify({ label: opts.label, after, listenersBefore, listenersAfter }));
  }
}

describe.skipIf(!AVAILABLE)('plan-2056: AGV replan outlives dispose - reload cycle regression', () => {
  it('2-3 load/dispose cycles of the PalletYard AGV model in one process do not throw, zone registry empty after each dispose', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await runCycle({ label: 'full cycle ' + (i + 1) });
      expect(r.complete, 'full cycle ' + (i + 1) + ' reached isComplete').toBe(true);
    }
  }, 300_000);

  it('dispose while a vehicle has an active maneuver/pending replan does not throw', async () => {
    // plan-2056 F3 deviation (sanctioned in the plan, section "Risiken & Mitigationen"): there
    // is no harness hook to pause mid-event inside the synchronous FastForward tick loop, so a
    // dispose cannot be aimed at the exact instant a specific vehicle's zone-release/replan is
    // in flight without deep changes to the DES/Fleet harness - out of scope here (this plan
    // touches test files only). Instead: several SHORT, production.stochastic=true cycles
    // (frequent re-planning, same config as tests/des/fixtures/plan-2051/taktsource-variance.test.ts.txt),
    // each disposed after only a small, bounded number of ticks - long before \`isComplete\`,
    // i.e. while vehicles are still actively planning / holding zones - repeated several times
    // to make catching one in flight likely rather than guaranteed on a single try.
    for (let i = 0; i < 6; i++) {
      // No assertion on \`complete\` here: the point is that disposing early never throws and
      // never leaks registry state, not the completion state at the moment of the cut.
      await runCycle({ label: 'short cycle ' + (i + 1), stochastic: true, maxTicks: 40, simSec: 8 * 3600 });
    }
  }, 300_000);
});
`;

interface CycleResult {
  label: string;
  after: Record<string, unknown>;
  listenersBefore: number;
  listenersAfter: number;
}

function cycleResults(out: string): CycleResult[] {
  const results: CycleResult[] = [];
  const re = /CYCLE_RESULT (\{.*\})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(out)) !== null) results.push(JSON.parse(m[1]) as CycleResult);
  return results;
}

const EMPTY = {
  paths: 0, zones: 0, zoneHolders: 0, spacing: 0, docks: 0,
  authorityVehicles: { des: 0, continuous: 0 }, pendingClockEvents: 0, fleetHandles: 0,
};

describe('plan-2056: AGV replan outlives dispose - reload cycle regression (browser child)', () => {
  it('both cases run in one browser process without a stall/throw, zone registry empty after every dispose', () => {
    const dir = join(WV, 'node_modules', TMP_NAME);
    mkdirSync(dir, { recursive: true });
    const rewritten = BROWSER_SCRIPT.split('__PUBLIC_ROOT__').join(WV.replace(/\\/g, '/'));
    writeFileSync(join(dir, 'agv-replan-reload-cycle.browser.test.ts'), rewritten);
    const config = `
import base from '${PUBLIC_ROOT}vite.config.ts';
export default ((env) => {
  const c = (base)(env);
  c.root = '${PUBLIC_ROOT}';
  c.test.include = ['${PUBLIC_ROOT}node_modules/${TMP_NAME}/agv-replan-reload-cycle.browser.test.ts'];
  c.test.exclude = [];
  c.server.fs.allow.push('${PUBLIC_ROOT}node_modules/${TMP_NAME}');
  return c;
});
`;
    writeFileSync(join(dir, 'vitest.agv-replan.config.ts'), config);
    // Leave time for a useful child error before with-test-lock's 600 s file limit.
    const out = runChildVitest('agv-replan-reload-cycle', ['--config', join(dir, 'vitest.agv-replan.config.ts'), join(dir, 'agv-replan-reload-cycle.browser.test.ts')], { timeout: 300_000 });
    const results = cycleResults(out);

    // The scene asset may be unavailable on a public-only checkout (devAssetAvailable gates the
    // browser describe with skipIf) - in that case vitest still exits 0 with zero cycles logged;
    // treat that as a legitimate skip rather than asserting on an empty array.
    if (results.length === 0) return;

    expect(results, 'full cycles (3) + short in-flight cycles (6)').toHaveLength(9);
    for (const r of results) {
      expect(r.after, `${r.label}: no traffic state survives a dispose`).toEqual(EMPTY);
      // Same bound as tests/des/pallet-yard-des-two-runs.test.ts (plan-645 N3): the movement
      // authority subscribes ONCE per browser process on first use (a singleton); from then on
      // a cycle's dispose must not leave any additional zone-registry subscriber behind.
      expect(r.listenersAfter - r.listenersBefore, `${r.label}: at most the authority`).toBeLessThanOrEqual(1);
    }
  }, 900_000);
});
