// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

//! Types for scripts/lib/rv-project-json.mjs (plan-587 F6). Sibling
//! declaration file, the established answer in this repo for a .mjs imported
//! from a .ts test.

export type MtimeRounding = 'floor' | 'round';

export interface DocumentRow {
  id?: string;
  path?: string;
  name?: string;
  section?: string;
  scriptRef?: string;
  sizeBytes?: number;
  mtimeMs?: number;
  sha256?: string;
  modifiedAt?: string;
  [key: string]: unknown;
}

export interface ProjectManifest {
  documents?: DocumentRow[];
  [key: string]: unknown;
}

export type DocumentSelector = { id: string; path?: undefined } | { path: string; id?: undefined };

export interface UpdateDocumentRowOptions {
  //! The file whose size / mtime / sha256 are stamped onto the row.
  glbPath: string;
  //! Required on purpose — the two callers round differently.
  mtimeRounding: MtimeRounding;
  removeScriptRef?: boolean;
  //! `true` = `new Date().toISOString()`, a string = that string verbatim.
  setModifiedAt?: boolean | string;
  ifMissing?: 'throw' | 'ignore';
  trailingNewline?: 'preserve' | 'none' | 'always';
}

export declare function findDocumentRow(
  manifest: ProjectManifest | null | undefined,
  selector: DocumentSelector,
): DocumentRow | null;

export declare function updateDocumentRow(
  projectJsonPath: string,
  selector: DocumentSelector,
  options: UpdateDocumentRowOptions,
): DocumentRow | null;
