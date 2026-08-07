// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';
import { ModeManager, type ModeHost } from '../src/core/rv-mode-manager';
import type { RVViewerPlugin } from '../src/core/rv-plugin';
import { RVViewer, type PluginOrigin } from '../src/core/rv-viewer';
import { UIPluginRegistry } from '../src/core/rv-ui-registry';

interface ViewerInternals {
  _plugins: RVViewerPlugin[];
  _pluginOrigins: Map<string, PluginOrigin>;
  _defaultPluginOrigin?: PluginOrigin;
  _prePlugins: RVViewerPlugin[];
  _postPlugins: RVViewerPlugin[];
  _renderPlugins: RVViewerPlugin[];
  _prePluginsSnapshot: readonly RVViewerPlugin[] | null;
  _postPluginsSnapshot: readonly RVViewerPlugin[] | null;
  _disabledIds: Set<string>;
  _userDisabledIds: Set<string>;
  _missedModelLoad: Set<string>;
  _modelLoadedIds: Set<string>;
  _lastLoadResult: LoadResult | null;
  _physicsPluginActive: boolean;
  _pluginContext: object;
  _notifyPluginsModelLoaded(result: LoadResult): Promise<void>;
  _notifyPluginsModelCleared(): void;
}

function loadResult(plugins?: string[]): LoadResult {
  return { modelConfig: { plugins } } as unknown as LoadResult;
}

function createCoreViewer() {
  const viewer = Object.create(RVViewer.prototype) as RVViewer;
  const internals = viewer as unknown as ViewerInternals & Record<string, unknown>;
  const emit = vi.fn();
  Object.assign(internals, {
    _plugins: [],
    _pluginOrigins: new Map(),
    _defaultPluginOrigin: undefined,
    _prePlugins: [],
    _postPlugins: [],
    _renderPlugins: [],
    _prePluginsSnapshot: null,
    _postPluginsSnapshot: null,
    _disabledIds: new Set(),
    _userDisabledIds: new Set(),
    _missedModelLoad: new Set(),
    _modelLoadedIds: new Set(),
    _lastLoadResult: null,
    _physicsPluginActive: false,
    _pluginContext: {},
    drives: [],
    uiRegistry: new UIPluginRegistry(),
    contextMenu: { unregister: vi.fn() },
    emit,
  });

  const modes = new ModeManager({
    viewer,
    pluginsForMode: (from, to) => viewer.pluginsForMode(from, to),
    enablePlugin: (id) => viewer.enablePlugin(id),
    disablePlugin: (id) => viewer.disablePlugin(id),
    callPlugin: (plugin, method, ...args) => {
      const fn = (plugin as unknown as Record<string, unknown>)[method];
      if (typeof fn === 'function') fn.apply(plugin, args);
    },
    setContext: vi.fn(),
    emit: (event, data) => emit(event, data),
  } satisfies ModeHost);
  modes.register({ id: 'hmi', label: 'HMI' });
  modes.register({ id: 'planner', label: 'Planner' });
  internals.modes = modes;

  const load = async (result: LoadResult) => {
    internals._lastLoadResult = result;
    await internals._notifyPluginsModelLoaded(result);
  };
  const clear = () => {
    internals._notifyPluginsModelCleared();
    internals._lastLoadResult = null;
    internals._missedModelLoad.clear();
  };

  return { viewer, internals, modes, emit, load, clear };
}

beforeEach(() => {
  try { localStorage.removeItem('rv-active-mode'); } catch { /* unavailable */ }
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
