// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * "I trust THIS shared model with my plant" — persisted, per model (plan-423 F6).
 *
 * A shared GLB is loaded untrusted (plan-386 F17): no `SignalBindingManager`,
 * no interface auto-connect, no CONNECT per-model stream. That is right for a
 * spectator and wrong for the integrator the commissioning workspace exists
 * for, so he is offered ONE explicit decision. This module is where that
 * decision lives between page loads.
 *
 * ## What identifies a model
 *
 * Two parts, and both are needed (review finding SOL-R1 F3):
 *
 * | Part | Why |
 * |------|-----|
 * | key: `share:<id>` / `url:<normalised>` | signed storage URLs ROTATE — the opaque share id is the only stable anchor a link has, and for a self-hosted GLB the normalised URL is |
 * | digest: SHA-256 of the loaded bytes | the key alone would transfer the decision to whatever the provider puts behind it NEXT; the bytes are what was actually trusted |
 *
 * A load is trusted only when BOTH match. Different bytes behind the same id
 * fall back to untrusted and ask again — which is the whole point: the user
 * vouched for a machine he looked at, not for an address.
 *
 * ## Fail closed, degrade quietly
 *
 * No `crypto.subtle` (an insecure-origin deploy: plain http on a LAN address)
 * means no digest, and no digest means no trust — never a weaker hash, which
 * would turn "the bytes I saw" into "bytes that collide with what I saw".
 * Storage that refuses to write (quota, private mode) is not an error either:
 * the activation still applies to the load that follows, the record simply is
 * not there next time and the banner asks again.
 */

/** Everything this module owns, under one versioned localStorage key. */
export const SHARE_TRUST_KEY = 'rv-share-trust';

/** Bumped when the record shape changes; an unknown version is ignored wholesale. */
export const SHARE_TRUST_VERSION = 1;

export interface ShareTrustRecord {
  /** Lowercase hex SHA-256 of the bytes that were trusted. */
  digest: string;
  /** Schema version of THIS record. */
  v: number;
}

type TrustTable = Record<string, ShareTrustRecord>;

/** Storage key for an opaque share id (`?glb=s:<id>`). */
export function shareTrustKeyForId(id: string): string {
  return `share:${id}`;
}

/**
 * Storage key for a self-hosted GLB (`?glb=<url>`).
 *
 * Normalised through `URL` so `HTTPS://Host/a.glb` and `https://host/a.glb` are
 * one model, while the query string is KEPT: a signed or versioned URL that
 * differs there may well be different content, and the digest check would catch
 * it anyway — treating them as one entry only widens what a single decision
 * covers. The hash is dropped; it never reaches the server.
 */
export function shareTrustKeyForUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    return `url:${u.href}`;
  } catch {
    return `url:${url.trim()}`;
  }
}

/**
 * Lowercase hex SHA-256 of the loaded bytes, or `null` when this browser
 * cannot compute one (insecure origin — see the header).
 */
export async function digestOfBytes(bytes: ArrayBuffer): Promise<string | null> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return null;
    const digest = await subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return null;
  }
}

function readTable(): TrustTable {
  try {
    const raw = localStorage.getItem(SHARE_TRUST_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as TrustTable;
  } catch {
    // Storage disabled, or a corrupt entry: the same answer either way — no
    // decision on file, so the banner asks.
    return {};
  }
}

function writeTable(table: TrustTable): boolean {
  try {
    localStorage.setItem(SHARE_TRUST_KEY, JSON.stringify(table));
    return true;
  } catch {
    return false;
  }
}

/**
 * Is there a decision on file for exactly these bytes under this key?
 *
 * Both halves are checked here rather than by the caller so no future call site
 * can accidentally honour the key alone.
 */
export function isShareTrusted(key: string, digest: string | null): boolean {
  if (!key || !digest) return false;
  const record = readTable()[key];
  return !!record
    && record.v === SHARE_TRUST_VERSION
    && typeof record.digest === 'string'
    && record.digest === digest;
}

/**
 * Record the decision. Returns `false` when storage refused it — the caller
 * proceeds anyway (the activation applies to the load it triggers), it just
 * will not survive the next visit.
 */
export function rememberShareTrust(key: string, digest: string | null): boolean {
  if (!key || !digest) return false;
  const table = readTable();
  table[key] = { digest, v: SHARE_TRUST_VERSION };
  return writeTable(table);
}

/**
 * Withdraw exactly one decision.
 *
 * Deliberately not "clear everything": the user revokes the model in front of
 * him, and silently dropping his decisions about other machines would be a
 * surprise he cannot see.
 */
export function forgetShareTrust(key: string): void {
  if (!key) return;
  const table = readTable();
  if (!(key in table)) return;
  delete table[key];
  if (Object.keys(table).length === 0) {
    try { localStorage.removeItem(SHARE_TRUST_KEY); } catch { /* see writeTable */ }
    return;
  }
  writeTable(table);
}
