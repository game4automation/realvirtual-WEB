// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * document-filter — what the document view is currently showing
 * (plan-413 §3.1, phase 4).
 *
 * Pure functions over a classification, deliberately separate from the React
 * that draws the chips. Two reasons, and the second is the load-bearing one:
 *
 *  1. The rules are testable without mounting a dashboard.
 *  2. **Search and classification are different kinds of filter and must not be
 *     merged.** The search term filters everything the screen shows at once —
 *     documents, examples and every attached library — because a user who types
 *     a name is asking "where is this thing", not "which tab is it on". The
 *     chips and the tag cut only the document list, because that is the only
 *     list that carries a classification at all. Folding the two into one
 *     predicate would either make the chips silently hide library assets or
 *     make the search stop crossing tabs; both were live bugs in the drafts.
 *
 * ## Why an unknown chip matches nothing
 *
 * The store types the chip as a plain string so a stale deep link cannot fail
 * to parse (see `ProjectsDashboardSnapshot.chip`). The resolution happens here,
 * and it resolves to "matches nothing" rather than "matches everything": a
 * filter that quietly stops filtering is the failure a user cannot see. An
 * empty grid under a lit-up chip they do not recognise is one they can.
 */

import {
  DOCUMENT_LEVELS,
  documentLevelLabel,
  UNCLASSIFIED_LABEL,
  type DocumentClassification,
  type DocumentLevel,
} from '../../project/rv-document-classification';

/** The "no classification filter" chip. Also what `chip === null` means. */
export const DOCUMENT_CHIP_ALL = 'all';
/** The chip that selects documents whose bytes carry no level. */
export const DOCUMENT_CHIP_UNCLASSIFIED = 'unclassified';

export type DocumentFilterChip =
  | typeof DOCUMENT_CHIP_ALL
  | typeof DOCUMENT_CHIP_UNCLASSIFIED
  | DocumentLevel;

/** Everything the filter needs from a row. Structural on purpose — a manifest
 *  document, a published example and a scene row all satisfy it. */
export interface ClassifiedRow {
  name: string;
  classification?: DocumentClassification;
}

export interface DocumentFilterState {
  /** Free-text search. Applies to every list on the screen, not just documents. */
  term: string;
  /** Classification chip, or null for "All". */
  chip: string | null;
  /** Tag, or null for "any tag". */
  tag: string | null;
}

/** One chip of the bar, with the count it would show. */
export interface DocumentChipOption {
  key: DocumentFilterChip;
  label: string;
  count: number;
}

/** True when the name contains the (already lower-cased) term. */
export function matchesSearchTerm(name: string, term: string): boolean {
  const t = term.trim().toLowerCase();
  return t === '' || name.toLowerCase().includes(t);
}

/** True when the classification satisfies the chip. See the header on unknowns. */
export function matchesDocumentChip(
  classification: DocumentClassification | undefined | null,
  chip: string | null,
): boolean {
  if (chip === null || chip === DOCUMENT_CHIP_ALL) return true;
  const level = classification?.level;
  if (chip === DOCUMENT_CHIP_UNCLASSIFIED) return level === undefined;
  return level === chip;
}

/**
 * True when the classification carries the tag.
 *
 * Case-insensitive, because the tags come from free text and "Linie3" and
 * "linie3" are one tag to everybody except a string comparison. The stored
 * spelling is untouched — normalisation belongs to the writer, not the filter.
 */
export function matchesDocumentTag(
  classification: DocumentClassification | undefined | null,
  tag: string | null,
): boolean {
  if (tag === null || tag === '') return true;
  const wanted = tag.toLowerCase();
  return (classification?.tags ?? []).some(t => t.toLowerCase() === wanted);
}

/** All three predicates at once, in the order that rejects most cheaply. */
export function matchesDocumentFilter(row: ClassifiedRow, state: DocumentFilterState): boolean {
  return matchesSearchTerm(row.name, state.term)
    && matchesDocumentChip(row.classification, state.chip)
    && matchesDocumentTag(row.classification, state.tag);
}

/** True when any part of the filter is narrowing the view. */
export function documentFilterActive(state: DocumentFilterState): boolean {
  return state.term.trim() !== ''
    || (state.chip !== null && state.chip !== DOCUMENT_CHIP_ALL)
    || (state.tag !== null && state.tag !== '');
}

/**
 * The chips to offer, with counts, for a document list.
 *
 * Counts come from the list BEFORE the chip is applied — a count that changed
 * as you clicked would be answering a different question every time. A level
 * nobody uses gets no chip: five permanent zeroes are noise in a project that
 * has only scenes. The exception is `selected`, which is always offered even at
 * zero, or clicking the last part away would leave the filter on with nothing
 * on screen to turn it off with.
 */
export function documentChipOptions(
  rows: readonly ClassifiedRow[],
  selected: string | null = null,
): DocumentChipOption[] {
  const counts = new Map<string, number>();
  let unclassified = 0;
  for (const row of rows) {
    const level = row.classification?.level;
    if (level === undefined) unclassified++;
    else counts.set(level, (counts.get(level) ?? 0) + 1);
  }

  const out: DocumentChipOption[] = [
    { key: DOCUMENT_CHIP_ALL, label: 'All', count: rows.length },
  ];
  for (const level of DOCUMENT_LEVELS) {
    const count = counts.get(level) ?? 0;
    if (count > 0 || selected === level) {
      out.push({ key: level, label: documentLevelLabel(level), count });
    }
  }
  if (unclassified > 0 || selected === DOCUMENT_CHIP_UNCLASSIFIED) {
    out.push({
      key: DOCUMENT_CHIP_UNCLASSIFIED,
      label: UNCLASSIFIED_LABEL,
      count: unclassified,
    });
  }
  return out;
}

/**
 * Distinct tags of a document list, sorted — the autocomplete source (F13).
 *
 * Deduplicated case-insensitively so a project does not end up offering
 * "Linie3" and "linie3" as two choices; the first spelling seen is the one
 * offered, because it is the one somebody actually typed.
 */
export function documentTagOptions(rows: readonly ClassifiedRow[]): string[] {
  const seen = new Map<string, string>();
  for (const row of rows) {
    for (const tag of row.classification?.tags ?? []) {
      const key = tag.toLowerCase();
      if (!seen.has(key)) seen.set(key, tag);
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}
