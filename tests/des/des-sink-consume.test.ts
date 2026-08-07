// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * des-sink-consume.test.ts — regression for the line-tail sink deadlock.
 *
 * A sink CONSUMES MUs (it never retains or forwards them), so it must have
 * unlimited capacity and free its load slot on every accept. The unified
 * material-flow Sink behavior builds on `DESComponent`, whose default
 * `MaxCapacity = 1`: before the fix, a sink accepted ONE MU (which onAccept
 * destroyed) but, having nothing to forward, never called `releaseMU`, so
 * `currentLoad` stayed pinned at 1. The conveyor feeding it then saw the sink as
 * permanently full and the whole line deadlocked after the first part.
 *
 * This builds Source → Conveyor → Sink (the REAL `behaviors/Sink.ts` def, the
 * one a placed *Sink* asset binds to) and asserts the sink keeps consuming:
 *  - many parts pass through (NOT capped at 1);
 *  - the sink's load returns to 0 (slot freed, never accumulates);
 *  - `totalProcessed` counts throughput;
 *  - the event queue drains (no permanent block).
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
import Sink from '../../src/behaviors/Sink';
import { createSelf } from '../../src/core/material-flow/material-flow-self';
import { type MaterialFlowDefinition } from '../../src/core/material-flow/define-material-flow';
import { _resetMaterialFlowRegistry, getMaterialFlow } from '../../src/core/material-flow/registry';
import {
  createBindContext,
  type BindContextHost,
  type KinematicsSpec,
  type RVBindContext,
} from '../../src/core/behavior-runtime';
import { EventEmitter } from '../../src/core/rv-events';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';

// Trigger registration; the defs live in the material-flow registry.
void Source; void Sink; void ConveyorFlow;
const SourceDef = getMaterialFlow('Source') as MaterialFlowDefinition;
const SinkDef = getMaterialFlow('Sink') as MaterialFlowDefinition;
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

describe('DES sink consume — no line-tail deadlock', () => {
  beforeEach(() => {
    _resetMaterialFlowRegistry();
    _resetDesHookCache();
    resetDESMUCounter();
    void Source; void Sink; void ConveyorFlow;
  });

  it('keeps consuming parts and frees its load slot (not capped at 1)', () => {
    const values = new Map<string, boolean | number>();
    const runner = new DESRunner({ subMode: 'animated' });

    const adapters: MaterialFlowAdapter[] = [];
    const idAt = (i: number) => () => adapters[i].entityId;

    // ── Source (interval 1 s → ~20 parts in 20 s) ──
    const srcCtx = bareCtx('Source', values);
    const srcSelf = createSelf(srcCtx.ctx, SourceDef, {
      mode: 'des',
      scheduler: runner.makeScheduler(SourceDef, idAt(0)),
      onTransfer: (mu) => runner.makeTransfer(adapters[0])(mu),
      canAcceptDownstream: (mu) => adapters[0].nextComponents.some(c => c.canAccept(mu as never)),
      spawnMU: () => runner.createMU(),
      local: (SourceDef.state ?? SourceDef.local)?.(),
    });
    srcSelf.prop['Interval'] = 1;
    adapters.push(runner.addInstance(SourceDef, srcSelf, srcCtx.root));

    // ── Conveyor (500 mm @ 1000 mm/s → 0.5 s transit) ──
    const c1 = conveyorCtx('Conveyor1', values, 500, 1000);
    const c1Self = createSelf(c1.ctx, ConveyorDef, {
      mode: 'des',
      scheduler: runner.makeScheduler(ConveyorDef, idAt(1)),
      onTransfer: (mu) => runner.makeTransfer(adapters[1])(mu),
      canAcceptDownstream: (mu) => adapters[1].nextComponents.some(c => c.canAccept(mu as never)),
      local: (ConveyorDef.state ?? ConveyorDef.local)!(),
    });
    adapters.push(runner.addInstance(ConveyorDef, c1Self, c1.root));

    // ── Sink (the REAL behaviors/Sink.ts def — kind:'sink', onAccept destroys) ──
    const sinkCtx = bareCtx('PalletSink', values);
    const sinkSelf = createSelf(sinkCtx.ctx, SinkDef, {
      mode: 'des', scheduler: runner.makeScheduler(SinkDef, idAt(2)),
    });
    adapters.push(runner.addInstance(SinkDef, sinkSelf, sinkCtx.root));

    // Wire Source → Conveyor → Sink as native DES neighbours.
    adapters[0].nextComponents = [adapters[1]];
    adapters[1].nextComponents = [adapters[2]]; adapters[1].previousComponents = [adapters[0]];
    adapters[2].previousComponents = [adapters[1]];

    values.set('Flow.Run', true);
    runner.start([SourceDef, ConveyorDef, SinkDef], { root: new Object3D() });

    // Run 20 s of sim time (animated 1×).
    for (let i = 0; i < 60 * 20; i++) runner.tick(1 / 60);

    const sink = adapters[2];
    // Before the fix the sink jams at the first part (load pinned to 1, conveyor
    // blocked) — totalProcessed would be 0 and throughput capped at 1.
    expect(sink.totalProcessed).toBeGreaterThanOrEqual(5);
    // The slot must be freed after every consume — a sink never accumulates load.
    expect(sink.currentLoad).toBe(0);
    // The line keeps flowing: the event queue drains to a small bounded backlog.
    expect(runner.getManager().pendingEventCount).toBeLessThanOrEqual(3);
  });
});
