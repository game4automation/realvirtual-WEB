// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Shared layout constants — kept dependency-free to avoid circular imports. */

/** Height of the bottom bar area (search + padding) for layout calculations. */
export const BOTTOM_BAR_HEIGHT = 52;

/** Top position of left-side panels (below TopBar). */
export const LEFT_PANEL_TOP = 56;

/** Left margin of left-side panels on desktop. */
export const LEFT_PANEL_LEFT = 8;

/** Bottom margin of left-side panels on desktop. */
export const LEFT_PANEL_BOTTOM = 8;

/** Z-index for left-side panels (desktop). */
export const LEFT_PANEL_ZINDEX = 1200;

/**
 * Z-index for left-side panels on mobile.
 * Higher than TopBar buttons (9001), BottomBar (1201), ButtonPanel/LogoBadge (1210),
 * so mobile panels fully overlay the entire viewport. The panel header's own close
 * button keeps it dismissable.
 */
export const LEFT_PANEL_MOBILE_ZINDEX = 10000;

/** Width of the Settings panel. */
export const SETTINGS_PANEL_WIDTH = 540;

/** Width of the PropertyInspector panel. */
export const INSPECTOR_PANEL_WIDTH = 320;

/** Width of the Machine Control panel. */
export const MACHINE_PANEL_WIDTH = 370;

/** Width of the Layout Planner library panel. */
export const LAYOUT_PANEL_WIDTH = 340;

/** Width of the Order Manager panel. */
export const ORDER_PANEL_WIDTH = 320;
