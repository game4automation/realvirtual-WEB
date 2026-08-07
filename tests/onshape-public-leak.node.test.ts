// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * onshape-public-leak.node.test.ts — plan-237 §9.7 build_NoOnshapeInPublicBundle
 * (static variant).
 *
 * The public bundle is built exclusively from this repo's `src/` (the
 * @rv-private alias resolves to `src/private-stubs` under
 * VITE_PUBLIC_BUILD). Therefore: as long as NO file under public `src/`
 * imports Onshape modules, no Onshape code can reach the public bundle.
 * This static guard runs in milliseconds instead of a full production
 * build; the full dist-grep remains part of the deploy checklist.
 *
 * plan-252 extends the same guard to the USD provider: no public src file
 * may import the private usd-import modules or three's USDZLoader.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SRC = resolve(__dirname, '../src');

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      yield* walk(p);
    } else if (/\.(ts|tsx|js|jsx)$/.test(name)) {
      yield p;
    }
  }
}

describe('public bundle leak guard', () => {
  it('no public src file imports Onshape modules', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const text = readFileSync(file, 'utf8');
      // Import specifiers only — comments/labels mentioning Onshape are fine.
      if (/from\s+['"][^'"]*onshape[^'"]*['"]/i.test(text) ||
          /import\(\s*['"][^'"]*onshape[^'"]*['"]\s*\)/i.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no public src file imports USD modules (plan-252)', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const text = readFileSync(file, 'utf8');
      // Import specifiers only — comments mentioning USD are fine.
      if (/from\s+['"][^'"]*(usd-import|usd-to-three|USDZLoader)[^'"]*['"]/i.test(text) ||
          /import\(\s*['"][^'"]*(usd-import|usd-to-three|USDZLoader)[^'"]*['"]\s*\)/i.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
