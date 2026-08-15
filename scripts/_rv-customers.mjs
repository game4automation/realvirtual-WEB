// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * _rv-customers — the customer register (plan-434 §2.1).
 *
 * ## What this replaces
 *
 * Until now the only machine-readable statement about a customer was
 * `delivery/<key>.json`: a delivery *recipe* that happened to be the closest
 * thing to a customer record. It said nothing about who works there, what kind
 * of relationship it is, what the hub grants them, or whether the customer even
 * has a git delivery — and it carried the licence key and the inference
 * credentials as literal values, in a file that is committed.
 *
 * `customers/<slug>.json` is the record. It is a *superset* of the delivery
 * config and replaces it; two files per customer would be exactly the state
 * plan-434 exists to remove.
 *
 * ## What this module is and is not
 *
 * Loader and validator. **No network I/O** — the Forgejo comparison is the
 * doctor's job (Phase 3) and lives elsewhere. **No hard-coded host names**:
 * `assert-public-safe.mjs` runs over this repository before every mirror push,
 * so the hub host is never written here. A remote URL is assembled from the
 * register's building blocks plus a base URL the *caller* supplies
 * ({@link customerRemoteUrl}).
 *
 * ## Errors versus warnings
 *
 * {@link assertCustomerInvariants} never throws: it returns
 * `{ errors, warnings }`. {@link loadCustomer} throws when `errors` is
 * non-empty. That split exists because one invariant — "a `managed` customer
 * has a diagnosis preset for every project" — is true of `wmyb` today and must
 * not stop a delivery; it is a finding for the doctor, not a load failure.
 *
 * ## Secret values never live here
 *
 * `connectLicenseKey`, `requestyApiKey` and `requestyBaseUrl` resolve through
 * {@link resolveCustomerSecrets}: environment first, then the gitignored
 * `customers/<slug>.secrets.json`, then a clear error naming the expected path
 * and the SOPS counterpart. A credential-shaped *value* found inside the
 * register itself is an error, not a warning (§2.3).
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { readJson } from './_rv-fs-utils.mjs';
import { knownProjectKeys, looksLikeSecretValue } from './_rv-guards.mjs';
// Deliberate module cycle: `_workspace-lib.mjs` imports this file to read the
// register, and this file imports the tier resolver from there so the
// `restrictedFeatures` invariant is judged by the SAME rules the delivery uses
// (a second copy of resolveTier is how "entitled" and "shipped" drift apart).
// Safe under ESM because neither side touches an imported binding at module
// evaluation time — every use is inside a function body.
import { loadTierManifest, resolveTier } from './_workspace-lib.mjs';

//! Schema version of `customers/<slug>.json`. Bumped only on a breaking change.
export const CUSTOMER_SCHEMA_VERSION = 1;

//! `development` customers build with us and get write access; `standard` customers consume.
export const CUSTOMER_KINDS = Object.freeze(['development', 'standard']);
//! `managed` means we run diagnosis/RAG/doc support for them, and a preset must exist per project.
export const CUSTOMER_SUPPORT_LEVELS = Object.freeze(['managed', 'basic']);
export const CUSTOMER_STATUSES = Object.freeze(['active', 'suspended']);
//! How the customer receives the product. Only `git-workspace` has a git delivery.
export const DELIVERY_CHANNELS = Object.freeze(['git-workspace', 'hosted-link', 'connect-exe']);
export const CONTACT_STATUSES = Object.freeze(['active', 'inactive']);
export const FORGEJO_PERMISSIONS = Object.freeze(['read', 'write']);

/**
 * The ONE repository every standard customer shares (plan-434 §2.7).
 *
 * A standard customer buys the product, not a project, and the product is the
 * same bytes for all of them — so one repository carries it and each customer
 * gets a read team of their own inside it. The team name IS the customer slug,
 * which is what makes the register and the hub comparable without a second
 * mapping table.
 *
 * Own-repo (`rv-<slug>/rv-project-<slug>`) stays available for a standard
 * customer who needs it; the register decides, one entry at a time.
 *
 * Only the org and the repo are named here — no host. `assert-public-safe.mjs`
 * runs over this file before every mirror push; the remote is assembled from
 * these two plus a base URL the caller supplies ({@link customerRemoteUrl}).
 */
export const SHARED_ORG = 'rv-commercial';
export const SHARED_REPO = 'realvirtual-commercial';

//! Strict allowlists — an unknown field is a typo that would otherwise be silently ignored.
const CUSTOMER_KEYS = new Set([
  'schemaVersion', 'customer', 'displayName', 'kind', 'support', 'status',
  'forgejo', 'contacts', 'licensing', 'delivery', 'billing', 'secretsRef',
]);
const FORGEJO_KEYS = new Set(['org', 'repo', 'team', 'permission']);
const CONTACT_KEYS = new Set(['login', 'email', 'fullName', 'role', 'status']);
const LICENSING_KEYS = new Set(['connect']);
const LICENSING_CONNECT_KEYS = new Set(['issuer', 'keyRef', 'seats', 'activatedFingerprints']);
const DELIVERY_KEYS = new Set([
  'channel', 'tier', 'restrictedFeatures', 'projects', 'connectChannel', 'mirror',
]);
const BILLING_KEYS = new Set(['billomatCustomer']);

//! The three values a secrets file may carry. `keyRef` must name one of them.
export const CUSTOMER_SECRET_KEYS = Object.freeze(['connectLicenseKey', 'requestyApiKey', 'requestyBaseUrl']);

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const PROJECT_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

//! Absolute path of one register entry.
export function customerRegistryPath(privateRoot, slug) {
  return join(privateRoot, 'customers', `${slug}.json`);
}

//! Default location of the gitignored secrets file belonging to one customer.
export function customerSecretsPath(privateRoot, customer) {
  const ref = typeof customer?.secretsRef === 'string' && customer.secretsRef
    ? customer.secretsRef
    : `customers/${customer.customer}.secrets.json`;
  return join(privateRoot, ...ref.split('/'));
}

/**
 * Where the CONNECT diagnosis preset of one project lives.
 *
 * A sibling repository of the private WebViewer folder, so it is derived rather
 * than configured; `presetsRoot` exists for tests and for a relocated checkout.
 */
export function diagnosisPresetPath(privateRoot, projectKey, presetsRoot = null) {
  const root = presetsRoot ?? join(privateRoot, '..', 'realvirtual-Connect~', 'tools', 'presets');
  return join(root, `${projectKey}.diagnosis.json`);
}

//! Every slug present under `<privateRoot>/customers/`, sorted. Missing folder is not an error.
export function listCustomerSlugs(privateRoot) {
  const root = join(privateRoot, 'customers');
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => name.endsWith('.json') && !name.endsWith('.secrets.json') && !name.endsWith('.cert.json'))
    .map((name) => name.slice(0, -5))
    .sort();
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * True when this customer receives the product through the SHARED commercial
 * repository rather than through a repository of their own.
 *
 * Asks the register, not the kind: a standard customer may legitimately have an
 * own repo, and only the `forgejo` block says which of the two forms is in use.
 * The validator guarantees the rest of the shape (kind, team, permission), so a
 * loaded customer that answers `true` here is a fully checked shared customer.
 */
export function isSharedForgejo(customer) {
  const forgejo = customer?.forgejo;
  return isPlainObject(forgejo) && forgejo.org === SHARED_ORG && forgejo.repo === SHARED_REPO;
}

function unknownKeys(value, allowed) {
  return Object.keys(value).filter((key) => !allowed.has(key));
}

//! Tier of the feature's adapter, judged exactly as the delivery judges it (Phase 2b).
function featureTier(manifest, feature) {
  const adapter = manifest.registrations[feature].adapter.replace(/^\.\//, '') + '.ts';
  return resolveTier(manifest, `src/${adapter}`).tier;
}

/**
 * Validates one register entry. Returns `{ errors, warnings }` and never throws
 * on a finding — see the module header for why the split exists.
 *
 * `context`:
 *   - `fileName`   slug taken from the file name (the identity check)
 *   - `privateRoot` enables the project-existence and preset checks
 *   - `manifest`   tier manifest; loaded from `privateRoot` when omitted
 *   - `presetsRoot` overrides the CONNECT presets folder
 */
export function assertCustomerInvariants(customer, context = {}) {
  const errors = [];
  const warnings = [];
  const label = context.fileName ? `customers/${context.fileName}.json` : 'customer register entry';
  const fail = (message) => errors.push(`${label}: ${message}`);
  const warn = (message) => warnings.push(`${label}: ${message}`);

  if (!isPlainObject(customer)) {
    fail('must be a JSON object.');
    return { errors, warnings };
  }
  for (const key of unknownKeys(customer, CUSTOMER_KEYS)) fail(`contains unknown field "${key}".`);

  if (customer.schemaVersion !== CUSTOMER_SCHEMA_VERSION) {
    fail(`"schemaVersion" must be ${CUSTOMER_SCHEMA_VERSION}.`);
  }
  const slug = customer.customer;
  if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) {
    fail('"customer" must be a lowercase slug like "mauser".');
  } else if (context.fileName !== undefined && context.fileName !== slug) {
    fail(`"customer" is "${slug}" but the file is named "${context.fileName}.json"; the slug IS the file name.`);
  }
  if (typeof customer.displayName !== 'string' || !customer.displayName.trim()) {
    fail('"displayName" is required.');
  }
  if (!CUSTOMER_KINDS.includes(customer.kind)) fail(`"kind" must be one of ${CUSTOMER_KINDS.join(', ')}.`);
  if (!CUSTOMER_SUPPORT_LEVELS.includes(customer.support)) {
    fail(`"support" must be one of ${CUSTOMER_SUPPORT_LEVELS.join(', ')}.`);
  }
  if (!CUSTOMER_STATUSES.includes(customer.status)) fail(`"status" must be one of ${CUSTOMER_STATUSES.join(', ')}.`);

  // ── delivery ──────────────────────────────────────────────────────────
  const delivery = customer.delivery;
  let projects = [];
  if (!isPlainObject(delivery)) {
    fail('"delivery" must be a JSON object.');
  } else {
    for (const key of unknownKeys(delivery, DELIVERY_KEYS)) fail(`delivery contains unknown field "${key}".`);
    if (!DELIVERY_CHANNELS.includes(delivery.channel)) {
      fail(`delivery.channel must be one of ${DELIVERY_CHANNELS.join(', ')}.`);
    }
    if (!['core', 'commercial'].includes(delivery.tier)) fail('delivery.tier must be core or commercial.');
    if (!['stable', 'beta'].includes(delivery.connectChannel)) {
      fail('delivery.connectChannel must be stable or beta.');
    }
    if (delivery.mirror !== null && typeof delivery.mirror !== 'string') {
      fail('delivery.mirror must be a string or null.');
    }
    if (!Array.isArray(delivery.projects)
        || delivery.projects.some((key) => typeof key !== 'string' || !PROJECT_KEY_PATTERN.test(key))) {
      fail('delivery.projects must be an array of project keys.');
    } else if (new Set(delivery.projects).size !== delivery.projects.length) {
      fail('delivery.projects contains duplicates.');
    } else {
      projects = delivery.projects;
    }
    if (!Array.isArray(delivery.restrictedFeatures)
        || delivery.restrictedFeatures.some((feature) => typeof feature !== 'string')) {
      fail('delivery.restrictedFeatures must be an array of feature keys.');
    } else if (new Set(delivery.restrictedFeatures).size !== delivery.restrictedFeatures.length) {
      fail('delivery.restrictedFeatures contains duplicates.');
    } else if (delivery.restrictedFeatures.length > 0) {
      let manifest = context.manifest ?? null;
      if (!manifest && context.privateRoot) {
        try {
          manifest = loadTierManifest(context.privateRoot);
        } catch (error) {
          fail(`delivery.restrictedFeatures cannot be checked: ${error?.message ?? error}`);
        }
      }
      if (manifest) {
        for (const feature of delivery.restrictedFeatures) {
          if (!manifest.registrations[feature]) {
            fail(`delivery.restrictedFeatures names "${feature}", which is not in tier-manifest.json.`);
            continue;
          }
          const tier = featureTier(manifest, feature);
          if (tier !== 'restricted') {
            // An entitlement on a commercial feature suggests a grant that does
            // nothing: the feature already ships to every commercial customer.
            fail(`delivery.restrictedFeatures names "${feature}", whose adapter resolves to tier "${tier}"; `
              + 'only restricted features can be granted individually.');
          }
        }
      }
    }

    // kind ⇄ projects, and kind ⇄ hub permission (§2.1 / §2.2)
    if (customer.kind === 'development' && Array.isArray(delivery.projects) && delivery.projects.length === 0) {
      fail('kind "development" requires at least one entry in delivery.projects.');
    }
    if (customer.kind === 'standard' && Array.isArray(delivery.projects) && delivery.projects.length > 0) {
      fail('kind "standard" must have an empty delivery.projects — standard customers get no seed project.');
    }
    if (delivery.channel === 'git-workspace' && !isPlainObject(customer.forgejo)) {
      fail('delivery.channel "git-workspace" requires a "forgejo" block.');
    }
  }

  // ── forgejo ───────────────────────────────────────────────────────────
  if (customer.forgejo !== undefined) {
    if (!isPlainObject(customer.forgejo)) {
      fail('"forgejo" must be a JSON object.');
    } else {
      for (const key of unknownKeys(customer.forgejo, FORGEJO_KEYS)) fail(`forgejo contains unknown field "${key}".`);
      // Exactly TWO valid forms, and the block itself says which one it means
      // (plan-434 §2.7). Anything naming the shared org OR the shared repo is
      // judged as shared — a half-shared block is a mistake, not a third form.
      const shared = customer.forgejo.org === SHARED_ORG || customer.forgejo.repo === SHARED_REPO;
      if (shared) {
        if (customer.forgejo.org !== SHARED_ORG || customer.forgejo.repo !== SHARED_REPO) {
          fail(`forgejo names the shared repository only half: both org "${SHARED_ORG}" and repo "${SHARED_REPO}" `
            + `are required together (is ${JSON.stringify(customer.forgejo.org)}/${JSON.stringify(customer.forgejo.repo)}).`);
        }
        // A development customer writes into their repository. In the shared one
        // that would mean writing into every other customer's product.
        if (customer.kind !== 'standard') {
          fail(`kind ${JSON.stringify(customer.kind)} cannot use the shared repository ${SHARED_ORG}/${SHARED_REPO}; `
            + 'only kind "standard" shares it. Give this customer an own repo (rv-<slug>/rv-project-<slug>).');
        }
        // The team is the customer's only identity inside the shared repository,
        // so it is the slug — a shared "members" team would grant everyone.
        if (typeof slug === 'string' && customer.forgejo.team !== slug) {
          fail(`forgejo.team must be "${slug}" in the shared repository — the slug IS the team name `
            + `(is ${JSON.stringify(customer.forgejo.team)}).`);
        }
        if (FORGEJO_PERMISSIONS.includes(customer.forgejo.permission) && customer.forgejo.permission !== 'read') {
          fail(`forgejo.permission must be "read" in the shared repository ${SHARED_ORG}/${SHARED_REPO} `
            + `(is ${JSON.stringify(customer.forgejo.permission)}).`);
        }
      } else if (typeof slug === 'string') {
        if (customer.forgejo.org !== `rv-${slug}`) {
          fail(`forgejo.org must be "rv-${slug}" or the shared "${SHARED_ORG}" (is ${JSON.stringify(customer.forgejo.org)}).`);
        }
        if (customer.forgejo.repo !== `rv-project-${slug}`) {
          fail(`forgejo.repo must be "rv-project-${slug}" or the shared "${SHARED_REPO}" `
            + `(is ${JSON.stringify(customer.forgejo.repo)}).`);
        }
      }
      if (typeof customer.forgejo.team !== 'string' || !customer.forgejo.team.trim()) {
        fail('forgejo.team is required.');
      }
      if (!FORGEJO_PERMISSIONS.includes(customer.forgejo.permission)) {
        fail(`forgejo.permission must be one of ${FORGEJO_PERMISSIONS.join(', ')}.`);
      } else if (!shared) {
        const expected = customer.kind === 'standard' ? 'read' : 'write';
        if (CUSTOMER_KINDS.includes(customer.kind) && customer.forgejo.permission !== expected) {
          fail(`forgejo.permission must be "${expected}" for kind "${customer.kind}".`);
        }
      }
    }
  }

  // ── contacts ──────────────────────────────────────────────────────────
  if (!Array.isArray(customer.contacts)) {
    fail('"contacts" must be an array (use [] when nobody is registered yet).');
  } else {
    const logins = new Set();
    for (const [index, contact] of customer.contacts.entries()) {
      const at = `contacts[${index}]`;
      if (!isPlainObject(contact)) {
        fail(`${at} must be a JSON object.`);
        continue;
      }
      for (const key of unknownKeys(contact, CONTACT_KEYS)) fail(`${at} contains unknown field "${key}".`);
      if (typeof contact.login !== 'string' || !contact.login.trim()) {
        fail(`${at}.login is required.`);
      } else if (logins.has(contact.login)) {
        fail(`${at}.login "${contact.login}" is used more than once.`);
      } else {
        logins.add(contact.login);
      }
      if (!CONTACT_STATUSES.includes(contact.status)) {
        fail(`${at}.status must be one of ${CONTACT_STATUSES.join(', ')}.`);
      }
      // The address is the password-reset channel, so it is part of onboarding
      // and mandatory while the account is meant to work.
      if (contact.status === 'active' && (typeof contact.email !== 'string' || !contact.email.includes('@'))) {
        fail(`${at}.email is required while status is "active".`);
      }
      for (const key of ['fullName', 'role']) {
        if (contact[key] !== undefined && (typeof contact[key] !== 'string' || !contact[key].trim())) {
          fail(`${at}.${key} must be a non-empty string when present.`);
        }
      }
    }
  }

  // ── licensing ─────────────────────────────────────────────────────────
  if (customer.licensing !== undefined) {
    if (!isPlainObject(customer.licensing)) {
      fail('"licensing" must be a JSON object.');
    } else {
      for (const key of unknownKeys(customer.licensing, LICENSING_KEYS)) {
        fail(`licensing contains unknown field "${key}".`);
      }
      const connect = customer.licensing.connect;
      if (connect !== undefined) {
        if (!isPlainObject(connect)) {
          fail('licensing.connect must be a JSON object.');
        } else {
          for (const key of unknownKeys(connect, LICENSING_CONNECT_KEYS)) {
            fail(`licensing.connect contains unknown field "${key}".`);
          }
          if (typeof connect.issuer !== 'string' || !connect.issuer.trim()) {
            fail('licensing.connect.issuer is required (the register assigns, it does not issue).');
          }
          if (!CUSTOMER_SECRET_KEYS.includes(connect.keyRef)) {
            fail(`licensing.connect.keyRef must be one of ${CUSTOMER_SECRET_KEYS.join(', ')} — `
              + 'it names a field in the secrets file, never a value.');
          }
          for (const key of ['seats', 'activatedFingerprints']) {
            if (connect[key] !== undefined && (!Number.isInteger(connect[key]) || connect[key] < 0)) {
              fail(`licensing.connect.${key} must be a non-negative integer when present.`);
            }
          }
        }
      }
    }
  }

  // ── billing / secretsRef ──────────────────────────────────────────────
  if (customer.billing !== undefined) {
    if (!isPlainObject(customer.billing)) {
      fail('"billing" must be a JSON object.');
    } else {
      for (const key of unknownKeys(customer.billing, BILLING_KEYS)) fail(`billing contains unknown field "${key}".`);
      if (customer.billing.billomatCustomer !== undefined
          && (typeof customer.billing.billomatCustomer !== 'string' || !customer.billing.billomatCustomer.trim())) {
        fail('billing.billomatCustomer must be a non-empty string when present.');
      }
    }
  }
  if (customer.secretsRef !== undefined) {
    if (typeof customer.secretsRef !== 'string' || !customer.secretsRef.startsWith('customers/')
        || customer.secretsRef.includes('..') || customer.secretsRef.includes('\\')) {
      fail('"secretsRef" must be a POSIX path under "customers/".');
    } else if (typeof slug === 'string' && customer.secretsRef !== `customers/${slug}.secrets.json`) {
      fail(`"secretsRef" must be "customers/${slug}.secrets.json" so the .gitignore rule covers it.`);
    }
  }

  // ── no secret VALUES anywhere in the register (§2.3) ───────────────────
  for (const [path, value] of flattenStrings(customer)) {
    if (looksLikeSecretValue(value)) {
      fail(`${path} holds a credential-shaped value. Licence and API keys belong in `
        + `customers/${typeof slug === 'string' ? slug : '<slug>'}.secrets.json, referenced by licensing.connect.keyRef.`);
    }
  }

  // ── cross-checks against the private tree ─────────────────────────────
  if (context.privateRoot) {
    const known = new Set(knownProjectKeys(context.privateRoot));
    for (const key of projects) {
      if (!known.has(key)) {
        fail(`delivery.projects names "${key}", but ${join('projects', key, 'project.json')} does not exist `
          + '(project keys are case-sensitive).');
      }
    }
    if (customer.support === 'managed') {
      for (const key of projects) {
        const preset = diagnosisPresetPath(context.privateRoot, key, context.presetsRoot);
        // A warning, not an error: wmyb is `basic` precisely because it has no
        // preset, and turning this into a load failure would stop a delivery
        // over a support-tooling gap. The doctor (Phase 3) gates on it.
        if (!existsSync(preset)) warn(`support "managed" but no diagnosis preset for "${key}" at ${preset}.`);
      }
    }
  }

  return { errors, warnings };
}

//! Every string leaf of the register, with its dotted path — the input of the secret-value check.
function flattenStrings(value, path = '', out = []) {
  if (typeof value === 'string') {
    out.push([path || '<root>', value]);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => flattenStrings(item, `${path}[${index}]`, out));
    return out;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) flattenStrings(item, path ? `${path}.${key}` : key, out);
  }
  return out;
}

/**
 * Reads and validates `customers/<slug>.json`.
 *
 * Throws with every finding at once rather than the first — a register entry is
 * hand-written and reporting one problem per run is three runs of nothing.
 */
export function loadCustomer(privateRoot, slug, options = {}) {
  if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) throw new Error(`Invalid customer slug ${slug}.`);
  const path = customerRegistryPath(privateRoot, slug);
  if (!existsSync(path)) throw new Error(`Customer register entry not found: ${path}`);
  const customer = readJson(path, `customers/${slug}.json`);
  const { errors, warnings } = assertCustomerInvariants(customer, {
    fileName: slug,
    privateRoot,
    manifest: options.manifest,
    presetsRoot: options.presetsRoot,
  });
  if (errors.length > 0) throw new Error(errors.join('\n'));
  if (typeof options.onWarning === 'function') warnings.forEach((warning) => options.onWarning(warning));
  return customer;
}

//! Every register entry, sorted by slug. An absent `customers/` folder yields [].
export function listCustomers(privateRoot, options = {}) {
  return listCustomerSlugs(privateRoot).map((slug) => loadCustomer(privateRoot, slug, options));
}

/**
 * The customer that owns one project key, or `null`.
 *
 * Two customers claiming the same key is an error, never a first match:
 * guessing here means delivering one customer's project into another
 * customer's repository.
 */
export function resolveCustomerForProject(privateRoot, projectKey, options = {}) {
  if (typeof projectKey !== 'string' || !PROJECT_KEY_PATTERN.test(projectKey)) {
    throw new Error(`Invalid project key ${projectKey}.`);
  }
  const matches = listCustomers(privateRoot, options)
    .filter((customer) => customer.delivery.projects.includes(projectKey));
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(`Project "${projectKey}" is claimed by more than one customer: `
      + `${matches.map((customer) => `customers/${customer.customer}.json`).join(', ')}.`);
  }
  return matches[0];
}

/**
 * Assembles the customer's git remote from the register plus a base URL.
 *
 * The base URL is a parameter on purpose: this file is mirrored to a public
 * remote, and `assert-public-safe.mjs` refuses infrastructure host names in it.
 */
export function customerRemoteUrl(customer, hubBaseUrl) {
  if (!isPlainObject(customer.forgejo)) {
    throw new Error(`Customer "${customer.customer}" has no forgejo block, so it has no git remote.`);
  }
  if (typeof hubBaseUrl !== 'string' || !/^https?:\/\//i.test(hubBaseUrl)) {
    throw new Error(`A hub base URL is required to build the remote of "${customer.customer}".`);
  }
  return `${hubBaseUrl.replace(/\/+$/, '')}/${customer.forgejo.org}/${customer.forgejo.repo}.git`;
}

/**
 * Resolves the customer's secret values: environment → secrets file → error.
 *
 * The environment layer is deliberately only the two Requesty variables that
 * already worked that way. No `CONNECT_LICENSE_KEY_<SLUG>` convention is
 * invented here: a per-customer environment variable is a second place a
 * licence key can live, which is the problem, not the fix.
 *
 * `options.requireLicenseKey` (default `true`) is what a caller sets to `false`
 * when the run does not SHIP the key: a shared-repo delivery writes no
 * `connectLicensePrefill` (plan-434 §2.7), so a missing value cannot break it.
 * The default keeps the management view — the doctor — reporting "declared but
 * no value resolves", because the licence itself is still owed to the customer.
 */
export function resolveCustomerSecrets(privateRoot, customer, options = {}) {
  const env = options.env ?? process.env;
  const path = customerSecretsPath(privateRoot, customer);
  let file = null;
  if (existsSync(path)) {
    file = readJson(path, `customers/${customer.customer}.secrets.json`);
    if (!isPlainObject(file)) throw new Error(`${path} must be a JSON object.`);
    const unknown = unknownKeys(file, new Set(CUSTOMER_SECRET_KEYS));
    if (unknown.length > 0) {
      throw new Error(`${path} contains unknown field "${unknown[0]}"; allowed: ${CUSTOMER_SECRET_KEYS.join(', ')}.`);
    }
  }
  const fromEnv = (name) => (typeof env[name] === 'string' && env[name].trim() ? env[name].trim() : undefined);
  const keyRef = customer.licensing?.connect?.keyRef;
  const secrets = {
    connectLicenseKey: keyRef ? file?.[keyRef] : file?.connectLicenseKey,
    requestyApiKey: fromEnv('REQUESTY_API_KEY') ?? file?.requestyApiKey,
    requestyBaseUrl: fromEnv('REQUESTY_BASE_URL') ?? file?.requestyBaseUrl,
    path,
  };
  if (customer.licensing?.connect && !secrets.connectLicenseKey && options.requireLicenseKey !== false) {
    throw new Error(`Customer "${customer.customer}" declares a CONNECT licence but no value resolves for `
      + `"${keyRef}". Expected it in ${path} (gitignored). The encrypted counterpart lives in the private `
      + 'knowledge-base secrets store (secrets/delivery/<slug>.secrets.json, SOPS-encrypted) — decrypt it '
      + 'with SOPS and write the file.');
  }
  return secrets;
}
