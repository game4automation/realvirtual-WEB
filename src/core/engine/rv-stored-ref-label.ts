// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-stored-ref-label — labels for stored references held as STRINGS (plan-769 Phase 3).
 *
 * Several components parse their stored references into plain strings once and read
 * them later (`RVPipe.sourcePath`, `RVPump.pipePath`, instruction step targets, physics
 * zone walls, connection endpoints). For a path that string IS the reference. For the
 * address forms a web save writes (`{ address }`, `{ unresolvedPath, reason }`) the
 * string is a LABEL — the address / the kept path, fine to show — and this table maps
 * it back to the stored value, per owner node. {@link NodeRegistry.readStoredRef}
 * consults it for a string reference, so every label-based reader reads the address,
 * with no second resolution path.
 */

import type { Object3D } from 'three';
import { storedReferenceForm, storedReferenceLabel, storedReferenceValue, type StoredReferenceValue } from './rv-node-path-rewrite.mjs';

const _labels = new WeakMap<Object3D, Map<string, StoredReferenceValue>>();

/**
 * The string a label-based reader keeps for one stored value of `owner`: the path for
 * the path form; for an address / a kept path its label, remembered so that a later
 * `readStoredRef(owner, label)` reads the stored value. `null` = no reference.
 */
export function storedRefString(owner: Object3D | null | undefined, value: unknown): string | null {
  const form = storedReferenceForm(value);
  if (!form) return null;
  if (form.form === 'path') return form.path;
  const label = storedReferenceLabel(value)!;
  if (owner) {
    let m = _labels.get(owner);
    if (!m) { m = new Map(); _labels.set(owner, m); }
    m.set(label, storedReferenceValue(value)!);
  }
  return label;
}

/** The stored value behind a label of `owner` ({@link storedRefString}), or undefined. */
export function storedValueOfLabel(owner: Object3D | null | undefined, label: string): StoredReferenceValue | undefined {
  return owner ? _labels.get(owner)?.get(label) : undefined;
}
