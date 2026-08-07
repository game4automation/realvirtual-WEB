// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mu-dissolve-tsl — TSL variant of the MU clip effects
 * (plan-271 Phase 2, port #3).
 *
 * Parity target: the GLSL `onBeforeCompile` clip/burn patches in
 * rv-mu-dissolve.ts:
 *  - VANISH (`createMUDissolveTsl`): progress-driven world-Y clip from the
 *    bottom up (`positionWorld.y < edge → Discard`), noisy edge (hash) and a
 *    blue emissive glow band above the edge.
 *  - GROW (`createMUGrowTsl`): a static world-space clip plane across the
 *    move axis — fragments behind the plane are discarded; the MU physically
 *    slides out of the plane. The plane is constant after creation, so the
 *    node graph needs NO per-frame update (the CPU-side completion tracking
 *    stays in rv-mu-dissolve.ts).
 *
 * Clone-per-MU contract (tested): every install call clones each mesh's
 * material into a fresh NodeMaterial and creates FRESH uniform nodes — the
 * uniforms are shared across the clones OF ONE MU (a single setProgress
 * drives the whole object) but NEVER across two MUs. `dispose()` restores the
 * original materials and frees the clones; idempotent.
 *
 * Import hygiene: only 'three/webgpu' / 'three/tsl'; loaded exclusively via
 * the dynamic import in material-factory.ts.
 */

import { MeshBasicNodeMaterial, MeshStandardNodeMaterial, Color } from 'three/webgpu';
import type { Material, Mesh, Object3D, Texture, Vector3 } from 'three/webgpu';
import {
  Discard,
  Fn,
  dot,
  hash,
  materialEmissive,
  materialOpacity,
  mix,
  positionWorld,
  smoothstep,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';

// Tunables — MUST stay in sync with rv-mu-dissolve.ts (single-line tweaks).
const BURN_COLOR = { r: 0.25, g: 0.6, b: 1.0 }; //!< sci-fi blue
const GLOW_BAND_M = 0.03;                        //!< thickness (m) of the glowing edge
const GLOW_STRENGTH = 2.5;                       //!< emissive boost at the burn line
const NOISE_SCALE = 5.5;                         //!< lower = bigger (coarser) noise cells
const NOISE_AMP_M = 0.05;                        //!< jitter (m) of the edge

/** Public handle mirroring the `MUDissolve` interface of rv-mu-dissolve.ts. */
export interface MUDissolveTsl {
  setProgress(p: number): void;
  dispose(): void;
}

/** Structural view of the standard-ish properties the clone copies. */
interface CloneSourceLike extends Material {
  isMeshBasicMaterial?: boolean;
  color?: Color;
  map?: Texture | null;
  normalMap?: Texture | null;
  emissive?: Color;
  emissiveMap?: Texture | null;
  emissiveIntensity?: number;
  alphaMap?: Texture | null;
  roughness?: number;
  metalness?: number;
  // Node slots (present when the source is the shared uber node material)
  isMeshStandardNodeMaterial?: boolean;
  colorNode?: unknown;
  roughnessNode?: unknown;
  metalnessNode?: unknown;
}

/**
 * Clone one source material into a NodeMaterial the effect nodes can attach
 * to. Classic materials are auto-converted by WebGPURenderer at draw time,
 * but effect NODES can only live on a NodeMaterial — hence the explicit
 * re-typed clone (textures shared by reference, like `material.clone()`).
 */
function cloneToNodeMaterial(src: Material): MeshStandardNodeMaterial | MeshBasicNodeMaterial {
  const s = src as CloneSourceLike;
  const clone = s.isMeshBasicMaterial === true
    ? new MeshBasicNodeMaterial()
    : new MeshStandardNodeMaterial();

  // Generic Material props
  clone.side = s.side;
  clone.transparent = s.transparent;
  clone.opacity = s.opacity;
  clone.alphaTest = s.alphaTest;
  clone.depthWrite = s.depthWrite;
  clone.depthTest = s.depthTest;
  clone.vertexColors = s.vertexColors;

  // Standard-ish props (undefined-safe — basic materials lack some)
  const c = clone as MeshStandardNodeMaterial;
  if (s.color) c.color.copy(s.color);
  c.map = s.map ?? null;
  if ('normalMap' in c) c.normalMap = s.normalMap ?? null;
  if ('roughness' in c) c.roughness = s.roughness ?? 1;
  if ('metalness' in c) c.metalness = s.metalness ?? 0;
  if ('emissive' in c && s.emissive) c.emissive.copy(s.emissive);
  if ('emissiveMap' in c) c.emissiveMap = s.emissiveMap ?? null;
  if ('emissiveIntensity' in c) c.emissiveIntensity = s.emissiveIntensity ?? 1;
  c.alphaMap = s.alphaMap ?? null;

  // Node slots: an uber-baked MU carries the shared MeshStandardNodeMaterial
  // (rmPacked roughness/metalness) — keep its nodes on the clone.
  if (s.isMeshStandardNodeMaterial === true) {
    const cn = clone as unknown as CloneSourceLike;
    if (s.colorNode) cn.colorNode = s.colorNode;
    if (s.roughnessNode) cn.roughnessNode = s.roughnessNode;
    if (s.metalnessNode) cn.metalnessNode = s.metalnessNode;
  }
  return clone;
}

/** Noisy edge jitter shared by both effects — TSL pendant of the GLSL
 *  `dHash(vDissolveWorld.xz * uNoiseScale)`; the hash differs numerically
 *  from the GLSL sin-hash (visual noise only, no contract on the pattern). */
function edgeNoise() {
  return hash(dot(positionWorld.xz.mul(NOISE_SCALE), vec2(127.1, 311.7)))
    .sub(0.5)
    .mul(NOISE_AMP_M);
}

/**
 * Splice the effect nodes into every Mesh under `node` (clone-per-mesh) and
 * return a dispose() that restores the originals. `buildNodes` receives the
 * clone and attaches opacity/emissive nodes — called once per clone with the
 * SAME per-MU node graph (uniform sharing within one MU, never across MUs).
 */
function installClipTsl(
  node: Object3D,
  buildNodes: (clone: MeshStandardNodeMaterial | MeshBasicNodeMaterial) => void,
): () => void {
  const restore: Array<{ mesh: Mesh; original: Material | Material[] }> = [];
  const clones: Material[] = [];

  const patch = (mat: Material): Material => {
    const clone = cloneToNodeMaterial(mat);
    buildNodes(clone);
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

/**
 * VANISH (TSL). Same contract as `createMUDissolve`: the burn edge sweeps
 * world-Y from just below `minY` (progress 0 → fully visible) to just above
 * `maxY` (progress 1 → fully discarded).
 */
export function createMUDissolveTsl(
  node: Object3D,
  minY: number,
  maxY: number,
): MUDissolveTsl {
  // Fresh uniforms per MU (clone-per-MU contract).
  const uProgress = uniform(0);
  const uMinY = uniform(minY);
  const uMaxY = uniform(maxY);

  const edge = mix(uMinY.sub(GLOW_BAND_M), uMaxY.add(GLOW_BAND_M), uProgress)
    .add(edgeNoise());
  const glow = smoothstep(0.0, GLOW_BAND_M, positionWorld.y.sub(edge)).oneMinus();
  const glowEmissive = vec3(BURN_COLOR.r, BURN_COLOR.g, BURN_COLOR.b)
    .mul(glow)
    .mul(GLOW_STRENGTH);
  const opacityWithDiscard = Fn(() => {
    Discard(positionWorld.y.lessThan(edge));
    return materialOpacity;
  })();

  const dispose = installClipTsl(node, (clone) => {
    clone.opacityNode = opacityWithDiscard;
    // GLSL adds the glow to gl_FragColor after lighting; the emissive slot is
    // the node-pipeline equivalent (pre-tonemapping additive term; the
    // NodeMaterial BASE handles emissiveNode, the typings just don't declare
    // it on MeshBasicNodeMaterial). Basic materials have no `.emissive`
    // property — materialEmissive would read undefined.
    (clone as MeshStandardNodeMaterial).emissiveNode = 'emissive' in clone
      ? materialEmissive.add(glowEmissive)
      : glowEmissive;
  });

  return {
    setProgress(p: number): void {
      uProgress.value = p < 0 ? 0 : p > 1 ? 1 : p;
    },
    dispose,
  };
}

/**
 * GROW (TSL). The clip plane (`planePoint` across unit `axis`) is fixed in
 * WORLD space at creation — fragments behind it are discarded, the glow band
 * stays on the plane. No per-frame node update; completion tracking (the
 * `update(nodeWorldPos)` logic) stays CPU-side in rv-mu-dissolve.ts.
 * Returns the dispose() restoring the original materials.
 */
export function createMUGrowTsl(
  node: Object3D,
  axis: Vector3,
  planePoint: Vector3,
): () => void {
  // Fresh uniforms per MU. axis/planePoint are captured by value (clone) —
  // they are constant for the lifetime of the effect.
  const uAxis = uniform(axis.clone());
  const uPlane = uniform(planePoint.clone());

  const coord = dot(positionWorld.sub(uPlane), uAxis);
  const noise = edgeNoise();
  const glow = smoothstep(0.0, GLOW_BAND_M, coord.sub(noise)).oneMinus();
  const glowEmissive = vec3(BURN_COLOR.r, BURN_COLOR.g, BURN_COLOR.b)
    .mul(glow)
    .mul(GLOW_STRENGTH);
  const opacityWithDiscard = Fn(() => {
    Discard(coord.lessThan(noise));
    return materialOpacity;
  })();

  return installClipTsl(node, (clone) => {
    clone.opacityNode = opacityWithDiscard;
    (clone as MeshStandardNodeMaterial).emissiveNode = 'emissive' in clone
      ? materialEmissive.add(glowEmissive)
      : glowEmissive;
  });
}
