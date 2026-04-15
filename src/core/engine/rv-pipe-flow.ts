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

// ─── Config ─────────────────────────────────────────────────────────────

/** Ring color (bright cyan). */
const RING_COLOR = 0x44ccff;
/** Base opacity of the ring bands. */
const RING_OPACITY = 0.6;
/** Rings per meter of pipe length. */
const RING_DENSITY = 3.0;
/** Ring width as fraction of spacing (0–1, lower = thinner). */
const RING_WIDTH = 0.25;
/** Flow speed multiplier (meters per second at flowRate=1). */
const FLOW_SPEED_SCALE = 0.5;

// ─── Types ──────────────────────────────────────────────────────────────

interface PipeFlowEntry {
  node: Object3D;
  overlay: Mesh;
  shader: WebGLProgramParametersWithUniforms | null;
  lastFlowRate: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function findPipeMesh(pipeNode: Object3D): Mesh | null {
  let best: Mesh | null = null;
  let bestVolume = 0;
  const tmpBox = new Box3();
  const tmpSize = new Vector3();

  pipeNode.traverse((child) => {
    if (!(child as Mesh).isMesh) return;
    if (child.userData._pipeFlowViz) return;
    const mesh = child as Mesh;
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

export class PipeFlowManager {
  readonly entries: PipeFlowEntry[] = [];
  private _time = 0;

  constructor(pipeNodes: Object3D[]) {
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

      // Visual flow speed accounts for UV direction on the mesh
      if (entry.shader) {
        entry.shader.uniforms.uTime.value = this._time;
        entry.shader.uniforms.uFlowSpeed.value = flowRate * uvDirection * FLOW_SPEED_SCALE;
      }

      entry.overlay.visible = active;
      if (active) hasActive = true;
      entry.lastFlowRate = flowRate;
    }

    return hasActive; // always dirty when pipes are flowing (animation)
  }

  dispose(): void {
    for (const entry of this.entries) {
      entry.overlay.parent?.remove(entry.overlay);
      (entry.overlay.material as Material).dispose();
    }
    this.entries.length = 0;
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
      lastFlowRate: 0,
    };

    const mat = new MeshBasicMaterial({
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

    mat.customProgramCacheKey = () => `pipeFlow_${pipeMesh.uuid}`;

    const overlay = new Mesh(pipeMesh.geometry, mat);
    overlay.name = `${pipeMesh.name}_flowOverlay`;
    overlay.userData._pipeFlowViz = true;
    overlay.userData._tankFillViz = true; // exclude from raycast + static merge
    overlay.renderOrder = 1;
    overlay.position.copy(pipeMesh.position);
    overlay.quaternion.copy(pipeMesh.quaternion);
    overlay.scale.copy(pipeMesh.scale);
    parent.add(overlay);

    overlay.visible = false;
    entry.overlay = overlay;
    this.entries.push(entry);
  }
}
