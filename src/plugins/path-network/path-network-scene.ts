// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * path-network-scene — the seam between the pure path-network ops
 * (`rv-path-network-ops.ts`) and the planner's document (plan-628 Phase 3).
 *
 *  - {@link snapshotNetwork} reads the graph FROM THE NODES (N8: never from
 *    `network.all()`, which keeps one path per id): every node with
 *    `rv_extras.Path` and every `PathBlock` node, the resolved vehicle starts
 *    (fleet handles, N10) and all taken node names (P4).
 *  - {@link networkEditToOps} translates one `NetworkEdit` 1:1 into scene ops
 *    (`addNode` / `removeNode` / `setField`) in the order the edit demands:
 *    `PathNetwork` node if missing → new blocks → new paths → field writes →
 *    vehicle rewrites → removed paths → removed blocks. Pure (no viewer).
 *  - {@link foldEdit} applies an edit to a snapshot, so a command that runs
 *    several ops (multi-id remove) books them as ONE transaction.
 */

import type { Object3D } from 'three';
import type { FleetReferenceResolver } from '../../core/fleet/scene/fleet-scene-model';
import { freshOpId } from '../../core/ops/rv-op-utils';
import type { RvOp } from '../../core/ops/rv-unified-ops';
import type { NodeSpec } from '../../core/hmi/scene/rv-scene-edits';
import { PATH_SCHEMA_VERSION, type PathSegmentSpec } from '../../core/engine/rv-path';
import { getDefaultAgvFleet } from '../../core/engine/rv-agv-fleet';
import {
  PATH_BLOCK_TYPE,
  PATH_NETWORK_NODE,
  parsePathBlockExtras,
  type PathBlockExtras,
} from '../../core/engine/rv-path-block';
import { isAuthoredSubtreeRemovable } from '../../core/engine/rv-scene-loader';
import type {
  BlockEntry,
  NetworkEdit,
  NetworkInput,
  PathGraphEntry,
  VehicleStart,
} from '../../core/engine/rv-path-network-ops';

/** Where every network node lives (node paths of the scene registry). */
export interface NetworkLocator {
  /** Registry path of the model root ('' allowed — children are `/<name>`). */
  rootPath: string;
  /** Path of the `PathNetwork` node; null = not there yet (created on demand). */
  networkPath: string | null;
  /** Path id → node path. */
  pathNodes: Map<string, string>;
  /** Block id → node path. */
  blockNodes: Map<string, string>;
  /** Node path → its current spec (what a `removeNode` must carry for undo). */
  specs: Map<string, NodeSpec>;
  /** Vehicle node path → the component its start lives in (`Agv` / `AgvBehavior`). */
  vehicleComponent: Map<string, string>;
  /**
   * plan-628 8.7: node paths of AUTHORED (file-loaded) nodes that may still be
   * removed — their `removeNode` is emitted with `authored: true` (persisted).
   */
  authored?: Set<string>;
}

/** A snapshot of the scene network: the pure input plus where it lives. */
export interface SceneNetwork {
  input: NetworkInput;
  locator: NetworkLocator;
}

/** The minimal viewer view the snapshot reads. */
export interface SnapshotViewer {
  readonly scene: Object3D;
  readonly registry?: { getPathForNode(node: Object3D): string | null; resolve?: FleetReferenceResolver['resolve'] } | null;
}

type Rv = Record<string, Record<string, unknown> | undefined>;

const rvOf = (n: Object3D): Rv | undefined =>
  (n.userData as { realvirtual?: Rv } | undefined)?.realvirtual;

/**
 * plan-628 8.11a (H5, plan-681): a node owned by a composition generator
 * (`extras.realvirtual.Generated.owner`) is read-only for authoring — the
 * marquee never selects it.
 */
export function isCompositionOwnedNode(node: Object3D | null | undefined): boolean {
  return compositionOwnerOf(node) !== null;
}

/**
 * plan-628 8.6: the composition owner of a generated node (`Generated.owner`,
 * e.g. 'palletYard'), or null. The snapshot carries it as `owner`, and every
 * path-network op refuses to write such an entry ('composition-owned').
 */
export function compositionOwnerOf(node: Object3D | null | undefined): string | null {
  const g = node ? rvOf(node)?.['Generated'] : undefined;
  if (!g || typeof g !== 'object') return null;
  const o = (g as Record<string, unknown>)['owner'];
  return typeof o === 'string' && o ? o : null;
}

const isIdentity = (n: Object3D): boolean => {
  const p = n.position, q = n.quaternion, s = n.scale;
  const e = 1e-9;
  return Math.abs(p.x) < e && Math.abs(p.y) < e && Math.abs(p.z) < e
    && Math.abs(q.x) < e && Math.abs(q.y) < e && Math.abs(q.z) < e && Math.abs(q.w - 1) < e
    && Math.abs(s.x - 1) < e && Math.abs(s.y - 1) < e && Math.abs(s.z - 1) < e;
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The current spec of a node (position, rotation, scale and all components). */
export function nodeSpecOf(node: Object3D, parentPath: string): NodeSpec {
  return {
    parentPath,
    name: node.name,
    position: [node.position.x, node.position.y, node.position.z],
    quaternion: [node.quaternion.x, node.quaternion.y, node.quaternion.z, node.quaternion.w],
    scale: [node.scale.x, node.scale.y, node.scale.z],
    components: clone((rvOf(node) ?? {}) as Record<string, Record<string, unknown>>),
  };
}

function parentPathOf(nodePath: string): string {
  const i = nodePath.lastIndexOf('/');
  return i < 0 ? '' : nodePath.slice(0, i);
}

/** The model root the network node belongs under. */
export function modelRootOf(viewer: SnapshotViewer): Object3D | null {
  return (viewer as unknown as { currentModel?: Object3D | null }).currentModel ?? null;
}

/**
 * Read the network from the scene nodes. Overlay subtrees (`__*`) are skipped;
 * a node without a registry path is still part of the graph (it blocks ids)
 * but counts as imported (it cannot be written).
 */
export function snapshotNetwork(viewer: SnapshotViewer): SceneNetwork {
  const reg = viewer.registry ?? null;
  const root = modelRootOf(viewer);
  const rootPath = root ? (reg?.getPathForNode(root) ?? root.name) : '';
  const locator: NetworkLocator = {
    rootPath,
    networkPath: null,
    pathNodes: new Map(),
    blockNodes: new Map(),
    specs: new Map(),
    vehicleComponent: new Map(),
    authored: new Set(),
  };
  const paths: PathGraphEntry[] = [];
  const blocks: BlockEntry[] = [];
  const taken = new Set<string>();
  let rootIdentity = true;

  // plan-628 8.7: only the document's OWN network (the `PathNetwork` directly
  // under the model root) — never network content of a placed reference, which
  // the bake could not drop from this file.
  const inOwnNetwork = (n: Object3D): boolean => {
    for (let cur = n.parent; cur; cur = cur.parent) {
      if (cur.name === PATH_NETWORK_NODE) return cur.parent === root;
    }
    return false;
  };
  const visit = (n: Object3D, blockName: string): void => {
    if (n !== viewer.scene && n.name.startsWith('__')) return;
    if (n.name) taken.add(n.name);
    const rv = rvOf(n);
    const nodePath = reg?.getPathForNode(n) ?? null;
    const added = !!(n.userData as Record<string, unknown>)['__rvAdded'];
    // plan-628 8.7: a loaded block / path inside `PathNetwork` is removable too
    // (persisted authored removal); every other loaded node stays `imported`.
    const authoredRemovable = !added && nodePath !== null && inOwnNetwork(n) && isAuthoredSubtreeRemovable(n);
    const removable = nodePath !== null && (added || authoredRemovable);
    if (authoredRemovable) locator.authored!.add(nodePath);
    let childBlock = blockName;
    if (n.name === PATH_NETWORK_NODE && n.parent === root && !locator.networkPath && nodePath !== null) {
      locator.networkPath = nodePath;
      rootIdentity = isIdentity(n);
    }
    const owner = compositionOwnerOf(n);
    const blockExtras = rv ? parsePathBlockExtras(rv[PATH_BLOCK_TYPE]) : null;
    if (blockExtras) {
      blocks.push({
        id: n.name,
        extras: blockExtras,
        ...(removable ? {} : { imported: true }),
        ...(owner ? { owner } : {}),
        ...(isIdentity(n) ? {} : { transformIdentity: false }),
      });
      if (nodePath !== null) {
        locator.blockNodes.set(n.name, nodePath);
        locator.specs.set(nodePath, nodeSpecOf(n, parentPathOf(nodePath)));
      }
      childBlock = n.name;
    }
    const raw = rv?.['Path'];
    if (raw && typeof raw === 'object') {
      const r = raw as Record<string, unknown>;
      const id = typeof r.id === 'string' && r.id ? r.id : (n.name || 'Path');
      const e: PathGraphEntry = {
        id,
        nodeName: n.name,
        block: blockExtras ? '' : blockName,
        segments: Array.isArray(r.segments) ? clone(r.segments as PathSegmentSpec[]) : [],
        successors: Array.isArray(r.successors) ? (r.successors as unknown[]).filter((s): s is string => typeof s === 'string' && !!s) : [],
      };
      if (typeof r.zone === 'string' && r.zone) e.zone = r.zone;
      if (r.zoneCapacity !== undefined && r.zoneCapacity !== null && Number.isFinite(Number(r.zoneCapacity))) e.zoneCapacity = Number(r.zoneCapacity);
      if (r.closed === true) e.closed = true;
      if (r.connectCheck === false) e.connectCheck = false;
      if (!removable) e.imported = true;
      if (owner) e.owner = owner;
      paths.push(e);
      if (nodePath !== null && !locator.pathNodes.has(id)) {
        locator.pathNodes.set(id, nodePath);
        locator.specs.set(nodePath, nodeSpecOf(n, parentPathOf(nodePath)));
      }
    }
    for (const c of n.children) visit(c, childBlock);
  };
  visit(viewer.scene, '');

  const vehicles: VehicleStart[] = [];
  for (const h of getDefaultAgvFleet().handleList) {
    if (!h.startPathId || !h.node) continue;
    const agvPath = reg?.getPathForNode(h.node) ?? null;
    if (agvPath === null) continue;
    const rv = (rvOf(h.node) ?? {}) as Rv;
    const comp = rv['Agv'] ? 'Agv' : rv['AgvBehavior'] ? 'AgvBehavior' : 'Agv';
    const sp = Number(rv['Agv']?.['StartPosition'] ?? rv['AgvBehavior']?.['StartPosition'] ?? 0);
    vehicles.push({ agvNode: agvPath, pathId: h.startPathId, startPositionMm: Number.isFinite(sp) ? sp : 0 });
    locator.vehicleComponent.set(agvPath, comp);
  }

  return {
    input: { paths, blocks, vehicles, takenNames: [...taken], rootTransformIdentity: rootIdentity },
    locator,
  };
}

// ─── Edit → ops ─────────────────────────────────────────────────────────

const header = (): { id: string; ts: number; schemaV: 1 } => ({ id: freshOpId(), ts: Date.now(), schemaV: 1 });

function addNodeOp(spec: NodeSpec): RvOp {
  const nodePath = `${spec.parentPath}/${spec.name}`;
  return { ...header(), kind: 'addNode', nodePath, spec } as unknown as RvOp;
}

function removeNodeOp(nodePath: string, spec: NodeSpec, authored = false): RvOp {
  return { ...header(), kind: 'removeNode', nodePath, spec, ...(authored ? { authored: true } : {}) } as unknown as RvOp;
}

export function setFieldOp(nodePath: string, componentType: string, fieldName: string, value: unknown, prev: unknown): RvOp {
  return { ...header(), kind: 'setField', nodePath, componentType, fieldName, value, prev } as unknown as RvOp;
}

function bareSpec(parentPath: string, name: string, components: Record<string, Record<string, unknown>>): NodeSpec {
  return { parentPath, name, position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], components };
}

/** The `rv_extras.Path` payload of a new entry. */
export function pathPayload(e: PathGraphEntry): Record<string, unknown> {
  const p: Record<string, unknown> = {
    type: 'Path', version: PATH_SCHEMA_VERSION, id: e.id,
    segments: clone(e.segments), successors: [...e.successors],
  };
  if (e.zone) p.zone = e.zone;
  if (e.zoneCapacity !== undefined) p.zoneCapacity = e.zoneCapacity;
  if (e.closed) p.closed = true;
  if (e.connectCheck === false) p.connectCheck = false;
  return p;
}

const BLOCK_FIELDS = ['type', 'version', 'kind', 'params', 'pose', 'y', 'host', 'hostPathId', 'frontPathId'] as const;

/** Thrown when an edit names a node the locator does not know (nothing is booked). */
export class NetworkLocateError extends Error {
  constructor(readonly what: string) {
    super(`path network: no node for ${what}`);
    this.name = 'NetworkLocateError';
  }
}

/**
 * Translate one edit into scene ops. The locator is UPDATED (new nodes,
 * removed nodes), so a following edit of the same command resolves against
 * the state after this one.
 */
export function networkEditToOps(edit: NetworkEdit, loc: NetworkLocator): RvOp[] {
  const ops: RvOp[] = [];
  const needsNetwork = edit.addBlocks.length > 0 || edit.add.some((p) => !p.block);
  if (needsNetwork && loc.networkPath === null) {
    const spec = bareSpec(loc.rootPath, PATH_NETWORK_NODE, {});
    ops.push(addNodeOp(spec));
    loc.networkPath = `${loc.rootPath}/${PATH_NETWORK_NODE}`;
    loc.specs.set(loc.networkPath, spec);
  }
  for (const b of edit.addBlocks) {
    const spec = bareSpec(loc.networkPath!, b.id, { [PATH_BLOCK_TYPE]: clone(b.extras) as unknown as Record<string, unknown> });
    ops.push(addNodeOp(spec));
    const p = `${spec.parentPath}/${spec.name}`;
    loc.blockNodes.set(b.id, p);
    loc.specs.set(p, spec);
  }
  for (const e of edit.add) {
    const parent = e.block ? loc.blockNodes.get(e.block) : loc.networkPath;
    if (parent === undefined || parent === null) throw new NetworkLocateError(`block ${e.block}`);
    const spec = bareSpec(parent, e.nodeName || e.id, { Path: pathPayload(e) });
    ops.push(addNodeOp(spec));
    const p = `${parent}/${spec.name}`;
    loc.pathNodes.set(e.id, p);
    loc.specs.set(p, spec);
  }
  for (const s of edit.set) {
    const p = loc.pathNodes.get(s.id);
    if (!p) throw new NetworkLocateError(`path ${s.id}`);
    ops.push(setFieldOp(p, 'Path', s.field, clone(s.value ?? null), clone(s.prev ?? null)));
  }
  for (const b of edit.setBlocks) {
    const p = loc.blockNodes.get(b.id);
    if (!p) throw new NetworkLocateError(`block ${b.id}`);
    const v = b.value as unknown as Record<string, unknown>;
    const o = b.prev as unknown as Record<string, unknown>;
    for (const f of BLOCK_FIELDS) {
      if (JSON.stringify(v[f] ?? null) === JSON.stringify(o[f] ?? null)) continue;
      ops.push(setFieldOp(p, PATH_BLOCK_TYPE, f, clone(v[f] ?? null), clone(o[f] ?? null)));
    }
  }
  for (const r of edit.agvRewrites) {
    const comp = loc.vehicleComponent.get(r.agvNode) ?? 'Agv';
    if (r.pathId !== r.prevPathId) ops.push(setFieldOp(r.agvNode, comp, 'PathId', r.pathId, r.prevPathId));
    if (r.startPositionMm !== r.prevStartPositionMm) {
      ops.push(setFieldOp(r.agvNode, comp, 'StartPosition', r.startPositionMm, r.prevStartPositionMm));
    }
  }
  for (const id of edit.remove) {
    const p = loc.pathNodes.get(id);
    const spec = p ? loc.specs.get(p) : undefined;
    if (!p || !spec) throw new NetworkLocateError(`path ${id}`);
    ops.push(removeNodeOp(p, spec, loc.authored?.has(p) ?? false));
    loc.pathNodes.delete(id);
    loc.specs.delete(p);
  }
  for (const id of edit.removeBlocks) {
    const p = loc.blockNodes.get(id);
    const spec = p ? loc.specs.get(p) : undefined;
    if (!p || !spec) throw new NetworkLocateError(`block ${id}`);
    ops.push(removeNodeOp(p, spec, loc.authored?.has(p) ?? false));
    loc.blockNodes.delete(id);
    loc.specs.delete(p);
  }
  // Keep the stored specs current, so a later removeNode of a written node carries its new content.
  for (const s of edit.set) {
    const spec = loc.specs.get(loc.pathNodes.get(s.id) ?? '');
    if (spec) (spec.components.Path ??= {})[s.field] = clone(s.value ?? null);
  }
  for (const b of edit.setBlocks) {
    const spec = loc.specs.get(loc.blockNodes.get(b.id) ?? '');
    if (spec) spec.components[PATH_BLOCK_TYPE] = clone(b.value) as unknown as Record<string, unknown>;
  }
  return ops;
}

/** The snapshot after `edit` (pure) — for commands that chain several ops. */
export function foldEdit(net: NetworkInput, edit: NetworkEdit): NetworkInput {
  const removed = new Set(edit.remove);
  const paths = new Map<string, PathGraphEntry>();
  for (const p of net.paths) if (!removed.has(p.id) && !paths.has(p.id)) paths.set(p.id, clone(p));
  for (const p of edit.add) paths.set(p.id, clone(p));
  for (const s of edit.set) {
    const p = paths.get(s.id);
    if (!p) continue;
    const v = s.value === null ? undefined : clone(s.value);
    (p as unknown as Record<string, unknown>)[s.field] = v;
    if (v === undefined) delete (p as unknown as Record<string, unknown>)[s.field];
  }
  const removedBlocks = new Set(edit.removeBlocks);
  const blocks = new Map<string, BlockEntry>();
  for (const b of net.blocks ?? []) if (!removedBlocks.has(b.id)) blocks.set(b.id, clone(b));
  for (const b of edit.addBlocks) blocks.set(b.id, clone(b));
  for (const s of edit.setBlocks) {
    const b = blocks.get(s.id);
    if (b) b.extras = clone(s.value) as PathBlockExtras;
  }
  const vehicles = (net.vehicles ?? []).map((v) => {
    const r = edit.agvRewrites.find((x) => x.agvNode === v.agvNode);
    return r ? { agvNode: v.agvNode, pathId: r.pathId, startPositionMm: r.startPositionMm } : { ...v };
  });
  const taken = new Set(net.takenNames ?? []);
  for (const b of edit.addBlocks) taken.add(b.id);
  for (const p of edit.add) taken.add(p.nodeName || p.id);
  return { ...net, paths: [...paths.values()], blocks: [...blocks.values()], vehicles, takenNames: [...taken] };
}
