// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it, vi } from 'vitest';
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
  _persistedUserDisabled: Set<string>;
  _missedModelLoad: Set<string>;
  _modelLoadedIds: Set<string>;
  _lastLoadResult: null;
  _physicsPluginActive: boolean;
  _pluginContext: object;
}

function createPluginApiViewer() {
  const viewer = Object.create(RVViewer.prototype) as RVViewer;
  const internals = viewer as unknown as ViewerInternals & Record<string, unknown>;
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
    modes: { activeMode: 'hmi' },
    uiRegistry: new UIPluginRegistry(),
    contextMenu: { unregister: vi.fn() },
  });
  return viewer;
}

describe('RVViewer plugin origins', () => {
  it('sets explicit and scoped origins atomically and restores nested defaults', () => {
    const viewer = createPluginApiViewer();
    const registrations: Array<{ id: string; origin: PluginOrigin; present: boolean }> = [];
    viewer.emit = vi.fn((event: string, payload?: unknown) => {
      if (event !== 'plugins-changed') return;
      const id = (payload as { id: string }).id;
      registrations.push({
        id,
        origin: viewer.getPluginOrigin(id),
        present: viewer.getPlugins().some((plugin) => plugin.id === id),
      });
    }) as RVViewer['emit'];

    viewer.use({ id: 'explicit' }, 'commercial');
    viewer.withDefaultOrigin('project', () => {
      viewer.use({ id: 'project-default' });
      viewer.withDefaultOrigin('internal', () => viewer.use({ id: 'nested' }));
      viewer.use({ id: 'project-restored' });
      viewer.use({ id: 'explicit-wins' }, 'core');
    });
    viewer.use({ id: 'untagged' });

    expect(registrations.every((entry) => entry.present)).toBe(true);
    expect(viewer.getPluginOrigin('explicit')).toBe('commercial');
    expect(viewer.getPluginOrigin('project-default')).toBe('project');
    expect(viewer.getPluginOrigin('nested')).toBe('internal');
    expect(viewer.getPluginOrigin('project-restored')).toBe('project');
    expect(viewer.getPluginOrigin('explicit-wins')).toBe('core');
    expect(viewer.getPluginOrigin('untagged')).toBe('unknown');
    expect(viewer.getPluginOrigin('missing')).toBe('unknown');
  });

  it('restores the outer origin even when the scoped callback throws', () => {
    const viewer = createPluginApiViewer();
    viewer.emit = vi.fn() as RVViewer['emit'];

    expect(() => viewer.withDefaultOrigin('project', () => {
      throw new Error('registration failed');
    })).toThrow('registration failed');
    viewer.use({ id: 'after-error' });

    expect(viewer.getPluginOrigin('after-error')).toBe('unknown');
  });

  it('cleans origins on remove and uses the new origin after re-registration', () => {
    const viewer = createPluginApiViewer();
    viewer.emit = vi.fn() as RVViewer['emit'];

    viewer.use({ id: 'replaceable' }, 'project');
    expect(viewer.removePlugin('replaceable')).toBe(true);
    expect(viewer.getPluginOrigin('replaceable')).toBe('unknown');
    viewer.use({ id: 'replaceable' }, 'internal');
    expect(viewer.getPluginOrigin('replaceable')).toBe('internal');
  });

  it('returns a defensive plugin copy', () => {
    const viewer = createPluginApiViewer();
    viewer.emit = vi.fn() as RVViewer['emit'];
    viewer.use({ id: 'stable' }, 'core');

    const snapshot = viewer.getPlugins() as RVViewerPlugin[];
    snapshot.push({ id: 'injected' });
    snapshot.splice(0, 1);

    expect(viewer.getPlugins().map((plugin) => plugin.id)).toEqual(['stable']);
  });

  it('emits only after successful mutations and not for documented no-ops', () => {
    const viewer = createPluginApiViewer();
    const emit = vi.fn();
    viewer.emit = emit as RVViewer['emit'];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const removable = { id: 'removable' };
    const core = { id: 'core', core: true };
    viewer.use(removable, 'project');
    viewer.use(core, 'core');
    emit.mockClear();

    viewer.use({ id: 'removable' }, 'internal');
    viewer.enablePlugin('removable');
    viewer.removePlugin('missing');
    viewer.removePlugin('core');
    expect(emit).not.toHaveBeenCalled();

    viewer.disablePlugin('core');
    expect(viewer.isPluginDisabled('core')).toBe(true);
    expect(emit).toHaveBeenLastCalledWith('plugins-changed', { kind: 'disabled', id: 'core' });
    viewer.disablePlugin('core');
    expect(emit).toHaveBeenCalledTimes(1);

    viewer.enablePlugin('core');
    expect(viewer.isPluginDisabled('core')).toBe(false);
    expect(emit).toHaveBeenLastCalledWith('plugins-changed', { kind: 'enabled', id: 'core' });
    viewer.removePlugin('removable');
    expect(emit).toHaveBeenLastCalledWith('plugins-changed', { kind: 'removed', id: 'removable' });

    warn.mockRestore();
  });
});
