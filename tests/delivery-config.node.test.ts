// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Multi-project delivery configuration (plan-700 §2.10).
 *
 * The file name used to BE the project key. One customer repository may now carry
 * several projects, so a key is resolved against every config — and the two fields
 * that make that possible have to be in the strict `DELIVERY_CONFIG_KEYS` allowlist,
 * or the first converted config throws on load (review finding I1).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  hasDeliveryConfig, listDeliveryConfigs, loadDeliveryConfig, loadDeliveryConfigByCustomer,
  loadTierManifest, renderFeatureMatrix,
} from '../scripts/_workspace-lib.mjs';

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

const MANIFEST = {
  defaults: 'internal',
  rules: [{ path: 'src/**', tier: 'commercial' }],
  registrations: { 'step-import': { adapter: './adapters/step', requires: [] } },
};

const BASE = {
  tier: 'commercial',
  restrictedFeatures: [] as string[],
  mirror: null,
  connectChannel: 'stable',
  connectLicenseKey: 'LIC-ABCD-EFGH-IJKL',
};

function privateRoot(configs: Record<string, Record<string, unknown>>): string {
  const root = mkdtempSync(join(tmpdir(), 'rv-delivery-config-'));
  temporary.push(root);
  writeFileSync(join(root, 'tier-manifest.json'), JSON.stringify(MANIFEST));
  mkdirSync(join(root, 'delivery'), { recursive: true });
  for (const [name, config] of Object.entries(configs)) {
    writeFileSync(join(root, 'delivery', name + '.json'), JSON.stringify(config, null, 2));
  }
  return root;
}

describe('delivery configuration', () => {
  it('keeps loading a pre-plan-700 config, where the file name is the only project', () => {
    const root = privateRoot({ wmyb: { ...BASE, project: 'WMYB', remote: 'https://git.example.invalid/wmyb.git' } });
    const config = loadDeliveryConfig(root, 'wmyb');
    expect(config.projects).toEqual(['wmyb']);
    expect(config.customer).toBe('wmyb');
    expect(config.projectKey).toBe('wmyb');
  });

  it('resolves a project key against a config named after the customer', () => {
    const root = privateRoot({
      mauser: {
        ...BASE, project: 'Mauser 3D HMI', customer: 'mauser',
        projects: ['mauser3dhmi', 'mauser-line2'],
        remote: 'https://git.example.invalid/mauser.git',
      },
    });
    const config = loadDeliveryConfig(root, 'mauser-line2');
    expect(config.customer).toBe('mauser');
    expect(config.projectKey).toBe('mauser-line2');
    expect(config.projects).toEqual(['mauser3dhmi', 'mauser-line2']);
    expect(hasDeliveryConfig(root, 'mauser3dhmi')).toBe(true);
    expect(hasDeliveryConfig(root, 'not-a-project')).toBe(false);
  });

  it('delivers a whole customer repository by name', () => {
    const root = privateRoot({
      mauser: {
        ...BASE, project: 'Mauser 3D HMI', customer: 'mauser',
        projects: ['mauser3dhmi', 'mauser-line2'],
        remote: 'https://git.example.invalid/mauser.git',
      },
    });
    const config = loadDeliveryConfigByCustomer(root, 'mauser');
    // The primary is the first project: the one the README, settings and CONNECT
    // payload are generated for.
    expect(config.projectKey).toBe('mauser3dhmi');
    expect(config.projects).toHaveLength(2);
  });

  it('refuses an ambiguous key instead of picking the first match', () => {
    const root = privateRoot({
      alpha: { ...BASE, project: 'Alpha', projects: ['shared'], remote: 'https://git.example.invalid/a.git' },
      beta: { ...BASE, project: 'Beta', projects: ['shared'], remote: 'https://git.example.invalid/b.git' },
    });
    // Guessing here would deliver one customer project into another customer repository.
    expect(() => loadDeliveryConfig(root, 'shared')).toThrow(/more than one delivery config/);
  });

  it('accepts customer and projects as known fields, and still rejects unknown ones', () => {
    const root = privateRoot({
      acme: {
        ...BASE, project: 'Acme', customer: 'acme', projects: ['acme'],
        remote: 'https://git.example.invalid/acme.git', typoField: true,
      },
    });
    expect(() => loadDeliveryConfig(root, 'acme')).toThrow(/unknown field "typoField"/);
  });

  it('rejects a malformed projects list rather than delivering a guess', () => {
    const empty = privateRoot({ acme: { ...BASE, project: 'Acme', projects: [], remote: 'https://git.example.invalid/acme.git' } });
    expect(() => loadDeliveryConfig(empty, 'acme')).toThrow(/non-empty array/);
    const duplicated = privateRoot({ dup: { ...BASE, project: 'Dup', projects: ['x', 'x'], remote: 'https://git.example.invalid/d.git' } });
    expect(() => loadDeliveryConfig(duplicated, 'dup')).toThrow(/duplicates/);
    const unsafe = privateRoot({ bad: { ...BASE, project: 'Bad', projects: ['../escape'], remote: 'https://git.example.invalid/b.git' } });
    expect(() => loadDeliveryConfig(unsafe, 'bad')).toThrow(/invalid project key/);
  });

  it('enumerates every config for the feature matrix, whatever the files are called', () => {
    const root = privateRoot({
      mauser: {
        ...BASE, project: 'Mauser 3D HMI', customer: 'mauser',
        projects: ['mauser3dhmi', 'mauser-line2'], restrictedFeatures: ['step-import'],
        remote: 'https://git.example.invalid/mauser.git',
      },
      wmyb: { ...BASE, project: 'WMYB', remote: 'https://git.example.invalid/wmyb.git' },
    });
    const configs = listDeliveryConfigs(root);
    expect(configs.map(config => config.configName)).toEqual(['mauser', 'wmyb']);
    // feature-matrix used to derive the key from the file name; a config carrying
    // several projects made that a "config not found" for every one of them.
    const matrix = renderFeatureMatrix(loadTierManifest(root), configs, 'mauser-line2');
    expect(matrix).toContain('Mauser 3D HMI');
    expect(matrix).not.toContain('WMYB');
    expect(matrix).toContain('| step-import | commercial | yes |');
  });
});
