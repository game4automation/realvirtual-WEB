// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Rules-of-hooks guard: no React component may call a hook AFTER an early
 * `return` in its body.
 *
 * `react-hooks/rules-of-hooks` is only a stub in `eslint.config.js`, so nothing
 * caught this. It is what took the whole HMI down for Festo: the Hierarchy
 * browser returned `null` while the editor plugin was not yet registered and
 * ran 40 more hooks once it was — React #310 on a mode switch or model load,
 * both side panels gone, the 3D scene still running. The fix pattern is a thin
 * gate component that returns early and renders the hook-carrying body.
 *
 * The scan is a line heuristic on the house formatting (2-space indent): a
 * top-level `return` / `if (…) return` / `if (…) { … return … }` at body
 * level, followed by a body-level hook call, in the same top-level
 * `function Name(` or `const Name = (` block.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const SCAN_DIRS = ['src', resolve(ROOT, '../realvirtual-WebViewer-Private~/src')];

const FN_START = /^(?:export\s+)?(?:function\s+([A-Z]\w*|use[A-Z]\w*)\s*[<(]|const\s+([A-Z]\w*|use[A-Z]\w*)\s*=\s*(?:React\.)?(?:memo\()?(?:function\b|\())/;
const EARLY_RETURN = /^ {2}(?:if\s*\(.*\)\s*return\b|return\b)/;
const IF_BLOCK_OPEN = /^ {2}if\s*\(.*\)\s*\{\s*$/;
const NESTED_RETURN = /^ {4}return\b/;
const HOOK_CALL = /^ {2}(?:(?:const|let)\s.*?=\s*)?use[A-Z]\w*\s*[<(]/;

function* tsxFiles(dir: string): Generator<string> {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* tsxFiles(p);
    else if (p.endsWith('.tsx')) yield p;
  }
}

function findHooksAfterEarlyReturn(source: string): Array<{ fn: string; returnLine: number; hookLine: number }> {
  const out: Array<{ fn: string; returnLine: number; hookLine: number }> = [];
  const lines = source.split(/\r?\n/);
  let fn: string | null = null;
  let earlyAt = 0;
  let inIfBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = FN_START.exec(line);
    if (m) { fn = m[1] ?? m[2]; earlyAt = 0; inIfBlock = false; continue; }
    if (line.startsWith('}')) { fn = null; continue; }
    if (!fn) continue;
    if (inIfBlock) {
      if (NESTED_RETURN.test(line) && !earlyAt) earlyAt = i + 1;
      if (/^ {2}\}/.test(line)) inIfBlock = false;
      continue;
    }
    if (IF_BLOCK_OPEN.test(line)) { inIfBlock = true; continue; }
    if (!earlyAt && EARLY_RETURN.test(line)) { earlyAt = i + 1; continue; }
    if (earlyAt && HOOK_CALL.test(line)) {
      out.push({ fn, returnLine: earlyAt, hookLine: i + 1 });
      fn = null;
    }
  }
  return out;
}

describe('rules of hooks — no hook after an early return', () => {
  it('detects the pattern that broke the Hierarchy browser', () => {
    const bad = [
      'export function Panel() {',
      '  const { plugin } = useEditorPlugin();',
      '  if (!plugin) return null;',
      '  const rows = useMemo(() => [], []);',
      '  return null;',
      '}',
    ].join('\n');
    expect(findHooksAfterEarlyReturn(bad)).toEqual([{ fn: 'Panel', returnLine: 3, hookLine: 4 }]);

    const blockForm = [
      'function Panel() {',
      '  if (!ready) {',
      '    return null;',
      '  }',
      '  const [a] = useState(0);',
      '}',
    ].join('\n');
    expect(findHooksAfterEarlyReturn(blockForm)).toHaveLength(1);
  });

  it('accepts the gate + body split and returns inside callbacks', () => {
    const good = [
      'export function Panel() {',
      '  const { plugin } = useEditorPlugin();',
      '  if (!plugin) return null;',
      '  return <Body plugin={plugin} />;',
      '}',
      'function Body() {',
      '  const cb = useCallback(() => {',
      '    if (x) return;',
      '  }, []);',
      '  const v = useMemo(() => 1, []);',
      '  return null;',
      '}',
    ].join('\n');
    expect(findHooksAfterEarlyReturn(good)).toEqual([]);
  });

  it('no component in src (public and private) calls a hook after an early return', () => {
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of tsxFiles(resolve(ROOT, dir))) {
        for (const hit of findHooksAfterEarlyReturn(readFileSync(file, 'utf8'))) {
          offenders.push(`${relative(ROOT, file)}:${hit.returnLine} ${hit.fn} — hook at line ${hit.hookLine}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
