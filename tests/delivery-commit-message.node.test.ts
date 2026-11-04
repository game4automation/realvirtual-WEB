// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-679 Phase 6 (D7) — the delivery commit carries the APPROVED release notes.
 *
 * Until 6.5.0 the body listed the raw `feat:`/`fix:` subjects since the last delivered core
 * commit — internal ones included — while the release notes Thomas approved never reached the
 * customer. Now it carries the released CHANGELOG sections since the customer's baseline version,
 * without the `**Internal**` blocks, and on the release path a missing section is an error.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  changelogPromotionProblem,
  parseChangelogSections,
  releaseNotesFromChangelog,
  versionOfBaselineTag,
} from '../scripts/_workspace-lib.mjs';

type Generator = {
  deliveryCommitNotes: (options: { coreRoot: string; baselineTag: string | null; version: string; previousCoreCommit?: string | null; requireReleaseNotes?: boolean }) => string;
  snapshotPush: (options: Record<string, unknown>) => { pushed: boolean; message: string };
};
const loadGenerator = () => import(pathToFileURL(resolve(__dirname, '../scripts/generate-customer-workspace.mjs')).href) as Promise<Generator>;

const CHANGELOG = [
  '# realvirtual WEB — Changelog',
  '',
  'User-facing release notes.',
  '',
  '## Unreleased',
  '',
  '## 6.5.0 — 2026-10-23',
  '',
  '**New**',
  '- Five-oh feature visible to customers.',
  '',
  '**Internal**',
  '- Five-oh internal refactor nobody outside should read.',
  '',
  '## 6.4.1 — 2026-10-13',
  '',
  '**Fixed**',
  '- Four-one fix for customers.',
  '',
  '**Internal**',
  '- Four-one internal test lock.',
  '',
  '## 6.4.0 — 2026-10-12',
  '',
  '**New**',
  '- Four-oh feature from the baseline release.',
  '',
].join('\n');

let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'rv-commit-notes-')); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

describe('release notes from the CHANGELOG', () => {
  it('delivery/6.4.0 -> 6.5.0: the bullets of 6.4.1 AND 6.5.0, nothing internal, nothing from 6.4.0', () => {
    const notes = releaseNotesFromChangelog(CHANGELOG, '6.4.0', '6.5.0');
    expect(notes).toContain('- Five-oh feature visible to customers.');
    expect(notes).toContain('- Four-one fix for customers.');
    expect(notes).toContain('## 6.5.0 — 2026-10-23');
    expect(notes).not.toContain('internal');
    expect(notes).not.toContain('**Internal**');
    expect(notes).not.toContain('Four-oh');
    // Newest first.
    expect(notes.indexOf('6.5.0')).toBeLessThan(notes.indexOf('6.4.1'));
  });

  it('the same version again (a corrected re-delivery) carries that section', () => {
    const notes = releaseNotesFromChangelog(CHANGELOG, '6.5.0', '6.5.0');
    expect(notes).toContain('- Five-oh feature visible to customers.');
    expect(notes).not.toContain('Four-one');
  });

  it('a first delivery (no baseline version) carries only the current section', () => {
    const notes = releaseNotesFromChangelog(CHANGELOG, null, '6.4.1');
    expect(notes).toContain('- Four-one fix for customers.');
    expect(notes).not.toContain('Five-oh');
    expect(notes).not.toContain('Four-oh');
  });

  it('no section for the version -> empty', () => {
    expect(releaseNotesFromChangelog(CHANGELOG, '6.5.0', '6.6.0')).toBe('');
    expect(versionOfBaselineTag('delivery/6.4.0')).toBe('6.4.0');
    expect(versionOfBaselineTag('realvirtual-v6.4.0')).toBeNull();
  });

  it('parse keeps every byte', () => {
    const { preamble, sections } = parseChangelogSections(CHANGELOG);
    expect(preamble + sections.map((s: { heading: string; body: string }) => s.heading + s.body).join('')).toBe(CHANGELOG);
  });
});

describe('deliveryCommitNotes — release path vs single delivery', () => {
  function core(changelog: string | null): string {
    const root = join(work, 'core');
    mkdirSync(root, { recursive: true });
    if (changelog !== null) writeFileSync(join(root, 'CHANGELOG.md'), changelog);
    return root;
  }

  it('with a receipt and a matching section: the release notes', async () => {
    const { deliveryCommitNotes } = await loadGenerator();
    const body = deliveryCommitNotes({ coreRoot: core(CHANGELOG), baselineTag: 'delivery/6.4.0', version: '6.5.0', requireReleaseNotes: true });
    expect(body.startsWith('Release notes:')).toBe(true);
    expect(body).toContain('- Four-one fix for customers.');
  });

  it('with a receipt and NO section: an error, never the commit subjects', async () => {
    const { deliveryCommitNotes } = await loadGenerator();
    expect(() => deliveryCommitNotes({ coreRoot: core(CHANGELOG), baselineTag: 'delivery/6.5.0', version: '6.6.0', requireReleaseNotes: true }))
      .toThrow(/no released section for 6\.6\.0/);
  });

  it('without a receipt and no section: falls back to the subject summary (empty without a range)', async () => {
    const { deliveryCommitNotes } = await loadGenerator();
    expect(deliveryCommitNotes({ coreRoot: core(null), baselineTag: null, version: '6.6.0' })).toBe('');
  });
});

describe('the delivery commit itself (D7)', () => {
  it('carries the approved notes in its body on the remote', async () => {
    const { snapshotPush } = await loadGenerator();
    const coreRoot = join(work, 'core');
    write(join(coreRoot, 'CHANGELOG.md'), CHANGELOG);
    const staged = join(work, 'staged');
    write(join(staged, 'realvirtual-web', 'src', 'main.ts'), 'export {};');
    write(join(staged, 'delivery-manifest.json'), JSON.stringify({ coreCommit: null }));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: staged });
    execFileSync('git', ['add', '-A'], { cwd: staged });
    const bare = join(work, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    const identity = {
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    };
    const previous = Object.fromEntries(Object.keys(identity).map((key) => [key, process.env[key]]));
    Object.assign(process.env, identity);
    try {
      // The baseline delivery 6.4.0 leaves `delivery/6.4.0` behind.
      snapshotPush({ workspaceRoot: staged, remote: pathToFileURL(bare).href, version: '6.4.0', push: true, coreRoot });
      write(join(staged, 'realvirtual-web', 'src', 'main.ts'), 'export const next = true;');
      execFileSync('git', ['add', '-A'], { cwd: staged });
      const second = snapshotPush({ workspaceRoot: staged, remote: pathToFileURL(bare).href, version: '6.5.0', push: true, coreRoot, requireReleaseNotes: true });
      expect(second.pushed).toBe(true);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    const body = execFileSync('git', ['-C', bare, 'log', '-1', '--format=%B', 'main'], { encoding: 'utf8' });
    expect(body).toContain('viewer 6.5.0');
    expect(body).toContain('- Five-oh feature visible to customers.');
    expect(body).toContain('- Four-one fix for customers.');
    expect(body).not.toContain('internal');
    expect(body).not.toContain('Four-oh');
  }, 180000);
});

describe('changelogPromotionProblem — the approved text, and nothing else (Gate R2 finding 1)', () => {
  const before = [
    '# Changelog', '', '## Unreleased', '', '**New**', '- Draft bullet.', '', '## 6.4.0 — 2026-10-12', '', '**New**', '- Old.', '',
  ].join('\n');
  const promoted = (section: string, older = '## 6.4.0 — 2026-10-12\n\n**New**\n- Old.\n') =>
    `# Changelog\n\n## Unreleased\n\n## 6.5.0 — 2026-10-24\n\n${section}\n\n${older}`;

  it('approved new, reworded and dropped bullets are fine', () => {
    const approved = '**New**\n- Reworded bullet.\n- An extra approved bullet.';
    expect(changelogPromotionProblem(before, promoted(approved), '6.5.0', approved)).toBeNull();
  });

  it('an unapproved bullet, a changed older section or a non-empty Unreleased is refused', () => {
    const approved = '**New**\n- Reworded bullet.';
    expect(changelogPromotionProblem(before, promoted(`${approved}\n- Sneaked in.`), '6.5.0', approved)).toMatch(/differs from the approved/);
    expect(changelogPromotionProblem(before, promoted(approved, '## 6.4.0 — 2026-10-12\n\n**New**\n- Old, edited.\n'), '6.5.0', approved)).toMatch(/older section/);
    expect(changelogPromotionProblem(before, `# Changelog\n\n## Unreleased\n\n- left\n\n## 6.5.0 — 2026-10-24\n\n${approved}\n\n## 6.4.0 — 2026-10-12\n\n**New**\n- Old.\n`, '6.5.0', approved)).toMatch(/not empty/);
    expect(changelogPromotionProblem(before, promoted(approved), '6.5.1', approved)).toMatch(/is not "## 6\.5\.1/);
  });
});
