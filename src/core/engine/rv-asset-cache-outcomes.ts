// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-asset-cache-outcomes.ts — what the asset blob cache did, per request (plan-508 F6).
 *
 * Every exit of `RVAssetBlobCache` records one outcome here: a verified hit, a
 * revalidation, a replacement, a download, an eviction, a rejected body, a hash
 * mismatch. The console lines stay; this ring is what `web_status.cache` and
 * the DevTools "Asset cache" table read, so "why is my library GLB old?" is
 * answered by looking instead of guessing.
 *
 * A ring of the last {@link CACHE_OUTCOME_CAP} records (array + shift — tiny
 * objects, only on the fetch path, never per frame) plus cumulative counters
 * per outcome since the last clear.
 */

/** One cache decision. */
export type CacheOutcome =
  | 'hit'           // served from the Cache API without a network round trip
  | 'offline-hit'   // revalidation unreachable — the cached bytes were served
  | 'revalidated'   // conditional GET answered 304 — cached bytes still current
  | 'replaced'      // conditional GET answered 200 — the newer file replaced the entry
  | 'miss'          // downloaded (and stored when a Cache API exists)
  | 'evicted'       // a stored entry failed the content check and was dropped
  | 'rejected'      // a network body failed the content check (nothing stored)
  | 'hash-mismatch';// downloaded bytes did not hash to the catalog sha256

/** All outcomes, in display order. */
export const CACHE_OUTCOMES: readonly CacheOutcome[] = [
  'hit', 'offline-hit', 'revalidated', 'replaced', 'miss', 'evicted', 'rejected', 'hash-mismatch',
];

/** One ring entry. `at` is `Date.now()`; `ms` the time the request took. */
export interface CacheOutcomeRecord {
  at: number;
  bucket: string;
  url: string;
  outcome: CacheOutcome;
  bytes?: number;
  ms?: number;
  detail?: string;
}

/** Ring capacity. */
export const CACHE_OUTCOME_CAP = 128;

const _ring: CacheOutcomeRecord[] = [];
const _counts = new Map<CacheOutcome, number>();
let _version = 0;
let _persisted: boolean | null = null;

/** Append one record (drops the oldest beyond the cap) and count it. */
export function recordCacheOutcome(record: Omit<CacheOutcomeRecord, 'at'> & { at?: number }): void {
  const entry: CacheOutcomeRecord = { at: record.at ?? Date.now(), bucket: record.bucket, url: record.url, outcome: record.outcome };
  if (record.bytes !== undefined) entry.bytes = record.bytes;
  if (record.ms !== undefined) entry.ms = Math.round(record.ms * 10) / 10;
  if (record.detail !== undefined) entry.detail = record.detail;
  _ring.push(entry);
  if (_ring.length > CACHE_OUTCOME_CAP) _ring.shift();
  _counts.set(entry.outcome, (_counts.get(entry.outcome) ?? 0) + 1);
  _version++;
}

/** Snapshot for `web_status.cache` / DevTools: the newest `last` records (oldest first), counters, total. */
export function getCacheOutcomes(opts?: { last?: number }): {
  outcomes: CacheOutcomeRecord[];
  counts: Record<CacheOutcome, number>;
  total: number;
  persisted: boolean | null;
} {
  const last = Math.max(0, Math.min(CACHE_OUTCOME_CAP, Math.floor(opts?.last ?? 20)));
  const counts = {} as Record<CacheOutcome, number>;
  let total = 0;
  for (const o of CACHE_OUTCOMES) {
    const n = _counts.get(o) ?? 0;
    counts[o] = n;
    total += n;
  }
  return {
    outcomes: last === 0 ? [] : _ring.slice(-last).map((r) => ({ ...r })),
    counts,
    total,
    persisted: _persisted,
  };
}

/** Changes whenever a record is added or the ring is cleared — a cheap poll key for the UI. */
export function cacheOutcomeVersion(): number {
  return _version;
}

/** Empty the ring and reset the counters ("Clear outcomes"). The `persisted` verdict is kept. */
export function clearCacheOutcomes(): void {
  _ring.length = 0;
  _counts.clear();
  _version++;
}

/** Remember the `navigator.storage.persist()` verdict (null = never asked). */
export function setCachePersisted(persisted: boolean | null): void {
  _persisted = persisted;
  _version++;
}

/** The `navigator.storage.persist()` verdict, null when it was never asked. */
export function getCachePersisted(): boolean | null {
  return _persisted;
}

/** `navigator.storage.estimate()` (usage / quota in bytes), null when the browser has none. */
export async function getCacheStorageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
    if (!storage?.estimate) return null;
    const e = await storage.estimate();
    return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
  } catch {
    return null;
  }
}
