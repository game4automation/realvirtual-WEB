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
 * 2. Does a delivery driven by the register still behave the way the delivery
 *    driven by `delivery/<key>.json` did?
 *
 * (2) is deliberately NOT a field-by-field equality. The migration changes
 * identity on purpose — `customer` is now the customer slug, not the project
 * file name — and the loader adds `configName`, `path` and `projectKey`. What
 * must hold is the *normalised delivery contract*: the fields that steer the
 * pipeline, plus the provenance of the secrets. The wanted identity changes are
 * asserted separately, so they can never hide inside a passing equality.
 *
 * Since plan-739 the legacy files are DELETED, so (2) compares against a frozen
 * expectation in this file rather than against a second file on disk — see the
 * MIGRATED block below for why that is a replacement, not a downgrade.
 *
 * Skips entirely without the private sibling repository (community checkout).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HUB_URL,
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
 * Runs `action` with the hub base URL pinned, and restores the variable afterwards
 * so no other test in the same process inherits it.
 *
 * It used to scavenge the origin out of a legacy `delivery/*.json`, mirroring what
 * `hubBaseUrl()` did. Both are gone with plan-739 F6: the library now answers with
 * the shared {@link DEFAULT_HUB_URL} whenever the variable is unset, so this helper
 * pins that same constant. Keeping it (rather than deleting the call sites) means
 * these tests still say out loud which hub they expect, and a future change of the
 * constant shows up here rather than passing silently.
 */
function withHubBaseUrl<T>(action: () => T): T {
  const before = process.env.RV_FORGEJO_HUB_URL;
  process.env.RV_FORGEJO_HUB_URL = DEFAULT_HUB_URL;
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

/**
 * The delivery contract of the two migrated customers, FROZEN (plan-739 F7/T18).
 *
 * This block used to read `delivery/<legacy>.json` and compare the register
 * against it — the honest thing to do while both sources were on disk. Phase 3
 * deleted those two files (they were the last tracked carriers of the plaintext
 * licence and inference keys), and the block was gated on
 * `existsSync(legacyPath)`: deleting the files alone would have turned four real
 * assertions per customer into a silent `skip`. That is the failure class plan-739
 * exists to remove, so the expectation moves into the test instead of vanishing.
 *
 * The values below are the ones the deleted files carried, verified identical to
 * what the register resolves on 2026-09-07 before the deletion. Secrets stay out:
 * they are asserted by SHAPE and by provenance (they must come from the gitignored
 * `customers/<slug>.secrets.json`), never by value — writing a licence key into a
 * mirrored test file would re-create exactly the leak the deletion closed.
 */
const MIGRATED: Array<{
  slug: string;
  projectKey: string;
  legacyConfigName: string;
  contract: { remote: string; tier: string; restrictedFeatures: string[]; connectChannel: string; mirror: string | null };
}> = [
  {
    slug: 'mauser',
    projectKey: 'mauser3dhmi',
    legacyConfigName: 'mauser3dhmi',
    contract: {
      remote: `${DEFAULT_HUB_URL}/rv-mauser/rv-project-mauser.git`,
      tier: 'commercial',
      restrictedFeatures: [],
      connectChannel: 'stable',
      mirror: null,
    },
  },
  {
    slug: 'wmyb',
    projectKey: 'wmyb',
    legacyConfigName: 'wmyb',
    contract: {
      remote: `${DEFAULT_HUB_URL}/rv-wmyb/rv-project-wmyb.git`,
      tier: 'commercial',
      restrictedFeatures: [],
      connectChannel: 'stable',
      mirror: null,
    },
  },
];

for (const { slug, projectKey, legacyConfigName, contract } of MIGRATED) {
  describe.skipIf(!HAS_PRIVATE)(`delivery contract — ${slug}`, () => {
    it('matches the frozen contract the deleted legacy config carried', () => {
      const after = withHubBaseUrl(() => loadDeliveryConfig(PRIVATE_ROOT, projectKey));
      expect({
        remote: after.remote,
        tier: after.tier,
        restrictedFeatures: [...after.restrictedFeatures].sort(),
        connectChannel: after.connectChannel,
        mirror: after.mirror ?? null,
      }).toEqual(contract);
      // The contract shape itself stays exercised, so a field added to it is not
      // quietly dropped from this comparison.
      expect(Object.keys(deliveryContract(after)).sort()).toEqual([
        'connectChannel', 'connectLicenseKey', 'mirror', 'projects',
        'remote', 'requestyApiKey', 'requestyBaseUrl', 'restrictedFeatures', 'tier',
      ]);
    });

    it('changes identity, deliberately and visibly', () => {
      const after = withHubBaseUrl(() => loadDeliveryConfig(PRIVATE_ROOT, projectKey));
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
      // The legacy identity was the file name: mauser3dhmi -> mauser, wmyb -> wmyb.
      expect({ legacyIdentity: legacyConfigName, registryIdentity: after.customer })
        .toEqual({ legacyIdentity: legacyConfigName, registryIdentity: slug });
    });

    it('resolves the licence key out of the gitignored secrets file, not the register', () => {
      const customer = loadCustomer(PRIVATE_ROOT, slug);
      const secrets = resolveCustomerSecrets(PRIVATE_ROOT, customer);
      expect(secrets.path.endsWith(`${slug}.secrets.json`)).toBe(true);
      expect(secrets.connectLicenseKey).toMatch(/^LIC(-[A-Z0-9]{4}){3}$/i);
      // The same value the pipeline puts into settings.json as connectLicensePrefill.
      const config = withHubBaseUrl(() => loadDeliveryConfig(PRIVATE_ROOT, projectKey));
      expect(config.connectLicenseKey).toBe(secrets.connectLicenseKey);
    });

    it('is reachable by customer name and appears in the enumeration', () => {
      expect(withHubBaseUrl(() => loadDeliveryConfigByCustomer(PRIVATE_ROOT, slug)).projectKey).toBe(projectKey);
      const configs = withHubBaseUrl(() => listDeliveryConfigs(PRIVATE_ROOT));
      expect(configs.map(config => config.configName)).toContain(slug);
      // Exactly one config claims the key — the register's.
      expect(configs.filter(config => (config.projects ?? []).includes(projectKey))).toHaveLength(1);
    });

    it('has no legacy delivery config left on disk', () => {
      // The point of the deletion, asserted where the migration is described.
      // `hub-base-url.node.test.ts` T17 owns the repo-wide version of this.
      expect(existsSync(join(PRIVATE_ROOT, 'delivery', `${legacyConfigName}.json`))).toBe(false);
    });
  });
}
