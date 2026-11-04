// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const privateRoot = resolve(root, '../realvirtual-WebViewer-Private~');
type ReadFile = (file: string) => string | undefined;

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
}

function runtimeImports(file: string, text: string): string[] {
  return parse(file, text).statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) return [];
    if (ts.isImportDeclaration(statement) ? statement.importClause?.isTypeOnly : statement.isTypeOnly) return [];
    const spec = statement.moduleSpecifier;
    return spec && ts.isStringLiteral(spec) ? [spec.text] : [];
  });
}

function originalMocks(text: string): string[] {
  // The factory parameter is Vitest's importOriginal, regardless of its name.
  const pattern = /\bvi\s*\.\s*mock\s*\(\s*(['"])([^'"]+)\1\s*,\s*async\s*(?:function\s*\w*\s*)?\(\s*[^)\s][^)]*\)/g;
  return Array.from(text.matchAll(pattern), (match) => match[2]!);
}

function resolveSpec(file: string, spec: string, read: ReadFile): string | undefined {
  const base = spec.startsWith('.') ? resolve(dirname(file), spec)
    : spec.startsWith('@rv/') ? resolve(root, 'src', spec.slice(4))
      : spec.startsWith('@rv-private/') ? resolve(privateRoot, 'src', spec.slice(12)) : undefined;
  if (!base) return undefined;
  const stem = base.replace(/\.js$/, '');
  return [stem + '.ts', stem + '.tsx', resolve(stem, 'index.ts'), resolve(stem, 'index.tsx'), base]
    .find((candidate) => read(candidate) !== undefined);
}

function createGraph(read: ReadFile): (file: string) => string[] {
  const cache = new Map<string, string[]>();
  return (file) => {
    if (!cache.has(file)) {
      cache.set(file, runtimeImports(file, read(file) ?? '').flatMap((spec) => {
        const target = resolveSpec(file, spec, read);
        return target ? [target] : [];
      }));
    }
    return cache.get(file)!;
  };
}

// Only cycles through the mocked module matter; a cycle elsewhere is harmless here.
function findCycle(start: string, edges: (file: string) => string[]): string[] | null {
  const visited = new Set<string>();
  const path: string[] = [];
  function visit(file: string): string[] | null {
    if (file === start && path.length) return [...path, start];
    if (visited.has(file)) return null;
    visited.add(file);
    path.push(file);
    for (const next of edges(file)) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    path.pop();
    return null;
  }
  return visit(start);
}

function testFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = resolve(dir, entry.name);
    return entry.isDirectory() ? testFiles(file)
      : /\.test\.tsx?$/.test(entry.name) && !/\.node\.test\.tsx?$/.test(entry.name) ? [file] : [];
  });
}

const files = new Map<string, string | undefined>();
const read: ReadFile = (file) => {
  if (!files.has(file)) {
    try { files.set(file, existsSync(file) ? readFileSync(file, 'utf8') : undefined); }
    catch (error) {
      if (!['ENOENT', 'EISDIR', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      files.set(file, undefined);
    }
  }
  return files.get(file);
};
const graph = createGraph(read);
const mocks = [resolve(root, 'tests'), resolve(privateRoot, 'tests')].flatMap(testFiles)
  .flatMap((file) => originalMocks(read(file)!).flatMap((spec) => {
    const target = resolveSpec(file, spec, read);
    return target ? [{ file, spec, target }] : [];
  }));
const display = (file: string): string => relative(root, file).replaceAll('\\', '/');

describe('importOriginal static import cycle guard', () => {
  it('keeps browser partial mocks off static runtime cycles', () => {
    const failures = mocks.flatMap(({ file, spec, target }) => {
      const cycle = findCycle(target, graph);
      return cycle ? [`${display(file)}: vi.mock('${spec}')\n${cycle.map(display).join(' -> ')}`] : [];
    });
    expect(failures, failures.join('\n\n') + '\nvi.mock with importOriginal on a module that is on a static import cycle deadlocks the browser runner at import time (the file hangs with no output) — break the cycle, e.g. move the needed symbol into a leaf module.').toEqual([]);
  });

  it('keeps the settings leaf away from the scene loading graph', () => {
    const seen = new Set<string>();
    function visit(file: string): void {
      if (seen.has(file)) return;
      seen.add(file);
      graph(file).forEach(visit);
    }
    visit(resolve(root, 'src/core/material-flow/des-manager-settings.ts'));
    for (const file of ['rv-rangefinder', 'rv-model-cache', 'rv-scene-loader']) {
      expect(seen.has(resolve(root, `src/core/engine/${file}.ts`))).toBe(false);
    }
  });

  it('detects the original edge in all five previously hanging files', () => {
    const rangefinder = resolve(root, 'src/core/engine/rv-rangefinder.ts');
    const manager = resolve(root, 'src/core/material-flow/des-manager-node.ts');
    const oldGraph = (file: string): string[] => file === rangefinder ? [...graph(file), manager] : graph(file);
    for (const name of ['library-snap-index', 'load-model-race', 'in-place-test-session', 'editor-save-authored-names', 'editor-save-shortcut']) {
      const matches = mocks.filter(({ file }) => file === resolve(root, `tests/${name}.test.ts`));
      expect(matches.some(({ target }) => findCycle(target, oldGraph) !== null), name).toBe(true);
    }
  });

  it.each([
    { name: 'runtime cycle', a: "import { type A, b } from './b.js';", b: "export * from './a';", cycle: ['a', 'b', 'a'] },
    { name: 'type and dynamic imports', a: "import type { B } from './b'; export type { B } from './b'; const b = import('./b');", b: "import './a';", cycle: null },
    { name: 'acyclic graph', a: "import './b';", b: 'export const b = 1;', cycle: null },
  ])('$name', ({ a, b, cycle }) => {
    const map = new Map([[resolve(root, 'a.ts'), a], [resolve(root, 'b.ts'), b]]);
    expect(findCycle(resolve(root, 'a.ts'), createGraph((file) => map.get(file))))
      .toEqual(cycle?.map((name) => resolve(root, `${name}.ts`)) ?? null);
  });
});
