// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Kill-switch for the editor instance pick index (rv-instance-pick-index.ts)
 * — the two-level per-mesh pick backend used by authoring loads
 * (`preserveHierarchy`). Default ON. Disabling ('off' | 'false' | '0')
 * restores the legacy merged grouped-BVH picking in editor mode on the next
 * asset open — the fallback if the new backend misbehaves.
 *
 * Read at model-load time only; changing the flag requires a reload.
 */

/** localStorage key gating the editor instance pick backend. */
export const INSTANCE_PICK_LS_KEY = 'rv.editor.instancePick';

/** True unless the user disabled the instance pick backend (default true). */
export function isInstancePickEnabled(): boolean {
  try {
    const v = localStorage.getItem(INSTANCE_PICK_LS_KEY);
    return !(v === 'off' || v === 'false' || v === '0');
  } catch {
    return true;
  }
}
