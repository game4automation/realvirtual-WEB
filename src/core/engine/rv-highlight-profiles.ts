// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-highlight-profiles — pure data: the per-workspace-mode hover/selection
 * highlight profiles.
 *
 * A profile bundles the DESIRED VISUAL for a mode (overlay fill+edges vs
 * OutlinePass silhouette) with the channel styles for both rendering paths.
 * RVHighlightPolicy applies the matching profile on every `mode-changed`;
 * RVHighlightManager's capability resolver (resolveStrategy) may still fall
 * back per root (e.g. outline requested but the root is fully batched).
 *
 * Mode → visual (product decision):
 *   - HMI, DES    → 'overlay'  (fill + edges — never OutlinePass)
 *   - Planner     → 'outline'  (green silhouette)
 *   - Editor      → 'outline'  (yellow silhouette)
 *
 * The overlay styles double as the outline-mode FALLBACK look (WebGPU without
 * a TSL host, or a fully batched root).
 */

import type { HighlightStyle } from './rv-highlight-manager';
import { DEFAULT_HOVER_STYLE, DEFAULT_SELECTION_STYLE } from './rv-highlight-manager';
import type { OutlineStyle } from './rv-outline-manager';
import { DEFAULT_OUTLINE_STYLE, DEFAULT_HOVER_OUTLINE_STYLE } from './rv-outline-manager';

// ─── Types ──────────────────────────────────────────────────────────────

/** The visual family a mode wants for hover AND selection. */
export type HighlightVisual = 'overlay' | 'outline';

/** Everything a mode needs to describe its hover/selection look. */
export interface HighlightProfile {
  /** Desired visual for hover AND selection (per-root capability fallback
   *  may still downgrade outline → overlay). */
  visual: HighlightVisual;
  /** Overlay-path hover style (also the outline-mode fallback look). */
  hoverStyle: HighlightStyle;
  /** Overlay-path selection style (also the outline-mode fallback look). */
  selectionStyle: HighlightStyle;
  /** OutlinePass hover style. */
  hoverOutline: OutlineStyle;
  /** OutlinePass selection style. */
  selectionOutline: OutlineStyle;
  /** Optional per-mode override of the legacy-overlay mesh budget
   *  (`RVHighlightManager.maxHoverMeshes`, default 200). */
  maxHoverMeshes?: number;
}

// ─── Planner styles (GREEN) — moved from plugins/layout-planner/index.ts ──

/** Planner hover — soft green hint. Overlay fields are the fallback look; the
 *  on-screen visual is the hover OutlinePass silhouette below. */
const PLANNER_HOVER_STYLE: HighlightStyle = {
  overlayColor: 0x4fc34f,
  overlayOpacity: 0.10,
  overlayWireframe: false,
  edgeColor: 0x4fc34f,
  edgeOpacity: 0.4,
  edgeLinewidth: 1,
  showOverlay: true,
  showEdges: true,
};

/** Planner selection — green fill+edges FALLBACK for roots the OutlinePass
 *  cannot silhouette (WebGPU without TSL, fully batched root). Replaces the
 *  old PLANNER_SELECTION_MUTE_STYLE: muting is now expressed by
 *  `visual: 'outline'`, so the fallback can show a real visual instead of
 *  nothing. */
const PLANNER_SELECTION_STYLE: HighlightStyle = {
  overlayColor: 0x4fc34f,
  overlayOpacity: 0.20,
  overlayWireframe: false,
  edgeColor: 0x4fc34f,
  edgeOpacity: 0.65,
  edgeLinewidth: 1,
  showOverlay: true,
  showEdges: true,
};

/** Planner selection silhouette — vivid green, quiet glow, crisp edge. */
const PLANNER_OUTLINE_STYLE: OutlineStyle = {
  visibleEdgeColor: 0x4fc34f,
  hiddenEdgeColor: 0x2a6b2a,
  edgeStrength: 4,
  edgeThickness: 2,
  edgeGlow: 0.3,
  pulsePeriod: 0,
};

/** Planner hover silhouette — dimmer than the selection outline so the
 *  focused (selected) object dominates. */
const PLANNER_HOVER_OUTLINE_STYLE: OutlineStyle = {
  visibleEdgeColor: 0x5fc35f,
  hiddenEdgeColor: 0x2a6b2a,
  edgeStrength: 3.5,
  edgeThickness: 2,
  edgeGlow: 0.25,
  pulsePeriod: 0,
};

// ─── Editor styles (YELLOW) — moved from plugins/asset-editor/index.ts ────

/** Editor hover highlight — soft yellow, low intensity (a hint). */
const EDITOR_HOVER_STYLE: HighlightStyle = {
  overlayColor: 0xffe066,
  overlayOpacity: 0.10,
  overlayWireframe: false,
  edgeColor: 0xffe066,
  edgeOpacity: 0.4,
  edgeLinewidth: 1,
  showOverlay: true,
  showEdges: true,
};

/** Editor selection highlight — stronger amber-yellow that dominates hover. */
const EDITOR_SELECTION_STYLE: HighlightStyle = {
  overlayColor: 0xffc400,
  overlayOpacity: 0.20,
  overlayWireframe: false,
  edgeColor: 0xffc400,
  edgeOpacity: 0.65,
  edgeLinewidth: 1,
  showOverlay: true,
  showEdges: true,
};

/** Editor selection silhouette — vivid amber, crisp. */
const EDITOR_OUTLINE_STYLE: OutlineStyle = {
  visibleEdgeColor: 0xffc400,
  hiddenEdgeColor: 0x594400,
  edgeStrength: 6,
  edgeThickness: 2,
  edgeGlow: 0.35,
  pulsePeriod: 0,
};

/** Editor hover silhouette — dimmer, softer yellow than the selection outline. */
const EDITOR_HOVER_OUTLINE_STYLE: OutlineStyle = {
  visibleEdgeColor: 0xffe066,
  hiddenEdgeColor: 0x594e23,
  edgeStrength: 4,
  edgeThickness: 2,
  edgeGlow: 0.3,
  pulsePeriod: 0,
};

/** Editor kinematic-group preview — the Kinematic accent (pink, `#ce93d8`,
 *  matching the Kinematics window and the hierarchy badge) instead of the
 *  editor yellow, and a lighter fill: the preview covers whole assemblies,
 *  so it must read as a tint rather than repaint the geometry. Passed
 *  per-call via `highlightSelection({ style })` — the editor profile keeps
 *  owning every other selection. */
export const EDITOR_KINEMATIC_SELECTION_STYLE: HighlightStyle = {
  overlayColor: 0xce93d8,
  overlayOpacity: 0.08,
  overlayWireframe: false,
  edgeColor: 0xce93d8,
  edgeOpacity: 0.45,
  edgeLinewidth: 1,
  showOverlay: true,
  showEdges: true,
};

// ─── Profiles ───────────────────────────────────────────────────────────

const HMI_PROFILE: HighlightProfile = Object.freeze({
  visual: 'overlay' as const,
  hoverStyle: DEFAULT_HOVER_STYLE,
  selectionStyle: DEFAULT_SELECTION_STYLE,
  hoverOutline: DEFAULT_HOVER_OUTLINE_STYLE,
  selectionOutline: DEFAULT_OUTLINE_STYLE,
});

/** Built-in workspace-mode profiles. Custom modes register their own via
 *  RVHighlightPolicy.register(); unknown modes fall back to the HMI default. */
export const MODE_HIGHLIGHT_PROFILES: Readonly<Record<string, HighlightProfile>> = Object.freeze({
  hmi: HMI_PROFILE,
  des: HMI_PROFILE, // DES shares the HMI blue overlay look
  planner: Object.freeze({
    visual: 'outline' as const,
    hoverStyle: PLANNER_HOVER_STYLE,
    selectionStyle: PLANNER_SELECTION_STYLE,
    hoverOutline: PLANNER_HOVER_OUTLINE_STYLE,
    selectionOutline: PLANNER_OUTLINE_STYLE,
  }),
  editor: Object.freeze({
    // Fill overlay + edges rather than an OutlinePass silhouette: authoring
    // needs to see WHICH surfaces belong to the hovered/selected node inside
    // a dense assembly, which a silhouette (outer contour only) cannot show.
    // The outline styles below stay for the flash channel.
    visual: 'overlay' as const,
    hoverStyle: EDITOR_HOVER_STYLE,
    selectionStyle: EDITOR_SELECTION_STYLE,
    hoverOutline: EDITOR_HOVER_OUTLINE_STYLE,
    selectionOutline: EDITOR_OUTLINE_STYLE,
    // Editor loads have NO proxy provider (instance pick backend, no merged
    // geometry) — every editor highlight runs on legacy per-mesh pairs. Real
    // CAD nodes and kinematic group previews easily exceed the 200-mesh
    // default; without this they'd degrade to a bbox wireframe.
    maxHoverMeshes: 1000,
  }),
});

/** Fallback profile for unknown/unregistered modes. */
export const DEFAULT_HIGHLIGHT_PROFILE: HighlightProfile = MODE_HIGHLIGHT_PROFILES.hmi;
