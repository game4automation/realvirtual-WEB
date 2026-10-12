// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-collider-extras.ts — ONE parser for the Unity collider metadata in
 * `userData.realvirtual` (plan-467 Phase 1).
 *
 * Unity's export plugin (`realvirtualExportPlugin.cs`, `GetComponents<Collider>()`)
 * writes every collider of a GameObject into `rv.colliders[]`:
 *
 * ```json
 * "colliders": [
 *   { "type": "BoxCollider",  "isTrigger": false, "enabled": true,
 *     "center": {…}, "size": {…} },
 *   { "type": "MeshCollider", "isTrigger": false, "enabled": true,
 *     "convex": true, "cookingOptions": "…" }
 * ]
 * ```
 *
 * Older exports carry a single box under the top-level `rv.BoxCollider` key
 * (no `enabled` / `isTrigger` there — both are assumed permissive).
 *
 * Before this module three call sites parsed that structure independently and
 * all three understood only boxes (`rv-scene-loader.ts::createAABBFromExtras`,
 * `physics-zone-plugin.ts::hasBoxColliderExtras` / `::boxColliderAabb`).
 * plan-467 needs MeshCollider entries as well (convex-hull kinematic bodies),
 * so the parsing lives here once and the call sites read the result.
 *
 * PUBLIC module — no Rapier, no private types. The physics provider turns a
 * `ColliderExtra` into a `PhysicsShape`; this file only reads GLB data.
 *
 * COORDINATE NOTE: `center` / `size` are handed back EXACTLY as Unity wrote
 * them (left-handed, X not yet negated). The glTF conversion happens where the
 * value is consumed — `AABB.fromBoxCollider()` owns it (`unityPositionToGltf`),
 * exactly as before.
 */

import type { Mesh, Object3D } from 'three';

/** Fields every collider entry shares (legacy boxes default to permissive). */
interface ColliderExtraBase {
  /** Unity `Collider.enabled`. Missing → true (legacy exports). */
  readonly enabled: boolean;
  /** Unity `Collider.isTrigger`. Missing → false (legacy exports). */
  readonly isTrigger: boolean;
}

/** Unity `BoxCollider` — center/size in UNITY space (see coordinate note). */
export interface BoxColliderExtra extends ColliderExtraBase {
  readonly kind: 'box';
  readonly center: { x: number; y: number; z: number };
  readonly size: { x: number; y: number; z: number };
}

/** Unity `MeshCollider` — the mesh itself is the node's render geometry, so
 *  only the cooking flag rides along in the extras. */
export interface MeshColliderExtra extends ColliderExtraBase {
  readonly kind: 'mesh';
  /** Unity `MeshCollider.convex`. A `false` here means the authored shape is
   *  concave — the physics side still hulls it (Rapier has no trimesh support
   *  on kinematic bodies, plan-467 Alternative 3) and warns once. */
  readonly convex: boolean;
}

export type ColliderExtra = BoxColliderExtra | MeshColliderExtra;

type Vec3Like = { x: number; y: number; z: number };

/**
 * Validity check for EVERY box definition read from rv_extras: all components
 * finite and a strictly positive size per axis. Degenerate CAD exports (NaN
 * centers, zero/negative sizes) would otherwise reach the physics engine.
 *
 * Moved here verbatim from `physics-zone-plugin.ts` so the loader applies the
 * same rule the physics side always did.
 */
export function isValidBoxDef(center: Vec3Like, size: Vec3Like): boolean {
  if (!Number.isFinite(center.x) || !Number.isFinite(center.y) || !Number.isFinite(center.z)) return false;
  if (!Number.isFinite(size.x) || !Number.isFinite(size.y) || !Number.isFinite(size.z)) return false;
  return size.x > 0 && size.y > 0 && size.z > 0;
}

function isVec3Like(v: unknown): v is Vec3Like {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.x === 'number' && typeof o.y === 'number' && typeof o.z === 'number';
}

/**
 * Parse the collider metadata of one `userData.realvirtual` object.
 *
 * Order is DELIBERATE and load-bearing: the legacy top-level `BoxCollider` key
 * comes first, then the `colliders[]` entries in export order — that is the
 * precedence `physics-zone-plugin.ts::boxColliderAabb` has always used ("first
 * VALID entry wins"), and switching it would silently move existing colliders.
 *
 * Entries the WebViewer has no shape for (Sphere, Capsule, Terrain, …) are
 * skipped silently; a degenerate box is skipped too (it never was usable).
 * `enabled` / `isTrigger` are REPORTED, not filtered — the physics side decides
 * (moving bodies exclude both, implicit statics keep their historical
 * behaviour; plan-467 F1).
 */
export function getColliderExtrasFrom(rv: Record<string, unknown> | undefined): ColliderExtra[] {
  if (!rv) return [];
  const out: ColliderExtra[] = [];

  // Legacy single box (no enabled/isTrigger were ever exported for it).
  const legacy = rv['BoxCollider'] as { center?: unknown; size?: unknown } | undefined;
  if (legacy && isVec3Like(legacy.center) && isVec3Like(legacy.size) && isValidBoxDef(legacy.center, legacy.size)) {
    out.push({ kind: 'box', center: legacy.center, size: legacy.size, enabled: true, isTrigger: false });
  }

  const colliders = rv['colliders'];
  if (Array.isArray(colliders)) {
    for (const raw of colliders) {
      if (!raw || typeof raw !== 'object') continue;
      const col = raw as Record<string, unknown>;
      const type = typeof col.type === 'string' ? col.type : '';
      const enabled = col.enabled !== false;
      const isTrigger = col.isTrigger === true;
      if (type === 'Box' || type === 'BoxCollider') {
        if (!isVec3Like(col.center) || !isVec3Like(col.size)) continue;
        if (!isValidBoxDef(col.center, col.size)) continue;
        out.push({ kind: 'box', center: col.center, size: col.size, enabled, isTrigger });
      } else if (type === 'Mesh' || type === 'MeshCollider') {
        out.push({ kind: 'mesh', convex: col.convex === true, enabled, isTrigger });
      }
      // Sphere / Capsule / anything else: no WebViewer shape — ignored.
    }
  }
  return out;
}

/** {@link getColliderExtrasFrom} for a scene node. */
export function getColliderExtras(node: Object3D): ColliderExtra[] {
  return getColliderExtrasFrom(node.userData?.realvirtual as Record<string, unknown> | undefined);
}

/** True while the collider would exist as SOLID geometry in Unity: enabled and
 *  not a trigger volume (plan-467 F1). */
export function isSolidCollider(col: ColliderExtra): boolean {
  return col.enabled && !col.isTrigger;
}

/** First usable box definition, or null — the shape `AABB.fromBoxCollider`
 *  consumes. `solidOnly` applies the F1 enabled/isTrigger filter. */
export function firstBoxCollider(node: Object3D, solidOnly = false): BoxColliderExtra | null {
  for (const col of getColliderExtras(node)) {
    if (col.kind !== 'box') continue;
    if (solidOnly && !isSolidCollider(col)) continue;
    return col;
  }
  return null;
}

/**
 * The RENDER primitives that make up `node`'s own geometry — the vertex source
 * for a MeshCollider convex hull (plan-467 F2, SOL R1 #7).
 *
 * A single-material Unity mesh arrives as one `Mesh` node. A MULTI-MATERIAL
 * mesh arrives from GLTFLoader as a `Group` with one `Mesh` child per glTF
 * primitive; those children carry no `userData.realvirtual` of their own, which
 * is exactly what separates them from a real child object that happens to be a
 * mesh (and belongs to a different collider / link).
 *
 * Never recurses deeper than one level — a grandchild is a separate object.
 */
export function renderPrimitivesOf(node: Object3D): Mesh[] {
  const self = node as Mesh;
  if (self.isMesh && self.geometry) return [self];
  const out: Mesh[] = [];
  for (const child of node.children) {
    const mesh = child as Mesh;
    if (!mesh.isMesh || !mesh.geometry) continue;
    if (child.userData?.realvirtual) continue; // an object in its own right
    out.push(mesh);
  }
  return out;
}
