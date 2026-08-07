// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * PipeFlowManager — Animated flow-direction rings on pipe meshes.
 *
 * Pipe meshes have their path distance encoded in UV.x (meters).
 * Creates an overlay per pipe with propagating ring bands using
 * MeshBasicMaterial + onBeforeCompile. Ring direction follows flowRate sign.
 *
 * One draw call per pipe. Animation via a shared time uniform.
 */

import {
  Object3D,
  Mesh,
  MeshBasicMaterial,
  Vector3,
  Box3,
  FrontSide,
  type Material,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { ISOLATE_FOCUS_LAYER } from './rv-group-registry';
import { traverseMeshes } from './rv-traverse-utils';
import { getTslMaterials } from './materials/material-factory';
import type { PipeFlowTslHandles } from './materials/rv-pipe-flow-tsl';

// ─── Config ─────────────────────────────────────────────────────────────

/** Default ring color (bright cyan) used when no per-pipe override is set. */
export const RING_COLOR = 0x44ccff;
/** Base opacity of the ring bands. */
const RING_OPACITY = 0.6;
/** Rings per meter of pipe length. */
const RING_DENSITY = 3.0;
/** Ring width as fraction of spacing (0–1, lower = thinner). */
const RING_WIDTH = 0.25;
/** UV scroll speed in meters/second. Uniform regardless of flow magnitude —
 *  only the SIGN of flowRate (and uvDirection) decides the direction. */
const FLOW_SCROLL_SPEED = 1.0;

// ─── Types ──────────────────────────────────────────────────────────────

interface PipeFlowEntry {
  node: Object3D;
  overlay: Mesh;
  shader: WebGLProgramParametersWithUniforms | null;
  /** TSL uniform handles (WebGPURenderer path, plan-271 Phase 2). The uTime
   *  uniform is fed EXCLUSIVELY from update(dt) — never wall-clock. */
  tsl: PipeFlowTslHandles | null;
  lastFlowRate: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function findPipeMesh(pipeNode: Object3D): Mesh | null {
  let best: Mesh | null = null;
  let bestVolume = 0;
  const tmpBox = new Box3();
  const tmpSize = new Vector3();

  traverseMeshes(pipeNode, (mesh) => {
    if (mesh.userData._pipeFlowViz) return;
    if (!mesh.geometry?.attributes?.position) return;

    tmpBox.setFromObject(mesh);
    tmpBox.getSize(tmpSize);
    const vol = tmpSize.x * tmpSize.y * tmpSize.z;
    if (vol > bestVolume) {
      bestVolume = vol;
      best = mesh;
    }
  });

  return best;
}

// ─── PipeFlowManager ────────────────────────────────────────────────────

// Module-local warn-once flag (repo convention — no external warnOnce util).
// Since plan-271 Phase 2 this only fires as a FALLBACK: when the renderer is
// a WebGPURenderer but the TSL material module was not pre-warmed (see
// preloadTslMaterials in material-factory.ts) — the TSL variant in
// materials/rv-pipe-flow-tsl.ts otherwise carries the animated rings.
let _warnedWebGPU = false;
function warnPipeFlowWebGPUOnce(): void {
  if (_warnedWebGPU) return;
  _warnedWebGPU = true;
  console.warn(
    '[PipeFlow] WebGPU renderer active but the TSL material module is not ' +
    'preloaded — the GLSL onBeforeCompile ring patch is disabled because ' +
    'onBeforeCompile is silently ignored under WebGPURenderer. Pipes keep a ' +
    'static semi-transparent overlay without animated flow rings.',
  );
}

export class PipeFlowManager {
  readonly entries: PipeFlowEntry[] = [];
  private _time = 0;
  private readonly _isWebGPU: boolean;

  constructor(pipeNodes: Object3D[], isWebGPU = false) {
    this._isWebGPU = isWebGPU;
    for (const node of pipeNodes) {
      this._createFlow(node);
    }

    if (this.entries.length > 0) {
      console.log(`[PipeFlow] Created flow overlay for ${this.entries.length} pipes`);
    }
  }

  /**
   * Advance animation and update flow rates.
   * Call from fixedUpdate with the simulation dt.
   * Returns true if anything changed (caller marks render dirty).
   */
  update(dt: number): boolean {
    this._time += dt;
    let hasActive = false;

    for (const entry of this.entries) {
      const rv = entry.node.userData._rvPipe as
        { flowRate: number } | undefined;
      if (!rv) continue;

      const flowRate = rv.flowRate ?? 0;
      const uvDirection = (rv as any).uvDirection ?? 1;
      const active = Math.abs(flowRate) > 0.001;

      // Uniform UV scroll speed — only the sign of flowRate (combined with
      // uvDirection) decides the direction. Magnitude is ignored so all
      // flowing pipes scroll at FLOW_SCROLL_SPEED m/s. When flow is zero the
      // overlay stays visible (static rings) so the viewer can still see the
      // pipe decoration; we just set scroll speed to zero.
      //
      // Sign convention: Unity PipelineController treats positive flowRate as
      // "fill source, drain destination" — so the visible fluid must appear
      // to move FROM destination TOWARD source. Our fragment shader uses
      // `fract(vPipeUv.x * density - uTime * uFlowSpeed)`, where positive
      // uFlowSpeed makes rings drift toward lower uv.x. To match the Unity
      // convention for rings flowing from destination→source, we negate the
      // direction before assigning.
      const direction = Math.sign(flowRate) * uvDirection;
      const flowSpeed = active ? -direction * FLOW_SCROLL_SPEED : 0;
      if (entry.shader) {
        entry.shader.uniforms.uTime.value = this._time;
        entry.shader.uniforms.uFlowSpeed.value = flowSpeed;
      } else if (entry.tsl) {
        // TSL path (plan-271 Phase 2): the SAME dt-accumulated time base —
        // NEVER the wall-clock `time` node (pause behaviour / determinism).
        entry.tsl.uTime.value = this._time;
        entry.tsl.uFlowSpeed.value = flowSpeed;
      }

      entry.overlay.visible = true; // always visible — zero flow shows static rings
      if (active) hasActive = true;
      entry.lastFlowRate = flowRate;
    }

    return hasActive; // animation still dirties frames only when something actually flows
  }

  dispose(): void {
    for (const entry of this.entries) {
      entry.overlay.parent?.remove(entry.overlay);
      (entry.overlay.material as Material).dispose();
    }
    this.entries.length = 0;
  }

  /**
   * Override the scrolling-ring color for a single pipe. Callers (e.g.
   * ProcessIndustryPlugin's fluid-coloring toggle) use this so the animated
   * rings match the fluid the pipe currently carries. Pass RING_COLOR to
   * restore the default cyan.
   */
  setRingColor(pipeNode: Object3D, color: number): void {
    const entry = this.entries.find((e) => e.node === pipeNode);
    if (!entry) return;
    const mat = entry.overlay.material as MeshBasicMaterial;
    mat.color.setHex(color);
  }

  /** Restore every overlay to the default cyan ring color. */
  resetAllRingColors(): void {
    for (const entry of this.entries) {
      const mat = entry.overlay.material as MeshBasicMaterial;
      mat.color.setHex(RING_COLOR);
    }
  }

  private _createFlow(pipeNode: Object3D): void {
    const pipeMesh = findPipeMesh(pipeNode);
    if (!pipeMesh) return;

    // Check the mesh has UVs
    if (!pipeMesh.geometry.attributes.uv) return;

    const parent = pipeMesh.parent ?? pipeNode;

    const entry: PipeFlowEntry = {
      node: pipeNode,
      overlay: null!,
      shader: null,
      tsl: null,
      lastFlowRate: 0,
    };

    let mat: MeshBasicMaterial;
    // WebGPURenderer (both backends): onBeforeCompile GLSL patches are
    // silently ignored — the pre-warmed TSL variant carries the animated
    // rings instead (plan-271 Phase 2). Without pre-warm → F4 guard fallback
    // (warn once, static semi-transparent overlay, `entry.shader`/`entry.tsl`
    // stay null so update() writes nothing).
    if (this._isWebGPU) {
      const tslMod = getTslMaterials();
      if (tslMod) {
        const handles = tslMod.createPipeFlowMaterialTsl(
          RING_COLOR, RING_OPACITY, RING_DENSITY, RING_WIDTH,
        );
        // MeshBasicNodeMaterial shares the MeshBasicMaterial property surface
        // (color, opacity, …) — setRingColor()/dispose() keep working.
        mat = handles.material as MeshBasicMaterial;
        entry.tsl = handles;
      } else {
        warnPipeFlowWebGPUOnce();
        mat = new MeshBasicMaterial({
          color: RING_COLOR,
          transparent: true,
          opacity: RING_OPACITY,
          side: FrontSide,
          depthTest: true,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -4,
        });
      }
    } else {
      mat = new MeshBasicMaterial({
        color: RING_COLOR,
        transparent: true,
        opacity: RING_OPACITY,
        side: FrontSide,
        depthTest: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -4,
      });
      mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = { value: 0 };
      shader.uniforms.uFlowSpeed = { value: 0 };
      shader.uniforms.uRingDensity = { value: RING_DENSITY };
      shader.uniforms.uRingWidth = { value: RING_WIDTH };

      // Vertex: pass UV to fragment (already available as vUv in MeshBasicMaterial when map is set,
      // but we need it without a map — so pass it explicitly)
      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
varying vec2 vPipeUv;`,
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vPipeUv = uv;`,
      );

      // Fragment: animated ring pattern along UV.x
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
uniform float uTime;
uniform float uFlowSpeed;
uniform float uRingDensity;
uniform float uRingWidth;
varying vec2 vPipeUv;`,
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        `#include <opaque_fragment>
{
  float pathPos = vPipeUv.x * uRingDensity - uTime * uFlowSpeed;
  float t = fract(pathPos);
  float ring = smoothstep(0.0, 0.05, t) * (1.0 - smoothstep(uRingWidth, uRingWidth + 0.05, t));
  gl_FragColor.a *= ring;
  if (gl_FragColor.a < 0.01) discard;
}`,
      );

        entry.shader = shader;
      };

      // WebGL program cache key (GLSL path only — the WebGPU node pipeline
      // caches by node-graph state, a shared key would be wrong there).
      mat.customProgramCacheKey = () => `pipeFlow_${pipeMesh.uuid}`;
    }

    const overlay = new Mesh(pipeMesh.geometry, mat);
    overlay.name = `${pipeMesh.name}_flowOverlay`;
    overlay.userData._pipeFlowViz = true;
    overlay.userData._tankFillViz = true; // exclude from raycast + static merge
    overlay.renderOrder = 1;
    overlay.position.copy(pipeMesh.position);
    overlay.quaternion.copy(pipeMesh.quaternion);
    overlay.scale.copy(pipeMesh.scale);
    // Make the scrolling flow rings visible in pass 3 of isolate mode (focus
    // pass) — without this they only carry layer 0 and disappear under the
    // dim overlay when the pumping plant is isolated.
    overlay.layers.enable(ISOLATE_FOCUS_LAYER);
    parent.add(overlay);

    overlay.visible = false;
    entry.overlay = overlay;
    this.entries.push(entry);
  }
}
