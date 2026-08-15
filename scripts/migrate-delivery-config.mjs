// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * migrate-delivery-config.mjs — `delivery/<key>.json` → `customers/<slug>.json`
 * plus `customers/<slug>.secrets.json` (plan-434 Phase 1).
 *
 * ## What it does not do
 *
 * It does not guess. `mauser3dhmi.json` is a *project* file name; whether the
 * customer behind it is called `mauser` is knowledge this script does not have,
 * so the slug defaults to the file name and is overridden per file with
 * `--slug`. And it verifies that decision against the remote URL already in the
 * config: if the URL does not read `…/rv-<slug>/rv-project-<slug>.git`, it
 * aborts with the mismatch instead of writing an entry whose forgejo block
 * points somewhere else than the repository the customer actually pulls from.
 *
 * ## Secret values
 *
 * `connectLicenseKey`, `requestyApiKey` and `requestyBaseUrl` move to the
 * gitignored secrets file; the register entry keeps only `secretsRef` and a
 * `licensing.connect.keyRef` pointing at the field name. The values are not
 * printed, not in `--dry-run` either.
 *
 * ## Usage
 *
 *   node scripts/migrate-delivery-config.mjs                       # dry run, all configs
 *   node scripts/migrate-delivery-config.mjs --apply
 *   node scripts/migrate-delivery-config.mjs mauser3dhmi --slug mauser \
 *        --display-name "MAUSER Maschinentechnik GmbH" \
 *        --billomat "MAUSER Maschinentechnik GmbH" --apply
 *
 * `--slug` also takes the `<config>=<slug>` form so several configs can be
 * remapped in one run. Idempotent: a second `--apply` writes nothing.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readJson } from './_rv-fs-utils.mjs';
import {
  CUSTOMER_SCHEMA_VERSION,
  customerRegistryPath,
  diagnosisPresetPath,
} from './_rv-customers.mjs';

const DEFAULT_PRIVATE_ROOT = fileURLToPath(new URL('../../realvirtual-WebViewer-Private~/', import.meta.url));

//! The .gitignore that makes the secrets file — and any future customer certificate — untrackable.
export const CUSTOMERS_GITIGNORE = [
  '# Secret VALUES never enter git (plan-434 §2.3). The encrypted counterparts live in the',
  '# private knowledge-base secrets store (secrets/delivery/<slug>.secrets.json, SOPS-encrypted).',
  '*.secrets.json',
  '# Reserved: signing is not modelled yet, but a customer certificate must never',
  '# reach a commit by accident either.',
  '*.cert.json',
  '',
].join('\n');

/**
 * Parses a git remote into `{ base, org, repo }`.
 *
 * Returns `null` for anything that is not an http(s) URL with two path
 * segments — an ssh remote or a local path is a case this migration has never
 * seen and must not silently reinterpret.
 */
export function parseForgejoRemote(remote) {
  if (typeof remote !== 'string' || !/^https?:\/\//i.test(remote)) return null;
  let url;
  try {
    url = new URL(remote);
  } catch {
    return null;
  }
  const segments = url.pathname.replace(/^\/+/, '').replace(/\.git$/i, '').split('/').filter(Boolean);
  if (segments.length !== 2) return null;
  return { base: url.origin, org: segments[0], repo: segments[1] };
}

//! `managed` only when every project of this customer already has a CONNECT diagnosis preset.
function supportLevel(privateRoot, projects, presetsRoot) {
  if (projects.length === 0) return 'basic';
  return projects.every((key) => existsSync(diagnosisPresetPath(privateRoot, key, presetsRoot)))
    ? 'managed'
    : 'basic';
}

/**
 * Builds the register entry and the secrets payload for one legacy config.
 * Pure — no filesystem writes, so the CLI can show a dry run of the same object.
 */
export function customerFromDeliveryConfig(config, options) {
  const { slug, projects, support, displayName, billomatCustomer } = options;
  const remote = parseForgejoRemote(config.remote);
  if (!remote) {
    throw new Error(`Cannot parse the remote ${JSON.stringify(config.remote)} as <base>/<org>/<repo>.git — `
      + 'migrate this config by hand.');
  }
  if (remote.org !== `rv-${slug}` || remote.repo !== `rv-project-${slug}`) {
    throw new Error(`The remote ${remote.base}/${remote.org}/${remote.repo}.git does not match slug "${slug}" `
      + `(expected rv-${slug}/rv-project-${slug}). Pass --slug <name> with the slug this repository belongs to.`);
  }

  const entry = {
    schemaVersion: CUSTOMER_SCHEMA_VERSION,
    customer: slug,
    displayName: displayName ?? config.project,
    // Every legacy config carries projects and a write-access repository, so it
    // is a development customer by construction. Standard customers are created
    // by hand (or by Phase 4), never migrated.
    kind: 'development',
    support,
    status: 'active',
    forgejo: { org: remote.org, repo: remote.repo, team: 'members', permission: 'write' },
    // Deliberately empty: inventing an address would put a wrong password-reset
    // channel into the record. The Forgejo comparison (Phase 3) fills it.
    contacts: [],
    licensing: {},
    delivery: {
      channel: 'git-workspace',
      tier: config.tier,
      restrictedFeatures: [...(config.restrictedFeatures ?? [])],
      projects: [...projects],
      connectChannel: config.connectChannel,
      mirror: config.mirror ?? null,
    },
  };
  if (billomatCustomer) entry.billing = { billomatCustomer };

  const secrets = {};
  if (config.connectLicenseKey) {
    secrets.connectLicenseKey = config.connectLicenseKey;
    entry.licensing.connect = { issuer: 'portal', keyRef: 'connectLicenseKey' };
  }
  if (config.requestyApiKey) secrets.requestyApiKey = config.requestyApiKey;
  if (config.requestyBaseUrl) secrets.requestyBaseUrl = config.requestyBaseUrl;
  if (Object.keys(secrets).length > 0) entry.secretsRef = `customers/${slug}.secrets.json`;

  return { entry, secrets };
}

const serialise = (value) => JSON.stringify(value, null, 2) + '\n';

//! Writes only when the content differs, so a re-run reports `unchanged`.
function writeIfChanged(path, content, apply) {
  const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (current === content) return 'unchanged';
  if (apply) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  return current === null ? 'created' : 'updated';
}

/**
 * Migrates one `delivery/<configName>.json`.
 *
 * `options.apply` writes; the default is a dry run. Returns what would change,
 * never the secret values themselves.
 */
export function migrateDeliveryConfig(privateRoot, configName, options = {}) {
  const source = join(privateRoot, 'delivery', `${configName}.json`);
  if (!existsSync(source)) throw new Error(`Delivery config not found: ${source}`);
  const config = readJson(source, `delivery/${configName}.json`);
  const slug = options.slug ?? config.customer ?? configName;
  const projects = Array.isArray(config.projects) && config.projects.length > 0
    ? [...config.projects]
    : [configName];
  const support = options.support ?? supportLevel(privateRoot, projects, options.presetsRoot);
  const { entry, secrets } = customerFromDeliveryConfig(config, {
    slug,
    projects,
    support,
    displayName: options.displayName,
    billomatCustomer: options.billomatCustomer,
  });

  const registryPath = customerRegistryPath(privateRoot, slug);
  const secretsPath = join(privateRoot, 'customers', `${slug}.secrets.json`);
  const apply = options.apply === true;
  const actions = [];
  // The ignore rule goes down FIRST: the secrets file must never exist for even
  // one moment in a folder that does not already exclude it.
  actions.push({
    file: 'customers/.gitignore',
    status: writeIfChanged(join(privateRoot, 'customers', '.gitignore'), CUSTOMERS_GITIGNORE, apply),
  });
  actions.push({
    file: `customers/${slug}.json`,
    status: writeIfChanged(registryPath, serialise(entry), apply),
  });
  if (Object.keys(secrets).length > 0) {
    actions.push({
      file: `customers/${slug}.secrets.json`,
      status: writeIfChanged(secretsPath, serialise(secrets), apply),
      secretFields: Object.keys(secrets).sort(),
    });
  }
  return { configName, slug, support, entry, actions };
}

//! Every `delivery/*.json`, sorted. Missing folder yields [].
export function listLegacyConfigNames(privateRoot) {
  const root = join(privateRoot, 'delivery');
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)).sort();
}

// ─── CLI ─────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = { apply: false, slugs: new Map(), configs: [] };
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${token} needs a value.`);
      return value;
    };
    if (token === '--apply') options.apply = true;
    else if (token === '--dry-run') options.apply = false;
    else if (token === '--private-root') options.privateRoot = next();
    else if (token === '--display-name') options.displayName = next();
    else if (token === '--billomat') options.billomatCustomer = next();
    else if (token === '--support') options.support = next();
    else if (token === '--slug') {
      const value = next();
      if (value.includes('=')) {
        const [config, slug] = value.split('=');
        options.slugs.set(config, slug);
      } else {
        options.slugs.set('*', value);
      }
    } else if (token.startsWith('--')) throw new Error(`Unknown option ${token}.`);
    else options.configs.push(token);
  }
  return options;
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  const privateRoot = resolve(options.privateRoot ?? DEFAULT_PRIVATE_ROOT);
  const configs = options.configs.length > 0
    ? options.configs.map((token) => basename(token).replace(/\.json$/i, ''))
    : listLegacyConfigNames(privateRoot);
  if (options.slugs.has('*') && configs.length !== 1) {
    console.error('--slug <name> without "<config>=" applies to a single config; '
      + 'name the config, or use --slug <config>=<slug>.');
    return 2;
  }
  if ((options.displayName || options.billomatCustomer) && configs.length !== 1) {
    console.error('--display-name and --billomat apply to a single config; name it explicitly.');
    return 2;
  }

  let failed = 0;
  for (const configName of configs) {
    try {
      const result = migrateDeliveryConfig(privateRoot, configName, {
        apply: options.apply,
        slug: options.slugs.get(configName) ?? options.slugs.get('*'),
        displayName: options.displayName,
        billomatCustomer: options.billomatCustomer,
        support: options.support,
      });
      console.log(`${configName} -> ${result.slug} (support: ${result.support})`);
      for (const action of result.actions) {
        const fields = action.secretFields ? ` [${action.secretFields.join(', ')}]` : '';
        console.log(`  ${action.status.padEnd(9)} ${action.file}${fields}`);
      }
    } catch (error) {
      console.error(`${configName}: ${error.message}`);
      failed++;
    }
  }
  if (!options.apply) console.log('\nDry run — nothing was written. Re-run with --apply.');
  return failed > 0 ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
