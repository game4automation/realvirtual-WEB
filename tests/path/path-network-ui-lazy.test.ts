// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PathNetworkUiPlugin, setPathNetworkInteractionLoaderForTests } from '../../src/plugins/path-network/path-network-ui-plugin';
import { PATH_LIBRARY_CATALOG_KEY } from '../../src/plugins/path-network/path-network-ui-model';

type Module = typeof import('../../src/plugins/path-network/path-network-interaction');
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const plugins: PathNetworkUiPlugin[] = [];
afterEach(() => {
  for (const plugin of plugins.splice(0)) plugin.dispose();
  setPathNetworkInteractionLoaderForTests(null);
  vi.restoreAllMocks();
});

function setup() {
  const pending = deferred<Module>();
  setPathNetworkInteractionLoaderForTests(() => pending.promise);
  const dispose = vi.fn();
  const constructed = vi.fn();
  const provider = {};
  class Interaction {
    boxSelectProvider = provider;
    dispose = dispose;
    constructor(...args: unknown[]) { constructed(...args); }
  }
  const module = { PathNetworkInteraction: Interaction } as unknown as Module;
  const planner = {
    store: { addCatalogDirect: vi.fn(), removeCatalog: vi.fn() },
    setPathBlockEntryHandler: vi.fn(() => vi.fn()),
    registerBoxSelectHitProvider: vi.fn(() => vi.fn()),
  };
  const viz = {};
  const viewer = {
    modes: { activeMode: 'hmi' },
    getPlugin: (id: string) => id === 'path-visualizer' ? viz : id === 'layout-planner' ? planner : undefined,
    on: vi.fn(() => vi.fn()),
  };
  const plugin = new PathNetworkUiPlugin();
  plugins.push(plugin);
  return { pending, module, plugin, viewer, planner, viz, provider, constructed, dispose };
}

describe('plan-2036 lazy path network interaction', () => {
  it('publishes readiness once, catches up authoring/model load, and notifies on dispose', async () => {
    const r = setup();
    expect(await r.plugin.whenInteractionReady()).toBeNull();
    const listener = vi.fn();
    const off = r.plugin.subscribeInteraction(listener);
    r.plugin.init(r.viewer as never);
    const ready = r.plugin.whenInteractionReady();
    expect(r.plugin.interaction).toBeNull();
    r.viewer.modes.activeMode = 'planner';
    r.plugin.onModelLoaded();
    r.plugin.onRender();
    r.plugin.onModelCleared();
    expect(r.planner.store.addCatalogDirect).not.toHaveBeenCalled();
    r.pending.resolve(r.module);
    const ui = await ready;
    expect(ui).not.toBeNull();
    expect(r.plugin.interaction).toBe(ui);
    expect(await r.plugin.whenInteractionReady()).toBe(ui);
    expect(r.constructed).toHaveBeenCalledExactlyOnceWith(r.viewer, r.viz);
    expect(r.planner.store.addCatalogDirect).toHaveBeenCalledExactlyOnceWith(PATH_LIBRARY_CATALOG_KEY, expect.objectContaining({ name: 'Path Network' }));
    expect(r.planner.setPathBlockEntryHandler).toHaveBeenCalledTimes(1);
    expect(r.planner.registerBoxSelectHitProvider).toHaveBeenCalledExactlyOnceWith(r.provider);
    expect(listener).toHaveBeenCalledTimes(1);
    r.plugin.dispose();
    expect(r.dispose).toHaveBeenCalledTimes(1);
    expect(r.plugin.interaction).toBeNull();
    expect(await r.plugin.whenInteractionReady()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
    off();
  });

  it('settles pending readiness immediately on dispose and ignores the late module', async () => {
    const r = setup();
    r.plugin.init(r.viewer as never);
    const ready = r.plugin.whenInteractionReady();
    r.plugin.dispose();
    expect(await ready).toBeNull();
    r.pending.resolve(r.module);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(r.constructed).not.toHaveBeenCalled();
    expect(r.plugin.interaction).toBeNull();
    expect(r.planner.store.addCatalogDirect).not.toHaveBeenCalled();
    expect(r.planner.registerBoxSelectHitProvider).not.toHaveBeenCalled();
  });

  it('a stale completion cannot settle or populate a new initialization', async () => {
    const r = setup();
    r.plugin.init(r.viewer as never);
    const oldReady = r.plugin.whenInteractionReady();
    r.plugin.dispose();
    expect(await oldReady).toBeNull();
    const next = deferred<Module>();
    setPathNetworkInteractionLoaderForTests(() => next.promise);
    r.plugin.init(r.viewer as never);
    const ready = r.plugin.whenInteractionReady();
    const settled = vi.fn();
    void ready.then(settled);
    r.pending.resolve(r.module);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(r.constructed).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    next.resolve(r.module);
    expect(await ready).toBe(r.plugin.interaction);
    expect(r.constructed).toHaveBeenCalledTimes(1);
  });

  it('warns on import failure and resolves readiness with null', async () => {
    const r = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const listener = vi.fn();
    r.plugin.subscribeInteraction(listener);
    r.plugin.init(r.viewer as never);
    const error = new Error('chunk unavailable');
    r.pending.reject(error);
    expect(await r.plugin.whenInteractionReady()).toBeNull();
    expect(r.plugin.interaction).toBeNull();
    expect(warn).toHaveBeenCalledWith('Failed to load path network interaction', error);
    expect(listener).not.toHaveBeenCalled();
  });

  it('does not load without a visualizer', async () => {
    const r = setup();
    const loader = vi.fn(() => r.pending.promise);
    setPathNetworkInteractionLoaderForTests(loader);
    r.plugin.init({ getPlugin: () => undefined } as never);
    expect(await r.plugin.whenInteractionReady()).toBeNull();
    expect(loader).not.toHaveBeenCalled();
  });
});
