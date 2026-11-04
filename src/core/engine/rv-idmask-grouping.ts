// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-idmask-grouping — "which meshes share one identity colour" (plan-740
 * D-A17 / P2.2).
 *
 * Extracted from `McpObserveTools.webRender`, which is a PLUGIN module, while
 * the eye channels that need the same grouping live in core. Leaving it where
 * it was would have made core import from the plugin while the plugin calls
 * core — the cycle review finding A1 flagged.
 *
 * THREE GROUPINGS, three questions an agent asks of the same scene:
 *
 *   hierarchy  — subtrees at `groupDepth` below the root (or explicit paths).
 *                "What are the assemblies?" — the kinematize view.
 *   geometry   — every copy of an identical part shares a colour ("12× wheel").
 *                "What is repeated?" — the materialize view.
 *   component  — one entry per component-bearing node (Drive, Sensor, …), each
 *                claiming its whole subtree, with everything left over merged
 *                into one rest group. "What is already mechanised?" (D-U12) —
 *                and the reason Set-of-Mark can number what the agent can act
 *                on rather than whatever the CAD tree happens to nest.
 *
 * The geometry signature stays a DYNAMIC import from `@rv-private` — it is the
 * same identity `select_similar 'identical'` uses, and duplicating it would
 * mean two answers to "is this the same part". This is the first dynamic
 * `@rv-private` import under `core/engine/`; the public build resolves it
 * through the `src/private-stubs/*` alias (see vite.config.ts), so an
 * AGPL-only build gets a stub instead of a missing module.
 */

import { Box3, Color, Vector3, type Object3D, type Mesh } from 'three';
import { computeSubtreeAABB, traverseMeshes } from './rv-traverse-utils';

/** Max distinct ID-mask groups — beyond this the smallest merge into 'other'. */
export const IDMASK_GROUP_CAP = 48;

/** How the meshes under a root are partitioned into identity groups. */
export type IdmaskGroupBy = 'hierarchy' | 'geometry' | 'component';

export interface IdmaskGrouping {
  groupBy?: IdmaskGroupBy;
  /** hierarchy: group at this depth below the root (1 = direct children). */
  groupDepth?: number;
  /** hierarchy: explicit group-root paths instead of `groupDepth`. */
  paths?: string[];
}

/** One identity group: a label plus the meshes that get its colour. */
export interface IdmaskGroup {
  path: string;
  meshes: Mesh[];
  /** geometry grouping: the paths of every copy. */
  paths?: string[];
  /** geometry grouping: number of copies. */
  count?: number;
  /** component grouping: the component types on the owning node. */
  components?: string[];
}

/** A legend row as it reaches the agent. */
export interface IdmaskLegendEntry {
  color: string;
  path: string;
  meshCount: number;
  count?: number;
  paths?: string[];
  morePaths?: number;
  components?: string[];
  /** Set-of-Mark number, filled in by the eye tool when labels are on. */
  mark?: number;
}

/** Minimal registry surface — avoids a core→NodeRegistry class dependency. */
export interface IdmaskRegistry {
  // `NodeRegistry.getNode` answers with `null`, not `undefined` — both are
  // accepted so the real registry is assignable without a cast.
  getNode(path: string): Object3D | null | undefined;
  getPathForNode(node: Object3D): string | undefined;
}

/**
 * Golden-angle hue stepping — up to ~48 clearly distinct saturated colors.
 *
 * The three lightness bands double the usable pool: 137.5° apart is distinct
 * for maybe two dozen hues before neighbours start reading the same in a JPEG,
 * and alternating lightness pulls those apart again.
 */
export function idmaskColor(index: number): Color {
  const hue = (index * 137.508) % 360;
  const light = 0.5 + 0.14 * (index % 3); // 3 lightness bands double the pool
  return new Color().setHSL(hue / 360, 0.85, light);
}

/** Every mesh with geometry under `n`, in traversal order. */
export function meshesUnder(n: Object3D): Mesh[] {
  const out: Mesh[] = [];
  traverseMeshes(n, (m) => { if (m.geometry) out.push(m); });
  return out;
}

/** Largest world AABB extent of a mesh set — the "visually largest" ordering. */
function extentOf(meshes: Mesh[]): number {
  const box = new Box3();
  const mb = new Box3();
  for (const m of meshes) {
    const geo = m.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    if (geo.boundingBox && !geo.boundingBox.isEmpty()) {
      box.union(mb.copy(geo.boundingBox).applyMatrix4(m.matrixWorld));
    }
  }
  if (box.isEmpty()) return 0;
  const size = box.getSize(new Vector3());
  return Math.max(size.x, size.y, size.z);
}

/**
 * Component type names on a node — `userData.realvirtual` keys, the same shape
 * `findPickOwner` and `buildSceneSnapshot` read, so "has a component" means the
 * same thing to the grouping as it does to `web_view_sweep`'s `ownerPath`.
 * Keys starting with `_` are internal loader bookkeeping, not components.
 */
export function componentTypesOf(node: Object3D): string[] {
  const rv = (node.userData as Record<string, unknown> | undefined)?.['realvirtual'] as
    Record<string, unknown> | undefined;
  if (!rv || typeof rv !== 'object') return [];
  return Object.keys(rv).filter((k) => !k.startsWith('_'));
}

/**
 * True when the subtree below `root` carries kinematic/behaviour components —
 * the condition under which `component` is the better DEFAULT grouping (D-U12):
 * numbering Drives and Sensors beats numbering whatever CAD folders exist.
 */
export function hasComponentNodes(root: Object3D): boolean {
  let found = false;
  root.traverse((n) => {
    if (!found && componentTypesOf(n).length > 0) found = true;
  });
  return found;
}

/** Grouping that a bare `web_eye` should use for this subtree. */
export function defaultGroupBy(root: Object3D): IdmaskGroupBy {
  return hasComponentNodes(root) ? 'component' : 'hierarchy';
}

/**
 * Partition the meshes under `root` into identity groups.
 *
 * Returns `{ error }` instead of throwing for the one case an agent causes
 * itself — an explicit path that does not resolve — so the tool can hand the
 * message back verbatim.
 */
export async function resolveIdmaskGroups(
  root: Object3D,
  registry: IdmaskRegistry,
  grouping: IdmaskGrouping = {},
): Promise<{ groups: IdmaskGroup[] } | { error: string }> {
  const groupBy: IdmaskGroupBy = grouping.groupBy ?? 'hierarchy';
  let groups: IdmaskGroup[] = [];

  if (groupBy === 'geometry') {
    // All copies of an identical part (geometry-signature match — the same
    // identity select_similar 'identical' uses) share one color.
    const { geometrySignature, signaturesMatch } =
      await import('@rv-private/plugins/asset-editor/shared/select-actions');
    const reps: Array<{
      sig: ReturnType<typeof geometrySignature>; path: string; meshes: Mesh[]; paths: string[];
    }> = [];
    traverseMeshes(root, (mesh) => {
      if (!mesh.geometry) return;
      const sig = geometrySignature(mesh.geometry);
      const p = registry.getPathForNode(mesh) ?? mesh.name;
      const g = reps.find((r) => signaturesMatch(r.sig, sig));
      if (g) { g.meshes.push(mesh); g.paths.push(p); }
      else reps.push({ sig, path: p, meshes: [mesh], paths: [p] });
    });
    groups = reps.map((r) => ({ path: r.path, meshes: r.meshes, paths: r.paths, count: r.meshes.length }));
  } else if (groupBy === 'component') {
    // One group per component-bearing node, OUTERMOST wins: a Drive that
    // contains a Sensor is one moving thing, and splitting it would number the
    // parts of an axis rather than the axis.
    const owners: Array<{ path: string; node: Object3D; components: string[] }> = [];
    const claimed = new Set<Object3D>();
    const walk = (node: Object3D): void => {
      const comps = componentTypesOf(node);
      if (comps.length > 0) {
        const p = registry.getPathForNode(node);
        if (p) {
          owners.push({ path: p, node, components: comps });
          node.traverse((c) => claimed.add(c));
          return; // do not descend — the outermost component owns its subtree
        }
      }
      for (const c of node.children) walk(c);
    };
    for (const c of root.children) walk(c);

    groups = owners.map((o) => ({
      path: o.path,
      meshes: meshesUnder(o.node),
      components: o.components,
    }));
    // Everything with no component above it: one rest group, so the image still
    // accounts for every pixel instead of leaving the frame half unlabelled.
    const rest: Mesh[] = [];
    traverseMeshes(root, (m) => { if (m.geometry && !claimed.has(m)) rest.push(m); });
    if (rest.length > 0) {
      const p = registry.getPathForNode(root) ?? '';
      groups.push({ path: `${p ? `${p} ` : ''}(no component)`, meshes: rest });
    }
    // No component anywhere → fall back rather than returning one huge group.
    if (owners.length === 0) {
      return resolveIdmaskGroups(root, registry, { ...grouping, groupBy: 'hierarchy' });
    }
  } else {
    const explicit = grouping.paths ?? [];
    const roots: Array<{ path: string; node: Object3D }> = [];
    if (explicit.length > 0) {
      for (const p of explicit) {
        const n = registry.getNode(p);
        if (!n) return { error: `Node not found: "${p}"` };
        roots.push({ path: p, node: n });
      }
    } else {
      const depth = Math.max(1, Math.min(6, Math.round(grouping.groupDepth ?? 1)));
      const collect = (node: Object3D, d: number): void => {
        if (d === depth || node.children.length === 0) {
          const p = registry.getPathForNode(node);
          if (p) roots.push({ path: p, node });
          return;
        }
        for (const c of node.children) collect(c, d + 1);
      };
      // Skip single-child wrapper chains first. One imported CAD assembly under
      // the scene root is the NORMAL shape, and counting depth from the root
      // then yields exactly one group — a uniformly coloured mask that tells an
      // agent nothing, with no error to say why. Depth 1 should mean "the first
      // level that actually branches". Only descends where it opens up more
      // nodes, so a single-mesh model still groups as itself.
      let start = root;
      while (start.children.length === 1 && start.children[0].children.length > 0) {
        start = start.children[0];
      }
      for (const c of start.children) collect(c, 1);
      if (roots.length === 0) {
        const p = registry.getPathForNode(root);
        if (p) roots.push({ path: p, node: root });
      }
    }
    groups = roots.map((r) => ({ path: r.path, meshes: meshesUnder(r.node) }));
  }

  // Cap the palette: keep the VISUALLY largest groups (by AABB extent — a 6 m
  // structural beam outranks a triangle-rich bearing), the rest merge into
  // 'other' at draw time.
  if (groups.length > IDMASK_GROUP_CAP) {
    groups = groups
      .map((g) => ({ g, ext: extentOf(g.meshes) }))
      .sort((a, b) => b.ext - a.ext)
      .map((e) => e.g);
  }
  return { groups };
}

/** World AABB of a group's meshes (empty box when it has none). */
export function groupBounds(group: IdmaskGroup, out = new Box3()): Box3 {
  out.makeEmpty();
  const mb = new Box3();
  for (const m of group.meshes) {
    const geo = m.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    if (geo.boundingBox && !geo.boundingBox.isEmpty()) {
      out.union(mb.copy(geo.boundingBox).applyMatrix4(m.matrixWorld));
    }
  }
  return out;
}

/** Re-export so callers needing a whole-subtree AABB do not import two modules. */
export { computeSubtreeAABB };
