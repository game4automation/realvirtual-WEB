// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * library-sidecar-ingest — `library/library.json` on its way into the rows
 * (plan-717 §2.4, Phase 2).
 *
 * Two things live here and nothing else: the adapter that re-keys a parsed
 * sidecar into the manifest's coordinate system, and the ONE gate that decides
 * whether a sidecar value may still be read at all.
 *
 * ## Why a separate module and not a few lines in the store
 *
 * The manifest layer (`rv-asset-identity`) must not learn the library's file
 * layout — it owns rules about rows, and `library/` is a folder name. The
 * library layer must not learn how a delta is merged. What is left in the
 * middle is a path re-keying and a precedence rule, and putting them together
 * here keeps both of those statements true.
 *
 * ## Read tolerance lasts ONE release generation
 *
 * {@link LegacySidecarMeta} is a *read-only* shape, deliberately separate from
 * {@link LibrarySidecarAsset} rather than an alias of it — the same device
 * `upgradeLegacyAssetBase` uses (plan-716 §2.6): membership in the writable
 * type is what the compiler uses to decide whether a value may be produced, and
 * nothing in this build may produce one of these again. The sidecar write API
 * itself dies in Phase 4; this fallback goes with the release after it.
 *
 * The fallback is *narrow on purpose*: it answers only for a project that has
 * not been through the ingestion (no marker) and only for a field the row does
 * not carry. Once the marker is set the row is the sole answer, even when a
 * `library.json` is lying next to it — which is exactly what happens when a
 * user downgrades, the older build re-creates the file, and they come back.
 */

import type { AdoptSidecarIngestion, AdoptSidecarMeta } from '../project/rv-asset-identity';
import { isSidecarMigrated } from '../project/rv-asset-identity';
import type { RvProject } from '../project/rv-project-types';
import { LIBRARY_FOLDER } from './library-asset-ops';
import { SIDECAR_FILENAME, type LibrarySidecarV1 } from './library-sidecar';

/** Project-relative path of the sidecar a writable library keeps. */
export const SIDECAR_PATH = `${LIBRARY_FOLDER}/${SIDECAR_FILENAME}`;

/**
 * A sidecar record as an OLDER build wrote it — readable, never producible.
 *
 * `tags` is deliberately absent from what this build does anything with: the
 * row's `classification.tags` are read out of the GLB itself and are therefore
 * a derived cache, not user metadata that could be lost. Collections and the
 * display name are the two fields with nowhere else to live.
 */
export interface LegacySidecarMeta {
  readonly collections?: readonly string[];
  readonly displayName?: string;
}

/** The row fields the fallback has to look at before it answers. */
export interface LegacyCollectionsQuery {
  /** The manifest, for the marker. */
  project: RvProject | null | undefined;
  /** The row for this path, when there is one. */
  row?: { collections?: string[] } | null;
  /** The sidecar record for this path, when there is one. */
  legacy?: LegacySidecarMeta | null;
}

/**
 * The collections a legacy sidecar may still speak for, or null.
 *
 * Null — not `[]` — when the fallback does not apply, because "no answer" and
 * "the user filed this under nothing" are different statements and only the
 * first one may fall through to something else.
 */
export function legacyCollectionsFor(query: LegacyCollectionsQuery): string[] | null {
  if (isSidecarMigrated(query.project)) return null;   // the row is the answer now
  if (query.row?.collections !== undefined) return null; // the row already answered
  const collections = query.legacy?.collections;
  if (!collections || collections.length === 0) return null;
  return [...collections];
}

/**
 * Turn a parsed sidecar into the ingestion the adopt verb takes (§2.4).
 *
 * The keys change and nothing else: `conveyor/belt.glb` in the file is
 * `library/conveyor/belt.glb` in the manifest. Records that carry neither of
 * the two fields with a home are dropped here rather than travelling as empty
 * proposals the merge would only discard.
 *
 * Returns null only when there is no sidecar at all. A file that parses to
 * nothing still produces an ingestion with no entries, because the file is
 * still there to be marked and deleted. A caller must NOT synthesise this for
 * an *unparseable* file: that one is reported and left alone (§2.4, R1-S6).
 */
export function ingestionFromSidecar(
  sidecar: LibrarySidecarV1 | null,
  project: RvProject | null | undefined,
): AdoptSidecarIngestion | null {
  if (!sidecar) return null;
  const entries: Record<string, AdoptSidecarMeta> = {};
  for (const [relPath, record] of Object.entries(sidecar.assets)) {
    const meta: AdoptSidecarMeta = {};
    const collections = record.collections?.filter(c => typeof c === 'string' && c.trim() !== '');
    if (collections && collections.length > 0) meta.collections = collections;
    const displayName = record.displayName?.trim();
    if (displayName) meta.displayName = displayName;
    if (meta.collections || meta.displayName) {
      entries[`${LIBRARY_FOLDER}/${relPath}`] = meta;
    }
  }
  return { entries, migrated: isSidecarMigrated(project), path: SIDECAR_PATH };
}
