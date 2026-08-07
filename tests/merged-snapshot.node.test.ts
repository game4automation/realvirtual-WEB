// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * applyMergedSnapshot — the delivery path that writes into a customer repository
 * (plan-700 Phase 4, §2.2/§2.5/§2.6).
 *
 * This is the file that closes B16: before it, the SECOND delivery against a
 * populated projects/<key>/ was covered by no test at all, and that is the only
 * delivery that can destroy anything. Every test here therefore asserts what
 * SURVIVES, not just what arrives.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMergedSnapshot } from '../scripts/_workspace-lib.mjs';

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

const VENDOR = { managed: ['models/**', 'connect/**', 'docs/**'], handover: ['models/custom/**'] };

const ATTRIBUTES = [
  'projects/*/models/*.glb filter=lfs diff=lfs merge=lfs -text',
  // An EXACT path pin, not a suffix glob. The repository really does use these
  // (Assets/realvirtual-WebViewer~/.gitattributes pins paths on purpose), and a
  // sidecar can never inherit one — which is the case §2.5 refuses to write.
  'projects/acme/docs/pinned.bin filter=lfs diff=lfs merge=lfs -text',
  '',
].join('\n');

//! Builds a staging tree in the shape stageFilteredSourceTree produces, then gives it
//! the Git index applyMergedSnapshot reads the staged-side blob OIDs from.
function stage(root: string, name: string, files: Record<string, string>, version = '1.0.0'): string {
  const staged = join(root, name);
  write(join(staged, '.gitattributes'), ATTRIBUTES);
  // Exactly what the generator writes: a v2 manifest naming the tag THIS delivery
  // will set. The next delivery reads it back out of the clone and uses that tag as
  // its merge basis, so a fixture without it is a fixture without a baseline.
  write(join(staged, 'delivery-manifest.json'), JSON.stringify({ manifestVersion: 2, baselineTag: 'delivery/' + version, projects: {} }, null, 2));
  for (const [path, text] of Object.entries(files)) write(join(staged, path), text);
  git(staged, 'init', '-b', 'main');
  git(staged, 'add', '-A');
  return staged;
}

function emptyClone(root: string, name = 'clone'): string {
  const clone = join(root, name);
  mkdirSync(clone, { recursive: true });
  git(clone, 'init', '-b', 'main');
  return clone;
}

function commit(clone: string, message: string): void {
  git(clone, 'add', '-A');
  git(clone, 'commit', '-m', message);
}

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'rv-merged-snapshot-'));
  temporary.push(root);
  return root;
}

//! Byte snapshot of a tree, keyed by POSIX-relative path — the evidence for the
//! preservation invariant of §2.5.
function bytes(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else out[relative(root, absolute).split('\\').join('/')] = readFileSync(absolute, 'base64');
    }
  };
  walk(root);
  return out;
}

const V1: Record<string, string> = {
  'realvirtual-web/src/main.ts': 'export const version = 1;\n',
  'projects/acme/project.json': JSON.stringify({ schemaVersion: 1, id: 'prj_1', name: 'Acme', canonicalName: 'acme', vendor: VENDOR }, null, 2) + '\n',
  'projects/acme/models/machine.glb': 'model-v1',
  'projects/acme/connect/project-config.json': '{"poll":100}\n',
  'projects/acme/docs/manual.md': 'manual v1\n',
  'projects/acme/docs/pinned.bin': 'pinned-v1',
  'projects/acme/scenes/shipped.scene.json': '{"scene":"shipped"}\n',
};

//! First delivery + commit + baseline tag: the state every "second delivery" test starts from.
function seededClone(root: string, version = '1.0.0', files: Record<string, string> = V1) {
  const stagedV1 = stage(root, 'staged-v1', files, version);
  const clone = emptyClone(root);
  applyMergedSnapshot(stagedV1, clone, { projects: [{ key: 'acme', vendor: VENDOR }], version });
  commit(clone, 'delivery 1');
  git(clone, 'tag', 'delivery/' + version);
  return { clone, stagedV1 };
}

/**
 * Every case below drives real `git init` / `clone` / `add` / `commit` / `tag`
 * in a sandbox directory — that is the point of them, because the merge basis
 * is a Git blob OID and a faked one would test nothing. On Windows those
 * process spawns cost seconds, not milliseconds: isolated, the file needs ~38 s
 * for 13 cases, and the heaviest single case (the `.gitattributes` sidecar
 * rule, which stages an extra commit) lands at ~5.2 s — just over vitest's
 * 5000 ms default. It therefore failed as a coin toss: green at 4.8 s, timed
 * out at 5.2 s, with nothing wrong in the assertions either way.
 *
 * The timeout is set once for the whole suite rather than on single cases:
 * every case here is git-heavy, so singling any of them out would only invite
 * the next one to drift over the line unnoticed. 60 s is the value
 * `customer-workspace.node.test.ts` already uses for its own git/LFS push test
 * — roughly a twelvefold margin on the slowest case, which is the room the
 * full suite needs when these run alongside everything else.
 *
 * Raised again to 180 s for the community precheck (scripts/precheck-community.mjs),
 * which runs the suite from a FRESH copy of the tree in the system temp dir: every
 * file is read cold and, on Windows, inspected by the on-access virus scanner. The
 * git work here is the same; only the filesystem underneath is slower.
 */
describe('applyMergedSnapshot', { timeout: 180000 }, () => {
  it('seeds an empty remote completely, including the customer-owned zone', () => {
    const root = sandbox();
    const staged = stage(root, 'staged', V1);
    const clone = emptyClone(root);
    const snapshot = applyMergedSnapshot(staged, clone, { projects: [{ key: 'acme', vendor: VENDOR }], version: '1.0.0' });
    expect(snapshot.remoteEmpty).toBe(true);
    expect(snapshot.projects.acme.seeded).toBe(true);
    // Zone C only ever "arrives" during seeding. On any later delivery it belongs to
    // the customer, and a vendor scene must not overwrite what they made of it.
    expect(existsSync(join(clone, 'projects/acme/scenes/shipped.scene.json'))).toBe(true);
    expect(existsSync(join(clone, 'projects/acme/models/machine.glb'))).toBe(true);
    expect(existsSync(join(clone, 'realvirtual-web/src/main.ts'))).toBe(true);
    expect(existsSync(join(clone, 'DELIVERY-REPORT.md'))).toBe(true);
  });

  it('delivers updates, keeps the customer version on conflict and never touches zone C', () => {
    const root = sandbox();
    const { clone } = seededClone(root);

    // The customer works in their repository.
    write(join(clone, 'projects/acme/scenes/mine.scene.json'), '{"scene":"mine"}\n');
    write(join(clone, 'projects/acme/connect/project-config.json'), '{"poll":250}\n');
    write(join(clone, 'realvirtual-web/src/main.ts'), 'export const patchedByCustomer = true;\n');
    write(join(clone, 'notizen.md'), 'meine notizen\n');
    commit(clone, 'customer work');
    const before = bytes(join(clone, 'projects/acme'));

    const stagedV2 = stage(root, 'staged-v2', {
      ...V1,
      'realvirtual-web/src/main.ts': 'export const version = 2;\n',
      'projects/acme/connect/project-config.json': '{"poll":500}\n',
      'projects/acme/docs/manual.md': 'manual v2\n',
      'projects/acme/models/new.glb': 'model-new',
    }, '2.0.0');
    const snapshot = applyMergedSnapshot(stagedV2, clone, {
      projects: [{ key: 'acme', vendor: VENDOR }], version: '2.0.0',
    });
    const after = bytes(join(clone, 'projects/acme'));
    const project = snapshot.projects.acme;

    // F1 — an untouched vendor file is updated. This is the whole point: before
    // plan-700 no project-side change reached a delivered customer at all.
    expect(project.updated).toContain('docs/manual.md');
    expect(readFileSync(join(clone, 'projects/acme/docs/manual.md'), 'utf8')).toBe('manual v2\n');
    expect(project.added).toContain('models/new.glb');

    // F2 — both sides changed: the customer wins, our version is parked beside it.
    const conflict = project.conflicts.find(entry => entry.path === 'connect/project-config.json');
    expect(conflict).toMatchObject({ reason: 'both-changed', sidecarPath: 'connect/project-config.vendor-2.0.0.json' });
    expect(readFileSync(join(clone, 'projects/acme/connect/project-config.json'), 'utf8')).toBe('{"poll":250}\n');
    expect(readFileSync(join(clone, 'projects/acme/connect/project-config.vendor-2.0.0.json'), 'utf8')).toBe('{"poll":500}\n');

    // Zone C, byte for byte. Both the file the customer created and the scene we
    // once shipped and they now own.
    expect(after['scenes/mine.scene.json']).toBe(before['scenes/mine.scene.json']);
    expect(after['scenes/shipped.scene.json']).toBe(before['scenes/shipped.scene.json']);

    // The preservation invariant of §2.5, stated as a property rather than a list:
    // every path we did not decide to add, update or delete is unchanged.
    const decided = new Set([...project.added, ...project.updated, ...project.removed,
      ...project.conflicts.filter(entry => entry.sidecarPath).map(entry => entry.sidecarPath as string)]);
    for (const [path, content] of Object.entries(before)) {
      if (decided.has(path)) continue;
      expect(after[path], 'must be preserved: ' + path).toBe(content);
    }

    // Zone A is replaced, and the difference is REPORTED rather than dropped in silence.
    expect(readFileSync(join(clone, 'realvirtual-web/src/main.ts'), 'utf8')).toBe('export const version = 2;\n');
    expect(snapshot.drift).toContainEqual({ status: 'M', path: 'realvirtual-web/src/main.ts' });
    expect(snapshot.drift).toContainEqual({ status: 'A', path: 'notizen.md' });
    expect(existsSync(join(clone, 'notizen.md'))).toBe(false);

    const report = readFileSync(join(clone, 'DELIVERY-REPORT.md'), 'utf8');
    expect(report).toContain('connect/project-config.json');
    expect(report).toContain('notizen.md');
    expect(report).toContain('Ihre Aenderungen ausserhalb von projects/');
  });

  it('never re-delivers a vendor file the customer deleted on purpose', () => {
    const root = sandbox();
    const { clone } = seededClone(root);
    rmSync(join(clone, 'projects/acme/models/machine.glb'));
    commit(clone, 'customer removed the model');

    const stagedV2 = stage(root, 'staged-v2', { ...V1, 'projects/acme/models/machine.glb': 'model-v2' }, '2.0.0');
    const snapshot = applyMergedSnapshot(stagedV2, clone, { projects: [{ key: 'acme', vendor: VENDOR }], version: '2.0.0' });

    expect(existsSync(join(clone, 'projects/acme/models/machine.glb'))).toBe(false);
    expect(snapshot.projects.acme.conflicts).toContainEqual(
      expect.objectContaining({ path: 'models/machine.glb', reason: 'deleted-by-customer' }));
  });

  it('refuses a sidecar that would escape the .gitattributes rule of its original', () => {
    const root = sandbox();
    const { clone } = seededClone(root);
    write(join(clone, 'projects/acme/docs/pinned.bin'), 'pinned-customer');
    commit(clone, 'customer edited the pinned file');

    const stagedV2 = stage(root, 'staged-v2', { ...V1, 'projects/acme/docs/pinned.bin': 'pinned-v2' }, '2.0.0');
    const snapshot = applyMergedSnapshot(stagedV2, clone, { projects: [{ key: 'acme', vendor: VENDOR }], version: '2.0.0' });

    const conflict = snapshot.projects.acme.conflicts.find(entry => entry.path === 'docs/pinned.bin');
    // No sidecar rather than a raw blob outside LFS: a missing sidecar costs a
    // lookup, a several-hundred-megabyte blob costs the customer their repository.
    expect(conflict).toMatchObject({ sidecar: true, sidecarPath: null });
    expect(existsSync(join(clone, 'projects/acme/docs/pinned.vendor-2.0.0.bin'))).toBe(false);
    expect(readFileSync(join(clone, 'projects/acme/docs/pinned.bin'), 'utf8')).toBe('pinned-customer');

    // A .glb, by contrast, keeps its extension and stays under the suffix rule.
    commit(clone, 'delivery 2');
    git(clone, 'tag', 'delivery/2.0.0');
    write(join(clone, 'projects/acme/models/machine.glb'), 'model-customer');
    commit(clone, 'customer edited the model');
    const stagedV3 = stage(root, 'staged-v3', { ...V1, 'projects/acme/models/machine.glb': 'model-v3' }, '3.0.0');
    applyMergedSnapshot(stagedV3, clone, { projects: [{ key: 'acme', vendor: VENDOR }], version: '3.0.0' });
    expect(existsSync(join(clone, 'projects/acme/models/machine.vendor-3.0.0.glb'))).toBe(true);
  });

  it('parks a second conflicting version beside the first instead of overwriting it', () => {
    const root = sandbox();
    const { clone } = seededClone(root);
    write(join(clone, 'projects/acme/connect/project-config.json'), '{"poll":250}\n');
    commit(clone, 'customer change');
    applyMergedSnapshot(stage(root, 'staged-v2', { ...V1, 'projects/acme/connect/project-config.json': '{"poll":500}\n' }, '2.0.0'),
      clone, { projects: [{ key: 'acme', vendor: VENDOR }], version: '2.0.0' });
    commit(clone, 'delivery 2');
    git(clone, 'tag', 'delivery/2.0.0');
    applyMergedSnapshot(stage(root, 'staged-v3', { ...V1, 'projects/acme/connect/project-config.json': '{"poll":900}\n' }, '3.0.0'),
      clone, { projects: [{ key: 'acme', vendor: VENDOR }], version: '3.0.0' });

    expect(readFileSync(join(clone, 'projects/acme/connect/project-config.vendor-2.0.0.json'), 'utf8')).toBe('{"poll":500}\n');
    expect(readFileSync(join(clone, 'projects/acme/connect/project-config.vendor-3.0.0.json'), 'utf8')).toBe('{"poll":900}\n');
    expect(readFileSync(join(clone, 'projects/acme/connect/project-config.json'), 'utf8')).toBe('{"poll":250}\n');
  });

  it('merges project.json field-wise and keeps the customer sections', () => {
    const root = sandbox();
    const { clone } = seededClone(root);
    const customerManifest = {
      schemaVersion: 1, id: 'prj_1', name: 'Acme', canonicalName: 'acme', vendor: VENDOR,
      scenes: [{ id: 'own', path: 'scenes/mine.scene.json' }], somethingWeNeverHeardOf: 42,
    };
    write(join(clone, 'projects/acme/project.json'), JSON.stringify(customerManifest, null, 2) + '\n');
    commit(clone, 'customer manifest');

    const stagedV2 = stage(root, 'staged-v2', {
      ...V1,
      'projects/acme/project.json': JSON.stringify({
        schemaVersion: 2, id: 'prj_1', name: 'Acme', canonicalName: 'acme',
        vendor: { managed: ['models/**'], handover: [] },
      }, null, 2) + '\n',
    }, '2.0.0');
    applyMergedSnapshot(stagedV2, clone, { projects: [{ key: 'acme', vendor: VENDOR }], version: '2.0.0' });

    const merged = JSON.parse(readFileSync(join(clone, 'projects/acme/project.json'), 'utf8'));
    expect(merged.schemaVersion).toBe(2);                    // the schema-update channel
    expect(merged.vendor).toEqual({ managed: ['models/**'], handover: [] });
    expect(merged.scenes).toEqual(customerManifest.scenes);  // customer field, untouched
    expect(merged.somethingWeNeverHeardOf).toBe(42);         // plan-370 rule R3
  });

  it('does not merge an unreadable customer project.json, it parks ours beside it', () => {
    const root = sandbox();
    const { clone } = seededClone(root);
    write(join(clone, 'projects/acme/project.json'), '{ this is not json');
    commit(clone, 'customer broke the manifest');

    const snapshot = applyMergedSnapshot(stage(root, 'staged-v2', V1, '2.0.0'), clone,
      { projects: [{ key: 'acme', vendor: VENDOR }], version: '2.0.0' });

    expect(readFileSync(join(clone, 'projects/acme/project.json'), 'utf8')).toBe('{ this is not json');
    expect(existsSync(join(clone, 'projects/acme/project.vendor-2.0.0.json'))).toBe(true);
    expect(snapshot.projects.acme.conflicts).toContainEqual(expect.objectContaining({ path: 'project.json' }));
  });

  it('asks instead of creating when a delivered repository has no baseline tag', () => {
    const root = sandbox();
    // A customer from before plan-700: content, but no delivery tag. Here "we never
    // sent it" and "they deleted it" are indistinguishable, so nothing is created.
    const { clone } = seededClone(root);
    git(clone, 'tag', '-d', 'delivery/1.0.0');
    rmSync(join(clone, 'projects/acme/models/machine.glb'));
    write(join(clone, 'projects/acme/docs/manual.md'), 'customer manual\n');
    commit(clone, 'pre-plan-700 state');

    const stagedV2 = stage(root, 'staged-v2', { ...V1, 'projects/acme/docs/manual.md': 'manual v2\n' }, '2.0.0');
    const snapshot = applyMergedSnapshot(stagedV2, clone, { projects: [{ key: 'acme', vendor: VENDOR }], version: '2.0.0' });

    expect(snapshot.baselineTag).toBeNull();
    expect(existsSync(join(clone, 'projects/acme/models/machine.glb'))).toBe(false);
    expect(snapshot.projects.acme.addPending).toContain('models/machine.glb');
    // Present on both sides and different: without a basis we cannot tell who changed
    // it, so we do not touch it.
    expect(readFileSync(join(clone, 'projects/acme/docs/manual.md'), 'utf8')).toBe('customer manual\n');
    expect(readFileSync(join(clone, 'DELIVERY-REPORT.md'), 'utf8')).toContain('Fehlt bei Ihnen');
  });

  it('creates the missing files only when a human passes seedMissing', () => {
    const root = sandbox();
    const { clone } = seededClone(root);
    git(clone, 'tag', '-d', 'delivery/1.0.0');
    rmSync(join(clone, 'projects/acme/models/machine.glb'));
    commit(clone, 'pre-plan-700 state');

    applyMergedSnapshot(stage(root, 'staged-v2', V1, '2.0.0'), clone,
      { projects: [{ key: 'acme', vendor: VENDOR }], version: '2.0.0', seedMissing: true });
    expect(existsSync(join(clone, 'projects/acme/models/machine.glb'))).toBe(true);
  });

  it('merges several projects in one repository and reports each of them', () => {
    const root = sandbox();
    const twoProjects: Record<string, string> = { ...V1 };
    for (const [path, text] of Object.entries(V1)) {
      if (path.startsWith('projects/acme/')) twoProjects[path.replace('/acme/', '/acme-line2/')] = text;
    }
    const stagedV1 = stage(root, 'staged-v1', twoProjects, '1.0.0');
    const clone = emptyClone(root);
    const projects = [{ key: 'acme', vendor: VENDOR }, { key: 'acme-line2', vendor: VENDOR }];
    applyMergedSnapshot(stagedV1, clone, { projects, version: '1.0.0' });
    commit(clone, 'delivery 1');
    git(clone, 'tag', 'delivery/1.0.0');

    for (const key of ['acme', 'acme-line2']) {
      write(join(clone, 'projects/' + key + '/connect/project-config.json'), '{"poll":250}\n');
      write(join(clone, 'projects/' + key + '/scenes/mine.scene.json'), '{"scene":"' + key + '"}\n');
    }
    commit(clone, 'customer work in both projects');

    const stagedV2Files: Record<string, string> = { ...twoProjects };
    for (const key of ['acme', 'acme-line2']) {
      stagedV2Files['projects/' + key + '/connect/project-config.json'] = '{"poll":500}\n';
    }
    const snapshot = applyMergedSnapshot(stage(root, 'staged-v2', stagedV2Files, '2.0.0'), clone, { projects, version: '2.0.0' });

    for (const key of ['acme', 'acme-line2']) {
      expect(snapshot.projects[key].conflicts).toHaveLength(1);
      expect(readFileSync(join(clone, 'projects/' + key + '/connect/project-config.json'), 'utf8')).toBe('{"poll":250}\n');
      expect(readFileSync(join(clone, 'projects/' + key + '/scenes/mine.scene.json'), 'utf8')).toBe('{"scene":"' + key + '"}\n');
    }
    const report = readFileSync(join(clone, 'DELIVERY-REPORT.md'), 'utf8');
    expect(report).toContain('| acme |');
    expect(report).toContain('| acme-line2 |');
  });

  it('leaves a foreign project in the same repository completely alone', () => {
    const root = sandbox();
    const { clone } = seededClone(root);
    write(join(clone, 'projects/not-ours/models/theirs.glb'), 'not our business');
    commit(clone, 'another project');

    applyMergedSnapshot(stage(root, 'staged-v2', V1, '2.0.0'), clone, { projects: [{ key: 'acme', vendor: VENDOR }], version: '2.0.0' });
    expect(readFileSync(join(clone, 'projects/not-ours/models/theirs.glb'), 'utf8')).toBe('not our business');
  });

  it('refuses to run on anything but a clean, freshly cloned working tree', () => {
    const root = sandbox();
    const { clone } = seededClone(root);
    // An uncommitted local file. On a working checkout the zone-A loop would delete
    // it, and the customer-side blob map would describe a tree nobody delivered (R2-6).
    write(join(clone, 'work-in-progress.txt'), 'not committed');
    expect(() => applyMergedSnapshot(stage(root, 'staged-v2', V1, '2.0.0'), clone,
      { projects: [{ key: 'acme', vendor: VENDOR }], version: '2.0.0' })).toThrow(/clean, freshly cloned/);
    expect(readFileSync(join(clone, 'work-in-progress.txt'), 'utf8')).toBe('not committed');

    const noRepo = join(root, 'no-repo');
    mkdirSync(noRepo, { recursive: true });
    expect(() => applyMergedSnapshot(stage(root, 'staged-v3', V1, '3.0.0'), noRepo,
      { projects: [{ key: 'acme', vendor: VENDOR }], version: '2.0.0' })).toThrow(/no .git/);
  });

  it('honours vendor.handover: a path inside a managed glob stays customer-owned', () => {
    const root = sandbox();
    const files = { ...V1, 'projects/acme/models/custom/theirs.glb': 'customer model v1' };
    const { clone } = seededClone(root, '1.0.0', files);
    write(join(clone, 'projects/acme/models/custom/theirs.glb'), 'customer model edited');
    commit(clone, 'customer edited their own model');

    const stagedV2 = stage(root, 'staged-v2', { ...files, 'projects/acme/models/custom/theirs.glb': 'vendor would overwrite' }, '2.0.0');
    const snapshot = applyMergedSnapshot(stagedV2, clone, { projects: [{ key: 'acme', vendor: VENDOR }], version: '2.0.0' });

    expect(readFileSync(join(clone, 'projects/acme/models/custom/theirs.glb'), 'utf8')).toBe('customer model edited');
    expect(snapshot.projects.acme.conflicts).toHaveLength(0);
  });
});
