// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-729 §9.3 — the public LogicStep registry seam.
 *
 * `rv-logic-step-registry.ts` lets a plugin contribute a `LogicStep_*` type
 * without the public logic engine importing it (license cut). Covered: the two
 * functions themselves, `buildStep()` using a registered builder (through the
 * real `RVLogicEngine.build`), and the unchanged community behaviour — an
 * unknown, unregistered type warns and produces no step.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Object3D } from 'three';
import {
  getLogicStepBuilder,
  getRegisteredLogicStepTypes,
  registerLogicStepBuilder,
  type LogicStepBuildCtx,
} from '../src/core/engine/rv-logic-step-registry';
import { RVLogicEngine } from '../src/core/engine/rv-logic-engine';
import { RVLogicStep, RVSerialContainer, StepState } from '../src/core/engine/rv-logic-step';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';

class ProbeStep extends RVLogicStep {
  started = 0;
  constructor(readonly payload: unknown) { super(); }
  get progress(): number { return this.state === StepState.Finished ? 100 : 0; }
  start(): void { this.started++; this.state = StepState.Active; }
  fixedUpdate(): void { this.finish(); }
}

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const off of disposers.splice(0)) off();
  vi.restoreAllMocks();
});

/** Root SerialContainer with one child carrying `stepType`. */
function sceneWith(stepType: string, data: Record<string, unknown>) {
  const root = new Object3D(); root.name = 'Root';
  const seq = new Object3D(); seq.name = 'Seq'; root.add(seq);
  seq.userData.realvirtual = { LogicStep_SerialContainer: {} };
  const leaf = new Object3D(); leaf.name = 'Leaf'; seq.add(leaf);
  leaf.userData.realvirtual = { [stepType]: data };
  const registry = new NodeRegistry();
  root.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  return { root, leaf, registry, store: new SignalStore() };
}

describe('plan-729 9.3 — rv-logic-step-registry', () => {
  it('register / get round-trip, and the disposer removes exactly its own builder', () => {
    const a = () => null;
    const b = () => null;
    const offA = registerLogicStepBuilder('LogicStep_ProbeA', a);
    expect(getLogicStepBuilder('LogicStep_ProbeA')).toBe(a);
    expect(getRegisteredLogicStepTypes()).toContain('LogicStep_ProbeA');

    // A re-registration replaces; the stale disposer must not remove the new one.
    const offB = registerLogicStepBuilder('LogicStep_ProbeA', b);
    offA();
    expect(getLogicStepBuilder('LogicStep_ProbeA')).toBe(b);
    offB();
    expect(getLogicStepBuilder('LogicStep_ProbeA')).toBeUndefined();
  });

  it('buildStep() uses a registered builder and hands it the build context', () => {
    const seen: LogicStepBuildCtx[] = [];
    disposers.push(registerLogicStepBuilder('LogicStep_Probe', (ctx) => {
      seen.push(ctx);
      return new ProbeStep(ctx.data['Payload']);
    }));
    const { root, leaf, registry, store } = sceneWith('LogicStep_Probe', { Payload: 42 });

    const engine = RVLogicEngine.build(root, registry, store);
    expect(engine.roots).toHaveLength(1);
    const container = engine.roots[0] as RVSerialContainer;
    expect(container.children).toHaveLength(1);
    const step = container.children[0] as ProbeStep;
    expect(step).toBeInstanceOf(ProbeStep);
    expect(step.payload).toBe(42);
    // The engine names the step after its node, like every built-in step.
    expect(step.name).toBe('Leaf');

    expect(seen).toHaveLength(1);
    expect(seen[0].node).toBe(leaf);
    expect(seen[0].stepType).toBe('LogicStep_Probe');
    expect(seen[0].registry).toBe(registry);
    expect(seen[0].signalStore).toBe(store);
    expect(seen[0].scope).toBe(root);
  });

  it('a builder that returns null yields no step (and no crash)', () => {
    disposers.push(registerLogicStepBuilder('LogicStep_Probe', () => null));
    const { root, registry, store } = sceneWith('LogicStep_Probe', {});
    const engine = RVLogicEngine.build(root, registry, store);
    expect((engine.roots[0] as RVSerialContainer).children).toHaveLength(0);
  });

  it('an unknown type WITHOUT registration keeps the old behaviour: warn + null', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { root, registry, store } = sceneWith('LogicStep_NoSuchThing', {});
    const engine = RVLogicEngine.build(root, registry, store);
    expect((engine.roots[0] as RVSerialContainer).children).toHaveLength(0);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('Unknown step type: "LogicStep_NoSuchThing"')))
      .toBe(true);
  });
});
