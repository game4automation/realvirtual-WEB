// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-unified-ops — the ONE op vocabulary behind {@link RvDocument}
 * (plan-703 Phase 0/1, contracted by plan-710 Phase 1).
 *
 * Until plan-703 there were two complete op-log documents side by side, each with
 * its own vocabulary: `EditOp` (`hmi/scene/rv-scene-edits.ts`, 14 primitives +
 * `composite`) over a scene OVERLAY on top of a base GLB, and `AssetOp`
 * (`editor/rv-asset-ops.ts`, 14 primitives + `composite`) over the AUTHORED GLB
 * itself. Three names looked shared; only two payloads actually were.
 *
 * plan-703 built this merged union ALONGSIDE those two, bridged by an
 * up-/downcast on every apply. plan-710 finished the job: the two legacy names
 * are gone, mutators construct `RvOp` directly, and the executors take the
 * origin-filtered SUBSETS defined below instead of a second vocabulary. What is
 * left of the old shapes is one nine-line read-side rename for persisted scene
 * logs ({@link normalizePersistedSceneOp}).
 *
 * ── Phase-0 decisions, one line each (full table in the plan, §2.2.2) ────────
 *
 *  P1  `setNodeTransform` (scene) ↔ `transformNode` (asset) → **MERGED** into
 *      `transformNode` with an OPTIONAL `scale`. `scale === undefined` is not a
 *      default, it is the scene lineage: the executor then runs the frozen-safe
 *      position/quaternion path and never writes `node.scale`. `[1,1,1]` is
 *      never substituted.
 *  P2  `addNode` (scene) ↔ `createNode` (asset) → **NOT merged.** Different
 *      payload (component-bearing `NodeSpec` vs. bare transform+index),
 *      different construction (component factory vs. plain `Object3D`) and
 *      different undo (destroy+recreate vs. detach-to-trash). Both kinds live on.
 *  P3  `removeNode` (scene) ↔ `deleteNode` (asset) → **NOT merged.** `removeNode`
 *      carries the full spec and only reaches op-created nodes; `deleteNode`
 *      carries only a path, reaches ANY subtree and undoes through the trash
 *      group. Neither can express the other without loss. Both kinds live on.
 *
 * Net: 25 primitives + `composite`. (14 + 14 − 2 identical − 1 merged.)
 *
 * Pure module — no Three.js, no DOM, no storage. Application to a live scene is
 * `rv-unified-executors.ts`; the queue/undo machinery is `rv-document.ts`.
 */

import type {
  SetFieldOp,
  UnsetFieldOp,
  AddPlacementOp,
  RemovePlacementOp,
  TransformPlacementOp,
  SetCameraOp,
  SetCodeOp,
  AddNodeOp,
  RemoveNodeOp,
  AddConnectionOp,
  RemoveConnectionOp,
  SetConnectionTypeOp,
  RemoveConnectionTypeOp,
} from '../hmi/scene/rv-scene-edits';
import type {
  ImportCadOp,
  RenameNodeOp,
  DeleteNodeOp,
  SetNodeVisibleOp,
  CreateNodeOp,
  ReparentNodeOp,
  AddComponentOp,
  RemoveComponentOp,
  SetMaterialOp,
  SeparateMeshOp,
  MergeMeshOp,
} from '../editor/rv-asset-ops';
import { COALESCE_WINDOW_MS, deepCloneJSON, freshOpId } from './rv-op-utils';

// ─── Header ─────────────────────────────────────────────────────────────

/**
 * Common header of every unified op — the SUPERSET of the two legacy headers.
 *
 * The scene lineage's header carried the optional selection fields, the asset
 * lineage's did not. Making them optional here is what let every asset-lineage
 * record become an `RvOp` without any rewriting at all — the reason the merge
 * needed exactly one payload rename and no data migration.
 */
export interface RvOpHeader {
  /** Stable id (`op_<base36-time>_<rand6>`) — stack identity + coalescing. */
  id: string;
  /** Wall-clock timestamp at op creation. Display + coalescing window. */
  ts: number;
  /** Op-shape version. Bump + add an upcaster when a kind's payload changes. */
  schemaV: 1;
  /** Node path to select after forward / before inverse (scene lineage). */
  selectionAfter?: string | null;
  selectionBefore?: string | null;
}

/** Widen a legacy op to the unified header (a no-op for scene-lineage ops). */
type WithHeader<T> = T & RvOpHeader;

// ─── The merged transform op (Phase-0 decision P1) ──────────────────────

/**
 * A node's local TRS, with `scale` OPTIONAL.
 *
 * The optionality is the whole point of the merge and must not be "fixed" by a
 * default. `rv-scene-edits.ts:92-96` states it for the scene lineage: "scale is
 * deliberately untouched (GLB nodes may carry mirror scale that must survive)" —
 * Unity-exported IKTarget nodes ship `scale (-1,1,1)`. Substituting `[1,1,1]`
 * on upcast would mirror-flip every such node the first time an old log replays.
 */
export interface RvNodeTransform {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  /**
   * Present = asset lineage (authored GLB, full TRS is the user's intent).
   * Absent  = scene lineage (overlay on a base GLB, scale belongs to the GLB).
   *
   * NEVER defaulted. The executor branches on presence, not on the document mode,
   * which is exactly what keeps an upcast legacy log replaying the way it always did.
   */
  scale?: [number, number, number];
}

/** Set a node's local transform. Merged from `setNodeTransform` + `transformNode`. */
export interface RvTransformNodeOp extends RvOpHeader {
  kind: 'transformNode';
  nodePath: string;
  transform: RvNodeTransform;
  prev: RvNodeTransform;
}

// ─── Shared kinds (identical payload in both vocabularies) ──────────────

/** origin: both — `rv-asset-ops.ts:160-161` states the payload parity explicitly. */
export type RvSetFieldOp = WithHeader<SetFieldOp>;
/** origin: both */
export type RvUnsetFieldOp = WithHeader<UnsetFieldOp>;

// ─── Scene-lineage kinds ────────────────────────────────────────────────

/** origin: scene */
export type RvAddPlacementOp = WithHeader<AddPlacementOp>;
/** origin: scene */
export type RvRemovePlacementOp = WithHeader<RemovePlacementOp>;
/** origin: scene */
export type RvTransformPlacementOp = WithHeader<TransformPlacementOp>;
/** origin: scene */
export type RvSetCameraOp = WithHeader<SetCameraOp>;
/** origin: scene */
export type RvSetCodeOp = WithHeader<SetCodeOp>;
/** origin: scene — component-bearing node factory. NOT `createNode` (decision P2). */
export type RvAddNodeOp = WithHeader<AddNodeOp>;
/** origin: scene — removes an op-created node only. NOT `deleteNode` (decision P3). */
export type RvRemoveNodeOp = WithHeader<RemoveNodeOp>;
/** origin: scene */
export type RvAddConnectionOp = WithHeader<AddConnectionOp>;
/** origin: scene */
export type RvRemoveConnectionOp = WithHeader<RemoveConnectionOp>;
/** origin: scene */
export type RvSetConnectionTypeOp = WithHeader<SetConnectionTypeOp>;
/** origin: scene */
export type RvRemoveConnectionTypeOp = WithHeader<RemoveConnectionTypeOp>;

// ─── Asset-lineage kinds ────────────────────────────────────────────────

/** origin: asset */
export type RvImportCadOp = WithHeader<ImportCadOp>;
/** origin: asset */
export type RvRenameNodeOp = WithHeader<RenameNodeOp>;
/** origin: asset — detach-to-trash undo, reaches ANY subtree (decision P3). */
export type RvDeleteNodeOp = WithHeader<DeleteNodeOp>;
/** origin: asset */
export type RvSetNodeVisibleOp = WithHeader<SetNodeVisibleOp>;
/** origin: asset — bare `Object3D`, deduped at op creation (decision P2). */
export type RvCreateNodeOp = WithHeader<CreateNodeOp>;
/** origin: asset */
export type RvReparentNodeOp = WithHeader<ReparentNodeOp>;
/** origin: asset */
export type RvAddComponentOp = WithHeader<AddComponentOp>;
/** origin: asset */
export type RvRemoveComponentOp = WithHeader<RemoveComponentOp>;
/** origin: asset */
export type RvSetMaterialOp = WithHeader<SetMaterialOp>;
/** origin: asset */
export type RvSeparateMeshOp = WithHeader<SeparateMeshOp>;
/** origin: asset */
export type RvMergeMeshOp = WithHeader<MergeMeshOp>;

// ─── Composite ──────────────────────────────────────────────────────────

/** origin: both — same form in both vocabularies; composites never nest. */
export interface RvCompositeOp extends RvOpHeader {
  kind: 'composite';
  label: string;
  ops: RvPrimitiveOp[];
}

// ─── The union ──────────────────────────────────────────────────────────

/** Ops that may appear inside a composite (composites can't nest). */
export type RvPrimitiveOp =
  // shared
  | RvSetFieldOp
  | RvUnsetFieldOp
  | RvTransformNodeOp
  // scene lineage
  | RvAddPlacementOp
  | RvRemovePlacementOp
  | RvTransformPlacementOp
  | RvSetCameraOp
  | RvSetCodeOp
  | RvAddNodeOp
  | RvRemoveNodeOp
  | RvAddConnectionOp
  | RvRemoveConnectionOp
  | RvSetConnectionTypeOp
  | RvRemoveConnectionTypeOp
  // asset lineage
  | RvImportCadOp
  | RvRenameNodeOp
  | RvDeleteNodeOp
  | RvSetNodeVisibleOp
  | RvCreateNodeOp
  | RvReparentNodeOp
  | RvAddComponentOp
  | RvRemoveComponentOp
  | RvSetMaterialOp
  | RvSeparateMeshOp
  | RvMergeMeshOp;

/** Anything that may appear in an {@link RvDocument} op log. */
export type RvOp = RvPrimitiveOp | RvCompositeOp;

export type RvOpKind = RvOp['kind'];

/** Which legacy vocabulary a kind came from. `both` = identical payload. */
export type RvOpOrigin = 'scene' | 'asset' | 'both';

/**
 * Origin of every kind — the machine-checkable form of the Phase-0 table.
 *
 * Pinned by `rv-op-semantics-pinning.test.ts`: a kind that quietly changes
 * lineage here changes which executor it reaches, which is exactly the silent
 * merge the plan forbids.
 */
const RV_OP_ORIGIN_TABLE = {
  setField: 'both',
  unsetField: 'both',
  composite: 'both',
  // merged (P1): the payload carries scene lineage as `scale === undefined`
  transformNode: 'both',
  // scene only
  addPlacement: 'scene',
  removePlacement: 'scene',
  transformPlacement: 'scene',
  setCamera: 'scene',
  setCode: 'scene',
  addNode: 'scene',
  removeNode: 'scene',
  addConnection: 'scene',
  removeConnection: 'scene',
  setConnectionType: 'scene',
  removeConnectionType: 'scene',
  // asset only
  importCad: 'asset',
  renameNode: 'asset',
  deleteNode: 'asset',
  setNodeVisible: 'asset',
  createNode: 'asset',
  reparentNode: 'asset',
  addComponent: 'asset',
  removeComponent: 'asset',
  setMaterial: 'asset',
  separateMesh: 'asset',
  mergeMesh: 'asset',
} as const;

export const RV_OP_ORIGIN: Readonly<Record<RvOpKind, RvOpOrigin>> = Object.freeze(RV_OP_ORIGIN_TABLE);

/** Every kind in the union, sorted — the count is pinned by the tests. */
export const RV_OP_KINDS: readonly RvOpKind[] =
  Object.freeze((Object.keys(RV_OP_ORIGIN) as RvOpKind[]).slice().sort());

// ─── Origin-filtered subsets (plan-710 §2.2) ────────────────────────────
//
// The two executors write to genuinely different targets, so their signatures
// want the SUBSET of the union they can actually apply. Before plan-710 that
// subset had a second NAME (`EditOp` / `AssetOp`) in a second file, kept in step
// by hand and bridged by an up-/downcast on every apply. Here it is DERIVED from
// the origin table instead: one vocabulary, two views of it, and a kind that
// changes lineage in the table moves between the views by itself.

type KindsWithOrigin<O extends RvOpOrigin> = {
  [K in keyof typeof RV_OP_ORIGIN_TABLE]:
    (typeof RV_OP_ORIGIN_TABLE)[K] extends O ? K : never;
}[keyof typeof RV_OP_ORIGIN_TABLE];

/** Kinds a SCENE-mode document can hold: scene lineage plus the shared ones. */
export type RvSceneOpKind = KindsWithOrigin<'scene' | 'both'>;
/** Kinds an ASSET-mode document can hold: asset lineage plus the shared ones. */
export type RvAssetOpKind = KindsWithOrigin<'asset' | 'both'>;

/** Anything a scene-lineage executor / mutator may see. */
export type RvSceneOp = Extract<RvOp, { kind: RvSceneOpKind }>;
/** Scene-lineage ops that may appear inside a composite. */
export type RvScenePrimitiveOp = Extract<RvPrimitiveOp, { kind: RvSceneOpKind }>;
/** Anything an asset-lineage executor / mutator may see. */
export type RvAssetOp = Extract<RvOp, { kind: RvAssetOpKind }>;
/** Asset-lineage ops that may appear inside a composite. */
export type RvAssetPrimitiveOp = Extract<RvPrimitiveOp, { kind: RvAssetOpKind }>;

// ─── Composite constructors, typed by origin ────────────────────────────
//
// `RvCompositeOp.ops` is `RvPrimitiveOp[]` and deliberately NOT
// origin-restricted: splitting the union in two would recreate the very pair of
// vocabularies this module replaced, and a composite is the one place a
// mixed-lineage log is at least conceivable. The compile-time guarantee is put
// back HERE, at the point of construction, where the lineage is known — so a
// scene mutator cannot smuggle an asset-only op into a scene composite, while a
// composite read back from storage stays assignable without a cast.
//
// The runtime counterpart is `resolveOpTarget`'s defensive split
// (`rv-unified-executors.ts`), which routes a genuinely mixed composite child by
// child instead of crashing. Both halves are pinned by
// `rv-op-single-vocabulary.test.ts`.

function compositeOf(label: string, ops: RvPrimitiveOp[]): RvCompositeOp {
  return { id: freshOpId(), ts: Date.now(), schemaV: 1, kind: 'composite', label, ops };
}

/** Build a composite from SCENE-lineage primitives. */
export function makeSceneComposite(label: string, ops: RvScenePrimitiveOp[]): RvCompositeOp {
  return compositeOf(label, ops);
}

/** Build a composite from ASSET-lineage primitives. */
export function makeAssetComposite(label: string, ops: RvAssetPrimitiveOp[]): RvCompositeOp {
  return compositeOf(label, ops);
}

/** Build a composite for the given document mode — the shared-helper form. */
export function makeComposite(
  mode: 'scene' | 'asset',
  label: string,
  ops: RvPrimitiveOp[],
): RvCompositeOp {
  return mode === 'scene'
    ? makeSceneComposite(label, ops as RvScenePrimitiveOp[])
    : makeAssetComposite(label, ops as RvAssetPrimitiveOp[]);
}

// ─── Persisted-record normalisation (schema evolution, NOT a shim) ──────

/**
 * The one kind rename this vocabulary ever performed, applied ON READ.
 *
 * Scene op logs are PERSISTED (`RvScene.edits.ops`), and a log written before
 * plan-710 stores the scene transform under its old kind name
 * `setNodeTransform`, with `position`/`quaternion` flat on the record instead of
 * inside a `transform` object. Every other kind is byte-identical across the
 * rename, which is why this function is nine lines rather than a module.
 *
 * It runs where a persisted log ENTERS the session and nowhere else. That is the
 * difference between schema evolution and the up-/downcast layer plan-710
 * deleted: nothing converts on the way out, no second vocabulary exists to
 * convert to, and an op already in this shape passes through by reference.
 *
 * `scale` is NEVER invented here. The absent scale IS the scene lineage — see
 * {@link RvNodeTransform}; Unity ships IKTarget nodes at `(-1,1,1)` and a
 * substituted identity would mirror-flip them on the first replay.
 */
export function normalizePersistedSceneOp(op: RvOp): RvOp {
  const legacy = op as unknown as LegacySetNodeTransformRecord;
  if (legacy.kind === 'setNodeTransform') {
    const { position, quaternion, prev, kind: _kind, ...header } = legacy;
    return {
      ...header,
      kind: 'transformNode',
      nodePath: legacy.nodePath,
      transform: { position, quaternion },
      prev: { position: prev.position, quaternion: prev.quaternion },
    };
  }
  if (op.kind === 'composite') {
    const children = op.ops.map((child) => normalizePersistedSceneOp(child) as RvPrimitiveOp);
    // Reference-stable when nothing changed: op-id equality drives `dirty`, and
    // rewriting an untouched log would report a clean document as modified.
    if (children.every((child, i) => child === op.ops[i])) return op;
    return { ...op, ops: children };
  }
  return op;
}

/** {@link normalizePersistedSceneOp} over a whole persisted log. */
export function normalizePersistedSceneOps(ops: readonly RvOp[]): RvOp[] {
  return ops.map(normalizePersistedSceneOp);
}

/** The pre-plan-710 on-disk shape of the scene transform op. Read-only. */
interface LegacySetNodeTransformRecord extends RvOpHeader {
  kind: 'setNodeTransform';
  nodePath: string;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  prev: {
    position: [number, number, number];
    quaternion: [number, number, number, number];
  };
}

// ─── Coalescing ─────────────────────────────────────────────────────────

/**
 * Should two adjacent ops merge into one history entry?
 *
 * The union of both legacy rule sets, kind by kind — no rule was widened. The
 * caller only ever compares against the CURRENT head, which is what gives the
 * plan's "no intervening foreign op" property for free.
 */
export function canCoalesceRvOps(last: RvOp, next: RvOp): boolean {
  if (last.kind !== next.kind) return false;
  if (last.kind === 'composite' || next.kind === 'composite') return false;
  if (next.ts - last.ts > COALESCE_WINDOW_MS) return false;
  if (next.ts < last.ts) return false; // clock went backwards — don't coalesce
  switch (next.kind) {
    case 'setField':
    case 'unsetField': {
      const a = last as RvSetFieldOp | RvUnsetFieldOp;
      return a.nodePath === next.nodePath
        && a.componentType === next.componentType
        && a.fieldName === next.fieldName;
    }
    case 'transformNode':
      return (last as RvTransformNodeOp).nodePath === next.nodePath;
    case 'transformPlacement':
      return (last as RvTransformPlacementOp).placementId === next.placementId;
    case 'setCamera':
      return true; // camera coalesces unconditionally on consecutive saves
    case 'setCode':
      return (last as RvSetCodeOp).nodePath === next.nodePath;
    case 'setConnectionType':
      return (last as RvSetConnectionTypeOp).connectionType.type === next.connectionType.type;
    case 'renameNode':
      return (last as RvRenameNodeOp).nodePath === next.nodePath;
    case 'setMaterial': {
      const a = last as RvSetMaterialOp;
      return a.nodePaths.length === next.nodePaths.length
        && a.nodePaths.every((p, i) => p === next.nodePaths[i]);
    }
    // Structural / discrete user actions — never coalesce, in EITHER lineage.
    case 'addPlacement':
    case 'removePlacement':
    case 'addNode':
    case 'removeNode':
    case 'addConnection':
    case 'removeConnection':
    case 'removeConnectionType':
    case 'importCad':
    case 'deleteNode':
    case 'setNodeVisible':
    case 'createNode':
    case 'reparentNode':
    case 'addComponent':
    case 'removeComponent':
    case 'separateMesh':
    case 'mergeMesh':
      return false;
  }
}

/**
 * Merge `next` into `last` (caller verified {@link canCoalesceRvOps}).
 *
 * Keeps `last.id`, `last.ts` and `last.prev`, takes `next`'s forward payload —
 * so ONE undo after the run reverts to the state before the FIRST op.
 */
export function mergeRvOps(last: RvOp, next: RvOp): RvOp {
  if (last.kind !== next.kind || last.kind === 'composite' || next.kind === 'composite') {
    throw new Error('mergeRvOps: precondition violated — call canCoalesceRvOps first');
  }
  switch (next.kind) {
    case 'setField':
      return { ...(last as RvSetFieldOp), value: next.value };
    case 'unsetField':
      return last; // identical target → same op
    case 'transformNode':
      return { ...(last as RvTransformNodeOp), transform: deepCloneJSON(next.transform) };
    case 'transformPlacement': {
      const a = last as RvTransformPlacementOp;
      return { ...a, position: next.position, rotation: next.rotation, scale: next.scale };
    }
    case 'setCamera':
      return { ...(last as RvSetCameraOp), preset: next.preset };
    case 'setCode':
      return { ...(last as RvSetCodeOp), code: next.code };
    case 'setConnectionType':
      return { ...(last as RvSetConnectionTypeOp), connectionType: next.connectionType };
    case 'renameNode':
      return { ...(last as RvRenameNodeOp), name: next.name };
    case 'setMaterial':
      return { ...(last as RvSetMaterialOp), material: deepCloneJSON(next.material) };
    default:
      throw new Error(`mergeRvOps: ${next.kind} never coalesces`);
  }
}

// ─── Hierarchy classification ───────────────────────────────────────────

/**
 * True when applying (or inverting) this op changes what the hierarchy panel
 * shows. Union of both legacy classifiers; transforms and field edits are not
 * structural in either lineage.
 */
export function rvOpTouchesHierarchy(op: RvOp): boolean {
  if (op.kind === 'composite') return op.ops.some(rvOpTouchesHierarchy);
  switch (op.kind) {
    case 'addNode':
    case 'removeNode':
    case 'importCad':
    case 'deleteNode':
    case 'setNodeVisible':
    case 'renameNode':
    case 'createNode':
    case 'reparentNode':
    case 'addComponent':
    case 'removeComponent':
    case 'separateMesh':
    case 'mergeMesh':
      return true;
    default:
      return false;
  }
}

// ─── Description (undo/redo labels, history UI) ─────────────────────────

/** Short human-readable label. Wording carried over from both legacy describers. */
export function describeRvOp(op: RvOp): string {
  switch (op.kind) {
    case 'setField':
      return `Set ${op.componentType}.${op.fieldName} = ${formatValue(op.value)} on ${leaf(op.nodePath)}`;
    case 'unsetField':
      return `Reset ${op.componentType}.${op.fieldName} on ${leaf(op.nodePath)}`;
    case 'transformNode':
      return op.transform.scale ? `Transform ${leaf(op.nodePath)}` : `Move ${leaf(op.nodePath)}`;
    case 'addPlacement':      return `Add ${op.placement.label}`;
    case 'removePlacement':   return `Remove ${op.placement.label}`;
    case 'transformPlacement':return `Move ${shortId(op.placementId)}`;
    case 'setCamera':         return op.preset ? 'Set camera view' : 'Clear camera view';
    case 'setCode':           return `Edit script on ${leaf(op.nodePath)}`;
    case 'addNode':           return `Add ${op.spec.name}`;
    case 'removeNode':        return `Remove ${op.spec.name}`;
    case 'addConnection':
      return `Connect ${leaf(op.connection.source)} → ${leaf(op.connection.target)} (${op.connection.type})`;
    case 'removeConnection':
      return `Disconnect ${leaf(op.connection.source)} → ${leaf(op.connection.target)}`;
    case 'setConnectionType':   return `Edit connection type ${op.connectionType.type}`;
    case 'removeConnectionType':return `Remove connection type ${op.connectionType.type}`;
    case 'importCad':         return `Import ${op.cadlink.File}`;
    case 'renameNode':        return `Rename ${op.prevName} → ${op.name}`;
    case 'deleteNode':        return `Delete ${leaf(op.nodePath)}`;
    case 'setNodeVisible':    return op.visible ? `Show ${leaf(op.nodePath)}` : `Hide ${leaf(op.nodePath)}`;
    case 'createNode':        return `Create ${leaf(op.nodePath)}`;
    case 'reparentNode':      return `Move ${leaf(op.nodePath)}`;
    case 'addComponent':      return `Add ${op.componentType} to ${leaf(op.nodePath)}`;
    case 'removeComponent':   return `Remove ${op.componentType} from ${leaf(op.nodePath)}`;
    case 'setMaterial':
      return `Material ${op.material.name} (${op.prev.length} mesh${op.prev.length === 1 ? '' : 'es'})`;
    case 'separateMesh':      return `Separate ${leaf(op.sourcePath)} (${op.childNames.length} parts)`;
    case 'mergeMesh':
      return `Merge ${leaf(op.rootPath)} (${op.sourcePaths.length} → ${op.outputs.length} mesh${op.outputs.length === 1 ? '' : 'es'})`;
    case 'composite':         return op.label;
  }
}

function leaf(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) + '…' : id;
}

function formatValue(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'number') {
    return Number.isInteger(v) ? v.toString() : v.toFixed(3).replace(/\.?0+$/, '');
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return v.length > 20 ? `"${v.slice(0, 20)}…"` : `"${v}"`;
  if (Array.isArray(v)) return `[${v.length}]`;
  return '{…}';
}
