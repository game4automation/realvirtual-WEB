// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * MU clip effects — a small "sci-fi burn" stripe (noisy edge + blue glow band)
 * spliced into the standard material shader via `onBeforeCompile`.
 *
 * Two flavours share the clone/patch plumbing:
 *  • `createMUDissolve` — VANISH: progress-driven, clips world-Y from the bottom
 *    up just before an end-of-line MU is deleted. The MU is stationary, so the
 *    edge is swept by an explicit `setProgress(0→1)`.
 *  • `createMUGrow` — SPAWN: the mirror effect when an MU is created at a Source.
 *    It is DISTANCE / VECTOR based, NOT timed: a clip plane is anchored in WORLD
 *    space at the MU's leading edge at spawn, oriented across its (horizontal)
 *    move direction. Fragments BEHIND the plane are discarded, so the MU starts
 *    fully clipped and physically slides out of it as it travels — leading edge
 *    first, the glow stripe staying on the plane (i.e. travelling back toward the
 *    source relative to the MU). A stopped belt simply freezes the MU mid-emerge.
 *
 * Implementation: per-MU, each `Mesh`'s material is CLONED (clone MUs share their
 * materials by reference with the spawn template, so we must never mutate the
 * original). `dispose()` restores the originals and frees the clones; it is safe
 * to call on completion OR to cancel an in-progress effect.
 */

import { Color, Vector3 } from 'three';
import type { Object3D, Mesh, Material, IUniform } from 'three';
import { getTslMaterials } from './materials/material-factory';

/** Tunables — single-line tweaks for the look of the burn. */
const BURN_COLOR = new Color(0.25, 0.6, 1.0); //!< sci-fi blue
const GLOW_BAND_M = 0.03;                      //!< thickness (m) of the glowing edge
const GLOW_STRENGTH = 2.5;                     //!< emissive boost at the burn line
const NOISE_SCALE = 5.5;                       //!< lower = bigger (coarser) noise cells
const NOISE_AMP_M = 0.05;                      //!< jitter (m) of the edge

const VERTEX_VARYING = 'varying vec3 vDissolveWorld;';
const VERTEX_ASSIGN = 'vDissolveWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;';
const DHASH = 'float dHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }';

// Module-local warn-once flag (repo convention — no external warnOnce util).
// Since plan-271 Phase 2 this only fires as a FALLBACK: when the renderer is
// a WebGPURenderer but the TSL material module was not pre-warmed (see
// preloadTslMaterials in material-factory.ts) — the TSL variant in
// materials/rv-mu-dissolve-tsl.ts otherwise carries the effect.
let _warnedWebGPU = false;
function warnDissolveWebGPUOnce(): void {
  if (_warnedWebGPU) return;
  _warnedWebGPU = true;
  console.warn(
    '[MUDissolve] WebGPU renderer active but the TSL material module is not ' +
    'preloaded — the GLSL onBeforeCompile clip/burn effect is disabled ' +
    'because onBeforeCompile is silently ignored under WebGPURenderer. ' +
    'MUs appear/disappear without the dissolve effect.',
  );
}

/**
 * Splice a clip shader (given header + body GLSL) into every `Mesh` under `node`
 * and return a `dispose()` that restores the originals. `cacheKey` keeps each
 * variant's program compiled once and reused. `uniforms` is shared across all of
 * this MU's clones so a single update drives the whole object.
 */
function installClip(
  node: Object3D,
  uniforms: Record<string, IUniform>,
  cacheKey: string,
  fragHeader: string,
  fragBody: string,
  isWebGPU = false,
): () => void {
  // WebGPU guard (plan-271 PR#0): onBeforeCompile GLSL patches are silently
  // ignored under WebGPURenderer — skip the material clone/patch entirely.
  // The MU simply appears/vanishes without the burn effect (accepted).
  if (isWebGPU) {
    warnDissolveWebGPUOnce();
    return (): void => { /* nothing installed — nothing to restore */ };
  }

  const restore: Array<{ mesh: Mesh; original: Material | Material[] }> = [];
  const clones: Material[] = [];

  const patch = (mat: Material): Material => {
    const clone = mat.clone();
    clone.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VERTEX_VARYING}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERTEX_ASSIGN}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${fragHeader}`)
        .replace('#include <opaque_fragment>', `#include <opaque_fragment>\n${fragBody}`);
    };
    // Constant key → the program compiles once and is reused for every MU using
    // this effect variant instead of recompiling per material instance.
    clone.customProgramCacheKey = () => cacheKey;
    clone.needsUpdate = true;
    return clone;
  };

  node.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh) return;
    const original = mesh.material;
    if (Array.isArray(original)) {
      const patched = original.map(patch);
      clones.push(...patched);
      mesh.material = patched;
    } else {
      const patched = patch(original);
      clones.push(patched);
      mesh.material = patched;
    }
    restore.push({ mesh, original });
  });

  let disposed = false;
  return (): void => {
    if (disposed) return;
    disposed = true;
    for (const { mesh, original } of restore) mesh.material = original;
    for (const c of clones) c.dispose();
    restore.length = 0;
    clones.length = 0;
  };
}

// ─────────────────────────────── VANISH ───────────────────────────────

const DISSOLVE_HEADER = `
uniform float uProgress;
uniform float uMinY;
uniform float uMaxY;
uniform float uBand;
uniform vec3  uColor;
uniform float uGlow;
uniform float uNoiseScale;
uniform float uNoiseAmp;
varying vec3 vDissolveWorld;
${DHASH}
`;

const DISSOLVE_BODY = `
{
  float edge = mix(uMinY - uBand, uMaxY + uBand, uProgress);
  edge += (dHash(vDissolveWorld.xz * uNoiseScale) - 0.5) * uNoiseAmp;
  if (vDissolveWorld.y < edge) discard;
  float glow = 1.0 - smoothstep(0.0, uBand, vDissolveWorld.y - edge);
  gl_FragColor.rgb += uColor * glow * uGlow;
}
`;

export interface MUDissolve {
  /** Set burn progress 0 (intact) → 1 (fully dissolved). */
  setProgress(p: number): void;
  /** Restore original materials and dispose the cloned ones. Idempotent. */
  dispose(): void;
}

/**
 * VANISH effect. `minY`/`maxY` are the MU's world-space vertical bounds — the
 * burn edge sweeps from just below `minY` to just above `maxY` as progress goes
 * 0 → 1 (bottom-to-top). The MU is stationary, so the clip is absolute world-Y.
 */
export function createMUDissolve(
  node: Object3D,
  minY: number,
  maxY: number,
  isWebGPU = false,
): MUDissolve {
  // WebGPURenderer (both backends): the pre-warmed TSL variant carries the
  // effect (plan-271 Phase 2). Without pre-warm → F4 guard fallback (warn
  // once, MU vanishes without the burn effect).
  if (isWebGPU) {
    const tsl = getTslMaterials();
    if (tsl) return tsl.createMUDissolveTsl(node, minY, maxY);
    warnDissolveWebGPUOnce();
    return { setProgress(): void { /* effect off */ }, dispose(): void { /* nothing installed */ } };
  }

  const uniforms = {
    uProgress: { value: 0 },
    uMinY: { value: minY },
    uMaxY: { value: maxY },
    uBand: { value: GLOW_BAND_M },
    uColor: { value: BURN_COLOR.clone() },
    uGlow: { value: GLOW_STRENGTH },
    uNoiseScale: { value: NOISE_SCALE },
    uNoiseAmp: { value: NOISE_AMP_M },
  };
  const dispose = installClip(node, uniforms, 'muDissolve', DISSOLVE_HEADER, DISSOLVE_BODY, isWebGPU);
  return {
    setProgress(p: number): void {
      uniforms.uProgress.value = p < 0 ? 0 : p > 1 ? 1 : p;
    },
    dispose,
  };
}

// ──────────────────────────────── GROW ────────────────────────────────

const GROW_HEADER = `
uniform vec3  uAxis;
uniform vec3  uPlane;
uniform float uBand;
uniform vec3  uColor;
uniform float uGlow;
uniform float uNoiseScale;
uniform float uNoiseAmp;
varying vec3 vDissolveWorld;
${DHASH}
`;

// Signed distance from the (fixed, world-space) spawn plane along the move axis.
// Behind the plane (still inside the source) → discard. The plane is static, so
// the effect is driven entirely by the MU's transform as it travels.
const GROW_BODY = `
{
  float coord = dot(vDissolveWorld - uPlane, uAxis);
  float edge = (dHash(vDissolveWorld.xz * uNoiseScale) - 0.5) * uNoiseAmp;
  if (coord < edge) discard;
  float glow = 1.0 - smoothstep(0.0, uBand, coord - edge);
  gl_FragColor.rgb += uColor * glow * uGlow;
}
`;

export interface MUGrow {
  /**
   * Re-evaluate against the MU's current world position. Returns whether the MU
   * has fully emerged (caller should `dispose()` then) and whether it moved since
   * the last call (caller keeps the renderer awake while it moves). The shader
   * itself needs no per-frame update — the clip plane is fixed in world.
   */
  update(nodeWorldPos: Vector3): { finished: boolean; moved: boolean };
  /** Restore original materials and dispose the cloned ones. Idempotent. */
  dispose(): void;
}

/**
 * GROW (spawn) effect. The clip plane is anchored in WORLD space at the MU's
 * leading edge at spawn (`planePoint`), across the horizontal unit move direction
 * `axis`. The MU starts fully clipped and emerges, leading edge first, as it
 * travels along `axis`. `trailingRel` is the MU's trailing-edge coordinate along
 * `axis` measured from the node origin (so completion can be detected once the
 * trailing edge clears the plane).
 */
export function createMUGrow(
  node: Object3D,
  axis: Vector3,
  planePoint: Vector3,
  trailingRel: number,
  isWebGPU = false,
): MUGrow {
  // Material install: TSL variant under WebGPURenderer (plan-271 Phase 2),
  // GLSL onBeforeCompile patch on the classic WebGLRenderer. The CPU-side
  // completion tracking below is renderer-independent (the clip plane is
  // fixed in world space — no per-frame shader update either way).
  let dispose: () => void;
  if (isWebGPU) {
    const tsl = getTslMaterials();
    if (tsl) {
      dispose = tsl.createMUGrowTsl(node, axis, planePoint);
    } else {
      warnDissolveWebGPUOnce();
      dispose = (): void => { /* nothing installed — nothing to restore */ };
    }
  } else {
    const uniforms = {
      uAxis: { value: axis.clone() },
      uPlane: { value: planePoint.clone() },
      uBand: { value: GLOW_BAND_M },
      uColor: { value: BURN_COLOR.clone() },
      uGlow: { value: GLOW_STRENGTH },
      uNoiseScale: { value: NOISE_SCALE },
      uNoiseAmp: { value: NOISE_AMP_M },
    };
    dispose = installClip(node, uniforms, 'muGrow', GROW_HEADER, GROW_BODY, false);
  }

  const planeRef = planePoint.clone();
  const axisRef = axis.clone();
  const _prev = new Vector3();
  let havePrev = false;

  return {
    update(nodeWorldPos: Vector3): { finished: boolean; moved: boolean } {
      // Trailing edge distance from the plane along the move axis: node-origin
      // distance + the trailing-edge offset captured at spawn. > band ⇒ the whole
      // MU has cleared the plane and is fully visible.
      const trailingCoord =
        (nodeWorldPos.x - planeRef.x) * axisRef.x +
        (nodeWorldPos.y - planeRef.y) * axisRef.y +
        (nodeWorldPos.z - planeRef.z) * axisRef.z +
        trailingRel;
      const finished = trailingCoord > GLOW_BAND_M;
      const moved = !havePrev || _prev.distanceToSquared(nodeWorldPos) > 1e-10;
      _prev.copy(nodeWorldPos);
      havePrev = true;
      return { finished, moved };
    },
    dispose,
  };
}
