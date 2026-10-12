// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * library-catalog-hash.node.test.ts — plan-508 F2.
 *
 * The catalog carries `sha256` + `sizeBytes` per asset, and the browser keys
 * its blob cache on that hash and verifies every download with it. So the
 * Node side (builders, deploy stamper) and the browser side (`sha256Hex`) must
 * spell the same string for the same bytes, and the builders must write both
 * fields for every entry.
 *
 * Runner: `npm run test:node` (vitest.node.config.ts, environment: node).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Typed through the sibling declaration file scripts/lib/rv-hash.d.mts (plan-587 F6).
import { sha256Buffer, sha256File } from '../scripts/lib/rv-hash.mjs';
import { sha256Hex } from '../src/core/import/rv-cad-glb-cache';
import { buildLocalCatalog } from '../scripts/build-local-library-catalog.mjs';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'rv-catalog-hash-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A 12-byte GLB header: 'glTF', version 2, total length 12. */
function glb12(marker = 0): Uint8Array {
  const b = new Uint8Array(12);
  b.set([0x67, 0x6c, 0x54, 0x46], 0);
  b[4] = 2;
  b[8] = 12;
  b[11] = marker;
  return b;
}

describe('catalog hash parity', () => {
  it('node createHash, rv-hash.mjs and browser sha256Hex agree on a golden vector', async () => {
    const bytes = new TextEncoder().encode('glTF\u0002\u0000\u0000\u0000');
    const golden = createHash('sha256').update(bytes).digest('hex');
    expect(golden).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Buffer(bytes)).toBe(golden);
    expect(sha256Buffer(bytes.buffer.slice(0))).toBe(golden);
    expect(await sha256Hex(bytes.buffer.slice(0) as ArrayBuffer)).toBe(golden);
    // The empty input has a well-known digest — pins the hex spelling (lowercase, 64 chars).
    expect(sha256Buffer(new Uint8Array(0))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(await sha256Hex(new ArrayBuffer(0))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('sha256File returns the hash and the size of a file', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'a.glb'), glb12(7));
    const info = sha256File(join(dir, 'a.glb'));
    expect(info.sizeBytes).toBe(12);
    expect(info.sha256).toBe(createHash('sha256').update(glb12(7)).digest('hex'));
  });
});

describe('build-local-library-catalog', () => {
  it('writes sha256 and sizeBytes for every glb entry', { timeout: 30_000 }, async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'PalletHandling'), { recursive: true });
    writeFileSync(join(dir, 'PalletHandling', 'Belt-1m.glb'), glb12(1));
    writeFileSync(join(dir, 'Loose.glb'), glb12(2));
    writeFileSync(join(dir, 'readme.txt'), 'not an asset');

    const catalog = await buildLocalCatalog(dir);
    expect(catalog.entries).toHaveLength(2);
    for (const e of catalog.entries) {
      expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(e.sizeBytes).toBe(12);
      expect(e.sha256).toBe(createHash('sha256').update(readFileSync(join(dir, ...e.glbUrl.split('/')))).digest('hex'));
    }
    const belt = catalog.entries.find((e) => e.glbUrl === 'PalletHandling/Belt-1m.glb')!;
    // Existing fields keep their names and order; the hash fields come last.
    expect(Object.keys(belt)).toEqual(['id', 'name', 'category', 'glbUrl', 'sha256', 'sizeBytes']);
    expect(belt).toMatchObject({ id: 'pallethandling-belt-1m', name: 'Belt 1m', category: 'Pallet Handling' });
  });

  it('the checked-in public/library/catalog.json is stamped for every entry and matches the files', () => {
    const root = join(__dirname, '..', 'public', 'library');
    const catalog = JSON.parse(readFileSync(join(root, 'catalog.json'), 'utf8')) as {
      entries: Array<{ glbUrl: string; sha256?: string; sizeBytes?: number }>;
    };
    expect(catalog.entries.length).toBeGreaterThan(0);
    for (const e of catalog.entries) {
      const bytes = readFileSync(join(root, ...e.glbUrl.split('/')));
      expect(e.sizeBytes, e.glbUrl).toBe(bytes.byteLength);
      expect(e.sha256, e.glbUrl).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
  }, 120_000); // hashes the whole bundled library (tens of MB)
});
