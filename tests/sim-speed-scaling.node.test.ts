// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Simulation speed in the continuous workspace (2026-10-25, Thomas: variant B).
 *
 * The sim toolbar factor must make SIMULATED TIME run faster, not only drives:
 * the sim clock, Source interval spawning, LogicStep Delay and
 * the material-flow / script timers all
 * advance by `factor × dt`. Plus the DES speed warning (trigger, dismissal, mode
 * switch) and the no-data watch, which must keep a 1×-pace window.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, Object3D, Scene } from 'three';
import { scaleSimDt, setDriveSpeedOverride } from '../src/core/engine/rv-speed-override';
import { RVDelay, StepState } from '../src/core/engine/rv-logic-step';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { processExtras } from '../src/core/engine/rv-scene-loader';
import { buildInitContext } from '../src/core/engine/rv-init-context';
import { SimRunningClock } from '../src/core/hmi/connect-no-data-watch';
import {
  DES_SPEED_WARN_FACTOR,
  dismissDesSpeedWarningForSession,
  isDesSpeedWarningDismissed,
  resetDesSpeedWarningForTests,
  shouldWarnDesSpeed,
  switchToDesMode,
  type DesSpeedWarnViewer,
} from '../src/plugins/sim-controller/sim-speed-des-warning';
import { RVViewer } from '../src/core/rv-viewer';

afterEach(() => {
  setDriveSpeedOverride(1);
  resetDesSpeedWarningForTests();
});

function sourceFixture(properties: Record<string, unknown>) {
  const scene = new Scene(), root = new Object3D(); root.name = 'Test'; scene.add(root);
  const node = new Mesh(new BoxGeometry(.02, .02, .02), new MeshBasicMaterial());
  node.name = 'Source'; node.position.y = 1;
  node.userData.realvirtual = { Source: { GenerateMU: false, AutomaticGeneration: false, ...properties } };
  root.add(node); scene.updateMatrixWorld(true);
  const manager = new RVTransportManager(); manager.scene = scene; manager.preferCloneMU = true;
  processExtras(root, buildInitContext({ registry: new NodeRegistry(), signalStore: new SignalStore(), transportManager: manager, scene }));
  return { manager, tick: (dt: number) => manager.update(dt) };
}

describe('scaleSimDt', () => {
  it('multiplies dt by the simulation speed and stops at 0', () => {
    expect(scaleSimDt(0.5)).toBe(0.5);
    setDriveSpeedOverride(10);
    expect(scaleSimDt(0.5)).toBe(5);
    setDriveSpeedOverride(0);
    expect(scaleSimDt(0.5)).toBe(0);
  });
});

describe('time-based logic follows the simulation speed', () => {
  it('LogicStep Delay finishes after duration / factor real seconds', () => {
    setDriveSpeedOverride(10);
    const step = new RVDelay(2);
    step.start();
    step.fixedUpdate(0.1); // 1 s simulated
    expect(step.state).toBe(StepState.Active);
    step.fixedUpdate(0.1); // 2 s simulated
    expect(step.state).toBe(StepState.Finished);
  });

  it('Source Interval spawning runs on simulated time', () => {
    const slow = sourceFixture({ Interval: 1, StartInterval: 1 });
    slow.tick(0.1); slow.tick(0.1);
    expect(slow.manager.mus).toHaveLength(0); // 0.2 s at 1x — nothing due yet

    setDriveSpeedOverride(10);
    const fast = sourceFixture({ Interval: 1, StartInterval: 1 });
    fast.tick(0.1); // 1 s simulated → first part
    expect(fast.manager.mus).toHaveLength(1);
    fast.tick(0.1); // 2 s simulated → second part
    expect(fast.manager.mus).toHaveLength(2);
  });

  it('a tick spanning several intervals spawns one part and leaves no backlog', () => {
    setDriveSpeedOverride(100);
    const { manager, tick } = sourceFixture({ Interval: 1, StartInterval: 1 });
    tick(1 / 60); // 1.67 s simulated
    tick(1 / 60); // 3.33 s simulated — intervals 2 and 3 fall into one tick
    expect(manager.mus).toHaveLength(2);
    setDriveSpeedOverride(0);
    tick(1 / 60); tick(1 / 60); tick(1 / 60);
    expect(manager.mus).toHaveLength(2); // stopped: no replay of skipped intervals
  });

  it('the viewer sim clock advances by factor × dt', () => {
    const fake = {
      logicRunState: 'active', simTickCount: 0, _simTime: 0,
      _getKernel: () => null,
      _coreSubsystems: { early: vi.fn(), drives: vi.fn(), visuals: vi.fn() },
      _snapshotPrePlugins: () => [], _snapshotPostPlugins: () => [],
      _runTickCallbacks: vi.fn(), behaviors: { tick: vi.fn() },
      _pushRenderBackendDriveValue: vi.fn(),
    };
    const fixedUpdate = (RVViewer.prototype as unknown as { fixedUpdate(dt: number): void }).fixedUpdate;
    fixedUpdate.call(fake, 1 / 60);
    expect(fake._simTime).toBeCloseTo(1 / 60, 12);
    setDriveSpeedOverride(10);
    fixedUpdate.call(fake, 1 / 60);
    expect(fake._simTime).toBeCloseTo(11 / 60, 12);
    // the stages still get the real fixed step (drives scale their speed themselves)
    expect(fake._coreSubsystems.drives).toHaveBeenLastCalledWith(1 / 60);
  });

});

describe('SimRunningClock (no-data watch window at 1x pace)', () => {
  it('divides simTime steps by the factor, holds on pause and resets on a jump back', () => {
    const clock = new SimRunningClock();
    expect(clock.advance(1, 10)).toBe(1); // step ran at 1x; 10x from now on
    expect(clock.advance(21, 10)).toBe(3); // 20 s simulated at 10x = 2 s running
    expect(clock.advance(21, 0)).toBe(3); // stopped
    expect(clock.advance(21, 1)).toBe(3); // no sim progress while stopped
    expect(clock.advance(0, 1)).toBe(0); // sim reset
  });

  it('divides each step by the factor in force during it (fold on speed change)', () => {
    const clock = new SimRunningClock();
    clock.advance(0, 100);
    clock.advance(100, 1); // speed change folds: 100 s simulated at 100x = 1 s
    expect(clock.advance(101, 1)).toBe(2); // then 1 s at 1x
  });
});

describe('DES speed warning', () => {
  function viewer(over: { desActive?: boolean; mode?: string | null; hasDes?: boolean } = {}) {
    const setMode = vi.fn();
    const setModeAsync = vi.fn(async () => true);
    const v: DesSpeedWarnViewer = {
      features: { isActive: (id: string) => id === 'des' && (over.desActive ?? true) },
      modes: {
        activeMode: over.mode === undefined ? 'planner' : over.mode,
        has: (id: string) => id === 'des' && (over.hasDes ?? true),
        setMode, setModeAsync,
      },
    };
    return { v, setMode, setModeAsync };
  }

  it('warns when crossing the threshold in a continuous workspace with DES blocks', () => {
    const { v } = viewer();
    expect(shouldWarnDesSpeed(v, DES_SPEED_WARN_FACTOR, 1)).toBe(true);
    expect(shouldWarnDesSpeed(v, 100, 5)).toBe(true);
    expect(shouldWarnDesSpeed(v, 5, 1)).toBe(false); // below the threshold
    expect(shouldWarnDesSpeed(v, 50, 25)).toBe(false); // already above — no repeat
  });

  it('stays silent without DES blocks, in DES / editor / HMI, or without a DES workspace', () => {
    expect(shouldWarnDesSpeed(viewer({ desActive: false }).v, 10, 1)).toBe(false);
    expect(shouldWarnDesSpeed(viewer({ mode: 'des' }).v, 10, 1)).toBe(false);
    expect(shouldWarnDesSpeed(viewer({ mode: 'editor' }).v, 10, 1)).toBe(false);
    expect(shouldWarnDesSpeed(viewer({ mode: 'hmi' }).v, 10, 1)).toBe(false);
    expect(shouldWarnDesSpeed(viewer({ hasDes: false }).v, 10, 1)).toBe(false);
    expect(shouldWarnDesSpeed(undefined, 10, 1)).toBe(false);
  });

  it('"Don\'t ask again" silences it for the session', () => {
    const { v } = viewer();
    dismissDesSpeedWarningForSession();
    expect(isDesSpeedWarningDismissed()).toBe(true);
    expect(shouldWarnDesSpeed(v, 10, 1)).toBe(false);
  });

  it('"Switch to DES mode" enters the DES workspace', () => {
    const { v, setModeAsync, setMode } = viewer();
    switchToDesMode(v);
    expect(setModeAsync).toHaveBeenCalledWith('des');
    expect(setMode).not.toHaveBeenCalled();
  });
});
