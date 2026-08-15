// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCoreViewer, loadResult, resetModeStorage } from './helpers/core-toggle-viewer';

beforeEach(() => {
  resetModeStorage();
});

describe('RVViewer plugin user overrides', () => {
  it('survives a mode roundtrip without ghost activate/deactivate hooks', () => {
    const { viewer, modes } = createCoreViewer();
    const activate = vi.fn();
    const deactivate = vi.fn();
    viewer.use({ id: 'hmi-tool', modes: ['hmi'], onModeActivate: activate, onModeDeactivate: deactivate });
    modes.setMode('hmi');
    activate.mockClear();

    viewer.setPluginUserEnabled('hmi-tool', false);
    expect(deactivate).toHaveBeenCalledOnce();
    modes.setMode('planner');
    modes.setMode('hmi');

    expect(deactivate).toHaveBeenCalledOnce();
    expect(activate).not.toHaveBeenCalled();
    expect(viewer.isPluginDisabled('hmi-tool')).toBe(true);
    expect(viewer.isPluginUserDisabled('hmi-tool')).toBe(true);
  });

  it('disables callbacks in the null-mode boot window and defers activation until user enable', () => {
    const { viewer, modes } = createCoreViewer();
    const tick = vi.fn();
    const activate = vi.fn();
    viewer.use({ id: 'boot-tool', modes: ['hmi'], onFixedUpdatePre: tick, onModeActivate: activate });

    viewer.setPluginUserEnabled('boot-tool', false);
    modes.setMode('hmi');
    expect(viewer.isPluginDisabled('boot-tool')).toBe(true);
    expect(activate).not.toHaveBeenCalled();

    viewer.setPluginUserEnabled('boot-tool', true);
    expect(viewer.isPluginDisabled('boot-tool')).toBe(false);
    expect(activate).toHaveBeenCalledOnce();
  });

  it('clears the actual model recipient while disabled and replays only an eligible current model', async () => {
    const { viewer, modes, load, clear } = createCoreViewer();
    const received: string[] = [];
    const cleared = vi.fn();
    const modelA = loadResult();
    const modelB = loadResult(['target']);
    viewer.use({
      id: 'target',
      modes: ['hmi'],
      onModelLoaded: (result) => received.push(result === modelB ? 'B' : 'A'),
      onModelCleared: cleared,
    });
    const optionalLoad = vi.fn();
    viewer.use({ id: 'optional', modes: ['hmi'], onModelLoaded: optionalLoad, onModelCleared: vi.fn() });
    modes.setMode('hmi');

    await load(modelA);
    expect(received).toEqual(['A']);
    expect(optionalLoad).toHaveBeenCalledOnce();

    viewer.setPluginUserEnabled('target', false);
    viewer.setPluginUserEnabled('optional', false);
    clear();
    expect(cleared).toHaveBeenCalledOnce();

    await load(modelB);
    viewer.setPluginUserEnabled('target', true);
    viewer.setPluginUserEnabled('optional', true);
    expect(received).toEqual(['A', 'B']);
    expect(optionalLoad).toHaveBeenCalledOnce();
  });

  it('recomputes the transport mutex from enabled plugins', () => {
    const { viewer, internals, modes } = createCoreViewer();
    viewer.use({ id: 'transport-owner', modes: ['hmi'], handlesTransport: true });
    modes.setMode('hmi');
    expect(internals._physicsPluginActive).toBe(true);
    viewer.setPluginUserEnabled('transport-owner', false);
    expect(internals._physicsPluginActive).toBe(false);
    viewer.setPluginUserEnabled('transport-owner', true);
    expect(internals._physicsPluginActive).toBe(true);
  });

  it('cleans overrides on remove/re-register and returns defensive snapshots', () => {
    const { viewer, modes } = createCoreViewer();
    viewer.use({ id: 'replaceable', modes: ['hmi'] });
    modes.setMode('hmi');
    viewer.setPluginUserEnabled('replaceable', false);
    const snapshot = viewer.getPluginUserDisabledIds() as Set<string>;
    snapshot.clear();
    expect(viewer.isPluginUserDisabled('replaceable')).toBe(true);

    expect(viewer.removePlugin('replaceable')).toBe(true);
    viewer.use({ id: 'replaceable', modes: ['hmi'] });
    expect(viewer.isPluginUserDisabled('replaceable')).toBe(false);
  });

  it('enables outside-mode plugins only on the next matching mode transition', () => {
    const { viewer, modes } = createCoreViewer();
    const activate = vi.fn();
    viewer.use({ id: 'planner-tool', modes: ['planner'], onModeActivate: activate });
    modes.setMode('hmi');
    viewer.setPluginUserEnabled('planner-tool', false);
    viewer.setPluginUserEnabled('planner-tool', true);
    expect(viewer.isPluginDisabled('planner-tool')).toBe(true);
    expect(activate).not.toHaveBeenCalled();

    modes.setMode('planner');
    expect(viewer.isPluginDisabled('planner-tool')).toBe(false);
    expect(activate).toHaveBeenCalledOnce();
  });

  it('clears all overrides without disturbing plugins registered later', () => {
    const { viewer, modes } = createCoreViewer();
    viewer.use({ id: 'first', modes: ['hmi'] });
    modes.setMode('hmi');
    viewer.setPluginUserEnabled('first', false);
    viewer.use({ id: 'late', modes: ['hmi'] });

    viewer.clearPluginUserOverrides();
    expect(viewer.getPluginUserDisabledIds().size).toBe(0);
    expect(viewer.isPluginDisabled('first')).toBe(false);
    expect(viewer.isPluginDisabled('late')).toBe(false);
  });

  it('does not emit for unknown IDs or duplicate user state', () => {
    const { viewer, emit, modes } = createCoreViewer();
    viewer.use({ id: 'known', modes: ['hmi'] });
    modes.setMode('hmi');
    emit.mockClear();

    viewer.setPluginUserEnabled('unknown', false);
    viewer.setPluginUserEnabled('known', true);
    expect(emit).not.toHaveBeenCalled();
    viewer.setPluginUserEnabled('known', false);
    const count = emit.mock.calls.length;
    viewer.setPluginUserEnabled('known', false);
    expect(emit).toHaveBeenCalledTimes(count);
  });
});
