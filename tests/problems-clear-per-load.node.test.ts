// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 Phase 0a (F16, test 9.12, static half) — every Problems code has a
 * lifecycle classification.
 *
 * Scans `src/` (fs walk, node mode — the browser glob over all sources costs
 * ~113 s, see `bake-classification-once.node.test.ts`) for every code a module
 * that talks to `problems-store` reports:
 *  - `code: '<literal>'` — inside a Problems entry only: an object literal that
 *    carries `severity:` or is handed straight to a `problems-store` function
 *    (`isProblemsEntry`; the editor's own `{ code, message }` notices and result
 *    codes in the same modules never reach the panel),
 *  - `code: CONST` / `code: CONSTS.member` / `code: CONSTS[k]` resolved through
 *    the `const NAME = '…'` / `const NAME = Object.freeze({ … })` declarations of `src/`,
 *  - exported `…_CODE` / `…_CODES` / `…PROBLEM…` constants of those modules,
 *  - `clearProblemsOfCode('<literal>')`.
 * A code without an entry in `tests/helpers/problem-code-classification.ts`
 * fails, and so does an entry whose code no longer exists. A `code:` expression
 * the scanner cannot resolve fails unless it is on the short indirection list.
 *
 * The behaviour half (`clear-model` codes really leave on `clearModel()`) is
 * `problems-clear-per-load.test.ts`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROBLEM_CODE_CLASSIFICATION } from './helpers/problem-code-classification';
import { PRIVATE_SRC } from './helpers/static-import-graph';

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
// plan-2211: the DES experiment manager is a commercial module in the private sibling. Its
// Problems codes are scanned there when the sibling exists (dev, commercial builds); a
// community clone runs this test without it.
const privateModuleDir = resolve(PRIVATE_SRC, 'plugins', 'des-experiments');
const hasPrivateModule = existsSync(privateModuleDir);
// plan-2233: the commercial display wall reports its own code (old prefix lists ignored).
const privateWallDir = resolve(PRIVATE_SRC, 'display-wall');
const hasPrivateWall = existsSync(privateWallDir);
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;

/**
 * `code:` expressions that are not a code themselves but forward one whose
 * constant the scan already collects (file → expression → why).
 */
const INDIRECT_CODE_EXPRESSIONS: ReadonlyArray<readonly [string, string, string]> = [
  ['core/hmi/problems-store.ts', 'm.code', 'reportUnitProblem forwards a UNIT_PROBLEM_CODES value'],
  ['plugins/signal-bind/unit-scale.ts', 'PROBLEM_CODE_OF[k]', 'maps to UNIT_PROBLEM_CODES values'],
  ['plugins/mcp-bridge/rv-mcp-robot-tools.ts', 'p.code', 'problemsFor reads Problems entries back from getProblems() for web_robot_* answers; it reports none'],
  // plan-673 Phase 4: reportMjcfProblems forwards the code of each finding the
  // (private, pure) MJCF writer returned. The possible values are the exported
  // MJCF_PROBLEM_* constants of this very module, which the scan already
  // collects — which is exactly why those strings live in the public src/.
  ['core/engine/rv-mjcf-problems.ts', 'p.code', 'reportMjcfProblems forwards an MJCF_PROBLEM_CODES value'],
];

/**
 * `code:` expressions typed by a string-literal UNION declared in another module:
 * every member of the union is a code of the reporting file
 * (file → expression → declaring module → exported type name).
 */
const UNION_CODE_EXPRESSIONS: ReadonlyArray<readonly [string, string, string, string]> = [
  // plan-628 live path-network validation: publishes each `PathNetworkIssue` as is.
  ['plugins/path-network/path-network-validation.ts', 'i.code', 'core/engine/rv-path-network-validate.ts', 'PathNetworkIssueCode'],
  // plan-2013 V1: variant restoration forwards each `RecoveryProblem`; plan-2211: it lives in the
  // commercial experiment module of the private sibling (the column migration was removed, G7).
  ['private:des-experiments/backend/experiment-project-manager.ts', 'p.code', 'private:des-experiments/des/des-column-recovery.ts', 'RecoveryProblemCode'],
  // plan-2207 Phase 5b: the DES runner reports each registered DES-unsuitable entry (PLC D1/D2) under its code.
  ['plugins/des/des-runner.ts', 'entry.code', 'core/material-flow/des-unsuitable-entry.ts', 'DesUnsuitableCode'],
];

/** Comments out, string contents kept — doc comments mention `code:` in prose. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/**
 * The callees a module reaches `problems-store` through: its named imports
 * (`reportProblem`, `b as c` → `c`) and `ns.` for a namespace import
 * (`import * as problems` → `problems.`).
 */
function problemsStoreCallees(text: string): { names: Set<string>; namespaces: string[] } {
  const names = new Set<string>();
  const namespaces: string[] = [];
  for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"][^'"]*problems-store['"]/g)) {
    for (const part of m[1]!.split(',')) {
      const local = /(?:\bas\s+)?([A-Za-z_$][\w$]*)\s*$/.exec(part.trim())?.[1];
      if (local) names.add(local);
    }
  }
  for (const m of text.matchAll(/import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*['"][^'"]*problems-store['"]/g)) namespaces.push(m[1]!);
  return { names, namespaces };
}

/**
 * Is the object literal around `text[at]` a Problems entry? A module that imports
 * `problems-store` also carries other `{ code, … }` vocabularies — the asset
 * editor's rename notices (`auto-renamed`, `name-not-unique-in-file`), the
 * parametric regenerate's `VariantError` (`not-found`, `invalid-input`,
 * `commit-failed`), rewrite warnings mapped through `code: w.code` — that never
 * reach the panel. A literal counts when it IS a problem (it carries a
 * `severity:` — every `ProblemInput` does) or is handed straight to a
 * `problems-store` function (`reportX({ code })`, `reportX([{ code }, …])`),
 * whose helper owns the severity. Anything else is not a Problems code.
 */
function isProblemsEntry(text: string, at: number, callees: { names: Set<string>; namespaces: string[] }): boolean {
  let open = at - 1;
  for (let depth = 0; open >= 0; open--) {
    const c = text[open];
    if (c === '}') depth++;
    else if (c === '{') { if (depth === 0) break; depth--; }
  }
  if (open < 0) return true; // not inside a literal — keep it strict, let the resolver judge
  let close = at;
  for (let depth = 0; close < text.length; close++) {
    const c = text[close];
    if (c === '{') depth++;
    else if (c === '}') { if (depth === 0) break; depth--; }
  }
  if (/\bseverity\s*:/.test(text.slice(open, close))) return true;
  // The call the literal is an argument of: walk back over `[`, `(`, earlier array
  // elements `{…},` and whitespace to the callee identifier.
  let i = open - 1;
  for (let depth = 0; i >= 0; i--) {
    const c = text[i]!;
    if (c === '}' || c === ']') depth++;
    else if (c === '{' || c === '[') { if (depth === 0 && c === '{') return false; if (depth > 0) depth--; }
    else if (c === '(' && depth === 0) break;
    else if (depth === 0 && !/[\s,]/.test(c)) return false;
  }
  const callee = /([A-Za-z_$][\w$]*)(?:\s*\.\s*([A-Za-z_$][\w$]*))?\s*$/.exec(text.slice(Math.max(0, i - 80), i));
  if (!callee) return false;
  if (callee[2]) return callees.namespaces.includes(callee[1]!);
  return callees.names.has(callee[1]!);
}

/** The string-literal members of `export type <name> = 'a' | 'b' …;` in `file` (empty when absent). */
function unionMembers(texts: ReadonlyArray<{ file: string; text: string }>, file: string, name: string): string[] {
  const text = texts.find((t) => t.file === file)?.text ?? '';
  const body = new RegExp(`export\\s+type\\s+${name}\\s*=([^;]+);`).exec(text)?.[1] ?? '';
  return [...body.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

interface ScanResult {
  codes: Map<string, Set<string>>;
  unresolved: string[];
}

function scan(): ScanResult {
  const walk = (root: string, prefix: string) => {
    const files: string[] = [];
    (function rec(dir: string) {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) rec(p);
        else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name)) files.push(p);
      }
    })(root);
    return files.map((f) => ({ file: prefix + relative(root, f).split(sep).join('/'), text: stripComments(readFileSync(f, 'utf8')) }));
  };
  const texts = [...walk(srcDir, ''), ...(hasPrivateModule ? walk(privateModuleDir, 'private:des-experiments/') : []),
    ...(hasPrivateWall ? walk(privateWallDir, 'private:display-wall/') : [])];

  const strConst = new Map<string, string>();
  const objConst = new Map<string, string[]>();
  for (const { text } of texts) {
    for (const m of text.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*'([^']+)'/g)) strConst.set(m[1]!, m[2]!);
    for (const m of text.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*(?:Object\.freeze\()?\{([^}]*)\}/g)) {
      const vals = [...m[2]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!).filter((v) => KEBAB.test(v));
      if (vals.length > 0) objConst.set(m[1]!, vals);
    }
  }

  const codes = new Map<string, Set<string>>();
  const unresolved: string[] = [];
  const add = (code: string, file: string) => {
    if (!KEBAB.test(code)) return;
    if (!codes.has(code)) codes.set(code, new Set());
    codes.get(code)!.add(file);
  };
  for (const { file, text } of texts) {
    const isStore = file === 'core/hmi/problems-store.ts';
    if (!isStore && !/from\s+['"][^'"]*problems-store['"]/.test(text)) continue;
    const storeCalls = problemsStoreCallees(text);
    for (const m of text.matchAll(/\bcode:\s*([^,;}\n]+)/g)) {
      const expr = m[1]!.trim();
      if (/^string\b/.test(expr)) continue; // a type annotation
      if (!isProblemsEntry(text, m.index!, storeCalls)) continue;
      const literals = [...expr.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
      if (literals.length > 0) { for (const l of literals) add(l, file); continue; }
      const id = /^([A-Z][A-Z0-9_]*)\b/.exec(expr)?.[1];
      if (id && !/[.[]/.test(expr) && strConst.has(id)) { add(strConst.get(id)!, file); continue; }
      if (id && objConst.has(id)) { for (const v of objConst.get(id)!) add(v, file); continue; }
      if (INDIRECT_CODE_EXPRESSIONS.some(([f, e]) => f === file && e === expr)) continue;
      const union = UNION_CODE_EXPRESSIONS.find(([f, e]) => f === file && e === expr);
      if (union) {
        const members = unionMembers(texts, union[2], union[3]);
        for (const v of members) add(v, file);
        if (members.length > 0) continue;
      }
      unresolved.push(`${file}: code: ${expr}`);
    }
    for (const m of text.matchAll(/clearProblemsOfCode\(\s*'([^']+)'/g)) add(m[1]!, file);
    for (const m of text.matchAll(/export\s+const\s+([A-Z][A-Z0-9_]*(?:_CODES?|PROBLEM[A-Z_]*))\s*=/g)) {
      const name = m[1]!;
      if (strConst.has(name)) add(strConst.get(name)!, file);
      else for (const v of objConst.get(name) ?? []) add(v, file);
    }
  }
  return { codes, unresolved };
}

describe('plan-769 9.12 — every Problems code has a lifecycle classification', () => {
  let result: ScanResult;
  beforeAll(() => { result = scan(); });

  it('the scan finds the known anchor codes (scanner sanity)', () => {
    for (const c of ['unresolved-instruction-target', 'signal-name-collision', 'reference-unresolved', 'unit-scale-not-applied', 'web-operator-panel-config', 'des-zero-time-pulse']) {
      expect(result.codes.has(c), c).toBe(true);
    }
    expect(result.codes.size).toBeGreaterThanOrEqual(50);
    // Problems entries of modules that ALSO carry other `{ code }` vocabularies…
    for (const c of ['parametric-manual-attach', 'parametric-regenerate-failed']) expect(result.codes.has(c), c).toBe(true);
    // …whose rename notices and VariantError codes are no Problems codes.
    for (const c of ['auto-renamed', 'name-not-unique-in-file', 'not-found', 'invalid-input', 'commit-failed']) {
      expect(result.codes.has(c), c).toBe(false);
    }
  });

  it('every code reported in src/ is classified', () => {
    const missing = [...result.codes.keys()].filter((c) => !(c in PROBLEM_CODE_CLASSIFICATION))
      .map((c) => `${c} (${[...result.codes.get(c)!].join(', ')})`);
    expect(missing, 'add these to tests/helpers/problem-code-classification.ts').toEqual([]);
  });

  it('every classified code still exists in src/', () => {
    const stale = Object.entries(PROBLEM_CODE_CLASSIFICATION)
      .filter(([c, k]) => !result.codes.has(c)
        && (k.module === 'display-wall' ? hasPrivateWall : hasPrivateModule || !k.module)).map(([c]) => c);
    expect(stale, 'remove these from tests/helpers/problem-code-classification.ts').toEqual([]);
  });

  it('every `code:` expression of a problems module resolves to a literal', () => {
    expect(result.unresolved).toEqual([]);
  });

  it('every classification names who retires it', () => {
    for (const [code, c] of Object.entries(PROBLEM_CODE_CLASSIFICATION)) expect(c.retiredBy.trim(), code).not.toBe('');
  });
});
