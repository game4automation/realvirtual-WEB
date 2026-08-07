// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * des-mu-recycling.test.ts — MU slot recycling after sink consume.
 *
 * A sink-consumed MU is RETIRED at the manager (runner sweep): its slot is
 * nulled so the object can be garbage-collected and the id is reused by the
 * next `createMU()`. Retained memory therefore stays bounded by
 * work-in-progress, not total production — essential for long runs (a high-bay
 * warehouse produces millions of MUs over a simulated year).
 *
 * Safety: when queued events still reference the MU (pending-event refcount),
 * the free is DEFERRED until the last one fires or is cancelled — a queued
 * event never resolves to a wrong, recycled MU.
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

/** Build a runner with one sink instance (consumes + marks visuals). */
function makeSinkRunner(): { runner: DESRunner; adapter: ReturnType<DESRunner['addInstance']>; self: MaterialFlowSelf } {
  const def = defineMaterialFlow<MaterialFlowSelf>({
    type: 'RecycleSink',
    kind: 'sink',
    schema: {},
    continuous: {},
    des: {
      onAccept(_self, mu) {
        const visual = mu.visual as { markedForRemoval?: boolean } | null;
        if (visual) visual.markedForRemoval = true;
        return true;
      },
      onArrival() {},
    },
  });
  const runner = new DESRunner({ subMode: 'animated' });
  const node = new Object3D(); node.name = 'RecycleSink1';
  const self = createSelf(makeBindContext(node), def, {
    mode: 'des',
    scheduler: runner.makeScheduler(def as MaterialFlowDefinition, () => adapter.entityId),
  });
  const adapter = runner.addInstance(def as MaterialFlowDefinition, self, node);
  runner.start([def as MaterialFlowDefinition], { root: node });
  return { runner, adapter, self };
}

beforeEach(() => {
  _resetMaterialFlowRegistry();
  _resetDesHookCache();
  resetDESMUCounter();
});

describe('DES MU recycling', () => {
  it('frees the slot after sink consume and reuses the id for the next MU', () => {
    const { runner, adapter } = makeSinkRunner();
    const manager = runner.getManager();

    const mu = runner.createMU();
    const id = mu.id;
    expect(manager.getMU(id)).toBe(mu);

    expect(adapter.acceptMU(mu as never)).toBe(true);
    runner.lateTick(0.016); // sweep → retire

    // Slot freed — the manager no longer references the consumed MU.
    expect(manager.getMU(id)).toBe(null);

    // The next MU reuses the freed id: the slot array does not grow.
    const next = runner.createMU();
    expect(next.id).toBe(id);
    expect(manager.getMU(id)).toBe(next);
  });

  it('bounds slot growth to WIP across many produce-consume cycles', () => {
    const { runner, adapter } = makeSinkRunner();
    const manager = runner.getManager();

    for (let i = 0; i < 1000; i++) {
      const mu = runner.createMU();
      adapter.acceptMU(mu as never);
      runner.lateTick(0.016);
    }

    // 1000 MUs produced and consumed, but never more than 1 alive at a time —
    // the slot array must stay tiny (all ids recycled), not grow to 1000.
    expect(manager.muCount).toBeLessThanOrEqual(2);
  });

  it('defers the free while a queued event still references the MU', () => {
    const { runner, adapter, self } = makeSinkRunner();
    const manager = runner.getManager();

    let receivedMu: MU | null = null;
    // Redefine would be cleaner, but the def is registered — schedule the extra
    // event via the sink's own Arrival hook path instead.
    const def = adapter.def as MaterialFlowDefinition;
    (def.des as { onArrival?: (s: MaterialFlowSelf, mu: MU) => void }).onArrival =
      (_s, mu) => { receivedMu = mu; };

    const mu = runner.createMU();
    const id = mu.id;

    // A future event references the MU BEFORE it is consumed.
    self.in(5, 'Arrival', mu as unknown as MU);

    adapter.acceptMU(mu as never);
    runner.lateTick(0.016); // sweep → retire is DEFERRED (pending event)

    // Slot must still resolve — the queued event holds a reference.
    expect(manager.getMU(id)).toBe(mu);

    // The event fires with the CORRECT (original) MU …
    runner.tick(6);
    expect(receivedMu).toBe(mu as unknown as MU);

    // … and afterwards the deferred free happens automatically.
    expect(manager.getMU(id)).toBe(null);
    const next = runner.createMU();
    expect(next.id).toBe(id);
  });

  it('a cancelled event releases its reference and completes a deferred retire', () => {
    const { runner, adapter, self } = makeSinkRunner();
    const manager = runner.getManager();

    const mu = runner.createMU();
    const id = mu.id;
    const eventId = self.in(60, 'Arrival', mu as unknown as MU);

    adapter.acceptMU(mu as never);
    runner.lateTick(0.016); // retire deferred (pending event)
    expect(manager.getMU(id)).toBe(mu);

    self.cancel(eventId);
    // Cancel dropped the last reference → deferred free completes.
    expect(manager.getMU(id)).toBe(null);

    // A repeated cancel must not corrupt the freelist (no double-free).
    self.cancel(eventId);
    const a = runner.createMU();
    const b = runner.createMU();
    expect(a.id).not.toBe(b.id);
  });
});
