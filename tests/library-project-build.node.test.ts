// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-778 9.10 — the realvirtual library as a project (`public/library/project.json`).
 *
 * The builder emits the manifest beside `catalog.json`; its document ids are the
 * catalog ids captured before the catalog goes away (`realvirtual-library-ids.json`),
 * every row keeps hash / size / thumbnail / collections, carries the GitHub-scan id
 * as an alias, and a signing deploy re-stamps the rows after signing.
 *
 * Runner: `npm run test:node`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  LIBRARY_DIR,
  PROJECT_OUTPUT,
  LIBRARY_PROJECT_ID,
  buildLibraryProject,
  buildLocalCatalog,
  githubScanId,
} from '../scripts/build-local-library-catalog.mjs';
import { stampCatalogHashes } from '../scripts/_bunny-lib.mjs';

const FIXTURE_IDS = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'realvirtual-library-ids.json'), 'utf8')) as string[];

interface Doc {
  id: string; name: string; path: string; sha256: string; sizeBytes: number;
  thumbnail?: string; collections: string[]; aliases: string[];
}
interface Project { schemaVersion: number; id: string; name: string; kind: string; documents: Doc[] }

const project = JSON.parse(readFileSync(PROJECT_OUTPUT, 'utf8')) as Project;

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'rv-library-project-'));
  dirs.push(d);
  return d;
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function glb12(marker = 0): Uint8Array {
  const b = new Uint8Array(12);
  b.set([0x67, 0x6c, 0x54, 0x46], 0);
  b[4] = 2; b[8] = 12; b[11] = marker;
  return b;
}

describe('public/library/project.json', () => {
  it('is the library project: schema 2, fixed id, demo kind', () => {
    expect(project.schemaVersion).toBe(2);
    expect(project.id).toBe(LIBRARY_PROJECT_ID);
    expect(project.id).toBe('prj_realvirtual_library');
    expect(project.name).toBe('realvirtual Library');
    expect(project.kind).toBe('demo');
  });

  it('document ids equal the 26 ids captured from catalog.json (no id was invented or lost)', () => {
    expect(FIXTURE_IDS).toHaveLength(26);
    expect(project.documents.map((d) => d.id).sort()).toEqual([...FIXTURE_IDS].sort());
  });

  it('every row carries hash, size, collections and the GitHub scan id as its alias', () => {
    for (const d of project.documents) {
      expect(d.sha256, d.id).toMatch(/^[0-9a-f]{64}$/);
      expect(d.sizeBytes, d.id).toBeGreaterThan(0);
      expect(d.collections.length, d.id).toBeGreaterThan(0);
      expect(d.path, d.id).toMatch(/\.glb$/);
      expect(d.aliases, d.id).toEqual([githubScanId(d.path)]);
      // the bytes behind `path` hash to the stamped value (dev bytes, unsigned)
      const bytes = readFileSync(join(LIBRARY_DIR, ...d.path.split('/')));
      expect(createHash('sha256').update(bytes).digest('hex'), d.id).toBe(d.sha256);
      expect(bytes.length, d.id).toBe(d.sizeBytes);
    }
    expect(project.documents.find((d) => d.id === 'pallethandling-chainconveyor-1m')!.aliases)
      .toEqual(['realvirtual-library-pallethandling-chainconveyor-1m-glb']);
  });

  it('the ids the MCP help files name are real document ids / aliases of this project', () => {
    const ids = new Set(project.documents.map((d) => d.id));
    const aliases = new Set(project.documents.flatMap((d) => d.aliases));
    for (const file of ['layout.md', 'solidcraft.md']) {
      const text = readFileSync(join(__dirname, '..', 'src', 'plugins', 'mcp-bridge', 'help', file), 'utf8');
      for (const m of text.matchAll(/(realvirtual-library-[a-z0-9-]+-glb|(?:pallethandling|robots|mobilerobots)-[a-z0-9-]+)/g)) {
        const id = m[1];
        expect(ids.has(id) || aliases.has(id), `${file} names "${id}", which is neither a document id nor an alias`).toBe(true);
      }
    }
  });

  it('aliases are unique and never shadow a document id', () => {
    const ids = new Set(project.documents.map((d) => d.id));
    const aliases = project.documents.flatMap((d) => d.aliases);
    expect(new Set(aliases).size).toBe(aliases.length);
    for (const a of aliases) expect(ids.has(a), a).toBe(false);
  });

  it('mirrors catalog.json: same order, ids, names, paths, hashes and thumbnails', async () => {
    const catalog = await buildLocalCatalog(LIBRARY_DIR);
    const rebuilt = buildLibraryProject(catalog);
    expect(project).toEqual(rebuilt);
    // and rows keep thumbnails exactly where the catalog has them
    for (const e of catalog.entries) {
      expect(project.documents.find((d) => d.id === e.id)!.thumbnail).toBe(e.thumbnail);
    }
  });
});

describe('buildLibraryProject', () => {
  it('carries footprintMm / pivotToFloor / tags where a catalog entry has them', () => {
    const base = { name: 'L', category: 'Cat', sha256: 'a'.repeat(64), sizeBytes: 12 };
    const out = buildLibraryProject({
      name: 'L',
      entries: [
        { ...base, id: 'cat-a', glbUrl: 'Cat/A.glb', footprintMm: [1000, 600], pivotToFloor: false, tags: ['x'] },
        { ...base, id: 'cat-b', glbUrl: 'Cat/B.glb' },
      ],
    });
    const a = out.documents.find((d) => d.id === 'cat-a')!;
    expect(a.footprintMm).toEqual([1000, 600]);
    expect(a.pivotToFloor).toBe(false);
    expect(a.tags).toEqual(['x']);
    const b = out.documents.find((d) => d.id === 'cat-b')!;
    expect('footprintMm' in b).toBe(false);
    expect('tags' in b).toBe(false);
  });

  it('refuses an alias that equals another document id', () => {
    const base = { name: 'L', category: 'Cat', sha256: 'a'.repeat(64), sizeBytes: 12 };
    const aliasOfA = githubScanId('Cat/A.glb');
    expect(() => buildLibraryProject({
      name: 'L',
      entries: [
        { ...base, id: 'cat-a', glbUrl: 'Cat/A.glb' },
        { ...base, id: aliasOfA, glbUrl: 'Cat/Other.glb' },
      ],
    })).toThrow(/collides with a document id/);
  });

  it('refuses a duplicate alias (two files that fold to the same scan id)', () => {
    const base = { name: 'L', category: 'Cat', sha256: 'a'.repeat(64), sizeBytes: 12 };
    expect(() => buildLibraryProject({
      name: 'L',
      entries: [
        { ...base, id: 'one', glbUrl: 'Cat/A_B.glb' },
        { ...base, id: 'two', glbUrl: 'Cat/A-B.glb' },
      ],
    })).toThrow(/not unique/);
  });

  it('the repo scan id is <repo>/<path> lowercased with non-alphanumerics folded', () => {
    expect(githubScanId('PalletHandling/ChainConveyor-1m.glb')).toBe('realvirtual-library-pallethandling-chainconveyor-1m-glb');
    expect(githubScanId('A/b c.glb', 'My_Repo')).toBe('my-repo-a-b-c-glb');
  });
});

describe('deploy re-stamp', () => {
  it('stampCatalogHashes updates the library project rows from the shipped bytes', () => {
    const dist = tmp();
    mkdirSync(join(dist, 'library', 'Cat'), { recursive: true });
    writeFileSync(join(dist, 'library', 'Cat', 'A.glb'), glb12(1));
    const stale = {
      schemaVersion: 2, id: LIBRARY_PROJECT_ID, name: 'L', kind: 'demo',
      documents: [{ id: 'cat-a', name: 'A', path: 'Cat/A.glb', sha256: '0'.repeat(64), sizeBytes: 1, collections: ['Cat'], aliases: [] }],
    };
    writeFileSync(join(dist, 'library', 'project.json'), JSON.stringify(stale, null, 2) + '\n');
    // a customer project must not be touched
    mkdirSync(join(dist, 'p'), { recursive: true });
    const other = { schemaVersion: 2, id: 'prj_customer', name: 'C', documents: [{ id: 'x', path: 'Cat/A.glb', sha256: '1'.repeat(64) }] };
    writeFileSync(join(dist, 'p', 'project.json'), JSON.stringify(other, null, 2) + '\n');

    const result = stampCatalogHashes(dist);
    expect(result).toMatchObject({ libraryProjects: 1, projectRows: 1 });
    const row = (JSON.parse(readFileSync(join(dist, 'library', 'project.json'), 'utf8')) as Project).documents[0];
    expect(row.sha256).toBe(createHash('sha256').update(glb12(1)).digest('hex'));
    expect(row.sizeBytes).toBe(12);
    expect(JSON.parse(readFileSync(join(dist, 'p', 'project.json'), 'utf8'))).toEqual(other);
  });
});
