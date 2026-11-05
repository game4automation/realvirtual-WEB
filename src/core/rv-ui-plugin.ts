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
  | 'activity-bar'     // Left ACTIVITY BAR: a button that opens a left-docked window.
                       //   Convention: if a plugin opens a left window, register here and
                       //   dock via leftPanelManager.toggle(id, width); the window renders
                       //   edge-to-edge via LeftPanel. For top-bar ACTIONS use toolbar-button*.
  | 'button-group'     // Floating left TOOL toolbar: contextual mode tools (planner
                       //   grid/snap/delete, measurement, …). Floats over the 3D view,
                       //   shifts to clear the activity bar + open window. NOT window-openers.
  | 'search-bar'       // Bottom center: Search field
  | 'messages'         // Right: Notification/status tiles vertical
  | 'views'            // Bottom right: Expandable panels (charts, tables)
  | 'settings-tab'     // Settings dialog: Tab registration
  | 'toolbar-button-leading' // TopBar: Buttons rendered before Hierarchy (primary sim controls)
  | 'toolbar-status' // TopBar: own status pills right of the sim controls (each entry renders its own pill)
  | 'toolbar-button'   // TopBar: Additional top-bar action buttons (toggles/modals, not left windows)
  | 'toolbar-button-center'  // TopBar: Center region toolbars (reserved for future tools)
  | 'toolbar-button-trailing' // TopBar: Right region toolbars (before the camera/view group)
  | 'view-overflow'    // Bottom-right view cluster: a ROW in its "⋯" overflow menu. The
                       //   component renders an `ActionMenuRow` (action-group.tsx) directly —
                       //   no wrapper element — and closes the menu via the row itself.
  | 'usd-menu'         // Activity-bar USD menu: a visible `SlotMenuRow` (slot-menu-row.tsx)
                       //   without a wrapper; the host closes enabled rows via data-rv-dropdown-item.
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
  /** For activity-bar: 'bottom' renders the entry in the lower group (Problems/Multiuser). Default: 'top'. */
  placement?: 'top' | 'bottom';
  /** For settings-tab: tab label text. */
  label?: string;
  /** Optional visibility element ID for context-aware hiding. */
  visibilityId?: string;
  /** Optional visibility rule — when provided, the entry is hidden/shown per active contexts.
   *  Entries WITHOUT this field are always visible (invariant). */
  visibilityRule?: UIVisibilityRule;
  /**
   * button-group only (plan-2010): the toolbar SECTION this entry belongs to.
   *
   * Well-known ids are `TOOL_GROUP` in `hmi/button-panel-sections.ts` (`editing`,
   * `model`, `analysis`, `view`) and render in that fixed rank order, whatever
   * the entries' `order` values are — so a group sits at the same place in every
   * mode. Any other string forms its own section after the well-known ones.
   * Entries WITHOUT a group render first, in today's order (third-party plugins
   * and the HMI operator buttons keep their place). `order` still sorts entries
   * WITHIN a section. A divider separates two non-empty sections.
   */
  group?: string;
  /**
   * @internal Stable identity of this declaration — auto-stamped by
   * `UIPluginRegistry.register()` as `${pluginId}:${slot}:${declarationIndex}`
   * (anonymous entries: `anon:${seq}:${declarationIndex}`). Used as the React
   * key of the rendered slot component, so an entry keeps its state when another
   * plugin registers entries that sort in before it. Never set it yourself.
   */
  slotKey?: string;
}
