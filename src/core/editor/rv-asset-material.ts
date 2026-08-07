// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-asset-material — the three.js side of the `setMaterial` asset op.
 *
 * Shared by `rv-asset-document.ts` (which captures the per-mesh inverse payload
 * at op-creation time) and `rv-asset-executors.ts` (which applies forward and
 * inverse). Kept separate from both so the mesh-expansion rule and the
 * MaterialValue ↔ Material conversion have exactly one definition.
 *
 * Two invariants this module exists to protect:
 *
 *  1. **Clone-on-write.** Materials are shared across meshes — the loader runs
 *     `deduplicateMaterials()`, so one `MeshStandardMaterial` instance routinely
 *     backs hundreds of parts. Applying a preset therefore ASSIGNS a different
 *     material instance; it never mutates the one already attached, or unrelated
 *     parts of the asset would silently change with it.
 *
 *  2. **One instance per distinct value.** `materialForValue` caches by the
 *     value's fingerprint, so painting 400 parts "Steel" yields a single shared
 *     material — which is both what the renderer wants and what keeps the
 *     exported GLB from carrying 400 identical material definitions.
 *
 * Editor-mode only. See doc-render-picking.md §1.1: editor mode loads with
 * `preserveHierarchy: true`, so no uber bake and no BatchTable exist and a plain
 * `mesh.material = …` both renders and survives the GLB export. In batched modes
 * the same assignment is a silent no-op (sources render at `layers.mask = 0`).
 */

import { Object3D, Mesh, Material, MeshStandardMaterial, Color, DoubleSide } from 'three';
import type { MaterialValue } from './rv-asset-ops';
import { NodeRegistry } from '../engine/rv-node-registry';

/** Runtime helpers (gizmos, overlays, sensor viz) never take a user material. */
function isRuntimeHelper(node: Object3D): boolean {
  return node.name.startsWith('_') || node.userData?._rvGizmo === true;
}

/**
 * Every mesh at or under `node`, skipping runtime-helper subtrees.
 *
 * Multi-material meshes are excluded: their `geometry.groups` map face ranges to
 * array slots, so collapsing them onto one preset would silently discard the
 * per-group assignment. They stay untouched and are reported to the caller by
 * their absence from the result.
 */
export function collectPaintableMeshes(node: Object3D): Mesh[] {
  const out: Mesh[] = [];
  node.traverse((child) => {
    if (isRuntimeHelper(child)) return;
    const mesh = child as Mesh;
    if (!(mesh as { isMesh?: boolean }).isMesh) return;
    if (Array.isArray(mesh.material)) return;
    if (!mesh.material) return;
    out.push(mesh);
  });
  return out;
}

/**
 * Expand selected node paths to their descendant meshes, deduped.
 *
 * A selection may contain both an ancestor and one of its descendants; the Set
 * keeps each mesh painted exactly once so `prev` has no duplicate entries (a
 * duplicate would make undo order-dependent).
 */
export function expandSelectionToMeshes(
  registry: NodeRegistry,
  nodePaths: string[],
): Array<{ mesh: Mesh; path: string }> {
  const seen = new Set<Mesh>();
  const out: Array<{ mesh: Mesh; path: string }> = [];
  for (const nodePath of nodePaths) {
    const node = registry.getNode(nodePath);
    if (!node) continue;
    for (const mesh of collectPaintableMeshes(node)) {
      if (seen.has(mesh)) continue;
      seen.add(mesh);
      out.push({ mesh, path: NodeRegistry.computeNodePath(mesh) });
    }
  }
  return out;
}

/**
 * Resolve the inverse payload for a `setMaterial` op.
 *
 * A mesh whose current material cannot be expressed as a `MaterialValue` —
 * it carries texture maps, or is not a MeshStandardMaterial — records `null`.
 * The executor stashes those originals in its trash bin and re-attaches the
 * exact instance on undo, so textures survive a paint/undo round-trip.
 */
export function captureMaterialPrev(
  registry: NodeRegistry,
  nodePaths: string[],
): Array<{ meshPath: string; material: MaterialValue | null }> {
  return expandSelectionToMeshes(registry, nodePaths).map(({ mesh, path }) => ({
    meshPath: path,
    material: materialToValue(mesh.material as Material),
  }));
}

/** True when the material is a plain, untextured MeshStandardMaterial. */
function isPlainStandard(mat: Material): mat is MeshStandardMaterial {
  const m = mat as MeshStandardMaterial;
  if (!(m as { isMeshStandardMaterial?: boolean }).isMeshStandardMaterial) return false;
  return !m.map && !m.normalMap && !m.roughnessMap && !m.metalnessMap
    && !m.aoMap && !m.emissiveMap && !m.alphaMap && !m.lightMap;
}

/**
 * Losslessly describe a material as a `MaterialValue`, or `null` when it carries
 * data the value type cannot hold (textures, non-standard material types).
 */
export function materialToValue(mat: Material | null | undefined): MaterialValue | null {
  if (!mat || !isPlainStandard(mat)) return null;
  const emissive = mat.emissive ? `#${mat.emissive.getHexString()}` : '#000000';
  return {
    name: mat.name || 'Material',
    color: `#${mat.color.getHexString()}`,
    metalness: mat.metalness,
    roughness: mat.roughness,
    opacity: mat.opacity,
    transparent: mat.transparent,
    ...(emissive !== '#000000'
      ? { emissive, emissiveIntensity: mat.emissiveIntensity }
      : {}),
  };
}

/** Stable identity for a `MaterialValue` — the cache key and equality test. */
export function materialValueKey(v: MaterialValue): string {
  const q = (n: number) => String(Math.round(n * 1000));
  return [
    v.color, q(v.metalness), q(v.roughness), q(v.opacity),
    v.transparent ? '1' : '0', v.emissive ?? '-', q(v.emissiveIntensity ?? 1),
  ].join('|');
}

/**
 * Shared material instances, one per distinct value.
 *
 * Module-level and deliberately never evicted per-model: the set of distinct
 * preset values a user paints in a session is small and bounded, and the
 * instances must outlive an undo/redo cycle (a redo re-attaches the same value).
 * `disposeMaterialCache` clears it on viewer teardown.
 */
const CACHE = new Map<string, MeshStandardMaterial>();

/**
 * Get-or-create the shared material for a value.
 *
 * The returned instance is shared — callers assign it, and must never mutate it.
 * To change appearance, build a new `MaterialValue` and ask for that instead.
 */
export function materialForValue(v: MaterialValue): MeshStandardMaterial {
  const key = materialValueKey(v);
  const hit = CACHE.get(key);
  if (hit) return hit;

  const mat = new MeshStandardMaterial({
    name: v.name,
    color: new Color(v.color),
    metalness: v.metalness,
    roughness: v.roughness,
    opacity: v.opacity,
    // Opacity < 1 implies transparency even if the preset forgot the flag —
    // otherwise the value renders fully opaque and the slider looks broken.
    transparent: v.transparent || v.opacity < 1,
  });
  if (v.emissive) {
    mat.emissive = new Color(v.emissive);
    mat.emissiveIntensity = v.emissiveIntensity ?? 1;
  }
  // Painted parts are usually CAD solids seen from outside, but transparent
  // presets (glass, guards) read as paper-thin without back faces.
  if (mat.transparent) mat.side = DoubleSide;

  CACHE.set(key, mat);
  return mat;
}

/**
 * Index every paintable mesh in the asset by the value-key of its current
 * material.
 *
 * Backs the Materials window's "Select" action: given a preset, look up its
 * key here to find every part that currently wears that exact flat appearance.
 * Built once per stats recompute and shared across all preset rows, so the
 * asset is walked once rather than once per preset.
 *
 * Meshes whose material carries textures or is non-standard are absent by
 * design — a flat preset cannot match them, so they must not be selectable
 * through it.
 */
export function indexMeshPathsByMaterialValue(root: Object3D | null): Map<string, string[]> {
  const index = new Map<string, string[]>();
  if (!root) return index;
  for (const { mesh, path } of collectPaintableMeshesWithPaths(root)) {
    const value = materialToValue(mesh.material as Material);
    if (!value) continue;
    const key = materialValueKey(value);
    const bucket = index.get(key);
    if (bucket) bucket.push(path);
    else index.set(key, [path]);
  }
  return index;
}

/** Paintable meshes under `root` paired with their registry paths. */
function collectPaintableMeshesWithPaths(root: Object3D): Array<{ mesh: Mesh; path: string }> {
  return collectPaintableMeshes(root).map((mesh) => ({
    mesh,
    path: NodeRegistry.computeNodePath(mesh),
  }));
}

/** Release every cached material. Call on viewer teardown. */
export function disposeMaterialCache(): void {
  for (const mat of CACHE.values()) mat.dispose();
  CACHE.clear();
}
