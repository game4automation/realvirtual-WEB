// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-435 T16 — plugins whose visible effect lives in a FOREIGN plugin.
 *
 * `pipe-coloring` and `processing-unit-mode` each own nothing but a button:
 * the actual colouring / info display is state inside `ProcessIndustryPlugin`.
 * Removing their slot is therefore NOT a teardown — the pipes would stay
 * coloured behind a switched-off plugin (§2.5 Group B, round-2 finding 2).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PipeColoringPlugin, savePipeColoringEnabled } from '../src/plugins/pipe-coloring-plugin';
import {
  ProcessingUnitModePlugin,
  saveProcessingUnitModeEnabled,
} from '../src/plugins/processing-unit-mode-plugin';
import { createCoreViewer, loadResult, resetModeStorage } from './helpers/core-toggle-viewer';

/** Stand-in for the foreign plugin that actually holds the visible state. */
function createProcessIndustryStub() {
  const state = { coloring: false, processingUnit: false };
  return {
    state,
    plugin: {
      id: 'processindustry',
      setColoringEnabled: vi.fn((on: boolean) => { state.coloring = on; }),
      setProcessingUnitModeEnabled: vi.fn((on: boolean) => { state.processingUnit = on; }),
    },
  };
}

beforeEach(() => {
  resetModeStorage();
  try { localStorage.clear(); } catch { /* unavailable */ }
});

describe('toggling a plugin that holds state in a foreign plugin', () => {
  it('pipe-coloring resets the colouring in ProcessIndustryPlugin and restores it', async () => {
    const { viewer, modes, load } = createCoreViewer();
    const foreign = createProcessIndustryStub();
    viewer.use(foreign.plugin);
    savePipeColoringEnabled(true);
    viewer.use(new PipeColoringPlugin());
    modes.setMode('hmi');
    await load(loadResult());
    expect(foreign.state.coloring).toBe(true);

    viewer.setPluginUserEnabled('pipe-coloring', false);
    // Not just the button gone — the colouring itself is off.
    expect(foreign.state.coloring).toBe(false);
    expect(viewer.uiRegistry.getSlotComponents('button-group')).toHaveLength(0);

    viewer.setPluginUserEnabled('pipe-coloring', true);
    expect(foreign.state.coloring).toBe(true);
    expect(viewer.uiRegistry.getSlotComponents('button-group')).toHaveLength(1);
  });

  it('processing-unit-mode does the same for the PU display', async () => {
    const { viewer, modes, load } = createCoreViewer();
    const foreign = createProcessIndustryStub();
    viewer.use(foreign.plugin);
    saveProcessingUnitModeEnabled(true);
    viewer.use(new ProcessingUnitModePlugin());
    modes.setMode('hmi');
    await load(loadResult());
    expect(foreign.state.processingUnit).toBe(true);

    viewer.setPluginUserEnabled('processing-unit-mode', false);
    expect(foreign.state.processingUnit).toBe(false);

    viewer.setPluginUserEnabled('processing-unit-mode', true);
    expect(foreign.state.processingUnit).toBe(true);
  });

  it('restores the persisted preference, not a hardcoded true', async () => {
    const { viewer, modes, load } = createCoreViewer();
    const foreign = createProcessIndustryStub();
    viewer.use(foreign.plugin);
    savePipeColoringEnabled(false);
    viewer.use(new PipeColoringPlugin());
    modes.setMode('hmi');
    await load(loadResult());

    viewer.setPluginUserEnabled('pipe-coloring', false);
    viewer.setPluginUserEnabled('pipe-coloring', true);
    expect(foreign.state.coloring).toBe(false);
  });
});
