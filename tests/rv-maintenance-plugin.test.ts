// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { MaintenancePlugin } from '../src/plugins/demo/maintenance-plugin';
import type { MaintenanceProcedure, MaintenanceStep } from '../src/core/maintenance-parser';
import type { RVViewer } from '../src/core/rv-viewer';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';
import { Object3D, Scene } from 'three';
import { EventEmitter } from '../src/core/rv-events';
import { loadMaintenanceProgress, saveMaintenanceProgress } from '../src/core/hmi/maintenance-progress-store';
import {
  registerMaintenanceRuntime,
  setMaintenanceRenderLock,
  maintenanceRenderLockReason,
  MAINTENANCE_RENDER_LOCKED,
  type MaintenanceEndReason,
  type MaintenanceRuntime,
  type StepDirection,
} from '../src/core/maintenance-runtime-registry';
import { renderModeLockReason } from '../src/core/hmi/render-mode-controller';
import { CommandRegistry } from '../src/core/hmi/rv-command-registry';
import { ensureViewCommandsRegistered } from '../src/core/hmi/view-commands';
import { ensureSessionOverlayCommandsRegistered } from '../src/core/hmi/session-overlay-commands';
import { ensureComponentCommandsRegistered } from '../src/core/hmi/component-commands';
import { ensureQueryCommandsRegistered } from '../src/core/hmi/query-commands';
import { ensureDocumentCommandsRegistered } from '../src/core/hmi/document-commands';
import { ensureSignalAutomapCommandsRegistered } from '../src/core/hmi/signal-automap-commands';
import { ensureDesPlcCommandsRegistered } from '../src/core/hmi/des-plc-commands';
import { setAppConfig } from '../src/core/rv-app-config';
import { fakeRenderViewer } from './helpers/fake-render-viewer';

// ─── Mock Viewer ────────────────────────────────────────────────────────

/** Minimal industrial interface for the live check (duck type of BaseIndustrialInterface). */
interface FakeInterface {
  id: string;
  isConnected: boolean;
  connect(): Promise<void>;
  disconnect(): void;
}

function createFakeInterface(connected = false): FakeInterface {
  return { id: 'fake-plc', isConnected: connected, connect: async () => {}, disconnect: () => {} };
}

interface MockViewerOptions {
  /** Shared call log: pause changes are recorded as `pause:<true|false>`. */
  log?: string[];
  /** Interfaces registered in a fake `interface-manager`. */
  interfaces?: FakeInterface[];
}

/** Create a minimal mock viewer that supports events + highlight + camera + pause + plugins. */
function createMockViewer(opts: MockViewerOptions = {}): RVViewer {
  const emitter = new EventEmitter();
  let _isCameraAnimating = false;
  const pauseReasons = new Set<string>();
  const manager = {
    id: 'interface-manager',
    getRegistered: () => new Map((opts.interfaces ?? []).map((i) => [i.id, i])),
  };

  const viewer = {
    scene: new Scene(),
    // A fresh viewer reports 'Connected' — the live check must NOT read it.
    connectionState: 'Connected',
    setSimulationPaused: vi.fn((reason: string, paused: boolean) => {
      opts.log?.push(`pause:${paused}`);
      if (paused) pauseReasons.add(reason); else pauseReasons.delete(reason);
    }),
    get pauseReasons() { return pauseReasons; },
    getPlugin: (id: string) => (id === 'interface-manager' ? manager : undefined),
    getPlugins: () => [manager],
    highlightByPath: vi.fn(),
    clearHighlight: vi.fn(),
    // Step markers = aux emphasis + flash; every path resolves to a node of that name.
    registry: { getNode: (path: string) => Object.assign(new Object3D(), { name: path }) },
    highlighter: { setAuxEmphasis: vi.fn(), flash: vi.fn(), clearFlash: vi.fn() },
    markRenderDirty: vi.fn(),
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

type HighlighterMock = Record<'setAuxEmphasis' | 'flash' | 'clearFlash', ReturnType<typeof vi.fn>>;
const hlOf = (viewer: RVViewer): HighlighterMock => (viewer as unknown as { highlighter: HighlighterMock }).highlighter;

/** The step markers now shown: aux-emphasis roots (node names) and colour, and whether the flash pulses with them. */
function markers(viewer: RVViewer): { paths: string[]; color: number | null; flashing: boolean } {
  const hl = hlOf(viewer);
  const aux = hl.setAuxEmphasis.mock.calls.filter((c) => c[0] === 'maintenance-step').at(-1);
  const roots = (aux?.[1] as Object3D[] | null | undefined) ?? [];
  const flashAt = hl.flash.mock.invocationCallOrder.at(-1) ?? -1;
  const clearAt = hl.clearFlash.mock.invocationCallOrder.at(-1) ?? -1;
  return {
    paths: roots.map((n) => n.name),
    color: roots.length ? (aux![2] as { color: number }).color : null,
    flashing: flashAt > clearAt,
  };
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
        actions: [],
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
        actions: [],
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
        actions: [],
      },
    ],
    warnings: [],
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
    expect(markers(mockViewer)).toEqual({ paths: ['Path/Target1'], color: 0x29b6f6, flashing: true });
  });

  test('nextStep advances step index', () => {
    plugin.startScenario(testProcedure, 'stepbystep');
    plugin.nextStep();
    expect(plugin.getState().currentStep).toBe(1);
  });

  test('nextStep to last step transitions to completed', () => {
    plugin.startScenario(testProcedure, 'stepbystep');
    plugin.completeStep(1, 'pass'); // plan-522: confirm the safety step (barrier)
    plugin.goToStep(2); // Go to last step
    plugin.nextStep();  // One more should complete
    expect(plugin.getState().mode).toBe('completed');
  });

  test('prevStep goes back one step', () => {
    plugin.startScenario(testProcedure, 'stepbystep');
    plugin.completeStep(1, 'pass'); // plan-522: confirm the safety step (barrier)
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
    plugin.completeStep(1, 'pass'); // plan-522: confirm the safety step (barrier)
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
    plugin.completeStep(1, 'pass'); // plan-522: confirm the safety step (barrier)
    (mockViewer.animateCameraTo as ReturnType<typeof vi.fn>).mockClear();
    plugin.goToStep(2); // Step 3 has no camera
    expect(mockViewer.animateCameraTo).not.toHaveBeenCalled();
  });

  test('step with multiple highlights highlights all paths', () => {
    plugin.startScenario(testProcedure, 'stepbystep');
    plugin.goToStep(1); // Step 2 has two highlight paths, severity Warning
    expect(markers(mockViewer)).toEqual({ paths: ['Path/Target2', 'Path/Target3'], color: 0xffa726, flashing: true });
  });

  test('a step without highlight paths clears the previous markers', () => {
    plugin.startScenario(testProcedure, 'stepbystep');
    plugin.goToStep(1); // Step 2 has two highlight paths
    expect(markers(mockViewer).paths).toHaveLength(2);
    plugin.completeStep(1, 'pass'); // the safety step (barrier)
    plugin.goToStep(2); // Step 3 has no highlight paths
    expect(markers(mockViewer)).toEqual({ paths: [], color: null, flashing: false });
  });

  test('exit clears the markers', () => {
    plugin.startScenario(testProcedure, 'stepbystep');
    expect(markers(mockViewer).flashing).toBe(true);
    plugin.exitMaintenance();
    expect(markers(mockViewer)).toEqual({ paths: [], color: null, flashing: false });
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
    // plan-522 barrier: step 2 is an unconfirmed ConfirmWarning ('fail') — resume clamps to it.
    expect(state.currentStep).toBe(1);
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

// ─── plan-522 §9.4 — runtime seam, freeze, live, barrier, render lock, reset ──

interface FakeRuntimeCall {
  step: number;
  direction: StepDirection;
  signal: AbortSignal;
  resolve: () => void;
}

type FakeRuntime = MaintenanceRuntime & {
  calls: FakeRuntimeCall[];
  begin: ReturnType<typeof vi.fn>;
  applyStep: MaintenanceRuntime['applyStep'] & ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
};

/**
 * Fake runtime. `manual: true` keeps every applyStep pending until the test
 * resolves it (or the plugin aborts it — a superseded applyStep resolves, as
 * the seam contract requires).
 */
function createFakeRuntime(log: string[], manual = false): FakeRuntime {
  const calls: FakeRuntimeCall[] = [];
  const rt = {
    calls,
    begin: vi.fn(() => { log.push('begin'); }),
    applyStep: vi.fn((step: number, direction: StepDirection, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        log.push(`apply:${step}:${direction}`);
        calls.push({ step, direction, signal, resolve });
        signal.addEventListener('abort', () => resolve(), { once: true });
        if (!manual) resolve();
      })),
    end: vi.fn((reason?: MaintenanceEndReason) => { log.push(`end:${reason ?? 'exit'}`); }),
  };
  return rt as unknown as FakeRuntime;
}

/** Nine steps, step 1 (index 1) is the ConfirmWarning safety step. */
function createSafetyProcedure(): MaintenanceProcedure {
  const step = (index: number, completionType: MaintenanceStep['completionType']): MaintenanceStep => ({
    index,
    title: `Step ${index + 1}`,
    instruction: '',
    warningNote: '',
    icon: 'build',
    severity: completionType === 'ConfirmWarning' ? 'Warning' : 'Info',
    camera: null,
    cameraDuration: 0.8,
    highlightPaths: [],
    checkboxLabel: 'Done',
    completionType,
    estimatedMinutes: 1,
    actions: [],
  });
  return {
    name: 'Safety Procedure',
    estimatedMinutes: 9,
    steps: [
      step(0, 'Checkbox'), step(1, 'ConfirmWarning'), step(2, 'Checkbox'), step(3, 'Observation'),
      step(4, 'Observation'), step(5, 'Checkbox'), step(6, 'Checkbox'), step(7, 'Observation'),
      step(8, 'Checkbox'),
    ],
    warnings: [],
  };
}

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Make the flythrough fast: dwell and camera watchdog are private tuning fields. */
function speedUpFlythrough(plugin: MaintenancePlugin, dwellMs = 5): void {
  const p = plugin as unknown as { _flythroughDwellMs: number; _flythroughCameraTimeoutMs: number };
  p._flythroughDwellMs = dwellMs;
  p._flythroughCameraTimeoutMs = 50;
}

function pauseReasonsOf(viewer: RVViewer): Set<string> {
  return (viewer as unknown as { pauseReasons: Set<string> }).pauseReasons;
}

describe('plan-522 §9.4 MaintenancePlugin — machine follows the guide', () => {
  let log: string[];
  let unregister: (() => void) | null;

  beforeEach(() => {
    localStorage.clear();
    log = [];
    unregister = null;
    setAppConfig({});
  });

  afterEach(() => {
    unregister?.();
    setMaintenanceRenderLock(false);
    setAppConfig({});
  });

  function setup(opts: { runtime?: FakeRuntime; interfaces?: FakeInterface[] } = {}) {
    if (opts.runtime) unregister = registerMaintenanceRuntime(opts.runtime);
    const viewer = createMockViewer({ log, interfaces: opts.interfaces });
    const plugin = new MaintenancePlugin();
    plugin.onModelLoaded({} as LoadResult, viewer);
    return { viewer, plugin };
  }

  // ── Freeze ──

  test('start sets the pause reason maintenance; exit clears it', () => {
    const { viewer, plugin } = setup();
    plugin.startScenario(createTestProcedure(), 'stepbystep');
    expect(viewer.setSimulationPaused).toHaveBeenCalledWith('maintenance', true);
    expect(pauseReasonsOf(viewer).has('maintenance')).toBe(true);
    plugin.exitMaintenance();
    expect(pauseReasonsOf(viewer).has('maintenance')).toBe(false);
  });

  test('completion clears the pause reason (cell runs on behind the summary)', () => {
    const { viewer, plugin } = setup();
    plugin.startScenario(createTestProcedure(), 'stepbystep');
    plugin.completeStep(1, 'pass');
    plugin.goToStep(2);
    plugin.nextStep();
    expect(plugin.getState().mode).toBe('completed');
    expect(pauseReasonsOf(viewer).has('maintenance')).toBe(false);
  });

  test('onModelCleared clears the pause reason and ends the runtime', () => {
    const rt = createFakeRuntime(log);
    const { viewer, plugin } = setup({ runtime: rt });
    plugin.startScenario(createTestProcedure(), 'stepbystep');
    plugin.onModelCleared(viewer);
    expect(pauseReasonsOf(viewer).has('maintenance')).toBe(false);
    expect(rt.end).toHaveBeenCalledTimes(1);
    expect(plugin.getState().mode).toBe('idle');
  });

  test('dispose ends a running guide like exit', () => {
    const rt = createFakeRuntime(log);
    const { viewer, plugin } = setup({ runtime: rt });
    plugin.startScenario(createTestProcedure(), 'stepbystep');
    plugin.dispose();
    expect(rt.end).toHaveBeenCalledTimes(1);
    expect(pauseReasonsOf(viewer).has('maintenance')).toBe(false);
    expect(maintenanceRenderLockReason()).toBeNull();
  });

  // ── Live ──

  test('live (fake interface isConnected): no pause, no runtime, isLive true', () => {
    const rt = createFakeRuntime(log);
    const { viewer, plugin } = setup({ runtime: rt, interfaces: [createFakeInterface(true)] });
    expect(plugin.isLive()).toBe(true);
    plugin.startScenario(createTestProcedure(), 'stepbystep');
    expect(viewer.setSimulationPaused).not.toHaveBeenCalledWith('maintenance', true);
    expect(rt.begin).not.toHaveBeenCalled();
    expect(rt.applyStep).not.toHaveBeenCalled();
    expect(plugin.getState().isLive).toBe(true);
    expect(plugin.getState().renderModeLocked).toBe(false);
  });

  test('fresh viewer without interface (connectionState Connected) is NOT live', () => {
    const { viewer, plugin } = setup({ interfaces: [createFakeInterface(false)] });
    expect((viewer as unknown as { connectionState: string }).connectionState).toBe('Connected');
    expect(plugin.isLive()).toBe(false);
    plugin.startScenario(createTestProcedure(), 'stepbystep');
    expect(plugin.getState().isLive).toBe(false);
    expect(pauseReasonsOf(viewer).has('maintenance')).toBe(true);
  });

  test('a stream outside the manager counts only with a TAKEOVER (dev server + local CONNECT is not live)', () => {
    const { viewer, plugin } = setup({ interfaces: [createFakeInterface(false)] });
    const state = { interfaceConnected: true, takeover: false };
    (viewer as unknown as { connectionMode: unknown }).connectionMode = { state };
    expect(plugin.isLive()).toBe(false);
    state.takeover = true;
    expect(plugin.isLive()).toBe(true);
  });

  test('connecting during a guide → end(live-handover) once, pause released, guide goes on without actions', () => {
    const rt = createFakeRuntime(log);
    const iface = createFakeInterface(false);
    const { viewer, plugin } = setup({ runtime: rt, interfaces: [iface] });
    plugin.startScenario(createTestProcedure(), 'stepbystep');
    expect(rt.begin).toHaveBeenCalledTimes(1);

    iface.isConnected = true;
    viewer.emit('interface-connected', { interfaceId: iface.id, type: 'fake' });
    viewer.emit('interface-connected', { interfaceId: iface.id, type: 'fake' }); // repeated event

    expect(rt.end).toHaveBeenCalledTimes(1);
    expect(rt.end).toHaveBeenCalledWith('live-handover');
    expect(pauseReasonsOf(viewer).has('maintenance')).toBe(false);
    const state = plugin.getState();
    expect(state.mode).toBe('stepbystep');
    expect(state.isLive).toBe(true);
    expect(state.renderModeLocked).toBe(false);

    const applied = rt.applyStep.mock.calls.length;
    plugin.nextStep();
    expect(plugin.getState().currentStep).toBe(1);
    expect(rt.applyStep.mock.calls.length).toBe(applied);

    plugin.exitMaintenance();
    expect(rt.end).toHaveBeenCalledTimes(1);
  });

  // ── Barrier ──

  test('barrier: nextStep on an unconfirmed ConfirmWarning step is a no-op', () => {
    const { plugin } = setup();
    plugin.startScenario(createSafetyProcedure(), 'stepbystep');
    plugin.nextStep();
    expect(plugin.getState().currentStep).toBe(1);
    plugin.nextStep();
    expect(plugin.getState().currentStep).toBe(1);
    plugin.completeStep(1, 'fail');
    plugin.nextStep();
    expect(plugin.getState().currentStep).toBe(1);
    plugin.completeStep(1, 'pass');
    plugin.nextStep();
    expect(plugin.getState().currentStep).toBe(2);
  });

  test('barrier: goToStep(8) with step 1 unconfirmed lands on 1; skipped normal steps stay open', () => {
    const { plugin } = setup();
    plugin.startScenario(createSafetyProcedure(), 'stepbystep');
    plugin.goToStep(8);
    expect(plugin.getState().currentStep).toBe(1);
    expect(plugin.clampToBarrier(8)).toBe(1);
    expect(plugin.clampToBarrier(1)).toBe(1);
    expect(plugin.clampToBarrier(0)).toBe(0);
    plugin.completeStep(1, 'pass');
    plugin.goToStep(8);
    expect(plugin.getState().currentStep).toBe(8);
    expect(plugin.getState().stepResults[0]).toBeNull();
  });

  test('barrier: resume with saved step 6 and unconfirmed step 1 starts at 1', () => {
    saveMaintenanceProgress('Safety Procedure', ['pass', null, null, null, null, null, null, null, null], 6);
    const { plugin } = setup();
    plugin.startScenario(createSafetyProcedure(), 'stepbystep');
    expect(plugin.getState().currentStep).toBe(1);
  });

  test('barrier: the last step being an unconfirmed safety step blocks completion', () => {
    const proc = createSafetyProcedure();
    proc.steps[8] = { ...proc.steps[8], completionType: 'ConfirmWarning' };
    const { plugin } = setup();
    plugin.startScenario(proc, 'stepbystep');
    plugin.completeStep(1, 'pass');
    plugin.goToStep(8);
    plugin.nextStep();
    expect(plugin.getState().mode).toBe('stepbystep');
    plugin.completeStep(8, 'pass');
    plugin.nextStep();
    expect(plugin.getState().mode).toBe('completed');
  });

  test('barrier: the flythrough preview runs over the barrier', async () => {
    const { viewer, plugin } = setup();
    speedUpFlythrough(plugin, 1);
    const visited: number[] = [];
    viewer.on('maintenance-step-changed' as string, (d: unknown) => visited.push((d as { stepIndex: number }).stepIndex));
    plugin.startScenario(createSafetyProcedure(), 'flythrough');
    await vi.waitFor(() => expect(plugin.getState().mode).toBe('completed'), { timeout: 2000 });
    expect(visited).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  // ── Fake runtime: directions, cancellation, exit order ──

  test('runtime: begin once at start; forward / back / jump mapping', () => {
    const rt = createFakeRuntime(log);
    const { viewer, plugin } = setup({ runtime: rt });
    const proc = createTestProcedure();
    plugin.startScenario(proc, 'stepbystep');
    expect(rt.begin).toHaveBeenCalledTimes(1);
    expect(rt.begin).toHaveBeenCalledWith(proc, viewer);
    plugin.completeStep(1, 'pass');
    plugin.nextStep();
    plugin.nextStep();
    plugin.prevStep();
    plugin.goToStep(0);
    expect(rt.calls.map((c) => `${c.step}:${c.direction}`))
      .toEqual(['0:forward', '1:forward', '2:forward', '1:back', '0:jump']);
  });

  test('runtime: resume at a later step applies it as a jump', () => {
    saveMaintenanceProgress('Test Procedure', ['pass', 'pass', null], 2);
    const rt = createFakeRuntime(log);
    const { plugin } = setup({ runtime: rt });
    plugin.startScenario(createTestProcedure(), 'stepbystep');
    expect(rt.calls.map((c) => `${c.step}:${c.direction}`)).toEqual(['2:jump']);
  });

  test('runtime: a second navigation aborts the signal of the first', () => {
    const rt = createFakeRuntime(log, true);
    const { plugin } = setup({ runtime: rt });
    plugin.startScenario(createTestProcedure(), 'stepbystep');
    const first = rt.calls[0];
    expect(first.signal.aborted).toBe(false);
    plugin.nextStep();
    expect(first.signal.aborted).toBe(true);
    expect(rt.calls[1].signal.aborted).toBe(false);
  });

  test('runtime: exit aborts, calls end() BEFORE releasing the pause, creates no controller', () => {
    const rt = createFakeRuntime(log, true);
    const { plugin } = setup({ runtime: rt });
    plugin.startScenario(createTestProcedure(), 'stepbystep');
    const pending = rt.calls[0];
    log.length = 0;
    plugin.exitMaintenance();
    expect(pending.signal.aborted).toBe(true);
    expect(log.indexOf('end:exit')).toBeGreaterThanOrEqual(0);
    expect(log.indexOf('end:exit')).toBeLessThan(log.indexOf('pause:false'));
    expect(rt.end).toHaveBeenCalledWith('exit');
    expect((plugin as unknown as { _navAbort: AbortController | null })._navAbort).toBeNull();
    // Navigation after exit is inert.
    plugin.nextStep();
    plugin.goToStep(1);
    expect(rt.applyStep).toHaveBeenCalledTimes(1);
    plugin.exitMaintenance();
    expect(rt.end).toHaveBeenCalledTimes(1);
  });

  test('runtime: completion ends the runtime (baseline restored) before the summary', () => {
    const rt = createFakeRuntime(log);
    const { plugin } = setup({ runtime: rt });
    plugin.startScenario(createTestProcedure(), 'stepbystep');
    plugin.completeStep(1, 'pass');
    plugin.goToStep(2);
    plugin.nextStep();
    expect(plugin.getState().mode).toBe('completed');
    expect(rt.end).toHaveBeenCalledTimes(1);
    expect(rt.end).toHaveBeenCalledWith('exit');
    plugin.exitMaintenance();
    expect(rt.end).toHaveBeenCalledTimes(1);
  });

  test('runtime: without a registered runtime the guide behaves as before', () => {
    const { viewer, plugin } = setup();
    plugin.startScenario(createTestProcedure(), 'stepbystep');
    expect(markers(viewer).paths).toEqual(['Path/Target1']);
    expect(plugin.getState().renderModeLocked).toBe(false);
    expect(maintenanceRenderLockReason()).toBeNull();
  });

  // ── Flythrough waits for the machine ──

  test('flythrough: an action longer than the dwell holds the next step back', async () => {
    const rt = createFakeRuntime(log, true);
    const { viewer, plugin } = setup({ runtime: rt });
    speedUpFlythrough(plugin, 5);
    const visited: number[] = [];
    viewer.on('maintenance-step-changed' as string, (d: unknown) => visited.push((d as { stepIndex: number }).stepIndex));
    plugin.startScenario(createTestProcedure(), 'flythrough');
    await tick(80); // camera (10 ms) + dwell (5 ms) long over
    expect(visited).toEqual([0]);
    rt.calls[0].resolve();
    await vi.waitFor(() => expect(visited).toEqual([0, 1]), { timeout: 1000 });
    // Exit while step 1's action is still running.
    plugin.exitMaintenance();
    expect(rt.calls[1].signal.aborted).toBe(true);
    expect(rt.end).toHaveBeenCalledTimes(1);
    await tick(80);
    expect(visited).toEqual([0, 1]);
    expect(plugin.getState().mode).toBe('idle');
  });

  // ── Render-mode lock ──

  test('renderModeLocked true during the guide (with runtime), false after exit', () => {
    const rt = createFakeRuntime(log);
    const { plugin } = setup({ runtime: rt });
    plugin.startScenario(createTestProcedure(), 'stepbystep');
    expect(plugin.getState().renderModeLocked).toBe(true);
    expect(maintenanceRenderLockReason()).toBe(MAINTENANCE_RENDER_LOCKED);
    plugin.exitMaintenance();
    expect(plugin.getState().renderModeLocked).toBe(false);
    expect(maintenanceRenderLockReason()).toBeNull();
  });

  test('render lock works over all paths: lock reason, command enabled, command run', async () => {
    const rt = createFakeRuntime(log);
    const { plugin } = setup({ runtime: rt });
    const registry = new CommandRegistry();
    ensureViewCommandsRegistered(registry);
    ensureSessionOverlayCommandsRegistered(registry);
    ensureComponentCommandsRegistered(registry);
    ensureQueryCommandsRegistered(registry);
    ensureDocumentCommandsRegistered(registry);
    ensureSignalAutomapCommandsRegistered(registry);
    ensureDesPlcCommandsRegistered(registry);
    const rv = fakeRenderViewer({ renderMode: 'default' });

    expect(renderModeLockReason()).toBeNull();
    expect(registry.enabled('view.renderMode', { mode: 'toon' }, rv)).toBe(true);

    plugin.startScenario(createTestProcedure(), 'stepbystep');
    expect(renderModeLockReason()).toBe('Not available during a maintenance guide');
    // Toolbar pill and Visual tab (origin ui) and MCP (origin mcp) are views of this command.
    expect(registry.enabled('view.renderMode', { mode: 'toon' }, rv))
      .toEqual({ reason: MAINTENANCE_RENDER_LOCKED });
    for (const origin of ['ui', 'mcp'] as const) {
      const r = await registry.execute('view.renderMode', { mode: 'toon' }, { origin, viewer: rv });
      expect(r).toMatchObject({ ok: false, kind: 'disabled', reason: MAINTENANCE_RENDER_LOCKED });
    }
    expect(rv.renderMode).toBe('default');
    expect(rv.calls).toEqual([]);

    // The deployment lock keeps precedence.
    setAppConfig({ lockedTabs: ['visual'] });
    expect(renderModeLockReason()).not.toBe(MAINTENANCE_RENDER_LOCKED);
    setAppConfig({});

    plugin.exitMaintenance();
    expect(renderModeLockReason()).toBeNull();
    const ok = await registry.execute('view.renderMode', { mode: 'toon' }, { origin: 'mcp', viewer: rv });
    expect(ok).toEqual({ ok: true, value: { renderMode: 'toon', wireframe: false } });
    expect(rv.renderMode).toBe('toon');
  });

  // ── Simulation reset ──

  test('simulation-reset mid applyStep → end(reset) exactly once, synchronously; pause gone; exit idempotent', () => {
    const rt = createFakeRuntime(log, true);
    const { viewer, plugin } = setup({ runtime: rt });
    plugin.startScenario(createTestProcedure(), 'stepbystep');
    plugin.nextStep(); // applyStep(1) pending
    const pending = rt.calls[1];
    expect(pending.signal.aborted).toBe(false);

    viewer.emit('simulation-reset');
    // Synchronously inside the event — before any drive reset that follows it.
    expect(rt.end).toHaveBeenCalledTimes(1);
    expect(rt.end).toHaveBeenCalledWith('reset');
    expect(pending.signal.aborted).toBe(true);
    expect(pauseReasonsOf(viewer).has('maintenance')).toBe(false);
    expect(plugin.getState().mode).toBe('idle');
    expect(maintenanceRenderLockReason()).toBeNull();

    plugin.exitMaintenance();
    viewer.emit('simulation-reset');
    expect(rt.end).toHaveBeenCalledTimes(1);
  });

  test('simulation-reset outside a running guide does nothing', () => {
    const rt = createFakeRuntime(log);
    const { viewer, plugin } = setup({ runtime: rt });
    viewer.emit('simulation-reset');
    expect(rt.end).not.toHaveBeenCalled();
    expect(plugin.getState().mode).toBe('idle');
  });
});
