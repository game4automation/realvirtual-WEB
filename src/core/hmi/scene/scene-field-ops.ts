// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * scene-field-ops.ts — Tiny helper to persist a component-field edit through
 * the active edit target (SceneStore op log outside the editor, AssetDocument
 * inside — same `setField` op the property inspector uses).
 *
 * Lets non-inspector editors (IK Quick-Edit popover, IK path reorder/delete)
 * write `userData.realvirtual[componentType][fieldName] = value` durably and
 * undoably without re-implementing the op plumbing. No-op when no target is
 * available (tests / pre-boot) — callers keep their own optimistic runtime update.
 */

import { getActiveEditTarget } from '../rv-edit-target';

/** Persist a single component-field edit as a setField op (no-op without an edit target). */
export function persistFieldOp(
  nodePath: string,
  componentType: string,
  fieldName: string,
  value: unknown,
  prev: unknown,
): void {
  const target = getActiveEditTarget();
  if (!target.available) return;
  target.setField(nodePath, componentType, fieldName, value, prev);
}
