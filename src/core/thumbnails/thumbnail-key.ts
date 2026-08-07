// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * thumbnail-key — the stable cache identity of a preview image (plan-372 §2.7).
 *
 * Until now a preview was cached under the asset's `glbUrl`. That was wrong in
 * two directions once projects exist:
 *
 * - **Collisions.** Two projects may each ship `library/conveyor/belt.glb`.
 *   Under a folder backend both resolve to the *same* relative path and, for a
 *   blob-backed source, to a URL that is not stable across reloads at all. One
 *   project's preview would then be shown for the other project's asset.
 * - **Churn.** A `blob:` URL changes on every reload, so a blob-backed source
 *   never hit the cache and re-rendered its whole library every session.
 *
 * The key is therefore built from *identity*, not from location:
 *
 * ```
 * <projectId>:<providerId>:<sourceId>:<assetId>[:<version>]
 * ```
 *
 * `version` is optional and comes from {@link ResolvedAsset.version} — when a
 * source can tell us that an asset changed, an old preview is bypassed rather
 * than served stale. When it cannot, the key stays version-less and the preview
 * is reused, which is the pre-existing behaviour.
 *
 * Colons in the parts are escaped so that a value containing `:` (a URL-shaped
 * `assetId`, for instance) can never impersonate a different key.
 */

/** The identity of one asset, as far as the thumbnail cache is concerned. */
export interface ThumbnailKeyParts {
  /** Active project id. Use {@link NO_PROJECT} when no project is active. */
  projectId: string;
  /** Registry provider id (`LibrarySourceProvider.id`). */
  providerId: string;
  /** Source id, unique only within its provider (`LibrarySource.id`). */
  sourceId: string;
  /** Asset id, unique only within its source (`LibraryCatalogEntry.id`). */
  assetId: string;
  /** Optional content version; when present it participates in the key. */
  version?: string;
}

/**
 * Stand-in project id for the (transitional) case where no project is active.
 * Keeping a literal rather than an empty string means such keys are visibly
 * distinct in devtools instead of looking like a malformed key.
 */
export const NO_PROJECT = '~noproject';

/** Escape `\` and `:` so a part can never introduce a separator. */
function escapePart(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
}

/**
 * Build the stable cache key for an asset preview.
 *
 * Deterministic and side-effect free — the same parts always produce the same
 * key, which is what makes it safe to use as a queue de-duplication key in
 * {@link ThumbnailService} as well.
 */
export function buildThumbnailKey(parts: ThumbnailKeyParts): string {
  const base = [
    parts.projectId || NO_PROJECT,
    parts.providerId,
    parts.sourceId,
    parts.assetId,
  ].map(escapePart);
  // Only append the version segment when there is one — otherwise every
  // version-less source would carry a dangling separator.
  if (parts.version) base.push(escapePart(parts.version));
  return base.join(':');
}
