// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { eagerGraphPaths } from '../helpers/static-import-graph';

const core = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const privateRoot = resolve(core, '../realvirtual-WebViewer-Private~');
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory()
    ? sources(join(dir, e.name)) : /\.[cm]?[jt]sx?$/.test(e.name) ? [join(dir, e.name)] : []);
}
function imports(source: string): string[] {
  const result: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)) result.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || ts.isIdentifier(node.expression) && node.expression.text === 'require')
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) result.push(node.arguments[0].text);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteral(node.argument.literal)) result.push(node.argument.literal.text);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile('scan.ts', source, ts.ScriptTarget.Latest, true));
  return result;
}
function target(file: string, spec: string): string {
  const resolved = spec.startsWith('@rv/') ? resolve(core, 'src', spec.slice(4))
    : spec.startsWith('@rv-private/') ? resolve(privateRoot, 'src', spec.slice(12))
    : spec.startsWith('.') ? resolve(dirname(file), spec) : spec;
  return resolved.replace(/\\/g, '/');
}

describe('PLC and event facade plugin boundaries', () => {
  it('detects value, type, multiline, dynamic and inline type imports', () => {
    expect(imports(`import type { A } from './a'; import { B }\n from './b';
      const c = import('./c'); type D = import('./d').D; export { E } from './e';
      // import('./ignored')
    `)).toEqual(['./a', './b', './c', './d', './e']);
  });

  it.skipIf(!existsSync(privateRoot))('Private PLC imports no DES internals (skipped if Private sibling is absent)', () => {
    const violations: string[] = [];
    for (const dir of ['src/plugins/plc', 'src/plc']) for (const file of sources(join(privateRoot, dir)))
      for (const spec of imports(readFileSync(file, 'utf8')))
        if (target(file, spec).includes('/src/plugins/des/')) violations.push(`${relative(privateRoot, file)}: ${spec}`);
    expect(violations).toEqual([]);
  });

  it('the logic engine module graph stays outside DES implementation modules', () => {
    const graph = eagerGraphPaths(resolve(core, 'src/core/engine/rv-logic-engine.ts'));
    expect(graph.some(file => file.endsWith('/rv-logic-step.ts'))).toBe(true);
    expect(graph.filter(file => file.includes('/plugins/des/'))).toEqual([]);
  });

  it('core event facade and snapshot types import no plugins', () => {
    for (const rel of ['src/core/sim-event-facade.ts', 'src/core/sdk/rv-snapshot-contract-types.ts']) {
      const file = join(core, rel);
      expect(imports(readFileSync(file, 'utf8')).filter(spec => target(file, spec).includes('/src/plugins/')), rel).toEqual([]);
    }
  });
});
