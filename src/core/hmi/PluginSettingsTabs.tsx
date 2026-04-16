// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SlotRenderer helpers for plugin-registered settings-tab entries.
 *
 * `usePluginSettingsTabs` is a hook that returns the reactive list of all
 * registered settings-tab entries. Consumers must render <Tab> elements
 * INLINE as direct children of MUI <Tabs> — wrapping Tabs inside a custom
 * component or Fragment prevents MUI from enumerating them (MUI Tabs uses
 * React.Children.map on direct children only).
 *
 * `PluginSettingsTabContent` renders the active plugin tab's component when
 * `value >= offset`. Returns null otherwise.
 *
 * Both subscribe reactively to UIPluginRegistry via useSyncExternalStore so
 * plugin (un)registration updates the UI immediately.
 */

import { useSyncExternalStore } from 'react';
import type { RVViewer } from '../rv-viewer';
import type { UISlotEntry } from '../rv-ui-plugin';

/**
 * Hook: returns reactive list of registered settings-tab entries.
 * Callers should render <Tab> elements inline as direct children of <Tabs>.
 */
export function usePluginSettingsTabs(viewer: RVViewer): UISlotEntry[] {
  const registry = viewer.uiRegistry;
  useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
  return registry.getSettingsTabs();
}

export function PluginSettingsTabContent({
  viewer, value, offset,
}: { viewer: RVViewer; value: number; offset: number }) {
  const registry = viewer.uiRegistry;
  useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
  const tabs = registry.getSettingsTabs();
  const idx = value - offset;
  if (idx < 0 || idx >= tabs.length) return null;
  const entry = tabs[idx];
  const Component = entry.component;
  return <Component viewer={viewer} />;
}
