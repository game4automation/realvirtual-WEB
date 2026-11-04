// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ESLint flat config — minimal setup for plan-182 Phase 6.
 *
 * INTENT: enforce ONLY the architecture-boundary rule from plan-182. We
 * deliberately do NOT enable style/formatting/quality rules — those would
 * flood the existing 80+ TS-file codebase with thousands of warnings.
 *
 * To run:    npx eslint src/
 * In CI:     npm run lint
 *
 * Boundary rule enforced:
 *   src/core/engine/* MUST NOT import from src/core/rv-viewer.ts or src/core/rv-plugin.ts
 *
 * Whitelisted exceptions are marked per-file with:
 *   // eslint-disable-next-line boundaries/dependencies -- legit: <reason>
 *
 * Implementation notes:
 *   - ESLint 10.x (flat-config-native), installed 2026-05-16 for plan-182 Phase 6
 *   - Node engine warning (requires >=20.19.0, running 20.15.0) is benign — ESLint
 *     runs correctly on 20.15.0 in this project
 *   - @typescript-eslint/parser used WITHOUT parserOptions.project (no type-aware
 *     linting) — boundary checks don't require type info and this keeps lint fast
 *   - eslint-plugin-boundaries v6: 'element-types' is renamed to 'dependencies';
 *     this config uses 'boundaries/dependencies' (the v6 canonical name).
 *   - Stub plugins for 'react-hooks' and '@typescript-eslint' are registered below.
 *     Existing source files contain eslint-disable-next-line comments for those rules
 *     (react-hooks/exhaustive-deps, @typescript-eslint/no-explicit-any).
 *     ESLint 10 always reports an error when a disable comment references an unknown
 *     rule. Installing minimal stubs that register the rule names as no-ops prevents
 *     those false positives without enabling any actual style/quality checks.
 */

import tsParser from '@typescript-eslint/parser';
import boundaries from 'eslint-plugin-boundaries';

/**
 * Creates a stub ESLint plugin that registers the given rule names as no-ops.
 *
 * This is needed because existing source files contain eslint-disable comments
 * for rules from plugins (react-hooks, @typescript-eslint) that are not installed
 * in this minimal config. ESLint 10 reports an error for every disable comment that
 * references an unknown rule. Registering stub rules silences those false positives
 * without activating any linting logic.
 *
 * @param {string[]} ruleNames - Rule names (without plugin prefix) to stub out
 * @returns ESLint plugin object with no-op rules
 */
function stubPlugin(ruleNames) {
  const noopRule = { create: () => ({}) };
  return {
    rules: Object.fromEntries(ruleNames.map(name => [name, noopRule])),
  };
}

// ── HMI design guardrails (plan-510) ──────────────────────────────────────
//
// The Property Inspector is built ONLY from the inspector building blocks
// (InspectorRow, InspectorSubheader, InspectorActionRow, DetailsDisclosure)
// and the design values in src/core/hmi/shared-sx.ts (see DESIGN.md). These
// selectors make a new local colour / font size / pixel column / number input
// in an inspector file an ERROR. Existing violations are frozen in
// eslint-suppressions.json — that baseline may only SHRINK (`npm run
// lint:prune`); tests/hmi-design-lint.node.test.ts fails when it grows, when it
// is stale, or when a scope file gains a violation. The test is part of
// `npm run test:node` / `npm run test:all`.

/** The inspector files the design rule applies to (keep package.json lint:baseline / lint:prune in sync — the test checks it). */
export const HMI_DESIGN_SCOPE = [
  'src/core/hmi/rv-*inspector*.tsx',
  'src/core/hmi/rv-field-*.tsx',
  'src/core/hmi/rv-component-section.tsx',
  'src/core/hmi/rv-signal-slot-row.tsx',
  'src/core/hmi/rv-*-field-renderer.tsx',
  'src/core/hmi/Fmu*.tsx',
  'src/core/hmi/inspector-*.tsx',
  'src/core/hmi/rv-baked-geometry-section.tsx',
  'src/plugins/signal-bind/*.tsx',
];

/** The only files allowed to hold colour literals: the design values themselves. */
export const HMI_DESIGN_IGNORES = ['src/core/hmi/theme.ts', 'src/core/hmi/shared-sx.ts'];

const SPACING_KEYS = '^(p|pl|pr|pt|pb|px|py|m|ml|mr|mt|mb|mx|my|width|minWidth|maxWidth|gap)$';

/** `no-restricted-syntax` options of the HMI design rule (also used by the fixture test). */
export const HMI_DESIGN_RESTRICTIONS = [
  {
    selector: 'Literal[value=/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/]',
    message: 'HMI design: no hex colour literal in inspector UI — use a colour from shared-sx.ts / theme.ts (DESIGN.md).',
  },
  {
    // Unanchored (deliberately stricter than plan-510 §4): also catches '1px solid rgba(…)' border strings.
    selector: 'Literal[value=/rgba?\\(/]',
    message: 'HMI design: no rgba() literal in inspector UI — use INK_* / DIVIDER / FIELD_* from shared-sx.ts (DESIGN.md).',
  },
  {
    selector: 'TemplateLiteral > TemplateElement[value.raw=/rgba?\\(/]',
    message: 'HMI design: no rgba() in a template literal in inspector UI — use a colour from shared-sx.ts (DESIGN.md).',
  },
  {
    selector: "Property[key.name='fontSize'] Literal[raw=/^[0-9]/]",
    message: 'HMI design: no numeric fontSize in inspector UI — use FS.* (or ICON_SIZE.* for icons) from shared-sx.ts (DESIGN.md).',
  },
  {
    selector: "JSXAttribute[name.name='fontSize'] Literal[raw=/^[0-9]/]",
    message: 'HMI design: no numeric fontSize in inspector UI — use FS.* (or ICON_SIZE.* for icons) from shared-sx.ts (DESIGN.md).',
  },
  {
    selector: `Property[key.name=/${SPACING_KEYS}/] Literal[value=/^[0-9.]+px$/]`,
    message: "HMI design: no 'NNpx' spacing/width in inspector UI — use theme spacing units or the InspectorRow grid (DESIGN.md).",
  },
  {
    selector: `Property[key.name=/${SPACING_KEYS}/] Literal[value=/^(?!100%$)[0-9.]+%$/]`,
    message: "HMI design: no percentage column in inspector UI — the InspectorRow grid owns the columns ('100%' is fine) (DESIGN.md).",
  },
  {
    selector: "JSXAttribute[name.name='type'] Literal[value='number']",
    message: 'HMI design: no type="number" input — use NumberEditor / DragNumberField (text + inputMode="decimal", parseDecimal) (DESIGN.md).',
  },
];

export default [
  {
    // Ignore non-src directories and config files
    ignores: [
      'dist/**',
      'node_modules/**',
      'public/**',
      'e2e/**',
      'tests/**',
      'scripts/**',
      '*.config.*',
    ],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    linterOptions: {
      // Suppress "Unused eslint-disable directive" warnings for stub rules
      // (react-hooks/exhaustive-deps, @typescript-eslint/*) that are registered
      // as no-ops. Since stub rules never report problems, their disable comments
      // are technically "unused". This setting prevents those noisy warnings.
      reportUnusedDisableDirectives: 'off',
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      boundaries,
      // Stub plugins to silence "Definition for rule X was not found" for
      // existing eslint-disable comments in the codebase.
      // These stubs register the rule names as no-ops — they do NOT activate
      // any style or quality checking.
      'react-hooks': stubPlugin(['exhaustive-deps', 'rules-of-hooks']),
      '@typescript-eslint': stubPlugin(['no-explicit-any', 'no-unused-vars', 'ban-ts-comment']),
    },
    settings: {
      // Configure eslint-module-utils to resolve TypeScript imports without extension.
      // Without this, '../rv-viewer' from an engine/ file cannot be resolved to
      // 'src/core/rv-viewer.ts' and eslint-plugin-boundaries cannot classify the
      // dependency element type — the boundary rule would silently not trigger.
      'import/resolver': {
        node: {
          extensions: ['.ts', '.tsx', '.js', '.jsx'],
        },
      },

      // Element definitions — rootPath defaults to cwd (the WebViewer root)
      // so patterns are relative to the project root.
      //
      // mode notes (eslint-plugin-boundaries v6):
      //   'full'   — matches the full file path against the glob (default for **)
      //   'file'   — matches individual filename or array of specific files
      //   Without explicit mode, specific .ts file patterns are not matched correctly.
      // IMPORTANT: Order matters — eslint-plugin-boundaries v6 uses a path-segment
      // accumulation algorithm. Specific file matchers use mode:'full' to match the
      // complete path in a single pass. Without mode:'full', the broad 'core' catch-all
      // (src/core/**) would match 'src/core' first and classify rv-viewer.ts as 'core',
      // silently bypassing the engine→viewer boundary rule.
      'boundaries/elements': [
        { type: 'engine',  pattern: 'src/core/engine/**',                                     mode: 'full' },
        { type: 'viewer',  pattern: ['src/core/rv-viewer.ts', 'src/core/rv-plugin.ts'],        mode: 'full' },
        { type: 'hmi',     pattern: 'src/core/hmi/**',                                         mode: 'full' },
        { type: 'plugins', pattern: 'src/plugins/**',                                          mode: 'full' },
        { type: 'hooks',   pattern: 'src/hooks/**',                                            mode: 'full' },
        { type: 'iface',   pattern: 'src/interfaces/**',                                       mode: 'full' },
        { type: 'core',    pattern: 'src/core/**',                                             mode: 'full' },
      ],
      'boundaries/include': ['src/**/*'],
    },
    rules: {
      // v6 canonical name for the dependency rule (replaces deprecated 'element-types')
      'boundaries/dependencies': ['error', {
        default: 'allow',
        rules: [
          // engine/ MUST NOT import from rv-viewer or rv-plugin — those re-export
          // RVViewer-typed surfaces and create a cycle. Use ViewerHost interface instead.
          // Validated clean by plan-182 Phase 2 (see engine-no-viewer-import.node.test.ts).
          { from: { type: 'engine' }, disallow: { to: { type: 'viewer' } } },
        ],
      }],
    },
  },
  {
    name: 'rv/safe-storage',
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/core/rv-safe-storage.ts'],
    rules: {
      'no-restricted-globals': ['error', ...['localStorage', 'sessionStorage'].map(name => ({
        name,
        message: 'Use src/core/rv-safe-storage.ts for storage access.',
      }))],
      'no-restricted-properties': ['error', ...['window', 'globalThis', 'self'].flatMap(object =>
        ['localStorage', 'sessionStorage'].map(property => ({
          object,
          property,
          message: 'Use src/core/rv-safe-storage.ts for storage access.',
        })))],
    },
  },
  {
    // plan-510 — HMI design guardrails for the inspector files (see top of file).
    name: 'rv/hmi-design',
    files: HMI_DESIGN_SCOPE,
    ignores: HMI_DESIGN_IGNORES,
    rules: {
      'no-restricted-syntax': ['error', ...HMI_DESIGN_RESTRICTIONS],
    },
  },
];
