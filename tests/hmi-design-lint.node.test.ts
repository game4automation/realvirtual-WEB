// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-510 §9.4 — the HMI design guardrail as a gate.
 *
 * ESLint runs in no CI, so the `rv/hmi-design` rule of `eslint.config.js` is
 * enforced HERE (part of `npm run test:node` and `npm run test:all`):
 *
 *  1. The inspector scope lints with 0 design errors once the frozen baseline
 *     (`eslint-suppressions.json`) is applied — a NEW local colour / numeric
 *     font size / px column / `type="number"` in a scope file is red.
 *  2. The baseline is current: no entry allows more violations than the file
 *     still has ("stale" → `npm run lint:prune`).
 *  3. The baseline never grows: its file count and violation total must equal
 *     the ceilings below. Raising a ceiling is a visible edit of THIS file and is
 *     forbidden without the user's approval (DESIGN.md, CLAUDE.md); after a
 *     `lint:prune` the ceilings are LOWERED to the new measurement.
 *  4. The selectors themselves are pinned by two permanent fixtures
 *     (`tests/fixtures/hmi-lint/bad.tsx` / `good.tsx`).
 *  5. The files cleaned by plan-510 carry no suppression at all.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ESLint, type Linter } from 'eslint';

const ROOT = resolve(__dirname, '..');
const RULE = 'no-restricted-syntax';

/**
 * The frozen size of `eslint-suppressions.json` — only ever LOWERED.
 * Bootstrap (plan-510): 14 files / 172 violations. plan-514 migrated the whole
 * inspector scope, so the baseline is now EMPTY (`{}`): every design violation
 * in a scope file is an error.
 */
const SUPPRESSION_CEILING = { files: 0, total: 0 } as const;

/** Files plan-510 made clean — they must never re-enter the baseline. */
const CLEAN_FILES = [
  'src/core/hmi/FmuAttachAction.tsx',
  'src/core/hmi/rv-fmu-parameters-field-renderer.tsx',
  'src/core/hmi/FmuTrustDialog.tsx',
  'src/core/hmi/rv-field-editors.tsx',
  'src/core/hmi/rv-inspector-row.tsx',
  'src/core/hmi/rv-inspector-blocks.tsx',
];

type Suppressions = Record<string, Record<string, { count: number }>>;

interface HmiConfig {
  HMI_DESIGN_SCOPE: string[];
  HMI_DESIGN_IGNORES: string[];
  HMI_DESIGN_RESTRICTIONS: Array<{ selector: string; message: string }>;
}

let cfg: HmiConfig;
let unsuppressed: ESLint.LintResult[];

function rel(p: string): string {
  return p.slice(ROOT.length + 1).replace(/\\/g, '/');
}

function readSuppressions(): Suppressions {
  return JSON.parse(readFileSync(resolve(ROOT, 'eslint-suppressions.json'), 'utf8')) as Suppressions;
}

function designCount(r: ESLint.LintResult): number {
  return r.messages.filter((m) => m.ruleId === RULE).length;
}

beforeAll(async () => {
  cfg = (await import(/* @vite-ignore */ pathToFileURL(resolve(ROOT, 'eslint.config.js')).href)) as unknown as HmiConfig;
  const eslint = new ESLint({ cwd: ROOT });
  unsuppressed = await eslint.lintFiles(cfg.HMI_DESIGN_SCOPE);
}, 120_000);

describe('HMI design lint — inspector scope (plan-510)', () => {
  it('the scope matches files (the rule is not silently empty)', () => {
    expect(unsuppressed.length).toBeGreaterThanOrEqual(20);
    const files = unsuppressed.map((r) => rel(r.filePath));
    expect(files).toContain('src/core/hmi/rv-property-inspector.tsx');
    expect(files).toContain('src/core/hmi/FmuAttachAction.tsx');
    expect(files).toContain('src/core/hmi/rv-inspector-blocks.tsx');
  });

  it('0 design errors with the frozen baseline applied (a new violation in a scope file is red)', async () => {
    const eslint = new ESLint({ cwd: ROOT, applySuppressions: true });
    const results = await eslint.lintFiles(cfg.HMI_DESIGN_SCOPE);
    const offenders = results
      .map((r) => ({ file: rel(r.filePath), msgs: r.messages.filter((m) => m.ruleId === RULE) }))
      .filter((o) => o.msgs.length > 0)
      .map((o) => `${o.file}: ${o.msgs.map((m) => `L${m.line} ${m.message}`).join(' | ')}`);
    expect(offenders, `New HMI design violations — use the inspector building blocks + shared-sx values (DESIGN.md). NEVER extend eslint-suppressions.json.\n${offenders.join('\n')}`).toEqual([]);
  }, 120_000);

  it('the baseline is current: no entry allows more violations than the file has (else: npm run lint:prune)', () => {
    const sup = readSuppressions();
    const actual = new Map(unsuppressed.map((r) => [rel(r.filePath), designCount(r)]));
    const stale: string[] = [];
    for (const [file, rules] of Object.entries(sup)) {
      const allowed = rules[RULE]?.count ?? 0;
      const has = actual.get(file) ?? 0;
      if (allowed > has) stale.push(`${file}: baseline ${allowed}, actual ${has}`);
    }
    expect(stale, `Stale baseline — run \`npm run lint:prune\` and lower SUPPRESSION_CEILING in this file.\n${stale.join('\n')}`).toEqual([]);
  });

  it('the baseline never grows: file count and total equal the ceiling (lower it after a prune, never raise it)', () => {
    const sup = readSuppressions();
    const files = Object.keys(sup).length;
    const total = Object.values(sup).reduce((s, rules) => s + (rules[RULE]?.count ?? 0), 0);
    expect(files, `eslint-suppressions.json grew to ${files} files (ceiling ${SUPPRESSION_CEILING.files}). Fix the new violations instead of suppressing them.`)
      .toBeLessThanOrEqual(SUPPRESSION_CEILING.files);
    expect(total, `eslint-suppressions.json grew to ${total} violations (ceiling ${SUPPRESSION_CEILING.total}). Fix the new violations instead of suppressing them.`)
      .toBeLessThanOrEqual(SUPPRESSION_CEILING.total);
    expect(files, `The baseline shrank to ${files} files — lower SUPPRESSION_CEILING.files to ${files}.`).toBe(SUPPRESSION_CEILING.files);
    expect(total, `The baseline shrank to ${total} violations — lower SUPPRESSION_CEILING.total to ${total}.`).toBe(SUPPRESSION_CEILING.total);
  });

  it('only the design rule is suppressed, and never in a file plan-510 made clean', () => {
    const sup = readSuppressions();
    for (const [file, rules] of Object.entries(sup)) {
      expect(Object.keys(rules), file).toEqual([RULE]);
    }
    for (const clean of CLEAN_FILES) expect(sup[clean], clean).toBeUndefined();
    const actual = new Map(unsuppressed.map((r) => [rel(r.filePath), designCount(r)]));
    for (const clean of CLEAN_FILES) expect(actual.get(clean), clean).toBe(0);
  });

  it('package.json lint:baseline / lint:prune cover exactly the rule scope', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    for (const script of ['lint:baseline', 'lint:prune']) {
      const cmd = pkg.scripts[script];
      expect(cmd, script).toBeTruthy();
      for (const glob of cfg.HMI_DESIGN_SCOPE) expect(cmd, `${script} misses ${glob}`).toContain(glob);
    }
    expect(pkg.scripts['lint:baseline']).toContain(`--suppress-rule ${RULE}`);
    expect(pkg.scripts['lint:prune']).toContain('--prune-suppressions');
  });
});

describe('HMI design lint — selector fixtures (plan-510)', () => {
  async function lintFixture(name: string): Promise<Linter.LintMessage[]> {
    const tsParser = (await import('@typescript-eslint/parser')).default;
    const eslint = new ESLint({
      cwd: ROOT,
      overrideConfigFile: true,
      overrideConfig: [{
        files: ['**/*.tsx'],
        languageOptions: {
          parser: tsParser,
          parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
        },
        rules: { [RULE]: ['error', ...cfg.HMI_DESIGN_RESTRICTIONS] },
      }],
    });
    const [result] = await eslint.lintFiles([resolve(ROOT, 'tests/fixtures/hmi-lint', name)]);
    return result.messages;
  }

  /** Count of messages per selector (by the selector's message text). */
  function perSelector(msgs: Linter.LintMessage[]): number[] {
    return cfg.HMI_DESIGN_RESTRICTIONS.map((r) => msgs.filter((m) => m.message === r.message).length);
  }

  it('bad.tsx: the exact count per selector (incl. ternary fontSize, fontSize={12}, type={\'number\'}, template rgba, border rgba)', async () => {
    const msgs = await lintFixture('bad.tsx');
    expect(msgs.every((m) => m.ruleId === RULE), JSON.stringify(msgs.filter((m) => m.ruleId !== RULE))).toBe(true);
    // Order = HMI_DESIGN_RESTRICTIONS: hex, rgba, template rgba, fontSize prop, fontSize JSX, px, %, type=number.
    // The two fontSize selectors share one message text, so each counts 1 (JSX) + 3 (prop) = 4.
    expect(perSelector(msgs)).toEqual([2, 2, 1, 4, 4, 2, 1, 2]);
    expect(msgs).toHaveLength(2 + 2 + 1 + 4 + 2 + 1 + 2);
  });

  it('good.tsx: 0 errors (width 100%, FS.*, ICON_SIZE.*, INK_*, inputMode="decimal")', async () => {
    const msgs = await lintFixture('good.tsx');
    expect(msgs, JSON.stringify(msgs)).toEqual([]);
  });
});
