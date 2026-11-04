// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-778 review fixes D3 D5 D6 D7 D8 - hardening of the library trim.
 * (D1 lives in library-trim.node.test.ts, D2/D9 in validate-project-libraries, D12 in library-pack.)
 *
 * Runner: `npm run test:node`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { planProjectLibraries, trimProjectLibraries } from '../scripts/lib/rv-library-trim.mjs';
import {
  bundledCatalogEntryCount,
  isBundledCatalogUrl,
  libraryProjectIdProblem,
} from '../src/core/project/rv-library-trim-core.mjs';
import {
  FIXTURE_FOLDERS,
  FIXTURE_IDS,
  buildLibraryTrimFixture,
  glbWithNodeExtras,
  type FixtureFiles,
} from './fixtures/library-trim/library-trim-fixture';

function writeProject(dir: string, files: FixtureFiles): string {
  for (const [rel, bytes] of files) {
    const abs = join(dir, ...rel.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
  }
  return dir;
}
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const LFS = 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 10\n';

describe('library trim hardening (plan-778 review)', () => {
  let work: string;
  let projectsDir: string;
  let staged: string;
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'rv-library-trim-hard-'));
    projectsDir = join(work, 'projects');
    const fx = buildLibraryTrimFixture();
    writeProject(join(projectsDir, FIXTURE_FOLDERS.a), fx.a);
    writeProject(join(projectsDir, FIXTURE_FOLDERS.b), fx.b);
    writeProject(join(projectsDir, FIXTURE_FOLDERS.c), fx.c);
    staged = join(work, 'staged', FIXTURE_FOLDERS.a);
    cpSync(join(projectsDir, FIXTURE_FOLDERS.a), staged, { recursive: true });
  });
  afterEach(() => { rmSync(work, { recursive: true, force: true }); });

  const errorCodes = (fn: () => unknown): string[] => {
    try { fn(); } catch (e) { return ((e as { errors?: Array<{ code: string }> }).errors ?? []).map((x) => x.code); }
    return [];
  };

  it('D3: an unfetched LFS pointer in place of a library GLB is document-unreadable, not "no references"', () => {
    writeFileSync(join(projectsDir, FIXTURE_FOLDERS.b, 'motor-big.glb'), LFS);
    expect(errorCodes(() => trimProjectLibraries(staged, { projectsDir }))).toContain('document-unreadable');
    expect(existsSync(join(staged, 'libraries'))).toBe(false);
  });

  it('D3: a truncated library GLB is document-unreadable', () => {
    truncateSync(join(projectsDir, FIXTURE_FOLDERS.b, 'conv-1m.glb'), 40);
    expect(errorCodes(() => trimProjectLibraries(staged, { projectsDir }))).toContain('document-unreadable');
  });

  it('D3: an LFS pointer thumbnail of a used library document stops the delivery', () => {
    const manifest = readJson(join(projectsDir, FIXTURE_FOLDERS.b, 'project.json'));
    const thumb = manifest.documents.find((d: { id: string }) => d.id === 'conv-1m').thumbnail as string;
    writeFileSync(join(projectsDir, FIXTURE_FOLDERS.b, ...thumb.split('/')), LFS);
    expect(() => trimProjectLibraries(staged, { projectsDir })).toThrow(/unfetched Git LFS pointer/);
    expect(existsSync(join(staged, 'libraries'))).toBe(false);
  });

  it('D3: a symlinked library document is never followed (reported missing, not shipped)', () => {
    const real = join(work, 'outside.glb');
    cpSync(join(projectsDir, FIXTURE_FOLDERS.b, 'conv-1m.glb'), real);
    rmSync(join(projectsDir, FIXTURE_FOLDERS.b, 'conv-1m.glb'));
    try { symlinkSync(real, join(projectsDir, FIXTURE_FOLDERS.b, 'conv-1m.glb')); } catch { return; }   // no symlink right on this machine
    expect(errorCodes(() => trimProjectLibraries(staged, { projectsDir }))).toContain('document-file-missing');
  });

  it('D3: the verifySourceFolder hook runs per shipped library before anything is copied', () => {
    const seen: string[] = [];
    trimProjectLibraries(staged, { projectsDir, verifySourceFolder: (_folder: string, id: string) => { seen.push(id); } });
    expect(seen).toEqual([FIXTURE_IDS.b, FIXTURE_IDS.c]);
    rmSync(join(staged, 'libraries'), { recursive: true, force: true });
    expect(() => trimProjectLibraries(staged, { projectsDir, verifySourceFolder: () => { throw new Error('dirty tree'); } })).toThrow('dirty tree');
    expect(existsSync(join(staged, 'libraries'))).toBe(false);
  });

  it('D5: pointers to files that do not ship are stripped; a path-escaping row and a devOnly row are refused', () => {
    const file = join(projectsDir, FIXTURE_FOLDERS.b, 'project.json');
    const manifest = readJson(file);
    const row = manifest.documents.find((d: { id: string }) => d.id === 'conv-1m');
    Object.assign(row, { scriptRef: 'scripts/x.ts', connectRef: 'c.json', knowledgeRef: 'k.md', experiments: 'experiments/e.ndjson' });
    writeFileSync(file, JSON.stringify(manifest));
    trimProjectLibraries(staged, { projectsDir });
    const shipped = readJson(join(staged, 'libraries', FIXTURE_IDS.b, 'project.json')).documents.find((d: { id: string }) => d.id === 'conv-1m');
    for (const key of ['scriptRef', 'connectRef', 'knowledgeRef', 'experiments']) expect(shipped, key).not.toHaveProperty(key);

    const escaping = readJson(file);
    escaping.documents.find((d: { id: string }) => d.id === 'conv-1m').path = '../escape.glb';
    writeFileSync(file, JSON.stringify(escaping));
    rmSync(join(staged, 'libraries'), { recursive: true, force: true });
    expect(errorCodes(() => trimProjectLibraries(staged, { projectsDir }))).toContain('document-path-invalid');

    const dev = readJson(file);
    const devRow = dev.documents.find((d: { id: string }) => d.id === 'conv-1m');
    devRow.path = 'conv-1m.glb';
    devRow.devOnly = true;
    writeFileSync(file, JSON.stringify(dev));
    expect(errorCodes(() => trimProjectLibraries(staged, { projectsDir }))).toContain('document-dev-only');
  });

  it('D6: the same project id in two --projects-dir folders is library-ambiguous unless --library names one', () => {
    cpSync(join(projectsDir, FIXTURE_FOLDERS.c), join(projectsDir, 'Fasteners-copy'), { recursive: true });
    expect(errorCodes(() => trimProjectLibraries(staged, { projectsDir }))).toContain('library-ambiguous');
    const result = trimProjectLibraries(staged, { projectsDir, libraries: { [FIXTURE_IDS.c]: join(projectsDir, FIXTURE_FOLDERS.c) } });
    expect(result.shipped).toEqual([FIXTURE_IDS.b, FIXTURE_IDS.c]);
  });

  it('D7: ids are an allowlist; Windows reserved names are refused', () => {
    for (const bad of ['CON', 'nul', 'Aux.x', 'COM1', 'lpt9', 'a b', 'a:b', 'a*b', '.hidden', 'trail.', 'über']) {
      expect(libraryProjectIdProblem(bad), bad).not.toBeNull();
    }
    for (const ok of ['prj_ok-1.2', 'A', 'prj_lib_b', 'a.b', 'COM10', 'console']) expect(libraryProjectIdProblem(ok), ok).toBeNull();
  });

  it('D8: bundled-catalog URL entries count as needing the realvirtual library; partner catalogs do not', () => {
    expect(isBundledCatalogUrl('library/catalog.json')).toBe(true);
    expect(isBundledCatalogUrl('https://web.realvirtual.io/demo/library/catalog.json?v=3')).toBe(true);
    expect(isBundledCatalogUrl('https://partner.example/library/catalog.json')).toBe(false);
    expect(isBundledCatalogUrl('https://github.com/game4automation/realvirtual-Library')).toBe(false);
    expect(bundledCatalogEntryCount({
      libraries: [{ url: '/library/catalog.json' }, { projectId: 'prj_x', url: 'library/catalog.json' }, 'https://partner.example/library/catalog.json'],
    })).toBe(1);
    const plain = join(work, 'plain');
    writeProject(plain, new Map([['project.json', new TextEncoder().encode(JSON.stringify({
      id: 'prj_p', name: 'p', documents: [], libraries: [{ url: 'library/catalog.json' }],
    }))]]));
    expect(planProjectLibraries(plain, {}).realvirtualLibraryUsed).toBe(true);
  });

  it('D8: a legacy manifest (no documents[]) is planned over its derived documents; the written manifest keeps its shape', () => {
    const legacy = join(work, 'legacy');
    writeProject(legacy, new Map([
      ['project.json', new TextEncoder().encode(JSON.stringify({
        id: 'prj_legacy', name: 'legacy', models: [{ id: 'plant', name: 'Plant', path: 'models/plant.glb' }],
        libraries: [{ projectId: FIXTURE_IDS.b, hint: 'SharedConveyors' }],
      }))],
      ['models/plant.glb', glbWithNodeExtras([{ AssetReference: { assetId: 'conv-1m', providerId: 'library-projects', sourceId: FIXTURE_IDS.b } }])],
    ]));
    const { plan } = trimProjectLibraries(legacy, { projectsDir });
    expect(plan.libraries.find((l) => l.projectId === FIXTURE_IDS.b)?.documentIds).toEqual(['conv-1m']);
    const written = readJson(join(legacy, 'project.json'));
    expect(written.documents).toBeUndefined();
    expect(written.libraries[0].hint).toBe(`libraries/${FIXTURE_IDS.b}/project.json`);
  });
});
