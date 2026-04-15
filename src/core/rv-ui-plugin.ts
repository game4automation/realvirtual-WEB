// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * UI Slot types for the HMI layout.
 *
 * Plugins register React components into named layout slots
 * (kpi-bar, button-group, search-bar, messages, views, settings-tab)
 * via the `slots` property on RVViewerPlugin.
 *
 * The HMI shell renders all registered components per slot.
 */

import type { ComponentType } from 'react';
import type { RVViewer } from './rv-viewer';
import type { UIVisibilityRule } from './hmi/ui-context-store';

/** Available slots in the HMI layout. */
export type UISlot =
  | 'kpi-bar'          // Top: KPI cards horizontal
  | 'button-group'     // Left: Navigation buttons vertical
  | 'search-bar'       // Bottom center: Search field
  | 'messages'         // Right: Notification/status tiles vertical
  | 'views'            // Bottom right: Expandable panels (charts, tables)
  | 'settings-tab'     // Settings dialog: Tab registration
  | 'toolbar-button'   // TopBar: Additional toolbar buttons (next to hierarchy/settings)
  | 'overlay';         // Full-screen overlay panels (left panels, modals, etc.)

/** Props passed to every UI slot component. */
export interface UISlotProps {
  viewer: RVViewer;
}

export interface UISlotEntry {
  /** Owning plugin ID — auto-stamped by UIPluginRegistry.register(). */
  pluginId?: string;
  /** Which slot this component belongs to. */
  slot: UISlot;
  /** React component rendered into the slot. */
  component: ComponentType<UISlotProps>;
  /** Sort order within the slot (lower = further left/top). Default: 100. */
  order?: number;
  /** For settings-tab: tab label text. */
  label?: string;
  /** Optional visibility element ID for context-aware hiding. */
  visibilityId?: string;
  /** Optional visibility rule — when provided, the entry is hidden/shown per active contexts.
   *  Entries WITHOUT this field are always visible (invariant). */
  visibilityRule?: UIVisibilityRule;
}
