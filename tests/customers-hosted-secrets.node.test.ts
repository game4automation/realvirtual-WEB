// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * customers-hosted-secrets.node.test.ts — plan-759 §9.7 / D6b.
 *
 * The two halves of a hosted deploy's key live in the register entry
 * (`hosted.password`, `hosted.fragment`), the environment wins for a one-off
 * run, a minted fragment is written back so the customer's link survives the
 * next publish, and the register's secret-value refusal exempts exactly these
 * two paths. `hosted.password` is redacted for display.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertCustomerInvariants,
  loadCustomer,
  resolveHostedSecrets,
  recordHostedFragment,
  redactHostedSecrets,
  isHostedFragment,
  type RvCustomer,
} from '../scripts/_rv-customers.mjs';

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

const MANIFEST = { defaults: 'commercial', rules: [], registrations: {} };
const FRAGMENT = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'; // base64url of 0..31

function toray(overrides: Record<string, unknown> = {}): RvCustomer {
  return {
    schemaVersion: 1,
    customer: 'toray',
    displayName: 'Toray',
    kind: 'development',
    support: 'basic',
    status: 'active',
    forgejo: { org: 'rv-toray', repo: 'rv-project-toray', team: 'members', permission: 'write' },
    contacts: [],
    licensing: {},
    delivery: {
      channel: 'git-workspace', tier: 'commercial', restrictedFeatures: [], projects: ['Toray'],
      connectChannel: 'stable', mirror: null,
    },
    ...overrides,
  } as unknown as RvCustomer;
}

function fixture(customers: Record<string, unknown>): string {
  const wrapper = mkdtempSync(join(tmpdir(), 'rv-hosted-secrets-'));
  temporary.push(wrapper);
  const root = join(wrapper, 'private');
  mkdirSync(join(root, 'projects', 'Toray'), { recursive: true });
  writeFileSync(join(root, 'tier-manifest.json'), JSON.stringify(MANIFEST));
  writeFileSync(join(root, 'projects', 'Toray', 'project.json'), '{"schemaVersion":2,"kind":"customer"}');
  mkdirSync(join(root, 'customers'), { recursive: true });
  for (const [slug, entry] of Object.entries(customers)) {
    writeFileSync(join(root, 'customers', `${slug}.json`), JSON.stringify(entry, null, 2));
  }
  return root;
}

describe('hosted block in the register', () => {
  it('accepts password + fragment and exempts exactly those two paths from the secret-value refusal', () => {
    const root = fixture({ toray: toray({ hosted: { password: 'Kx9$vB2!qL7#mP4z', fragment: FRAGMENT } }) });
    const customer = loadCustomer(root, 'toray');
    expect(customer.hosted).toEqual({ password: 'Kx9$vB2!qL7#mP4z', fragment: FRAGMENT });
    // a credential-shaped value anywhere ELSE is still refused
    const { errors } = assertCustomerInvariants(toray({ hosted: { password: 'Kx9$vB2!qL7#mP4z' }, billing: { billomatCustomer: FRAGMENT } }), { fileName: 'toray' });
    expect(errors.some((e: string) => e.includes('billing.billomatCustomer holds a credential-shaped value'))).toBe(true);
    expect(errors.some((e: string) => /hosted\.(password|fragment) holds a credential-shaped value/.test(e))).toBe(false);
  });

  it('rejects unknown hosted fields, a short password and a malformed fragment', () => {
    // Findings are prefixed with the file name; match on the sentence.
    const errorsFor = (hosted: unknown) => assertCustomerInvariants(toray({ hosted }), { fileName: 'toray' }).errors.join('\n');
    expect(errorsFor({ token: 'x' })).toContain('hosted contains unknown field "token".');
    expect(errorsFor({ password: 'short' })).toContain('hosted.password must be a string of at least 8 characters when present.');
    expect(errorsFor({ fragment: 'not-base64url!' })).toContain('hosted.fragment must be the base64url of 32 bytes (43 characters, no padding) when present.');
    expect(errorsFor('nope')).toContain('"hosted" must be a JSON object.');
    expect(isHostedFragment(FRAGMENT)).toBe(true);
    expect(isHostedFragment(`${FRAGMENT}=`)).toBe(false);
  });
});

describe('resolveHostedSecrets', () => {
  it('takes the register values and says so', () => {
    const r = resolveHostedSecrets(toray({ hosted: { password: 'geheim-2027', fragment: FRAGMENT } }), {});
    expect(r).toEqual({ password: 'geheim-2027', fragment: FRAGMENT, source: 'register' });
  });

  it('lets the environment win, half by half', () => {
    const env = { RV_DEPLOY_PASSWORD: 'one-off', RV_DEPLOY_FRAGMENT: FRAGMENT };
    expect(resolveHostedSecrets(toray({ hosted: { password: 'geheim-2027' } }), env))
      .toEqual({ password: 'one-off', fragment: FRAGMENT, source: 'env' });
    expect(resolveHostedSecrets(toray({ hosted: { password: 'geheim-2027', fragment: FRAGMENT } }), { RV_DEPLOY_PASSWORD: 'one-off' }))
      .toEqual({ password: 'one-off', fragment: FRAGMENT, source: 'env' });
  });

  it('a project no customer claims can only be armed from the environment', () => {
    expect(resolveHostedSecrets(null, {})).toEqual({ password: null, fragment: null, source: null });
    expect(resolveHostedSecrets(null, { RV_DEPLOY_PASSWORD: 'x' })).toEqual({ password: 'x', fragment: null, source: 'env' });
  });

  it('refuses a fragment that is not 32 bytes base64url', () => {
    expect(() => resolveHostedSecrets(null, { RV_DEPLOY_FRAGMENT: 'short' })).toThrow(/32 bytes/);
  });
});

describe('recordHostedFragment', () => {
  it('writes a minted fragment into the entry and refuses to overwrite one', () => {
    const root = fixture({ toray: toray({ hosted: { password: 'geheim-2027' } }) });
    recordHostedFragment(root, 'toray', FRAGMENT);
    const written = JSON.parse(readFileSync(join(root, 'customers', 'toray.json'), 'utf8'));
    expect(written.hosted).toEqual({ password: 'geheim-2027', fragment: FRAGMENT });
    expect(loadCustomer(root, 'toray').hosted?.fragment).toBe(FRAGMENT);
    expect(() => recordHostedFragment(root, 'toray', FRAGMENT)).toThrow(/already carries hosted.fragment/);
  });
});

describe('redactHostedSecrets', () => {
  it('masks the password and nothing else', () => {
    const r = redactHostedSecrets(toray({ hosted: { password: 'geheim-2027', fragment: FRAGMENT } }));
    expect(r.hosted).toEqual({ password: '••••••••', fragment: FRAGMENT });
    expect(r.customer).toBe('toray');
    const plain = toray();
    expect(redactHostedSecrets(plain)).toBe(plain);
  });
});
