// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-435 T14 / F11 — the generation guard.
 *
 * Synchronous `onDeactivate` hooks only hold up if async initialisation can be
 * aborted. `webxr` is the proof case: `onModelLoaded` fires `initXR()` off and
 * forgets it, and that promise waits on `_supportReady`. Without the guard, a
 * toggle-off during that wait would still end up building dolly, controller
 * rig and listeners — the switch would be visibly without effect (§2.10).
 */

import { describe, expect, it, vi } from 'vitest';
import { WebXRPlugin } from '../src/plugins/webxr-plugin';

interface XRInternals {
  _supportReady: Promise<unknown>;
  _generation: number;
  initialized: boolean;
  dolly: unknown;
  glRenderer: unknown;
}

describe('webxr async abort guard', () => {
  it('builds nothing after a toggle-off that lands before _supportReady resolves', async () => {
    const plugin = new WebXRPlugin();
    const internals = plugin as unknown as XRInternals;

    // Hold the support check open so the toggle can land inside the await.
    let release!: () => void;
    internals._supportReady = new Promise<void>((resolve) => { release = resolve; });

    // Anything below the await would touch these; if the guard works, it never
    // gets that far.
    const add = vi.fn();
    const viewer = {
      isWebGPU: false,
      scene: { add, remove: vi.fn() },
      camera: {},
      renderer: {},
      setSimulationPaused: vi.fn(),
    } as never;

    plugin.onModelLoaded({ boundingBox: null } as never, viewer);
    expect(internals.initialized).toBe(true);

    plugin.onDeactivate();          // bumps the generation, runs dispose()
    release();                      // …and only now the support check finishes
    await Promise.resolve();
    await Promise.resolve();

    expect(add).not.toHaveBeenCalled();
    expect(internals.dolly).toBeNull();
    expect(internals.glRenderer).toBeNull();
    // dispose() reset the latch, so a later activate can build for real.
    expect(internals.initialized).toBe(false);
  });

  it('bumps the generation on every deactivate', () => {
    const plugin = new WebXRPlugin();
    const internals = plugin as unknown as XRInternals;
    const before = internals._generation;
    plugin.onDeactivate();
    plugin.onDeactivate();
    expect(internals._generation).toBe(before + 2);
  });
});
