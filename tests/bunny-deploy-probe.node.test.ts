// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * bunny-deploy-probe.node.test.ts — plan-508 F2 / F2b / F8.
 *
 *  - `probePublishedAssets`: the live host answers a missing asset with a
 *    404 (Bunny's text/html error page accepted, a 200 fails), serves the
 *    library manifest (`library/project.json` since plan-778 Phase 4) byte-for-byte
 *    and the first asset with bytes that hash to the
 *    catalog `sha256`.
 *  - deploy ordering: the catalog is stamped AFTER signing (signing is size-
 *    preserving, the hash is not), a same-size binary whose catalog hash changed
 *    is uploaded, and the catalog goes up LAST — a failed binary leaves the old
 *    catalog remote so the next run selects the binary again.
 *
 * Runner: `npm run test:node` (vitest.node.config.ts, environment: node).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  probePublishedAssets,
  stampCatalogHashes,
  catalogChangedBinaries,
  catalogEntryBinaryRel,
  selectFilesToUpload,
  collectLocalFiles,
  isAlwaysUploadFile,
  PROBE_MISSING_ASSET,
} from '../scripts/_bunny-lib.mjs';
import { uploadDirectory, catalogHashDiff, isCatalogFile } from '../scripts/bunny-deploy.mjs';
import { loadSigningConfig, signGlbFile } from '../scripts/rv-sign-glb.mjs';

const sha = (b: Uint8Array | Buffer): string => createHash('sha256').update(b).digest('hex');

let dist = '';
beforeEach(() => {
  dist = mkdtempSync(join(tmpdir(), 'rv-probe-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dist, { recursive: true, force: true });
});

/** A minimal valid GLB (JSON chunk only) — signable by `rv-sign-glb.mjs`. */
function makeGlb(tag = 'a'): Buffer {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0', generator: tag }, scene: 0, scenes: [{ nodes: [] }], nodes: [] }), 'utf8');
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

/**
 * The realvirtual library as the build ships it: `library/<rel>` files and the
 * library PROJECT manifest `library/project.json` (plan-778 Phase 4 — the bundled
 * catalog.json is gone). Rows are stamped like the deploy stamps them. Returns
 * the manifest text.
 */
function writeLibrary(entries: Array<{ rel: string; bytes: Buffer }>): string {
  mkdirSync(join(dist, 'library'), { recursive: true });
  for (const e of entries) {
    const abs = join(dist, 'library', ...e.rel.split('/'));
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, e.bytes);
  }
  writeFileSync(join(dist, 'library', 'project.json'), JSON.stringify({
    schemaVersion: 2, id: 'prj_realvirtual_library', name: 'test', kind: 'demo',
    documents: entries.map((e, i) => ({ id: `g${i}`, name: `G${i}`, path: e.rel })),
  }, null, 2) + '\n');
  stampCatalogHashes(dist);
  return readFileSync(join(dist, 'library', 'project.json'), 'utf8');
}

/** An EXTERNAL URL catalog in the build (catalog.json stays their format), stamped. */
const PARTNER = 'catalogs/partner';
function writeCatalog(entries: Array<{ rel: string; bytes: Buffer; splat?: boolean }>): string {
  mkdirSync(join(dist, PARTNER), { recursive: true });
  for (const e of entries) {
    const abs = join(dist, PARTNER, ...e.rel.split('/'));
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, e.bytes);
  }
  const catalog = {
    version: '1.0',
    name: 'test',
    entries: entries.map((e, i) => (e.splat
      ? { id: `s${i}`, name: `S${i}`, category: 'splat', splatUrl: e.rel }
      : { id: `g${i}`, name: `G${i}`, category: 'custom', glbUrl: e.rel })),
  };
  writeFileSync(join(dist, PARTNER, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
  stampCatalogHashes(dist);
  return readFileSync(join(dist, PARTNER, 'catalog.json'), 'utf8');
}

function response(status: number, body: Uint8Array | string, type: string): Response {
  return new Response(typeof body === 'string' ? body : new Uint8Array(body), { status, headers: { 'content-type': type } });
}

/** A host double: `routes` maps a path (after the base, query stripped) to a response factory. */
function host(routes: Record<string, () => Response>) {
  const seen: string[] = [];
  const fetchImpl = vi.fn(async (url: string) => {
    const path = url.replace('https://cdn.example.com/demo/', '').split('?')[0];
    seen.push(url);
    return routes[decodeURIComponent(path)]?.() ?? response(404, 'not found', 'text/plain');
  });
  return { fetchImpl, seen };
}

describe('probePublishedAssets', { timeout: 30_000 }, () => {
  const baseUrl = 'https://cdn.example.com/demo/';

  it('passes when the missing probe is 404, the remote library manifest equals dist byte-for-byte and the first asset hashes to its sha256', async () => {
    const glb = makeGlb('first');
    const manifestText = writeLibrary([{ rel: 'Pallet/Belt.glb', bytes: glb }]);
    const { fetchImpl, seen } = host({
      'library/project.json': () => response(200, manifestText, 'application/json'),
      'library/Pallet/Belt.glb': () => response(200, glb, 'model/gltf-binary'),
    });
    const result = await probePublishedAssets({ baseUrl, distDir: dist, fetchImpl });
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checks).toHaveLength(3);
    expect(seen[0]).toBe(`${baseUrl}${PROBE_MISSING_ASSET}`);
    // The manifest and asset GETs bypass a stale edge copy.
    expect(seen[1]).toMatch(/library\/project\.json\?rv-probe=\d+$/);
  });

  // plan-778 Phase 4: the probed manifest is library/project.json by default; an external
  // catalog in the catalog.json format is still probed the same way when named.
  it('probes an external catalog.json (entries form) when given as catalogRel', async () => {
    const glb = makeGlb('p');
    const catalogText = writeCatalog([{ rel: 'Belt.glb', bytes: glb }]);
    const routes = (catalog: string) => ({
      [`${PARTNER}/catalog.json`]: () => response(200, catalog, 'application/json'),
      [`${PARTNER}/Belt.glb`]: () => response(200, glb, 'model/gltf-binary'),
    });
    const catalogRel = `${PARTNER}/catalog.json`;
    const ok = await probePublishedAssets({ baseUrl, distDir: dist, fetchImpl: host(routes(catalogText)).fetchImpl, catalogRel });
    expect(ok.findings).toEqual([]);
    expect(ok.checks.join('\n')).toMatch(/catalogs\/partner\/catalog\.json -> 200, byte-equal to dist/);
    const stale = catalogText.replace(/"sha256": "(.)/, (_m, c: string) => `"sha256": "${c === 'a' ? 'b' : 'a'}`);
    const bad = await probePublishedAssets({ baseUrl, distDir: dist, fetchImpl: host(routes(stale)).fetchImpl, catalogRel });
    expect(bad.ok).toBe(false);
    expect(bad.findings.join('\n')).toMatch(/catalogs\/partner\/catalog\.json on the host differs from the build output/);
  });

  it('fails with a named finding when the missing probe answers 200 text/html', async () => {
    const manifestText = writeLibrary([{ rel: 'Belt.glb', bytes: makeGlb() }]);
    const { fetchImpl } = host({
      [PROBE_MISSING_ASSET]: () => response(200, '<!DOCTYPE html><html></html>', 'text/html'),
      'library/project.json': () => response(200, manifestText, 'application/json'),
      'library/Belt.glb': () => response(200, makeGlb(), 'application/octet-stream'),
    });
    const result = await probePublishedAssets({ baseUrl, distDir: dist, fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.findings.join('\n')).toMatch(/__rv-probe-missing__\.glb answered HTTP 200 \(text\/html\).*answered 200 — the host serves a fallback page instead of 404/);
  });

  it('fails when the missing probe answers 200 with a binary type (any 200 is a fallback)', async () => {
    const { fetchImpl } = host({ [PROBE_MISSING_ASSET]: () => response(200, makeGlb(), 'model/gltf-binary') });
    const result = await probePublishedAssets({ baseUrl, distDir: dist, fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.findings[0]).toMatch(/answered HTTP 200 \(model\/gltf-binary\).*fallback page instead of 404/);
  });

  it('fails when the missing probe answers another non-404 status', async () => {
    const { fetchImpl } = host({ [PROBE_MISSING_ASSET]: () => response(403, 'denied', 'text/plain') });
    const result = await probePublishedAssets({ baseUrl, distDir: dist, fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.findings[0]).toMatch(/answered HTTP 403 \(text\/plain\).*must be a 404/);
  });

  it('accepts a 404 that carries an HTML page (Bunny standard error page)', async () => {
    const { fetchImpl } = host({ [PROBE_MISSING_ASSET]: () => response(404, '<html>custom 404</html>', 'text/html') });
    const result = await probePublishedAssets({ baseUrl, distDir: dist, fetchImpl });
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checks[0]).toBe(`${PROBE_MISSING_ASSET} -> 404 (text/html error page, accepted)`);
  });

  it('fails when the remote library manifest differs from dist (the same-size skip)', async () => {
    const glb = makeGlb();
    const manifestText = writeLibrary([{ rel: 'Belt.glb', bytes: glb }]);
    // Same length, one hash digit flipped — what a size-only diff leaves behind.
    const stale = manifestText.replace(/"sha256": "(.)/, (_m, c: string) => `"sha256": "${c === 'a' ? 'b' : 'a'}`);
    expect(stale.length).toBe(manifestText.length);
    const { fetchImpl } = host({
      'library/project.json': () => response(200, stale, 'application/json'),
      'library/Belt.glb': () => response(200, glb, 'model/gltf-binary'),
    });
    const result = await probePublishedAssets({ baseUrl, distDir: dist, fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.findings.join('\n')).toMatch(/library\/project\.json on the host differs from the build output/);
  });

  it('fails when the first asset bytes hash differently (size-preserving re-sign not stamped)', async () => {
    const glb = makeGlb('x');
    const manifestText = writeLibrary([{ rel: 'Belt.glb', bytes: glb }]);
    const other = Buffer.from(glb);
    other[other.length - 1] = 0x21; // same size, different bytes
    const { fetchImpl } = host({
      'library/project.json': () => response(200, manifestText, 'application/json'),
      'library/Belt.glb': () => response(200, other, 'model/gltf-binary'),
    });
    const result = await probePublishedAssets({ baseUrl, distDir: dist, fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.findings.join('\n')).toMatch(/Belt\.glb: served bytes hash to .* the catalog says/);
  });

  it('flags an HTML content-type for the asset and a network failure without throwing', async () => {
    const glb = makeGlb();
    const manifestText = writeLibrary([{ rel: 'Belt.glb', bytes: glb }]);
    const { fetchImpl } = host({
      'library/project.json': () => response(200, manifestText, 'application/json'),
      'library/Belt.glb': () => response(200, glb, 'text/html'),
    });
    const html = await probePublishedAssets({ baseUrl, distDir: dist, fetchImpl });
    expect(html.findings.join('\n')).toMatch(/content-type "text\/html"/);

    const down = await probePublishedAssets({ baseUrl, distDir: dist, fetchImpl: vi.fn(async () => { throw new TypeError('fetch failed'); }) });
    expect(down.ok).toBe(false);
    expect(down.findings[0]).toMatch(/failed: fetch failed/);
  });

  it('refuses a build output that contains the reserved probe path', async () => {
    mkdirSync(join(dist, 'library'), { recursive: true });
    writeFileSync(join(dist, PROBE_MISSING_ASSET), makeGlb());
    const { fetchImpl } = host({});
    const result = await probePublishedAssets({ baseUrl, distDir: dist, fetchImpl });
    expect(result.findings[0]).toMatch(/must never be deployed/);
  });
});

// ─── Deploy ordering ──────────────────────────────────────────────────────

function rawPublicKey(key: KeyObject): Buffer {
  return Buffer.from(key.export({ format: 'jwk' }).x!, 'base64url');
}
function signingWith(key: { privateKey: KeyObject; publicKey: KeyObject }) {
  const env = { RV_SIGN_PRIVATE_KEY: Buffer.from(key.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string).toString('base64') };
  const signing = loadSigningConfig(env, rawPublicKey(key.publicKey));
  if (!signing) throw new Error('test signing configuration was not created');
  return signing;
}

// Key generation and a few file round trips — generous on a loaded CI box.
describe('deploy ordering', { timeout: 60_000 }, () => {
  it('stampCatalogHashes after signGlbsInDirectory yields row/entry sha256 == sha256 of the signed file', () => {
    writeLibrary([{ rel: 'Pallet/Belt.glb', bytes: makeGlb('belt') }]);
    writeCatalog([{ rel: 'Belt.glb', bytes: makeGlb('partner-belt') }]);
    const libraryPath = join(dist, 'library', 'Pallet', 'Belt.glb');
    const catalogPath = join(dist, PARTNER, 'Belt.glb');
    const readRow = () => JSON.parse(readFileSync(join(dist, 'library', 'project.json'), 'utf8')).documents[0];
    const readEntry = () => JSON.parse(readFileSync(join(dist, PARTNER, 'catalog.json'), 'utf8')).entries[0];
    const devHash = readRow().sha256;

    // First signing (the deploy's signGlbsInDirectory), then a RE-sign with another key:
    // size-preserving by design, which is exactly why a size check cannot see it.
    signGlbFile(libraryPath, signingWith(generateKeyPairSync('ed25519')));
    const firstSigned = readFileSync(libraryPath);
    signGlbFile(libraryPath, signingWith(generateKeyPairSync('ed25519')));
    const signed = readFileSync(libraryPath);
    expect(signed.length).toBe(firstSigned.length);
    expect(sha(signed)).not.toBe(sha(firstSigned));
    signGlbFile(catalogPath, signingWith(generateKeyPairSync('ed25519')));
    const signedPartner = readFileSync(catalogPath);

    // Without the stamp the shipped manifest still describes the unsigned dev bytes.
    expect(readRow().sha256).toBe(devHash);
    expect(readRow().sha256).not.toBe(sha(signed));

    const result = stampCatalogHashes(dist);
    expect(result).toEqual({ catalogs: 1, stamped: 1, libraryProjects: 1, projectRows: 1 });
    // The library project's row (plan-778) and an external catalog's entry, both from the signed bytes.
    expect(readRow().sha256).toBe(sha(signed));
    expect(readRow().sizeBytes).toBe(signed.length);
    expect(readEntry().sha256).toBe(sha(signedPartner));
    expect(readEntry().sizeBytes).toBe(signedPartner.length);
  });

  it('selectFilesToUpload picks catalog.json and a same-size glb AND a same-size splat whose catalog hash changed', () => {
    const glb = makeGlb('v1');
    const splat = Buffer.alloc(64, 1);
    const published = writeCatalog([
      { rel: 'Belt.glb', bytes: glb },
      { rel: 'Hall.splat', bytes: splat, splat: true },
      { rel: 'Same.glb', bytes: makeGlb('same') },
    ]);
    // New bytes, identical sizes.
    const glb2 = Buffer.from(glb); glb2[glb2.length - 1] = 0x21;
    const splat2 = Buffer.alloc(64, 2);
    writeFileSync(join(dist, PARTNER, 'Belt.glb'), glb2);
    writeFileSync(join(dist, PARTNER, 'Hall.splat'), splat2);
    stampCatalogHashes(dist);

    const changed = catalogChangedBinaries(dist, `${PARTNER}/catalog.json`, published);
    expect(changed.sort()).toEqual([`${PARTNER}/Belt.glb`, `${PARTNER}/Hall.splat`]);

    const local = collectLocalFiles(dist);
    const remote = new Map(local.map((f) => [f.rel.toLowerCase(), f.size] as [string, number]));
    const selected = selectFilesToUpload(local, remote, { alwaysUploadRel: changed }).map((f) => f.rel).sort();
    expect(selected).toEqual([`${PARTNER}/Belt.glb`, `${PARTNER}/Hall.splat`, `${PARTNER}/catalog.json`]);
    expect(isAlwaysUploadFile(`${PARTNER}/catalog.json`)).toBe(true);
    expect(isAlwaysUploadFile('x/y/catalog.json')).toBe(true);

    // No published catalog (first deploy): every catalogued file counts as changed.
    expect(catalogChangedBinaries(dist, `${PARTNER}/catalog.json`, null).sort())
      .toEqual([`${PARTNER}/Belt.glb`, `${PARTNER}/Hall.splat`, `${PARTNER}/Same.glb`]);
  });

  it('catalogEntryBinaryRel resolves relative urls and ignores absolute ones', () => {
    expect(catalogEntryBinaryRel(`${PARTNER}/catalog.json`, { glbUrl: 'A%20B/x.glb' })).toBe(`${PARTNER}/A B/x.glb`);
    expect(catalogEntryBinaryRel('catalog.json', { splatUrl: 'x.ply' })).toBe('x.ply');
    expect(catalogEntryBinaryRel(`${PARTNER}/catalog.json`, { glbUrl: 'https://raw.githubusercontent.com/a/b.glb' })).toBeNull();
    expect(catalogEntryBinaryRel(`${PARTNER}/catalog.json`, { glbUrl: '/library/x.glb' })).toBeNull();
    expect(catalogEntryBinaryRel(`${PARTNER}/catalog.json`, { glbUrl: '../../../x.glb' })).toBeNull();
    expect(isCatalogFile(`${PARTNER}/catalog.json`)).toBe(true);
    expect(isCatalogFile(`${PARTNER}/catalog.json.bak`)).toBe(false);
    // plan-778: the library project is deferred like a catalog (hashes of the binaries beside it) ...
    expect(isCatalogFile('library/project.json')).toBe(true);
    // ... but any other project.json is an ordinary manifest.
    expect(isCatalogFile('demo/project.json')).toBe(false);
    expect(catalogEntryBinaryRel('library/project.json', { path: 'Pallet/Belt.glb' })).toBe('library/Pallet/Belt.glb');
  });

  it('the library manifest is uploaded last; when a binary fails, the old manifest stays remote and the next run selects the binary again', async () => {
    const published = writeLibrary([
      { rel: 'A.glb', bytes: makeGlb('a1') },
      { rel: 'B.glb', bytes: makeGlb('b1') },
    ]);
    // Both GLBs change at the same size.
    for (const name of ['A.glb', 'B.glb']) {
      const p = join(dist, 'library', name);
      const b = readFileSync(p); b[b.length - 1] = 0x21; writeFileSync(p, b);
    }
    stampCatalogHashes(dist);
    writeFileSync(join(dist, 'index.html'), '<html></html>');

    const manifestRel = 'library/project.json';
    const remoteFiles = new Map<string, Buffer>();
    for (const f of collectLocalFiles(dist)) remoteFiles.set(f.rel, f.rel === manifestRel ? Buffer.from(published) : readFileSync(f.abs));
    const order: string[] = [];
    let failB = true;
    const client = {
      listRecursive: async () => [...remoteFiles.entries()].map(([rel, b]) => ({ rel, size: b.length, isDirectory: false })),
      getFileIfExists: async (path: string) => remoteFiles.get(path.replace(/^demo\//, '')) ?? null,
      putFile: async (bytes: Buffer, path: string) => {
        const rel = path.replace(/^demo\//, '');
        if (rel === 'library/B.glb' && failB) throw new Error('storage down');
        order.push(rel);
        remoteFiles.set(rel, Buffer.from(bytes));
      },
      deleteFile: async () => {},
    };
    const opts = { force: false, dryRun: false, alwaysUploadGlbs: false };

    // Run 1: B fails → the pool rejects before the manifest and the HTML are sent.
    const diff1 = await catalogHashDiff(client, dist, 'demo');
    expect([...diff1].sort()).toEqual(['library/A.glb', 'library/B.glb']);
    await expect(uploadDirectory(client, dist, 'demo', { ...opts, alwaysUploadRel: diff1 })).rejects.toThrow(/Failed to upload library\/B\.glb/);
    expect(order).toContain('library/A.glb');
    expect(order).not.toContain(manifestRel);
    expect(order).not.toContain('index.html');
    expect(remoteFiles.get(manifestRel)!.toString('utf8')).toBe(published);

    // Run 2 (resume): the remote manifest is still the old one, so B is selected again.
    failB = false;
    order.length = 0;
    const diff2 = await catalogHashDiff(client, dist, 'demo');
    expect([...diff2]).toContain('library/B.glb');
    await uploadDirectory(client, dist, 'demo', { ...opts, alwaysUploadRel: diff2 });
    expect(order).toContain('library/B.glb');
    // The manifest follows every binary; only the HTML comes after it.
    const manifestAt = order.indexOf(manifestRel);
    expect(manifestAt).toBeGreaterThan(order.indexOf('library/B.glb'));
    expect(order.slice(manifestAt + 1)).toEqual(['index.html']);
    expect(remoteFiles.get(manifestRel)!.equals(readFileSync(join(dist, 'library', 'project.json')))).toBe(true);

    // Run 3: nothing changed any more — only the always-upload files go.
    const diff3 = await catalogHashDiff(client, dist, 'demo');
    expect([...diff3]).toEqual([]);
  });
});
