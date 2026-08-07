// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/* Placed-asset LogicStep instantiation (processExtras gap fix):
 * RVLogicEngine.addSubtree() must build the steps of a placed subtree,
 * bind DriveTo ComponentReferences via the scope-limited name fallback
 * (authored hierarchy prefix no longer exists after re-parenting), and
 * removeSubtree() must drop them again. */

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';

import { RVLogicEngine } from '../src/core/engine/rv-logic-engine';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVSerialContainer, RVDriveTo, StepState } from '../src/core/engine/rv-logic-step';

function nd(name: string, parent: Object3D | null): Object3D {
  const n = new Object3D();
  n.name = name;
  if (parent) parent.add(n);
  return n;
}

function makePlacedInstance(rootName: string) {
  // placement root as it exists AFTER re-parenting: <root>/TableAxis
  const root = nd(rootName, null);
  const axis = nd('TableAxis', root);
  // SeqCycle container with one DriveTo whose ref uses the STALE authored path
  const seq = nd('SeqCycle', root);
  seq.userData.realvirtual = { LogicStep_SerialContainer: { AutoLoop: true } };
  const c1 = nd('C1', seq);
  c1.userData.realvirtual = { LogicStep_DriveTo: {
    drive: { type: 'ComponentReference', path: 'AuxScene/AuxScene_1/Gone/Gone_1//TableAxis', componentType: 'realvirtual.Drive' },
    Destination: 900,
  } };
  return { root, axis };
}

function registerSubtree(registry: NodeRegistry, root: Object3D): void {
  root.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
}

describe('RVLogicEngine placed-subtree lifecycle', () => {
  it('addSubtree builds roots and binds drive refs via scoped name fallback', () => {
    const registry = new NodeRegistry();
    const store = new SignalStore();
    const scene = nd('Scene', null);
    const { root, axis } = makePlacedInstance('AuxScene_1');
    scene.add(root);
    registerSubtree(registry, scene);
    const fakeDrive = { name: 'TableAxis', isDrive: true, currentPosition: 0, targetPosition: 0, startMove: () => {} };
    registry.register('Drive', registry.getPathForNode(axis)!, fakeDrive);

    const engine = new RVLogicEngine();
    engine.start(); // placed mid-session: engine already running
    const added = engine.addSubtree(root, registry, store);

    expect(added).toBe(1);
    expect(engine.roots.length).toBe(1);
    const seq = engine.roots[0] as RVSerialContainer;
    expect(seq).toBeInstanceOf(RVSerialContainer);
    expect(seq.state).not.toBe(StepState.Idle); // started immediately
    const c1 = seq.children[0] as RVDriveTo;
    expect(c1).toBeInstanceOf(RVDriveTo);
    expect(c1.drive).toBe(fakeDrive); // scoped fallback bound the drive
  });

  it('two instances bind each their OWN drive (scope isolation)', () => {
    const registry = new NodeRegistry();
    const store = new SignalStore();
    const scene = nd('Scene', null);
    const a = makePlacedInstance('AuxScene_1');
    const b = makePlacedInstance('AuxScene_1_2');
    scene.add(a.root);
    scene.add(b.root);
    registerSubtree(registry, scene);
    const driveA = { name: 'A' };
    const driveB = { name: 'B' };
    registry.register('Drive', registry.getPathForNode(a.axis)!, driveA);
    registry.register('Drive', registry.getPathForNode(b.axis)!, driveB);

    const engine = new RVLogicEngine();
    engine.addSubtree(a.root, registry, store);
    engine.addSubtree(b.root, registry, store);

    expect(engine.roots.length).toBe(2);
    expect((engine.roots[0] as RVSerialContainer).children[0]).toBeInstanceOf(RVDriveTo);
    expect(((engine.roots[0] as RVSerialContainer).children[0] as RVDriveTo).drive).toBe(driveA);
    expect(((engine.roots[1] as RVSerialContainer).children[0] as RVDriveTo).drive).toBe(driveB);
  });

  it('removeSubtree drops only the removed instance roots', () => {
    const registry = new NodeRegistry();
    const store = new SignalStore();
    const scene = nd('Scene', null);
    const a = makePlacedInstance('AuxScene_1');
    const b = makePlacedInstance('AuxScene_1_2');
    scene.add(a.root);
    scene.add(b.root);
    registerSubtree(registry, scene);

    const engine = new RVLogicEngine();
    engine.addSubtree(a.root, registry, store);
    engine.addSubtree(b.root, registry, store);
    expect(engine.roots.length).toBe(2);

    const removed = engine.removeSubtree(a.root);
    expect(removed).toBe(1);
    expect(engine.roots.length).toBe(1);
    expect(engine.stepByPath.size).toBeGreaterThan(0);
    for (const [p] of engine.stepByPath) {
      expect(p.startsWith('Scene/AuxScene_1/')).toBe(false);
    }
  });
});
