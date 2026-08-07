// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-crypto-utils.test.ts — plan-267 Phase 0. Verifies the zero-knowledge
 * AES-256-GCM envelope: 2-factor key derivation, round-trips, wrong password /
 * fragment rejection, NFC password normalization (macOS NFD ↔ Windows NFC),
 * envelope tampering, chunk-boundary correctness, and a deterministic golden
 * vector that the Node publish pipeline reproduces byte-for-byte.
 *
 * Runs in real headless Chromium (vitest browser mode) so `crypto.subtle` is the
 * genuine WebCrypto implementation — identical to what the Node pipeline uses.
 */

import { describe, it, expect } from 'vitest';
import {
  parseFragmentSecret,
  bytesToBase64Url,
  base64UrlToBytes,
  randomBytes,
  deriveMasterKey,
  encryptGlb,
  decryptGlb,
  encryptToEnvelope,
  decryptEnvelope,
  parseEnvelopeHeader,
  verifyKey,
  isEncryptedEnvelope,
  FRAGMENT_BYTES,
  DEFAULT_ITERATIONS,
} from '../src/core/persistence/rv-crypto-utils';

// Cheap iteration count keeps the suite fast; correctness is iteration-agnostic.
const FAST = 1000;

function textBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
function decode(buf: ArrayBuffer): string {
  return new TextDecoder().decode(buf);
}
function toHex(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

// ─── Fragment parsing ──────────────────────────────────────────────────────

describe('parseFragmentSecret', () => {
  it('extracts a valid 32-byte k= secret', () => {
    const secret = randomBytes(FRAGMENT_BYTES);
    const hash = '#k=' + bytesToBase64Url(secret);
    const parsed = parseFragmentSecret(hash);
    expect(parsed).not.toBeNull();
    expect(toHex(parsed!)).toBe(toHex(secret));
  });

  it('ignores other &-separated hash params', () => {
    const secret = randomBytes(FRAGMENT_BYTES);
    const hash = `#model=demo&k=${bytesToBase64Url(secret)}&t=1`;
    expect(toHex(parseFragmentSecret(hash)!)).toBe(toHex(secret));
  });

  it('returns null when k= is missing', () => {
    expect(parseFragmentSecret('#model=demo')).toBeNull();
    expect(parseFragmentSecret('')).toBeNull();
    expect(parseFragmentSecret('#')).toBeNull();
  });

  it('returns null on wrong length (not 32 bytes)', () => {
    expect(parseFragmentSecret('#k=' + bytesToBase64Url(randomBytes(16)))).toBeNull();
    expect(parseFragmentSecret('#k=' + bytesToBase64Url(randomBytes(48)))).toBeNull();
  });

  it('returns null on undecodable token (no exception)', () => {
    expect(parseFragmentSecret('#k=!!!not base64!!!')).toBeNull();
  });

  it('base64url round-trips arbitrary bytes', () => {
    const b = randomBytes(70);
    expect(toHex(base64UrlToBytes(bytesToBase64Url(b)))).toBe(toHex(b));
  });
});

// ─── Round-trips ───────────────────────────────────────────────────────────

describe('encrypt/decrypt round-trip', () => {
  it('round-trips a single-buffer payload', async () => {
    const frag = randomBytes(FRAGMENT_BYTES);
    const plain = textBytes('{"defaultModel":"models/mauser.glb"}');
    const text = '{"defaultModel":"models/mauser.glb"}';
    const env = await encryptGlb(plain, 'correct horse battery staple', frag, { iterations: FAST });
    expect(isEncryptedEnvelope(env)).toBe(true);
    const out = await decryptGlb(env, 'correct horse battery staple', frag);
    expect(decode(out)).toBe(text);
  });

  it('round-trips a chunked payload (many chunks)', async () => {
    const frag = randomBytes(FRAGMENT_BYTES);
    const plain = randomBytes(100_000);
    const env = await encryptGlb(plain, 'pw', frag, { iterations: FAST, chunkSize: 16_384 });
    const header = await parseEnvelopeHeader(env);
    expect(header.chunkCount).toBe(Math.ceil(100_000 / 16_384));
    const out = new Uint8Array(await decryptGlb(env, 'pw', frag));
    expect(toHex(out)).toBe(toHex(plain));
  });

  it('round-trips an empty payload', async () => {
    const frag = randomBytes(FRAGMENT_BYTES);
    const env = await encryptGlb(new Uint8Array(0), 'pw', frag, { iterations: FAST });
    expect((await decryptGlb(env, 'pw', frag)).byteLength).toBe(0);
  });
});

// ─── Two-factor enforcement ────────────────────────────────────────────────

describe('two-factor key', () => {
  it('rejects a wrong password', async () => {
    const frag = randomBytes(FRAGMENT_BYTES);
    const env = await encryptGlb(textBytes('secret'), 'right', frag, { iterations: FAST });
    await expect(decryptGlb(env, 'wrong', frag)).rejects.toThrow();
  });

  it('rejects a wrong/altered fragment secret (password alone is not enough)', async () => {
    const frag = randomBytes(FRAGMENT_BYTES);
    const other = randomBytes(FRAGMENT_BYTES);
    const env = await encryptGlb(textBytes('secret'), 'pw', frag, { iterations: FAST });
    await expect(decryptGlb(env, 'pw', other)).rejects.toThrow();
  });

  it('rejects a fragment of the wrong size at derive time', async () => {
    await expect(deriveMasterKey('pw', randomBytes(16), randomBytes(16), FAST)).rejects.toThrow();
  });
});

// ─── Unicode / NFC normalization ───────────────────────────────────────────

describe('password NFC normalization', () => {
  it('decrypts an NFD-typed password against an NFC-encrypted payload', async () => {
    const frag = randomBytes(FRAGMENT_BYTES);
    const nfc = 'Paßwort-Zürich'.normalize('NFC');
    const nfd = 'Paßwort-Zürich'.normalize('NFD');
    // Sanity: the two normalizations differ at the byte level.
    expect(toHex(textBytes(nfc))).not.toBe(toHex(textBytes(nfd)));
    const env = await encryptGlb(textBytes('cad'), nfc, frag, { iterations: FAST });
    // Same logical passphrase, different Unicode form → must still decrypt.
    const out = await decryptGlb(env, nfd, frag);
    expect(decode(out)).toBe('cad');
  });
});

// ─── Tampering ─────────────────────────────────────────────────────────────

describe('tamper resistance', () => {
  async function envelope(): Promise<Uint8Array> {
    const frag = randomBytes(FRAGMENT_BYTES);
    const key = await deriveMasterKey('pw', frag, saltFixed, FAST);
    const buf = await encryptToEnvelope(textBytes('important payload'), key, {
      salt: saltFixed,
      iterations: FAST,
    });
    (envelope as unknown as { key: CryptoKey; frag: Uint8Array }).key = key;
    (envelope as unknown as { key: CryptoKey; frag: Uint8Array }).frag = frag;
    return new Uint8Array(buf);
  }
  const saltFixed = new Uint8Array(16).fill(7);

  it('rejects a flipped ciphertext byte (GCM auth)', async () => {
    const env = await envelope();
    const key = (envelope as unknown as { key: CryptoKey }).key;
    env[env.length - 1] ^= 0xff; // flip within the tag/ciphertext tail
    await expect(decryptEnvelope(env, key)).rejects.toThrow();
  });

  it('rejects a manipulated header (iterations byte) via AAD binding', async () => {
    const env = await envelope();
    const key = (envelope as unknown as { key: CryptoKey }).key;
    // iterations u32 lives at offset 6 (magic4 + flags1 + kdf1).
    env[6] ^= 0x01;
    await expect(decryptEnvelope(env, key)).rejects.toThrow();
  });

  it('rejects appended trailing bytes', async () => {
    const env = await envelope();
    const key = (envelope as unknown as { key: CryptoKey }).key;
    const bloated = new Uint8Array(env.length + 4);
    bloated.set(env, 0);
    await expect(decryptEnvelope(bloated, key)).rejects.toThrow();
  });

  it('throws "malformed envelope" on a bad magic', async () => {
    await expect(parseEnvelopeHeader(new Uint8Array([1, 2, 3, 4, 5]))).rejects.toThrow('malformed envelope');
  });

  it('throws on an out-of-bounds length field', async () => {
    // Valid magic, flags, kdf, iterations, then saltLen claiming 200 bytes.
    const bad = new Uint8Array([0x52, 0x56, 0x45, 0x31, 0, 0, 0x40, 0x9c, 0, 0, 200]);
    await expect(parseEnvelopeHeader(bad)).rejects.toThrow('malformed envelope');
  });
});

// ─── verifyKey (gate probe) ────────────────────────────────────────────────

describe('verifyKey', () => {
  it('returns true for the correct key and false for a wrong one', async () => {
    const frag = randomBytes(FRAGMENT_BYTES);
    const salt = randomBytes(16);
    const good = await deriveMasterKey('pw', frag, salt, FAST);
    const bad = await deriveMasterKey('nope', frag, salt, FAST);
    const env = await encryptToEnvelope(textBytes('x'), good, { salt, iterations: FAST });
    expect(await verifyKey(env, good)).toBe(true);
    expect(await verifyKey(env, bad)).toBe(false);
  });
});

// ─── Chunk boundary correctness ────────────────────────────────────────────

describe('chunk boundary', () => {
  it('exactly one chunk when length == chunkSize', async () => {
    const frag = randomBytes(FRAGMENT_BYTES);
    const env = await encryptGlb(randomBytes(4096), 'pw', frag, { iterations: FAST, chunkSize: 4096 });
    expect((await parseEnvelopeHeader(env)).chunkCount).toBe(1);
  });

  it('two chunks when length == chunkSize + 1', async () => {
    const frag = randomBytes(FRAGMENT_BYTES);
    const plain = randomBytes(4097);
    const env = await encryptGlb(plain, 'pw', frag, { iterations: FAST, chunkSize: 4096 });
    expect((await parseEnvelopeHeader(env)).chunkCount).toBe(2);
    expect(toHex(new Uint8Array(await decryptGlb(env, 'pw', frag)))).toBe(toHex(plain));
  });
});

// ─── Golden vector (deterministic; Node/CLI reproduces byte-for-byte) ───────

describe('golden vector', () => {
  // Fixed inputs → the encrypt path with an injected IV is fully deterministic.
  const GOLDEN = {
    password: 'Paßwort-Zürich',
    fragmentHex: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
    saltHex: '0102030405060708090a0b0c0d0e0f10',
    ivHex: 'aabbccddeeff001122334455',
    iterations: 1000,
    plaintext: 'realvirtual golden vector v1',
  };
  // Frozen golden envelope; the Node publish pipeline must reproduce this exactly.
  // Layout: "RVE1"|flags00|kdf00|iters(1000)|saltLen16|salt|infoLen19|"rv-webviewer-glb-v1"
  //         |chunkSize0|chunkCount1|ivLen12|iv|ctLen44|ciphertext‖tag
  const GOLDEN_ENVELOPE_HEX =
    '525645310000e8030000100102030405060708090a0b0c0d0e0f10' +
    '1372762d7765627669657765722d676c622d763100000000010000000c' +
    'aabbccddeeff0011223344552c0000005809d7f9b5b46e87eeb7d2daf9' +
    '0ea6a787979d809bc78b1cfeb373a3127d25f8dd926d5b2a2faf72fb876700';

  function hexToBytes(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  it('produces a deterministic, self-consistent envelope', async () => {
    const frag = hexToBytes(GOLDEN.fragmentHex);
    const salt = hexToBytes(GOLDEN.saltHex);
    const iv = hexToBytes(GOLDEN.ivHex);
    const key = await deriveMasterKey(GOLDEN.password, frag, salt, GOLDEN.iterations);

    const env1 = new Uint8Array(
      await encryptToEnvelope(textBytes(GOLDEN.plaintext), key, {
        salt,
        iterations: GOLDEN.iterations,
        ivs: [iv],
      }),
    );
    const env2 = new Uint8Array(
      await encryptToEnvelope(textBytes(GOLDEN.plaintext), key, {
        salt,
        iterations: GOLDEN.iterations,
        ivs: [iv],
      }),
    );
    // Deterministic: identical inputs (incl. IV) → identical bytes.
    expect(toHex(env1)).toBe(toHex(env2));
    // Round-trips.
    expect(decode(await decryptGlb(env1, GOLDEN.password, frag))).toBe(GOLDEN.plaintext);

    if (GOLDEN_ENVELOPE_HEX) {
      expect(toHex(env1)).toBe(GOLDEN_ENVELOPE_HEX);
    } else {
      // First run: surface the value to freeze into GOLDEN_ENVELOPE_HEX.
      // eslint-disable-next-line no-console
      console.log('[golden vector envelope hex]', toHex(env1));
    }
  });
});

describe('defaults', () => {
  it('exposes the OWASP-aligned default iteration count', () => {
    expect(DEFAULT_ITERATIONS).toBe(600_000);
  });
});
