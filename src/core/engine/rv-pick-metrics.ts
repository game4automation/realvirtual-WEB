// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * PickMetrics — always-on timing instrumentation for the pick path:
 * raycast (pick-structure traversal) → hit resolution → highlight apply.
 *
 * Fed by RaycastManager (per-pick raycast/resolve timings, split by target
 * category) and RVHighlightManager (highlight-apply timing + strategy).
 * Snapshots are polled by the DevTools "Picking & Highlight" section via
 * `RVViewer.getPickMetrics()`.
 *
 * Cost: a handful of `performance.now()` calls per pick. Picks are throttled
 * to 50 ms (RaycastManager THROTTLE_MS), so this is always-on — no flag.
 *
 * EMA smoothing (α = 0.2 ≈ ~10-sample horizon at the 20 Hz pick rate) keeps
 * the displayed values readable; the raw last sample is kept alongside so
 * spikes (e.g. first-hover EdgesGeometry builds, or the editor's native-fallback
 * raycasts before its async BVH lands) stay visible. The plan-756 gate is a p95,
 * not an average, so a percentile ring sits next to the EMA.
 */

/** Which rendering strategy the highlight manager used for the last apply. */
export type HighlightStrategy =
  | 'outline'        // OutlinePass silhouette on rendered meshes (incl. chunk-outline proxies)
  | 'chunk-overlay'  // pooled window proxies over the baked chunk geometry (fill, no edges)
  | 'overlay'        // per-mesh fill + EdgesGeometry overlay pair on source meshes
  | 'bbox'           // bounding-box wireframe fallback (> maxHoverMeshes)
  | 'mu-overlay'     // instanced MU overlay
  | 'none';

export interface PickMetricsSnapshot {
  /** EMA of total intersect time per pick (ms). */
  raycastMs: number;
  /** EMA of intersect time against the primary backend (instance pick index) (ms). */
  raycastStaticMs: number;
  /** EMA of intersect time against the chunk pick backend (ms). */
  raycastKinematicMs: number;
  /** EMA of intersect time against MU InstancedMeshes + aux gizmo targets (ms). */
  raycastOtherMs: number;
  /** EMA of the hit-resolution loop (exclude filters, window binary search, gates) (ms). */
  resolveMs: number;
  /** EMA of highlight apply (ms). */
  highlightMs: number;
  /** Raw last raycast sample (ms) — spike visibility. */
  lastRaycastMs: number;
  /** Raw last highlight-apply sample (ms) — spike visibility. */
  lastHighlightMs: number;
  /** Strategy used by the last highlight apply. */
  strategy: HighlightStrategy;
  /** True when the last apply DOWNGRADED from the mode's desired visual
   *  (outline→overlay capability fallback, or the bbox mesh-budget cap). */
  strategyFallback: boolean;
  /** Number of picks (raycasts) since the last reset. */
  raycastCount: number;
  /** Number of picks that resolved to a node since the last reset. */
  hitCount: number;
  /**
   * p95 of the per-ray raycast time in ms (plan-756 NFR gate: ≤ 1 ms).
   *
   * Computed on read over a ring of the last {@link RAY_RING} samples. The
   * samples are BATCHED (plan §2.4a.6): `performance.now()` resolves 0.1 ms, so
   * one pick of a 0.03 ms ray would quantise to 0 or 0.1 — several picks are
   * summed and divided before a sample is pushed.
   */
  raycastP95Ms: number;
  /** Samples currently in the p95 ring (0 = no number yet). */
  raycastP95Samples: number;
  /** Per-mesh pick geometries of the EDITOR instance index still without a BVH
   *  (native-fallback window). 0 = all BVHs ready. Baked chunks never appear
   *  here — their pick structure exists before the scene is shown (plan F1). */
  bvhPending: number;
  /** Live highlight overlay/proxy objects currently in the scene. */
  overlayObjects: number;
}

const EMA_ALPHA = 0.2;

/** Samples kept for the p95 (plan-756 P6: "ring of the last 512 samples"). */
export const RAY_RING = 512;

/**
 * A batch is flushed into the ring once it is long enough to be measurable
 * (`performance.now()` resolves 0.1 ms) or once it has enough picks that a
 * hover session produces samples at all.
 */
const BATCH_MIN_MS = 1;
const BATCH_MAX_PICKS = 16;

/**
 * Percentile over a fixed ring of the most recent samples. Sorting happens on
 * READ (DevTools polls at 5 Hz), never on the pick path.
 */
class Percentile {
  private readonly ring = new Float64Array(RAY_RING);
  private write = 0;
  private count = 0;
  private readonly scratch = new Float64Array(RAY_RING);

  push(sample: number): void {
    this.ring[this.write] = sample;
    this.write = (this.write + 1) % RAY_RING;
    if (this.count < RAY_RING) this.count++;
  }

  get samples(): number {
    return this.count;
  }

  /** `q` in [0,1]; 0 when nothing was recorded yet. */
  quantile(q: number): number {
    if (this.count === 0) return 0;
    const view = this.scratch.subarray(0, this.count);
    view.set(this.ring.subarray(0, this.count));
    view.sort();
    const i = Math.min(this.count - 1, Math.max(0, Math.ceil(q * this.count) - 1));
    return view[i];
  }

  reset(): void {
    this.write = 0;
    this.count = 0;
  }
}

/** Exponential moving average with unset-until-first-sample semantics. */
class Ema {
  private v: number | null = null;
  push(sample: number): void {
    this.v = this.v === null ? sample : this.v + EMA_ALPHA * (sample - this.v);
  }
  get value(): number {
    return this.v ?? 0;
  }
  reset(): void {
    this.v = null;
  }
}

export class PickMetrics {
  private readonly raycast = new Ema();
  private readonly raycastStatic = new Ema();
  private readonly raycastKinematic = new Ema();
  private readonly raycastOther = new Ema();
  private readonly resolve = new Ema();
  private readonly highlight = new Ema();
  private lastRaycast = 0;
  private lastHighlight = 0;
  private strategy: HighlightStrategy = 'none';
  private strategyFallback = false;
  private raycastCount = 0;
  private hitCount = 0;
  private bvhPending = 0;
  private overlayObjects = 0;
  private readonly raycastP95 = new Percentile();
  private batchMs = 0;
  private batchPicks = 0;

  /** Record one pick's intersect timings (total + per target category). */
  recordRaycast(totalMs: number, staticMs: number, kinematicMs: number, otherMs: number, hit: boolean): void {
    this.raycast.push(totalMs);
    this.batchMs += totalMs;
    this.batchPicks++;
    if (this.batchMs >= BATCH_MIN_MS || this.batchPicks >= BATCH_MAX_PICKS) {
      this.raycastP95.push(this.batchMs / this.batchPicks);
      this.batchMs = 0;
      this.batchPicks = 0;
    }
    this.raycastStatic.push(staticMs);
    this.raycastKinematic.push(kinematicMs);
    this.raycastOther.push(otherMs);
    this.lastRaycast = totalMs;
    this.raycastCount++;
    if (hit) this.hitCount++;
  }

  /** Record the hit-resolution loop duration for one pick. */
  recordResolve(ms: number): void {
    this.resolve.push(ms);
  }

  /** Record one highlight apply: duration, strategy taken, live overlay object
   *  count, and whether the apply fell back from the desired visual. */
  recordHighlight(ms: number, strategy: HighlightStrategy, overlayObjects: number, fallback = false): void {
    this.highlight.push(ms);
    this.lastHighlight = ms;
    this.strategy = strategy;
    this.strategyFallback = fallback;
    this.overlayObjects = overlayObjects;
  }

  /** Number of merged pick geometries still awaiting their async BVH build. */
  setBvhPending(n: number): void {
    this.bvhPending = n;
  }

  /** Reset all series and counters (model load/clear). */
  reset(): void {
    this.raycast.reset();
    this.raycastStatic.reset();
    this.raycastKinematic.reset();
    this.raycastOther.reset();
    this.resolve.reset();
    this.highlight.reset();
    this.lastRaycast = 0;
    this.lastHighlight = 0;
    this.strategy = 'none';
    this.strategyFallback = false;
    this.raycastCount = 0;
    this.hitCount = 0;
    this.bvhPending = 0;
    this.overlayObjects = 0;
    this.raycastP95.reset();
    this.batchMs = 0;
    this.batchPicks = 0;
  }

  snapshot(): PickMetricsSnapshot {
    return {
      raycastMs: this.raycast.value,
      raycastStaticMs: this.raycastStatic.value,
      raycastKinematicMs: this.raycastKinematic.value,
      raycastOtherMs: this.raycastOther.value,
      resolveMs: this.resolve.value,
      highlightMs: this.highlight.value,
      lastRaycastMs: this.lastRaycast,
      lastHighlightMs: this.lastHighlight,
      strategy: this.strategy,
      strategyFallback: this.strategyFallback,
      raycastCount: this.raycastCount,
      hitCount: this.hitCount,
      raycastP95Ms: this.raycastP95.quantile(0.95),
      raycastP95Samples: this.raycastP95.samples,
      bvhPending: this.bvhPending,
      overlayObjects: this.overlayObjects,
    };
  }
}
