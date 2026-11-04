// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-user-paths — node PATH arguments of an MCP call through `findNodeForUser`
 * (plan-769 F9, Phase 3b).
 *
 * MCP callers type paths: the runtime spelling `web_node_tree` prints, or the AUTHORED
 * spelling of the file (Unity names, `NL6:501` instead of the loader's `NL6501_1`). The
 * tools themselves look paths up in the registry (the runtime spelling). At the ONE
 * dispatch point every node-path argument the registry does not know is replaced by the
 * registry path of the node `findNodeForUser` names — but only for a hit it did not
 * GUESS (runtime / authored / legacy-Three spelling); a guess or a miss leaves the
 * argument as typed, so the tool's own error or lookup applies unchanged. Values a tool
 * then writes into a reference are stored as addresses by the executors (Phase 3b).
 *
 * Which arguments: `path`, `paths` (a path list — comma string or JSON array, see
 * `rv-path-list`), and every `…Path` / `…Paths` except the ones that are not scene
 * node paths (`componentPath` is relative to a bind target; file / document / project
 * paths name files).
 */

import type { NodeRegistry } from '../../core/engine/rv-node-registry';
import { isJsonPathList, parsePathList, serializePathList } from '../../core/hmi/rv-path-list';

const NOT_NODE_PATHS = new Set([
  'componentPath', 'documentPath', 'filePath', 'projectPath', 'glbPath', 'relPath', 'folderPath',
  'outputPath', 'sourcePath', 'assetPath', 'libraryPath', 'macroPath', 'imagePath', 'url',
]);

function isNodePathParam(name: string): boolean {
  if (NOT_NODE_PATHS.has(name)) return false;
  return name === 'path' || name === 'paths' || /[a-z]Paths?$/.test(name);
}

function normalizeOne(registry: NodeRegistry, value: string): string {
  // Whitespace and a leading `/` are every tool's own normalisation — not a different path.
  const p = value.trim().replace(/^\/+/, '');
  if (!p) return value;
  // An EXACT registry path stays; `getNode` alone would also accept its guessing stages.
  const bare = (s: string | null | undefined): string => (s ?? '').replace(/^\/+/, '');
  const direct = registry.getNode(p);
  if (direct && bare(registry.getPathForNode(direct)) === p) return value;
  const hit = registry.findNodeForUser(p);
  if (!hit || hit.via === 'guess') return value;
  const canonical = registry.getPathForNode(hit.node);
  return canonical && bare(canonical) !== p ? canonical : value;
}

/** `args` with every node-path argument in the registry's spelling (a copy when something changed). */
export function normalizeUserPathArgs(
  registry: NodeRegistry | null | undefined,
  args: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!registry || !args) return args;
  let out: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(args)) {
    if (!isNodePathParam(key)) continue;
    const isList = key.endsWith('aths');
    if (isList && (typeof value === 'string' || Array.isArray(value))) {
      const next = normalizeList(registry, value);
      if (next !== value) (out ??= { ...args })[key] = next;
      continue;
    }
    if (typeof value !== 'string') continue;
    const next = normalizeOne(registry, value);
    if (next !== value) (out ??= { ...args })[key] = next;
  }
  return out ?? args;
}

/**
 * A path LIST, element by element, parsed with THE shared rule (`rv-path-list`):
 * a JSON array keeps commas inside names, so a quoted `Asset/LINK,PLATE` is
 * looked up as one path and never as the fragments `Asset/LINK` and `PLATE`.
 *
 * Returns `value` itself when nothing changed (or the list does not parse — the
 * tool's own parse then reports the error). A changed list keeps its form where
 * that is lossless: a native array stays an array, a legacy string is re-joined
 * with its own delimiter unless a normalised element contains one, and
 * everything else is written as a JSON array.
 */
function normalizeList(registry: NodeRegistry, value: string | readonly unknown[]): string | readonly unknown[] {
  let parts: string[];
  try {
    parts = parsePathList(value);
  } catch {
    return value;
  }
  let changed = false;
  const next = parts.map((part) => {
    const n = normalizeOne(registry, part);
    if (n !== part) changed = true;
    return n;
  });
  if (!changed) return value;
  if (typeof value !== 'string') return next;
  if (isJsonPathList(value)) return JSON.stringify(next);
  const multiLine = /[\r\n]/.test(value);
  const delimiter = multiLine ? '\n' : ',';
  const unsafe = multiLine ? /[;\r\n]/ : /[,;\r\n]/;
  return next.some((p) => unsafe.test(p)) ? serializePathList(next) : next.join(delimiter);
}
