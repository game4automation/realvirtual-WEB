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
 * Editor-mode only. See contract-bake-picking.md §1.1: editor mode loads with
 * `preserveHierarchy: true`, so no bake exists and a plain `mesh.material = …`
 * survives the GLB export. What the editor DRAWS is its arenas (plan-766,
 * §2.5; the sources render at `layers.mask = 0`): the assignment reaches the
 * screen through the `setMaterial` op, whose apply listener re-colours or
 * re-buckets the mesh's arena instance. A material write outside that op would
 * stay invisible until `viewer.editorArena.reconcile()`.
 */

import { Object3D, Mesh, Material, MeshStandardMaterial, Color, DoubleSide, TextureLoader, RepeatWrapping, SRGBColorSpace, NoColorSpace, Texture } from 'three';
import type { MaterialValue } from './rv-asset-ops';
import { NodeRegistry } from '../engine/rv-node-registry';
import { isOwnedContent } from '../engine/rv-reference-scope';

/**
 * Runtime helpers (gizmos, overlays, sensor viz) never take a user material.
 *
 * Decided by explicit metadata, not by a leading `_`: CAD and Unity exports
 * carry legitimate part names like `_CADpart`, and treating them as helpers
 * silently left them unpainted. The `__` prefix stays a helper marker because
 * it is the reserved runtime-object convention (`__rvTransformGizmo`,
 * `__muPool_…`, `__statusOutlineProxy_…`) that many overlays rely on without
 * setting a flag.
 */
function isRuntimeHelper(node: Object3D): boolean {
  const ud = node.userData;
  if (ud?._rvGizmo === true || ud?._rvGizmoOverlay === true || ud?._rvSynthetic === true) return true;
  return node.name.startsWith('__');
}

/**
 * Every mesh at or under `node`, skipping runtime-helper subtrees.
 *
 * Multi-material meshes are included: the executor paints every slot of the
 * array with the preset, so `geometry.groups` keep their face ranges and the
 * whole mesh changes. (They used to be skipped, which left them unpainted
 * without anyone being told.)
 */
export function collectPaintableMeshes(node: Object3D): Mesh[] {
  const out: Mesh[] = [];
  node.traverse((child) => {
    if (isRuntimeHelper(child)) return;
    const mesh = child as Mesh;
    if (!(mesh as { isMesh?: boolean }).isMesh) return;
    const mat = mesh.material;
    if (!mat || (Array.isArray(mat) && mat.length === 0)) return;
    out.push(mesh);
  });
  return out;
}

/** Why a requested path contributed no mesh to a material assignment. */
export type MaterialSkipReason =
  /** The path resolves to nothing in the scene. */
  | 'unresolved'
  /** The node (or everything under it) is placed reference content — baked, owned by another file. */
  | 'placed-reference'
  /** The node exists but carries no paintable mesh at or under it. */
  | 'no-mesh';

/** The meshes a material assignment will paint, plus every requested path that yields none. */
export interface MaterialAssignmentPlan {
  /** Requested paths that contribute at least one mesh — the op's `nodePaths`. */
  nodePaths: string[];
  /** Deduped meshes to paint with their registry paths. */
  targets: Array<{ mesh: Mesh; path: string }>;
  /** Requested paths that contribute nothing, with the reason. */
  skipped: Array<{ path: string; reason: MaterialSkipReason }>;
}

/**
 * Plan a material assignment over `nodePaths`: which meshes it paints and
 * which requested paths it cannot reach (and why).
 *
 * Placed reference content is excluded mesh by mesh: an `AssetOverrides` patch
 * carries components, not materials, so painting it from this document is not
 * expressible (the reference guard refuses the whole op). Excluding it here
 * keeps one placed part in a selection from sinking the rest of the assignment.
 */
export function planMaterialAssignment(
  registry: NodeRegistry,
  nodePaths: string[],
): MaterialAssignmentPlan {
  const seen = new Set<Mesh>();
  const plan: MaterialAssignmentPlan = { nodePaths: [], targets: [], skipped: [] };
  for (const nodePath of nodePaths) {
    const node = registry.getNode(nodePath);
    if (!node) { plan.skipped.push({ path: nodePath, reason: 'unresolved' }); continue; }
    if (!isOwnedContent(node)) { plan.skipped.push({ path: nodePath, reason: 'placed-reference' }); continue; }
    const all = collectPaintableMeshes(node);
    const owned = all.filter((mesh) => isOwnedContent(mesh));
    if (owned.length === 0) {
      plan.skipped.push({ path: nodePath, reason: all.length > 0 ? 'placed-reference' : 'no-mesh' });
      continue;
    }
    plan.nodePaths.push(nodePath);
    for (const mesh of owned) {
      if (seen.has(mesh)) continue;
      seen.add(mesh);
      plan.targets.push({ mesh, path: NodeRegistry.computeNodePath(mesh) });
    }
  }
  return plan;
}

/** The one material of a mesh as a value — `null` for a material array (exact undo goes through the executor stash). */
function meshMaterialToValue(mesh: Mesh): MaterialValue | null {
  return Array.isArray(mesh.material) ? null : materialToValue(mesh.material);
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
    material: meshMaterialToValue(mesh),
  }));
}

/** {@link captureMaterialPrev} over an already-built {@link planMaterialAssignment}. */
export function materialPrevOfPlan(
  plan: MaterialAssignmentPlan,
): Array<{ meshPath: string; material: MaterialValue | null }> {
  return plan.targets.map(({ mesh, path }) => ({ meshPath: path, material: meshMaterialToValue(mesh) }));
}

/** Material extras key of a preset assignment (plan-675; written by GLTFExporter as `extras`). */
export const RV_MATERIAL_PRESET_KEY = 'rvMaterialPreset';

/** What a preset assignment leaves in `material.userData.rvMaterialPreset` (and thus the GLB). */
export interface MaterialPresetExtras {
  presetId: string;
  textureScaleU?: number;
  textureScaleV?: number;
  spin?: 'roller';
}

/** Looks a preset up by id — registered by the asset editor's preset library (plan-675). */
export type MaterialPresetResolver = (presetId: string) => MaterialValue | null;
let presetResolver: MaterialPresetResolver | null = null;

/**
 * Register the preset library that rehydrates a reloaded material from its
 * `rvMaterialPreset.presetId` (the textures are embedded in the GLB, but their
 * identity — the data URL a value compares by — is not: glTF keeps no texture
 * extras).
 */
export function registerMaterialPresetResolver(resolver: MaterialPresetResolver | null): void {
  presetResolver = resolver;
}

/** The preset extras of a material, if it carries any. */
export function materialPresetExtras(mat: Material | null | undefined): MaterialPresetExtras | null {
  const raw = (mat?.userData as Record<string, unknown> | undefined)?.[RV_MATERIAL_PRESET_KEY] as MaterialPresetExtras | undefined;
  return raw && typeof raw === 'object' && (typeof raw.presetId === 'string' || raw.spin) ? raw : null;
}

/** Preset ids of roller-mantle presets authored for cylindrical UVs start with this. */
export const MANTLE_PRESET_PREFIX = 'tex-roller-';

/** The roller-mantle presets are authored for cylindrical UVs (u = revolutions). */
function isMantlePreset(v: MaterialValue): boolean {
  return v.spin === 'roller' || (v.presetId?.startsWith(MANTLE_PRESET_PREFIX) ?? false);
}

/**
 * Texture repeat of a value: planar/box UVs are metres, so a scale of "metres
 * per tile" becomes `1 / scale` tiles per UV unit; a mantle's u counts
 * revolutions, so "tiles per revolution" IS the repeat. V is metres either way.
 */
export function textureRepeatOf(v: MaterialValue): [number, number] {
  const su = v.textureScaleU ?? 1;
  const sv = v.textureScaleV ?? 1;
  const u = isMantlePreset(v) ? su : 1 / (su > 0 ? su : 1);
  return [u, 1 / (sv > 0 ? sv : 1)];
}

const PRESET_MAP_SLOTS = ['map', 'roughnessMap', 'metalnessMap', 'normalMap'] as const;

/** True when a standard material can be represented by an editor preset. */
function isPlainStandard(mat: Material): mat is MeshStandardMaterial {
  const m = mat as MeshStandardMaterial;
  if (!(m as { isMeshStandardMaterial?: boolean }).isMeshStandardMaterial) return false;
  if (m.aoMap || m.emissiveMap || m.alphaMap || m.lightMap) return false;
  // A preset assignment the library can rehydrate stands for itself, maps and all.
  const extras = materialPresetExtras(m);
  if (extras?.presetId && presetResolver?.(extras.presetId)) return true;
  // Otherwise every map must be a known preset map (identity by data URL).
  for (const slot of PRESET_MAP_SLOTS) {
    const t = m[slot];
    if (t && typeof t.userData?.rvPresetTexture !== 'string') return false;
  }
  return true;
}

/**
 * Losslessly describe a material as a `MaterialValue`, or `null` when it carries
 * data the value type cannot hold (foreign textures, non-standard material types).
 */
export function materialToValue(mat: Material | null | undefined): MaterialValue | null {
  if (!mat || !isPlainStandard(mat)) return null;
  const emissive = mat.emissive ? `#${mat.emissive.getHexString()}` : '#000000';
  const extras = materialPresetExtras(mat);
  // plan-675: a reloaded preset material gets its map identities back from the library.
  const preset = extras?.presetId ? presetResolver?.(extras.presetId) ?? null : null;
  const texId = (t: Texture | null | undefined): string | undefined =>
    (t && typeof t.userData?.rvPresetTexture === 'string') ? t.userData.rvPresetTexture as string : undefined;
  const texture = texId(mat.map) ?? (mat.map ? preset?.texture : undefined);
  const ormTexture = texId(mat.roughnessMap) ?? (mat.roughnessMap ? preset?.ormTexture : undefined);
  const normalTexture = texId(mat.normalMap) ?? (mat.normalMap ? preset?.normalTexture : undefined);
  return {
    name: mat.name || 'Material',
    color: `#${mat.color.getHexString()}`,
    metalness: mat.metalness,
    roughness: mat.roughness,
    opacity: mat.opacity,
    transparent: mat.transparent,
    ...(texture ? { texture } : {}),
    ...(ormTexture ? { ormTexture } : {}),
    ...(normalTexture ? { normalTexture } : {}),
    ...(extras?.presetId ? { presetId: extras.presetId } : {}),
    ...(extras?.textureScaleU !== undefined ? { textureScaleU: extras.textureScaleU } : {}),
    ...(extras?.textureScaleV !== undefined ? { textureScaleV: extras.textureScaleV } : {}),
    ...(extras?.spin ? { spin: extras.spin } : {}),
    ...(emissive !== '#000000'
      ? { emissive, emissiveIntensity: mat.emissiveIntensity }
      : {}),
  };
}

/** Stable identity for a `MaterialValue` — the cache key and equality test. */
export function materialValueKey(v: MaterialValue): string {
  const q = (n: number) => String(Math.round(n * 1000));
  const parts = [
    v.color, q(v.metalness), q(v.roughness), q(v.opacity),
    v.transparent ? '1' : '0', v.emissive ?? '-', q(v.emissiveIntensity ?? 1),
    v.texture ?? '',
  ];
  // plan-675 fields only when present — every key of a pre-675 value stays byte-identical.
  if (v.ormTexture || v.normalTexture || v.presetId || v.textureScaleU !== undefined
    || v.textureScaleV !== undefined || v.spin) {
    parts.push(v.ormTexture ?? '', v.normalTexture ?? '', v.presetId ?? '',
      v.textureScaleU !== undefined ? q(v.textureScaleU) : '', v.textureScaleV !== undefined ? q(v.textureScaleV) : '',
      v.spin ?? '');
  }
  return parts.join('|');
}

/**
 * Shared material instances, one per distinct value.
 *
 * Module-level and deliberately never evicted per-model: the set of distinct
 * preset values a user paints in a session is small and bounded, and the
 * instances must outlive an undo/redo cycle (a redo re-attaches the same value).
 * `disposeMaterialCache` clears it on viewer teardown.
 */
const TEXTURE_READY = new WeakMap<Texture, Promise<void>>();

/** Wait for assigned library maps before serializing an asset. */
export async function waitForMaterialTextures(root: Object3D): Promise<void> {
  const pending = new Set<Promise<void>>();
  root.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const m = mat as MeshStandardMaterial;
      for (const slot of PRESET_MAP_SLOTS) {
        const t = m?.[slot];
        const ready = t && TEXTURE_READY.get(t);
        if (ready) pending.add(ready);
      }
    }
  });
  await Promise.all(pending);
}

const CACHE = new Map<string, MeshStandardMaterial>();

/**
 * One decoded image per data URL (plan-675): materials that use the same preset
 * map in different colours or scales get CLONES of one base texture — own
 * sampler / repeat, shared `source`, so one GPU upload.
 */
interface BaseTexture { tex: Texture; ready: Promise<void>; clones: Set<Texture> }
const BASE_TEXTURES = new Map<string, BaseTexture>();

function baseTexture(url: string): BaseTexture {
  const hit = BASE_TEXTURES.get(url);
  if (hit) return hit;
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const ready = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  // Rendering may precede export; retain failures without an unhandled rejection.
  void ready.catch(() => {});
  const entry: BaseTexture = { tex: null as unknown as Texture, ready, clones: new Set() };
  entry.tex = new TextureLoader().load(url, () => {
    // A clone made before the image arrived shares the source but not the
    // texture version — bump each so the renderer uploads it.
    for (const c of entry.clones) c.needsUpdate = true;
    resolve();
  }, undefined, reject);
  BASE_TEXTURES.set(url, entry);
  return entry;
}

/** A material-owned map for `url`: shared image, own colour space / wrap / repeat. */
function presetMap(url: string, srgb: boolean, repeat: [number, number]): Texture {
  const base = baseTexture(url);
  const t = base.tex.clone();
  base.clones.add(t);
  t.flipY = false;
  t.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.userData.rvPresetTexture = url;
  if (base.tex.image) t.needsUpdate = true;
  TEXTURE_READY.set(t, base.ready);
  return t;
}

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
  const repeat = textureRepeatOf(v);
  if (v.texture) mat.map = presetMap(v.texture, true, repeat);
  if (v.ormTexture) {
    // glTF metallicRoughness layout: ONE texture in both slots (G / B); the
    // exporter writes it once.
    const orm = presetMap(v.ormTexture, false, repeat);
    mat.roughnessMap = orm;
    mat.metalnessMap = orm;
  }
  if (v.normalTexture) mat.normalMap = presetMap(v.normalTexture, false, repeat);
  if (v.presetId || v.spin) {
    const extras: MaterialPresetExtras = {
      presetId: v.presetId ?? '',
      ...(v.textureScaleU !== undefined ? { textureScaleU: v.textureScaleU } : {}),
      ...(v.textureScaleV !== undefined ? { textureScaleV: v.textureScaleV } : {}),
      ...(v.spin ? { spin: v.spin } : {}),
    };
    mat.userData[RV_MATERIAL_PRESET_KEY] = extras;
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
    const value = meshMaterialToValue(mesh);
    if (!value) continue;
    const key = materialValueKey(value);
    const bucket = index.get(key);
    if (bucket) bucket.push(path);
    else index.set(key, [path]);
  }
  return index;
}

/**
 * Paintable meshes of `root`'s OWNED content paired with their registry paths.
 * plan-774 F9: a placed reference is baked and cannot be painted from this
 * document (the guard refuses `setMaterial` there), so its chunks are no
 * candidates of a preset's "Select".
 */
function collectPaintableMeshesWithPaths(root: Object3D): Array<{ mesh: Mesh; path: string }> {
  return collectPaintableMeshes(root)
    .filter((mesh) => isOwnedContent(mesh, root))
    .map((mesh) => ({
      mesh,
      path: NodeRegistry.computeNodePath(mesh),
    }));
}

/** Release every cached material. Call on viewer teardown. */
export function disposeMaterialCache(): void {
  for (const mat of CACHE.values()) {
    mat.map?.dispose();
    mat.normalMap?.dispose();
    mat.roughnessMap?.dispose();
    mat.dispose();
  }
  CACHE.clear();
  for (const b of BASE_TEXTURES.values()) b.tex.dispose();
  BASE_TEXTURES.clear();
}
