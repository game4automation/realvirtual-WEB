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

/** The two per-customer joint developments, the public-demo welcome window (plan-646 F14,
 *  entitled only by bunny-deploy's DEMO_PROFILE) and the internal ray traced render test
 *  (plan-762); nothing else may be `restricted`. */
const RESTRICTED_PREFIXES = [
  'features/agents.register.ts',
  'features/omniverse.register.ts',
  'features/demo-welcome.register.ts',
  'plugins/agents/',
  'plugins/demo-welcome/',
  'render-backends/',
  'omniverse-streaming-lib.d.ts',
  'features/raytraced-render.register.ts',
  'raytraced/',
];

/** Aggregate entry points that import everything and must never be delivered. */
const INTERNAL_FILES = [
  'internal-plugins.ts',
  'private-plugins.ts',
  'plugins/import-providers/register-import-providers.ts',
];

/** Internal-tier FEATURE files (not aggregates): the AutomationML importer is
 *  deliberately internal until proven against files from more than one
 *  authoring tool (plan-420) — a half importer at a customer is a negative
 *  proof of "realvirtual reads AutomationML". Mirrors the two manifest rules
 *  `src/features/aml-import.register.ts` and `src/plugins/import-providers/aml-*`.
 *  The Box2D zones (plan-661, promotion is its Phase 7) are internal until
 *  promoted.
 *
 *  MUJOCO WAS PROMOTED and is no longer listed here (plan-673 O13, Thomas
 *  2026-10-25: "es soll ins commercial tier aber in der public demo sein").
 *  The reason it was held back was the CC BY-NC-SA fixture history, and that
 *  is settled: the delivered geometry is own work generated from the
 *  Apache-2.0 TEXT files alone, the collision hulls are original MuJoCo
 *  primitives, the two ONNX policies are Apache-2.0 — written down with
 *  revisions and SHA-256 in `public/demo-realvirtual/MuJoCoWalker.LICENSE.txt`.
 *  No mesh of the original model is in this repository. The manifest rule
 *  `mujoco` (status beta, commercial by default) is the SSOT; this list only
 *  mirrors it. */
const INTERNAL_PREFIXES = [
  'features/aml-import.register.ts',
  'plugins/import-providers/aml-',
  'features/physics2d.register.ts',
  'physics2d/',
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
const isInternal = (rel: string) => INTERNAL_FILES.includes(rel)
  || INTERNAL_PREFIXES.some((prefix) => /[-/]$/.test(prefix) ? rel.startsWith(prefix) : rel === prefix);

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
    expect(byTier.internal.sort()).toEqual(ALL_SOURCES.filter(isInternal).sort());
    // The remainder is the commercial standard - stated as a set difference, so a new
    // file lands here only because it is neither restricted nor a named internal file.
    expect(byTier.commercial.sort()).toEqual(
      ALL_SOURCES.filter((rel) => !isRestricted(rel) && !isInternal(rel)).sort());
  });

  it('names the owning feature on every restricted file', () => {
    for (const rel of ALL_SOURCES.filter(isRestricted)) {
      const resolved = resolveTier(manifest, `src/${rel}`);
      expect(['agents', 'omniverse', 'demo-welcome', 'raytraced-render'], rel).toContain(resolved.feature);
    }
  });

  it('withholds every restricted file from a delivery without the entitlement', () => {
    const profile: Profile = { tier: 'commercial', restrictedFeatures: [] };
    for (const rel of ALL_SOURCES.filter(isRestricted)) {
      expect(sourceAllowed(rel, profile), `${rel} must not be staged`).toBe(false);
    }
    for (const rel of ALL_SOURCES.filter(isInternal)) {
      expect(sourceAllowed(rel, profile), `${rel} must not be staged`).toBe(false);
    }
    // plan-762: the ray traced backend folder is restricted BEFORE its first file
    // exists — a future src/raytraced/** module is withheld without the entitlement.
    expect(sourceAllowed('raytraced/rv-raytraced-backend.ts', profile)).toBe(false);
    expect(sourceAllowed('features/raytraced-render.register.ts', profile)).toBe(false);
    expect(sourceAllowed('raytraced/rv-raytraced-backend.ts',
      { tier: 'commercial', restrictedFeatures: ['raytraced-render'] })).toBe(true);
    // The positive half: a plain commercial file DOES ship, so the assertions above
    // are not passing because everything is blocked.
    expect(sourceAllowed('features/step-import.register.ts', profile)).toBe(true);
  });

  it('generates a customer entry point with every commercial feature and neither restricted one', () => {
    const source = generateCustomerPrivatePlugins(manifest, { tier: 'commercial', restrictedFeatures: [] });
    for (const feature of [
      'plc', 'physics', 'feature-matrix', 'kinematic-mechanism', 'machining',
    ]) {
      expect(source, `${feature} must reach a commercial customer`).toContain(`features/${feature}.register`);
    }
    // plan-680: DES is core code — every delivery carries it through the core, and the
    // generated private entry must not expect a private DES adapter any more.
    expect(source).not.toContain('features/des.register');
    expect(source).not.toContain('agents.register');
    expect(source).not.toContain('omniverse.register');
    expect(source).not.toContain('raytraced-render.register');
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
    expect(delivered).not.toContain('raytraced-render');
    expect(delivered).toContain('step-import');
  });
});
