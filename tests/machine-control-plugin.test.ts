// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * MachineControlPlugin Tests
 *
 * Tests the demo state machine, auto-discovery, event emission,
 * 3D integration API, and idempotency.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MachineControlPlugin, type MachineControlState } from '../src/plugins/demo/machine-control-plugin';
import { LeftPanelManager } from '../src/core/hmi/left-panel-manager';

// ─── Minimal Viewer Mock ─────────────────────────────────────────────────

function createMockViewer(options?: { drives?: { name: string; nodePath: string }[]; sensors?: { name: string; nodePath: string }[] }) {
  const drives = (options?.drives ?? []).map(d => ({
    name: d.name,
    node: { name: d.name, userData: {} },
  }));

  const sensorList = (options?.sensors ?? []).map(s => ({
    name: s.name,
    node: { name: s.name, userData: {} },
  }));

  const pathMap = new Map<unknown, string>();
  for (const d of drives) {
    pathMap.set(d.node, `Root/${d.name}`);
  }
  for (const s of sensorList) {
    pathMap.set(s.node, `Root/${s.name}`);
  }

  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  return {
    drives,
    transportManager: sensorList.length > 0 ? { sensors: sensorList } : null,
    registry: {
      getPathForNode: (node: unknown) => pathMap.get(node) ?? '',
    },
    highlightByPath: vi.fn(),
    focusByPath: vi.fn(),
    clearHighlight: vi.fn(),
    emit: vi.fn((event: string, _data?: unknown) => {
      const set = listeners.get(event);
      if (set) for (const cb of set) cb(_data);
    }),
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      let set = listeners.get(event);
      if (!set) { set = new Set(); listeners.set(event, set); }
      set.add(cb);
      return () => { set!.delete(cb); };
    }),
    leftPanelManager: new LeftPanelManager(),
  };
}

type MockViewer = ReturnType<typeof createMockViewer>;

// ─── Helper: set up plugin with model loaded ─────────────────────────────

function setupPlugin(options?: { drives?: { name: string; nodePath: string }[]; sensors?: { name: string; nodePath: string }[] }) {
  const plugin = new MachineControlPlugin();
  const viewer = createMockViewer(options);
  const result = { drives: viewer.drives } as unknown;
  plugin.onModelLoaded(result as never, viewer as never);
  return { plugin, viewer };
}

// ─── 9.1 State Machine Tests ─────────────────────────────────────────────

describe('MachineControlPlugin - State Machine', () => {
  it('initial state is RUNNING', () => {
    const { plugin } = setupPlugin();
    expect(plugin.machineState).toBe('RUNNING');
  });

  it('Reset: STOPPED -> IDLE', () => {
    const { plugin } = setupPlugin();
    plugin.emergencyStop();
    plugin.clearError(); // ERROR -> STOPPED
    plugin.reset(); // STOPPED -> IDLE
    expect(plugin.machineState).toBe('IDLE');
  });

  it('Start: IDLE -> RUNNING', () => {
    const { plugin } = setupPlugin();
    plugin.stop(); // RUNNING -> IDLE
    plugin.start(); // IDLE -> RUNNING
    expect(plugin.machineState).toBe('RUNNING');
  });

  it('Stop: RUNNING -> IDLE', () => {
    const { plugin } = setupPlugin();
    plugin.stop();
    expect(plugin.machineState).toBe('IDLE');
  });

  it('E-Stop from any state -> ERROR', () => {
    const { plugin } = setupPlugin();
    plugin.stop(); // RUNNING -> IDLE
    plugin.emergencyStop();
    expect(plugin.machineState).toBe('ERROR');
  });

  it('E-Stop from RUNNING -> ERROR', () => {
    const { plugin } = setupPlugin();
    plugin.emergencyStop();
    expect(plugin.machineState).toBe('ERROR');
  });

  it('Clear: ERROR -> STOPPED', () => {
    const { plugin } = setupPlugin();
    plugin.emergencyStop();
    plugin.clearError();
    expect(plugin.machineState).toBe('STOPPED');
  });

  it('Hold: RUNNING -> HELD', () => {
    const { plugin } = setupPlugin();
    plugin.hold();
    expect(plugin.machineState).toBe('HELD');
  });

  it('Resume: HELD -> RUNNING', () => {
    const { plugin } = setupPlugin();
    plugin.hold();
    plugin.resume();
    expect(plugin.machineState).toBe('RUNNING');
  });

  it('Start from STOPPED works (start from any non-running)', () => {
    const { plugin } = setupPlugin();
    plugin.emergencyStop();
    plugin.clearError(); // ERROR -> STOPPED
    expect(plugin.machineState).toBe('STOPPED');
    plugin.start();
    expect(plugin.machineState).toBe('RUNNING');
  });

  it('mode can be switched from any state (demo mode)', () => {
    const { plugin } = setupPlugin();
    plugin.setMode('MANUAL');
    expect(plugin.machineMode).toBe('MANUAL');
    plugin.setMode('MAINTENANCE');
    expect(plugin.machineMode).toBe('MAINTENANCE');
    plugin.setMode('AUTO');
    expect(plugin.machineMode).toBe('AUTO');
    expect(plugin.machineState).toBe('RUNNING'); // state unchanged
  });
});

// ─── 9.2 Auto-Discovery Tests ────────────────────────────────────────────

describe('MachineControlPlugin - Auto-Discovery', () => {
  it('discovers drives from viewer.drives', () => {
    const { plugin } = setupPlugin({
      drives: [
        { name: 'Drive1', nodePath: 'Root/Drive1' },
        { name: 'Drive2', nodePath: 'Root/Drive2' },
      ],
    });
    const comps = plugin.components;
    expect(comps.length).toBe(2);
    expect(comps[0].name).toBe('Drive1');
    expect(comps[0].type).toBe('drive');
    expect(comps[1].name).toBe('Drive2');
  });

  it('discovers sensors from viewer.transportManager.sensors', () => {
    const { plugin } = setupPlugin({
      sensors: [
        { name: 'Sensor1', nodePath: 'Root/Sensor1' },
      ],
    });
    const comps = plugin.components;
    expect(comps.length).toBe(1);
    expect(comps[0].name).toBe('Sensor1');
    expect(comps[0].type).toBe('sensor');
  });

  it('handles empty model gracefully (no drives, no sensors)', () => {
    const { plugin } = setupPlugin();
    expect(plugin.components.length).toBe(0);
  });

  it('resets component list on model-cleared', () => {
    const { plugin, viewer } = setupPlugin({
      drives: [{ name: 'D1', nodePath: 'Root/D1' }],
    });
    expect(plugin.components.length).toBe(1);
    plugin.onModelCleared(viewer as never);
    expect(plugin.components.length).toBe(0);
  });

  it('rapid model reload does not duplicate components', () => {
    const { plugin, viewer } = setupPlugin({
      drives: [{ name: 'D1', nodePath: 'Root/D1' }],
    });
    expect(plugin.components.length).toBe(1);
    // Simulate reload: cleared + loaded again
    plugin.onModelCleared(viewer as never);
    plugin.onModelLoaded({ drives: viewer.drives } as never, viewer as never);
    expect(plugin.components.length).toBe(1);
  });
});

// ─── 9.3 Event Emission Tests ────────────────────────────────────────────

describe('MachineControlPlugin - Events', () => {
  it('emits machine-control-changed on state transition', () => {
    const { plugin, viewer } = setupPlugin();
    viewer.emit.mockClear();
    plugin.stop(); // RUNNING -> IDLE
    expect(viewer.emit).toHaveBeenCalledWith(
      'machine-control-changed',
      expect.objectContaining({ state: 'IDLE' }),
    );
  });

  it('emits machine-control-changed on mode change', () => {
    const { plugin, viewer } = setupPlugin();
    viewer.emit.mockClear();
    plugin.setMode('MANUAL');
    expect(viewer.emit).toHaveBeenCalledWith(
      'machine-control-changed',
      expect.objectContaining({ mode: 'MANUAL' }),
    );
  });
});

// ─── 9.4 3D Integration Tests ────────────────────────────────────────────

describe('MachineControlPlugin - 3D Integration', () => {
  it('hoverComponent calls viewer.highlightByPath', () => {
    const { plugin, viewer } = setupPlugin({
      drives: [{ name: 'Drive1', nodePath: 'Root/Drive1' }],
    });
    plugin.hoverComponent('Root/Drive1');
    expect(viewer.highlightByPath).toHaveBeenCalledWith('Root/Drive1', true);
  });

  it('clickComponent calls viewer.focusByPath', () => {
    const { plugin, viewer } = setupPlugin({
      drives: [{ name: 'Drive1', nodePath: 'Root/Drive1' }],
    });
    plugin.clickComponent('Root/Drive1');
    expect(viewer.focusByPath).toHaveBeenCalledWith('Root/Drive1');
  });

  it('leaveComponent calls viewer.clearHighlight', () => {
    const { plugin, viewer } = setupPlugin();
    plugin.leaveComponent();
    expect(viewer.clearHighlight).toHaveBeenCalled();
  });

  it('invalid path in hoverComponent does not throw', () => {
    const { plugin } = setupPlugin();
    expect(() => plugin.hoverComponent('')).not.toThrow();
  });

  it('leaveComponent does NOT clear highlight during ERROR state', () => {
    const { plugin, viewer } = setupPlugin({
      drives: [{ name: 'D1', nodePath: 'Root/D1' }],
    });
    plugin.emergencyStop();
    viewer.clearHighlight.mockClear();
    plugin.leaveComponent();
    expect(viewer.clearHighlight).not.toHaveBeenCalled();
  });
});

// ─── 9.5 Idempotency Tests ──────────────────────────────────────────────

describe('MachineControlPlugin - Idempotency', () => {
  it('Start from RUNNING is a no-op', () => {
    const { plugin, viewer } = setupPlugin();
    expect(plugin.machineState).toBe('RUNNING');
    viewer.emit.mockClear();
    plugin.start(); // no-op
    expect(plugin.machineState).toBe('RUNNING');
    // Should NOT emit again (no state change)
    expect(viewer.emit).not.toHaveBeenCalled();
  });

  it('Stop from IDLE is a no-op', () => {
    const { plugin, viewer } = setupPlugin();
    plugin.stop(); // RUNNING -> IDLE
    viewer.emit.mockClear();
    plugin.stop(); // no-op (IDLE, not RUNNING or HELD)
    expect(plugin.machineState).toBe('IDLE');
    expect(viewer.emit).not.toHaveBeenCalled();
  });

  it('mode change does NOT reset machine state', () => {
    const { plugin } = setupPlugin();
    expect(plugin.machineState).toBe('RUNNING');
    plugin.setMode('MAINTENANCE');
    expect(plugin.machineState).toBe('RUNNING'); // unchanged
    expect(plugin.machineMode).toBe('MAINTENANCE');
  });

  it('E-Stop from ERROR is a no-op', () => {
    const { plugin, viewer } = setupPlugin();
    plugin.emergencyStop();
    expect(plugin.machineState).toBe('ERROR');
    viewer.emit.mockClear();
    plugin.emergencyStop(); // no-op
    expect(viewer.emit).not.toHaveBeenCalled();
  });
});

// ─── LeftPanelManager Tests ──────────────────────────────────────────────

describe('LeftPanelManager', () => {
  it('starts with no active panel', () => {
    const lpm = new LeftPanelManager();
    expect(lpm.activePanel).toBeNull();
    expect(lpm.activePanelWidth).toBe(0);
  });

  it('open sets active panel', () => {
    const lpm = new LeftPanelManager();
    lpm.open('settings', 540);
    expect(lpm.activePanel).toBe('settings');
    expect(lpm.activePanelWidth).toBe(540);
  });

  it('opening another panel closes the previous one', () => {
    const lpm = new LeftPanelManager();
    lpm.open('settings', 540);
    lpm.open('machine-control', 320);
    expect(lpm.activePanel).toBe('machine-control');
    expect(lpm.activePanelWidth).toBe(320);
  });

  it('close only closes the specified panel', () => {
    const lpm = new LeftPanelManager();
    lpm.open('settings', 540);
    lpm.close('machine-control'); // no-op, not active
    expect(lpm.activePanel).toBe('settings');
    lpm.close('settings');
    expect(lpm.activePanel).toBeNull();
  });

  it('toggle opens and closes', () => {
    const lpm = new LeftPanelManager();
    lpm.toggle('machine-control', 320);
    expect(lpm.isOpen('machine-control')).toBe(true);
    lpm.toggle('machine-control', 320);
    expect(lpm.isOpen('machine-control')).toBe(false);
  });

  it('subscribe notifies on state changes', () => {
    const lpm = new LeftPanelManager();
    const listener = vi.fn();
    const unsub = lpm.subscribe(listener);
    lpm.open('settings', 540);
    expect(listener).toHaveBeenCalledTimes(1);
    lpm.close('settings');
    expect(listener).toHaveBeenCalledTimes(2);
    unsub();
    lpm.open('settings', 540);
    expect(listener).toHaveBeenCalledTimes(2); // not called after unsub
  });

  it('getSnapshot returns stable reference between changes', () => {
    const lpm = new LeftPanelManager();
    const snap1 = lpm.getSnapshot();
    const snap2 = lpm.getSnapshot();
    expect(snap1).toBe(snap2); // same object reference
    lpm.open('settings', 540);
    const snap3 = lpm.getSnapshot();
    expect(snap3).not.toBe(snap1); // new reference after change
    expect(snap3.activePanel).toBe('settings');
  });

  it('open with same id and width is no-op (no notification)', () => {
    const lpm = new LeftPanelManager();
    const listener = vi.fn();
    lpm.open('settings', 540);
    lpm.subscribe(listener);
    lpm.open('settings', 540); // same — should not notify
    expect(listener).not.toHaveBeenCalled();
  });
});

// ─── Component Status Update Tests ───────────────────────────────────────

describe('MachineControlPlugin - Component Status Updates', () => {
  it('components are "running"/"active" when machine is RUNNING (default)', () => {
    const { plugin } = setupPlugin({
      drives: [{ name: 'D1', nodePath: 'Root/D1' }, { name: 'D2', nodePath: 'Root/D2' }],
      sensors: [{ name: 'S1', nodePath: 'Root/S1' }],
    });
    const comps = plugin.components;
    expect(comps[0].status).toBe('running');
    expect(comps[1].status).toBe('running');
    expect(comps[2].status).toBe('active'); // sensor
  });

  it('components are "stopped"/"inactive" when machine is IDLE', () => {
    const { plugin } = setupPlugin({
      drives: [{ name: 'D1', nodePath: 'Root/D1' }],
      sensors: [{ name: 'S1', nodePath: 'Root/S1' }],
    });
    plugin.stop(); // RUNNING -> IDLE
    expect(plugin.components[0].status).toBe('stopped');
    expect(plugin.components[1].status).toBe('inactive');
  });

  it('E-Stop sets one random component to error', () => {
    const { plugin } = setupPlugin({
      drives: [{ name: 'D1', nodePath: 'Root/D1' }, { name: 'D2', nodePath: 'Root/D2' }],
    });
    plugin.emergencyStop();
    const errorIdx = plugin.errorComponentIdx;
    expect(errorIdx).toBeGreaterThanOrEqual(0);
    expect(errorIdx).toBeLessThan(2);
    expect(plugin.components[errorIdx].status).toBe('error');
  });

  it('clearError resets error component status', () => {
    const { plugin } = setupPlugin({
      drives: [{ name: 'D1', nodePath: 'Root/D1' }],
    });
    plugin.emergencyStop();
    expect(plugin.components[0].status).toBe('error');
    plugin.clearError();
    expect(plugin.components[0].status).toBe('stopped');
    expect(plugin.errorComponentIdx).toBe(-1);
  });
});

// ─── Dispose Tests ───────────────────────────────────────────────────────

describe('MachineControlPlugin - Dispose', () => {
  it('dispose prevents further operations', () => {
    const { plugin } = setupPlugin();
    plugin.dispose();
    // Should not throw
    expect(() => plugin.hoverComponent('test')).not.toThrow();
    expect(() => plugin.clickComponent('test')).not.toThrow();
    expect(() => plugin.leaveComponent()).not.toThrow();
  });

  it('getState still works after dispose', () => {
    const { plugin } = setupPlugin();
    plugin.dispose();
    const state = plugin.getState();
    expect(state.state).toBe('RUNNING');
  });
});
