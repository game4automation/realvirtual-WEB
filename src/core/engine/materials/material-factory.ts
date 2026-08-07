// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * material-factory — Renderer-aware material variant selection (plan-271).
 *
 * Every custom-shader site (uber material, MU dissolve, pipe flow, toon
 * recolor) will be routed through this factory so it can hand out either the
 * classic GLSL/onBeforeCompile variant (classic `WebGLRenderer`) or a TSL
 * NodeMaterial variant (`WebGPURenderer` — BOTH backends, including
 * `forceWebGL`). GLSL/`onBeforeCompile` is SILENTLY ignored under
 * `WebGPURenderer`, and TSL never runs under the classic `WebGLRenderer`
 * (three.js issue #30185) — there is no mixed mode within one renderer
 * instance.
 *
 * Design rules (plan-271 review findings 2 + 9):
 *  - The factory is SYNCHRONOUS. TSL modules are loaded once via
 *    `preloadTslMaterials()` (dynamic import — keeps `three/webgpu`/`three/tsl`
 *    out of the default bundle chunk) after `RVViewer.create()` and BEFORE the
 *    first `loadModel()` (pre-warm). Synchronous access afterwards goes through
 *    `getTslMaterials()`. Without a successful pre-warm the callers fall back
 *    to the F4 guard behavior (effect off + warning, vertexColors kept).
 *  - This directory NEVER imports `rv-viewer.ts` — the `MaterialContext` is
 *    passed down by the caller (circularity protection, enforced by
 *    tests/tsl-import-hygiene.node.test.ts).
 */

/** Which renderer `RVViewer.create()` actually constructed. */
export type RendererKind = 'webgl' | 'webgpu-gl' | 'webgpu';

export interface MaterialContext {
  kind: RendererKind;
  /** true for BOTH WebGPURenderer variants — there TSL MUST be used instead of
   *  GLSL. This is also the derivation of `viewer.isWebGPU` (plan-271 review
   *  core finding): isWebGPU := kind !== 'webgl' — NOT the real backend! */
  needsTSL: boolean;
  /** true ONLY on a real WebGPU backend (former `_detectWebGPU()` logic) —
   *  gate for `compute()`; also the source for `_gpuInfo`/ready-log diagnostics. */
  hasCompute: boolean;
}

/** Build a consistent MaterialContext from the renderer kind.
 *  Enforces the invariants: needsTSL := kind !== 'webgl';
 *  hasCompute only ever true on the real 'webgpu' backend. */
export function createMaterialContext(kind: RendererKind, hasCompute = false): MaterialContext {
  return {
    kind,
    needsTSL: kind !== 'webgl',
    hasCompute: kind === 'webgpu' && hasCompute,
  };
}

export type MaterialVariant = 'glsl' | 'tsl';

/** Select the material implementation family for the given context.
 *  'glsl' → classic WebGLRenderer path (ShaderMaterial / onBeforeCompile);
 *  'tsl'  → NodeMaterial path (WebGPURenderer, both backends). */
export function resolveMaterialVariant(ctx: MaterialContext): MaterialVariant {
  return ctx.needsTSL ? 'tsl' : 'glsl';
}

// ─── TSL module pre-warm (dynamic import, cached) ────────────────────────

/** Shape of the lazily loaded TSL materials — the flat merge of all four
 *  `*-tsl.ts` module namespaces (export names are unique across them).
 *  Type-only — the actual modules are ONLY ever loaded via the dynamic
 *  `import()` calls below so that `three/webgpu`/`three/tsl` never land in
 *  the default chunk. */
export type TslMaterialsModule =
  typeof import('./rv-uber-material-tsl') &
  typeof import('./rv-toon-materials-tsl') &
  typeof import('./rv-mu-dissolve-tsl') &
  typeof import('./rv-pipe-flow-tsl') &
  typeof import('./rv-post-processing-tsl') &
  typeof import('./rv-mu-compute-tsl');

let _tslModule: TslMaterialsModule | null = null;
let _tslPreload: Promise<void> | null = null;
let _warnedNotPreloaded = false;

/**
 * Pre-warm the TSL material modules. Call once after `RVViewer.create()` and
 * BEFORE the first `loadModel()` when `ctx.needsTSL` is true. No-op under the
 * classic 'webgl' kind. Never throws — a failed preload logs a warning and
 * leaves the F4 guard fallbacks active.
 */
export async function preloadTslMaterials(ctx: MaterialContext): Promise<void> {
  if (!ctx.needsTSL) return; // classic WebGL: GLSL variants, nothing to load
  if (_tslModule) return;
  if (!_tslPreload) {
    _tslPreload = Promise.all([
      import('./rv-uber-material-tsl'),
      import('./rv-toon-materials-tsl'),
      import('./rv-mu-dissolve-tsl'),
      import('./rv-pipe-flow-tsl'),
      import('./rv-post-processing-tsl'),
      import('./rv-mu-compute-tsl'),
    ])
      .then(([uber, toon, dissolve, pipeFlow, post, muCompute]) => {
        _tslModule = { ...uber, ...toon, ...dissolve, ...pipeFlow, ...post, ...muCompute };
      })
      .catch((err) => {
        _tslPreload = null; // allow a later retry
        console.warn('[material-factory] TSL material preload failed — F4 guard fallbacks stay active:', err);
      });
  }
  await _tslPreload;
}

/** True once `preloadTslMaterials()` completed successfully. */
export function isTslPreloaded(): boolean {
  return _tslModule !== null;
}

/**
 * Synchronous access to the cached TSL materials module. Returns `null` (and
 * warns once) when the pre-warm has not run/completed — callers must then use
 * their F4 guard fallback (keep `vertexColors: true` + base color).
 */
export function getTslMaterials(): TslMaterialsModule | null {
  if (!_tslModule && !_warnedNotPreloaded) {
    _warnedNotPreloaded = true;
    console.warn('[material-factory] TSL materials requested before preloadTslMaterials() completed — using GLSL-guard fallback.');
  }
  return _tslModule;
}

/** Test-only: reset the module cache + warn-once flags. */
export function __resetTslMaterialCacheForTests(): void {
  _tslModule = null;
  _tslPreload = null;
  _warnedNotPreloaded = false;
}
