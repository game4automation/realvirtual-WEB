// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * What survived the vendor-merge teardown (plan-738 §2.8).
 *
 * `_vendor-merge.mjs` was not a monolith: six symbols in it had nothing to do
 * with the three-way merge and everything to do with the delivery BASELINE — the
 * tag a delivery leaves behind, which the tier gate still reads its private
 * source inventory out of. They moved to `_workspace-lib.mjs`, and their
 * assertions moved here rather than being deleted with the file.
 *
 * The genuinely new part is the tag scan (T-TAG). Before plan-738 the baseline
 * was reached through the NAME written in `delivery-manifest.json`, which is one
 * indirection too many: a delivery whose branch push landed and whose tag push
 * did not leaves a manifest naming a tag that does not exist. "No baseline" then
 * read as "first delivery", and a first delivery seeds every project folder over
 * the customer's work. Asking Git which tags are really there cannot do that.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DELIVERY_MANIFEST_VERSION,
  baselineTagFor,
  changeoverCommitNote,
  detectDeliveryBaseline,
  parseLsFiles,
  parseLsTree,
  readDeliveryManifest,
  withDeliveryBaseline,
} from '../scripts/_workspace-lib.mjs';

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENTITY } });
}

//! A repository with one commit, plus whatever manifest and tags the case needs.
function repo(options: { manifest?: unknown; tags?: string[]; empty?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'rv-baseline-'));
  temporary.push(root);
  git(root, 'init', '-b', 'main');
  if (options.empty) return root;
  mkdirSync(join(root, 'realvirtual-web'), { recursive: true });
  writeFileSync(join(root, 'realvirtual-web', 'main.ts'), 'export {};\n');
  if (options.manifest !== undefined) {
    writeFileSync(join(root, 'delivery-manifest.json'),
      typeof options.manifest === 'string' ? options.manifest : JSON.stringify(options.manifest, null, 2));
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'a delivery');
  for (const tag of options.tags ?? []) git(root, 'tag', tag);
  return root;
}

// ── T-BASE: the migrated survivor assertions ────────────────────────────
describe('T-BASE: delivery-manifest baseline', () => {
  it('reads a manifest with its baseline tag', () => {
    const read = readDeliveryManifest({
      manifestVersion: 3, baselineTag: 'delivery/6.2.4', coreCommit: 'abc',
      projects: { p: { projectSchemaVersion: 1 } },
    });
    expect(read.baselineTag).toBe('delivery/6.2.4');
    expect(read.coreCommit).toBe('abc');
    expect(read.projects.p.projectSchemaVersion).toBe(1);
  });

  it('reports NO baseline for a v1 manifest rather than inventing one', () => {
    const read = readDeliveryManifest({ coreCommit: 'abc', projectTreeSha256: 'deadbeef' });
    expect(read.manifestVersion).toBe(1);
    expect(read.baselineTag).toBeNull();
    expect(read.coreCommit).toBe('abc');
  });

  it('survives a missing or malformed manifest', () => {
    for (const raw of [null, undefined, [], 'nonsense']) {
      expect(readDeliveryManifest(raw as never).baselineTag).toBeNull();
    }
  });

  it('adds the baseline fields without disturbing the pre-existing ones', () => {
    const base = { coreCommit: 'abc', privateCommit: 'def', viewerVersion: '6.3.0' };
    const next = withDeliveryBaseline(base, {
      version: '6.3.0', projects: { mauser3dhmi: { schemaVersion: 1 } },
    });
    expect(next.manifestVersion).toBe(DELIVERY_MANIFEST_VERSION);
    expect(next.coreCommit).toBe('abc');
    expect(next.baselineTag).toBe('delivery/6.3.0');
    expect(next.projects.mauser3dhmi.projectSchemaVersion).toBe(1);
  });

  it('writes neither vendorGlobs nor keptByCustomer any more (v3)', () => {
    expect(DELIVERY_MANIFEST_VERSION).toBe(3);
    const next = withDeliveryBaseline({}, {
      version: '6.3.0',
      // Even when the caller still hands over an old-shaped project entry, the
      // zone fields have nowhere to land.
      projects: { p: { schemaVersion: 1, vendor: { managed: ['models/**'] } } },
    });
    expect(next.projects.p).toEqual({ projectSchemaVersion: 1 });
    expect(JSON.stringify(next)).not.toContain('vendorGlobs');
    expect(JSON.stringify(next)).not.toContain('keptByCustomer');
  });

  it('carries no per-file hash map (redundant, large and incomplete)', () => {
    const next = withDeliveryBaseline({}, { version: '6.3.0', projects: {} });
    expect(next.outsideBaseline).toBeUndefined();
    expect(JSON.stringify(next).length).toBeLessThan(400);
  });

  it('names the tag the same way twice', () => {
    expect(baselineTagFor('6.3.0')).toBe('delivery/6.3.0');
  });
});

// ── T-V2 ────────────────────────────────────────────────────────────────
describe('T-V2: a v2 manifest is read, not refused', () => {
  it('takes the baseline out of a v2 manifest and ignores the two dropped fields', () => {
    // Every repository delivered before this plan carries exactly this shape.
    // Refusing it would make the first post-plan delivery look like a FIRST
    // delivery and seed over the customer's projects.
    const read = readDeliveryManifest({
      manifestVersion: 2,
      baselineTag: 'delivery/6.3.36',
      coreCommit: 'abc123',
      projects: {
        mauser3dhmi: {
          projectSchemaVersion: 2,
          vendorGlobs: { managed: ['models/**'], handover: ['models/custom/**'] },
          keptByCustomer: ['connect/project-config.json'],
        },
      },
    });
    expect(read.manifestVersion).toBe(2);
    expect(read.baselineTag).toBe('delivery/6.3.36');
    expect(read.projects.mauser3dhmi.projectSchemaVersion).toBe(2);
  });

  it('and a v2 manifest on disk still yields a baseline through the tag scan', () => {
    const clone = repo({
      manifest: { manifestVersion: 2, baselineTag: 'delivery/6.3.36', projects: {} },
      tags: ['delivery/6.3.36'],
    });
    const baseline = detectDeliveryBaseline(clone);
    expect(baseline.firstDelivery).toBe(false);
    expect(baseline.baselineTag).toBe('delivery/6.3.36');
  });
});

// ── T-TAG ───────────────────────────────────────────────────────────────
describe('T-TAG: the first-delivery decision comes from Git, not from the manifest', () => {
  it('an empty remote is a first delivery', () => {
    const baseline = detectDeliveryBaseline(repo({ empty: true }));
    expect(baseline.remoteEmpty).toBe(true);
    expect(baseline.firstDelivery).toBe(true);
    expect(baseline.untagged).toBe(false);
    expect(baseline.baselineTag).toBeNull();
  });

  it('content but no tag is UNTAGGED, and that is not a first delivery', () => {
    // The case the seed used to swallow: a repository whose delivery tags were
    // never pushed, or have been deleted, still holds the customer's work under
    // `projects/`. Seeding it would replace every folder this delivery carries.
    const baseline = detectDeliveryBaseline(repo({}));
    expect(baseline.remoteEmpty).toBe(false);
    expect(baseline.firstDelivery).toBe(false);
    expect(baseline.untagged).toBe(true);
    expect(baseline.baselineTag).toBeNull();
  });

  it('a tag with NO manifest is not a first delivery', () => {
    // The manifest is a convenience; the tag is the evidence.
    const baseline = detectDeliveryBaseline(repo({ tags: ['delivery/6.3.36'] }));
    expect(baseline.firstDelivery).toBe(false);
    expect(baseline.untagged).toBe(false);
    expect(baseline.baselineTag).toBe('delivery/6.3.36');
  });

  it('a tag with a BROKEN manifest is not a first delivery either', () => {
    for (const manifest of ['{ not json at all', '[]', '"nonsense"']) {
      const baseline = detectDeliveryBaseline(repo({ manifest, tags: ['delivery/6.3.36'] }));
      expect(baseline.firstDelivery, manifest).toBe(false);
      expect(baseline.baselineTag, manifest).toBe('delivery/6.3.36');
    }
  });

  it('the partial-failure case: the manifest names a tag whose push never landed', () => {
    // Branch pushed, tag push failed. The manifest says 6.4.0; Git only has
    // 6.3.36. Reading the name would find nothing and seed every project folder.
    const clone = repo({
      manifest: { manifestVersion: 3, baselineTag: 'delivery/6.4.0', projects: {} },
      tags: ['delivery/6.3.36'],
    });
    const baseline = detectDeliveryBaseline(clone);
    expect(baseline.firstDelivery).toBe(false);
    expect(baseline.baselineTag).toBe('delivery/6.3.36');
  });

  it('prefers the named tag when it really exists, and the newest otherwise', () => {
    const clone = repo({
      manifest: { manifestVersion: 3, baselineTag: 'delivery/6.3.0', projects: {} },
      tags: ['delivery/6.3.0', 'delivery/6.3.36'],
    });
    // The named one wins while it is really there — the pre-738 meaning, kept
    // exactly, because the tier gate reads this value.
    expect(detectDeliveryBaseline(clone).baselineTag).toBe('delivery/6.3.0');
  });

  it('ignores tags that are not delivery tags', () => {
    const clone = repo({ tags: ['realvirtual-v6.3.36', 'v1', 'backup'] });
    const baseline = detectDeliveryBaseline(clone);
    expect(baseline.tags).toEqual([]);
    // No DELIVERY tag, but the repository has content — untagged, not first.
    expect(baseline.firstDelivery).toBe(false);
    expect(baseline.untagged).toBe(true);
  });
});

// ── blob-OID parsers ────────────────────────────────────────────────────
describe('blob-OID maps from git', () => {
  it('parses git ls-files -s -z output', () => {
    const output = [
      '100644 aaaa1111 0\tprojects/p/models/a.glb',
      '100644 bbbb2222 0\tprojects/p/scenes/s.scene.json',
      '100644 cccc3333 0\tREADME.md',
    ].join('\0') + '\0';
    expect(parseLsFiles(output)).toEqual({
      'projects/p/models/a.glb': 'aaaa1111',
      'projects/p/scenes/s.scene.json': 'bbbb2222',
      'README.md': 'cccc3333',
    });
  });

  it('tolerates a path containing spaces', () => {
    expect(parseLsFiles('100644 aaaa 0\tdocs/my manual.pdf\0'))
      .toEqual({ 'docs/my manual.pdf': 'aaaa' });
  });

  it('parses git ls-tree -r -z output and keeps blobs only', () => {
    // One field more than ls-files, which is why there are two parsers.
    const output = [
      '100644 blob aaaa1111\tREADME.md',
      '040000 tree bbbb2222\tprojects',
      '100644 blob cccc3333\tprojects/p/models/a.glb',
    ].join('\0') + '\0';
    expect(parseLsTree(output)).toEqual({
      'README.md': 'aaaa1111',
      'projects/p/models/a.glb': 'cccc3333',
    });
  });

  it('agrees with a real git index and a real tree', () => {
    const root = repo({});
    const files = parseLsFiles(git(root, 'ls-files', '-s', '-z'));
    const tree = parseLsTree(git(root, 'ls-tree', '-r', '-z', 'HEAD'));
    expect(Object.keys(files).sort()).toEqual(['delivery-manifest.json', 'realvirtual-web/main.ts'].filter(
      name => name in files).sort());
    expect(files).toEqual(tree);
    for (const oid of Object.values(tree)) expect(oid).toMatch(/^[0-9a-f]{40}$/);
    // Git always reports forward slashes, which is why no path here ever comes
    // from readdirSync.
    expect(Object.keys(tree).every(path => !path.includes('\\'))).toBe(true);
  });
});

// ── F9: the changeover paragraph says itself exactly once ────────────────
describe('changeoverCommitNote', () => {
  it('explains the new model while the repository is still on an older manifest', () => {
    for (const previous of [1, 2]) {
      const note = changeoverCommitNote(previous);
      expect(note, String(previous)).toContain('Neues Liefermodell ab dieser Auslieferung.');
      // Both customer rules, in the one place a customer is told about them
      // besides the README.
      expect(note).toMatch(/committen Sie Ihre Arbeit, bevor Sie pullen/);
      expect(note).toMatch(/force-pushen nie/);
    }
  });

  it('says nothing once the repository already carries v3 — no changeover state anywhere', () => {
    expect(changeoverCommitNote(DELIVERY_MANIFEST_VERSION)).toBe('');
    expect(changeoverCommitNote(DELIVERY_MANIFEST_VERSION + 1)).toBe('');
  });

  it('mentions the sidecar cleanup only when there was one', () => {
    expect(changeoverCommitNote(2, { sidecarsRemoved: [] })).not.toMatch(/Aufgeraeumt/);
    expect(changeoverCommitNote(2, { sidecarsRemoved: ['projects/a/b.vendor-6.3.0.json'] }))
      .toMatch(/Aufgeraeumt: 1 zurueckgebliebene/);
  });
});
