// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-render-backend-plugins.test.ts — plan-256 test 9-WEB (c).
 *
 * The interactive 3D plugins (measurement, ik-target-edit, snap-point,
 * clipping, webxr, gaussian-splat, drive-axis-gizmo, …) rely on
 * viewer.camera()/renderer/raycast and must no-op under a non-Three backend.
 * The viewer neutralises them two ways:
 *   1. CENTRAL — while `shouldRenderThree()` is false, `render()` skips the
 *      per-frame plugin `onRender` dispatch, and the WebGL canvas is hidden
 *      (no pointer events reach the raycaster). Also `shouldRunThreePlugins()`
 *      is false.
 *   2. EXPLICIT — the `onRenderBackendChanged` plugin hook lets a plugin tear
 *      down open gizmos / drag handlers.
 *
 * This test exercises both mechanisms at unit level (no heavy RVViewer needed).
 */

import { describe, test, expect, vi } from 'vitest';
import {
  RenderBackendController,
  type RenderBackendId,
  type RenderBackendAwarePlugin,
} from '../src/core/render-backend/rv-render-backend';

/** A minimal stand-in for an interactive 3D plugin. */
class Fake3DPlugin implements RenderBackendAwarePlugin {
  active = true;
  gizmoOpen = true;
  renderCalls = 0;
  /** Called by the render loop only while three renders. */
  onRender() { this.renderCalls++; }
  onRenderBackendChanged(backend: RenderBackendId) {
    if (backend !== 'three') {
      this.active = false;
      this.gizmoOpen = false;
    } else {
      this.active = true;
    }
  }
}

describe('render backend — plugin neutralisation', () => {
  test('central: onRender dispatch is skipped and canvas hidden under omniverse', async () => {
    const controller = new RenderBackendController();
    controller.registerFactory('omniverse', () => ({
      id: 'omniverse' as const, mount: () => {}, dispose: () => {},
    }));
    const plugin = new Fake3DPlugin();
    const canvas = document.createElement('canvas');

    // Simulate the render-loop + canvas-visibility logic from RVViewer.render()
    // / _syncCanvasVisibility().
    const renderFrame = () => {
      canvas.style.display = controller.shouldRenderThree() ? 'block' : 'none';
      if (!controller.shouldRenderThree()) return; // render() early-returns
      plugin.onRender();
    };

    renderFrame();
    renderFrame();
    expect(plugin.renderCalls).toBe(2);
    expect(canvas.style.display).toBe('block');

    await controller.setBackend('omniverse', document.createElement('div'));
    expect(controller.shouldRenderThree()).toBe(false);
    expect(controller.shouldRunThreePlugins()).toBe(false);

    const before = plugin.renderCalls;
    renderFrame();
    renderFrame();
    expect(plugin.renderCalls).toBe(before); // onRender no longer dispatched
    expect(canvas.style.display).toBe('none'); // canvas hidden → no raycast input
  });

  test('explicit: onRenderBackendChanged tears the plugin down and restores it', () => {
    const plugin = new Fake3DPlugin();
    expect(plugin.active).toBe(true);
    expect(plugin.gizmoOpen).toBe(true);

    // Simulate RVViewer.setRenderBackend() dispatching the hook to plugins.
    plugin.onRenderBackendChanged('omniverse');
    expect(plugin.active).toBe(false);
    expect(plugin.gizmoOpen).toBe(false);

    plugin.onRenderBackendChanged('three');
    expect(plugin.active).toBe(true);
  });

  test('backend-change listeners fire (drives the viewer plugin dispatch + HMI)', async () => {
    const controller = new RenderBackendController();
    controller.registerFactory('omniverse', () => ({
      id: 'omniverse' as const, mount: () => {}, dispose: () => {},
    }));
    const seen: RenderBackendId[] = [];
    const off = controller.onBackendChange((b) => seen.push(b));

    await controller.setBackend('omniverse', document.createElement('div'));
    await controller.setBackend('three');
    expect(seen).toEqual(['omniverse', 'three']);

    off();
    await controller.setBackend('omniverse', document.createElement('div'));
    expect(seen).toEqual(['omniverse', 'three']); // unsubscribed
  });

  test('switching to an unregistered backend rejects and stays on three', async () => {
    const controller = new RenderBackendController();
    const statuses: string[] = [];
    controller.onStatusChange((s) => statuses.push(s));

    await expect(controller.setBackend('omniverse', document.createElement('div')))
      .rejects.toThrow(/not registered/);
    expect(controller.backend).toBe('three');
    expect(controller.shouldRenderThree()).toBe(true);
    expect(statuses).toContain('error');
  });
});
