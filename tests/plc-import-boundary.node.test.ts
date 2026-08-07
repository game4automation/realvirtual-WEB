// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plc-import-boundary.node.test.ts — plan-242 build guard (public build purity).
 *
 * The virtual PLC (ST compiler / Monaco editor) lives ENTIRELY in the private
 * package behind the `__RV_INTERNAL__` gate. The public core must talk to it
 * only through `src/core/plc-control.ts` (structural surface). This node test
 * scans every public source file's import lines and asserts that no
 * PLC/Monaco/parser dependency has leaked into `src/` — which would drag
 * those bytes into the public and customer bundles.
 *
 * QuickJS exception (plan-210 phase 0, ADR-023): the script sandbox moved to
 * the public core — it carries the free JS-in-GLB behavior layer. QuickJS
 * imports are therefore legitimate, but ONLY in the dedicated engine files
 * (`QUICKJS_ALLOWED`) and ONLY as `import type` + lazy dynamic `import()` —
 * the WASM chunk must never enter the eager bundle. A separate assertion
 * guards that.
 *
 * Pattern: tests/sim-mode-toggle.node.test.ts (import-line scan, so comments
 * mentioning the packages do not trip the guard).
 *
 * Runs in the Node environment (vitest.node.config.ts).
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SRC = resolve(__dirname, '../src');

const QUICKJS_PATTERN = /['"][^'"]*quickjs[^'"]*['"]/;
const MONACO_PATTERN = /['"]monaco-editor(?:\/[^'"]*)?['"]/;

/** Import specifiers that must never appear in PUBLIC sources. */
const FORBIDDEN = [
  MONACO_PATTERN,                                // editor bundle (2–5 MB) — see MONACO_ALLOWED
  /['"]chevrotain['"]/,                          // ST parser (private compiler only)
  QUICKJS_PATTERN,                               // sandbox runtime (any quickjs pkg) — see QUICKJS_ALLOWED
  /['"]@rv-private\/plc(?:\/[^'"]*)?['"]/,       // private PLC runtime modules
  /['"]@rv-private\/plugins\/plc(?:\/[^'"]*)?['"]/, // private PLC UI/plugin modules
  /realvirtual-WebViewer-Private[^'"]*\/plc/,    // relative escape into the private plc dir
  /['"][^'"]*internal-plugins['"]/,              // internal tier must never be imported from public src
];

/** Public engine files that legitimately host the QuickJS sandbox (plan-210
 *  phase 0, ADR-023). Kept deliberately tight — new quickjs consumers must go
 *  through these modules, not import quickjs themselves. */
const QUICKJS_ALLOWED = new Set([
  'core/engine/rv-script-sandbox.ts',
  'core/engine/rv-script-host.ts',
]);

/** Public files that legitimately host Monaco (plan-210 phase 3: the script
 *  editor loader). Same contract as QUICKJS_ALLOWED: import type + dynamic
 *  import() ONLY — Monaco must stay a lazy separate chunk, never in the eager
 *  bundle. New Monaco consumers must go through this loader. */
const MONACO_ALLOWED = new Set([
  'core/hmi/script/monaco-loader.ts',
]);

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

/** Recursively collect .ts/.tsx files under `dir`, skipping the stub folder. */
function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // private-stubs ARE the public no-op side of @rv-private — exempt.
      if (relative(SRC, full).split(sep)[0] === 'private-stubs') continue;
      collectSources(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Extract only the import/require lines of a source (incl. dynamic imports). */
function importLines(source: string): string {
  return source
    .split('\n')
    .filter((l) =>
      /^\s*import\b/.test(l) ||
      /\bfrom\s+['"]/.test(l) ||
      /\bimport\s*\(/.test(l) ||
      /\brequire\s*\(/.test(l),
    )
    .join('\n');
}

describe('PLC import boundary (plan-242 build guard)', () => {
  const files = collectSources(SRC);

  it('finds a non-trivial number of public sources (sanity)', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('no public source imports monaco/chevrotain/quickjs or private PLC modules', () => {
    const violations: string[] = [];
    for (const file of files) {
      const rel = toPosix(relative(SRC, file));
      const imports = importLines(readFileSync(file, 'utf-8'));
      for (const pattern of FORBIDDEN) {
        if (pattern === QUICKJS_PATTERN && QUICKJS_ALLOWED.has(rel)) continue;
        if (pattern === MONACO_PATTERN && MONACO_ALLOWED.has(rel)) continue;
        if (pattern.test(imports)) {
          violations.push(`${rel} → ${pattern}`);
        }
      }
    }
    expect(violations, `forbidden imports in public src:\n${violations.join('\n')}`).toEqual([]);
  });

  it('the allowed quickjs hosts import quickjs only lazily (import type / dynamic import)', () => {
    for (const rel of QUICKJS_ALLOWED) {
      let source = readFileSync(join(SRC, rel), 'utf-8');
      // Strip type-only import statements (single- or multi-line) — the
      // compiler erases them; they never pull bytes into the bundle.
      source = source.replace(/import\s+type\s+[\s\S]*?from\s+['"][^'"]+['"];?/g, '');
      const offending = source
        .split('\n')
        .filter((l) => QUICKJS_PATTERN.test(l))
        .filter((l) => !/\bimport\s*\(/.test(l));   // dynamic import() is the lazy path
      expect(offending, `${rel} must not import quickjs eagerly:\n${offending.join('\n')}`).toEqual([]);
    }
  });

  it('the allowed monaco host imports monaco only lazily (import type / dynamic import)', () => {
    // plan-210 phase 3: the script-editor loader is the ONLY public Monaco
    // consumer, and it must load Monaco exclusively via dynamic import() so
    // the editor bundle stays a lazy separate chunk.
    for (const rel of MONACO_ALLOWED) {
      let source = readFileSync(join(SRC, rel), 'utf-8');
      source = source.replace(/import\s+type\s+[\s\S]*?from\s+['"][^'"]+['"];?/g, '');
      const offending = source
        .split('\n')
        .filter((l) => MONACO_PATTERN.test(l))
        .filter((l) => !/\bimport\s*\(/.test(l));   // dynamic import() is the lazy path
      expect(offending, `${rel} must not import monaco eagerly:\n${offending.join('\n')}`).toEqual([]);
    }
  });

  it('the script editor UI reaches monaco only through the loader (no direct monaco imports)', () => {
    // The panel / save pipeline / stores must depend on the loader module,
    // never on 'monaco-editor' directly — one lazy entry point (MONACO_ALLOWED).
    const scriptDir = join(SRC, 'core/hmi/script');
    for (const entry of readdirSync(scriptDir)) {
      const rel = `core/hmi/script/${entry}`;
      if (MONACO_ALLOWED.has(rel) || !/\.(ts|tsx)$/.test(entry)) continue;
      const imports = importLines(readFileSync(join(scriptDir, entry), 'utf-8'));
      expect(MONACO_PATTERN.test(imports), `${rel} must import monaco via the loader only`).toBe(false);
    }
  });

  it('the public PlcControl surface itself is import-clean (positive control)', () => {
    const surface = readFileSync(join(SRC, 'core/plc-control.ts'), 'utf-8');
    const imports = importLines(surface);
    // The structural surface must not import ANYTHING (zero private imports by design).
    expect(imports.trim()).toBe('');
  });
});
