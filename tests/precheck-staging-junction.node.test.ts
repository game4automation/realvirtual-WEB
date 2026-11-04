// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// plan-2222: the staged community tree must link node_modules via the NATIVE real path.
// (SUBST E: vs C:\Daten: two spellings of one tree break Rollup/Vite.) The script itself
// cannot be imported (it runs the whole precheck), so the contract is asserted on its source.
const src = readFileSync(new URL('../scripts/precheck-community.mjs', import.meta.url), 'utf8');

describe('precheck-community node_modules junction target (plan-2222)', () => {
  it('creates the junction from realpathSync.native, not a plain join', () => {
    expect(src).toMatch(/symlinkSync\(\s*realpathSync\.native\(join\(ROOT, 'node_modules'\)\)/);
    expect(src).not.toMatch(/symlinkSync\(nodeModules,/);
    expect(src).toMatch(/import \{[^}]*\brealpathSync\b[^}]*\} from 'node:fs'/);
  });

  it('realpathSync.native collapses a linked node_modules to the real location', () => {
    const real = mkdtempSync(join(tmpdir(), 'rv-junction-real-'));
    const nm = join(real, 'nm');
    mkdirSync(nm);
    const root = mkdtempSync(join(tmpdir(), 'rv-junction-link-'));
    symlinkSync(nm, join(root, 'node_modules'), 'junction');
    expect(realpathSync.native(join(root, 'node_modules'))).toBe(realpathSync.native(nm));
  });
});
