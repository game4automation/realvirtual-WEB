// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * document-multi-select — what a click with modifier keys does to the
 * dashboard's document selection.
 *
 * Pure on purpose: `ProjectsDashboardHost.tsx` cannot be rendered by a test,
 * so the rules live here and the host only calls them.
 *
 * - plain click: that one document (and it becomes the range anchor)
 * - Ctrl / Cmd: add or remove the document, keep the rest
 * - Shift: every document between the anchor and the click, in the order the
 *   grid shows them; with Ctrl / Cmd as well, that range is ADDED
 *
 * One selected document is a `document` selection, two or more a `documents`
 * selection, none is `none` — so every single-document view keeps working
 * unchanged.
 */

import type { ProjectsSelection } from './projects-dashboard-store';

/** The modifier keys of a selecting click. */
export interface SelectModifiers {
  /** Ctrl (Windows/Linux) or Cmd (macOS). */
  toggle: boolean;
  /** Shift. */
  range: boolean;
}

/** The document ids a selection holds — empty for anything that is not documents. */
export function selectedDocumentIds(selection: ProjectsSelection): string[] {
  if (selection.kind === 'document') return [selection.documentId];
  if (selection.kind === 'documents') return [...selection.documentIds];
  return [];
}

/** A list of ids as the selection that describes it. */
export function selectionOfDocumentIds(ids: readonly string[]): ProjectsSelection {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return { kind: 'none' };
  if (unique.length === 1) return { kind: 'document', documentId: unique[0] };
  return { kind: 'documents', documentIds: unique };
}

/**
 * The selection after a click on document `clickedId`.
 *
 * `orderedIds` is the order the user sees (the grid); `anchorId` the document
 * of the last plain or Ctrl click. A Shift-click without a usable anchor (none
 * yet, or not in the visible order) selects just the clicked document.
 * Returns the next selection and the next anchor.
 */
export function nextDocumentSelection(
  current: ProjectsSelection,
  anchorId: string | null,
  clickedId: string,
  mods: SelectModifiers,
  orderedIds: readonly string[],
): { selection: ProjectsSelection; anchorId: string } {
  if (mods.range) {
    const from = anchorId !== null ? orderedIds.indexOf(anchorId) : -1;
    const to = orderedIds.indexOf(clickedId);
    if (from < 0 || to < 0) {
      return { selection: selectionOfDocumentIds([clickedId]), anchorId: clickedId };
    }
    const range = orderedIds.slice(Math.min(from, to), Math.max(from, to) + 1);
    const base = mods.toggle ? selectedDocumentIds(current) : [];
    // The anchor stays: the next Shift-click spans from the same start.
    return { selection: selectionOfDocumentIds([...base, ...range]), anchorId: anchorId! };
  }
  if (mods.toggle) {
    const ids = selectedDocumentIds(current);
    const next = ids.includes(clickedId) ? ids.filter(id => id !== clickedId) : [...ids, clickedId];
    return { selection: selectionOfDocumentIds(next), anchorId: clickedId };
  }
  return { selection: selectionOfDocumentIds([clickedId]), anchorId: clickedId };
}
