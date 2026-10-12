// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * served-bytes-seam.test.ts — plan-759 §9.4. ONE decrypt seam: every GLB byte
 * path of a served project goes through `rv-served-bytes`, which turns an RVE1
 * envelope into a GLB with the key the gate verified and refuses — loudly —
 * to hand out ciphertext without one. The backend's blob-URL path decrypts as
 * well, so its fifteen callers never see an envelope. The model cache's
 * persistent blob cache is bypassed on an encrypted deploy.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  encryptGlb, deriveMasterKey, parseEnvelopeHeader, randomBytes, FRAGMENT_BYTES,
} from '../src/core/persistence/rv-crypto-utils';
import {
  decryptServedBytes, fetchServedBytes, setSessionKey, clearSessionKeys, EncryptedWithoutKeyError, isEncryptedDeploy,
} from '../src/core/persistence/rv-served-bytes';
import { setAppConfig } from '../src/core/rv-app-config';
import { BundledBackend } from '../src/core/project/backends/bundled-backend';
import modelCacheSource from '../src/core/engine/rv-model-cache.ts?raw';
import bundledBackendSource from '../src/core/project/backends/bundled-backend.ts?raw';

const FRAG = randomBytes(FRAGMENT_BYTES);
const SALT = randomBytes(16);
const PLAIN = 'glTF-served-document-bytes';
const REMOTE = 'https://cdn.example.test/deadbeef/p/';

const text = (s: string) => new TextEncoder().encode(s);
const decode = (b: ArrayBuffer) => new TextDecoder().decode(b);

async function envelope(): Promise<Uint8Array> {
  return new Uint8Array(await encryptGlb(text(PLAIN), 'pw', FRAG, { salt: SALT, iterations: 1000, hkdfInfo: 'models/a.glb' }));
}

async function unlock(): Promise<void> {
  const key = await deriveMasterKey('pw', FRAG, SALT, 1000);
  setSessionKey(SALT, key);
}

function fakeFetch(files: Record<string, Uint8Array | object>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = files[url];
    if (body === undefined) return new Response('', { status: 404 });
    if (body instanceof Uint8Array) return new Response(body as unknown as BodyInit, { status: 200 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

beforeEach(() => {
  clearSessionKeys();
  setAppConfig({ encryption: { enabled: true } });
});

describe('decryptServedBytes', () => {
  it('passes plain bytes through untouched', async () => {
    const out = await decryptServedBytes(text(PLAIN).buffer as ArrayBuffer);
    expect(decode(out)).toBe(PLAIN);
  });

  it('refuses an envelope without a key for its salt, and decrypts with one', async () => {
    const env = await envelope();
    await expect(decryptServedBytes(env, 'x.glb')).rejects.toBeInstanceOf(EncryptedWithoutKeyError);
    await unlock();
    expect(decode(await decryptServedBytes(env))).toBe(PLAIN);
    // another salt = another publish = no key
    const other = new Uint8Array(await encryptGlb(text(PLAIN), 'pw', FRAG, { salt: randomBytes(16), iterations: 1000 }));
    await expect(decryptServedBytes(other)).rejects.toBeInstanceOf(EncryptedWithoutKeyError);
  });

  it('fetchServedBytes is fetch + the seam', async () => {
    const env = await envelope();
    const f = fakeFetch({ 'https://x/a.glb': env, 'https://x/plain.glb': text(PLAIN) });
    await expect(fetchServedBytes('https://x/a.glb', undefined, f)).rejects.toBeInstanceOf(EncryptedWithoutKeyError);
    await unlock();
    expect(decode(await fetchServedBytes('https://x/a.glb', undefined, f))).toBe(PLAIN);
    expect(decode(await fetchServedBytes('https://x/plain.glb', undefined, f))).toBe(PLAIN);
    await expect(fetchServedBytes('https://x/missing.glb', undefined, f)).rejects.toThrow(/404/);
  });

  it('isEncryptedDeploy reads settings.json', () => {
    expect(isEncryptedDeploy()).toBe(true);
    setAppConfig({});
    expect(isEncryptedDeploy()).toBe(false);
  });
});

describe('BundledBackend on an encrypted deploy', () => {
  const manifest = {
    schemaVersion: 2, id: 'prj_hosted', name: 'Hosted', canonicalName: 'hosted', kind: 'customer',
    documents: [{ id: 'doc_a', path: 'models/a.glb', name: 'a' }],
  };

  it('readDocument goes through the seam', async () => {
    const env = await envelope();
    const backend = new BundledBackend({ baseUrl: REMOTE, fetchImpl: fakeFetch({ [`${REMOTE}project.json`]: manifest, [`${REMOTE}models/a.glb`]: env }) });
    await expect(backend.readDocument({ path: 'models/a.glb' } as never)).rejects.toBeInstanceOf(EncryptedWithoutKeyError);
    await unlock();
    const record = await backend.readDocument({ path: 'models/a.glb' } as never);
    expect(record).not.toBeNull();
  });

  it('readDocumentUrl hands out a blob URL of the DECRYPTED bytes and revokes it on release', async () => {
    await unlock();
    const env = await envelope();
    const backend = new BundledBackend({ baseUrl: REMOTE, fetchImpl: fakeFetch({ [`${REMOTE}project.json`]: manifest, [`${REMOTE}models/a.glb`]: env }) });
    const resolved = await backend.readDocumentUrl({ path: 'models/a.glb' } as never);
    expect(resolved).not.toBeNull();
    expect(resolved!.url.startsWith('blob:')).toBe(true);
    const bytes = await (await fetch(resolved!.url)).arrayBuffer();
    expect(decode(bytes)).toBe(PLAIN);
    resolved!.release();
    await expect(fetch(resolved!.url)).rejects.toThrow();
  });

  it('on a plain deploy readDocumentUrl is still the CDN URL', async () => {
    setAppConfig({});
    const backend = new BundledBackend({ baseUrl: REMOTE, fetchImpl: fakeFetch({ [`${REMOTE}project.json`]: manifest }) });
    const resolved = await backend.readDocumentUrl({ path: 'models/a.glb' } as never);
    expect(resolved?.url).toBe(`${REMOTE}models/a.glb`);
  });
});

describe('no naked fetch of GLB bytes beside the seam (drift guard)', () => {
  it('the model cache fetches through fetchServedBytes and bypasses the blob cache when encrypted', () => {
    expect(modelCacheSource).toContain('return fetchServedBytes(url);');
    expect(modelCacheSource).toContain("!url.startsWith('blob:') && !isEncryptedDeploy()");
  });

  it('the bundled backend decrypts in _fetchBytes and in readDocumentUrl', () => {
    expect(bundledBackendSource).toContain('decryptServedBytes(await resp.arrayBuffer()');
    expect(bundledBackendSource).toContain('if (isEncryptedDeploy()) {');
  });
});
