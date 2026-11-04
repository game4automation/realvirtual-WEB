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
 * plan-621 added a 26th, the asset-lineage `replaceNodeGeometry` — a new kind,
 * not a merge; the arithmetic above describes the union plan-703 built.
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
  CloneNodeOp,
  ReparentNodeOp,
  AddComponentOp,
  RemoveComponentOp,
  SetMaterialOp,
  SeparateMeshOp,
  MergeMeshOp,
  ReplaceNodeGeometryOp,
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
/** origin: asset — a mesh node's geometry, swapped by cache hash (plan-621). */
export type RvReplaceNodeGeometryOp = WithHeader<ReplaceNodeGeometryOp>;
/** origin: asset — deep copy of a live subtree (plan-641 Phase 3). */
export type RvCloneNodeOp = WithHeader<CloneNodeOp>;

// ─── Composite ──────────────────────────────────────────────────────────

/**
 * Metadata of a history entry (plan-590). Lives on the COMPOSITE — the one
 * record a transaction produces — and survives the flattening of nested
 * composites (`RvDocument.endTransaction` lifts it to the top level).
 */
export interface RvOpMeta {
  /**
   * The signal-rename journal this entry belongs to. An entry carrying it is
   * one third of a stores-spanning operation (model + CONNECT + planner):
   * `RvDocument` hands its undo/redo to the history interceptor instead of
   * replaying only the model part.
   */
  journalId?: string;
  /**
   * plan-610: this composite is a reference-safe rename/move as a WHOLE
   * (structure ops + the `setField` steps that rewrite the referrers). The
   * asset executor defers the referrers' schema re-apply + reference
   * resolution to the END of the composite and re-binds foreign referrers
   * there — forward, inverse and rollback. Absent on every other composite
   * (their behaviour is unchanged).
   */
  referenceRewrite?: true;
  /**
   * plan-610: index ranges `[start, endExclusive]` of the reference-rewrite
   * GROUPS inside this composite's op list. Written when a marked composite is
   * flattened into a transaction entry next to unmarked siblings: only the ops
   * of a range run in a deferred re-bind session, the siblings keep today's
   * immediate behaviour (e.g. `Drive.Offset` + `transformNode`). A composite
   * carrying {@link referenceRewrite} is the special case "one range over all".
   */
  referenceRewriteRanges?: Array<[number, number]>;
}

/** origin: both — same form in both vocabularies; composites never nest. */
export interface RvCompositeOp extends RvOpHeader {
  kind: 'composite';
  label: string;
  ops: RvPrimitiveOp[];
  /** Optional entry metadata (plan-590) — absent on every ordinary composite. */
  meta?: RvOpMeta;
}

/** plan-610: does this op carry a reference-rewrite marker (whole composite or ranges)? */
export function isReferenceRewriteOp(op: RvOp | null | undefined): boolean {
  return referenceRewriteRangesOf(op).length > 0;
}

/**
 * plan-610: the reference-rewrite ranges of a composite, normalised — `[[0, n]]`
 * for a wholly marked one, the validated (in bounds, non-empty, ascending,
 * non-overlapping) `referenceRewriteRanges` otherwise, `[]` for anything else.
 * A malformed persisted range is dropped rather than trusted: a range over the
 * wrong ops would re-order their configuration effects.
 */
export function referenceRewriteRangesOf(op: RvOp | null | undefined): ReadonlyArray<readonly [number, number]> {
  if (!op || op.kind !== 'composite' || op.ops.length === 0) return [];
  const n = op.ops.length;
  if (op.meta?.referenceRewrite === true) return [[0, n]];
  const raw: unknown = op.meta?.referenceRewriteRanges;
  if (!Array.isArray(raw)) return [];
  const out: Array<readonly [number, number]> = [];
  let floor = 0;
  for (const r of raw as unknown[]) {
    if (!Array.isArray(r) || r.length !== 2) continue;
    const [start, end] = r as [unknown, unknown];
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    const s = start as number;
    const e = end as number;
    if (s < floor || e <= s || e > n) continue;
    out.push([s, e]);
    floor = e;
  }
  return out;
}

/** The signal-rename journal id of a history entry, if it carries one (plan-590). */
export function journalIdOf(op: RvOp | null | undefined): string | undefined {
  if (!op || op.kind !== 'composite') return undefined;
  const id = op.meta?.journalId;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
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
  | RvMergeMeshOp
  | RvReplaceNodeGeometryOp
  | RvCloneNodeOp;

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
  replaceNodeGeometry: 'asset',
  // plan-641 Phase 3: a 27th kind (asset lineage), the subtree copy of `editor.clone`.
  cloneNode: 'asset',
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

function compositeOf(label: string, ops: RvPrimitiveOp[], meta?: RvOpMeta): RvCompositeOp {
  const op: RvCompositeOp = { id: freshOpId(), ts: Date.now(), schemaV: 1, kind: 'composite', label, ops };
  // Only a meta that says something is written: an ordinary composite keeps
  // exactly its old shape (persisted logs, op-equality tests).
  if (meta && (meta.journalId || meta.referenceRewrite || (meta.referenceRewriteRanges?.length ?? 0) > 0)) {
    op.meta = { ...meta };
  }
  return op;
}

/** Build a composite from SCENE-lineage primitives. */
export function makeSceneComposite(label: string, ops: RvScenePrimitiveOp[], meta?: RvOpMeta): RvCompositeOp {
  return compositeOf(label, ops, meta);
}

/** Build a composite from ASSET-lineage primitives. */
export function makeAssetComposite(label: string, ops: RvAssetPrimitiveOp[], meta?: RvOpMeta): RvCompositeOp {
  return compositeOf(label, ops, meta);
}

/** Build a composite for the given document mode — the shared-helper form. */
export function makeComposite(
  mode: 'scene' | 'asset',
  label: string,
  ops: RvPrimitiveOp[],
  meta?: RvOpMeta,
): RvCompositeOp {
  return mode === 'scene'
    ? makeSceneComposite(label, ops as RvScenePrimitiveOp[], meta)
    : makeAssetComposite(label, ops as RvAssetPrimitiveOp[], meta);
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
    // plan-621: an absolute setter of one node's geometry. Same node AND the
    // same cache namespace, so `prevSha256` of the first and `sha256` of the
    // newest address one cache, and one undo returns to the first geometry.
    case 'replaceNodeGeometry':
      return sameGeometryTarget(last as RvReplaceNodeGeometryOp, next);
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
    case 'cloneNode':
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
    case 'replaceNodeGeometry':
      // `prevSha256` of the FIRST stays (the undo target), `sha256` of the newest wins.
      return { ...(last as RvReplaceNodeGeometryOp), sha256: next.sha256 };
    default:
      throw new Error(`mergeRvOps: ${next.kind} never coalesces`);
  }
}

/** Same node and the same cache namespace — the coalescing target of `replaceNodeGeometry`. */
function sameGeometryTarget(a: RvReplaceNodeGeometryOp, b: RvReplaceNodeGeometryOp): boolean {
  return a.nodePath === b.nodePath && a.quality === b.quality && a.converter === b.converter
    && JSON.stringify(a.sharedNodePaths ?? []) === JSON.stringify(b.sharedNodePaths ?? []);
}

// ─── Keyed composite coalescing (plan-621, Spike (b) V2 "keyed amend") ──
//
// Two consecutive transaction entries that carry the same coalesce key (one
// live CAD-sync session, say) become ONE undo entry. Pure function; the guards
// (key, sliding window, clean point, chain break) live in
// `RvDocument._recordKeyed`.
//
// Merge = "amend the top entry": `next`'s children are appended to `top`,
// EXCEPT a child that is an absolute state SETTER whose target already has a
// setter in the entry and that COMMUTES with every op standing between that
// setter and the end of the entry. Such a child is FOLDED into the earlier
// setter (keeps that setter's id and `prev`, takes the child's forward payload)
// — the rule `mergeRvOps` applies to adjacent primitives. The folded child's id
// leaves the history; it is returned in `absorbed` so the executor can drop
// what it stashed for it (the intermediate material / geometry no undo reaches).
//
// Reference-rewrite ranges are never folded into or across; they are carried
// over with their indices shifted to where their ops land.

/** Kinds that set an absolute state of exactly one target. */
const SETTER_KINDS: ReadonlySet<RvOpKind> = new Set<RvOpKind>([
  'transformNode', 'setField', 'setMaterial', 'replaceNodeGeometry',
]);

/** The node path(s) a setter writes to. */
function setterPaths(op: RvPrimitiveOp): readonly string[] {
  switch (op.kind) {
    case 'transformNode':
    case 'setField':
      return [op.nodePath];
    case 'replaceNodeGeometry':
      return [op.nodePath, ...(op.sharedNodePaths ?? [])];
    case 'setMaterial':
      return op.nodePaths;
    default:
      return [];
  }
}

/** Same target in the `mergeRvOps` sense (the time window is the document's business). */
function sameSetterTarget(a: RvPrimitiveOp, b: RvPrimitiveOp): boolean {
  if (a.kind !== b.kind) return false;
  switch (b.kind) {
    case 'transformNode':
      return (a as RvTransformNodeOp).nodePath === b.nodePath;
    case 'setField': {
      const x = a as RvSetFieldOp;
      return x.nodePath === b.nodePath && x.componentType === b.componentType && x.fieldName === b.fieldName;
    }
    case 'setMaterial': {
      const x = a as RvSetMaterialOp;
      return x.nodePaths.length === b.nodePaths.length && x.nodePaths.every((p, i) => p === b.nodePaths[i]);
    }
    case 'replaceNodeGeometry':
      return sameGeometryTarget(a as RvReplaceNodeGeometryOp, b);
    default:
      return false;
  }
}

/** Same node, an ancestor or a descendant. */
function relatedPaths(p: string, q: string): boolean {
  return p === q || p.startsWith(q + '/') || q.startsWith(p + '/');
}

/**
 * May `a` and `b` swap their order without changing the end state? Conservative:
 *  - both must be setters, on different targets (the same target is the fold);
 *  - a `setField` RE-APPLIES its component, which may move its node
 *    (`Drive.Offset`, pinned in rewrite-composite-isolation.test.ts) or measure
 *    its geometry (collider / sensor bounds) — so a `setField` never commutes
 *    with a `transformNode` or a `replaceNodeGeometry` on a related node.
 */
function setterCommutes(a: RvPrimitiveOp, b: RvPrimitiveOp): boolean {
  if (!SETTER_KINDS.has(a.kind) || !SETTER_KINDS.has(b.kind)) return false;
  if (sameSetterTarget(a, b)) return false;
  const reapplies = (x: RvPrimitiveOp, y: RvPrimitiveOp): boolean =>
    x.kind === 'setField' && (y.kind === 'transformNode' || y.kind === 'replaceNodeGeometry');
  if (reapplies(a, b) || reapplies(b, a)) {
    for (const p of setterPaths(a)) for (const q of setterPaths(b)) if (relatedPaths(p, q)) return false;
  }
  return true;
}

/** Result of {@link foldKeyedComposite}. */
export interface KeyedCompositeFold {
  merged: RvCompositeOp;
  /** Ids of `next`'s children that were folded away — their executor stash is garbage. */
  absorbed: string[];
  /** How many of `next`'s children were appended (not folded). */
  appended: number;
}

/**
 * Amend `top` with `next` (two transaction entries of the same coalesce key).
 *
 * Returns null when the two must stay separate entries: a journaled entry
 * (plan-590) is undone by the history interceptor and addressed by its id, so
 * neither side of a merge may carry one. The merged entry keeps `top`'s id, ts
 * and label.
 */
export function foldKeyedComposite(top: RvCompositeOp, next: RvCompositeOp): KeyedCompositeFold | null {
  if (journalIdOf(top) || journalIdOf(next)) return null;
  const out: RvPrimitiveOp[] = [...top.ops];
  const topRanges = referenceRewriteRangesOf(top);
  const inRange: boolean[] = out.map(() => false);
  for (const [s, e] of topRanges) for (let i = s; i < e; i++) inRange[i] = true;
  const nextRanges = referenceRewriteRangesOf(next);
  const nextInRange = (j: number): boolean => nextRanges.some(([s, e]) => j >= s && j < e);
  const newIndexOf: number[] = [];
  const absorbed: string[] = [];

  for (let j = 0; j < next.ops.length; j++) {
    const c = next.ops[j];
    let folded = false;
    if (SETTER_KINDS.has(c.kind) && !nextInRange(j)) {
      // The newest setter of the same target in the entry so far.
      let k = -1;
      for (let i = out.length - 1; i >= 0; i--) if (sameSetterTarget(out[i], c)) { k = i; break; }
      if (k >= 0 && !inRange[k]) {
        let clear = true;
        for (let i = k + 1; i < out.length && clear; i++) {
          if (inRange[i] || !setterCommutes(out[i], c)) clear = false;
        }
        if (clear) {
          out[k] = mergeRvOps(out[k], c) as RvPrimitiveOp;
          absorbed.push(c.id);
          folded = true;
        }
      }
    }
    if (!folded) {
      newIndexOf[j] = out.length;
      out.push(c);
      inRange.push(nextInRange(j));
    }
  }

  // Ranges: top's stay where they were (a fold replaces in place); next's
  // children inside a range are never folded, so each of its ranges landed
  // contiguously and only moves. Adjacent ranges stay separate sessions.
  const ranges: Array<[number, number]> = topRanges.map(([s, e]) => [s, e]);
  for (const [s, e] of nextRanges) ranges.push([newIndexOf[s], newIndexOf[e - 1] + 1]);

  const merged: RvCompositeOp = { ...top, ops: out };
  delete merged.meta;
  if (ranges.length > 0) merged.meta = { referenceRewriteRanges: ranges };
  return { merged, absorbed, appended: next.ops.length - absorbed.length };
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
    case 'cloneNode':
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
    case 'replaceNodeGeometry': return `Update geometry of ${leaf(op.nodePath)}`;
    case 'cloneNode':         return `Clone ${leaf(op.sourcePath)} → ${leaf(op.nodePath)}`;
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
