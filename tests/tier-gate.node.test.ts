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
  it('loads the authoritative manifest and assigns commercial by default', () => {
    const manifest = loadTierManifest(privateRoot);
    // Phase 2b run 3 flipped the default: everything private is commercial unless a rule
    // says otherwise, so a brand-new private module ships instead of being silently held back.
    expect(resolveTier(manifest, 'src/unlisted-module.ts').tier).toBe('commercial');
    // The CAD importers and the IK solver are part of the commercial standard since
    // plan-434 Phase 2b; `restricted` is reserved for per-customer joint developments.
    expect(resolveTier(manifest, 'src/plugins/step-import/index.ts').tier).toBe('commercial');
    expect(resolveTier(manifest, 'src/plugins/import-providers/jt-import-provider.tsx').tier).toBe('commercial');
    // The two restricted features keep their explicit rules.
    expect(resolveTier(manifest, 'src/render-backends/omniverse-backend.ts').tier).toBe('restricted');
    expect(resolveTier(manifest, 'src/render-backends/omniverse-backend.ts').feature).toBe('omniverse');
    expect(resolveTier(manifest, 'src/plugins/agents/agent-plugin.tsx').tier).toBe('restricted');
    // The internal aggregate entry points stay behind: they import everything and would
    // reach the customer as dead code with dangling imports.
    expect(resolveTier(manifest, 'src/plugins/import-providers/register-import-providers.ts').tier).toBe('internal');
    expect(resolveTier(manifest, 'src/internal-plugins.ts').tier).toBe('internal');
    expect(resolveTier(manifest, 'src/private-plugins.ts').tier).toBe('internal');
  });

  it('generates the importer adapters from the commercial tier alone', () => {
    const manifest = loadTierManifest(privateRoot);
    // No entitlement any more: the importers are commercial, so an empty
    // `restrictedFeatures` list must still produce every importer adapter.
    const source = generateCustomerPrivatePlugins(manifest, {
      tier: 'commercial',
      restrictedFeatures: [],
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

  it('generates every commercial adapter and never imports internal-plugins', () => {
    const manifest = loadTierManifest(privateRoot);
    const source = generateCustomerPrivatePlugins(manifest, {
      tier: 'commercial', restrictedFeatures: [],
    });
    for (const feature of [
      'diagnostics', 'step-import', 'jt-import', 'fbx-import', 'ik-solver',
      // Since the default flip these adapters carry no rule at all and inherit `commercial`.
      'kinematic-mechanism', 'machining', 'des', 'plc', 'physics', 'feature-matrix',
    ]) {
      expect(source).toContain(`features/${feature}.register`);
    }
    // Restricted and unassigned: the two per-customer features stay out of a delivery
    // whose `restrictedFeatures` list is empty.
    expect(source).not.toContain('features/agents.register');
    expect(source).not.toContain('features/omniverse.register');
    expect(source).not.toContain('internal-plugins');
    expect(readFileSync(join(privateRoot, 'tier-manifest.json'), 'utf8')).toContain('"defaults": "commercial"');
  });

  it('rejects an unknown registration status', () => {
    const root = mkdtempSync(join(tmpdir(), 'rv-tier-status-'));
    temporary.push(root);
    const manifest = {
      defaults: 'internal',
      rules: [{ path: 'src/features/x.register.ts', tier: 'commercial', feature: 'x' }],
      registrations: { x: { adapter: './features/x.register', status: 'invalid' } },
    };
    writeFileSync(join(root, 'tier-manifest.json'), JSON.stringify(manifest));
    expect(() => loadTierManifest(root)).toThrow(/status/);

    manifest.registrations.x.status = 'beta';
    writeFileSync(join(root, 'tier-manifest.json'), JSON.stringify(manifest));
    expect(loadTierManifest(root).registrations.x.status).toBe('beta');
  });
});
