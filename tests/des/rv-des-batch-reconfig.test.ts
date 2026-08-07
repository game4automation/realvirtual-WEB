// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-265 Phase 2 primitive — the PRODUCTION re-config path.
 *
 * The live DES runner binds MaterialFlowAdapters whose config lives in
 * `self.prop` (seeded once at bind). A parameter override written into
 * node.userData.realvirtual only takes effect after `runner.reconfigureFromExtras()`
 * (re-runs seedConfig → self.prop) followed by `runner.reset()` (start re-runs
 * def.setup, re-reading prop). This test proves an InterArrivalTime override
 * changes the actual generation count through the RUNNER (adapter) path — the
 * mechanism DESComponent.reconfigureFromExtras (native path, test 9.2) does NOT
 * cover.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import { DESRunner } from '@rv-private/plugins/des/des-runner';
import { _resetDesHookCache } from '@rv-private/plugins/des/des-hook-adapter';
import { resetDESMUCounter } from '@rv-private/plugins/des/rv-des-mu';
import {
  createSelf,
  readConfigNumber,
  type MaterialFlowSelf,
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

let generated = 0;

/** A self-rescheduling source that reads its interval from self.prop. */
function makeSourceDef(): MaterialFlowDefinition {
  return defineMaterialFlow<MaterialFlowSelf>({
    type: 'CfgSource',
    kind: 'source',
    schema: { InterArrivalTime: { type: 'number', default: 5 } },
    continuous: {},
    setup() { /* config read live in onArrival via self.prop */ },
    des: {
      // onGenerate is the auto-fired kickoff at start(); it schedules the first
      // recurring Arrival. onArrival counts a generation and reschedules itself at
      // the (possibly overridden) interval read live from self.prop. 'Arrival' is
      // a valid DES hook suffix (HOOK_SUFFIX in des-hook-adapter).
      onGenerate(self) {
        const iv = readConfigNumber(self, 'InterArrivalTime', 5);
        self.in(iv, 'Arrival');
      },
      onArrival(self) {
        const iv = readConfigNumber(self, 'InterArrivalTime', 5);
        generated++;
        self.in(iv, 'Arrival');
      },
    },
  }) as MaterialFlowDefinition;
}

describe('DES batch re-config (runner/adapter path)', () => {
  beforeEach(() => {
    _resetMaterialFlowRegistry();
    _resetDesHookCache();
    resetDESMUCounter();
    generated = 0;
  });

  it('an InterArrivalTime override changes generation count via reconfigureFromExtras + reset', () => {
    const def = makeSourceDef();
    const node = new Object3D();
    node.name = 'CfgSource1';
    node.userData.realvirtual = { CfgSource: { InterArrivalTime: 10 } };

    const runner = new DESRunner({ subMode: 'animated' });
    let adapter: { entityId: number };
    const self = createSelf(makeBindContext(node), def, {
      mode: 'des',
      // Read entityId LIVE — reset() re-registers the adapter with a fresh id.
      scheduler: runner.makeScheduler(def, () => adapter.entityId),
    });
    adapter = runner.addInstance(def, self, node);

    runner.start([def], { root: node });

    const run = (interArrival: number, seconds: number): number => {
      (node.userData.realvirtual as { CfgSource: { InterArrivalTime: number } }).CfgSource.InterArrivalTime = interArrival;
      runner.reconfigureFromExtras();       // re-seed self.prop from rv_extras
      expect(readConfigNumber(self, 'InterArrivalTime', 0)).toBe(interArrival); // prop refreshed
      runner.reset();                        // start re-runs setup + onGenerate with new prop
      generated = 0;                         // count steady-state generations only
      const dt = 0.5;
      for (let t = 0; t < seconds; t += dt) runner.tick(dt);
      return generated;
    };

    const slow = run(10, 200); // ~20 generations
    const fast = run(2, 200);  // ~100 generations
    expect(slow).toBeGreaterThan(0);
    expect(fast).toBeGreaterThan(slow * 2); // markedly more, not identical (silent-fail guard)
  });
});
