// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * select-actions.ts — "Select ▸" actions on the editor selection.
 *
 * Backs the editor context menu's "Select ▸" submenu (also on the S shortcut):
 *   Identical — every mesh whose geometry matches a seed mesh by CONTENT
 *               signature (vertex/index counts + sorted quantized sample of
 *               vertex distances from the centroid). Reference identity is
 *               not enough: the uber-material bake clones shared geometries
 *               per (geometry, material) pair, and CAD (STEP) imports
 *               tessellate every occurrence separately — often with the
 *               part's placement baked into the vertex data. The signature
 *               is invariant under rigid transforms (translation, rotation,
 *               mirror), so all copies of a part match wherever they sit.
 *               Material is ignored — recolored copies count as identical.
 *   Material  — every mesh sharing a material with the seed meshes, by
 *               reference OR by appearance fingerprint (rv-material-dedup),
 *               so visually-identical materials the dedup pass didn't collapse
 *               still match. Multi-material meshes match on ANY slot.
 *   Invert    — every selectable mesh not currently selected (selected group
 *               paths count their descendant meshes as selected).
 *
 * All three operate on the marquee's selectable universe (effectively-visible,
 * non-authored-hidden leaf meshes) — hidden objects are never swept in — and
 * REPLACE the selection with the full matching set, seeds included.
 *
 * The set computations are pure functions over the universe map so they are
 * unit-testable without an RVViewer.
 */

import type { BufferGeometry, Material, Mesh, Object3D } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import type { ContextMenuItem } from '../../core/hmi/context-menu-store';
import { fingerprint } from '../../core/engine/rv-material-dedup';

/** Selectable universe: editor path → leaf mesh (see buildEditorSelectableMap). */
export type SelectableMap = ReadonlyMap<string, Object3D>;

/**
 * Expand arbitrary node paths (leaf meshes AND groups) to the universe mesh
 * paths they cover: a path contributes itself if it is a universe mesh, plus
 * every universe mesh underneath it. O(universe × path depth) — each mesh
 * path's ancestor chain is checked against the input set.
 */
export function expandToUniverseMeshes(
  universe: SelectableMap,
  paths: readonly string[],
): Set<string> {
  const roots = new Set(paths);
  const out = new Set<string>();
  if (roots.size === 0) return out;
  for (const meshPath of universe.keys()) {
    let ancestor = meshPath;
    for (;;) {
      if (roots.has(ancestor)) { out.add(meshPath); break; }
      const cut = ancestor.lastIndexOf('/');
      if (cut < 0) break;
      ancestor = ancestor.slice(0, cut);
    }
  }
  return out;
}

/** Materials of a mesh as a flat array (handles single and Material[] slots). */
function meshMaterials(mesh: Mesh): Material[] {
  const m = mesh.material;
  return Array.isArray(m) ? m : m ? [m] : [];
}

// ─── Geometry content signature ─────────────────────────────────────────

/** Quantile count of the radial-distance profile (includes min and max). */
const SIGNATURE_QUANTILES = 33;
/** Absolute tolerance floor when comparing profiles: 0.1 mm at meter scale. */
const SIGNATURE_ABS_TOL = 1e-4;
/** Relative tolerance vs. the part's max radius — absorbs float noise
 *  between independent tessellations of the same part. */
const SIGNATURE_REL_TOL = 1e-3;

/**
 * Content signature of a geometry: vertex/index counts + quantiles of the
 * distribution of vertex distances from the centroid (the radial profile).
 * Computed over ALL vertices, so it is independent of vertex ORDER — two
 * tessellations that emit the same vertex set in a different sequence still
 * match. Distances from the centroid are unchanged by translation, rotation
 * and mirroring, so copies match wherever their baked placement puts them.
 */
export interface GeometrySignature {
  vCount: number;
  iCount: number;
  /** SIGNATURE_QUANTILES sorted radii, quantiles[last] = max radius. */
  quantiles: Float64Array;
}

/** Signature per BufferGeometry, computed once — geometries are immutable
 *  after load, so the WeakMap never needs invalidation. */
const signatureCache = new WeakMap<BufferGeometry, GeometrySignature>();

export function geometrySignature(geom: BufferGeometry): GeometrySignature {
  const cached = signatureCache.get(geom);
  if (cached !== undefined) return cached;

  const pos = geom.attributes.position;
  const vCount = pos?.count ?? 0;
  const iCount = geom.index ? geom.index.count : -1;
  const quantiles = new Float64Array(SIGNATURE_QUANTILES);
  if (pos && vCount > 0) {
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < vCount; i++) {
      cx += pos.getX(i); cy += pos.getY(i); cz += pos.getZ(i);
    }
    cx /= vCount; cy /= vCount; cz /= vCount;

    const dists = new Float64Array(vCount);
    for (let i = 0; i < vCount; i++) {
      const dx = pos.getX(i) - cx, dy = pos.getY(i) - cy, dz = pos.getZ(i) - cz;
      dists[i] = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    dists.sort();
    for (let q = 0; q < SIGNATURE_QUANTILES; q++) {
      quantiles[q] = dists[Math.floor((q * (vCount - 1)) / (SIGNATURE_QUANTILES - 1))];
    }
  }
  const sig: GeometrySignature = { vCount, iCount, quantiles };
  signatureCache.set(geom, sig);
  return sig;
}

/**
 * Tolerance-based signature match: exact on counts, epsilon on the radial
 * profile. A tolerance comparison (instead of hashing quantized values)
 * avoids quantization-boundary flapping — a distance landing exactly on a
 * rounding edge can otherwise round apart between two noisy copies.
 */
export function signaturesMatch(a: GeometrySignature, b: GeometrySignature): boolean {
  if (a.vCount !== b.vCount || a.iCount !== b.iCount) return false;
  const maxRadius = Math.max(
    a.quantiles[SIGNATURE_QUANTILES - 1],
    b.quantiles[SIGNATURE_QUANTILES - 1],
  );
  const tol = Math.max(SIGNATURE_ABS_TOL, maxRadius * SIGNATURE_REL_TOL);
  for (let q = 0; q < SIGNATURE_QUANTILES; q++) {
    if (Math.abs(a.quantiles[q] - b.quantiles[q]) > tol) return false;
  }
  return true;
}

/** Universe meshes whose geometry matches any seed mesh's content signature. */
export function computeIdenticalPaths(
  universe: SelectableMap,
  seedMeshPaths: ReadonlySet<string>,
): string[] {
  // Deduplicate seed signatures against each other so the per-mesh loop
  // compares against as few profiles as possible.
  const seedSigs: GeometrySignature[] = [];
  for (const path of seedMeshPaths) {
    const mesh = universe.get(path) as Mesh | undefined;
    if (!mesh?.isMesh || !mesh.geometry) continue;
    const sig = geometrySignature(mesh.geometry);
    if (!seedSigs.some((s) => signaturesMatch(s, sig))) seedSigs.push(sig);
  }
  if (seedSigs.length === 0) return [];
  const out: string[] = [];
  for (const [path, obj] of universe) {
    const geom = (obj as Mesh).geometry;
    if (!geom) continue;
    const sig = geometrySignature(geom);
    if (seedSigs.some((s) => signaturesMatch(s, sig))) out.push(path);
  }
  return out;
}

/**
 * Universe meshes sharing a material with any seed mesh — by reference or by
 * appearance fingerprint. Reference check first (cheap, and covers materials
 * the dedup pass already collapsed); fingerprints are computed lazily only
 * for meshes that miss the reference fast-path.
 */
export function computeSameMaterialPaths(
  universe: SelectableMap,
  seedMeshPaths: ReadonlySet<string>,
): string[] {
  const seedRefs = new Set<Material>();
  const seedPrints = new Set<string>();
  for (const path of seedMeshPaths) {
    const mesh = universe.get(path) as Mesh | undefined;
    if (!mesh?.isMesh) continue;
    for (const mat of meshMaterials(mesh)) {
      seedRefs.add(mat);
      seedPrints.add(fingerprint(mat));
    }
  }
  if (seedRefs.size === 0) return [];
  const out: string[] = [];
  for (const [path, obj] of universe) {
    const mats = meshMaterials(obj as Mesh);
    const match = mats.some((mat) => seedRefs.has(mat) || seedPrints.has(fingerprint(mat)));
    if (match) out.push(path);
  }
  return out;
}

/** Universe meshes NOT covered by the current selection (groups expanded). */
export function computeInvertPaths(
  universe: SelectableMap,
  selectedPaths: readonly string[],
): string[] {
  const selected = expandToUniverseMeshes(universe, selectedPaths);
  const out: string[] = [];
  for (const path of universe.keys()) {
    if (!selected.has(path)) out.push(path);
  }
  return out;
}

/**
 * Seed paths for Identical/Material: the whole selection when the clicked
 * node is part of it, otherwise just the clicked node — same convention as
 * the editor's Hide/Show items.
 */
export function resolveSeedPaths(
  selectedPaths: readonly string[],
  clickedPath: string,
): string[] {
  return selectedPaths.includes(clickedPath) ? [...selectedPaths] : [clickedPath];
}

/**
 * Menu items of the Select picker: Identical / Material / Invert with live
 * match counts in the labels, computed at menu-open time. Items with zero
 * matches are omitted (the store auto-hides the parent when all are gone).
 * Used by the context menu's "Select ▸" submenu AND the S keyboard shortcut
 * (which opens the same list standalone at the cursor via openItems).
 */
export function buildSelectMenuItems(
  viewer: RVViewer,
  target: { path: string },
  getUniverse: () => SelectableMap,
): ContextMenuItem[] {
  const universe = getUniverse();
  const selectedPaths = viewer.selectionManager.getSnapshot().selectedPaths;
  const seeds = expandToUniverseMeshes(universe, resolveSeedPaths(selectedPaths, target.path));

  const identical = computeIdenticalPaths(universe, seeds);
  const material = computeSameMaterialPaths(universe, seeds);
  const invert = computeInvertPaths(universe, selectedPaths);

  const items: ContextMenuItem[] = [];
  const add = (id: string, label: string, shortcut: string, order: number, paths: string[]): void => {
    if (paths.length === 0) return;
    items.push({
      id,
      label: `${label} (${paths.length})`,
      shortcut,
      order,
      action: () => viewer.selectionManager.selectPaths(paths),
    });
  };
  // Chord letters (S › I / S › M / S › V) — activated by ContextMenuLayer's
  // shortcut matching while the menu is open; V for inVert since I is taken.
  add('editor.select.identical', 'Identical', 'I', 0, identical);
  add('editor.select.material', 'Material', 'M', 1, material);
  add('editor.select.invert', 'Invert', 'V', 2, invert);
  return items;
}
