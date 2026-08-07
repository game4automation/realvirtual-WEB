// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  generateCustomerPrivatePlugins,
  loadTierManifest,
  resolveTier,
} from '../scripts/_workspace-lib.mjs';

const privateRoot = resolve('../realvirtual-WebViewer-Private~');
const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

describe('customer source tier gate', () => {
  it('loads the authoritative manifest and assigns internal by default', () => {
    const manifest = loadTierManifest(privateRoot);
    expect(resolveTier(manifest, 'src/plugins/render-backends/omniverse.ts').tier).toBe('internal');
    expect(resolveTier(manifest, 'src/unlisted-module.ts').tier).toBe('internal');
    expect(resolveTier(manifest, 'src/plugins/step-import/index.ts').tier).toBe('restricted');
    // import-providers is tiered per file, so the internal entry point keeps the
    // default while the individual providers ship with their own feature.
    expect(resolveTier(manifest, 'src/plugins/import-providers/register-import-providers.ts').tier).toBe('internal');
    expect(resolveTier(manifest, 'src/plugins/import-providers/jt-import-provider.tsx').feature).toBe('jt-import');
  });

  it('generates the newly entitled importer adapters', () => {
    const manifest = loadTierManifest(privateRoot);
    const source = generateCustomerPrivatePlugins(manifest, {
      tier: 'commercial',
      restrictedFeatures: ['step-import', 'jt-import', 'usd-import', 'onshape-import', 'asset-manager-import'],
    });
    for (const feature of ['step-import', 'jt-import', 'usd-import', 'onshape-import', 'asset-manager-import']) {
      expect(source).toContain(`features/${feature}.register`);
    }
    expect(source).not.toContain('internal-plugins');
  });

  it('rejects overlapping and unsafe rules', () => {
    const root = mkdtempSync(join(tmpdir(), 'rv-tier-test-'));
    temporary.push(root);
    writeFileSync(join(root, 'tier-manifest.json'), JSON.stringify({
      defaults: 'internal',
      rules: [
        { path: 'src/plugins/**', tier: 'commercial' },
        { path: 'src/plugins/step/**', tier: 'restricted', feature: 'step' },
      ],
      registrations: { step: { adapter: '../escape', requires: [] } },
    }));
    expect(() => loadTierManifest(root)).toThrow();
  });

  it('generates only entitled adapters and never imports internal-plugins', () => {
    const manifest = loadTierManifest(privateRoot);
    const source = generateCustomerPrivatePlugins(manifest, {
      tier: 'commercial', restrictedFeatures: ['step-import'],
    });
    expect(source).toContain('features/diagnostics.register');
    expect(source).toContain('features/step-import.register');
    expect(source).not.toContain('features/ik-solver.register');
    expect(source).not.toContain('features/jt-import.register');
    expect(source).not.toContain('internal-plugins');
    expect(readFileSync(join(privateRoot, 'tier-manifest.json'), 'utf8')).toContain('"defaults": "internal"');
  });
});
