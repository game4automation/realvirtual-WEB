// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-435 T11a/T11b — toggling during the boot null-mode window.
 *
 * Shared and `core` plugins never appear in any `computeModePluginSets` set,
 * so nothing heals them later: switching them back on must enable them right
 * away, even while `activeMode === null` (T11a). Mode-scoped plugins are the
 * exact opposite — they must stay disabled and wait for the first matching
 * `setMode()` (T11b).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCoreViewer, resetModeStorage } from './helpers/core-toggle-viewer';

beforeEach(() => {
  resetModeStorage();
});

describe('user toggle in the null-mode boot window', () => {
  // T11a
  it('re-enables shared and core plugins immediately', () => {
    const { viewer, modes } = createCoreViewer();
    viewer.use({ id: 'shared-tool' });
    viewer.use({ id: 'core-tool', core: true, modes: ['planner'] });
    expect(modes.activeMode).toBeNull();

    for (const id of ['shared-tool', 'core-tool']) {
      viewer.setPluginUserEnabled(id, false);
      expect(viewer.isPluginDisabled(id)).toBe(true);
      viewer.setPluginUserEnabled(id, true);
      expect(viewer.isPluginDisabled(id)).toBe(false);
    }
  });

  // T11a
  it('re-enables several shared plugins through clearPluginUserOverrides()', () => {
    const { viewer, modes } = createCoreViewer();
    viewer.use({ id: 'one' });
    viewer.use({ id: 'two' });
    viewer.use({ id: 'three', core: true });
    expect(modes.activeMode).toBeNull();

    viewer.setPluginUserEnabled('one', false);
    viewer.setPluginUserEnabled('two', false);
    viewer.setPluginUserEnabled('three', false);

    viewer.clearPluginUserOverrides();
    expect(viewer.getPluginUserDisabledIds().size).toBe(0);
    expect(viewer.isPluginDisabled('one')).toBe(false);
    expect(viewer.isPluginDisabled('two')).toBe(false);
    expect(viewer.isPluginDisabled('three')).toBe(false);
  });

  // T11b
  it('keeps a mode-scoped plugin disabled until the first matching setMode()', () => {
    const { viewer, modes } = createCoreViewer();
    const activate = vi.fn();
    const onActivate = vi.fn();
    viewer.use({
      id: 'planner-tool',
      modes: ['planner'],
      onModeActivate: activate,
      onActivate,
    });
    expect(modes.activeMode).toBeNull();

    viewer.setPluginUserEnabled('planner-tool', false);
    viewer.setPluginUserEnabled('planner-tool', true);
    // Still disabled: it does not participate in the null baseline, so nothing
    // may be built up ahead of time.
    expect(viewer.isPluginDisabled('planner-tool')).toBe(true);
    expect(onActivate).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();

    modes.setMode('hmi');
    expect(viewer.isPluginDisabled('planner-tool')).toBe(true);

    modes.setMode('planner');
    expect(viewer.isPluginDisabled('planner-tool')).toBe(false);
    expect(activate).toHaveBeenCalledOnce();
  });
});
