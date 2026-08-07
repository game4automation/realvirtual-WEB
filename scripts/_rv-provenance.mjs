// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * _rv-provenance.mjs — who published this project, where, and when.
 *
 * plan-700 §2.8 / B15. Before this, `project.json` carried a single
 * `lastPublished` timestamp for all three publish targets, so a Bunny deploy
 * silently erased the record of the CONNECT embed and vice versa — the field
 * answered "when was this project last published anywhere", which is never the
 * question anyone actually has.
 *
 * `provenance.lastPublishedBy` is keyed by target and additive; `lastPublished`
 * stays as a mirror of the most recent publish so every existing reader
 * (`_bunny-lib.mjs` listPrivateProjects, the Unity toolbar) keeps working.
 *
 * Deliberately dependency-free (node:fs + node:path only) so the CONNECT
 * stager and the delivery pipeline can both import it without dragging in
 * `_bunny-lib.mjs` or `_workspace-lib.mjs` — importing either from the other
 * would be the cycle §2.9 already had to design around once.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

//! The three publish targets, exactly as §2.8 names them. A target outside
//! this set is a typo, and a typo must not silently mint a fourth key.
export const PUBLISH_TARGETS = Object.freeze(['bunny-private', 'connect-embed', 'delivery']);

//! Second-resolution ISO stamp, the same shape `lastPublished` has always had.
export function publishTimestamp(now = new Date()) {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Pure: a manifest with one publish recorded. Returns a NEW object; the input
 * is not mutated, and every unknown field survives untouched (plan-370 R3).
 *
 * `info` carries whatever identifies the artifact for that target — `version`
 * plus `code` (Bunny), `connectBuild` (CONNECT), `coreCommit` (delivery).
 * `undefined` and empty values are dropped rather than written as nulls.
 */
export function withPublishProvenance(manifest, target, info = {}, now = new Date()) {
  if (!PUBLISH_TARGETS.includes(target)) {
    throw new Error(`Unknown publish target "${target}" (expected one of ${PUBLISH_TARGETS.join(', ')})`);
  }
  const at = publishTimestamp(now);
  const entry = { at };
  for (const [key, value] of Object.entries(info)) {
    if (value === undefined || value === null || value === '') continue;
    entry[key] = value;
  }
  const previous = (manifest && typeof manifest.provenance === 'object' && manifest.provenance)
    ? manifest.provenance
    : {};
  const previousBy = (typeof previous.lastPublishedBy === 'object' && previous.lastPublishedBy)
    ? previous.lastPublishedBy
    : {};
  return {
    ...manifest,
    // The legacy single field stays, as a mirror of the most recent publish.
    lastPublished: at,
    provenance: {
      ...previous,
      lastPublishedBy: { ...previousBy, [target]: entry },
    },
  };
}

/**
 * Record a publish in `<projectDir>/project.json`.
 *
 * Called only AFTER the artifact is actually out — an upload that failed
 * halfway must not leave a manifest claiming it succeeded. Returns the written
 * manifest, or null when there is no `project.json` to write (a staged copy
 * that has already been torn down, say).
 */
export function recordPublishProvenance(projectDir, target, info = {}, now = new Date()) {
  const jsonPath = join(projectDir, 'project.json');
  if (!existsSync(jsonPath)) return null;
  const manifest = JSON.parse(readFileSync(jsonPath, 'utf8'));
  const updated = withPublishProvenance(manifest, target, info, now);
  writeFileSync(jsonPath, JSON.stringify(updated, null, 2));
  return updated;
}
