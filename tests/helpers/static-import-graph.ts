// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * static-import-graph.ts — walks the STATIC import graph of a TypeScript entry.
 *
 * Extracted from `tests/bundle-eager-imports.node.test.ts` (plan-499 §9.12)
 * when plan-773 Phase 5 needed the same walk for the robot program export.
 * Shared rather than copied for the reason `tests/helpers/mcp-schemas.ts`
 * states about itself: a second private copy is how one of them goes stale.
 *
 * ## What counts as an edge, and why the exclusions matter
 *
 * Only VALUE-level `import` / `export … from` edges are followed. The two
 * things that are deliberately NOT edges are exactly the two mechanisms a lazy
 * feature is built out of:
 *
 * - **`import('…')`** — a dynamic import is a chunk boundary. Rollup emits the
 *   target as a separate chunk, so it is not in the entry chunk by definition.
 * - **`import type { … }`** — erased at build time; it carries no code at all.
 *   A clause is type-only when EVERY name in it is prefixed with `type`.
 *
 * This is a lexical approximation of what Rollup does, not a bundle run — which
 * is the point: it is fast enough to be a guard, and it answers the only
 * question a lazy-loading rule asks, namely whether a file is REACHABLE from
 * the entry without crossing an `import()`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Repository root (the folder that holds `src/`), derived from this file. */
export const REPO_ROOT = resolve(__dirname, '..', '..');

/** The private sister repo's src/ (may not exist — check HAS_PRIVATE / existsSync). */
export const PRIVATE_SRC = resolve(REPO_ROOT, '../realvirtual-WebViewer-Private~/src');

/** True when the private sister repo is checked out next to this one. */
export const HAS_PRIVATE = existsSync(PRIVATE_SRC);

/** Resolve one specifier against the file that wrote it; null for a package. */
export function resolveSpec(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else if (spec.startsWith('@rv-private/')) {
    base = resolve(
      HAS_PRIVATE ? PRIVATE_SRC : resolve(REPO_ROOT, 'src/private-stubs'),
      spec.slice('@rv-private/'.length),
    );
  } else if (spec.startsWith('@rv/')) base = resolve(REPO_ROOT, 'src', spec.slice(4));
  else return null; // a package
  for (const c of [base, `${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts'), resolve(base, 'index.tsx')]) {
    if (existsSync(c) && /\.(ts|tsx)$/.test(c)) return c;
  }
  return null;
}

/** Static, value-level `import` / `export … from` specifiers of one source text. */
export function staticSpecifiers(src: string): string[] {
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

/** Every file statically reachable from `entry` (absolute paths, `entry` included). */
export function eagerGraph(entry: string): Set<string> {
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

/** Forward slashes, so a suffix test reads the same on Windows and Linux. */
export const norm = (p: string): string => p.replace(/\\/g, '/');

/** {@link eagerGraph} as normalised strings — what a test actually compares. */
export function eagerGraphPaths(entry: string): string[] {
  return [...eagerGraph(entry)].map(norm);
}

/**
 * Size of one file in bytes with CRLF counted as LF, independent of the checkout.
 *
 * `statSync().size` depends on `core.autocrlf`: a fresh worktree on Windows checks the
 * same commit out with CRLF and measured +2_234 B over the canonical LF tree (2026-11-04).
 * Done at Buffer level (drop the 0x0D of every 0x0D 0x0A), so UTF-8 multibyte sequences stay exact.
 */
export function lfBytes(file: string): number {
  const buf = readFileSync(file);
  let n = buf.length;
  for (let i = buf.indexOf(0x0d); i !== -1; i = buf.indexOf(0x0d, i + 1)) {
    if (buf[i + 1] === 0x0a) n--;
  }
  return n;
}

/** The dynamic `import('…')` specifiers written in one source text. */
export function dynamicSpecifiers(src: string): string[] {
  const out: string[] = [];
  const re = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (let m; (m = re.exec(src)) !== null;) out.push(m[1]);
  return out;
}
