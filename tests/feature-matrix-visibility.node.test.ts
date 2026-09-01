// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
//
// FEATURES.md is a customer-facing document (plan-434 §2.5). Before this test the
// matrix iterated every registration, so a customer read the names of features they
// were never offered - listed as "no", which is worse than absent: it advertises a
// per-customer joint development to the customer it does not belong to.
//
// It also pins the BETA marking on both sides: the generated markdown column and the
// runtime chip mapping, which cannot read the build-time manifest and would otherwise
// drift from it silently.

import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTierManifest, renderFeatureMatrix } from '../scripts/_workspace-lib.mjs';
import { BETA_PLUGIN_FEATURES } from '../../realvirtual-WebViewer-Private~/src/plugins/feature-matrix/build-feature-matrix';

const privateRoot = resolve('../realvirtual-WebViewer-Private~');
const manifest = loadTierManifest(privateRoot);

/** The features whose adapters must reach every commercial customer. */
const RESTRICTED_FEATURES = ['agents', 'omniverse'];
const BETA_FEATURES = ['des', 'ik-solver', 'kinematic-mechanism', 'machining', 'physics', 'plc'];

const ACME = {
  configName: 'acme',
  project: 'ACME',
  customer: 'acme',
  projects: ['acme'],
  projectKey: 'acme',
  tier: 'commercial' as const,
  restrictedFeatures: [] as string[],
};

describe('feature matrix visibility', () => {
  it('lists only the customer\'s own features in a customer matrix', () => {
    const matrix = renderFeatureMatrix(manifest, [ACME], 'acme');
    for (const feature of RESTRICTED_FEATURES) {
      expect(matrix, `${feature} must not appear in a customer matrix`).not.toContain(`| ${feature} |`);
    }
    for (const feature of Object.keys(manifest.registrations)) {
      if (RESTRICTED_FEATURES.includes(feature)) continue;
      expect(matrix, `${feature} is entitled and must be listed`).toContain(`| ${feature} |`);
    }
  });

  it('lists every registration in the internal report', () => {
    const matrix = renderFeatureMatrix(manifest, [ACME], null);
    for (const feature of Object.keys(manifest.registrations)) {
      expect(matrix, `${feature} missing from the internal report`).toContain(`| ${feature} |`);
    }
    // 18 since plan-281 added the jerk-limited smooth-motion core as a licensed
    // feature of its own (17 came from plan-434 moving the asset editor UI out
    // of the AGPL core).
    expect(Object.keys(manifest.registrations)).toHaveLength(18);
    // The internal report still shows what an unentitled restricted feature costs: a "no".
    expect(matrix).toMatch(/\| agents \| restricted \| stable \| no \|/);
  });

  it('marks exactly the beta features in the Status column', () => {
    const matrix = renderFeatureMatrix(manifest, [ACME], null);
    for (const feature of Object.keys(manifest.registrations)) {
      const expected = BETA_FEATURES.includes(feature) ? 'beta' : 'stable';
      const row = matrix.split('\n').find((line: string) => line.startsWith(`| ${feature} |`)) ?? '';
      expect(row, `${feature} has no row`).not.toBe('');
      expect(row.split('|').map((cell: string) => cell.trim())[3], `${feature} status cell`).toBe(expected);
    }
  });

  it('declares beta exactly where the manifest does', () => {
    const beta = Object.entries(manifest.registrations)
      .filter(([, registration]) => (registration as { status?: string }).status === 'beta')
      .map(([feature]) => feature)
      .sort();
    expect(beta).toEqual([...BETA_FEATURES].sort());
  });

  it('maps every runtime BETA chip to a beta feature of the manifest', () => {
    // The browser never loads tier-manifest.json, so the chip mapping is a hand-kept
    // mirror. Every feature it names must actually carry `status: "beta"`.
    for (const [pluginId, feature] of Object.entries(BETA_PLUGIN_FEATURES)) {
      expect(manifest.registrations[feature], `${pluginId} -> unknown feature ${feature}`).toBeTruthy();
      expect((manifest.registrations[feature] as { status?: string }).status, `${pluginId} -> ${feature}`).toBe('beta');
    }
    // The three beta features that register providers instead of plugins have no runtime
    // row at all, so they are legitimately absent from the chip mapping.
    expect(new Set(Object.values(BETA_PLUGIN_FEATURES))).toEqual(new Set(['des', 'plc', 'physics']));
  });
});
