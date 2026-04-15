// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Plugin Lifecycle Tests
 *
 * Validates plugin registration, lifecycle dispatch, retroactive onModelLoaded,
 * duplicate ID rejection, exception isolation, and Pre/Post ordering.
 */
import { describe, it, expect } from 'vitest';

// Minimal mock of the RVViewer plugin system (extracted logic)
class PluginHost {
  plugins: any[] = [];
  prePlugins: any[] = [];
  postPlugins: any[] = [];
  renderPlugins: any[] = [];
  private _lastLoadResult: any = null;
  drives: any[] = [];

  use(plugin: any): this {
    if (this.plugins.some((p: any) => p.id === plugin.id)) return this;
    this.plugins.push(plugin);
    const insertSorted = (list: any[], p: any) => {
      list.push(p);
      list.sort((a: any, b: any) => (a.order ?? 100) - (b.order ?? 100));
    };
    if (plugin.onFixedUpdatePre) insertSorted(this.prePlugins, plugin);
    if (plugin.onFixedUpdatePost) insertSorted(this.postPlugins, plugin);
    if (plugin.onRender) insertSorted(this.renderPlugins, plugin);
    if (this.drives.length > 0 && this._lastLoadResult && plugin.onModelLoaded) {
      plugin.onModelLoaded(this._lastLoadResult, this);
    }
    return this;
  }

  simulateLoad(result: any) {
    this._lastLoadResult = result;
    this.drives = [{ name: 'TestDrive' }];
    for (const p of this.plugins) {
      if (p.onModelLoaded) p.onModelLoaded(result, this);
    }
  }

  fixedUpdate(dt: number) {
    for (const p of this.prePlugins) {
      try { p.onFixedUpdatePre!(dt); } catch (_e) { /* isolated */ }
    }
    for (const p of this.postPlugins) {
      try { p.onFixedUpdatePost!(dt); } catch (_e) { /* isolated */ }
    }
  }

  render(frameDt: number) {
    for (const p of this.renderPlugins) {
      try { p.onRender!(frameDt); } catch (_e) { /* isolated */ }
    }
  }
}

describe('Plugin Lifecycle', () => {
  it('calls onModelLoaded for registered plugins', () => {
    const host = new PluginHost();
    const calls: string[] = [];
    host.use({ id: 'a', onModelLoaded: () => calls.push('a') });
    host.use({ id: 'b', onModelLoaded: () => calls.push('b') });
    host.simulateLoad({ registry: null });
    expect(calls).toEqual(['a', 'b']);
  });

  it('retroactive onModelLoaded when plugin registered after load', () => {
    const host = new PluginHost();
    host.simulateLoad({ registry: null });
    const calls: string[] = [];
    host.use({ id: 'late', onModelLoaded: () => calls.push('late') });
    expect(calls).toEqual(['late']);
  });

  it('duplicate plugin ID is rejected', () => {
    const host = new PluginHost();
    host.use({ id: 'dup' });
    host.use({ id: 'dup' });
    expect(host.plugins.length).toBe(1);
  });

  it('exception in onFixedUpdatePre does not break other plugins', () => {
    const host = new PluginHost();
    const calls: string[] = [];
    host.use({ id: 'bad', onFixedUpdatePre: () => { throw new Error('boom'); } });
    host.use({ id: 'good', onFixedUpdatePost: () => { calls.push('good'); } });
    host.fixedUpdate(1 / 60);
    expect(calls).toEqual(['good']);
  });

  it('Pre plugins run before Post plugins', () => {
    const host = new PluginHost();
    const order: string[] = [];
    host.use({ id: 'pre', onFixedUpdatePre: () => order.push('pre') });
    host.use({ id: 'post', onFixedUpdatePost: () => order.push('post') });
    host.fixedUpdate(1 / 60);
    expect(order).toEqual(['pre', 'post']);
  });

  it('plugins sorted by order within phase', () => {
    const host = new PluginHost();
    const order: string[] = [];
    host.use({ id: 'b', order: 200, onFixedUpdatePre: () => order.push('b') });
    host.use({ id: 'a', order: 10, onFixedUpdatePre: () => order.push('a') });
    host.fixedUpdate(1 / 60);
    expect(order).toEqual(['a', 'b']);
  });

  it('render plugins are called', () => {
    const host = new PluginHost();
    const calls: number[] = [];
    host.use({ id: 'r', onRender: (dt: number) => calls.push(dt) });
    host.render(0.016);
    expect(calls).toEqual([0.016]);
  });

  it('exception in onRender does not break other render plugins', () => {
    const host = new PluginHost();
    const calls: string[] = [];
    host.use({ id: 'bad-r', onRender: () => { throw new Error('render-boom'); } });
    host.use({ id: 'good-r', onRender: () => calls.push('ok') });
    host.render(0.016);
    expect(calls).toEqual(['ok']);
  });
});
