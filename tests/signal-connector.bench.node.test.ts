// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2227 NFA — 1000 SignalConnectors, 1000 source changes per tick: the
 * connector work of one tick stays below 1 ms (median) on coder. Measured as
 * the tick minus the same 1000 store writes on signals without a connector;
 * the whole tick is reported too. Also reports the load cost (init of all
 * 1000, network re-check included).
 */

import { describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVSignalConnector } from '../src/core/engine/rv-signal-connector';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';

const N = 1000;
const TICKS = 60;

function world() {
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'Cell';
  scene.add(root);
  const registry = new NodeRegistry();
  const store = new SignalStore();
  registry.registerNode('Cell', root);
  for (let i = 0; i < N; i++) {
    store.register(`Src${i}`, `Cell/Src${i}`, 0, 'PLCOutputInt');
    store.register(`Dst${i}`, `Cell/Dst${i}`, false, 'PLCInputBool');
    store.register(`Free${i}`, `Cell/Free${i}`, 0, 'PLCOutputInt'); // baseline: no connector
  }
  store.buildIndex();
  const ctx = { registry, signalStore: store, scene, root } as unknown as ComponentContext;
  const t0 = performance.now();
  const list: RVSignalConnector[] = [];
  for (let i = 0; i < N; i++) {
    const node = new Object3D();
    node.name = `C${i}`;
    root.add(node);
    node.userData.realvirtual = {
      SignalConnector: {
        SourceInt: { type: 'ComponentReference', path: `Cell/Src${i}` },
        TargetBool: { type: 'ComponentReference', path: `Cell/Dst${i}` },
      },
    };
    const c = new RVSignalConnector(node);
    c.Mode = 'IntToBool';
    c.SourceInt = `Cell/Src${i}`;
    c.TargetBool = `Cell/Dst${i}`;
    c.init(ctx);
    list.push(c);
  }
  const loadMs = performance.now() - t0;
  return { store, list, loadMs };
}

describe('SignalConnector benchmark (1000 connectors)', () => {
  it('1000 source changes per tick < 1 ms median (best of interleaved rounds)', () => {
    const { store, list, loadMs } = world();
    const tick = (prefix: string): number => {
      const names = Array.from({ length: N }, (_, i) => `${prefix}${i}`);
      const times: number[] = [];
      for (let t = 0; t < TICKS + 10; t++) {
        const v = t % 2 === 0 ? 7 : 0; // every source changes, every target flips
        const start = performance.now();
        for (let i = 0; i < N; i++) store.set(names[i], v);
        const ms = performance.now() - start;
        if (t >= 10) times.push(ms); // warm-up
      }
      times.sort((a, b) => a - b);
      return times[Math.floor(times.length / 2)];
    };
    // Robust under load (a parallel suite measured 1.36 ms for 0.49 ms alone): ROUNDS
    // interleaved rounds, each measures the store's own cost (the same 1000 writes on
    // signals nobody listens to) right before the connector tick, so both see the same
    // machine state; the verdict is the best round. A load spike hits single rounds; a
    // real regression raises every round.
    const ROUNDS = 5;
    let best = { median: Infinity, baseline: 0, connectorMs: Infinity };
    for (let r = 0; r < ROUNDS; r++) {
      const baseline = tick('Free');
      const median = tick('Src');
      const connectorMs = Math.max(0, median - baseline);
      if (connectorMs < best.connectorMs) best = { median, baseline, connectorMs };
    }
    const { median, baseline, connectorMs } = best;
    // Every connector did its job in the last tick.
    const last = (TICKS + 9) % 2 === 0;
    for (let i = 0; i < N; i += 97) expect(store.get(`Dst${i}`)).toBe(last);
    console.log(`[bench] SignalConnector: ${N} connectors, ${N} changes/tick — best of ${ROUNDS} rounds: tick median ${median.toFixed(3)} ms `
      + `(store writes alone ${baseline.toFixed(3)} ms, connector share ${connectorMs.toFixed(3)} ms); `
      + `load (init + checks) ${loadMs.toFixed(1)} ms`);
    // NFA: the connector work of one tick stays below 1 ms. The whole tick (source
    // writes included) gets a margin for a loaded machine.
    expect(connectorMs).toBeLessThan(1);
    expect(median).toBeLessThan(2);
    for (const c of list) c.dispose();
  });
});
