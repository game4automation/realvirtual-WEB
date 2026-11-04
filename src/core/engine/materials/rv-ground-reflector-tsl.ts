// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-ground-reflector-tsl — the floor reflection for the WebGPURenderer paths
 * (plan-763 Phase 3), the TSL counterpart of `rv-ground-reflector.ts`.
 *
 * The classic factory builds a three `Reflector` (a ShaderMaterial that
 * re-renders the scene from `onBeforeRender`), which the WebGPURenderer cannot
 * run. Here the mirror is three's TSL `reflector()` node: it renders the
 * mirrored scene into its own target inside the material's `updateBefore` —
 * i.e. INSIDE the graph, before the plane is drawn — so it never touches the
 * canvas after the post pipeline (the one rule of plan-763).
 *
 * Same look as the WebGL mirror, from the same constants (passed in — a
 * `*-tsl.ts` module imports nothing relative):
 *  - the LINEAR disc fade of the checker floor on the plane's uv;
 *  - the Fresnel falloff on the view angle (strong at grazing angles, never
 *    below `fresnelMin` straight down);
 *  - strength as the overlay-blend gray (0 = black, `fullMirrorGray` = the
 *    natural mirror);
 *  - gloss as a Gaussian blur of the mirror texture. The blur sigma is a
 *    construction-time constant of three's node, so a blur change rebuilds the
 *    material's colour graph (a slider move, not a per-frame cost).
 *
 * The checker plane is hidden for the mirror render exactly like the WebGL
 * wrapper does, by wrapping the node's `updateBefore`; the same wrapper lets
 * the caller book the pass into its frame stats.
 *
 * Import hygiene: only 'three/webgpu', 'three/tsl' and 'three/addons/tsl/*';
 * loaded exclusively via the dynamic import in material-factory.ts.
 */

import {
  Color,
  MeshBasicNodeMaterial,
  Mesh,
  PlaneGeometry,
  type Object3D,
} from 'three/webgpu';
import {
  blendOverlay,
  cameraPosition,
  clamp,
  float,
  mix,
  positionWorld,
  pow,
  reflector,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TslNode = any;

/** The look constants shared with the WebGL mirror (`rv-ground-reflector.ts`). */
export interface GroundReflectorTslConstants {
  /** Overlay-blend gray that reproduces an unmodified reflection (0.5). */
  fullMirrorGray: number;
  /** Reflection minimum when viewed straight down. */
  fresnelMin: number;
  /** Fresnel exponent. */
  fresnelPower: number;
  /** Opaque inner radius of the disc fade as a fraction of the disc (checker parity). */
  fadeOpaqueRatio: number;
}

/** Gaussian sigma at blur = 1 (slider maximum). */
const MAX_BLUR_SIGMA = 8;

export interface GroundReflectorTslOptions {
  /** Wraps the mirror's render — the caller books frame stats here. */
  wrapPass?: <T>(run: () => T) => T;
  /** Mirror resolution relative to the drawing buffer (default 0.5). */
  resolutionScale?: number;
}

/** What the viewer holds — the same shape as the WebGL adapter. */
export interface GroundReflectorTsl {
  readonly mesh: Mesh;
  setStrength(strength: number): void;
  setBlur(blur: number): void;
  renderTargets(): readonly unknown[];
  dispose(): void;
}

/**
 * Create the TSL floor mirror. The returned mesh is a 200×200 plane like the
 * checker (so the caller applies the same scale / X-Z position), rotated
 * horizontal, `renderOrder = -2`, starting `visible = false`.
 */
export function createGroundReflectorTsl(
  checkerMesh: Mesh,
  constants: GroundReflectorTslConstants,
  options: GroundReflectorTslOptions = {},
): GroundReflectorTsl {
  const node = reflector({
    resolutionScale: options.resolutionScale ?? 0.5,
    samples: 0,
    bounces: false,
    generateMipmaps: false,
  });

  const mesh = new Mesh(new PlaneGeometry(200, 200), new MeshBasicNodeMaterial());
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = -2;
  mesh.visible = false;
  // The node's target follows the plane's world transform.
  mesh.add((node as unknown as { target: Object3D }).target);

  const material = mesh.material as MeshBasicNodeMaterial;
  material.transparent = true;
  material.depthWrite = false;
  material.toneMapped = false;

  const uGray = uniform(0); // strength starts at 0 (off), like the WebGL mirror
  let blur = 0;

  // Disc fade on the plane's uv — the checker's LINEAR profile.
  const r: TslNode = uv().sub(vec2(0.5, 0.5)).length().mul(2);
  const opaque = constants.fadeOpaqueRatio;
  const mask: TslNode = clamp(float(1).sub(r.sub(opaque).div(1 - opaque)), 0, 1);
  // Fresnel on the view angle.
  const ndotv: TslNode = clamp(cameraPosition.sub(positionWorld).normalize().y, 0, 1);
  const fres: TslNode = mix(float(constants.fresnelMin), float(1), pow(float(1).sub(ndotv), constants.fresnelPower));
  material.opacityNode = mask.mul(fres);

  const buildColor = (): void => {
    const sigma = Math.round(blur * MAX_BLUR_SIGMA);
    const source: TslNode = sigma > 0 ? gaussianBlur(node as TslNode, null, sigma) : node;
    material.colorNode = blendOverlay(source.rgb, vec3(uGray));
    material.needsUpdate = true;
  };
  buildColor();

  // Hide the checker for the mirror render (no doubled checker inside the
  // mirror) and let the caller book the pass — same contract as the WebGL
  // wrapper around `Reflector.onBeforeRender`. The render lives on the inner
  // ReflectorBaseNode (`node.reflector`), not on the texture node itself.
  const base = (node as unknown as { reflector: { updateBefore(frame: unknown): unknown } }).reflector;
  const origUpdateBefore = base.updateBefore.bind(base);
  const wrap = options.wrapPass ?? (<T>(run: () => T): T => run());
  base.updateBefore = (frame: unknown): unknown => {
    const checkerWasVisible = checkerMesh.visible;
    checkerMesh.visible = false;
    try {
      return wrap(() => origUpdateBefore(frame));
    } finally {
      checkerMesh.visible = checkerWasVisible;
    }
  };

  return {
    mesh,
    setStrength(strength: number): void {
      const s = Math.max(0, Math.min(1, strength));
      uGray.value = constants.fullMirrorGray * s;
    },
    setBlur(v: number): void {
      const b = Math.max(0, Math.min(1, v));
      if (b === blur) return;
      blur = b;
      buildColor();
    },
    renderTargets(): readonly unknown[] {
      const rt = (node as unknown as { getRenderTarget?: () => unknown }).getRenderTarget?.();
      return rt ? [rt] : [];
    },
    dispose(): void {
      (node as unknown as { dispose?: () => void }).dispose?.();
      material.dispose();
      mesh.geometry.dispose();
    },
  };
}

/** Keeps the `Color` import meaningful for consumers that tint the mirror later. */
export const GROUND_REFLECTOR_TSL_DEFAULT_TINT = new Color(0xffffff);
