// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, test, expect, vi } from 'vitest';
import { Object3D, Scene } from 'three';
import { createTestViewer } from './helpers/test-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVDrive } from '../src/core/engine/rv-drive';
import { RVDriveSimple } from '../src/core/engine/rv-drive-simple';
import { applySchema } from '../src/core/engine/rv-component-registry';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';

describe('SimController — resetSimulation()', () => {
  test('clears all MUs', () => {
    const viewer = createTestViewer({ initialMus: 5 });
    expect(viewer.transportManager.mus.length).toBe(5);
    viewer.resetSimulation();
    expect(viewer.transportManager.mus.length).toBe(0);
  });

  test('resets transport counters to zero', () => {
    const viewer = createTestViewer({ initialMus: 5 });
    viewer.transportManager.totalConsumed = 17;
    viewer.resetSimulation();
    expect(viewer.transportManager.totalSpawned).toBe(0);
    expect(viewer.transportManager.totalConsumed).toBe(0);
  });

  test('calls logicEngine.reset()', () => {
    const viewer = createTestViewer();
    expect(viewer.logicEngine.resetCalls).toBe(0);
    viewer.resetSimulation();
    expect(viewer.logicEngine.resetCalls).toBe(1);
  });

  test('does NOT touch signal values', () => {
    const viewer = createTestViewer();
    viewer.signalStore!.set('ConveyorRunning', true);
    viewer.signalStore!.set('Speed', 42.5);
    viewer.resetSimulation();
    expect(viewer.signalStore!.get('ConveyorRunning')).toBe(true);
    expect(viewer.signalStore!.get('Speed')).toBe(42.5);
  });

  test('does NOT change pause state', () => {
    const viewer = createTestViewer({ initialMus: 2 });
    viewer.setSimulationPaused('user', true);
    expect(viewer.isSimulationPaused).toBe(true);
    viewer.resetSimulation();
    expect(viewer.isSimulationPaused).toBe(true);
    expect(viewer.simulationPauseReasons).toContain('user');
  });

  test('emits simulation-reset → simulation-resetstat → simulation-start in order', () => {
    const viewer = createTestViewer();
    const order: string[] = [];
    viewer.on('simulation-reset', () => order.push('reset'));
    viewer.on('simulation-resetstat', () => order.push('resetstat'));
    viewer.on('simulation-start', () => order.push('start'));
    viewer.resetSimulation();
    expect(order).toEqual(['reset', 'resetstat', 'start']);
  });

  test('calls reset() on every drive', () => {
    const viewer = createTestViewer();
    const resetCalls: string[] = [];
    viewer.drives = [
      { name: 'A', reset() { resetCalls.push('A'); } },
      { name: 'B', reset() { resetCalls.push('B'); } },
    ];
    viewer.resetSimulation();
    expect(resetCalls).toEqual(['A', 'B']);
  });

  test('simulation-reset fires BEFORE the engine clears MUs', () => {
    const viewer = createTestViewer({ initialMus: 3 });
    let musAtReset = -1;
    // The reset event must run while the live MUs are still present, so a
    // behavior's onReset handler can reference them before the engine drops them.
    viewer.on('simulation-reset', () => { musAtReset = viewer.transportManager.mus.length; });
    viewer.resetSimulation();
    expect(musAtReset).toBe(3);
    expect(viewer.transportManager.mus.length).toBe(0); // cleared afterwards
  });
});

describe('SimController — clearPauseReasons()', () => {
  test('clears all pause reasons when called with no argument', () => {
    const viewer = createTestViewer();
    viewer.setSimulationPaused('user', true);
    viewer.setSimulationPaused('layout-edit', true);
    expect(viewer.simulationPauseReasons.length).toBe(2);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    viewer.clearPauseReasons();
    expect(viewer.isSimulationPaused).toBe(false);
    expect(viewer.simulationPauseReasons.length).toBe(0);
    warnSpy.mockRestore();
  });

  test('clears only the specified reason when one is given', () => {
    const viewer = createTestViewer();
    viewer.setSimulationPaused('user', true);
    viewer.setSimulationPaused('layout-edit', true);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    viewer.clearPauseReasons('user');
    expect(viewer.isSimulationPaused).toBe(true);
    expect(viewer.simulationPauseReasons).toEqual(['layout-edit']);
    warnSpy.mockRestore();
  });

  test('is a no-op if no reasons are active', () => {
    const viewer = createTestViewer();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    viewer.clearPauseReasons();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('SimController — pause event re-entrancy guard', () => {
  test('nested setSimulationPaused inside a handler does not recurse', () => {
    const viewer = createTestViewer();
    const events: { reason: string; paused: boolean }[] = [];

    let entered = false;
    viewer.on('simulation-pause-changed', (e: any) => {
      events.push({ reason: e.reason, paused: e.paused });
      // Re-entrant trigger: try to pause for a DIFFERENT reason from inside
      // the handler. Without the guard this would produce a nested event,
      // potentially leading to subscriber-reorder bugs or stack growth.
      if (!entered) {
        entered = true;
        viewer.setSimulationPaused('inner', true);
      }
    });

    viewer.setSimulationPaused('user', true);
    // The outer event MUST have fired. The inner re-entrant call mutated
    // the reason-set but its own pause-changed emit was suppressed (idle→
    // paused transition only happens once for the same idle→paused edge).
    expect(events.length).toBe(1);
    expect(events[0].reason).toBe('user');
    expect(viewer.simulationPauseReasons).toContain('inner');
    expect(viewer.simulationPauseReasons).toContain('user');
  });
});

// ─── Signal level re-apply (plan-427) ───────────────────────────────────────

describe('SimController — signal level re-apply on reset', () => {
  /**
   * The core regression. Reproduces the reported failure in miniature:
   * Drive_Simple with `Forward` bound to a PLCOutputBool that is held `true`.
   * `resetSimulation()` calls `drive.reset()`, which clears `jogForward` — and
   * because the SignalStore only notifies on CHANGE, the still-`true` level
   * used to be lost forever and the conveyor stayed dead.
   */
  function buildDriveWithHeldForwardSignal() {
    const scene = new Scene();
    const root = new Object3D(); root.name = 'Root'; scene.add(root);
    const signalNode = new Object3D(); signalNode.name = 'Run'; root.add(signalNode);
    const speedNode = new Object3D(); speedNode.name = 'RunSpeed'; root.add(speedNode);
    const driveNode = new Object3D(); driveNode.name = 'Conveyor'; root.add(driveNode);

    const registry = new NodeRegistry();
    const signalStore = new SignalStore();
    scene.traverse((n) => {
      if (!n.parent) return;
      registry.registerNode(NodeRegistry.computeNodePath(n), n);
    });

    const signalPath = NodeRegistry.computeNodePath(signalNode);
    signalStore.register('Run', signalPath, true, 'PLCOutputBool');
    const speedPath = NodeRegistry.computeNodePath(speedNode);
    signalStore.register('RunSpeed', speedPath, 350, 'PLCOutputFloat');

    const drivePath = NodeRegistry.computeNodePath(driveNode);
    const drive = new RVDrive(driveNode);
    applySchema(drive as unknown as Record<string, unknown>,
      RVDrive.schema, { Direction: 'LinearX', TargetSpeed: 200 });
    drive.initDrive();
    registry.register('Drive', drivePath, drive);

    const viewer = createTestViewer();
    const behavior = new RVDriveSimple(driveNode);
    behavior.Forward = signalPath;
    behavior.Speed = speedPath;   // exercises the numeric slot too

    const ctx = {
      registry, signalStore, scene, root,
      transportManager: {} as never,
      reapply: viewer.signalReapply,
    } as unknown as ComponentContext;
    behavior.init(ctx);

    viewer.drives = [drive];
    return { viewer, drive, behavior, signalStore, signalPath };
  }

  test('a level held true across resetSimulation() drives the component again', () => {
    const { viewer, drive } = buildDriveWithHeldForwardSignal();
    // Wiring already applied the held level once.
    expect(drive.jogForward).toBe(true);

    viewer.resetSimulation();

    // drive.reset() cleared jogForward in phase 1; the re-apply put the still
    // standing PLC level back on in phase 3. Without it the belt stays dead.
    expect(drive.jogForward).toBe(true);
  });

  test('without the re-apply the jog would be gone — guard against a silent regression', () => {
    const { viewer, drive } = buildDriveWithHeldForwardSignal();
    viewer.signalReapply.clear();   // simulate the pre-plan-427 behaviour
    viewer.resetSimulation();
    expect(drive.jogForward).toBe(false);
  });

  test('a level that went FALSE before the reset is not resurrected', () => {
    const { viewer, drive, signalStore } = buildDriveWithHeldForwardSignal();
    signalStore.set('Run', false);
    expect(drive.jogForward).toBe(false);

    viewer.resetSimulation();
    expect(drive.jogForward).toBe(false);
  });

  test('the re-apply reads the CURRENT store value, not the one seen at wire time', () => {
    const { viewer, drive, signalStore } = buildDriveWithHeldForwardSignal();
    signalStore.set('Run', false);
    signalStore.set('Run', true);
    viewer.resetSimulation();
    expect(drive.jogForward).toBe(true);
  });

  test('reapply runs on simulation-start, after every start subscriber', () => {
    const viewer = createTestViewer();
    const order: string[] = [];
    viewer.on('simulation-reset', () => order.push('reset'));
    viewer.on('simulation-resetstat', () => order.push('resetstat'));
    viewer.on('simulation-start', () => order.push('start'));
    viewer.signalReapply.register('Run', () => order.push('reapply'));

    viewer.resetSimulation();

    // Last on purpose: a behavior that re-asserts its own level inside
    // 'simulation-start' must not overwrite the live PLC level.
    expect(order).toEqual(['reset', 'resetstat', 'start', 'reapply']);
  });

  test('reapply does NOT fire on a bare simulation-reset emit', () => {
    const viewer = createTestViewer();
    const applied: string[] = [];
    viewer.signalReapply.register('Run', () => applied.push('reapply'));

    viewer.emit('simulation-reset', undefined);
    expect(applied).toEqual([]);
  });

  test('repeated resets stay idempotent', () => {
    const { viewer, drive } = buildDriveWithHeldForwardSignal();
    viewer.resetSimulation();
    viewer.resetSimulation();
    viewer.resetSimulation();
    expect(drive.jogForward).toBe(true);
    // Only the two BOUND slots register — an empty slot wires nothing.
    expect(viewer.signalReapply.size).toBe(2); // Forward + Speed
  });

  test('a numeric slot the PLC never wrote leaves the authored speed alone', () => {
    const { viewer, drive } = buildDriveWithHeldForwardSignal();
    // RunSpeed is registered but was never written, so it reads as its
    // registration value. Neither wiring nor the re-apply may push that onto
    // the drive — the authored TargetSpeed (200) has to stand, or the belt
    // would run at whatever the store happened to be seeded with.
    expect(drive.targetSpeed).toBe(200);

    viewer.resetSimulation();
    expect(drive.targetSpeed).toBe(200);
  });

  test('a numeric slot the PLC DID write is re-applied after the reset', () => {
    const { viewer, drive, signalStore } = buildDriveWithHeldForwardSignal();
    signalStore.set('RunSpeed', 120);
    expect(drive.targetSpeed).toBe(120);

    viewer.resetSimulation();
    // drive.reset() re-seeds targetSpeed from the authored TargetSpeed (200);
    // the re-apply then puts the PLC's current 120 back on top.
    expect(drive.targetSpeed).toBe(120);
    expect(Number.isNaN(drive.targetSpeed)).toBe(false);
  });

  test('signals themselves remain untouched by the re-apply', () => {
    const { viewer, signalStore } = buildDriveWithHeldForwardSignal();
    viewer.resetSimulation();
    expect(signalStore.get('Run')).toBe(true);
  });

  test('Drive_Simple.dispose() drops the input slots (incl. the former Speed leak)', () => {
    const { viewer, behavior, drive, signalStore } = buildDriveWithHeldForwardSignal();
    expect(viewer.signalReapply.size).toBe(2);

    behavior.dispose();
    expect(viewer.signalReapply.size).toBe(0);

    // The store subscriptions are gone as well: a later change must not reach
    // the (now detached) drive.
    drive.jogForward = false;
    signalStore.set('Run', false);
    signalStore.set('Run', true);
    expect(drive.jogForward).toBe(false);
  });
});
