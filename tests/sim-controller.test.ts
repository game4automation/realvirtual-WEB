// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, test, expect } from 'vitest';
import { createTestViewer } from './helpers/test-viewer';
import { SimControllerPlugin, SIM_CONTROLLER_PAUSE_REASON } from '../src/plugins/sim-controller';

describe('SimControllerPlugin — lifecycle', () => {
  test('registers the leading toolbar-button slot and the mode-switch overlay', () => {
    const plugin = new SimControllerPlugin();
    // plan-198: the old Realtime/DES execution toggle (SimModeToggle) was removed
    // from the toolbar (DES is now a workspace mode). What remains:
    //   • 'toolbar-button-leading' — Play/Pause + Reset + Speed controls
    //     (hidden in DES/HMI modes via a visibility rule, plan-194)
    //   • 'overlay' — ModeSwitchNotice, always mounted, warns that switching
    //     workspace clears MUs.
    expect(plugin.slots.length).toBe(2);
    expect(plugin.slots.some(s => s.slot === 'toolbar-button-leading')).toBe(true);
    expect(plugin.slots.some(s => s.slot === 'overlay')).toBe(true);
  });

  test('exposes a stable plugin id', () => {
    const plugin = new SimControllerPlugin();
    expect(plugin.id).toBe('sim-controller');
  });

  test('onModelLoaded stores the viewer reference', () => {
    const plugin = new SimControllerPlugin({ shortcuts: false });
    const viewer = createTestViewer();
    plugin.onModelLoaded(null as any, viewer as any);
    // Indirect check: dispose() releases the pause reason iff a viewer is held.
    viewer.setSimulationPaused(SIM_CONTROLLER_PAUSE_REASON, true);
    expect(viewer.isSimulationPaused).toBe(true);
    plugin.dispose();
    expect(viewer.isSimulationPaused).toBe(false);
  });

  test('dispose releases the user pause reason as a safety net', () => {
    const plugin = new SimControllerPlugin({ shortcuts: false });
    const viewer = createTestViewer();
    plugin.onModelLoaded(null as any, viewer as any);

    viewer.setSimulationPaused(SIM_CONTROLLER_PAUSE_REASON, true);
    viewer.setSimulationPaused('layout-edit', true);
    expect(viewer.simulationPauseReasons.length).toBe(2);

    plugin.dispose();
    // 'user' is released, but 'layout-edit' (owned by another plugin) is NOT
    // touched — Defense-in-Depth means we only release our own reason.
    expect(viewer.simulationPauseReasons).toContain('layout-edit');
    expect(viewer.simulationPauseReasons).not.toContain(SIM_CONTROLLER_PAUSE_REASON);
  });

  test('dispose is safe to call twice', () => {
    const plugin = new SimControllerPlugin({ shortcuts: false });
    const viewer = createTestViewer();
    plugin.onModelLoaded(null as any, viewer as any);
    plugin.dispose();
    expect(() => plugin.dispose()).not.toThrow();
  });
});

describe('SimControllerPlugin — pause toggle behavior', () => {
  test('toggling user pause emits simulation-pause-changed events', () => {
    const viewer = createTestViewer();
    const events: { paused: boolean; reasons: readonly string[] }[] = [];
    viewer.on('simulation-pause-changed', (e: any) => events.push({ paused: e.paused, reasons: e.reasons }));

    viewer.setSimulationPaused(SIM_CONTROLLER_PAUSE_REASON, true);
    expect(events.length).toBe(1);
    expect(events[0].paused).toBe(true);

    viewer.setSimulationPaused(SIM_CONTROLLER_PAUSE_REASON, false);
    expect(events.length).toBe(2);
    expect(events[1].paused).toBe(false);
  });

  test('user pause composes with layout-edit pause via ref-count', () => {
    const viewer = createTestViewer();
    viewer.setSimulationPaused(SIM_CONTROLLER_PAUSE_REASON, true);
    viewer.setSimulationPaused('layout-edit', true);
    expect(viewer.isSimulationPaused).toBe(true);

    // Releasing only 'user' keeps the sim paused via 'layout-edit'.
    viewer.setSimulationPaused(SIM_CONTROLLER_PAUSE_REASON, false);
    expect(viewer.isSimulationPaused).toBe(true);
    expect(viewer.simulationPauseReasons).toEqual(['layout-edit']);

    // Releasing the last reason resumes the sim.
    viewer.setSimulationPaused('layout-edit', false);
    expect(viewer.isSimulationPaused).toBe(false);
  });

  test('pause-changed events fire only on overall transitions', () => {
    const viewer = createTestViewer();
    const events: { paused: boolean; reason: string }[] = [];
    viewer.on('simulation-pause-changed', (e: any) => events.push({ paused: e.paused, reason: e.reason }));

    viewer.setSimulationPaused('user', true);          // idle → paused (transition)
    viewer.setSimulationPaused('layout-edit', true);   // paused → paused (no event)
    viewer.setSimulationPaused('user', false);         // still paused (no event)
    viewer.setSimulationPaused('layout-edit', false);  // paused → idle (transition)

    expect(events.length).toBe(2);
    expect(events[0].paused).toBe(true);
    expect(events[1].paused).toBe(false);
  });
});

describe('SimControllerPlugin — keyboard shortcuts', () => {
  test('Space toggles user pause', () => {
    const plugin = new SimControllerPlugin({ shortcuts: true });
    const viewer = createTestViewer();
    plugin.onModelLoaded(null as any, viewer as any);

    expect(viewer.isSimulationPaused).toBe(false);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
    expect(viewer.isSimulationPaused).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
    expect(viewer.isSimulationPaused).toBe(false);

    plugin.dispose();
  });

  test('Shift+R triggers resetSimulation', () => {
    const plugin = new SimControllerPlugin({ shortcuts: true });
    const viewer = createTestViewer({ initialMus: 4 });
    plugin.onModelLoaded(null as any, viewer as any);

    expect(viewer.transportManager.mus.length).toBe(4);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', shiftKey: true }));
    expect(viewer.transportManager.mus.length).toBe(0);

    plugin.dispose();
  });

  test('Space inside an input element is ignored', () => {
    const plugin = new SimControllerPlugin({ shortcuts: true });
    const viewer = createTestViewer();
    plugin.onModelLoaded(null as any, viewer as any);

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
    expect(viewer.isSimulationPaused).toBe(false);

    input.remove();
    plugin.dispose();
  });

  test('dispose removes the keydown listener', () => {
    const plugin = new SimControllerPlugin({ shortcuts: true });
    const viewer = createTestViewer();
    plugin.onModelLoaded(null as any, viewer as any);
    plugin.dispose();

    // After dispose, Space should be a no-op (viewer is detached anyway).
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
    expect(viewer.isSimulationPaused).toBe(false);
  });
});
