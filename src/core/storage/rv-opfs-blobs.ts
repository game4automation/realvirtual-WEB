// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-opfs-blobs — the SHA-addressed blob store of the `browser` backend (§2.5).
 *
 * localStorage holds the scene JSON and will keep holding it: the whole point
 * of §2.5 is that the `rv-scenes/*` keyspace is not touched. What it cannot
 * hold is a 40 MB authored GLB or a thumbnail — it is a string store with a
 * 5–10 MB budget. Those go into the Origin Private File System instead, keyed
 * by the SHA-256 of their own bytes.
 *
 * ## Content addressing is not decoration
 *
 * A project manifest already carries `sha256` on every asset entry
 * (`RvProjectAssetEntry`). Keying the store by that hash means the same GLB
 * referenced from three projects is stored once, a re-save of unchanged bytes
 * is a no-op, and a corrupted half-write can be detected rather than served.
 * It also removes the question "what is this file called" from a medium that
 * has no user-visible names anyway.
 *
 * ## The two honest failure paths (§2.5, §5.1)
 *
 * Both matter more than the happy path, because both are silent by default:
 *
 *  1. **`navigator.storage.persist()` refused.** The data is written and
 *     readable — it is simply evictable under storage pressure. That is not
 *     an error and must not read like one, but it must not be invisible
 *     either: it is announced once through {@link onBlobStoreNotice} so the
 *     shell can say so.
 *  2. **No OPFS at all.** The store degrades to "scenes yes, authored assets
 *     no". It does **not** throw — a missing capability is not an exception —
 *     but it announces itself, {@link getBlobStoreStatus} reports
 *     `available: false`, and every read returns `null` instead of a URL that
 *     silently 404s. What must never happen is a `putBlob()` that resolves as
 *     though it stored something.
 *
 * ## URL ownership
 *
 * {@link getBlobUrl} mints an object URL and hands ownership to the caller
 * together with `revokeUrl()`. There is no internal cache of live URLs: a
 * cache would either leak (never revoked) or revoke a URL a caller is still
 * using. One resolve, one revoke, caller's responsibility.
 *
 * No React, no Three.js, no project types — this module is pure storage.
 */

// ─── Types ──────────────────────────────────────────────────────────────

/**
 * A blob resolved to something loadable, plus the release that goes with it.
 *
 * Named `revokeUrl` rather than `release` because that is exactly what it
 * does — `URL.revokeObjectURL`. The library layer's richer `ResolvedAsset`
 * (§2.6.4, Phase 4) wraps this shape; wrapping is cheap, guessing at it now
 * would not be.
 */
export interface ResolvedBlob {
  url: string;
  revokeUrl(): void;
}

/** What the shell needs to know to be honest about this store. */
export interface BlobStoreStatus {
  /** Is OPFS usable at all? False means "scenes yes, authored assets no". */
  available: boolean;
  /**
   * `navigator.storage.persist()` result: `true` granted, `false` refused,
   * `null` not asked yet (or the API is absent).
   */
  persisted: boolean | null;
  /** Human-readable reason when `available === false`. */
  reason?: string;
}

/** A user-visible notice. Never an exception — see the file header. */
export interface BlobStoreNotice {
  kind: 'no-opfs' | 'not-persisted' | 'write-failed' | 'read-failed';
  message: string;
  /** The underlying error, when there was one. */
  cause?: unknown;
}

// ─── Constants ──────────────────────────────────────────────────────────

/** Root directory inside OPFS. Everything this module owns lives under it. */
export const BLOB_ROOT = 'rv-blobs';

/**
 * Two-character fan-out directory, the git-object layout.
 *
 * A single flat directory with tens of thousands of entries is slow to
 * enumerate in every implementation that backs OPFS with a real filesystem,
 * and `listBlobs()` is what the eventual garbage collection will walk.
 */
const SHARD_LEN = 2;

const SHA256_RE = /^[0-9a-f]{64}$/;

// ─── Notices ────────────────────────────────────────────────────────────

type NoticeListener = (notice: BlobStoreNotice) => void;

const noticeListeners = new Set<NoticeListener>();
/** Notices already emitted, so a capability gap is announced once, not per call. */
const announced = new Set<string>();

/**
 * Subscribe to store notices.
 *
 * Notices already emitted before subscribing are **replayed**: the store is
 * touched during boot and the shell mounts later, so a listener that only saw
 * future notices would reliably miss the one that matters most ("this browser
 * cannot keep your authored assets").
 */
export function onBlobStoreNotice(listener: NoticeListener): () => void {
  noticeListeners.add(listener);
  for (const notice of replayable.values()) {
    try { listener(notice); } catch { /* a bad listener is not our failure */ }
  }
  return () => { noticeListeners.delete(listener); };
}

/** Notices worth replaying to a late subscriber — capability facts, not incidents. */
const replayable = new Map<string, BlobStoreNotice>();

function notify(notice: BlobStoreNotice, opts: { once?: boolean; replay?: boolean } = {}): void {
  const key = `${notice.kind}:${notice.message}`;
  if (opts.once !== false) {
    if (announced.has(key)) return;
    announced.add(key);
  }
  if (opts.replay) replayable.set(notice.kind, notice);
  for (const l of [...noticeListeners]) {
    try { l(notice); } catch { /* ignore */ }
  }
}

// ─── Capability ─────────────────────────────────────────────────────────

let _status: BlobStoreStatus = { available: true, persisted: null };
let _rootPromise: Promise<FileSystemDirectoryHandle | null> | null = null;

/** Is OPFS present in this browser? Cheap, synchronous, no side effects. */
export function isOpfsSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function'
  );
}

/**
 * Current store status.
 *
 * `available` starts optimistic and is only proven false once something has
 * actually tried to reach OPFS — a synchronous feature check cannot tell a
 * private-mode origin apart from a healthy one.
 */
export function getBlobStoreStatus(): BlobStoreStatus {
  return { ..._status };
}

function degrade(reason: string, cause?: unknown): void {
  _status = { ..._status, available: false, reason };
  notify(
    {
      kind: 'no-opfs',
      message: `Authored assets cannot be stored in this browser (${reason}). Scenes are still saved; imported models and thumbnails are not.`,
      cause,
    },
    { replay: true },
  );
}

/** Resolve (and memoise) the store root. Null when OPFS is unusable. */
async function blobRoot(): Promise<FileSystemDirectoryHandle | null> {
  if (_rootPromise) return _rootPromise;
  _rootPromise = (async () => {
    if (!isOpfsSupported()) {
      degrade('the Origin Private File System is not supported');
      return null;
    }
    try {
      const opfs = await navigator.storage.getDirectory();
      return await opfs.getDirectoryHandle(BLOB_ROOT, { create: true });
    } catch (e) {
      degrade('the Origin Private File System is not writable here', e);
      return null;
    }
  })();
  return _rootPromise;
}

// ─── Persistence ────────────────────────────────────────────────────────

/**
 * Ask the browser to make this origin's storage persistent.
 *
 * A refusal is **not** a failure and never throws: the blobs are written
 * either way, they are just evictable. It is announced once so the shell can
 * say "your browser may clear imported models" rather than letting a user
 * discover it by loss.
 *
 * @returns true when storage is persistent (already, or newly granted).
 */
export async function requestPersistence(): Promise<boolean> {
  const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
  if (!storage || typeof storage.persist !== 'function') {
    _status = { ..._status, persisted: null };
    return false;
  }
  try {
    if (typeof storage.persisted === 'function' && (await storage.persisted())) {
      _status = { ..._status, persisted: true };
      return true;
    }
    const granted = await storage.persist();
    _status = { ..._status, persisted: granted };
    if (!granted) {
      notify(
        {
          kind: 'not-persisted',
          message:
            'This browser did not grant persistent storage. Saved scenes and imported models remain available, but may be cleared when the device runs low on space.',
        },
        { replay: true },
      );
    }
    return granted;
  } catch (e) {
    // An exception here means "no answer", not "refused" — do not claim either.
    _status = { ..._status, persisted: null };
    notify({ kind: 'not-persisted', message: 'Persistent storage could not be requested.', cause: e });
    return false;
  }
}

// ─── SHA helpers ────────────────────────────────────────────────────────

/** Hex SHA-256 of a blob's bytes. The canonical key of this store. */
export async function sha256OfBlob(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** True for a well-formed lowercase-able 64-hex digest. */
export function isSha256(value: string): boolean {
  return typeof value === 'string' && SHA256_RE.test(value.toLowerCase());
}

/**
 * Normalise and validate a key.
 *
 * Rejecting a non-digest is a security property, not tidiness: the key
 * becomes a directory and a file name, so an unvalidated `../` would walk out
 * of {@link BLOB_ROOT}.
 */
function normaliseKey(sha256: string): string | null {
  const key = (sha256 ?? '').trim().toLowerCase();
  return SHA256_RE.test(key) ? key : null;
}

function shardOf(key: string): string {
  return key.slice(0, SHARD_LEN);
}

// ─── CRUD ───────────────────────────────────────────────────────────────

/**
 * Store `blob` under its SHA-256.
 *
 * Resolves silently when the bytes are already present (content addressing
 * makes that provable, not assumed). Never throws for a missing OPFS — see
 * the file header — but a genuine write failure is announced.
 *
 * @param sha256 64 hex chars. Use {@link sha256OfBlob} to compute it.
 */
export async function putBlob(sha256: string, blob: Blob): Promise<void> {
  const key = normaliseKey(sha256);
  if (!key) {
    // A malformed key is a programming error, not a capability gap: throwing
    // is right here, because silently not storing would be the data loss.
    throw new Error(`putBlob: "${sha256}" is not a SHA-256 digest.`);
  }
  const root = await blobRoot();
  if (!root) return;                       // degraded — already announced
  try {
    const dir = await root.getDirectoryHandle(shardOf(key), { create: true });
    const file = await dir.getFileHandle(key, { create: true });
    const writable = await file.createWritable();
    try {
      await writable.write(blob);
    } finally {
      await writable.close();
    }
  } catch (e) {
    notify(
      { kind: 'write-failed', message: 'An imported asset could not be stored.', cause: e },
      { once: false },
    );
    throw e;
  }
}

/**
 * Resolve a stored blob to an object URL.
 *
 * The URL is **transient and owned by the caller**: hold it as long as you
 * need it and call `revokeUrl()` exactly once when done. Returns `null` when
 * the blob is not there or the store is degraded — a null is always better
 * than a URL that 404s inside a GLB loader.
 */
export async function getBlobUrl(sha256: string): Promise<ResolvedBlob | null> {
  const blob = await getBlob(sha256);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  let revoked = false;
  return {
    url,
    revokeUrl: () => {
      // Idempotent on purpose: a double revoke in a React cleanup path is a
      // near-certainty, and it must not become an error.
      if (revoked) return;
      revoked = true;
      URL.revokeObjectURL(url);
    },
  };
}

/** The raw blob, or null when absent/degraded. */
export async function getBlob(sha256: string): Promise<Blob | null> {
  const key = normaliseKey(sha256);
  if (!key) return null;
  const root = await blobRoot();
  if (!root) return null;
  try {
    const dir = await root.getDirectoryHandle(shardOf(key));
    const handle = await dir.getFileHandle(key);
    return await handle.getFile();
  } catch {
    // Not found is the normal case for a cache miss, not an incident.
    return null;
  }
}

/** True when the blob is present. */
export async function hasBlob(sha256: string): Promise<boolean> {
  return (await getBlob(sha256)) !== null;
}

/** Remove a blob. Absent is success — deleting is idempotent by contract. */
export async function deleteBlob(sha256: string): Promise<void> {
  const key = normaliseKey(sha256);
  if (!key) return;
  const root = await blobRoot();
  if (!root) return;
  try {
    const dir = await root.getDirectoryHandle(shardOf(key));
    await dir.removeEntry(key);
  } catch {
    /* absent — nothing to do */
  }
}

/** Every stored digest. The walk a future garbage collection needs. */
export async function listBlobs(): Promise<string[]> {
  const root = await blobRoot();
  if (!root) return [];
  const out: string[] = [];
  try {
    for await (const [, shard] of dirEntries(root)) {
      if (shard.kind !== 'directory') continue;
      for await (const [name, entry] of dirEntries(shard as FileSystemDirectoryHandle)) {
        if (entry.kind === 'file' && SHA256_RE.test(name)) out.push(name);
      }
    }
  } catch {
    return out;
  }
  return out.sort();
}

/** Total bytes held. Cheap enough for a settings panel, not for a hot path. */
export async function blobStoreSize(): Promise<number> {
  let total = 0;
  for (const key of await listBlobs()) {
    const blob = await getBlob(key);
    total += blob?.size ?? 0;
  }
  return total;
}

/**
 * Drop everything under {@link BLOB_ROOT}.
 *
 * Test and "clear site data" utility. Deliberately not reachable from any
 * normal code path.
 */
export async function clearAllBlobs(): Promise<void> {
  if (!isOpfsSupported()) return;
  try {
    const opfs = await navigator.storage.getDirectory();
    await opfs.removeEntry(BLOB_ROOT, { recursive: true });
  } catch {
    /* absent */
  }
  _rootPromise = null;
}

/** Test seam: forget the memoised root, status and one-shot notices. */
export function _resetBlobStoreForTests(): void {
  _rootPromise = null;
  _status = { available: true, persisted: null };
  announced.clear();
  replayable.clear();
}

// ─── Iteration shim ─────────────────────────────────────────────────────

/**
 * `entries()` on a directory handle, with a fallback.
 *
 * The async-iterable members of `FileSystemDirectoryHandle` are still absent
 * from TypeScript's DOM lib, and some implementations expose only
 * `Symbol.asyncIterator`. Both spellings are tried before giving up.
 */
function dirEntries(
  dir: FileSystemDirectoryHandle,
): AsyncIterable<[string, FileSystemHandle]> {
  const candidate = dir as unknown as {
    entries?: () => AsyncIterable<[string, FileSystemHandle]>;
    [Symbol.asyncIterator]?: () => AsyncIterator<[string, FileSystemHandle]>;
  };
  if (typeof candidate.entries === 'function') return candidate.entries();
  if (typeof candidate[Symbol.asyncIterator] === 'function') {
    return candidate as AsyncIterable<[string, FileSystemHandle]>;
  }
  return { async *[Symbol.asyncIterator]() { /* nothing to walk */ } };
}
