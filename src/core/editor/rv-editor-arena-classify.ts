// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Editor arena classification + planning (plan-766 Phase 2, §2.4.1 steps 1–2).
 *
 * PURE functions — no scene mutation, no GPU — so the bucket rule, the
 * threshold and the capacity arithmetic are node-testable on their own
 * (`tests/editor-arena-classify.node.test.ts`).
 *
 * Classification of one mesh:
 *   1. not drawable as an arena instance → `standalone`: SkinnedMesh, morph
 *      targets, InstancedMesh / BatchedMesh, a non-default `drawRange`,
 *      a material ARRAY (geometry `groups` only matter with one), a missing material, a
 *      `ShaderMaterial` (no batching chunks) or a material with its own
 *      `onBeforeCompile` patch;
 *   2. the node or an ancestor has bake role `keep` (`bakeRoleOf`) → `standalone`;
 *   3. `transparent`, `opacity < 1`, `alphaTest > 0` → `standalone`;
 *   4. `isUberEligible(material)` → `uber` (one arena, colour/rm per instance);
 *   5. otherwise → `material` (one arena per material × attribute layout).
 *
 * Planning then groups the classified meshes into buckets, demotes material
 * buckets below the threshold (16) to standalone, deduplicates geometry by
 * `(geometry.uuid, mirrored)` and sizes each arena with the reserve
 * (instances n·1.25 + 64, vertices V·1.25, indices I·1.25).
 *
 * Effectively hidden meshes are NOT excluded here — they become instances
 * that the manager marks invisible (`setVisibleAt(false)`); their `.visible`
 * is never touched.
 */

import type { BufferGeometry, Material, Mesh, Object3D } from 'three';
import type { BakeRole } from '../engine/rv-bake-chunk';
import { isUberEligible } from '../engine/rv-uber-material';
import {
  EDITOR_UBER_LAYOUT,
  arenaLayoutSignature,
  editorTexturedLayoutOf,
  type ArenaAttrSpec,
} from '../engine/rv-mesh-merge-batch';

/** Arena kind of one mesh. */
export type ArenaClass = 'uber' | 'material' | 'standalone';

/** Default minimum mesh count of a textured/material bucket (below → standalone). */
export const ARENA_MATERIAL_THRESHOLD = 16;
/** Default capacity reserve (fraction on top of the planned counts). */
export const ARENA_RESERVE = 0.25;
/** Extra instance slots on top of the reserve (imports of a few parts never grow). */
export const ARENA_INSTANCE_SLACK = 64;

/** Signature of the uber arena layout (`position:3|normal:3`). */
export const UBER_ARENA_SIGNATURE = arenaLayoutSignature(EDITOR_UBER_LAYOUT);

/** Why a mesh ended up standalone (diagnostics + tests). */
export type StandaloneReason =
  | 'keep' | 'transparent' | 'multi-material' | 'no-material' | 'custom-shader'
  | 'skinned' | 'morph' | 'instanced' | 'draw-range' | 'below-threshold';

/** Role lookup injected by the caller (`bakeRoleOf` in production). */
export type RoleOf = (node: Object3D) => BakeRole | undefined;

/**
 * Reason a mesh can never be an arena instance, or `null` when it can.
 * Checks geometry/object shape and the material (steps 1–3 above), but not
 * the bake role — see {@link classifyMesh}.
 */
export function standaloneReasonOf(mesh: Mesh): StandaloneReason | null {
  const m = mesh as Mesh & {
    isSkinnedMesh?: boolean; isInstancedMesh?: boolean; isBatchedMesh?: boolean;
  };
  if (m.isSkinnedMesh) return 'skinned';
  if (m.isInstancedMesh || m.isBatchedMesh) return 'instanced';
  if (mesh.morphTargetInfluences && mesh.morphTargetInfluences.length > 0) return 'morph';
  const geom = mesh.geometry as BufferGeometry | undefined;
  if (geom) {
    if (geom.morphAttributes && Object.keys(geom.morphAttributes).length > 0) return 'morph';
    // Geometry `groups` matter only with a material ARRAY (three ignores them for a
    // single material, and so does the arena) — that case is 'multi-material' below.
    const dr = geom.drawRange;
    if (dr && (dr.start !== 0 || dr.count !== Infinity)) return 'draw-range';
  }
  const mat = mesh.material as Material | Material[] | null | undefined;
  if (Array.isArray(mat)) return 'multi-material';
  if (!mat) return 'no-material';
  const sm = mat as Material & { isShaderMaterial?: boolean; isRawShaderMaterial?: boolean };
  if (sm.isShaderMaterial || sm.isRawShaderMaterial) return 'custom-shader';
  // An own onBeforeCompile = a patched shader the arena cannot reproduce for
  // other instances (the prototype's no-op does not count).
  if (Object.prototype.hasOwnProperty.call(mat, 'onBeforeCompile')) return 'custom-shader';
  if (mat.transparent || mat.opacity < 1 || mat.alphaTest > 0) return 'transparent';
  return null;
}

/** True when `node` or any ancestor has bake role `keep`. */
export function hasKeepRole(node: Object3D, roleOf: RoleOf): boolean {
  let cur: Object3D | null = node;
  while (cur) {
    if (roleOf(cur) === 'keep') return true;
    cur = cur.parent;
  }
  return false;
}

/** Classify one mesh (plan-766 §2.3 signature). */
export function classifyMesh(mesh: Mesh, roleOf: RoleOf): ArenaClass {
  return classifyMeshDetailed(mesh, roleOf).kind;
}

/** {@link classifyMesh} plus the standalone reason. */
export function classifyMeshDetailed(
  mesh: Mesh, roleOf: RoleOf,
): { kind: ArenaClass; reason?: StandaloneReason } {
  const reason = standaloneReasonOf(mesh);
  if (reason) return { kind: 'standalone', reason };
  if (hasKeepRole(mesh, roleOf)) return { kind: 'standalone', reason: 'keep' };
  return { kind: isUberEligible(mesh.material as Material) ? 'uber' : 'material' };
}

/** True when the mesh's world matrix mirrors (negative determinant). */
export function isMirrored(mesh: Mesh): boolean {
  return mesh.matrixWorld.determinant() < 0;
}

/** Geometry dedup key of one instance — mirrored copies are separate geometries. */
export function geometryKeyOf(geometry: BufferGeometry, mirrored: boolean): string {
  return `${geometry.uuid}|${mirrored ? 1 : 0}`;
}

/** Layout of the arena a mesh of `kind` belongs to. */
export function arenaLayoutFor(kind: 'uber' | 'material', mesh: Mesh): ArenaAttrSpec[] {
  if (kind === 'uber') return EDITOR_UBER_LAYOUT.slice();
  return editorTexturedLayoutOf(mesh.geometry, mesh.material as Material & { vertexColors?: boolean; normalMap?: unknown });
}

/** Bucket key: `uber|<sig>` or `mat:<material uuid>|<sig>`. */
export function bucketKeyOf(kind: 'uber' | 'material', material: Material | null, signature: string): string {
  return kind === 'uber' ? `uber|${signature}` : `mat:${material!.uuid}|${signature}`;
}

/** Staged vertex / index counts of one geometry in an arena (always indexed). */
export function stagedSizeOf(geometry: BufferGeometry): { vertices: number; indices: number } {
  const pos = geometry.getAttribute('position');
  const vertices = pos ? pos.count : 0;
  const indices = geometry.index ? geometry.index.count : vertices;
  return { vertices, indices };
}

/** Capacity of an arena for the given counts, with the reserve applied. */
export function arenaCapacity(
  instances: number, vertices: number, indices: number, reserve = ARENA_RESERVE,
): { instances: number; vertices: number; indices: number } {
  return {
    instances: Math.ceil(instances * (1 + reserve)) + ARENA_INSTANCE_SLACK,
    vertices: Math.max(1, Math.ceil(vertices * (1 + reserve))),
    indices: Math.max(1, Math.ceil(indices * (1 + reserve))),
  };
}

/** One planned arena. */
export interface PlannedArena {
  key: string;
  kind: 'uber' | 'material';
  /** Shared source material of a `material` bucket; null for uber. */
  material: Material | null;
  layout: ArenaAttrSpec[];
  signature: string;
  meshes: Mesh[];
  /** Distinct `(geometry, mirrored)` keys in this arena. */
  geometryKeys: number;
  /** Planned (pre-reserve) vertex / index totals over the distinct geometries. */
  vertices: number;
  indices: number;
  capacity: { instances: number; vertices: number; indices: number };
}

/** Result of {@link planArenas}. */
export interface ArenaPlan {
  arenas: PlannedArena[];
  standalone: Mesh[];
  /** Reason per standalone mesh. */
  standaloneReasons: Map<Mesh, StandaloneReason>;
}

export interface PlanArenasOptions {
  materialThreshold?: number;
  reserve?: number;
  /** Bake-role lookup (production: `bakeRoleOf`). Default: no roles. */
  roleOf?: RoleOf;
}

/**
 * Plan the arenas for a set of meshes. Expects up-to-date `matrixWorld`
 * (mirroring is read from it). Deterministic: buckets keep first-seen order,
 * meshes keep input order.
 */
export function planArenas(meshes: readonly Mesh[], opts: PlanArenasOptions = {}): ArenaPlan {
  const threshold = opts.materialThreshold ?? ARENA_MATERIAL_THRESHOLD;
  const reserve = opts.reserve ?? ARENA_RESERVE;
  const roleOf = opts.roleOf ?? (() => undefined);
  const buckets = new Map<string, PlannedArena & { seen: Set<string> }>();
  const standalone: Mesh[] = [];
  const reasons = new Map<Mesh, StandaloneReason>();

  for (const mesh of meshes) {
    const cls = classifyMeshDetailed(mesh, roleOf);
    if (cls.kind === 'standalone') {
      standalone.push(mesh);
      reasons.set(mesh, cls.reason!);
      continue;
    }
    const kind = cls.kind;
    const layout = arenaLayoutFor(kind, mesh);
    const signature = arenaLayoutSignature(layout);
    const material = kind === 'uber' ? null : (mesh.material as Material);
    const key = bucketKeyOf(kind, material, signature);
    let b = buckets.get(key);
    if (!b) {
      b = {
        key, kind, material, layout, signature, meshes: [], geometryKeys: 0,
        vertices: 0, indices: 0, capacity: { instances: 0, vertices: 0, indices: 0 },
        seen: new Set<string>(),
      };
      buckets.set(key, b);
    }
    b.meshes.push(mesh);
    const gk = geometryKeyOf(mesh.geometry, isMirrored(mesh));
    if (!b.seen.has(gk)) {
      b.seen.add(gk);
      const sz = stagedSizeOf(mesh.geometry);
      b.vertices += sz.vertices;
      b.indices += sz.indices;
    }
  }

  const arenas: PlannedArena[] = [];
  for (const b of buckets.values()) {
    if (b.kind === 'material' && b.meshes.length < threshold) {
      for (const m of b.meshes) {
        standalone.push(m);
        reasons.set(m, 'below-threshold');
      }
      continue;
    }
    const { seen, ...arena } = b;
    arena.geometryKeys = seen.size;
    arena.capacity = arenaCapacity(arena.meshes.length, arena.vertices, arena.indices, reserve);
    arenas.push(arena);
  }
  return { arenas, standalone, standaloneReasons: reasons };
}
