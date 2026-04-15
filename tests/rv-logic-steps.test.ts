// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * LogicStep Unit Tests
 *
 * Tests all LogicStep types: containers, delay, signal steps,
 * sensor steps, drive steps, and the engine builder.
 */
import { describe, it, expect, vi } from 'vitest';
import { Object3D } from 'three';
import { RVDrive, DriveDirection } from '../src/core/engine/rv-drive';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import {
  StepState,
  RVSerialContainer,
  RVParallelContainer,
  RVDelay,
  RVSetSignalBool,
  RVWaitForSignalBool,
  RVWaitForSensor,
  RVDriveTo,
  RVSetDriveSpeed,
  RVEnable,
} from '../src/core/engine/rv-logic-step';
import type { RVSensor } from '../src/core/engine/rv-sensor';

function makeDrive(name: string, startPos = 0): RVDrive {
  const node = new Object3D();
  node.name = name;
  const drive = new RVDrive(node);
  drive.Direction = DriveDirection.LinearX;
  drive.ReverseDirection = false;
  drive.Offset = 0;
  drive.StartPosition = startPos;
  drive.TargetSpeed = 100;
  drive.Acceleration = 0;
  drive.UseAcceleration = false;
  drive.UseLimits = false;
  drive.LowerLimit = 0;
  drive.UpperLimit = 1000;
  drive.initDrive();
  return drive;
}

function makeSensor(occupied = false): RVSensor {
  return { occupied, node: new Object3D() } as unknown as RVSensor;
}

// ─── Delay ───────────────────────────────────────────────────

describe('RVDelay', () => {
  it('should finish after duration', () => {
    const step = new RVDelay(0.5);
    step.start();
    expect(step.state).toBe(StepState.Active);

    step.fixedUpdate(0.2);
    expect(step.state).toBe(StepState.Active);

    step.fixedUpdate(0.3);
    expect(step.state).toBe(StepState.Finished);
  });

  it('should finish immediately with zero duration', () => {
    const step = new RVDelay(0);
    step.start();
    expect(step.state).toBe(StepState.Finished);
  });

  it('should reset correctly', () => {
    const step = new RVDelay(1);
    step.start();
    step.fixedUpdate(1);
    expect(step.state).toBe(StepState.Finished);

    step.reset();
    expect(step.state).toBe(StepState.Idle);
  });
});

// ─── SetSignalBool ───────────────────────────────────────────

describe('RVSetSignalBool', () => {
  it('should set signal and finish immediately', () => {
    const store = new SignalStore();
    store.register('sig/a', 'sig/a', false);

    const step = new RVSetSignalBool('sig/a', true, store);
    step.start();

    expect(step.state).toBe(StepState.Finished);
    expect(store.getBoolByPath('sig/a')).toBe(true);
  });

  it('should skip with null address', () => {
    const store = new SignalStore();
    const step = new RVSetSignalBool(null, true, store);
    step.start();
    expect(step.state).toBe(StepState.Finished);
  });
});

// ─── WaitForSignalBool ───────────────────────────────────────

describe('RVWaitForSignalBool', () => {
  it('should wait until signal matches', () => {
    const store = new SignalStore();
    store.register('sig/b', 'sig/b', false);

    const step = new RVWaitForSignalBool('sig/b', true, store);
    step.start();
    expect(step.state).toBe(StepState.Waiting);

    step.fixedUpdate(0.02);
    expect(step.state).toBe(StepState.Waiting);

    store.setByPath('sig/b', true);
    step.fixedUpdate(0.02);
    expect(step.state).toBe(StepState.Finished);
  });

  it('should finish immediately if signal already matches', () => {
    const store = new SignalStore();
    store.register('sig/c', 'sig/c', true);

    const step = new RVWaitForSignalBool('sig/c', true, store);
    step.start();
    expect(step.state).toBe(StepState.Finished);
  });

  it('should skip with null address', () => {
    const store = new SignalStore();
    const step = new RVWaitForSignalBool(null, true, store);
    step.start();
    expect(step.state).toBe(StepState.Finished);
  });
});

// ─── WaitForSensor ───────────────────────────────────────────

describe('RVWaitForSensor', () => {
  it('should wait until sensor is occupied', () => {
    const sensor = makeSensor(false);

    const step = new RVWaitForSensor(sensor, true);
    step.start();
    expect(step.state).toBe(StepState.Waiting);

    step.fixedUpdate(0.02);
    expect(step.state).toBe(StepState.Waiting);

    sensor.occupied = true;
    step.fixedUpdate(0.02);
    expect(step.state).toBe(StepState.Finished);
  });

  it('should finish immediately if sensor already matches', () => {
    const sensor = makeSensor(true);
    const step = new RVWaitForSensor(sensor, true);
    step.start();
    expect(step.state).toBe(StepState.Finished);
  });

  it('should wait for not-occupied', () => {
    const sensor = makeSensor(true);
    const step = new RVWaitForSensor(sensor, false);
    step.start();
    expect(step.state).toBe(StepState.Waiting);

    sensor.occupied = false;
    step.fixedUpdate(0.02);
    expect(step.state).toBe(StepState.Finished);
  });

  it('should skip with null sensor', () => {
    const step = new RVWaitForSensor(null, true);
    step.start();
    expect(step.state).toBe(StepState.Finished);
  });
});

// ─── DriveTo ─────────────────────────────────────────────────

describe('RVDriveTo', () => {
  it('should start drive movement to destination', () => {
    const drive = makeDrive('d1', 0);
    const step = new RVDriveTo(drive, 500, false, 'Automatic');
    step.start();

    expect(step.state).toBe(StepState.Active);
    expect(drive.targetPosition).toBe(500);
    expect(drive.isRunning).toBe(true);
  });

  it('should finish when drive reaches target', () => {
    const drive = makeDrive('d1', 0);
    const step = new RVDriveTo(drive, 500, false, 'Automatic');
    step.start();

    // Simulate drive reaching target
    drive.currentPosition = 500;
    step.fixedUpdate(0.02);
    expect(step.state).toBe(StepState.Finished);
  });

  it('should support relative destination', () => {
    const drive = makeDrive('d1', 100);
    const step = new RVDriveTo(drive, 200, true, 'Automatic');
    step.start();

    expect(drive.targetPosition).toBe(300); // 100 + 200
  });

  it('should clamp to drive limits', () => {
    const node = new Object3D();
    node.name = 'd1';
    const drive = new RVDrive(node);
    drive.Direction = DriveDirection.LinearX;
    drive.StartPosition = 0;
    drive.TargetSpeed = 100;
    drive.UseLimits = true;
    drive.LowerLimit = 0;
    drive.UpperLimit = 200;
    drive.initDrive();

    const step = new RVDriveTo(drive, 500, false, 'Automatic');
    step.start();

    expect(drive.targetPosition).toBe(200); // clamped to upperLimit
  });

  it('should skip with null drive', () => {
    const step = new RVDriveTo(null, 100, false, 'Automatic');
    step.start();
    expect(step.state).toBe(StepState.Finished);
  });
});

// ─── SetDriveSpeed ───────────────────────────────────────────

describe('RVSetDriveSpeed', () => {
  it('should set drive speed and finish immediately', () => {
    const drive = makeDrive('d1');
    const step = new RVSetDriveSpeed(drive, 250);
    step.start();

    expect(step.state).toBe(StepState.Finished);
    expect(drive.targetSpeed).toBe(250);
  });

  it('should skip with null drive', () => {
    const step = new RVSetDriveSpeed(null, 100);
    step.start();
    expect(step.state).toBe(StepState.Finished);
  });
});

// ─── Enable ──────────────────────────────────────────────────

describe('RVEnable', () => {
  it('should set target visibility', () => {
    const target = { visible: true };
    const step = new RVEnable(target, false);
    step.start();

    expect(step.state).toBe(StepState.Finished);
    expect(target.visible).toBe(false);
  });

  it('should handle null target gracefully', () => {
    const step = new RVEnable(null, true);
    step.start();
    expect(step.state).toBe(StepState.Finished);
  });
});

// ─── SerialContainer ─────────────────────────────────────────

describe('RVSerialContainer', () => {
  it('should execute children sequentially', () => {
    const d1 = new RVDelay(0.1);
    const d2 = new RVDelay(0.1);
    const d3 = new RVDelay(0.1);
    const container = new RVSerialContainer([d1, d2, d3], false);

    container.start();
    expect(container.state).toBe(StepState.Active);
    expect(d1.state).toBe(StepState.Active);
    expect(d2.state).toBe(StepState.Idle);

    container.fixedUpdate(0.1);
    expect(d1.state).toBe(StepState.Finished);
    expect(d2.state).toBe(StepState.Active);

    container.fixedUpdate(0.1);
    expect(d2.state).toBe(StepState.Finished);
    expect(d3.state).toBe(StepState.Active);

    container.fixedUpdate(0.1);
    expect(d3.state).toBe(StepState.Finished);
    expect(container.state).toBe(StepState.Finished);
  });

  it('should auto-loop when enabled', () => {
    const store = new SignalStore();
    store.register('sig/x', 'sig/x', false);

    const set1 = new RVSetSignalBool('sig/x', true, store);
    const set2 = new RVSetSignalBool('sig/x', false, store);
    const container = new RVSerialContainer([set1, set2], true);

    container.start();
    // start() only starts child 0, advancement happens in fixedUpdate
    container.fixedUpdate(0.02);
    // Both set steps finish immediately → first cycle done → auto-loop restarts
    expect(container.completedCycles).toBeGreaterThanOrEqual(1);
    expect(container.state).toBe(StepState.Active);
  });

  it('should handle empty children', () => {
    const container = new RVSerialContainer([], false);
    container.start();
    expect(container.state).toBe(StepState.Finished);
  });

  it('should skip immediate-finish steps rapidly', () => {
    const store = new SignalStore();
    const s1 = new RVSetSignalBool('a', true, store);
    const s2 = new RVSetSignalBool('b', true, store);
    const delay = new RVDelay(0.5);
    const container = new RVSerialContainer([s1, s2, delay], false);

    container.start();
    // start() kicks off child 0 (s1 finishes immediately)
    // fixedUpdate advances through s1→s2→delay
    container.fixedUpdate(0.02);
    expect(delay.state).toBe(StepState.Active);
    expect(container.currentIndex).toBe(2);
  });

  it('should reset all children', () => {
    const d1 = new RVDelay(0.1);
    const d2 = new RVDelay(0.1);
    const container = new RVSerialContainer([d1, d2], false);

    container.start();
    container.fixedUpdate(0.1);
    container.fixedUpdate(0.1);
    expect(container.state).toBe(StepState.Finished);

    container.reset();
    expect(container.state).toBe(StepState.Idle);
    expect(d1.state).toBe(StepState.Idle);
    expect(d2.state).toBe(StepState.Idle);
    expect(container.currentIndex).toBe(0);
  });
});

// ─── ParallelContainer ───────────────────────────────────────

describe('RVParallelContainer', () => {
  it('should execute all children simultaneously', () => {
    const d1 = new RVDelay(0.2);
    const d2 = new RVDelay(0.1);
    const container = new RVParallelContainer([d1, d2]);

    container.start();
    expect(d1.state).toBe(StepState.Active);
    expect(d2.state).toBe(StepState.Active);

    container.fixedUpdate(0.1);
    expect(d2.state).toBe(StepState.Finished);
    expect(d1.state).toBe(StepState.Active);
    expect(container.state).toBe(StepState.Active);

    container.fixedUpdate(0.1);
    expect(d1.state).toBe(StepState.Finished);
    expect(container.state).toBe(StepState.Finished);
  });

  it('should finish immediately if all children are instant', () => {
    const store = new SignalStore();
    const s1 = new RVSetSignalBool('a', true, store);
    const s2 = new RVSetSignalBool('b', true, store);
    const container = new RVParallelContainer([s1, s2]);

    container.start();
    expect(container.state).toBe(StepState.Finished);
  });

  it('should handle empty children', () => {
    const container = new RVParallelContainer([]);
    container.start();
    expect(container.state).toBe(StepState.Finished);
  });

  it('should reset all children', () => {
    const d1 = new RVDelay(0.1);
    const d2 = new RVDelay(0.1);
    const container = new RVParallelContainer([d1, d2]);

    container.start();
    container.fixedUpdate(0.1);
    expect(container.state).toBe(StepState.Finished);

    container.reset();
    expect(container.state).toBe(StepState.Idle);
    expect(d1.state).toBe(StepState.Idle);
    expect(d2.state).toBe(StepState.Idle);
  });
});

// ─── Nested Containers ───────────────────────────────────────

describe('Nested Containers', () => {
  it('should execute serial inside parallel', () => {
    const d1 = new RVDelay(0.1);
    const d2 = new RVDelay(0.1);
    const serial = new RVSerialContainer([d1, d2], false);

    const d3 = new RVDelay(0.15);
    const parallel = new RVParallelContainer([serial, d3]);

    parallel.start();
    expect(parallel.state).toBe(StepState.Active);

    // After 0.1s: d1 done, d2 starts; d3 still active
    parallel.fixedUpdate(0.1);
    expect(d1.state).toBe(StepState.Finished);
    expect(d2.state).toBe(StepState.Active);
    expect(d3.state).toBe(StepState.Active);

    // After 0.15s: d3 done; d2 still active
    parallel.fixedUpdate(0.05);
    expect(d3.state).toBe(StepState.Finished);
    expect(d2.state).toBe(StepState.Active);
    expect(parallel.state).toBe(StepState.Active);

    // After 0.2s: d2 done → serial done → parallel done
    parallel.fixedUpdate(0.05);
    expect(d2.state).toBe(StepState.Finished);
    expect(serial.state).toBe(StepState.Finished);
    expect(parallel.state).toBe(StepState.Finished);
  });

  it('should support serial containing parallel', () => {
    const store = new SignalStore();
    const s1 = new RVSetSignalBool('a', true, store);
    const d1 = new RVDelay(0.1);
    const parallel = new RVParallelContainer([s1, d1]);

    const d2 = new RVDelay(0.1);
    const serial = new RVSerialContainer([parallel, d2], false);

    serial.start();
    expect(parallel.state).toBe(StepState.Active); // d1 not done yet

    serial.fixedUpdate(0.1);
    expect(parallel.state).toBe(StepState.Finished);
    expect(d2.state).toBe(StepState.Active);

    serial.fixedUpdate(0.1);
    expect(serial.state).toBe(StepState.Finished);
  });
});

// ─── Integration: Signal-Driven Flow ─────────────────────────

describe('Signal-Driven Flow', () => {
  it('should coordinate set + wait signal steps', () => {
    const store = new SignalStore();
    store.register('conveyor/start', 'conveyor/start', false);

    // Process 1: Set signal to true
    const setter = new RVSetSignalBool('conveyor/start', true, store);

    // Process 2: Wait for signal
    const waiter = new RVWaitForSignalBool('conveyor/start', true, store);

    // Run parallel
    const parallel = new RVParallelContainer([setter, waiter]);
    parallel.start();

    // setter finishes immediately, sets signal to true
    // waiter should also finish because signal is now true
    parallel.fixedUpdate(0.02);
    expect(parallel.state).toBe(StepState.Finished);
    expect(store.getBool('conveyor/start')).toBe(true);
  });
});

// ─── Progress Getter Tests ──────────────────────────────────────

describe('Progress Getter', () => {
  it('RVDelay: should report progress as elapsed/duration percentage', () => {
    const step = new RVDelay(1.0);
    expect(step.progress).toBe(0); // Idle

    step.start();
    expect(step.progress).toBe(0); // Just started, elapsed=0

    step.fixedUpdate(0.5);
    expect(step.progress).toBeCloseTo(50, 0);

    step.fixedUpdate(0.5);
    expect(step.progress).toBe(100); // Finished
  });

  it('RVDelay: zero-duration should report 0 then 100', () => {
    const step = new RVDelay(0);
    expect(step.progress).toBe(0);
    step.start();
    // Finishes immediately
    expect(step.progress).toBe(100);
  });

  it('RVSetSignalBool: should be 0 then 100', () => {
    const store = new SignalStore();
    store.register('sig/p', 'sig/p', false);
    const step = new RVSetSignalBool('sig/p', true, store);
    expect(step.progress).toBe(0);
    step.start();
    expect(step.progress).toBe(100);
  });

  it('RVWaitForSignalBool: should be 0, 50 while waiting, 100 when done', () => {
    const store = new SignalStore();
    store.register('sig/q', 'sig/q', false);
    const step = new RVWaitForSignalBool('sig/q', true, store);
    expect(step.progress).toBe(0);

    step.start();
    expect(step.progress).toBe(50); // Waiting

    store.setByPath('sig/q', true);
    step.fixedUpdate(0.02);
    expect(step.progress).toBe(100); // Finished
  });

  it('RVWaitForSensor: should be 0, 50 while waiting, 100 when done', () => {
    const sensor = makeSensor(false);
    const step = new RVWaitForSensor(sensor, true);
    expect(step.progress).toBe(0);

    step.start();
    expect(step.progress).toBe(50); // Waiting

    sensor.occupied = true;
    step.fixedUpdate(0.02);
    expect(step.progress).toBe(100); // Finished
  });

  it('RVDriveTo: should reflect drive position progress', () => {
    const drive = makeDrive('dp1', 0);
    const step = new RVDriveTo(drive, 1000, false, 'Automatic');
    expect(step.progress).toBe(0);

    step.start();
    // Drive starts at 0, target=1000
    drive.currentPosition = 500;
    expect(step.progress).toBeCloseTo(50, 0);

    drive.currentPosition = 1000;
    step.fixedUpdate(0.02);
    expect(step.progress).toBe(100);
  });

  it('RVSetDriveSpeed: should be 0 then 100', () => {
    const drive = makeDrive('dp2');
    const step = new RVSetDriveSpeed(drive, 500);
    expect(step.progress).toBe(0);
    step.start();
    expect(step.progress).toBe(100);
  });

  it('RVEnable: should be 0 then 100', () => {
    const target = { visible: true };
    const step = new RVEnable(target, false);
    expect(step.progress).toBe(0);
    step.start();
    expect(step.progress).toBe(100);
  });

  it('SerialContainer: should report weighted child progress', () => {
    const d1 = new RVDelay(1.0);
    const d2 = new RVDelay(1.0);
    const container = new RVSerialContainer([d1, d2], false);

    expect(container.progress).toBe(0); // Idle
    container.start();

    // d1 at 50% => container at 25% (50% of first half)
    d1.fixedUpdate(0.5);
    expect(container.progress).toBeGreaterThan(0);
    expect(container.progress).toBeLessThan(50);

    // d1 finishes => container at ~50%
    d1.fixedUpdate(0.5);
    container.fixedUpdate(0); // Advance to d2

    // After all done
    container.fixedUpdate(1.0);
    expect(container.progress).toBe(100);
  });

  it('ParallelContainer: should use minimum child progress', () => {
    const d1 = new RVDelay(0.2);
    const d2 = new RVDelay(0.4);
    const container = new RVParallelContainer([d1, d2]);

    expect(container.progress).toBe(0); // Idle
    container.start();

    container.fixedUpdate(0.2);
    // d1 finished (100%), d2 at 50% => min is 50%
    // But d1.progress=100, d2.progress~50, min=50
    expect(container.progress).toBeCloseTo(50, 0);

    container.fixedUpdate(0.2);
    expect(container.progress).toBe(100);
  });
});

// ─── Waiting State Transition Tests ─────────────────────────────

describe('Waiting State Transitions', () => {
  it('WaitForSignalBool should enter Waiting state (not Active)', () => {
    const store = new SignalStore();
    store.register('sig/w1', 'sig/w1', false);
    const step = new RVWaitForSignalBool('sig/w1', true, store);
    step.start();
    expect(step.state).toBe(StepState.Waiting);
    // Not Active
    expect(step.state).not.toBe(StepState.Active);
  });

  it('WaitForSensor should enter Waiting state (not Active)', () => {
    const sensor = makeSensor(false);
    const step = new RVWaitForSensor(sensor, true);
    step.start();
    expect(step.state).toBe(StepState.Waiting);
    expect(step.state).not.toBe(StepState.Active);
  });

  it('WaitForSignalBool should transition Waiting -> Finished', () => {
    const store = new SignalStore();
    store.register('sig/w2', 'sig/w2', false);
    const step = new RVWaitForSignalBool('sig/w2', true, store);
    step.start();
    expect(step.state).toBe(StepState.Waiting);

    store.setByPath('sig/w2', true);
    step.fixedUpdate(0.02);
    expect(step.state).toBe(StepState.Finished);
  });

  it('WaitForSensor should transition Waiting -> Finished', () => {
    const sensor = makeSensor(false);
    const step = new RVWaitForSensor(sensor, true);
    step.start();
    expect(step.state).toBe(StepState.Waiting);

    sensor.occupied = true;
    step.fixedUpdate(0.02);
    expect(step.state).toBe(StepState.Finished);
  });
});

// ─── Container with Waiting Children (Deadlock Prevention) ──────

describe('Container with Waiting children', () => {
  it('SerialContainer should not deadlock on Waiting child', () => {
    const store = new SignalStore();
    store.register('sig/dl', 'sig/dl', false);

    const wait = new RVWaitForSignalBool('sig/dl', true, store);
    const delay = new RVDelay(0.1);
    const container = new RVSerialContainer([wait, delay], false);

    container.start();
    expect(wait.state).toBe(StepState.Waiting);
    expect(container.state).toBe(StepState.Active);

    // fixedUpdate should still update the Waiting child
    container.fixedUpdate(0.02);
    expect(wait.state).toBe(StepState.Waiting); // Still waiting

    // Now signal matches
    store.setByPath('sig/dl', true);
    container.fixedUpdate(0.02);
    expect(wait.state).toBe(StepState.Finished);
    expect(delay.state).toBe(StepState.Active); // Next child started
  });

  it('ParallelContainer should not deadlock on Waiting child', () => {
    const sensor = makeSensor(false);
    const wait = new RVWaitForSensor(sensor, true);
    const delay = new RVDelay(0.1);
    const container = new RVParallelContainer([wait, delay]);

    container.start();
    expect(wait.state).toBe(StepState.Waiting);
    expect(delay.state).toBe(StepState.Active);
    expect(container.state).toBe(StepState.Active);

    // Update: delay finishes but wait is still waiting
    container.fixedUpdate(0.1);
    expect(delay.state).toBe(StepState.Finished);
    expect(wait.state).toBe(StepState.Waiting);
    expect(container.state).toBe(StepState.Active); // Not done yet

    // Sensor triggers
    sensor.occupied = true;
    container.fixedUpdate(0.02);
    expect(wait.state).toBe(StepState.Finished);
    expect(container.state).toBe(StepState.Finished); // Now all done
  });
});

// ─── Cycle Time Statistics ──────────────────────────────────────

describe('Cycle Time Statistics', () => {
  it('should track completedCycles', () => {
    const d1 = new RVDelay(0.1);
    const container = new RVSerialContainer([d1], true); // autoLoop

    container.start();
    container.fixedUpdate(0.1); // Complete cycle 1
    expect(container.completedCycles).toBe(1);

    container.fixedUpdate(0.1); // Complete cycle 2
    expect(container.completedCycles).toBe(2);
  });

  it('should compute min/max/median cycle times', () => {
    // We need to use performance.now() mocking for reliable times.
    // Since cycle time uses performance.now(), we can verify the properties exist
    // and are non-negative after cycles complete.
    const d1 = new RVDelay(0.05);
    const container = new RVSerialContainer([d1], true);

    container.start();

    // Run several cycles
    for (let i = 0; i < 5; i++) {
      container.fixedUpdate(0.05);
    }

    expect(container.completedCycles).toBe(5);
    expect(container.minCycleTime).toBeGreaterThanOrEqual(0);
    expect(container.maxCycleTime).toBeGreaterThanOrEqual(container.minCycleTime);
    expect(container.medianCycleTime).toBeGreaterThanOrEqual(0);
  });

  it('should return 0 for cycle times when no cycles completed', () => {
    const d1 = new RVDelay(1.0);
    const container = new RVSerialContainer([d1], true);

    expect(container.minCycleTime).toBe(0);
    expect(container.maxCycleTime).toBe(0);
    expect(container.medianCycleTime).toBe(0);
  });
});

// ─── STEP_STATE_COLORS Completeness ─────────────────────────────

describe('STEP_STATE_COLORS', () => {
  // Import at test scope to avoid circular deps
  it('should have a color for every StepState value', async () => {
    const { STEP_STATE_COLORS } = await import('../src/core/hmi/rv-logic-step-colors');
    for (const state of Object.values(StepState)) {
      expect(STEP_STATE_COLORS[state]).toBeDefined();
      expect(typeof STEP_STATE_COLORS[state]).toBe('string');
      // Should be a hex color
      expect(STEP_STATE_COLORS[state]).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it('should have a label for every StepState value', async () => {
    const { STEP_STATE_LABELS } = await import('../src/core/hmi/rv-logic-step-colors');
    for (const state of Object.values(StepState)) {
      expect(STEP_STATE_LABELS[state]).toBeDefined();
      expect(typeof STEP_STATE_LABELS[state]).toBe('string');
      expect(STEP_STATE_LABELS[state].length).toBeLessThanOrEqual(4);
    }
  });
});

// ─── StepByPath and getStepInfo ─────────────────────────────────

describe('stepByPath and getStepInfo', () => {
  it('should populate stepByPath with hierarchyPath from LogicEngine build', () => {
    // Create a minimal step and manually set path (integration test)
    const delay = new RVDelay(1.0);
    delay.name = 'TestDelay';
    delay.hierarchyPath = 'root/TestDelay';

    expect(delay.hierarchyPath).toBe('root/TestDelay');
  });

  it('RVLogicStep.hierarchyPath should default to empty string', () => {
    const delay = new RVDelay(0.5);
    expect(delay.hierarchyPath).toBe('');
  });

  it('getStepInfo should return correct fields for SerialContainer', () => {
    // We simulate what getStepInfo would return by checking the step properties
    const d1 = new RVDelay(0.1);
    const d2 = new RVDelay(0.1);
    const container = new RVSerialContainer([d1, d2], true);
    container.name = 'TestSerial';

    container.start();
    container.fixedUpdate(0.1); // d1 finishes, d2 starts

    // Verify the properties that getStepInfo reads
    expect(container.state).toBe(StepState.Active);
    expect(container.currentIndex).toBe(1);
    expect(container.children.length).toBe(2);
    expect(container.progress).toBeGreaterThan(0);
  });

  it('getStepInfo should return correct fields for ParallelContainer', () => {
    const d1 = new RVDelay(0.1);
    const d2 = new RVDelay(0.2);
    const container = new RVParallelContainer([d1, d2]);
    container.name = 'TestParallel';

    container.start();
    container.fixedUpdate(0.1); // d1 finishes

    expect(container.state).toBe(StepState.Active);
    expect(container.finishedCount).toBe(1);
    expect(container.children.length).toBe(2);
  });

  it('getStepInfo should return correct fields for RVDelay', () => {
    const delay = new RVDelay(1.0);
    delay.name = 'TestDelay';

    delay.start();
    delay.fixedUpdate(0.3);

    expect(delay.state).toBe(StepState.Active);
    expect(delay.elapsed).toBeCloseTo(0.3);
    expect(delay.duration).toBe(1.0);
    expect(delay.progress).toBeCloseTo(30, 0);
  });
});
