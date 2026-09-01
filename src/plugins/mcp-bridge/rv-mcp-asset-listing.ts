// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-asset-listing — the PURE half of the plan-713 Phase 2 asset tools.
 *
 * `web_document_list`, `web_document_update` and `web_editor_project_files` all
 * do the same things before they touch anything: decide whether a row matches
 * the filter, and decide whether the answer still fits in one MCP result. None
 * of those need a backend, a viewer or a document — so none of them live in a
 * tool method, where they would only ever be testable through a mock of all
 * three.
 *
 * The `library/Custom/` path whitelist that used to live here is gone with the
 * project-tree rework (2026-08-19): `web_document_update` now manages the whole
 * project root through the dashboard's own tree verdicts
 * (`canRenameInTree` / `canMoveInTree` in `rv-project-tree.ts`), which carry
 * the reserved-system-folder and validity rules themselves.
 */

/** True when two project-relative paths name the same file. */
export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Case-insensitive substring match over the fields a caller would search by.
 *
 * An empty or absent filter matches everything — F2 requires an empty library to
 * answer with an empty array rather than an error, and the same rule read the
 * other way is why "no filter" may not mean "no results".
 */
export function matchesAssetFilter(
  row: { name?: string; relPath?: string },
  filter?: string,
): boolean {
  const needle = (filter ?? '').trim().toLowerCase();
  if (!needle) return true;
  return (row.name ?? '').toLowerCase().includes(needle)
    || (row.relPath ?? '').toLowerCase().includes(needle);
}

/**
 * Match a path against a `*`/`?` glob, anchored over the WHOLE path.
 *
 * Deliberately not a full minimatch: `**` and brace expansion buy nothing for a
 * flat project listing and every one of them is another thing that can behave
 * differently from what the caller assumed. `*` crosses `/` here on purpose —
 * `*.glb` is what an agent writes when it means "every GLB anywhere", and the
 * `dir` parameter is how it narrows the folder.
 */
export function matchesGlob(path: string, glob?: string): boolean {
  const pattern = (glob ?? '').trim();
  if (!pattern) return true;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i').test(path);
}

/** True when `path` sits inside `dir` (a project-relative folder prefix). */
export function inDirectory(path: string, dir?: string): boolean {
  const d = (dir ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!d) return true;
  return path.toLowerCase().startsWith(`${d.toLowerCase()}/`);
}

/**
 * Cap a row list at the announced result budget.
 *
 * Same shape as the `QUERY_RESULT_CAP` handling in `rv-mcp-observe-tools.ts`, and
 * for the same reason: an oversized result is not a smaller result, it is a
 * result the client drops entirely. The difference is that a FILE listing has an
 * obvious narrowing — `dir` and `glob` — so the truncation says so instead of
 * only reporting a number, and the rows it does return are still valid.
 */
export function capRows<T>(
  rows: readonly T[],
  cap: number,
  hint: string,
): { rows: T[]; truncated: boolean; note?: string } {
  let kept = rows.length;
  while (kept > 0 && JSON.stringify(rows.slice(0, kept)).length > cap) {
    kept = Math.floor(kept * 0.8);
  }
  if (kept >= rows.length) return { rows: [...rows], truncated: false };
  return {
    rows: rows.slice(0, kept),
    truncated: true,
    note: `Truncated to ${kept} of ${rows.length} entries (result cap ${cap} chars). ${hint}`,
  };
}
