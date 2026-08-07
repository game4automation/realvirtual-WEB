// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Shared layout constants — kept dependency-free to avoid circular imports. */

/** Height of the bottom bar area (search + padding) for layout calculations. */
export const BOTTOM_BAR_HEIGHT = 52;

/** Width of the left activity bar (VSCode-style vertical icon strip).
 *  Sized to match the floating overlay ButtonPanel (medium IconButtons, 38px,
 *  inside a 4px-padded Paper → 46px) so the outer and overlay toolbars align. */
export const ACTIVITY_BAR_WIDTH = 46;

/** Height of the optional top title bar (shown only when branding.titleBar is set).
 *  Top-anchored chrome and the 3D canvas are pushed down by this amount when active. */
export const TITLE_BAR_HEIGHT = 40;

/** Small top gap for floating viewport clusters (mode/sim switcher, camera/view
 *  controls, KPI bar). There is no top app bar anymore — they float at the top. */
export const FLOATING_TOP_MARGIN = 8;

/** Top of left-docked windows — flush to the very top (the activity bar and
 *  docked windows run full height now that the top app bar is gone). */
export const LEFT_PANEL_TOP = 0;

/** Left of left-docked windows — flush against the activity bar (edge-to-edge). */
export const LEFT_PANEL_LEFT = ACTIVITY_BAR_WIDTH;

/** Bottom of left-docked windows — flush to the viewport bottom (edge-to-edge). */
export const LEFT_PANEL_BOTTOM = 0;

/** Z-index for left-side panels (desktop). */
export const LEFT_PANEL_ZINDEX = 1200;

/**
 * Z-index for left-side panels on mobile.
 * Higher than TopBar buttons (9001), BottomBar (1201), ButtonPanel/LogoBadge (1210),
 * so mobile panels fully overlay the entire viewport. The panel header's own close
 * button keeps it dismissable.
 */
export const LEFT_PANEL_MOBILE_ZINDEX = 10000;

/**
 * Z-index of the full-screen Projects dashboard (plan-372 §2.14).
 *
 * It covers the viewport and every docked panel, so it must sit above the
 * mobile panel layer — otherwise a left panel left open before the dashboard
 * was invoked would punch through it. It deliberately stays *below*
 * {@link MOBILE_CHROME_ZINDEX}: the mobile ActivityBar pill is the only way
 * back out on a phone, so it has to remain reachable.
 */
export const PROJECTS_DASHBOARD_ZINDEX = 10500;

/**
 * Z-index of the mobile chrome that must stay usable above the dashboard —
 * today the ActivityBar pill. Being trapped in a full-screen overlay with no
 * visible exit is the failure this constant exists to prevent.
 */
export const MOBILE_CHROME_ZINDEX = 10600;

/** Width of the Settings panel. */
export const SETTINGS_PANEL_WIDTH = 540;

/** Default width of the PropertyInspector panel (also the initial resizable width). */
export const INSPECTOR_PANEL_WIDTH = 320;

/** Min width the PropertyInspector can be resized to. */
export const INSPECTOR_MIN_WIDTH = 240;

/** Max width the PropertyInspector can be resized to. */
export const INSPECTOR_MAX_WIDTH = 640;

/** Width of the Machine Control panel. */
export const MACHINE_PANEL_WIDTH = 370;

/** Width of the Layout Planner library panel. */
export const LAYOUT_PANEL_WIDTH = 340;

/** Width of the Scene panel (scene browser + layout management). */
export const SCENE_PANEL_WIDTH = 340;

/** Width of the Order Manager panel. */
export const ORDER_PANEL_WIDTH = 320;

/** Width of the Annotations panel — shared by the panel itself and the
 *  ActivityBar toggle that registers the slot, so the reserved viewport inset
 *  always matches the width the panel actually renders with. */
export const ANNOTATION_PANEL_WIDTH = 280;

/** Default width of the editor's Kinematics window (right-docked, resizable). */
export const KINEMATICS_PANEL_WIDTH = 340;

/** Resize bounds for the Kinematics window. */
export const KINEMATICS_PANEL_MIN_WIDTH = 300;
export const KINEMATICS_PANEL_MAX_WIDTH = 560;

/** localStorage key for the user-resized Kinematics window width. */
export const LS_KEY_KINEMATICS_PANEL_WIDTH = 'rv-kinematics-panel-width';

/** Materials window — wider default than Quick Edit to fit the swatch grid. */
export const MATERIALS_PANEL_WIDTH = 360;
export const MATERIALS_PANEL_MIN_WIDTH = 300;
export const MATERIALS_PANEL_MAX_WIDTH = 560;
export const LS_KEY_MATERIALS_PANEL_WIDTH = 'rv-materials-panel-width';

export function getStoredMaterialsPanelWidth(): number {
  try {
    const raw = localStorage.getItem(LS_KEY_MATERIALS_PANEL_WIDTH);
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n)) {
        return Math.max(MATERIALS_PANEL_MIN_WIDTH, Math.min(MATERIALS_PANEL_MAX_WIDTH, n));
      }
    }
  } catch { /* storage unavailable — fall through to the default */ }
  return MATERIALS_PANEL_WIDTH;
}

/** The Kinematics window width to use right now: the user's persisted resize
 *  (clamped to the bounds) or the default. Shared by the panel and its
 *  toolbar toggle so the viewport shift always matches the rendered width. */
export function getStoredKinematicsPanelWidth(): number {
  try {
    const raw = localStorage.getItem(LS_KEY_KINEMATICS_PANEL_WIDTH);
    if (raw != null) {
      const n = Number(raw);
      if (!Number.isNaN(n))
        return Math.max(KINEMATICS_PANEL_MIN_WIDTH, Math.min(KINEMATICS_PANEL_MAX_WIDTH, n));
    }
  } catch { /* storage unavailable — fall through to default */ }
  return KINEMATICS_PANEL_WIDTH;
}

/** Default width of the CONNECT panel (resizable — see getStoredConnectPanelWidth). */
export const CONNECT_PANEL_WIDTH = 360;

/** Resize bounds for the CONNECT panel (LeftPanel resizable range, hierarchy-browser convention). */
export const CONNECT_PANEL_MIN_WIDTH = 280;
export const CONNECT_PANEL_MAX_WIDTH = 640;

/** localStorage key for the user-resized CONNECT panel width. */
export const LS_KEY_CONNECT_PANEL_WIDTH = 'rv-connect-panel-width';

/**
 * The CONNECT panel width to use right now: the user's persisted resize (clamped to the bounds)
 * or the default. Shared by the panel itself and by connect-plugin's open/toggle call so the
 * viewport shift (LeftPanelManager) always matches the rendered width.
 */
export function getStoredConnectPanelWidth(): number {
  try {
    const raw = localStorage.getItem(LS_KEY_CONNECT_PANEL_WIDTH);
    if (raw != null) {
      const n = Number(raw);
      if (!Number.isNaN(n))
        return Math.max(CONNECT_PANEL_MIN_WIDTH, Math.min(CONNECT_PANEL_MAX_WIDTH, n));
    }
  } catch { /* storage unavailable — fall through to default */ }
  return CONNECT_PANEL_WIDTH;
}

// ── Property-Inspector row layout ───────────────────────────────────────────
// Shared dimensions for the uniform `label → field` grid used by every
// inspector row (see rv-inspector-row.tsx). A scalar row is a 4-track grid:
//   [dot gutter] [label ≤40%] [flexible gap] [field ≤50%]
// so the label hugs the left, the field hugs the right, and both columns line
// up across every row regardless of label length.

/** Fixed px width of the leading gutter holding the override/reset dot. */
export const INSPECTOR_DOT_GUTTER = 14;

/** Max width of the label column (CSS %, relative to the inspector content box). */
export const INSPECTOR_LABEL_MAX = '40%';

/** Max width of the scalar field column (CSS %). */
export const INSPECTOR_FIELD_MAX = '50%';

/** Floor (px) so the field column stays usable on a 240px-wide panel. */
export const INSPECTOR_FIELD_MIN = 72;

/** Gap (px) between the grid tracks. */
export const INSPECTOR_ROW_GAP = 4;

