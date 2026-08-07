// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-crypto-utils.ts — zero-knowledge AES-256-GCM encryption for password-
 * protected private WebViewer deploys (plan-267).
 *
 * GENERIC by design: lives in the PUBLIC repo so ONE implementation serves both
 * the browser runtime (`crypto.subtle`, password gate → decrypt) and the Node
 * publish pipeline (`node:crypto.webcrypto`, scripts/_bunny-lib.mjs → encrypt).
 * Because both sides call the identical WebCrypto API there is no C#↔TS interop
 * surface and the encrypt/decrypt halves can never drift. Uses only WebCrypto,
 * available identically in browsers and Node 16+. Must never import feature types.
 *
 * Key = HKDF-SHA256( PBKDF2-SHA256(NFC(password), salt, iters) ‖ fragmentSecret )
 * Two factors, BOTH mandatory: the 32-byte fragment secret travels only in the
 * URL (`#k=...`, never sent to the server), the password only in the user's head.
 * Neither factor alone derives the key. See plan-267 §2.4.
 *
 * Envelope integrity: every chunk is AES-GCM-sealed with Additional Authenticated
 * Data binding it to (magic, chunkIndex, chunkCount, SHA-256(header)). This blocks
 * header tampering, chunk reordering and truncation — a valid chunk cannot be
 * spliced to another position or file, and a shortened stream fails to verify.
 */

// ─── Format constants ────────────────────────────────────────────────────

/** Envelope magic "RVE1" (realvirtual encrypted, v1). */
const MAGIC = new Uint8Array([0x52, 0x56, 0x45, 0x31]);
/** HKDF domain-separation label (also SHA-256 length invariant for AAD). */
const HKDF_INFO = new TextEncoder().encode('rv-webviewer-glb-v1');
/** Fragment secret length in bytes (256-bit URL factor). */
export const FRAGMENT_BYTES = 32;
/** PBKDF2 output length in bits (feeds the HKDF IKM alongside the fragment). */
const PBKDF2_BITS = 256;
/** OWASP-aligned default PBKDF2 iteration count (Dec-2022 guidance). */
export const DEFAULT_ITERATIONS = 600_000;
/** Default chunk size for large payloads (16 MiB). 0 in opts = single buffer. */
export const DEFAULT_CHUNK_SIZE = 16 * 1024 * 1024;
/** AES-GCM IV length in bytes (96 bit, the only size WebCrypto/.NET accept). */
const IV_BYTES = 12;
/** KDF identifier stored in the header (0 = PBKDF2-SHA256). */
const KDF_PBKDF2 = 0;
/** Header flag: payload is split into multiple chunks. */
const FLAG_CHUNKED = 0x01;

// ─── base64url ─────────────────────────────────────────────────────────────

/** Encode bytes as URL-safe base64 without padding (for the `#k=` fragment). */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode URL-safe base64 (padding optional). Throws on invalid input. */
export function base64UrlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ─── Fragment secret ─────────────────────────────────────────────────────

/**
 * Extract the `k=` fragment secret from a `location.hash` value. Returns null
 * when absent, non-decodable, or not exactly {@link FRAGMENT_BYTES} bytes — all
 * of which the caller must treat as "incomplete link", never as an exception.
 * Read this FIRST, before any network request, then clear the hash (plan-267 F6).
 */
export function parseFragmentSecret(hash: string): Uint8Array | null {
  if (!hash) return null;
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!body) return null;
  let token: string | null = null;
  for (const part of body.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq) === 'k') {
      token = part.slice(eq + 1);
      break;
    }
  }
  if (token === null || token === '') return null;
  try {
    const bytes = base64UrlToBytes(token);
    return bytes.length === FRAGMENT_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

// ─── Small byte helpers ────────────────────────────────────────────────────

/** Cryptographically random bytes. Fills in 64 KiB slices (getRandomValues cap). */
export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  const MAX = 65536;
  for (let o = 0; o < n; o += MAX) {
    crypto.getRandomValues(b.subarray(o, Math.min(o + MAX, n)));
  }
  return b;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
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

function asBytes(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

/**
 * WebCrypto's DOM types demand ArrayBuffer-backed views, but TS 5.7 widens most
 * `Uint8Array` producers (`subarray`, `slice`, `TextEncoder.encode`) to
 * `ArrayBufferLike`. Narrow at the call boundary — the runtime bytes are fine.
 */
function bs(b: Uint8Array): BufferSource {
  return b as unknown as BufferSource;
}

// ─── Key derivation (2-factor) ─────────────────────────────────────────────

/**
 * Derive the AES-256-GCM master key from password + fragment secret. The
 * password is NFC-normalized so the same passphrase typed on macOS (NFD) and
 * Windows (NFC) yields identical bytes. Expensive by design (PBKDF2); derive
 * once at the gate and reuse the returned key for probe + full decrypt.
 */
export async function deriveMasterKey(
  password: string,
  fragmentSecret: Uint8Array,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  if (fragmentSecret.length !== FRAGMENT_BYTES) {
    throw new Error(`fragment secret must be ${FRAGMENT_BYTES} bytes, got ${fragmentSecret.length}`);
  }
  const pwBytes = new TextEncoder().encode(password.normalize('NFC'));
  const pwKey = await crypto.subtle.importKey('raw', bs(pwBytes), 'PBKDF2', false, ['deriveBits']);
  const pwBits = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: bs(salt), iterations }, pwKey, PBKDF2_BITS),
  );
  // IKM = fragmentSecret(32) ‖ pbkdf2Bits(32); fixed field widths => unambiguous.
  const ikm = concatBytes([fragmentSecret, pwBits]);
  const hkdfKey = await crypto.subtle.importKey('raw', bs(ikm), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: bs(salt), info: bs(HKDF_INFO) },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ─── Envelope header ───────────────────────────────────────────────────────

/** Parsed, validated envelope header plus offsets needed to read the chunks. */
export interface EnvelopeHeader {
  flags: number;
  kdf: number;
  iterations: number;
  salt: Uint8Array;
  hkdfInfo: Uint8Array;
  chunkSize: number;
  chunkCount: number;
  /** Byte length of the header (where the first chunk framing begins). */
  headerLength: number;
  /** SHA-256 of the exact header bytes — bound into every chunk's AAD. */
  headerHash: Uint8Array;
}

function buildHeaderBytes(
  flags: number,
  iterations: number,
  salt: Uint8Array,
  chunkSize: number,
  chunkCount: number,
): Uint8Array {
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

/** True when `data` begins with the RVE1 magic. */
export function isEncryptedEnvelope(data: ArrayBuffer | Uint8Array): boolean {
  const b = asBytes(data);
  return b.length >= 4 && b[0] === MAGIC[0] && b[1] === MAGIC[1] && b[2] === MAGIC[2] && b[3] === MAGIC[3];
}

/** Parse and validate the header. Throws "malformed envelope" on any overrun. */
export async function parseEnvelopeHeader(data: ArrayBuffer | Uint8Array): Promise<EnvelopeHeader> {
  const b = asBytes(data);
  const fail = (): never => { throw new Error('malformed envelope'); };
  if (b.length < 4 || !isEncryptedEnvelope(b)) fail();
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 4;
  const need = (n: number) => { if (o + n > b.length) fail(); };
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
  const headerHash = new Uint8Array(await crypto.subtle.digest('SHA-256', bs(b.slice(0, headerLength))));
  return { flags, kdf, iterations, salt, hkdfInfo, chunkSize, chunkCount, headerLength, headerHash };
}

// ─── AAD ─────────────────────────────────────────────────────────────────

function computeAad(chunkIndex: number, chunkCount: number, headerHash: Uint8Array): Uint8Array {
  const aad = new Uint8Array(4 + 4 + 4 + headerHash.length);
  const dv = new DataView(aad.buffer);
  aad.set(MAGIC, 0);
  dv.setUint32(4, chunkIndex, true);
  dv.setUint32(8, chunkCount, true);
  aad.set(headerHash, 12);
  return aad;
}

// ─── Encrypt / decrypt ─────────────────────────────────────────────────────

export interface EncryptOptions {
  /** PBKDF2/HKDF salt (public). Random 16 bytes when omitted. */
  salt?: Uint8Array;
  /** PBKDF2 iterations stored in the header. Defaults to {@link DEFAULT_ITERATIONS}. */
  iterations?: number;
  /** Chunk size in bytes; 0/undefined = single buffer. Large GLBs use {@link DEFAULT_CHUNK_SIZE}. */
  chunkSize?: number;
  /** Test/deterministic use ONLY — explicit per-chunk IVs. Production omits (random IVs). */
  ivs?: Uint8Array[];
}

/**
 * Encrypt a payload into an RVE1 envelope using a pre-derived key. `salt` and
 * `iterations` are embedded in the header so the reader can re-derive; they must
 * match the key. Prefer {@link encryptGlb} unless you already hold the key.
 */
export async function encryptToEnvelope(
  plain: ArrayBuffer | Uint8Array,
  key: CryptoKey,
  opts: EncryptOptions = {},
): Promise<ArrayBuffer> {
  const data = asBytes(plain);
  const salt = opts.salt ?? randomBytes(16);
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  const chunked = opts.chunkSize !== undefined && opts.chunkSize > 0;
  const chunkSize = chunked ? (opts.chunkSize as number) : 0;
  const step = chunked ? chunkSize : Math.max(data.length, 1);
  const chunkCount = chunked ? Math.max(1, Math.ceil(data.length / step)) : 1;
  const flags = chunked ? FLAG_CHUNKED : 0x00;

  const header = buildHeaderBytes(flags, iterations, salt, chunkSize, chunkCount);
  const headerHash = new Uint8Array(await crypto.subtle.digest('SHA-256', bs(header)));

  const parts: Uint8Array[] = [header];
  for (let i = 0; i < chunkCount; i++) {
    const start = i * step;
    const slice = data.subarray(start, Math.min(start + step, data.length));
    const iv = opts.ivs?.[i] ?? randomBytes(IV_BYTES);
    if (iv.length !== IV_BYTES) throw new Error(`iv must be ${IV_BYTES} bytes`);
    const aad = computeAad(i, chunkCount, headerHash);
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bs(iv), additionalData: bs(aad) }, key, bs(slice)),
    );
    const framing = new Uint8Array(1 + IV_BYTES + 4 + ct.length);
    const fdv = new DataView(framing.buffer);
    framing[0] = IV_BYTES;
    framing.set(iv, 1);
    fdv.setUint32(1 + IV_BYTES, ct.length, true);
    framing.set(ct, 1 + IV_BYTES + 4);
    parts.push(framing);
  }
  return concatBytes(parts).buffer as ArrayBuffer;
}

/**
 * Decrypt an RVE1 envelope with a pre-derived key. Throws on wrong key, tampered
 * header/ciphertext, reordered or truncated chunks (all surface as GCM auth
 * failures) and on structural corruption ("malformed envelope").
 */
export async function decryptEnvelope(data: ArrayBuffer | Uint8Array, key: CryptoKey): Promise<ArrayBuffer> {
  const header = await parseEnvelopeHeader(data);
  const b = asBytes(data);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = header.headerLength;
  const fail = (): never => { throw new Error('malformed envelope'); };
  const plainChunks: Uint8Array[] = [];
  for (let i = 0; i < header.chunkCount; i++) {
    if (o + 1 > b.length) fail();
    const ivLen = b[o++];
    if (ivLen !== IV_BYTES || o + IV_BYTES + 4 > b.length) fail();
    const iv = b.slice(o, o + IV_BYTES); o += IV_BYTES;
    const ctLen = dv.getUint32(o, true); o += 4;
    if (o + ctLen > b.length) fail();
    const ct = b.slice(o, o + ctLen); o += ctLen;
    const aad = computeAad(i, header.chunkCount, header.headerHash);
    const pt = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bs(iv), additionalData: bs(aad) }, key, bs(ct)),
    );
    plainChunks.push(pt);
  }
  if (o !== b.length) fail(); // trailing bytes => tampering
  return concatBytes(plainChunks).buffer as ArrayBuffer;
}

/**
 * Cheap password/key check for the gate: decrypt ONLY the first chunk. Returns
 * true when the key is correct. Note a later chunk may still be corrupt — the
 * full {@link decryptEnvelope} must run before trusting the payload.
 */
export async function verifyKey(data: ArrayBuffer | Uint8Array, key: CryptoKey): Promise<boolean> {
  try {
    const header = await parseEnvelopeHeader(data);
    const b = asBytes(data);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let o = header.headerLength;
    if (b[o] !== IV_BYTES) return false;
    o += 1;
    const iv = b.slice(o, o + IV_BYTES); o += IV_BYTES;
    const ctLen = dv.getUint32(o, true); o += 4;
    if (o + ctLen > b.length) return false;
    const ct = b.slice(o, o + ctLen);
    const aad = computeAad(0, header.chunkCount, header.headerHash);
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bs(iv), additionalData: bs(aad) }, key, bs(ct));
    return true;
  } catch {
    return false;
  }
}

// ─── High-level convenience (password + fragment) ──────────────────────────

/** Derive the key and encrypt in one call (used by the Node publish pipeline). */
export async function encryptGlb(
  plain: ArrayBuffer | Uint8Array,
  password: string,
  fragmentSecret: Uint8Array,
  opts: EncryptOptions = {},
): Promise<ArrayBuffer> {
  const salt = opts.salt ?? randomBytes(16);
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  const key = await deriveMasterKey(password, fragmentSecret, salt, iterations);
  return encryptToEnvelope(plain, key, { ...opts, salt, iterations });
}

/** Parse the header, derive the key from its salt/iterations, and decrypt. */
export async function decryptGlb(
  data: ArrayBuffer | Uint8Array,
  password: string,
  fragmentSecret: Uint8Array,
): Promise<ArrayBuffer> {
  const header = await parseEnvelopeHeader(data);
  const key = await deriveMasterKey(password, fragmentSecret, header.salt, header.iterations);
  return decryptEnvelope(data, key);
}
