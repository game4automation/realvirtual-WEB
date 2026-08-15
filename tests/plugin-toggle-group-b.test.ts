// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-435 T7 — Group B: plugins where the fallback is WITHOUT EFFECT.
 * Each of these has no `slots` and no (useful) `onModelCleared`, so before
 * this plan switching them off changed nothing at all.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera } from 'three';
import { LeftPanelManager } from '../src/core/hmi/left-panel-manager';
import { OrientationGizmoPlugin } from '../src/plugins/rv-orientation-gizmo-plugin';
import { OperatorHmiControlsPlugin } from '../src/plugins/models/DemoRealvirtualWeb/operator-hmi-controls';
import { PerfTestPlugin } from '../src/plugins/demo/perf-test-plugin';
import { SimControllerPlugin } from '../src/plugins/sim-controller/index';
import { getActiveContexts } from '../src/core/hmi/ui-context-store';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('Group B — rv-orientation-gizmo', () => {
  it('removes its overlay from document.body and rebuilds it on activate', () => {
    const plugin = new OrientationGizmoPlugin();
    // A REAL camera: the gizmo projects through `camera.matrixWorldInverse`,
    // so a hand-rolled quaternion stub is not enough.
    const camera = new PerspectiveCamera();
    camera.updateMatrixWorld(true);
    const viewer = {
      camera,
      // The real manager, for the same reason: the gizmo reads its dock width
      // while positioning itself.
      leftPanelManager: new LeftPanelManager(),
      markRenderDirty: () => {},
    } as never;

    plugin.onModelLoaded({} as never, viewer);
    const built = document.body.querySelectorAll('div').length;
    expect(built).toBeGreaterThan(0);

    plugin.onDeactivate();
    expect(document.body.querySelectorAll('div').length).toBeLessThan(built);

    plugin.onActivate(viewer);
    expect(document.body.querySelectorAll('div').length).toBe(built);
  });
});

describe('Group B — sim-controller', () => {
  it('removes the keyboard shortcuts and releases a held pause', () => {
    const plugin = new SimControllerPlugin();
    const removeListener = vi.spyOn(window, 'removeEventListener');
    const setSimulationPaused = vi.fn();
    const viewer = { setSimulationPaused } as never;

    plugin.onModelLoaded(null, viewer);
    plugin.onDeactivate();

    expect(removeListener).toHaveBeenCalledWith('keydown', expect.any(Function), true);
    expect(setSimulationPaused).toHaveBeenCalledWith('user', false);
    removeListener.mockRestore();
  });
});

describe('Group B — operator-hmi-controls', () => {
  it('drops the visibility subscription and the operator-hmi context', () => {
    const plugin = new OperatorHmiControlsPlugin();
    plugin.onModelLoaded();
    plugin.onDeactivate();

    expect([...getActiveContexts()]).not.toContain('operator-hmi');
    // A second call must not throw — teardown is idempotent.
    expect(() => plugin.onDeactivate()).not.toThrow();
  });
});

describe('Group B — perf-test', () => {
  it('cancels its pending run and removes the results overlay', () => {
    vi.useFakeTimers();
    const plugin = new PerfTestPlugin();
    const internals = plugin as unknown as { _startTimer: unknown; _overlay: HTMLElement | null };
    const run = vi.fn();
    (plugin as unknown as { run: unknown }).run = run;

    plugin.onModelLoaded({} as never, {} as never);
    expect(internals._startTimer).not.toBeNull();

    // A dangling overlay from an earlier run must go too.
    const overlay = document.createElement('div');
    document.body.appendChild(overlay);
    internals._overlay = overlay;

    plugin.onDeactivate();
    vi.runAllTimers();

    expect(run).not.toHaveBeenCalled();
    expect(internals._startTimer).toBeNull();
    expect(document.body.contains(overlay)).toBe(false);
    vi.useRealTimers();
  });
});
