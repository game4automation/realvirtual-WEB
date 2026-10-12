// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-model-index — the storage-free half of the cross-project model index
 * (plan-509 Phase 1).
 *
 * The Projects screen searches the models of EVERY linked project, but a linked
 * folder is usually not readable without a permission prompt after a browser
 * restart, and listing must never prompt (plan-743). So the search runs over a
 * persisted SNAPSHOT per project — its document list as last seen — written
 * whenever a project is open and its list changes.
 *
 * Same split as the recents ring (`rv-project-recents.ts` vs
 * `rv-project-recents-store.ts`): this module decides WHAT a snapshot looks
 * like from values; `rv-model-index-store.ts` is the one place snapshots meet
 * IndexedDB. Every function here is pure: `updatedAt` is handed in, so a test
 * can state it.
 *
 * ## Identity is the pair
 *
 * A snapshot is keyed `<backend>:<projectId>`, never by the id alone: the
 * shipped demo exists under one id both as the bundled project AND as a linked
 * folder (`open-project-by-id.ts`), and unlinking the folder must not take the
 * bundled snapshot with it.
 */

import type { RvDocumentEntry } from './rv-project-types';
import type { RecentBackend } from './rv-project-recents';

export const MODEL_INDEX_SCHEMA_VERSION = 1;

/** Where a snapshotted project's bytes live — the recents vocabulary. */
export type ModelIndexBackend = RecentBackend;

/** One document of a snapshot — only what the search matches and opens by. */
export interface ModelIndexDoc {
  /** `RvDocumentEntry.id` — what the open chain looks up. */
  id: string;
  name: string;
  /** Project-relative, `/`-separated; the breadcrumb is its folder part. */
  path: string;
  /** `classification.tags`, `[]` when unclassified. */
  tags: string[];
  /** The row's DECLARED workspace mode — the open chain's exit guards need it. */
  mode?: string;
}

export interface ModelIndexSnapshot {
  version: typeof MODEL_INDEX_SCHEMA_VERSION;
  projectId: string;
  /** Name when last seen. Display fallback only — the project list wins. */
  projectName: string;
  backend: ModelIndexBackend;
  /** ISO timestamp of the write. Never part of the signature. */
  updatedAt: string;
  /**
   * Who wrote it: a live `open` project, or the bundled `manifest` read on the
   * Projects screen. Optional — a snapshot without it counts as `open`. A
   * manifest read never replaces an `open` snapshot: the live list also
   * carries the user tier the HTTP manifest cannot know about.
   */
  source?: 'open' | 'manifest';
  docs: ModelIndexDoc[];
}

/** The IndexedDB key of a snapshot. */
export function modelIndexKey(backend: ModelIndexBackend, projectId: string): string {
  return `${backend}:${projectId}`;
}

/** The key of an existing snapshot. */
export function snapshotKey(snapshot: Pick<ModelIndexSnapshot, 'backend' | 'projectId'>): string {
  return modelIndexKey(snapshot.backend, snapshot.projectId);
}

function docOf(entry: Pick<RvDocumentEntry, 'id' | 'name' | 'path' | 'classification' | 'mode'>): ModelIndexDoc {
  const doc: ModelIndexDoc = {
    id: entry.id,
    name: entry.name,
    path: entry.path,
    tags: Array.isArray(entry.classification?.tags)
      ? entry.classification!.tags!.filter((t): t is string => typeof t === 'string')
      : [],
  };
  if (typeof entry.mode === 'string' && entry.mode) doc.mode = entry.mode;
  return doc;
}

/** A snapshot of one project's document list. */
export function snapshotFromDocuments(
  project: { id: string; name: string },
  backend: ModelIndexBackend,
  documents: readonly Pick<RvDocumentEntry, 'id' | 'name' | 'path' | 'classification' | 'mode'>[],
  updatedAt: string,
  source: 'open' | 'manifest' = 'open',
): ModelIndexSnapshot {
  return {
    version: MODEL_INDEX_SCHEMA_VERSION,
    projectId: project.id,
    projectName: project.name,
    backend,
    updatedAt,
    source,
    docs: documents
      .filter(d => typeof d?.id === 'string' && d.id !== '' && typeof d.path === 'string')
      .map(docOf),
  };
}

/**
 * What a write is compared by: the project name plus `id|name|path|tags|mode`
 * per document, sorted — so a reorder is no change, while a rename, a move, a
 * tag edit, a mode edit or a renamed project is one.
 */
export function signatureOf(snapshot: Pick<ModelIndexSnapshot, 'projectName' | 'docs'>): string {
  const rows = snapshot.docs.map(d =>
    [d.id, d.name, d.path, d.tags.join(','), d.mode ?? ''].join('|'));
  rows.sort();
  return `${snapshot.projectName}\n${rows.join('\n')}`;
}

function isBackend(v: unknown): v is ModelIndexBackend {
  return v === 'folder' || v === 'browser' || v === 'bundled';
}

function parseDoc(raw: unknown): ModelIndexDoc | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id === '') return null;
  if (typeof r.name !== 'string' || typeof r.path !== 'string') return null;
  const doc: ModelIndexDoc = {
    id: r.id,
    name: r.name,
    path: r.path,
    tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === 'string') : [],
  };
  if (typeof r.mode === 'string' && r.mode) doc.mode = r.mode;
  return doc;
}

/**
 * A stored value as a snapshot, or null. Never throws.
 *
 * A wrong version is a discarded snapshot, not an error: the index is a cache
 * the next project open rebuilds. Broken documents are dropped one by one, so
 * one bad row does not cost the project its whole entry.
 */
export function parseSnapshot(raw: unknown): ModelIndexSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== MODEL_INDEX_SCHEMA_VERSION) return null;
  if (typeof r.projectId !== 'string' || r.projectId === '') return null;
  if (!isBackend(r.backend)) return null;
  if (!Array.isArray(r.docs)) return null;
  const docs: ModelIndexDoc[] = [];
  for (const d of r.docs) {
    const doc = parseDoc(d);
    if (doc) docs.push(doc);
  }
  return {
    version: MODEL_INDEX_SCHEMA_VERSION,
    projectId: r.projectId,
    projectName: typeof r.projectName === 'string' ? r.projectName : r.projectId,
    backend: r.backend,
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : '',
    ...(r.source === 'manifest' || r.source === 'open' ? { source: r.source } : {}),
    docs,
  };
}
