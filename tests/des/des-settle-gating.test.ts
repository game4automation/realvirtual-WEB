// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * des-settle-gating.test.ts — plan-262 Phase 2 (settle opt-in via
 * `des.samplesLiveGeometry`) + Phase 2b (script-hook safety, R4).
 *
 * Real DESRunner integration tests (build pattern: des-runner.test.ts /
 * des-fastforward-throughput.test.ts — createSelf + makeScheduler +
 * addInstance + start, NO FSM fakes):
 *  (a) conveyor-only model → `manager.onTimeAdvance === null`, zero
 *      `tweens.settle()` calls during FastForward, and the run result is
 *      IDENTICAL to the same model with the settle forced on (parity);
 *  (b) a model WITH a samplesLiveGeometry instance → settle wired, event
 *      handlers sample visuals at the EXACT event time;
 *  (c) the FF-EXIT settle in setSubMode fires ALWAYS (also with gating off);
 *  (d) a dynamic addInstance() after start() re-arms the settle counter;
 *  (e) active script components with DES hooks keep the settle on (R4),
 *      including the conservative no-probe fallback;
 *  (f) the DEV guard warns (once per type) when an unflagged type dispatches
 *      a hook against a mid-tween MU while the settle is off.
 *
 * Runs only in the private build (imports `@rv-private/plugins/des/*`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { DESRunner } from '@rv-private/plugins/des/des-runner';
import { _resetDesHookCache } from '@rv-private/plugins/des/des-hook-adapter';
import { resetDESMUCounter } from '@rv-private/plugins/des/rv-des-mu';
import type { MaterialFlowAdapter } from '@rv-private/plugins/des/material-flow-adapter';
import { RVScriptComponentAdapter } from '../../src/core/sdk/rv-script-component-adapter';
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

/** Add one instance (createSelf in DES mode + addInstance) to a runner. */
function addInstanceTo(
  runner: DESRunner,
  def: MaterialFlowDefinition,
  name: string,
): MaterialFlowAdapter {
  const node = new Object3D();
  node.name = name;
  const self = createSelf(makeBindContext(node), def, {
    mode: 'des',
    scheduler: runner.makeScheduler(def, () => adapter.entityId),
  });
  const adapter = runner.addInstance(def, self, node);
  return adapter;
}

// ─── (a) Reference line model — Source → 2 stations → Sink ─────────────────

const LINE_DURATION_S = 600; // 10 simulated minutes

interface LineResult {
  done: boolean;
  totalEventsProcessed: number;
  settleCalls: number;
  settleWired: boolean;
  kpis: { simTime: number; meanUtilization: number; throughputPerHour: number; consumed: number };
}

/**
 * Build + FastForward the reference line. `withLiveSampler` adds the
 * `samplesLiveGeometry` flag to the STATION type — the only difference between
 * the gated (settle off) and ungated (settle on) run.
 */
async function runLine(withLiveSampler: boolean): Promise<LineResult> {
  _resetMaterialFlowRegistry();
  _resetDesHookCache();
  resetDESMUCounter();

  const runner = new DESRunner({
    subMode: 'animated',
    durationSeconds: LINE_DURATION_S,
    masterSeed: 42,
  });

  const adapters: MaterialFlowAdapter[] = [];
  const idAt = (i: number) => () => adapters[i].entityId;

  const sourceDef = defineMaterialFlow<MaterialFlowSelf>({
    type: 'GateSource', kind: 'source', schema: {}, continuous: {},
    des: {
      onGenerate(self) {
        const mu = self.spawn();
        self.transfer(mu);
        self.in(1, 'Generate', null);
      },
    },
  }) as MaterialFlowDefinition;

  const stationDef = defineMaterialFlow<MaterialFlowSelf>({
    type: 'GateStation', kind: 'station', schema: {}, continuous: {},
    des: {
      ...(withLiveSampler ? { samplesLiveGeometry: true } : {}),
      onAccept(self, mu) { self.in(0.5, 'ProcessComplete', mu); return true; },
      onProcessComplete(self, mu) { if (mu) self.transfer(mu); },
    },
  }) as MaterialFlowDefinition;

  let consumed = 0;
  const sinkDef = defineMaterialFlow<MaterialFlowSelf>({
    type: 'GateSink', kind: 'sink', schema: {}, continuous: {},
    des: { onAccept() { consumed++; return true; } },
  }) as MaterialFlowDefinition;

  const add = (def: MaterialFlowDefinition, name: string, index: number): void => {
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

  add(sourceDef, 'Source', 0);
  add(stationDef, 'Station1', 1);
  add(stationDef, 'Station2', 2);
  add(sinkDef, 'Sink', 3);
  for (let i = 0; i < adapters.length - 1; i++) {
    adapters[i].nextComponents = [adapters[i + 1]];
    adapters[i + 1].previousComponents = [adapters[i]];
  }

  runner.start([sourceDef, stationDef, sinkDef], { root: new Object3D() });

  const settleWired = runner.getManager().onTimeAdvance !== null;
  const settleSpy = vi.spyOn(runner.getTweenRegistry(), 'settle');

  const done = await runner.runFastForward();

  const result: LineResult = {
    done,
    totalEventsProcessed: runner.getManager().totalEventsProcessed,
    settleCalls: settleSpy.mock.calls.length,
    settleWired,
    kpis: (() => {
      const s = runner.statistics();
      return {
        simTime: s.simTime,
        meanUtilization: s.meanUtilization,
        throughputPerHour: s.throughputPerHour,
        consumed,
      };
    })(),
  };
  settleSpy.mockRestore();
  runner.dispose();
  return result;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('DES settle gating (plan-262 Phase 2)', () => {
  beforeEach(() => {
    _resetMaterialFlowRegistry();
    _resetDesHookCache();
    resetDESMUCounter();
  });

  it('(a) conveyor-only line: settle unwired, zero settle calls in FF, result identical to the settle-on run', async () => {
    const gated = await runLine(false);   // no live sampler → settle OFF
    const settled = await runLine(true);  // station flagged → settle ON

    // Wiring: gated run has NO onTimeAdvance and never settles during FF.
    expect(gated.settleWired).toBe(false);
    expect(gated.settleCalls).toBe(0);
    expect(gated.done).toBe(true);

    // Control run: the flag wires the settle (and it actually fires).
    expect(settled.settleWired).toBe(true);
    expect(settled.settleCalls).toBeGreaterThan(0);
    expect(settled.done).toBe(true);

    // Result parity — skipping the settle must not change the simulation.
    expect(gated.totalEventsProcessed).toBe(settled.totalEventsProcessed);
    expect(gated.kpis).toEqual(settled.kpis);
    expect(gated.totalEventsProcessed).toBeGreaterThan(0);
    expect(gated.kpis.consumed).toBeGreaterThan(0);
  }, 60_000);

  it('(b) a samplesLiveGeometry instance wires the settle — event handlers sample visuals at the EXACT event time', () => {
    const target = { pos: new Vector3(), setPosition(v: Vector3) { this.pos.copy(v); } };
    const sampled: number[] = [];

    const def = defineMaterialFlow<MaterialFlowSelf>({
      type: 'LiveSampler', kind: 'source', schema: {}, continuous: {},
      des: {
        samplesLiveGeometry: true,
        onGenerate(self) {
          self.at(1.0, 'Arrival', null);
          self.at(2.0, 'Arrival', null);
          self.at(3.0, 'Arrival', null);
        },
        onArrival() { sampled.push(target.pos.x); },
      },
    }) as MaterialFlowDefinition;

    const runner = new DESRunner({ subMode: 'fastforward' });
    addInstanceTo(runner, def, 'LiveSampler1');
    runner.start([def], { root: new Object3D() });

    expect(runner.getManager().onTimeAdvance).not.toBe(null);

    // Position tween 0→10 over 2s; all three events process in ONE FF tick
    // without a render in between — only the event-time settle positions them.
    runner.getTweenRegistry().addPosition(target, new Vector3(0, 0, 0), new Vector3(10, 0, 0), 0, 2);
    runner.tick(0.016);
    runner.lateTick(0.016);

    expect(sampled).toHaveLength(3);
    expect(sampled[0]).toBeCloseTo(5);   // t=1: mid-tween — EXACT event time
    expect(sampled[1]).toBeCloseTo(10);  // t=2: finished exactly now
    expect(sampled[2]).toBeCloseTo(10);  // t=3: stays at the end position
    runner.dispose();
  });

  it('(c) the FF-EXIT settle fires ALWAYS — also when the per-event settle is gated off', () => {
    const target = { pos: new Vector3(), setPosition(v: Vector3) { this.pos.copy(v); } };

    // Unflagged type → per-event settle OFF.
    const def = defineMaterialFlow<MaterialFlowSelf>({
      type: 'ExitOnly', kind: 'source', schema: {}, continuous: {},
      des: { onGenerate(self) { self.at(4.0, 'Arrival', null); }, onArrival() { /* no-op */ } },
    }) as MaterialFlowDefinition;

    const runner = new DESRunner({ subMode: 'fastforward' });
    addInstanceTo(runner, def, 'ExitOnly1');
    runner.start([def], { root: new Object3D() });
    expect(runner.getManager().onTimeAdvance).toBe(null); // gating off

    const settleSpy = vi.spyOn(runner.getTweenRegistry(), 'settle');

    // Long-running tween (0→100 over 10s); FF advances the clock to 4.0 but
    // (settle off + FF noWrite) never writes the target mid-run.
    runner.getTweenRegistry().addPosition(target, new Vector3(0, 0, 0), new Vector3(100, 0, 0), 0, 10);
    runner.tick(0.016);
    runner.lateTick(0.016);
    expect(runner.simTime).toBeCloseTo(4.0);
    expect(settleSpy).not.toHaveBeenCalled();
    expect(target.pos.x).toBeCloseTo(0); // stranded at pre-FF position

    // Leaving FF: the UNCONDITIONAL exit settle snaps it to the exact sim position.
    runner.setSubMode('animated');
    expect(settleSpy).toHaveBeenCalled();
    expect(target.pos.x).toBeCloseTo(40); // 4s of 10s → 40%
    runner.dispose();
  });

  it('(d) a dynamic addInstance() after start() re-arms the settle counter; dispose() unwires it', () => {
    const plainDef = defineMaterialFlow<MaterialFlowSelf>({
      type: 'PlainConveyor', kind: 'conveyor', schema: {}, continuous: {},
      des: { onArrival() { /* no-op */ } },
    }) as MaterialFlowDefinition;
    const liveDef = defineMaterialFlow<MaterialFlowSelf>({
      type: 'LateLive', kind: 'station', schema: {}, continuous: {},
      des: { samplesLiveGeometry: true, onArrival() { /* no-op */ } },
    }) as MaterialFlowDefinition;

    const runner = new DESRunner({ subMode: 'animated' });
    addInstanceTo(runner, plainDef, 'Plain1');
    runner.start([plainDef], { root: new Object3D() });
    expect(runner.getManager().onTimeAdvance).toBe(null);

    // A live-geometry sampler added at runtime must re-wire the settle NOW.
    addInstanceTo(runner, liveDef, 'Late1');
    expect(runner.getManager().onTimeAdvance).not.toBe(null);

    runner.dispose();
    expect(runner.getManager().onTimeAdvance).toBe(null);
  });

  it('(e) active script components with DES hooks keep the settle on (R4) — incl. conservative no-probe fallback', () => {
    const plainDef = defineMaterialFlow<MaterialFlowSelf>({
      type: 'PlainConveyor2', kind: 'conveyor', schema: {}, continuous: {},
      des: { onArrival() { /* no-op */ } },
    }) as MaterialFlowDefinition;

    const runner = new DESRunner({ subMode: 'animated' });
    addInstanceTo(runner, plainDef, 'Plain2');
    runner.start([plainDef], { root: new Object3D() });
    expect(runner.getManager().onTimeAdvance).toBe(null);

    const stateApi = {
      captureScriptState: () => null,
      restoreScriptState: () => { /* no-op */ },
    };

    // Script component WITH DES hooks → settle stays on (behavior as today).
    runner.setScriptComponentSource(() => [
      { path: 'Cell/Script1', adapter: { ...stateApi, hasDesHooks: () => true } },
    ]);
    expect(runner.getManager().onTimeAdvance).not.toBe(null);

    // Script component WITHOUT DES hooks → gating applies again.
    runner.setScriptComponentSource(() => [
      { path: 'Cell/Script1', adapter: { ...stateApi, hasDesHooks: () => false } },
    ]);
    expect(runner.getManager().onTimeAdvance).toBe(null);

    // No probe at all (older/structural adapter) → conservative: settle on.
    runner.setScriptComponentSource(() => [
      { path: 'Cell/Script2', adapter: stateApi },
    ]);
    expect(runner.getManager().onTimeAdvance).not.toBe(null);

    runner.setScriptComponentSource(null);
    runner.dispose();
  });

  it('(e2) RVScriptComponentAdapter.hasDesHooks(): unattached → conservative true; disposed → false', () => {
    const adapter = new RVScriptComponentAdapter();
    expect(adapter.hasDesHooks()).toBe(true); // not attached yet → unknown → true
    adapter.dispose();
    expect(adapter.hasDesHooks()).toBe(false);
  });
});

describe('DES settle gating — DEV guard (plan-262 Phase 2 safety net)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetMaterialFlowRegistry();
    _resetDesHookCache();
    resetDESMUCounter();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('(f) warns ONCE per type when an unflagged hook dispatches against a mid-tween MU while the settle is off', () => {
    const target = { pos: new Vector3(), setPosition(v: Vector3) { this.pos.copy(v); } };

    const def = defineMaterialFlow<MaterialFlowSelf>({
      type: 'GuardType', kind: 'station', schema: {}, continuous: {},
      des: { onArrival() { /* pretend to sample geometry */ } },
    }) as MaterialFlowDefinition;

    const runner = new DESRunner({ subMode: 'fastforward' });
    const adapter = addInstanceTo(runner, def, 'Guard1');
    runner.start([def], { root: new Object3D() });
    expect(runner.getManager().onTimeAdvance).toBe(null); // settle off

    // An MU whose visual is mid-tween at dispatch time.
    const mu = runner.createMU();
    (mu as { visual?: unknown }).visual = target;
    runner.getTweenRegistry().addPosition(target, new Vector3(0, 0, 0), new Vector3(10, 0, 0), 0, 10);

    adapter.dispatchHook('Arrival', mu as unknown as MU, undefined, undefined);
    const settleWarnings = warnSpy.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('samplesLiveGeometry'),
    );
    expect(settleWarnings).toHaveLength(1);
    expect(settleWarnings[0][0]).toContain("'GuardType.Arrival'");

    // Warn-once per type: a second dispatch stays silent.
    adapter.dispatchHook('Arrival', mu as unknown as MU, undefined, undefined);
    expect(
      warnSpy.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('samplesLiveGeometry'),
      ),
    ).toHaveLength(1);

    runner.dispose();
  });

  it('does NOT warn when the type declares samplesLiveGeometry (settle is on)', () => {
    const target = { pos: new Vector3(), setPosition(v: Vector3) { this.pos.copy(v); } };

    const def = defineMaterialFlow<MaterialFlowSelf>({
      type: 'FlaggedGuard', kind: 'station', schema: {}, continuous: {},
      des: { samplesLiveGeometry: true, onArrival() { /* no-op */ } },
    }) as MaterialFlowDefinition;

    const runner = new DESRunner({ subMode: 'fastforward' });
    const adapter = addInstanceTo(runner, def, 'Flagged1');
    runner.start([def], { root: new Object3D() });

    const mu = runner.createMU();
    (mu as { visual?: unknown }).visual = target;
    runner.getTweenRegistry().addPosition(target, new Vector3(0, 0, 0), new Vector3(10, 0, 0), 0, 10);

    adapter.dispatchHook('Arrival', mu as unknown as MU, undefined, undefined);
    expect(
      warnSpy.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('samplesLiveGeometry'),
      ),
    ).toHaveLength(0);
    runner.dispose();
  });
});
