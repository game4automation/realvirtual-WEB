// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * conveyor-des-timing.test.ts — Plan 194 P5b (Conveyor DES transit timing).
 *
 * Verifies the unified Conveyor `des` block under the private DESRunner:
 *  - an accepted MU is NOT released immediately — it is held for the full-belt
 *    transit time of SIM time, then released to the downstream;
 *  - `transitTime = length / speed` (length from the belt geometry, speed from
 *    the Transport Drive; the `Math.max(0.001, …)` guard keeps transit finite);
 *  - back-pressure: when the downstream cannot accept, the MU is parked in
 *    `blockedMUs` and released once the downstream frees (onDownstreamReady).
 *
 * Imports `@rv/plugins/des/*` — DES is core code since plan-680.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D, Mesh, BoxGeometry } from 'three';
import { DESRunner } from '@rv/plugins/des/des-runner';
import { _resetDesHookCache } from '@rv/plugins/des/des-hook-adapter';
import { resetDESMUCounter } from '@rv/plugins/des/rv-des-mu';
import { ConveyorFlow } from '../../src/behaviors/Conveyor';
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

const ConveyorDef = ConveyorFlow as unknown as MaterialFlowDefinition;

/** The conveyor's DES-relevant local fields (private to Conveyor.ts — re-stated).
 *  The transit-timing model lives on `local.timer` (createTransitTimer);
 *  `speed`/`length`/`transitTime` come from the Transport Drive + belt geometry. */
interface ConvLocalView {
  timer: { transitTime: number; speed: number; length: number } | null;
  blockedMUs: MU[];
}
type ConvSelf = MaterialFlowSelf<ConvLocalView>;

// ─── Minimal bind context with a Conveyor node (Transport-X + Sensor) ─────

function makeConveyorContext(
  name: string,
  lengthMm: number,
  speedMmS: number,
): { ctx: RVBindContext; root: Object3D } {
  const events = new EventEmitter<Record<string, unknown>>();
  const values = new Map<string, boolean | number>();
  const root = new Object3D(); root.name = name;
  // Belt geometry in METRES (the scene unit): lengthMm/1000 → world-bounds
  // extent; resolveLength scales it back ×1000 to mm. A real Mesh so
  // Box3.expandByObject yields finite bounds.
  const belt = new Mesh(new BoxGeometry(lengthMm / 1000, 0.1, 0.2));
  belt.name = 'Transport-X'; belt.updateMatrixWorld(true); root.add(belt);
  const sensor = new Object3D(); sensor.name = 'Sensor'; root.add(sensor);
  const host: BindContextHost = {
    signalStore: {
      get: (n: string) => values.get(n),
      set: (n: string, v: boolean | number) => values.set(n, v),
      subscribe: () => () => {},
    } as never,
    on: (e, cb) => events.on(e, cb as never),
    contextMenu: new ContextMenuStore(),
    // The Transport Drive provides the belt speed (mm/s) the DES timer reads.
    drives: [{ name: 'Transport-X', node: belt, TargetSpeed: speedMmS }] as never,
    registry: null,
    getPlugin: () => undefined,
  };
  const accum: KinematicsSpec = {};
  const { ctx } = createBindContext(root, host, accum);
  return { ctx, root };
}

function makeBareContext(name: string): RVBindContext {
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
  const root = new Object3D(); root.name = name;
  const accum: KinematicsSpec = {};
  const { ctx } = createBindContext(root, host, accum);
  return ctx;
}

/** Build a conveyor instance whose belt geometry (length, mm) and Transport
 *  Drive (speed, mm/s) drive the DES transit timing. */
function buildConveyor(runner: DESRunner, name: string, cfg: { length: number; speed: number }) {
  const { ctx, root } = makeConveyorContext(name, cfg.length, cfg.speed);
  let entityId = -1;
  const self = createSelf(ctx, ConveyorDef, {
    mode: 'des',
    scheduler: runner.makeScheduler(ConveyorDef, () => entityId),
    onTransfer: (mu) => runner.makeTransfer(adapter)(mu),
    // Mirror the model-load binding: the downstream probe queries the adapter's
    // wired nextComponents (set in the test after start()).
    canAcceptDownstream: (mu) =>
      adapter.nextComponents.length > 0 &&
      adapter.nextComponents.some(c => c.canAccept(mu as never)),
    local: (ConveyorDef.state ?? ConveyorDef.local)?.(),
  });
  const adapter = runner.addInstance(ConveyorDef, self, root, undefined, { desId: root.name + '@' + ConveyorDef.type });
  entityId = adapter.entityId; // assigned lazily after start(); refreshed below
  return {
    self: self as unknown as ConvSelf,
    adapter,
    root,
    refreshId: () => { entityId = adapter.entityId; },
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('Conveyor DES timing — transit delay', () => {
  beforeEach(() => {
    _resetMaterialFlowRegistry();
    _resetDesHookCache();
    resetDESMUCounter();
  });

  it('holds the MU for the transit time (length/speed), then releases it', () => {
    const runner = new DESRunner({ subMode: 'animated' });

    // Downstream sink records transferred MUs.
    const consumed: MU[] = [];
    const sinkDef = defineMaterialFlow<MaterialFlowSelf>({
      type: 'TestSinkA', kind: 'sink', schema: {}, continuous: {},
      des: { onAccept(_s, mu) { consumed.push(mu); return true; } },
    });
    const sinkNode = new Object3D(); sinkNode.name = 'SinkA';
    let sinkId = -1;
    const sinkSelf = createSelf(makeBareContext('SinkA'), sinkDef, {
      mode: 'des', scheduler: runner.makeScheduler(sinkDef as MaterialFlowDefinition, () => sinkId),
    });
    const sink = runner.addInstance(sinkDef as MaterialFlowDefinition, sinkSelf, sinkNode);

    // 1000 mm @ 200 mm/s → transit 5 s.
    const conv = buildConveyor(runner, 'Conveyor', { length: 1000, speed: 200 });

    runner.start([ConveyorDef, sinkDef as MaterialFlowDefinition], { root: conv.root });
    conv.refreshId();
    sinkId = sink.entityId;
    conv.adapter.nextComponents = [sink];
    conv.self.signals.set('Flow.Run', true); // belt running (ZPA: shouldFlow)

    // transitTime should equal length/speed = 5 s.
    expect(conv.self.local.timer!.transitTime).toBeCloseTo(5, 3);

    // Accept an MU → schedule arrival in 5 s; NOT released yet.
    const mu = runner.createMU();
    conv.adapter.acceptMU(mu as never);
    expect(conv.adapter.currentLoad).toBe(1);
    expect(consumed.length).toBe(0);

    // Advance < 5 s — still in transit.
    runner.tick(2.0);
    runner.tick(2.0);
    expect(consumed.length).toBe(0);

    // Cross 5 s — arrival fires → release to the sink.
    runner.tick(1.5);
    expect(consumed.length).toBe(1);
    expect(consumed[0].id).toBe(mu.id);
  });

  it('transit time follows length/speed and guards a non-positive drive speed', () => {
    const runner = new DESRunner({ subMode: 'animated' });
    runner.start([ConveyorDef], { root: new Object3D() });

    // 2000 mm @ 500 mm/s → 4 s. Built AFTER start(), so re-run the shared setup
    // to resolve timing from the belt geometry + drive.
    const fast = buildConveyor(runner, 'ConvFast', { length: 2000, speed: 500 });
    ConveyorDef.setup?.(fast.self as unknown as MaterialFlowSelf);
    expect(fast.self.local.timer!.transitTime).toBeCloseTo(4, 3);

    // A non-positive drive speed falls back to the default (200 mm/s) and the
    // Math.max(0.001, …) guard keeps the transit time finite & > 0.
    const stalled = buildConveyor(runner, 'ConvStalled', { length: 1000, speed: 0 });
    ConveyorDef.setup?.(stalled.self as unknown as MaterialFlowSelf);
    expect(Number.isFinite(stalled.self.local.timer!.transitTime)).toBe(true);
    expect(stalled.self.local.timer!.transitTime).toBeGreaterThan(0);
    expect(stalled.self.local.timer!.speed).toBeGreaterThanOrEqual(0.001);
  });

  it('back-pressure: holds the MU when the downstream is full, releases on ready', () => {
    const runner = new DESRunner({ subMode: 'animated' });

    // Downstream that REFUSES the first MU, then accepts.
    let accepting = false;
    const consumed: MU[] = [];
    const sinkDef = defineMaterialFlow<MaterialFlowSelf>({
      type: 'TestSinkB', kind: 'station', schema: {}, continuous: {},
      des: {
        canAccept() { return accepting; },
        onAccept(_s, mu) { consumed.push(mu); return true; },
      },
    });
    const sinkNode = new Object3D(); sinkNode.name = 'SinkB';
    let sinkId = -1;
    const sinkSelf = createSelf(makeBareContext('SinkB'), sinkDef, {
      mode: 'des', scheduler: runner.makeScheduler(sinkDef as MaterialFlowDefinition, () => sinkId),
    });
    const sink = runner.addInstance(sinkDef as MaterialFlowDefinition, sinkSelf, sinkNode);

    const conv = buildConveyor(runner, 'Conveyor', { length: 1000, speed: 1000 }); // 1 s

    runner.start([ConveyorDef, sinkDef as MaterialFlowDefinition], { root: conv.root });
    conv.refreshId();
    sinkId = sink.entityId;
    conv.adapter.nextComponents = [sink];
    conv.adapter.previousComponents = [];
    conv.self.signals.set('Flow.Run', true); // belt running (ZPA: shouldFlow)

    // Accept → transit 1 s. Downstream refuses → MU parks in blockedMUs.
    const mu = runner.createMU();
    conv.adapter.acceptMU(mu as never);
    runner.tick(1.5); // past the 1 s arrival → tryRelease blocked
    expect(consumed.length).toBe(0);
    expect(conv.self.local.blockedMUs.length).toBe(1);

    // Downstream frees → notify the conveyor → it retries the blocked MU.
    accepting = true;
    conv.adapter.onDownstreamReady(sink as never);
    expect(consumed.length).toBe(1);
    expect(conv.self.local.blockedMUs.length).toBe(0);
  });
});
