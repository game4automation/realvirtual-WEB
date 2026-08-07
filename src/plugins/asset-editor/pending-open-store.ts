// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * pending-open-store — one-shot handoff for "Edit asset" requests.
 *
 * The library card action stashes the asset to open, then requests the editor
 * mode; the AssetEditorPlugin consumes the request in onModeActivate. Kept as
 * its own tiny module so the layout-planner UI never imports the editor plugin
 * (registry-over-hard-wiring, and no import cycles).
 */

import type { AssetBase } from '../../core/editor/rv-asset-document';

let _pending: AssetBase | null = null;

/** Stash the asset the editor should open on its next activation. */
export function setPendingAssetOpen(base: AssetBase): void {
  _pending = base;
}

/** Consume (and clear) the pending open request. */
export function takePendingAssetOpen(): AssetBase | null {
  const p = _pending;
  _pending = null;
  return p;
}
