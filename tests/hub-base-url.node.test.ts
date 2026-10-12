// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The hub is named ONCE, and the legacy secret files are gone (plan-739 F6/F7).
 *
 * Before this, `hubBaseUrl()` resolved in three steps: the `RV_FORGEJO_HUB_URL`
 * override, then the origin scavenged out of the legacy `delivery/<name>.json` of
 * that very customer, then an error. Two of the five register customers had such a
 * file (mauser, wmyb) and resolved; hs-heilbronn, iotsolution and toray had none
 * and threw `no hub base URL` unless the operator remembered the variable. So the
 * direct delivery path worked for 40% of the register, and the release path only
 * worked because `planReleaseTargets()` sets the variable for the duration of its
 * own call. That is the defect these tests pin down.
 *
 * The two legacy files were also the last TRACKED carriers of the plaintext CONNECT
 * licence key and the Requesty credentials; the register keeps those in the
 * gitignored `customers/<slug>.secrets.json`. T17 is the guard that they stay gone —
 * and that they are gone by DELETION, not by someone emptying the files, which a
 * content-only scan would happily call clean.
 *
 * Needs the private sibling repository; skips entirely in a community checkout.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_HUB_URL,
  customerRemoteUrl,
  listCustomerSlugs,
  listCustomers,
} from '../scripts/_rv-customers.mjs';
import { loadDeliveryConfigByCustomer, undeliverableReason } from '../scripts/_workspace-lib.mjs';

const PRIVATE_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../realvirtual-WebViewer-Private~',
);
const HAS_PRIVATE = existsSync(join(PRIVATE_ROOT, 'tier-manifest.json'));
const DELIVER_RELEASE = join(PRIVATE_ROOT, 'scripts', 'deliver-release.mjs');

/**
 * The five register customers and the remote each must resolve to, FROZEN.
 *
 * This is the scripted before/after proof of the change, kept as a test instead of
 * as a paragraph. The values were captured from `loadDeliveryConfigByCustomer()`
 * WITH `RV_FORGEJO_HUB_URL=https://git.realvirtual.io` before the change, and must
 * come back byte-identical WITHOUT the variable after it — that equality is the
 * whole claim: the constant replaces the env var and the legacy scavenging, and
 * changes no destination.
 */
const FROZEN_REMOTES: Record<string, string> = {
  'hs-heilbronn': `${DEFAULT_HUB_URL}/rv-commercial/realvirtual-commercial.git`,
  iotsolution: `${DEFAULT_HUB_URL}/rv-commercial/realvirtual-commercial.git`,
  mauser: `${DEFAULT_HUB_URL}/rv-mauser/rv-project-mauser.git`,
  toray: `${DEFAULT_HUB_URL}/rv-toray/rv-project-toray.git`,
  wmyb: `${DEFAULT_HUB_URL}/rv-wmyb/rv-project-wmyb.git`,
};

//! The three field names that must never appear in a tracked file again.
const SECRET_FIELDS = ['connectLicenseKey', 'requestyApiKey', 'requestyBaseUrl'];

//! The two files phase 3 deleted. Named literally so "it must not exist" is testable.
const DELETED_LEGACY_PATHS = ['delivery/mauser3dhmi.json', 'delivery/wmyb.json'];

const HUB_ENV_BEFORE = process.env.RV_FORGEJO_HUB_URL;

//! Every test here asserts the UNSET behaviour, so the variable is cleared per test
//! rather than trusted to be absent — vitest shares one process across files, and
//! `rv-customers-registry.node.test.ts` legitimately sets it around its own calls.
beforeEach(() => {
  delete process.env.RV_FORGEJO_HUB_URL;
});

afterAll(() => {
  if (HUB_ENV_BEFORE === undefined) delete process.env.RV_FORGEJO_HUB_URL;
  else process.env.RV_FORGEJO_HUB_URL = HUB_ENV_BEFORE;
});

/**
 * The resolved remote of one customer.
 *
 * `DeliveryProfile.remote` is declared optional because the type also describes a
 * half-built config; `assertDeliveryFields()` refuses to return one without it. The
 * narrowing is therefore a real assertion, not a cast: "resolved but has no remote"
 * is exactly the state these tests exist to rule out.
 */
function remoteOf(slug: string): string {
  const remote = loadDeliveryConfigByCustomer(PRIVATE_ROOT, slug).remote;
  if (typeof remote !== 'string' || remote.length === 0) {
    throw new Error(`Customer "${slug}" resolved without a remote.`);
  }
  return remote;
}

//! Repo-relative paths of every tracked file in the private repository.
function trackedPrivateFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: PRIVATE_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean)
    .map(path => path.replace(/\\/g, '/'));
}

describe.skipIf(!HAS_PRIVATE)('hub base URL — one constant (F6)', () => {
  it('T15 resolves a remote on the right host for every register customer, with no env var and no delivery/*.json', () => {
    expect(process.env.RV_FORGEJO_HUB_URL).toBeUndefined();
    // The precondition is part of the assertion: if a delivery/*.json came back,
    // this test would pass for the OLD reason and prove nothing.
    expect(existsSync(join(PRIVATE_ROOT, 'delivery'))).toBe(false);

    // Only customers with a git delivery have a hub remote; a hosted-link customer (plan-759,
    // e.g. gernbauer) is skipped exactly like T15b does.
    const deliverable = new Set(listCustomers(PRIVATE_ROOT).filter(c => !undeliverableReason(c)).map(c => c.customer));
    const slugs = listCustomerSlugs(PRIVATE_ROOT).filter(s => deliverable.has(s));
    expect(slugs.length).toBeGreaterThan(0);

    const resolved: Record<string, string> = {};
    for (const slug of slugs) {
      const remote = remoteOf(slug);
      // The host, not merely "did not throw".
      expect(new URL(remote).origin).toBe(DEFAULT_HUB_URL);
      resolved[slug] = remote;
    }

    // And the full destinations, frozen, for the five customers that existed when
    // the change was made. A sixth customer only has to satisfy the host check
    // above; these five must land exactly where they landed before.
    for (const [slug, remote] of Object.entries(FROZEN_REMOTES)) {
      expect(resolved[slug], `remote of ${slug}`).toBe(remote);
    }
  });

  it('T15b resolves the same remote the register itself would build', () => {
    for (const customer of listCustomers(PRIVATE_ROOT)) {
      if (undeliverableReason(customer)) continue;
      const remote = remoteOf(customer.customer);
      expect(remote).toBe(customerRemoteUrl(customer, DEFAULT_HUB_URL));
      // The default parameter answers identically — a caller that omits the hub
      // must not silently get a different destination.
      expect(remote).toBe(customerRemoteUrl(customer));
    }
  });

  it('T15c still honours RV_FORGEJO_HUB_URL, so a rehearsal can point elsewhere', () => {
    process.env.RV_FORGEJO_HUB_URL = 'https://hub.example.test';
    try {
      expect(new URL(remoteOf('mauser')).origin).toBe('https://hub.example.test');
    } finally {
      delete process.env.RV_FORGEJO_HUB_URL;
    }
  });

  it('T16 makes deliver-release.mjs read the shared constant, not one of its own', async () => {
    const source = readFileSync(DELIVER_RELEASE, 'utf8');
    // Structural half: no second declaration may reappear next to the import.
    expect(source).not.toMatch(/^\s*(?:const|let|var)\s+DEFAULT_HUB_URL\s*=/m);
    expect(source).toMatch(/DEFAULT_HUB_URL[\s\S]{0,400}from '\.\.\/\.\.\/realvirtual-WebViewer~\/scripts\/_rv-customers\.mjs'/);

    // Behavioural half: with nothing set, the release planner and the single
    // delivery agree on every destination, character for character.
    const { planReleaseTargets } = await import(/* @vite-ignore */ DELIVER_RELEASE);
    const plan = planReleaseTargets(PRIVATE_ROOT);
    expect(plan.targets.length).toBeGreaterThan(0);
    for (const target of plan.targets as Array<{ remote: string; driver: string }>) {
      expect(new URL(target.remote).origin).toBe(DEFAULT_HUB_URL);
      expect(target.remote).toBe(remoteOf(target.driver));
    }
  });
});

describe.skipIf(!HAS_PRIVATE)('legacy secret files — deleted, not emptied (F7)', () => {
  it('T17 keeps the secret field names out of every tracked file but the register entries', () => {
    // ONE `git grep` over the whole index, the way `assert-public-safe.mjs` scans:
    // the private repository carries hundreds of megabytes of tracked geometry, and
    // opening every file from Node turns a guard into a minute of waiting.
    // `-I` drops binaries; the pattern demands a field name AND a quoted value, so a
    // script that merely mentions `connectLicenseKey` — the register loader, the
    // delivery writer — is not a hit.
    const pattern = `["'](${SECRET_FIELDS.join('|')})["'][[:space:]]*:[[:space:]]*["']`;
    let hits: string[] = [];
    try {
      hits = execFileSync('git', ['grep', '-l', '-I', '-E', pattern, '--', '.'], {
        cwd: PRIVATE_ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).split('\n').filter(Boolean).map(path => path.replace(/\\/g, '/'));
    } catch {
      hits = []; // exit code 1 = no match, which is the wanted state
    }
    // The register entries are the ONE legitimate home since 2026-09-13:
    // `inference.requestyApiKey` / `requestyBaseUrl` live there, and
    // rv-customers-registry.node.test.ts checks that nothing ELSE in those
    // files is credential-shaped. A hit anywhere else is still the finding —
    // including on a `customers/<slug>.secrets.json`, which would mean the
    // retired sidecar mechanism came back AND escaped the .gitignore.
    const isRegisterEntry = (path: string) => path.startsWith('customers/')
      && path.endsWith('.json') && !path.endsWith('.secrets.json');
    const offenders = hits.filter(path => !isRegisterEntry(path));
    expect(offenders).toEqual([]);
  }, 60_000); // one git grep over the whole private index takes ~6 s

  it('T17b asserts the two legacy paths do not exist — emptying them is not enough', () => {
    for (const path of DELETED_LEGACY_PATHS) {
      expect(existsSync(join(PRIVATE_ROOT, path)), `${path} must be deleted, not emptied`).toBe(false);
    }
    const tracked = new Set(trackedPrivateFiles());
    for (const path of DELETED_LEGACY_PATHS) {
      expect(tracked.has(path), `${path} must not be tracked`).toBe(false);
    }
  });
});
