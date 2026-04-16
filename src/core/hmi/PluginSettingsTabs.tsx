// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SlotRenderer helpers for plugin-registered settings-tab entries.
 *
 * `PluginSettingsTabs` renders <Tab> elements (intended to live inside MUI <Tabs>)
 * for every plugin entry. Tab `value` starts at `offset` (typically 100) so it
 * does not collide with hardcoded settings tabs (0..8).
 *
 * `PluginSettingsTabContent` renders the active plugin tab's component when
 * `value >= offset`. Returns null otherwise.
 *
 * Both components subscribe reactively to UIPluginRegistry changes via
 * useSyncExternalStore so plugin (un)registration updates the UI immediately.
 */

import { Tab } from '@mui/material';
import { useSyncExternalStore } from 'react';
import type { RVViewer } from '../rv-viewer';

export function PluginSettingsTabs({ viewer, offset }: { viewer: RVViewer; offset: number }) {
  const registry = viewer.uiRegistry;
  // Subscribe for reactive updates when plugins register/unregister.
  useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
  const tabs = registry.getSettingsTabs();
  return (
    <>
      {tabs.map((entry, i) => (
        <Tab key={entry.pluginId ?? i} label={entry.label ?? 'Tab'} value={offset + i} />
      ))}
    </>
  );
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
