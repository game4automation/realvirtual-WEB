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

  it('registers feature-matrix only from the internal manifest', () => {
    const internal = readFileSync(INTERNAL_MANIFEST, 'utf-8');
    expect(/from\s+['"]\.\/plugins\/feature-matrix\/feature-matrix-plugin['"]/.test(internal)).toBe(true);
    expect(/viewer\.use\(new\s+FeatureMatrixPlugin\(\),\s*['"]internal['"]\)/.test(internal)).toBe(true);
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
