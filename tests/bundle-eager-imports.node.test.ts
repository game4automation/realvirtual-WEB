// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-499 §9.12 — lazy discipline of the command registry.
 *
 * Walks the STATIC import graph from `src/main.ts` (type-only imports and
 * dynamic `import()` do not count — they never put code into the entry
 * chunk) and asserts: the registry core is reachable (the open `ActionSegment`
 * is eager), the private command IMPLEMENTATIONS are not — they stay behind the
 * descriptors' `import()`. The descriptors themselves ride with their
 * consumers: the MCP bridge (itself a lazy chunk of `main.ts`) imports them
 * statically, so labels, button keys and capabilities exist before any call and
 * before the editor (measured 2026-09-26: they are not in the entry graph).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const PRIVATE_SRC = resolve(ROOT, '../realvirtual-WebViewer-Private~/src');
const HAS_PRIVATE = existsSync(PRIVATE_SRC);

function resolveSpec(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else if (spec.startsWith('@rv-private/')) {
    base = resolve(HAS_PRIVATE ? PRIVATE_SRC : resolve(ROOT, 'src/private-stubs'), spec.slice('@rv-private/'.length));
  } else if (spec.startsWith('@rv/')) base = resolve(ROOT, 'src', spec.slice(4));
  else return null; // a package
  for (const c of [base, `${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts'), resolve(base, 'index.tsx')]) {
    if (existsSync(c) && /\.(ts|tsx)$/.test(c)) return c;
  }
  return null;
}

/** Static, value-level import/export-from specifiers of one file. */
function staticSpecifiers(src: string): string[] {
  const out: string[] = [];
  const re = /^\s*(import|export)\s+(?!type\b)([^'";]*?\bfrom\s*)?['"]([^'"]+)['"]/gm;
  for (let m; (m = re.exec(src)) !== null;) {
    // `import { type A, type B } from` is still type-only when EVERY name is a type.
    const clause = (m[2] ?? '').trim();
    const onlyBraces = /^\{([^}]*)\}\s*from$/.exec(clause);
    if (onlyBraces && onlyBraces[1].split(',').map((n) => n.trim()).filter(Boolean).every((n) => n.startsWith('type '))) {
      continue;
    }
    out.push(m[3]);
  }
  return out;
}

function eagerGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    let src: string;
    try { src = readFileSync(f, 'utf8'); } catch { continue; }
    for (const spec of staticSpecifiers(src)) {
      const r = resolveSpec(f, spec);
      if (r && !seen.has(r)) stack.push(r);
    }
  }
  return seen;
}

const norm = (p: string): string => p.replace(/\\/g, '/');

describe('bundle: command registry lazy discipline', () => {
  const graph = [...eagerGraph(resolve(ROOT, 'src/main.ts'))].map(norm);
  const has = (suffix: string): boolean => graph.some((f) => f.endsWith(suffix));

  it('walks a real graph', () => {
    expect(graph.length).toBeGreaterThan(100);
  });

  it('the registry core is in the entry graph; the descriptors ride with the (lazy) bridge', () => {
    expect(has('src/core/hmi/rv-command-registry.ts')).toBe(true);
    const bridge = [...eagerGraph(resolve(ROOT, 'src/plugins/mcp-bridge-plugin.ts'))].map(norm);
    expect(bridge.some((f) => f.endsWith('src/core/hmi/editor-command-descriptors.ts'))).toBe(true);
    expect(bridge.some((f) => f.includes('realvirtual-WebViewer-Private~') && f.endsWith('/asset-editor/editor-commands.ts')))
      .toBe(false);
  });

  it('the private command implementations are NOT (they stay behind import())', () => {
    expect(graph.filter((f) => f.includes('realvirtual-WebViewer-Private~') && f.endsWith('/asset-editor/editor-commands.ts')))
      .toEqual([]);
  });
});
