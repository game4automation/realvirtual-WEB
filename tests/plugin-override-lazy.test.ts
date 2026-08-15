// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-435 T13 — a persisted override must also reach plugins that only get
 * registered while (or after) the model loads.
 *
 * `setPluginUserEnabled()` returns immediately for an unknown ID, so the
 * intent has to live in the viewer independently of the registry and be
 * applied in `use()` — BEFORE the retroactive `onModelLoaded` delivery.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCoreViewer, loadResult, resetModeStorage } from './helpers/core-toggle-viewer';

beforeEach(() => {
  resetModeStorage();
});

describe('persisted overrides for late-registered plugins', () => {
  it('applies before the retroactive onModelLoaded of a late plugin', async () => {
    const { viewer, modes, load } = createCoreViewer();
    modes.setMode('hmi');
    // Nothing with this ID exists yet — the intent must survive that.
    viewer.applyPersistedPluginOverrides(['late-model-plugin']);
    await load(loadResult());

    const modelLoaded = vi.fn();
    viewer.use({ id: 'late-model-plugin', onModelLoaded: modelLoaded });

    expect(modelLoaded).not.toHaveBeenCalled();
    expect(viewer.isPluginUserDisabled('late-model-plugin')).toBe(true);
    expect(viewer.isPluginDisabled('late-model-plugin')).toBe(true);
  });

  it('restores the late plugin when the user switches it back on', async () => {
    const { viewer, modes, load } = createCoreViewer();
    modes.setMode('hmi');
    viewer.applyPersistedPluginOverrides(['late-model-plugin']);
    await load(loadResult());
    const modelLoaded = vi.fn();
    viewer.use({ id: 'late-model-plugin', onModelLoaded: modelLoaded });

    viewer.setPluginUserEnabled('late-model-plugin', true);
    expect(viewer.isPluginDisabled('late-model-plugin')).toBe(false);
    expect(modelLoaded).toHaveBeenCalledOnce();
  });

  it('applies to plugins already registered at boot', () => {
    const { viewer, modes } = createCoreViewer();
    viewer.use({ id: 'early' });
    modes.setMode('hmi');

    viewer.applyPersistedPluginOverrides(['early']);
    expect(viewer.isPluginUserDisabled('early')).toBe(true);
  });

  it('never disables a core plugin, however the storage got that way', () => {
    const { viewer, modes } = createCoreViewer();
    viewer.use({ id: 'infrastructure', core: true });
    modes.setMode('hmi');

    viewer.applyPersistedPluginOverrides(['infrastructure']);
    expect(viewer.isPluginUserDisabled('infrastructure')).toBe(false);
    expect(viewer.isPluginDisabled('infrastructure')).toBe(false);
  });

  it('keeps core plugins out of what gets persisted', () => {
    const { viewer, modes } = createCoreViewer();
    viewer.use({ id: 'infrastructure', core: true });
    viewer.use({ id: 'optional' });
    modes.setMode('hmi');

    viewer.setPluginUserEnabled('infrastructure', false);
    viewer.setPluginUserEnabled('optional', false);

    // Both are off for this session…
    expect(viewer.getPluginUserDisabledIds().size).toBe(2);
    // …but only the non-core one survives a reload.
    expect(viewer.getPersistedPluginOverrideIds()).toEqual(['optional']);
  });
});
