// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-371 T17 — semantics of `ModelCache._inflight` (§2.10).
 *
 * `_decoded` only ever holds FINISHED results, so two overlapping loads of the
 * same url used to decode it twice — precisely what the hover prefetch creates.
 * The in-flight map fixes that, but only if three rules hold; each of them,
 * broken, produces a silent bug rather than a crash:
 *
 *   1. a REJECTED decode must be evicted, or every later caller (retry
 *      included) is handed the same stale failure forever;
 *   2. one consumer's `AbortSignal` must not tear down the shared decode;
 *   3. `invalidate()` must drop an in-flight decode, or it lands afterwards and
 *      re-installs exactly the tree that was just evicted.
 *
 * These run against the REAL `ModelCache` with a mocked loader (precedent:
 * `rv-layout-model-cache.test.ts`). A hand-rolled stand-in would only ever
 * confirm its own logic.
 *
 * `blob:` urls are used throughout: `getOrLoad` passes those straight to the
 * loader, so no `fetch` mock is needed and the module-level `RVAssetBlobCache`
 * singleton cannot leak state between cases.
 */
import { describe, it, expect, vi } from 'vitest';
import { Group, Mesh, BoxGeometry, MeshBasicMaterial } from 'three';
import { ModelCache } from '../src/plugins/layout-planner/model-cache';

const URL_A = 'blob:rv-test/inflight-a';

interface Deferred {
  resolve(): void;
  reject(err: unknown): void;
}

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
    /** Release the oldest outstanding load. */
    settle(err?: unknown) {
      const next = pending.shift();
      if (!next) throw new Error('no outstanding load to settle');
      if (err) next.reject(err); else next.resolve();
    },
    outstanding: () => pending.length,
  };
}

/** Let queued microtasks run. */
async function flush(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

describe('plan-371 §2.10 — ModelCache in-flight decode map', () => {
  // ── The dedup itself ──────────────────────────────────────────────────
  it('T17a: two overlapping loads of one url share a single decode', async () => {
    const ctl = makeControllableLoader();
    const cache = new ModelCache(ctl.loader as never);

    const a = cache.getOrLoad(URL_A);
    const b = cache.getOrLoad(URL_A);
    expect(ctl.loadAsync).toHaveBeenCalledTimes(1);

    ctl.settle();
    const [ra, rb] = await Promise.all([a, b]);

    // Shared DECODE, independent clones — callers must never alias.
    expect(ra).not.toBe(rb);
    expect(ctl.loadAsync).toHaveBeenCalledTimes(1);
  });

  it('T17b: prefetch warms the same promise the real load then joins', async () => {
    const ctl = makeControllableLoader();
    const cache = new ModelCache(ctl.loader as never);

    cache.prefetch(URL_A);
    expect(ctl.loadAsync).toHaveBeenCalledTimes(1);

    const real = cache.getOrLoad(URL_A);
    expect(ctl.loadAsync).toHaveBeenCalledTimes(1); // joined, not restarted

    ctl.settle();
    expect(await real).toBeDefined();
  });

  it('T17c: prefetching an already-decoded url does nothing', async () => {
    const ctl = makeControllableLoader();
    const cache = new ModelCache(ctl.loader as never);

    const first = cache.getOrLoad(URL_A);
    ctl.settle();
    await first;

    cache.prefetch(URL_A);
    expect(ctl.loadAsync).toHaveBeenCalledTimes(1);
  });

  // ── RULE 1 ────────────────────────────────────────────────────────────
  it('T17d: evicts a failed decode from _inflight so a retry can succeed', async () => {
    const ctl = makeControllableLoader();
    const cache = new ModelCache(ctl.loader as never);

    const failing = cache.getOrLoad(URL_A);
    ctl.settle(new Error('boom'));
    await expect(failing).rejects.toThrow('boom');
    await flush();

    // Without the settle-handler eviction this second call would be handed the
    // very same rejected promise — F7 "retry" could then never recover.
    const retry = cache.getOrLoad(URL_A);
    ctl.settle();
    await expect(retry).resolves.toBeDefined();
    expect(ctl.loadAsync).toHaveBeenCalledTimes(2);
  });

  it('T17e: a decode whose only consumer aborted does not raise unhandled rejection', async () => {
    const ctl = makeControllableLoader();
    const cache = new ModelCache(ctl.loader as never);
    const controller = new AbortController();

    const consumer = cache.getOrLoad(URL_A, { signal: controller.signal });
    controller.abort();
    await expect(consumer).rejects.toThrow();

    // Nobody is listening to the shared decode any more; failing it must be a
    // non-event, not a global unhandled rejection.
    ctl.settle(new Error('late failure'));
    await flush();

    // And the map recovered: the next ask starts a genuinely new decode.
    const next = cache.getOrLoad(URL_A);
    ctl.settle();
    await expect(next).resolves.toBeDefined();
  });

  // ── RULE 2 ────────────────────────────────────────────────────────────
  it('T17f: one consumer cannot abort a decode another consumer is awaiting', async () => {
    const ctl = makeControllableLoader();
    const cache = new ModelCache(ctl.loader as never);
    const controller = new AbortController();

    const aborted = cache.getOrLoad(URL_A, { signal: controller.signal });
    const survivor = cache.getOrLoad(URL_A);

    controller.abort();
    await expect(aborted).rejects.toThrow();

    ctl.settle();
    // The shared work ran to completion for everybody else — the same bug class
    // as H5 (blob-fetch dedup), one layer higher.
    await expect(survivor).resolves.toBeDefined();
    expect(ctl.loadAsync).toHaveBeenCalledTimes(1);
  });

  it('T17g: an already-aborted signal rejects without starting any work', async () => {
    const ctl = makeControllableLoader();
    const cache = new ModelCache(ctl.loader as never);
    const controller = new AbortController();
    controller.abort();

    await expect(cache.getOrLoad(URL_A, { signal: controller.signal })).rejects.toThrow();
    expect(ctl.loadAsync).not.toHaveBeenCalled();
  });

  // ── RULE 3 ────────────────────────────────────────────────────────────
  it('T17h: invalidate() drops an in-flight decode so it cannot re-install itself', async () => {
    const ctl = makeControllableLoader();
    const cache = new ModelCache(ctl.loader as never);

    const first = cache.getOrLoad(URL_A);
    cache.invalidate(URL_A);
    ctl.settle();
    await first;

    // The invalidated decode must not be served to the next caller — a re-saved
    // library asset would otherwise keep coming back in its pre-save shape.
    const second = cache.getOrLoad(URL_A);
    expect(ctl.loadAsync).toHaveBeenCalledTimes(2);
    ctl.settle();
    await expect(second).resolves.toBeDefined();
  });
});
