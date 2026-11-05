// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * library-reference-requalify — plan-780 A3: a copied document's unqualified
 * references name the SOURCE project's documents (contract documents-projects 4),
 * so the copy command qualifies them. JSON chunk only, computed before any write
 * (no partial file); opening a copy writes nothing (node-identity 2). No change = same bytes.
 */

import { parseGlbChunks, rebuildGlbWithJson } from '../persistence/rv-glb-chunks';
import { LIBRARY_PROJECTS_PROVIDER_ID, hasLegacyHint, isQualifiedRef, resolveDocumentRef } from './library-origin';

/** The result of {@link requalifyCopiedReferences}. */
export interface RequalifiedBytes {
  bytes: Uint8Array;
  /** How many references were rewritten (0 = `bytes` is the input, unchanged). */
  rewritten: number;
}

/** Qualify the unqualified references of `bytes` into `sourceProjectId`; throws only on a non-GLB. */
export function requalifyCopiedReferences(bytes: Uint8Array, sourceProjectId: string): RequalifiedBytes {
  const chunks = parseGlbChunks(bytes);
  const nodes = Array.isArray(chunks.json.nodes) ? chunks.json.nodes as Array<Record<string, unknown>> : [];
  const scope = { providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: sourceProjectId };
  let rewritten = 0;
  for (const node of nodes) {
    const extras = node.extras as Record<string, unknown> | undefined;
    const rv = extras?.realvirtual as Record<string, unknown> | undefined;
    const ref = rv?.AssetReference as Record<string, unknown> | undefined;
    if (!ref || typeof ref.assetId !== 'string' || ref.assetId === '') continue;
    const asRef = { providerId: ref.providerId as string | undefined, sourceId: ref.sourceId as string | undefined };
    if (isQualifiedRef(asRef) || hasLegacyHint(asRef)) continue;
    const r = resolveDocumentRef({ catalogId: ref.assetId }, scope);
    if ('hit' in r && r.hit.registered.providerId === LIBRARY_PROJECTS_PROVIDER_ID) {
      ref.assetId = r.hit.entry.id;
      ref.providerId = LIBRARY_PROJECTS_PROVIDER_ID;
      ref.sourceId = r.hit.registered.source.id;
    } else {
      // Not answerable now — still the source's document: qualify as written.
      ref.providerId = LIBRARY_PROJECTS_PROVIDER_ID;
      ref.sourceId = sourceProjectId;
    }
    delete ref.path;
    rewritten++;
  }
  if (rewritten === 0) return { bytes, rewritten: 0 };
  return { bytes: rebuildGlbWithJson(chunks), rewritten };
}
