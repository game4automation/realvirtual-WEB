// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-glb-reference-resolver — the production {@link ReferenceResolver}: how an
 * `AssetReference` turns into verified bytes.
 *
 * Kept out of `rv-glb-compose.ts` on purpose. Composition is a pure tree
 * operation and must stay testable without a network, a library registry or
 * WebCrypto; the policy of *where an asset comes from* belongs here, next to the
 * registry that owns that question.
 *
 * ## The order, and why it is that order
 *
 * 1. **`assetId` through the library registry.** The stable identity. A file
 *    renamed or moved inside a library still resolves.
 * 2. **`assetId` through the open project's manifest `documents[]`.** The other
 *    half of F12: the tree-move writer repoints exactly this row, and the
 *    library registry only lists `library/` — a GLB moved under `models/` or
 *    `scenes/` is findable ONLY here. Without this step, "a move breaks no
 *    reference" was true in the manifest and false at load time.
 * 3. **`path`, relative to the CONTAINING file.** The fallback for a plain
 *    folder of GLBs with no catalog at all.
 * 4. Nothing — reported as a miss, never an exception, so one unavailable
 *    library does not take the whole scene down with it.
 *
 * `sha256` is deliberately not a resolution key. The user decided that library
 * corrections must reach every referencing plant; a hash key would pin each
 * file to the bytes it last saw and quietly defeat that.
 *
 * Every resolved file goes through {@link verifyRvSigBuffer}, so a referenced
 * asset carries its OWN signature state into the trust chain (§2.9) instead of
 * silently inheriting the root's.
 */

import type { ReferenceResolver, ResolvedReference } from './rv-glb-compose';
import type { AssetReference } from './rv-asset-reference';
import { listLibrarySources, type ResolvedAsset } from '../library/library-source-registry';
import { verifyRvSigBuffer } from '../persistence/rv-sig-verify';
import { sha256Hex } from '../import/rv-cad-glb-cache';
import { debug } from './rv-debug';

/** Fetch a URL as bytes, or null when the URL does not serve a file. */
async function fetchBytes(url: string): Promise<ArrayBuffer | null> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (e) {
    debug('loader', `[compose] fetch failed for ${url}: ${String(e)}`);
    return null;
  }
  if (!response.ok) {
    debug('loader', `[compose] fetch returned ${response.status} for ${url}`);
    return null;
  }
  return response.arrayBuffer();
}

/**
 * Find an asset id in ANY registered source.
 *
 * `providerId`/`sourceId` on the reference narrow the search when present, but
 * are not required to match: a library that was reorganised — or a scene opened
 * on a machine where the same catalog is registered under a different provider —
 * must still resolve, which is the entire reason identity is the asset id.
 */
async function resolveThroughLibrary(ref: AssetReference): Promise<{ resolved: ResolvedAsset; url: string } | null> {
  if (!ref.assetId) return null;
  const sources = listLibrarySources();
  const preferred = sources.filter(
    (s) => (!ref.providerId || s.providerId === ref.providerId) && (!ref.sourceId || s.source.id === ref.sourceId),
  );
  for (const { source } of [...preferred, ...sources]) {
    if (!source.getEntry(ref.assetId)) continue;
    try {
      const resolved = await source.resolveAsset(ref.assetId, 'place');
      return { resolved, url: resolved.url };
    } catch (e) {
      debug('loader', `[compose] source "${source.id}" failed to resolve "${ref.assetId}": ${String(e)}`);
    }
  }
  return null;
}

/**
 * Find an asset id in the OPEN PROJECT's manifest and resolve its row's path
 * through the project backend.
 *
 * Dynamic imports on purpose: the engine must not statically depend on the
 * project store (same lazy-seam idiom as `scene-store`'s bake imports), and
 * this resolver is already async. Best-effort throughout — no project, no
 * backend, no row, or an unreadable file all mean "not found here", never an
 * exception.
 */
async function resolveThroughProjectManifest(assetId: string): Promise<string | null> {
  try {
    const [{ getProjectStore }, { findDocumentById }] = await Promise.all([
      import('../project/project-store'),
      import('../project/rv-asset-identity'),
    ]);
    const store = getProjectStore();
    const project = store.getProject();
    if (!project) return null;
    const row = findDocumentById(project, assetId);
    if (!row?.path) return null;
    return await store.resolveAssetUrl(row.path);
  } catch (e) {
    debug('loader', `[compose] manifest lookup failed for "${assetId}": ${String(e)}`);
    return null;
  }
}

/**
 * The resolver `loadGLB` uses.
 *
 * A blob URL handed out by a library source is revoked as soon as the bytes are
 * in hand: the caller owns the URL per the registry's contract, and holding it
 * for the lifetime of the model is the leak that contract exists to prevent.
 * The URL is still reported back, because it is the base for the referenced
 * file's own relative references (F18) — a revoked blob URL is a fine base, it
 * just resolves to nothing, which is what a blob-sourced asset with relative
 * children deserves.
 */
export function createReferenceResolver(): ReferenceResolver {
  return async (ref, context): Promise<ResolvedReference | null> => {
    let bytes: ArrayBuffer | null = null;
    let url = '';

    const viaLibrary = await resolveThroughLibrary(ref);
    if (viaLibrary) {
      url = viaLibrary.url;
      bytes = await fetchBytes(url);
      viaLibrary.resolved.revokeUrl?.();
    }

    // The manifest row the tree-move writer keeps honest (F12). Checked after
    // the registry (which covers `library/`) and before the raw path — a moved
    // file's old path is exactly what must NOT win here.
    if (!bytes && ref.assetId) {
      const viaManifest = await resolveThroughProjectManifest(ref.assetId);
      if (viaManifest) {
        url = viaManifest;
        bytes = await fetchBytes(url);
      }
    }

    if (!bytes && context.resolvedPath) {
      url = context.resolvedPath;
      bytes = await fetchBytes(url);
    }

    if (!bytes) return null;

    const verified = await verifyRvSigBuffer(bytes);
    return {
      bytes: verified.buffer,
      url,
      sha256: await sha256Hex(verified.buffer),
      signatureState: verified.state,
      signaturePresent: verified.signaturePresent,
    };
  };
}
