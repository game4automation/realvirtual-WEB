// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVUberMaterial — a single shared MeshStandardMaterial that reads base color,
 * roughness, and metalness from per-vertex attributes instead of uniforms.
 *
 * Purpose: collapse every untextured MeshStandardMaterial in the scene onto
 * one material reference. After this pass, all uber-baked static meshes share
 * the same `(attribute signature, material reference)` tuple, which means
 * (a) they all use one compiled WebGL program (via customProgramCacheKey)
 * and (b) they all land in the same static-merge group in Phase 4, producing
 * one draw call for the entire untextured-static portion of the scene.
 *
 * Data layout per vertex:
 *   - `color` (vec3, Uint8 normalized) — baked from material.color (linear)
 *   - `rmPacked` (vec2, Uint8 normalized) — (roughness, metalness)
 *
 * The `color` attribute uses the three.js-native `vertexColors: true` path.
 * `rmPacked` is a custom attribute injected by the onBeforeCompile shader
 * patch — we use a dedicated name rather than `uv2` because uv2 is reserved
 * by three.js for aoMap/lightMap.
 */

import {
  Object3D,
  Mesh,
  Material,
  MeshStandardMaterial,
  BufferAttribute,
  BufferGeometry,
  FrontSide,
} from 'three';
import { debug } from './rv-debug';
import { isRuntimeRigMesh, traverseMeshes } from './rv-traverse-utils';
import { getTslMaterials } from './materials/material-factory';

// Module-local warn-once flag (repo convention — no external warnOnce util).
// Since plan-271 Phase 2 this only fires as a FALLBACK: when the renderer is
// a WebGPURenderer but the TSL material module was not pre-warmed (see
// preloadTslMaterials in material-factory.ts).
let _warnedWebGPU = false;
function warnUberWebGPUOnce(): void {
  if (_warnedWebGPU) return;
  _warnedWebGPU = true;
  console.warn(
    '[UberMaterial] WebGPU renderer active but the TSL material module is ' +
    'not preloaded — the GLSL onBeforeCompile patch (per-vertex ' +
    'roughness/metalness via rmPacked) is disabled because onBeforeCompile ' +
    'is silently ignored under WebGPURenderer. Base colors stay correct ' +
    '(vertexColors), only the roughness/metalness overlay is skipped.',
  );
}

/**
 * Shared uber-material. A single instance serves every uber-eligible mesh in
 * the loaded scene. Marked with `userData._rvShared = true` so clearModel()
 * skips it during model teardown — the singleton outlives individual loads.
 */
export class RVUberMaterial extends MeshStandardMaterial {
  constructor(isWebGPU = false) {
    super({
      color: 0xffffff,    // identity — real color comes from vertex attribute
      roughness: 1.0,     // identity — replaced in fragment shader by vRm.x
      metalness: 0.0,     // identity — replaced in fragment shader by vRm.y
      vertexColors: true, // three.js native: reads `color` attribute (linear)
      side: FrontSide,
    });
    this.name = '__rvUberMaterial';
    this.userData._rvShared = true;

    // WebGPU guard (plan-271 PR#0): onBeforeCompile GLSL patches are silently
    // ignored under WebGPURenderer — do not install one. The material keeps
    // `vertexColors: true` (set above), so merged-mesh base colors stay
    // correct; only the per-vertex roughness/metalness overlay is skipped.
    if (isWebGPU) {
      warnUberWebGPUOnce();
      return;
    }

    this.onBeforeCompile = (shader) => {
      // Vertex shader: declare the custom attribute and forward it as a
      // varying. `#include <common>` and `#include <begin_vertex>` appear
      // literally in meshphysical_vert.glsl so string replacement works.
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nattribute vec2 rmPacked;\nvarying vec2 vRm;',
        )
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvRm = rmPacked;',
        );
      // Fragment shader: roughness/metalness are set inside the
      // `<roughnessmap_fragment>` and `<metalnessmap_fragment>` chunks —
      // NOT in the top-level fragment source. Three.js onBeforeCompile
      // receives the source before include resolution, so replacing the
      // inner text silently fails. Instead, let the chunks run first (which
      // seeds the Factor from the uniform), then overwrite with the
      // per-vertex value on the very next line.
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nvarying vec2 vRm;',
        )
        .replace(
          '#include <roughnessmap_fragment>',
          '#include <roughnessmap_fragment>\nroughnessFactor = vRm.x;',
        )
        .replace(
          '#include <metalnessmap_fragment>',
          '#include <metalnessmap_fragment>\nmetalnessFactor = vRm.y;',
        );
    };

    // Force a constant program cache key so every RVUberMaterial (we only
    // create one, but just in case) shares the same compiled WebGL program
    // instead of one program per material instance.
    this.customProgramCacheKey = () => '__rvUberMaterial_v1';
  }
}

export interface UberResult {
  /** Number of materials that passed the uber-eligibility predicate */
  eligibleMaterialCount: number;
  /** Number of meshes whose geometry + material were replaced with the uber path */
  bakedMeshCount: number;
  /** Shared uber-material reference, or null if nothing was eligible */
  sharedMaterial: RVUberMaterial | null;
  /** Meshes that shared an already-baked BufferGeometry instead of cloning (plan-153) */
  sharedGeometryReuses: number;
  /** Meshes that had to clone their geometry because of a material conflict (plan-153) */
  clonedGeometryCount: number;
  /** Orphaned source BufferGeometries that Pass 3 disposed (plan-153) */
  disposedSourceGeometries: number;
}

/**
 * Decide whether a material is uber-eligible.
 *
 * A material qualifies only when all of the following hold:
 *   - It is a plain MeshStandardMaterial (not Physical, not Basic, not custom)
 *   - All texture slots are null (no map, normalMap, roughnessMap, metalnessMap,
 *     aoMap, emissiveMap, alphaMap, lightMap, envMap)
 *   - Opaque: `transparent === false && opacity === 1 && alphaTest === 0`
 *   - `side === FrontSide` (mixed sides force GL state switches per draw call)
 *   - `vertexColors === false` (we own the color attribute after baking)
 *   - Emissive is black AND emissiveIntensity === 0
 *   - `flatShading === false`
 *
 * Materials that fail the predicate keep whatever dedup left them on — they
 * continue to be deduped across identical references but don't get collapsed
 * onto the shared uber reference.
 */
export function isUberEligible(mat: Material): boolean {
  const m = mat as MeshStandardMaterial & {
    isMeshStandardMaterial?: boolean;
    isMeshPhysicalMaterial?: boolean;
  };
  if (!m.isMeshStandardMaterial) return false;
  if (m.isMeshPhysicalMaterial) return false; // Physical extends Standard — exclude
  if (m.map) return false;
  if (m.normalMap) return false;
  if (m.roughnessMap) return false;
  if (m.metalnessMap) return false;
  if (m.aoMap) return false;
  if (m.emissiveMap) return false;
  if (m.alphaMap) return false;
  if (m.lightMap) return false;
  if (m.envMap) return false;
  if (m.transparent) return false;
  if (m.opacity < 1) return false;
  if (m.alphaTest > 0) return false;
  if (m.side !== FrontSide) return false;
  if (m.vertexColors) return false;
  if (m.flatShading) return false;
  // Emissive contribution check: black color OR zero intensity
  if (m.emissiveIntensity > 0 && m.emissive) {
    const e = m.emissive;
    if (e.r > 0 || e.g > 0 || e.b > 0) return false;
  }
  return true;
}

/**
 * Filter a set of deduped materials down to the uber-eligible subset.
 */
export function classifyUberEligible(materials: Set<Material>): Set<Material> {
  const out = new Set<Material>();
  for (const m of materials) {
    if (isUberEligible(m)) out.add(m);
  }
  return out;
}

/**
 * Bake the uniform color / roughness / metalness of `originalMat` into
 * per-vertex attributes on `mesh.geometry`, then swap the mesh over to the
 * shared uber material.
 *
 * Geometry handling is conditional:
 *   - `shareGeometry === false` (default): clone the geometry before baking.
 *     Required when other meshes still reference this BufferGeometry with
 *     DIFFERENT materials — mutating it would corrupt their output.
 *   - `shareGeometry === true`: bake into the original geometry in place.
 *     The caller has verified via Pre-Scan that every uber-eligible user of
 *     this geometry would produce the same bake result, so a single in-place
 *     bake serves all of them and the clone is avoided. This is the major
 *     heap saving for scenes with heavily reused GLTFLoader geometries.
 *
 * The function marks the resulting geometry with `userData._rvUberBaked =
 * true` so the outer loop can skip re-baking when the next mesh shares it.
 *
 * Per-vertex storage uses Uint8 normalized attributes: 3 bytes/vertex for
 * color and 2 bytes/vertex for rmPacked. That's a 4× memory win over
 * Float32 with no perceptible quality loss for albedo/roughness/metalness.
 */
export function bakeMaterialToAttributes(
  mesh: Mesh,
  sharedUber: RVUberMaterial,
  originalMat: MeshStandardMaterial,
  options: { shareGeometry?: boolean } = {},
): void {
  const srcGeom = mesh.geometry;
  const posAttr = srcGeom.attributes.position;
  if (!posAttr) return; // Nothing to bake onto
  const vCount = posAttr.count;

  // Conditional clone — see function docs above.
  const geom = options.shareGeometry ? srcGeom : srcGeom.clone();

  // Build color attribute: Uint8 normalized (0-255 → 0..1 in shader)
  // material.color is in linear RGB; three.js r150+ vertex colors are
  // interpreted as linear too, so we copy without conversion.
  const col = originalMat.color;
  const colArr = new Uint8Array(vCount * 3);
  const r = Math.round(col.r * 255);
  const g = Math.round(col.g * 255);
  const b = Math.round(col.b * 255);
  for (let i = 0; i < vCount; i++) {
    const o = i * 3;
    colArr[o] = r;
    colArr[o + 1] = g;
    colArr[o + 2] = b;
  }
  geom.setAttribute('color', new BufferAttribute(colArr, 3, true));

  // Build rmPacked attribute: (roughness, metalness) Uint8 normalized
  const rm = new Uint8Array(vCount * 2);
  const rough = Math.round(Math.max(0, Math.min(1, originalMat.roughness ?? 1)) * 255);
  const metal = Math.round(Math.max(0, Math.min(1, originalMat.metalness ?? 0)) * 255);
  for (let i = 0; i < vCount; i++) {
    const o = i * 2;
    rm[o] = rough;
    rm[o + 1] = metal;
  }
  geom.setAttribute('rmPacked', new BufferAttribute(rm, 2, true));

  // Mark the geometry so the outer loop knows not to re-bake it when the
  // next mesh in the traversal shares this same BufferGeometry.
  geom.userData._rvUberBaked = true;

  // Swap in the (possibly cloned) geometry + shared material
  mesh.geometry = geom;
  mesh.material = sharedUber;
  mesh.userData._rvUberBaked = true;
}

/**
 * Walk the scene, identify every mesh whose material is uber-eligible, and
 * bake each one onto the shared uber material. Mutates `dedupedMaterials`:
 * eligible materials are removed from the Set (they no longer exist on any
 * mesh), and the shared uber material is added in their place.
 *
 * Depends on Phase 1 material dedup having already collapsed identical
 * materials to single references — otherwise two "same color, no texture"
 * materials would each be classified separately and the baked meshes would
 * still share the single uber singleton, but the stats would double-count.
 */
export function applyUberMaterial(
  root: Object3D,
  dedupedMaterials: Set<Material>,
  isWebGPU = false,
): UberResult {
  const eligible = classifyUberEligible(dedupedMaterials);
  if (eligible.size === 0) {
    return {
      eligibleMaterialCount: 0,
      bakedMeshCount: 0,
      sharedMaterial: null,
      sharedGeometryReuses: 0,
      clonedGeometryCount: 0,
      disposedSourceGeometries: 0,
    };
  }

  // Renderer-aware variant selection (plan-271 Phase 2): under a
  // WebGPURenderer (BOTH backends) the pre-warmed TSL variant replaces the
  // GLSL onBeforeCompile patch. Without a successful pre-warm the F4 guard
  // fallback stays active (RVUberMaterial(true): warn once, vertexColors
  // kept, rm overlay skipped). The TSL material is a MeshStandardNodeMaterial
  // — downstream code only uses the shared reference structurally (assign to
  // mesh.material, Set<Material>, name/userData), so the cast is safe.
  let sharedUber: RVUberMaterial;
  if (isWebGPU) {
    const tsl = getTslMaterials();
    sharedUber = tsl
      ? (tsl.createUberMaterialTsl() as unknown as RVUberMaterial)
      : new RVUberMaterial(true);
  } else {
    sharedUber = new RVUberMaterial(false);
  }
  let bakedMeshCount = 0;
  let sharedGeometryReuses = 0;
  let clonedGeometryCount = 0;
  // Track every source geometry we replace so we can dispose the ones that
  // nothing references anymore after the pass. GLTFLoader often shares a
  // single BufferGeometry across several meshes (e.g. 100 identical bolts,
  // some of which may have different materials) so we can only safely
  // dispose a source geometry once we know no mesh in the scene still
  // holds it.
  const replacedSources = new Set<BufferGeometry>();

  // Pre-Scan: map every shared BufferGeometry to the set of distinct
  // uber-eligible materials that use it. If the set size is 1, every
  // eligible user of this geometry would bake to the same color+rm output,
  // so we can bake in-place and share the geometry instead of cloning it
  // per mesh. This is the main heap-reduction lever for GLTFLoader scenes
  // with many shared geometries (e.g. 40k meshes → ~24k unique geometries
  // on the Mauser scene).
  const geometryUsage = new Map<BufferGeometry, Set<Material>>();
  // Geometries that a runtime deformation rig (EnergyChain, plan-362) holds.
  // They are never baked themselves, and no OTHER mesh may bake them in place
  // either — that would write shared color/rmPacked attributes into geometry a
  // SkinnedMesh renders and a dispose() has to hand back untouched.
  const rigGeometries = new Set<BufferGeometry>();
  traverseMeshes(root, (mesh) => {
    if (isRuntimeRigMesh(mesh)) {
      if (mesh.geometry) rigGeometries.add(mesh.geometry);
      return;
    }
    if (Array.isArray(mesh.material)) return;
    const mat = mesh.material;
    if (!mat || !eligible.has(mat)) return;
    let users = geometryUsage.get(mesh.geometry);
    if (!users) {
      users = new Set<Material>();
      geometryUsage.set(mesh.geometry, users);
    }
    users.add(mat);
  });

  // Clone cache: when a geometry is used with SEVERAL eligible materials
  // (canShare === false), all meshes with the same (geometry, material) pair
  // still bake to an identical clone — share ONE baked clone per pair instead
  // of cloning per mesh. Shrinks the heap AND the unique-geometry set the
  // BatchedMesh arena stores.
  const cloneCache = new Map<BufferGeometry, Map<Material, BufferGeometry>>();

  traverseMeshes(root, (mesh) => {
    // Skip multi-material meshes — baking per-submesh would require splitting
    // the geometry by groups and is out of scope for Phase 2. They continue to
    // use the deduped (but not uber-collapsed) materials.
    if (Array.isArray(mesh.material)) return;

    // Skip pipe and tank meshes — ProcessIndustryPlugin swaps their materials
    // at runtime to show the fluid color. Uber baking freezes the color into
    // a shared vertex attribute, which would make `mesh.material = newMat` a
    // visual no-op.
    if (mesh.userData?._rvLampMesh || mesh.parent?.userData?._rvLampMesh) return;
    // Scene-button caps swap between a lit and an unlit material clone
    // (plan-417) — an uber bake would freeze the emissive into the geometry.
    if (mesh.userData?._rvSceneButtonMesh || mesh.parent?.userData?._rvSceneButtonMesh) return;
    if (mesh.userData?._rvType === 'Pipe' || mesh.parent?.userData?._rvType === 'Pipe') return;
    if (mesh.userData?._rvType === 'Tank' || mesh.parent?.userData?._rvType === 'Tank') return;

    // Skip runtime deformation-rig sidecars (EnergyChain, plan-362): a
    // SkinnedMesh must keep its own material and untouched geometry, and the
    // invisible picking proxy has no business in the bake at all.
    if (isRuntimeRigMesh(mesh)) return;

    const mat = mesh.material;
    if (!mat || !eligible.has(mat)) return;

    const users = geometryUsage.get(mesh.geometry);
    const canShare = users !== undefined && users.size === 1
      && !rigGeometries.has(mesh.geometry);

    // Second (or later) visit of a shared geometry that has already been
    // baked in-place by an earlier mesh in this traversal. The geometry
    // already carries the color+rmPacked attributes — we only need to swap
    // the material reference on this mesh.
    if (canShare && mesh.geometry.userData._rvUberBaked === true) {
      mesh.material = sharedUber;
      mesh.userData._rvUberBaked = true;
      bakedMeshCount++;
      sharedGeometryReuses++;
      return;
    }

    // Clone case: reuse an already-baked clone for this (geometry, material)
    // pair when an earlier mesh in the traversal produced one.
    if (!canShare) {
      const cached = cloneCache.get(mesh.geometry)?.get(mat);
      if (cached) {
        replacedSources.add(mesh.geometry);
        mesh.geometry = cached;
        mesh.material = sharedUber;
        mesh.userData._rvUberBaked = true;
        bakedMeshCount++;
        sharedGeometryReuses++;
        return;
      }
    }

    // Remember the source geometry BEFORE the bake potentially replaces
    // mesh.geometry with a clone.
    const sourceGeom = mesh.geometry;
    replacedSources.add(sourceGeom);
    bakeMaterialToAttributes(mesh, sharedUber, mat as MeshStandardMaterial, {
      shareGeometry: canShare,
    });
    bakedMeshCount++;
    if (canShare) {
      sharedGeometryReuses++;
    } else {
      clonedGeometryCount++;
      let byMat = cloneCache.get(sourceGeom);
      if (!byMat) {
        byMat = new Map<Material, BufferGeometry>();
        cloneCache.set(sourceGeom, byMat);
      }
      byMat.set(mat, mesh.geometry);
    }
  });

  if (bakedMeshCount === 0) {
    // Predicate matched materials but no live mesh used them — bail out
    // without adding the shared material to the unique set.
    return {
      eligibleMaterialCount: eligible.size,
      bakedMeshCount: 0,
      sharedMaterial: null,
      sharedGeometryReuses: 0,
      clonedGeometryCount: 0,
      disposedSourceGeometries: 0,
    };
  }

  // Pass 2: dispose source geometries that no surviving mesh still uses.
  // Walk the scene once, collect every geometry still referenced, then
  // dispose each replaced source whose reference count dropped to zero.
  // On a typical scene this reclaims tens of megabytes of typed-array
  // vertex data that GLTFLoader uploaded but nothing renders anymore.
  const stillReferenced = new Set<BufferGeometry>();
  traverseMeshes(root, (mesh) => {
    if (mesh.geometry) {
      stillReferenced.add(mesh.geometry);
    }
  });
  let disposedSources = 0;
  for (const srcGeom of replacedSources) {
    if (!stillReferenced.has(srcGeom)) {
      srcGeom.dispose();
      disposedSources++;
    }
  }

  // Update the deduped material set: remove collapsed materials, add the
  // shared uber reference. This keeps `clearModel()` dispose logic honest
  // (it iterates uniqueMaterials) and keeps getRendererStats() accurate.
  for (const m of eligible) dedupedMaterials.delete(m);
  dedupedMaterials.add(sharedUber);

  debug('loader',
    `[UberMaterial] ${eligible.size} untextured materials → 1 shared ` +
    `(${bakedMeshCount} meshes baked: ${sharedGeometryReuses} shared / ${clonedGeometryCount} cloned, ` +
    `${disposedSources} orphaned source geometries disposed)`
  );

  return {
    eligibleMaterialCount: eligible.size,
    bakedMeshCount,
    sharedMaterial: sharedUber,
    sharedGeometryReuses,
    clonedGeometryCount,
    disposedSourceGeometries: disposedSources,
  };
}
