// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * cart-gate.ts — the ONE gate every Order Cart entry reads (plan-682 §2.7).
 *
 * The cart panel is gated by `ORDER_PANEL_GATE` (App.tsx, hidden in
 * `mode:viewer`, redefinable via `ui.visibilityOverrides`). Every other way
 * into the cart — the NavButton, "Add to Cart" in the pinned AAS tooltip and
 * in the metadata tooltip, the context-menu entry and the auto-open in
 * `addItem()` — reads the SAME gate, so there is never a button without a
 * panel behind it.
 *
 * Lives in its own leaf module (not in order-manager-plugin.tsx) because the
 * metadata tooltip and the order manager import each other's helpers; a leaf
 * keeps that free of import cycles.
 */

import { ORDER_PANEL_GATE } from './left-panel-visibility';
import {
  ensureUIElementRule,
  getActiveContexts,
  isUIElementVisible,
  useUIVisible,
} from './ui-context-store';

/**
 * Whether the Order Cart may be offered right now: `ORDER_PANEL_GATE` visible
 * in the active contexts, deployment overrides included. For non-React callers
 * (context-menu `condition`, `addItem()`).
 */
export function isCartAvailable(): boolean {
  ensureUIElementRule(ORDER_PANEL_GATE.id, ORDER_PANEL_GATE.rule);
  return isUIElementVisible(ORDER_PANEL_GATE.id, getActiveContexts());
}

/** React twin of {@link isCartAvailable}: re-renders on every context change. */
export function useCartAvailable(): boolean {
  return useUIVisible(ORDER_PANEL_GATE.id, ORDER_PANEL_GATE.rule);
}
