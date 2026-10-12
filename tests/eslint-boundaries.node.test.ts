// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Phase 6 of plan-182: ESLint enforces engine -> viewer boundary.
 *
 * Tests the rule by linting a synthetic source string. Runs in Node-env
 * (vitest.node.config.ts) because eslint is a Node.js library and the
 * Playwright browser-mode test runner can't import it cleanly.
 *
 * Note on rule IDs:
 *   eslint-plugin-boundaries v6 renamed 'element-types' to 'dependencies'.
 *   This config uses 'boundaries/dependencies' (the v6 canonical name).
 *   See eslint.config.js and plan-182 Phase 6 implementation notes.
 */

import { describe, it, expect } from 'vitest';
import { ESLint } from 'eslint';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const WEBVIEWER_ROOT = resolve(__dirname, '..');

/**
 * The linter, pinned to the tree it is actually linting.
 *
 * `boundaries/elements` patterns are relative to the plugin's ROOT PATH, and
 * that root is `process.cwd()` unless `boundaries/root-path` says otherwise -
 * ESLint's own `cwd` option does NOT reach the plugin. Where the two disagree,
 * no element type matches, every file is unclassified and the boundary rule
 * silently reports nothing: the exact silent-pass the config comments warn
 * about. It disagrees for real on a checkout reached through a `subst` drive,
 * where `__dirname` resolves to the underlying path while the process cwd keeps
 * the substituted one. Stating the root removes the dependency entirely.
 */
function boundaryLinter(): ESLint {
  return new ESLint({
    cwd: WEBVIEWER_ROOT,
    overrideConfig: { settings: { 'boundaries/root-path': WEBVIEWER_ROOT } },
  });
}

describe('ESLint boundary enforcement (plan-182 Phase 6)', () => {
  it('flags an engine/ file that imports from rv-viewer', async () => {
    const eslint = boundaryLinter();
    const results = await eslint.lintText(
      `import type { RVViewer } from '../rv-viewer';\nexport const _ = 1;`,
      { filePath: resolve(WEBVIEWER_ROOT, 'src/core/engine/_synthetic.ts') }
    );
    // In eslint-plugin-boundaries v6 the rule was renamed from 'element-types'
    // to 'dependencies'. Both names work but v6 canonical is 'boundaries/dependencies'.
    const hasBoundaryError = results[0].messages.some(
      m => m.ruleId === 'boundaries/dependencies' || m.ruleId === 'boundaries/element-types'
    );
    expect(hasBoundaryError).toBe(true);
  }, 120000);  // ESLint startup is slow, and slower still from the cold temp copy the
  // community precheck stages (scripts/precheck-community.mjs).

  it('allows an engine/ file that does NOT import from rv-viewer', async () => {
    const eslint = boundaryLinter();
    const results = await eslint.lintText(
      `import { Vector3 } from 'three';\nexport const _ = 1;`,
      { filePath: resolve(WEBVIEWER_ROOT, 'src/core/engine/_synthetic_ok.ts') }
    );
    const boundaryErrors = results[0].messages.filter(
      m => m.ruleId === 'boundaries/dependencies' || m.ruleId === 'boundaries/element-types'
    );
    expect(boundaryErrors).toHaveLength(0);
  }, 120000);
});
