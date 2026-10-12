// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-560 §9.1 — the encrypted branch of the `?glb=` boot.
 *
 * The decryptor is a seam: without one (public edition) an RVE1 envelope ends
 * on the card with a sentence and nothing is loaded; with one the plaintext is
 * loaded trusted, without touching the trust store, and the card keeps the
 * ENVELOPE for its download button.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Object3D } from 'three';

import { bootSharedGlb, type ShareBootViewer } from '../src/core/share/rv-share-boot';
import { setSharedGlbDecryptor, ShareDecryptError } from '../src/core/share/rv-share-decrypt';
import { getSharedGlbSnapshot, clearSharedGlb } from '../src/core/share/rv-share-store';
import { SHARE_DECRYPT_MESSAGES } from '../src/core/share/rv-share-fetch';
import { SHARE_TRUST_KEY } from '../src/core/share/rv-share-trust-store';
import type { ModelProvenance } from '../src/core/rv-model-provenance';
import type { LoadTrustContext } from '../src/core/rv-load-trust';
import { encryptGlb, randomBytes, FRAGMENT_BYTES } from '../src/core/persistence/rv-crypto-utils';

const LS_KEY_MODEL = 'rv-webviewer-last-model';
const SHARE_URL = 'https://files.example.org/pick-and-place.rve.glb';

interface FakeViewer extends ShareBootViewer {
  calls: Array<{
    url: string;
    options: { data: ArrayBuffer; modelName?: string; trust: LoadTrustContext; provenance?: ModelProvenance };
  }>;
  currentModelUrl: string | null;
}

function makeViewer(): FakeViewer {
  const v: FakeViewer = {
    calls: [],
    currentModelUrl: null,
    loadModel: vi.fn(async (url, options) => {
      v.calls.push({ url, options });
      return { root: new Object3D() };
    }),
  };
  return v;
}

function okFetch(bytes: ArrayBuffer | Uint8Array): typeof fetch {
  return (async () => new Response(new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); },
  }))) as unknown as typeof fetch;
}

/** Plaintext "GLB": the glTF magic plus a recognisable body. */
const glbBytes = (() => {
  const b = new Uint8Array(256).fill(7);
  b.set([0x67, 0x6c, 0x54, 0x46]); // "glTF"
  return b.buffer;
})();

let env: ArrayBuffer;

beforeEach(async () => {
  localStorage.clear();
  clearSharedGlb();
  env = await encryptGlb(glbBytes, 'correct horse battery', randomBytes(FRAGMENT_BYTES), { iterations: 1000 });
});

afterEach(() => {
  vi.restoreAllMocks();
  clearSharedGlb();
  localStorage.clear();
});

async function boot(viewer: FakeViewer, bytes: ArrayBuffer = env) {
  return bootSharedGlb(viewer, SHARE_URL, { fetch: { fetchImpl: okFetch(bytes) } });
}

describe('share boot — encrypted envelope behind a signed redirect (plan-560 follow-up)', () => {
  it('names the model without the signature and loads from the asked-for URL (no sidecar probe)', async () => {
    const asked = 'https://files.example.org/dl/tok123/file';
    const signed = 'https://storage.example.com/uploads/tok123/pick-and-place.rve.glb?GoogleAccessId=x&Signature=y';
    const redirected = (async () => {
      const r = new Response(new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(new Uint8Array(env)); c.close(); },
      }));
      Object.defineProperty(r, 'url', { value: signed });
      return r;
    }) as unknown as typeof fetch;
    const restore = setSharedGlbDecryptor(async () => glbBytes);
    try {
      const viewer = makeViewer();
      const r = await bootSharedGlb(viewer, asked, { fetch: { fetchImpl: redirected } });
      expect(r.ok).toBe(true);
      // `/file` is not `.glb` → the loader never derives a `.kin.json` next to the signature
      expect(viewer.calls[0]!.url).toBe(asked);
      const identity = (viewer.calls[0]!.options as { identityUrl?: string }).identityUrl;
      expect(identity).toBe('https://storage.example.com/uploads/tok123/pick-and-place.glb');
      expect(viewer.currentModelUrl).toBe(identity);
      expect(viewer.calls[0]!.options.modelName).toBe('pick-and-place');
    } finally { restore(); }
  });
});

describe('share boot — encrypted envelope (plan-560)', () => {
  it('share_Encrypted_NoDecryptor_ShowsUnsupported', async () => {
    const viewer = makeViewer();
    const r = await boot(viewer);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/encrypted/i);
    expect(r.error).toBe(SHARE_DECRYPT_MESSAGES['encrypted-unsupported']);
    expect(getSharedGlbSnapshot().error).toBe(SHARE_DECRYPT_MESSAGES['encrypted-unsupported']);
    expect(viewer.calls).toHaveLength(0);
  });

  it('share_Encrypted_WithDecryptor_LoadsPlaintextTrusted', async () => {
    const decryptor = vi.fn(async (_envelope: ArrayBuffer) => glbBytes);
    const restore = setSharedGlbDecryptor(decryptor);
    try {
      const viewer = makeViewer();
      const r = await boot(viewer);
      expect(r.ok).toBe(true);
      expect(decryptor).toHaveBeenCalledTimes(1);
      expect(new Uint8Array(decryptor.mock.calls[0]![0] as ArrayBuffer)).toEqual(new Uint8Array(env));
      expect(viewer.calls).toHaveLength(1);
      expect(new Uint8Array(viewer.calls[0]!.options.data)).toEqual(new Uint8Array(glbBytes));
      expect(viewer.calls[0]!.options.trust.trusted).toBe(true);
      expect(viewer.calls[0]!.options.trust.sourceOrigin).toBe('files.example.org');
      const prov = viewer.calls[0]!.options.provenance!;
      expect(prov.source).toBe('share-encrypted');
      expect(prov.trusted).toBe(true);
      expect(prov.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(viewer.calls[0]!.options.modelName).toBe('pick-and-place');
    } finally { restore(); }
  });

  it('share_Encrypted_DoesNotWriteAnyKey: no scene keys, no last-model entry, no trust-store record', async () => {
    localStorage.setItem('rv-scenes/active', JSON.stringify({ id: 'scn_visitor' }));
    localStorage.setItem(LS_KEY_MODEL, 'models/VisitorsOwnModel.glb');
    const before = JSON.stringify(Object.fromEntries(Object.keys(localStorage).sort().map(k => [k, localStorage.getItem(k)])));

    const restore = setSharedGlbDecryptor(async () => glbBytes);
    try {
      const r = await boot(makeViewer());
      expect(r.ok).toBe(true);
    } finally { restore(); }

    const after = JSON.stringify(Object.fromEntries(Object.keys(localStorage).sort().map(k => [k, localStorage.getItem(k)])));
    expect(after).toBe(before);
    expect(localStorage.getItem(SHARE_TRUST_KEY)).toBeNull();
  });

  it('share_Encrypted_Cancelled_MapsToCardError', async () => {
    const restore = setSharedGlbDecryptor(async () => { throw new ShareDecryptError('cancelled', 'x'); });
    try {
      const viewer = makeViewer();
      const r = await boot(viewer);
      expect(r.ok).toBe(false);
      expect(r.error).toBe(SHARE_DECRYPT_MESSAGES['decrypt-cancelled']);
      expect(getSharedGlbSnapshot().error).toBe('Opening was cancelled.');
      expect(viewer.calls).toHaveLength(0);
    } finally { restore(); }
  });

  it('share_Encrypted_LinkIncomplete_MapsToCardError', async () => {
    const restore = setSharedGlbDecryptor(async () => { throw new ShareDecryptError('link-incomplete', 'x'); });
    try {
      const r = await boot(makeViewer());
      expect(r.ok).toBe(false);
      expect(r.error).toBe('The link is incomplete (missing key).');
    } finally { restore(); }
  });

  it('share_Encrypted_Damaged_And_UnknownErrors_MapToDamaged', async () => {
    for (const thrown of [new ShareDecryptError('damaged', 'x'), new Error('boom')]) {
      const restore = setSharedGlbDecryptor(async () => { throw thrown; });
      try {
        const viewer = makeViewer();
        const r = await boot(viewer);
        expect(r.ok).toBe(false);
        expect(r.error).toBe(SHARE_DECRYPT_MESSAGES['decrypt-failed']);
        expect(viewer.calls).toHaveLength(0);
      } finally { restore(); }
    }
  });

  it('share_Encrypted_DownloadKeepsEnvelope: the card payload is the envelope, info.encrypted is set', async () => {
    const restore = setSharedGlbDecryptor(async () => glbBytes);
    try {
      await boot(makeViewer());
      const snap = getSharedGlbSnapshot();
      expect(snap.info?.encrypted).toBe(true);
      expect(snap.info?.name).toBe('pick-and-place');
      expect(new Uint8Array(snap.payload!.bytes)).toEqual(new Uint8Array(env));
    } finally { restore(); }
  });

  it('share_Plain_Unchanged: a plaintext GLB never reaches the decryptor and stays untrusted', async () => {
    const decryptor = vi.fn(async (_envelope: ArrayBuffer) => glbBytes);
    const restore = setSharedGlbDecryptor(decryptor);
    try {
      const viewer = makeViewer();
      const r = await bootSharedGlb(viewer, 'https://files.example.org/plain.glb', {
        fetch: { fetchImpl: okFetch(glbBytes) },
      });
      expect(r.ok).toBe(true);
      expect(decryptor).not.toHaveBeenCalled();
      expect(viewer.calls[0]!.options.trust).toEqual({ trusted: false, sourceOrigin: 'files.example.org' });
      expect(viewer.calls[0]!.options.provenance?.source).toBe('own-url');
      expect(getSharedGlbSnapshot().info?.encrypted).toBeUndefined();
    } finally { restore(); }
  });

  it('a bare fileshare landing link is fetched at its /file URL', async () => {
    const restore = setSharedGlbDecryptor(async () => glbBytes);
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(new Uint8Array(env));
    }) as unknown as typeof fetch;
    try {
      const r = await bootSharedGlb(makeViewer(), 'https://files.realvirtual.io/dl/abc123', { fetch: { fetchImpl } });
      expect(r.ok).toBe(true);
      expect(seen).toEqual(['https://files.realvirtual.io/dl/abc123/file']);
    } finally { restore(); }
  });
});
