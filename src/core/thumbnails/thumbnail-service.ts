// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ThumbnailService — the viewer's single owner of preview generation
 * (plan-372 §2.7, Phase 5).
 *
 * ## Why this moved out of the Layout Planner
 *
 * Preview rendering used to be private to the planner plugin: it owned the
 * renderer, the cache and the queue, and `_enqueueMissingPreviews()` swept
 * *every* catalog entry without a picture into that queue on every store
 * change. Two things were wrong with it.
 *
 * 1. **Ownership.** The Projects dashboard shows the same assets and needs the
 *    same previews, but it must work with the planner plugin absent. A service
 *    on the viewer is reachable from both; a plugin private is not.
 * 2. **Eagerness.** Sweeping the whole catalog is the opposite of what a large
 *    library needs — it decodes and renders hundreds of GLBs the user never
 *    scrolls to. Work is now *pulled* by whoever can see a card (§2.8), not
 *    pushed by the store.
 *
 * ## Contracts that are not negotiable
 *
 * - **Concurrency 1.** {@link ThumbnailRenderer} manipulates the shared
 *   renderer's render target and clear alpha and restores them afterwards
 *   (`thumbnail-renderer.ts` `render()`); it is *not* re-entrant. Two
 *   concurrent renders would interleave those swaps and leak a wrong render
 *   target back into the main scene. One job at a time, always. Formally this
 *   queue only serialises *its own* jobs; the direct callers outside it
 *   (`rv-asset-library-save.ts`, `DocumentCard`'s `renderNow`) are safe purely
 *   because `render()` is synchronous and therefore cannot interleave.
 * - **WebGPU is permanently unavailable, never retried.** The renderer needs
 *   `WebGLRenderTarget` + synchronous `readRenderTargetPixels`, neither of
 *   which exists under a `WebGPURenderer` (plan-271). On such a viewer the
 *   service reports unavailable, resolves every request with `null` and keeps
 *   the queue empty. A retry loop would burn a frame forever for a capability
 *   that cannot appear later in the session.
 * - **Callers get `null`, not an exception.** A missing preview is a normal
 *   outcome (WebGPU, decode failure, disposed mid-flight). Cards fall back to
 *   their icon; nothing about a preview is worth breaking a render over.
 */

import type { Object3D, Scene, WebGLRenderer } from 'three';
import { ThumbnailRenderer } from './thumbnail-renderer';
import { ThumbnailCache } from './thumbnail-cache';

/** How a job is loaded. Called only when the cache misses. */
export type ThumbnailLoader = () => Promise<Object3D>;

export interface ThumbnailServiceOptions {
  /** The viewer's renderer. Ignored when `isWebGPU` is true. */
  renderer: WebGLRenderer;
  /** The live main scene — the renderer mirrors its lighting. */
  scene: Scene;
  /** True on either WebGPU backend (`viewer.isWebGPU`). Disables the service. */
  isWebGPU?: boolean;
  /** Injectable for tests; defaults to the shared versioned bucket. */
  cache?: ThumbnailCache;
  /** Square edge length of the generated PNG. Defaults to 512 (plan-712). */
  size?: number;
}

interface QueuedJob {
  key: string;
  load: ThumbnailLoader;
  priority: number;
  /** Monotonic tie-breaker so equal priorities stay FIFO. */
  seq: number;
  resolve(blob: Blob | null): void;
}

export class ThumbnailService {
  private readonly _renderer: WebGLRenderer;
  private readonly _scene: Scene;
  private readonly _cache: ThumbnailCache;
  private readonly _size: number;
  private readonly _unavailable: boolean;

  private _thumbRenderer: ThumbnailRenderer | null = null;
  private _queue: QueuedJob[] = [];
  /** De-dupes by key: a second enqueue for a pending key joins the first job. */
  private _pending = new Map<string, Promise<Blob | null>>();
  private _running = false;
  private _disposed = false;
  private _seq = 0;

  constructor(opts: ThumbnailServiceOptions) {
    this._renderer = opts.renderer;
    this._scene = opts.scene;
    this._cache = opts.cache ?? new ThumbnailCache();
    this._size = opts.size ?? 512;
    this._unavailable = opts.isWebGPU === true;
  }

  /** False on a WebGPU viewer — callers can hide "generate preview" affordances. */
  get isAvailable(): boolean {
    return !this._unavailable && !this._disposed;
  }

  /**
   * Request the preview for `key`, loading the model only on a cache miss.
   *
   * Resolves with the PNG blob, or `null` when no preview could be produced
   * (unavailable renderer, load/render failure, cancelled, disposed). Enqueuing
   * the same key twice returns the same in-flight promise rather than rendering
   * it twice.
   *
   * @param key      stable key from `buildThumbnailKey()`
   * @param load     loads the model; called at most once, only on a cache miss
   * @param priority higher runs first; equal priorities keep insertion order
   */
  enqueue(key: string, load: ThumbnailLoader, priority = 0): Promise<Blob | null> {
    if (!this.isAvailable) return Promise.resolve(null);

    const existing = this._pending.get(key);
    if (existing) return existing;

    const promise = new Promise<Blob | null>((resolve) => {
      this._queue.push({ key, load, priority, seq: this._seq++, resolve });
    });
    this._pending.set(key, promise);
    void this._drain();
    return promise;
  }

  /**
   * Drop the CACHED preview for `key` so the next `enqueue` re-renders from
   * fresh bytes — the save-path invalidation. Deliberately not a `cancel`: an
   * in-flight job may still land its (pre-save) result, which the next
   * enqueue then replaces; racing a save against a render is rare enough that
   * one extra render beats a hard-abort pathway.
   */
  forget(key: string): void {
    this._pending.delete(key);
    void this._cache.delete(key);
  }

  /**
   * Drop a queued request. Per §2.8 this is a de-prioritisation, not a hard
   * abort: a job that already started keeps running (its result still lands in
   * the cache, so scrolling back is instant), only a job still waiting is
   * removed and resolved with `null`.
   */
  cancel(key: string): void {
    const idx = this._queue.findIndex(j => j.key === key);
    if (idx === -1) return;             // not queued: either running or unknown
    const [job] = this._queue.splice(idx, 1);
    this._pending.delete(key);
    job.resolve(null);
  }

  /**
   * Render one model immediately, bypassing both queue and cache.
   *
   * This is the "regenerate this preview now" button: the user asked for a
   * fresh picture, so serving the cached one would be wrong. Sharing the
   * service's renderer keeps the single-instance rule; `render()` being
   * synchronous means this can never interleave with a queued job.
   *
   * Returns `null` on a WebGPU viewer or after dispose.
   */
  renderNow(model: Object3D, size?: number): string | null {
    if (!this.isAvailable) return null;
    return this._render(model, size);
  }

  /**
   * Render the LIVE scene (no clone, no dispose) immediately — the hero card's
   * "picture of what is open right now".
   *
   * NEVER use `renderNow` for the live model root: its clone/dispose cycle is
   * O(model) and destroys resources shared with the live scene (see
   * `ThumbnailRenderer.renderLive`). Being synchronous on the one shared
   * renderer, this cannot interleave with a queued job — same rule as
   * `renderNow`.
   *
   * Returns `null` on a WebGPU viewer, after dispose, or when the subtree has
   * no mesh content.
   */
  renderLiveNow(root: Object3D, size?: number): string | null {
    if (!this.isAvailable) return null;
    if (!this._thumbRenderer) {
      this._thumbRenderer = new ThumbnailRenderer(this._renderer, this._scene);
    }
    return this._thumbRenderer.renderLive(root, size ?? this._size);
  }

  /** Drop every queued request and release the renderer. Idempotent. */
  dispose(): void {
    this._disposed = true;
    const queued = this._queue;
    this._queue = [];
    this._pending.clear();
    for (const job of queued) job.resolve(null);
    this._thumbRenderer?.dispose();
    this._thumbRenderer = null;
  }

  /** Highest priority first, insertion order within a priority. */
  private _takeNext(): QueuedJob | undefined {
    if (this._queue.length === 0) return undefined;
    let best = 0;
    for (let i = 1; i < this._queue.length; i++) {
      const a = this._queue[i];
      const b = this._queue[best];
      if (a.priority > b.priority || (a.priority === b.priority && a.seq < b.seq)) best = i;
    }
    return this._queue.splice(best, 1)[0];
  }

  /**
   * Run the queue, strictly one job at a time, yielding a frame between renders
   * so the live simulation and the UI stay responsive on large libraries.
   */
  private async _drain(): Promise<void> {
    if (this._running) return;
    this._running = true;
    try {
      for (;;) {
        if (this._disposed) break;
        const job = this._takeNext();
        if (!job) break;

        let result: Blob | null = null;
        try {
          result = await this._run(job);
        } catch (e) {
          // A failed preview is not an error worth propagating — the card
          // falls back to its icon and the manual button stays available.
          console.warn('[ThumbnailService] preview failed for', job.key, e);
          result = null;
        } finally {
          this._pending.delete(job.key);
          job.resolve(result);
        }

        // Yield a frame between renders to avoid jank.
        if (!this._disposed && this._queue.length > 0) {
          await new Promise<void>(r => requestAnimationFrame(() => r()));
        }
      }
    } finally {
      this._running = false;
    }
  }

  /** Cache lookup, then load + render + persist. */
  private async _run(job: QueuedJob): Promise<Blob | null> {
    const cached = await this._cache.get(job.key);
    if (this._disposed) return null;
    if (cached) {
      // The cache hands out an object URL; the service's contract is a blob.
      try {
        const blob = await (await fetch(cached)).blob();
        return blob;
      } finally {
        URL.revokeObjectURL(cached);
      }
    }

    const model = await job.load();
    if (this._disposed) return null;

    const dataUrl = this._render(model);
    if (!dataUrl) return null;          // WebGPU skip — treated as "no preview"

    const blob = await (await fetch(dataUrl)).blob();
    // Best-effort persistence; a full quota must not fail the request.
    await this._cache.put(job.key, blob);
    return blob;
  }

  /** Lazily build the renderer (needs a live GL context) and render one model. */
  private _render(model: Object3D, size = this._size): string | null {
    if (!this._thumbRenderer) {
      this._thumbRenderer = new ThumbnailRenderer(this._renderer, this._scene);
    }
    // The renderer clones internally, so the caller's model is never touched —
    // important, because `load()` usually hands back a *shared, cached* model.
    return this._thumbRenderer.render(model, size);
  }
}
