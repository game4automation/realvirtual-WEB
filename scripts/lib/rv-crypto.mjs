// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-crypto.mjs — Node port of src/core/persistence/rv-crypto-utils.ts (plan-267).
 *
 * The publish pipeline (_bunny-lib.mjs) runs in plain Node with no TS loader, so
 * it cannot import the browser TS module directly. This is a faithful, byte-for-
 * byte port using the SAME WebCrypto primitives (node:crypto webcrypto ==
 * browser crypto.subtle). Drift is caught by tests/rv-crypto-parity.node.test.ts,
 * which asserts the SAME frozen golden vector as the browser test — if either
 * side changes the envelope format, that test goes red.
 *
 * // SOURCE: src/core/persistence/rv-crypto-utils.ts — keep in sync (golden vector)
 */

import { webcrypto } from 'node:crypto';

const { subtle } = webcrypto;

// ─── Format constants (must match the TS module exactly) ───────────────────

const MAGIC = new Uint8Array([0x52, 0x56, 0x45, 0x31]); // "RVE1"
const HKDF_INFO = new TextEncoder().encode('rv-webviewer-glb-v1');
export const FRAGMENT_BYTES = 32;
const PBKDF2_BITS = 256;
export const DEFAULT_ITERATIONS = 600_000;
export const DEFAULT_CHUNK_SIZE = 16 * 1024 * 1024;
const IV_BYTES = 12;
const KDF_PBKDF2 = 0;
const FLAG_CHUNKED = 0x01;

// ─── Byte helpers ──────────────────────────────────────────────────────────

export function randomBytes(n) {
  const b = new Uint8Array(n);
  const MAX = 65536;
  for (let o = 0; o < n; o += MAX) {
    webcrypto.getRandomValues(b.subarray(o, Math.min(o + MAX, n)));
  }
  return b;
}

/** 32 random bytes for the URL `#k=` factor. */
export function generateFragmentSecret() {
  return randomBytes(FRAGMENT_BYTES);
}

/** URL-safe base64 without padding (matches the browser encoder). */
export function bytesToBase64Url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

export function base64UrlToBytes(s) {
  return new Uint8Array(Buffer.from(s, 'base64url'));
}

function concatBytes(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function asBytes(data) {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

// ─── Key derivation (2-factor) ─────────────────────────────────────────────

export async function deriveMasterKey(password, fragmentSecret, salt, iterations) {
  if (fragmentSecret.length !== FRAGMENT_BYTES) {
    throw new Error(`fragment secret must be ${FRAGMENT_BYTES} bytes, got ${fragmentSecret.length}`);
  }
  const pwBytes = new TextEncoder().encode(password.normalize('NFC'));
  const pwKey = await subtle.importKey('raw', pwBytes, 'PBKDF2', false, ['deriveBits']);
  const pwBits = new Uint8Array(
    await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, pwKey, PBKDF2_BITS),
  );
  const ikm = concatBytes([fragmentSecret, pwBits]);
  const hkdfKey = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: HKDF_INFO },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ─── Envelope ──────────────────────────────────────────────────────────────

function buildHeaderBytes(flags, iterations, salt, chunkSize, chunkCount) {
  const len = 4 + 1 + 1 + 4 + 1 + salt.length + 1 + HKDF_INFO.length + 4 + 4;
  const out = new Uint8Array(len);
  const dv = new DataView(out.buffer);
  let o = 0;
  out.set(MAGIC, o); o += 4;
  out[o++] = flags;
  out[o++] = KDF_PBKDF2;
  dv.setUint32(o, iterations, true); o += 4;
  out[o++] = salt.length;
  out.set(salt, o); o += salt.length;
  out[o++] = HKDF_INFO.length;
  out.set(HKDF_INFO, o); o += HKDF_INFO.length;
  dv.setUint32(o, chunkSize, true); o += 4;
  dv.setUint32(o, chunkCount, true); o += 4;
  return out;
}

export function isEncryptedEnvelope(data) {
  const b = asBytes(data);
  return b.length >= 4 && b[0] === MAGIC[0] && b[1] === MAGIC[1] && b[2] === MAGIC[2] && b[3] === MAGIC[3];
}

export async function parseEnvelopeHeader(data) {
  const b = asBytes(data);
  const fail = () => { throw new Error('malformed envelope'); };
  if (b.length < 4 || !isEncryptedEnvelope(b)) fail();
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 4;
  const need = (n) => { if (o + n > b.length) fail(); };
  need(2 + 4);
  const flags = b[o++];
  const kdf = b[o++];
  const iterations = dv.getUint32(o, true); o += 4;
  need(1);
  const saltLen = b[o++];
  need(saltLen);
  const salt = b.slice(o, o + saltLen); o += saltLen;
  need(1);
  const infoLen = b[o++];
  need(infoLen);
  const hkdfInfo = b.slice(o, o + infoLen); o += infoLen;
  need(8);
  const chunkSize = dv.getUint32(o, true); o += 4;
  const chunkCount = dv.getUint32(o, true); o += 4;
  if (kdf !== KDF_PBKDF2 || iterations <= 0 || chunkCount <= 0) fail();
  const headerLength = o;
  const headerHash = new Uint8Array(await subtle.digest('SHA-256', b.slice(0, headerLength)));
  return { flags, kdf, iterations, salt, hkdfInfo, chunkSize, chunkCount, headerLength, headerHash };
}

function computeAad(chunkIndex, chunkCount, headerHash) {
  const aad = new Uint8Array(4 + 4 + 4 + headerHash.length);
  const dv = new DataView(aad.buffer);
  aad.set(MAGIC, 0);
  dv.setUint32(4, chunkIndex, true);
  dv.setUint32(8, chunkCount, true);
  aad.set(headerHash, 12);
  return aad;
}

/**
 * Encrypt with a pre-derived key. `opts`: { salt, iterations, chunkSize, ivs }.
 * `ivs` is for deterministic tests only; production omits it (random IVs).
 */
export async function encryptToEnvelope(plain, key, opts = {}) {
  const data = asBytes(plain);
  const salt = opts.salt ?? randomBytes(16);
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  const chunked = opts.chunkSize !== undefined && opts.chunkSize > 0;
  const chunkSize = chunked ? opts.chunkSize : 0;
  const step = chunked ? chunkSize : Math.max(data.length, 1);
  const chunkCount = chunked ? Math.max(1, Math.ceil(data.length / step)) : 1;
  const flags = chunked ? FLAG_CHUNKED : 0x00;

  const header = buildHeaderBytes(flags, iterations, salt, chunkSize, chunkCount);
  const headerHash = new Uint8Array(await subtle.digest('SHA-256', header));

  const parts = [header];
  for (let i = 0; i < chunkCount; i++) {
    const start = i * step;
    const slice = data.subarray(start, Math.min(start + step, data.length));
    const iv = opts.ivs?.[i] ?? randomBytes(IV_BYTES);
    if (iv.length !== IV_BYTES) throw new Error(`iv must be ${IV_BYTES} bytes`);
    const aad = computeAad(i, chunkCount, headerHash);
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, slice));
    const framing = new Uint8Array(1 + IV_BYTES + 4 + ct.length);
    const fdv = new DataView(framing.buffer);
    framing[0] = IV_BYTES;
    framing.set(iv, 1);
    fdv.setUint32(1 + IV_BYTES, ct.length, true);
    framing.set(ct, 1 + IV_BYTES + 4);
    parts.push(framing);
  }
  return concatBytes(parts);
}

export async function decryptEnvelope(data, key) {
  const header = await parseEnvelopeHeader(data);
  const b = asBytes(data);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = header.headerLength;
  const fail = () => { throw new Error('malformed envelope'); };
  const plainChunks = [];
  for (let i = 0; i < header.chunkCount; i++) {
    if (o + 1 > b.length) fail();
    const ivLen = b[o++];
    if (ivLen !== IV_BYTES || o + IV_BYTES + 4 > b.length) fail();
    const iv = b.slice(o, o + IV_BYTES); o += IV_BYTES;
    const ctLen = dv.getUint32(o, true); o += 4;
    if (o + ctLen > b.length) fail();
    const ct = b.slice(o, o + ctLen); o += ctLen;
    const aad = computeAad(i, header.chunkCount, header.headerHash);
    const pt = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, ct));
    plainChunks.push(pt);
  }
  if (o !== b.length) fail();
  return concatBytes(plainChunks);
}

// ─── High-level (password + fragment) ──────────────────────────────────────

/** Derive the key and encrypt. Returns a Uint8Array RVE1 envelope. */
export async function encryptGlb(plain, password, fragmentSecret, opts = {}) {
  const salt = opts.salt ?? randomBytes(16);
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  const key = await deriveMasterKey(password, fragmentSecret, salt, iterations);
  return encryptToEnvelope(plain, key, { ...opts, salt, iterations });
}

export async function decryptGlb(data, password, fragmentSecret) {
  const header = await parseEnvelopeHeader(data);
  const key = await deriveMasterKey(password, fragmentSecret, header.salt, header.iterations);
  return decryptEnvelope(data, key);
}
