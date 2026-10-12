// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-json-path-ranges.ts — JSON path ↔ text position for the JSON field
 * editor (plan-555), on `jsonc-parser`.
 *
 *  - {@link rangeForPath}: where a validator issue (`['buttons', 0, 'signal']`)
 *    sits in the text — the value's range; a missing property marks its parent
 *    object; an index past the end of an array has no range.
 *  - {@link locationAt}: what the cursor is in (path, on a key or a value) —
 *    drives signal completion / hover.
 *  - {@link stringTokenAt}: the string literal under the cursor, terminated or
 *    not — the replace range of a completion.
 *
 * All offsets are UTF-16 code-unit offsets into the text, the unit Monaco's
 * `model.getPositionAt` / `getOffsetAt` use. Pure functions, no Monaco.
 */

import {
  createScanner, getLocation, parseTree,
  type Node as JsonNode, type ParseError, type ScanError, type SyntaxKind,
} from 'jsonc-parser';

// jsonc-parser declares these as `const enum`s, which isolatedModules cannot
// read — the stable numeric values of its public API (jsonc-parser 3.x).
const KIND_STRING_LITERAL = 10 as SyntaxKind;
const KIND_EOF = 17 as SyntaxKind;
const SCAN_UNEXPECTED_END_OF_STRING = 2 as ScanError;

/** A half-open text range `[start, end)` in UTF-16 offsets. */
export interface JsonTextRange {
  start: number;
  end: number;
}

/** The cursor's place in a JSON text. */
export interface JsonCursorLocation {
  /** Property names and array indices from the root to the cursor. */
  path: (string | number)[];
  /** True on a property KEY (`"sig|nal": …`), false in a value. */
  isAtPropertyKey: boolean;
  /** The literal the cursor is in or right after, when there is one. */
  previous?: { type: string; value: unknown; offset: number; length: number };
}

const PARSE_OPTIONS = { allowTrailingComma: true, disallowComments: false, allowEmptyContent: false };

const rangeOf = (n: JsonNode): JsonTextRange => ({ start: n.offset, end: n.offset + n.length });

/**
 * The text range of the value at `path`. A property missing on its (existing)
 * object → that object's range; an array index out of range, a path through a
 * non-container, or a text with syntax errors → `null`. Never throws.
 */
export function rangeForPath(text: string, path: readonly (string | number)[]): JsonTextRange | null {
  const errors: ParseError[] = [];
  let root: JsonNode | undefined;
  try {
    root = parseTree(text, errors, PARSE_OPTIONS);
  } catch {
    return null;
  }
  if (!root || errors.length > 0) return null;
  let node: JsonNode = root;
  for (const seg of path) {
    if (typeof seg === 'number') {
      if (node.type !== 'array' || !node.children || seg < 0 || seg >= node.children.length) return null;
      node = node.children[seg];
    } else {
      if (node.type !== 'object') return null;
      const prop = node.children?.find((p) => p.children?.[0]?.value === seg);
      if (!prop) return rangeOf(node);              // missing property → its parent object
      const value = prop.children?.[1];
      if (!value) return rangeOf(prop);
      node = value;
    }
  }
  return rangeOf(node);
}

/** The cursor's JSON path and whether it is on a key. Tolerates incomplete text. */
export function locationAt(text: string, offset: number): JsonCursorLocation {
  const loc = getLocation(text, offset);
  const prev = loc.previousNode;
  return {
    path: [...loc.path],
    isAtPropertyKey: loc.isAtPropertyKey,
    previous: prev ? { type: prev.type, value: prev.value as unknown, offset: prev.offset, length: prev.length } : undefined,
  };
}

/** A string literal in the text. */
export interface JsonStringToken {
  /** Offset of the opening quote. */
  start: number;
  /** Offset after the token (after the closing quote when terminated, else end of its line content). */
  end: number;
  /** False when the string has no closing quote (yet). */
  terminated: boolean;
}

/**
 * The string literal whose content holds `offset` (between the quotes, the
 * closing quote's position included), or null. An unterminated string ends at
 * its line end.
 */
export function stringTokenAt(text: string, offset: number): JsonStringToken | null {
  const scanner = createScanner(text, false);
  for (;;) {
    const kind = scanner.scan();
    if (kind === KIND_EOF) return null;
    const start = scanner.getTokenOffset();
    if (start >= offset) return null;
    const end = start + scanner.getTokenLength();
    if (kind !== KIND_STRING_LITERAL) continue;
    if (offset > end) continue;
    const terminated = scanner.getTokenError() !== SCAN_UNEXPECTED_END_OF_STRING;
    // Terminated: the cursor must be before or ON the closing quote (end - 1).
    if (terminated && offset > end - 1) continue;
    return { start, end, terminated };
  }
}
