// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-679 Phase 3 — third-party notices per tier.
 *
 * 6.5.0 aborted every customer-workspace build with `stale-exception`: the workspace builds with
 * `VITE_PRIVATE_BUILD=1`, so the notices plugin judged it as the FULL private build, while the
 * staging had pruned the private package.json — the private policy's entry for a package only the
 * full build carries then matched nothing. The fix: a customer workspace builds as its DELIVERY
 * tier (`RV_NOTICES_TIER`), and a policy entry may say which tiers carry it (`tiers`).
 *
 * The static half (bottom) runs the rule "an entry is stale only if no tier it names carries it"
 * in the normal suite, without a build: for every policy entry it derives the manifest the staging
 * writes for each named tier and requires the package to be declared there.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  NOTICE_DELIVERY_TIERS,
  NOTICE_POLICY_TIERS,
  applyPolicy,
  loadManualComponents,
  loadPolicy,
  policyEntryAppliesToTier,
  type LicensePolicy,
  type NoticesTier,
  type ThirdPartyComponent,
} from '../scripts/lib/rv-third-party-notices.mjs';
import { noticesTierFromEnv } from '../scripts/vite-plugin-third-party-notices.mjs';
import { DELIVERY_TIERS, prunedPrivateManifest, runBuild } from '../scripts/_workspace-lib.mjs';
import { buildEnvForMode } from '../scripts/_bunny-lib.mjs';

const ROOT = resolve(__dirname, '..');
const PRIVATE_ROOT = resolve(ROOT, '../realvirtual-WebViewer-Private~');
// A package of the pruned scope, as the staging removes it from every customer manifest.
const PRUNED_PKG = '@nvidia/fixture-streaming-library';

const BASE: LicensePolicy = { scope: 'public', path: 'pub', allowed: ['MIT'], dynamicOnly: [], exceptions: [], vendorTerms: [] };

function component(over: Partial<ThirdPartyComponent> = {}): ThirdPartyComponent {
  return {
    name: 'pkg', version: '1.0.0', license: 'MIT', licenseExpression: 'MIT', copyright: ['Copyright (c) A'],
    licenseText: 'MIT text', source: 'https://example.invalid/pkg', origin: 'npm', linking: 'static', notes: [],
    ...over,
  };
}

function vendorEntry(name: string, tiers?: string[]) {
  return { name, version: '1.0.0', vendor: 'V', licenseRef: 'V terms', reason: 'r', decidedBy: 'thomas', date: 'd', ...(tiers ? { tiers } : {}) };
}

function privatePolicy(entries: ReturnType<typeof vendorEntry>[]): LicensePolicy {
  return { ...BASE, path: 'priv', scope: 'private', allowed: [], vendorTerms: entries as LicensePolicy['vendorTerms'] };
}

const stale = (result: ReturnType<typeof applyPolicy>) => result.violations.filter((v) => v.rule === 'stale-exception').map((v) => v.name);

let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'rv-notices-tiers-')); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(work, { recursive: true, force: true }); });

describe('tier-aware stale check (plan-679 F3)', () => {
  it('an entry for another tier is information, not a violation', () => {
    const result = applyPolicy([component()], [privatePolicy([vendorEntry('only-internal', ['internal'])])], { tier: 'commercial' });
    expect(stale(result)).toEqual([]);
    expect(result.notInTier.map((e) => e.name)).toEqual(['only-internal']);
  });

  it('the same entry in its own tier, matching nothing, is stale', () => {
    const result = applyPolicy([component()], [privatePolicy([vendorEntry('only-internal', ['internal'])])], { tier: 'internal' });
    expect(stale(result)).toEqual(['only-internal']);
    expect(result.notInTier).toEqual([]);
  });

  it('an entry without tiers behaves as before: stale in the full build and in every delivery tier', () => {
    const policies = [privatePolicy([vendorEntry('gone')])];
    expect(stale(applyPolicy([component()], policies, { tier: 'private' }))).toEqual(['gone']);
    expect(stale(applyPolicy([component()], policies, { tier: 'commercial' }))).toEqual(['gone']);
    // public / demo never stale-check the private policy (unchanged).
    expect(stale(applyPolicy([component()], policies, { tier: 'public' }))).toEqual([]);
    expect(stale(applyPolicy([component()], policies, { tier: 'demo' }))).toEqual([]);
  });

  it('the full build (no RV_NOTICES_TIER) still checks every entry, tiers or not', () => {
    const result = applyPolicy([component()], [privatePolicy([vendorEntry('unused-full', ['private']), vendorEntry('unused-com', ['commercial'])])], { tier: 'private' });
    expect(stale(result)).toEqual(['unused-com', 'unused-full']);
  });

  it('the 6.5.0 chain: pruned workspace manifest + unchanged policy', () => {
    const fullManifest = { dependencies: { [PRUNED_PKG]: '1.0.0', three: '0.1.0' } };
    const workspaceManifest = prunedPrivateManifest(fullManifest);
    expect(Object.keys(workspaceManifest.dependencies)).toEqual(['three']);
    const declared = (manifest: { dependencies: Record<string, string> }) => Object.keys(manifest.dependencies);

    const untagged = [privatePolicy([vendorEntry(PRUNED_PKG)])];
    // Full build, original manifest: declared, not stale.
    expect(stale(applyPolicy([component()], untagged, { tier: 'private', declared: declared(fullManifest) }))).toEqual([]);
    // What 6.5.0 did: the workspace judged as "private" against its PRUNED manifest -> stale.
    expect(stale(applyPolicy([component()], untagged, { tier: 'private', declared: declared(workspaceManifest) }))).toEqual([PRUNED_PKG]);

    // After the fix: the entry says which tier carries it, the workspace builds as its delivery tier.
    const tagged = [privatePolicy([vendorEntry(PRUNED_PKG, ['private'])])];
    expect(stale(applyPolicy([component()], tagged, { tier: 'commercial', declared: declared(workspaceManifest) }))).toEqual([]);
    expect(stale(applyPolicy([component()], tagged, { tier: 'private', declared: declared(fullManifest) }))).toEqual([]);
  });

  it('policyEntryAppliesToTier', () => {
    expect(policyEntryAppliesToTier({}, 'commercial')).toBe(true);
    expect(policyEntryAppliesToTier({ tiers: ['internal'] }, 'private')).toBe(true);
    expect(policyEntryAppliesToTier({ tiers: ['internal'] }, 'commercial')).toBe(false);
    expect(policyEntryAppliesToTier({ tiers: ['commercial', 'internal'] }, 'commercial')).toBe(true);
    expect(policyEntryAppliesToTier({ tiers: ['private'] }, 'demo')).toBe(false);
  });
});

describe('policy schema: tiers', () => {
  const write = (entry: Record<string, unknown>) => {
    const path = join(work, 'policy.json');
    writeFileSync(path, JSON.stringify({ allowed: [], vendorTerms: [entry] }));
    return path;
  };

  it('accepts delivery tiers and "private"', () => {
    expect(loadPolicy(write(vendorEntry('a', ['private', 'commercial'])), { scope: 'private' })!.vendorTerms[0].tiers)
      .toEqual(['private', 'commercial']);
  });

  it('refuses an empty list, an unknown tier, a duplicate or a non-list', () => {
    for (const tiers of [[], ['foo'], ['public'], ['demo'], ['core', 'core'], 'commercial']) {
      expect(() => loadPolicy(write({ ...vendorEntry('a'), tiers }), { scope: 'private' }), JSON.stringify(tiers)).toThrow(/"tiers" must be/);
    }
  });

  it('the notices tiers are the delivery tiers of the workspace library (no drift)', () => {
    expect([...NOTICE_DELIVERY_TIERS]).toEqual([...DELIVERY_TIERS]);
    expect([...NOTICE_POLICY_TIERS]).toEqual([...DELIVERY_TIERS, 'private']);
  });
});

describe('noticesTierFromEnv priority (plan-679 R2-6)', () => {
  // {mode} x {private tree} x {inherited RV_NOTICES_TIER}
  const cases: Array<[string, boolean, Record<string, string>, NoticesTier]> = [
    ['public build', false, {}, 'public'],
    ['public build, inherited tier', false, { RV_NOTICES_TIER: 'commercial', VITE_PRIVATE_BUILD: '1' }, 'public'],
    ['demo', true, {}, 'demo'],
    ['demo, inherited tier', true, { RV_NOTICES_TIER: 'commercial' }, 'demo'],
    ['full private build', true, { VITE_PRIVATE_BUILD: '1' }, 'private'],
    ['customer workspace', true, { VITE_PRIVATE_BUILD: '1', RV_NOTICES_TIER: 'commercial' }, 'commercial'],
    ['core workspace', true, { VITE_PRIVATE_BUILD: '1', RV_NOTICES_TIER: 'core' }, 'core'],
    ['empty tier', true, { VITE_PRIVATE_BUILD: '1', RV_NOTICES_TIER: '' }, 'private'],
  ];
  it.each(cases)('%s', (_label, hasPrivate, env, expected) => {
    expect(noticesTierFromEnv(hasPrivate, env)).toBe(expected);
  });

  it('an unknown RV_NOTICES_TIER is a hard error', () => {
    expect(() => noticesTierFromEnv(true, { VITE_PRIVATE_BUILD: '1', RV_NOTICES_TIER: 'foo' })).toThrow(/not a delivery tier/);
  });
});

describe('runBuild sets RV_NOTICES_TIER only for a customer workspace', () => {
  function stagedWorkspace() {
    const workspaceRoot = join(work, 'workspace');
    mkdirSync(workspaceRoot, { recursive: true });
    writeFileSync(join(workspaceRoot, 'package.json'), '{"name":"staged-fixture","version":"1.0.0"}');
    writeFileSync(join(workspaceRoot, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}');
    const envs: Record<string, string | undefined>[] = [];
    const npmRunner = (args: string[], options: { cwd: string; env?: Record<string, string | undefined> }) => {
      if (args.join(' ') === 'run build') {
        envs.push({ ...(options.env ?? {}) });
        mkdirSync(join(options.cwd, 'dist'), { recursive: true });
        writeFileSync(join(options.cwd, 'dist', 'app.js'), 'built');
      }
    };
    return { workspaceRoot, envs, npmRunner };
  }

  it('removes an inherited value in public, demo and full private builds', () => {
    vi.stubEnv('RV_NOTICES_TIER', 'internal');
    for (const mode of ['public', 'demo', 'private', undefined]) {
      const { workspaceRoot, envs, npmRunner } = stagedWorkspace();
      runBuild(workspaceRoot, { npmRunner, mode, sourceRoot: work });
      expect(envs[0].RV_NOTICES_TIER, String(mode)).toBeUndefined();
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('sets the delivery tier of a customer workspace, and refuses an unknown one', () => {
    const { workspaceRoot, envs, npmRunner } = stagedWorkspace();
    runBuild(workspaceRoot, { npmRunner, mode: 'private', noticesTier: 'commercial', sourceRoot: work });
    expect(envs[0].RV_NOTICES_TIER).toBe('commercial');
    expect(envs[0].VITE_PRIVATE_BUILD).toBe('1');
    expect(() => runBuild(workspaceRoot, { npmRunner, mode: 'private', noticesTier: 'foo', sourceRoot: work })).toThrow(/not a delivery tier/);
    // A demo build never carries a delivery tier, even when one is passed.
    runBuild(workspaceRoot, { npmRunner, mode: 'demo', noticesTier: 'commercial', sourceRoot: work });
    expect(envs[1].RV_NOTICES_TIER).toBeUndefined();
  });

  it('a Bunny build never inherits one', () => {
    vi.stubEnv('RV_NOTICES_TIER', 'commercial');
    for (const mode of ['public', 'demo', 'private'] as const) expect(buildEnvForMode(mode).RV_NOTICES_TIER, mode).toBeUndefined();
  });
});

// ─── static: every policy entry is carried by every tier it names ──────────────────────────

interface PolicyLike { scope: string; vendorTerms: Array<{ name: string; tiers?: string[] }>; exceptions: Array<{ name: string; tiers?: string[] }> }

function dependencyNames(manifest: Record<string, any> | null): string[] {
  if (!manifest) return [];
  return ['dependencies', 'optionalDependencies'].flatMap((field) => Object.keys(manifest[field] ?? {}));
}

/**
 * The names a build of `tier` declares: the core manifest, the private manifest as the staging
 * writes it for that tier (unpruned for the full build), and the manual component list.
 */
function declaredFor(tier: string, input: { core: Record<string, any>; priv: Record<string, any> | null; manual: string[] }): Set<string> {
  const priv = input.priv && tier !== 'private' ? prunedPrivateManifest(input.priv) : input.priv;
  return new Set([...dependencyNames(input.core), ...dependencyNames(priv), ...input.manual]);
}

//! Returns one message per entry that a tier it names does not carry.
function staticTierProblems(policies: PolicyLike[], input: Parameters<typeof declaredFor>[1]): string[] {
  const problems: string[] = [];
  for (const policy of policies) {
    if (policy.scope === 'customer') continue;
    for (const kind of ['exceptions', 'vendorTerms'] as const) {
      for (const entry of policy[kind] ?? []) {
        const tiers = entry.tiers ?? ['private'];
        for (const tier of tiers) {
          if (!declaredFor(tier, input).has(entry.name)) {
            problems.push(`${policy.scope} ${kind} ${entry.name}: tier "${tier}" does not carry it`);
          }
        }
      }
    }
  }
  return problems;
}

describe('static tier check of the real policies (normal suite, no build)', () => {
  const readJson = (path: string) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);
  const manual = loadManualComponents(join(ROOT, 'third-party', 'manual-components.json')).map((e) => String(e.name));
  const input = { core: readJson(join(ROOT, 'package.json')), priv: readJson(join(PRIVATE_ROOT, 'package.json')), manual };
  const policies: PolicyLike[] = [loadPolicy(join(ROOT, 'third-party', 'license-policy.json'), { scope: 'public' })!];
  const privatePolicyPath = join(PRIVATE_ROOT, 'third-party', 'license-policy.json');
  if (existsSync(privatePolicyPath)) policies.push(loadPolicy(privatePolicyPath, { scope: 'private' })!);

  it('every entry is declared by every tier it names (entries without tiers: by the full build)', () => {
    expect(staticTierProblems(policies, input)).toEqual([]);
  });

  it('fixtures: an entry no tier declares is red; a tier that prunes the package is red', () => {
    const fixtureInput = { core: { dependencies: { three: '1' } }, priv: { dependencies: { [PRUNED_PKG]: '1' } }, manual: [] };
    const policy = (entry: { name: string; tiers?: string[] }): PolicyLike => ({ scope: 'private', exceptions: [], vendorTerms: [entry] });
    expect(staticTierProblems([policy({ name: 'nobody-ships-this' })], fixtureInput)).toHaveLength(1);
    expect(staticTierProblems([policy({ name: PRUNED_PKG, tiers: ['private'] })], fixtureInput)).toEqual([]);
    // The staging prunes the scope for EVERY delivery tier, so naming one is red.
    expect(staticTierProblems([policy({ name: PRUNED_PKG, tiers: ['internal'] })], fixtureInput)).toHaveLength(1);
    expect(staticTierProblems([policy({ name: PRUNED_PKG, tiers: ['commercial'] })], fixtureInput)).toHaveLength(1);
    expect(staticTierProblems([policy({ name: 'three', tiers: ['commercial', 'private'] })], fixtureInput)).toEqual([]);
  });
});
