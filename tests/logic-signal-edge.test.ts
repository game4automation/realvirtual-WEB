// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * logic-signal-edge.test.ts — plan-538 F5: `LogicStep_WaitForSignalBool.Edge`.
 *
 * Level (default) keeps today's behaviour. Rising / Falling sample the signal at
 * step start and finish only on the first transition AFTER it — an already
 * high (low) level does not count. Also: a pulse shorter than one tick is not
 * lost, a re-activated instance re-samples, and the field is read from the GLB
 * extras by the engine.
 */

import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { RVLogicEngine } from '../src/core/engine/rv-logic-engine';
import {
  RVWaitForSignalBool,
  RVSerialContainer,
  StepState,
  parseSignalEdge,
} from '../src/core/engine/rv-logic-step';

const SIG = 'Cell/Trigger';

function store(initial: boolean): SignalStore {
  const s = new SignalStore();
  s.register(SIG, SIG, initial, 'PLCOutputBool');
  return s;
}

describe('plan-538 F5 — WaitForSignalBool Edge', () => {
  it('Level (default) is unchanged: finishes at once on a matching level', () => {
    const s = store(true);
    const step = new RVWaitForSignalBool(SIG, true, s);
    expect(step.edge).toBe('Level');
    step.start();
    expect(step.state).toBe(StepState.Finished);

    const waitLow = new RVWaitForSignalBool(SIG, false, s);
    waitLow.start();
    expect(waitLow.state).toBe(StepState.Waiting);
    s.setByPath(SIG, false);
    waitLow.fixedUpdate(0.02);
    expect(waitLow.state).toBe(StepState.Finished);
  });

  it('Rising ignores an already-high level at start and finishes on the next low→high', () => {
    const s = store(true);
    const step = new RVWaitForSignalBool(SIG, true, s, 'Rising');
    step.start();
    expect(step.state).toBe(StepState.Waiting);
    step.fixedUpdate(0.02);
    expect(step.state).toBe(StepState.Waiting); // high level is no edge
    s.setByPath(SIG, false);
    step.fixedUpdate(0.02);
    expect(step.state).toBe(StepState.Waiting); // falling is not rising
    s.setByPath(SIG, true);
    step.fixedUpdate(0.02);
    expect(step.state).toBe(StepState.Finished);
  });

  it('Falling ignores an already-low level at start and finishes on the next high→low', () => {
    const s = store(false);
    const step = new RVWaitForSignalBool(SIG, true, s, 'Falling');
    step.start();
    step.fixedUpdate(0.02);
    expect(step.state).toBe(StepState.Waiting);
    s.setByPath(SIG, true);
    step.fixedUpdate(0.02);
    expect(step.state).toBe(StepState.Waiting);
    s.setByPath(SIG, false);
    step.fixedUpdate(0.02);
    expect(step.state).toBe(StepState.Finished);
  });

  it('a pulse shorter than one tick is caught (rising edge between two ticks)', () => {
    const s = store(false);
    const step = new RVWaitForSignalBool(SIG, true, s, 'Rising');
    step.start();
    s.setByPath(SIG, true);
    s.setByPath(SIG, false); // back low before the next tick
    step.fixedUpdate(0.02);
    expect(step.state).toBe(StepState.Finished);
  });

  it('re-activation of the same instance re-samples (an edge seen before does not carry over)', () => {
    const s = store(false);
    const step = new RVWaitForSignalBool(SIG, true, s, 'Rising');
    step.start();
    s.setByPath(SIG, true);
    step.fixedUpdate(0.02);
    expect(step.state).toBe(StepState.Finished);

    // Container loop: reset + start again while the level is still high.
    step.reset();
    step.start();
    step.fixedUpdate(0.02);
    expect(step.state).toBe(StepState.Waiting);
    // An edge that happens while the step is Idle is not remembered either.
    step.reset();
    s.setByPath(SIG, false);
    s.setByPath(SIG, true);
    step.start();
    step.fixedUpdate(0.02);
    expect(step.state).toBe(StepState.Waiting);
    s.setByPath(SIG, false);
    s.setByPath(SIG, true);
    step.fixedUpdate(0.02);
    expect(step.state).toBe(StepState.Finished);
  });

  it('parses Edge from the GLB extras (unknown values fall back to Level)', () => {
    expect(parseSignalEdge('Rising')).toBe('Rising');
    expect(parseSignalEdge('Falling')).toBe('Falling');
    expect(parseSignalEdge('rising')).toBe('Level');
    expect(parseSignalEdge(undefined)).toBe('Level');

    const s = store(true);
    const registry = new NodeRegistry();
    const sigNode = new Object3D();
    sigNode.name = 'Trigger';
    const cell = new Object3D();
    cell.name = 'Cell';
    cell.add(sigNode);
    registry.registerNode('Cell', cell);
    registry.registerNode(SIG, sigNode);
    const seq = new Object3D();
    seq.name = 'Seq';
    seq.userData.realvirtual = { LogicStep_SerialContainer: {} };
    const wait = new Object3D();
    wait.name = 'WaitRise';
    wait.userData.realvirtual = {
      LogicStep_WaitForSignalBool: {
        Signal: { type: 'ComponentReference', path: SIG, componentType: 'realvirtual.PLCOutputBool' },
        WaitForTrue: true,
        Edge: 'Rising',
      },
    };
    seq.add(wait);
    const engine = RVLogicEngine.build(seq, registry, s);
    const step = (engine.roots[0] as RVSerialContainer).children[0] as RVWaitForSignalBool;
    expect(step.edge).toBe('Rising');
  });
});
