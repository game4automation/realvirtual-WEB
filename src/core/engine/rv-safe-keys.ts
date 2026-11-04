// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-safe-keys — the one guard against prototype pollution through model
 * CONTENT (rv_extras, `.kin.json` sidecars, `AssetOverrides`, overlays, model
 * configs). Every merge that writes keys taken from a file into a record goes
 * through these: a key `__proto__` / `constructor` / `prototype` is never
 * written, and an existing value is only reused when it is the record's OWN
 * property — `obj['__proto__']` is `Object.prototype`, and merging into it
 * reaches every object of the page (Codex round 3, sidecar `type: "__proto__"`).
 */

const UNSAFE_OBJECT_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** True for a key that must never be written from content into a record. */
export function isUnsafeObjectKey(key: string): boolean {
  return UNSAFE_OBJECT_KEYS.has(key);
}

/** `obj[key]` when it is an OWN property of `obj`, else undefined (inherited values never count). */
export function ownValue(obj: unknown, key: string): unknown {
  if (obj === null || (typeof obj !== 'object' && typeof obj !== 'function')) return undefined;
  return Object.prototype.hasOwnProperty.call(obj, key) ? (obj as Record<string, unknown>)[key] : undefined;
}

/** `userData.realvirtual` of a node as an OWN plain record, else undefined. */
export function ownExtrasOf(userData: unknown): Record<string, unknown> | undefined {
  const rv = ownValue(userData, 'realvirtual');
  return rv !== null && typeof rv === 'object' && !Array.isArray(rv) ? rv as Record<string, unknown> : undefined;
}
