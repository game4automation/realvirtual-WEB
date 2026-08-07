// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * des-fastforward-throughput.test.ts — plan-262 Phase 0 (Events/s benchmark).
 *
 * Runs a synthetic reference model (Source → 5 stations → Sink, fixed seed,
 * deterministic timing) to completion through `runner.runFastForward()` twice
 * and asserts RESULT PARITY (identical totalEventsProcessed + KPIs) — the
 * regression gate for every FastForward batching change (plan-262 F5/F6).
 *
 * Throughput (events/s) is LOGGED via console.info only, never asserted —
 * absolute ms gates are flaky in CI (style: rv-des-snapshot-scale.test.ts).
 * The only throughput assertion is the smoke check `eventsPerSecond > 0`.
 *
 * Runs only in the private build (imports `@rv-private/plugins/des/*`).
 */

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import { DESRunner } from '@rv-private/plugins/des/des-runner';
import { _resetDesHookCache } from '@rv-private/plugins/des/des-hook-adapter';
import { resetDESMUCounter } from '@rv-private/plugins/des/rv-des-mu';
import type { MaterialFlowAdapter } from '@rv-private/plugins/des/material-flow-adapter';
import {
  createSelf,
  type MaterialFlowSelf,
  type MU,
} from '../../src/core/material-flow/material-flow-self';
import {
  defineMaterialFlow,
  type MaterialFlowDefinition,
} from '../../src/core/material-flow/define-material-flow';
import { _resetMaterialFlowRegistry } from '../../src/core/material-flow/registry';
import {
  createBindContext,
  type BindContextHost,
  type KinematicsSpec,
  type RVBindContext,
} from '../../src/core/behavior-runtime';
import { EventEmitter } from '../../src/core/rv-events';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';

// ─── Reference model parameters (deterministic — the seed is fixed AND the
//     event times are constants, so two runs must be bit-identical) ─────────

const SEED = 42;
const DURATION_S = 21_600;        // 6 simulated hours
const STATION_COUNT = 5;
const SOURCE_INTERVAL_S = 1;      // one MU per simulated second
const STATION_TIME_S = 0.5;       // < interval → no congestion, steady flow

// ─── Minimal bind context (mirrors des-runner.test.ts) ─────────────────────

function makeBindContext(root: Object3D): RVBindContext {
  const events = new EventEmitter<Record<string, unknown>>();
  const values = new Map<string, boolean | number>();
  const host: BindContextHost = {
    signalStore: {
      get: (n: string) => values.get(n),
      set: (n: string, v: boolean | number) => values.set(n, v),
      subscribe: () => () => {},
    } as never,
    on: (e, cb) => events.on(e, cb as never),
    contextMenu: new ContextMenuStore(),
    drives: [] as never,
    registry: null,
    getPlugin: () => undefined,
  };
  const accum: KinematicsSpec = {};
  const { ctx } = createBindContext(root, host, accum);
  return ctx;
}

// ─── Reference-model run ───────────────────────────────────────────────────

interface BenchResult {
  done: boolean;
  totalEventsProcessed: number;
  kpis: { simTime: number; meanUtilization: number; throughputPerHour: number; consumed: number };
  eventsPerSecond: number;
  wallMs: number;
}

/** Build + FastForward the reference model to completion; fresh world per run. */
async function runReferenceModel(seed: number): Promise<BenchResult> {
  _resetMaterialFlowRegistry();
  _resetDesHookCache();
  resetDESMUCounter();

  const runner = new DESRunner({
    subMode: 'animated',
    durationSeconds: DURATION_S,
    masterSeed: seed,
  });

  const adapters: MaterialFlowAdapter[] = [];
  const idAt = (i: number) => () => adapters[i].entityId;

  // Source: emits one MU per SOURCE_INTERVAL_S via a self-rescheduling Generate.
  const sourceDef = defineMaterialFlow<MaterialFlowSelf>({
    type: 'BenchSource', kind: 'source', schema: {}, continuous: {},
    des: {
      onGenerate(self) {
        const mu = self.spawn();
        self.transfer(mu);
        self.in(SOURCE_INTERVAL_S, 'Generate', null);
      },
    },
  }) as MaterialFlowDefinition;

  // Station: hold each MU for STATION_TIME_S, then hand it downstream.
  const stationDef = defineMaterialFlow<MaterialFlowSelf>({
    type: 'BenchStation', kind: 'station', schema: {}, continuous: {},
    des: {
      onAccept(self, mu) { self.in(STATION_TIME_S, 'ProcessComplete', mu); return true; },
      onProcessComplete(self, mu) { if (mu) self.transfer(mu); },
    },
  }) as MaterialFlowDefinition;

  // Sink: consume + count.
  let consumed = 0;
  const sinkDef = defineMaterialFlow<MaterialFlowSelf>({
    type: 'BenchSink', kind: 'sink', schema: {}, continuous: {},
    des: { onAccept() { consumed++; return true; } },
  }) as MaterialFlowDefinition;

  const addInstance = (def: MaterialFlowDefinition, name: string, index: number): void => {
    const node = new Object3D();
    node.name = name;
    const self = createSelf(makeBindContext(node), def, {
      mode: 'des',
      scheduler: runner.makeScheduler(def, idAt(index)),
      onTransfer: (mu: MU) => runner.makeTransfer(adapters[index])(mu),
      canAcceptDownstream: (mu: MU) => adapters[index].nextComponents.some(c => c.canAccept(mu as never)),
      spawnMU: () => runner.createMU(),
    });
    adapters.push(runner.addInstance(def, self, node));
  };

  addInstance(sourceDef, 'Source', 0);
  for (let s = 0; s < STATION_COUNT; s++) addInstance(stationDef, `Station${s + 1}`, 1 + s);
  addInstance(sinkDef, 'Sink', 1 + STATION_COUNT);

  // Wire the line topology (Source → S1 → … → S5 → Sink) BEFORE start().
  for (let i = 0; i < adapters.length - 1; i++) {
    adapters[i].nextComponents = [adapters[i + 1]];
    adapters[i + 1].previousComponents = [adapters[i]];
  }

  runner.start([sourceDef, stationDef, sinkDef], { root: new Object3D() });

  const t0 = performance.now();
  const done = await runner.runFastForward();
  const wallMs = performance.now() - t0;

  const totalEventsProcessed = runner.getManager().totalEventsProcessed;
  const stats = runner.statistics();
  const kpis = {
    simTime: stats.simTime,
    meanUtilization: stats.meanUtilization,
    throughputPerHour: stats.throughputPerHour,
    consumed,
  };
  runner.dispose();

  return {
    done,
    totalEventsProcessed,
    kpis,
    eventsPerSecond: wallMs > 0 ? totalEventsProcessed / (wallMs / 1000) : totalEventsProcessed,
    wallMs,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('DES FastForward throughput (plan-262 Phase 0 benchmark)', () => {
  it('drains a fixed-seed model to identical event counts and KPIs across runs', async () => {
    const a = await runReferenceModel(SEED);
    const b = await runReferenceModel(SEED);

    // The FF run completes and actually processed the line.
    expect(a.done).toBe(true);
    expect(b.done).toBe(true);
    expect(a.totalEventsProcessed).toBeGreaterThan(0);
    expect(a.kpis.consumed).toBeGreaterThan(0);

    // Result parity — the determinism gate for every FF batching change.
    expect(a.totalEventsProcessed).toBe(b.totalEventsProcessed);
    expect(a.kpis).toEqual(b.kpis);

    // Throughput: log only (CI-flaky as an assertion), smoke-check > 0.
    expect(a.eventsPerSecond).toBeGreaterThan(0);
    console.info(
      `[bench] FF throughput: run A ${Math.round(a.eventsPerSecond).toLocaleString('en-US')} events/s `
      + `(${a.totalEventsProcessed.toLocaleString('en-US')} events in ${a.wallMs.toFixed(0)} ms), `
      + `run B ${Math.round(b.eventsPerSecond).toLocaleString('en-US')} events/s (${b.wallMs.toFixed(0)} ms)`,
    );
  }, 120_000);
});
