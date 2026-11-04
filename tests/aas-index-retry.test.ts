// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * A failed AASX index read is not cached for the session: a cold first load of a
 * large model let the 10 s index timeout expire and every AAS link then stayed on
 * `index-error` until the cache was cleared by hand (Festo hosted deploy).
 * Only a successful read is cached; a failure schedules ONE automatic retry
 * after a backoff, and any later read fetches again.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Object3D } from 'three';
import {
  INDEX_RETRY_DELAY_MS,
  ProjectAasSource,
  lookupAas,
  resetAasSources,
  subscribeAasSources,
  urlAasSourceFor,
  type AasProjectBackend,
  type AasSource,
} from '../src/core/aas/rv-aas-source';
import { beginAasLoadGeneration, currentAasLoadGeneration, resetAasResolution, resolveAasSubtree } from '../src/plugins/aas-resolution';
import { getAasResolution } from '../src/plugins/aas-resolution-mark';

const AAS_ID = 'urn:festo:cylinder-0001';
const INDEX_JSON = JSON.stringify({ [AAS_ID]: { file: 'festo.aasx', idShort: 'Cylinder' } });

/** `fetch` that times out for the first `failures` index calls, then serves the index. */
function flakyIndexFetch(failures: number): { calls: () => number } {
  let n = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.endsWith('index.json')) return new Response(null, { status: 404 });
    n++;
    if (n <= failures) throw new DOMException('The operation timed out.', 'TimeoutError');
    return new Response(INDEX_JSON, { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return { calls: () => n };
}

/** A scene with one AAS-linked node. */
function linkedScene(): { root: Object3D; node: Object3D } {
  const root = new Object3D();
  const node = new Object3D();
  node.userData._rvAasLink = { aasId: AAS_ID };
  root.add(node);
  return { root, node };
}

/** What `installAasResolution` does on a source change: classify the scene again. */
function rewireResolution(root: Object3D, src: AasSource): () => void {
  return subscribeAasSources(() => { void resolveAasSubtree(root, src, currentAasLoadGeneration()); });
}

beforeEach(() => {
  resetAasSources();
  resetAasResolution();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  resetAasSources();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('AASX index: a failed read is not cached', () => {
  it('URL source: first fetch times out -> automatic retry resolves the links', async () => {
    const fetches = flakyIndexFetch(1);
    const src = urlAasSourceFor('https://web.realvirtual.io/festo/aasx/');
    const { root, node } = linkedScene();
    const off = rewireResolution(root, src);

    await resolveAasSubtree(root, src, beginAasLoadGeneration());
    expect(getAasResolution(node)).toBe('index-error');
    expect(fetches.calls()).toBe(1);

    // The one automatic retry after the backoff re-runs the resolution pass.
    const revision = src.revision;
    await vi.advanceTimersByTimeAsync(INDEX_RETRY_DELAY_MS);
    expect(src.revision).toBe(revision + 1);
    await vi.waitFor(() => expect(getAasResolution(node)).toBe('resolved'));
    expect(fetches.calls()).toBe(2);
    expect((await lookupAas(src, AAS_ID))?.entry.file).toBe('festo.aasx');

    // A success IS cached: no further fetch.
    await src.readIndex();
    expect(fetches.calls()).toBe(2);
    off();
  });

  it('a later read retries even after the automatic retry failed too', async () => {
    const fetches = flakyIndexFetch(2);
    const src = urlAasSourceFor('https://cdn.example/aasx/');
    let notified = 0;
    const off = subscribeAasSources(() => { notified++; });

    expect((await src.readIndex()).kind).toBe('error');
    await vi.advanceTimersByTimeAsync(INDEX_RETRY_DELAY_MS);
    expect(notified).toBe(1);
    expect((await src.readIndex()).kind).toBe('error');

    // Only ONE automatic retry per failure streak ...
    await vi.advanceTimersByTimeAsync(INDEX_RETRY_DELAY_MS * 4);
    expect(notified).toBe(1);
    // ... but the failure is still not cached: the next resolve reads again.
    const third = await src.readIndex();
    expect(third.kind === 'available' && third.index[AAS_ID]?.file).toBe('festo.aasx');
    expect(fetches.calls()).toBe(3);
    off();
  });

  it('project source (hosted deploy URL): a timed-out index read is retried', async () => {
    const fetches = flakyIndexFetch(1);
    const backend: AasProjectBackend = {
      kind: 'bundled',
      id: 'bundled:festo',
      readDocumentUrl: async (ref) => ({ url: `https://cdn.example/festo/p/${typeof ref === 'string' ? ref : ref.path}`, release: () => {} }),
    };
    const src = new ProjectAasSource(backend, 'festo');
    expect((await src.readIndex()).kind).toBe('error');
    const again = await src.readIndex();
    expect(again.kind === 'available' && again.index[AAS_ID]?.file).toBe('festo.aasx');
    expect(fetches.calls()).toBe(2);
  });

  it('an invalidate cancels a pending automatic retry', async () => {
    flakyIndexFetch(1);
    const src = urlAasSourceFor('https://cdn.example/x/aasx/');
    let notified = 0;
    const off = subscribeAasSources(() => { notified++; });
    expect((await src.readIndex()).kind).toBe('error');
    src.invalidate();
    await vi.advanceTimersByTimeAsync(INDEX_RETRY_DELAY_MS);
    expect(notified).toBe(0);
    off();
  });
});
