// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-558 §9.6 — acceptance: AGVFactory, 8 AGVs, work plan of the demo,
 * 10 simulated minutes DES animated at 60 Hz. Independent oracle: the oriented
 * body footprints never overlap (SAT, every frame) for a 1.0 × 0.6 m AND a
 * 1.2 × 0.6 m body (the plan-903 model overlapped at 1.2 m — regression
 * proof against the original copy). Plus the analytic check of the planner
 * (`violations` = every applied plan verified with `minSeparation`), the
 * minimum front-to-rear gap ≥ SafetyGap, every station served and no stop
 * longer than 60 s.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { MaterialFlowDefinition } from '../../src/core/material-flow/define-material-flow';
import { getDefaultMovementAuthority, type MbStats } from '../../src/core/engine/rv-movement-authority';
import { AgvFlow as AgvOrigFlow } from './_reference/agv-original-903';
import { DESRunner } from '@rv-private/plugins/des/des-runner';
import {
  AGV_DEF, TICK, Object3D, makeHost, makeAgvRoot, bindDes, clearShared, runAnimated, centredBody,
  type RunMetrics,
} from '../helpers/agv-harness';
import { registerFactory, factoryAgvConfigs, installWorkPlan, type WorkPlanStats } from '../fixtures/agv-factory-fixture';

const ORIG = AgvOrigFlow as unknown as MaterialFlowDefinition;
const log = (...a: unknown[]): void => { console.log('[agv-factory]', ...a); };

beforeEach(() => clearShared());

interface FactoryResult { m: RunMetrics; plan: WorkPlanStats; stats: MbStats | null; minFrontRear: number }

function runFactory(def: MaterialFlowDefinition, footLen: number, simSec = 600): FactoryResult {
  clearShared();
  const layout = registerFactory();
  const runner = new DESRunner({ subMode: 'animated' });
  const host = makeHost();
  const cfgs = factoryAgvConfigs(layout, 8, { VehicleLength: footLen * 1000, VehicleWidth: 600 });
  const roots = cfgs.map(([n, c]) => makeAgvRoot(n, c));
  roots.forEach((r) => bindDes(runner, r, host, def));
  runner.start([def], { root: new Object3D() });
  const wp = installWorkPlan();
  wp.dispatch();
  const mb = getDefaultMovementAuthority('des');
  const isNew = def === AGV_DEF;
  let minFR = Infinity;
  const body = centredBody(footLen, 0.6);
  const m = runAnimated(runner, { roots, names: roots.map((r) => r.name), bodies: roots.map(() => body) }, simSec, (f) => {
    if (isNew && f % 3 === 0) {
      const g = mb.minFrontRearGap(f * TICK);
      if (g < minFR) minFR = g;
    }
  });
  const stats = isNew ? JSON.parse(JSON.stringify(mb.stats)) as MbStats : null;
  runner.dispose();
  return { m, plan: wp.stats, stats, minFrontRear: minFR };
}

function summary(tag: string, r: FactoryResult): void {
  log(`${tag} events=${r.m.events} overlapFrames=${r.m.overlapFrames} maxPen=${r.m.maxPenetration.toFixed(3)}`
    + ` minCentre=${r.m.minCentreDist.toFixed(3)} minFrontRear=${Number.isFinite(r.minFrontRear) ? r.minFrontRear.toFixed(3) : 'n/a'}`
    + ` maxStopped=${r.m.maxStoppedSec.toFixed(1)}s(${r.m.maxStoppedAgv}) services=${JSON.stringify(Object.fromEntries(r.plan.services))}`
    + (r.stats ? ` violations=${r.stats.violations} forced=${r.stats.forced} watchdog=${r.stats.watchdogFires}`
      + ` minPlanMargin=${r.stats.minMargin === null ? 'n/a' : Number(r.stats.minMargin).toFixed(4)} capHitsAfterStart=${r.stats.cascadeCapHitsAfterStart}` : ''));
}

describe('AGVFactory — no body overlap (plan-558 §9.6)', () => {
  for (const footLen of [1.0, 1.2]) {
    it(`8 AGVs, ${footLen.toFixed(1)} m body: 0 overlap frames, gap ≥ SafetyGap, every station served, no stop ≥ 60 s`, () => {
      const r = runFactory(AGV_DEF, footLen);
      summary(`NEW[${footLen}m]`, r);
      expect(r.stats!.violations).toBe(0);
      expect(r.stats!.forced).toBe(0);
      expect(r.stats!.watchdogFires).toBe(0);
      expect(r.m.overlapFrames).toBe(0);
      expect(r.minFrontRear).toBeGreaterThanOrEqual(0.3 - 1e-6);
      expect(r.m.maxStoppedSec).toBeLessThan(60);
      for (const st of ['Load', 'WS1', 'WS2', 'WS3']) expect(r.plan.services.get(st) ?? 0).toBeGreaterThan(0);
    }, 120_000);
  }

  it('regression proof: the plan-903 model overlaps with a 1.2 m body on the same course', () => {
    const r = runFactory(ORIG, 1.2);
    summary('ORIG[1.2m]', r);
    expect(r.m.overlapFrames).toBeGreaterThan(0);
  }, 120_000);
});
