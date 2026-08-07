// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * des-runner-gc-paths.test.ts — the GC-free hot paths of the DES scheduler.
 *
 * The scheduler resolves the named-action INDEX once at registration and
 * schedules by index; a REGISTERED MU rides the queue as its integer id and is
 * resolved back at dispatch — no per-event string building and no payload
 * object unless real user data (or an unregistered MU) travels along. Sink
 * consumes feed a pending list the runner drains on lateTick, instead of
 * scanning every MU ever registered per frame.
 *
 * Verifies:
 *  - a registered MU arrives at the hook as the IDENTICAL object, with the
 *    serialized event carrying data:null (no side-channel payload);
 *  - an unregistered MU literal still reaches the hook (payload fallback);
 *  - user data still travels through the side-channel;
 *  - a sink-consumed MU's visual is disposed exactly once via the pending list.
 *
 * Runs only in the private build (imports `@rv-private/plugins/des/*`).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import { DESRunner } from '@rv-private/plugins/des/des-runner';
import { _resetDesHookCache } from '@rv-private/plugins/des/des-hook-adapter';
import { resetDESMUCounter } from '@rv-private/plugins/des/rv-des-mu';
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

// ─── Minimal bind context (mirrors des-runner.test.ts) ────────────────────

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

beforeEach(() => {
  _resetMaterialFlowRegistry();
  _resetDesHookCache();
  resetDESMUCounter();
});

describe('DESRunner — MU rides the queue as its integer id', () => {
  it('a registered MU arrives IDENTICAL at the hook, with NO side-channel payload', () => {
    let receivedMu: MU | null = null;
    const def = defineMaterialFlow<MaterialFlowSelf>({
      type: 'GcConv',
      kind: 'conveyor',
      schema: {},
      continuous: {},
      des: {
        onArrival(_self, mu) { receivedMu = mu; },
      },
    });

    const runner = new DESRunner({ subMode: 'animated' });
    const node = new Object3D(); node.name = 'GcConv1';
    const self = createSelf(makeBindContext(node), def, {
      mode: 'des',
      scheduler: runner.makeScheduler(def as MaterialFlowDefinition, () => adapter.entityId),
    });
    const adapter = runner.addInstance(def as MaterialFlowDefinition, self, node);
    runner.start([def as MaterialFlowDefinition], { root: node });

    const mu = runner.createMU(); // registered → id ≥ 0
    expect(mu.id).toBeGreaterThanOrEqual(0);
    self.in(1, 'Arrival', mu as unknown as MU);

    // The queue carries the integer muId; the serialized event has NO payload.
    const snap = runner.getManager().snapshot();
    expect(snap.events.length).toBe(1);
    expect(snap.events[0].muId).toBe(mu.id);
    expect(snap.events[0].data).toBe(null);

    runner.tick(1.5);
    // Resolved back from the queue id — the SAME object, not a copy.
    expect(receivedMu).toBe(mu as unknown as MU);
  });

  it('an unregistered MU literal still reaches the hook via the payload fallback', () => {
    let receivedMu: MU | null = null;
    const def = defineMaterialFlow<MaterialFlowSelf>({
      type: 'GcConvLit',
      kind: 'conveyor',
      schema: {},
      continuous: {},
      des: {
        onArrival(_self, mu) { receivedMu = mu; },
      },
    });

    const runner = new DESRunner({ subMode: 'animated' });
    const node = new Object3D(); node.name = 'GcConvLit1';
    const self = createSelf(makeBindContext(node), def, {
      mode: 'des',
      scheduler: runner.makeScheduler(def as MaterialFlowDefinition, () => adapter.entityId),
    });
    const adapter = runner.addInstance(def as MaterialFlowDefinition, self, node);
    runner.start([def as MaterialFlowDefinition], { root: node });

    // `id: 7` is NOT a registered MU — identity cannot round-trip the queue, so
    // the scheduler must fall back to threading the object through the payload.
    const literal = { id: 7 } as MU;
    self.in(1, 'Arrival', literal);

    runner.tick(1.5);
    expect(receivedMu).toBe(literal);
  });

  it('user data still travels through the side-channel', () => {
    const def = defineMaterialFlow<MaterialFlowSelf>({
      type: 'GcConvData',
      kind: 'conveyor',
      schema: {},
      continuous: {},
      des: {
        onArrival() {},
      },
    });

    const runner = new DESRunner({ subMode: 'animated' });
    const node = new Object3D(); node.name = 'GcConvData1';
    const self = createSelf(makeBindContext(node), def, {
      mode: 'des',
      scheduler: runner.makeScheduler(def as MaterialFlowDefinition, () => adapter.entityId),
    });
    const adapter = runner.addInstance(def as MaterialFlowDefinition, self, node);
    runner.start([def as MaterialFlowDefinition], { root: node });

    const mu = runner.createMU();
    self.in(1, 'Arrival', mu as unknown as MU, { batchNo: 42 });

    const snap = runner.getManager().snapshot();
    expect(snap.events.length).toBe(1);
    const payload = snap.events[0].data as { mu: unknown; data: { batchNo: number } };
    expect(payload.data.batchNo).toBe(42);
    // The registered MU still rides the queue — the payload does not duplicate it.
    expect(payload.mu).toBe(null);
    expect(snap.events[0].muId).toBe(mu.id);
  });
});

describe('DESRunner — sink consume disposes visuals via the pending list', () => {
  it('disposes a consumed visual exactly once on lateTick', () => {
    const def = defineMaterialFlow<MaterialFlowSelf>({
      type: 'GcSink',
      kind: 'sink',
      schema: {},
      continuous: {},
      des: {
        onAccept(_self, mu) {
          const visual = mu.visual as { markedForRemoval?: boolean } | null;
          if (visual) visual.markedForRemoval = true;
          return true;
        },
      },
    });

    const runner = new DESRunner({ subMode: 'animated' });
    const node = new Object3D(); node.name = 'GcSink1';
    const self = createSelf(makeBindContext(node), def, {
      mode: 'des',
      scheduler: runner.makeScheduler(def as MaterialFlowDefinition, () => adapter.entityId),
    });
    const adapter = runner.addInstance(def as MaterialFlowDefinition, self, node);
    runner.start([def as MaterialFlowDefinition], { root: node });

    let disposed = 0;
    const visual = {
      markedForRemoval: false,
      dispose() { disposed++; },
    };
    const mu = runner.createMU();
    (mu as unknown as { visual: unknown }).visual = visual;

    expect(adapter.acceptMU(mu as never)).toBe(true);
    expect(visual.markedForRemoval).toBe(true);
    expect(disposed).toBe(0); // not yet swept

    runner.lateTick(0.016);
    expect(disposed).toBe(1);
    expect((mu as unknown as { visual: unknown }).visual).toBe(null); // cleared after dispose

    // Idempotent: further sweeps must not double-dispose.
    runner.lateTick(0.016);
    expect(disposed).toBe(1);
  });
});
