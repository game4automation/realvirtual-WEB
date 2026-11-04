// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * des-chain-robustness.test.ts — regressions of the DES chain errors found on
 * 2026-10-26 (a minimal DES chain placed in an empty planner scene, and the
 * `Test-DES-Turntable-Loop` fixture in DES mode).
 *
 *  1. A second DESManager in the GLOBAL slot must not redirect the runner's
 *     hooks: they resolve entity
 *     and MU ids in the manager that dispatches the event. Before: every hook
 *     resolved `DES.getManager()` → foreign component / null MU →
 *     `Conveyor.onArrival(null)` ("reading 'id'").
 *  3. A component that disabled itself in setup (a conveyor without Transport /
 *     Sensor nodes — a virtual 'Conveyor (Straight)' DES block) refuses every
 *     MU and is reported; before: `onAccept` read `timer.transitTime` of null.
 *  4. Source → Sink directly: the sink frees its slot inside the transfer; the
 *     synchronous wake must not re-enter the source ("Maximum call stack size
 *     exceeded"). The source then emits at its heartbeat interval.
 *  5. Each start registers every instance once — a reset no longer appends the
 *     same adapters to the manager again.
 *
 * Imports `@rv/plugins/des/*` — DES is core code since plan-680.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Object3D, Mesh, BoxGeometry } from 'three';
import { DESRunner } from '@rv/plugins/des/des-runner';
import { _resetDesHookCache } from '@rv/plugins/des/des-hook-adapter';
import { resetDESMUCounter } from '@rv/plugins/des/rv-des-mu';
import { DESManager } from '@rv/plugins/des/rv-des-manager';
import { DES } from '@rv/plugins/des/rv-des-api';
import type { MaterialFlowAdapter } from '@rv/plugins/des/material-flow-adapter';
import { ConveyorFlow } from '../../src/behaviors/Conveyor';
import Source from '../../src/behaviors/Source';
import { createSelf, type MaterialFlowSelf, type MU } from '../../src/core/material-flow/material-flow-self';
import { defineMaterialFlow, type MaterialFlowDefinition } from '../../src/core/material-flow/define-material-flow';
import { _resetMaterialFlowRegistry, getMaterialFlow } from '../../src/core/material-flow/registry';
import { createBindContext, type BindContextHost, type KinematicsSpec, type RVBindContext } from '../../src/core/behavior-runtime';
import { EventEmitter } from '../../src/core/rv-events';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';
import { clearAllProblems, getProblems } from '../../src/core/hmi/problems-store';

void Source;
// Captured at module load: the per-test registry reset below empties the registry.
const SourceDef = getMaterialFlow('Source') as MaterialFlowDefinition;
const ConveyorDef = ConveyorFlow as unknown as MaterialFlowDefinition;

function makeHost(values: Map<string, boolean | number>, drives: BindContextHost['drives'] = []): BindContextHost {
  const events = new EventEmitter<Record<string, unknown>>();
  return {
    signalStore: {
      get: (n: string) => values.get(n),
      set: (n: string, v: boolean | number) => values.set(n, v),
      subscribe: () => () => {},
    } as never,
    on: (e, cb) => events.on(e, cb as never),
    contextMenu: new ContextMenuStore(),
    drives: drives as never,
    registry: null,
    getPlugin: () => undefined,
  };
}

/** A conveyor node WITH the Transport-X + Sensor children its setup needs. */
function conveyorCtx(name: string, values: Map<string, boolean | number>, lengthMm: number, speedMmS: number): { ctx: RVBindContext; root: Object3D } {
  const root = new Object3D(); root.name = name;
  const belt = new Mesh(new BoxGeometry(lengthMm / 1000, 0.1, 0.2));
  belt.name = 'Transport-X'; belt.updateMatrixWorld(true); root.add(belt);
  const sensor = new Object3D(); sensor.name = 'Sensor'; root.add(sensor);
  const host = makeHost(values, [{ name: 'Transport-X', node: belt, TargetSpeed: speedMmS }]);
  const accum: KinematicsSpec = {};
  return { ctx: createBindContext(root, host, accum).ctx, root };
}

/** A node with no children — what a virtual DES block offers a name-bound type. */
function bareCtx(name: string, values: Map<string, boolean | number>): { ctx: RVBindContext; root: Object3D } {
  const root = new Object3D(); root.name = name;
  const accum: KinematicsSpec = {};
  return { ctx: createBindContext(root, makeHost(values), accum).ctx, root };
}

interface Line {
  runner: DESRunner;
  adapters: MaterialFlowAdapter[];
  consumed: MU[];
  defs: MaterialFlowDefinition[];
}

/** Source → [conveyors…] → Sink, wired as native DES neighbours. `conveyors`:
 *  `null` = a bare (disabling) conveyor node, a number = a real belt of that length. */
function buildLine(conveyors: Array<number | null>, sourceIntervalS = 3): Line {
  const values = new Map<string, boolean | number>([['Flow.Run', true]]);
  const runner = new DESRunner({ subMode: 'animated' });
  const adapters: MaterialFlowAdapter[] = [];
  const idAt = (i: number) => () => adapters[i].entityId;

  const srcCtx = bareCtx('Source', values);
  const srcSelf = createSelf(srcCtx.ctx, SourceDef, {
    mode: 'des',
    scheduler: runner.makeScheduler(SourceDef, idAt(0)),
    onTransfer: (mu) => runner.makeTransfer(adapters[0])(mu),
    canAcceptDownstream: (mu) => adapters[0].nextComponents.some(c => c.canAccept(mu as never)),
    spawnMU: () => runner.createMU(),
    local: (SourceDef.state ?? SourceDef.local)?.(),
  });
  srcSelf.prop['Interval'] = sourceIntervalS;
  adapters.push(runner.addInstance(SourceDef, srcSelf, srcCtx.root));

  conveyors.forEach((lengthMm, k) => {
    const i = adapters.length;
    const c = lengthMm === null ? bareCtx(`Conveyor${k}`, values) : conveyorCtx(`Conveyor${k}`, values, lengthMm, 1000);
    const self = createSelf(c.ctx, ConveyorDef, {
      mode: 'des',
      scheduler: runner.makeScheduler(ConveyorDef, idAt(i)),
      onTransfer: (mu) => runner.makeTransfer(adapters[i])(mu),
      canAcceptDownstream: (mu) => adapters[i].nextComponents.some(n => n.canAccept(mu as never)),
      local: (ConveyorDef.state ?? ConveyorDef.local)!(),
    });
    adapters.push(runner.addInstance(ConveyorDef, self, c.root));
  });

  const consumed: MU[] = [];
  const sinkDef = defineMaterialFlow<MaterialFlowSelf>({
    type: 'TestSinkRobust', kind: 'sink', schema: {}, continuous: {},
    des: { onAccept(_s, mu) { consumed.push(mu); return true; } },
  }) as MaterialFlowDefinition;
  const sinkIdx = adapters.length;
  const sinkCtx = bareCtx('Sink', values);
  const sinkSelf = createSelf(sinkCtx.ctx, sinkDef, { mode: 'des', scheduler: runner.makeScheduler(sinkDef, idAt(sinkIdx)) });
  adapters.push(runner.addInstance(sinkDef, sinkSelf, sinkCtx.root));

  for (let i = 0; i < adapters.length - 1; i++) {
    adapters[i].nextComponents = [adapters[i + 1]];
    adapters[i + 1].previousComponents = [adapters[i]];
  }
  return { runner, adapters, consumed, defs: [SourceDef, ConveyorDef, sinkDef] };
}

function run(line: Line, seconds: number): void {
  for (let i = 0; i < 60 * seconds; i++) line.runner.tick(1 / 60);
}

describe('DES chain robustness (2026-10-26)', () => {
  beforeEach(() => {
    _resetMaterialFlowRegistry();
    _resetDesHookCache();
    resetDESMUCounter();
    clearAllProblems();
    void Source; void ConveyorFlow;
  });
  afterEach(() => {
    DES.setManager(null);
    clearAllProblems();
  });

  it('hooks resolve ids in the dispatching manager, not in a foreign global one', () => {
    const line = buildLine([1000]);
    line.runner.start(line.defs, { root: new Object3D() });
    // A foreign global manager must not redirect the runner's events.
    DES.setManager(new DESManager());
    expect(() => run(line, 15)).not.toThrow();
    expect(line.consumed.length).toBeGreaterThanOrEqual(4);
  });


  it('a conveyor that disabled itself refuses MUs, is reported and never crashes', () => {
    const line = buildLine([null]);
    expect(() => {
      line.runner.start(line.defs, { root: new Object3D() });
      run(line, 10);
    }).not.toThrow();
    const conveyor = line.adapters[1];
    expect(conveyor.self.disabled).toBe(true);
    expect(conveyor.currentLoad).toBe(0);
    expect(line.consumed).toHaveLength(0);
    const p = getProblems().find(e => e.code === 'des-component-disabled');
    expect(p?.title).toContain('Conveyor0');
    expect(p?.detail).toContain('Transport');
  });

  it('Source → Sink directly emits at the source interval instead of recursing', () => {
    const line = buildLine([], 2);
    expect(() => {
      line.runner.start(line.defs, { root: new Object3D() });
      run(line, 10);
    }).not.toThrow();
    // First part at t=0, then one per 2 s heartbeat: 5-6 parts in 10 s.
    expect(line.consumed.length).toBeGreaterThanOrEqual(5);
    expect(line.consumed.length).toBeLessThanOrEqual(7);
  });

  it('a reset re-registers each instance once (no growing component list)', () => {
    const line = buildLine([1000]);
    line.runner.start(line.defs, { root: new Object3D() });
    run(line, 3);
    line.runner.reset();
    run(line, 3);
    line.runner.reset();
    const mgr = line.runner.getManager();
    expect(mgr.componentCount).toBe(line.adapters.length);
    line.adapters.forEach((a, i) => expect(mgr.getComponentByEntityId(a.entityId)).toBe(line.adapters[i]));
    expect(() => run(line, 10)).not.toThrow();
    expect(line.consumed.length).toBeGreaterThan(0);
  });
});
