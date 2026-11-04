// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-path-list — THE parser for node-path lists (`paths`, `…Paths`, `names`).
 *
 * CAD part names contain commas ("ISO 15 ABB - 6020 - Full,SI,NC,Full",
 * "Asset/LINK,PLATE"), and the legacy wire form is a comma string. Splitting such
 * a name into fragments is how a command used to act on the wrong nodes — or on
 * none — without saying so. Accepted forms, in this order:
 *
 *  1. a native `string[]` (command callers, views, macro args) — as before: strings
 *     kept verbatim, non-strings and empty strings dropped, never an error;
 *  2. a JSON array string — anything whose trimmed text starts with `[`. Invalid
 *     JSON, or an element that is not a string, is an ERROR — never a fallback
 *     to splitting, which would silently act on fragments of the intended paths;
 *  3. the legacy string: multi-line input splits on newlines and `;` (commas stay
 *     literal), single-line input also on `,`. So `A,B` keeps meaning two paths.
 *
 * Lists are SERIALISED with {@link serializePathList}: the legacy plain string where
 * that is lossless, JSON where an element would otherwise split again on the next
 * parse (a re-joined singleton that contains a comma).
 *
 * Renderer-free and dependency-free, so the MCP bridge, the command descriptors and
 * node tests share it.
 */

/** What a path-list parameter may carry on the wire or from a direct caller. */
export type PathListInput = string | readonly unknown[] | null | undefined;

/** Parameter-description fragment every path-list parameter uses. */
export const PATH_LIST_HINT = 'comma-separated, or a JSON array of strings for names containing commas';

/** A path list that is neither a valid string array nor a legacy separated string. */
export class PathListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathListError';
  }
}

function fromArray(list: readonly unknown[], source: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    if (typeof v !== 'string') {
      throw new PathListError(`${source}: element ${i} is ${v === null ? 'null' : typeof v}, expected a string path`);
    }
    const p = v.trim();
    if (p.length > 0) out.push(p);
  }
  return out;
}

/** Split a legacy separated string (no JSON handling). */
export function splitLegacyPathList(raw: string): string[] {
  const splitter = /[\r\n]/.test(raw) ? /[;\r\n]+/ : /[,;\r\n]+/;
  return raw.split(splitter).map((p) => p.trim()).filter((p) => p.length > 0);
}

/** True when `raw` is (meant as) a JSON array string. */
export function isJsonPathList(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.trimStart().startsWith('[');
}

/**
 * Normalise a path list into clean individual paths (see the module doc for the
 * accepted forms). `null` / `undefined` / a non-string scalar yield `[]`; a broken
 * JSON array throws {@link PathListError}.
 */
export function parsePathList(raw: unknown): string[] {
  if (raw === null || raw === undefined) return [];
  // A native list keeps its historic contract: strings as given (no trim),
  // non-strings and empties dropped, never a throw.
  if (Array.isArray(raw)) return raw.filter((p): p is string => typeof p === 'string' && p.length > 0);
  if (typeof raw !== 'string') return [];
  if (isJsonPathList(raw)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new PathListError(`Path list looks like a JSON array but is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!Array.isArray(parsed)) throw new PathListError('Path list JSON must be an array of strings');
    return fromArray(parsed, 'Path list JSON');
  }
  return splitLegacyPathList(raw);
}

/**
 * The wire form of a list that {@link parsePathList} reads back exactly — and the
 * SMALLEST such form: the legacy plain string (`paths.join(delimiter)`, so saved
 * macros and recorded args of ordinary names stay byte-identical) when no element
 * contains a delimiter (`,` `;` newline) and none starts with `[`; otherwise a JSON
 * array string. `delimiter` is the caller's historic join (`','` or `'\n'`).
 */
export function serializePathList(paths: readonly string[], delimiter: ',' | '\n' = ','): string {
  const plain = paths.every((p) => !/[,;\r\n]/.test(p) && !p.trimStart().startsWith('['));
  return plain ? paths.join(delimiter) : JSON.stringify([...paths]);
}
