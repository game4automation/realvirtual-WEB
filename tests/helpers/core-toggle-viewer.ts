// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * `createCoreViewer()` — the plugin-lifecycle harness (plan-435 §9).
 *
 * A real `RVViewer.prototype` clone with every internal field the plugin
 * system touches, a real `UIPluginRegistry` and a real `ModeManager`. Unlike
 * `helpers/feature-matrix-viewer.ts` (UI-oriented) this harness also drives
 * `onModelLoaded` / `onModelCleared` through the viewer's own private
 * notification methods, so model bookkeeping (`_modelLoadedIds`,
 * `_missedModelLoad`) behaves exactly as in production.
 */

import { vi } from 'vitest';
import type { LoadResult } from '../../src/core/engine/rv-scene-loader';
import { ModeManager, type ModeHost } from '../../src/core/rv-mode-manager';
import type { RVViewerPlugin } from '../../src/core/rv-plugin';
import { RVViewer, type PluginOrigin } from '../../src/core/rv-viewer';
import { UIPluginRegistry } from '../../src/core/rv-ui-registry';

export interface ViewerInternals {
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
  _persistedUserDisabled: Set<string>;
  _missedModelLoad: Set<string>;
  _modelLoadedIds: Set<string>;
  _lastLoadResult: LoadResult | null;
  _physicsPluginActive: boolean;
  _pluginContext: object;
  _notifyPluginsModelLoaded(result: LoadResult): Promise<void>;
  _notifyPluginsModelCleared(): void;
}

/** Minimal `LoadResult` stub; `plugins` mirrors a model's `rv_plugins` list. */
export function loadResult(plugins?: string[]): LoadResult {
  return { modelConfig: { plugins } } as unknown as LoadResult;
}

export function createCoreViewer() {
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
    _persistedUserDisabled: new Set(),
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

/** Drop the persisted active mode so a fresh harness always boots in null-mode. */
export function resetModeStorage(): void {
  try { localStorage.removeItem('rv-active-mode'); } catch { /* unavailable */ }
}
