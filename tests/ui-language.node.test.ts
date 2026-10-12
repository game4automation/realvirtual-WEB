// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-510 §9.5 — the UI is English (user decision: English + test, no i18n
 * layer). Scans every string literal, template chunk and JSX text under `src/`
 * with the TypeScript compiler API and fails on German UI text: an umlaut / ß,
 * or a whole German word from a conservative list.
 *
 * Not scanned: comments, import/export paths, `console.*` arguments,
 * `data-testid` values. The scan is a HEURISTIC against relapses, not a proof
 * of completeness (the FMU migration's completeness is the string inventory in
 * the plan).
 *
 * Existing German text outside the inspector scope is frozen in
 * `tests/fixtures/ui-language-allowlist.json`: an entry that no longer occurs
 * fails (the list only shrinks), the entry count is capped by
 * `ALLOWLIST_CEILING` (lowered after cleanups, never raised without the user's
 * approval), and no inspector-scope file may be in it at all.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, matchesGlob } from 'node:path';
import ts from 'typescript';

const ROOT = resolve(__dirname, '..');
const ALLOWLIST_PATH = resolve(ROOT, 'tests/fixtures/ui-language-allowlist.json');

/** Frozen size of the allowlist — only ever LOWERED (bootstrap plan-510). */
const ALLOWLIST_CEILING = 10;

/**
 * Files that must be German-free with NO allowlist entry: the inspector lint
 * scope (eslint.config.js HMI_DESIGN_SCOPE) plus the other FMU UI files.
 */
const LANGUAGE_SCOPE = [
  'src/core/hmi/rv-*inspector*.tsx',
  'src/core/hmi/rv-field-*.tsx',
  'src/core/hmi/rv-component-section.tsx',
  'src/core/hmi/rv-signal-slot-row.tsx',
  'src/core/hmi/rv-*-field-renderer.tsx',
  'src/core/hmi/Fmu*.tsx',
  'src/core/hmi/inspector-*.tsx',
  'src/core/hmi/rv-baked-geometry-section.tsx',
  'src/plugins/signal-bind/*.tsx',
  'src/core/hmi/fmu-trust-store.ts',
  'src/plugins/fmu-provisioning-plugin.ts',
];

const UMLAUT = /[äöüÄÖÜß]/;
const GERMAN_WORD = /\b(und|nicht|wird|läuft|übernehmen|zurück|abbrechen|speichern|löschen|neustart|vertrauen|datei|keine|entfernen|konflikte?|starten|fehler|wert|oder)\b/i;

export interface LanguageFinding { file: string; text: string }

/** True when a text reads as German UI text. */
function isGerman(text: string): boolean {
  return UMLAUT.test(text) || GERMAN_WORD.test(text);
}

function isConsoleCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'console';
}

/** Whether a literal sits in a place that is never UI text. */
function isExempt(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  // import x from '…' / export … from '…' / import('…') / require('…')
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isExternalModuleReference(parent)) return true;
  if (ts.isLiteralTypeNode(parent)) return true;
  if (ts.isCallExpression(parent) && (parent.expression.kind === ts.SyntaxKind.ImportKeyword
    || (ts.isIdentifier(parent.expression) && parent.expression.text === 'require'))) return true;
  // data-testid="…"
  if (ts.isJsxAttribute(parent) && parent.name.getText() === 'data-testid') return true;
  // Anything inside console.*(…)
  for (let n: ts.Node | undefined = parent; n; n = n.parent) {
    if (isConsoleCall(n)) return true;
    if (ts.isBlock(n) || ts.isSourceFile(n)) break;
  }
  return false;
}

/** Every German-looking UI text in one source text. */
export function scanSource(fileName: string, source: string): string[] {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    let text: string | null = null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text;
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) text = node.text;
    else if (ts.isJsxText(node)) text = node.text.trim();
    if (text && isGerman(text) && !isExempt(node)) hits.push(text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) out.push(full);
  }
}

function inScope(file: string): boolean {
  return LANGUAGE_SCOPE.some((g) => matchesGlob(file, g));
}

let findings: LanguageFinding[];
let allowlist: LanguageFinding[];

beforeAll(() => {
  const files: string[] = [];
  walk(resolve(ROOT, 'src'), files);
  findings = [];
  const seen = new Set<string>();
  for (const full of files) {
    const file = full.slice(ROOT.length + 1).replace(/\\/g, '/');
    for (const text of scanSource(file, readFileSync(full, 'utf8'))) {
      const key = `${file}\u0000${text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ file, text });
    }
  }
  allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8')) as LanguageFinding[];
}, 120_000);

describe('UI language — the scanner (plan-510)', () => {
  it('comments with umlauts, console arguments, import paths and test ids are ignored', () => {
    const src = [
      '// Kommentar: läuft nicht, wird übernommen',
      '/* Fehler beim Speichern */',
      "import x from './datei-und-wert';",
      "console.warn('Fehler: Datei nicht gefunden', `oder ${x}`);",
      'const a = <div data-testid="löschen">ok</div>;',
      "type T = 'löschen';",
      "const ok = 'Save as start value';",
    ].join('\n');
    expect(scanSource('probe.tsx', src)).toEqual([]);
  });

  it('the known old FMU texts are detected (negative fixtures)', () => {
    const src = [
      "const a = 'Entfernen';",
      'const b = `Konflikte`;',
      "const c = 'Als Startwert übernehmen';",
      'const d = <span>Vertrauen &amp; starten</span>;',
      "const e = `${n} FMUs in CONNECT ausführen?`;",
    ].join('\n');
    const hits = scanSource('probe.tsx', src);
    expect(hits).toContain('Entfernen');
    expect(hits).toContain('Konflikte');
    expect(hits).toContain('Als Startwert übernehmen');
    expect(hits.some((h) => h.includes('Vertrauen'))).toBe(true);
    expect(hits.some((h) => h.includes('ausführen'))).toBe(true);
  });
});

describe('UI language — src/ (plan-510)', () => {
  it('no German UI text in string literals / JSX text outside the frozen allowlist', () => {
    const allowed = new Set(allowlist.map((a) => `${a.file}\u0000${a.text}`));
    const fresh = findings.filter((f) => !allowed.has(`${f.file}\u0000${f.text}`));
    expect(fresh, `German UI text — write English (DESIGN.md). NEVER extend the allowlist without the user's approval:\n${fresh.map((f) => `${f.file}: ${JSON.stringify(f.text)}`).join('\n')}`).toEqual([]);
  });

  it('every allowlist entry still occurs (the list only shrinks)', () => {
    const found = new Set(findings.map((f) => `${f.file}\u0000${f.text}`));
    const gone = allowlist.filter((a) => !found.has(`${a.file}\u0000${a.text}`));
    expect(gone, `Remove these allowlist entries and lower ALLOWLIST_CEILING:\n${gone.map((g) => `${g.file}: ${JSON.stringify(g.text)}`).join('\n')}`).toEqual([]);
  });

  it('no inspector-scope / FMU UI file is in the allowlist', () => {
    expect(allowlist.filter((a) => inScope(a.file))).toEqual([]);
  });

  it('the allowlist never grows: its size equals the ceiling (lower it after a cleanup, never raise it)', () => {
    expect(allowlist.length, `ui-language-allowlist.json grew to ${allowlist.length} (ceiling ${ALLOWLIST_CEILING}) — write English instead.`)
      .toBeLessThanOrEqual(ALLOWLIST_CEILING);
    expect(allowlist.length, `The allowlist shrank to ${allowlist.length} — lower ALLOWLIST_CEILING to ${allowlist.length}.`)
      .toBe(ALLOWLIST_CEILING);
  });
});
