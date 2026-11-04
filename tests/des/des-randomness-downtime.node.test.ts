// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2051 §9.2 — Downtime MTBF/MTTR drawn from the seeded `self.rng`.
 *
 * With `Stochastic` on, all THREE scheduling points draw exponentially:
 * `onGenerate` (first failure), `onProcessComplete` (repair duration) and
 * `onAutoRelease` (up time after a repair). Proven here: same seed → identical
 * failure/repair times; different seeds → different ones; default (no flag /
 * false) → the exact fixed MTBF/MTTR cycle and the RNG untouched; every delay
 * stays strictly positive (the 0.001 s clamp).
 *
 * Synthetic Station + Downtime scene, the harness of tests/des/rv-des-downtime.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { resetDESMUCounter } from '../../src/plugins/des/rv-des-mu';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import { DESRunner } from '../../src/plugins/des/des-runner';
import { bindSceneToRunner } from '../../src/plugins/des/des-scene-binding';
import type { MaterialFlowAdapter } from '../../src/plugins/des/material-flow-adapter';
import { Station } from '../../src/plugins/des/material-flow/Station';
import { Downtime } from '../../src/plugins/des/material-flow/Downtime';
import { registerMaterialFlow } from '../../src/core/material-flow/registry';
import type { MaterialFlowDefinition } from '../../src/core/material-flow/define-material-flow';
import type { BindContextHost } from '../../src/core/behavior-runtime';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';

const runners: DESRunner[] = [];
afterEach(() => { for (const runner of runners.splice(0)) runner.dispose(); });

interface Cycle { fail: number; repair: number }
interface RunResult { cycles: Cycle[]; rngTouched: boolean }

/**
 * One run of a Station + Downtime pair: the failure/repair instants of the
 * target station up to `until` (s), and whether the downtime's RNG was drawn from.
 */
function run(downtime: Record<string, unknown>, seed: number, until = 20_000): RunResult {
  resetDESMUCounter();
  for (const def of [Station, Downtime] as unknown as MaterialFlowDefinition[]) registerMaterialFlow(def);
  const scene = new Scene();
  const stationNode = new Object3D(); stationNode.name = 'Station';
  const downtimeNode = new Object3D(); downtimeNode.name = 'Downtime';
  scene.add(stationNode, downtimeNode);
  stationNode.userData.realvirtual = { Station: {} };
  downtimeNode.userData.realvirtual = { Downtime: { MTBF: 100, MTTR: 10, TargetComponentPath: 'Station', ...downtime } };
  scene.updateMatrixWorld(true);
  const host: BindContextHost = {
    signalStore: new SignalStore(), registry: null, drives: [],
    on: () => () => {}, contextMenu: new ContextMenuStore(),
    getPlugin: () => undefined,
  };
  const runner = new DESRunner({ subMode: 'animated', masterSeed: seed });
  runners.push(runner);
  bindSceneToRunner(runner, scene, host);
  for (const { adapter } of runner.liveInstances) { adapter.nextComponents = []; adapter.previousComponents = []; }
  const adapterOf = (node: Object3D): MaterialFlowAdapter => runner.liveInstances.find(i => i.adapter.node === node)!.adapter;
  const manager = runner.getManager();
  manager.duration = 100_000;
  runner.start([], { root: scene });

  const station = adapterOf(stationNode);
  const dt = adapterOf(downtimeNode);
  const cycles: Cycle[] = [];
  const setFailure = station.setFailure.bind(station);
  station.setFailure = (on: boolean) => {
    if (on) cycles.push({ fail: manager.currentTime, repair: NaN });
    else if (cycles.length) cycles[cycles.length - 1].repair = manager.currentTime;
    setFailure(on);
  };
  // The adapter's RNG as attached (masterSeed + entity id) — compared after the run.
  const fresh = manager.createComponentRng(dt.entityId >= 0 ? dt.entityId : 0).getState();

  manager.duration = until;
  while (manager.currentTime < until) if (manager.processEvents(1000) === 0) break;
  const rngTouched = JSON.stringify(dt.rng!.getState()) !== JSON.stringify(fresh);
  return { cycles: cycles.filter(c => Number.isFinite(c.repair)), rngTouched };
}

const upTimes = (c: Cycle[]): number[] => c.map((x, k) => x.fail - (k === 0 ? 0 : c[k - 1].repair));
const downTimes = (c: Cycle[]): number[] => c.map(x => x.repair - x.fail);

describe('Downtime stochastic MTBF/MTTR (plan-2051)', () => {
  it('default (no flag / Stochastic false) -> the exact fixed cycle, RNG untouched', () => {
    for (const cfg of [{}, { Stochastic: false }]) {
      const r = run(cfg, 7, 1_000);
      expect(r.cycles.slice(0, 3)).toEqual([
        { fail: 100, repair: 110 }, { fail: 210, repair: 220 }, { fail: 320, repair: 330 },
      ]);
      expect(upTimes(r.cycles).every(u => Math.abs(u - 100) < 1e-9)).toBe(true);
      expect(downTimes(r.cycles).every(d => Math.abs(d - 10) < 1e-9)).toBe(true);
      expect(r.rngTouched).toBe(false);
    }
  });

  it('same seed -> identical failure/repair times', () => {
    const a = run({ Stochastic: true }, 7);
    const b = run({ Stochastic: true }, 7);
    expect(a.cycles.length).toBeGreaterThan(20);
    expect(b.cycles).toEqual(a.cycles);
    expect(a.rngTouched).toBe(true);
  });

  it('different seeds -> different failure/repair times', () => {
    const seqs = [1, 2, 3, 4, 5].map(seed => JSON.stringify(run({ Stochastic: true }, seed).cycles));
    expect(new Set(seqs).size).toBe(5);
  });

  it('all three scheduling points draw: first failure, repair durations, up times after repair', () => {
    const { cycles } = run({ Stochastic: true }, 3, 50_000);
    const up = upTimes(cycles);
    const down = downTimes(cycles);
    expect(cycles[0].fail).not.toBe(100);                                // onGenerate
    expect(new Set(down.map(d => d.toFixed(6))).size).toBeGreaterThan(10); // onProcessComplete
    expect(new Set(up.slice(1).map(u => u.toFixed(6))).size).toBeGreaterThan(10); // onAutoRelease
    // Exponential with the configured means (loose bounds, ~450 cycles).
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(mean(up)).toBeGreaterThan(80);
    expect(mean(up)).toBeLessThan(120);
    expect(mean(down)).toBeGreaterThan(8);
    expect(mean(down)).toBeLessThan(12);
  });

  it('failure and repair delays stay strictly positive (clamp at 0.001 s)', () => {
    // A tiny MTTR: every exponential draw lies below the clamp, so each repair takes the clamp.
    const { cycles } = run({ Stochastic: true, MTBF: 5, MTTR: 1e-7 }, 11, 2_000);
    expect(cycles.length).toBeGreaterThan(50);
    for (const d of downTimes(cycles)) {
      expect(d).toBeGreaterThan(0);
      expect(d).toBeCloseTo(0.001, 9);
    }
    for (const u of upTimes(cycles)) expect(u).toBeGreaterThan(0);
  });
});
