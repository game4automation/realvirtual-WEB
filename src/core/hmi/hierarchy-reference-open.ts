// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * hierarchy-reference-open — which document a reference row's link glyph
 * opens (the opening itself is `document-nav.ts`).
 *
 * A reference names its asset by `AssetReference.assetId`; a planner placement
 * that has not been saved yet carries the same id as `LayoutObject.CatalogId`.
 * A project asset id is `project:<project-relative path>`, which the open
 * project's manifest maps to a document id. An id that is not a document of
 * the open project (a library catalogue entry) resolves to null: there is no
 * document to open.
 */

import type { Object3D } from 'three';
import { getAssetReference } from '../engine/rv-asset-reference';
import { PROJECT_PLACEMENT_PREFIX } from '../library/rv-placement-source';
import { isQualifiedRef } from '../library/library-origin';
import { findDocumentById, findDocumentByPath } from '../project/rv-asset-identity';
import type { RvProject } from '../project/rv-project-types';

/** The asset id `object` places: its `AssetReference.assetId`, else its `LayoutObject.CatalogId`. */
export function referenceAssetIdOf(object: Object3D): string | null {
  const assetId = getAssetReference(object)?.assetId;
  if (assetId) return assetId;
  const rv = (object.userData as Record<string, unknown> | undefined)?.realvirtual as
    { LayoutObject?: { CatalogId?: unknown } } | undefined;
  const catalogId = rv?.LayoutObject?.CatalogId;
  return typeof catalogId === 'string' && catalogId !== '' ? catalogId : null;
}

/** The LIBRARY document a qualified reference places (plan-778), or null. */
export function referencedLibraryDocument(object: Object3D): { libraryProjectId: string; documentId: string } | null {
  const ref = getAssetReference(object);
  if (!ref || !isQualifiedRef(ref) || !ref.sourceId || !ref.assetId) return null;
  return { libraryProjectId: ref.sourceId, documentId: ref.assetId };
}

/** The id of the project document `object` references, or null when it is not one. */
export function referencedDocumentId(object: Object3D, project: RvProject | null | undefined): string | null {
  // plan-778 F4: a qualified reference names a document of a LIBRARY project —
  // never the open project's row that happens to share its id.
  if (isQualifiedRef(getAssetReference(object))) return null;
  const assetId = referenceAssetIdOf(object);
  if (!assetId) return null;
  if (assetId.startsWith(PROJECT_PLACEMENT_PREFIX)) {
    return findDocumentByPath(project, assetId.slice(PROJECT_PLACEMENT_PREFIX.length))?.id ?? null;
  }
  return findDocumentById(project, assetId)?.id ?? null;
}
