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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { catalogLabelsByRegistration, loadTierManifest, renderFeatureMatrix } from '../scripts/_workspace-lib.mjs';
import { generateFeatures } from '../scripts/gen-features-json.mjs';
import { BETA_PLUGIN_FEATURES } from '../../realvirtual-WebViewer-Private~/src/plugins/feature-matrix/build-feature-matrix';

const privateRoot = resolve('../realvirtual-WebViewer-Private~');
const manifest = loadTierManifest(privateRoot);

/** The features whose adapters must reach every commercial customer. */
// plan-646 F14: `demo-welcome` is restricted too — entitled only by bunny-deploy's DEMO_PROFILE.
// plan-762: the ray traced render mode is an internal render test (restricted like omniverse).
const RESTRICTED_FEATURES = ['agents', 'omniverse', 'demo-welcome', 'raytraced-render'];
// maintenance-runtime left beta on 2026-11-03 (Thomas).
// plan-2215: stereo, display-wall and flystick moved to the commercial tier as beta (2026-11-04).
const BETA_FEATURES = ['display-wall', 'flystick', 'ik-solver', 'machining', 'mujoco', 'physics', 'raytraced-render', 'stereo'];
/**
 * plan-680: DES is part of the AGPL core — no manifest registration any more. Since 92af3545
 * it is stable too, so des-hmi carries no BETA chip. A core feature that ever gets a chip
 * again is backed by its public catalog row (`edition: community`, `status: beta`).
 */
const CORE_BETA_FEATURES: string[] = [];
const CATALOG_ROWS = (JSON.parse(readFileSync(resolve('features.catalog.json'), 'utf8')) as {
  rows: Array<{ id: string; label: string; edition?: string; status?: string }>;
}).rows;

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
    // 19 since plan-550 added the cinematic render (path-traced video frames, commercial).
    // 20 since plan-551 added the "Record video" dialog (commercial UI over the capture engine).
    // 21 since plan-560 added the decryptor of encrypted `?glb=` share links (commercial).
    // 22 since plan-599 added the virtual camera displays (commercial, shown in the demo).
    // 23 since plan-764 added the USD export with 1:1 realvirtual extras (commercial).
    // 24 since plan-621 added the SolidCraft live sync of the asset editor (commercial).
    // 25 since plan-646 added the public-demo welcome window (restricted, demo profile only).
    // 26 since plan-522 added the maintenance runtime (the machine follows the guide, commercial).
    // 27 since plan-660 added the SimReady import via CONNECT (commercial); back to 26 for the
    // 6.4.4 release: SimReady is internal until it ships as a library source (plan-660 Phase 3).
    // 27 since plan-762 added the ray traced render mode (restricted, internal render test).
    // 28 since plan-741 added the DXF import provider.
    // 29 since plan-660 Phase 3 made SimReady visible again (a Library source).
    // 30 since plan-673 moved the MuJoCo detail physics / locomotion feature from the
    // internal tier to commercial (Thomas, 2026-10-25: it belongs in the public demo).
    // It was registered from internal-plugins.ts and in no manifest registration at all,
    // which is why the demo build — commercial tier, RV_INTERNAL deleted — did not carry it.
    // 29 since plan-680 moved DES into the AGPL core (no private registration any more).
    // 30 since plan-2040 added the ai-prompt commercial feature.
    // 31 since plan-2014 added the motion-trail commercial feature (swept-volume trail).
    // 32 since plan-2211 made the experiment manager commercial.
    // 35 since plan-2215 registered stereo, display-wall and flystick as commercial beta features.
    expect(Object.keys(manifest.registrations)).toHaveLength(35);
    expect(matrix).toMatch(/\| raytraced-render \| restricted \| beta \| no \|/);
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
      if (CORE_BETA_FEATURES.includes(feature)) {
        // A core feature: no manifest entry may exist (repo skew), its catalog row says beta.
        expect(manifest.registrations[feature], `${pluginId} -> ${feature} is core, not a registration`).toBeUndefined();
        const row = CATALOG_ROWS.find((candidate) => candidate.id === feature);
        expect(row?.edition, `${pluginId} -> ${feature} catalog edition`).toBe('community');
        expect(row?.status, `${pluginId} -> ${feature} catalog status`).toBe('beta');
        continue;
      }
      expect(manifest.registrations[feature], `${pluginId} -> unknown feature ${feature}`).toBeTruthy();
      expect((manifest.registrations[feature] as { status?: string }).status, `${pluginId} -> ${feature}`).toBe('beta');
    }
    // The beta features that register providers instead of plugins have no runtime
    // row at all, so they are legitimately absent from the chip mapping.
    expect(new Set(Object.values(BETA_PLUGIN_FEATURES))).toEqual(new Set(['physics']));
    // DES is stable and AGPL core (92af3545): no chip, and its catalog row says so.
    expect(Object.keys(BETA_PLUGIN_FEATURES)).not.toContain('des-hmi');
    const des = CATALOG_ROWS.find((candidate) => candidate.id === 'des');
    expect(des?.edition, 'des catalog edition').toBe('community');
    expect(des?.status ?? 'stable', 'des catalog status').toBe('stable');
  });

  it('shows every runtime BETA chip feature as beta in the public editions data (plan-646)', () => {
    // The third place beta is stated: the generated features.json derives it from the same
    // manifest status, so a chip and the editions table can never disagree.
    const result = generateFeatures({ privateRoot });
    if (!result.available) throw new Error('private manifest expected');
    const rows = result.features.groups.flatMap((group) => group.rows);
    const labels = catalogLabelsByRegistration();
    for (const feature of new Set(Object.values(BETA_PLUGIN_FEATURES))) {
      const label = CORE_BETA_FEATURES.includes(feature)
        ? CATALOG_ROWS.find((candidate) => candidate.id === feature)?.label
        : labels.get(feature);
      const row = rows.find((candidate) => candidate.label === label);
      expect(row, `${feature} has no public catalog row`).toBeTruthy();
      expect(row?.status, `${feature} row status`).toBe('beta');
    }
  });

  it('labels each registration with its catalog row in the matrix', () => {
    const matrix = renderFeatureMatrix(manifest, [ACME], null);
    const labels = catalogLabelsByRegistration();
    for (const feature of Object.keys(manifest.registrations)) {
      const row = matrix.split('\n').find((line: string) => line.startsWith(`| ${feature} |`)) ?? '';
      const cells = row.split('|').map((cell: string) => cell.trim());
      expect(cells[cells.length - 2], `${feature} label cell`).toBe(labels.get(feature) ?? '-');
    }
  });

  it('names the on-demand features (manifest activation) under the table (plan-652 §9.14)', () => {
    const matrix = renderFeatureMatrix(manifest, [ACME], null);
    const onDemand = Object.entries(manifest.registrations as Record<string, { activation?: string[] }>)
      .filter(([, reg]) => (reg.activation ?? ['startup']).some((t) => t !== 'startup'))
      .map(([id]) => id).sort();
    // des left the list with plan-680 (core feature, declared by main.ts, still lazy).
    expect(onDemand).toEqual(expect.arrayContaining(['asset-editor']));
    expect(onDemand).not.toContain('des');
    expect(matrix).toContain(`On demand (delivered, loaded on first use): ${onDemand.join(', ')}.`);
  });
});

describe('private-plugins.ts registers the commercial features in manifest order (plan-551 F10)', () => {
  it('the useFeature list equals the commercial registrations of tier-manifest.json, in order', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(resolve(privateRoot, 'src/private-plugins.ts'), 'utf8');
    const used = [...src.matchAll(/useFeature\(viewer, '([^']+)'/g)].map((m) => m[1]);
    const commercial = Object.keys(manifest.registrations).filter((f) => !RESTRICTED_FEATURES.includes(f));
    expect(used).toEqual(commercial);
    expect(used).toContain('video-record-ui');
    // plan-560: encrypted share links are a customer-tier feature (the demo needs them).
    expect(used).toContain('share-decrypt');
  });
});
