// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * _vendor-merge — the three-way merge core (plan-700 Phase 3).
 *
 * Every one of the nine cases in §2.5, plus the invariant that actually
 * protects customers: **anything not decided as add/update/delete must leave
 * the customer's bytes untouched.** The merge is pure, so all of it is testable
 * without a single temporary repository.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  mergeVendorTree,
  classifyPath,
  sidecarPathFor,
  sidecarIsSafe,
  mergeProjectManifest,
  readDeliveryManifest,
  withDeliveryBaseline,
  baselineTagFor,
  parseLsFiles,
  projectSubtree,
  summariseMerge,
  parseCheckAttr,
  DELIVERY_MANIFEST_VERSION,
} from '../scripts/_vendor-merge.mjs';

const globs = {
  managed: ['models/**', 'connect/**', 'docs/**'],
  handover: ['models/custom/**', 'connect/secrets.local.json'],
};

/** Shorthand for one path through the merge. */
function decide(
  path: string,
  b: string | null,
  c: string | null,
  s: string | null,
  extra: Record<string, unknown> = {},
) {
  const map = (v: string | null) => (v === null ? {} : { [path]: v });
  return mergeVendorTree({
    baseline: b === null && extra.baseline === null ? null : map(b),
    customer: map(c),
    staged: map(s),
    vendorGlobs: globs,
    ...extra,
  });
}

describe('classifyPath', () => {
  it('treats a handover path as the customer\'s even inside a managed glob', () => {
    expect(classifyPath('models/custom/mine.glb', globs)).toBe('customer');
    expect(classifyPath('connect/secrets.local.json', globs)).toBe('customer');
  });

  it('treats a managed path as ours', () => {
    expect(classifyPath('models/a.glb', globs)).toBe('vendor');
    expect(classifyPath('connect/project-config.json', globs)).toBe('vendor');
  });

  it('treats everything unmatched as the customer\'s (the safe default)', () => {
    expect(classifyPath('scenes/s.scene.json', globs)).toBe('customer');
    expect(classifyPath('settings/project-settings.json', globs)).toBe('customer');
    expect(classifyPath('notes.md', globs)).toBe('customer');
  });

  it('treats the whole project as the customer\'s when there is no vendor block', () => {
    expect(classifyPath('models/a.glb', null)).toBe('customer');
    expect(classifyPath('models/a.glb', {})).toBe('customer');
  });
});

describe('mergeVendorTree — the nine cases of §2.5', () => {
  it('case 1: a path no vendor glob matches is kept, silently', () => {
    const r = decide('scenes/mine.scene.json', 'sha-b', 'sha-c', 'sha-s');
    expect(r.actions['scenes/mine.scene.json']).toBe('keep-customer');
    expect(r.conflicts).toHaveLength(0);
  });

  it('case 2: a brand-new vendor file is added', () => {
    const r = decide('models/new.glb', null, null, 'sha-s');
    expect(r.actions['models/new.glb']).toBe('add');
    expect(r.conflicts).toHaveLength(0);
  });

  it('case 3: a vendor file the customer never touched is updated', () => {
    const r = decide('models/a.glb', 'sha-old', 'sha-old', 'sha-new');
    expect(r.actions['models/a.glb']).toBe('update');
    expect(r.conflicts).toHaveLength(0);
  });

  it('case 4: an already-current file is a no-op', () => {
    const r = decide('models/a.glb', 'sha-old', 'sha-new', 'sha-new');
    expect(r.actions['models/a.glb']).toBe('noop');
    expect(r.conflicts).toHaveLength(0);
  });

  it('case 5: both sides changed — the customer wins, with a sidecar', () => {
    const r = decide('connect/project-config.json', 'sha-b', 'sha-c', 'sha-s');
    expect(r.actions['connect/project-config.json']).toBe('keep-customer');
    expect(r.conflicts[0]).toMatchObject({
      path: 'connect/project-config.json', reason: 'both-changed', sidecar: true,
    });
  });

  it('case 6: the customer created a file we now also ship — customer wins, with a sidecar', () => {
    const r = decide('models/a.glb', null, 'sha-c', 'sha-s');
    expect(r.actions['models/a.glb']).toBe('keep-customer');
    expect(r.conflicts[0]).toMatchObject({ reason: 'added-both-sides', sidecar: true });
  });

  it('case 7: a vendor file we stopped shipping is removed when untouched', () => {
    const r = decide('models/old.glb', 'sha-b', 'sha-b', null);
    expect(r.actions['models/old.glb']).toBe('delete');
    expect(r.conflicts).toHaveLength(0);
  });

  it('case 8: we want to remove it but the customer changed it — kept, reported', () => {
    const r = decide('models/old.glb', 'sha-b', 'sha-c', null);
    expect(r.actions['models/old.glb']).toBe('keep-customer');
    expect(r.conflicts[0]).toMatchObject({
      reason: 'deleted-by-vendor-changed-by-customer', sidecar: false,
    });
  });

  it('case 9: a file the customer deleted on purpose is never re-delivered (F4)', () => {
    const r = decide('models/a.glb', 'sha-b', null, 'sha-s');
    expect(r.actions['models/a.glb']).toBe('keep-deleted');
    expect(r.conflicts[0]).toMatchObject({ reason: 'deleted-by-customer', sidecar: false });
  });
});

describe('the invariant that protects the customer', () => {
  /**
   * For every path whose action is not add/update/delete, the customer's bytes
   * after the delivery must equal the bytes before it. Modelled by applying the
   * actions to the customer map and comparing.
   */
  it('never changes a byte on any path that is not add, update or delete', () => {
    const baseline: Record<string, string> = {
      'models/a.glb': 'b1', 'models/gone.glb': 'b2', 'connect/project-config.json': 'b3',
      'scenes/s.scene.json': 'b4', 'models/custom/mine.glb': 'b5',
    };
    const customer: Record<string, string> = {
      'models/a.glb': 'b1', 'connect/project-config.json': 'c3',
      'scenes/s.scene.json': 'c4', 'models/custom/mine.glb': 'c5', 'notes.md': 'c6',
    };
    const staged: Record<string, string> = {
      'models/a.glb': 's1', 'models/new.glb': 's7', 'connect/project-config.json': 's3',
      'scenes/s.scene.json': 's4', 'models/custom/mine.glb': 's5',
    };
    const r = mergeVendorTree({ baseline, customer, staged, vendorGlobs: globs });

    const after = { ...customer };
    for (const [path, action] of Object.entries(r.actions)) {
      if (action === 'add' || action === 'update') after[path] = staged[path];
      else if (action === 'delete') delete after[path];
    }
    for (const [path, action] of Object.entries(r.actions)) {
      if (action === 'add' || action === 'update' || action === 'delete') continue;
      expect(after[path], path).toBe(customer[path]);
    }
    // And specifically: the customer's own material is exactly as it was.
    expect(after['scenes/s.scene.json']).toBe('c4');
    expect(after['models/custom/mine.glb']).toBe('c5');
    expect(after['notes.md']).toBe('c6');
    // While the untouched vendor file did get its update.
    expect(after['models/a.glb']).toBe('s1');
    expect(after['models/new.glb']).toBe('s7');
    // And a file the customer had deleted stays deleted.
    expect('models/gone.glb' in after).toBe(false);
  });
});

describe('first delivery without a baseline (§2.4)', () => {
  const customer = { 'models/a.glb': 'c1' };
  const staged = { 'models/a.glb': 's1', 'models/b.glb': 's2' };

  it('seeds everything when the remote is empty', () => {
    const r = mergeVendorTree({
      baseline: null, customer: {}, staged, vendorGlobs: globs, remoteEmpty: true,
    });
    expect(r.actions['models/a.glb']).toBe('add');
    expect(r.actions['models/b.glb']).toBe('add');
    expect(r.conflicts).toHaveLength(0);
    expect(r.baselineMissing).toBe(true);
  });

  it('touches nothing that exists on both sides when there is no baseline tag', () => {
    const r = mergeVendorTree({ baseline: null, customer, staged, vendorGlobs: globs });
    expect(r.actions['models/a.glb']).toBe('keep-customer');
    expect(r.baselineMissing).toBe(true);
  });

  it('asks instead of silently restoring a file missing at a pre-plan-700 customer (R2-1)', () => {
    const r = mergeVendorTree({ baseline: null, customer, staged, vendorGlobs: globs });
    expect(r.actions['models/b.glb']).toBe('add-pending');
    expect(r.conflicts[0]).toMatchObject({ path: 'models/b.glb', reason: 'missing-without-baseline' });
  });

  it('creates those files once a human passed --seed-missing', () => {
    const r = mergeVendorTree({
      baseline: null, customer, staged, vendorGlobs: globs, seedMissing: true,
    });
    expect(r.actions['models/b.glb']).toBe('add');
    expect(r.conflicts).toHaveLength(0);
  });
});

describe('case collisions (S4)', () => {
  it('throws rather than deciding a delete against the wrong entry', () => {
    expect(() => mergeVendorTree({
      baseline: { 'models/A.glb': 'b', 'models/a.glb': 'b2' },
      customer: {}, staged: {}, vendorGlobs: globs,
    })).toThrow(/differing only in case/);
  });

  it('checks all three maps, not just the baseline', () => {
    expect(() => mergeVendorTree({
      baseline: {}, customer: { 'Models/a.glb': 'c', 'models/a.glb': 'c2' },
      staged: {}, vendorGlobs: globs,
    })).toThrow(/customer/);
    expect(() => mergeVendorTree({
      baseline: {}, customer: {}, staged: { 'models/A.GLB': 's', 'models/a.glb': 's2' },
      vendorGlobs: globs,
    })).toThrow(/staged/);
  });
});

describe('sidecar naming (S1)', () => {
  it('keeps the extension last so the LFS rule still matches', () => {
    expect(sidecarPathFor('models/a.glb', '6.3.0')).toBe('models/a.vendor-6.3.0.glb');
    expect(sidecarPathFor('connect/project-config.json', '6.3.0'))
      .toBe('connect/project-config.vendor-6.3.0.json');
  });

  it('appends when there is no extension, and leaves a dotfile intact', () => {
    expect(sidecarPathFor('LICENSE', '6.3.0')).toBe('LICENSE.vendor-6.3.0');
    expect(sidecarPathFor('.gitignore', '6.3.0')).toBe('.gitignore.vendor-6.3.0');
  });

  it('yields a different name per version, so two conflicts do not overwrite each other', () => {
    expect(sidecarPathFor('models/a.glb', '6.3.0')).not.toBe(sidecarPathFor('models/a.glb', '6.3.1'));
  });

  it('every sidecar of a real .gitattributes tree lands under its original rule', () => {
    const root = mkdtempSync(join(tmpdir(), 'rv-sidecar-attr-'));
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
      writeFileSync(join(root, '.gitattributes'), [
        '*.glb    filter=lfs diff=lfs merge=lfs -text',
        '*.pdf    filter=lfs diff=lfs merge=lfs -text',
        '*.json   text eol=lf',
        '',
      ].join('\n'));
      const attributeOf = (path: string) =>
        parseCheckAttr(execFileSync('git', ['check-attr', 'filter', '--', path], { cwd: root, encoding: 'utf8' }));

      for (const original of ['models/a.glb', 'docs/manual.pdf', 'connect/project-config.json']) {
        const sidecar = sidecarPathFor(original, '6.3.0');
        expect(sidecarIsSafe(original, sidecar, attributeOf), original).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses the sidecar when the rule is an exact path pin it cannot inherit (R2-4)', () => {
    const root = mkdtempSync(join(tmpdir(), 'rv-sidecar-pin-'));
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
      // The repository's own deliberate pattern: scoped paths, NOT a blanket *.glb.
      writeFileSync(join(root, '.gitattributes'),
        'models/a.glb filter=lfs diff=lfs merge=lfs -text\n');
      const attributeOf = (path: string) =>
        parseCheckAttr(execFileSync('git', ['check-attr', 'filter', '--', path], { cwd: root, encoding: 'utf8' }));

      const sidecar = sidecarPathFor('models/a.glb', '6.3.0');
      expect(sidecarIsSafe('models/a.glb', sidecar, attributeOf)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('mergeProjectManifest (§2.7)', () => {
  const vendorManifest = {
    schemaVersion: 1, id: 'prj_vendor', name: 'Vendor Name', canonicalName: 'proj',
    vendor: { managed: ['models/**'] },
    connect: { bundleId: 'proj' },
    models: [{ path: 'a.glb' }, { path: 'custom/mine.glb' }],
  };

  it('replaces the schema-update channel and keeps the customer\'s identity', () => {
    const customer = {
      schemaVersion: 1, id: 'prj_customer', name: 'Their Name', canonicalName: 'old',
      scenes: [{ id: 'scn_a', path: 'scenes/a.scene.json' }],
      settingsRef: { ref: 'settings/project-settings.json' },
      activeSceneId: 'scn_a',
    };
    const { merged, changed } = mergeProjectManifest(customer, vendorManifest, globs);
    expect(merged!.canonicalName).toBe('proj');
    expect(merged!.vendor).toEqual({ managed: ['models/**'] });
    expect(merged!.id).toBe('prj_customer');
    expect(merged!.name).toBe('Their Name');
    expect(merged!.scenes).toEqual(customer.scenes);
    expect(merged!.activeSceneId).toBe('scn_a');
    expect(merged!.settingsRef).toEqual(customer.settingsRef);
    expect(changed).toContain('canonicalName');
  });

  it('keeps unknown sections written by a newer client (plan-370 R3)', () => {
    const { merged } = mergeProjectManifest(
      { schemaVersion: 1, id: 'x', name: 'y', somethingNew: { a: 1 } }, vendorManifest, globs,
    );
    expect(merged!.somethingNew).toEqual({ a: 1 });
  });

  it('keeps an entry whose path falls under handover, while replacing the rest', () => {
    const customer = {
      schemaVersion: 1, id: 'x', name: 'y',
      models: [{ path: 'custom/mine.glb', label: 'Mine' }, { path: 'stale.glb' }],
    };
    const { merged } = mergeProjectManifest(customer, vendorManifest, globs);
    const models = merged!.models as Array<Record<string, unknown>>;
    expect(models).toContainEqual({ path: 'custom/mine.glb', label: 'Mine' });
    expect(models.some(m => m.path === 'a.glb')).toBe(true);
    expect(models.some(m => m.path === 'stale.glb')).toBe(false);
  });

  // plan-413 phase 6: `documents[]` is a merged section like the others, but its
  // paths already carry their folder — the classification must not prefix them
  // again, or every customer document would be classified as ours.
  it('merges documents[] entry-wise and keeps a handover document', () => {
    const customer = {
      schemaVersion: 2, id: 'x', name: 'y',
      documents: [
        { id: 'doc_mine', path: 'models/custom/mine.glb', section: 'models', label: 'Mine' },
        { id: 'doc_stale', path: 'models/stale.glb', section: 'models' },
      ],
    };
    const vendor = {
      ...vendorManifest, schemaVersion: 2,
      documents: [{ id: 'doc_a', path: 'models/a.glb', section: 'models' }],
    };
    const { merged, changed } = mergeProjectManifest(customer, vendor, globs);
    const docs = merged!.documents as Array<Record<string, unknown>>;
    expect(docs).toContainEqual(customer.documents[0]);   // handover → theirs
    expect(docs.some(d => d.path === 'models/a.glb')).toBe(true);
    expect(docs.some(d => d.path === 'models/stale.glb')).toBe(false);
    expect(changed).toContain('documents');
  });

  it('leaves a customer that has not migrated yet with their three arrays', () => {
    // A repository nobody has opened in a current client still carries
    // scenes/models/library and no documents[]. A delivery must not fail over
    // that, and must not invent a documents[] the customer never had.
    const customer = {
      schemaVersion: 1, id: 'x', name: 'y',
      library: [{ path: 'gripper.glb' }],
    };
    const { merged } = mergeProjectManifest(customer, vendorManifest, globs);
    expect(merged!.documents).toBeUndefined();
    expect(merged!.library).toEqual([{ path: 'gripper.glb' }]);
  });

  it('does not merge into an unreadable customer manifest — it reports instead', () => {
    expect(mergeProjectManifest(null, vendorManifest, globs))
      .toMatchObject({ merged: null, unreadable: true });
    expect(mergeProjectManifest('{ truncated', vendorManifest, globs))
      .toMatchObject({ merged: null, unreadable: true });
  });

  it('refuses to run at all when the DELIVERED manifest is broken', () => {
    expect(() => mergeProjectManifest({ id: 'x' }, null, globs)).toThrow();
  });
});

describe('delivery-manifest v2 (§2.4)', () => {
  it('reads a v2 manifest with its baseline tag', () => {
    const read = readDeliveryManifest({
      manifestVersion: 2, baselineTag: 'delivery/6.2.4', coreCommit: 'abc',
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
      expect(readDeliveryManifest(raw).baselineTag).toBeNull();
    }
  });

  it('adds the v2 fields without disturbing the v1 ones', () => {
    const base = { coreCommit: 'abc', privateCommit: 'def', viewerVersion: '6.3.0' };
    const next = withDeliveryBaseline(base, {
      version: '6.3.0',
      projects: { mauser3dhmi: { schemaVersion: 1, vendor: { managed: ['models/**'], handover: [] } } },
    });
    expect(next.manifestVersion).toBe(DELIVERY_MANIFEST_VERSION);
    expect(next.coreCommit).toBe('abc');
    expect(next.baselineTag).toBe('delivery/6.3.0');
    expect(next.projects.mauser3dhmi.vendorGlobs.managed).toEqual(['models/**']);
  });

  it('carries no per-file hash map (R2-3: redundant, large and incomplete)', () => {
    const next = withDeliveryBaseline({}, { version: '6.3.0', projects: {} });
    expect(next.outsideBaseline).toBeUndefined();
    expect(JSON.stringify(next).length).toBeLessThan(400);
  });

  it('names the tag the same way twice', () => {
    expect(baselineTagFor('6.3.0')).toBe('delivery/6.3.0');
  });
});

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

  it('re-keys one project subtree to project-relative paths', () => {
    const map = {
      'projects/p/models/a.glb': 'a', 'projects/other/models/b.glb': 'b', 'README.md': 'c',
    };
    expect(projectSubtree(map, 'p')).toEqual({ 'models/a.glb': 'a' });
  });

  it('agrees with a real git index, pointer blobs included', () => {
    const root = mkdtempSync(join(tmpdir(), 'rv-lsfiles-'));
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
      mkdirSync(join(root, 'projects', 'p', 'models'), { recursive: true });
      writeFileSync(join(root, 'projects', 'p', 'models', 'a.glb'), 'glb-bytes');
      writeFileSync(join(root, 'README.md'), '# readme\n');
      execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
      const output = execFileSync('git', ['ls-files', '-s', '-z'], { cwd: root, encoding: 'utf8' });
      const map = parseLsFiles(output);
      expect(Object.keys(map).sort()).toEqual(['README.md', 'projects/p/models/a.glb']);
      for (const oid of Object.values(map)) expect(oid).toMatch(/^[0-9a-f]{40}$/);
      // Git always reports forward slashes, which is why no path in the merge
      // ever comes from readdirSync.
      expect(Object.keys(map).every(p => !p.includes('\\'))).toBe(true);
      expect(projectSubtree(map, 'p')).toEqual({ 'models/a.glb': map['projects/p/models/a.glb'] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('summariseMerge', () => {
  it('counts what the CLI line and the report show', () => {
    const r = mergeVendorTree({
      baseline: { 'models/a.glb': 'b', 'models/gone.glb': 'b' },
      customer: { 'models/a.glb': 'b', 'models/gone.glb': 'b', 'connect/x.json': 'c' },
      staged: { 'models/a.glb': 's', 'models/new.glb': 's', 'connect/x.json': 's' },
      vendorGlobs: globs,
    });
    expect(summariseMerge(r)).toMatchObject({ add: 1, update: 1, delete: 1, conflicts: 1 });
  });
});
