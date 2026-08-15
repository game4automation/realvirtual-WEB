// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-435 T1/T2/T3/T12/T15 — the retroactive teardown contract of
 * `setPluginUserEnabled`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCoreViewer, loadResult, resetModeStorage } from './helpers/core-toggle-viewer';

beforeEach(() => {
  resetModeStorage();
});

describe('plugin toggle teardown', () => {
  // T1
  it('lets onDeactivate win over the onModelCleared fallback', async () => {
    const { viewer, modes, load } = createCoreViewer();
    const deactivate = vi.fn();
    const cleared = vi.fn();
    viewer.use({
      id: 'hooked',
      onModelLoaded: vi.fn(),
      onModelCleared: cleared,
      onDeactivate: deactivate,
    });
    modes.setMode('hmi');
    await load(loadResult());

    viewer.setPluginUserEnabled('hooked', false);
    expect(deactivate).toHaveBeenCalledOnce();
    expect(cleared).not.toHaveBeenCalled();
  });

  // T1
  it('does not throw for a plugin with neither hook nor onModelCleared', async () => {
    const { viewer, modes, load } = createCoreViewer();
    viewer.use({ id: 'bare', onModelLoaded: vi.fn() });
    modes.setMode('hmi');
    await load(loadResult());

    expect(() => viewer.setPluginUserEnabled('bare', false)).not.toThrow();
    expect(viewer.isPluginDisabled('bare')).toBe(true);
    expect(() => viewer.setPluginUserEnabled('bare', true)).not.toThrow();
    expect(viewer.isPluginDisabled('bare')).toBe(false);
  });

  // T2
  it('fires exactly one onModelCleared across disable and a later real clearModel', async () => {
    const { viewer, modes, load, clear } = createCoreViewer();
    const cleared = vi.fn();
    viewer.use({ id: 'fallback', onModelLoaded: vi.fn(), onModelCleared: cleared });
    modes.setMode('hmi');
    await load(loadResult());

    viewer.setPluginUserEnabled('fallback', false);
    expect(cleared).toHaveBeenCalledOnce();

    clear();
    expect(cleared).toHaveBeenCalledOnce();
  });

  // T2 — the hook branch KEEPS the model bookkeeping (invariant 3).
  it('still delivers onModelCleared to a hook plugin on a later real clearModel', async () => {
    const { viewer, internals, modes, load, clear } = createCoreViewer();
    const cleared = vi.fn();
    viewer.use({
      id: 'hooked',
      onModelLoaded: vi.fn(),
      onModelCleared: cleared,
      onDeactivate: vi.fn(),
    });
    modes.setMode('hmi');
    await load(loadResult());

    viewer.setPluginUserEnabled('hooked', false);
    expect(internals._modelLoadedIds.has('hooked')).toBe(true);

    clear();
    expect(cleared).toHaveBeenCalledOnce();
  });

  // T3
  it('restores through exactly one path when the model stays loaded', async () => {
    const { viewer, modes, load } = createCoreViewer();
    const fallbackLoad = vi.fn();
    const hookLoad = vi.fn();
    const activate = vi.fn();
    viewer.use({ id: 'fallback', onModelLoaded: fallbackLoad, onModelCleared: vi.fn() });
    viewer.use({
      id: 'hooked',
      onModelLoaded: hookLoad,
      onDeactivate: vi.fn(),
      onActivate: activate,
    });
    modes.setMode('hmi');
    await load(loadResult());
    expect(fallbackLoad).toHaveBeenCalledOnce();
    expect(hookLoad).toHaveBeenCalledOnce();

    viewer.setPluginUserEnabled('fallback', false);
    viewer.setPluginUserEnabled('hooked', false);
    viewer.setPluginUserEnabled('fallback', true);
    viewer.setPluginUserEnabled('hooked', true);

    // Fallback plugin: exactly one further onModelLoaded, no onActivate.
    expect(fallbackLoad).toHaveBeenCalledTimes(2);
    // Hook plugin: onActivate only, model never replayed (it never lost it).
    expect(activate).toHaveBeenCalledOnce();
    expect(hookLoad).toHaveBeenCalledOnce();
  });

  // T3
  it('replays nothing when no model was ever loaded', () => {
    const { viewer, modes } = createCoreViewer();
    const modelLoaded = vi.fn();
    const cleared = vi.fn();
    viewer.use({ id: 'idle', onModelLoaded: modelLoaded, onModelCleared: cleared });
    modes.setMode('hmi');

    viewer.setPluginUserEnabled('idle', false);
    viewer.setPluginUserEnabled('idle', true);

    expect(cleared).not.toHaveBeenCalled();
    expect(modelLoaded).not.toHaveBeenCalled();
  });

  // T12
  it('delivers a missed onModelLoaded BEFORE onActivate, each exactly once', async () => {
    const { viewer, modes, load, clear } = createCoreViewer();
    const order: string[] = [];
    viewer.use({
      id: 'hooked',
      onModelLoaded: () => order.push('onModelLoaded'),
      onModelCleared: () => order.push('onModelCleared'),
      onDeactivate: () => order.push('onDeactivate'),
      onActivate: () => order.push('onActivate'),
    });
    modes.setMode('hmi');
    await load(loadResult());
    order.length = 0;

    viewer.setPluginUserEnabled('hooked', false);
    clear();
    await load(loadResult());
    viewer.setPluginUserEnabled('hooked', true);

    expect(order).toEqual([
      'onDeactivate',
      'onModelCleared',   // the real clearModel — the plugin still owned the model
      'onModelLoaded',    // replayed from the missed-load set
      'onActivate',       // …and only then the activation
    ]);
  });

  // T15
  it('completes the toggle even when onDeactivate throws', async () => {
    const { viewer, modes, emit, load } = createCoreViewer();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const Comp = () => null;
    viewer.use({
      id: 'throwing',
      slots: [{ slot: 'kpi-bar', component: Comp as never, order: 10 }],
      onModelLoaded: vi.fn(),
      onDeactivate: () => { throw new Error('boom'); },
    });
    modes.setMode('hmi');
    await load(loadResult());
    emit.mockClear();

    expect(() => viewer.setPluginUserEnabled('throwing', false)).not.toThrow();
    expect(viewer.isPluginDisabled('throwing')).toBe(true);
    expect(viewer.uiRegistry.getSlotComponents('kpi-bar')).toHaveLength(0);
    expect(emit).toHaveBeenCalledWith('plugins-changed', { kind: 'user-disabled', id: 'throwing' });
    consoleError.mockRestore();
  });
});
