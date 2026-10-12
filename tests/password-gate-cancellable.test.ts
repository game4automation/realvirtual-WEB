// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-560 §9.3 — the hardened `decryptModelData`, driven through the REAL
 * overlay in headless Chromium: typed errors, Cancel (also while the key is
 * being derived), the busy guard, the KDF limit and the pre-allocated
 * `decryptEnvelope`.
 *
 * Order matters in this file: the fragment secret is a module singleton read
 * once by `initFragmentSecret()`, so the "no #k=" case runs first.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/dom';
import {
  encryptGlb, bytesToBase64Url, randomBytes, FRAGMENT_BYTES, MAX_SHARE_KDF_ITERATIONS,
  deriveMasterKey, decryptEnvelope, parseEnvelopeHeader,
} from '../src/core/persistence/rv-crypto-utils';
import { initFragmentSecret, getFragmentSecret, decryptModelData, ShareDecryptError } from '../src/core/hmi/password-gate';

const PASSWORD = 'richtig-2027-share';
const FRAG = randomBytes(FRAGMENT_BYTES);

const ROOT = '#rv-password-gate-root';

function plainOf(len: number): Uint8Array {
  const b = new Uint8Array(len);
  for (let i = 0; i < len; i++) b[i] = (i * 31 + 7) & 0xff;
  return b;
}

async function gateInput(): Promise<HTMLInputElement> {
  return waitFor(() => {
    const el = document.querySelector(`${ROOT} input`) as HTMLInputElement | null;
    if (!el) throw new Error('gate input not mounted yet');
    return el;
  });
}

function button(label: RegExp): HTMLButtonElement {
  const b = Array.from(document.querySelectorAll(`${ROOT} button`)).find((el) => label.test(el.textContent ?? ''));
  if (!b) throw new Error(`no button ${label}`);
  return b as HTMLButtonElement;
}

async function gateGone(): Promise<void> {
  await waitFor(() => { if (document.querySelector(ROOT)) throw new Error('gate still mounted'); });
}

async function typeAndOpen(password: string): Promise<void> {
  const input = await gateInput();
  fireEvent.change(input, { target: { value: password } });
  fireEvent.click(button(/^open$/i));
}

async function expectCode(p: Promise<unknown>, code: string): Promise<ShareDecryptError> {
  const e = await p.then(() => { throw new Error('expected a rejection'); }, (err: unknown) => err);
  expect(e).toBeInstanceOf(ShareDecryptError);
  expect((e as ShareDecryptError).code).toBe(code);
  return e as ShareDecryptError;
}

/** Byte offset of chunk `i`'s ciphertext inside an envelope. */
async function chunkCiphertextOffset(env: ArrayBuffer, index: number): Promise<number> {
  const header = await parseEnvelopeHeader(env);
  const dv = new DataView(env);
  let o = header.headerLength;
  for (let i = 0; i < index; i++) o += 1 + 12 + 4 + dv.getUint32(o + 1 + 12, true);
  return o + 1 + 12 + 4;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('decryptModelData — cancellable share path (plan-560)', () => {
  it('without #k= and cancellable: rejects link-incomplete and mounts nothing', async () => {
    expect(getFragmentSecret()).toBeNull();
    const env = await encryptGlb(plainOf(64), PASSWORD, FRAG, { iterations: 1000 });
    await expectCode(decryptModelData(env, { cancellable: true }), 'link-incomplete');
    expect(document.querySelector(ROOT)).toBeNull();
  });

  it('reads the fragment for the remaining cases', () => {
    window.location.hash = '#k=' + bytesToBase64Url(FRAG);
    initFragmentSecret();
    expect(Array.from(getFragmentSecret()!)).toEqual(Array.from(FRAG));
  });

  it('wrong password keeps the overlay open; the right one resolves and unmounts', async () => {
    const plain = plainOf(300);
    const env = await encryptGlb(plain, PASSWORD, FRAG, { iterations: 1000 });
    const pending = decryptModelData(env, { cancellable: true });

    await typeAndOpen('falsch-falsch-falsch');
    await waitFor(() => {
      if (!/Wrong password or damaged file\./.test(document.querySelector(ROOT)?.textContent ?? '')) {
        throw new Error('no error yet');
      }
    });
    expect(document.querySelector(ROOT)).not.toBeNull();

    await typeAndOpen(PASSWORD);
    const out = await pending;
    expect(new Uint8Array(out)).toEqual(plain);
    await gateGone();
  });

  it('multi-chunk envelope (>= 3 chunks) decrypts byte-identically', async () => {
    const plain = plainOf(1000);
    const env = await encryptGlb(plain, PASSWORD, FRAG, { iterations: 1000, chunkSize: 256 });
    expect((await parseEnvelopeHeader(env)).chunkCount).toBeGreaterThanOrEqual(3);
    const pending = decryptModelData(env, { cancellable: true });
    await typeAndOpen(PASSWORD);
    expect(new Uint8Array(await pending)).toEqual(plain);
    await gateGone();
  });

  it('a flipped byte in the FIRST chunk reads as "Wrong password or damaged file." (overlay stays)', async () => {
    const env = await encryptGlb(plainOf(1000), PASSWORD, FRAG, { iterations: 1000, chunkSize: 256 });
    const at = await chunkCiphertextOffset(env, 0);
    new Uint8Array(env)[at + 3] ^= 0xff;
    const pending = decryptModelData(env, { cancellable: true });
    await typeAndOpen(PASSWORD);
    await waitFor(() => {
      if (!/Wrong password or damaged file\./.test(document.querySelector(ROOT)?.textContent ?? '')) {
        throw new Error('no error yet');
      }
    });
    fireEvent.click(button(/^cancel$/i));
    await expectCode(pending, 'cancelled');
    await gateGone();
  });

  it('a flipped byte in the LAST chunk rejects damaged and unmounts', async () => {
    const env = await encryptGlb(plainOf(1000), PASSWORD, FRAG, { iterations: 1000, chunkSize: 256 });
    const header = await parseEnvelopeHeader(env);
    const at = await chunkCiphertextOffset(env, header.chunkCount - 1);
    new Uint8Array(env)[at + 1] ^= 0xff;
    const pending = decryptModelData(env, { cancellable: true });
    await typeAndOpen(PASSWORD);
    await expectCode(pending, 'damaged');
    await gateGone();
  });

  it('a header above MAX_SHARE_KDF_ITERATIONS rejects damaged without deriving or mounting', async () => {
    const env = await encryptGlb(plainOf(64), PASSWORD, FRAG, { iterations: 1000 });
    new DataView(env).setUint32(6, MAX_SHARE_KDF_ITERATIONS + 1, true); // magic(4) flags(1) kdf(1)
    const derive = vi.spyOn(crypto.subtle, 'deriveBits');
    const e = await expectCode(decryptModelData(env, { cancellable: true }), 'damaged');
    expect(e.message).toMatch(/key derivation limit/);
    expect(derive).not.toHaveBeenCalled();
    expect(document.querySelector(ROOT)).toBeNull();
  });

  it('Cancel rejects cancelled', async () => {
    const env = await encryptGlb(plainOf(64), PASSWORD, FRAG, { iterations: 1000 });
    const pending = decryptModelData(env, { cancellable: true });
    await gateInput();
    fireEvent.click(button(/^cancel$/i));
    await expectCode(pending, 'cancelled');
    await gateGone();
  });

  it('Cancel DURING a slow derivation rejects at once; the late key is ignored', async () => {
    const env = await encryptGlb(plainOf(64), PASSWORD, FRAG, { iterations: 1000 });
    const original = crypto.subtle.deriveBits.bind(crypto.subtle);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const derive = vi.spyOn(crypto.subtle, 'deriveBits').mockImplementation(async (...args) => {
      await gate;
      return original(...args);
    });

    const pending = decryptModelData(env, { cancellable: true });
    await typeAndOpen(PASSWORD);
    await waitFor(() => expect(derive).toHaveBeenCalled());
    // Busy: the submit button says so, Cancel is still live.
    expect(button(/decrypting/i)).toBeTruthy();
    fireEvent.click(button(/^cancel$/i));
    await expectCode(pending, 'cancelled');
    release();
    await new Promise((r) => setTimeout(r, 50));
    await gateGone();
  });

  it('a second call while the gate is open rejects cancelled (gate busy) instead of hanging', async () => {
    const env = await encryptGlb(plainOf(64), PASSWORD, FRAG, { iterations: 1000 });
    const first = decryptModelData(env, { cancellable: true });
    await gateInput();
    const e = await expectCode(decryptModelData(env, { cancellable: true }), 'cancelled');
    expect(e.message).toBe('gate busy');
    fireEvent.click(button(/^cancel$/i));
    await expectCode(first, 'cancelled');
    await gateGone();
  });
});

describe('decryptEnvelope — pre-allocated output (plan-560 Phase 2)', () => {
  it('single-chunk and n-chunk envelopes yield exactly the plaintext', async () => {
    for (const chunkSize of [undefined, 100, 1000, 4096]) {
      const plain = plainOf(1000);
      const env = await encryptGlb(plain, PASSWORD, FRAG, { iterations: 1000, ...(chunkSize ? { chunkSize } : {}) });
      const header = await parseEnvelopeHeader(env);
      const key = await deriveMasterKey(PASSWORD, FRAG, header.salt, header.iterations);
      const out = await decryptEnvelope(env, key);
      expect(out.byteLength).toBe(plain.length);
      expect(new Uint8Array(out)).toEqual(plain);
    }
  });

  it('an empty plaintext still round-trips', async () => {
    const env = await encryptGlb(new Uint8Array(0), PASSWORD, FRAG, { iterations: 1000 });
    const header = await parseEnvelopeHeader(env);
    const key = await deriveMasterKey(PASSWORD, FRAG, header.salt, header.iterations);
    expect((await decryptEnvelope(env, key)).byteLength).toBe(0);
  });

  it('trailing bytes are still refused as tampering', async () => {
    const env = await encryptGlb(plainOf(64), PASSWORD, FRAG, { iterations: 1000 });
    const longer = new Uint8Array(env.byteLength + 1);
    longer.set(new Uint8Array(env));
    const header = await parseEnvelopeHeader(env);
    const key = await deriveMasterKey(PASSWORD, FRAG, header.salt, header.iterations);
    await expect(decryptEnvelope(longer, key)).rejects.toThrow(/malformed envelope/);
  });
});

describe('decryptModelData — without the option (hosted-style look unchanged)', () => {
  it('offers no Cancel, keeps the "Unlock" wording and still resolves on the right password', async () => {
    // The terminal IncompleteOverlay branch (no #k=, no option) is untouched
    // code; it cannot be reached here because the fragment singleton is
    // already set for this module instance.
    const plain = plainOf(64);
    const env = await encryptGlb(plain, PASSWORD, FRAG, { iterations: 1000 });
    const pending = decryptModelData(env);
    const input = await gateInput();
    expect(() => button(/^cancel$/i)).toThrow();
    fireEvent.change(input, { target: { value: PASSWORD } });
    fireEvent.click(button(/^unlock$/i));
    expect(new Uint8Array(await pending)).toEqual(plain);
    await gateGone();
  });
});
