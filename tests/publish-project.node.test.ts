// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * publish-project.node.test.ts — plan-604 §5.
 *
 * The publish path a DELIVERED workspace carries. Two things are worth a test here, and
 * the second one is the point of the plan:
 *
 *   1. the CLI's own decisions (arguments, project lookup, upload order, printed URL),
 *   2. that this path does not reach into internal tooling. A single import of
 *      `_workspace-lib.mjs` or `_rv-customers.mjs` would put the customer register and
 *      the delivery/tier machinery — material describing OTHER customers' arrangements —
 *      into every delivered workspace. That is not a style question, so it is a test and
 *      not a review habit.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  changedProjectDocuments,
  loadDotEnv,
  orderForUpload,
  parsePublishArguments,
  pickProject,
  publishedUrl,
  resolveProjectsDir,
} from '../scripts/publish-project.mjs';

const SCRIPTS = resolve(__dirname, '..', 'scripts');
const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function fixtureProjects(names: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'rv-publish-'));
  temporary.push(root);
  const projects = join(root, 'projects');
  for (const name of names) {
    mkdirSync(join(projects, name), { recursive: true });
    writeFileSync(join(projects, name, 'project.json'), JSON.stringify({
      schemaVersion: 2, kind: 'customer', name, code: `${name.toLowerCase()}00000000000000000000000000`.slice(0, 32),
    }));
  }
  return projects;
}

describe('arguments', () => {
  it('reads the project, the flags and refuses an unknown one', () => {
    expect(parsePublishArguments(['--project', 'My Line'])).toMatchObject({
      help: false, list: false, project: 'My Line', build: true, dryRun: false, force: false,
    });
    expect(parsePublishArguments(['--list'])).toMatchObject({ list: true });
    expect(parsePublishArguments(['--project', 'X', '--no-build', '--dry-run', '--force']))
      .toMatchObject({ build: false, dryRun: true, force: true });
    expect(parsePublishArguments([])).toMatchObject({ help: true });
    expect(() => parsePublishArguments(['--publish'])).toThrow(/Unknown argument/);
    expect(() => parsePublishArguments(['--project'])).toThrow(/requires a value/);
    // a value that looks like a flag is a missing value, not a project called "--force"
    expect(() => parsePublishArguments(['--project', '--force'])).toThrow(/requires a value/);
  });
});

describe('credentials from .env', () => {
  it('reads this folder AND the workspace root, and never overrides a real shell value', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'rv-publish-env-'));
    temporary.push(workspace);
    const core = join(workspace, 'realvirtual-web');
    mkdirSync(core, { recursive: true });
    // the root is where someone who received a workspace actually puts credentials …
    writeFileSync(join(workspace, '.env'), 'BUNNY_STORAGE_ZONE=from-root\nBUNNY_STORAGE_KEY=root-key\n');
    // … and this folder wins over it, because it is the more specific of the two
    writeFileSync(join(core, '.env'), 'BUNNY_STORAGE_ZONE=from-core\n');

    const env: Record<string, string | undefined> = { BUNNY_REGION: 'storage.bunnycdn.com' };
    loadDotEnv(core, env);

    expect(env.BUNNY_STORAGE_ZONE).toBe('from-core');
    expect(env.BUNNY_STORAGE_KEY).toBe('root-key');
    // a value that was already there is left alone
    expect(env.BUNNY_REGION).toBe('storage.bunnycdn.com');
  });
});

describe('project lookup', () => {
  it('prefers the projects folder BESIDE the workspace, which is where a delivery puts it', () => {
    const projects = fixtureProjects(['Line1']);
    const workspace = dirname(projects);
    const viewer = join(workspace, 'realvirtual-web');
    mkdirSync(viewer, { recursive: true });
    expect(resolveProjectsDir({ root: viewer, env: {} })).toBe(projects);
    // explicit wins over both candidates
    expect(resolveProjectsDir({ root: viewer, env: { PROJECTS_DIR: projects } })).toBe(projects);
  });

  it('matches a project by name or folder, case-insensitively, and names the alternatives', () => {
    const entries = [
      { project: { name: 'My Line', code: 'a'.repeat(32) }, folderName: 'myline', projectDir: 'x' },
      { project: { name: 'Second', code: 'b'.repeat(32) }, folderName: 'second', projectDir: 'y' },
    ] as any[];
    expect(pickProject(entries, 'my line').project.name).toBe('My Line');
    expect(pickProject(entries, 'MYLINE').project.name).toBe('My Line');
    expect(() => pickProject(entries, 'Third')).toThrow(/This workspace has: "My Line", "Second"/);
    expect(() => pickProject([], 'Third')).toThrow(/\(none\)/);
  });
});

describe('upload order (the one contract shared with the internal pipeline)', () => {
  it('sends the project first and index.html last', () => {
    const files = [
      'index.html', 'assets/app-123.js', 'settings.json', 'p/project.json',
      'library/project.json', 'viewer.html', 'p/models/line.glb',
    ].map((rel) => ({ rel, size: 1, abs: rel }));

    expect(orderForUpload(files).map((file) => file.rel)).toEqual([
      'p/project.json',
      'p/models/line.glb',
      'assets/app-123.js',
      'settings.json',
      'library/project.json',
      'viewer.html',
      'index.html',
    ]);
  });
});

describe('what counts as a changed model (the model-only publish)', () => {
  const live = { documents: [
    { path: 'Machine.glb', sha256: 'aaa' },
    { path: 'Robot.glb', sha256: 'bbb' },
  ] };

  it('forces exactly the document whose sha256 moved, even at identical size', () => {
    const next = { documents: [
      { path: 'Machine.glb', sha256: 'aaa' },
      { path: 'Robot.glb', sha256: 'ccc' },
    ] };
    expect(changedProjectDocuments(JSON.stringify(next), JSON.stringify(live)))
      .toEqual(['p/Robot.glb']);
  });

  it('forces nothing when every hash matches — that is the fast publish', () => {
    expect(changedProjectDocuments(JSON.stringify(live), JSON.stringify(live))).toEqual([]);
  });

  it('forces everything on a first publish, an unparsable remote manifest or a missing hash', () => {
    expect(changedProjectDocuments(JSON.stringify(live), null))
      .toEqual(['p/Machine.glb', 'p/Robot.glb']);
    expect(changedProjectDocuments(JSON.stringify(live), 'not json'))
      .toEqual(['p/Machine.glb', 'p/Robot.glb']);
    const unhashed = { documents: [{ path: 'Machine.glb' }] };
    expect(changedProjectDocuments(JSON.stringify(unhashed), JSON.stringify(live)))
      .toEqual(['p/Machine.glb']);
  });

  it('normalises the manifest path into the staged rel', () => {
    const windowsish = { documents: [{ path: './sub/Machine.glb', sha256: 'zzz' }] };
    expect(changedProjectDocuments(JSON.stringify(windowsish), JSON.stringify(live)))
      .toEqual(['p/sub/Machine.glb']);
    expect(changedProjectDocuments('not json', JSON.stringify(live))).toEqual([]);
  });
});

describe('printed URL', () => {
  it('uses the configured hostname, and Bunny\'s own when there is none', () => {
    const code = 'c'.repeat(32);
    expect(publishedUrl(code, { zone: 'rv-partner-x', env: { RV_PUBLIC_BASE_URL: 'https://x.web.realvirtual.io/' } }))
      .toBe(`https://x.web.realvirtual.io/${code}/`);
    // no hostname configured: name where the files REALLY are rather than someone else's domain
    expect(publishedUrl(code, { zone: 'rv-partner-x', env: {} }))
      .toBe(`https://rv-partner-x.b-cdn.net/${code}/`);
  });
});

describe('the delivered publish path stays out of internal tooling', () => {
  const FORBIDDEN = ['_workspace-lib.mjs', '_rv-customers.mjs', 'bunny-deploy.mjs', 'rv-demo-smoke.mjs', 'rv-publish-lock.mjs'];
  const SPECIFIER = /\b(?:from|import)\s*\(?\s*['"](\.\.?\/[^'"]+)['"]/g;

  function closure(entry: string): string[] {
    const seen = new Set<string>();
    const queue = [entry];
    while (queue.length) {
      const rel = queue.shift()!;
      if (seen.has(rel)) continue;
      seen.add(rel);
      const source = readFileSync(join(SCRIPTS, rel), 'utf8');
      for (const match of source.matchAll(SPECIFIER)) {
        queue.push(posix.normalize(posix.join(posix.dirname(rel), match[1])));
      }
    }
    return [...seen];
  }

  it('imports neither the customer register nor the delivery machinery', () => {
    const files = closure('publish-project.mjs');
    expect(files).toContain('_bunny-lib.mjs'); // the staging + client contract IS shared
    for (const forbidden of FORBIDDEN) {
      expect(files, `${forbidden} must not be reachable from the delivered publish path`)
        .not.toContain(forbidden);
    }
  });

  it('every file it does import is staged into the workspace', () => {
    const lib = readFileSync(join(SCRIPTS, '_workspace-lib.mjs'), 'utf8');
    const listed = lib.slice(lib.indexOf('const CORE_SCRIPT_FILES = ['), lib.indexOf('];', lib.indexOf('const CORE_SCRIPT_FILES = [')));
    for (const rel of closure('publish-project.mjs')) {
      // plan-778: a `scripts → src` edge (the shared library-trim core) is delivered with
      // src/, which the staging copies wholesale — it is never a CORE_SCRIPT_FILES entry.
      // It must exist, and the 'scripts → src edges' test in bunny-deploy.node pins it as
      // self-contained.
      if (rel.startsWith('../src/')) {
        expect(existsSync(join(SCRIPTS, rel)), `${rel} is imported by the publish path but missing`).toBe(true);
        continue;
      }
      expect(listed, `${rel} is imported by the publish path but not in CORE_SCRIPT_FILES`)
        .toContain(`'${rel}'`);
    }
  });
});
