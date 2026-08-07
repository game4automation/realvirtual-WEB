// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Three.js node-name sanitization parity helper.
 *
 * Three.js' `GLTFLoader` runs every imported node name through
 * `THREE.PropertyBinding.sanitizeNodeName(name)` (via `createUniqueName`)
 * before assigning `Object3D.name`, because the animation system reserves the
 * characters `[ ] . : /` as track-binding path separators and `\s` for
 * readability. The exact transform (Three r171,
 * `src/animation/PropertyBinding.js`) is:
 *
 *   name.replace(/\s/g, '_').replace(/[\[\]\.:\/]/g, '')
 *
 * i.e. whitespace → `_`, then the five reserved characters removed.
 *
 * This matters for PLC signal names: a Siemens symbol like `MC04.01I00W`
 * becomes `MC0401I00W` once it lands on `Object3D.name`. realvirtual registers
 * signals (and resolves rv_extras component references) by exact name, and the
 * live interfaces (MQTT / realvirtual CONNECT) address the SAME signal by the
 * ORIGINAL dotted name. Re-deriving the original glTF name and detecting that a
 * given `Object3D.name` is *purely* the sanitized form of it (no dedup `_N`
 * suffix) lets the loader restore the exact original name so both sides match.
 *
 * Keep this in lock-step with `THREE.PropertyBinding.sanitizeNodeName`; the
 * unit test `tests/three-name-sanitize.test.ts` pins it against the real THREE
 * implementation so a Three.js upgrade that changes the rule fails loudly.
 */

/** Reserved track-binding characters Three.js strips from node names: `[ ] . : /`. */
const RESERVED_CHARS_RE = /[\[\]\.:/]/g;

/**
 * Reproduce `THREE.PropertyBinding.sanitizeNodeName` exactly:
 * whitespace → `_`, then strip the reserved characters `[ ] . : /`.
 *
 * @param name The original (glTF) node name.
 * @returns The sanitized form Three.js would assign to `Object3D.name`
 *   (before any `_N` dedup suffix it may additionally append on collision).
 */
export function sanitizeLikeThree(name: string): string {
  return name.replace(/\s/g, '_').replace(RESERVED_CHARS_RE, '');
}

/**
 * Decide whether `currentName` is the *pure* Three.js sanitization of
 * `origName` — i.e. it differs from `origName` ONLY because of name
 * sanitization, with NO `_N` deduplication suffix appended.
 *
 * When this is `true` it is safe to restore `obj.name = origName`, because the
 * original name was unique within the GLB (no collision) and restoring it
 * cannot reintroduce a name clash. When it is `false`, `currentName` either
 * already equals `origName` (nothing to do) or carries a real dedup suffix
 * (restoring would collide) — in both cases the name must be left untouched.
 *
 * @param origName    The original glTF node name (may contain `.`/spaces).
 * @param currentName The current `Object3D.name` Three.js assigned.
 * @returns `true` iff `currentName === sanitizeLikeThree(origName)` and the two
 *   names actually differ (so there is something to restore).
 */
export function isPureSanitization(origName: string, currentName: string): boolean {
  if (!origName) return false;
  if (origName === currentName) return false; // identical → nothing was changed
  return sanitizeLikeThree(origName) === currentName;
}
