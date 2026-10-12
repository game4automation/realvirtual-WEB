// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-596 Phase 2 — AAS sources: project over deploy, per-project caching,
 * invalidation, and the encrypted hosted path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';
import { makeAasx } from './helpers/aasx-fixtures';
import { FolderBackend } from '../src/core/project/backends/folder-backend';
import {
  MergedAasSource,
  ProjectAasSource,
  invalidateAasSource,
  lookupAas,
  projectAasSourceFor,
  readIndexJson,
  resetAasSources,
  urlAasSourceFor,
  type AasProjectBackend,
} from '../src/core/aas/rv-aas-source';
import { loadAasDetail, resetCache } from '../src/plugins/aas-link-parser';
import { encryptToEnvelope } from '../src/core/persistence/rv-crypto-utils';
import { clearSessionKeys, setSessionKey } from '../src/core/persistence/rv-served-bytes';

const SEW_ID = 'https://demo.realvirtual.io/aas/sew/KA47-DRN90M4-Demo-0001';
const FESTO = { id: 'urn:festo:a', idShort: 'FestoA', productName: 'Festo Cylinder', manufacturer: 'Festo SE & Co. KG' };

/** Route `fetch` by URL suffix; every call gets a fresh Response. */
function routeFetch(routes: Record<string, () => BodyInit | null>, onCall?: (url: string) => void): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    onCall?.(url);
    for (const [suffix, body] of Object.entries(routes)) {
      if (url.endsWith(suffix)) return new Response(body() as BodyInit, { status: 200 });
    }
    return new Response(null, { status: 404 });
  });
}

async function folderProject(files: Record<string, Uint8Array | string>): Promise<FolderBackend> {
  const root = new FakeDir('Proj');
  const aasx = root.seedDir('aasx');
  for (const [name, body] of Object.entries(files)) {
    const h = await aasx.getFileHandle(name, { create: true });
    const w = await h.createWritable();
    await w.write(new Blob([body as BlobPart]));
    await w.close();
  }
  const backend = new FolderBackend(asDirHandle(root), { writable: true, id: `folder:${Math.random()}` });
  await backend.activate();
  return backend;
}

beforeEach(() => {
  resetAasSources();
  resetCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  clearSessionKeys();
});

describe('MergedAasSource', () => {
  it('the project wins per id; the deploy index stays the fallback (SEW demo id)', async () => {
    const festoAasx = await makeAasx([FESTO]);
    const backend = await folderProject({
      'festo.aasx': festoAasx,
      'index.json': JSON.stringify({ [FESTO.id]: { file: 'festo.aasx', idShort: 'FestoA' } }),
    });
    routeFetch({
      '/deploy/aasx/index.json': () => JSON.stringify({
        [SEW_ID]: { file: '26_SEW.aasx', idShort: 'SEW' },
        [FESTO.id]: { file: 'deploy-copy.aasx', idShort: 'DeployCopy' },
      }),
    });
    const project = projectAasSourceFor(backend, 'p1');
    const deploy = urlAasSourceFor('/deploy/aasx/');
    const merged = new MergedAasSource([project, deploy]);

    const idx = await merged.readIndex();
    expect(idx.kind).toBe('available');
    if (idx.kind === 'available') {
      expect(idx.index[FESTO.id].file).toBe('festo.aasx');
      expect(idx.index[SEW_ID].file).toBe('26_SEW.aasx');
    }
    expect((await lookupAas(merged, FESTO.id))?.source).toBe(project);
    expect((await lookupAas(merged, SEW_ID))?.source).toBe(deploy);
    expect(await lookupAas(merged, 'urn:unknown')).toBeNull();

    // The detail is read from the project's own archive.
    const lookup = (await lookupAas(merged, FESTO.id))!;
    const detail = await loadAasDetail(lookup, FESTO.id);
    expect(detail.nameplate.find(p => p.label === 'Manufacturer Product Designation')?.value).toBe('Festo Cylinder');
  });

  it('missing project index + available deploy index = available', async () => {
    const backend = await folderProject({});
    routeFetch({ '/d/aasx/index.json': () => JSON.stringify({ [SEW_ID]: { file: 's.aasx', idShort: 'S' } }) });
    const merged = new MergedAasSource([projectAasSourceFor(backend, 'p'), urlAasSourceFor('/d/aasx/')]);
    expect((await merged.readIndex()).kind).toBe('available');
  });
});

describe('caching and invalidation', () => {
  it('keys sources per project, not per deploy base', async () => {
    const a = await folderProject({});
    const b = await folderProject({});
    const sa = projectAasSourceFor(a, 'proj-a');
    const sb = projectAasSourceFor(b, 'proj-b');
    expect(sa.key).toBe('project:proj-a');
    expect(sb.key).toBe('project:proj-b');
    expect(projectAasSourceFor(a, 'proj-a')).toBe(sa);
  });

  it('invalidateAasSource turns a cached "missing" into "available" after the index is written', async () => {
    const backend = await folderProject({});
    const src = projectAasSourceFor(backend, 'p1');
    expect((await src.readIndex()).kind).toBe('missing');

    await backend.writeDocument('aasx/index.json',
      new TextEncoder().encode(JSON.stringify({ version: 1, generator: 'realvirtual-web', entries: { [FESTO.id]: { file: 'f.aasx', idShort: 'F' } }, files: {} })),
      { expectedRevision: 'any' });
    expect((await src.readIndex()).kind).toBe('missing'); // still cached

    const rev = src.revision;
    invalidateAasSource(src.key);
    expect(src.revision).toBeGreaterThan(rev);
    const after = await src.readIndex();
    expect(after.kind === 'available' && after.index[FESTO.id]?.file).toBe('f.aasx');
  });

  it('reads both index shapes (flat deploy format, project format)', () => {
    expect(readIndexJson({ a: { file: 'x.aasx', idShort: 'X' } })?.entries.a.file).toBe('x.aasx');
    const p = readIndexJson({ version: 1, generator: 'realvirtual-web', entries: { b: { file: 'y.aasx', idShort: 'Y' } }, files: {} });
    expect(p?.entries.b.file).toBe('y.aasx');
    expect(p?.file?.version).toBe(1);
    expect(readIndexJson([1, 2])).toBeNull();
  });
});

describe('bundled + encrypted (hosted, password-protected)', () => {
  it('reads index and archive through the decrypt seam', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const salt = new Uint8Array(16).fill(7);
    setSessionKey(salt, key);
    const indexBytes = new TextEncoder().encode(JSON.stringify({ [FESTO.id]: { file: 'festo.aasx', idShort: 'FestoA' } }));
    const encIndex = await encryptToEnvelope(indexBytes, key, { salt, iterations: 1 });
    const encAasx = await encryptToEnvelope(await makeAasx([FESTO]), key, { salt, iterations: 1 });
    // The envelope is not a ZIP.
    expect(String.fromCharCode(...new Uint8Array(encAasx.slice(0, 4)))).toBe('RVE1');

    routeFetch({
      '/p/aasx/index.json': () => encIndex.slice(0),
      '/p/aasx/festo.aasx': () => encAasx.slice(0),
    });
    // A fake bundled backend that hands out deploy URLs (unencrypted-deploy shape)
    // so the decrypt happens in the source itself.
    const backend: AasProjectBackend = {
      kind: 'bundled',
      id: 'bundled:p',
      readDocumentUrl: async (ref) => ({ url: `https://cdn.example/p/${typeof ref === 'string' ? ref : ref.path}`, release: () => {} }),
    };
    const src = new ProjectAasSource(backend, 'hosted');
    const idx = await src.readIndex();
    expect(idx.kind === 'available' && idx.index[FESTO.id]?.file).toBe('festo.aasx');
    const detail = await loadAasDetail({ source: src, entry: { file: 'festo.aasx', idShort: 'FestoA' } }, FESTO.id);
    expect(detail.aasId).toBe(FESTO.id);
    expect(detail.nameplate.some(p => p.value === 'Festo Cylinder')).toBe(true);
  });
});
