// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-referenced-asset-open — turning an `AssetReference` into something the
 * editor can OPEN (plan-703 §2.7.3, decision (a) of 2026-08-10).
 *
 * A descend opens the child asset from ITS OWN bytes, never over the grafted
 * subtree in the parent. This module is the pure half of that: it decides which
 * bytes, in the order `AssetReference` itself prescribes, and it is free of the
 * viewer, of React and of IndexedDB so the order can be tested without any of
 * them.
 *
 * ## The resolution order, and why it is this one
 *
 * `rv-asset-reference.ts` states it in its own header: "`assetId` resolves
 * first, `path` is the fallback and is relative TO THE FILE THE REFERENCE IS
 * WRITTEN IN". That gives three steps, in this order:
 *
 * 1. **Catalog** — `providerId` + `sourceId` present ⇒ the asset lives in a
 *    registered library and is resolved through it, exactly like a
 *    `providerAsset` base. The catalog owns its own identity space, so its
 *    answer beats anything the project manifest might coincidentally hold.
 * 2. **Manifest by id** — the project's `documents[]` row carrying `assetId`.
 *    This is what Phase 5's mint bought: the row survives a MOVE, so a
 *    reference written before the file was moved still opens the right file
 *    while its own `path` has gone stale.
 * 3. **Path** — resolved relative to the file the reference is written in, then
 *    normalised against the project root.
 *
 * Step 2 sitting above step 3 is the whole point of `moveDocumentPath()`: if the
 * path won, a move would break every reference the moment the id stopped being
 * consulted.
 *
 * plan-780 2.3: a reference is read in its referrer's scope (contract
 * documents-projects 4); {@link openDocumentScoped} is the ONE open helper.
 */

import type { RvProject } from './rv-project-types';
import { findDocumentById, findDocumentByPath } from './rv-asset-identity';
import {
  hasLegacyHint,
  isQualifiedRef,
  LIBRARY_PROJECTS_PROVIDER_ID,
  resolveDocumentRef,
  type DocumentScope,
} from '../library/library-origin';
import type { AssetDraftBase } from '../editor/rv-asset-draft-storage';

/** `PROJECT_PLACEMENT_PREFIX` of `core/library/rv-placement-source.ts`, kept local so this module stays pure. */
const PROJECT_ASSET_PREFIX = 'project:';

/** The reference fields this module needs — a structural subset of `AssetReference`. */
export interface ReferencedAssetLocator {
  assetId: string;
  providerId?: string;
  sourceId?: string;
  /** Relative to the file the reference is written in. */
  path?: string;
}


export type ReferencedAssetPlan =
  /**
   * A document of LIBRARY PROJECT `libraryProjectId` (plan-778 Phase 5): opened
   * as a `libraryDocument` — B's own row, saved into B only through Edit in
   * library, never into the open project.
   */
  | { via: 'library'; libraryProjectId: string; documentId: string }
  /** Resolve through a registered library source. */
  | { via: 'catalog'; providerId: string; sourceId: string; assetId: string }
  /** Read this project-relative path. */
  | { via: 'manifest'; assetId: string; relPath: string }
  | { via: 'path'; relPath: string }
  /** Nothing to open — the caller raises a `child-missing` problem (§2.8). */
  | { via: 'unresolvable'; reason: 'no-locator' | 'unknown-asset' };

/**
 * Join a reference's relative `path` onto the folder of the file it was written
 * in, collapsing `.` and `..`.
 *
 * `ownerPath` is the project-relative path of the PARENT file, not its folder —
 * callers hand in what they have (`documents[].path`), and dropping the last
 * segment here keeps that asymmetry in one place. An absolute-looking `path`
 * (leading `/`) or an external URL is returned untouched: it does not describe a
 * position relative to anything.
 */
export function resolveReferencePath(ownerPath: string | null, path: string): string {
  const raw = (path ?? '').trim();
  if (raw === '') return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;
  if (raw.startsWith('/')) return raw.replace(/^\/+/, '');

  const ownerDir = (ownerPath ?? '').split('/').slice(0, -1).filter(Boolean);
  const out: string[] = [...ownerDir];
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return out.join('/');
}

/**
 * What to open for `ref`.
 *
 * `ownerPath` is the project-relative path of the file the reference is written
 * in; null when the parent is not a manifest document (an unsaved or bundled
 * document), in which case a relative `path` resolves against the project root.
 */
export function planReferencedAssetOpen(
  ref: ReferencedAssetLocator,
  project: RvProject | null | undefined,
  ownerPath: string | null,
  scope: DocumentScope = null,
): ReferencedAssetPlan {
  if (isQualifiedRef(ref) && ref.sourceId) {
    // A legacy path qualified into a library maps through that library's index.
    const r = ref.assetId.startsWith(PROJECT_ASSET_PREFIX) ? resolveDocumentRef({ catalogId: ref.assetId, providerId: ref.providerId, sourceId: ref.sourceId }, null) : null;
    const documentId = r && 'hit' in r ? r.hit.assetId : ref.assetId;
    return { via: 'library', libraryProjectId: ref.sourceId, documentId };
  }
  // plan-780 D2: in library B an unqualified reference is B's, never the open project's.
  if (scope && !hasLegacyHint(ref)) {
    if (!ref.assetId) return { via: 'unresolvable', reason: 'no-locator' };
    const r = resolveDocumentRef({ catalogId: ref.assetId }, scope);
    if ('hit' in r && r.hit.registered.providerId === LIBRARY_PROJECTS_PROVIDER_ID) {
      return { via: 'library', libraryProjectId: r.hit.registered.source.id, documentId: r.hit.assetId };
    }
    // Still loading: B's document as written.
    if ('pending' in r) return { via: 'library', libraryProjectId: r.source?.sourceId ?? scope.sourceId, documentId: ref.assetId };
    return { via: 'unresolvable', reason: 'unknown-asset' };
  }
  if (ref.providerId && ref.sourceId) {
    return {
      via: 'catalog',
      providerId: ref.providerId,
      sourceId: ref.sourceId,
      assetId: ref.assetId,
    };
  }

  const row = ref.assetId ? findDocumentById(project, ref.assetId) : null;
  if (row?.path) return { via: 'manifest', assetId: ref.assetId, relPath: row.path };

  // A placement dragged in from the project library names its asset by the
  // catalog id `project:<project-relative path>` (`PROJECT_PLACEMENT_PREFIX`)
  // and carries no `path` — the same mapping `referencedDocumentId` applies.
  if (ref.assetId?.startsWith(PROJECT_ASSET_PREFIX)) {
    const byPath = findDocumentByPath(project, ref.assetId.slice(PROJECT_ASSET_PREFIX.length));
    if (byPath?.path) return { via: 'manifest', assetId: byPath.id, relPath: byPath.path };
  }

  if (ref.path) {
    const relPath = resolveReferencePath(ownerPath, ref.path);
    if (relPath !== '') return { via: 'path', relPath };
  }

  // An assetId with no row and no path is a reference into a project this one
  // cannot see — §2.8's placeholder case, reported rather than guessed at.
  return { via: 'unresolvable', reason: ref.assetId ? 'unknown-asset' : 'no-locator' };
}

/** The referrer: the document the reference is written in. */
export interface ReferrerContext {
  /** Library B's qualifier, or null = the open project. */
  scope: DocumentScope;
  /** The open project's manifest (for a null scope). */
  project: RvProject | null | undefined;
  /** Project-relative path of the referrer (null = not a manifest document). */
  ownerPath: string | null;
}

/** Builds a library document's base (injected; keeps this module pure). */
export type LibraryBaseOf = (libraryProjectId: string, documentId: string) => AssetDraftBase | null;

/** The base to open, or why there is none. */
export type ScopedOpen =
  | { ok: true; base: AssetDraftBase; plan: ReferencedAssetPlan }
  | { ok: false; reason: string; plan: ReferencedAssetPlan };

/**
 * plan-780 2.3 — THE open helper: reference + referrer scope → editor base
 * (`document` / `libraryDocument` / `referencedAsset`); never an open-project row
 * for a reference written in a library document.
 */
export function openDocumentScoped(
  ref: ReferencedAssetLocator,
  referrer: ReferrerContext,
  libraryBaseOf: LibraryBaseOf,
  label = '',
): ScopedOpen {
  const plan = planReferencedAssetOpen(ref, referrer.project, referrer.ownerPath, referrer.scope);
  const name = label || ref.path?.split('/').pop() || ref.assetId;
  switch (plan.via) {
    case 'library': {
      const base = libraryBaseOf(plan.libraryProjectId, plan.documentId);
      return base
        ? { ok: true, base, plan }
        : { ok: false, reason: `Library '${plan.libraryProjectId}' is not available or no longer lists "${plan.documentId}".`, plan };
    }
    case 'manifest': {
      const row = findDocumentById(referrer.project, plan.assetId);
      return { ok: true, base: { kind: 'document', documentId: plan.assetId, path: plan.relPath, name: row?.name || name }, plan };
    }
    case 'catalog':
      return { ok: true, base: { kind: 'referencedAsset', assetId: plan.assetId, providerId: plan.providerId, sourceId: plan.sourceId, label: name }, plan };
    case 'path':
      return { ok: true, base: { kind: 'referencedAsset', assetId: ref.assetId, path: plan.relPath, label: name }, plan };
    default:
      return {
        ok: false,
        reason: plan.reason === 'no-locator'
          ? 'The reference names no asset to open.'
          : referrer.scope
            ? `"${ref.assetId}" is missing in library '${referrer.scope.sourceId}'.`
            : `No document with id "${ref.assetId}" is known in this project.`,
        plan,
      };
  }
}
