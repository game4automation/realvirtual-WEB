// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The REAL customer register, and the delivery contract across the migration
 * (plan-434 §6.2).
 *
 * Two questions, both only answerable against the actual files:
 *
 * 1. Does every register entry on disk load? A register that validates only in
 *    a fixture is a register nobody can trust.
 * 2. Does a delivery driven by the register behave exactly like the delivery
 *    driven by `delivery/<key>.json` did?
 *
 * (2) is deliberately NOT a field-by-field equality. The migration changes
 * identity on purpose — `customer` is now the customer slug, not the project
 * file name — and the loader adds `configName`, `path` and `projectKey`. What
 * must be identical is the *normalised delivery contract*: the fields that
 * steer the pipeline, plus the resolved secrets. The wanted identity changes
 * are asserted separately, so they can never hide inside a passing equality.
 *
 * Skips entirely without the private sibling repository (community checkout).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  customerRegistryPath,
  isSharedForgejo,
  listCustomerSlugs,
  listCustomers,
  loadCustomer,
  resolveCustomerSecrets,
} from '../scripts/_rv-customers.mjs';
import {
  hasDeliveryConfig,
  listDeliveryConfigs,
  loadDeliveryConfig,
  loadDeliveryConfigByCustomer,
} from '../scripts/_workspace-lib.mjs';

const PRIVATE_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../realvirtual-WebViewer-Private~',
);
const HAS_PRIVATE = existsSync(join(PRIVATE_ROOT, 'tier-manifest.json'));

/**
 * The hub base URL, DERIVED — never typed.
 *
 * `assert-public-safe.mjs` runs over this repository before every mirror push, so
 * the Forgejo host name must not appear in its source. It is read the same way
 * `hubBaseUrl()` in the library reads it: from the origin of a legacy
 * `delivery/*.json` remote, which is where the URL came from before the register
 * existed and is therefore provably the right one.
 *
 * It is needed because a register entry WITHOUT a legacy config beside it (the
 * rehearsal customer, and every customer onboarded from now on) cannot derive it
 * for itself — enumerating all customers therefore fails without the variable set.
 */
function derivedHubBaseUrl(): string | null {
  const deliveryRoot = join(PRIVATE_ROOT, 'delivery');
  if (!existsSync(deliveryRoot)) return null;
  for (const name of readdirSync(deliveryRoot).filter(entry => entry.endsWith('.json')).sort()) {
    let remote: unknown;
    try {
      remote = JSON.parse(readFileSync(join(deliveryRoot, name), 'utf8'))?.remote;
    } catch { continue; }
    if (typeof remote !== 'string' || !/^https?:\/\//i.test(remote)) continue;
    try {
      return new URL(remote).origin;
    } catch { /* an unparsable legacy remote is no source of truth */ }
  }
  return null;
}

//! Runs `action` with RV_FORGEJO_HUB_URL set to the derived origin, and restores it
//! afterwards so no other test in the same process inherits it.
function withHubBaseUrl<T>(action: () => T): T {
  const derived = derivedHubBaseUrl();
  if (!derived) return action();
  const before = process.env.RV_FORGEJO_HUB_URL;
  process.env.RV_FORGEJO_HUB_URL = derived;
  try {
    return action();
  } finally {
    if (before === undefined) delete process.env.RV_FORGEJO_HUB_URL;
    else process.env.RV_FORGEJO_HUB_URL = before;
  }
}

//! The fields that actually steer a delivery, in a shape two sources can be compared in.
function deliveryContract(config: Record<string, any>) {
  return {
    remote: config.remote,
    projects: [...config.projects].sort(),
    tier: config.tier,
    restrictedFeatures: [...config.restrictedFeatures].sort(),
    connectChannel: config.connectChannel,
    mirror: config.mirror ?? null,
    connectLicenseKey: config.connectLicenseKey,
    requestyApiKey: config.requestyApiKey,
    requestyBaseUrl: config.requestyBaseUrl,
  };
}

describe.skipIf(!HAS_PRIVATE)('customer register — the real files', () => {
  it('loads every entry, and every entry is named after its slug', () => {
    const slugs = listCustomerSlugs(PRIVATE_ROOT);
    expect(slugs.length).toBeGreaterThan(0);
    for (const slug of slugs) {
      const customer = loadCustomer(PRIVATE_ROOT, slug);
      expect(customer.customer).toBe(slug);
      expect(existsSync(customerRegistryPath(PRIVATE_ROOT, slug))).toBe(true);
    }
  });

  it('carries no credential value in any entry', () => {
    // loadCustomer already refuses one; this reads the raw text as well, so a
    // future field that escapes the string walk still cannot pass unnoticed.
    for (const slug of listCustomerSlugs(PRIVATE_ROOT)) {
      const text = readFileSync(customerRegistryPath(PRIVATE_ROOT, slug), 'utf8');
      expect(text, `customers/${slug}.json`).not.toMatch(/LIC(-[A-Z0-9]{4}){3}/i);
      expect(text, `customers/${slug}.json`).not.toMatch(/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/i);
    }
  });

  it('claims each project exactly once across all customers', () => {
    const seen = new Map<string, string>();
    for (const customer of listCustomers(PRIVATE_ROOT)) {
      for (const key of customer.delivery.projects) {
        expect(seen.has(key), `${key} is claimed by ${seen.get(key)} and ${customer.customer}`).toBe(false);
        seen.set(key, customer.customer);
      }
    }
  });

  it('reports a customer without a git delivery by name, with the reason', () => {
    const hosted = listCustomers(PRIVATE_ROOT).filter(c => c.delivery.channel !== 'git-workspace');
    for (const customer of hosted) {
      for (const key of customer.delivery.projects) {
        expect(() => loadDeliveryConfig(PRIVATE_ROOT, key)).toThrow(/no git delivery/);
        // Not a git delivery means "publish like an internal project", which is
        // what the CDN path already did for these projects before the register.
        expect(hasDeliveryConfig(PRIVATE_ROOT, key)).toBe(false);
      }
    }
  });

  // A `standard` customer is a legal, fully validating register entry with an
  // empty delivery.projects. Since plan-434 Phase 4 it is DELIVERABLE — the
  // product with an empty projects/ folder — so the only entries missing from
  // the enumeration are those without a git delivery at all.
  it('enumerates every customer with a git delivery, standard included', () => {
    const enumerated = withHubBaseUrl(() => listDeliveryConfigs(PRIVATE_ROOT)).map(config => config.configName);
    const registered = listCustomers(PRIVATE_ROOT);
    for (const customer of registered) {
      const deliverable = customer.delivery.channel === 'git-workspace';
      expect(enumerated.includes(customer.customer), `${customer.customer} (${customer.kind}/${customer.delivery.channel})`)
        .toBe(deliverable);
    }
    // The concrete expectation of today's register, so a silent change of the
    // rule cannot hide behind the derived check above.
    expect(enumerated).toEqual(expect.arrayContaining(['mauser', 'wmyb']));
    expect(enumerated).toContain('hs-heilbronn'); // standard, git-workspace, projectless
    expect(enumerated).toContain('toray');        // development, git-workspace since ea3b919
    // No negative pin any more: since Toray moved off hosted-link, today's
    // register has no non-git-workspace customer left to name. The derived
    // check above is the real guard - it asserts BOTH directions for every
    // entry, so a hosted-link customer that slipped into the enumeration
    // still fails here.
  });

  it('delivers a standard customer projectlessly', () => {
    const standard = listCustomers(PRIVATE_ROOT).filter(c => c.kind === 'standard');
    expect(standard.length, 'the register carries at least one standard customer').toBeGreaterThan(0);
    for (const customer of standard) {
      const config = withHubBaseUrl(() => loadDeliveryConfigByCustomer(PRIVATE_ROOT, customer.customer));
      // The empty project list IS the projectless delivery. `projectKey` is null
      // rather than undefined, so every downstream branch reads it as a decision.
      expect(config.projects).toEqual([]);
      expect(config.projectKey).toBeNull();
      expect(config.kind).toBe('standard');
      // The remote is DERIVED from the entry, not from a shape typed here: since
      // plan-434 §2.7 a standard customer legitimately has either an own repo or
      // the shared `rv-commercial/realvirtual-commercial`, and which one is the
      // register's decision to make, one customer at a time. Asserting the
      // building blocks keeps this true across a switch of form.
      expect(config.remote).toContain(`/${customer.forgejo!.org}/${customer.forgejo!.repo}.git`);
      expect(config.sharedRepo).toBe(isSharedForgejo(customer));
      // A standard customer runs CONNECT like anyone else, so the licence key is
      // resolved out of the secrets file exactly as for a development customer —
      // it is only WITHHELD from the workspace in the shared channel, never
      // absent from the register.
      if (config.connectLicenseKey !== undefined) {
        expect(config.connectLicenseKey).toMatch(/^LIC(-[A-Z0-9]{4}){3}$/i);
      }
      expect(hasDeliveryConfig(PRIVATE_ROOT, customer.customer)).toBe(true);
      // And no project key of theirs exists to be looked up — that is the point.
      expect(customer.delivery.projects).toEqual([]);
    }
  });

  it('still refuses a customer without a git delivery, by name and with the reason', () => {
    const hosted = listCustomers(PRIVATE_ROOT).filter(c => c.delivery.channel !== 'git-workspace');
    for (const customer of hosted) {
      expect(() => withHubBaseUrl(() => loadDeliveryConfigByCustomer(PRIVATE_ROOT, customer.customer)))
        .toThrow(/no git delivery/);
      expect(hasDeliveryConfig(PRIVATE_ROOT, customer.customer)).toBe(false);
    }
  });
});

// One block per migrated customer: the legacy config is still on disk, so the
// contract can be compared against its actual source rather than a transcript.
const MIGRATED: Array<{ slug: string; legacy: string; projectKey: string }> = [
  { slug: 'mauser', legacy: 'mauser3dhmi', projectKey: 'mauser3dhmi' },
  { slug: 'wmyb', legacy: 'wmyb', projectKey: 'wmyb' },
];

for (const { slug, legacy, projectKey } of MIGRATED) {
  const legacyPath = join(PRIVATE_ROOT, 'delivery', `${legacy}.json`);
  describe.skipIf(!HAS_PRIVATE || !existsSync(legacyPath))(`delivery contract — ${slug}`, () => {
    it('is unchanged by the migration', () => {
      const before = JSON.parse(readFileSync(legacyPath, 'utf8'));
      const after = loadDeliveryConfig(PRIVATE_ROOT, projectKey);
      expect(deliveryContract(after)).toEqual(deliveryContract({
        ...before,
        projects: before.projects ?? [legacy],
      }));
    });

    it('changes identity, deliberately and visibly', () => {
      const before = JSON.parse(readFileSync(legacyPath, 'utf8'));
      const after = loadDeliveryConfig(PRIVATE_ROOT, projectKey);
      // The customer is now the CUSTOMER, not the file name of a project.
      expect(after.customer).toBe(slug);
      expect(after.configName).toBe(slug);
      expect(after.path).toBe(customerRegistryPath(PRIVATE_ROOT, slug));
      expect(after.projectKey).toBe(projectKey);
      // `project` stays the display name it always was — but it is now the
      // CUSTOMER's display name, so the string may legitimately differ from the
      // project title the legacy config carried.
      expect(typeof after.project).toBe('string');
      expect(String(after.project).trim().length).toBeGreaterThan(0);
      // The legacy identity was implicit in the file name. Recording it here
      // makes the rename visible in the test output rather than in a diff:
      // mauser3dhmi -> mauser, wmyb -> wmyb.
      expect({ legacyIdentity: before.customer ?? legacy, registryIdentity: after.customer })
        .toEqual({ legacyIdentity: before.customer ?? legacy, registryIdentity: slug });
    });

    it('resolves the licence key out of the gitignored secrets file, not the register', () => {
      const customer = loadCustomer(PRIVATE_ROOT, slug);
      const secrets = resolveCustomerSecrets(PRIVATE_ROOT, customer);
      expect(secrets.path.endsWith(`${slug}.secrets.json`)).toBe(true);
      expect(secrets.connectLicenseKey).toMatch(/^LIC(-[A-Z0-9]{4}){3}$/i);
      // The same value the pipeline puts into settings.json as connectLicensePrefill.
      expect(loadDeliveryConfig(PRIVATE_ROOT, projectKey).connectLicenseKey).toBe(secrets.connectLicenseKey);
    });

    it('is reachable by customer name and appears in the enumeration', () => {
      expect(loadDeliveryConfigByCustomer(PRIVATE_ROOT, slug).projectKey).toBe(projectKey);
      const configs = withHubBaseUrl(() => listDeliveryConfigs(PRIVATE_ROOT));
      expect(configs.map(config => config.configName)).toContain(slug);
      // The legacy file is shadowed, not read twice.
      expect(configs.filter(config => (config.projects ?? []).includes(projectKey))).toHaveLength(1);
    });
  });
}
