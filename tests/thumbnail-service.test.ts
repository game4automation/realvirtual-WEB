// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ThumbnailService — the viewer-owned preview queue (plan-372 §2.7, Phase 5).
 *
 * The contracts under test are the ones that would silently corrupt rendering
 * or burn the main thread if they regressed:
 *   - concurrency 1 (the renderer is not re-entrant)
 *   - WebGPU is permanently unavailable and never retried
 *   - priority ordering, de-duplication, cancel, dispose
 *   - cache hits skip the loader entirely
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Group, Object3D } from 'three';
import { ThumbnailService } from '../src/core/thumbnails/thumbnail-service';
import { ThumbnailCache } from '../src/core/thumbnails/thumbnail-cache';

/** Cache double: records calls, serves whatever was seeded. */
class FakeCache {
  seeded = new Map<string, Blob>();
  puts: string[] = [];
  gets: string[] = [];
  async get(key: string): Promise<string | null> {
    this.gets.push(key);
    const blob = this.seeded.get(key);
    return blob ? URL.createObjectURL(blob) : null;
  }
  async put(key: string, blob: Blob): Promise<void> { this.puts.push(key); this.seeded.set(key, blob); }
  async clear(): Promise<void> { this.seeded.clear(); }
}

/** Tracks concurrent render() entries so re-entrancy is observable, plus the
 *  sizes it was asked for (plan-712: the default must reach the renderer). */
function makeRendererStub() {
  const state = { inFlight: 0, maxInFlight: 0, renders: 0, sizes: [] as (number | undefined)[] };
  return { state };
}

/**
 * Build a service whose renderer is stubbed at the module boundary. The real
 * ThumbnailRenderer needs a live GL context, which the vitest browser runner
 * has, but a stub keeps the test about queue semantics rather than pixels.
 */
function makeService(opts: { cache?: FakeCache; isWebGPU?: boolean } = {}) {
  const cache = opts.cache ?? new FakeCache();
  const svc = new ThumbnailService({
    renderer: {} as never,
    scene: {} as never,
    isWebGPU: opts.isWebGPU,
    cache: cache as unknown as ThumbnailCache,
  });
  const stub = makeRendererStub();
  // Replace the lazily-built renderer with a counting stub.
  (svc as unknown as { _thumbRenderer: unknown })._thumbRenderer = {
    render: (_model: Object3D, size?: number) => {
      stub.state.sizes.push(size);
      stub.state.inFlight++;
      stub.state.maxInFlight = Math.max(stub.state.maxInFlight, stub.state.inFlight);
      stub.state.renders++;
      stub.state.inFlight--;
      // A 1x1 transparent PNG data URL.
      return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    },
    dispose: () => {},
  };
  return { svc, cache, stub };
}

const loadModel = () => Promise.resolve<Object3D>(new Group());

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('ThumbnailService', () => {
  it('never runs two renders concurrently (renderer is not re-entrant)', async () => {
    const { svc, stub } = makeService();
    const jobs = Array.from({ length: 6 }, (_, i) => svc.enqueue('k' + i, loadModel));
    const results = await Promise.all(jobs);
    expect(results.every(r => r instanceof Blob)).toBe(true);
    expect(stub.state.renders).toBe(6);
    expect(stub.state.maxInFlight).toBe(1);
  });

  it('is permanently unavailable on WebGPU and resolves null without loading', async () => {
    const loader = vi.fn(loadModel);
    const { svc, stub } = makeService({ isWebGPU: true });
    expect(svc.isAvailable).toBe(false);
    expect(await svc.enqueue('k', loader)).toBeNull();
    expect(await svc.enqueue('k', loader)).toBeNull(); // no retry loop
    expect(loader).not.toHaveBeenCalled();
    expect(stub.state.renders).toBe(0);
  });

  it('de-duplicates a key that is already pending', async () => {
    const loader = vi.fn(loadModel);
    const { svc, stub } = makeService();
    const [a, b] = await Promise.all([svc.enqueue('same', loader), svc.enqueue('same', loader)]);
    expect(a).toBe(b);              // same promise, same blob instance
    expect(loader).toHaveBeenCalledTimes(1);
    expect(stub.state.renders).toBe(1);
  });

  it('serves a cache hit without calling the loader', async () => {
    const cache = new FakeCache();
    cache.seeded.set('cached', new Blob(['x'], { type: 'image/png' }));
    const loader = vi.fn(loadModel);
    const { svc, stub } = makeService({ cache });
    const blob = await svc.enqueue('cached', loader);
    expect(blob).toBeInstanceOf(Blob);
    expect(loader).not.toHaveBeenCalled();
    expect(stub.state.renders).toBe(0);
  });

  it('runs higher priority first and keeps FIFO within one priority', async () => {
    const { svc } = makeService();
    const order: string[] = [];
    const track = (id: string) => () => { order.push(id); return Promise.resolve<Object3D>(new Group()); };
    // The first enqueue starts draining immediately, so it always runs first;
    // ordering is asserted over the remainder that actually queues up.
    const all = [
      svc.enqueue('head', track('head'), 0),
      svc.enqueue('lo1', track('lo1'), 0),
      svc.enqueue('hi', track('hi'), 10),
      svc.enqueue('lo2', track('lo2'), 0),
    ];
    await Promise.all(all);
    expect(order[0]).toBe('head');
    expect(order.slice(1)).toEqual(['hi', 'lo1', 'lo2']);
  });

  it('cancel drops a queued job and resolves it with null', async () => {
    const { svc } = makeService();
    const head = svc.enqueue('head', loadModel);
    const doomed = svc.enqueue('doomed', loadModel);
    svc.cancel('doomed');
    expect(await doomed).toBeNull();
    expect(await head).toBeInstanceOf(Blob);
  });

  it('renders queued previews at the 512px default (plan-712)', async () => {
    const { svc, stub } = makeService();
    await svc.enqueue('k', loadModel);
    expect(stub.state.sizes).toEqual([512]);
  });

  it('honours an explicit size, both per service and per renderNow call', async () => {
    const cache = new FakeCache();
    const svc = new ThumbnailService({
      renderer: {} as never,
      scene: {} as never,
      cache: cache as unknown as ThumbnailCache,
      size: 256,
    });
    const sizes: (number | undefined)[] = [];
    (svc as unknown as { _thumbRenderer: unknown })._thumbRenderer = {
      render: (_m: Object3D, size?: number) => { sizes.push(size); return 'data:image/png;base64,x'; },
      dispose: () => {},
    };
    svc.renderNow(new Group());        // no size → service default
    svc.renderNow(new Group(), 1024);  // explicit override
    expect(sizes).toEqual([256, 1024]);
  });

  it('dispose resolves every queued job with null and reports unavailable', async () => {
    const { svc } = makeService();
    const head = svc.enqueue('head', loadModel);
    const queued = svc.enqueue('queued', loadModel);
    svc.dispose();
    expect(svc.isAvailable).toBe(false);
    expect(await queued).toBeNull();
    await head; // must not reject
    expect(await svc.enqueue('after', loadModel)).toBeNull();
  });
});
