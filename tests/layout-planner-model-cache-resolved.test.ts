// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-723 §9.2 — `ModelCache.getOrLoadResolved`.
 *
 * The trap this file exists for is not a crash. `resolveAsset()` hands out a
 * FRESH `blob:` URL on every call, so a naive implementation that cached under
 * that URL would work perfectly and simply never hit the cache again: one
 * backend read and one full decode per placement, silently, forever. Half of
 * these cases therefore assert on the RESOLVE COUNT rather than on a result.
 *
 * The other half is the release obligation. `revokeUrl` must be called in the
 * success path, in the failure-after-resolve path and after an abort — but
 * never when the resolve itself threw, because then no handle was ever issued.
 *
 * Mirrors `tests/layout-planner-inflight-decode.test.ts`: a controllable
 * `loadAsync` and `blob:` URLs, so `RVAssetBlobCache` pass-throughs and no
 * `fetch` mock is needed.
 */
import { describe, it, expect, vi } from 'vitest';
import { Group, Mesh, BoxGeometry, MeshBasicMaterial } from 'three';

import { ModelCache, resolvedCacheKey, RESOLVED_KEY_PREFIX } from '../src/plugins/layout-planner/model-cache';

const BLOB_URL = 'blob:rv-test/resolved-a';
const KEY = resolvedCacheKey('project', 'proj-1', 'project:library/Belt.glb');

interface Deferred { resolve(): void; reject(err: unknown): void }

function makeScene(): { scene: Group } {
  const group = new Group();
  group.name = 'Root';
  group.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));
  return { scene: group };
}

/** A loader whose every call hangs until the test releases it. */
function makeControllableLoader() {
  const pending: Deferred[] = [];
  const loadAsync = vi.fn(
    () => new Promise<{ scene: Group }>((resolve, reject) => {
      pending.push({ resolve: () => resolve(makeScene()), reject });
    }),
  );
  return {
    loader: { loadAsync },
    loadAsync,
    settle(err?: unknown) {
      const next = pending.shift();
      if (!next) throw new Error('no outstanding load to settle');
      if (err) next.reject(err); else next.resolve();
    },
    outstanding: () => pending.length,
  };
}

/** A loader that resolves immediately — for the cache-hit assertions. */
function makeInstantLoader() {
  const loadAsync = vi.fn(async () => makeScene());
  return { loader: { loadAsync }, loadAsync };
}

/** A `resolveAsset` stand-in that counts its calls and its revokes. */
function makeResolver(opts?: { throwOnResolve?: boolean; withRevoke?: boolean }) {
  const state = { resolves: 0, revokes: 0 };
  const resolve = vi.fn(async () => {
    state.resolves++;
    if (opts?.throwOnResolve) throw new Error('resolve exploded');
    return opts?.withRevoke === false
      ? { url: BLOB_URL }
      : { url: BLOB_URL, revokeUrl: () => { state.revokes++; } };
  });
  return { resolve, state };
}

async function flush(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

describe('plan-723 §9.2 — ModelCache.getOrLoadResolved', () => {
  it('resolves once per cache key and revokes the URL after a successful load', async () => {
    const ctl = makeInstantLoader();
    const cache = new ModelCache(ctl.loader as never);
    const { resolve, state } = makeResolver();

    const model = await cache.getOrLoadResolved(KEY, resolve);

    expect(model).toBeInstanceOf(Group);
    expect(state.resolves).toBe(1);
    expect(state.revokes).toBe(1);
  });

  it('revokes the URL when the load fails AFTER resolve', async () => {
    const ctl = makeControllableLoader();
    const cache = new ModelCache(ctl.loader as never);
    const { resolve, state } = makeResolver();

    const failing = cache.getOrLoadResolved(KEY, resolve);
    await flush();
    ctl.settle(new Error('decode boom'));

    await expect(failing).rejects.toThrow('decode boom');
    expect(state.resolves).toBe(1);
    expect(state.revokes).toBe(1);
  });

  it('does NOT attempt a revoke when resolve() itself throws (no handle exists)', async () => {
    const ctl = makeControllableLoader();
    const cache = new ModelCache(ctl.loader as never);
    const { resolve, state } = makeResolver({ throwOnResolve: true });

    await expect(cache.getOrLoadResolved(KEY, resolve)).rejects.toThrow('resolve exploded');

    expect(state.resolves).toBe(1);
    expect(state.revokes).toBe(0);
    // Nothing was ever handed to the loader either.
    expect(ctl.loadAsync).not.toHaveBeenCalled();
  });

  it('revokes and completes the underlying work when the consumer aborts via signal', async () => {
    const ctl = makeControllableLoader();
    const cache = new ModelCache(ctl.loader as never);
    const { resolve, state } = makeResolver();
    const controller = new AbortController();

    const consumer = cache.getOrLoadResolved(KEY, resolve, { signal: controller.signal });
    await flush();
    controller.abort();
    await expect(consumer).rejects.toThrow();

    // `detachOnAbort` detaches the CONSUMER, never the work: the shared decode
    // runs to completion, fills the cache and releases the handle.
    ctl.settle();
    await flush();
    expect(state.revokes).toBe(1);

    const later = await cache.getOrLoadResolved(KEY, resolve);
    expect(later).toBeInstanceOf(Group);
    expect(state.resolves).toBe(1);   // the abandoned work still populated the cache
  });

  it('never collides with URL-keyed entries (resolved: namespace prefix)', async () => {
    const ctl = makeInstantLoader();
    const cache = new ModelCache(ctl.loader as never);
    const { resolve } = makeResolver();

    expect(KEY.startsWith(RESOLVED_KEY_PREFIX)).toBe(true);

    await cache.getOrLoadResolved(KEY, resolve);
    // The SAME blob url, asked for the plain way, is a different cache entry.
    await cache.getOrLoad(BLOB_URL);

    expect(ctl.loadAsync).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(2);
  });

  it('caches under the stable cacheKey: a second call hits the cache and does NOT call resolve() again', async () => {
    const ctl = makeInstantLoader();
    const cache = new ModelCache(ctl.loader as never);
    const { resolve, state } = makeResolver();

    await cache.getOrLoadResolved(KEY, resolve);
    await cache.getOrLoadResolved(KEY, resolve);

    // THE regression this file was written for: a volatile-URL key would have
    // produced two resolves and two decodes here.
    expect(state.resolves).toBe(1);
    expect(state.revokes).toBe(1);
    expect(ctl.loadAsync).toHaveBeenCalledTimes(1);
  });

  it('dedups two overlapping calls for the same cacheKey into ONE resolve + ONE decode (inflight)', async () => {
    const ctl = makeControllableLoader();
    const cache = new ModelCache(ctl.loader as never);
    const { resolve, state } = makeResolver();

    const a = cache.getOrLoadResolved(KEY, resolve);
    const b = cache.getOrLoadResolved(KEY, resolve);
    await flush();

    expect(state.resolves).toBe(1);
    expect(ctl.loadAsync).toHaveBeenCalledTimes(1);

    ctl.settle();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).not.toBe(rb);              // shared decode, independent clones
    expect(state.revokes).toBe(1);
  });

  it('prefetchResolved warms the same promise the real load then joins', async () => {
    const ctl = makeControllableLoader();
    const cache = new ModelCache(ctl.loader as never);
    const { resolve, state } = makeResolver();

    cache.prefetchResolved(KEY, resolve);
    await flush();
    expect(ctl.loadAsync).toHaveBeenCalledTimes(1);

    const real = cache.getOrLoadResolved(KEY, resolve);
    await flush();
    expect(state.resolves).toBe(1);        // joined, not restarted

    ctl.settle();
    expect(await real).toBeInstanceOf(Group);
  });

  it('invalidate(cacheKey) evicts the resolved entry (epoch rule still applies)', async () => {
    const ctl = makeInstantLoader();
    const cache = new ModelCache(ctl.loader as never);
    const { resolve, state } = makeResolver();

    await cache.getOrLoadResolved(KEY, resolve);
    expect(cache.size).toBe(1);

    cache.invalidate(KEY);
    expect(cache.size).toBe(0);

    await cache.getOrLoadResolved(KEY, resolve);
    // A save-invalidated document is read from the backend again, not served
    // from the pre-save decode (plan-723 F10).
    expect(state.resolves).toBe(2);
    expect(ctl.loadAsync).toHaveBeenCalledTimes(2);
  });

  it('the plain getOrLoad(url) path stays behaviourally unchanged (cacheKey === url)', async () => {
    const ctl = makeControllableLoader();
    const cache = new ModelCache(ctl.loader as never);

    // Synchronously reaching the loader is part of the contract: the in-flight
    // dedup tests (plan-371 T17) observe it, and a `blob:` url has nothing to
    // wait for.
    const a = cache.getOrLoad(BLOB_URL);
    const b = cache.getOrLoad(BLOB_URL);
    expect(ctl.loadAsync).toHaveBeenCalledTimes(1);

    ctl.settle();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).not.toBe(rb);
    expect(ctl.loadAsync).toHaveBeenCalledTimes(1);
  });

  it('a resolver without revokeUrl is simply not released (nothing to release)', async () => {
    const ctl = makeInstantLoader();
    const cache = new ModelCache(ctl.loader as never);
    const { resolve, state } = makeResolver({ withRevoke: false });

    await expect(cache.getOrLoadResolved(KEY, resolve)).resolves.toBeInstanceOf(Group);
    expect(state.revokes).toBe(0);
  });
});
