// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const retired = [
  'src/plugins/des/des-plugin.ts',
  ...['source', 'sink', 'station', 'storage', 'conveyor', 'downtime'].map(n => `src/plugins/des/rv-des-${n}.ts`),
  'src/plugins/des/des-worker.ts',
  'src/plugins/des/hmi/DESControlBar.tsx',
  'src/plugins/des/hmi/DESRunComparePanel.tsx',
  'src/plugins/des/hmi/des-hmi-source.ts',
  'src/plugins/sim-controller/des-run-compare-store.ts',
  'src/plugins/sim-controller/des-experiments-helpers.ts',
  'src/core/material-flow/material-flow-adapter.ts',
];
const names = new Set(retired.filter(p => !p.endsWith('/material-flow-adapter.ts'))
  .map(p => p.split('/').pop()!.replace(/\.tsx?$/, '')));

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'node_modules' || entry.name === 'dist') return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return entry.isFile() && /\.(?:[cm]?[jt]sx?)$/.test(entry.name) ? [path] : [];
  });
}

describe('legacy DES retirement (plan 2006, 9.15)', () => {
  it('keeps the named-action registry without the decorator machinery', () => {
    const registry = readFileSync(join(root, 'src/plugins/des/rv-des-named-actions.ts'), 'utf8');
    expect(registry).not.toMatch(/export\s+(?:function|const)\s+desAction\b/);
    expect(files(join(root, 'src')).filter(file => /@desAction\b/.test(readFileSync(file, 'utf8')))
      .map(file => relative(root, file))).toEqual([]);
  });

  it('removes the legacy modules and keeps the runner adapter', () => {
    expect(retired.filter(p => existsSync(join(root, p)))).toEqual([]);
    expect(existsSync(join(root, 'src/plugins/des/material-flow-adapter.ts'))).toBe(true);
  });

  it('has no imports or re-exports of retired modules in either repo', () => {
    const violations: string[] = [];
    const dirs = ['src', 'tests', '../realvirtual-WebViewer-Private~/src',
      '../realvirtual-WebViewer-Private~/projects', '../realvirtual-WebViewer-Private~/tests'];
    for (const file of dirs.flatMap(dir => files(resolve(root, dir)))) {
      if (file === fileURLToPath(import.meta.url) || /des-legacy-inventory[^/\\]*$/.test(file)) continue;
      const text = readFileSync(file, 'utf8');
      // Static import/export-from, side-effect imports, and dynamic imports.
      const specifiers = /\b(?:import|export)\s+(?:[^;'"]*?\s+from\s*)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g;
      for (const match of text.matchAll(specifiers)) {
        const specifier = (match[1] ?? match[2]).replace(/\.(?:[cm]?[jt]sx?)$/, '');
        const resolved = specifier.startsWith('.') ? resolve(dirname(file), specifier) : specifier;
        if (names.has(specifier.split('/').pop()!)
          || resolved.replaceAll('\\', '/').endsWith('/core/material-flow/material-flow-adapter')) {
          violations.push(`${relative(root, file)}: ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('has no legacy plugin class or lookup in public source', () => {
    const forbidden = /\bgetPlugin\s*(?:<[^>]+>)?\s*\(\s*['"]des-plugin['"]|\bclass\s+DESPlugin\b/;
    expect(files(join(root, 'src')).filter(file => forbidden.test(readFileSync(file, 'utf8')))
      .map(file => relative(root, file))).toEqual([]);
  });
});
