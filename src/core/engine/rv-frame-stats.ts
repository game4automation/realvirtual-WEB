// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Per-pass draw-call / triangle accounting for one rendered frame.
 *
 * `renderer.info.render` is a running counter (`info.autoReset` is off in
 * the viewer, `info.reset()` runs once per frame). Read as one number after
 * the frame it is the SUM over every pass — scene RenderPass, shadow map,
 * AO gbuffer, outline mask/depth/edge passes, bloom, overlay, plugin
 * renders. That sum is what the DevTools tab used to show as "Draw Calls",
 * and it is why three placements of a five-mesh conveyor read as +60.
 *
 * This module splits the counter by measuring `info.render` DELTAS around
 * the individual passes:
 *  - composer passes are wrapped ONCE (idempotent marker on the pass) and
 *    attributed by pass class — RenderPass → `scene`, GTAO / N8AO → `ao`,
 *    OutlinePass → `outline`, everything else → `post`;
 *  - the shadow map is wrapped at `renderer.shadowMap.render` (an own
 *    property of the WebGLShadowMap, same trick as rv-perf-probe.ts). It
 *    renders INSIDE whichever `renderer.render` consumes `needsUpdate`
 *    (normally the RenderPass), so it is a NESTED pass: its delta is booked
 *    to `shadow` and taken OUT of the pass bucket that is running at that
 *    moment (see `addNestedDelta`);
 *  - the ground reflector (rv-ground-reflector.ts) re-renders the whole
 *    scene from a mirrored camera inside `Mesh.onBeforeRender`, which three
 *    fires in EVERY `renderer.render` whose render list contains the mirror
 *    mesh — the RenderPass, the GTAO normal / N8AO gbuffer renders and the
 *    OutlinePass depth pass (`scene.overrideMaterial` does not stop
 *    `onBeforeRender`). Those mirror renders are nested passes too: booked
 *    to `reflection`, subtracted from the running bucket. Without this the
 *    scene bucket reads ~2× the visible triangles as soon as the reflection
 *    is on;
 *  - overlay pass and plugin `onRender` are deltas the viewer takes around
 *    the calls;
 *  - `other` = `total` minus every attributed bucket (toon gbuffer prepass,
 *    isolate composition extras, anything not wrapped).
 *
 * The "running bucket" is module state (`activeBucket`) that the composer
 * pass wrappers set and restore around `pass.render`; when no wrapped pass
 * is running (direct `renderer.render` paths) a nested pass is taken out of
 * `scene`, which is where the viewer books those direct renders. Rendering
 * is synchronous and single-threaded, so one module-level slot is enough.
 * The reflector reaches the frame through `setActiveFrameStats` — the
 * viewer points it at its own `FrameStats` at the start of every rendered
 * frame and DETACHES (`null`) right after `finalizeFrameStats`, so the
 * reflector never imports the viewer and renders that happen OUTSIDE the
 * loop (MCP draw probes, thumbnail / agent-eye captures, screenshots) book
 * nothing — neither the reflector nor the shadow-map wrapper touches the
 * last closed frame.
 *
 * No allocation per frame: the buckets are mutated in place, and
 * `getRendererInfo().frame` hands out the same object every time.
 */

import type { Pass } from 'three/addons/postprocessing/Pass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';

export interface PassCounters {
  calls: number;
  triangles: number;
}

export type FrameStatsBucket = 'scene' | 'shadow' | 'reflection' | 'ao' | 'outline' | 'post' | 'overlay' | 'plugins' | 'other';

/** Buckets that render INSIDE another pass and are taken out of it. */
export type NestedBucket = 'shadow' | 'reflection';

export interface FrameStats {
  /** Everything the frame submitted (all passes). */
  total: PassCounters;
  /** The main scene render, WITHOUT the nested shadow-map / reflection renders. */
  scene: PassCounters;
  /** Shadow-map regeneration — 0 on frames where the cached map was reused. */
  shadow: PassCounters;
  /** Ground-reflector mirror renders (+ its blur quads) — every pass in
   *  which the mirror mesh was rendered re-renders the scene once. 0 when
   *  the reflection is off. */
  reflection: PassCounters;
  /** AO gbuffer (GTAO / N8AO). */
  ao: PassCounters;
  /** OutlinePass depth + mask + edge/blur quads. */
  outline: PassCounters;
  /** Bloom, output, toon sobel/saturation, isolate composition passes. */
  post: PassCounters;
  /** Highlight / measurement overlay layers pass. */
  overlay: PassCounters;
  /** Plugin `onRender` renders (splats, gizmo scenes, …). */
  plugins: PassCounters;
  /** `total` minus every bucket above. */
  other: PassCounters;
}

/**
 * The counter shape shared by `WebGLRenderer.info` and the WebGPU `Info`.
 *
 * They do NOT agree on the name: WebGL counts draw calls in `render.calls`,
 * the WebGPU `Info` in `render.drawCalls` (three PR #30359). Both fields are
 * therefore optional here, and nothing reads them directly — see
 * {@link drawCallsOf}.
 */
export interface RenderInfoLike {
  render: { calls?: number; drawCalls?: number; triangles: number };
}

/**
 * Draw calls of a renderer info object, whichever backend produced it
 * (plan-492 R7).
 *
 * The trap this closes: reading `render.calls` at the START of a pass and
 * something else at the end — or the other way round — silently yields a delta
 * of `end − 0` under WebGPU, i.e. every pass reporting the whole frame. Both
 * ends of every measurement go through this one function, in this module and
 * in `rv-viewer.ts`, so a backend can never be half-read.
 *
 * Allocation-free and monomorphic: it is called twice per pass per frame.
 */
export function drawCallsOf(info: RenderInfoLike): number {
  const r = info.render;
  // three/webgpu's Info carries BOTH: `calls` is the cumulative count of
  // `renderer.render()` invocations that `info.reset()` never clears, and
  // `drawCalls` the per-frame draw count (plan-763). WebGL has only `calls`,
  // which IS its per-frame draw count — so prefer `drawCalls` when present.
  return r.drawCalls ?? r.calls ?? 0;
}

const BUCKETS: readonly FrameStatsBucket[] = ['scene', 'shadow', 'reflection', 'ao', 'outline', 'post', 'overlay', 'plugins', 'other'];

export function createFrameStats(): FrameStats {
  return {
    total: { calls: 0, triangles: 0 },
    scene: { calls: 0, triangles: 0 },
    shadow: { calls: 0, triangles: 0 },
    reflection: { calls: 0, triangles: 0 },
    ao: { calls: 0, triangles: 0 },
    outline: { calls: 0, triangles: 0 },
    post: { calls: 0, triangles: 0 },
    overlay: { calls: 0, triangles: 0 },
    plugins: { calls: 0, triangles: 0 },
    other: { calls: 0, triangles: 0 },
  };
}

/** Zero every bucket (call right after `info.reset()`). */
export function resetFrameStats(frame: FrameStats): void {
  frame.total.calls = 0; frame.total.triangles = 0;
  for (const b of BUCKETS) { frame[b].calls = 0; frame[b].triangles = 0; }
}

/** Add `info.render − (c0, t0)` to `bucket`. */
export function addDelta(target: PassCounters, info: RenderInfoLike, c0: number, t0: number): void {
  target.calls += drawCallsOf(info) - c0;
  target.triangles += info.render.triangles - t0;
}

// ─── Running-bucket / active-frame slots ───────────────────────────────

let activeBucket: FrameStatsBucket | null = null;
let activeFrame: FrameStats | null = null;

/**
 * Point nested-pass instrumentation that cannot reach the viewer (the ground
 * reflector's `onBeforeRender`) at the frame being rendered. The viewer calls
 * this at the start of every rendered frame; `null` detaches.
 */
export function setActiveFrameStats(frame: FrameStats | null): void {
  activeFrame = frame;
}

/** The frame `setActiveFrameStats` last installed, or null. */
export function getActiveFrameStats(): FrameStats | null {
  return activeFrame;
}

/** The bucket of the wrapped composer pass currently rendering, or null
 *  outside any wrapped pass (direct `renderer.render` paths → `scene`). */
export function currentFrameStatsBucket(): FrameStatsBucket | null {
  return activeBucket;
}

/**
 * Book `info.render − (c0, t0)` to a NESTED bucket (`shadow` / `reflection`)
 * and take the same amount out of the pass that is running right now — the
 * enclosing pass wrapper will add its full delta (which includes this nested
 * render) afterwards, so the enclosing bucket nets out to its own draws.
 * With no wrapped pass running the host is `scene` (the direct-render paths
 * book their delta there).
 *
 * Outside a frame (no wrapped pass running AND no active frame) nothing is
 * booked: the viewer detaches the frame right after `finalizeFrameStats`,
 * so a render between frames (MCP draw probes, offscreen captures) must not
 * mutate the last closed frame. The callers already guard on the active
 * frame; this is the defensive backstop and should never trigger.
 */
export function addNestedDelta(frame: FrameStats, bucket: NestedBucket, info: RenderInfoLike, c0: number, t0: number): void {
  if (activeBucket === null && activeFrame === null) return;
  const dc = drawCallsOf(info) - c0;
  const dt = info.render.triangles - t0;
  frame[bucket].calls += dc;
  frame[bucket].triangles += dt;
  const host = frame[activeBucket ?? 'scene'];
  host.calls -= dc;
  host.triangles -= dt;
}

/**
 * Close the frame: `total` = the running counter, `other` takes the
 * unattributed remainder. Nested passes (shadow, reflection) were already
 * taken out of their host bucket by `addNestedDelta`; the clamp only guards
 * against a nested render that fired outside any booked pass.
 */
export function finalizeFrameStats(frame: FrameStats, info: RenderInfoLike): void {
  frame.total.calls = drawCallsOf(info);
  frame.total.triangles = info.render.triangles;
  for (const b of BUCKETS) {
    if (frame[b].calls < 0) frame[b].calls = 0;
    if (frame[b].triangles < 0) frame[b].triangles = 0;
  }
  let c = frame.total.calls;
  let t = frame.total.triangles;
  for (const b of BUCKETS) {
    if (b === 'other') continue;
    c -= frame[b].calls;
    t -= frame[b].triangles;
  }
  frame.other.calls = Math.max(0, c);
  frame.other.triangles = Math.max(0, t);
}

// ─── Pass instrumentation ──────────────────────────────────────────────

const PASS_MARK = '__rvFrameStatsBucket';

type MarkedPass = Pass & { [PASS_MARK]?: FrameStatsBucket };

/** Attribute a composer pass to a bucket by its class. `aoPasses` names the
 *  AO passes (N8AO is dynamically imported, so it cannot be `instanceof`-ed). */
export function classifyPass(pass: Pass, aoPasses: ReadonlyArray<Pass | null>): FrameStatsBucket {
  if (pass instanceof RenderPass) return 'scene';
  if (pass instanceof OutlinePass) return 'outline';
  if (aoPasses.includes(pass)) return 'ao';
  return 'post';
}

/**
 * Wrap `pass.render` once so its draw-call / triangle delta lands in the
 * frame bucket named by `classifyPass`. Idempotent: a wrapped pass carries
 * its bucket as an own property and is skipped. Meant to be called right
 * before `composer.render()` — the pass list changes over time (OutlinePass
 * on first selection, N8AO after its dynamic import, toon sobel), and a
 * per-frame scan over ≤ 10 passes is a handful of property reads.
 */
export function instrumentComposerPasses(
  passes: ReadonlyArray<Pass>,
  info: RenderInfoLike,
  frame: FrameStats,
  aoPasses: ReadonlyArray<Pass | null>,
): void {
  for (let i = 0; i < passes.length; i++) {
    const pass = passes[i] as MarkedPass;
    if (pass[PASS_MARK]) continue;
    const bucket = classifyPass(pass, aoPasses);
    pass[PASS_MARK] = bucket;
    const orig = pass.render;
    const target = frame[bucket];
    pass.render = function (this: Pass, ...args: Parameters<Pass['render']>) {
      const c0 = drawCallsOf(info);
      const t0 = info.render.triangles;
      const prevBucket = activeBucket;
      activeBucket = bucket;
      try {
        return orig.apply(this, args);
      } finally {
        activeBucket = prevBucket;
        addDelta(target, info, c0, t0);
      }
    } as Pass['render'];
  }
}

/** Bucket a pass was attributed to, or undefined when it is not wrapped. */
export function passBucketOf(pass: Pass): FrameStatsBucket | undefined {
  return (pass as MarkedPass)[PASS_MARK];
}

/** Run `fn` with `bucket` as the active nesting host (restored afterwards). */
export function withActiveBucket<T>(bucket: FrameStatsBucket, fn: () => T): T {
  const prev = activeBucket;
  activeBucket = bucket;
  try {
    return fn();
  } finally {
    activeBucket = prev;
  }
}

/** A TSL pass node of the post pipeline and the bucket it books into (plan-763). */
export interface TslPassLike {
  node: { updateBefore(frame: unknown): unknown } & { __rvFrameStatsBucket?: FrameStatsBucket };
  bucket: FrameStatsBucket;
}

/**
 * Per-pass accounting for the TSL post pipeline (plan-763 Phase 4) — the
 * `instrumentComposerPasses` of the WebGPURenderer paths.
 *
 * Every pass node (scene pass, GTAO, outline nodes, bloom, overlay pass)
 * renders inside its `updateBefore`, which three calls once per frame before
 * the output quad. The wrapper books the node's delta into its bucket and
 * SUBTRACTS it from the bucket that was active around the whole pipeline
 * render (the viewer books the pipeline as `post`), so the sum of all buckets
 * stays equal to the frame total and the output quad is what remains in
 * `post`. Nested passes inside a pass (the floor mirror inside the scene
 * pass) see their host through `activeBucket` exactly like the composer path.
 *
 * Idempotent per node (marker property); the pipeline calls this hook at the
 * END of every graph build, so no frame renders between build and wrap.
 */
export function instrumentTslPasses(
  passes: ReadonlyArray<TslPassLike>,
  info: RenderInfoLike,
  frame: FrameStats,
): void {
  for (const { node, bucket } of passes) {
    if (node.__rvFrameStatsBucket) continue;
    node.__rvFrameStatsBucket = bucket;
    const orig = node.updateBefore;
    node.updateBefore = function (this: TslPassLike['node'], f: unknown): unknown {
      const c0 = drawCallsOf(info);
      const t0 = info.render.triangles;
      const host = activeBucket;
      activeBucket = bucket;
      try {
        return orig.call(this, f);
      } finally {
        activeBucket = host;
        if (activeFrame === frame) {
          const dc = drawCallsOf(info) - c0;
          const dt = info.render.triangles - t0;
          frame[bucket].calls += dc;
          frame[bucket].triangles += dt;
          if (host && host !== bucket) {
            frame[host].calls -= dc;
            frame[host].triangles -= dt;
          }
        }
      }
    };
  }
}

const SHADOW_MARK = '__rvFrameStatsShadow';

export interface ShadowMapLike {
  render: (...args: unknown[]) => void;
  __rvFrameStatsShadow?: true;
}

/**
 * Wrap `renderer.shadowMap.render` once so the shadow-map pass delta lands in
 * `frame.shadow` and is taken out of the pass it ran inside (the RenderPass
 * normally, but the toon gbuffer prepass or an AO render can be the first
 * `renderer.render` of the frame — whichever consumes `needsUpdate`).
 * `render` is an own property assigned inside WebGLShadowMap
 * (rv-perf-probe.ts relies on the same fact); the probe later wraps THIS
 * wrapper and restores it, which keeps both measurements intact.
 */
export function instrumentShadowMap(shadowMap: ShadowMapLike | undefined, info: RenderInfoLike, frame: FrameStats): void {
  if (!shadowMap || typeof shadowMap.render !== 'function' || shadowMap[SHADOW_MARK]) return;
  shadowMap[SHADOW_MARK] = true;
  const orig = shadowMap.render;
  shadowMap.render = function (this: ShadowMapLike, ...args: unknown[]) {
    const c0 = drawCallsOf(info);
    const t0 = info.render.triangles;
    try {
      return orig.apply(this, args);
    } finally {
      // Book only while THIS frame is the active one: a shadow update
      // triggered by an out-of-loop render (thumbnail, MCP probe) must not
      // land in the last closed frame.
      if (activeFrame === frame) addNestedDelta(frame, 'shadow', info, c0, t0);
    }
  };
}

// ─── Render-target census ──────────────────────────────────────────────

/**
 * Count the render targets owned by the composer and its passes (own
 * properties that are `WebGLRenderTarget`s or arrays of them — bloom keeps
 * its mip chain in two arrays), plus the shadow map, plus `extraTargets`
 * (the ground reflector's mirror + blur targets). O(passes × own props),
 * never O(scene). Used to explain `info.memory.textures`, which counts
 * every render-target texture as a texture.
 */
export function countRenderTargets(
  composer: { renderTarget1?: unknown; renderTarget2?: unknown; passes: ReadonlyArray<Pass> } | null,
  shadowMapTexture: unknown,
  extraTargets: ReadonlyArray<unknown> = [],
): number {
  let n = shadowMapTexture ? 1 : 0;
  for (const t of extraTargets) if (isRenderTarget(t)) n++;
  if (!composer) return n;
  if (isRenderTarget(composer.renderTarget1)) n++;
  if (isRenderTarget(composer.renderTarget2)) n++;
  for (const pass of composer.passes) {
    for (const key of Object.keys(pass)) {
      const v = (pass as unknown as Record<string, unknown>)[key];
      if (isRenderTarget(v)) n++;
      else if (Array.isArray(v)) {
        for (const e of v) if (isRenderTarget(e)) n++;
      }
    }
  }
  return n;
}

function isRenderTarget(v: unknown): boolean {
  return !!v && typeof v === 'object'
    && ((v as { isWebGLRenderTarget?: boolean }).isWebGLRenderTarget === true
      || (v as { isRenderTarget?: boolean }).isRenderTarget === true);
}
