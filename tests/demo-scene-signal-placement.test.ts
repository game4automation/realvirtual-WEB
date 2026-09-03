// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * demo-scene-signal-placement — the machine and the robot carry their own
 * signals (plan-422 F8, phase 6).
 *
 * Werner's report, verbatim: "the drag & drop target at the machine is still
 * called Conveyor Belt and does not offer the machine's data points yet." Both
 * halves had the same cause — every signal in the demo hung under one central
 * `PLCInterface` node, far from the geometry it describes. Badges and hierarchy
 * chips follow the node position, so the machine had nothing on it to hit, and
 * the nearest thing the magnet could find was the conveyor behind it.
 *
 * Phase 6 moved the groups onto their machines in the Unity scene and
 * re-exported. This test is what stops the next export from quietly undoing it:
 * it reads the SHIPPING GLB and checks where the signals actually landed, that
 * each is a bind target in its own right, and that the ConnectSignal chains
 * survived the move.
 */

import { describe, expect, it, beforeAll } from 'vitest';
import { Scene } from 'three';
import { loadGLB, type LoadResult } from '../src/core/engine/rv-scene-loader';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { findSignalBindTarget, signalBindTargetId } from '../src/plugins/signal-bind/signal-bind-target';
import { PLC_SIGNAL_SLOT } from '../src/core/engine/rv-binding-slot-resolver';
import type { RVViewer } from '../src/core/rv-viewer';

// Inside the demo's own folder since plan-737 (one folder artefact).
const DEMO_MODEL = '/demo-realvirtual/DemoRealvirtualWeb.glb';

/** Signals that must sit under the MACHINE, not under a central PLC node. */
const MACHINE_SIGNALS = [
  'MachineStart', 'MachineIsMachining', 'MachineIsFinished',
  'DoorOpened', 'DoorClosed', 'OpenDoor', 'Machining',
  'MoveTooling', 'ToolChangerArmPos',
];

/** Signals that must sit under the ROBOT. */
const ROBOT_SIGNALS = [
  'RobotIsLoading', 'RobotIsUnloading',
  'RobotAtConveyorPick', 'RobotAtMachinePlace', 'RobotAtMachinePick', 'RobotAtConveyorPlace',
  'LoadCell', 'UnloadCell', 'GripperClosed',
];

/** These deliberately STAY on the central node — they belong to no one machine. */
const CENTRAL_SIGNALS = [
  'EntryConveyorStart', 'ExitConveyorStart', 'OnSwitch', 'EmergencyButton', 'AutomaticLight',
];

let load: LoadResult;
let viewer: RVViewer;
/** node name → full registry path, for every PLC signal node in the model. */
const signalPaths = new Map<string, string>();

beforeAll(async () => {
  load = await loadGLB(DEMO_MODEL, new Scene(), { loadKinematicsSidecar: false });
  viewer = {
    registry: load.registry,
    signalStore: load.signalStore,
    signalBindingManager: new SignalBindingManager(load.signalStore, load.registry),
    behaviors: { getActiveBinds: () => [] },
    getPlugin: () => undefined,
    markRenderDirty: () => {},
  } as unknown as RVViewer;

  const SIGNAL_TYPES = ['PLCOutputBool', 'PLCInputBool', 'PLCOutputFloat', 'PLCInputFloat', 'PLCOutputInt', 'PLCInputInt'];
  load.root.traverse((node) => {
    const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
    if (!rv || !SIGNAL_TYPES.some((t) => rv[t])) return;
    const path = load.registry.getPathForNode(node);
    if (path) signalPaths.set(node.name, path);
  });
}, 180_000);

describe('the demo GLB places signals on the objects they describe', () => {
  it('found the demo model and its signal nodes at all', () => {
    expect(signalPaths.size, 'no PLC signal nodes in the shipping demo GLB')
      .toBeGreaterThanOrEqual(40);
  });

  it.each(MACHINE_SIGNALS)('%s lives under the CNC machine', (name) => {
    const path = signalPaths.get(name);
    expect(path, `${name} missing from the demo model`).toBeTruthy();
    expect(path, `${name} is not under the machine — Werner's report stands`)
      .toContain('/CNC/');
  });

  it.each(ROBOT_SIGNALS)('%s lives under the robot', (name) => {
    const path = signalPaths.get(name);
    expect(path, `${name} missing from the demo model`).toBeTruthy();
    expect(path, `${name} is not under the robot root`).toMatch(/(^|\/)Robot\//);
  });

  it.each(CENTRAL_SIGNALS)('%s stays on the central PLCInterface node', (name) => {
    const path = signalPaths.get(name);
    expect(path, `${name} missing from the demo model`).toBeTruthy();
    expect(path, `${name} was moved — conveyor and button signals belong to no single machine`)
      .toContain('PLCInterface');
  });
});

describe('the moved signals are bindable where they now sit (F8)', () => {
  it.each([...MACHINE_SIGNALS, ...ROBOT_SIGNALS])('%s offers a bindable Value slot', (name) => {
    const path = signalPaths.get(name)!;
    const node = load.registry.getNode(path)!;
    expect(node, `${name} does not resolve`).toBeTruthy();

    const target = findSignalBindTarget(viewer, node);
    expect(target, `${name} is not a bind target — no badge would appear on it`).toBeTruthy();

    const slots = viewer.signalBindingManager!.getElementSlots(
      signalBindTargetId(target!), target!.node, 'own');
    const value = slots.find((s) => s.slot === PLC_SIGNAL_SLOT);
    expect(value, `${name} has no Value slot`).toBeTruthy();
    expect(value!.kind, `${name}'s Value slot is unavailable`).toBe('mapped-signal');
  });

  it('gives the machine subtree its own set of bind targets', () => {
    // The concrete answer to "the machine offers no data points": count them.
    const underMachine = [...signalPaths.values()].filter((p) => p.includes('/CNC/'));
    expect(underMachine.length).toBeGreaterThanOrEqual(MACHINE_SIGNALS.length);
  });
});

describe('the internal wiring survived the re-parenting', () => {
  it('keeps every signal registered in the SignalStore', () => {
    for (const name of [...MACHINE_SIGNALS, ...ROBOT_SIGNALS, ...CENTRAL_SIGNALS]) {
      expect(load.signalStore.get(name), `${name} is not registered`).not.toBeUndefined();
    }
  });

  it('re-paths the ConnectSignal chains onto the moved nodes', () => {
    // MachineIsMachining mirrors the machine's own Machining output; both moved
    // together, so the reference must now point INSIDE the machine subtree.
    const path = signalPaths.get('MachineIsMachining')!;
    const node = load.registry.getNode(path)!;
    const rv = node.userData.realvirtual as Record<string, unknown>;
    const connect = rv.ConnectSignal as { ConnectedSignal?: { path?: string } } | undefined;
    expect(connect?.ConnectedSignal?.path, 'the ConnectSignal chain lost its target')
      .toContain('/CNC/');
  });

  it('keeps the robot feedback chain pointing at the robot I/O', () => {
    const path = signalPaths.get('RobotAtConveyorPick')!;
    const node = load.registry.getNode(path)!;
    const rv = node.userData.realvirtual as Record<string, unknown>;
    const connect = rv.ConnectSignal as { ConnectedSignal?: { path?: string } } | undefined;
    expect(connect?.ConnectedSignal?.path).toBe('Robot/AtPickPositionConveyor-do1');
  });
});

describe('every signal explains itself (comments in rv_extras)', () => {
  it('carries a Comment on every PLC signal component', () => {
    const SIGNAL_TYPES = ['PLCOutputBool', 'PLCInputBool', 'PLCOutputFloat', 'PLCInputFloat', 'PLCOutputInt', 'PLCInputInt'];
    const missing: string[] = [];
    load.root.traverse((node) => {
      const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
      if (!rv) return;
      const type = SIGNAL_TYPES.find((t) => rv[t]);
      if (!type) return;
      const comment = (rv[type] as { Comment?: string }).Comment;
      if (!comment) missing.push(node.name);
    });
    expect(missing, `signals without a Comment: ${missing.join(', ')}`).toEqual([]);
  });
});
