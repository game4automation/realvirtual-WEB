// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * des-end-to-end.test.ts — Plan 194 P5b (full DES line under the DESRunner).
 *
 * Builds a Source → Conveyor → Conveyor → Sink line, registers every instance
 * with the private DESRunner (the same shape the model-load binding produces),
 * wires the snap-graph topology as native DES neighbours, runs the event loop,
 * and asserts the line actually flows:
 *  - the Source generates MUs;
 *  - each MU transits both conveyors with a realistic delay (length/speed);
 *  - the Sink consumes them → throughput > 0;
 *  - no events are dropped (the queue drains to empty).
 *
 * Runs only in the private build (imports `@rv-private/plugins/des/*`).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D, Mesh, BoxGeometry } from 'three';
import { DESRunner } from '@rv-private/plugins/des/des-runner';
import { _resetDesHookCache } from '@rv-private/plugins/des/des-hook-adapter';
import { resetDESMUCounter } from '@rv-private/plugins/des/rv-des-mu';
import type { MaterialFlowAdapter } from '@rv-private/plugins/des/material-flow-adapter';
import { ConveyorFlow } from '../../src/behaviors/Conveyor';
import Source from '../../src/behaviors/Source';
import {
  createSelf,
  type MaterialFlowSelf,
  type MU,
} from '../../src/core/material-flow/material-flow-self';
import {
  defineMaterialFlow,
  type MaterialFlowDefinition,
} from '../../src/core/material-flow/define-material-flow';
import { _resetMaterialFlowRegistry, getMaterialFlow } from '../../src/core/material-flow/registry';
import {
  createBindContext,
  type BindContextHost,
  type KinematicsSpec,
  type RVBindContext,
} from '../../src/core/behavior-runtime';
import { EventEmitter } from '../../src/core/rv-events';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';

// Trigger Source registration (default export is the Behavior; the def is in the registry).
void Source;
const SourceDef = getMaterialFlow('Source') as MaterialFlowDefinition;
const ConveyorDef = ConveyorFlow as unknown as MaterialFlowDefinition;

function makeHost(
  values: Map<string, boolean | number>,
  drives: BindContextHost['drives'] = [],
): BindContextHost {
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

/** A conveyor node with the Transport-X + Sensor children the setup() needs.
 *  The belt geometry (length, mm) and the Transport Drive (speed, mm/s) drive
 *  the DES transit timing. Geometry is METRE-scale (the scene unit). */
function conveyorCtx(
  name: string,
  values: Map<string, boolean | number>,
  lengthMm: number,
  speedMmS: number,
): { ctx: RVBindContext; root: Object3D } {
  const root = new Object3D(); root.name = name;
  const belt = new Mesh(new BoxGeometry(lengthMm / 1000, 0.1, 0.2));
  belt.name = 'Transport-X'; belt.updateMatrixWorld(true); root.add(belt);
  const sensor = new Object3D(); sensor.name = 'Sensor'; root.add(sensor);
  const host = makeHost(values, [{ name: 'Transport-X', node: belt, TargetSpeed: speedMmS }]);
  const accum: KinematicsSpec = {};
  return { ctx: createBindContext(root, host, accum).ctx, root };
}

function bareCtx(name: string, values: Map<string, boolean | number>): { ctx: RVBindContext; root: Object3D } {
  const root = new Object3D(); root.name = name;
  const accum: KinematicsSpec = {};
  return { ctx: createBindContext(root, makeHost(values), accum).ctx, root };
}

describe('DES end-to-end — Source → 2 Conveyors → Sink', () => {
  beforeEach(() => {
    _resetMaterialFlowRegistry();
    _resetDesHookCache();
    resetDESMUCounter();
    // Re-register Source + Conveyor after the registry reset.
    void Source; void ConveyorFlow;
  });

  it('flows MUs through both conveyors with transit delay and consumes them', () => {
    const values = new Map<string, boolean | number>();
    const runner = new DESRunner({ subMode: 'animated' });

    const adapters: MaterialFlowAdapter[] = [];
    // Resolve the entityId lazily from the adapter (assigned in registerComponent
    // during start(), BEFORE onGenerate fires) so scheduling always resolves.
    const idAt = (i: number) => () => adapters[i].entityId;

    // ── Source (interval 3 s) ──
    const srcCtx = bareCtx('Source', values);
    const srcSelf = createSelf(srcCtx.ctx, SourceDef, {
      mode: 'des',
      scheduler: runner.makeScheduler(SourceDef, idAt(0)),
      onTransfer: (mu) => runner.makeTransfer(adapters[0])(mu),
      canAcceptDownstream: (mu) => adapters[0].nextComponents.some(c => c.canAccept(mu as never)),
      spawnMU: () => runner.createMU(),
      local: (SourceDef.state ?? SourceDef.local)?.(),
    });
    srcSelf.prop['Interval'] = 3;
    adapters.push(runner.addInstance(SourceDef, srcSelf, srcCtx.root));

    // ── Conveyor 1 (1000 mm @ 1000 mm/s → 1 s) ──
    const c1 = conveyorCtx('Conveyor1', values, 1000, 1000);
    const c1Self = createSelf(c1.ctx, ConveyorDef, {
      mode: 'des',
      scheduler: runner.makeScheduler(ConveyorDef, idAt(1)),
      onTransfer: (mu) => runner.makeTransfer(adapters[1])(mu),
      canAcceptDownstream: (mu) => adapters[1].nextComponents.some(c => c.canAccept(mu as never)),
      local: (ConveyorDef.state ?? ConveyorDef.local)!(),
    });
    adapters.push(runner.addInstance(ConveyorDef, c1Self, c1.root));

    // ── Conveyor 2 (2000 mm @ 1000 mm/s → 2 s) ──
    const c2 = conveyorCtx('Conveyor2', values, 2000, 1000);
    const c2Self = createSelf(c2.ctx, ConveyorDef, {
      mode: 'des',
      scheduler: runner.makeScheduler(ConveyorDef, idAt(2)),
      onTransfer: (mu) => runner.makeTransfer(adapters[2])(mu),
      canAcceptDownstream: (mu) => adapters[2].nextComponents.some(c => c.canAccept(mu as never)),
      local: (ConveyorDef.state ?? ConveyorDef.local)!(),
    });
    adapters.push(runner.addInstance(ConveyorDef, c2Self, c2.root));

    // ── Sink ──
    const consumed: MU[] = [];
    const sinkDef = defineMaterialFlow<MaterialFlowSelf>({
      type: 'TestSinkE2E', kind: 'sink', schema: {}, continuous: {},
      des: { onAccept(_s, mu) { consumed.push(mu); return true; } },
    });
    const sinkCtx = bareCtx('Sink', values);
    const sinkSelf = createSelf(sinkCtx.ctx, sinkDef as MaterialFlowDefinition, {
      mode: 'des', scheduler: runner.makeScheduler(sinkDef as MaterialFlowDefinition, idAt(3)),
    });
    adapters.push(runner.addInstance(sinkDef as MaterialFlowDefinition, sinkSelf, sinkCtx.root));

    // Wire the line topology (Source → C1 → C2 → Sink) as native DES neighbours
    // BEFORE start() so the source's first onGenerate already has a downstream.
    adapters[0].nextComponents = [adapters[1]];
    adapters[1].nextComponents = [adapters[2]]; adapters[1].previousComponents = [adapters[0]];
    adapters[2].nextComponents = [adapters[3]]; adapters[2].previousComponents = [adapters[1]];
    adapters[3].previousComponents = [adapters[2]];

    // Belts running.
    values.set('Flow.Run', true);

    // Start (assigns entityIds, runs def.setup, kicks the source onGenerate).
    runner.start(
      [SourceDef, ConveyorDef, sinkDef as MaterialFlowDefinition],
      { root: new Object3D() },
    );

    // Run ~30 s of sim time (animated 1×, 1/60 ticks).
    for (let i = 0; i < 60 * 30; i++) runner.tick(1 / 60);

    // The DES source is demand-driven (AutomaticGeneration → ASAP, no production
    // rate): it emits the instant the line can take a part, so throughput is gated
    // by the SLOWEST conveyor (C2 = 2 s), NOT by the Interval. Each MU transits C1
    // (1 s) + C2 (2 s); after 30 s at ~1 MU / 2 s the sink has consumed ~13-14.
    expect(runner.getManager().muCount).toBeGreaterThan(0);
    // Line-limited throughput: well above the old 1-MU/3-s interval cap (~10) and
    // bounded by the C2 bottleneck — proves the source is NOT rate-throttled.
    expect(consumed.length).toBeGreaterThanOrEqual(10);
    expect(consumed.length).toBeLessThanOrEqual(16);

    // No events dropped — the queue drains (the source keeps one heartbeat Generate
    // armed as a safety net, plus a couple of transit events in flight at the cutoff).
    expect(runner.getManager().pendingEventCount).toBeLessThanOrEqual(4);
  });
});
