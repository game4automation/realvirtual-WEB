// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { Object3D, Mesh, Material, Color, Texture, MeshStandardMaterial } from 'three';
import { debug } from './rv-debug';

export interface DedupResult {
  /** Number of Material references present in the scene before dedup */
  originalCount: number;
  /** Number of unique Material references after dedup (collapsed) */
  uniqueCount: number;
  /** Number of duplicate Material references that were replaced */
  disposedCount: number;
  /**
   * Set of unique materials still attached to the scene. Consumed by
   * `clearModel()` in rv-viewer.ts — each Material is disposed exactly
   * once via this Set (the disposed-Set pattern in clearModel also
   * deduplicates, but feeding a pre-deduplicated Set keeps dispose O(unique)
   * instead of O(total-mesh-references)).
   */
  uniqueMaterials: Set<Material>;
}

/**
 * Deduplicate materials on a scene graph.
 *
 * Groups materials by a stable fingerprint (color, roughness, metalness,
 * emissive, transparent, opacity, side, alphaTest, vertexColors, flatShading,
 * and source URL of every texture slot). Identical-looking materials produced
 * by the GLTFLoader — which always creates a fresh Material instance per
 * glTF material — collapse onto a single shared reference.
 *
 * Critical: for multi-material meshes (`mesh.material: Material[]`), array
 * elements are replaced in-place. The array reference itself is never
 * overwritten, otherwise `geometry.groups` would render with the wrong
 * material mapping (this was the root cause of the previous "black materials"
 * regression that caused this function to be disabled).
 *
 * Must run before static geometry merging (merge groups by material identity,
 * so without dedup every visually-identical material ends up in its own group).
 */
export function deduplicateMaterials(root: Object3D): DedupResult {
  const dedupMap = new Map<string, Material>();
  const uniqueMaterials = new Set<Material>();
  let originalCount = 0;
  let disposedCount = 0;

  root.traverse((node) => {
    if (!(node as Mesh).isMesh) return;
    const mesh = node as Mesh;

    if (Array.isArray(mesh.material)) {
      // Multi-material mesh — replace array elements in place, NEVER the
      // array reference itself, or geometry.groups misaligns.
      const arr = mesh.material;
      for (let i = 0; i < arr.length; i++) {
        const mat = arr[i];
        if (!mat) continue;
        originalCount++;
        const fp = fingerprint(mat);
        const existing = dedupMap.get(fp);
        if (existing && existing !== mat) {
          arr[i] = existing;
          disposedCount++;
        } else if (!existing) {
          dedupMap.set(fp, mat);
          uniqueMaterials.add(mat);
        } else {
          // existing === mat — already tracked, nothing to do
          uniqueMaterials.add(mat);
        }
      }
    } else if (mesh.material) {
      originalCount++;
      const fp = fingerprint(mesh.material);
      const existing = dedupMap.get(fp);
      if (existing && existing !== mesh.material) {
        mesh.material = existing;
        disposedCount++;
      } else if (!existing) {
        dedupMap.set(fp, mesh.material);
        uniqueMaterials.add(mesh.material);
      } else {
        uniqueMaterials.add(mesh.material);
      }
    }
  });

  const uniqueCount = uniqueMaterials.size;
  if (originalCount > 0) {
    debug('loader',
      `[MaterialDedup] ${originalCount} → ${uniqueCount} unique (${disposedCount} duplicates collapsed)`
    );
  }

  return {
    originalCount,
    uniqueCount,
    disposedCount,
    uniqueMaterials,
  };
}

/**
 * Build a stable fingerprint string for a Material. Materials with equal
 * fingerprints are considered interchangeable and get collapsed to a single
 * shared reference.
 *
 * Float fields are quantized (×1000, rounded) to absorb loader-induced noise
 * like 0.5 vs 0.500001. Textures are compared by source URL rather than UUID
 * because GLTFLoader can wrap the same image in distinct Texture objects with
 * different UUIDs.
 */
function fingerprint(mat: Material): string {
  const m = mat as MeshStandardMaterial;
  const q = (v: number | undefined): string =>
    v === undefined || v === null ? '-' : String(Math.round(v * 1000));
  const c = (col: Color | undefined | null): string =>
    col ? q(col.r) + ',' + q(col.g) + ',' + q(col.b) : '-';

  return [
    mat.type,
    c(m.color),
    q(m.roughness),
    q(m.metalness),
    c(m.emissive),
    q(m.emissiveIntensity),
    mat.transparent ? '1' : '0',
    q(mat.opacity),
    mat.side,
    q(mat.alphaTest),
    mat.vertexColors ? '1' : '0',
    m.flatShading ? '1' : '0',
    texKey(m.map),
    texKey(m.normalMap),
    texKey(m.roughnessMap),
    texKey(m.metalnessMap),
    texKey(m.aoMap),
    texKey(m.emissiveMap),
    texKey(m.alphaMap),
    texKey(m.lightMap),
  ].join('|');
}

/**
 * Extract a stable identity key for a Texture. Prefer the image source URL
 * (two Texture wrappers around the same Image.src collide), fall back to UUID.
 */
function texKey(t: Texture | null | undefined): string {
  if (!t) return 'null';
  const src = (t.source as unknown as { data?: { src?: string } } | undefined)?.data?.src;
  if (src) return src;
  const imgSrc = (t.image as unknown as { src?: string } | undefined)?.src;
  if (imgSrc) return imgSrc;
  return t.uuid;
}
