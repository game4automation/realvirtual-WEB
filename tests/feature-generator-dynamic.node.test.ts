// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-652 §9.7 — the customer/demo entry generator emits DYNAMIC adapter imports behind the
 * same `useFeature` contract as the checked-in private-plugins.ts, and the manifest parser
 * knows `activation`.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { generateCustomerPrivatePlugins, loadTierManifest } from '../scripts/_workspace-lib.mjs';

const privateRoot = resolve('../realvirtual-WebViewer-Private~');
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function manifestWith(registrations: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'rv-652-gen-'));
  temporary.push(root);
  writeFileSync(join(root, 'tier-manifest.json'), JSON.stringify({ defaults: 'commercial', rules: [], registrations }));
  return root;
}

describe('generateCustomerPrivatePlugins (plan-652, dynamic)', () => {
  it('emits one dynamic useFeature call per entitled feature, in manifest order, no static adapter import', () => {
    const manifest = loadTierManifest(privateRoot);
    const source = generateCustomerPrivatePlugins(manifest, { tier: 'commercial', restrictedFeatures: [] });
    expect(source).not.toMatch(/^import \{ register/m);
    // All imports start up front (one parallel fetch, no waterfall), registration stays serial.
    const fetches = new Map([...source.matchAll(/const (adapter\d+) = early\(import\('([^']+)'\)\);/g)].map((m) => [m[1]!, m[2]!]));
    const calls = [...source.matchAll(/await useFeature\(viewer, '([a-z0-9-]+)', \(\) => (adapter\d+)\);/g)]
      .map((m) => [m[0], m[1]!, fetches.get(m[2]!)] as const);
    expect(source.indexOf('early(import(')).toBeLessThan(source.indexOf('await useFeature(viewer,'));
    const ids = calls.map((c) => c[1]);
    const manifestOrder = Object.keys(manifest.registrations).filter((f) => ids.includes(f));
    expect(calls.length).toBeGreaterThanOrEqual(20);
    expect(ids).toEqual(manifestOrder);
    for (const [, feature, adapter] of calls) expect(adapter).toBe(manifest.registrations[feature!]!.adapter);
    expect(source).toContain('features.recordStartup');
    expect(source).toContain('logBootSummary');
    expect(source).not.toContain('agents.register');
    expect(source).not.toContain('omniverse.register');
  });

  it('keeps the demo-only feature for the demo profile and drops it otherwise', () => {
    const manifest = loadTierManifest(privateRoot);
    const demo = generateCustomerPrivatePlugins(manifest, { tier: 'commercial', restrictedFeatures: ['demo-welcome'] });
    expect(demo).toContain("early(import('./features/demo-welcome.register'))");
    expect(demo).toMatch(/useFeature\(viewer, 'demo-welcome', \(\) => adapter\d+\)/);
    const plain = generateCustomerPrivatePlugins(manifest, { tier: 'commercial', restrictedFeatures: [] });
    expect(plain).not.toContain('demo-welcome');
  });

  it('parses activation; absent = startup; unknown trigger prefixes are rejected', () => {
    const ok = loadTierManifest(manifestWith({
      a: { adapter: './features/a.register' },
      b: { adapter: './features/b.register', activation: ['mode:editor', 'component:DESSource', 'command:sim.discrete'] },
    }));
    expect(ok.registrations.a.activation).toEqual(['startup']);
    expect(ok.registrations.b.activation).toEqual(['mode:editor', 'component:DESSource', 'command:sim.discrete']);
    expect(() => loadTierManifest(manifestWith({ c: { adapter: './features/c.register', activation: ['onload:x'] } }))).toThrow(/activation/);
    expect(() => loadTierManifest(manifestWith({ d: { adapter: './features/d.register', activation: [] } }))).toThrow(/activation/);
  });
});
