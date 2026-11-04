// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-778 9.16 — `validate-project` and the customer Doctor on library projects.
 *
 *  - every `libraries[]` entry names something (`projectId` or `url`);
 *  - a `projectId` never names a path (`/`, `\`, `..`) — it becomes a folder name;
 *  - in a delivered tree (`--delivered`) every qualified reference resolves in the
 *    tree's own `libraries/` — exit 1, naming document and library;
 *  - a source project checked against `--projects-dir` resolves its libraries by id;
 *  - the register loader (what the Doctor prints and every delivery runs first)
 *    reports the same findings for a customer's project.
 *
 * Runner: `npm run test:node`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { validateProject } from '../scripts/validate-project.mjs';
import { assertCustomerInvariants, projectLibraryProblems, type RvCustomer } from '../scripts/_rv-customers.mjs';
import { trimProjectLibraries } from '../scripts/lib/rv-library-trim.mjs';
import {
  FIXTURE_FOLDERS,
  FIXTURE_IDS,
  buildLibraryTrimFixture,
  glbWithNodeExtras,
  type FixtureFiles,
} from './fixtures/library-trim/library-trim-fixture';

const VALIDATOR = resolve(__dirname, '..', 'scripts', 'validate-project.mjs');
const write = (path: string, data: string | Uint8Array) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); };
function writeProject(dir: string, files: FixtureFiles): string {
  for (const [rel, bytes] of files) write(join(dir, ...rel.split('/')), bytes);
  return dir;
}
const cli = (...args: string[]) => spawnSync(process.execPath, [VALIDATOR, ...args], { encoding: 'utf8' });

describe('validate-project — libraries[] (plan-778 9.16)', () => {
  let work: string;
  let projectsDir: string;
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'rv-validate-libraries-'));
    projectsDir = join(work, 'projects');
    const fx = buildLibraryTrimFixture();
    writeProject(join(projectsDir, FIXTURE_FOLDERS.a), fx.a);
    writeProject(join(projectsDir, FIXTURE_FOLDERS.b), fx.b);
    writeProject(join(projectsDir, FIXTURE_FOLDERS.c), fx.c);
  });
  afterEach(() => { rmSync(work, { recursive: true, force: true }); });

  const project = (libraries: unknown[]) => {
    const dir = join(work, 'shape');
    write(join(dir, 'project.json'), JSON.stringify({ id: 'prj_x', name: 'x', kind: 'internal', canonicalName: 'shape', documents: [], libraries }));
    return dir;
  };

  it('an entry with neither projectId nor url, and a path-like projectId, are errors', () => {
    const result = validateProject(project([
      { label: 'nothing' },
      { projectId: '../escape' },
      { projectId: 'a/b' },
      { projectId: 'a\\b' },
      { projectId: 'prj_fine', hint: 'Fine' },
      { url: 'https://example.invalid/catalog.json' },
      '/catalogs/partner/catalog.json',
    ]));
    expect(result.ok).toBe(false);
    expect(result.errors.filter((e) => e.includes('libraries['))).toEqual([
      expect.stringContaining('libraries[0] has neither "projectId" nor "url"'),
      expect.stringMatching(/libraries\[1\]: projectId "\.\.\/escape" contains a path separator/),
      expect.stringMatching(/libraries\[2\]: projectId "a\/b" contains a path separator/),
      expect.stringMatching(/libraries\[3\]: projectId "a\\b" contains a path separator/),
    ]);
  });

  it('libraries/ is a known project folder (no "unrecognised folder" warning)', () => {
    const dir = project([]);
    mkdirSync(join(dir, 'libraries'), { recursive: true });
    expect(validateProject(dir).warnings.some((w) => w.includes('"libraries"'))).toBe(false);
  });

  it('a source project resolves its libraries by id against --projects-dir', () => {
    const a = join(projectsDir, FIXTURE_FOLDERS.a);
    expect(validateProject(a, { librarySources: { projectsDir } }).errors).toEqual([]);
    rmSync(join(projectsDir, FIXTURE_FOLDERS.c), { recursive: true });
    const result = validateProject(a, { librarySources: { projectsDir } });
    expect(result.errors.join('\n')).toContain(`Library "${FIXTURE_IDS.c}" (needed by ${FIXTURE_IDS.b})`);
    const run = cli(a, '--projects-dir', projectsDir);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`Library "${FIXTURE_IDS.c}"`);
  });

  it('D9: --delivered combined with --projects-dir or --library is a usage error (exit 2)', () => {
    const a = join(projectsDir, FIXTURE_FOLDERS.a);
    expect(cli(a, '--delivered', '--projects-dir', projectsDir).status).toBe(2);
    expect(cli(a, '--delivered', '--library', `${FIXTURE_IDS.b}=${join(projectsDir, FIXTURE_FOLDERS.b)}`).status).toBe(2);
  });

  it('--delivered: a delivered tree is valid; an unresolvable qualified ref exits 1 naming document and library', () => {
    const delivered = join(work, 'delivered', FIXTURE_FOLDERS.a);
    cpSync(join(projectsDir, FIXTURE_FOLDERS.a), delivered, { recursive: true });
    trimProjectLibraries(delivered, { projectsDir });
    const ok = cli(delivered, '--delivered');
    expect(ok.status, ok.stderr).toBe(0);

    // A placement whose document the delivered library does not carry.
    write(join(delivered, 'plant.glb'), glbWithNodeExtras([
      { AssetReference: { assetId: 'conv-2m', providerId: 'library-projects', sourceId: FIXTURE_IDS.b } },
    ]));
    const bad = cli(delivered, '--delivered');
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain(`plant.glb places "conv-2m" from library "${FIXTURE_IDS.b}", which has no such document`);

    // A library that is listed but not shipped at all.
    rmSync(join(delivered, 'libraries', FIXTURE_IDS.c), { recursive: true });
    const missing = validateProject(delivered, { delivered: true });
    expect(missing.errors.join('\n')).toContain(`library "${FIXTURE_IDS.c}" (needed by ${FIXTURE_IDS.b}) is not shipped under libraries/${FIXTURE_IDS.c}/`);
  });

  it('without --delivered or sources a source project is only shape-checked (no false alarm)', () => {
    rmSync(join(projectsDir, FIXTURE_FOLDERS.b), { recursive: true });
    expect(validateProject(join(projectsDir, FIXTURE_FOLDERS.a)).errors).toEqual([]);
  });
});

describe('customer Doctor — library projects (plan-778 9.16)', () => {
  let work: string;
  let privateRoot: string;
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'rv-doctor-libraries-'));
    privateRoot = join(work, 'private');
    const fx = buildLibraryTrimFixture();
    writeProject(join(privateRoot, 'projects', FIXTURE_FOLDERS.a), fx.a);
    writeProject(join(privateRoot, 'projects', FIXTURE_FOLDERS.b), fx.b);
    writeProject(join(privateRoot, 'projects', FIXTURE_FOLDERS.c), fx.c);
    write(join(privateRoot, 'tier-manifest.json'), JSON.stringify({ defaults: 'commercial', rules: [], registrations: {} }));
  });
  afterEach(() => { rmSync(work, { recursive: true, force: true }); });

  const customer = (): RvCustomer => ({
    schemaVersion: 1, customer: 'plant', displayName: 'Plant', kind: 'development', support: 'basic', status: 'active',
    forgejo: { org: 'rv-plant', repo: 'rv-project-plant', team: 'members', permission: 'write' },
    contacts: [], licensing: {},
    delivery: {
      channel: 'git-workspace', tier: 'commercial', restrictedFeatures: [], projects: [FIXTURE_FOLDERS.a],
      connectChannel: 'stable', mirror: null,
    },
  } as unknown as RvCustomer);
  const errors = (extra: Record<string, unknown> = {}) => assertCustomerInvariants(customer(), { fileName: 'plant', privateRoot, manifest: { defaults: 'commercial', rules: [], registrations: {} }, ...extra } as never).errors;

  it('a resolvable project raises nothing', () => {
    expect(projectLibraryProblems(privateRoot, FIXTURE_FOLDERS.a)).toEqual([]);
    expect(errors().filter((e) => e.includes('librar'))).toEqual([]);
  });

  it('D2: loading (the invariants) never resolves libraries deeply - only the doctor does', () => {
    rmSync(join(privateRoot, 'projects', FIXTURE_FOLDERS.c), { recursive: true });
    expect(errors().filter((e) => e.includes('librar'))).toEqual([]);
    expect(projectLibraryProblems(privateRoot, FIXTURE_FOLDERS.a)).toEqual([]);
  });

  it('D2: a library given only via --library resolves in the deep (doctor / delivery) check', () => {
    const elsewhere = join(work, 'elsewhere', 'C-copy');
    cpSync(join(privateRoot, 'projects', FIXTURE_FOLDERS.c), elsewhere, { recursive: true });
    rmSync(join(privateRoot, 'projects', FIXTURE_FOLDERS.c), { recursive: true });
    expect(projectLibraryProblems(privateRoot, FIXTURE_FOLDERS.a, { deep: true }).join('\n')).toContain(`Library "${FIXTURE_IDS.c}"`);
    expect(projectLibraryProblems(privateRoot, FIXTURE_FOLDERS.a, { deep: true, sources: { libraries: { [FIXTURE_IDS.c]: elsewhere } } })).toEqual([]);
  });

  it('D2: a broken library of customer X does not break loading customer Y', () => {
    rmSync(join(privateRoot, 'projects', FIXTURE_FOLDERS.c), { recursive: true });   // X (PlantA) is now broken
    writeProject(join(privateRoot, 'projects', 'Other'), new Map([
      ['project.json', new TextEncoder().encode(JSON.stringify({ id: 'prj_other', name: 'Other', documents: [] }))],
    ]));
    const base = customer() as unknown as { delivery: Record<string, unknown> };
    const y = { ...base, customer: 'other', forgejo: { org: 'rv-other', repo: 'rv-project-other', team: 'members', permission: 'write' }, delivery: { ...base.delivery, projects: ['Other'] } } as unknown as RvCustomer;
    const found = assertCustomerInvariants(y, { fileName: 'other', privateRoot, manifest: { defaults: 'commercial', rules: [], registrations: {} } } as never);
    expect(found.errors).toEqual([]);
  });

  it('surfaces an unresolvable library and an unresolvable qualified reference (doctor, deep)', () => {
    rmSync(join(privateRoot, 'projects', FIXTURE_FOLDERS.c), { recursive: true });
    const found = errors({ deepLibraries: true }).join('\n');
    expect(found).toContain(`projects/${FIXTURE_FOLDERS.a}: Library "${FIXTURE_IDS.c}" (needed by ${FIXTURE_IDS.b})`);
    expect(found).toContain(`${FIXTURE_IDS.b}:motor-big.glb places "bolt-m8" from library "${FIXTURE_IDS.c}"`);
  });

  it('surfaces a path-like library id', () => {
    const manifest = join(privateRoot, 'projects', FIXTURE_FOLDERS.a, 'project.json');
    write(manifest, JSON.stringify({ id: FIXTURE_IDS.a, name: 'PlantA', documents: [], libraries: [{ projectId: '../x' }] }));
    expect(errors().join('\n')).toMatch(/projects\/PlantA: libraries\[0\]: projectId "\.\.\/x" contains a path separator/);
  });
});
