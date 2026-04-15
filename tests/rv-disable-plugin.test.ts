// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for disablePlugin API and project plugin loading.
 *
 * Uses minimal mocks of the viewer's plugin infrastructure to test
 * the logic without requiring a full Three.js scene or GLB loading.
 */

import { describe, it, expect, vi } from 'vitest';
import { callPlugin } from '../src/core/rv-viewer';
import type { RVViewerPlugin } from '../src/core/rv-plugin';

// ── Minimal plugin infrastructure mock ──────────────────────────────

function makePlugin(overrides: Partial<RVViewerPlugin> & { id: string }): RVViewerPlugin {
  return {
    onModelLoaded: vi.fn(),
    onModelCleared: vi.fn(),
    onConnectionStateChanged: vi.fn(),
    onFixedUpdatePre: vi.fn(),
    onFixedUpdatePost: vi.fn(),
    onRender: vi.fn(),
    dispose: vi.fn(),
    ...overrides,
  };
}

/**
 * Lightweight mock that replicates the relevant parts of RVViewer's
 * plugin management: use(), disablePlugin(), and lifecycle dispatch.
 */
function createMiniViewer() {
  let plugins: RVViewerPlugin[] = [];
  let prePlugins: RVViewerPlugin[] = [];
  let postPlugins: RVViewerPlugin[] = [];
  let renderPlugins: RVViewerPlugin[] = [];
  const disabledIds = new Set<string>();

  const insertSorted = (list: RVViewerPlugin[], p: RVViewerPlugin) => {
    list.push(p);
    list.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  };

  return {
    use(plugin: RVViewerPlugin) {
      if (plugins.some(p => p.id === plugin.id)) return;
      plugins.push(plugin);
      if (plugin.onFixedUpdatePre) insertSorted(prePlugins, plugin);
      if (plugin.onFixedUpdatePost) insertSorted(postPlugins, plugin);
      if (plugin.onRender) insertSorted(renderPlugins, plugin);
    },

    disablePlugin(id: string) {
      const plugin = plugins.find(p => p.id === id);
      if (plugin?.core) {
        console.warn(`[RVViewer] Cannot disable core plugin '${id}'`);
        return;
      }
      prePlugins = prePlugins.filter(p => p.id !== id);
      postPlugins = postPlugins.filter(p => p.id !== id);
      renderPlugins = renderPlugins.filter(p => p.id !== id);
      disabledIds.add(id);
    },

    fireModelLoaded() {
      for (const p of plugins) {
        if (disabledIds.has(p.id)) continue;
        callPlugin(p, 'onModelLoaded', {}, this);
      }
    },

    fireModelCleared() {
      for (const p of plugins) {
        if (disabledIds.has(p.id)) continue;
        callPlugin(p, 'onModelCleared', this);
      }
    },

    fireConnectionStateChanged(state: string) {
      for (const p of plugins) {
        if (disabledIds.has(p.id)) continue;
        callPlugin(p, 'onConnectionStateChanged', state, this);
      }
    },

    fireFixedUpdatePre(dt: number) {
      for (const p of prePlugins) {
        callPlugin(p, 'onFixedUpdatePre', dt);
      }
    },

    fireFixedUpdatePost(dt: number) {
      for (const p of postPlugins) {
        callPlugin(p, 'onFixedUpdatePost', dt);
      }
    },

    fireRender(dt: number) {
      for (const p of renderPlugins) {
        callPlugin(p, 'onRender', dt);
      }
    },

    fireDispose() {
      // dispose always runs for ALL plugins (including disabled)
      for (const p of plugins) {
        callPlugin(p, 'dispose');
      }
    },

    get plugins() { return plugins; },
    get prePlugins() { return prePlugins; },
    get postPlugins() { return postPlugins; },
    get renderPlugins() { return renderPlugins; },
    get disabledIds() { return disabledIds; },
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('disablePlugin', () => {
  it('prevents onModelLoaded callback for disabled plugin', () => {
    const viewer = createMiniViewer();
    const pluginA = makePlugin({ id: 'alpha' });
    const pluginB = makePlugin({ id: 'beta' });
    viewer.use(pluginA);
    viewer.use(pluginB);

    viewer.disablePlugin('beta');
    viewer.fireModelLoaded();

    expect(pluginA.onModelLoaded).toHaveBeenCalledOnce();
    expect(pluginB.onModelLoaded).not.toHaveBeenCalled();
  });

  it('filters plugin from pre/post/render cached arrays', () => {
    const viewer = createMiniViewer();
    const plugin = makePlugin({ id: 'target' });
    viewer.use(plugin);

    expect(viewer.prePlugins).toContain(plugin);
    expect(viewer.postPlugins).toContain(plugin);
    expect(viewer.renderPlugins).toContain(plugin);

    viewer.disablePlugin('target');

    expect(viewer.prePlugins).not.toContain(plugin);
    expect(viewer.postPlugins).not.toContain(plugin);
    expect(viewer.renderPlugins).not.toContain(plugin);
  });

  it('skips disabled plugins in fixedUpdate tick arrays', () => {
    const viewer = createMiniViewer();
    const plugin = makePlugin({ id: 'ticker' });
    viewer.use(plugin);
    viewer.disablePlugin('ticker');

    viewer.fireFixedUpdatePre(0.016);
    viewer.fireFixedUpdatePost(0.016);
    viewer.fireRender(0.016);

    expect(plugin.onFixedUpdatePre).not.toHaveBeenCalled();
    expect(plugin.onFixedUpdatePost).not.toHaveBeenCalled();
    expect(plugin.onRender).not.toHaveBeenCalled();
  });

  it('cannot disable core plugins', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const viewer = createMiniViewer();
    const corePlugin = makePlugin({ id: 'drive-order', core: true });
    viewer.use(corePlugin);

    viewer.disablePlugin('drive-order');

    // Plugin should still be in cached arrays
    expect(viewer.prePlugins).toContain(corePlugin);
    expect(viewer.disabledIds.has('drive-order')).toBe(false);

    // Should still receive callbacks
    viewer.fireModelLoaded();
    expect(corePlugin.onModelLoaded).toHaveBeenCalledOnce();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('core plugin'));
    warnSpy.mockRestore();
  });

  it('disabling non-existent plugin ID is a no-op', () => {
    const viewer = createMiniViewer();
    const plugin = makePlugin({ id: 'existing' });
    viewer.use(plugin);

    // Should not throw
    expect(() => viewer.disablePlugin('non-existent')).not.toThrow();

    // Existing plugin should be unaffected
    expect(viewer.prePlugins).toContain(plugin);
  });

  it('dispose() still called for disabled plugins', () => {
    const viewer = createMiniViewer();
    const plugin = makePlugin({ id: 'disposable' });
    viewer.use(plugin);
    viewer.disablePlugin('disposable');

    viewer.fireDispose();

    expect(plugin.dispose).toHaveBeenCalledOnce();
  });

  it('skips disabled plugins in onModelCleared', () => {
    const viewer = createMiniViewer();
    const plugin = makePlugin({ id: 'clearable' });
    viewer.use(plugin);
    viewer.disablePlugin('clearable');

    viewer.fireModelCleared();

    expect(plugin.onModelCleared).not.toHaveBeenCalled();
  });

  it('skips disabled plugins in onConnectionStateChanged', () => {
    const viewer = createMiniViewer();
    const plugin = makePlugin({ id: 'connectable' });
    viewer.use(plugin);
    viewer.disablePlugin('connectable');

    viewer.fireConnectionStateChanged('Connected');

    expect(plugin.onConnectionStateChanged).not.toHaveBeenCalled();
  });
});

describe('project-plugin loading pattern', () => {
  it('setup(viewer) call pattern works correctly', () => {
    const viewer = createMiniViewer();
    const customPlugin = makePlugin({ id: 'customer-hmi' });

    // Simulate what a project-plugin.js default export does
    const setup = (v: ReturnType<typeof createMiniViewer>) => {
      v.use(customPlugin);
      v.disablePlugin('some-standard-plugin');
    };

    setup(viewer);

    expect(viewer.plugins).toContain(customPlugin);
    expect(viewer.disabledIds.has('some-standard-plugin')).toBe(true);
  });

  it('project plugin can register and then receive onModelLoaded', () => {
    const viewer = createMiniViewer();
    const projectPlugin = makePlugin({ id: 'project-special' });

    // 1. Simulate project-plugin.js setup (registers plugin)
    const setup = (v: ReturnType<typeof createMiniViewer>) => {
      v.use(projectPlugin);
    };
    setup(viewer);

    // 2. Then onModelLoaded fires (including newly registered plugin)
    viewer.fireModelLoaded();

    expect(projectPlugin.onModelLoaded).toHaveBeenCalledOnce();
  });

  it('project plugin can disable standard plugins before onModelLoaded', () => {
    const viewer = createMiniViewer();
    const standardPlugin = makePlugin({ id: 'kpi-demo' });
    const projectPlugin = makePlugin({ id: 'customer-hmi' });

    // Standard plugins registered first
    viewer.use(standardPlugin);

    // Project-plugin.js setup runs before onModelLoaded
    const setup = (v: ReturnType<typeof createMiniViewer>) => {
      v.use(projectPlugin);
      v.disablePlugin('kpi-demo');
    };
    setup(viewer);

    // Now onModelLoaded fires
    viewer.fireModelLoaded();

    expect(standardPlugin.onModelLoaded).not.toHaveBeenCalled();
    expect(projectPlugin.onModelLoaded).toHaveBeenCalledOnce();
  });
});
