// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
//
// The classification test for plan-434 Phase 2b (§9.2).
//
// Since the default flipped to `commercial`, silence means "ship it". That is the
// right default for a product and a dangerous one for a mistake, so this test walks
// the REAL private source tree and pins every file to a named tier: the three
// internal aggregate entry points, the agents/omniverse files, and — everything
// else. A new restricted file that nobody wrote a rule for shows up here as an
// unexpected `commercial`, which is exactly the failure worth catching.

import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  generateCustomerPrivatePlugins,
  loadTierManifest,
  resolveTier,
} from '../scripts/_workspace-lib.mjs';

const privateRoot = resolve('../realvirtual-WebViewer-Private~');
const sourceRoot = join(privateRoot, 'src');
const manifest = loadTierManifest(privateRoot);

/** The two per-customer joint developments; nothing else may be `restricted`. */
const RESTRICTED_PREFIXES = [
  'features/agents.register.ts',
  'features/omniverse.register.ts',
  'plugins/agents/',
  'render-backends/',
  'omniverse-streaming-lib.d.ts',
];

/** Aggregate entry points that import everything and must never be delivered. */
const INTERNAL_FILES = [
  'internal-plugins.ts',
  'private-plugins.ts',
  'plugins/import-providers/register-import-providers.ts',
];

type Profile = { tier: 'commercial' | 'core'; restrictedFeatures: string[] };

/** Mirrors the generator's `sourceAllowed`, which is module-private. */
function sourceAllowed(rel: string, profile: Profile): boolean {
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
const isRestricted = (rel: string) => RESTRICTED_PREFIXES.some(
  (prefix) => prefix.endsWith('/') ? rel.startsWith(prefix) : rel === prefix);

describe('private source tier classification', () => {
  it('has private sources to classify at all', () => {
    // Guards the guard: an empty walk would make every assertion below vacuously true.
    expect(ALL_SOURCES.length).toBeGreaterThan(50);
  });

  it('assigns exactly one tier to every private source file', () => {
    // resolveTier throws on an ambiguous match; loadTierManifest already rejects
    // overlapping rules, and this proves it across the real tree.
    for (const rel of ALL_SOURCES) {
      expect(() => resolveTier(manifest, `src/${rel}`), rel).not.toThrow();
      expect(['commercial', 'internal', 'restricted'], rel)
        .toContain(resolveTier(manifest, `src/${rel}`).tier);
    }
  });

  it('classifies every file into the named sets and nothing else', () => {
    const byTier: Record<string, string[]> = { commercial: [], internal: [], restricted: [] };
    for (const rel of ALL_SOURCES) byTier[resolveTier(manifest, `src/${rel}`).tier].push(rel);

    expect(byTier.restricted.sort()).toEqual(ALL_SOURCES.filter(isRestricted).sort());
    expect(byTier.restricted.length).toBeGreaterThan(0);
    expect(byTier.internal.sort()).toEqual([...INTERNAL_FILES].sort());
    // The remainder is the commercial standard - stated as a set difference, so a new
    // file lands here only because it is neither restricted nor an internal entry point.
    expect(byTier.commercial.sort()).toEqual(
      ALL_SOURCES.filter((rel) => !isRestricted(rel) && !INTERNAL_FILES.includes(rel)).sort());
  });

  it('names the owning feature on every restricted file', () => {
    for (const rel of ALL_SOURCES.filter(isRestricted)) {
      const resolved = resolveTier(manifest, `src/${rel}`);
      expect(['agents', 'omniverse'], rel).toContain(resolved.feature);
    }
  });

  it('withholds every restricted file from a delivery without the entitlement', () => {
    const profile: Profile = { tier: 'commercial', restrictedFeatures: [] };
    for (const rel of ALL_SOURCES.filter(isRestricted)) {
      expect(sourceAllowed(rel, profile), `${rel} must not be staged`).toBe(false);
    }
    for (const rel of INTERNAL_FILES) {
      expect(sourceAllowed(rel, profile), `${rel} must not be staged`).toBe(false);
    }
    // The positive half: a plain commercial file DOES ship, so the assertions above
    // are not passing because everything is blocked.
    expect(sourceAllowed('features/step-import.register.ts', profile)).toBe(true);
  });

  it('generates a customer entry point with every commercial feature and neither restricted one', () => {
    const source = generateCustomerPrivatePlugins(manifest, { tier: 'commercial', restrictedFeatures: [] });
    for (const feature of [
      'des', 'plc', 'physics', 'feature-matrix', 'kinematic-mechanism', 'machining',
    ]) {
      expect(source, `${feature} must reach a commercial customer`).toContain(`features/${feature}.register`);
    }
    expect(source).not.toContain('agents.register');
    expect(source).not.toContain('omniverse.register');
  });

  it('delivers a tier manifest that mentions neither restricted feature', () => {
    const profile: Profile = { tier: 'commercial', restrictedFeatures: [] };
    // Mirrors the `deliveredManifest` block of stageFilteredSourceTree: rules survive
    // only when the profile is allowed to hold them, registrations only when selected.
    const rules = manifest.rules.filter((rule) => rule.tier === 'commercial'
      ? profile.tier === 'commercial'
      : rule.tier === 'restricted' && profile.restrictedFeatures.includes(rule.feature ?? ''));
    expect(rules).toEqual([]);

    const generated = generateCustomerPrivatePlugins(manifest, profile);
    const delivered = Object.keys(manifest.registrations)
      .filter((feature) => generated.includes(`${manifest.registrations[feature].adapter}'`));
    expect(delivered).not.toContain('agents');
    expect(delivered).not.toContain('omniverse');
    expect(delivered).toContain('step-import');
  });
});
