// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mesh-bake.ts — Utility for baking scene nodes into a single merged mesh.
 *
 * Collects all meshes under given nodes (including hidden uber-source meshes),
 * merges their geometry into a single BufferGeometry with baked world transforms,
 * and returns a single Mesh. Original material colors are preserved via vertex
 * colors so the baked mesh looks identical to the originals. Useful for:
 *   - Isolate/browse modes (doc browser, maintenance view)
 *   - Snapshot meshes for overlay rendering
 *   - Any scenario where N nodes need to be rendered as 1 draw call
 */

import {
  Mesh,
  BufferGeometry,
  Float32BufferAttribute,
  MeshStandardMaterial,
  Color,
  type Object3D,
  type Scene,
  type MeshStandardMaterialParameters,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ─── Types ──────────────────────────────────────────────────────────────

export interface BakeMeshOptions {
  /** Name for the resulting mesh (used for scene lookup/caching). Default: '__bakedMesh'. */
  name?: string;
  /** Include hidden uber-source meshes (_rvStaticUberSource). Default: true. */
  includeHiddenSources?: boolean;
  /** Include visible meshes. Default: false (only hidden sources). */
  includeVisible?: boolean;
  /** Material parameters for the baked mesh. Default: vertexColors + standard. */
  material?: MeshStandardMaterialParameters;
  /** If true, mesh starts visible. Default: false. */
  visible?: boolean;
  /** Scene to add the mesh to. If omitted, mesh is returned but not added. */
  addToScene?: Scene;
}

// ─── Helpers ────────────────────────────────────────────────────────────

const _tmpColor = new Color();

/** Extract the diffuse color from a material. Falls back to white. */
function getMaterialColor(material: Material | Material[]): Color {
  const mat = Array.isArray(material) ? material[0] : material;
  if (mat && 'color' in mat && (mat as MeshStandardMaterial).color) {
    return (mat as MeshStandardMaterial).color;
  }
  return new Color(1, 1, 1);
}

/**
 * Add a vertex color attribute to a geometry, filled with a uniform color.
 * If the geometry already has vertex colors, they are preserved.
 */
function addVertexColor(geom: BufferGeometry, color: Color): void {
  if (geom.attributes.color) return; // already has vertex colors
  const count = geom.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geom.setAttribute('color', new Float32BufferAttribute(colors, 3));
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Bake multiple scene nodes into a single merged mesh.
 *
 * Collects all mesh children under the given nodes, clones and transforms
 * their geometry into world space, bakes material colors as vertex colors,
 * merges into one BufferGeometry, and returns a single Mesh.
 *
 * The mesh has `raycast = () => {}` (not interactive) and
 * `_highlightOverlay = true` (excluded from highlight/raycast systems).
 *
 * @param nodes - Scene nodes whose mesh subtrees should be merged.
 * @param options - Configuration options.
 * @returns The merged Mesh, or null if no geometry was found.
 *
 * @example
 * ```ts
 * const docMesh = bakeMesh(docNodes, {
 *   name: '__docUberMesh',
 *   addToScene: viewer.scene,
 * });
 * if (docMesh) docMesh.visible = true;
 * ```
 */
export function bakeMesh(nodes: Object3D[], options?: BakeMeshOptions): Mesh | null {
  const {
    name = '__bakedMesh',
    includeHiddenSources = true,
    includeVisible = false,
    material: matParams,
    visible = false,
    addToScene,
  } = options ?? {};

  const geometries: BufferGeometry[] = [];

  for (const node of nodes) {
    node.traverse(obj => {
      if (!(obj as Mesh).isMesh) return;
      if (obj.userData?._highlightOverlay) return;

      const mesh = obj as Mesh;
      const isHiddenSource = !!mesh.userData?._rvStaticUberSource;
      const isVisible = mesh.visible;

      // Filter: include based on options
      if (isHiddenSource && !includeHiddenSources) return;
      if (isVisible && !isHiddenSource && !includeVisible) return;
      if (!isVisible && !isHiddenSource) return;

      mesh.updateWorldMatrix(true, false);

      let geom = mesh.geometry.clone();

      // Keep only position, normal, and color
      for (const attrName of Object.keys(geom.attributes)) {
        if (attrName !== 'position' && attrName !== 'normal' && attrName !== 'color') {
          geom.deleteAttribute(attrName);
        }
      }
      if (!geom.attributes.normal) geom.computeVertexNormals();

      // Bake material color as vertex colors (preserves original appearance)
      const color = getMaterialColor(mesh.material);
      addVertexColor(geom, color);

      // Bake world transform into geometry
      geom.applyMatrix4(mesh.matrixWorld);
      geometries.push(geom);
    });
  }

  if (geometries.length === 0) return null;

  // Ensure consistent indexed/non-indexed state for mergeGeometries
  const allIndexed = geometries.every(g => g.index !== null);
  if (!allIndexed) {
    for (let i = 0; i < geometries.length; i++) {
      if (geometries[i].index) {
        const nonIndexed = geometries[i].toNonIndexed();
        geometries[i].dispose();
        geometries[i] = nonIndexed;
      }
    }
  }

  const merged = mergeGeometries(geometries, false);
  for (const g of geometries) g.dispose();
  if (!merged) return null;

  const mat = new MeshStandardMaterial({
    vertexColors: true,
    metalness: 0.1,
    roughness: 0.7,
    ...matParams,
  });

  const bakedMesh = new Mesh(merged, mat);
  bakedMesh.name = name;
  bakedMesh.frustumCulled = false;
  bakedMesh.raycast = () => {};
  bakedMesh.visible = visible;
  bakedMesh.userData._highlightOverlay = true;

  if (addToScene) addToScene.add(bakedMesh);

  return bakedMesh;
}

/**
 * Find a previously baked mesh in the scene by name, or return null.
 */
export function findBakedMesh(scene: Object3D, name: string): Mesh | null {
  return (scene.getObjectByName(name) as Mesh) ?? null;
}

/**
 * Dispose a baked mesh: remove from scene, dispose geometry and material.
 */
export function disposeBakedMesh(mesh: Mesh): void {
  mesh.removeFromParent();
  mesh.geometry.dispose();
  if (Array.isArray(mesh.material)) {
    for (const m of mesh.material) m.dispose();
  } else {
    mesh.material.dispose();
  }
}
