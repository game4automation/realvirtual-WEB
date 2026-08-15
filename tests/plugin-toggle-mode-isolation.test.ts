// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-435 T5 — the teardown lives ONLY in `setPluginUserEnabled`.
 *
 * A workspace mode switch goes through `disablePlugin()` / `enablePlugin()`
 * for every mode-scoped plugin. If the teardown were anchored there, every
 * click on the mode dropdown would fire `onDeactivate` / `onModelCleared` and
 * make the whole toolbar flicker (plan-435 §2.2).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCoreViewer, loadResult, resetModeStorage } from './helpers/core-toggle-viewer';

const Comp = (() => null) as never;

beforeEach(() => {
  resetModeStorage();
});

describe('mode switches never trigger the user-toggle teardown', () => {
  it('leaves onDeactivate/onActivate and the UI slots untouched on setMode()', async () => {
    const { viewer, modes, load } = createCoreViewer();
    const deactivate = vi.fn();
    const activate = vi.fn();
    const cleared = vi.fn();
    viewer.use({
      id: 'planner-tool',
      modes: ['planner'],
      slots: [{ slot: 'button-group', component: Comp, order: 10 }],
      onModelLoaded: vi.fn(),
      onModelCleared: cleared,
      onDeactivate: deactivate,
      onActivate: activate,
    });
    const unregister = vi.spyOn(viewer.uiRegistry, 'unregister');
    modes.setMode('planner');
    await load(loadResult());

    modes.setMode('hmi');
    modes.setMode('planner');
    modes.setMode('hmi');

    expect(deactivate).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    expect(cleared).not.toHaveBeenCalled();
    expect(unregister).not.toHaveBeenCalled();
    // The slot itself stays registered — its `mode:planner` visibility rule,
    // not the registry, is what hides it outside the planner.
    expect(viewer.uiRegistry.getSlotComponents('button-group')).toHaveLength(1);
  });

  it('still disables and re-enables the plugin on the mode transition', () => {
    const { viewer, modes } = createCoreViewer();
    viewer.use({ id: 'planner-tool', modes: ['planner'] });
    modes.setMode('planner');
    expect(viewer.isPluginDisabled('planner-tool')).toBe(false);

    modes.setMode('hmi');
    expect(viewer.isPluginDisabled('planner-tool')).toBe(true);

    modes.setMode('planner');
    expect(viewer.isPluginDisabled('planner-tool')).toBe(false);
  });
});
