// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/* plan-502 F13 — an Inspector edit of a LogicStep field (setField op → executor
 * → reapplySchemaForComponent) reaches the RUNNING step: LogicSteps are built by
 * the logic engine, not the component registry, so the generic schema reapply
 * never saw them and `Duration` only changed after a reload. */

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';

import { RVLogicEngine } from '../src/core/engine/rv-logic-engine';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVDelay, RVSerialContainer, RVSetSignalBool, StepState } from '../src/core/engine/rv-logic-step';
import { reapplySchemaForComponent, writeUserDataField } from '../src/core/hmi/scene/rv-scene-executors';
import type { RVViewer } from '../src/core/rv-viewer';

function nd(name: string, parent: Object3D | null): Object3D {
  const n = new Object3D();
  n.name = name;
  if (parent) parent.add(n);
  return n;
}

function build() {
  const registry = new NodeRegistry();
  const store = new SignalStore();
  const root = nd('Demo', null);
  const seq = nd('Sequence', root);
  seq.userData.realvirtual = { LogicStep_SerialContainer: {} };
  const set = nd('RestartBall', seq);
  set.userData.realvirtual = { LogicStep_SetSignalBool: { Signal: null, SetToTrue: true } };
  const wait = nd('Wait', seq);
  wait.userData.realvirtual = { LogicStep_Delay: { Duration: 4 } };
  root.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  const engine = RVLogicEngine.build(root, registry, store);
  const viewer = { registry, logicEngine: engine } as unknown as RVViewer;
  const waitPath = registry.getPathForNode(wait)!;
  const setPath = registry.getPathForNode(set)!;
  const container = engine.roots[0] as RVSerialContainer;
  return { engine, viewer, waitPath, setPath, container };
}

describe('LogicStep field edits reach the running step (plan-502 F13)', () => {
  it('Duration edit via the executor path changes the running delay and ends a longer wait early', () => {
    const { engine, viewer, waitPath, container } = build();
    const delay = engine.stepByPath.get(waitPath) as RVDelay;
    expect(delay).toBeInstanceOf(RVDelay);
    expect(delay.duration).toBe(4);

    engine.start();
    // SetSignalBool (null address) finishes at once → the delay is active.
    for (let i = 0; i < 100; i++) engine.fixedUpdate(0.02); // 2 s into the 4 s wait
    expect(delay.state).toBe(StepState.Active);

    writeUserDataField(viewer, waitPath, 'LogicStep_Delay', 'Duration', 2);
    reapplySchemaForComponent(viewer, waitPath, 'LogicStep_Delay');
    expect(delay.duration).toBe(2);

    engine.fixedUpdate(0.02);
    // The wait ended → the (looping) container moved on.
    expect(container.completedCycles).toBeGreaterThanOrEqual(1);
  });

  it('an unset Duration falls back to the schema default (1 s); SetToTrue follows too', () => {
    const { engine, viewer, waitPath, setPath } = build();
    const node = viewer.registry!.getNode(waitPath)!;
    (node.userData.realvirtual as Record<string, unknown>).LogicStep_Delay = {};
    reapplySchemaForComponent(viewer, waitPath, 'LogicStep_Delay');
    expect((engine.stepByPath.get(waitPath) as RVDelay).duration).toBe(1);

    writeUserDataField(viewer, setPath, 'LogicStep_SetSignalBool', 'SetToTrue', false);
    reapplySchemaForComponent(viewer, setPath, 'LogicStep_SetSignalBool');
    expect((engine.stepByPath.get(setPath) as RVSetSignalBool).value).toBe(false);
  });

  it('is a no-op without a logic engine or for an unknown path', () => {
    const { engine, viewer, waitPath } = build();
    expect(engine.reapplyStepFields('Nope/Wait', 'LogicStep_Delay', { Duration: 9 })).toBe(false);
    expect(engine.reapplyStepFields(waitPath, 'LogicStep_SetSignalBool', { SetToTrue: false })).toBe(false);
    const bare = { registry: viewer.registry, logicEngine: null } as unknown as RVViewer;
    expect(() => reapplySchemaForComponent(bare, waitPath, 'LogicStep_Delay')).not.toThrow();
  });
});
