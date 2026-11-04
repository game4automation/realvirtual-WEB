// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-778 9.15 — library projects in every delivery channel (F15, N1/N2, Imp 7/8).
 *
 * Trimming runs in the two SHARED stagers, so every channel inherits it:
 *  - `stageFilteredSourceTree` (customer workspace, private deploy staging, CONNECT
 *    embed staging, the public shells) writes `projects/<key>/libraries/<id>/`;
 *  - `stageHostedProject` (hosted deploy, partner publish, CONNECT embed) writes
 *    `p/libraries/<id>/` and publishes the app-level realvirtual library when the
 *    project needs it.
 * Library sources come from `--projects-dir` or `--library <id>=<folder>`; an
 * unresolvable id stops the delivery. The realvirtual library is never trimmed and
 * stays app-level `library/project.json`; nothing prunes `libraries/`.
 *
 * Runner: `npm run test:node`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { stageFilteredSourceTree } from '../scripts/_workspace-lib.mjs';
import {
  applyPublicModelAllowlist,
  findLibraryProjectFiles,
  isCatalogFile,
  publicDemoManifestMisses,
  stageHostedProject,
  stampCatalogHashes,
} from '../scripts/_bunny-lib.mjs';
import { LibraryTrimError, librarySourceArgv, parseLibrarySourceArgs } from '../scripts/lib/rv-library-trim.mjs';
import { makeDist } from './helpers/make-dist';
import {
  EXPECTED_TRIM,
  FIXTURE_FOLDERS,
  FIXTURE_IDS,
  buildLibraryTrimFixture,
  type FixtureFiles,
} from './fixtures/library-trim/library-trim-fixture';


const write = (path: string, text: string | Uint8Array) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

function writeProject(dir: string, files: FixtureFiles): string {
  for (const [rel, bytes] of files) write(join(dir, ...rel.split('/')), bytes);
  return dir;
}

/** The realvirtual library as the core tree ships it (two docs; the project uses one). */
const REALVIRTUAL_LIBRARY = {
  schemaVersion: 2, id: 'prj_realvirtual_library', name: 'realvirtual Library', kind: 'demo',
  documents: [
    { id: 'pallethandling-chainconveyor-1m', name: 'Chain Conveyor 1m', path: 'PalletHandling/ChainConveyor-1m.glb', thumbnail: 'PalletHandling/.thumbnails/pallethandling-chainconveyor-1m.0a0b0c0d.webp' },
    { id: 'pallethandling-europallet', name: 'Europallet', path: 'PalletHandling/Europallet.glb', aliases: ['realvirtual-library-pallethandling-europallet-glb'] },
    { id: 'robots-irb', name: 'IRB', path: 'Robots/Irb.glb' },
  ],
};

/** A minimal core + private tree that `stageFilteredSourceTree` accepts. */
function stagingFixture(root: string) {
  const core = join(root, 'core');
  const privateRoot = join(root, 'private');
  write(join(core, 'src', 'main.ts'), 'export {};');
  // copyCore() requires the static recipes of the real core tree.
  for (const name of ['kinematize-cad-import.md']) write(join(core, 'recipes', name), `# ${name} fixture\n`);
  write(join(core, 'src', 'plugins', 'layout-planner', 'index.ts'), 'export const LayoutPlannerPlugin = null;');
  write(join(core, 'public', 'settings.json'), '{}');
  write(join(core, 'public', 'demo-realvirtual', 'project.json'), JSON.stringify({
    schemaVersion: 2, id: 'prj_sample', name: 'DemoRealvirtual', kind: 'demo',
    documents: [{ id: 'doc_a', name: 'Demo', path: 'DemoRealvirtualWeb.glb' }],
    libraries: [{ projectId: 'prj_realvirtual_library', label: 'realvirtual Library', hint: 'library/project.json' }],
  }));
  write(join(core, 'public', 'demo-realvirtual', 'DemoRealvirtualWeb.glb'), 'fixture:demo-glb');
  write(join(core, 'public', 'library', 'project.json'), JSON.stringify(REALVIRTUAL_LIBRARY));
  write(join(core, 'public', 'library', 'PalletHandling', 'ChainConveyor-1m.glb'), 'fixture:chain');
  write(join(core, 'public', 'library', 'PalletHandling', 'Europallet.glb'), 'fixture:pallet');
  write(join(core, 'public', 'library', 'PalletHandling', '.thumbnails', 'pallethandling-chainconveyor-1m.0a0b0c0d.webp'), 'webp');
  write(join(core, 'public', 'library', 'Robots', 'Irb.glb'), 'fixture:robot');   // not a delivered category
  write(join(core, 'package.json'), '{"name":"core","version":"1.0.0"}');
  write(join(core, 'package-lock.json'), '{"lockfileVersion":3}');
  write(join(core, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: {} } }));
  write(join(privateRoot, 'package.json'), '{"name":"private","version":"1.0.0","dependencies":{}}');
  write(join(privateRoot, 'package-lock.json'), JSON.stringify({
    name: 'private', version: '1.0.0', lockfileVersion: 3, requires: true,
    packages: { '': { name: 'private', version: '1.0.0', dependencies: {} } },
  }));
  write(join(privateRoot, 'tier-manifest.json'), JSON.stringify({ defaults: 'internal', rules: [], registrations: {} }));
  write(join(privateRoot, 'src', 'commercial', 'safe.ts'), 'export const safe = true;');
  const fx = buildLibraryTrimFixture();
  writeProject(join(privateRoot, 'projects', FIXTURE_FOLDERS.a), fx.a);
  writeProject(join(privateRoot, 'projects', FIXTURE_FOLDERS.b), fx.b);
  writeProject(join(privateRoot, 'projects', FIXTURE_FOLDERS.c), fx.c);
  const delivery = {
    project: 'PlantA', tier: 'commercial' as const, restrictedFeatures: [] as string[], remote: 'git@example.invalid:plant.git',
    mirror: null, connectChannel: 'stable' as const, projectKey: FIXTURE_FOLDERS.a,
  };
  return { core, privateRoot, delivery, fx };
}

function stage(fixture: ReturnType<typeof stagingFixture>, extra: Record<string, unknown> = {}) {
  return stageFilteredSourceTree({
    coreRoot: fixture.core,
    privateRoot: fixture.privateRoot,
    projectKey: FIXTURE_FOLDERS.a,
    projectKeys: [FIXTURE_FOLDERS.a],
    delivery: fixture.delivery,
    profile: fixture.delivery,
    workspaceFiles: false,
    ...extra,
  });
}

function expectTrimmed(projectRoot: string) {
  for (const id of [FIXTURE_IDS.b, FIXTURE_IDS.c] as const) {
    const manifest = readJson(join(projectRoot, 'libraries', id, 'project.json'));
    expect(manifest.id).toBe(id);
    expect(manifest.documents.map((d: { id: string }) => d.id)).toEqual(EXPECTED_TRIM[id]);
  }
  expect(readdirSync(join(projectRoot, 'libraries')).sort()).toEqual([FIXTURE_IDS.b, FIXTURE_IDS.c]);
  const a = readJson(join(projectRoot, 'project.json'));
  expect(a.libraries[0].hint).toBe(`libraries/${FIXTURE_IDS.b}/project.json`);
  expect(a.libraries[1]).toEqual({ projectId: 'prj_realvirtual_library', label: 'realvirtual Library' });
}

describe('library delivery — customer / private staging (plan-778 9.15)', () => {
  let work: string;
  const staged: string[] = [];
  beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'rv-library-delivery-')); });
  afterEach(() => {
    for (const dir of staged.splice(0)) rmSync(dir, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  it('writes projects/<key>/libraries/<id>/ found by id in the private projects/ (default source)', () => {
    const fixture = stagingFixture(work);
    const result = stage(fixture);
    staged.push(result.workspaceRoot);
    const project = join(result.workspaceRoot, 'projects', FIXTURE_FOLDERS.a);
    expectTrimmed(project);
    // The library projects are NOT delivered as projects of their own.
    expect(existsSync(join(result.workspaceRoot, 'projects', FIXTURE_FOLDERS.b))).toBe(false);
    // The source project is untouched.
    expect(readJson(join(fixture.privateRoot, 'projects', FIXTURE_FOLDERS.a, 'project.json')).libraries[0].hint).toBe('SharedConveyors');
  });

  it('ships the realvirtual library app-level as library/project.json — untrimmed, curated by category only', () => {
    const fixture = stagingFixture(work);
    const result = stage(fixture);
    staged.push(result.workspaceRoot);
    const library = join(result.coreRoot, 'public', 'library');
    const manifest = readJson(join(library, 'project.json'));
    expect(manifest.id).toBe('prj_realvirtual_library');
    // Both delivered-category documents, although the project uses only one: no per-project trim.
    expect(manifest.documents.map((d: { id: string }) => d.id)).toEqual(['pallethandling-chainconveyor-1m', 'pallethandling-europallet']);
    expect(manifest.documents[1].aliases).toEqual(['realvirtual-library-pallethandling-europallet-glb']);
    expect(existsSync(join(library, 'PalletHandling', '.thumbnails', 'pallethandling-chainconveyor-1m.0a0b0c0d.webp'))).toBe(true);
    // …and it is not ALSO shipped as a trimmed copy beside the project.
    expect(existsSync(join(result.workspaceRoot, 'projects', FIXTURE_FOLDERS.a, 'libraries', 'prj_realvirtual_library'))).toBe(false);
  });

  it('library sources from an explicit projects dir and from --library <id>=<folder>', () => {
    const fixture = stagingFixture(work);
    const elsewhere = join(work, 'elsewhere');
    cpSync(join(fixture.privateRoot, 'projects', FIXTURE_FOLDERS.b), join(elsewhere, 'B'), { recursive: true });
    cpSync(join(fixture.privateRoot, 'projects', FIXTURE_FOLDERS.c), join(work, 'loose-c'), { recursive: true });
    rmSync(join(fixture.privateRoot, 'projects', FIXTURE_FOLDERS.b), { recursive: true });
    rmSync(join(fixture.privateRoot, 'projects', FIXTURE_FOLDERS.c), { recursive: true });

    const sources = parseLibrarySourceArgs(['--projects-dir', elsewhere, '--library', `${FIXTURE_IDS.c}=${join(work, 'loose-c')}`]);
    // The argv a channel hands to its child (deliver.mjs → generator, CONNECT → stagers) round-trips.
    expect(parseLibrarySourceArgs(librarySourceArgv(sources))).toEqual({ projectsDir: resolve(elsewhere), libraries: { [FIXTURE_IDS.c]: resolve(work, 'loose-c') } });
    const result = stage(fixture, { librarySources: sources });
    staged.push(result.workspaceRoot);
    expectTrimmed(join(result.workspaceRoot, 'projects', FIXTURE_FOLDERS.a));
  });

  it('an unresolvable library id fails the staging (exit 1) and leaves no staging dir behind', () => {
    const fixture = stagingFixture(work);
    rmSync(join(fixture.privateRoot, 'projects', FIXTURE_FOLDERS.c), { recursive: true });
    // A private temp root: other test files stage into the shared one in parallel
    // (pool 'forks' — this env override is this process's own).
    const ownTmp = join(work, 'tmp');
    mkdirSync(ownTmp, { recursive: true });
    const saved = { TMP: process.env.TMP, TEMP: process.env.TEMP, TMPDIR: process.env.TMPDIR };
    process.env.TMP = ownTmp; process.env.TEMP = ownTmp; process.env.TMPDIR = ownTmp;
    let caught: unknown = null;
    try {
      expect(tmpdir()).toBe(ownTmp);
      try { staged.push(stage(fixture).workspaceRoot); } catch (error) { caught = error; }
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
    expect(caught).toBeInstanceOf(LibraryTrimError);
    expect((caught as Error).message).toMatch(new RegExp(`Library "${FIXTURE_IDS.c}" \\(needed by ${FIXTURE_IDS.b}\\)`));
    expect(readdirSync(ownTmp).filter((n) => n.startsWith('rv-customer-workspace-'))).toEqual([]);
  });

  it('the public shell staging (core profile, -Public) keeps the app-level /library/ project', () => {
    const fixture = stagingFixture(work);
    const result = stageFilteredSourceTree({
      coreRoot: fixture.core, privateRoot: fixture.privateRoot,
      profile: { tier: 'core', restrictedFeatures: [] }, includePublicDemoContent: false,
    });
    staged.push(result.workspaceRoot);
    expect(readJson(join(result.coreRoot, 'public', 'library', 'project.json')).id).toBe('prj_realvirtual_library');
    // (That the CONNECT -Public shell never strips library/ again is pinned in
    // library-delivery-connect.node.test.ts.)
  });
});

describe('library delivery — hosted staging (plan-778 9.15)', () => {
  let work: string;
  const staged: string[] = [];
  beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'rv-library-hosted-')); });
  afterEach(() => {
    for (const dir of staged.splice(0)) rmSync(dir, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  function hostedFixture() {
    const projectsDir = join(work, 'projects');
    const fx = buildLibraryTrimFixture();
    writeProject(join(projectsDir, FIXTURE_FOLDERS.a), fx.a);
    writeProject(join(projectsDir, FIXTURE_FOLDERS.b), fx.b);
    writeProject(join(projectsDir, FIXTURE_FOLDERS.c), fx.c);
    // stageHostedProject needs a code + canonical name.
    const aPath = join(projectsDir, FIXTURE_FOLDERS.a, 'project.json');
    writeFileSync(aPath, JSON.stringify({ ...readJson(aPath), code: 'deadbeefdeadbeefdeadbeefdeadbeef' }, null, 2));
    const dist = makeDist(join(work, 'dist'));
    writeFileSync(join(dist, 'library', 'project.json'), JSON.stringify(REALVIRTUAL_LIBRARY));
    return { projectsDir, dist, projectDir: join(projectsDir, FIXTURE_FOLDERS.a) };
  }

  it('writes p/libraries/<id>/, publishes the app-level library the project needs, untrimmed', async () => {
    const { projectsDir, dist, projectDir } = hostedFixture();
    let report: Record<string, unknown> | null = null;
    const staging = await stageHostedProject({
      distDir: dist, projectDir, librarySources: { projectsDir }, onReport: (r) => { report = r as unknown as Record<string, unknown>; },
    });
    staged.push(staging);
    expectTrimmed(join(staging, 'p'));
    expect(report!.libraries).toEqual([FIXTURE_IDS.b, FIXTURE_IDS.c]);
    expect(report!.realvirtualLibrary).toBe(true);
    // app-level, byte-identical to the build's — not trimmed to the one document the project uses
    expect(readFileSync(join(staging, 'library', 'project.json'), 'utf8')).toBe(readFileSync(join(dist, 'library', 'project.json'), 'utf8'));
    expect(existsSync(join(staging, 'p', 'libraries', 'prj_realvirtual_library'))).toBe(false);
  });

  it('a project without the realvirtual library keeps the plan-759 layout (no library/)', async () => {
    const { projectsDir, dist, projectDir } = hostedFixture();
    const aPath = join(projectDir, 'project.json');
    const a = readJson(aPath);
    a.libraries = a.libraries.filter((l: { projectId: string }) => l.projectId !== 'prj_realvirtual_library');
    writeFileSync(aPath, JSON.stringify(a));
    // drop the realvirtual placements from plant.glb by giving A a document without refs
    writeFileSync(join(projectDir, 'plant.glb'), readFileSync(join(projectsDir, FIXTURE_FOLDERS.b, 'conv-2m.glb')));
    const staging = await stageHostedProject({ distDir: dist, projectDir, librarySources: { projectsDir } });
    staged.push(staging);
    expect(existsSync(join(staging, 'library'))).toBe(false);
    // B is listed but unused now: shipped, trimmed to nothing — the viewer loads every listed library.
    expect(readJson(join(staging, 'p', 'libraries', FIXTURE_IDS.b, 'project.json')).documents).toEqual([]);
  });

  it('sources by --library and by the project\'s own libraries/ (a re-publish of a delivered copy)', async () => {
    const { projectsDir, dist, projectDir } = hostedFixture();
    const first = await stageHostedProject({
      distDir: dist, projectDir,
      librarySources: { libraries: { [FIXTURE_IDS.b]: join(projectsDir, FIXTURE_FOLDERS.b), [FIXTURE_IDS.c]: join(projectsDir, FIXTURE_FOLDERS.c) } },
    });
    staged.push(first);
    expectTrimmed(join(first, 'p'));
    // The delivered copy publishes again with NO sources: its own libraries/ serve.
    const delivered = join(work, 'delivered', FIXTURE_FOLDERS.a);
    cpSync(join(first, 'p'), delivered, { recursive: true });
    const second = await stageHostedProject({ distDir: dist, projectDir: delivered });
    staged.push(second);
    expectTrimmed(join(second, 'p'));
  });

  it('an unresolvable library id fails the hosted staging and removes its staging dir', async () => {
    const { dist, projectDir } = hostedFixture();
    // Private temp root (see the customer-staging twin above).
    const ownTmp = join(work, 'tmp');
    mkdirSync(ownTmp, { recursive: true });
    const saved = { TMP: process.env.TMP, TEMP: process.env.TEMP, TMPDIR: process.env.TMPDIR };
    process.env.TMP = ownTmp; process.env.TEMP = ownTmp; process.env.TMPDIR = ownTmp;
    try {
      expect(tmpdir()).toBe(ownTmp);
      await expect(stageHostedProject({ distDir: dist, projectDir, librarySources: { projectsDir: join(work, 'nowhere') } }))
        .rejects.toThrow(new RegExp(`Library "${FIXTURE_IDS.b}"`));
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
    expect(readdirSync(ownTmp).filter((n) => n.startsWith('realvirtual-hosted-'))).toEqual([]);
  });

  it('library rows are re-stamped after signing/encryption and uploaded with the catalogs', async () => {
    const { projectsDir, dist, projectDir } = hostedFixture();
    const staging = await stageHostedProject({ distDir: dist, projectDir, librarySources: { projectsDir } });
    staged.push(staging);
    // Simulate a size-preserving re-sign of a library GLB.
    const glb = join(staging, 'p', 'libraries', FIXTURE_IDS.b, 'conv-1m.glb');
    const bytes = readFileSync(glb); bytes[bytes.length - 1] ^= 0xff; writeFileSync(glb, bytes);
    expect(findLibraryProjectFiles(staging).sort()).toEqual([
      'library/project.json', `p/libraries/${FIXTURE_IDS.b}/project.json`, `p/libraries/${FIXTURE_IDS.c}/project.json`,
    ]);
    stampCatalogHashes(staging);
    const row = readJson(join(staging, 'p', 'libraries', FIXTURE_IDS.b, 'project.json')).documents.find((d: { id: string }) => d.id === 'conv-1m');
    expect(row.sha256).toBe(sha(glb));
    expect(row.sizeBytes).toBe(bytes.length);
    // The project's OWN manifest is not a library manifest.
    expect(findLibraryProjectFiles(staging)).not.toContain('p/project.json');
    expect(isCatalogFile(`p/libraries/${FIXTURE_IDS.b}/project.json`)).toBe(true);
    expect(isCatalogFile('p/project.json')).toBe(false);
  });

  it('nothing prunes libraries/: demo allowlist and manifest guard leave it alone', () => {
    const dist = makeDist(join(work, 'dist'));
    const demo = join(dist, 'demo-realvirtual');
    write(join(demo, 'project.json'), JSON.stringify({
      id: 'prj_sample', documents: [{ id: 'd', path: 'DemoRealvirtualWeb.glb' }, { id: 'x', path: 'libraries/prj_lib_b/conv-1m.glb' }],
    }));
    write(join(demo, 'DemoRealvirtualWeb.glb'), 'GLB');
    write(join(demo, 'libraries', 'prj_lib_b', 'conv-1m.glb'), 'GLB');
    write(join(demo, 'libraries', 'prj_lib_b', 'project.json'), '{"id":"prj_lib_b","documents":[]}');
    applyPublicModelAllowlist(dist, { keep: ['DemoRealvirtualWeb.glb'] });
    expect(existsSync(join(demo, 'libraries', 'prj_lib_b', 'conv-1m.glb'))).toBe(true);
    rmSync(join(demo, 'libraries'), { recursive: true });
    expect(publicDemoManifestMisses(dist)).toEqual([]);
  });
});

describe('library delivery — channels forward their sources (plan-778 9.15)', () => {
  // The CONNECT half (stage-project.mjs / stage-public.mjs) lives in
  // library-delivery-connect.node.test.ts: it reads the sibling repository, which a
  // community checkout does not have, and must not take this file out of that edition.
  it('deliver.mjs and bunny-deploy.mjs hand the sources on', () => {
    const deliver = readFileSync(join(__dirname, '..', 'scripts', 'deliver.mjs'), 'utf8');
    expect(deliver).toMatch(/args\.push\(\.\.\.librarySourceArgv\(librarySources\)\)/);
    const generator = readFileSync(join(__dirname, '..', 'scripts', 'generate-customer-workspace.mjs'), 'utf8');
    expect(generator.match(/librarySources: librarySourcesOf\(args\)/g)).toHaveLength(2);
    const deploy = readFileSync(join(__dirname, '..', 'scripts', 'bunny-deploy.mjs'), 'utf8');
    expect(deploy).toMatch(/stageAndBuild\(\{[^}]*librarySources \}\)/);
    expect(deploy).toMatch(/librarySources: opts\.librarySources/);
  });
});
