// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * editor-mode-detached.node.test.ts — every `editor` mode registration must
 * carry `runtime: 'detached'`.
 *
 * ModeManager.register is a last-wins Map.set, and several feature adapters
 * (asset editor, the six CAD importers, AML import, …) each register the
 * `editor` mode so no adapter has to assume another one brought it. That only
 * works while ALL registrations agree on the shape: one adapter dropping
 * `runtime: 'detached'` — and happening to run last — silently re-attaches
 * time integration for the whole editor session. Drives, LogicSteps and
 * mechanisms then keep running while authoring, and the in-place test run's
 * Stop loses its meaning (the restored scene starts moving immediately).
 * Exactly that shipped once, via the AML import adapter (internal tier, runs
 * after every customer-tier registration).
 *
 * This test scans BOTH source trees for editor-mode registrations and asserts
 * the field on every single one. The private half is skipped on a public
 * checkout. Runs in the Node environment (vitest.node.config.ts).
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PUBLIC_SRC = resolve(__dirname, '../src');
const PRIVATE_SRC = resolve(__dirname, '../../realvirtual-WebViewer-Private~/src');

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(path);
  }
  return files;
}

/** All `…register({ id: 'editor', … })` object literals in a source tree. */
function editorRegistrations(root: string): { file: string; literal: string }[] {
  const found: { file: string; literal: string }[] = [];
  for (const file of sourceFiles(root)) {
    const src = readFileSync(file, 'utf-8');
    // Registration call with an inline object literal naming the editor mode.
    // [^}]* keeps the match inside ONE literal — good enough for the flat
    // descriptor shape every adapter uses.
    const re = /\.register\(\s*\{[^}]*id:\s*['"]editor['"][^}]*\}/g;
    for (const m of src.matchAll(re)) {
      found.push({ file, literal: m[0] });
    }
  }
  return found;
}

function assertAllDetached(root: string, minCount: number): void {
  const regs = editorRegistrations(root);
  expect(
    regs.length,
    `expected at least ${minCount} editor-mode registration(s) under ${root}`,
  ).toBeGreaterThanOrEqual(minCount);
  const offenders = regs.filter(r => !/runtime:\s*['"]detached['"]/.test(r.literal));
  expect(
    offenders.map(o => o.file),
    'editor-mode registrations missing runtime: \'detached\' (last-wins overwrite re-attaches the editor)',
  ).toEqual([]);
}

describe('editor mode registrations', () => {
  it('public: any editor registration declares runtime: detached', () => {
    // The community core registers no editor mode at all (the mode comes from
    // the private asset-editor adapter) — zero registrations is fine here, a
    // registration without the flag is not.
    assertAllDetached(PUBLIC_SRC, 0);
  });

  it.skipIf(!existsSync(PRIVATE_SRC))(
    'private: every editor registration declares runtime: detached',
    () => {
      assertAllDetached(PRIVATE_SRC, 1);
    },
  );
});
