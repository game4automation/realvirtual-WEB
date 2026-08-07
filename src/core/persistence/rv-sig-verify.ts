// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { RV_SIG_ROOT_PUBLIC_KEY_BASE64 } from './rv-sig-public-key';

export type SignatureState = 'none' | 'valid' | 'invalid' | 'unverifiable';

export interface SignatureVerification {
  state: SignatureState;
  signaturePresent: boolean;
  signerOrganization?: string;
}

export interface SignatureBufferResult extends SignatureVerification {
  buffer: ArrayBuffer;
  workerUsed: boolean;
  recoveredByRefetch: boolean;
}

export interface VerifyRvSigOptions {
  /** Tests may force the JS fallback without mutating global WebCrypto. */
  forceFallback?: boolean;
  /** Tests may model an environment where neither implementation is usable. */
  disableFallback?: boolean;
  /** Test-only trust anchor override. Production callers use the compiled root key. */
  rootPublicKeyBase64?: string;
}

export const RV_SIG_PLACEHOLDER = `${'A'.repeat(86)}==`;
export const RV_SIG_WORKER_THRESHOLD = 25 * 1024 * 1024;
const RV_SIG_WORKER_TIMEOUT_MS = 5_000;
const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const JSON_CHUNK = 0x4e4f534a;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

interface StringToken {
  value: string;
  start: number;
  contentStart: number;
  contentEnd: number;
  end: number;
  escaped: boolean;
}

interface SigLocation {
  value: string;
  byteOffset: number;
  canonical: boolean;
  count: number;
}

interface ParsedGlbSignature {
  json: Record<string, unknown>;
  jsonOffset: number;
  jsonLength: number;
  sig: SigLocation | null;
  signaturePresent: boolean;
}

/** Strict standard Base64 decoder for the fixed 64-byte Ed25519 signature. */
export function base64ToSig(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]{86}==$/.test(value)) return null;
  return decodeStrictBase64(value, 64);
}

/** Strict standard Base64 encoder for a 64-byte Ed25519 signature. */
export function sigToBase64(value: Uint8Array): string {
  if (value.length !== 64) throw new Error(`Ed25519 signature must be 64 bytes, got ${value.length}`);
  return bytesToBase64(value);
}

function decodeStrictPublicKey(value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return null;
  return decodeStrictBase64(value, 32);
}

function decodeStrictBase64(value: string, expectedLength: number): Uint8Array | null {
  try {
    const binary = atob(value);
    if (binary.length !== expectedLength) return null;
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return bytesToBase64(out) === value ? out : null;
  } catch {
    return null;
  }
}

function bytesToBase64(value: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < value.length; i += chunk) {
    binary += String.fromCharCode(...value.subarray(i, Math.min(i + chunk, value.length)));
  }
  return btoa(binary);
}

function skipWs(text: string, pos: number): number {
  while (pos < text.length && /\s/.test(text[pos])) pos++;
  return pos;
}

function readString(text: string, pos: number): StringToken {
  if (text[pos] !== '"') throw new Error('expected JSON string');
  const start = pos++;
  const contentStart = pos;
  let escaped = false;
  while (pos < text.length) {
    const ch = text[pos];
    if (ch === '"') {
      const contentEnd = pos;
      const end = pos + 1;
      const raw = text.slice(start, end);
      return {
        value: JSON.parse(raw) as string,
        start,
        contentStart,
        contentEnd,
        end,
        escaped,
      };
    }
    if (ch === '\\') {
      escaped = true;
      pos++;
      if (pos >= text.length) throw new Error('unterminated JSON escape');
      if (text[pos] === 'u') {
        if (!/^[0-9a-fA-F]{4}$/.test(text.slice(pos + 1, pos + 5))) throw new Error('invalid unicode escape');
        pos += 5;
      } else {
        pos++;
      }
      continue;
    }
    if (ch.charCodeAt(0) < 0x20) throw new Error('invalid JSON string');
    pos++;
  }
  throw new Error('unterminated JSON string');
}

/**
 * Walk a JSON value without reserializing it. When `targetPath` resolves to an
 * object, every rv_sig member in that exact object is recorded, including
 * duplicate keys that JSON.parse alone would hide.
 */
function locateSignature(text: string, targetPath: Array<string | number>): SigLocation | null {
  const matches: Array<{ token: StringToken; canonical: boolean }> = [];

  const scanValue = (at: number, path: Array<string | number>): number => {
    let pos = skipWs(text, at);
    const ch = text[pos];
    if (ch === '"') return readString(text, pos).end;
    if (ch === '{') {
      pos = skipWs(text, pos + 1);
      if (text[pos] === '}') return pos + 1;
      while (pos < text.length) {
        const key = readString(text, pos);
        const colon = key.end;
        pos = skipWs(text, colon);
        if (text[pos] !== ':') throw new Error('expected JSON colon');
        const valueStart = skipWs(text, pos + 1);
        if (samePath(path, targetPath) && key.value === 'rv_sig') {
          if (text[valueStart] !== '"') throw new Error('rv_sig must be a string');
          const token = readString(text, valueStart);
          matches.push({
            token,
            canonical:
              !key.escaped
              && text.slice(key.start, key.end) === '"rv_sig"'
              && colon === pos
              && valueStart === pos + 1
              && !token.escaped,
          });
        }
        pos = scanValue(valueStart, [...path, key.value]);
        pos = skipWs(text, pos);
        if (text[pos] === '}') return pos + 1;
        if (text[pos] !== ',') throw new Error('expected JSON comma');
        pos = skipWs(text, pos + 1);
      }
      throw new Error('unterminated JSON object');
    }
    if (ch === '[') {
      pos = skipWs(text, pos + 1);
      if (text[pos] === ']') return pos + 1;
      let index = 0;
      while (pos < text.length) {
        pos = scanValue(pos, [...path, index++]);
        pos = skipWs(text, pos);
        if (text[pos] === ']') return pos + 1;
        if (text[pos] !== ',') throw new Error('expected JSON comma');
        pos = skipWs(text, pos + 1);
      }
      throw new Error('unterminated JSON array');
    }
    const primitive = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(pos));
    if (!primitive) throw new Error('invalid JSON value');
    return pos + primitive[0].length;
  };

  const end = skipWs(text, scanValue(0, []));
  if (end !== text.length) throw new Error('trailing JSON data');
  if (matches.length === 0) return null;
  const first = matches[0];
  return {
    value: first.token.value,
    byteOffset: encoder.encode(text.slice(0, first.token.contentStart)).length,
    canonical: matches.length === 1 && first.canonical,
    count: matches.length,
  };
}

function samePath(a: Array<string | number>, b: Array<string | number>): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function parseGlbSignature(buffer: ArrayBuffer): ParsedGlbSignature {
  if (buffer.byteLength < 20) throw new Error('malformed GLB');
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== GLB_VERSION) {
    throw new Error('malformed GLB header');
  }
  if (view.getUint32(8, true) !== buffer.byteLength) throw new Error('malformed GLB length');
  const jsonLength = view.getUint32(12, true);
  const jsonType = view.getUint32(16, true);
  const jsonOffset = 20;
  if (jsonType !== JSON_CHUNK || jsonLength === 0 || jsonOffset + jsonLength > buffer.byteLength) {
    throw new Error('malformed GLB JSON chunk');
  }
  const textWithPadding = decoder.decode(new Uint8Array(buffer, jsonOffset, jsonLength));
  const text = textWithPadding.replace(/ +$/u, '');
  const json = JSON.parse(text) as Record<string, unknown>;
  const sceneIndex = typeof json.scene === 'number' && Number.isInteger(json.scene) ? json.scene : 0;
  const scenes = json.scenes;
  const scene = Array.isArray(scenes) ? scenes[sceneIndex] as Record<string, unknown> | undefined : undefined;
  const extras = scene?.extras as Record<string, unknown> | undefined;
  const signaturePresent = !!extras && Object.prototype.hasOwnProperty.call(extras, 'rv_sig');
  let sig: SigLocation | null = null;
  try {
    sig = locateSignature(text, ['scenes', sceneIndex, 'extras']);
  } catch (error) {
    // A semantically present but non-string/non-canonical rv_sig is invalid,
    // not unsigned. Preserve presence so the loader also excludes sidecars.
    if (!signaturePresent) throw error;
  }
  return { json, jsonOffset, jsonLength, sig, signaturePresent };
}

function customerKeyMessage(publicKey: Uint8Array, organization: string): Uint8Array<ArrayBuffer> {
  const org = encoder.encode(organization.normalize('NFC'));
  const prefix = encoder.encode('RV-KEY-V1');
  const out = new Uint8Array(prefix.length + publicKey.length + 4 + org.length);
  out.set(prefix, 0);
  out.set(publicKey, prefix.length);
  new DataView(out.buffer).setUint32(prefix.length + publicKey.length, org.length, true);
  out.set(org, prefix.length + publicKey.length + 4);
  return out;
}

async function verifyEd25519(
  signature: Uint8Array,
  message: Uint8Array<ArrayBuffer>,
  publicKey: Uint8Array,
  options: VerifyRvSigOptions,
): Promise<boolean | null> {
  const signatureBytes = Uint8Array.from(signature);
  // NOT copied: both call sites pass a freshly allocated, offset-free Uint8Array, and for the
  // file signature that is the whole GLB (up to RV_SIG_WORKER_THRESHOLD on the main thread).
  // `Uint8Array.from` would walk it through the iterator protocol — a second full copy per load.
  const messageBytes = message;
  const publicKeyBytes = Uint8Array.from(publicKey);
  if (!options.forceFallback) {
    try {
      const key = await crypto.subtle.importKey('raw', publicKeyBytes, 'Ed25519', false, ['verify']);
      return await crypto.subtle.verify('Ed25519', key, signatureBytes, messageBytes);
    } catch {
      // Feature detection: use the lazily loaded fallback below.
    }
  }
  if (options.disableFallback) return null;
  try {
    const noble = await import('@noble/ed25519');
    return await noble.verifyAsync(signatureBytes, messageBytes, publicKeyBytes);
  } catch {
    return null;
  }
}

/** Verify rv_sig on the current thread. The input buffer is never detached. */
export async function verifyRvSigDirect(
  buffer: ArrayBuffer,
  options: VerifyRvSigOptions = {},
): Promise<SignatureVerification> {
  let parsed: ParsedGlbSignature;
  try {
    parsed = parseGlbSignature(buffer);
  } catch {
    return { state: 'invalid', signaturePresent: false };
  }
  if (!parsed.signaturePresent) return { state: 'none', signaturePresent: false };
  if (!parsed.sig || parsed.sig.count !== 1 || !parsed.sig.canonical) {
    return { state: 'invalid', signaturePresent: true };
  }
  const signature = base64ToSig(parsed.sig.value);
  if (!signature) return { state: 'invalid', signaturePresent: true };

  const bytes = new Uint8Array(buffer.slice(0));
  const signatureOffset = parsed.jsonOffset + parsed.sig.byteOffset;
  bytes.set(encoder.encode(RV_SIG_PLACEHOLDER), signatureOffset);

  const rootPublicKey = decodeStrictPublicKey(options.rootPublicKeyBase64 ?? RV_SIG_ROOT_PUBLIC_KEY_BASE64);
  if (!rootPublicKey) return { state: 'unverifiable', signaturePresent: true };

  const sceneIndex = typeof parsed.json.scene === 'number' && Number.isInteger(parsed.json.scene)
    ? parsed.json.scene
    : 0;
  const scenes = parsed.json.scenes;
  const scene = Array.isArray(scenes) ? scenes[sceneIndex] as Record<string, unknown> | undefined : undefined;
  const extras = scene?.extras as Record<string, unknown> | undefined;
  const rawKey = extras?.rv_key;
  let filePublicKey = rootPublicKey;
  let signerOrganization: string | undefined;

  if (rawKey !== undefined) {
    if (!rawKey || typeof rawKey !== 'object' || Array.isArray(rawKey)) {
      return { state: 'invalid', signaturePresent: true };
    }
    const key = rawKey as Record<string, unknown>;
    const customerPublicKey = decodeStrictPublicKey(key.pub);
    const keySignature = typeof key.sig === 'string' ? base64ToSig(key.sig) : null;
    if (!customerPublicKey || !keySignature || typeof key.org !== 'string') {
      return { state: 'invalid', signaturePresent: true };
    }
    const certOk = await verifyEd25519(
      keySignature,
      customerKeyMessage(customerPublicKey, key.org),
      rootPublicKey,
      options,
    );
    if (certOk === null) return { state: 'unverifiable', signaturePresent: true, signerOrganization: key.org };
    if (!certOk) return { state: 'invalid', signaturePresent: true, signerOrganization: key.org };
    filePublicKey = customerPublicKey;
    signerOrganization = key.org;
  }

  const fileOk = await verifyEd25519(signature, bytes, filePublicKey, options);
  if (fileOk === null) return { state: 'unverifiable', signaturePresent: true, signerOrganization };
  return {
    state: fileOk ? 'valid' : 'invalid',
    signaturePresent: true,
    signerOrganization,
  };
}

/**
 * Verify a buffer and return the exact buffer that must be passed to GLTFLoader.
 * Large buffers make a transferable round-trip through a worker. If the worker
 * loses ownership through start/error/messageerror/timeout, one caller-supplied
 * re-fetch is used only to recover geometry and the state stays unverifiable.
 */
export async function verifyRvSigBuffer(
  buffer: ArrayBuffer,
  refetchForGeometry?: () => Promise<ArrayBuffer>,
  options: VerifyRvSigOptions = {},
): Promise<SignatureBufferResult> {
  if (buffer.byteLength <= RV_SIG_WORKER_THRESHOLD) {
    return { ...(await verifyRvSigDirect(buffer, options)), buffer, workerUsed: false, recoveredByRefetch: false };
  }
  // Avoid starting a Worker (and avoid gating) when a large file is unsigned.
  // Parsing only the JSON chunk is bounded and does not copy the binary payload.
  try {
    const parsed = parseGlbSignature(buffer);
    if (!parsed.signaturePresent) {
      return {
        state: 'none',
        signaturePresent: false,
        buffer,
        workerUsed: false,
        recoveredByRefetch: false,
      };
    }
  } catch {
    return {
      state: 'invalid',
      signaturePresent: false,
      buffer,
      workerUsed: false,
      recoveredByRefetch: false,
    };
  }
  if (typeof Worker === 'undefined') {
    return recoverUnverifiable(buffer, true, refetchForGeometry);
  }

  let worker: Worker;
  try {
    worker = new Worker(new URL('./rv-sig-worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return recoverUnverifiable(buffer, true, refetchForGeometry);
  }

  try {
    return await new Promise<SignatureBufferResult>((resolve) => {
      let settled = false;
      const finish = (result: SignatureBufferResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        worker.terminate();
        resolve(result);
      };
      const fail = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        worker.terminate();
        void recoverUnverifiable(buffer, true, refetchForGeometry).then(resolve);
      };
      const timeout = setTimeout(fail, RV_SIG_WORKER_TIMEOUT_MS);
      worker.onerror = fail;
      worker.onmessageerror = fail;
      worker.onmessage = (event: MessageEvent<SignatureVerification & { buffer: ArrayBuffer }>) => {
        const data = event.data;
        if (!(data?.buffer instanceof ArrayBuffer)) {
          fail();
          return;
        }
        finish({ ...data, workerUsed: true, recoveredByRefetch: false });
      };
      worker.postMessage({ buffer, options }, [buffer]);
    });
  } catch {
    return recoverUnverifiable(buffer, true, refetchForGeometry);
  }
}

async function recoverUnverifiable(
  original: ArrayBuffer,
  mayBeDetached: boolean,
  refetch?: () => Promise<ArrayBuffer>,
): Promise<SignatureBufferResult> {
  let geometry = original;
  let recoveredByRefetch = false;
  if ((mayBeDetached || original.byteLength === 0) && refetch) {
    geometry = await refetch();
    recoveredByRefetch = true;
  }
  return {
    state: 'unverifiable',
    signaturePresent: true,
    buffer: geometry,
    workerUsed: mayBeDetached,
    recoveredByRefetch,
  };
}
