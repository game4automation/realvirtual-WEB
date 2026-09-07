// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * previewProjectReplace / confirmProjectReplace — the gate in front of the only
 * destructive thing a delivery can do (plan-738 §2.5, F4).
 *
 * Two claims, and the first one is the whole safety function:
 *
 *   1. the preview runs **before** `applySnapshot` deletes anything. Run after,
 *      the same `diffTrees` call would compare the new content against itself,
 *      report nothing, and look exactly like a clean delivery — a silent failure
 *      of the feature rather than a visible one;
 *   2. the exit codes are a machine-readable contract (0/1/2), so an unattended
 *      caller can tell "nobody confirmed it" apart from "the build broke".
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ProjectReplaceAbort,
  applySnapshot,
  confirmProjectReplace,
  previewProjectReplace,
} from '../scripts/_workspace-lib.mjs';

const SCRIPTS = resolve(__dirname, '../scripts');
const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENTITY } });
}

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'rv-replace-preview-'));
  temporary.push(root);
  return root;
}

//! Staging tree + a clone that already received one delivery, so the next one is
//! not a first delivery and `--projects` is actually reachable.
function fixture() {
  const root = sandbox();
  const staged = join(root, 'staged');
  write(join(staged, 'delivery-manifest.json'),
    JSON.stringify({ manifestVersion: 3, baselineTag: 'delivery/2.0.0', projects: {} }, null, 2));
  write(join(staged, 'realvirtual-web/main.ts'), 'export const v = 2;\n');
  write(join(staged, 'projects/acme/project.json'), '{"canonicalName":"acme"}\n');
  write(join(staged, 'projects/acme/models/machine.glb'), 'model-v2');

  const clone = join(root, 'clone');
  mkdirSync(clone, { recursive: true });
  git(clone, 'init', '-b', 'main');
  write(join(clone, 'realvirtual-web/main.ts'), 'export const v = 1;\n');
  write(join(clone, 'projects/acme/project.json'), '{"canonicalName":"acme"}\n');
  write(join(clone, 'projects/acme/models/machine.glb'), 'model-v1-EDITED-BY-CUSTOMER');
  write(join(clone, 'projects/acme/notes.md'), '# my notes\n');
  git(clone, 'add', '-A');
  git(clone, 'commit', '-m', 'delivery 1 + customer work');
  git(clone, 'tag', 'delivery/1.0.0');
  return { root, staged, clone };
}

describe('previewProjectReplace', { timeout: 60000 }, () => {
  // ── T5 ────────────────────────────────────────────────────────────────
  it('T5: lists what the replace would destroy, from the state BEFORE the replace', () => {
    const { staged, clone } = fixture();
    const lines: string[] = [];
    const preview = previewProjectReplace(staged, clone, ['acme'], { log: (l: string) => lines.push(l) });

    // `notes.md` exists only in the clone and the replace would delete it;
    // `machine.glb` differs and would be overwritten.
    expect(preview.total).toBe(2);
    const text = lines.join('\n');
    expect(text).toContain('notes.md');
    expect(text).toContain('machine.glb');
    // `project.json` is identical on both sides, so it is not in the list that
    // precedes a confirmation — a `+`/unchanged entry would only dilute it.
    expect(text).not.toContain('project.json');

    // The ordering proof: after the replace those files are gone from the clone,
    // so the very same call now reports nothing. A preview placed after
    // applySnapshot would always be this second, empty answer.
    applySnapshot(staged, clone, { version: '2.0.0', replaceProjects: ['acme'], log: () => {} });
    expect(existsSync(join(clone, 'projects/acme/notes.md'))).toBe(false);
    expect(previewProjectReplace(staged, clone, ['acme'], { log: () => {} }).total).toBe(0);
  });

  // ── T5b ───────────────────────────────────────────────────────────────
  it('T5b: an identical folder produces no prompt and no abort', () => {
    const { staged, clone } = fixture();
    // Make the customer's folder match the delivery exactly.
    write(join(clone, 'projects/acme/models/machine.glb'), 'model-v2');
    rmSync(join(clone, 'projects/acme/notes.md'));
    git(clone, 'add', '-A');
    git(clone, 'commit', '-m', 'in sync');

    const lines: string[] = [];
    const preview = previewProjectReplace(staged, clone, ['acme'], { log: (l: string) => lines.push(l) });
    expect(preview.total).toBe(0);
    expect(lines.join('\n')).toMatch(/identisch mit dem Lieferstand/);

    // No deviation means no question is asked at all — the common case must not
    // train anybody to type "yes" without reading.
    const ask = () => { throw new Error('must not prompt'); };
    expect(confirmProjectReplace(preview, { force: false, interactive: true, ask, log: () => {} }))
      .toEqual({ confirmed: true, reason: 'no-deviation' });
  });

  it('aborts with exitCode 1 unless confirmed or forced', () => {
    const { staged, clone } = fixture();
    const preview = previewProjectReplace(staged, clone, ['acme'], { log: () => {} });

    // Non-interactive (a CI runner, a pipe): abort rather than block for ever.
    let caught: any;
    try {
      confirmProjectReplace(preview, { force: false, interactive: false, log: () => {} });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ProjectReplaceAbort);
    expect(caught.exitCode).toBe(1);
    expect(caught.message).toMatch(/--force/);

    expect(confirmProjectReplace(preview, { force: true, log: () => {} }))
      .toMatchObject({ confirmed: true, reason: 'force' });
    expect(confirmProjectReplace(preview, {
      force: false, interactive: true, ask: () => 'yes', log: () => {},
    })).toMatchObject({ confirmed: true, reason: 'interactive' });
    // Anything that is not an explicit yes is a no.
    expect(() => confirmProjectReplace(preview, {
      force: false, interactive: true, ask: () => 'y', log: () => {},
    })).toThrow(ProjectReplaceAbort);
  });
});

// ── T-EX ────────────────────────────────────────────────────────────────
//
// The exit codes at the real process boundary. 0 and 2 are driven through the
// real scripts; the 1 path cannot be reached from a bare CLI invocation without
// a full staging and build, so it is pinned in two halves that together are the
// contract: the abort really carries 1 (asserted above and below), and both CLI
// entry points really map a carried exitCode onto the process status.
describe('exit codes at the process boundary', { timeout: 60000 }, () => {
  it('T-EX: --help succeeds (0) and a real failure is 2, not 1', () => {
    const help = spawnSync(process.execPath, [join(SCRIPTS, 'deliver.mjs'), '--help'], { encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--projects');

    // A removed flag is a failure of the run, not a declined confirmation.
    const removed = spawnSync(process.execPath, [join(SCRIPTS, 'deliver.mjs'), 'mauser', '--seed-missing'],
      { encoding: 'utf8' });
    expect(removed.status).toBe(2);
    expect(removed.stderr).toMatch(/--seed-missing was removed/);

    const generator = spawnSync(process.execPath,
      [join(SCRIPTS, 'generate-customer-workspace.mjs'), '--seed-missing'], { encoding: 'utf8' });
    expect(generator.status).toBe(2);

    // An unknown customer is also 2 — the delivery never got as far as a preview.
    const unknown = spawnSync(process.execPath,
      [join(SCRIPTS, 'deliver.mjs'), 'no-such-customer-at-all'], { encoding: 'utf8' });
    expect(unknown.status).toBe(2);
  });

  it('T-EX: a declined --projects replace exits 1 through the real handler expression', () => {
    // Read the mapping out of the real script rather than restating it, so that
    // changing it there breaks this test instead of quietly decoupling from it.
    const source = readFileSync(join(SCRIPTS, 'generate-customer-workspace.mjs'), 'utf8');
    const handler = /process\.exitCode = Number\.isInteger\(error\?\.exitCode\) \? error\.exitCode : 2;/.exec(source);
    expect(handler, 'the generator must map a carried exitCode onto the process status').not.toBeNull();

    const { root, staged, clone } = fixture();
    const script = join(root, 'decline.mjs');
    writeFileSync(script, [
      `import { previewProjectReplace, confirmProjectReplace } from ${JSON.stringify(
        resolve(SCRIPTS, '_workspace-lib.mjs').split('\\').join('/'))};`,
      'try {',
      `  const preview = previewProjectReplace(${JSON.stringify(staged)}, ${JSON.stringify(clone)}, ['acme'], { log: () => {} });`,
      '  confirmProjectReplace(preview, { force: false, interactive: false, log: () => {} });',
      '} catch (error) {',
      `  ${handler![0]}`,
      '}',
    ].join('\n'));

    const declined = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    expect(declined.status).toBe(1);
  });

  it('T-EX: deliver.mjs forwards the generator status instead of flattening it to 1', () => {
    // The wrapper must not turn the generator's 1 into its own 1 by accident and
    // its 2 into a 1 either: `--projects` runs through two processes, and only
    // the inner one can decide that a human declined.
    const source = readFileSync(join(SCRIPTS, 'deliver.mjs'), 'utf8');
    expect(source).toMatch(/process\.exitCode = typeof error\.status === 'number' \? error\.status : 1;/);
    // ...while everything that fails inside the wrapper itself is a real failure.
    expect(source).toMatch(/console\.error\(`\[deliver\] \$\{error\.message\}`\);\r?\n(?:.*\r?\n)*?\s*process\.exitCode = 2;/);
  });
});
