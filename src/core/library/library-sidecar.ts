// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * library-sidecar — per-asset metadata beside a writable library root
 * (plan-372 §2.6.5, Phase 9).
 *
 * Collections and display names have to live *somewhere*. `project.json` is a
 * manifest of artefacts and deliberately gets no per-asset metadata, and the
 * GLB itself cannot carry it (renaming would mean rewriting the binary). So
 * each writable library root gets one `library.json` next to its assets:
 * `<project>/library/library.json`, and the same file in a local folder
 * library for as long as those exist.
 *
 * ## Defensive parsing, modelled on `isValidSceneV2`
 *
 * A sidecar is *derived convenience*, never the source of truth — the assets
 * on disk are. So a broken or future-versioned file is **ignored, not thrown**
 * and, critically, **never overwritten**:
 *
 * - Throwing would make one bad character take a whole library offline.
 * - Overwriting would silently destroy the collections of a user who opened
 *   their project in a newer build. A file we cannot parse is far more likely
 *   to be from a version we do not know than to be garbage.
 *
 * When no entry exists for an asset, the caller falls back to the historical
 * behaviour of deriving the collection from the parent folder name.
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

/** Serialise for writing. Stable key order keeps git diffs readable. */
export function serialiseSidecar(sidecar: LibrarySidecarV1): string {
  const assets: Record<string, LibrarySidecarAsset> = {};
  for (const key of Object.keys(sidecar.assets).sort()) {
    assets[key] = sidecar.assets[key];
  }
  return JSON.stringify({ schemaVersion: SIDECAR_SCHEMA_VERSION, assets }, null, 2) + '\n';
}

/**
 * Metadata for one asset, with the folder-derived fallback applied.
 *
 * The fallback is the pre-sidecar behaviour: an asset at `conveyor/belt.glb`
 * belongs to the "conveyor" collection. It stays in place because most
 * libraries have no sidecar at all and must keep working unchanged.
 */
export function resolveAssetMeta(
  sidecar: LibrarySidecarV1 | null,
  relPath: string,
): Required<LibrarySidecarAsset> {
  const entry = sidecar?.assets[relPath];
  const segments = relPath.split('/').filter(Boolean);
  const fileName = segments[segments.length - 1] ?? relPath;
  const parent = segments.length > 1 ? segments[segments.length - 2] : null;

  return {
    displayName: entry?.displayName ?? fileName.replace(/\.[^.]+$/, ''),
    // An explicit empty array in the sidecar means "no collections" and must
    // not silently fall back to the folder name.
    collections: entry?.collections ?? (parent ? [parent] : []),
    tags: entry?.tags ?? [],
  };
}

/** Return a copy with one asset's metadata replaced (or removed when empty). */
export function withAssetMeta(
  sidecar: LibrarySidecarV1,
  relPath: string,
  meta: LibrarySidecarAsset,
): LibrarySidecarV1 {
  const assets = { ...sidecar.assets };
  const hasContent =
    meta.displayName !== undefined
    || (meta.collections?.length ?? 0) > 0
    || (meta.tags?.length ?? 0) > 0;
  if (hasContent) assets[relPath] = meta;
  else delete assets[relPath];         // don't persist empty records
  return { schemaVersion: SIDECAR_SCHEMA_VERSION, assets };
}

/** Return a copy with an asset's record moved to a new path (rename/duplicate). */
export function withRenamedAsset(
  sidecar: LibrarySidecarV1,
  fromPath: string,
  toPath: string,
): LibrarySidecarV1 {
  const entry = sidecar.assets[fromPath];
  const assets = { ...sidecar.assets };
  delete assets[fromPath];
  if (entry) assets[toPath] = entry;
  return { schemaVersion: SIDECAR_SCHEMA_VERSION, assets };
}
