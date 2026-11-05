// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-placement-source.ts — where a placed reference's bytes come from.
 *
 * The planner-independent half of placement source resolution, lifted out of
 * `plugins/layout-planner/planner-persistence.ts` (2026-09-17) so the viewer's
 * placement instancer (`core/engine/rv-placement-instancer.ts`) derives the
 * ONE bake cache key with or without the planner plugin:
 *
 *  - a `project:` placement → the library registry (`findRegistryOrigin`);
 *  - a classic placement → its stable `glbUrl`, a bundled library path
 *    re-rooted onto this deploy's BASE_URL (`rebaseLocalLibraryUrl`).
 *
 * The catalog / cloud fallbacks for dead `blob:` urls stay in the planner —
 * they need its store and its cloud extension.
 */

import type { RegisteredLibrarySource } from './library-source-registry';
import { findLegacyOrigin, OPEN_PROJECT_PROVIDER_ID, resolveDocumentRef, type QualifierLike } from './library-origin';

/**
 * Prefix of a project-document catalog id (`project:<path>`, minted by
 * `project-library-provider.ts`) — and therefore of a placement made from one.
 */
export const PROJECT_PLACEMENT_PREFIX = 'project:';

/**
 * Is `catalogId` a document of the OPEN project — its manifest id, or the
 * legacy `project:<path>` form old files still carry (contract
 * documents-projects 4: references hang off the id, a path is only read).
 */
export function isProjectDocumentId(catalogId: string): boolean {
  if (catalogId.startsWith(PROJECT_PLACEMENT_PREFIX)) return true;
  return !!catalogId && findLegacyOrigin(catalogId)?.providerId === OPEN_PROJECT_PROVIDER_ID;
}

/**
 * The id a reference to `catalogId` is written with: a legacy `project:<path>`
 * becomes its document id via the ONE resolver (R3); ambiguous / unknown = as written.
 */
export function documentIdForWrite(catalogId: string): string {
  if (!catalogId.startsWith(PROJECT_PLACEMENT_PREFIX)) return catalogId;
  const r = resolveDocumentRef({ catalogId }, null);
  if (!('hit' in r) || r.hit.registered.providerId !== OPEN_PROJECT_PROVIDER_ID) return catalogId;
  return r.hit.entry.documentId ?? (r.hit.assetId.startsWith(PROJECT_PLACEMENT_PREFIX) ? catalogId : r.hit.assetId);
}

/**
 * Which registered library source owns `assetId` — the origin lookup the whole
 * plan-723 placement pipeline runs on.
 *
 * It is a SEARCH rather than a parameter threaded through every signature
 * because the planner's real drag channel is an in-memory entry reference
 * (`setDragEntry`), which carries no provenance. Since plan-778 it is the LEGACY
 * search of `library-origin.ts` (`findLegacyOrigin`): canonical ids over every
 * source in registry order first, then aliases; `hint` is a stored pre-778
 * qualifier (asked first, never required). A QUALIFIED reference never comes
 * here — `findQualifiedOrigin` answers it strictly.
 *
 * Never throws — one broken provider must not take the lookup with it.
 */
export function findRegistryOrigin(assetId: string, hint?: QualifierLike | null): RegisteredLibrarySource | null {
  // plan-778 F5: the ONE legacy search (`library-origin.ts`) — canonical ids
  // over every source first, then aliases; a qualified reference never comes
  // here (`findQualifiedOrigin`).
  return findLegacyOrigin(assetId, hint);
}

/**
 * Re-root a bundled (local) standard-library path onto the current deploy's
 * BASE_URL. A scene authored on one deploy (e.g. root `/`) stores each placement
 * glbUrl as the fully-resolved path of THAT deploy (`/library/...`); under
 * a sub-path deploy (`/demo/`) that root-absolute path resolves against the origin
 * root and 404s. Stripping to the `library/...` suffix and re-prepending
 * BASE_URL makes published scenes portable across root / sub-path / customer
 * deploys (and keeps local dev == build).
 *
 * The optional `models/` prefix is what scenes saved before the library moved
 * out of `models/` carry. Dropping it re-roots them onto the current location,
 * so an old published layout keeps resolving.
 *
 * Full public web URLs (http/https — e.g. a GitHub-hosted library) and blob/data
 * URLs are left untouched: those are NOT deploy-relative and resolve the same
 * everywhere.
 */
export function rebaseLocalLibraryUrl(url: string): string | null {
  if (!url || /^(https?:|blob:|data:)/i.test(url)) return null;
  const m = url.match(/(?:^|\/)(?:models\/)?(library\/.+)$/);
  if (!m) return null;
  const base = import.meta.env.BASE_URL ?? '/';
  return (base.endsWith('/') ? base : base + '/') + m[1];
}
