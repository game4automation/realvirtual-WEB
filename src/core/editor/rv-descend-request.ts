// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-descend-request — the seam through which core UI asks for a DESCEND
 * (plan-703 Phase 4, §3.4).
 *
 * The gesture lives in core (`rv-hierarchy-browser.tsx`'s double-click, the
 * viewport's double-click), the machinery lives in the asset-editor plugin
 * (`RvDescendController`, `RvDocumentStack`). Rather than importing the plugin
 * from core — which would make the hierarchy browser un-loadable without the
 * editor — the plugin INSTALLS a handler here on activation and removes it on
 * exit. That is the house pattern already used by
 * `setDriveGizmoFallbackResolver` and `setDriveDragDriver`.
 *
 * `canDescend` exists separately from `descend` so the UI can render the affordance
 * (the `[R]` chevron, an enabled context-menu item) without attempting the
 * navigation — §2.7.3 requires the verb to be DISABLED on a placeholder rather
 * than to fail on click.
 */

export interface DescendHandler {
  /** May this scene path be descended into right now? Pure and cheap. */
  canDescend(nodePath: string): boolean;
  /** Enter it. Rejects only on a genuine failure; refusals are reported. */
  descend(nodePath: string): Promise<void>;
}

let _handler: DescendHandler | null = null;

/** Install (or, with `null`, remove) the descend handler. */
export function setDescendHandler(handler: DescendHandler | null): void {
  _handler = handler;
}

/** True when a handler is installed AND it accepts this path. */
export function canDescendInto(nodePath: string): boolean {
  if (!_handler) return false;
  try {
    return _handler.canDescend(nodePath);
  } catch {
    // A verdict that throws is a "no" — never a broken hierarchy row.
    return false;
  }
}

/**
 * Ask to descend into `nodePath`.
 *
 * Returns **false when nothing happened** (no handler, or the path is not a
 * descendable reference), so the caller can fall through to its ordinary
 * double-click behaviour instead of swallowing the gesture.
 */
export function requestDescend(nodePath: string): boolean {
  if (!canDescendInto(nodePath)) return false;
  void _handler!.descend(nodePath);
  return true;
}
