// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-hash.mjs — SHA-256 helpers for the library catalog (plan-508).
 *
 * The catalog carries `sha256` (hex, lowercase, 64 chars) + `sizeBytes` per
 * asset. The browser cache keys on it and verifies every network answer
 * against it with `crypto.subtle.digest` (`sha256Hex` in
 * `src/core/import/rv-cad-glb-cache.ts`); both sides MUST produce the same
 * string — `tests/library-catalog-hash.node.test.ts` holds the golden vector.
 *
 * Used by the two catalog builders and by `stampCatalogHashes` in
 * `_bunny-lib.mjs`. Older scripts keep their own `createHash` calls.
 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

//! SHA-256 of a Buffer / Uint8Array / ArrayBuffer as lowercase hex.
export function sha256Buffer(bytes) {
  const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  return createHash('sha256').update(view).digest('hex');
}

//! `{ sha256, sizeBytes }` of one file on disk. Reads the file whole — library
//! assets are tens of MB at most, and the builders run sequentially.
export function sha256File(path) {
  const bytes = readFileSync(path);
  return { sha256: sha256Buffer(bytes), sizeBytes: statSync(path).size };
}
