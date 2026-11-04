// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * logic-nested-serial-container.node.test.ts — plan-2016 S2: only a ROOT
 * SerialContainer loops. A SerialContainer below a Serial or Parallel
 * container runs once per start and reports Finished to its parent, as in
 * Unity (LogicStep.NextStep / LogicStep_SerialContainer.OnFinished). Before the
 * fix every Serial was built with autoLoop=true, so a nested Serial restarted
 * instead of finishing and its parent container hung forever.
 *
 * The trees are built from GLB-shaped nodes (userData.realvirtual extras)
 * through the real `RVLogicEngine.addSubtree()`.
 */

import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { RVLogicEngine, disableNestedAutoLoop } from '../src/core/engine/rv-logic-engine';
import { NodeRegistry, type ComponentRef } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import {
  RVDelay,
  RVParallelContainer,
  RVSerialContainer,
  StepState,
} from '../src/core/engine/rv-logic-step';

const DT = 1 / 60;

type Extras = Record<string, unknown>;

function nd(name: string, parent: Object3D | null, extras?: Extras): Object3D {
  const n = new Object3D();
  n.name = name;
  if (parent) parent.add(n);
  if (extras) n.userData.realvirtual = extras;
  return n;
}

const sigRef = (path: string): ComponentRef => ({ type: 'ComponentReference', path, componentType: 'realvirtual.PLCOutputBool' });
const serial = (): Extras => ({ LogicStep_SerialContainer: {} });
const parallel = (): Extras => ({ LogicStep_ParallelContainer: {} });
const setBool = (path: string, value = true): Extras => ({ LogicStep_SetSignalBool: { Signal: sigRef(path), SetToTrue: value } });
const delay = (s: number): Extras => ({ LogicStep_Delay: { Duration: s } });

function world() {
  const scene = nd('Cell', null);
  const sig = nd('Sig', scene);
  const logic = nd('Logic', scene);
  const registry = new NodeRegistry();
  const store = new SignalStore();
  const engine = new RVLogicEngine();
  return {
    scene, logic, registry, store, engine,
    signal(name: string): string {
      const n = nd(name, sig);
      const path = NodeRegistry.computeNodePath(n);
      registry.registerNode(path, n);
      store.register(path, path, false, 'PLCOutputBool');
      return path;
    },
    build(): number {
      scene.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
      const added = engine.addSubtree(logic, registry, store);
      engine.start(false);
      return added;
    },
    tick(n = 1) { for (let i = 0; i < n; i++) engine.fixedUpdate(DT); },
  };
}

function rootStep(engine: RVLogicEngine, name: string): RVSerialContainer {
  const r = engine.roots.find((s) => s.name === name);
  if (!r) throw new Error(`no root "${name}"`);
  return r as RVSerialContainer;
}

describe('plan-2016 S2 — nested SerialContainers finish instead of looping', () => {
  it('(a) Parallel[Serial[Delay, SetSignal], Delay] finishes and the root chain continues', () => {
    const w = world();
    const doneA = w.signal('DoneA');
    const after = w.signal('After');
    const root = nd('Root', w.logic, serial());
    nd('Reset', root, setBool(after, false));
    const par = nd('Par', root, parallel());
    const inner = nd('Inner', par, serial());
    nd('InnerDelay', inner, delay(0.1));
    nd('InnerSet', inner, setBool(doneA, true));
    nd('ParDelay', par, delay(0.2));
    nd('SetAfter', root, setBool(after, true));
    expect(w.build()).toBe(1);

    const r = rootStep(w.engine, 'Root');
    const parStep = r.children[1] as RVParallelContainer;
    const innerStep = parStep.children[0] as RVSerialContainer;
    expect(r.autoLoop).toBe(true);
    expect(innerStep.autoLoop).toBe(false);

    // 0.2 s parallel ≈ 12 ticks; after 20 ticks the root has passed SetAfter at least once.
    w.tick(20);
    expect(w.store.get(doneA)).toBe(true);
    expect(r.completedCycles).toBeGreaterThanOrEqual(1);
    // The nested serial ran once per parallel start, never looped on its own.
    expect(innerStep.completedCycles - r.completedCycles).toBeGreaterThanOrEqual(0);
    expect(innerStep.completedCycles - r.completedCycles).toBeLessThanOrEqual(1);
  });

  it('(b) Serial inside Serial finishes and the root advances to the next step', () => {
    const w = world();
    const x = w.signal('X');
    const y = w.signal('Y');
    const root = nd('Root', w.logic, serial());
    const inner = nd('Inner', root, serial());
    nd('InnerDelay', inner, delay(0.1));
    nd('InnerSet', inner, setBool(x, true));
    nd('SetY', root, setBool(y, true));
    nd('Hold', root, delay(1));
    w.build();

    const r = rootStep(w.engine, 'Root');
    const innerStep = r.children[0] as RVSerialContainer;
    expect(innerStep.autoLoop).toBe(false);

    w.tick(15);
    expect(w.store.get(x)).toBe(true);
    expect(w.store.get(y)).toBe(true);
    expect(innerStep.state).toBe(StepState.Finished);
    expect(innerStep.completedCycles).toBe(1);
    expect(r.currentIndex).toBe(2); // waiting in Hold, not stuck in Inner
  });

  it('(c) the root SerialContainer stays cyclic', () => {
    const w = world();
    const x = w.signal('X');
    const root = nd('Root', w.logic, serial());
    const inner = nd('Inner', root, serial());
    nd('InnerDelay', inner, delay(0.1));
    nd('InnerSet', inner, setBool(x, true));
    nd('RootDelay', root, delay(0.1));
    w.build();

    const r = rootStep(w.engine, 'Root');
    const innerStep = r.children[0] as RVSerialContainer;
    w.tick(30);
    const c1 = r.completedCycles;
    expect(c1).toBeGreaterThanOrEqual(2);
    w.tick(30);
    expect(r.completedCycles).toBeGreaterThan(c1);
    // One inner run per root cycle (plus at most the one in flight).
    expect(innerStep.completedCycles - r.completedCycles).toBeGreaterThanOrEqual(0);
    expect(innerStep.completedCycles - r.completedCycles).toBeLessThanOrEqual(1);
  });

  it('a root ParallelContainer makes its Serial children non-looping', () => {
    const w = world();
    const root = nd('RootPar', w.logic, parallel());
    const a = nd('A', root, serial());
    nd('ADelay', a, delay(0.05));
    w.build();
    const p = w.engine.roots[0] as RVParallelContainer;
    expect((p.children[0] as RVSerialContainer).autoLoop).toBe(false);
    w.tick(10);
    expect(p.state).toBe(StepState.Finished);
  });

  it('disableNestedAutoLoop clears every nested level and keeps the root flag', () => {
    const deep = new RVSerialContainer([new RVDelay(0.1)], true);
    const mid = new RVSerialContainer([deep], true);
    const par = new RVParallelContainer([mid]);
    const root = new RVSerialContainer([par], true);
    disableNestedAutoLoop(root);
    expect(root.autoLoop).toBe(true);
    expect(mid.autoLoop).toBe(false);
    expect(deep.autoLoop).toBe(false);
  });
});
