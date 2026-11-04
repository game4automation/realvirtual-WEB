// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-macro-store — the save-path half of plan-641's macros (M5), as a tiny
 * leaf for the core bundle.
 *
 * The macro recorder, the parser and the jobs live in the MCP bridge
 * (`plugins/mcp-bridge/rv-mcp-macro.ts`), which is its own lazy chunk. The two
 * document writers — the asset export and the scene writer — only need to ask
 * "what goes under `extras.realvirtual.Macros` for this document?", and that
 * question must not pull the whole bridge into the entry. So the per-document
 * book map lives HERE; the bridge creates and fills the books, the writers read
 * them through {@link macrosForEmbed}.
 */

/** Key under `scenes[0].extras.realvirtual` (M5). */
export const RV_MACROS_KEY = 'Macros';

/** The macros of ONE document, keyed by name. The bridge owns the value type. */
export interface RvMacroBookBase<M extends object = object> {
  readonly macros: Map<string, M>;
  /** True once anything changed the book — only then does a save write the block. */
  touched: boolean;
}

const books = new WeakMap<object, RvMacroBookBase>();

/** The book of `doc` if one exists — never creates. */
export function peekMacroBook(doc: object | null | undefined): RvMacroBookBase | undefined {
  return doc ? books.get(doc) : undefined;
}

/** Attach a book to a document (the bridge, on first use). */
export function setMacroBook(doc: object, book: RvMacroBookBase): void {
  books.set(doc, book);
}

/**
 * What a save writes under `extras.realvirtual.Macros` (three-state, like
 * `DocumentInfo`): `undefined` = no opinion (no book, or never changed — an
 * authored block in the bytes stays as it is), `null` = remove the block,
 * an array = replace it (JSON copies).
 */
export function macrosForEmbed(doc: object | null | undefined): unknown[] | null | undefined {
  const book = peekMacroBook(doc);
  if (!book || !book.touched) return undefined;
  const list = [...book.macros.values()].map((m) => JSON.parse(JSON.stringify(m)) as unknown);
  return list.length ? list : null;
}
