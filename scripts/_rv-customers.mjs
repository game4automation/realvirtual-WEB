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
 * has a git delivery — and it carried the inference credentials as literal
 * values, in a file that is committed.
 *
 * `customers/<slug>.json` is the record. It is a *superset* of the delivery
 * config and replaces it; two files per customer would be exactly the state
 * plan-434 exists to remove.
 *
 * ## What this module is and is not
 *
 * Loader and validator. **No network I/O** — the Forgejo comparison is the
 * doctor's job (Phase 3) and lives elsewhere. A remote URL is assembled from
 * the register's building blocks plus a base URL ({@link customerRemoteUrl}),
 * which the caller may supply and which otherwise defaults to
 * {@link DEFAULT_HUB_URL} — the one place the hub is named (plan-739 F6).
 * `assert-public-safe.mjs` deliberately keeps the hub host OFF its denied-content
 * list (`git.realvirtual.io` is a public domain, named legitimately in the
 * delivery instructions generated for customers), so naming it here is safe for
 * the public mirror; the internal markers that guard stops are unaffected.
 *
 * ## Errors versus warnings
 *
 * {@link assertCustomerInvariants} never throws: it returns
 * `{ errors, warnings }`. {@link loadCustomer} throws when `errors` is
 * non-empty. That split exists because one invariant — "a `managed` customer
 * has a diagnosis preset for every project" — is true of `wmyb` today and must
 * not stop a delivery; it is a finding for the doctor, not a load failure.
 *
 * ## One customer, one file
 *
 * Everything a delivery needs is IN the entry (2026-09-13): the CONNECT licence
 * as `licensing.connect.key`, the Requesty pair as `inference`. Both used to sit
 * in a gitignored `customers/<slug>.secrets.json` — the licence additionally in
 * a SOPS copy in the knowledge base that no code ever read. Three places for one
 * string, synchronised by hand and in practice regularly out of sync: a customer
 * was onboarded with no key anywhere, and the doctor could only say something
 * was missing, not where it had gone.
 *
 * Neither value is a secret FROM the customer: we issue the licence and hand it
 * over, and `bundle-rag` embeds the Requesty credentials into their delivered
 * `project-config.json` regardless. What the sidecar bought was not protection
 * but a second mechanism.
 *
 * The scan for credential-shaped values in the register therefore still runs —
 * `licensing.connect.key` and `inference.requestyApiKey` are two exact exempt
 * paths, so an unexpected token or password anywhere else is still a hard error
 * (§2.3).
 */

import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { readJson } from './_rv-fs-utils.mjs';
import { knownProjectKeys, looksLikeSecretValue, CONNECT_LICENSE_KEY_PATTERN } from './_rv-guards.mjs';
import { planProjectLibraries } from './lib/rv-library-trim.mjs';
import {
  REALVIRTUAL_LIBRARY_PROJECT_ID,
  libraryEntriesOf,
  libraryProjectIdProblem,
} from '../src/core/project/rv-library-trim-core.mjs';
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
 * Only the org and the repo are named here; the remote is assembled from these
 * two plus a base URL ({@link customerRemoteUrl}), which defaults to
 * {@link DEFAULT_HUB_URL}.
 */
export const SHARED_ORG = 'rv-commercial';
export const SHARED_REPO = 'realvirtual-commercial';

//! Strict allowlists — an unknown field is a typo that would otherwise be silently ignored.
const CUSTOMER_KEYS = new Set([
  'schemaVersion', 'customer', 'displayName', 'kind', 'support', 'status',
  'forgejo', 'contacts', 'licensing', 'delivery', 'billing', 'inference', 'hosted',
  'publishing',
]);
//! plan-603 D1/D5: where a partner publishes his OWN projects — his own Bunny storage
//! zone in our account, his own pull zone, his own hostname. `storageKey` is that zone's
//! password and the third credential the register is allowed to hold as a value: it is a
//! credential we issue TO the partner and he holds it anyway, and it grants write and
//! delete inside HIS zone only (which is the whole point of giving him one).
const PUBLISHING_KEYS = new Set([
  'target', 'storageZone', 'storageZoneId', 'pullZoneId', 'hostname', 'region',
  'monthlyBandwidthGb', 'storageKey',
]);
//! The only publishing form that exists today. A second one would be a decision, not a typo.
export const PUBLISHING_TARGETS = Object.freeze(['partner-zone']);
//! Bunny's primary storage regions (`POST /storagezone`).
export const BUNNY_REGIONS = Object.freeze(['DE', 'NY', 'LA', 'SG']);
//! plan-759 D6/D6b: the hosted-link secrets live IN the entry, like the licence.
//! `fragment` is link material (the `#k=` half of the key, base64url, 32 bytes),
//! `password` the half the customer types. Both are exempt from the register's
//! secret-value refusal for exactly these two paths and nothing else.
const HOSTED_KEYS = new Set(['fragment', 'password']);
const FORGEJO_KEYS = new Set(['org', 'repo', 'team', 'permission']);
const CONTACT_KEYS = new Set(['login', 'email', 'fullName', 'role', 'status']);
const LICENSING_KEYS = new Set(['connect']);
const LICENSING_CONNECT_KEYS = new Set(['issuer', 'key', 'seats', 'activatedFingerprints']);
const DELIVERY_KEYS = new Set([
  'channel', 'tier', 'restrictedFeatures', 'projects', 'connectChannel', 'mirror',
]);
const BILLING_KEYS = new Set(['billomatCustomer']);
const INFERENCE_KEYS = new Set(['requestyApiKey', 'requestyBaseUrl']);



const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const PROJECT_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
//! A DNS hostname, lowercase, at least two labels (`wmyb.web.realvirtual.io`, `3d.partner.de`).
const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

//! Absolute path of one register entry.
export function customerRegistryPath(privateRoot, slug) {
  return join(privateRoot, 'customers', `${slug}.json`);
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

/**
 * True when a delivery of this customer carries the CONNECT diagnosis package (plan-679 Phase 2).
 *
 * The register already says it: `support: "managed"` means "we run diagnosis/RAG for them, a
 * preset exists per project". A second field (`delivery.diagnosis`) would be a second truth for
 * the same thing. A projectless or shared-repository customer has no corpus to embed, so it never
 * carries the package — whatever `support` says.
 *
 * Accepts a register entry or a delivery config (both carry `support`; a delivery config carries
 * `projects` at the top level instead of under `delivery`).
 */
export function deliversDiagnosis(customer) {
  if (!customer || customer.support !== 'managed') return false;
  if (isSharedForgejo(customer) || customer.sharedRepo === true) return false;
  const projects = customer.delivery?.projects ?? customer.projects ?? [];
  return Array.isArray(projects) && projects.length > 0;
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
          // The licence key is a VALUE here (2026-09-13). It used to be a
          // `keyRef` naming a field in a gitignored sidecar, with an encrypted
          // counterpart in the knowledge base — three places for one string,
          // kept in sync by hand, and regularly out of sync. The key is issued
          // by us, carries no access to anything but the customer's own CONNECT
          // and travels to them anyway, so the register is where it belongs.
          // OPTIONAL on purpose: a customer between onboarding and the portal
          // issuing their licence declares `connect` with no `key` yet. That is a
          // finding for the doctor (resolveCustomerSecrets throws), not an
          // unreadable file — making it required would break `list`, `doctor`
          // and every delivery for exactly the customer who needs attention.
          if (connect.key !== undefined
              && (typeof connect.key !== 'string' || !CONNECT_LICENSE_KEY_PATTERN.test(connect.key.trim()))) {
            fail('licensing.connect.key must look like a CONNECT licence key (LIC-XXXX-XXXX-XXXX); '
              + 'leave it out entirely while the licence is not issued yet.');
          }
          // Same placeholder refusal the delivery already makes: a customer
          // delivered 'LIC-XXXX-XXXX-XXXX' looks licensed and activates nothing.
          else if (typeof connect.key === 'string' && /placeholder|example|dummy|xxxx/i.test(connect.key)) {
            fail(`licensing.connect.key looks like a placeholder; write the customer's real key.`);
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

  // ── billing ────────────────────────────────────────────────────────
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
  // ── inference (the Requesty pair) ─────────────────────────
  //
  // In the entry since 2026-09-13, for the same reason as the licence: these
  // values are embedded into the customer's delivered project-config.json by
  // bundle-rag anyway, so a gitignored sidecar protected them from nobody while
  // costing a whole second mechanism. REQUESTY_API_KEY / REQUESTY_BASE_URL still
  // win at run time — that is a one-off override, not a storage location.
  // ── hosted (plan-759) ─────────────────────────────────────────────────
  if (customer.hosted !== undefined) {
    if (!isPlainObject(customer.hosted)) {
      fail('"hosted" must be a JSON object.');
    } else {
      for (const key of unknownKeys(customer.hosted, HOSTED_KEYS)) fail(`hosted contains unknown field "${key}".`);
      if (customer.hosted.password !== undefined
          && (typeof customer.hosted.password !== 'string' || customer.hosted.password.length < 8)) {
        fail('hosted.password must be a string of at least 8 characters when present.');
      }
      if (customer.hosted.fragment !== undefined
          && (typeof customer.hosted.fragment !== 'string' || !isHostedFragment(customer.hosted.fragment))) {
        fail('hosted.fragment must be the base64url of 32 bytes (43 characters, no padding) when present.');
      }
    }
  }

  // ── publishing (plan-603) ─────────────────────────────────────────────
  //
  // A partner who publishes his own projects gets his own storage zone, because a
  // Bunny storage-zone password is the smallest thing Bunny scopes: handing out the
  // key of `realvitual-web` would hand out write and delete on every other customer's
  // private project. The block is the record of that zone, and `provision-partner-zone`
  // writes it. `monthlyBandwidthGb` 0 means "no cap" and must be deliberate (D4).
  if (customer.publishing !== undefined) {
    if (!isPlainObject(customer.publishing)) {
      fail('"publishing" must be a JSON object.');
    } else {
      const publishing = customer.publishing;
      for (const key of unknownKeys(publishing, PUBLISHING_KEYS)) {
        fail(`publishing contains unknown field "${key}".`);
      }
      if (!PUBLISHING_TARGETS.includes(publishing.target)) {
        fail(`publishing.target must be one of ${PUBLISHING_TARGETS.join(', ')}.`);
      }
      if (typeof publishing.storageZone !== 'string' || !SLUG_PATTERN.test(publishing.storageZone)) {
        fail('publishing.storageZone must be a lowercase zone name like "rv-partner-wmyb".');
      }
      if (typeof publishing.hostname !== 'string' || !HOSTNAME_PATTERN.test(publishing.hostname)) {
        fail('publishing.hostname must be a DNS hostname like "wmyb.web.realvirtual.io".');
      }
      for (const key of ['storageZoneId', 'pullZoneId']) {
        if (publishing[key] !== undefined
            && (!Number.isInteger(publishing[key]) || publishing[key] <= 0)) {
          fail(`publishing.${key} must be a positive integer when present (Bunny's own id).`);
        }
      }
      if (publishing.region !== undefined && !BUNNY_REGIONS.includes(publishing.region)) {
        fail(`publishing.region must be one of ${BUNNY_REGIONS.join(', ')} when present.`);
      }
      if (publishing.monthlyBandwidthGb !== undefined
          && (!Number.isInteger(publishing.monthlyBandwidthGb) || publishing.monthlyBandwidthGb < 0)) {
        fail('publishing.monthlyBandwidthGb must be a non-negative integer (0 = no cap) when present.');
      } else if (publishing.monthlyBandwidthGb === 0) {
        // Not an error: an uncapped partner zone is a decision someone may take. It is
        // a finding, because the traffic lands on our invoice (D4).
        warn('publishing.monthlyBandwidthGb is 0 — this partner zone has NO bandwidth cap.');
      } else if (publishing.monthlyBandwidthGb === undefined) {
        warn('publishing carries no monthlyBandwidthGb — the partner zone runs uncapped on our invoice.');
      }
      if (publishing.storageKey !== undefined
          && (typeof publishing.storageKey !== 'string' || !publishing.storageKey.trim())) {
        fail('publishing.storageKey must be a non-empty string when present.');
      }
    }
  }

  if (customer.inference !== undefined) {
    if (!isPlainObject(customer.inference)) {
      fail('"inference" must be a JSON object.');
    } else {
      for (const key of unknownKeys(customer.inference, INFERENCE_KEYS)) {
        fail(`inference contains unknown field "${key}".`);
      }
      if (customer.inference.requestyApiKey !== undefined
          && (typeof customer.inference.requestyApiKey !== 'string' || !customer.inference.requestyApiKey.trim())) {
        fail('inference.requestyApiKey must be a non-empty string when present.');
      }
      if (customer.inference.requestyBaseUrl !== undefined
          && (typeof customer.inference.requestyBaseUrl !== 'string'
            || !/^https:[/][/]/i.test(customer.inference.requestyBaseUrl))) {
        fail('inference.requestyBaseUrl must be an https:// URL when present.');
      }
    }
  }

  // ── no secret VALUES anywhere in the register, except these two ────────
  //
  // The licence and the Requesty key are the credential-shaped values the entry
  // is allowed to hold (2026-09-13); both reach the customer through the
  // delivery anyway. Everything else — tokens, passwords, another vendor's key —
  // is still a hard error, so the exemption is a list of exact paths rather
  // than a relaxed pattern.
  // plan-759 D6b adds the two hosted-link halves; nothing else is exempt.
  // plan-603 D5 adds the partner zone's password; nothing else is exempt.
  const CREDENTIAL_PATHS = new Set([
    'licensing.connect.key', 'inference.requestyApiKey', 'hosted.password', 'hosted.fragment',
    'publishing.storageKey',
  ]);
  for (const [path, value] of flattenStrings(customer)) {
    if (CREDENTIAL_PATHS.has(path)) continue;
    if (looksLikeSecretValue(value)) {
      fail(`${path} holds a credential-shaped value. Only the CONNECT licence `
        + '(licensing.connect.key), the Requesty key (inference.requestyApiKey) and the hosted-link '
        + 'pair (hosted.password, hosted.fragment) belong in the register; anything else has no place in it at all.');
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
    // plan-778 F15: SHAPE of the libraries[] of a delivered project - every entry names
    // something and no id names a path. Deliberately shallow: the deep resolution (library
    // folders, GLB reads, qualified references) is the doctor and the delivery itself, with
    // the real --projects-dir / --library sources. Running it here made one customer's
    // library problem break loading of EVERY customer and ignored --library.
    for (const key of projects) {
      if (known.has(key)) {
        // `context.deepLibraries` is the doctor's switch (deep resolution); loadCustomer/list never set it.
        for (const message of projectLibraryProblems(context.privateRoot, key, { deep: context.deepLibraries === true, sources: context.librarySources ?? {} })) fail(message);
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

/**
 * Library findings of `projects/<key>` (plan-778): shape of `libraries[]` always, then -
 * only with `deep: true` (the doctor) and only when the project lists a library project
 * other than the public realvirtual one - the delivery's own resolution
 * (`planProjectLibraries`; by id in `projects/` plus `sources`, the `--projects-dir` /
 * `--library` the delivery will use). Reading GLB JSON chunks is the expensive half.
 */
export function projectLibraryProblems(privateRoot, key, { deep = false, sources = {} } = {}) {
  const projectDir = join(privateRoot, 'projects', key);
  let manifest;
  try { manifest = readJson(join(projectDir, 'project.json')); } catch { return []; }
  const out = [];
  let needsResolution = false;
  libraryEntriesOf(manifest).forEach((entry, index) => {
    const hasId = typeof entry.projectId === 'string' && entry.projectId.trim() !== '';
    const hasUrl = typeof entry.url === 'string' && entry.url.trim() !== '';
    if (!hasId && !hasUrl) {
      out.push(`projects/${key}: libraries[${index}] has neither "projectId" nor "url".`);
      return;
    }
    if (entry.projectId === undefined) return;
    const problem = libraryProjectIdProblem(entry.projectId);
    if (problem) out.push(`projects/${key}: libraries[${index}]: ${problem}.`);
    else if (entry.projectId !== REALVIRTUAL_LIBRARY_PROJECT_ID) needsResolution = true;
  });
  if (!deep || !needsResolution || out.length > 0) return out;
  try {
    const plan = planProjectLibraries(projectDir, {
      projectsDir: sources.projectsDir ?? join(privateRoot, 'projects'),
      libraries: sources.libraries ?? {},
    });
    for (const error of plan.errors) out.push(`projects/${key}: ${error.message}`);
  } catch (error) {
    out.push(`projects/${key}: library resolution could not run (${error?.message ?? error}).`);
  }
  return out;
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
 * The hub, named once. Every other statement about it is derived from this or
 * from the `RV_FORGEJO_HUB_URL` environment override (plan-739 F6).
 *
 * It lives HERE because this is the one module both sides already import:
 * `_workspace-lib.mjs` (`hubBaseUrl()`, and through it every delivery remote) and
 * the private `scripts/deliver-release.mjs`. A second copy in either place is how
 * a release run and a single delivery start disagreeing about where the hub is.
 *
 * Before plan-739 `hubBaseUrl()` scavenged the origin out of a legacy
 * `delivery/*.json`. Those files are gone, and a register-only customer
 * (hs-heilbronn, iotsolution, toray) had no legacy file to scavenge from, so the
 * direct path resolved for two of five customers and threw for the other three.
 */
export const DEFAULT_HUB_URL = 'https://git.realvirtual.io';

/**
 * Assembles the customer's git remote from the register plus a base URL.
 *
 * The base URL stays a parameter so a caller can point a rehearsal at another
 * hub; omitted, it is {@link DEFAULT_HUB_URL}.
 */
export function customerRemoteUrl(customer, hubBaseUrl = DEFAULT_HUB_URL) {
  if (!isPlainObject(customer.forgejo)) {
    throw new Error(`Customer "${customer.customer}" has no forgejo block, so it has no git remote.`);
  }
  if (typeof hubBaseUrl !== 'string' || !/^https?:\/\//i.test(hubBaseUrl)) {
    throw new Error(`A hub base URL is required to build the remote of "${customer.customer}".`);
  }
  return `${hubBaseUrl.replace(/\/+$/, '')}/${customer.forgejo.org}/${customer.forgejo.repo}.git`;
}

/**
 * Resolves the values a delivery needs, all of them out of the register entry.
 *
 * There is no file layer any more (2026-09-13). The licence and the Requesty
 * pair both live in `customers/<slug>.json`; the gitignored sidecar that used to
 * hold them protected nothing a delivery does not hand the customer anyway, and
 * a second storage location is a second thing to keep in sync.
 *
 * The environment still wins for the Requesty pair: `REQUESTY_API_KEY` /
 * `REQUESTY_BASE_URL` are the one-off run against another gateway, which worked
 * before the register existed and keeps working. No `CONNECT_LICENSE_KEY_<SLUG>`
 * convention was invented to match — a per-customer environment variable would be
 * a second place a licence can live, which is the problem, not the fix.
 *
 * `options.requireLicenseKey` (default `true`) is what a caller sets to `false`
 * when the run does not SHIP the key: a shared-repo delivery writes no
 * `connectLicensePrefill` (plan-434 §2.7), so a missing value cannot break it.
 * The default keeps the management view — the doctor — reporting the licence as
 * owed, because it still is.
 */
export function resolveCustomerSecrets(privateRoot, customer, options = {}) {
  const env = options.env ?? process.env;
  const fromEnv = (name) => (typeof env[name] === 'string' && env[name].trim() ? env[name].trim() : undefined);
  const trimmed = (value) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  const secrets = {
    connectLicenseKey: trimmed(customer.licensing?.connect?.key),
    requestyApiKey: fromEnv('REQUESTY_API_KEY') ?? trimmed(customer.inference?.requestyApiKey),
    requestyBaseUrl: fromEnv('REQUESTY_BASE_URL') ?? trimmed(customer.inference?.requestyBaseUrl),
    path: customerRegistryPath(privateRoot, customer.customer),
  };
  if (customer.licensing?.connect && !secrets.connectLicenseKey && options.requireLicenseKey !== false) {
    throw new Error(`Customer "${customer.customer}" declares a CONNECT licence but carries no `
      + `"licensing.connect.key" in ${secrets.path}. Issue the key in the portal and write it there.`);
  }
  return secrets;
}

// ─── Hosted link (plan-759) ─────────────────────────────────────────────

//! True for the base64url form of exactly 32 bytes (the `#k=` fragment secret).
export function isHostedFragment(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

/**
 * The two halves of a hosted deploy's key, with the environment winning over
 * the register (the same rule `resolveCustomerSecrets` applies to Requesty).
 * `customer` may be null (a project no register entry claims): then only the
 * environment can arm encryption. `source` says where the password came from.
 *
 *   { password: string|null, fragment: string|null, source: 'env'|'register'|null }
 */
export function resolveHostedSecrets(customer, env = process.env) {
  const fromEnv = (name) => (typeof env?.[name] === 'string' && env[name].trim() ? env[name].trim() : null);
  const trimmed = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
  const envPassword = fromEnv('RV_DEPLOY_PASSWORD');
  const envFragment = fromEnv('RV_DEPLOY_FRAGMENT');
  const regPassword = trimmed(customer?.hosted?.password);
  const regFragment = trimmed(customer?.hosted?.fragment);
  const password = envPassword ?? regPassword;
  const fragment = envFragment ?? regFragment;
  if (fragment !== null && !isHostedFragment(fragment)) {
    throw new Error('The hosted fragment must be the base64url of 32 bytes (43 characters).');
  }
  return {
    password,
    fragment,
    source: password === null ? null : (envPassword !== null ? 'env' : 'register'),
  };
}

/**
 * Writes a freshly minted fragment into `customers/<slug>.json` (`hosted.fragment`)
 * so the next publish keeps the link the customer already has (D6). Refuses to
 * overwrite an existing fragment: rotating one is an explicit edit, never a
 * side effect of a publish.
 */
export function recordHostedFragment(privateRoot, slug, fragment) {
  if (!isHostedFragment(fragment)) throw new Error('recordHostedFragment: not a fragment.');
  const path = customerRegistryPath(privateRoot, slug);
  const customer = readJson(path, `customers/${slug}.json`);
  if (typeof customer.hosted?.fragment === 'string' && customer.hosted.fragment.trim()) {
    throw new Error(`customers/${slug}.json already carries hosted.fragment; rotate it by hand, not by publishing.`);
  }
  customer.hosted = { ...(isPlainObject(customer.hosted) ? customer.hosted : {}), fragment };
  writeFileSync(path, JSON.stringify(customer, null, 2) + '\n');
  return customer;
}

//! A register entry with `hosted.password` replaced for display (`/customers show`, doctor).
export function redactHostedSecrets(customer) {
  if (!isPlainObject(customer?.hosted) || customer.hosted.password === undefined) return customer;
  return { ...customer, hosted: { ...customer.hosted, password: '••••••••' } };
}

// ─── Partner publishing (plan-603) ──────────────────────────────────────

/**
 * The partner's publishing target, or `null` if the entry has none.
 *
 * "Publishing" here is the partner putting HIS OWN projects on OUR CDN, which is a
 * different thing from `hosted-link` (plan-759: we publish FOR a customer). The
 * difference that matters technically is the credential: a hosted-link customer never
 * sees a Bunny key, a publishing partner needs one — and because a Bunny storage-zone
 * password is scoped to a whole zone, he gets a zone of his own (D1).
 */
export function resolvePartnerPublishing(customer) {
  const publishing = customer?.publishing;
  if (!isPlainObject(publishing)) return null;
  return {
    target: publishing.target,
    storageZone: publishing.storageZone,
    storageZoneId: publishing.storageZoneId ?? null,
    pullZoneId: publishing.pullZoneId ?? null,
    hostname: publishing.hostname,
    region: publishing.region ?? 'DE',
    monthlyBandwidthGb: publishing.monthlyBandwidthGb ?? null,
    storageKey: typeof publishing.storageKey === 'string' && publishing.storageKey.trim()
      ? publishing.storageKey.trim()
      : null,
  };
}

/**
 * The `.env` lines the partner pastes into his clone — the handover artefact, so that
 * what we tell him is derived from the register instead of retyped into a mail.
 *
 * `BUNNY_STORAGE_KEY` is omitted when the register has no key yet (the zone has not been
 * provisioned): a half-filled block is better than a line that reads `=undefined`.
 * `RV_PUBLIC_BASE_URL` is what makes the deploy print HIS url instead of ours (D7).
 */
export function partnerDeployEnv(publishing) {
  if (!publishing) return [];
  const lines = [
    ['BUNNY_STORAGE_ZONE', publishing.storageZone],
    ['BUNNY_PRIVATE_PROJECTS_DIR', 'projects'],
    ['RV_PUBLIC_BASE_URL', `https://${publishing.hostname}`],
  ];
  if (publishing.storageKey) lines.splice(1, 0, ['BUNNY_STORAGE_KEY', publishing.storageKey]);
  return lines;
}

/**
 * Merges a provisioning result into `customers/<slug>.json` (`publishing`).
 *
 * Merge, not overwrite: `create` runs more than once (F2), and a second run that knows
 * the pull-zone id but not the password must not drop the password. The one thing it
 * refuses is a silent zone swap — pointing an existing entry at a DIFFERENT storage zone
 * would orphan everything the partner has published, so that is a hand edit.
 */
export function recordPartnerPublishing(privateRoot, slug, publishing) {
  if (!isPlainObject(publishing)) throw new Error('recordPartnerPublishing: publishing must be an object.');
  const path = customerRegistryPath(privateRoot, slug);
  const customer = readJson(path, `customers/${slug}.json`);
  const current = isPlainObject(customer.publishing) ? customer.publishing : {};
  if (typeof current.storageZone === 'string' && typeof publishing.storageZone === 'string'
      && current.storageZone !== publishing.storageZone) {
    throw new Error(`customers/${slug}.json points at storage zone "${current.storageZone}", not `
      + `"${publishing.storageZone}". Moving a partner to another zone orphans everything he has `
      + 'published; change it by hand if that is really what you mean.');
  }
  const merged = { target: 'partner-zone', ...current };
  for (const [key, value] of Object.entries(publishing)) {
    if (value !== undefined && value !== null) merged[key] = value;
  }
  customer.publishing = merged;
  writeFileSync(path, JSON.stringify(customer, null, 2) + '\n');
  return customer;
}

//! Both register credentials masked for display — what `/customers show` and the doctor print.
export function redactRegisterSecrets(customer) {
  const withoutHosted = redactHostedSecrets(customer);
  if (!isPlainObject(withoutHosted?.publishing) || withoutHosted.publishing.storageKey === undefined) {
    return withoutHosted;
  }
  return {
    ...withoutHosted,
    publishing: { ...withoutHosted.publishing, storageKey: '••••••••' },
  };
}
