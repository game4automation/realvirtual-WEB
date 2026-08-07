// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { beforeEach, describe, expect, it } from 'vitest';
import type { BindContextHost } from '../../src/core/behavior-runtime';
import { EventEmitter } from '../../src/core/rv-events';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { _resetDesHookCache } from '@rv-private/plugins/des/des-hook-adapter';
import { resetDESMUCounter } from '@rv-private/plugins/des/rv-des-mu';
import {
  ROBOT_LOADING_REFERENCE_DURATION_SECONDS,
  ROBOT_LOADING_REFERENCE_SEED,
  createRobotLoadingDemoRuntime,
  robotLoadingDemoResult,
  type RobotLoadingDemoOptions,
  type RobotLoadingDemoResult,
} from '@rv-private/plugins/des/material-flow/demo-robot-loading';

function host(): BindContextHost {
  const values = new Map<string, boolean | number>();
  const events = new EventEmitter<Record<string, unknown>>();
  return {
    signalStore: {
      get: (name: string) => values.get(name),
      set: (name: string, value: boolean | number) => values.set(name, value),
      subscribe: () => () => {},
    } as never,
    on: (event, callback) => events.on(event, callback as never),
    contextMenu: new ContextMenuStore(),
    drives: [] as never,
    registry: null,
    getPlugin: () => undefined,
  };
}

interface CompletedRun {
  readonly result: RobotLoadingDemoResult;
  readonly wallMs: number;
}

async function runToCompletion(options: RobotLoadingDemoOptions): Promise<CompletedRun> {
  _resetDesHookCache();
  resetDESMUCounter();
  getDefaultPathNetwork().clear();
  const runtime = createRobotLoadingDemoRuntime(host(), options);
  try {
    const startedAt = performance.now();
    expect(await runtime.runner.runFastForward()).toBe(true);
    const wallMs = performance.now() - startedAt;
    return { result: robotLoadingDemoResult(runtime), wallMs };
  } finally {
    runtime.runner.dispose();
    getDefaultPathNetwork().clear();
  }
}

function expectCleanCompletedRun(
  result: RobotLoadingDemoResult,
  expected: { pallets: number; parts: number; totalMUs: number; emptyCarriers: number; duration: number },
): void {
  expect(result.simTime).toBe(expected.duration);
  expect(result.generatedPallets).toBe(expected.pallets);
  expect(result.createdMUs).toBe(expected.totalMUs);
  expect(result.partThroughput).toBe(expected.parts);
  expect(result.emptyCarrierThroughput).toBe(expected.emptyCarriers);
  expect(result.liveMUs).toBe(0);
  expect(result.pendingEvents).toBe(0);
  expect(result.activeReservations).toBe(0);
  expect(result.horizonReached).toBe(true);
  expect(Object.values(result.componentLoads).every((load) => load === 0)).toBe(true);
}

describe('DES robot-loading reference layout (plan-297 Phase 7)', () => {
  beforeEach(() => {
    _resetDesHookCache();
    resetDESMUCounter();
    getDefaultPathNetwork().clear();
  });

  it('builds virtual nodes, wires the logical layout, and completes deterministically', async () => {
    const options: RobotLoadingDemoOptions = {
      palletCount: 2,
      blistersPerPallet: 2,
      partsPerBlister: 4,
      masterSeed: 297,
      durationSeconds: 600,
    };
    const probe = createRobotLoadingDemoRuntime(host(), options);
    try {
      expect(probe.boundCount).toBe(11);
      expect(probe.nodes.get('PalletInput-01')?.userData.realvirtual.LayoutObject.virtual).toBe(true);
      expect(probe.nodes.get('IndexingConveyor')?.getObjectByName('Carrier-20')).toBeDefined();
      expect(probe.nodes.get('PathTransport')?.getObjectByName('Path-Reference')).toBeDefined();
      expect(probe.logicalConnections).toContainEqual({
        from: 'RobotHandling', to: 'IndexingConveyor', port: 'out',
      });
      expect(probe.logicalConnections).toContainEqual({
        from: 'RobotHandling', to: 'EmptyCarrierBuffer', port: 'empty',
      });
      const states = new Map(probe.runner.componentStates().map((state) => [state.name, state]));
      expect(states.get('RobotHandling')?.next).toEqual(['IndexingConveyor', 'EmptyCarrierBuffer']);
      expect(states.get('IndexingConveyor')?.next).toEqual(['Station']);
      expect(states.get('Station')?.next).toEqual(['PathTransport']);
      expect(states.get('PathTransport')?.next).toEqual(['Sink']);
    } finally {
      probe.runner.dispose();
      getDefaultPathNetwork().clear();
    }

    const a = await runToCompletion(options);
    const b = await runToCompletion(options);
    expectCleanCompletedRun(a.result, {
      pallets: 2,
      parts: 16,
      totalMUs: 22,
      emptyCarriers: 6,
      duration: 600,
    });
    expect(a.result).toEqual(b.result);
  }, 120_000);

  it('measures the 8 h reference load without asserting machine-dependent wall time', async () => {
    const options: RobotLoadingDemoOptions = {
      palletCount: 10,
      blistersPerPallet: 10,
      partsPerBlister: 20,
      masterSeed: ROBOT_LOADING_REFERENCE_SEED,
      durationSeconds: ROBOT_LOADING_REFERENCE_DURATION_SECONDS,
    };
    const a = await runToCompletion(options);
    const b = await runToCompletion(options);
    expectCleanCompletedRun(a.result, {
      pallets: 10,
      parts: 2_000,
      totalMUs: 2_110,
      emptyCarriers: 110,
      duration: ROBOT_LOADING_REFERENCE_DURATION_SECONDS,
    });
    expect(a.result).toEqual(b.result);
    expect(a.wallMs).toBeGreaterThan(0);
    expect(b.wallMs).toBeGreaterThan(0);
    console.info(
      `[plan-297] 8 h FastForward reference load: run A ${a.wallMs.toFixed(1)} ms, `
      + `run B ${b.wallMs.toFixed(1)} ms; ${a.result.totalEventsProcessed} events; `
      + `${a.result.partThroughput} parts consumed`,
    );
  }, 120_000);
});
