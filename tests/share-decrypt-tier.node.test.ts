// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-560 §9.4 — where the encrypted-share decryptor lives.
 *
 * - The public tree knows only the seam: nothing in `src/` imports
 *   `decryptModelData` except `password-gate.tsx` itself (and, in the private
 *   sibling, the `share-decrypt` adapter).
 * - The adapter is a CUSTOMER-tier registration (the public demo never sets
 *   RV_INTERNAL), listed in tier-manifest.json and registered in manifest order.
 * - main.ts registers the private plugins before it boots `?glb=`.
 *
 * The private checks skip when the private sibling is absent (community clone).
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const ROOT = resolve(__dirname, '..');
const SRC = resolve(ROOT, 'src');
const PRIVATE = resolve(ROOT, '../realvirtual-WebViewer-Private~');
const HAS_PRIVATE = existsSync(resolve(PRIVATE, 'src/private-plugins.ts'));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(?:ts|tsx|mts)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Files whose import statements name `decryptModelData`. */
function importersOfDecryptModelData(dir: string): string[] {
  return sourceFiles(dir).filter((file) => {
    const src = readFileSync(file, 'utf8');
    return /import\s*\{[^}]*\bdecryptModelData\b[^}]*\}\s*from/.test(src)
      || /import\(\s*['"][^'"]*password-gate['"]\s*\)[\s\S]{0,200}\bdecryptModelData\b/.test(src);
  }).map((f) => relative(ROOT, f).replace(/\\/g, '/'));
}

describe('share-decrypt tier (plan-560)', () => {
  it('no public source imports decryptModelData — the public tree knows only the seam', () => {
    expect(importersOfDecryptModelData(SRC)).toEqual([]);
  });

  it('the public seam modules do not reference decryptModelData at all', () => {
    for (const f of ['src/core/share/rv-share-decrypt.ts', 'src/core/share/rv-share-boot.ts']) {
      expect(readFileSync(resolve(ROOT, f), 'utf8'), f).not.toMatch(/decryptModelData/);
    }
  });

  it('main.ts registers the private plugins before it boots ?glb=', () => {
    const main = readFileSync(resolve(SRC, 'main.ts'), 'utf8');
    const register = main.indexOf('registerPrivatePlugins(');
    const boot = main.indexOf('bootSharedGlb(');
    expect(register).toBeGreaterThan(-1);
    expect(boot).toBeGreaterThan(-1);
    expect(register).toBeLessThan(boot);
  });

  describe.skipIf(!HAS_PRIVATE)('private sibling', () => {
    it('the only private importer of decryptModelData is the share-decrypt adapter', () => {
      expect(importersOfDecryptModelData(resolve(PRIVATE, 'src')).map((f) => f.replace(/^\.\.\/realvirtual-WebViewer-Private~\//, '')))
        .toEqual(['src/features/share-decrypt.register.ts']);
    });

    it('tier-manifest.json declares share-decrypt as a (non-restricted) registration', () => {
      const manifest = JSON.parse(readFileSync(resolve(PRIVATE, 'tier-manifest.json'), 'utf8')) as {
        rules: { path: string; tier: string }[];
        registrations: Record<string, { adapter: string }>;
      };
      expect(manifest.registrations['share-decrypt']?.adapter).toBe('./features/share-decrypt.register');
      const rule = manifest.rules.find((r) => r.path === 'src/features/share-decrypt.register.ts');
      expect(rule === undefined || rule.tier === 'commercial').toBe(true);
    });

    it('private-plugins.ts registers it in the customer tier, in manifest order', () => {
      const src = readFileSync(resolve(PRIVATE, 'src/private-plugins.ts'), 'utf8');
      const customer = src.split(/if\s*\(\s*__RV_INTERNAL__\s*\)/)[0]!;
      expect(customer).toContain("useFeature(viewer, 'share-decrypt', () => import('./features/share-decrypt.register'))");
      const manifest = JSON.parse(readFileSync(resolve(PRIVATE, 'tier-manifest.json'), 'utf8')) as {
        registrations: Record<string, unknown>;
      };
      const order = Object.keys(manifest.registrations);
      const used = [...customer.matchAll(/useFeature\(viewer, '([^']+)'/g)].map((m) => m[1]!);
      expect(used.indexOf('share-decrypt')).toBe(used.length - 1);
      expect(order.indexOf('share-decrypt')).toBe(order.indexOf(used[used.length - 2]!) + 1);
    });

    it('the adapter installs the cancellable password gate as the decryptor', () => {
      const src = readFileSync(resolve(PRIVATE, 'src/features/share-decrypt.register.ts'), 'utf8');
      expect(src).toMatch(/setSharedGlbDecryptor\(/);
      expect(src).toMatch(/decryptModelData\(envelope, \{ cancellable: true \}\)/);
      expect(src).not.toMatch(/SPDX-License-Identifier: AGPL/);
    });
  });
});
