// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-pipe-flow-tsl — TSL variant of the animated pipe flow rings
 * (plan-271 Phase 2, port #4).
 *
 * Parity target: the `MeshBasicMaterial` + `onBeforeCompile` ring patch in
 * rv-pipe-flow.ts — propagating ring bands along the pipe UV.x (path meters):
 *   `t = fract(uv.x * ringDensity - uTime * uFlowSpeed)`
 *   `ring = smoothstep(0, .05, t) * (1 - smoothstep(w, w+.05, t))`
 *   alpha = baseOpacity × ring, discard below 0.01.
 *
 * TIME BASE (plan-271 NFR / review finding 5 — MANDATORY): the `uTime`
 * uniform is fed EXCLUSIVELY from `PipeFlowManager.update(dt)` (the
 * SimulationLoop dt accumulator). NEVER import the wall-clock `time` node
 * from three/tsl here — it would keep scrolling through pause and break
 * WebGL/TSL determinism parity. Enforced by tsl-import-hygiene.node.test.ts.
 *
 * Import hygiene: only 'three/webgpu' / 'three/tsl'; loaded exclusively via
 * the dynamic import in material-factory.ts.
 */

import { MeshBasicNodeMaterial, FrontSide } from 'three/webgpu';
import type { Material } from 'three/webgpu';
import { Discard, Fn, fract, materialOpacity, smoothstep, uniform, uv } from 'three/tsl';

/** Minimal structural handle for a TSL uniform — the manager only writes `.value`. */
export interface TslUniformNumberHandle { value: number }

export interface PipeFlowTslHandles {
  /** Node material for the ring overlay (MeshBasicNodeMaterial — `.color`
   *  stays writable, so setRingColor()/resetAllRingColors() keep working). */
  material: Material;
  /** Simulation time (s) — write `PipeFlowManager._time` here from update(dt). */
  uTime: TslUniformNumberHandle;
  /** Signed scroll speed (m/s) — same convention as the GLSL uFlowSpeed. */
  uFlowSpeed: TslUniformNumberHandle;
}

/**
 * Create the TSL ring-overlay material for one pipe. Per-pipe uniforms
 * (uTime/uFlowSpeed) mirror the per-entry GLSL shader uniforms — the manager
 * drives them from its dt accumulator.
 */
export function createPipeFlowMaterialTsl(
  color: number,
  baseOpacity: number,
  ringDensity: number,
  ringWidth: number,
): PipeFlowTslHandles {
  const uTime = uniform(0);
  const uFlowSpeed = uniform(0);

  const mat = new MeshBasicNodeMaterial({
    color,
    transparent: true,
    opacity: baseOpacity,
    side: FrontSide,
    depthTest: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4,
  });

  // Animated ring pattern along UV.x — exact GLSL formula.
  const pathPos = uv().x.mul(ringDensity).sub(uTime.mul(uFlowSpeed));
  const t = fract(pathPos);
  const ring = smoothstep(0.0, 0.05, t)
    .mul(smoothstep(ringWidth, ringWidth + 0.05, t).oneMinus());

  mat.opacityNode = Fn(() => {
    const alpha = materialOpacity.mul(ring);
    Discard(alpha.lessThan(0.01));
    return alpha;
  })();

  return { material: mat, uTime, uFlowSpeed };
}
