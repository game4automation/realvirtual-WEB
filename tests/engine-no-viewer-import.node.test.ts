// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Phase 2 of plan-182: engine/-Schicht ist zykelfrei.
 *
 * Verifiziert dass KEINE Datei in `src/core/engine/` direkt aus `rv-viewer.ts`
 * oder transitiv aus `rv-plugin.ts` (welches selbst rv-viewer importiert)
 * importiert. ViewerHost-Interface in `engine/rv-viewer-host.ts` macht diese
 * Trennung möglich.
 *
 * Läuft im Node-Environment (siehe vitest.node.config.ts).
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ENGINE_DIR = resolve(__dirname, '../src/core/engine');

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (entry.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

describe('engine/ import topology (plan-182 Phase 2)', () => {
  const files = walk(ENGINE_DIR);

  it(`scans engine/ directory (${ENGINE_DIR})`, () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('no engine/* file imports from rv-viewer', () => {
    const violations: string[] = [];
    // A type-only import (`import type { X } from '../rv-viewer'`) is erased at build time —
    // no runtime module-graph edge, so no cycle. Scanning per line, not per match, so a
    // type-only import of rv-viewer stays allowed even when the file ALSO has an unrelated
    // value import elsewhere.
    const RV_VIEWER_IMPORT = /from\s+['"][./]+rv-viewer['"]/;
    const TYPE_ONLY_IMPORT = /^\s*import\s+type\b/;
    for (const file of files) {
      const src = readFileSync(file, 'utf-8');
      for (const line of src.split('\n')) {
        if (RV_VIEWER_IMPORT.test(line) && !TYPE_ONLY_IMPORT.test(line)) {
          violations.push(file);
          break;
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('no engine/* file imports from rv-plugin (which transitively pulls rv-viewer)', () => {
    const violations: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf-8');
      // Same rule, applied to rv-plugin (NOT rv-plugin-loader/rv-plugin-types/etc)
      if (/from\s+['"][./]+rv-plugin['"]/.test(src)) {
        violations.push(file);
      }
    }
    // rv-plugin-loader.ts now uses PluginLoadable (plan-182 Phase 2) and no longer
    // imports from rv-plugin — so this list should be empty.
    expect(violations).toEqual([]);
  });
});
