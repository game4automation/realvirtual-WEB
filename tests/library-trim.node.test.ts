// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-778 9.13 — trimming library projects for a delivery (F15).
 *
 * The shared fixture (`tests/fixtures/library-trim/`): A uses 2 of the 5
 * documents of B, one of those uses 1 of the 3 documents of C. The trim ships
 * exactly those, bytes unchanged, with their thumbnails and a trimmed
 * `project.json` (same ids, other fields kept), rewrites the hints of the
 * DELIVERED copy to `libraries/<id>/project.json`, leaves the realvirtual library
 * alone and reports — never guesses — an unqualified reference. 9.14 runs the
 * same algorithm in the browser and must arrive at the same digest.
 *
 * Runner: `npm run test:node`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import {
  LibraryTrimError,
  parseLibrarySourceArgs,
  planProjectLibraries,
  trimProjectLibraries,
} from '../scripts/lib/rv-library-trim.mjs';
import {
  collectAssetReferences,
  libraryProjectIdProblem,
  parseGlbJson,
  planLibraryTrim,
  planLibraryTrimSync,
} from '../src/core/project/rv-library-trim-core.mjs';
import {
  EXPECTED_TRIM,
  FIXTURE_FOLDERS,
  FIXTURE_IDS,
  buildLibraryTrimFixture,
  expectedTrimDigest,
  glbWithNodeExtras,
  trimDigest,
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

function readTree(dir: string): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else out.set(relative(dir, abs).replace(/\\/g, '/'), new Uint8Array(readFileSync(abs)));
    }
  };
  walk(dir);
  return out;
}

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

describe('library trim (plan-778 9.13)', () => {
  let work: string;
  let projectsDir: string;
  let staged: string;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'rv-library-trim-'));
    projectsDir = join(work, 'projects');
    const fx = buildLibraryTrimFixture();
    writeProject(join(projectsDir, FIXTURE_FOLDERS.a), fx.a);
    writeProject(join(projectsDir, FIXTURE_FOLDERS.b), fx.b);
    writeProject(join(projectsDir, FIXTURE_FOLDERS.c), fx.c);
    staged = join(work, 'staged', FIXTURE_FOLDERS.a);
    cpSync(join(projectsDir, FIXTURE_FOLDERS.a), staged, { recursive: true });
  });
  afterEach(() => { rmSync(work, { recursive: true, force: true }); });

  it('ships exactly the transitively used documents, bytes unchanged, with their thumbnails', async () => {
    const { shipped } = trimProjectLibraries(staged, { projectsDir });
    expect(shipped).toEqual([FIXTURE_IDS.b, FIXTURE_IDS.c]);

    const libs = join(staged, 'libraries');
    expect(readdirSync(libs).sort()).toEqual([FIXTURE_IDS.b, FIXTURE_IDS.c]);
    for (const [id, folder] of [[FIXTURE_IDS.b, FIXTURE_FOLDERS.b], [FIXTURE_IDS.c, FIXTURE_FOLDERS.c]] as const) {
      const manifest = readJson(join(libs, id, 'project.json'));
      expect(manifest.id).toBe(id);
      expect(manifest.documents.map((d: { id: string }) => d.id)).toEqual(EXPECTED_TRIM[id]);
      // D1: allowlist — no author-private field travels
      for (const leaked of ['customKey', 'code', 'provenance', 'settings', 'settingsRef', 'lastPublished', 'activeSceneId', 'folders', 'demos']) {
        expect(manifest, leaked).not.toHaveProperty(leaked);
      }
      expect(Object.keys(manifest).every((k) => ['schemaVersion', 'id', 'name', 'canonicalName', 'kind', 'libraries', 'documents'].includes(k))).toBe(true);
      const source = readJson(join(projectsDir, folder, 'project.json'));
      for (const doc of source.documents as Array<{ id: string; path: string; thumbnail: string }>) {
        const used = (EXPECTED_TRIM[id] as readonly string[]).includes(doc.id);
        expect(existsSync(join(libs, id, doc.path)), `${id}/${doc.path}`).toBe(used);
        expect(existsSync(join(libs, id, doc.thumbnail)), `${id}/${doc.thumbnail}`).toBe(used);
        if (used) {
          expect(Buffer.compare(readFileSync(join(libs, id, doc.path)), readFileSync(join(projectsDir, folder, doc.path)))).toBe(0);
          // the row itself is unchanged too (same id, path, thumbnail, size)
          expect(manifest.documents.find((d: { id: string }) => d.id === doc.id)).toEqual(doc);
        }
      }
    }

    const digest = await trimDigest([FIXTURE_IDS.b, FIXTURE_IDS.c].map((projectId) => ({
      projectId, files: readTree(join(libs, projectId)),
    })));
    expect(digest).toEqual(await expectedTrimDigest());
  });

  it('rewrites hints in the delivered copy only — the sources stay untouched', async () => {
    const before = readTree(join(projectsDir));
    trimProjectLibraries(staged, { projectsDir });

    const a = readJson(join(staged, 'project.json'));
    expect(a.libraries).toEqual([
      { projectId: FIXTURE_IDS.b, label: 'SharedConveyors', hint: `libraries/${FIXTURE_IDS.b}/project.json`, note: 'unknown keys survive' },
      { projectId: 'prj_realvirtual_library', label: 'realvirtual Library' },
    ]);
    const b = readJson(join(staged, 'libraries', FIXTURE_IDS.b, 'project.json'));
    expect(b.libraries).toEqual([{ projectId: FIXTURE_IDS.c, label: 'Fasteners', hint: `libraries/${FIXTURE_IDS.c}/project.json` }]);

    const after = readTree(join(projectsDir));
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [rel, bytes] of before) expect(Buffer.compare(after.get(rel)!, bytes), rel).toBe(0);
  });

  it('never trims the realvirtual library; reports the legacy reference, does not fail on it', async () => {
    const realvirtualDir = join(work, 'app-library');
    mkdirSync(realvirtualDir, { recursive: true });
    writeFileSync(join(realvirtualDir, 'project.json'), JSON.stringify({
      id: 'prj_realvirtual_library',
      documents: [
        { id: 'pallethandling-chainconveyor-1m', path: 'PalletHandling/ChainConveyor-1m.glb' },
        { id: 'pallethandling-europallet', path: 'PalletHandling/Europallet.glb', aliases: ['realvirtual-library-pallethandling-europallet-glb'] },
      ],
    }));
    const lines: string[] = [];
    const { plan } = trimProjectLibraries(staged, { projectsDir, realvirtualLibraryDir: realvirtualDir }, { log: (l) => lines.push(l) });
    expect(plan.realvirtualLibraryUsed).toBe(true);
    expect(existsSync(join(staged, 'libraries', 'prj_realvirtual_library'))).toBe(false);
    expect(plan.legacyRefs).toEqual([expect.objectContaining({
      document: 'plant.glb', assetId: 'realvirtual-library-pallethandling-europallet-glb', resolvesIn: 'prj_realvirtual_library',
    })]);
    expect(lines.some((l) => l.includes("1 unqualified reference(s)"))).toBe(true);
  });

  it('is idempotent: re-trimming a delivered copy (its own libraries/ as the source) gives the same tree', async () => {
    trimProjectLibraries(staged, { projectsDir });
    const first = readTree(staged);
    trimProjectLibraries(staged, {});   // no projects dir: the copy's own libraries/ is the source
    const second = readTree(staged);
    expect([...second.keys()].sort()).toEqual([...first.keys()].sort());
    for (const [rel, bytes] of first) expect(Buffer.compare(second.get(rel)!, bytes), rel).toBe(0);
  });

  it('--library <id>=<folder> wins over --projects-dir', async () => {
    const other = join(work, 'elsewhere', 'B-copy');
    cpSync(join(projectsDir, FIXTURE_FOLDERS.b), other, { recursive: true });
    const parsed = parseLibrarySourceArgs(['--projects-dir', projectsDir, '--library', `${FIXTURE_IDS.b}=${other}`]);
    expect(parsed).toEqual({ projectsDir, libraries: { [FIXTURE_IDS.b]: other } });
    const { plan } = trimProjectLibraries(staged, parsed);
    const b = plan.libraries.find((l) => l.projectId === FIXTURE_IDS.b)!;
    expect((b.source as unknown as { folder: string }).folder).toBe(other);
    expect(() => parseLibrarySourceArgs(['--library', 'no-equals'])).toThrow(/<projectId>=<folder>/);
    expect(() => parseLibrarySourceArgs(['--library', '../x=y'])).toThrow(/path separator|\.\./);
  });

  it('an unresolvable library fails with every cause named (exit-1 error)', async () => {
    rmSync(join(projectsDir, FIXTURE_FOLDERS.c), { recursive: true, force: true });
    expect(() => trimProjectLibraries(staged, { projectsDir })).toThrow(LibraryTrimError);
    let err: LibraryTrimError | null = null;
    try { trimProjectLibraries(staged, { projectsDir }); } catch (e) { err = e as LibraryTrimError; }
    if (!err) throw new Error('expected a LibraryTrimError');
    expect(err.code).toBe('LIBRARY_TRIM_FAILED');
    expect(err.message).toContain(`Library "${FIXTURE_IDS.c}" (needed by ${FIXTURE_IDS.b})`);
    expect(err.message).toContain(`${FIXTURE_IDS.b}:motor-big.glb places "bolt-m8" from library "${FIXTURE_IDS.c}"`);
    expect(existsSync(join(staged, 'libraries'))).toBe(false);   // nothing half-written
  });

  it('a project that uses no library is left byte-identical', async () => {
    const plain = join(work, 'plain');
    writeProject(plain, new Map([
      ['project.json', new TextEncoder().encode('{"id":"prj_plain","name":"plain","documents":[{"id":"m","path":"m.glb"}]}')],
      ['m.glb', new TextEncoder().encode('glTF')],   // not even a valid GLB — tolerated
    ]));
    const before = readTree(plain);
    const { shipped } = trimProjectLibraries(plain, {});
    expect(shipped).toEqual([]);
    const after = readTree(plain);
    expect([...after.keys()]).toEqual([...before.keys()]);
    for (const [rel, bytes] of before) expect(Buffer.compare(after.get(rel)!, bytes)).toBe(0);
  });
});

describe('library trim core (plan-778 9.13)', () => {
  const lib = (id: string, docs: Array<{ id: string; refs?: Array<[string, string]> }>, libraries: string[] = []) => ({
    manifest: {
      id, documents: docs.map((d) => ({ id: d.id, path: `${d.id}.glb` })),
      libraries: libraries.map((projectId) => ({ projectId })),
    },
    docs: new Map(docs.map((d) => [`${d.id}.glb`, glbWithNodeExtras((d.refs ?? []).map(([sourceId, assetId]) => ({
      AssetReference: { assetId, providerId: 'library-projects', sourceId },
    })))])),
  });
  const run = (root: ReturnType<typeof lib>, libs: Array<ReturnType<typeof lib>>, extra: Partial<Parameters<typeof planLibraryTrim>[0]> = {}) => {
    const byId = new Map(libs.map((l) => [l.manifest.id, l]));
    const reader = (l: ReturnType<typeof lib>) => async (path: string) => {
      const bytes = l.docs.get(path);
      return bytes ? { json: parseGlbJson(bytes) } : null;
    };
    return planLibraryTrim({
      manifest: root.manifest,
      readDocument: reader(root),
      openLibrary: async (id) => {
        const l = byId.get(id);
        return l ? { manifest: l.manifest, readDocument: reader(l) } : null;
      },
      ...extra,
    });
  };

  it('a cycle A → B → A and a self-reference are harmless', async () => {
    const a = lib('A', [{ id: 'main', refs: [['B', 'x']] }], ['B']);
    const b = lib('B', [{ id: 'x', refs: [['A', 'main'], ['B', 'y']] }, { id: 'y' }, { id: 'z' }], ['A', 'B']);
    const plan = await run(a, [b]);
    expect(plan.errors).toEqual([]);
    expect(plan.libraries.map((l) => [l.projectId, l.documentIds])).toEqual([['B', ['x', 'y']]]);
  });

  it('nesting deeper than 16 libraries is refused', async () => {
    const chain = Array.from({ length: 18 }, (_, i) => lib(`L${i}`, [{ id: 'd' }], i < 17 ? [`L${i + 1}`] : []));
    const root = lib('A', [{ id: 'main' }], ['L0']);
    const plan = await run(root, chain);
    expect(plan.errors.map((e) => e.code)).toContain('library-depth');
  });

  it('depth is the SHORTEST chain: a library listed directly AND at the end of a 16-deep chain is not too deep (review D13)', async () => {
    const chain = Array.from({ length: 16 }, (_, i) => lib(`L${i}`, [{ id: 'd' }], i < 15 ? [`L${i + 1}`] : ['X']));
    const x = lib('X', [{ id: 'x' }]);
    const root = lib('A', [{ id: 'main' }], ['L0', 'X']);
    const plan = await run(root, [...chain, x]);
    expect(plan.errors.map((e) => e.code)).not.toContain('library-depth');
  });

  it('a qualified ref to a missing document, or to an unlisted library, is an error naming document and library', async () => {
    const a = lib('A', [{ id: 'main', refs: [['B', 'nope'], ['C', 'c1']] }], ['B']);
    const b = lib('B', [{ id: 'x' }]);
    const c = lib('C', [{ id: 'c1' }]);
    const plan = await run(a, [b, c]);
    expect(plan.errors.map((e) => [e.code, e.document, e.projectId])).toEqual([
      ['document-unresolvable', 'main.glb', 'B'],
      ['library-not-listed', 'main.glb', 'C'],
    ]);
  });

  it('a path-like library id is refused before any source is asked', async () => {
    expect(libraryProjectIdProblem('a/b')).toMatch(/path separator/);
    expect(libraryProjectIdProblem('a\\b')).toMatch(/path separator/);
    expect(libraryProjectIdProblem('..')).toMatch(/\.\./);
    expect(libraryProjectIdProblem('prj_ok-1.2')).toBeNull();
    const a = lib('A', [{ id: 'main' }], ['../evil']);
    let asked = false;
    const plan = await planLibraryTrim({
      manifest: a.manifest, readDocument: async () => null,
      openLibrary: async () => { asked = true; return null; },
    });
    expect(asked).toBe(false);
    expect(plan.errors[0].code).toBe('library-id-invalid');
  });

  it('collects AssetReference from nodes and scenes and the splat qualifier; embedded refs are content', () => {
    const json = {
      nodes: [
        { extras: { realvirtual: { AssetReference: { assetId: 'a', providerId: 'library-projects', sourceId: 'B' } } } },
        { extras: { realvirtual: { AssetReference: { assetId: 'e', embedded: true } } } },
        { extras: { realvirtual: { PlacementMeta: { splatUrl: 's.splat', catalogId: 'sp', providerId: 'library-projects', sourceId: 'B' } } } },
      ],
      scenes: [{ extras: { realvirtual: { AssetReference: { assetId: 'scene-level', path: 'x.glb' } } } }],
    };
    expect(collectAssetReferences(json).map((r) => [r.assetId, r.sourceId, r.splat])).toEqual([
      ['a', 'B', false], ['sp', 'B', true], ['scene-level', null, false],
    ]);
  });

  it('an unqualified ref inside a library is attributed to that library only', async () => {
    const a = lib('A', [{ id: 'main', refs: [['B', 'x']] }], ['B']);
    const b = lib('B', [{ id: 'x' }, { id: 'sibling' }]);
    b.docs.set('x.glb', glbWithNodeExtras([{ AssetReference: { assetId: 'sibling' } }, { AssetReference: { assetId: 'foreign' } }]));
    const plan = await run(a, [b]);
    expect(plan.libraries[0].documentIds).toEqual(['x', 'sibling']);
    expect(plan.legacyRefs.map((r) => [r.document, r.assetId])).toEqual([['B:x.glb', 'foreign']]);
  });

  it('the sync and the async driver are one algorithm (same plan)', async () => {
    const a = lib('A', [{ id: 'main', refs: [['B', 'x'], ['B', 'nope']] }], ['B']);
    const b = lib('B', [{ id: 'x', refs: [['C', 'c1']] }, { id: 'y' }], ['C']);
    const c = lib('C', [{ id: 'c1' }, { id: 'c2' }]);
    const byId = new Map([b, c].map((l) => [l.manifest.id, l]));
    const syncReader = (l: ReturnType<typeof lib>) => (path: string) => {
      const bytes = l.docs.get(path);
      return bytes ? { json: parseGlbJson(bytes) } : null;
    };
    const sync = planLibraryTrimSync({
      manifest: a.manifest, readDocument: syncReader(a),
      openLibrary: (id) => { const l = byId.get(id); return l ? { manifest: l.manifest, readDocument: syncReader(l) } : null; },
    });
    const asyncPlan = await run(a, [b, c]);
    const strip = (p: typeof sync) => ({ ...p, libraries: p.libraries.map(({ source: _s, ...rest }) => rest) });
    expect(strip(sync)).toEqual(strip(asyncPlan));
    expect(sync.libraries.map((l) => [l.projectId, l.documentIds])).toEqual([['B', ['x']], ['C', ['c1']]]);
    expect(() => planLibraryTrimSync({ manifest: a.manifest, readDocument: async () => null, openLibrary: () => null }))
      .toThrow(/returned a Promise/);
  });

  it('planProjectLibraries reads only — the Doctor / validator form', async () => {
    const work = mkdtempSync(join(tmpdir(), 'rv-library-plan-'));
    try {
      const fx = buildLibraryTrimFixture();
      const projectsDir = join(work, 'projects');
      writeProject(join(projectsDir, FIXTURE_FOLDERS.a), fx.a);
      writeProject(join(projectsDir, FIXTURE_FOLDERS.b), fx.b);
      writeProject(join(projectsDir, FIXTURE_FOLDERS.c), fx.c);
      const plan = planProjectLibraries(join(projectsDir, FIXTURE_FOLDERS.a), { projectsDir });
      expect(plan.errors).toEqual([]);
      expect(existsSync(join(projectsDir, FIXTURE_FOLDERS.a, 'libraries'))).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
