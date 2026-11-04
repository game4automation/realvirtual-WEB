// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * partner-publishing.node.test.ts — plan-603 §5.
 *
 * The `publishing` block: a partner's own Bunny zone, recorded in the register so the
 * zone, its ids, its cap and its key have exactly one home. The zone password is the
 * third credential the register may hold as a value (D5) and the only new exempt path —
 * the same string anywhere else is still refused. A missing cap is a finding, because an
 * uncapped partner zone bills us.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertCustomerInvariants,
  loadCustomer,
  partnerDeployEnv,
  recordPartnerPublishing,
  redactRegisterSecrets,
  resolvePartnerPublishing,
  type RvCustomer,
} from '../scripts/_rv-customers.mjs';

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

const MANIFEST = { defaults: 'commercial', rules: [], registrations: {} };
const KEY = 'f3c1a9e2-7b64-4d0a-9e51-2c8d6b4f1a73'; // credential-shaped (uuid)

const PUBLISHING = {
  target: 'partner-zone',
  storageZone: 'rv-partner-wmyb',
  storageZoneId: 123456,
  pullZoneId: 654321,
  hostname: 'wmyb.web.realvirtual.io',
  region: 'DE',
  monthlyBandwidthGb: 100,
  storageKey: KEY,
};

function wmyb(overrides: Record<string, unknown> = {}): RvCustomer {
  return {
    schemaVersion: 1,
    customer: 'wmyb',
    displayName: 'WMYB',
    kind: 'development',
    support: 'basic',
    status: 'active',
    forgejo: { org: 'rv-wmyb', repo: 'rv-project-wmyb', team: 'members', permission: 'write' },
    contacts: [],
    licensing: {},
    delivery: {
      channel: 'git-workspace', tier: 'commercial', restrictedFeatures: [], projects: ['wmyb'],
      connectChannel: 'stable', mirror: null,
    },
    ...overrides,
  } as unknown as RvCustomer;
}

function fixture(customers: Record<string, unknown>): string {
  const wrapper = mkdtempSync(join(tmpdir(), 'rv-partner-publishing-'));
  temporary.push(wrapper);
  const root = join(wrapper, 'private');
  mkdirSync(join(root, 'projects', 'wmyb'), { recursive: true });
  writeFileSync(join(root, 'tier-manifest.json'), JSON.stringify(MANIFEST));
  writeFileSync(join(root, 'projects', 'wmyb', 'project.json'), '{"schemaVersion":2,"kind":"customer"}');
  mkdirSync(join(root, 'customers'), { recursive: true });
  for (const [slug, entry] of Object.entries(customers)) {
    writeFileSync(join(root, 'customers', `${slug}.json`), JSON.stringify(entry, null, 2));
  }
  return root;
}

const errorsFor = (publishing: unknown) =>
  assertCustomerInvariants(wmyb({ publishing }), { fileName: 'wmyb' }).errors.join('\n');

describe('publishing block in the register', () => {
  it('accepts a full block and exempts only publishing.storageKey from the secret refusal', () => {
    const root = fixture({ wmyb: wmyb({ publishing: PUBLISHING }) });
    const customer = loadCustomer(root, 'wmyb');
    expect(customer.publishing).toEqual(PUBLISHING);

    // the very same value in another field is still a hard error
    const { errors } = assertCustomerInvariants(
      wmyb({ publishing: PUBLISHING, billing: { billomatCustomer: KEY } }),
      { fileName: 'wmyb' },
    );
    expect(errors.some((e: string) => e.includes('billing.billomatCustomer holds a credential-shaped value')))
      .toBe(true);
    expect(errors.some((e: string) => /publishing\.storageKey holds a credential-shaped value/.test(e)))
      .toBe(false);
  });

  it('rejects an unknown field, a bad target, a non-hostname and a negative cap', () => {
    expect(errorsFor({ ...PUBLISHING, bucket: 'x' })).toMatch(/publishing contains unknown field "bucket"/);
    expect(errorsFor({ ...PUBLISHING, target: 'our-zone' })).toMatch(/publishing\.target must be one of/);
    expect(errorsFor({ ...PUBLISHING, storageZone: 'RV Partner' })).toMatch(/publishing\.storageZone must be/);
    expect(errorsFor({ ...PUBLISHING, hostname: 'wmyb' })).toMatch(/publishing\.hostname must be a DNS hostname/);
    expect(errorsFor({ ...PUBLISHING, pullZoneId: -1 })).toMatch(/publishing\.pullZoneId must be a positive integer/);
    expect(errorsFor({ ...PUBLISHING, region: 'EU' })).toMatch(/publishing\.region must be one of/);
    expect(errorsFor({ ...PUBLISHING, monthlyBandwidthGb: -5 })).toMatch(/non-negative integer/);
    expect(errorsFor('rv-partner-wmyb')).toMatch(/"publishing" must be a JSON object/);
    expect(errorsFor(PUBLISHING)).toBe('');
  });

  it('reports an uncapped partner zone as a finding, not a failure (D4)', () => {
    const uncapped = assertCustomerInvariants(
      wmyb({ publishing: { ...PUBLISHING, monthlyBandwidthGb: 0 } }), { fileName: 'wmyb' },
    );
    expect(uncapped.errors).toEqual([]);
    expect(uncapped.warnings.join('\n')).toMatch(/NO bandwidth cap/);

    const { monthlyBandwidthGb, ...withoutCap } = PUBLISHING;
    const missing = assertCustomerInvariants(wmyb({ publishing: withoutCap }), { fileName: 'wmyb' });
    expect(missing.errors).toEqual([]);
    expect(missing.warnings.join('\n')).toMatch(/runs uncapped on our invoice/);
  });
});

describe('resolver, env handover and redaction', () => {
  it('resolves defaults and produces the .env lines the partner pastes', () => {
    expect(resolvePartnerPublishing(wmyb())).toBeNull();
    const { region, monthlyBandwidthGb, storageKey, ...bare } = PUBLISHING;
    const resolved = resolvePartnerPublishing(wmyb({ publishing: bare }))!;
    expect(resolved).toMatchObject({ region: 'DE', monthlyBandwidthGb: null, storageKey: null });

    // no key yet → no BUNNY_STORAGE_KEY line, rather than one that reads "=null"
    expect(partnerDeployEnv(resolved).map(([name]) => name))
      .toEqual(['BUNNY_STORAGE_ZONE', 'BUNNY_PRIVATE_PROJECTS_DIR', 'RV_PUBLIC_BASE_URL']);
    expect(partnerDeployEnv(resolvePartnerPublishing(wmyb({ publishing: PUBLISHING })))).toEqual([
      ['BUNNY_STORAGE_ZONE', 'rv-partner-wmyb'],
      ['BUNNY_STORAGE_KEY', KEY],
      ['BUNNY_PRIVATE_PROJECTS_DIR', 'projects'],
      ['RV_PUBLIC_BASE_URL', 'https://wmyb.web.realvirtual.io'],
    ]);
    expect(partnerDeployEnv(null)).toEqual([]);
  });

  it('masks the zone key for display and leaves an entry without one alone', () => {
    const masked = redactRegisterSecrets(wmyb({ publishing: PUBLISHING })) as any;
    expect(masked.publishing.storageKey).toBe('••••••••');
    expect(masked.publishing.storageZone).toBe('rv-partner-wmyb');
    const plain = wmyb();
    expect(redactRegisterSecrets(plain)).toBe(plain);
  });
});

describe('recordPartnerPublishing', () => {
  it('merges a provisioning result and keeps the key a later partial run does not carry', () => {
    const root = fixture({ wmyb: wmyb() });

    recordPartnerPublishing(root, 'wmyb', {
      target: 'partner-zone',
      storageZone: 'rv-partner-wmyb',
      storageZoneId: 123456,
      pullZoneId: 654321,
      hostname: 'wmyb.web.realvirtual.io',
      region: 'DE',
      monthlyBandwidthGb: 100,
      storageKey: KEY,
    });
    // a later run that only rotates the key must not drop the ids …
    recordPartnerPublishing(root, 'wmyb', { storageKey: 'rotated-ioQ2bK7mTz4yR1' });
    // … and a null/undefined value must not erase what is on disk
    recordPartnerPublishing(root, 'wmyb', { pullZoneId: null as unknown as number });

    const written = JSON.parse(readFileSync(join(root, 'customers', 'wmyb.json'), 'utf8'));
    expect(written.publishing).toEqual({
      target: 'partner-zone',
      storageZone: 'rv-partner-wmyb',
      storageZoneId: 123456,
      pullZoneId: 654321,
      hostname: 'wmyb.web.realvirtual.io',
      region: 'DE',
      monthlyBandwidthGb: 100,
      storageKey: 'rotated-ioQ2bK7mTz4yR1',
    });
    // and the result still loads: the write-back produces a valid entry
    expect(loadCustomer(root, 'wmyb').publishing?.storageZone).toBe('rv-partner-wmyb');
  });

  it('refuses to repoint an entry at a different zone, which would orphan what is published', () => {
    const root = fixture({ wmyb: wmyb({ publishing: PUBLISHING }) });
    expect(() => recordPartnerPublishing(root, 'wmyb', { storageZone: 'rv-partner-other' }))
      .toThrow(/orphans everything he has published/);
  });
});
