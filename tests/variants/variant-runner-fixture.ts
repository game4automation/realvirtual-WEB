// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2013 test 9.4 fixture — a REAL DESRunner (source → sink, Interval in rv_extras) behind a
 * viewer slice with the real `structuralEdit` semantics. Shared by the public variant tests and
 * the commercial experiment-column test (plan-2211: the column/scope case moved to Private~).
 */
import { Object3D } from 'three';
import { DESRunner } from '../../src/plugins/des/des-runner';
import type { MaterialFlowAdapter } from '../../src/plugins/des/material-flow-adapter';
import { createBindContext, type BindContextHost } from '../../src/core/behavior-runtime';
import { createSelf, type MaterialFlowSelf } from '../../src/core/material-flow/material-flow-self';
import { defineMaterialFlow, type MaterialFlowDefinition } from '../../src/core/material-flow/define-material-flow';
import { EventEmitter } from '../../src/core/rv-events';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';
import { SignalStore } from '../../src/core/engine/rv-signal-store';

export async function variantRunnerSetup(runners: DESRunner[]) {
  const runner = new DESRunner({ subMode: 'animated' });
  runners.push(runner);
  const generatedAt: number[] = [];
  const source = defineMaterialFlow<MaterialFlowSelf>({
    type: 'VarTaktSource', kind: 'source', continuous: {},
    schema: { Interval: { type: 'number', default: 10, unit: 's' } },
    des: {
      onGenerate(self) {
        generatedAt.push(runner.getManager().currentTime);
        self.transfer(runner.createMU());
        self.in(Number(self.prop.Interval), 'Generate', null);
      },
    },
  }) as MaterialFlowDefinition;
  const sink = defineMaterialFlow<MaterialFlowSelf>({
    type: 'VarTaktSink', kind: 'sink', schema: {}, continuous: {},
    des: { onAccept() { return true; } },
  }) as MaterialFlowDefinition;

  const root = new Object3D(); root.name = 'Root';
  const gen = new Object3D(); gen.name = 'Gen'; gen.userData.realvirtual = { VarTaktSource: { Interval: 10 } };
  const snk = new Object3D(); snk.name = 'Snk'; snk.userData.realvirtual = {};
  root.add(gen, snk);
  const byAddress = new Map<string, Object3D>([['#gen', gen], ['#snk', snk]]);

  const events = new EventEmitter<Record<string, unknown>>();
  const host: BindContextHost = {
    signalStore: new SignalStore(), on: (e, cb) => events.on(e, cb as never),
    contextMenu: new ContextMenuStore(), drives: [], registry: null, getPlugin: () => undefined,
  };
  const defs = [source, sink];
  const adapters: MaterialFlowAdapter[] = [];
  for (const [i, def] of defs.entries()) {
    const n = i === 0 ? gen : snk;
    const ctx = createBindContext(n, host, {}).ctx;
    const self = createSelf(ctx, def, {
      mode: 'des', local: (def.state ?? def.local)?.() ?? {},
      scheduler: runner.makeScheduler(def, () => adapters[i].entityId),
      onTransfer: (mu) => runner.makeTransfer(adapters[i])(mu),
    });
    if (i === 0) self.prop.Interval = 10;
    adapters.push(runner.addInstance(def, self, n));
  }
  adapters[0].nextComponents = [adapters[1]];
  adapters[1].previousComponents = [adapters[0]];
  runner.start(defs, { root });
  runner.setEndTime(1000);

  let depth = 0;
  let owed = false;
  const pauses = new Set<string>();
  const viewer = {
    get isSimulationPaused() { return pauses.size > 0; },
    resets: 0,
    setSimulationPaused(reason: string, paused: boolean) { if (paused) pauses.add(reason); else pauses.delete(reason); },
    resetSimulation() {
      if (depth > 0) { owed = true; return; }
      viewer.resets++;
      runner.reset(); runner.setEndTime(1000);
    },
    async structuralEdit<T>(fn: () => Promise<T> | T): Promise<T> {
      depth++;
      try { return await fn(); } finally { depth--; if (depth === 0 && owed) { owed = false; viewer.resetSimulation(); } }
    },
    simulationKernel: { mode: 'des', desControl: () => runner, hasDesLifecycle: () => false },
    registry: {
      getNodeByAddress: (id: string, occ = '') => byAddress.get(`${occ}#${id}`) ?? null,
      getNode: (path: string) => [...byAddress.values()].find((n) => `Root/${n.name}` === path) ?? null,
      getAddressForNode: (n: Object3D) => [...byAddress].find(([, x]) => x === n)?.[0] ?? null,
    },
    whenSceneReady: () => Promise.resolve(),
  };
  const steps = (): number[] => {
    generatedAt.length = 0;
    runner.setSubMode('fastforward');
    for (let i = 0; i < 400 && runner.getManager().currentTime < 30; i++) runner.tick(0);
    const first = generatedAt.slice(0, 3);
    return first.slice(1).map((t, i) => Math.round((t - first[i]) * 1000) / 1000);
  };
  return { runner, viewer, gen, root, steps };
}
