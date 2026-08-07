// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * PickMetrics — always-on timing instrumentation for the pick path:
 * raycast (BVH traversal) → hit resolution → highlight apply.
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
 * spikes (e.g. first-hover EdgesGeometry builds, native-fallback raycasts
 * before the async BVH lands) stay visible.
 */

/** Which rendering strategy the highlight manager used for the last apply. */
export type HighlightStrategy =
  | 'outline'        // OutlinePass silhouette on rendered meshes
  | 'fill-proxy'     // zero-build fill/edge proxies over the merged pick geometry
  | 'overlay-legacy' // per-mesh fill + EdgesGeometry overlay pair
  | 'bbox'           // bounding-box wireframe fallback (> maxHoverMeshes)
  | 'mu-overlay'     // instanced MU overlay
  | 'none';

export interface PickMetricsSnapshot {
  /** EMA of total intersect time per pick (ms). */
  raycastMs: number;
  /** EMA of intersect time against the static merged BVH mesh (ms). */
  raycastStaticMs: number;
  /** EMA of summed intersect time against per-drive kinematic BVH meshes (ms). */
  raycastKinematicMs: number;
  /** EMA of intersect time against MU InstancedMeshes + aux gizmo targets (ms). */
  raycastOtherMs: number;
  /** EMA of the hit-resolution loop (exclude filters, face-range binary search, gates) (ms). */
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
  /** Merged pick geometries still without a BVH (native-fallback window). 0 = all BVHs ready. */
  bvhPending: number;
  /** Live highlight overlay/proxy objects currently in the scene. */
  overlayObjects: number;
}

const EMA_ALPHA = 0.2;

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

  /** Record one pick's intersect timings (total + per target category). */
  recordRaycast(totalMs: number, staticMs: number, kinematicMs: number, otherMs: number, hit: boolean): void {
    this.raycast.push(totalMs);
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
      bvhPending: this.bvhPending,
      overlayObjects: this.overlayObjects,
    };
  }
}
