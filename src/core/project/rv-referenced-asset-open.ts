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
 */

import type { RvProject } from './rv-project-types';
import { findDocumentById } from './rv-asset-identity';

/** The reference fields this module needs — a structural subset of `AssetReference`. */
export interface ReferencedAssetLocator {
  assetId: string;
  providerId?: string;
  sourceId?: string;
  /** Relative to the file the reference is written in. */
  path?: string;
}

export type ReferencedAssetPlan =
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
): ReferencedAssetPlan {
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

  if (ref.path) {
    const relPath = resolveReferencePath(ownerPath, ref.path);
    if (relPath !== '') return { via: 'path', relPath };
  }

  // An assetId with no row and no path is a reference into a project this one
  // cannot see — §2.8's placeholder case, reported rather than guessed at.
  return { via: 'unresolvable', reason: ref.assetId ? 'unknown-asset' : 'no-locator' };
}
