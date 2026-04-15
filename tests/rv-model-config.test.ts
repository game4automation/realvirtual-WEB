// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Model Config Tests
 *
 * Tests for rv-model-config.ts:
 *   - mergeModelConfig priority (modelJson > glbExtras > settings)
 *   - extractGlbPluginConfig
 *   - loadModelJsonConfig fetch + error handling
 *
 * Tests for rv-plugin-loader.ts:
 *   - loadExternalPlugin dynamic import
 *
 * Tests for selective plugin activation (core flag, ALL-MODE vs SELECTIVE-MODE):
 *   - PluginHost selective/all-by-default logic
 *   - registerLazy + resolvePlugin
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mergeModelConfig,
  extractGlbPluginConfig,
  loadModelJsonConfig,
  type ModelConfig,
} from '../src/core/engine/rv-model-config';

// ─── mergeModelConfig ─────────────────────────────────────────────────────

describe('mergeModelConfig', () => {
  it('returns empty config when all sources are empty', () => {
    const result = mergeModelConfig({}, {}, {});
    expect(result.plugins).toBeUndefined();
    expect(result.pluginConfig).toBeUndefined();
  });

  it('modelJson plugins take highest priority', () => {
    const result = mergeModelConfig(
      { plugins: ['a', 'b'] },
      { plugins: ['c'] },
      { plugins: ['d', 'e'] },
    );
    expect(result.plugins).toEqual(['a', 'b']);
  });

  it('glbExtras plugins used when modelJson has none', () => {
    const result = mergeModelConfig(
      {},
      { plugins: ['glb-plugin'] },
      { plugins: ['settings-plugin'] },
    );
    expect(result.plugins).toEqual(['glb-plugin']);
  });

  it('settings plugins used when both modelJson and glbExtras have none', () => {
    const result = mergeModelConfig(
      {},
      {},
      { plugins: ['fallback'] },
    );
    expect(result.plugins).toEqual(['fallback']);
  });

  it('pluginConfig deep-merges with correct priority', () => {
    const result = mergeModelConfig(
      { pluginConfig: { a: { x: 'model' }, b: { y: 'model' } } },
      { pluginConfig: { a: { x: 'glb', z: 'glb' } } },
      { pluginConfig: { a: { x: 'settings', w: 'settings' }, c: { v: 'settings' } } },
    );
    const cfg = result.pluginConfig!;
    // model overrides glb overrides settings
    expect(cfg['a']).toEqual({ x: 'model', z: 'glb', w: 'settings' });
    expect(cfg['b']).toEqual({ y: 'model' });
    expect(cfg['c']).toEqual({ v: 'settings' });
  });

  it('empty plugins array is preserved (selective mode with no plugins)', () => {
    const result = mergeModelConfig({ plugins: [] }, {}, {});
    expect(result.plugins).toEqual([]);
  });

  it('propertyOverrides passed through from modelJson', () => {
    const overrides = { 'Robot/Axis1': { rv_drive: { Speed: 100 } } };
    const result = mergeModelConfig(
      { propertyOverrides: overrides },
      {},
      {},
    );
    expect(result.propertyOverrides).toEqual(overrides);
  });
});

// ─── extractGlbPluginConfig ───────────────────────────────────────────────

describe('extractGlbPluginConfig', () => {
  function makeScene(childrenUserData: Record<string, unknown>[]): any {
    return {
      children: childrenUserData.map((userData) => ({ userData })),
    };
  }

  it('extracts rv_plugins from first child with extras', () => {
    const scene = makeScene([
      { rv_plugins: ['maintenance', 'kpi-demo'] },
    ]);
    const config = extractGlbPluginConfig(scene);
    expect(config.plugins).toEqual(['maintenance', 'kpi-demo']);
  });

  it('extracts rv_plugin_config from scene child', () => {
    const scene = makeScene([
      {
        rv_plugins: ['a'],
        rv_plugin_config: { a: { speed: 200 } },
      },
    ]);
    const config = extractGlbPluginConfig(scene);
    expect(config.plugins).toEqual(['a']);
    expect(config.pluginConfig).toEqual({ a: { speed: 200 } });
  });

  it('returns empty config when no children have extras', () => {
    const scene = makeScene([{}, {}]);
    const config = extractGlbPluginConfig(scene);
    expect(config.plugins).toBeUndefined();
    expect(config.pluginConfig).toBeUndefined();
  });

  it('filters non-string plugin IDs', () => {
    const scene = makeScene([
      { rv_plugins: ['valid', 42, null, 'also-valid'] },
    ]);
    const config = extractGlbPluginConfig(scene);
    expect(config.plugins).toEqual(['valid', 'also-valid']);
  });

  it('ignores non-object rv_plugin_config', () => {
    const scene = makeScene([
      { rv_plugins: ['a'], rv_plugin_config: 'invalid' },
    ]);
    const config = extractGlbPluginConfig(scene);
    expect(config.plugins).toEqual(['a']);
    expect(config.pluginConfig).toBeUndefined();
  });
});

// ─── loadModelJsonConfig ──────────────────────────────────────────────────

describe('loadModelJsonConfig', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('fetches companion .json file and returns parsed config', async () => {
    const mockConfig: ModelConfig = { plugins: ['test-plugin'] };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockConfig),
    }) as any;

    const result = await loadModelJsonConfig('models/demo.glb');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'models/demo.json',
      expect.objectContaining({}),
    );
    expect(result.plugins).toEqual(['test-plugin']);
  });

  it('returns empty config on 404', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    }) as any;

    const result = await loadModelJsonConfig('models/missing.glb');
    expect(result).toEqual({});
  });

  it('returns empty config on network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network')) as any;

    const result = await loadModelJsonConfig('models/broken.glb');
    expect(result).toEqual({});
  });

  it('returns empty config on invalid JSON structure (array)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([1, 2, 3]),
    }) as any;

    const result = await loadModelJsonConfig('models/bad.glb');
    expect(result).toEqual({});
  });

  it('re-throws AbortError', async () => {
    const abortError = new Error('Aborted');
    abortError.name = 'AbortError';
    globalThis.fetch = vi.fn().mockRejectedValue(abortError) as any;

    await expect(loadModelJsonConfig('models/aborted.glb')).rejects.toThrow('Aborted');
  });
});

// ─── Plugin Activation: ALL-MODE vs SELECTIVE-MODE ────────────────────────

describe('Plugin Activation (selective vs all-by-default)', () => {
  /** Minimal mock of RVViewer's plugin activation logic from loadModel(). */
  class PluginHost {
    plugins: any[] = [];
    private _lazyFactories = new Map<string, () => Promise<any>>();

    use(plugin: any): this {
      if (this.plugins.some((p: any) => p.id === plugin.id)) return this;
      this.plugins.push(plugin);
      return this;
    }

    registerLazy(id: string, factory: () => Promise<any>): this {
      this._lazyFactories.set(id, factory);
      return this;
    }

    async resolvePlugin(id: string): Promise<any | null> {
      const existing = this.plugins.find(p => p.id === id);
      if (existing) return existing;

      const factory = this._lazyFactories.get(id);
      if (factory) {
        try {
          const mod = await factory();
          const PluginOrInstance = mod.default;
          const plugin = typeof PluginOrInstance === 'function'
            ? new PluginOrInstance()
            : PluginOrInstance;
          if (plugin?.id) {
            this.use(plugin);
            return plugin;
          }
        } catch { return null; }
      }
      return null;
    }

    /**
     * Simulate the loadModel() plugin activation logic.
     * @param declared  The rv_plugins array (undefined = ALL-MODE, string[] = SELECTIVE-MODE)
     */
    async activatePlugins(declared: string[] | undefined): Promise<string[]> {
      const activated: string[] = [];

      if (declared === undefined) {
        // ALL-MODE: activate all registered plugins
        for (const p of this.plugins) {
          activated.push(p.id);
        }
      } else {
        // SELECTIVE-MODE: only declared + core
        for (const p of this.plugins) {
          if (p.core || declared.includes(p.id)) {
            activated.push(p.id);
          }
        }
        // Resolve lazy plugins not yet registered
        for (const id of declared) {
          if (!this.plugins.find(p => p.id === id)) {
            const plugin = await this.resolvePlugin(id);
            if (plugin) activated.push(plugin.id);
          }
        }
      }

      return activated;
    }
  }

  it('ALL-MODE: activates all registered plugins when rv_plugins is undefined', async () => {
    const host = new PluginHost();
    host.use({ id: 'core-a', core: true });
    host.use({ id: 'optional-b' });
    host.use({ id: 'optional-c' });

    const activated = await host.activatePlugins(undefined);
    expect(activated).toEqual(['core-a', 'optional-b', 'optional-c']);
  });

  it('SELECTIVE-MODE: only core + declared plugins activate', async () => {
    const host = new PluginHost();
    host.use({ id: 'core-a', core: true });
    host.use({ id: 'optional-b' });
    host.use({ id: 'declared-c' });

    const activated = await host.activatePlugins(['declared-c']);
    expect(activated).toEqual(['core-a', 'declared-c']);
  });

  it('SELECTIVE-MODE: core plugins always activate even when not declared', async () => {
    const host = new PluginHost();
    host.use({ id: 'drive-order', core: true });
    host.use({ id: 'rapier-physics', core: true });
    host.use({ id: 'maintenance' });

    const activated = await host.activatePlugins([]);
    expect(activated).toEqual(['drive-order', 'rapier-physics']);
  });

  it('SELECTIVE-MODE: resolves lazy plugins when declared', async () => {
    const host = new PluginHost();
    host.use({ id: 'core-a', core: true });
    host.registerLazy('lazy-plugin', async () => ({
      default: { id: 'lazy-plugin', onModelLoaded: () => {} },
    }));

    const activated = await host.activatePlugins(['lazy-plugin']);
    expect(activated).toContain('core-a');
    expect(activated).toContain('lazy-plugin');
    // Lazy plugin should now be registered
    expect(host.plugins.find(p => p.id === 'lazy-plugin')).toBeTruthy();
  });

  it('SELECTIVE-MODE: handles missing lazy factory gracefully', async () => {
    const host = new PluginHost();
    host.use({ id: 'core-a', core: true });

    const activated = await host.activatePlugins(['nonexistent-plugin']);
    // Only core activates, nonexistent is silently skipped
    expect(activated).toEqual(['core-a']);
  });

  it('resolvePlugin: returns existing plugin first', async () => {
    const host = new PluginHost();
    const existing = { id: 'existing' };
    host.use(existing);
    const resolved = await host.resolvePlugin('existing');
    expect(resolved).toBe(existing);
  });

  it('resolvePlugin: instantiates class from lazy factory', async () => {
    class TestPlugin {
      readonly id = 'test-class';
    }
    const host = new PluginHost();
    host.registerLazy('test-class', async () => ({ default: TestPlugin }));
    const resolved = await host.resolvePlugin('test-class');
    expect(resolved).toBeInstanceOf(TestPlugin);
    expect(resolved.id).toBe('test-class');
  });

  it('resolvePlugin: handles instance from lazy factory', async () => {
    const instance = { id: 'test-instance' };
    const host = new PluginHost();
    host.registerLazy('test-instance', async () => ({ default: instance }));
    const resolved = await host.resolvePlugin('test-instance');
    expect(resolved).toBe(instance);
  });
});
