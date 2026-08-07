// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * opfs-blobs.test — plan-372 §9.4.
 *
 * These run against the **real** Origin Private File System. vitest executes
 * in headless Chromium (`vite.config.ts` browser mode), so OPFS is genuinely
 * there — faking it would only prove the fake works, and the two properties
 * that matter here (content addressing survives a round trip, a URL is
 * revocable exactly once) are properties of the medium.
 *
 * The one thing that cannot be had for real is the *absence* of OPFS, so that
 * single case is produced by taking `navigator.storage.getDirectory` away.
 *
 * Covered:
 *  - put/get/delete round trip, and delete of an absent blob is not an error
 *  - SHA addressing: identical bytes collapse to one entry, a non-digest key
 *    is rejected, path-traversal shapes cannot escape the store root
 *  - a refused `persist()` is not a failure but is announced
 *  - a missing OPFS degrades **visibly** instead of throwing
 *  - `getBlobUrl` hands over a `ResolvedBlob` whose `revokeUrl()` is idempotent
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  BLOB_ROOT,
  blobStoreSize,
  clearAllBlobs,
  deleteBlob,
  getBlob,
  getBlobStoreStatus,
  getBlobUrl,
  hasBlob,
  isOpfsSupported,
  isSha256,
  listBlobs,
  onBlobStoreNotice,
  putBlob,
  requestPersistence,
  sha256OfBlob,
  _resetBlobStoreForTests,
  type BlobStoreNotice,
} from '../src/core/storage/rv-opfs-blobs';

// ─── Helpers ────────────────────────────────────────────────────────────

const bytes = (text: string) => new Blob([text], { type: 'application/octet-stream' });

async function store(text: string): Promise<string> {
  const blob = bytes(text);
  const sha = await sha256OfBlob(blob);
  await putBlob(sha, blob);
  return sha;
}

const unsubscribers: Array<() => void> = [];

function collectNotices(): BlobStoreNotice[] {
  const seen: BlobStoreNotice[] = [];
  unsubscribers.push(onBlobStoreNotice(n => seen.push(n)));
  return seen;
}

beforeEach(async () => {
  await clearAllBlobs();
  _resetBlobStoreForTests();
});

afterEach(async () => {
  while (unsubscribers.length) unsubscribers.pop()!();
  await clearAllBlobs();
  _resetBlobStoreForTests();
});

// ─── Round trip ─────────────────────────────────────────────────────────

describe('opfs blob store — round trip', () => {
  it('OPFS is genuinely available in this test environment', () => {
    // If this ever fails, every assertion below is testing a stub instead of
    // the medium, so it is worth asserting explicitly.
    expect(isOpfsSupported()).toBe(true);
  });

  it('stores and reads back the exact bytes', async () => {
    const sha = await store('conveyor-glb-payload');
    const blob = await getBlob(sha);
    expect(blob).not.toBeNull();
    expect(await blob!.text()).toBe('conveyor-glb-payload');
  });

  it('reports presence and absence', async () => {
    const sha = await store('present');
    expect(await hasBlob(sha)).toBe(true);
    expect(await hasBlob('0'.repeat(64))).toBe(false);
  });

  it('deletes, and deleting again is not an error', async () => {
    const sha = await store('temporary');
    await deleteBlob(sha);
    expect(await hasBlob(sha)).toBe(false);
    await expect(deleteBlob(sha)).resolves.toBeUndefined();
  });

  it('lists every stored digest', async () => {
    const a = await store('one');
    const b = await store('two');
    expect((await listBlobs()).sort()).toEqual([a, b].sort());
  });

  it('reports the total size held', async () => {
    await store('12345');
    await store('123456789');
    expect(await blobStoreSize()).toBe(14);
  });

  it('survives a store-root reset — the bytes are on disk, not in memory', async () => {
    const sha = await store('durable');
    _resetBlobStoreForTests();
    expect(await hasBlob(sha)).toBe(true);
  });
});

// ─── SHA addressing ─────────────────────────────────────────────────────

describe('opfs blob store — SHA addressing', () => {
  it('gives identical bytes the same key and stores them once', async () => {
    const first = await store('identical-payload');
    const second = await store('identical-payload');
    expect(second).toBe(first);
    expect(await listBlobs()).toEqual([first]);
  });

  it('gives different bytes different keys', async () => {
    expect(await store('a')).not.toBe(await store('b'));
  });

  it('produces the known SHA-256 of the empty input', async () => {
    // Anchors the digest to the real algorithm rather than to itself.
    expect(await sha256OfBlob(new Blob([]))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('accepts an upper-case digest and normalises it', async () => {
    const sha = await store('case-test');
    expect(await hasBlob(sha.toUpperCase())).toBe(true);
  });

  it('validates digests', () => {
    expect(isSha256('a'.repeat(64))).toBe(true);
    expect(isSha256('A'.repeat(64))).toBe(true);
    expect(isSha256('a'.repeat(63))).toBe(false);
    expect(isSha256('../etc/passwd')).toBe(false);
  });

  it('refuses a non-digest key rather than silently not storing it', async () => {
    // Throwing is right here: a caller that passed a bad key wants to know,
    // and a resolved promise would be the data loss.
    await expect(putBlob('not-a-digest', bytes('x'))).rejects.toThrow(/SHA-256/);
    await expect(putBlob('../escape', bytes('x'))).rejects.toThrow(/SHA-256/);
  });

  it('cannot be made to write outside the store root', async () => {
    await expect(putBlob(`../../${'a'.repeat(58)}`, bytes('x'))).rejects.toThrow();
    // Nothing escaped, and nothing landed inside either.
    expect(await listBlobs()).toEqual([]);
    const opfs = await navigator.storage.getDirectory();
    const names: string[] = [];
    for await (const [name] of (opfs as unknown as {
      entries(): AsyncIterable<[string, FileSystemHandle]>;
    }).entries()) {
      names.push(name);
    }
    expect(names.filter(n => n !== BLOB_ROOT)).toEqual([]);
  });

  it('returns null for a malformed key on read instead of throwing', async () => {
    expect(await getBlob('nonsense')).toBeNull();
    expect(await getBlobUrl('nonsense')).toBeNull();
    await expect(deleteBlob('nonsense')).resolves.toBeUndefined();
  });
});

// ─── Object URLs ────────────────────────────────────────────────────────

describe('opfs blob store — getBlobUrl', () => {
  it('returns a ResolvedBlob with a usable url and a revokeUrl', async () => {
    const sha = await store('url-payload');
    const resolved = await getBlobUrl(sha);
    expect(resolved).not.toBeNull();
    expect(resolved!.url.startsWith('blob:')).toBe(true);
    expect(typeof resolved!.revokeUrl).toBe('function');

    const fetched = await fetch(resolved!.url);
    expect(await fetched.text()).toBe('url-payload');

    resolved!.revokeUrl();
  });

  it('hands ownership to the caller: two resolves are two distinct urls', async () => {
    const sha = await store('shared');
    const a = await getBlobUrl(sha);
    const b = await getBlobUrl(sha);
    expect(a!.url).not.toBe(b!.url);
    // Revoking one must not disturb the other — that is what "the caller owns
    // it" has to mean in practice.
    a!.revokeUrl();
    expect((await fetch(b!.url)).ok).toBe(true);
    b!.revokeUrl();
  });

  it('revokeUrl is idempotent', async () => {
    const sha = await store('double-revoke');
    const resolved = await getBlobUrl(sha);
    resolved!.revokeUrl();
    expect(() => resolved!.revokeUrl()).not.toThrow();
  });

  it('returns null for a blob that is not stored', async () => {
    expect(await getBlobUrl('b'.repeat(64))).toBeNull();
  });
});

// ─── Persistence ────────────────────────────────────────────────────────

describe('opfs blob store — requestPersistence', () => {
  it('never throws and always answers a boolean', async () => {
    const granted = await requestPersistence();
    expect(typeof granted).toBe('boolean');
  });

  it('a refusal is not an error, but it is announced', async () => {
    const notices = collectNotices();
    const original = navigator.storage.persist;
    const originalPersisted = navigator.storage.persisted;
    Object.defineProperty(navigator.storage, 'persist', {
      configurable: true,
      value: async () => false,
    });
    Object.defineProperty(navigator.storage, 'persisted', {
      configurable: true,
      value: async () => false,
    });
    try {
      await expect(requestPersistence()).resolves.toBe(false);
      expect(getBlobStoreStatus().persisted).toBe(false);
      expect(notices.some(n => n.kind === 'not-persisted')).toBe(true);
      // Refused persistence must NOT disable the store — the blobs are
      // written either way, they are only evictable.
      expect(getBlobStoreStatus().available).toBe(true);
      const sha = await store('still-works');
      expect(await hasBlob(sha)).toBe(true);
    } finally {
      Object.defineProperty(navigator.storage, 'persist', { configurable: true, value: original });
      Object.defineProperty(navigator.storage, 'persisted', {
        configurable: true,
        value: originalPersisted,
      });
    }
  });

  it('an already-persisted origin is not asked again', async () => {
    let asked = 0;
    const original = navigator.storage.persist;
    const originalPersisted = navigator.storage.persisted;
    Object.defineProperty(navigator.storage, 'persisted', {
      configurable: true,
      value: async () => true,
    });
    Object.defineProperty(navigator.storage, 'persist', {
      configurable: true,
      value: async () => { asked++; return true; },
    });
    try {
      expect(await requestPersistence()).toBe(true);
      expect(asked).toBe(0);
    } finally {
      Object.defineProperty(navigator.storage, 'persist', { configurable: true, value: original });
      Object.defineProperty(navigator.storage, 'persisted', {
        configurable: true,
        value: originalPersisted,
      });
    }
  });
});

// ─── Degradation ────────────────────────────────────────────────────────

describe('opfs blob store — degradation is visible, never silent', () => {
  /** Take OPFS away for the duration of `fn`. */
  async function withoutOpfs(fn: () => Promise<void>): Promise<void> {
    const original = Object.getOwnPropertyDescriptor(navigator, 'storage')
      ?? Object.getOwnPropertyDescriptor(Navigator.prototype, 'storage');
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      get: () => ({ persist: async () => false, persisted: async () => false }),
    });
    _resetBlobStoreForTests();
    try {
      await fn();
    } finally {
      if (original) Object.defineProperty(navigator, 'storage', original);
      else delete (navigator as unknown as Record<string, unknown>).storage;
      _resetBlobStoreForTests();
    }
  }

  it('reports the capability as absent', async () => {
    await withoutOpfs(async () => {
      expect(isOpfsSupported()).toBe(false);
      await putBlob('c'.repeat(64), bytes('x'));
      const status = getBlobStoreStatus();
      expect(status.available).toBe(false);
      expect(status.reason).toBeTruthy();
    });
  });

  it('does not throw from put/get/delete', async () => {
    await withoutOpfs(async () => {
      const sha = 'd'.repeat(64);
      await expect(putBlob(sha, bytes('x'))).resolves.toBeUndefined();
      await expect(getBlobUrl(sha)).resolves.toBeNull();
      await expect(getBlob(sha)).resolves.toBeNull();
      await expect(deleteBlob(sha)).resolves.toBeUndefined();
      await expect(listBlobs()).resolves.toEqual([]);
    });
  });

  it('announces the degradation, and says what still works', async () => {
    await withoutOpfs(async () => {
      const notices = collectNotices();
      await putBlob('e'.repeat(64), bytes('x'));
      const notice = notices.find(n => n.kind === 'no-opfs');
      expect(notice).toBeDefined();
      // §2.5: "scenes yes, authored assets no" — the message has to carry
      // both halves or it reads as total failure.
      expect(notice!.message).toMatch(/[Ss]cene/);
      expect(notice!.message).toMatch(/model|asset/i);
    });
  });

  it('replays the capability notice to a listener that subscribes later', async () => {
    await withoutOpfs(async () => {
      await putBlob('f'.repeat(64), bytes('x'));
      // The shell mounts after boot; a listener that only saw future notices
      // would reliably miss this one.
      const late = collectNotices();
      expect(late.some(n => n.kind === 'no-opfs')).toBe(true);
    });
  });

  it('announces once, not per call', async () => {
    await withoutOpfs(async () => {
      const notices = collectNotices();
      await putBlob('a'.repeat(64), bytes('x'));
      await putBlob('b'.repeat(64), bytes('y'));
      await getBlobUrl('a'.repeat(64));
      expect(notices.filter(n => n.kind === 'no-opfs')).toHaveLength(1);
    });
  });
});
