// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * library-reference-write — the ONE writer rule of a stored reference (plan-780
 * R4/R4a/D1/A2, contract documents-projects 4, node-identity 1/11): same project →
 * `{ assetId }`, other project → qualified, never a path beside an id. Legacy forms
 * upgrade only when their source is ready, else byte-identical + Problems row.
 */

import { reportProblem } from '../hmi/problems-store';
import {
  hasLegacyHint,
  isQualifiedRef,
  LIBRARY_PROJECTS_PROVIDER_ID,
  OPEN_PROJECT_PROVIDER_ID,
  resolveDocumentRef,
  sameScope,
  type DocumentScope,
} from './library-origin';

/** Structural subset of `PlacedComponent`. */
export interface ReferenceWriteInput {
  catalogId: string;
  glbUrl?: string;
  providerId?: string;
  sourceId?: string;
}

/** The written `AssetReference` fields (bounds etc. are the caller's). */
export interface WrittenReference {
  assetId: string;
  providerId?: string;
  sourceId?: string;
  path?: string;
}

/** Problem code of a legacy reference written as it was (R4a). */
export const REFERENCE_NOT_UPGRADED_CODE = 'reference-not-upgraded';

/** Is `ref` an OLD library form — the ones D1 upgrades on save? */
export function isLegacyLibraryForm(ref: ReferenceWriteInput): boolean {
  return ref.catalogId.startsWith('project:') || hasLegacyHint(ref);
}

/** The reference to write for `ref` in a document of `scope`; pure apart from the R4a row, never throws. */
export function referenceForWrite(ref: ReferenceWriteInput, scope: DocumentScope): WrittenReference {
  const catalogId = ref.catalogId ?? '';
  const asWritten = (): WrittenReference => {
    const out: WrittenReference = { assetId: catalogId };
    if (ref.providerId) out.providerId = ref.providerId;
    if (ref.sourceId) out.sourceId = ref.sourceId;
    // No path on a qualified ref (plan-778 F4); blob: urls never persist (plan-921).
    if (!isQualifiedRef(ref) && ref.glbUrl && !ref.glbUrl.startsWith('blob:')) out.path = ref.glbUrl;
    return out;
  };
  if (!catalogId) return asWritten();

  const r = resolveDocumentRef({ catalogId, providerId: ref.providerId, sourceId: ref.sourceId }, scope);
  if ('hit' in r) {
    const { providerId, source } = r.hit.registered;
    if (providerId === LIBRARY_PROJECTS_PROVIDER_ID) {
      // Canonical id; an alias is read, never written.
      const assetId = r.hit.entry.id;
      if (scope && sameScope(scope, { providerId, sourceId: source.id })) return { assetId };   // A2
      return { assetId, providerId, sourceId: source.id };
    }
    if (providerId === OPEN_PROJECT_PROVIDER_ID) {
      const documentId = r.hit.entry.documentId
        ?? (r.hit.assetId.startsWith('project:') ? null : r.hit.assetId);
      if (documentId) return { assetId: documentId };
    }
    // An external catalog (not a project): its classic form.
    return asWritten();
  }
  if (isLegacyLibraryForm(ref) && !isQualifiedRef(ref)) {
    // R4a: not upgradable now — written byte-identical, and said so.
    const why = 'missing' in r ? r.reason : 'its library is still loading';
    reportProblem({
      id: `${REFERENCE_NOT_UPGRADED_CODE}:${catalogId}`,
      severity: 'warning',
      code: REFERENCE_NOT_UPGRADED_CODE,
      title: `Reference not upgraded: ${catalogId}`,
      detail: `The old reference "${catalogId}" was saved as it was — ${why}. It is upgraded to its document id on a save once its library is available.`,
    });
  }
  return asWritten();
}
