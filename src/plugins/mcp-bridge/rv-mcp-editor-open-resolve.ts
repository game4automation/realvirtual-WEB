// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Resolve the `relPath` of `web_editor_open(source=library)` onto a document of
 * the open project — pure, so it can be pinned without a viewer.
 *
 * ## Why this exists
 *
 * The tool used to build the pending open as `library/<relPath>` unconditionally.
 * A document that lives anywhere else — the project root is the usual place
 * since plan-744 made `library/Custom` stop being the save fallback — was then
 * addressed at a path that does not exist. The editor's load failed silently and
 * the tool polled for an active document until its own 120 s timeout, which
 * read as "the tool hangs" while the dashboard opened the same file instantly
 * (2026-09-22, sidecutter.glb at the project root).
 *
 * The dashboard opens by ROW: `documentBase(row.id, row.name, row.path)`. This
 * resolver finds that row for every spelling an agent plausibly passes, and the
 * tool then opens exactly what the UI would.
 *
 * ## Accepted spellings, in order
 *
 * 1. `library/<relPath>` — the documented library-relative form, kept first so
 *    an existing `Custom/MyAsset.glb` call keeps meaning the same file even when
 *    a root-level document shares its file name.
 * 2. `<relPath>` as a project-relative path (`sidecutter.glb`, `models/A.glb`),
 *    also with a `project:` prefix — the same address form `web_layout_place`
 *    already takes.
 * 3. A document id (`doc_…`), exactly as `web_document_list` prints it.
 * 4. A document name, matched like `web_document_open` matches it: case- and
 *    separator-insensitive, with or without `.glb`.
 *
 * Paths compare case-insensitively with separators normalised, so `Custom\A.glb`
 * and `/custom/a.glb` reach the same row; a match on rule 1 or 2 wins over a
 * name collision on rule 4.
 */

import type { RvDocumentEntry } from '../../core/project/rv-project-types';

/** Normalise a project-relative path for comparison: forward slashes, no leading `/`, lower case. */
export function normalisePath(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

/** The loose key `web_document_open` uses for names. */
function nameKey(s: string): string {
  return s.toLowerCase().replace(/\.glb$/i, '').replace(/[\s_-]+/g, '');
}

/**
 * The document `relPath` names, or `null` when no row matches.
 *
 * `rows` is the project's document list (`documentsOf(project)`); an empty list
 * yields `null` for every input, and the caller decides whether that means
 * "no project" (fall back) or "not found" (refuse).
 */
export function resolveEditorOpenDocument(
  relPath: string,
  rows: readonly RvDocumentEntry[],
): RvDocumentEntry | null {
  const raw = (relPath ?? '').trim();
  if (!raw || rows.length === 0) return null;

  const explicitProject = /^project:/i.test(raw);
  const bare = normalisePath(explicitProject ? raw.slice('project:'.length) : raw);
  if (!bare) return null;

  const byPath = (wanted: string): RvDocumentEntry | null =>
    rows.find((d) => normalisePath(d.path ?? '') === wanted) ?? null;

  // 1. Library-relative, unless the caller said `project:` explicitly.
  if (!explicitProject && !bare.startsWith('library/')) {
    const hit = byPath(`library/${bare}`);
    if (hit) return hit;
  }
  // 2. Project-relative as written.
  const direct = byPath(bare);
  if (direct) return direct;
  // 3. Document id, verbatim.
  const byId = rows.find((d) => d.id === raw);
  if (byId) return byId;
  // 4. Name — only for a bare token, a slash means the caller meant a path.
  if (!bare.includes('/')) {
    const key = nameKey(bare);
    const byName = rows.find((d) => nameKey(d.name ?? '') === key);
    if (byName) return byName;
  }
  return null;
}
