// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-doc-node-map — the inverted "which parts does this document describe?" index
 * (plan-284 F9). Node→document links live at each node (`_rvPdfLinks`, populated by
 * the docs-link plugins); this module inverts them into document → node paths so a
 * cited RAG source can be shown as clickable "Affected parts" chips that focus the
 * 3D scene.
 *
 * The index is built lazily by traversing the current scene and cached against the
 * scene identity, so it rebuilds automatically after a model load/clear with no
 * event wiring. Matching is normalized (full relative path, file basename, and
 * basename-without-extension, all lower-cased) because a CONNECT source url
 * (`docs/<file>`) and the GLB-side `_rvPdfLinks` url (`<assetsBase>/<file>`) share
 * only the file name, and a cited source's `title` is exactly that basename.
 */

import { normalizeDocRef } from '../hmi/search-ai-context';

/** Minimal view of the viewer needed to build the index — RVViewer satisfies it. */
export interface DocNodeMapViewer {
  scene: { traverse(callback: (object: SceneObjectLike) => void): void } | null;
  registry: { getPathForNode(node: unknown): string | null | undefined } | null;
}

interface SceneObjectLike {
  userData?: Record<string, unknown>;
}

/** A cited source to resolve to nodes — the fields of a DiagnoseSource we can match on. */
export interface DocSourceRef {
  url?: string;
  title?: string;
}

/** Lower-cased match keys for a document reference: full path, basename, basename-no-ext. */
export function docMatchKeys(ref: string): string[] {
  const norm = normalizeDocRef(ref).toLowerCase();
  if (!norm) return [];
  const base = norm.split('/').pop() ?? norm;
  const noExt = base.replace(/\.[^.]+$/, '');
  return Array.from(new Set([norm, base, noExt].filter((k) => k.length > 0)));
}

type DocNodeIndex = Map<string, Set<string>>;

/** Builds the document-key → node-paths index by traversing the scene once. */
export function buildDocNodeIndex(viewer: DocNodeMapViewer): DocNodeIndex {
  const index: DocNodeIndex = new Map();
  const scene = viewer.scene;
  const registry = viewer.registry;
  if (!scene || !registry) return index;

  scene.traverse((object) => {
    const links = object.userData?._rvPdfLinks as Array<{ source?: { url?: string } }> | undefined;
    if (!Array.isArray(links) || links.length === 0) return;
    const path = registry.getPathForNode(object);
    if (!path) return;
    for (const link of links) {
      const url = link?.source?.url;
      if (!url) continue;
      for (const key of docMatchKeys(url)) {
        let set = index.get(key);
        if (!set) index.set(key, (set = new Set()));
        set.add(path);
      }
    }
  });
  return index;
}

let _cacheToken: unknown = null;
let _cacheIndex: DocNodeIndex = new Map();

/** Cached index for the current scene (rebuilds when the scene identity changes). */
function indexFor(viewer: DocNodeMapViewer): DocNodeIndex {
  const token = viewer.scene;
  if (token !== _cacheToken) {
    _cacheToken = token;
    _cacheIndex = buildDocNodeIndex(viewer);
  }
  return _cacheIndex;
}

/**
 * Node paths whose linked documentation matches the cited source (by url and/or
 * title). Empty when nothing links to it — the caller then shows no chips.
 */
export function nodesForSource(viewer: DocNodeMapViewer, source: DocSourceRef): string[] {
  const index = indexFor(viewer);
  if (index.size === 0) return [];
  const keys = new Set<string>();
  if (source.url) for (const k of docMatchKeys(source.url)) keys.add(k);
  if (source.title) keys.add(source.title.trim().toLowerCase());

  const paths = new Set<string>();
  for (const key of keys) {
    const set = index.get(key);
    if (set) for (const p of set) paths.add(p);
  }
  return Array.from(paths);
}

/** Node paths for a set of cited sources, de-duplicated across all of them. */
export function nodesForSources(viewer: DocNodeMapViewer, sources: readonly DocSourceRef[]): string[] {
  const paths = new Set<string>();
  for (const source of sources) for (const p of nodesForSource(viewer, source)) paths.add(p);
  return Array.from(paths);
}

/** Test/hot-reload hook: drop the cached index so the next lookup rebuilds. */
export function resetDocNodeIndexCache(): void {
  _cacheToken = null;
  _cacheIndex = new Map();
}
