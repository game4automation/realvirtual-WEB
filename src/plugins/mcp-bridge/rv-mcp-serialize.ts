// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-serialize — the shallow property serialiser the read tools answer with.
 *
 * It lived as a module-local function in `mcp-bridge-plugin.ts` until plan-713
 * moved its every caller into `McpRuntimeTools` and `McpSceneTools`; it is a
 * module of its own now rather than a copy in each, because the numeric rounding
 * and the underscore/function/array elisions ARE the answer format agents parse.
 *
 * Deliberately conservative: private fields (leading `_`), functions and arrays
 * are dropped, numbers are rounded to 4 decimals, and nesting stops at
 * `maxDepth`. A component instance is a live object graph with back-references
 * into the scene; serialising it naively is how a tool result becomes a
 * megabyte, or a cycle.
 */

/** Serialize any object's own enumerable properties (primitives + shallow). */
export function serializeProps(obj: unknown, maxDepth = 2): Record<string, unknown> {
  if (obj === null || obj === undefined || typeof obj !== 'object') return {};
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (key.startsWith('_')) continue;
    const val = (obj as Record<string, unknown>)[key];
    if (val === undefined || val === null) { result[key] = val; continue; }
    if (typeof val === 'function') continue;
    if (typeof val === 'number') { result[key] = +val.toFixed(4); continue; }
    if (typeof val === 'boolean' || typeof val === 'string') { result[key] = val; continue; }
    if (Array.isArray(val)) continue;
    if (typeof val === 'object') {
      if (maxDepth > 0) result[key] = serializeProps(val, maxDepth - 1);
      continue;
    }
  }
  return result;
}
