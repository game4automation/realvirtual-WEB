// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * applySnapshot — the delivery path that writes into a customer repository
 * (plan-738 §2.4).
 *
 * The predecessor of this file (`merged-snapshot.node.test.ts`) tested a
 * three-way merge that no longer exists. The rule it replaces is territorial and
 * fits in one sentence — we deliver the application, `projects/` belongs to the
 * customer — so the cases here are about the BOUNDARY, not about file contents:
 * what crosses it, what never does, and what a human has to name explicitly
 * before anything under `projects/` is written at all.
 *
 * Every case drives real `git init` / `add` / `commit` / `tag` in a sandbox.
 * That is deliberate: the first-delivery decision reads `git tag -l 'delivery/*'`
 * out of the clone (§2.4.5), so a faked repository would test nothing.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { applySnapshot, resolveRequestedProjects } from '../scripts/_workspace-lib.mjs';

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

/**
 * Builds a staging tree in the shape `stageFilteredSourceTree` produces.
 *
 * Rewritten for v3 rather than reused from `merged-snapshot.node.test.ts`: the
 * old one hard-coded a v2 manifest with a `vendorGlobs` block per project, which
 * is exactly the shape this plan removed. No `git init` here either — v2 needed
 * the staged index to read blob OIDs for the merge; a snapshot copies files.
 */
function stage(root: string, name: string, files: Record<string, string>, version = '1.0.0'): string {
  const staged = join(root, name);
  write(join(staged, 'delivery-manifest.json'),
    JSON.stringify({ manifestVersion: 3, baselineTag: 'delivery/' + version, projects: {} }, null, 2));
  for (const [path, text] of Object.entries(files)) write(join(staged, path), text);
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
  const root = mkdtempSync(join(tmpdir(), 'rv-apply-snapshot-'));
  temporary.push(root);
  return root;
}

//! Byte snapshot of a tree, keyed by POSIX-relative path — the evidence for
//! every "untouched" claim below.
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
  'projects/acme/project.json': '{"canonicalName":"acme"}\n',
  'projects/acme/models/machine.glb': 'model-v1',
  'projects/acme/docs/manual.md': 'manual v1\n',
  'projects/demo-realvirtual/project.json': '{"canonicalName":"demo-realvirtual"}\n',
  'projects/demo-realvirtual/models/demo.glb': 'demo-v1',
};

const V2: Record<string, string> = {
  'realvirtual-web/src/main.ts': 'export const version = 2;\n',
  'projects/acme/project.json': '{"canonicalName":"acme"}\n',
  'projects/acme/models/machine.glb': 'model-v2',
  // manual.md is deliberately ABSENT in v2: an exact snapshot must remove it.
  'projects/demo-realvirtual/project.json': '{"canonicalName":"demo-realvirtual"}\n',
  'projects/demo-realvirtual/models/demo.glb': 'demo-v2',
};

//! First delivery + commit + baseline tag: the state every "second delivery"
//! case starts from, and the only way to make `firstDelivery` false.
function seededClone(root: string, version = '1.0.0', files: Record<string, string> = V1) {
  const staged = stage(root, 'staged-v1', files, version);
  const clone = emptyClone(root);
  applySnapshot(staged, clone, { version, log: () => {} });
  commit(clone, 'delivery 1');
  git(clone, 'tag', 'delivery/' + version);
  return { clone, staged };
}

const QUIET = { log: () => {} };

// Git process spawns dominate every case here and cost seconds on Windows.
describe('applySnapshot', { timeout: 60000 }, () => {
  // ── T1 ────────────────────────────────────────────────────────────────
  it('T1: replaces the core in full and does not touch projects/', () => {
    const root = sandbox();
    const { clone } = seededClone(root);

    // What the customer has: an edit in the core (which we own) and a project of
    // their own (which we do not).
    write(join(clone, 'realvirtual-web', 'src', 'main.ts'), 'export const mine = true;\n');
    write(join(clone, 'realvirtual-web', 'stray.txt'), 'a file we never shipped\n');
    const own = {
      'projects/mymachine/project.json': '{"canonicalName":"mymachine"}\n',
      'projects/mymachine/models/mine.glb': 'never touch this',
    };
    for (const [rel, text] of Object.entries(own)) write(join(clone, rel), text);
    commit(clone, 'customer state');
    const ownBefore = bytes(join(clone, 'projects', 'mymachine'));

    const staged = stage(root, 'staged-v2', V2, '2.0.0');
    const summary = applySnapshot(staged, clone, { version: '2.0.0', ...QUIET });

    expect(summary.firstDelivery).toBe(false);
    // The core is ours: the edit is gone and so is the file we never shipped.
    expect(readFileSync(join(clone, 'realvirtual-web/src/main.ts'), 'utf8')).toBe('export const version = 2;\n');
    expect(existsSync(join(clone, 'realvirtual-web/stray.txt'))).toBe(false);
    // projects/ is theirs: byte-identical, and nothing was seeded or replaced.
    expect(bytes(join(clone, 'projects', 'mymachine'))).toEqual(ownBefore);
    expect(summary.seeded).toEqual([]);
    expect(summary.replaced).toEqual([]);
    // Our own project folder is equally untouched — it aged with the customer's.
    expect(readFileSync(join(clone, 'projects/acme/models/machine.glb'), 'utf8')).toBe('model-v1');
    expect(existsSync(join(clone, 'projects/acme/docs/manual.md'))).toBe(true);
  });

  // ── T2 ────────────────────────────────────────────────────────────────
  it('T2: seeds projects/ on a first delivery, and only then', () => {
    const root = sandbox();
    const staged = stage(root, 'staged', V1);

    // (a) Empty remote — no HEAD at all.
    const fresh = emptyClone(root, 'fresh');
    const first = applySnapshot(staged, fresh, { version: '1.0.0', ...QUIET });
    expect(first.remoteEmpty).toBe(true);
    expect(first.firstDelivery).toBe(true);
    expect(first.seeded).toEqual(['acme', 'demo-realvirtual']);
    expect(readFileSync(join(fresh, 'projects/acme/models/machine.glb'), 'utf8')).toBe('model-v1');

    // (b) A repository with history but NO delivery tag is still a first
    //     delivery: the tag is the evidence, not the commit.
    const untagged = emptyClone(root, 'untagged');
    write(join(untagged, 'README.md'), '# theirs\n');
    commit(untagged, 'customer state');
    expect(applySnapshot(staged, untagged, { version: '1.0.0', ...QUIET }).firstDelivery).toBe(true);

    // (c) With a delivery tag it is NOT, and projects/ stays byte-identical —
    //     including a vendor folder that is missing on their side entirely.
    const { clone } = seededClone(root, '1.0.0');
    rmSync(join(clone, 'projects', 'acme'), { recursive: true, force: true });
    commit(clone, 'customer deleted our project on purpose');
    const before = bytes(join(clone, 'projects'));
    const second = applySnapshot(stage(root, 'staged-v2', V2, '2.0.0'), clone, { version: '2.0.0', ...QUIET });
    expect(second.firstDelivery).toBe(false);
    expect(second.seeded).toEqual([]);
    // A folder they deleted stays deleted. "Seed what is missing" is exactly the
    // rule this plan refused (Alternative 2).
    expect(existsSync(join(clone, 'projects', 'acme'))).toBe(false);
    expect(bytes(join(clone, 'projects'))).toEqual(before);
  });

  // ── T3 ────────────────────────────────────────────────────────────────
  it('T3: the demo is generic — a second delivery leaves it exactly as it was', () => {
    const root = sandbox();
    const { clone } = seededClone(root);

    // The customer breaks the demo, which they are explicitly invited to do.
    write(join(clone, 'projects/demo-realvirtual/models/demo.glb'), 'I edited the demo');
    write(join(clone, 'projects/demo-realvirtual/notes.md'), 'my notes\n');
    commit(clone, 'played with the demo');
    const before = bytes(join(clone, 'projects', 'demo-realvirtual'));

    applySnapshot(stage(root, 'staged-v2', V2, '2.0.0'), clone, { version: '2.0.0', ...QUIET });

    // plan-737 F4 said "replaced in full every delivery". That rule is withdrawn:
    // the demo is a project under projects/ like any other.
    expect(bytes(join(clone, 'projects', 'demo-realvirtual'))).toEqual(before);
    expect(readFileSync(join(clone, 'projects/demo-realvirtual/models/demo.glb'), 'utf8')).toBe('I edited the demo');
  });

  // ── T4 ────────────────────────────────────────────────────────────────
  it('T4: --projects replaces a named folder as an EXACT snapshot', () => {
    const root = sandbox();
    const { clone } = seededClone(root);
    write(join(clone, 'projects/acme/models/machine.glb'), 'customer edit');
    write(join(clone, 'projects/acme/mine.txt'), 'a file of mine\n');
    commit(clone, 'customer state');
    const demoBefore = bytes(join(clone, 'projects', 'demo-realvirtual'));

    const summary = applySnapshot(stage(root, 'staged-v2', V2, '2.0.0'), clone,
      { version: '2.0.0', replaceProjects: ['acme'], ...QUIET });

    expect(summary.replaced).toEqual(['acme']);
    // Exact, in all three directions: ours wins, theirs goes, and a file we
    // stopped shipping is removed rather than left behind.
    expect(readFileSync(join(clone, 'projects/acme/models/machine.glb'), 'utf8')).toBe('model-v2');
    expect(existsSync(join(clone, 'projects/acme/mine.txt'))).toBe(false);
    expect(existsSync(join(clone, 'projects/acme/docs/manual.md'))).toBe(false);
    // The neighbouring folder is not collateral.
    expect(bytes(join(clone, 'projects', 'demo-realvirtual'))).toEqual(demoBefore);
  });

  it('T4: refuses an unknown name, and names the right spelling for a case-only miss', () => {
    // The Toray case: `Toray` is a project, `toray` is the customer slug, so
    // accepting either spelling would one day replace a folder nobody named.
    expect(() => resolveRequestedProjects(['toray'], ['Toray', 'acme']))
      .toThrow(/did you mean "Toray"\?/);
    expect(() => resolveRequestedProjects(['nope'], ['Toray', 'acme']))
      .toThrow(/unknown project "nope"/);
    expect(() => resolveRequestedProjects(['all', 'acme'], ['acme']))
      .toThrow(/cannot be combined/);

    // And at the snapshot level: a folder this delivery does not carry would be
    // "replaced" with nothing, i.e. deleted. It is refused BEFORE any deletion.
    const root = sandbox();
    const { clone } = seededClone(root);
    const before = bytes(clone);
    expect(() => applySnapshot(stage(root, 'staged-v2', V2, '2.0.0'), clone,
      { version: '2.0.0', replaceProjects: ['ghost'], ...QUIET }))
      .toThrow(/does not carry/);
    expect(bytes(clone)).toEqual(before);
  });

  // ── T-ALL / T-STD ─────────────────────────────────────────────────────
  it('T-ALL: "all" means our projects plus the demo, never a folder of theirs', () => {
    expect(resolveRequestedProjects(['all'], ['acme', 'Toray']))
      .toEqual(['Toray', 'acme', 'demo-realvirtual']);

    const root = sandbox();
    const { clone } = seededClone(root);
    write(join(clone, 'projects/mymachine/project.json'), '{"canonicalName":"mymachine"}\n');
    write(join(clone, 'projects/mymachine/models/mine.glb'), 'mine');
    commit(clone, 'customer built their own');
    const ownBefore = bytes(join(clone, 'projects', 'mymachine'));

    const staged = stage(root, 'staged-v2', V2, '2.0.0');
    const summary = applySnapshot(staged, clone, {
      version: '2.0.0',
      replaceProjects: resolveRequestedProjects(['all'], ['acme']),
      ...QUIET,
    });

    expect(summary.replaced).toEqual(['acme', 'demo-realvirtual']);
    expect(readFileSync(join(clone, 'projects/demo-realvirtual/models/demo.glb'), 'utf8')).toBe('demo-v2');
    // The whole point of the rule: no spelling of the flag reaches their folder.
    expect(bytes(join(clone, 'projects', 'mymachine'))).toEqual(ownBefore);
  });

  it('T-STD: "all" for a projectless standard customer is the demo alone, not an error', () => {
    expect(resolveRequestedProjects(['all'], [])).toEqual(['demo-realvirtual']);

    const root = sandbox();
    const demoOnly = { 'realvirtual-web/src/main.ts': 'export const version = 1;\n', ...{
      'projects/demo-realvirtual/project.json': '{"canonicalName":"demo-realvirtual"}\n',
      'projects/demo-realvirtual/models/demo.glb': 'demo-v1',
    } };
    const staged = stage(root, 'staged', demoOnly);
    const clone = emptyClone(root);
    applySnapshot(staged, clone, { version: '1.0.0', ...QUIET });
    commit(clone, 'delivery 1');
    git(clone, 'tag', 'delivery/1.0.0');

    const summary = applySnapshot(staged, clone, {
      version: '2.0.0', replaceProjects: resolveRequestedProjects(['all'], []), ...QUIET,
    });
    expect(summary.replaced).toEqual(['demo-realvirtual']);
  });

  it('warns and does nothing when --projects meets a FIRST delivery (§2.4.4)', () => {
    // Not an error on purpose: deliver-release runs across customers whose
    // repositories are in different states, and the seed writes everything anyway.
    const root = sandbox();
    const staged = stage(root, 'staged', V1);
    const fresh = emptyClone(root, 'fresh');
    const logged: string[] = [];
    const summary = applySnapshot(staged, fresh, {
      version: '1.0.0', replaceProjects: ['acme'], log: (line: string) => logged.push(line),
    });
    expect(summary.seeded).toEqual(['acme', 'demo-realvirtual']);
    expect(summary.replaced).toEqual([]);
    expect(logged.join('\n')).toMatch(/FIRST delivery/);
  });

  // ── T-SIDE ────────────────────────────────────────────────────────────
  it('T-SIDE: removes leftover .vendor-* sidecars, keeps the neighbours, no-ops twice', () => {
    const root = sandbox();
    const { clone } = seededClone(root);
    // What the pre-738 merge parked in customer territory. The core replace never
    // reaches these, because they sit under projects/.
    write(join(clone, 'projects/acme/models/machine.vendor-6.3.0.glb'), 'parked vendor copy');
    write(join(clone, 'projects/acme/connect/project-config.vendor-6.3.0.json'), '{"poll":50}\n');
    write(join(clone, 'projects/mymachine/notes.md'), '# mine\n');
    // Deliberately adjacent: a real file of theirs whose NAME merely resembles one.
    write(join(clone, 'projects/mymachine/my.vendor-notes.md'), 'not a sidecar\n');
    commit(clone, 'customer state with sidecars');

    const first = applySnapshot(stage(root, 'staged-v2', V2, '2.0.0'), clone, { version: '2.0.0', ...QUIET });
    expect(first.sidecarsRemoved).toEqual([
      'projects/acme/connect/project-config.vendor-6.3.0.json',
      'projects/acme/models/machine.vendor-6.3.0.glb',
    ]);
    expect(existsSync(join(clone, 'projects/acme/models/machine.vendor-6.3.0.glb'))).toBe(false);
    expect(readFileSync(join(clone, 'projects/mymachine/notes.md'), 'utf8')).toBe('# mine\n');
    // `.vendor-notes.md` has no version after `.vendor-`, so it is not a sidecar.
    expect(existsSync(join(clone, 'projects/mymachine/my.vendor-notes.md'))).toBe(true);

    commit(clone, 'delivery 2');
    git(clone, 'tag', 'delivery/2.0.0');
    // Standing safety net, not a migration state: the second run simply matches nothing.
    const second = applySnapshot(stage(root, 'staged-v3', V2, '3.0.0'), clone, { version: '3.0.0', ...QUIET });
    expect(second.sidecarsRemoved).toEqual([]);
  });

  it('refuses to run on anything but a clean, freshly cloned working tree', () => {
    const root = sandbox();
    const { clone } = seededClone(root);
    // An uncommitted file means this is not a fresh clone — and the core deletion
    // loop would take local work with it.
    write(join(clone, 'realvirtual-web', 'local-work.ts'), 'export const wip = 1;\n');
    expect(() => applySnapshot(stage(root, 'staged-v2', V2, '2.0.0'), clone, { version: '2.0.0', ...QUIET }))
      .toThrow(/clean, freshly cloned/);
  });
});
