// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * severity-pulse — shared alarm flash for the message system.
 *
 * Frames a scene component in 3D and flashes it in the severity color for a
 * few seconds. This is the generalized form of the Toray showcase's
 * motor-alarm effect, wired into TileCard so EVERY message card with a
 * related component (standard WebError panel, demo messages, customer HMIs)
 * gets the same behavior — colored by the card's severity via the standard
 * SEVERITY_COLORS map.
 *
 * Rendering goes through {@link RVHighlightManager.flash}: fill + edges
 * overlay pairs AND the OutlinePass flash channel in the same color, pulsing
 * in sync, in every workspace mode. The flash channel is independent of
 * hover/selection — an alarm pulse never clobbers the user's selection
 * outline — and batched targets get invisible outline proxies, so the
 * silhouette works on every model.
 *
 * Re-trigger safe: clicking several cards in a row restarts the flash.
 *
 * NOTE on palettes: SEVERITY_COLORS is the HMI/panel palette (card chrome and
 * this flash). The 3D runtime-instruction highlight uses its own Unity-parity
 * palette (TYPE_COLOR in rv-custom-runtime-instruction.ts) — intentionally
 * separate.
 */

import type { RVViewer } from '../rv-viewer';

/** Message severity levels used across the HMI message system. */
export type MessageSeverity = 'error' | 'warning' | 'info' | 'success' | 'maintenance';

/** Standard message-system severity colors (single source of truth — TileCard
 *  border/icon and the alarm flash both read from here). */
export const SEVERITY_COLORS: Record<MessageSeverity, string> = {
  error: '#ef5350',
  warning: '#ffa726',
  info: '#4fc3f7',
  success: '#66bb6a',
  maintenance: '#ab47bc',
};

/** How long the alarm flash stays on the component (ms). */
const PULSE_DURATION_MS = 3500;

/** '#rrggbb' → numeric color. */
function hexToNumber(hex: string): number {
  return parseInt(hex.replace('#', ''), 16);
}

/**
 * Frame one or more paths in 3D and flash them in the severity color for a
 * few seconds (fill + edges + OutlinePass outline combined, auto-cleared).
 * No-op when no path resolves to a scene node.
 */
export function pulseSeverityOutline(viewer: RVViewer, pathOrPaths: string | string[], severity: MessageSeverity): void {
  const paths = Array.isArray(pathOrPaths) ? pathOrPaths : [pathOrPaths];
  const nodes = paths
    .map((p) => viewer.registry?.getNode(p))
    .filter((n): n is NonNullable<typeof n> => !!n);
  if (nodes.length === 0) return;

  const color = hexToNumber(SEVERITY_COLORS[severity] ?? SEVERITY_COLORS.info);
  viewer.highlighter.flash(nodes, { color, durationMs: PULSE_DURATION_MS });
  viewer.fitToNodes(nodes);
}
