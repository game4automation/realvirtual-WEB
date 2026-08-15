// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * dashboard-documents — the dashboard's readers of THE one list (plan-716 §2.7).
 *
 * ## Why these three functions exist at all
 *
 * `ProjectsDashboardHost` had four readers of `project.scenes` left after
 * plan-413 moved the rest onto `project.documents`: the open verb, the detail
 * pane, and the "new project from…" picker. Four readers of a second list is
 * how a screen ends up describing two worlds — a row that opens but has no
 * detail pane, a picker that cannot see half of what the tree shows.
 *
 * They are lifted OUT of the host rather than fixed in place because the host
 * is 2500 lines of React that no test can render cheaply. A pure function over
 * `TieredDocumentEntry[]` is the same logic with a test that costs nothing, and
 * `tests/dashboard-one-list.test.tsx` is that test.
 *
 * ## The role is a place, not a type (F8)
 *
 * `section` says which folder holds the bytes — `scenes/`, `models/`,
 * `library/`. Since plan-716 that is ALL it says: every one of them is a GLB
 * document, every one of them opens, and every one of them is placeable into
 * any other (F7). So the badge names the place and stops there; it must never
 * grow back into a type distinction the storage layer no longer makes.
 */

import type { TieredDocumentEntry } from '../../project/rv-project-tiers';
import { DEFAULT_DOCUMENT_FOLDER } from '../../project/rv-document-ops';

/** One row of the "pick documents" list a create-from dialog renders. */
export interface DocumentPickOption {
  id: string;
  name: string;
}

/**
 * The document a selection or an open verb names, or undefined.
 *
 * Matches on `id` only. A path fallback would look tolerant and be wrong: two
 * documents can share a path across tiers (a fork shadowing its bundled
 * original), and the caller always has the id — it came out of this very list.
 */
export function documentById(
  documents: readonly TieredDocumentEntry[],
  id: string | null | undefined,
): TieredDocumentEntry | undefined {
  if (!id) return undefined;
  return documents.find(d => d.id === id);
}

/**
 * Badge text for a document's PLACE — the folder its path actually names.
 *
 * The path's directory with a trailing slash, and nothing at all for a
 * document in the project root. A folder name, not a noun: "Scene" / "Base
 * model" / "Library asset" are TYPE names for a distinction the storage layer
 * stopped making, and the label sweep (plan-413) already banned "Model" from
 * this dashboard's user-facing strings.
 *
 * It used to render the legacy SECTION (`sectionOfDocument`), whose fallback
 * is `library` — which branded every root document "library/" although no such
 * folder was involved (field finding 2026-08-14). The badge now states where
 * the file is, which for the root is nowhere worth a chip.
 */
export function documentRoleBadge(
  doc: { section?: unknown; path?: unknown } | null | undefined,
): string {
  if (!doc || typeof doc.path !== 'string') return '';
  const dir = doc.path.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
  return dir ? `${dir}/` : '';
}

/**
 * Badge for WHAT the file is — its extension, spelled the way a user reads a
 * file type: `GLB`, `PDF`, `STEP`. It replaces the subtitle word "Document",
 * which said nothing the row's presence did not already say.
 */
export function documentTypeBadge(
  doc: { path?: unknown } | null | undefined,
): string {
  if (!doc || typeof doc.path !== 'string') return '';
  const leaf = doc.path.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = leaf.lastIndexOf('.');
  return dot > 0 ? leaf.slice(dot + 1).toUpperCase() : '';
}

/**
 * Every document of the project as a pickable row, in manifest order.
 *
 * All sections, deliberately: "new project from what I have" means everything
 * the project owns, and the dialog that consumes this used to show the scene
 * third of it while the tree beside it showed all three.
 */
export function documentPickOptions(
  documents: readonly TieredDocumentEntry[],
): DocumentPickOption[] {
  return documents.map(d => ({ id: d.id, name: d.name }));
}

/**
 * Where the "New" button places a document — the folder in view (plan-717 F7).
 *
 * ## One rule, one reader
 *
 * The host derived this twice: once for the tooltip and once, inline, inside the
 * `handleNewDocument` callback, where it also decided WHICH create mechanism to
 * use. Two derivations of one rule is how a button ends up promising a folder
 * the click does not use, and the second of them carried the blob-only create
 * branch that F1 removes. Since Phase 3 there is one create — `createDocument`
 * with this folder — so the whole decision is this function, and it is a pure
 * one that a test can state directly (R1-T9).
 *
 * The rule is now literally what the button promises: ANY folder of the open
 * project is the target, addressed project-relative, and the project root means
 * the root. It used to recognise only `library/` and send every other folder —
 * `models/`, a hand-made folder, the root itself — to `scenes/`, which is how a
 * new asset ended up somewhere the user was not looking. "Section is a place,
 * not a type" at the level of a button.
 *
 * The project ROOT is the fallback for the two cases where there is no folder
 * of this project to speak of: a selection in a catalog root (somebody else's
 * tree) and a project that is not open. That fallback was `scenes/` until the
 * default folder became the root.
 *
 * @param projectId id of the OPEN project — the tree root ids are namespaced by
 *   it, so a selection in a catalog root can never be mistaken for one in the
 *   project's own tree.
 * @param selectedFolderPath the tree path of the folder in view, `<rootId>/…`.
 * @returns a project-relative folder path; the empty string is the project root.
 */
export function newDocumentFolderFor(
  projectId: string | null | undefined,
  selectedFolderPath: string | null | undefined,
): string {
  if (!projectId) return DEFAULT_DOCUMENT_FOLDER;
  const segments = (selectedFolderPath ?? '').split('/');
  if (segments[0] !== projectId) return DEFAULT_DOCUMENT_FOLDER;
  return segments.slice(1).join('/');
}

/**
 * The name a new document is proposed under.
 *
 * One name, whatever the folder. It used to propose "Untitled" in `scenes/`
 * and "New asset" everywhere else — a scene/asset distinction surviving in the
 * one place the user actually reads it, on a model where both words name the
 * same kind of thing. The parameter is kept because the call site passes the
 * folder it just decided on and a signature change would ripple for nothing.
 */
export function newDocumentNameFor(_folder: string): string {
  return 'Untitled';
}
