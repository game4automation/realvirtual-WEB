// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-json.mjs — the ONE way a build script stamps a document row of a
 * `project.json` (plan-587 F6).
 *
 * **Why this exists.** Two model builders kept a `project.json` in step with
 * the GLB they had just written, and one of them did it by editing TEXT LINES:
 * it searched for the line holding `"id": "<docid>"`, then looked for
 * `"sizeBytes"`, `"mtimeMs"`, `"sha256"` within the NEXT FOURTEEN LINES and
 * rewrote them with a regex (`build-plc-model.mjs:1318` before this plan).
 * That construction has three failure modes, none of them obvious from the
 * call site:
 *
 *   1. A reformat of `project.json` (a longer `description`, a reordered row,
 *      one more nested field) pushes a key past line 14 and the build aborts
 *      with `key not found` — a build failure caused by whitespace.
 *   2. The row's fields need not be in the assumed order at all. Rows written
 *      by other tooling in this repo genuinely start with `sizeBytes`, others
 *      with `id` — the 14-line window is a guess about field order.
 *   3. The `scriptRef` removal used `lines.splice(…)`, which SHORTENS the array
 *      the window is measured against, so the very fix moved the window under
 *      its own feet and could push the last key out of reach.
 *
 * So: parse the JSON, set the fields on the object, write it back with
 * `JSON.stringify(…, 2)`. Field order survives because assigning to an
 * existing key does not move it, and `delete` removes one just like the
 * `splice` did.
 *
 * **Why the caller-specific behaviour stays a PARAMETER.** The two callers do
 * NOT want the same thing, and the differences were measured on the code, not
 * assumed (Gate round 1, HIGH 3):
 *
 *   | | `build-plc-model.mjs` (PLC) | `agv-factory-paths.mjs` (AGV) |
 *   |---|---|---|
 *   | selector      | `{ id }`               | `{ path }` (relative to the manifest) |
 *   | `mtimeMs`     | `Math.floor(mtimeMs)`  | `Math.round(mtimeMs)` |
 *   | `scriptRef`   | removed (plan-543: the panel is data in the GLB) | KEPT — the AGV row legitimately binds a model plugin |
 *   | `modifiedAt`  | not touched            | set to now |
 *   | row missing   | throws                 | silently does nothing |
 *   | trailing `\n` | preserved (its file has one) | none (its file has none) |
 *
 * Unifying any of these would silently change a committed artefact, so each is
 * named at the call site. `mtimeRounding` in particular has NO default: one of
 * the two files would get a different `mtimeMs` than it has today, and a
 * default is exactly how that happens unnoticed.
 *
 * `sha256`/`sizeBytes` come from `sha256File` in `rv-hash.mjs` — the same
 * helper the library catalog builders use, so the hash in a `project.json` row
 * and the hash in the catalog are produced by one implementation.
 *
 * Tests: `tests/rv-project-json.node.test.ts`.
 */

import { readFileSync, statSync, writeFileSync } from 'node:fs';

import { sha256File } from './rv-hash.mjs';

//! How `mtimeMs` is turned into an integer. No default — see the header.
const ROUNDINGS = {
  floor: Math.floor,
  round: Math.round,
};

//! Finds the one document row a selector addresses. Exported for callers that
//! want to look before they leap (and for the tests).
//!
//! `selector` is `{ id }` **or** `{ path }`, never both and never neither —
//! anything else throws, because a selector that matches "the first row" by
//! accident is the class of bug this module exists to remove.
export function findDocumentRow(manifest, selector) {
  const hasId = selector?.id !== undefined;
  const hasPath = selector?.path !== undefined;
  if (hasId === hasPath) {
    throw new Error('findDocumentRow: selector must be exactly one of { id } or { path }');
  }
  const rows = Array.isArray(manifest?.documents) ? manifest.documents : [];
  return rows.find((row) => (hasId ? row?.id === selector.id : row?.path === selector.path)) ?? null;
}

//! Stamps `sizeBytes`, `mtimeMs` and `sha256` of `glbPath` onto the document
//! row `selector` addresses in `projectJsonPath`, and writes the manifest back
//! as `JSON.stringify(…, 2)`.
//!
//! `options`:
//! - `glbPath` (required) — the file whose size/mtime/hash are stamped. Stays
//!   explicit in the API: neither caller derives it from the row's `path`
//!   (the PLC one stamps a published COPY of its GLB).
//! - `mtimeRounding` (required) — `'floor'` or `'round'`, see the header table.
//! - `removeScriptRef` (default `false`) — delete the row's `scriptRef`.
//! - `setModifiedAt` (default `false`) — `true` writes `new Date().toISOString()`,
//!   a string writes that string verbatim (used by the tests).
//! - `ifMissing` (default `'throw'`) — `'ignore'` returns `null` and writes
//!   nothing instead, which is the AGV caller's behaviour.
//! - `trailingNewline` (default `'preserve'`) — `'preserve'` keeps the file's
//!   existing final newline (or its absence), `'none'` never writes one,
//!   `'always'` always does.
//!
//! Returns the updated row object, or `null` when the row was missing and
//! `ifMissing` is `'ignore'`.
export function updateDocumentRow(projectJsonPath, selector, options) {
  const {
    glbPath,
    removeScriptRef = false,
    setModifiedAt = false,
    mtimeRounding,
    ifMissing = 'throw',
    trailingNewline = 'preserve',
  } = options ?? {};

  if (!glbPath) throw new Error('updateDocumentRow: options.glbPath is required');
  const round = ROUNDINGS[mtimeRounding];
  if (!round) {
    throw new Error(
      `updateDocumentRow: unknown mtimeRounding ${JSON.stringify(mtimeRounding)} (expected 'floor' or 'round')`,
    );
  }
  if (ifMissing !== 'throw' && ifMissing !== 'ignore') {
    throw new Error(`updateDocumentRow: unknown ifMissing ${JSON.stringify(ifMissing)} (expected 'throw' or 'ignore')`);
  }

  const text = readFileSync(projectJsonPath, 'utf8');
  const manifest = JSON.parse(text);
  const row = findDocumentRow(manifest, selector);
  if (!row) {
    if (ifMissing === 'ignore') return null;
    const what = selector.id !== undefined ? `id ${selector.id}` : `path ${selector.path}`;
    throw new Error(`row ${what} not found in ${projectJsonPath}`);
  }

  const { sha256, sizeBytes } = sha256File(glbPath);
  row.sizeBytes = sizeBytes;
  row.mtimeMs = round(statSync(glbPath).mtimeMs);
  row.sha256 = sha256;
  if (removeScriptRef) delete row.scriptRef;
  if (setModifiedAt) row.modifiedAt = typeof setModifiedAt === 'string' ? setModifiedAt : new Date().toISOString();

  const keepNewline =
    trailingNewline === 'always' ? true : trailingNewline === 'none' ? false : text.endsWith('\n');
  writeFileSync(projectJsonPath, JSON.stringify(manifest, null, 2) + (keepNewline ? '\n' : ''));
  return row;
}
