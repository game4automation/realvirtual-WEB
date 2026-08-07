// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { RVViewerPlugin } from '../../src/core/rv-plugin';
import type { ModeDescriptor, ModeId } from '../../src/core/rv-mode-manager';
import type { PluginOrigin, RVViewer } from '../../src/core/rv-viewer';
import { UIPluginRegistry } from '../../src/core/rv-ui-registry';

type Listener = (payload: unknown) => void;

export interface FeatureMatrixViewerHarness {
  viewer: RVViewer;
  addPlugin(plugin: RVViewerPlugin, origin?: PluginOrigin): void;
  removePlugin(id: string): void;
  disablePlugin(id: string): void;
  enablePlugin(id: string): void;
  setPluginUserEnabled(id: string, enabled: boolean): void;
  clearPluginUserOverrides(): void;
  setMode(id: ModeId): void;
  registerMode(descriptor: ModeDescriptor): void;
  eventListenerCount(event: string): number;
  modeListenerCount(): number;
  readonly userToggleCalls: Array<{ id: string; enabled: boolean }>;
}

export function createFeatureMatrixViewerHarness(
  initialModes: ModeDescriptor[] = [{ id: 'hmi', label: 'HMI', order: 10 }],
  initialMode: ModeId | null = initialModes[0]?.id ?? null,
): FeatureMatrixViewerHarness {
  const plugins: RVViewerPlugin[] = [];
  const origins = new Map<string, PluginOrigin>();
  const disabled = new Set<string>();
  const userDisabled = new Set<string>();
  const userToggleCalls: Array<{ id: string; enabled: boolean }> = [];
  const descriptors = new Map(initialModes.map((mode) => [mode.id, mode]));
  const eventListeners = new Map<string, Set<Listener>>();
  const modeListeners = new Set<() => void>();
  const uiRegistry = new UIPluginRegistry();
  let activeMode = initialMode;
  let modeVersion = 0;

  const emit = (event: string, payload: unknown) => {
    for (const listener of eventListeners.get(event) ?? []) listener(payload);
  };
  const notifyModes = () => {
    modeVersion++;
    for (const listener of modeListeners) listener();
  };

  const modes = {
    get activeMode() { return activeMode; },
    list: () => [...descriptors.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100)),
    subscribe: (listener: () => void) => {
      modeListeners.add(listener);
      return () => { modeListeners.delete(listener); };
    },
    getSnapshot: () => modeVersion,
  };

  const viewer = {
    uiRegistry,
    modes,
    getPlugins: () => plugins.slice(),
    getPlugin: (id: string) => plugins.find((plugin) => plugin.id === id),
    getPluginOrigin: (id: string) => origins.get(id) ?? 'unknown',
    isPluginDisabled: (id: string) => disabled.has(id),
    isPluginUserDisabled: (id: string) => userDisabled.has(id),
    getPluginUserDisabledIds: () => new Set(userDisabled),
    setPluginUserEnabled: (id: string, enabled: boolean) => {
      if (!plugins.some((plugin) => plugin.id === id)) return;
      if (enabled) {
        if (!userDisabled.delete(id)) return;
        disabled.delete(id);
        userToggleCalls.push({ id, enabled });
        emit('plugins-changed', { kind: 'user-enabled', id });
      } else {
        if (userDisabled.has(id)) return;
        userDisabled.add(id);
        disabled.add(id);
        userToggleCalls.push({ id, enabled });
        emit('plugins-changed', { kind: 'user-disabled', id });
      }
    },
    clearPluginUserOverrides: () => {
      for (const id of [...userDisabled]) {
        userDisabled.delete(id);
        disabled.delete(id);
        userToggleCalls.push({ id, enabled: true });
        emit('plugins-changed', { kind: 'user-enabled', id });
      }
    },
    on: (event: string, listener: Listener) => {
      let listeners = eventListeners.get(event);
      if (!listeners) {
        listeners = new Set();
        eventListeners.set(event, listeners);
      }
      listeners.add(listener);
      return () => { listeners!.delete(listener); };
    },
  } as unknown as RVViewer;

  return {
    viewer,
    addPlugin(plugin, origin) {
      if (plugins.some((candidate) => candidate.id === plugin.id)) return;
      plugins.push(plugin);
      if (origin) origins.set(plugin.id, origin);
      if (plugin.slots?.length) uiRegistry.register(plugin);
      emit('plugins-changed', { kind: 'registered', id: plugin.id });
    },
    removePlugin(id) {
      const index = plugins.findIndex((plugin) => plugin.id === id);
      if (index < 0) return;
      plugins.splice(index, 1);
      origins.delete(id);
      disabled.delete(id);
      userDisabled.delete(id);
      uiRegistry.unregister(id);
      emit('plugins-changed', { kind: 'removed', id });
    },
    disablePlugin(id) {
      if (disabled.has(id)) return;
      disabled.add(id);
      emit('plugins-changed', { kind: 'disabled', id });
    },
    enablePlugin(id) {
      if (!disabled.delete(id)) return;
      emit('plugins-changed', { kind: 'enabled', id });
    },
    setPluginUserEnabled(id, enabled) {
      viewer.setPluginUserEnabled(id, enabled);
    },
    clearPluginUserOverrides() {
      viewer.clearPluginUserOverrides();
    },
    setMode(id) {
      const from = activeMode;
      activeMode = id;
      notifyModes();
      emit('mode-changed', { from, to: id });
    },
    registerMode(descriptor) {
      descriptors.set(descriptor.id, descriptor);
      notifyModes();
    },
    eventListenerCount(event) {
      return eventListeners.get(event)?.size ?? 0;
    },
    modeListenerCount() {
      return modeListeners.size;
    },
    userToggleCalls,
  };
}
