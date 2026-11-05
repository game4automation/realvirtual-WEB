// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { RESERVED_PRIM_NAMES } from '../src/core/usd/usd-prim-names';

/** Analyze constructor arguments, including constants: do not rely on a hand-picked regex of names. */
function exporterNames(source: string): { structural: string[]; shader: string[] } {
  const file = ts.createSourceFile('USDZExporter.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const structural = new Set<string>(), shader = new Set<string>();
  function literal(expr: ts.Expression, use: ts.Node): string | null {
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
    if (!ts.isIdentifier(expr)) return null;
    let scope: ts.Node | undefined = use.parent;
    while (scope) {
      let declaration: ts.VariableDeclaration | undefined;
      const find = (n: ts.Node) => {
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === expr.text && n.initializer) declaration = n;
        if (n === scope || !ts.isFunctionLike(n)) ts.forEachChild(n, find);
      };
      find(scope);
      if (declaration) return literal(declaration.initializer!, declaration);
      scope = scope.parent;
    }
    return null;
  }
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node) && node.expression.getText(file) === 'USDNode' && node.arguments?.[0]) {
      const name = literal(node.arguments[0], node);
      if (name) {
        const type = node.arguments[1] && literal(node.arguments[1], node);
        (type === 'Shader' ? shader : structural).add(name);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { structural: [...structural].sort(), shader: [...shader].sort() };
}
const require = createRequire(import.meta.url);
const exporter = readFileSync(require.resolve('three/examples/jsm/exporters/USDZExporter.js'), 'utf8');

describe('exporter reserved-name guard', () => {
  it('all fixed structural names belong to RESERVED_PRIM_NAMES; shader namespace is separately pinned', () => {
    const names = exporterNames(exporter);
    expect(names.structural).toEqual(['Geometry', 'Materials', 'Root', 'Scene', 'Scenes']);
    expect(names.structural.filter((n) => !(RESERVED_PRIM_NAMES as readonly string[]).includes(n))).toEqual([]);
    // Shaders live under a material, so they cannot be siblings of authored scene nodes.
    expect(names.shader).toEqual(['PreviewSurface']);
  });
  it('a newly introduced literal or constant-backed structural name turns the guard red', () => {
    for (const extra of ["new USDNode('NewExporterPrim', 'Xform');", "const extraName = 'NewExporterPrim'; new USDNode(extraName, 'Xform');"]) {
      const names = exporterNames(exporter + '\n' + extra);
      expect(names.structural.filter((n) => !(RESERVED_PRIM_NAMES as readonly string[]).includes(n))).toEqual(['NewExporterPrim']);
    }
  });
});
