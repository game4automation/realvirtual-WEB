// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Type declarations for `_rv-manifest.mjs` (see `_rv-guards.d.mts`). */

export type RvDocumentSection = 'scenes' | 'models' | 'library';

export interface RvManifestDocument {
  id?: string;
  path: string;
  name?: string;
  section?: string;
  classification?: { v?: number; level?: string; tags?: string[] };
  [key: string]: unknown;
}

export interface RvDocumentsMarker {
  at: string;
  schemaVersion: number;
  counts: Record<string, number>;
}

export const DOCUMENT_SECTIONS: readonly RvDocumentSection[];
export const DOCUMENTS_MIGRATION_MARKER: string;
export const LEGACY_DOCUMENT_KEYS: readonly string[];

export function sectionOfDocument(entry: unknown): RvDocumentSection;
export function documentsOf(manifest: unknown): RvManifestDocument[];
export function documentsInSection(manifest: unknown, section: RvDocumentSection): RvManifestDocument[];

export function stableDocumentId(path: string): string;
export function documentOfLegacyEntry(entry: RvManifestDocument, section: RvDocumentSection): RvManifestDocument;
export function withoutLegacyArrays<T>(manifest: T): T;
export function withDerivedDocuments<T>(manifest: T): T;
export function deriveDocuments(
  manifest: unknown, options?: { now?: string },
): { documents: RvManifestDocument[]; existing: number; marker: RvDocumentsMarker } | null;

// ─── Reference fields (plan-718) ────────────────────────────────────────

export type RvDocumentRefField = 'connectRef' | 'scriptRef' | 'knowledgeRef';

export interface RvDocumentRef {
  documentId: string;
  documentPath: string;
  field: RvDocumentRefField;
  ref: string;
  contained: boolean;
}

export interface RvPluginModuleDeclaration {
  scriptRef: string;
  models: string[];
}

export interface RvScriptRefCaseMismatch {
  declared: string;
  scriptRef: string;
  documentId?: string;
  documentPath?: string;
}

export interface RvScriptRefMarker {
  at: string;
  schemaVersion: number;
  assigned: number;
  assignedIds: string[];
  caseMismatches: RvScriptRefCaseMismatch[];
}

export const DOCUMENT_REF_FIELDS: readonly RvDocumentRefField[];
export const DEFAULT_SECRETS_REF: string;
export const SCRIPT_REF_MIGRATION_MARKER: string;

export function normalizeRefPath(ref: unknown): string;
export function isContainedRef(ref: unknown): boolean;
export function readDocumentRef(entry: unknown, field: RvDocumentRefField): string | null;
export function documentRefsOf(manifest: unknown): RvDocumentRef[];
export function projectConnectRefs(manifest: unknown): { agentsRef: string | null; secretsRef: string };
export function modelNameOfPath(path: unknown): string;
export function deriveScriptRefs(
  manifest: unknown,
  modules: RvPluginModuleDeclaration[],
  options?: { now?: string },
): {
  documents: RvManifestDocument[];
  assigned: Array<{ declared: string; scriptRef: string; documentId?: string; documentPath?: string }>;
  caseMismatches: RvScriptRefCaseMismatch[];
  marker: RvScriptRefMarker;
} | null;
