// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-crypto-parity.node.test.ts — plan-267. Locks the Node publish-pipeline
 * crypto (scripts/lib/rv-crypto.mjs) to the browser TS module by asserting BOTH
 * produce the identical frozen golden vector. If either envelope format drifts,
 * this test (Node) and rv-crypto-utils.test.ts (browser) disagree with the frozen
 * constant and go red — that is what makes "one encrypt contract" enforceable
 * across two runtimes.
 *
 * Runs in the Node vitest config (`*.node.test.ts`, `npm run test:node`) because
 * it imports a Node-only `.mjs` that uses `node:crypto` webcrypto.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain JS Node module, no type declarations by design.
import * as nodeCrypto from '../scripts/lib/rv-crypto.mjs';

// MUST equal GOLDEN_ENVELOPE_HEX in tests/rv-crypto-utils.test.ts (browser).
const GOLDEN_ENVELOPE_HEX =
  '525645310000e8030000100102030405060708090a0b0c0d0e0f10' +
  '1372762d7765627669657765722d676c622d763100000000010000000c' +
  'aabbccddeeff0011223344552c0000005809d7f9b5b46e87eeb7d2daf9' +
  '0ea6a787979d809bc78b1cfeb373a3127d25f8dd926d5b2a2faf72fb876700';

const GOLDEN = {
  password: 'Paßwort-Zürich',
  fragmentHex: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
  saltHex: '0102030405060708090a0b0c0d0e0f10',
  ivHex: 'aabbccddeeff001122334455',
  iterations: 1000,
  plaintext: 'realvirtual golden vector v1',
};

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function toHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

describe('Node crypto pipeline parity', () => {
  it('produces the frozen golden vector byte-for-byte (matches the browser TS)', async () => {
    const frag = hexToBytes(GOLDEN.fragmentHex);
    const salt = hexToBytes(GOLDEN.saltHex);
    const iv = hexToBytes(GOLDEN.ivHex);
    const key = await nodeCrypto.deriveMasterKey(GOLDEN.password, frag, salt, GOLDEN.iterations);
    const env = await nodeCrypto.encryptToEnvelope(new TextEncoder().encode(GOLDEN.plaintext), key, {
      salt,
      iterations: GOLDEN.iterations,
      ivs: [iv],
    });
    expect(toHex(env)).toBe(GOLDEN_ENVELOPE_HEX);
  });

  it('round-trips through encryptGlb/decryptGlb', async () => {
    const frag = nodeCrypto.generateFragmentSecret();
    const plain = new TextEncoder().encode('{"defaultModel":"models/mauser.glb"}');
    const env = await nodeCrypto.encryptGlb(plain, 'pw', frag, { iterations: 1000 });
    expect(nodeCrypto.isEncryptedEnvelope(env)).toBe(true);
    const out = await nodeCrypto.decryptGlb(env, 'pw', frag);
    expect(new TextDecoder().decode(out)).toBe('{"defaultModel":"models/mauser.glb"}');
  });

  it('round-trips a chunked payload', async () => {
    const frag = nodeCrypto.generateFragmentSecret();
    const plain = nodeCrypto.randomBytes(50_000);
    const env = await nodeCrypto.encryptGlb(plain, 'pw', frag, { iterations: 1000, chunkSize: 16_384 });
    const out = new Uint8Array(await nodeCrypto.decryptGlb(env, 'pw', frag));
    expect(toHex(out)).toBe(toHex(plain));
  });

  it('base64url matches (fragment link factor)', () => {
    const bytes = hexToBytes(GOLDEN.fragmentHex);
    const b64 = nodeCrypto.bytesToBase64Url(bytes);
    expect(toHex(nodeCrypto.base64UrlToBytes(b64))).toBe(GOLDEN.fragmentHex);
  });
});
