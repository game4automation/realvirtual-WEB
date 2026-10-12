// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-598 §9.9 (node half) — every `@rv-private/private-plugins` variant
 * exports the same contract, and the generated customer entry imports its
 * features DYNAMICALLY and only the entitled ones.
 *
 * The browser half (runtime helpers, stub behaviour, registration-order
 * snapshot, smooth-motion idempotency) is `tests/private-features-prefetch.test.ts`.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { generateCustomerPrivatePlugins, loadTierManifest } from '../scripts/_workspace-lib.mjs';

const PRIVATE = resolve('../realvirtual-WebViewer-Private~');
const HAS_PRIVATE = existsSync(resolve(PRIVATE, 'tier-manifest.json'));
const RESTRICTED = new Set(['agents', 'omniverse']);

const CONTRACT = [
  /export function prefetchPrivateFeatures\(\): PrivateFeatureModules/,
  /export async function registerPrivatePlugins\(\s*_?viewer: RVViewer,\s*_?mods\?: PrivateFeatureModules\s*\): Promise<void>/,
];

describe('the community stub exports the contract', () => {
  it('prefetchPrivateFeatures + registerPrivatePlugins(viewer, mods?)', () => {
    const src = readFileSync(resolve('src/private-stubs/private-plugins.ts'), 'utf8');
    for (const re of CONTRACT) expect(src).toMatch(re);
  });
});

describe.skipIf(!HAS_PRIVATE)('private entries', () => {
  const manifest = HAS_PRIVATE ? loadTierManifest(PRIVATE) : null;

  it('the checked-in entry exports the contract', () => {
    const src = readFileSync(resolve(PRIVATE, 'src/private-plugins.ts'), 'utf8');
    for (const re of CONTRACT) expect(src).toMatch(re);
  });

  it('the checked-in entry prefetches exactly the commercial features WITHOUT load side effects', () => {
    const src = readFileSync(resolve(PRIVATE, 'src/private-plugins.ts'), 'utf8');
    const table = src.slice(src.indexOf('const PREFETCH_LOADERS'), src.indexOf('export function prefetchPrivateFeatures'));
    const prefetched = [...table.matchAll(/\['([^']+)', \(\) => import\('\.\/features\/([^']+)\.register'\)\]/g)];
    for (const [, id, file] of prefetched) expect(file).toBe(id);
    const expected = Object.entries(manifest!.registrations)
      .filter(([f, r]) => !RESTRICTED.has(f) && (r as { loadSideEffects?: boolean }).loadSideEffects !== true)
      .map(([f]) => f);
    expect(prefetched.map((m) => m[1])).toEqual(expected);
  });

  it('declares the side-effectful features in the manifest (they stay inside the ordered pass)', () => {
    const marked = Object.entries(manifest!.registrations)
      .filter(([, r]) => (r as { loadSideEffects?: boolean }).loadSideEffects === true)
      .map(([f]) => f);
    expect(marked).toEqual(['asset-editor', 'kinematic-mechanism', 'des', 'plc', 'feature-matrix']);
  });

  it('the generated customer entry: same contract, dynamic imports only, entitled features only', () => {
    const source = generateCustomerPrivatePlugins(manifest!, { tier: 'commercial', restrictedFeatures: [] });
    for (const re of CONTRACT) expect(source).toMatch(re);
    // No static feature import at all — every adapter becomes its own chunk.
    expect(source).not.toMatch(/^import \{ register/m);
    expect(source).not.toMatch(/^import .*features\//m);
    // Not entitled → not mentioned, neither prefetched nor registered.
    expect(source).not.toContain('features/agents.register');
    expect(source).not.toContain('features/omniverse.register');
    const registered = [...source.matchAll(/await registerPrivateFeature\(viewer, '([^']+)', \(\) => import\('([^']+)'\), mods\);/g)];
    const commercial = Object.keys(manifest!.registrations).filter((f) => !RESTRICTED.has(f));
    expect(registered.map((m) => m[1])).toEqual(commercial);
    const table = source.slice(source.indexOf('const PREFETCH_LOADERS'), source.indexOf('export function prefetchPrivateFeatures'));
    expect(table).not.toMatch(/'(asset-editor|kinematic-mechanism|des|plc|feature-matrix)'/);
    expect(table).toContain("['smooth-motion', () => import('./features/smooth-motion.register')]");
  });

  it('an entitled restricted feature is registered (and prefetched) dynamically', () => {
    const source = generateCustomerPrivatePlugins(manifest!, { tier: 'commercial', restrictedFeatures: ['agents'] });
    expect(source).toContain("await registerPrivateFeature(viewer, 'agents', () => import('./features/agents.register'), mods);");
    expect(source).toContain("['agents', () => import('./features/agents.register')],");
    expect(source).not.toContain('features/omniverse.register');
  });

});

describe('tier-manifest loadSideEffects validation', () => {
  it('rejects a non-boolean loadSideEffects', () => {
    const root = mkdtempSync(join(tmpdir(), 'rv-prefetch-manifest-'));
    try {
      const manifest = {
        defaults: 'commercial',
        rules: [],
        registrations: { x: { adapter: './features/x.register', loadSideEffects: 'yes' } },
      };
      writeFileSync(join(root, 'tier-manifest.json'), JSON.stringify(manifest));
      expect(() => loadTierManifest(root)).toThrow(/loadSideEffects/);
      manifest.registrations.x.loadSideEffects = true as unknown as string;
      writeFileSync(join(root, 'tier-manifest.json'), JSON.stringify(manifest));
      expect(loadTierManifest(root).registrations.x.loadSideEffects).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
