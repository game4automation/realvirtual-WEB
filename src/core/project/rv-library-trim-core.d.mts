// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Type declarations for rv-library-trim-core.mjs (plan-778 Phase 4). */

export const LIBRARY_PROJECTS_PROVIDER_ID: 'library-projects';
export const OPEN_PROJECT_PROVIDER_ID: 'project';
export const REALVIRTUAL_LIBRARY_PROJECT_ID: 'prj_realvirtual_library';
export const DELIVERED_LIBRARIES_FOLDER: 'libraries';
export const MAX_LIBRARY_DEPTH: number;
export const GLB_JSON_CHUNK_OFFSET: number;

export type TrimManifest = Record<string, unknown> & {
  id?: unknown;
  documents?: unknown;
  libraries?: unknown;
};

export interface TrimDocumentRow extends Record<string, unknown> {
  id: string;
  path: string;
  thumbnail?: string;
  settingsPath?: string;
  aliases?: string[];
}

export interface TrimAssetReference {
  assetId: string;
  providerId: string | null;
  sourceId: string | null;
  path: string | null;
  splat: boolean;
}

export interface TrimReadResult { json: Record<string, unknown> | null }

export interface TrimLibrarySource<S = unknown> {
  manifest: TrimManifest;
  readDocument(path: string): TrimReadResult | null | Promise<TrimReadResult | null>;
  /** Anything the caller needs to copy the files afterwards (a folder, a handle, a backend). */
  [key: string]: unknown;
}

export interface TrimmedLibrary {
  projectId: string;
  neededBy: string[];
  /** The trimmed `project.json` to write (hints of shipped libraries rewritten). */
  manifest: TrimManifest;
  documentIds: string[];
  /** Library-relative files to copy unchanged: documents, thumbnails, settings sidecars. */
  files: string[];
  source: TrimLibrarySource;
}

export type LibraryTrimErrorCode =
  | 'library-id-invalid'
  | 'library-depth'
  | 'library-unresolvable'
  | 'library-id-mismatch'
  | 'library-not-listed'
  | 'document-unresolvable'
  | 'document-file-missing';

export interface LibraryTrimError {
  code: LibraryTrimErrorCode;
  message: string;
  projectId?: string;
  document?: string;
  assetId?: string;
  neededBy?: string[];
}

export interface LegacyLibraryRef {
  document: string;
  assetId: string;
  providerId: string | null;
  sourceId: string | null;
  path: string | null;
  resolvesIn?: string;
}

export interface LibraryTrimPlan {
  projectId: string;
  /** The project's own manifest with the hints of shipped libraries rewritten (the delivered copy). */
  manifest: TrimManifest;
  libraries: TrimmedLibrary[];
  realvirtualLibraryUsed: boolean;
  legacyRefs: LegacyLibraryRef[];
  errors: LibraryTrimError[];
}

export interface LibraryTrimInput {
  manifest: TrimManifest;
  readDocument(path: string): TrimReadResult | null | Promise<TrimReadResult | null>;
  openLibrary(projectId: string): TrimLibrarySource | null | Promise<TrimLibrarySource | null>;
  realvirtualLibrary?: TrimManifest | null;
  maxDepth?: number;
}

export function normalizeLibraryPath(path: unknown): string;
export function isContainedPath(path: unknown): boolean;
export function libraryProjectIdProblem(projectId: unknown): string | null;
export function deliveredLibraryHint(projectId: string): string;
export function libraryEntriesOf(manifest: unknown): Array<Record<string, unknown>>;
export function listedLibraryIds(manifest: unknown): string[];
export function documentRowsOf(manifest: unknown): TrimDocumentRow[];
export function glbJsonChunkLength(headerBytes: Uint8Array | ArrayBuffer): number | null;
export function parseGlbJson(bytes: Uint8Array | ArrayBuffer): Record<string, unknown> | null;
export function collectAssetReferences(json: unknown): TrimAssetReference[];
export function isLibraryQualified(ref: { providerId?: string | null; sourceId?: string | null } | null | undefined): boolean;
export function rowFiles(row: TrimDocumentRow): string[];
export function withDeliveredLibraryHints<M extends TrimManifest>(manifest: M, shippedIds: Iterable<string>): M;
export function trimmedLibraryManifest(manifest: TrimManifest, usedRows: TrimDocumentRow[], shippedIds: Iterable<string>): TrimManifest;
export const TRIMMED_MANIFEST_FIELDS: readonly string[];
export function isBundledCatalogUrl(url: unknown): boolean;
export function bundledCatalogEntryCount(manifest: unknown): number;
export function planLibraryTrim(input: LibraryTrimInput): Promise<LibraryTrimPlan>;
/** The same algorithm for synchronous readers (the Node staging helpers). */
export function planLibraryTrimSync(input: LibraryTrimInput): LibraryTrimPlan;
export function formatLibraryTrimErrors(errors: LibraryTrimError[]): string;
