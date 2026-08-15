// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The customer register (plan-434 §2.1–§2.3).
 *
 * Everything here runs against SYNTHETIC fixtures in a temp directory — the
 * checks against the real `customers/*.json` live in
 * `rv-customers-registry.node.test.ts`, which skips without the private sibling.
 *
 * The register replaces `delivery/<key>.json` as the record of a customer, so
 * its validator carries the invariants that used to be nowhere: the slug is the
 * identity, the Forgejo coordinates are derived from it rather than typed, the
 * relationship kind decides both the project list and the hub permission, and a
 * credential-shaped VALUE anywhere in the file is a leak, not a convenience.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SHARED_ORG,
  SHARED_REPO,
  assertCustomerInvariants,
  customerRemoteUrl,
  isSharedForgejo,
  listCustomers,
  loadCustomer,
  resolveCustomerForProject,
  resolveCustomerSecrets,
} from '../scripts/_rv-customers.mjs';
import {
  hasDeliveryConfig,
  listDeliveryConfigs,
  loadDeliveryConfigByCustomer,
  sharedDeliveryTarget,
} from '../scripts/_workspace-lib.mjs';

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

// `omniverse` resolves to restricted through the rule; `plc` falls to the
// default and is therefore commercial — the pair the entitlement check needs.
const MANIFEST = {
  defaults: 'commercial',
  rules: [{ path: 'src/features/omniverse.register.ts', tier: 'restricted', feature: 'omniverse' }],
  registrations: {
    omniverse: { adapter: './features/omniverse.register' },
    plc: { adapter: './features/plc.register' },
  },
};

const MAUSER = {
  schemaVersion: 1,
  customer: 'mauser',
  displayName: 'MAUSER Maschinentechnik GmbH',
  kind: 'development',
  support: 'basic',
  status: 'active',
  forgejo: { org: 'rv-mauser', repo: 'rv-project-mauser', team: 'members', permission: 'write' },
  contacts: [] as unknown[],
  licensing: {},
  delivery: {
    channel: 'git-workspace',
    tier: 'commercial',
    restrictedFeatures: [] as string[],
    projects: ['mauser3dhmi'],
    connectChannel: 'stable',
    mirror: null,
  },
};

interface FixtureOptions {
  projects?: string[];
  presets?: string[];
  secrets?: Record<string, Record<string, string>>;
}

//! Presets folder of the fixture. Passed explicitly, never derived: the default
//! derivation reaches OUTSIDE the fixture root (it is a sibling repository), and
//! a fixture that writes there pollutes every other test in the same temp dir.
export const fixturePresetsRoot = (root: string) => join(root, '..', 'presets');

function fixture(customers: Record<string, unknown>, options: FixtureOptions = {}): string {
  const wrapper = mkdtempSync(join(tmpdir(), 'rv-customers-'));
  temporary.push(wrapper);
  const root = join(wrapper, 'private');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'tier-manifest.json'), JSON.stringify(MANIFEST));
  for (const key of options.projects ?? ['mauser3dhmi']) {
    mkdirSync(join(root, 'projects', key), { recursive: true });
    writeFileSync(join(root, 'projects', key, 'project.json'), '{"schemaVersion":2}');
  }
  mkdirSync(join(root, 'customers'), { recursive: true });
  for (const [slug, entry] of Object.entries(customers)) {
    writeFileSync(join(root, 'customers', `${slug}.json`), JSON.stringify(entry, null, 2));
  }
  for (const [slug, secrets] of Object.entries(options.secrets ?? {})) {
    writeFileSync(join(root, 'customers', `${slug}.secrets.json`), JSON.stringify(secrets, null, 2));
  }
  mkdirSync(fixturePresetsRoot(root), { recursive: true });
  for (const key of options.presets ?? []) {
    writeFileSync(join(fixturePresetsRoot(root), `${key}.diagnosis.json`), '{}');
  }
  return root;
}

//! A synthetic licence key in the real shape, assembled so no scanner reads it as one.
const syntheticLicenceKey = () => ['LIC', 'ABCD', 'EFGH', 'IJKL'].join('-');
//! The UUID shape the inference credentials carry.
const syntheticApiKey = () => ['00112233', '4455', '6677', '8899', 'aabbccddeeff'].join('-');

/**
 * The hub URL the translation would otherwise take from a legacy delivery config,
 * which a synthetic register does not have. Restored so no other test inherits it.
 */
function withHubBaseUrl<T>(run: () => T): T {
  const before = process.env.RV_FORGEJO_HUB_URL;
  process.env.RV_FORGEJO_HUB_URL = 'https://git.example.invalid';
  try {
    return run();
  } finally {
    if (before === undefined) delete process.env.RV_FORGEJO_HUB_URL;
    else process.env.RV_FORGEJO_HUB_URL = before;
  }
}

//! A standard customer in the SHARED form (plan-434 §2.7): one repository for all
//! of them, the slug as the team name, read-only, and no seed project.
function sharedCustomer(slug: string, overrides: Record<string, unknown> = {}) {
  return {
    ...MAUSER,
    customer: slug,
    displayName: `${slug} GmbH`,
    kind: 'standard',
    licensing: { connect: { issuer: 'portal', keyRef: 'connectLicenseKey' } },
    secretsRef: `customers/${slug}.secrets.json`,
    forgejo: { org: SHARED_ORG, repo: SHARED_REPO, team: slug, permission: 'read' },
    delivery: { ...MAUSER.delivery, projects: [] as string[] },
    ...overrides,
  };
}

describe('customer register — schema and identity', () => {
  it('rejects an unknown field instead of ignoring a typo', () => {
    const root = fixture({ mauser: { ...MAUSER, suport: 'managed' } });
    expect(() => loadCustomer(root, 'mauser')).toThrow(/unknown field "suport"/);
  });

  it('rejects an unknown field inside a nested block', () => {
    const root = fixture({ mauser: { ...MAUSER, forgejo: { ...MAUSER.forgejo, branchProtection: true } } });
    expect(() => loadCustomer(root, 'mauser')).toThrow(/forgejo contains unknown field "branchProtection"/);
  });

  it('refuses a slug that disagrees with the file name', () => {
    // Two identities for one customer is precisely what the register removes.
    const root = fixture({ mauser: { ...MAUSER, customer: 'mauser-gmbh' } });
    expect(() => loadCustomer(root, 'mauser')).toThrow(/the slug IS the file name/);
  });

  it('derives the Forgejo coordinates from the slug rather than trusting what was typed', () => {
    const wrongOrg = fixture({ mauser: { ...MAUSER, forgejo: { ...MAUSER.forgejo, org: 'mauser' } } });
    expect(() => loadCustomer(wrongOrg, 'mauser')).toThrow(/forgejo\.org must be "rv-mauser"/);
    const wrongRepo = fixture({ mauser: { ...MAUSER, forgejo: { ...MAUSER.forgejo, repo: 'rv-mauser' } } });
    expect(() => loadCustomer(wrongRepo, 'mauser')).toThrow(/forgejo\.repo must be "rv-project-mauser"/);
  });

  it('builds the remote from those coordinates and a caller-supplied base URL', () => {
    const root = fixture({ mauser: MAUSER });
    const customer = loadCustomer(root, 'mauser');
    expect(customerRemoteUrl(customer, 'https://git.example.invalid/'))
      .toBe('https://git.example.invalid/rv-mauser/rv-project-mauser.git');
    // No base URL means no guess: this module never carries a host name.
    expect(() => customerRemoteUrl(customer, '')).toThrow(/hub base URL is required/);
  });
});

describe('customer register — relationship invariants', () => {
  it('couples kind and the project list in both directions', () => {
    const emptyDevelopment = fixture({
      mauser: { ...MAUSER, delivery: { ...MAUSER.delivery, projects: [] } },
    });
    expect(() => loadCustomer(emptyDevelopment, 'mauser'))
      .toThrow(/kind "development" requires at least one entry/);

    const seededStandard = fixture({
      acme: {
        ...MAUSER, customer: 'acme', kind: 'standard',
        forgejo: { org: 'rv-acme', repo: 'rv-project-acme', team: 'members', permission: 'read' },
      },
    });
    expect(() => loadCustomer(seededStandard, 'acme')).toThrow(/standard customers get no seed project/);
  });

  it('couples the hub permission to the kind', () => {
    const root = fixture({ mauser: { ...MAUSER, forgejo: { ...MAUSER.forgejo, permission: 'read' } } });
    expect(() => loadCustomer(root, 'mauser')).toThrow(/permission must be "write" for kind "development"/);
  });

  it('demands a forgejo block for a git delivery and allows its absence for a hosted link', () => {
    const missing = fixture({ mauser: { ...MAUSER, forgejo: undefined } });
    expect(() => loadCustomer(missing, 'mauser')).toThrow(/requires a "forgejo" block/);

    const hosted = fixture(
      {
        toray: {
          ...MAUSER, customer: 'toray', displayName: 'Toray', forgejo: undefined,
          delivery: { ...MAUSER.delivery, channel: 'hosted-link', projects: ['Toray'] },
        },
      },
      { projects: ['Toray'] },
    );
    expect(loadCustomer(hosted, 'toray').delivery.channel).toBe('hosted-link');
  });

  it('insists that every named project exists on disk, case included', () => {
    const root = fixture({ mauser: MAUSER }, { projects: ['Mauser3DHMI'] });
    expect(() => loadCustomer(root, 'mauser')).toThrow(/case-sensitive/);
  });

  it('reports a managed customer without a diagnosis preset as a warning, not a failure', () => {
    // wmyb is exactly this case today; failing the load would stop a delivery
    // over a support-tooling gap, so the doctor gates on it instead.
    const root = fixture({ mauser: { ...MAUSER, support: 'managed' } });
    const warnings: string[] = [];
    const options = { presetsRoot: fixturePresetsRoot(root), onWarning: (w: string) => warnings.push(w) };
    expect(() => loadCustomer(root, 'mauser', options)).not.toThrow();
    expect(warnings.join('\n')).toMatch(/no diagnosis preset for "mauser3dhmi"/);

    const withPreset = fixture({ mauser: { ...MAUSER, support: 'managed' } }, { presets: ['mauser3dhmi'] });
    const findings = assertCustomerInvariants(
      loadCustomer(withPreset, 'mauser', { presetsRoot: fixturePresetsRoot(withPreset) }),
      { fileName: 'mauser', privateRoot: withPreset, presetsRoot: fixturePresetsRoot(withPreset) },
    );
    expect(findings).toEqual({ errors: [], warnings: [] });
  });
});

/**
 * The shared commercial repository (plan-434 §2.7).
 *
 * Standard customers share ONE repository, and each of them is a read team
 * inside it named after their own slug. That makes exactly two forms legal, and
 * the difference between them is not cosmetic: the shared form hands the same
 * bytes to every customer, so anything customer-specific in it — a licence key,
 * a write permission, a team called `members` — is visible to, or usable by,
 * everyone else in the repository.
 */
describe('customer register — the shared commercial repository', () => {
  it('accepts both forms, and says which one an entry uses', () => {
    const own = fixture({ mauser: MAUSER });
    expect(isSharedForgejo(loadCustomer(own, 'mauser'))).toBe(false);

    const shared = fixture({ acme: sharedCustomer('acme') });
    const customer = loadCustomer(shared, 'acme');
    expect(isSharedForgejo(customer)).toBe(true);
    expect(customerRemoteUrl(customer, 'https://git.example.invalid'))
      .toBe(`https://git.example.invalid/${SHARED_ORG}/${SHARED_REPO}.git`);
  });

  it('refuses a development customer in the shared repository', () => {
    // Write access is what a development relationship needs, and in the shared
    // repository that is write access to every other customer's product.
    const root = fixture({
      acme: sharedCustomer('acme', {
        kind: 'development',
        delivery: { ...MAUSER.delivery, projects: ['mauser3dhmi'] },
      }),
    });
    expect(() => loadCustomer(root, 'acme')).toThrow(/only kind "standard" shares it/);
  });

  it('insists the team is the slug, because the team IS the customer in there', () => {
    const root = fixture({ acme: sharedCustomer('acme', { forgejo: { org: SHARED_ORG, repo: SHARED_REPO, team: 'members', permission: 'read' } }) });
    expect(() => loadCustomer(root, 'acme')).toThrow(/forgejo\.team must be "acme"/);
  });

  it('refuses write permission in the shared repository', () => {
    const root = fixture({ acme: sharedCustomer('acme', { forgejo: { org: SHARED_ORG, repo: SHARED_REPO, team: 'acme', permission: 'write' } }) });
    expect(() => loadCustomer(root, 'acme')).toThrow(/permission must be "read" in the shared repository/);
  });

  it('refuses a half-shared block, which belongs to neither form', () => {
    const root = fixture({ acme: sharedCustomer('acme', { forgejo: { org: SHARED_ORG, repo: 'rv-project-acme', team: 'acme', permission: 'read' } }) });
    expect(() => loadCustomer(root, 'acme')).toThrow(/names the shared repository only half/);
  });

  it('leaves the own-repo form of a standard customer intact', () => {
    // The register decides per customer; sharing is the default shape, not the
    // only one. An own repo for a standard customer must keep validating.
    const root = fixture({
      acme: sharedCustomer('acme', {
        forgejo: { org: 'rv-acme', repo: 'rv-project-acme', team: 'members', permission: 'read' },
      }),
    });
    expect(isSharedForgejo(loadCustomer(root, 'acme'))).toBe(false);
  });
});

describe('customer register — entitlements and contacts', () => {
  it('accepts an entitlement on a restricted feature', () => {
    const root = fixture({
      mauser: { ...MAUSER, delivery: { ...MAUSER.delivery, restrictedFeatures: ['omniverse'] } },
    });
    expect(loadCustomer(root, 'mauser').delivery.restrictedFeatures).toEqual(['omniverse']);
  });

  it('refuses an entitlement on a commercial feature, which would grant nothing', () => {
    const root = fixture({
      mauser: { ...MAUSER, delivery: { ...MAUSER.delivery, restrictedFeatures: ['plc'] } },
    });
    expect(() => loadCustomer(root, 'mauser')).toThrow(/resolves to tier "commercial"/);
  });

  it('refuses a feature that is not registered at all', () => {
    const root = fixture({
      mauser: { ...MAUSER, delivery: { ...MAUSER.delivery, restrictedFeatures: ['teleport'] } },
    });
    expect(() => loadCustomer(root, 'mauser')).toThrow(/not in tier-manifest\.json/);
  });

  it('keeps contact logins unique and demands an address while the account is active', () => {
    const duplicated = fixture({
      mauser: {
        ...MAUSER,
        contacts: [
          { login: 'pb', email: 'pb@example.invalid', status: 'active' },
          { login: 'pb', email: 'other@example.invalid', status: 'active' },
        ],
      },
    });
    expect(() => loadCustomer(duplicated, 'mauser')).toThrow(/used more than once/);

    const noEmail = fixture({ mauser: { ...MAUSER, contacts: [{ login: 'pb', status: 'active' }] } });
    expect(() => loadCustomer(noEmail, 'mauser')).toThrow(/email is required while status is "active"/);

    const retired = fixture({ mauser: { ...MAUSER, contacts: [{ login: 'pb', status: 'inactive' }] } });
    expect(loadCustomer(retired, 'mauser').contacts).toHaveLength(1);
  });
});

describe('customer register — no secret values', () => {
  it('refuses a licence key pasted into the register', () => {
    const root = fixture({
      mauser: { ...MAUSER, billing: { billomatCustomer: syntheticLicenceKey() } },
    });
    expect(() => loadCustomer(root, 'mauser')).toThrow(/credential-shaped value/);
  });

  it('refuses an API-key-shaped value anywhere in the file', () => {
    const root = fixture({ mauser: { ...MAUSER, displayName: syntheticApiKey() } });
    expect(() => loadCustomer(root, 'mauser')).toThrow(/mauser\.secrets\.json/);
  });

  it('refuses a keyRef that is a value rather than a field name', () => {
    const root = fixture({
      mauser: { ...MAUSER, licensing: { connect: { issuer: 'portal', keyRef: syntheticLicenceKey() } } },
    });
    expect(() => loadCustomer(root, 'mauser')).toThrow(/keyRef must be one of/);
  });
});

describe('customer register — secret resolution', () => {
  const licensed = {
    ...MAUSER,
    licensing: { connect: { issuer: 'portal', keyRef: 'connectLicenseKey' } },
    secretsRef: 'customers/mauser.secrets.json',
  };

  it('reads the values from the gitignored secrets file', () => {
    const root = fixture({ mauser: licensed }, {
      secrets: {
        mauser: {
          connectLicenseKey: syntheticLicenceKey(),
          requestyApiKey: syntheticApiKey(),
          requestyBaseUrl: 'https://api.example.invalid/v1',
        },
      },
    });
    const secrets = resolveCustomerSecrets(root, loadCustomer(root, 'mauser'), { env: {} });
    expect(secrets.connectLicenseKey).toBe(syntheticLicenceKey());
    expect(secrets.requestyBaseUrl).toBe('https://api.example.invalid/v1');
  });

  it('lets the environment win over the file for the Requesty pair', () => {
    // The one-off run against another gateway that worked before the register
    // existed has to keep working.
    const root = fixture({ mauser: licensed }, {
      secrets: { mauser: { connectLicenseKey: syntheticLicenceKey(), requestyApiKey: syntheticApiKey() } },
    });
    const secrets = resolveCustomerSecrets(root, loadCustomer(root, 'mauser'), {
      env: { REQUESTY_API_KEY: 'from-environment', REQUESTY_BASE_URL: 'https://other.example.invalid/v1' },
    });
    expect(secrets.requestyApiKey).toBe('from-environment');
    expect(secrets.requestyBaseUrl).toBe('https://other.example.invalid/v1');
    // No per-customer environment convention was invented for the licence key.
    expect(secrets.connectLicenseKey).toBe(syntheticLicenceKey());
  });

  it('names the expected path and the SOPS counterpart when nothing resolves', () => {
    const root = fixture({ mauser: licensed });
    expect(() => resolveCustomerSecrets(root, loadCustomer(root, 'mauser'), { env: {} }))
      .toThrow(/mauser\.secrets\.json[\s\S]*secrets store \(secrets\/delivery\/<slug>\.secrets\.json, SOPS-encrypted\)/);
  });

  it('rejects an unknown field in the secrets file', () => {
    const root = fixture({ mauser: licensed }, {
      secrets: { mauser: { connectLicenseKey: syntheticLicenceKey(), portalPassword: 'nope' } },
    });
    expect(() => resolveCustomerSecrets(root, loadCustomer(root, 'mauser'), { env: {} }))
      .toThrow(/unknown field "portalPassword"/);
  });

  it('resolves to nothing, without throwing, for a customer that holds no licence', () => {
    const root = fixture({
      toray: {
        ...MAUSER, customer: 'toray', displayName: 'Toray', forgejo: undefined, licensing: {},
        delivery: { ...MAUSER.delivery, channel: 'hosted-link', projects: ['Toray'] },
      },
    }, { projects: ['Toray'] });
    const secrets = resolveCustomerSecrets(root, loadCustomer(root, 'toray'), { env: {} });
    expect(secrets.connectLicenseKey).toBeUndefined();
  });
});

describe('customer register — lookup', () => {
  it('finds the owner of a project and reports an ambiguous claim', () => {
    const root = fixture({ mauser: MAUSER });
    expect(resolveCustomerForProject(root, 'mauser3dhmi')?.customer).toBe('mauser');
    expect(resolveCustomerForProject(root, 'not-a-project')).toBeNull();

    const shared = fixture({
      mauser: MAUSER,
      acme: {
        ...MAUSER, customer: 'acme', displayName: 'Acme',
        forgejo: { org: 'rv-acme', repo: 'rv-project-acme', team: 'members', permission: 'write' },
      },
    });
    // Guessing here delivers one customer's project into another's repository.
    expect(() => resolveCustomerForProject(shared, 'mauser3dhmi')).toThrow(/claimed by more than one customer/);
  });

  it('lists nothing rather than failing when the register does not exist yet', () => {
    const root = mkdtempSync(join(tmpdir(), 'rv-customers-empty-'));
    temporary.push(root);
    expect(listCustomers(root)).toEqual([]);
  });
});

describe('customer register — delivery translation', () => {
  // A licence key and a hub URL are what the translation needs; a customer that
  // is not deliverable has neither, and must not be asked for them.
  const LICENSED = {
    ...MAUSER,
    licensing: { connect: { issuer: 'portal', keyRef: 'connectLicenseKey' } },
    secretsRef: 'customers/mauser.secrets.json',
  };
  const STANDARD = {
    ...MAUSER,
    customer: 'acme',
    displayName: 'Acme AG',
    kind: 'standard',
    licensing: { connect: { issuer: 'portal', keyRef: 'connectLicenseKey' } },
    secretsRef: 'customers/acme.secrets.json',
    forgejo: { org: 'rv-acme', repo: 'rv-project-acme', team: 'members', permission: 'read' },
    // The register itself enforces this emptiness for kind "standard".
    delivery: { ...MAUSER.delivery, projects: [] as string[] },
  };
  const registerWithBoth = () => fixture(
    { mauser: LICENSED, acme: STANDARD },
    {
      secrets: {
        mauser: { connectLicenseKey: syntheticLicenceKey() },
        // A standard customer runs CONNECT like anyone else, so they carry a
        // licence key too — what they do NOT carry is a project (plan-434 Phase 4).
        acme: { connectLicenseKey: syntheticLicenceKey() },
      },
    },
  );

  it('enumerates both customers, the standard one with an empty project list', () => {
    const root = registerWithBoth();
    const configs = withHubBaseUrl(() => listDeliveryConfigs(root));
    expect(configs.map(config => config.configName)).toEqual(['acme', 'mauser']);
    expect(configs.find(config => config.configName === 'mauser')!.remote)
      .toBe('https://git.example.invalid/rv-mauser/rv-project-mauser.git');
    const standard = configs.find(config => config.configName === 'acme')!;
    expect(standard.projects).toEqual([]);
    expect(standard.kind).toBe('standard');
  });

  it('delivers a standard customer projectlessly, with a null primary project', () => {
    const root = registerWithBoth();
    const config = withHubBaseUrl(() => loadDeliveryConfigByCustomer(root, 'acme'));
    expect(config.projects).toEqual([]);
    // `null`, never `undefined`: the whole pipeline branches on this value, so it
    // has to read as a decision rather than as an absent field (plan-434 Phase 4).
    expect(config.projectKey).toBeNull();
    expect(config.remote).toBe('https://git.example.invalid/rv-acme/rv-project-acme.git');
    expect(config.connectLicenseKey).toMatch(/^LIC(-[A-Z0-9]{4}){3}$/i);
  });

  it('answers hasDeliveryConfig without a hub URL, for a project key and a customer slug alike', () => {
    const root = registerWithBoth();
    expect(hasDeliveryConfig(root, 'mauser3dhmi')).toBe(true);
    // A projectless customer has no project key to ask about, so the slug is the
    // only question there is — and the answer is yes, they have a git delivery.
    expect(hasDeliveryConfig(root, 'acme')).toBe(true);
    expect(hasDeliveryConfig(root, 'not-a-customer')).toBe(false);
  });
});

/**
 * Translating a SHARED customer (plan-434 §2.7).
 *
 * The mechanics of the delivery do not change — it is the same projectless
 * delivery Phase 4 built — but the destination is shared, and that changes two
 * things that must be asserted rather than assumed: nothing customer-specific
 * may be generated into the workspace, and a missing licence value can no
 * longer stop a delivery that never ships one.
 */
describe('customer register — shared delivery translation', () => {
  const sharedRegister = (secrets: Record<string, Record<string, string>> = {}) => fixture(
    { acme: sharedCustomer('acme'), beta: sharedCustomer('beta') },
    { secrets },
  );

  it('points a shared customer at the one shared remote and says so in the config', () => {
    const root = sharedRegister({ acme: { connectLicenseKey: syntheticLicenceKey() } });
    const config = withHubBaseUrl(() => loadDeliveryConfigByCustomer(root, 'acme'));
    expect(config.remote).toBe(`https://git.example.invalid/${SHARED_ORG}/${SHARED_REPO}.git`);
    expect(config.sharedRepo).toBe(true);
    // Still exactly the projectless delivery of Phase 4 — only the target moved.
    expect(config.projects).toEqual([]);
    expect(config.projectKey).toBeNull();
    expect(config.kind).toBe('standard');
  });

  it('marks an own-repo delivery as not shared', () => {
    const root = fixture({ mauser: { ...MAUSER, licensing: { connect: { issuer: 'portal', keyRef: 'connectLicenseKey' } }, secretsRef: 'customers/mauser.secrets.json' } },
      { secrets: { mauser: { connectLicenseKey: syntheticLicenceKey() } } });
    const config = withHubBaseUrl(() => loadDeliveryConfigByCustomer(root, 'mauser'));
    expect(config.sharedRepo).toBe(false);
    expect(config.remote).toBe('https://git.example.invalid/rv-mauser/rv-project-mauser.git');
  });

  it('translates a shared customer whose licence key has not been issued yet', () => {
    // The key is not delivered in the shared channel, so its absence cannot be
    // what stops the delivery. The register still DECLARES the licence, and the
    // doctor still reports it as owed — that is the management view, not this one.
    const root = sharedRegister();
    expect(() => withHubBaseUrl(() => loadDeliveryConfigByCustomer(root, 'acme'))).not.toThrow();
    const config = withHubBaseUrl(() => loadDeliveryConfigByCustomer(root, 'acme'));
    expect(config.connectLicenseKey).toBeUndefined();
    // The same gap in an own repo still stops the delivery: there the key IS
    // shipped, so a workspace without one is a broken delivery.
    const own = fixture(
      { mauser: { ...MAUSER, licensing: { connect: { issuer: 'portal', keyRef: 'connectLicenseKey' } } } },
    );
    expect(() => withHubBaseUrl(() => loadDeliveryConfigByCustomer(own, 'mauser')))
      .toThrow(/no value resolves/);
  });

  it('does not read two customers on one remote as a conflict', () => {
    const root = sharedRegister({
      acme: { connectLicenseKey: syntheticLicenceKey() },
      beta: { connectLicenseKey: syntheticLicenceKey() },
    });
    const configs = withHubBaseUrl(() => listDeliveryConfigs(root));
    expect(configs.map(config => config.configName)).toEqual(['acme', 'beta']);
    expect(new Set(configs.map(config => config.remote)).size).toBe(1);
    expect(hasDeliveryConfig(root, 'acme')).toBe(true);
    expect(hasDeliveryConfig(root, 'beta')).toBe(true);
  });

  it('collapses the shared customers into one target for the release run', () => {
    const root = sharedRegister();
    const target = withHubBaseUrl(() => sharedDeliveryTarget(root))!;
    expect(target.org).toBe(SHARED_ORG);
    expect(target.repo).toBe(SHARED_REPO);
    expect(target.remote).toBe(`https://git.example.invalid/${SHARED_ORG}/${SHARED_REPO}.git`);
    expect(target.customers).toEqual(['acme', 'beta']);
  });

  it('reports no shared target when nobody is on the shared channel', () => {
    const root = fixture({ mauser: MAUSER });
    expect(withHubBaseUrl(() => sharedDeliveryTarget(root))).toBeNull();
  });
});

describe('customer register — fixture hygiene', () => {
  it('keeps the presets folder inside the fixture wrapper', () => {
    // Regression guard: the first version of this fixture derived the presets
    // path the way production does — as a SIBLING of the private root — and so
    // wrote it next to the OS temp dir, where the next test found a preset it
    // had never created.
    const root = fixture({ mauser: MAUSER }, { presets: ['mauser3dhmi'] });
    expect(existsSync(join(fixturePresetsRoot(root), 'mauser3dhmi.diagnosis.json'))).toBe(true);
    expect(fixturePresetsRoot(root).startsWith(tmpdir())).toBe(true);
  });
});
