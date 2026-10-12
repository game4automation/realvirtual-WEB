// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Source scanner behind the `ui.category` coverage guard (plan-597 §9.2).
 *
 * Parses with the TypeScript compiler API, not a regex: every capability
 * `ui: { … }` object literal with a `filter` property whose value is a string
 * literal must also carry a `category` property whose value is a string literal
 * from `CATEGORY_ORDER` minus `other`. Comments and JSDoc examples are not
 * object literals and are skipped by construction; `filter` as a CSS property
 * or an event payload field is not inside a `ui` object. Shared by the public
 * guard and the private sibling's own guard.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { CATEGORY_ORDER } from '../../src/core/engine/rv-component-category';

const ALLOWED: ReadonlySet<string> = new Set(CATEGORY_ORDER.filter((c) => c !== 'other'));

export interface Declaration {
  file: string;
  line: number;
  /** The type key the declaration belongs to (string literal or identifier text), or null. */
  typeKey: string | null;
  filter: string;
  category: string | null;
}

function propName(p: ts.ObjectLiteralElementLike): string | null {
  if (!ts.isPropertyAssignment(p)) return null;
  const n = p.name;
  if (ts.isIdentifier(n) || ts.isStringLiteral(n)) return n.text;
  return null;
}

function stringValue(e: ts.Expression): string | null {
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  return null;
}

/** The registration key next to a declaration: `type:` of an enclosing object
 *  literal, or the first argument of the enclosing call. */
function typeKeyOf(node: ts.Node): string | null {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isObjectLiteralExpression(p)) {
      for (const prop of p.properties) {
        if (propName(prop) === 'type' && ts.isPropertyAssignment(prop)) {
          return stringValue(prop.initializer) ?? prop.initializer.getText();
        }
      }
    }
    if (ts.isCallExpression(p)) {
      const first = p.arguments[0];
      if (!first) return null;
      return stringValue(first) ?? first.getText();
    }
  }
  return null;
}

/** Every `{ filter: '<literal>' }` object literal in one source text. */
export function scanSource(fileName: string, text: string): Declaration[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Declaration[] = [];
  const visit = (node: ts.Node): void => {
    // Only a capability `ui: { … }` object counts — `filter` is also a CSS
    // property in sx objects and an event payload field.
    if (ts.isObjectLiteralExpression(node) && ts.isPropertyAssignment(node.parent) && propName(node.parent) === 'ui') {
      let filter: string | null = null;
      let category: string | null = null;
      for (const prop of node.properties) {
        const name = propName(prop);
        if (!name || !ts.isPropertyAssignment(prop)) continue;
        if (name === 'filter') filter = stringValue(prop.initializer);
        else if (name === 'category') category = stringValue(prop.initializer);
      }
      if (filter !== null) {
        out.push({
          file: fileName,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          typeKey: typeKeyOf(node),
          filter,
          category,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Declarations that break the rule. */
export function violations(decls: readonly Declaration[]): Declaration[] {
  return decls.filter((d) => d.category === null || !ALLOWED.has(d.category));
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(p);
    }
  }
}

export function scanTree(dir: string, root: string): Declaration[] {
  const files: string[] = [];
  walk(dir, files);
  const out: Declaration[] = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    if (!/filter:\s*['"`]/.test(text)) continue;
    out.push(...scanSource(relative(root, f), text));
  }
  return out;
}

