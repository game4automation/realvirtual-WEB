// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { MaintenancePlugin, type MaintenanceMode, type StepResult } from '../src/plugins/demo/maintenance-plugin';
import type { MaintenanceProcedure } from '../src/core/maintenance-parser';
import type { RVViewer } from '../src/core/rv-viewer';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';
import { Object3D, Scene } from 'three';
import { EventEmitter } from '../src/core/rv-events';
import { loadMaintenanceProgress, saveMaintenanceProgress } from '../src/core/hmi/maintenance-progress-store';

// ─── Mock Viewer ────────────────────────────────────────────────────────

/** Create a minimal mock viewer that supports events + highlight + camera. */
function createMockViewer(): RVViewer {
  const emitter = new EventEmitter();
  let _isCameraAnimating = false;

  const viewer = {
    scene: new Scene(),
    highlightByPath: vi.fn(),
    clearHighlight: vi.fn(),
    animateCameraTo: vi.fn((_pos, _target, _dur) => {
      _isCameraAnimating = true;
      // Simulate camera animation completing after short delay
      setTimeout(() => {
        _isCameraAnimating = false;
        emitter.emit('camera-animation-done', {});
      }, 10);
    }),
    get isCameraAnimating() { return _isCameraAnimating; },
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    once: emitter.once.bind(emitter),
    emit: emitter.emit.bind(emitter),
    removeAllListeners: emitter.removeAllListeners.bind(emitter),
  } as unknown as RVViewer;

  return viewer;
}

/** Create a test maintenance procedure. */
function createTestProcedure(): MaintenanceProcedure {
  return {
    name: 'Test Procedure',
    estimatedMinutes: 15,
    steps: [
      {
        index: 0,
        title: 'Step 1',
        instruction: 'First instruction',
        warningNote: '',
        icon: 'build',
        severity: 'Info',
        camera: { px: 1, py: 2, pz: 3, tx: 0, ty: 0, tz: 0 },
        cameraDuration: 0.8,
        highlightPaths: ['Path/Target1'],
        checkboxLabel: 'Done',
        completionType: 'Checkbox',
        estimatedMinutes: 5,
      },
      {
        index: 1,
        title: 'Step 2',
        instruction: 'Second instruction',
        warningNote: 'Be careful!',
        icon: 'warning',
        severity: 'Warning',
        camera: { px: 4, py: 5, pz: 6, tx: 1, ty: 1, tz: 1 },
        cameraDuration: 1.0,
        highlightPaths: ['Path/Target2', 'Path/Target3'],
        checkboxLabel: 'Confirmed',
        completionType: 'ConfirmWarning',
        estimatedMinutes: 3,
      },
      {
        index: 2,
        title: 'Step 3',
        instruction: 'Third instruction',
        warningNote: '',
        icon: 'build',
        severity: 'Info',
        camera: null,
        cameraDuration: 0.8,
        highlightPaths: [],
        checkboxLabel: 'Got it',
        completionType: 'Observation',
        estimatedMinutes: 2,
      },
    ],
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('MaintenancePlugin', () => {
  let plugin: MaintenancePlugin;
  let mockViewer: RVViewer;
  const testProcedure = createTestProcedure();

  beforeEach(() => {
    // Clear localStorage to prevent cross-test persistence interference
    localStorage.clear();

    mockViewer = createMockViewer();
    plugin = new MaintenancePlugin();

    // Simulate model loaded (with no real GLB data, so procedures will be empty)
    plugin.onModelLoaded({} as LoadResult, mockViewer);
  });

  test('initial state is idle', () => {
    const state = plugin.getState();
    expect(state.mode).toBe('idle');
    expect(state.procedure).toBeNull();
    expect(state.currentStep).toBe(0);
    expect(state.stepResults).toEqual([]);
  });

  test('startScenario activates maintenance mode (stepbystep)', () => {
    plugin.startScenario(testProcedure, 'stepbystep');
    const state = plugin.getState();
    expect(state.mode).toBe('stepbystep');
    expect(state.currentStep).toBe(0);
    expect(state.procedure).not.toBeNull();
    expect(state.procedure!.name).toBe('Test Procedure');
    expect(state.stepResults.length).toBe(3);
    expect(state.stepResults.every(r => r === null)).toBe(true);
  });

  test('startScenario triggers camera animation for first step', () => {
    plugin.startScenario(testProcedure, 'stepbystep');
    expect(mockViewer.animateCameraTo).toHaveBeenCalledTimes(1);
  });

  test('startScenario triggers highlight for first step', () => {
    plugin.startScenario(testProcedure, 'stepbystep');
    expect(mockViewer.clearHighlight).toHaveBeenCalled();
    expect(mockViewer.highlightByPath).toHaveBeenCalledWith('Path/Target1', true);
  });

  test('nextStep advances step index', () => {
    plugin.startScenario(testProcedure, 'stepbystep');
    plugin.nextStep();
    expect(plugin.getState().currentStep).toBe(1);
  });

  test('nextStep to last step transitions to completed', () => {
    plugin.startScenario(testProcedure, 'stepbystep');
    plugin.goToStep(2); // Go to last step
    plugin.nextStep();  // One more should complete
    expect(plugin.getState().mode).toBe('completed');
  });

  test('prevStep goes back one step', () => {
    plugin.startScenario(testProcedure, 'stepbystep');
    plugin.goToStep(2);
    plugin.prevStep();
    expect(plugin.getState().currentStep).toBe(1);
  });

  test('prevStep does nothing at step 0', () => {
    plugin.startScenario(testProcedure, 'stepbystep');
    plugin.prevStep();
    expect(plugin.getState().currentStep).toBe(0);
  });

  test('completeStep records result', () => {
    plugin.startScenario(testProcedure, 'stepbystep');
    plugin.completeStep(0, 'pass');
    expect(plugin.getState().stepResults[0]).toBe('pass');
    expect(plugin.getState().stepResults[1]).toBeNull();
  });

  test('completeStep records fail result', () => {
    plugin.startScenario(testProcedure, 'stepbystep');
    plugin.completeStep(1, 'fail');
    expect(plugin.getState().stepResults[1]).toBe('fail');
  });

  test('exitMaintenance clears state', () => {
    plugin.startScenario(testProcedure, 'stepbystep');
    plugin.exitMaintenance();
    const state = plugin.getState();
    expect(state.mode).toBe('idle');
    expect(state.procedure).toBeNull();
    expect(state.stepResults).toEqual([]);
    expect(mockViewer.clearHighlight).toHaveBeenCalled();
  });

  test('goToStep navigates to specific step', () => {
    plugin.startScenario(testProcedure, 'stepbystep');
    plugin.goToStep(2);
    expect(plugin.getState().currentStep).toBe(2);
  });

  test('goToStep ignores out-of-range index', () => {
    plugin.startScenario(testProcedure, 'stepbystep');
    plugin.goToStep(999);
    expect(plugin.getState().currentStep).toBe(0);
    plugin.goToStep(-1);
    expect(plugin.getState().currentStep).toBe(0);
  });

  test('restoreProgress restores step results', () => {
    plugin.startScenario(testProcedure, 'stepbystep');
    plugin.restoreProgress(['pass', 'fail', null]);
    const state = plugin.getState();
    expect(state.stepResults).toEqual(['pass', 'fail', null]);
  });

  test('restoreProgress pads short arrays', () => {
    plugin.startScenario(testProcedure, 'stepbystep');
    plugin.restoreProgress(['pass']);
    const state = plugin.getState();
    expect(state.stepResults.length).toBe(3);
    expect(state.stepResults[0]).toBe('pass');
    expect(state.stepResults[1]).toBeNull();
    expect(state.stepResults[2]).toBeNull();
  });

  test('flythrough mode can be cancelled', () => {
    plugin.startScenario(testProcedure, 'flythrough');
    expect(plugin.getState().mode).toBe('flythrough');
    plugin.exitMaintenance();
    expect(plugin.getState().mode).toBe('idle');
  });

  test('emits maintenance-mode-changed events', () => {
    const handler = vi.fn();
    mockViewer.on('maintenance-mode-changed' as any, handler);
    plugin.startScenario(testProcedure, 'stepbystep');
    expect(handler).toHaveBeenCalled();
    const lastCall = handler.mock.calls[handler.mock.calls.length - 1][0];
    expect(lastCall.active).toBe(true);
    expect(lastCall.mode).toBe('stepbystep');
  });

  test('emits maintenance-step-changed events', () => {
    const handler = vi.fn();
    mockViewer.on('maintenance-step-changed' as any, handler);
    plugin.startScenario(testProcedure, 'stepbystep');
    expect(handler).toHaveBeenCalled();
    const call = handler.mock.calls[0][0];
    expect(call.stepIndex).toBe(0);
    expect(call.step.title).toBe('Step 1');
  });

  test('step without camera does not call animateCameraTo', () => {
    plugin.startScenario(testProcedure, 'stepbystep');
    (mockViewer.animateCameraTo as ReturnType<typeof vi.fn>).mockClear();
    plugin.goToStep(2); // Step 3 has no camera
    expect(mockViewer.animateCameraTo).not.toHaveBeenCalled();
  });

  test('step with multiple highlights highlights all paths', () => {
    plugin.startScenario(testProcedure, 'stepbystep');
    (mockViewer.highlightByPath as ReturnType<typeof vi.fn>).mockClear();
    plugin.goToStep(1); // Step 2 has two highlight paths
    expect(mockViewer.highlightByPath).toHaveBeenCalledWith('Path/Target2', true);
    expect(mockViewer.highlightByPath).toHaveBeenCalledWith('Path/Target3', true);
  });

  // ─── Persistence Tests ──────────────────────────────────────────────

  test('completeStep persists progress to localStorage', () => {
    plugin.startScenario(testProcedure, 'stepbystep');
    plugin.completeStep(0, 'pass');
    const saved = loadMaintenanceProgress('Test Procedure');
    expect(saved).not.toBeNull();
    expect(saved!.stepResults[0]).toBe('pass');
  });

  test('startScenario restores saved progress in stepbystep mode', () => {
    // Pre-save progress
    saveMaintenanceProgress('Test Procedure', ['pass', 'fail', null], 2);

    plugin.startScenario(testProcedure, 'stepbystep');
    const state = plugin.getState();
    expect(state.stepResults[0]).toBe('pass');
    expect(state.stepResults[1]).toBe('fail');
    expect(state.stepResults[2]).toBeNull();
    expect(state.currentStep).toBe(2);
  });

  test('startScenario does NOT restore progress in flythrough mode', () => {
    saveMaintenanceProgress('Test Procedure', ['pass', 'fail', null], 2);

    plugin.startScenario(testProcedure, 'flythrough');
    const state = plugin.getState();
    expect(state.stepResults.every(r => r === null)).toBe(true);
    expect(state.currentStep).toBe(0);
  });

  test('exitMaintenance from completed clears saved progress', () => {
    plugin.startScenario(testProcedure, 'stepbystep');
    plugin.completeStep(0, 'pass');
    plugin.completeStep(1, 'pass');
    plugin.completeStep(2, 'pass');
    plugin.goToStep(2);
    plugin.nextStep(); // Transitions to completed

    expect(plugin.getState().mode).toBe('completed');
    plugin.exitMaintenance();

    // Progress should be cleared since we completed
    const saved = loadMaintenanceProgress('Test Procedure');
    expect(saved).toBeNull();
  });

  test('exitMaintenance from stepbystep keeps saved progress', () => {
    plugin.startScenario(testProcedure, 'stepbystep');
    plugin.completeStep(0, 'pass');
    plugin.goToStep(1);

    // Exit mid-way — progress should be kept
    plugin.exitMaintenance();
    const saved = loadMaintenanceProgress('Test Procedure');
    expect(saved).not.toBeNull();
    expect(saved!.stepResults[0]).toBe('pass');
  });
});

describe('MaintenancePlugin enter-maintenance event', () => {
  test('enter-maintenance event triggers enterMaintenance', () => {
    const mockViewer = createMockViewer();
    const plugin = new MaintenancePlugin();

    // Manually set procedures since we don't have a real GLB
    plugin.onModelLoaded({} as LoadResult, mockViewer);
    // Trigger enter-maintenance — should be a no-op since no procedures
    mockViewer.emit('enter-maintenance' as any, undefined);
    expect(plugin.getState().mode).toBe('idle');
  });
});

describe('EventEmitter once()', () => {
  test('once() fires exactly once then auto-unsubscribes', () => {
    const emitter = new EventEmitter();
    const handler = vi.fn();
    emitter.once('test-event', handler);

    emitter.emit('test-event', 'first');
    emitter.emit('test-event', 'second');

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('first');
  });

  test('once() returns unsubscribe function that works before fire', () => {
    const emitter = new EventEmitter();
    const handler = vi.fn();
    const off = emitter.once('test-event', handler);

    off(); // unsubscribe before event fires
    emitter.emit('test-event', 'data');

    expect(handler).not.toHaveBeenCalled();
  });
});
