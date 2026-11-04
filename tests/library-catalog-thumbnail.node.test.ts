// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-776 §9.6 — the catalog `thumbnail` field and the delivery channels.
 *
 *  - `normalizeCatalogEntry` resolves a relative `thumbnail` against the
 *    catalog base; an explicit absolute `thumbnailUrl` of another source wins;
 *  - `build-local-library-catalog` derives `thumbnail` from
 *    `<category>/.thumbnails/` (newest hashed file wins, a legacy hash-less PNG
 *    is ignored), so `prebuild` never drops it;
 *  - every delivery channel carries `.thumbnails/`, and an encrypted hosted
 *    deploy encrypts it (P2) — the envelope decrypts back with the password and
 *    refuses without it (the viewer's resolver then shows the placeholder).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeCatalogEntry } from '../src/core/library/library-store';
import { encodeThumbnailId as encodeTs } from '../src/core/library/library-types';
import { buildLocalCatalog, buildLibraryProject, encodeThumbnailId as encodeMjs, findCatalogThumbnail } from '../scripts/build-local-library-catalog.mjs';
import {
  collectLocalFiles,
  copyProjectVerbatim,
  isEncryptablePath,
  stageHostedProject,
  HOSTED_PROJECT_PREFIX,
} from '../scripts/_bunny-lib.mjs';
import { hostedDeployDenyReason, isDeniedProjectArtifactPath } from '../scripts/_rv-guards.mjs';
// @ts-expect-error Node deploy modules intentionally have no declaration files.
import { decryptGlb, generateFragmentSecret, isEncryptedEnvelope } from '../scripts/lib/rv-crypto.mjs';

let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'rv-776-catalog-')); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

function write(rel: string, body: string | Buffer, mtimeSec?: number): string {
  const abs = join(work, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, body);
  if (mtimeSec !== undefined) utimesSync(abs, mtimeSec, mtimeSec);
  return abs;
}

function makeGlb(): Buffer {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }], nodes: [] }), 'utf8');
  const jsonLength = (json.length + 3) & ~3;
  const glb = Buffer.alloc(20 + jsonLength, 0x20);
  glb.writeUInt32LE(0x46546c67, 0);
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(jsonLength, 12);
  glb.writeUInt32LE(0x4e4f534a, 16);
  json.copy(glb, 20);
  return glb;
}

// ─── The catalog reader (F11) ────────────────────────────────────────────

describe('normalizeCatalogEntry — the `thumbnail` field', () => {
  const BASE = 'https://cdn.example/library/';

  it('resolves a relative pointer against the catalog base', () => {
    const e = normalizeCatalogEntry({ id: 'belt', glbUrl: 'PalletHandling/Belt.glb',
      thumbnail: 'PalletHandling/.thumbnails/belt.3fa9c2d1.webp' }, BASE);
    expect(e.thumbnailUrl).toBe('https://cdn.example/library/PalletHandling/.thumbnails/belt.3fa9c2d1.webp');
  });

  it('keeps an explicit absolute thumbnailUrl of another source unchanged', () => {
    const e = normalizeCatalogEntry({ id: 'x', glbUrl: 'x.glb', thumbnailUrl: 'https://simready.example/x.png',
      thumbnail: 'Cat/.thumbnails/x.00000000.webp' }, BASE);
    expect(e.thumbnailUrl).toBe('https://simready.example/x.png');
  });

  it('accepts a hand-written hash-less catalog picture, refuses a `..` escape, and is empty without either', () => {
    expect(normalizeCatalogEntry({ id: 'a', glbUrl: 'a.glb', thumbnail: 'Cat/a.png' }, BASE).thumbnailUrl)
      .toBe('https://cdn.example/library/Cat/a.png');
    expect(normalizeCatalogEntry({ id: 'a', glbUrl: 'a.glb', thumbnail: '../secret.png' }, BASE).thumbnailUrl).toBe('');
    expect(normalizeCatalogEntry({ id: 'a', glbUrl: 'a.glb' }, BASE).thumbnailUrl).toBe('');
  });
});

// ─── The catalog builder (F11) ───────────────────────────────────────────

describe('build-local-library-catalog — derives `thumbnail` from the category folder', () => {
  it('emits the hashed sidecar of an entry, and no field without one', async () => {
    write('PalletHandling/Belt-2m.glb', makeGlb());
    write('PalletHandling/Roller.glb', makeGlb());
    write('PalletHandling/.thumbnails/pallethandling-belt-2m.3fa9c2d1.webp', 'WEBP');
    const catalog = await buildLocalCatalog(work, { filterIgnored: false });
    const belt = catalog.entries.find((e) => e.id === 'pallethandling-belt-2m')!;
    const roller = catalog.entries.find((e) => e.id === 'pallethandling-roller')!;
    expect(belt.thumbnail).toBe('PalletHandling/.thumbnails/pallethandling-belt-2m.3fa9c2d1.webp');
    expect('thumbnail' in roller).toBe(false);
    // plan-778: the library PROJECT rows carry the same pointer (relative to project.json).
    const rows = buildLibraryProject(catalog).documents;
    expect(rows.find((d) => d.id === 'pallethandling-belt-2m')!.thumbnail)
      .toBe('PalletHandling/.thumbnails/pallethandling-belt-2m.3fa9c2d1.webp');
    expect('thumbnail' in rows.find((d) => d.id === 'pallethandling-roller')!).toBe(false);
  });

  it('several files for one id: the newest wins; a legacy hash-less PNG is ignored', () => {
    write('Cat/.thumbnails/x.11111111.webp', 'old', 1_000_000);
    write('Cat/.thumbnails/x.22222222.png', 'new', 2_000_000);
    write('Cat/.thumbnails/x.png', 'legacy', 3_000_000);
    write('Cat/.thumbnails/x.a.33333333.webp', 'another id', 4_000_000);
    expect(findCatalogThumbnail(work, 'Cat', 'x')).toBe('Cat/.thumbnails/x.22222222.png');
    expect(findCatalogThumbnail(work, 'Cat', 'nothing')).toBeNull();
  });

  it('encodes ids exactly like the viewer (encodeThumbnailId has one meaning)', () => {
    for (const id of ['belt', 'a/b', 'doc:1', 'Ā0', `doc_${'x'.repeat(300)}`]) {
      expect(encodeMjs(id)).toBe(encodeTs(id));
    }
  });
});

// ─── Delivery channels (F14) ─────────────────────────────────────────────

describe('delivery — every channel carries .thumbnails/', () => {
  it('a hosted deploy publishes and encrypts the sidecars; nothing denies them', () => {
    expect(isEncryptablePath('.thumbnails/x.3fa9c2d1.webp')).toBe(true);
    expect(isEncryptablePath('library/Cat/.thumbnails/x.3fa9c2d1.png')).toBe(true);
    expect(isEncryptablePath('.thumbnails/notes.txt')).toBe(false);
    expect(hostedDeployDenyReason('.thumbnails/x.3fa9c2d1.webp')).toBeNull();
    expect(hostedDeployDenyReason('.thumbnails', { isDir: true })).toBeNull();
    expect(isDeniedProjectArtifactPath('.thumbnails/x.3fa9c2d1.webp')).toBe(false);
  });

  it('copyProjectVerbatim and collectLocalFiles carry .thumbnails/', () => {
    write('project/project.json', '{}');
    write('project/models/a.glb', makeGlb());
    write('project/.thumbnails/doc_a.3fa9c2d1.webp', 'WEBP');
    const report = copyProjectVerbatim(join(work, 'project'), join(work, 'out'), { ignoreRules: [] });
    expect(report.copied).toContain('.thumbnails/doc_a.3fa9c2d1.webp');
    const rels = collectLocalFiles(join(work, 'out')).map((f: { rel: string }) => f.rel);
    expect(rels).toContain('.thumbnails/doc_a.3fa9c2d1.webp');
  });

  it('the customer delivery copies whole category folders, with no filter (P1)', () => {
    const src = readFileSync(join(__dirname, '..', 'scripts', '_workspace-lib.mjs'), 'utf8');
    const body = src.slice(src.indexOf('function copyLibraryIntoCore('), src.indexOf('function writeDeliveredLibraryCatalog('));
    expect(body).toMatch(/copyTree\(source, join\(coreOutput, 'public', 'library', category\)\);/);
  });

  it('an encrypted hosted deploy encrypts the sidecar; it decrypts with the password, not without', async () => {
    const distDir = join(work, 'dist');
    const projectDir = join(work, 'projects', 'acme');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, 'index.html'), '<html></html>');
    write('projects/acme/project.json', JSON.stringify({ name: 'Acme', code: 'acme-code' }));
    write('projects/acme/models/line.glb', makeGlb());
    const picture = Buffer.from('RIFF....WEBPVP8 fake-picture-bytes');
    write('projects/acme/.thumbnails/doc_line.3fa9c2d1.webp', picture);
    const fragmentSecret = generateFragmentSecret();
    let encrypted: string[] = [];
    const staging = await stageHostedProject({
      distDir, projectDir,
      encryption: { password: 'acme-2027', fragmentSecret, iterations: 1000 },
      onReport: (r: { encrypted: string[] }) => { encrypted = r.encrypted; },
    });
    try {
      expect(encrypted).toContain('.thumbnails/doc_line.3fa9c2d1.webp');
      const enc = readFileSync(join(staging, HOSTED_PROJECT_PREFIX, '.thumbnails', 'doc_line.3fa9c2d1.webp'));
      expect(isEncryptedEnvelope(enc)).toBe(true);
      expect(Buffer.from(await decryptGlb(enc, 'acme-2027', fragmentSecret)).equals(picture)).toBe(true);
      await expect(decryptGlb(enc, 'wrong', fragmentSecret)).rejects.toThrow();
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });
});
