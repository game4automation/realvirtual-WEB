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
 *
 * Visibility (plan-387): both functions filter through the SAME helper, so the
 * tab strip and the tab content always see the identical list — the content
 * renderer indexes into it by `value - offset`, so any divergence would show the
 * wrong panel. Entries without a `visibilityId` are always visible, matching
 * SlotRenderer's invariant; only an entry carrying both an id and a rule (which
 * is what `UIPluginRegistry.register` compiles from a plugin's `modes`) can be
 * hidden. Before this, settings-tab entries were the one slot type that ignored
 * visibility rules entirely.
 */

import { useSyncExternalStore } from 'react';
import type { RVViewer } from '../rv-viewer';
import type { UISlotEntry } from '../rv-ui-plugin';
import { useActiveContexts, isUIElementVisible, registerUIElement } from './ui-context-store';

/** Shared filter — see the visibility note in the module doc. */
function visibleTabs(tabs: UISlotEntry[], contexts: ReadonlySet<string>): UISlotEntry[] {
  return tabs.filter((entry) => {
    if (entry.visibilityId && entry.visibilityRule) {
      registerUIElement(entry.visibilityId, entry.visibilityRule);
    }
    if (!entry.visibilityId) return true;
    return isUIElementVisible(entry.visibilityId, contexts);
  });
}

/**
 * Hook: returns reactive list of registered settings-tab entries.
 * Callers should render <Tab> elements inline as direct children of <Tabs>.
 */
export function usePluginSettingsTabs(viewer: RVViewer): UISlotEntry[] {
  const registry = viewer.uiRegistry;
  useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
  const contexts = useActiveContexts();
  return visibleTabs(registry.getSettingsTabs(), contexts);
}

export function PluginSettingsTabContent({
  viewer, value, offset,
}: { viewer: RVViewer; value: number; offset: number }) {
  const registry = viewer.uiRegistry;
  useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
  const contexts = useActiveContexts();
  const tabs = visibleTabs(registry.getSettingsTabs(), contexts);
  const idx = value - offset;
  if (idx < 0 || idx >= tabs.length) return null;
  const entry = tabs[idx];
  const Component = entry.component;
  return <Component viewer={viewer} />;
}
