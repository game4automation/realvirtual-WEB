// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * private-internal-gate.node.test.ts — Internal-tier build-gate guard.
 *
 * Internal/dev-only private features (DES, IK solver, STEP import, layout
 * cloud, …) live in internal-plugins.ts and must be loaded EXCLUSIVELY via a
 * `__RV_INTERNAL__`-gated dynamic import in private-plugins.ts. A static
 * import would keep their side-effectful registrations in every private
 * build — including customer deploys — even inside a dead branch. This test
 * reads the private manifest source and asserts the gate cannot silently
 * regress. Skips when the private folder is absent (public checkout).
 *
 * Runs in the Node environment (vitest.node.config.ts).
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PRIVATE_MANIFEST = resolve(
  __dirname,
  '../../realvirtual-WebViewer-Private~/src/private-plugins.ts',
);
const MAIN = resolve(__dirname, '../src/main.ts');
const PUBLIC_SRC = resolve(__dirname, '../src');
const INTERNAL_MANIFEST = resolve(
  __dirname,
  '../../realvirtual-WebViewer-Private~/src/internal-plugins.ts',
);
const FEATURE_MATRIX_ADAPTER = resolve(
  __dirname,
  '../../realvirtual-WebViewer-Private~/src/features/feature-matrix.register.ts',
);

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(path);
  }
  return files;
}

describe.skipIf(!existsSync(PRIVATE_MANIFEST))('private-plugins internal gate', () => {
  const src = () => readFileSync(PRIVATE_MANIFEST, 'utf-8');

  // Only actual import statements count — comments mentioning a feature are fine.
  const importLines = () =>
    src()
      .split('\n')
      .filter(l => /^\s*import\b/.test(l) || /\bfrom\s+['"]/.test(l))
      .join('\n');

  it('has no static imports of internal feature modules', () => {
    const block = importLines();
    expect(/internal-plugins/.test(block)).toBe(false);
    expect(/plugins\/des\b/.test(block)).toBe(false);
    expect(/ik-solver/.test(block)).toBe(false);
    expect(/step-import/.test(block)).toBe(false);
    expect(/layout-cloud/.test(block)).toBe(false);
    // plan-276: zone-based physics (Rapier provider + lib loader) is
    // internal-tier — a static import in the manifest would pull the
    // out-of-band Rapier path into every private build.
    expect(/physics/.test(block)).toBe(false);
    expect(/rapier/.test(block)).toBe(false);
    expect(/feature-matrix/.test(block)).toBe(false);
  });

  it('loads internal-plugins only behind __RV_INTERNAL__ via dynamic import', () => {
    expect(/if\s*\(\s*__RV_INTERNAL__\s*\)[\s\S]*?import\(\s*['"]\.\/internal-plugins['"]\s*\)/.test(src())).toBe(
      true,
    );
  });

  it('registers feature-matrix from the customer tier, through its adapter', () => {
    // plan-434 §2.7 / ADR-047: feature-matrix carries no tier rule, so it inherits
    // `commercial` from the manifest default and every standard delivery generates
    // a call to its adapter (tier-gate.node.test.ts). The demo shows that same
    // commercial scope, so the checked-in customer tier registers it too — and
    // internal-plugins.ts must NOT, or the internal build registers it twice.
    // (The earlier version of this test asserted the opposite; its premise, that
    // the adapter sits on the internal tier, stopped being true when the manifest
    // default flipped to `commercial`.)
    expect(/import\(\s*['"]\.\/features\/feature-matrix\.register['"]\s*\)/.test(src())).toBe(true);
    const internal = readFileSync(INTERNAL_MANIFEST, 'utf-8');
    expect(/features\/feature-matrix\.register/.test(internal)).toBe(false);
    const adapter = readFileSync(FEATURE_MATRIX_ADAPTER, 'utf-8');
    expect(/from\s+['"]\.\.\/plugins\/feature-matrix\/feature-matrix-plugin['"]/.test(adapter)).toBe(true);
    expect(/viewer\.use\(new\s+FeatureMatrixPlugin\(\),\s*['"]internal['"]\)/.test(adapter)).toBe(true);
  });

  it('customer tier registers exactly the commercial features of the manifest', () => {
    // The checked-in entry point and the one `generateCustomerPrivatePlugins()`
    // writes into a customer workspace must select the SAME features, or the demo
    // and a standard commercial delivery stop being the same product. Restricted
    // features (agents, omniverse) need a per-customer assignment and belong to
    // neither — they stay in the __RV_INTERNAL__-gated internal tier.
    const manifest = JSON.parse(
      readFileSync(resolve(__dirname, '../../realvirtual-WebViewer-Private~/tier-manifest.json'), 'utf-8'),
    ) as { rules: { path: string; tier: string }[]; registrations: Record<string, { adapter: string }> };
    const restricted = new Set(
      manifest.rules
        .filter((rule) => rule.tier === 'restricted')
        .map((rule) => rule.path.replace(/^src\//, '').replace(/\.ts$/, '')),
    );
    // Split at the GATE, not at the first mention of the flag — the file header
    // names `__RV_INTERNAL__` in prose long before the branch exists.
    const customerBlock = src().split(/if\s*\(\s*__RV_INTERNAL__\s*\)/)[0]!;
    const internal = readFileSync(INTERNAL_MANIFEST, 'utf-8');
    for (const [feature, registration] of Object.entries(manifest.registrations)) {
      const adapter = registration.adapter.replace(/^\.\//, '');
      const isRestricted = restricted.has(adapter);
      expect(customerBlock.includes(`'./${adapter}'`), `${feature} in customer tier`).toBe(!isRestricted);
      expect(internal.includes(`./${adapter}'`), `${feature} in internal tier`).toBe(isRestricted);
    }
  });

  it('has no static feature-matrix imports in the public source tree', () => {
    const offenders = sourceFiles(PUBLIC_SRC).filter((path) => {
      const imports = readFileSync(path, 'utf-8')
        .split('\n')
        .filter((line) => /^\s*(?:import|export)\b/.test(line) || /\bfrom\s+['"]/.test(line))
        .join('\n');
      return /feature-matrix/.test(imports);
    });
    expect(offenders).toEqual([]);
  });
});

describe('main.ts awaits the async private-plugin registration', () => {
  it('uses await registerPrivatePlugins(...) so modes register before mode-boot', () => {
    const src = readFileSync(MAIN, 'utf-8');
    expect(/await\s+registerPrivatePlugins\s*\(/.test(src)).toBe(true);
  });
});
