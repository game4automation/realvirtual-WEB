// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * T8 — how `deliver.mjs` is addressed (plan-738 F5, §2.7).
 *
 * `deliver.mjs <slug>` is the target form: a delivery goes to a CUSTOMER
 * repository, and the positional now says which one. The two older forms — a
 * project key (`mauser3dhmi`) and `--customer <slug>` — still resolve, with a
 * deprecation warning rather than an error. That is deliberate: both are typed
 * from memory and both appear in `deliver-release`'s own child commands, so a
 * hard error would cost a release run to buy nothing.
 *
 * These cases resolve against the REAL customer register rather than a fixture.
 * The register is the thing being resolved against, and a fixture would only
 * prove that the fixture parses.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const SCRIPTS = resolve(__dirname, '../scripts');
const PRIVATE_ROOT = resolve(__dirname, '../../realvirtual-WebViewer-Private~');

// deliver.mjs has no .d.mts; a non-literal specifier keeps tsc out of it.
const load = () => import(new URL('../scripts/deliver.mjs', import.meta.url).href) as Promise<{
  resolveDelivery: (options: { token: string | null; customerFlag: string | null }) => {
    customer: string; primary: string | null; projects: string[]; kind: string;
  };
}>;

//! The register has to be there for any of this to mean anything.
const hasRegister = existsSync(join(PRIVATE_ROOT, 'customers', 'mauser.json'));

describe.skipIf(!hasRegister)('T8: deliver.mjs argument forms', () => {
  it('resolves the customer slug silently — this is the form we want typed', async () => {
    const { resolveDelivery } = await load();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const resolved = resolveDelivery({ token: 'mauser', customerFlag: null });
      expect(resolved.customer).toBe('mauser');
      expect(resolved.projects).toContain('mauser3dhmi');
      // No deprecation: the target form must be quiet, or the warning becomes noise.
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it('resolves a project key to its customer, with a deprecation warning', async () => {
    const { resolveDelivery } = await load();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const resolved = resolveDelivery({ token: 'mauser3dhmi', customerFlag: null });
      // The point of tolerating it: it lands on the same repository as the slug.
      expect(resolved.customer).toBe('mauser');
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0][0]);
      expect(message).toMatch(/DEPRECATED/);
      expect(message).toMatch(/is a project key/);
      // The warning has to name the replacement, or it is only a complaint.
      expect(message).toContain('node scripts/deliver.mjs mauser');
    } finally { warn.mockRestore(); }
  });

  it('resolves --customer to the same place, also with a warning (symmetry)', async () => {
    const { resolveDelivery } = await load();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const resolved = resolveDelivery({ token: null, customerFlag: 'mauser' });
      expect(resolved.customer).toBe('mauser');
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0][0]);
      expect(message).toMatch(/--customer is deprecated/);
      expect(message).toContain('node scripts/deliver.mjs mauser');
    } finally { warn.mockRestore(); }
  });

  it('refuses a name that is neither, and says what to pass instead', async () => {
    const { resolveDelivery } = await load();
    expect(() => resolveDelivery({ token: 'no-such-thing-anywhere', customerFlag: null }))
      .toThrow(/Pass the customer slug/);
  });
});

describe('T8: flags', () => {
  //! Runs the CLI far enough to see argument handling, never far enough to build.
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, [join(SCRIPTS, 'deliver.mjs'), ...args], { encoding: 'utf8', timeout: 30000 });

  it('documents --projects and --force, and the three exit codes', () => {
    const help = cli('--help');
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--projects <name…|all>');
    expect(help.stdout).toContain('--force');
    // Case-sensitivity is the one thing a reader must not have to discover by
    // destroying a folder, so the help text names the Toray case explicitly.
    expect(help.stdout).toMatch(/case-sensitive \(Toray, not toray\)/);
    expect(help.stdout).toContain('never a folder the customer created');
    for (const line of ['0  delivered', '1  --projects would replace', '2  the delivery failed']) {
      expect(help.stdout).toContain(line);
    }
  });

  it('rejects --seed-missing with a message that names the replacement', () => {
    // Removed rather than ignored: silently accepting it would let a caller
    // believe a folder was seeded when nothing was written at all.
    const removed = cli('mauser', '--seed-missing');
    expect(removed.status).toBe(2);
    expect(removed.stderr).toMatch(/--seed-missing was removed with plan-738/);
    expect(removed.stderr).toMatch(/--projects <name…\|all> instead/);
  });

  it('does not mistake a --projects value for the customer slug', () => {
    // `--projects` is variadic, so its values look exactly like the positional.
    // Reading `Toray` as a second slug is the regression this pins.
    const parsed = cli('mauser', '--projects', 'Toray', 'demo-realvirtual');
    expect(parsed.stderr).not.toMatch(/Only one <slug> is allowed/);
    const empty = cli('mauser', '--projects');
    expect(empty.status).toBe(2);
    expect(empty.stderr).toMatch(/--projects needs at least one name/);
  });
});
