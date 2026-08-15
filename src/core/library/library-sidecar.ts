// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * library-sidecar — READING the legacy `library.json` (plan-717 §2.4, Phase 4).
 *
 * Collections and display names used to live here, in one file next to a
 * writable library's assets. Since plan-717 they live on the manifest ROW, and
 * this module is what is left: **a reader, and only a reader**.
 *
 * ## Why anything is left at all
 *
 * Because the file still exists on every project that predates the change. The
 * adopt verb ingests it once into the rows and then deletes it
 * (`library-sidecar-ingest.ts`, §2.4), and `legacyCollectionsFor` answers for
 * the one release generation in which a project may not have been through that
 * ingestion yet. Both need to parse the file; neither may produce one.
 *
 * ## The write API is deleted, on purpose
 *
 * `withAssetMeta`, `withRenamedAsset`, `serialiseSidecar` and the
 * `writeSidecarAt` that used them are gone (plan-717 F9). Two homes for one
 * piece of metadata is the failure this plan removes, and a sidecar that a
 * newer build keeps refreshing is exactly how the old values "resurrect"
 * themselves after an external copy. `registration-removal-guard.test.ts`
 * keeps them gone.
 *
 * `resolveAssetMeta` went with them, for a different reason: it was the READ
 * half, and it had zero production callers from plan-413 until its deletion —
 * the write-only loop the plan closed.
 *
 * ## Defensive parsing
 *
 * A sidecar is *derived convenience*, never the source of truth — the assets
 * on disk are. So a broken or future-versioned file is **ignored, not thrown**:
 * throwing would make one bad character take a whole library offline. It is
 * also never rewritten, which since Phase 4 is a property of the module rather
 * than a rule inside it — there is no write left to refuse.
 */

/** Current schema version. Bump only for a breaking shape change. */
export const SIDECAR_SCHEMA_VERSION = 1;

/** File name, relative to the library root. */
export const SIDECAR_FILENAME = 'library.json';

export interface LibrarySidecarAsset {
  displayName?: string;
  collections?: string[];
  tags?: string[];
}

export interface LibrarySidecarV1 {
  schemaVersion: 1;
  /** Key = path relative to the library root, e.g. "conveyor/belt.glb". */
  assets: Record<string, LibrarySidecarAsset>;
}

/** An empty, valid sidecar. Used when the file is absent or unusable. */
export function emptySidecar(): LibrarySidecarV1 {
  return { schemaVersion: SIDECAR_SCHEMA_VERSION, assets: {} };
}

/** True when `value` is a sidecar this build understands. */
export function isValidSidecarV1(value: unknown): value is LibrarySidecarV1 {
  if (!value || typeof value !== 'object') return false;
  const s = value as Partial<LibrarySidecarV1>;
  if (s.schemaVersion !== SIDECAR_SCHEMA_VERSION) return false;
  // `assets` must be a plain record; an array would pass a naive typeof check
  // and then silently produce numeric keys.
  if (!s.assets || typeof s.assets !== 'object' || Array.isArray(s.assets)) return false;
  return true;
}

/** Drop anything that is not shaped like metadata, keeping the rest. */
function sanitiseAsset(value: unknown): LibrarySidecarAsset | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const out: LibrarySidecarAsset = {};
  if (typeof v.displayName === 'string') out.displayName = v.displayName;
  if (Array.isArray(v.collections)) {
    out.collections = v.collections.filter((c): c is string => typeof c === 'string');
  }
  if (Array.isArray(v.tags)) {
    out.tags = v.tags.filter((t): t is string => typeof t === 'string');
  }
  return out;
}

/**
 * Parse sidecar JSON text.
 *
 * Returns `null` for "unusable" — unparseable, wrong shape, or a schema version
 * this build does not know. `null` is the signal that the file must **not** be
 * rewritten; {@link emptySidecar} is what a caller should render from.
 */
export function parseSidecar(text: string): LibrarySidecarV1 | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;                       // malformed JSON — leave the file alone
  }
  if (!isValidSidecarV1(raw)) return null;

  // Per-asset entries are sanitised individually so one bad record cannot cost
  // the user every other asset's collections.
  const assets: Record<string, LibrarySidecarAsset> = {};
  for (const [key, value] of Object.entries(raw.assets)) {
    if (typeof key !== 'string' || key.length === 0) continue;
    const asset = sanitiseAsset(value);
    if (asset) assets[key] = asset;
  }
  return { schemaVersion: SIDECAR_SCHEMA_VERSION, assets };
}

// ─── Deleted in plan-717 Phase 4 (F9) ───────────────────────────────────
//
// `serialiseSidecar`, `withAssetMeta`, `withRenamedAsset` — the write API, and
// `resolveAssetMeta` — the read half nothing ever called. Collections are a row
// field now (§2.4); the folder-derived fallback `resolveAssetMeta` applied lives
// on as the catalog's folder CHIPS (`toCatalogEntry`, §2.6), which is where a
// user could always see it. Nothing in this build may produce a `library.json`.
