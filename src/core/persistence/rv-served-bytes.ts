// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-served-bytes.ts — THE decrypt seam of a hosted deploy (plan-759 F6).
 *
 * A hosted deploy publishes every GLB of the served project as an RVE1
 * envelope under its own name. Whatever fetches document bytes — the served
 * project's backend, the model cache, a blob URL handed to a thumbnail — goes
 * through {@link fetchServedBytes} / {@link decryptServedBytes}, which turn an
 * envelope back into a GLB with the key the boot gate derived, and pass plain
 * bytes through untouched. One place, so no fetch path can hand ciphertext to
 * `GLTFLoader.parse` by omission.
 *
 * The key is held per SALT: every envelope of one publish shares the salt the
 * probe in settings.json carries, so a key derived from the probe opens all of
 * them, and an envelope with another salt (a second served project in the same
 * tab, `project-store` caches backends per base URL) is simply "no key yet"
 * rather than a wrong-key failure (F13).
 */

import { getAppConfig } from '../rv-app-config';
import { decryptEnvelope, isEncryptedEnvelope, parseEnvelopeHeader } from './rv-crypto-utils';

/** An envelope reached a fetch path before the gate handed over a key for its salt. */
export class EncryptedWithoutKeyError extends Error {
  readonly code = 'encrypted-without-key' as const;
  constructor(readonly url: string) {
    super(`Encrypted document without a session key: ${url}`);
    this.name = 'EncryptedWithoutKeyError';
  }
}

const _keys = new Map<string, CryptoKey>();

export function saltHex(salt: Uint8Array): string {
  let s = '';
  for (const b of salt) s += b.toString(16).padStart(2, '0');
  return s;
}

/** Remember the key the gate verified for this salt (one per publish). */
export function setSessionKey(salt: Uint8Array | string, key: CryptoKey): void {
  _keys.set(typeof salt === 'string' ? salt : saltHex(salt), key);
}

/** The verified key for this salt, or null when the gate has not run for it. */
export function getSessionKey(salt: Uint8Array | string): CryptoKey | null {
  return _keys.get(typeof salt === 'string' ? salt : saltHex(salt)) ?? null;
}

/** Forget every key (tests; a future "lock" action). */
export function clearSessionKeys(): void {
  _keys.clear();
}

/** True when this deploy's settings.json declares encrypted documents. */
export function isEncryptedDeploy(): boolean {
  return getAppConfig().encryption?.enabled === true;
}

/**
 * Plain bytes come back as they are. An RVE1 envelope is decrypted with the
 * session key of its salt; without one this throws
 * {@link EncryptedWithoutKeyError} instead of returning ciphertext.
 */
export async function decryptServedBytes(bytes: ArrayBuffer | Uint8Array, url = ''): Promise<ArrayBuffer> {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!isEncryptedEnvelope(view)) {
    return bytes instanceof Uint8Array
      ? (view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer)
      : bytes;
  }
  const header = await parseEnvelopeHeader(view);
  const key = getSessionKey(header.salt);
  if (!key) throw new EncryptedWithoutKeyError(url);
  return decryptEnvelope(view, key);
}

/**
 * `fetch` + {@link decryptServedBytes}. The one call every GLB byte path of a
 * served project makes. Throws on a non-2xx response like the callers it
 * replaced did.
 */
export async function fetchServedBytes(url: string, init?: RequestInit, fetchImpl: typeof fetch = fetch): Promise<ArrayBuffer> {
  const resp = await fetchImpl(url, init);
  if (!resp.ok) throw new Error(`GLB fetch failed (${resp.status}) for ${url}`);
  return decryptServedBytes(await resp.arrayBuffer(), url);
}
