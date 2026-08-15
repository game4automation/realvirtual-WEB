// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * `delivery/<key>.json` → `customers/<slug>.json` (plan-434 Phase 1).
 *
 * The migration has two properties that matter more than its output: it never
 * writes without `--apply`, and it never *invents*. The file name is a project
 * name, not a customer name, so the slug is an input — and the remote URL
 * already in the config is the evidence that checks it. A migrator that
 * silently accepted a mismatch would write a register entry pointing at a
 * repository the customer does not pull from.
 *
 * The third property is the one this whole phase exists for: the licence key
 * and the inference credentials leave the register and land in the gitignored
 * secrets file.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCustomer } from '../scripts/_rv-customers.mjs';
import { migrateDeliveryConfig, parseForgejoRemote } from '../scripts/migrate-delivery-config.mjs';

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

const MANIFEST = { defaults: 'commercial', rules: [], registrations: {} };
const syntheticLicenceKey = () => ['LIC', 'ABCD', 'EFGH', 'IJKL'].join('-');
const syntheticApiKey = () => ['00112233', '4455', '6677', '8899', 'aabbccddeeff'].join('-');

const LEGACY = {
  project: 'Mauser 3D HMI',
  tier: 'commercial',
  restrictedFeatures: [] as string[],
  remote: 'https://git.example.invalid/rv-mauser/rv-project-mauser.git',
  mirror: null,
  connectChannel: 'stable',
  connectLicenseKey: syntheticLicenceKey(),
  requestyApiKey: syntheticApiKey(),
  requestyBaseUrl: 'https://api.example.invalid/v1',
};

function fixture(configs: Record<string, unknown>, projects: string[] = ['mauser3dhmi']): string {
  const root = mkdtempSync(join(tmpdir(), 'rv-migrate-delivery-'));
  temporary.push(root);
  writeFileSync(join(root, 'tier-manifest.json'), JSON.stringify(MANIFEST));
  mkdirSync(join(root, 'delivery'), { recursive: true });
  for (const [name, config] of Object.entries(configs)) {
    writeFileSync(join(root, 'delivery', `${name}.json`), JSON.stringify(config, null, 2));
  }
  for (const key of projects) {
    mkdirSync(join(root, 'projects', key), { recursive: true });
    writeFileSync(join(root, 'projects', key, 'project.json'), '{"schemaVersion":2}');
  }
  return root;
}

describe('migrate-delivery-config', () => {
  it('parses a Forgejo remote and refuses anything it cannot read', () => {
    expect(parseForgejoRemote('https://git.example.invalid/rv-mauser/rv-project-mauser.git'))
      .toEqual({ base: 'https://git.example.invalid', org: 'rv-mauser', repo: 'rv-project-mauser' });
    expect(parseForgejoRemote('git@git.example.invalid:rv-mauser/rv-project-mauser.git')).toBeNull();
    expect(parseForgejoRemote('https://git.example.invalid/only-one-segment')).toBeNull();
  });

  it('writes nothing on a dry run', () => {
    const root = fixture({ mauser3dhmi: LEGACY });
    const result = migrateDeliveryConfig(root, 'mauser3dhmi', { slug: 'mauser' });
    expect(result.actions.map(action => action.status)).toEqual(['created', 'created', 'created']);
    expect(existsSync(join(root, 'customers', 'mauser.json'))).toBe(false);
    expect(existsSync(join(root, 'customers', '.gitignore'))).toBe(false);
  });

  it('moves the secret values out of the register and into the secrets file', () => {
    const root = fixture({ mauser3dhmi: LEGACY });
    migrateDeliveryConfig(root, 'mauser3dhmi', { slug: 'mauser', apply: true });

    const registerText = readFileSync(join(root, 'customers', 'mauser.json'), 'utf8');
    expect(registerText).not.toContain(syntheticLicenceKey());
    expect(registerText).not.toContain(syntheticApiKey());
    expect(registerText).not.toContain('api.example.invalid');

    const secrets = JSON.parse(readFileSync(join(root, 'customers', 'mauser.secrets.json'), 'utf8'));
    expect(secrets).toEqual({
      connectLicenseKey: syntheticLicenceKey(),
      requestyApiKey: syntheticApiKey(),
      requestyBaseUrl: 'https://api.example.invalid/v1',
    });

    // The register keeps only the reference, and the loader accepts the result.
    const customer = loadCustomer(root, 'mauser');
    expect(customer.licensing?.connect).toEqual({ issuer: 'portal', keyRef: 'connectLicenseKey' });
    expect(customer.secretsRef).toBe('customers/mauser.secrets.json');
    expect(customer.delivery.projects).toEqual(['mauser3dhmi']);
    expect(customer.forgejo).toEqual({
      org: 'rv-mauser', repo: 'rv-project-mauser', team: 'members', permission: 'write',
    });
  });

  it('ignores the secrets file for git, from the first write on', () => {
    const root = fixture({ mauser3dhmi: LEGACY });
    migrateDeliveryConfig(root, 'mauser3dhmi', { slug: 'mauser', apply: true });
    const ignore = readFileSync(join(root, 'customers', '.gitignore'), 'utf8');
    expect(ignore).toContain('*.secrets.json');
    expect(ignore).toContain('*.cert.json');
  });

  it('is idempotent — a second apply changes nothing', () => {
    const root = fixture({ mauser3dhmi: LEGACY });
    migrateDeliveryConfig(root, 'mauser3dhmi', { slug: 'mauser', apply: true });
    const before = readFileSync(join(root, 'customers', 'mauser.json'), 'utf8');
    const second = migrateDeliveryConfig(root, 'mauser3dhmi', { slug: 'mauser', apply: true });
    expect(second.actions.every(action => action.status === 'unchanged')).toBe(true);
    expect(readFileSync(join(root, 'customers', 'mauser.json'), 'utf8')).toBe(before);
  });

  it('aborts when the remote does not belong to the requested slug', () => {
    const root = fixture({ mauser3dhmi: LEGACY });
    // The default slug is the FILE name, which here is a project name — exactly
    // the case that must fail loudly rather than invent a customer.
    expect(() => migrateDeliveryConfig(root, 'mauser3dhmi', {}))
      .toThrow(/does not match slug "mauser3dhmi"/);
    expect(() => migrateDeliveryConfig(root, 'mauser3dhmi', { slug: 'wmyb' }))
      .toThrow(/expected rv-wmyb\/rv-project-wmyb/);
  });

  it('derives the support level from the presence of a diagnosis preset', () => {
    const root = fixture({ mauser3dhmi: LEGACY });
    expect(migrateDeliveryConfig(root, 'mauser3dhmi', { slug: 'mauser' }).support).toBe('basic');

    const presets = join(root, 'presets');
    mkdirSync(presets, { recursive: true });
    writeFileSync(join(presets, 'mauser3dhmi.diagnosis.json'), '{}');
    expect(migrateDeliveryConfig(root, 'mauser3dhmi', { slug: 'mauser', presetsRoot: presets }).support)
      .toBe('managed');
  });

  it('carries a multi-project config across unchanged and leaves contacts empty', () => {
    const root = fixture(
      { mauser: { ...LEGACY, customer: 'mauser', projects: ['mauser3dhmi', 'mauser-line2'] } },
      ['mauser3dhmi', 'mauser-line2'],
    );
    const result = migrateDeliveryConfig(root, 'mauser', { apply: true });
    expect(result.entry.delivery.projects).toEqual(['mauser3dhmi', 'mauser-line2']);
    // Inventing an address would put a wrong password-reset channel on record.
    expect(result.entry.contacts).toEqual([]);
  });
});
