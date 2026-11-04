// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-652 §9.11 — stubs, manifest and the editor's leaf modules stay consistent (static).
 *
 * Phase 2 scope (Editor): the `asset-editor` stub has no value import from the editor
 * body, its activation equals the manifest's, and every editor module that STARTUP code
 * imports statically (public `@rv-private/plugins/asset-editor/<leaf>` imports, the
 * step-import and kinematic-mechanism adapters) is a leaf: it imports no other editor
 * module. A leaf that grew such an import would drag the editor body back into the
 * startup chunks without any build failing.
 *
 * Needs the private sibling (listed in private-dependent-tests.json).
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PRIVATE = resolve(ROOT, '..', 'realvirtual-WebViewer-Private~');
const EDITOR = resolve(PRIVATE, 'src/plugins/asset-editor');

/** Value (non-type) import specifiers of a TS source. */
function valueImports(text: string): string[] {
  const out: string[] = [];
  const re = /^\s*(import|export)\s+(?!type\b)([^;]*?)\s+from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const clause = m[2] ?? '';
    if (m[1] === 'export' && !/[{*]/.test(clause)) continue;
    // `import { type A, type B } from` is type-only too.
    if (/^\{[^}]*\}$/.test(clause.trim()) && clause.replace(/[{}\s]/g, '').split(',').filter(Boolean).every((s) => s.startsWith('type'))) continue;
    out.push(m[3] ?? m[4]);
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) out.push(path);
  }
  return out;
}

const resolvesIntoEditor = (fromFile: string, spec: string): boolean => {
  if (spec.startsWith('@rv-private/plugins/asset-editor')) return true;
  if (!spec.startsWith('.')) return false;
  const target = resolve(dirname(fromFile), spec).replace(/\\/g, '/');
  return target.startsWith(EDITOR.replace(/\\/g, '/'));
};

describe.skipIf(!existsSync(PRIVATE))('feature manifest consistency (plan-652 §9.11)', () => {
  const manifest = JSON.parse(readFileSync(resolve(PRIVATE, 'tier-manifest.json'), 'utf8'));
  const registrations = (manifest.registrations ?? manifest) as Record<string, { adapter?: string; activation?: string[] }>;
  const find = (id: string) => {
    for (const block of Object.values(manifest) as unknown[]) {
      if (block && typeof block === 'object' && id in (block as object)) return (block as Record<string, { activation?: string[] }>)[id];
    }
    return registrations[id];
  };

  it('asset-editor is declared on demand in the manifest', () => {
    expect(find('asset-editor')?.activation).toEqual(['mode:editor']);
  });

  it('the asset-editor stub has no value import from the editor body and matches the manifest', () => {
    const stubPath = resolve(PRIVATE, 'src/features/asset-editor.register.ts');
    const stub = readFileSync(stubPath, 'utf8');
    const intoEditor = valueImports(stub).filter((s) => resolvesIntoEditor(stubPath, s));
    expect(intoEditor).toEqual([]);
    expect(stub).toMatch(/load:\s*\(\)\s*=>\s*import\('\.\/asset-editor\.body'\)/);
    const activation = /const ACTIVATION = \[([^\]]*)\]/.exec(stub)?.[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
    expect(activation).toEqual(find('asset-editor')?.activation);
    expect(existsSync(resolve(PRIVATE, 'src/features/asset-editor.body.ts'))).toBe(true);
  });

  // plan-680: DES moved into the AGPL core. Its stub, body and triggers are checked by
  // tests/des/des-public-boundary.node.test.ts (no private path, runs in the community
  // edition); here only the private side must have let go of it, or both repos would
  // declare `des` (repo skew).
  it('des is no longer a private feature (core since plan-680)', () => {
    expect(registrations.des).toBeUndefined();
    expect(find('des')).toBeUndefined();
    expect(existsSync(resolve(PRIVATE, 'src/features/des.register.ts'))).toBe(false);
    expect(existsSync(resolve(PRIVATE, 'src/features/des.body.ts'))).toBe(false);
    expect(existsSync(resolve(PRIVATE, 'src/plugins/des'))).toBe(false);
  });

  it('nothing imports DES through the private alias any more', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(resolve(ROOT, 'src'))) {
      if (file.replace(/\\/g, '/').includes('/src/private-stubs/')) continue;
      // Static, dynamic and type imports alike — the private tree has no DES since plan-680.
      for (const m of readFileSync(file, 'utf8').matchAll(/['"](@rv-private\/plugins\/des\/[^'"]*)['"]/g)) {
        offenders.push(`${relative(ROOT, file)} → ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every editor module that startup code imports statically is a leaf', () => {
    const leaves = new Set<string>();
    // Public code: static `@rv-private/plugins/asset-editor/<x>` value imports.
    for (const file of sourceFiles(resolve(ROOT, 'src'))) {
      if (file.replace(/\\/g, '/').includes('/src/private-stubs/')) continue;
      for (const spec of valueImports(readFileSync(file, 'utf8'))) {
        const m = /^@rv-private\/plugins\/asset-editor\/(.+)$/.exec(spec);
        if (m) leaves.add(resolve(EDITOR, m[1]));
      }
    }
    // Private startup adapters outside the editor that reach into it.
    for (const file of sourceFiles(resolve(PRIVATE, 'src'))) {
      const norm = file.replace(/\\/g, '/');
      if (norm.startsWith(EDITOR.replace(/\\/g, '/')) || norm.endsWith('/features/asset-editor.body.ts')) continue;
      for (const spec of valueImports(readFileSync(file, 'utf8'))) {
        if (spec.startsWith('.') && resolvesIntoEditor(file, spec)) leaves.add(resolve(dirname(file), spec));
      }
    }
    expect(leaves.size).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const leaf of leaves) {
      const path = [`${leaf}.ts`, `${leaf}.tsx`, resolve(leaf, 'index.ts')].find((p) => existsSync(p));
      expect(path, `leaf ${leaf} not found`).toBeDefined();
      for (const spec of valueImports(readFileSync(path!, 'utf8'))) {
        if (resolvesIntoEditor(path!, spec)) offenders.push(`${relative(PRIVATE, path!)} → ${spec}`);
      }
    }
    expect(offenders, 'an editor module imported by startup code imports the editor body').toEqual([]);
  });

  // Phase 4 (§2.4.5): the leaves public code needs live in `asset-editor/shared/`, each with
  // a public stub at the same path, and nothing addresses them at the old location.
  it('public code reaches the editor only through asset-editor/shared/', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(resolve(ROOT, 'src'))) {
      if (file.replace(/\\/g, '/').includes('/src/private-stubs/')) continue;
      for (const spec of valueImports(readFileSync(file, 'utf8'))) {
        if (spec.startsWith('@rv-private/plugins/asset-editor/') && !spec.startsWith('@rv-private/plugins/asset-editor/shared/')) {
          offenders.push(`${relative(ROOT, file)} → ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every asset-editor/shared module has a public stub and imports nothing from the editor body', () => {
    const shared = resolve(EDITOR, 'shared');
    const stubs = resolve(ROOT, 'src/private-stubs/plugins/asset-editor/shared');
    const missing: string[] = [];
    const offenders: string[] = [];
    for (const file of sourceFiles(shared)) {
      if (!existsSync(resolve(stubs, relative(shared, file)))) missing.push(relative(shared, file));
      for (const spec of valueImports(readFileSync(file, 'utf8'))) {
        if (!resolvesIntoEditor(file, spec)) continue;
        const target = resolve(dirname(file), spec).replace(/\\/g, '/');
        if (!target.startsWith(shared.replace(/\\/g, '/'))) offenders.push(`${relative(PRIVATE, file)} → ${spec}`);
      }
    }
    expect(missing).toEqual([]);
    expect(offenders).toEqual([]);
  });
});
