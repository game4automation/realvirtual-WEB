// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Public arena-planner seam. Correctness remains in rv-batched-render.ts. */

import type { BufferGeometry, Material, Mesh, Object3D } from 'three';
import type { RVUberMaterial } from './rv-uber-material';
import { arenaSignatureOf } from './rv-mesh-merge-batch';

export const ARENA_PLANNER_VERSION = 1;
export const ARENA_PLANNER_FLAG_KEY = 'rv.batch.planner';

export interface PlanContext {
  sharedUber: RVUberMaterial | null;
  driveNodeSet: ReadonlySet<Object3D>;
  shouldAbort: () => boolean;
}

export interface ArenaGroupSpec {
  anchor: Object3D | null;
  groupKey: string;
  meshes: Mesh[];
}

export interface ArenaPlanner {
  readonly version: number;
  plan(candidates: readonly Mesh[], ctx: PlanContext): ArenaGroupSpec[];
}

export type ArenaPlannerKind = 'advanced' | 'baseline';

export interface ResolvedArenaPlan {
  groups: ArenaGroupSpec[];
  planner: ArenaPlannerKind;
}

let registeredPlanner: ArenaPlanner | null = null;

export const arenaPlannerRegistry = {
  register(planner: ArenaPlanner | null): void {
    registeredPlanner = planner;
  },
  get(): ArenaPlanner | null {
    return registeredPlanner;
  },
};

export function isArenaPlannerEnabled(): boolean {
  try {
    const value = typeof localStorage !== 'undefined' ? localStorage.getItem(ARENA_PLANNER_FLAG_KEY) : null;
    return value !== 'off' && value !== 'false' && value !== '0';
  } catch {
    return true;
  }
}

function singleMaterial(mesh: Mesh): Material | null {
  const material = mesh.material;
  return material && !Array.isArray(material) ? material : null;
}

function hasDriveAncestor(mesh: Mesh, driveNodeSet: ReadonlySet<Object3D>): boolean {
  let node: Object3D | null = mesh;
  while (node) {
    if (driveNodeSet.has(node)) return true;
    node = node.parent;
  }
  return false;
}

function driveAnchor(mesh: Mesh, driveNodeSet: ReadonlySet<Object3D>): Object3D | null {
  let anchor: Object3D | null = driveNodeSet.has(mesh) ? mesh : null;
  let node = mesh.parent;
  while (node) {
    if (!anchor && driveNodeSet.has(node)) anchor = node;
    node = node.parent;
  }
  return anchor;
}

/** Full static and Drive motion-blob coverage. */
export class AdvancedArenaPlanner implements ArenaPlanner {
  readonly version = ARENA_PLANNER_VERSION;

  plan(candidates: readonly Mesh[], ctx: PlanContext): ArenaGroupSpec[] {
    const uber = new Map<Object3D | null, Mesh[]>();
    const textured = new Map<Object3D | null, Map<Material, Map<string, Mesh[]>>>();

    for (const mesh of candidates) {
      if (ctx.shouldAbort()) break;
      const anchor = driveAnchor(mesh, ctx.driveNodeSet);
      const isStatic = mesh.matrixAutoUpdate === false;
      if ((isStatic && anchor !== null) || (!isStatic && anchor === null)) continue;
      const material = singleMaterial(mesh);
      if (!material) continue;
      if (ctx.sharedUber && material === ctx.sharedUber && mesh.userData?._rvUberBaked === true) {
        let meshes = uber.get(anchor);
        if (!meshes) {
          meshes = [];
          uber.set(anchor, meshes);
        }
        meshes.push(mesh);
        continue;
      }

      const signature = arenaSignatureOf(mesh.geometry);
      let byMaterial = textured.get(anchor);
      if (!byMaterial) {
        byMaterial = new Map();
        textured.set(anchor, byMaterial);
      }
      let bySignature = byMaterial.get(material);
      if (!bySignature) {
        bySignature = new Map();
        byMaterial.set(material, bySignature);
      }
      let meshes = bySignature.get(signature);
      if (!meshes) {
        meshes = [];
        bySignature.set(signature, meshes);
      }
      meshes.push(mesh);
    }

    const groups: ArenaGroupSpec[] = [];
    let index = 0;
    for (const [anchor, meshes] of uber) {
      if (meshes.length >= 2) groups.push({ anchor, groupKey: `advanced-uber-${index++}`, meshes });
    }
    for (const [anchor, byMaterial] of textured) {
      for (const bySignature of byMaterial.values()) {
        for (const meshes of bySignature.values()) {
          if (meshes.length >= 2) groups.push({ anchor, groupKey: `advanced-textured-${index++}`, meshes });
        }
      }
    }
    return groups;
  }
}

/** Conservative public fallback: repeated static geometry/material pairs only. */
export class BaselineArenaPlanner implements ArenaPlanner {
  readonly version = ARENA_PLANNER_VERSION;

  plan(candidates: readonly Mesh[], ctx: PlanContext): ArenaGroupSpec[] {
    const byMaterial = new Map<Material, Map<BufferGeometry, Mesh[]>>();
    for (const mesh of candidates) {
      if (ctx.shouldAbort()) break;
      if (mesh.matrixAutoUpdate !== false || hasDriveAncestor(mesh, ctx.driveNodeSet)) continue;
      const material = singleMaterial(mesh);
      if (!material) continue;
      let byGeometry = byMaterial.get(material);
      if (!byGeometry) {
        byGeometry = new Map();
        byMaterial.set(material, byGeometry);
      }
      let group = byGeometry.get(mesh.geometry);
      if (!group) {
        group = [];
        byGeometry.set(mesh.geometry, group);
      }
      group.push(mesh);
    }

    const groups: ArenaGroupSpec[] = [];
    let index = 0;
    for (const byGeometry of byMaterial.values()) {
      for (const meshes of byGeometry.values()) {
        if (meshes.length >= 2) groups.push({ anchor: null, groupKey: `baseline-${index++}`, meshes });
      }
    }
    return groups;
  }
}

const baselinePlanner = new BaselineArenaPlanner();
const advancedPlanner = new AdvancedArenaPlanner();

function isUnderRoot(node: Object3D, root: Object3D): boolean {
  let current: Object3D | null = node;
  while (current) {
    if (current === root) return true;
    current = current.parent;
  }
  return false;
}

function validatePlan(
  groups: ArenaGroupSpec[],
  root: Object3D,
  candidates: readonly Mesh[],
  ctx: PlanContext,
): string | null {
  if (!Array.isArray(groups)) return 'plan result is not an array';
  const safeCandidates = new Set(candidates);
  const seen = new Set<Mesh>();
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const group = groups[groupIndex];
    if (!group || typeof group.groupKey !== 'string' || group.groupKey.length === 0) {
      return `group ${groupIndex} has no valid groupKey`;
    }
    if (!Array.isArray(group.meshes) || group.meshes.length < 2) {
      return `group ${group.groupKey} has fewer than two meshes`;
    }
    if (group.anchor !== null && (!ctx.driveNodeSet.has(group.anchor) || !isUnderRoot(group.anchor, root))) {
      return `group ${group.groupKey} has an invalid anchor`;
    }

    let expectedMaterial: Material | null = null;
    let expectedSignature: string | null = null;
    let expectedUber: boolean | null = null;
    for (const mesh of group.meshes) {
      if (!safeCandidates.has(mesh)) return `group ${group.groupKey} contains an unsafe or foreign mesh`;
      if (seen.has(mesh)) return `mesh ${mesh.name || mesh.uuid} occurs more than once`;
      if (!isUnderRoot(mesh, root)) return `mesh ${mesh.name || mesh.uuid} is outside the model root`;
      if (group.anchor !== null && !isUnderRoot(mesh, group.anchor)) {
        return `mesh ${mesh.name || mesh.uuid} is outside its anchor subtree`;
      }
      const material = singleMaterial(mesh);
      if (!material) return `mesh ${mesh.name || mesh.uuid} has no single material`;
      const signature = arenaSignatureOf(mesh.geometry);
      const uber = !!ctx.sharedUber
        && material === ctx.sharedUber
        && mesh.userData?._rvUberBaked === true;
      if (expectedMaterial === null) {
        expectedMaterial = material;
        expectedSignature = signature;
        expectedUber = uber;
      } else if (
        material !== expectedMaterial
        || uber !== expectedUber
        || (!uber && signature !== expectedSignature)
      ) {
        return `group ${group.groupKey} mixes materials, arena kinds, or textured geometry layout signatures`;
      }
      seen.add(mesh);
    }
  }
  return null;
}

function baseline(root: Object3D, candidates: readonly Mesh[], ctx: PlanContext): ResolvedArenaPlan {
  const groups = baselinePlanner.plan(candidates, ctx);
  const validationError = validatePlan(groups, root, candidates, ctx);
  if (validationError) {
    console.warn(`[ArenaPlanner] baseline plan validation failed: ${validationError}`);
    return { groups: [], planner: 'baseline' };
  }
  return { groups, planner: 'baseline' };
}

/** Resolve and validate the registered strategy before any source mutation. */
export function resolveArenaPlan(
  root: Object3D,
  candidates: readonly Mesh[],
  ctx: PlanContext,
): ResolvedArenaPlan {
  if (!isArenaPlannerEnabled()) return baseline(root, candidates, ctx);
  const planner = arenaPlannerRegistry.get() ?? advancedPlanner;
  if (planner.version !== ARENA_PLANNER_VERSION) {
    console.warn(
      `[ArenaPlanner] provider version ${planner.version} != expected ${ARENA_PLANNER_VERSION}; using baseline`,
    );
    return baseline(root, candidates, ctx);
  }
  try {
    const groups = planner.plan(candidates, ctx);
    const validationError = validatePlan(groups, root, candidates, ctx);
    if (validationError) {
      console.warn(`[ArenaPlanner] advanced plan rejected (${validationError}); using baseline`);
      return baseline(root, candidates, ctx);
    }
    return { groups, planner: 'advanced' };
  } catch (error) {
    console.warn('[ArenaPlanner] advanced planner failed; using baseline:', error);
    return baseline(root, candidates, ctx);
  }
}
