// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * logic-driveto-destination-signal.node.test.ts — plan-2016 S3: Unity
 * `LogicStep_DriveTo.DestinationFromPLCOutput` ("Get Position from Signal").
 *
 * Unity semantics (LogicStep_DriveTo.cs Awake / FixedUpdate): the signal value
 * at Awake decides — not 0 → the signal is the destination and `Destination`
 * follows it; 0 → `Destination` stays. A change while the move runs updates
 * `Destination` but the running `drive.DriveTo(des)` is not re-commanded; it
 * takes effect on the next start. The web latches at build time
 * (`addSubtree`), when the loader has already registered the signals.
 *
 * Steps are built from GLB-shaped nodes through the real `RVLogicEngine.addSubtree()`.
 */

import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { RVLogicEngine } from '../src/core/engine/rv-logic-engine';
import { NodeRegistry, type ComponentRef } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVDrive, DriveDirection } from '../src/core/engine/rv-drive';
import { RVDriveTo, RVSerialContainer, StepState } from '../src/core/engine/rv-logic-step';

const DT = 1 / 60;
type Extras = Record<string, unknown>;

function nd(name: string, parent: Object3D | null, extras?: Extras): Object3D {
  const n = new Object3D();
  n.name = name;
  if (parent) parent.add(n);
  if (extras) n.userData.realvirtual = extras;
  return n;
}

const driveRef = (path: string): ComponentRef => ({ type: 'ComponentReference', path, componentType: 'realvirtual.Drive' });
const floatRef = (path: string): ComponentRef => ({ type: 'ComponentReference', path, componentType: 'realvirtual.PLCOutputFloat', componentIndex: 0 } as ComponentRef);

function world() {
  const scene = nd('Cell', null);
  const sig = nd('InputValues', scene);
  const axes = nd('Axes', scene);
  const logic = nd('Logic', scene);
  const registry = new NodeRegistry();
  const store = new SignalStore();
  const engine = new RVLogicEngine();
  const n = nd('Gripper', axes);
  const drive = new RVDrive(n);
  drive.Direction = DriveDirection.LinearX;
  drive.StartPosition = 0;
  drive.TargetSpeed = 1000;
  drive.UseAcceleration = false;
  drive.UseLimits = false;
  drive.initDrive();
  const drivePath = NodeRegistry.computeNodePath(n);
  registry.registerNode(drivePath, n);
  registry.register('Drive', drivePath, drive);
  return {
    scene, logic, registry, store, engine, drive, drivePath,
    floatSignal(name: string, initial: number): string {
      const s = nd(name, sig);
      const path = NodeRegistry.computeNodePath(s);
      registry.registerNode(path, s);
      store.register(path, path, initial, 'PLCOutputFloat');
      return path;
    },
    build(): void {
      scene.traverse((o) => registry.registerNode(NodeRegistry.computeNodePath(o), o));
      engine.addSubtree(logic, registry, store);
      engine.start(false);
    },
    tick(k = 1) {
      for (let i = 0; i < k; i++) {
        engine.fixedUpdate(DT);
        drive.update(DT);
      }
    },
  };
}

type W = ReturnType<typeof world>;

/** Root Serial[DriveTo(Destination, DestinationFromPLCOutput?), Delay 10 s] — the delay keeps the chain from looping. */
function chain(w: W, destination: number, signalPath: string | null): RVDriveTo {
  const r = nd('Chain', w.logic, { LogicStep_SerialContainer: {} });
  const data: Extras = { drive: driveRef(w.drivePath), Destination: destination };
  if (signalPath) data['DestinationFromPLCOutput'] = floatRef(signalPath);
  nd('DriveTo', r, { LogicStep_DriveTo: data });
  nd('Hold', r, { LogicStep_Delay: { Duration: 10 } });
  w.build();
  const root = w.engine.roots.find((s) => s.name === 'Chain') as RVSerialContainer;
  const step = root.children[0];
  expect(step).toBeInstanceOf(RVDriveTo);
  return step as RVDriveTo;
}

describe('plan-2016 S3 — LogicStep_DriveTo.DestinationFromPLCOutput', () => {
  it('(a) signal ≠ 0 at build → drives to the signal value, not to Destination', () => {
    const w = world();
    const sig = w.floatSignal('PosGreifer', 250);
    const step = chain(w, 0, sig);
    expect(step.destinationSignal).toBe(sig);
    expect(step.valueBySignal).toBe(true);
    w.tick(60);
    expect(step.state).toBe(StepState.Finished);
    expect(w.drive.currentPosition).toBeCloseTo(250, 3);
  });

  it('(b) signal = 0 at build → Destination is used and the signal is not followed', () => {
    const w = world();
    const sig = w.floatSignal('PosGreifer', 0);
    const step = chain(w, 120, sig);
    expect(step.valueBySignal).toBe(false);
    w.store.setByPath(sig, 400); // later write — Unity read the value once in Awake
    w.tick(60);
    expect(step.state).toBe(StepState.Finished);
    expect(w.drive.currentPosition).toBeCloseTo(120, 3);
  });

  it('(c) a signal change while the move runs updates the destination; the next start goes there (Unity parity)', () => {
    const w = world();
    const sig = w.floatSignal('PosGreifer', 500);
    const step = chain(w, 0, sig);
    w.tick(10); // ~167 mm on the way to 500
    expect(step.state).toBe(StepState.Active);
    w.store.setByPath(sig, 300);
    w.tick(1);
    expect(step.destination).toBe(300);
    // the running move is not re-commanded (Unity: des is fixed in OnStarted)
    w.tick(60);
    expect(step.state).toBe(StepState.Finished);
    expect(w.drive.currentPosition).toBeCloseTo(500, 3);
    // the next start uses the new signal value (driven directly: the root sits in its Hold delay)
    step.reset();
    step.start();
    for (let i = 0; i < 60; i++) { w.drive.update(DT); step.fixedUpdate(DT); }
    expect(step.state).toBe(StepState.Finished);
    expect(w.drive.currentPosition).toBeCloseTo(300, 3);
  });

  it('(d) Relative applies on top of the signal value', () => {
    const w = world();
    const sig = w.floatSignal('Hub', 80);
    const r = nd('Chain', w.logic, { LogicStep_SerialContainer: {} });
    nd('DriveTo', r, { LogicStep_DriveTo: { drive: driveRef(w.drivePath), Destination: 0, Relative: true, DestinationFromPLCOutput: floatRef(sig) } });
    nd('Hold', r, { LogicStep_Delay: { Duration: 10 } });
    w.build();
    w.tick(60);
    expect(w.drive.currentPosition).toBeCloseTo(80, 3);
  });

  it('(e) without DestinationFromPLCOutput the step behaves as before', () => {
    const w = world();
    const step = chain(w, 75, null);
    expect(step.destinationSignal).toBeNull();
    expect(step.valueBySignal).toBe(false);
    w.tick(60);
    expect(w.drive.currentPosition).toBeCloseTo(75, 3);
  });
});
