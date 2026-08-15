// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
//
// Guards the delivery path of the CAD import providers.
//
// The regression this exists for: `step-import` was entitled at both customers and
// its adapter was staged, but the adapter registered only StepImportPlugin — whose
// toolbar button had been retired in favour of the Unified Import Dialog. The tab
// itself was registered from `register-import-providers.ts`, behind __RV_INTERNAL__.
// Result: a paid feature with no entry point, and no test that could see it, because
// the dev build never executes the customer adapters.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadDeliveryConfig, loadTierManifest, resolveTier } from '../scripts/_workspace-lib.mjs';

const privateRoot = resolve('../realvirtual-WebViewer-Private~');
const sourceRoot = join(privateRoot, 'src');

/** Every importer feature and the adapter that must register its dialog tab. */
const IMPORTER_FEATURES = [
  'step-import',
  'jt-import',
  'usd-import',
  'fbx-import',
  'onshape-import',
  'asset-manager-import',
] as const;

const DELIVERY_KEYS = ['wmyb', 'mauser3dhmi'] as const;

type Profile = { tier: string; restrictedFeatures: string[] };

/** Mirrors the generator's `sourceAllowed`, which is module-private. */
function stagedFor(manifest: ReturnType<typeof loadTierManifest>, rel: string, profile: Profile): boolean {
  const resolved = resolveTier(manifest, `src/${rel}`);
  if (resolved.tier === 'commercial') return profile.tier === 'commercial';
  if (resolved.tier === 'restricted') return (profile.restrictedFeatures ?? []).includes(resolved.feature ?? '');
  return false;
}

function listSources(directory = sourceRoot, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const absolute = join(directory, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(absolute).isDirectory()) out.push(...listSources(absolute, rel));
    else out.push(rel);
  }
  return out;
}

const ALL_SOURCES = listSources();

/** Relative import specifiers of one private source file. */
function relativeImports(rel: string): string[] {
  const text = readFileSync(join(sourceRoot, rel), 'utf8');
  const specifiers: string[] = [];
  const pattern = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    if (m[1].startsWith('.')) specifiers.push(m[1]);
  }
  return specifiers;
}

/** Resolves a specifier to a private-src-relative path, or null if it leaves src/. */
function resolveWithinSource(fromRel: string, specifier: string): string | null {
  const joined = posix.normalize(posix.join(posix.dirname(fromRel), specifier.replace(/\?.*$/, '')));
  if (joined.startsWith('..')) return null; // public core, npm, or the sibling repo
  for (const candidate of [joined, `${joined}.ts`, `${joined}.tsx`, `${joined}/index.ts`]) {
    if (ALL_SOURCES.includes(candidate)) return candidate;
  }
  return null; // asset or generated file — not a source-closure concern
}

describe('CAD import provider delivery', () => {
  const manifest = loadTierManifest(privateRoot);

  it('registers an import provider from every importer feature adapter', () => {
    for (const feature of IMPORTER_FEATURES) {
      const registration = manifest.registrations[feature];
      expect(registration, `feature ${feature} is not declared in tier-manifest.json`).toBeTruthy();
      const adapterRel = `${registration.adapter.replace(/^\.\//, '')}.ts`;
      const source = readFileSync(join(sourceRoot, adapterRel), 'utf8');
      // The adapter — not some internal-only module — must put the tab into the registry.
      expect(source, `${adapterRel} never calls importProviderRegistry.register()`)
        .toMatch(/importProviderRegistry\.register\(/);
      // The dialog button is Editor-only, so the adapter has to guarantee that mode.
      expect(source, `${adapterRel} does not register the editor mode`).toMatch(/modes\.register\(/);
    }
  });

  it('keeps the internal-only registration entry point out of every delivery', () => {
    const profile: Profile = { tier: 'commercial', restrictedFeatures: [...IMPORTER_FEATURES] };
    expect(stagedFor(manifest, 'plugins/import-providers/register-import-providers.ts', profile)).toBe(false);
    expect(stagedFor(manifest, 'internal-plugins.ts', profile)).toBe(false);
  });

  it.each(DELIVERY_KEYS)('stages an import-closed source set for %s', (projectKey) => {
    const delivery = loadDeliveryConfig(privateRoot, projectKey, manifest);
    const profile: Profile = { tier: delivery.tier, restrictedFeatures: delivery.restrictedFeatures };
    const staged = ALL_SOURCES.filter((rel) => stagedFor(manifest, rel, profile));

    expect(staged.length).toBeGreaterThan(0);
    const dangling: string[] = [];
    for (const rel of staged) {
      if (!/\.tsx?$/.test(rel)) continue;
      for (const specifier of relativeImports(rel)) {
        const target = resolveWithinSource(rel, specifier);
        if (target && !staged.includes(target)) dangling.push(`${rel} -> ${specifier}`);
      }
    }
    // A dangling import is a build break in the customer workspace, not a warning.
    expect(dangling, `unstaged private imports in the ${projectKey} delivery`).toEqual([]);
  });

  it.each(DELIVERY_KEYS)('delivers the STEP dialog tab to %s', (projectKey) => {
    const delivery = loadDeliveryConfig(privateRoot, projectKey, manifest);
    const profile: Profile = { tier: delivery.tier, restrictedFeatures: delivery.restrictedFeatures };
    // `step-import` is commercial since plan-434 Phase 2b, so the tab ships without any
    // entitlement — the delivery's `restrictedFeatures` list is empty at both customers.
    expect(resolveTier(manifest, 'src/features/step-import.register.ts').tier).toBe('commercial');
    expect(stagedFor(manifest, 'features/step-import.register.ts', profile)).toBe(true);
    expect(stagedFor(manifest, 'plugins/import-providers/step-import-provider.tsx', profile)).toBe(true);
  });
});
