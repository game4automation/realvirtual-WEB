// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-asset-executors — apply AssetOps to the live RVViewer scene.
 *
 * For every primitive `RvAssetOp.kind`: `applyAssetForward(op)` mutates the live
 * scene, `applyAssetInverse(op)` reverses it via the op's `prev` payload.
 * Composites fan out (forward in order, inverse in reverse). Failures are
 * caught and logged — a stale op (e.g. node renamed outside the op flow) never
 * breaks the queue.
 *
 * Structural deletes use DETACH-TO-TRASH: `deleteNode` (and the inverse of
 * `importCad`) move the subtree into a hidden trash group instead of disposing
 * it, so undo re-attaches the ORIGINAL objects (geometry, materials, userData)
 * without any serialization. The trash is flushed on save/close by the
 * AssetDocument. Draft replay never needs the trash — recovery replays forward
 * ops only.
 *
 * `importCad` never inlines geometry. The op carries only `{Sha256, Quality}`;
 * the GLB bytes they address are resolved, in order, from:
 *   1. a session-local payload map (the fresh-import path parsed them already —
 *      pure optimization, it skips a redundant re-parse of the same bytes),
 *   2. the content-addressed GLB cache (`rv-cad-glb-cache`) — this is what makes
 *      draft replay work after a reload, in the PUBLIC build too,
 *   3. the registered `CadGeometryProvider.retessellate` (private build only),
 *      for when the GLB cache was evicted but the original CAD bytes survive.
 *
 * All three yield the SAME tree, because all three parse the same GLB bytes.
 * When none of them can produce geometry the op throws
 * {@link CadGeometryUnavailableError}, which — unlike a generic executor failure
 * — is collected and surfaced to the user instead of being logged away.
 * {@link SeparateMeshUnappliedError} is the second member of that class: a
 * recorded split whose source is gone (typically the same evicted cache, one op
 * downstream) is reported, never silently skipped.
 */

import { BufferGeometry, Group, Matrix4, Mesh, Object3D } from 'three';
import { isRuntimeHelperNode } from './rv-runtime-helper-node';
import { isUnsafeObjectKey } from '../engine/rv-safe-keys';
import type { Material } from 'three';
import type { RVViewer } from '../rv-viewer';
import type { RVDrive } from '../engine/rv-drive';
import { NodeRegistry } from '../engine/rv-node-registry';
import { removeSensorsFrom } from '../engine/rv-sensor-registration';
import { isModelRoot } from '../engine/rv-model-root';
import {
  writeUserDataField,
  deleteUserDataField,
  reapplySchemaForComponent,
  syncSignalLinksRuntime,
} from '../hmi/scene/rv-scene-executors';
import {
  constructComponentOnNode,
  disposeComponentsInSubtree,
  processExtras,
  removeDriveComponentFromNode,
  type RuntimeNodeDeps,
} from '../engine/rv-scene-loader';
import { DRIVE_BEHAVIOR_MAP } from '../engine/rv-signal-construction';
import { beginSignalSyncWave, endSignalSyncWave, syncSignalSubtree } from '../engine/rv-signal-editor-sync';
import { syncPhysicsZoneBounds } from '../engine/rv-physics-zone';
import {
  computeGroupPartitions,
  computeMeshIslands,
  extractSubGeometry,
  groupModeIneligibility,
  triangleCount,
  REASON_MULTI_MATERIAL,
  REASON_SINGLE_PART,
} from './rv-mesh-separator';
import {
  buildMergedGeometry,
  materialFingerprint,
} from './rv-mesh-merge';
import { unsupportedMeshShapeReason } from '../engine/rv-mesh-guards';
import { debug } from '../engine/rv-debug';
import { parseGlbSubtree, RV_ORIG_NAME_KEY } from '../engine/rv-glb-parse';
import { compactSharedVertexPools } from './rv-mesh-compact';
import { GROUP_KEY_RE, syncNodeGroups, syncSubtreeGroups } from '../engine/rv-group-sync';
import { getCadProvider, cadFormatOfName } from './rv-cad-provider';
import { ensureMovableTransform, refreshWorldMatricesDeep } from '../engine/rv-node-transform';
import { getCadGlb, type CadConverter } from '../import/rv-cad-glb-cache';
import { weldImportedGlb } from '../import/rv-glb-weld';
import { materialForValue } from './rv-asset-material';
import { assetOpTouchesHierarchy } from './rv-asset-ops';
import type { RvAssetOp, RvAssetPrimitiveOp, RvNodeTransform, RvOp } from '../ops/rv-unified-ops';
import { referenceRewriteRangesOf } from '../ops/rv-unified-ops';
import { isComponentReference } from '../engine/rv-node-path-rewrite.mjs';
import { getRawOdtDef } from '../engine/rv-component-registry';
import { authoredAssetRelativePath, authoredPathIsAmbiguous } from '../hmi/rv-reference-field';
import {
  assignRuntimeIdentity,
  instantiateSubtree,
  mintFromIdMap,
  reidentifySubtree,
  type NodeIdMap,
} from '../engine/rv-subtree-instantiate';
import { identityIdOf } from '../engine/rv-decode-identity';
import { registerNodeAliasesInRegistry } from '../engine/rv-node-aliases';
import type { VisitedReference } from '../engine/rv-node-path-rewrite.mjs';
import { addressedReferenceValue, referenceTargetForWrite } from '../engine/rv-reference-writer';
import { opTargetPaths, overrideTargetOf, writeOverride, type OverrideTarget } from '../ops/rv-reference-guard';
import { placedReferenceOfPath } from '../engine/rv-reference-scope';
import { reportReplayOpsSkipped, type ReplayOpSkippedReport } from '../hmi/problems-store';
import type { RvPlacedReplayTarget } from '../ops/rv-placed-replay';
import { overrideBaseOf, recordOverrideBase, type OverrideBase } from '../engine/rv-asset-reference';
import type {
  ImportCadOp,
  TransformNodeOp,
  RenameNodeOp,
  DeleteNodeOp,
  CreateNodeOp,
  CloneNodeOp,
  ReparentNodeOp,
  AddComponentOp,
  RemoveComponentOp,
  AssetSetFieldOp,
  AssetUnsetFieldOp,
  SetMaterialOp,
  SeparateMeshOp,
  MergeMeshOp,
  MergeOutputSpec,
  MergeKeptNodeSpec,
  NodeTransform,
  CADLinkExtras,
  ReplaceNodeGeometryOp,
} from './rv-asset-ops';

/** Name of the hidden trash group parked directly under the scene root. */
const TRASH_GROUP_NAME = '_rvAssetTrash';

/** Direction an op was applied in (plan-766 apply listeners). */
export type AssetApplyDirection = 'forward' | 'inverse';
/** Observer of applied ops — see {@link AssetExecutorContext.addApplyListener}. */
export type AssetApplyListener = (op: RvAssetOp, direction: AssetApplyDirection) => void;
/** Observer of bulk-replay brackets — see {@link AssetExecutorContext.addReplayListener}. */
export type AssetReplayListener = (phase: 'begin' | 'end') => void;

/** Every Mesh in a subtree (root included). */
function meshesUnder(root: Object3D): Mesh[] {
  const out: Mesh[] = [];
  root.traverse((o) => { if ((o as Mesh).isMesh) out.push(o as Mesh); });
  return out;
}

/** Authored meshes only; runtime helpers take their whole subtree out of the walk. */
function authoredMeshesUnder(root: Object3D): Mesh[] {
  const out: Mesh[] = [];
  const visit = (node: Object3D): void => {
    if (node !== root && isRuntimeHelperNode(node)) return;
    if ((node as Mesh).isMesh) out.push(node as Mesh);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return out;
}

/** Trash key for the copy a `cloneNode` created (parked by its inverse). */
function cloneTrashKey(opId: string): string { return `clone:${opId}`; }

/** A CPU buffer of `geometry` is detached (the worker BVH build transfers them while it runs). */
function geometryBuffersDetached(geometry: BufferGeometry): boolean {
  const arrays: Array<{ buffer?: ArrayBufferLike }> = [];
  if (geometry.index) arrays.push(geometry.index.array as unknown as { buffer?: ArrayBufferLike });
  for (const name in geometry.attributes) {
    const a = geometry.attributes[name] as unknown as { array?: { buffer?: ArrayBufferLike }; data?: { array?: { buffer?: ArrayBufferLike } } };
    const arr = a.data?.array ?? a.array;
    if (arr) arrays.push(arr);
  }
  return arrays.some((arr) => arr.buffer?.byteLength === 0);
}

/**
 * Deep copy of a live subtree for `cloneNode`: `Object3D.clone(true)` copies the
 * nodes, local and world matrices and a JSON copy of `userData` (the
 * non-enumerable component instances stay behind); geometry and materials are
 * shared by three's clone and are copied here, so a later in-place edit of
 * either side never reaches the other. A mesh the editor arena draws carries
 * `layers.mask = 0`; the copy is put back on the main layer so the arena's
 * reconcile picks it up as a fresh mesh instead of skipping it as "masked".
 */
function cloneSubtreeDeep(source: Object3D): Object3D {
  const copy = source.clone(true);
  copy.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    if (mesh.geometry) mesh.geometry = (mesh.geometry as BufferGeometry).clone();
    const mat = mesh.material as Material | Material[] | undefined;
    if (Array.isArray(mat)) mesh.material = mat.map((m) => m.clone());
    else if (mat) mesh.material = mat.clone();
    if (mesh.layers.mask === 0) mesh.layers.mask = 1;
  });
  return copy;
}

/** Trash key for the Group a `separateMesh` created (parked by its inverse). */
function separateTrashKey(opId: string): string { return `separate:${opId}`; }
/** Trash key for the source mesh a `separateMesh` displaced. */
function sourceTrashKey(opId: string): string { return `sourceOf:${opId}`; }
/** Trash key for the ORIGINAL subtree a `mergeMesh` dissolved (parked by its forward). */
function mergeSourceTrashKey(opId: string): string { return `mergeSource:${opId}`; }
/** Trash key for the merged result a `mergeMesh` built (parked by its inverse). */
function mergedTrashKey(opId: string): string { return `merged:${opId}`; }

/**
 * Marker on geometries the separator created, so the trash flush knows which
 * ones it exclusively owns and may dispose. Underscore-prefixed, i.e. stripped
 * by `sanitizeUserDataForExport` if it ever reached a node's userData.
 */
const SEPARATOR_GEOMETRY_MARK = '_rvSeparatorPart';

/**
 * Same idea for the merger, and here it matters even more: the parked ORIGINAL
 * geometries may be shared with meshes elsewhere and come back alive on undo, so
 * only the geometries the merge itself BUILT may ever be disposed.
 */
const MERGER_GEOMETRY_MARK = '_rvMergerOutput';

/** Cache identity of a geometry — see {@link AssetExecutorContext.geometryKeyOf}. */
export interface CadGeometryKey {
  sha256: string;
  quality: string;
  converter?: CadConverter;
}

/**
 * The geometry a `replaceNodeGeometry` displaced in each direction — never the
 * live one. `prev` is held after forward (undo restores the exact instance),
 * `next` after inverse (redo re-installs it without a cache read).
 */
interface GeometryStash {
  prev: BufferGeometry | null;
  next: BufferGeometry | null;
}

/** The one mesh a geometry swap targets: the node itself, or the only mesh in its subtree. */
export function singleMeshOf(node: Object3D): Mesh | null {
  if ((node as Mesh).isMesh) return node as Mesh;
  const meshes = authoredMeshesUnder(node);
  return meshes.length === 1 ? meshes[0] : null;
}

/**
 * Parse GLB bytes into the geometry of their ONE mesh, in that mesh's local
 * frame (node transforms inside the GLB are ignored). Runs the same vertex-pool
 * compaction `importCad` runs, so an import's single mesh and a re-parse of
 * the same cached bytes yield the same geometry. The parsed materials are
 * dropped — a swap keeps the node's own material.
 */
export async function geometryFromGlb(bytes: ArrayBuffer): Promise<BufferGeometry> {
  const root = await parseGlbSubtree(bytes);
  compactSharedVertexPools(root);
  const meshes = meshesUnder(root);
  if (meshes.length !== 1) {
    throw new Error(`replaceNodeGeometry: the GLB must hold exactly one mesh, it holds ${meshes.length}`);
  }
  const geometry = meshes[0].geometry as BufferGeometry;
  const material = meshes[0].material as Material | Material[];
  for (const m of Array.isArray(material) ? material : [material]) m?.dispose?.();
  return geometry;
}

/**
 * The analysis result handed over from the preview so the apply does not repeat
 * it (plan-331 §2.3).
 *
 * The analysis runs in the ACTION, before the op — and therefore before an op id
 * exists. Same handoff as `importCad`: the document mints the header, hands the
 * payload over under that id, then applies the op. The executor consumes the
 * entry and deletes it; a replay finds none and recomputes.
 */
export interface SeparateMeshPayload {
  /** The geometry the analysis ran on — identity-checked before the result is reused. */
  sourceGeometry: BufferGeometry;
  /** Vertex count at analysis time — the other half of the staleness check. */
  vertexCount: number;
  /** Triangle indices per output part, in child order. */
  partitions: number[][];
  /** Ready-built part geometries, same order. Empty when only `analyze` ran. */
  geometries: BufferGeometry[];
}

/**
 * Merged geometries handed over from the preview, so the apply does not repeat the bake
 * (plan-372 §2.3). Same handoff mechanism as {@link SeparateMeshPayload}.
 */
export interface MergeMeshPayload {
  /** Source geometries at analysis time, indexed like `op.sourcePaths` — identity-checked. */
  sources: { geometry: BufferGeometry; vertexCount: number }[];
  /** Ready-built merged geometries, indexed like `op.outputs`. Empty = build here. */
  geometries: (BufferGeometry | null)[];
}

/** One node a `mergeMesh` lifted out of the dissolved subtree. */
interface MergeMovedNode {
  node: Object3D;
  /** Parent BEFORE the merge — undo restores exactly here. */
  parent: Object3D;
  /** Sibling index BEFORE the merge (captured before ANY detachment). */
  childIndex: number;
  /** Depth below the subtree root; orders detach (deep first) and restore (shallow first). */
  depth: number;
  role: 'protected' | 'anchor' | 'source';
  /** Where the node belongs AFTER the merge. `null` for sources (they get parked). */
  targetParent: Object3D | null;
  /** Local matrix before the merge — the re-home rebases it to keep the world pose. */
  prevMatrix: Matrix4;
}

/** One generated output mesh plus the two parents it needs across undo/redo. */
interface MergeOutputRecord {
  node: Mesh;
  /** Parent after the merge; `null` for the `role: 'root'` output (it replaces the root). */
  targetParent: Object3D | null;
  /** Node that owns the zone in the ORIGINAL tree — where late authored children go home. */
  originOwner: Object3D;
}

/** Everything a `mergeMesh` needs to be undone bit-exactly. */
interface MergeRecord {
  /** Ascending (depth, childIndex) — detach walks it backwards, restore forwards. */
  moved: MergeMovedNode[];
  outputs: MergeOutputRecord[];
  rootOutput: Mesh;
  /** Identity of everything the merge generated — tells outputs from authored children. */
  generated: Set<Object3D>;
  /** Nodes that went into the trash with the root (structural leftovers + sources). */
  parked: Set<Object3D>;
  outputGeometries: BufferGeometry[];
  /** Cleared when the output geometries are disposed — gates the async BVH build. */
  alive: { value: boolean };
}

/** What a `separateMesh` created, so its inverse can tell parts from authored children. */
interface SeparateRecord {
  /** The generated island/group meshes (identity, not names). */
  islands: Set<Object3D>;
  /** Cleared when the parts' geometries are disposed — gates the async BVH build. */
  alive: { value: boolean };
}

/**
 * Neither the GLB cache nor the CAD provider could produce the geometry an
 * `importCad` op references — the caches were evicted (or this is a public build
 * opening a draft whose GLB cache is gone). Recoverable: the user re-picks the
 * source file. Distinguished from generic executor failures so that replay can
 * surface it rather than swallow it.
 */
export class CadGeometryUnavailableError extends Error {
  /**
   * `reason` is the user-facing cause when the CAD provider REFUSED to rebuild the geometry
   * (plan-561: e.g. "This model was converted with realvirtual CONNECT — start CONNECT …"),
   * as opposed to simply having no source bytes. Surfaced per file by the re-import prompt.
   */
  constructor(readonly cadlink: CADLinkExtras, readonly reason?: string) {
    super(
      `CAD geometry for ${cadlink.File} (${cadlink.Sha256.slice(0, 8)}…) is not available — re-import the file` +
      (reason ? ` (${reason})` : ''),
    );
    this.name = 'CadGeometryUnavailableError';
  }
}

/** An `importCad` whose geometry could not be re-materialised, with the cause when known. */
export interface MissingCadGeometry {
  cadlink: CADLinkExtras;
  /** Why the provider could not rebuild it (absent = cache and source bytes simply gone). */
  reason?: string;
}

/**
 * A recorded `separateMesh` op could not be applied to the live tree — the
 * source node is gone, is no longer a mesh, lost its parent, or the recorded
 * split no longer reproduces on it (part count / name divergence).
 *
 * Collected and surfaced like {@link CadGeometryUnavailableError}, NOT swallowed:
 * a silent no-op would leave the op recorded in the draft, so the split counts as
 * having happened while the tree still holds the unsplit mesh — and every later op
 * in the draft then edits the wrong tree. Recoverable: the user re-imports the
 * missing source (or drops the split) with the divergence named.
 */
export class SeparateMeshUnappliedError extends Error {
  constructor(
    readonly sourcePath: string,
    readonly reason: string,
    readonly opId: string,
  ) {
    super(`separateMesh on "${sourcePath}" was not applied: ${reason} (op ${opId})`);
    this.name = 'SeparateMeshUnappliedError';
  }
}

/** One drained {@link SeparateMeshUnappliedError}, flattened for the UI. */
export interface UnappliedSeparation {
  sourcePath: string;
  reason: string;
  opId: string;
}

/**
 * A recorded `mergeMesh` op could not be applied — a source path is gone, is no longer a
 * mesh, its material or vertex count diverged from the recorded signature, or an owner
 * path no longer resolves.
 *
 * The third member of the collected, user-recoverable class next to
 * {@link CadGeometryUnavailableError} and {@link SeparateMeshUnappliedError}, and for the
 * same reason: a silent no-op would leave the merge recorded in the draft while the tree
 * still holds the unmerged subtree, so every later op would edit the wrong tree. Throwing
 * instead would make the replay caller replace the partially restored document with an
 * empty one — which is why this is COLLECTED rather than fatal.
 */
export class MergeMeshUnappliedError extends Error {
  constructor(
    readonly rootPath: string,
    readonly reason: string,
    readonly opId: string,
  ) {
    super(`mergeMesh on "${rootPath}" was not applied: ${reason} (op ${opId})`);
    this.name = 'MergeMeshUnappliedError';
  }
}

/** One referrer whose re-bind failed at the end of a reference-rewrite range (plan-610). */
export interface RebindFailure {
  /** Registry path of the referrer (`''` for a failure of the scan itself). */
  path: string;
  componentType: string;
  error: unknown;
}

/**
 * The re-bind at the end of a reference-rewrite range failed for at least one
 * referrer (plan-610 §2.4, SOL R3 #3). Thrown only AFTER every other referrer
 * and the foreign-referrer scan ran; the composite is then rolled back and the
 * op is not recorded (forward), resp. the undo is re-applied and the entry stays
 * on the undo stack (inverse).
 */
export class ReferenceRebindError extends Error {
  readonly failures: readonly RebindFailure[];
  constructor(compositeId: string, failures: readonly RebindFailure[]) {
    const first = failures[0];
    const what = first?.path ? `${first.componentType} on "${first.path}"` : 'the referrer scan';
    const cause = first?.error instanceof Error ? first.error.message : String(first?.error);
    super(
      `reference re-bind after composite ${compositeId} failed for ${failures.length} referrer(s), ` +
      `first: ${what}: ${cause}`,
    );
    this.name = 'ReferenceRebindError';
    this.failures = failures;
  }
}

/** One drained {@link MergeMeshUnappliedError}, flattened for the UI. */
export interface UnappliedMerge {
  rootPath: string;
  reason: string;
  opId: string;
}

/**
 * Rename duplicate sibling names to `name_1`, `name_2`, … (the glTF/Unity
 * `_N` convention) throughout a subtree, in place. CAD assemblies commonly
 * repeat part names (20× "Bolt"); the NodeRegistry keys nodes by name-path,
 * so duplicate siblings would collapse onto ONE path and picking/selection
 * would always resolve the same instance.
 *
 * Deterministic (child order decides indices) and idempotent — replaying the
 * same tree yields the same names, and pre-existing `name_N` siblings keep
 * their names (renamed duplicates skip over them).
 */
export function dedupeSiblingNames(root: Object3D): void {
  const stack: Object3D[] = [root];
  while (stack.length > 0) {
    const parent = stack.pop()!;
    if (parent.children.length > 0) {
      // Original names are reserved so a renamed duplicate never steals the
      // name of a later sibling that legitimately carries a `_N` suffix.
      const taken = new Set<string>();
      for (const child of parent.children) taken.add(child.name);
      const assigned = new Set<string>();
      for (const child of parent.children) {
        let name = child.name;
        if (assigned.has(name)) {
          let i = 1;
          while (taken.has(`${name}_${i}`) || assigned.has(`${name}_${i}`)) i++;
          name = `${name}_${i}`;
          child.name = name;
          taken.add(name);
        }
        assigned.add(name);
        stack.push(child);
      }
    }
  }
}

/** One trashed subtree — enough to re-attach at the original position. */
interface TrashEntry {
  node: Object3D;
  parent: Object3D;
  childIndex: number;
  /**
   * The component registrations of the parked subtree (set by `_detachToTrash`):
   * the instances stay alive in the trash, but `unregisterSubtree` drops their
   * registry entries — the restore files them again. Without it a redo of
   * `cloneNode` / `createNode` / `importCad` and an undo of `deleteNode` brought
   * the node back WITHOUT its components (plan-769 Phase 2 finding).
   */
  components?: Array<{ node: Object3D; entries: Array<[string, unknown]> }>;
}

/** Field values are JSON (rv_extras): equal when they serialise alike. */
function jsonEqual(a: unknown, b: unknown): boolean {
  return Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b);
}

export class AssetExecutorContext {
  readonly viewer: RVViewer;
  /**
   * Session-local geometry payloads for importCad ops (op.id → parsed root).
   *
   * Purely an optimization: the fresh-import path has already parsed the GLB
   * bytes (it needs the root's transform to build the op), so handing that tree
   * over avoids re-parsing a possibly-large assembly a second time. The bytes are
   * in the cache either way, so a miss here is not a failure — it just falls
   * through to `getCadGlb` + `parseGlbSubtree` and yields the identical tree.
   */
  private readonly _cadPayloads = new Map<string, Object3D>();
  /** Detached subtrees keyed by op id (deleteNode) / `import:<opId>` (importCad inverse). */
  private readonly _trash = new Map<string, TrashEntry>();
  private _trashGroup: Group | null = null;
  /**
   * Original materials displaced by a `setMaterial` op, keyed by op id → mesh
   * path, so undo re-attaches the EXACT instance.
   *
   * Two things depend on this rather than on rebuilding from the op payload:
   * textured materials cannot round-trip through `MaterialValue` at all, and
   * even those that can would come back as fresh unshared instances, silently
   * splitting a material the rest of the asset still shares.
   */
  private readonly _materialTrash = new Map<string, Map<string, Material | Material[]>>();
  /**
   * plan-774 F1: the instance override a `setField` / `unsetField` on placed
   * content found at its address BEFORE it wrote (op id → state), so the inverse
   * restores that override — or its absence — and not merely the live value.
   * Re-captured on every forward (redo, replay), so it never outlives the truth;
   * a coalesce keeps the FIRST op's id and with it the state before the drag.
   */
  private readonly _overridePrev = new Map<string, OverrideBase>();
  /** importCad ops whose geometry could not be resolved (drained by the plugin). */
  private _missingCadGeometry: MissingCadGeometry[] = [];
  /** separateMesh ops that did not land on the live tree (drained by the plugin). */
  private _unappliedSeparations: UnappliedSeparation[] = [];
  /** Preview analysis results awaiting their `separateMesh` op (op.id → payload). */
  private readonly _separatePayloads = new Map<string, SeparateMeshPayload>();
  /** Per-`separateMesh` bookkeeping: which children are generated parts, BVH liveness. */
  private readonly _separateRecords = new Map<string, SeparateRecord>();
  /** mergeMesh ops that did not land on the live tree (drained by the plugin). */
  private _unappliedMerges: UnappliedMerge[] = [];
  /** Pre-built merge geometries awaiting their `mergeMesh` op (op.id → payload). */
  private readonly _mergePayloads = new Map<string, MergeMeshPayload>();
  /** Per-`mergeMesh` bookkeeping: moved nodes, generated outputs, BVH liveness. */
  private readonly _mergeRecords = new Map<string, MergeRecord>();
  /** Displaced geometries of `replaceNodeGeometry` ops, keyed by op id (plan-621). */
  private readonly _geometryStash = new Map<string, GeometryStash>();
  /** Freshly parsed geometries awaiting their `replaceNodeGeometry` op (op.id → geometry). */
  private readonly _geometryPayloads = new Map<string, BufferGeometry>();
  /** Cache identity of every geometry this context installed or imported (plan-621). */
  private readonly _geometryKeys = new WeakMap<BufferGeometry, CadGeometryKey>();
  /**
   * Geometries a `replaceNodeGeometry` BUILT (the document's payload or a cache
   * parse): they belong to the op alone and are disposed once no history
   * reaches them. A geometry a node carried BEFORE its first swap (an import,
   * the loaded base) is never in here — it may be shared with other meshes, so
   * it is left to the GC like the rest of the trash. A set rather than a
   * `userData` mark: geometry userData is exported as glTF primitive extras and
   * would come back on the next load claiming an ownership it no longer has.
   */
  private readonly _ownedGeometries = new WeakSet<BufferGeometry>();
  /** Geometries this context disposed — gates their background BVH build. */
  private readonly _disposedGeometries = new WeakSet<BufferGeometry>();

  constructor(viewer: RVViewer) {
    this.viewer = viewer;
  }

  /**
   * Stash the geometry the document already parsed for the matching
   * `replaceNodeGeometry` op — same hand-off as {@link provideCadPayload}: the
   * fresh apply skips a second parse, redo and replay read the cache instead.
   *
   * The geometry must be freshly parsed for this op and referenced by nothing
   * else: from here on the op OWNS it and disposes it once no history reaches it.
   */
  provideGeometryPayload(opId: string, geometry: BufferGeometry): void {
    this._ownedGeometries.add(geometry);
    this._geometryPayloads.set(opId, geometry);
  }

  /** Drop an unconsumed geometry payload (the op never ran) — nothing else holds it. */
  discardGeometryPayload(opId: string): void {
    const geometry = this._geometryPayloads.get(opId);
    this._geometryPayloads.delete(opId);
    if (geometry) this._disposeOwnedGeometry(geometry);
  }

  /**
   * The CAD-GLB cache key a geometry can be re-materialised from, or null.
   *
   * Known for every geometry a `replaceNodeGeometry` installed (in either
   * direction), and for the single mesh of an `importCad` whose GLB holds
   * exactly one mesh — the first geometry of a live-synced body, so its first
   * swap has a `prevSha256` without writing anything. Everything else (a node
   * of the loaded base, a geometry after a reload) has none, and the document
   * snapshots it into the cache before the swap.
   */
  geometryKeyOf(geometry: BufferGeometry): CadGeometryKey | null {
    return this._geometryKeys.get(geometry) ?? null;
  }

  /** Record the cache key of `geometry` (the document's snapshot path). */
  noteGeometryKey(geometry: BufferGeometry, key: CadGeometryKey): void {
    this._geometryKeys.set(geometry, { ...key });
  }

  /**
   * Drop the stash of ops a coalesce folded away (plan-621). Their displaced
   * material / geometry is the INTERMEDIATE state between two merged steps —
   * the merged op keeps the FIRST op's id and inverse payload, so no undo or
   * redo can reach it any more. A displaced geometry the op built is disposed
   * here, once; the stash entry goes with it.
   */
  releaseAbsorbed(opIds: readonly string[]): void {
    for (const id of opIds) {
      this._materialTrash.delete(id);
      this._overridePrev.delete(id);
      const entry = this._geometryStash.get(id);
      if (!entry) continue;
      this._geometryStash.delete(id);
      if (entry.prev) this._disposeOwnedGeometry(entry.prev);
      if (entry.next) this._disposeOwnedGeometry(entry.next);
    }
  }

  /** How much per-op state is held (tests / diagnostics). */
  get stashStats(): { trash: number; materials: number; geometries: number } {
    let geometries = 0;
    for (const e of this._geometryStash.values()) geometries += (e.prev ? 1 : 0) + (e.next ? 1 : 0);
    return { trash: this._trash.size, materials: this._materialTrash.size, geometries };
  }

  /** Stash the freshly parsed CAD root for the matching importCad op. */
  provideCadPayload(opId: string, root: Object3D): void {
    this._cadPayloads.set(opId, root);
  }

  /**
   * Stash the partition the document already computed (and, optionally, extracted
   * part geometries) for the matching `separateMesh` op.
   *
   * The executor validates the payload against the LIVE source geometry before
   * using it — a mesh edited in between must not silently get a stale split.
   */
  provideSeparatePayload(opId: string, payload: SeparateMeshPayload): void {
    this._separatePayloads.set(opId, payload);
  }

  /** Drop a stashed analysis (dialog cancelled, or the action failed). */
  discardSeparatePayload(opId: string): void {
    this._separatePayloads.delete(opId);
  }

  /**
   * Stash the preview's merged geometries for the matching `mergeMesh` op.
   *
   * Validated against the LIVE source geometries before use — a subtree edited while the
   * dialog was open must not silently get a stale merge.
   */
  provideMergePayload(opId: string, payload: MergeMeshPayload): void {
    this._mergePayloads.set(opId, payload);
  }

  /** Drop a stashed merge payload (dialog cancelled, or the action failed). */
  discardMergePayload(opId: string): void {
    const payload = this._mergePayloads.get(opId);
    this._mergePayloads.delete(opId);
    // These geometries were built for an op that will never run — nothing else holds them.
    for (const geometry of payload?.geometries ?? []) geometry?.dispose();
  }

  /**
   * Take (and clear) the `mergeMesh` ops that did not land during the last apply/replay.
   * Same one-shot contract as {@link takeUnappliedSeparations}.
   */
  takeUnappliedMerges(): UnappliedMerge[] {
    const out = this._unappliedMerges;
    this._unappliedMerges = [];
    return out;
  }

  /**
   * Take (and clear) the CADLinks whose geometry could not be re-materialised
   * during the last apply/replay. The AssetEditorPlugin drains this after
   * `replayOps` and prompts the user to re-import — geometry silently vanishing
   * is exactly the failure this replaces. Each entry carries the provider's
   * refusal reason when there was one (plan-561).
   */
  takeMissingCadGeometry(): MissingCadGeometry[] {
    const out = this._missingCadGeometry;
    this._missingCadGeometry = [];
    return out;
  }

  /**
   * Take (and clear) the `separateMesh` ops that did not land during the last
   * apply/replay. Same contract as {@link takeMissingCadGeometry}: the plugin
   * drains this after `replayOps` and tells the user, because a recorded-but-
   * unapplied split silently desynchronises the draft from the live tree.
   */
  takeUnappliedSeparations(): UnappliedSeparation[] {
    const out = this._unappliedSeparations;
    this._unappliedSeparations = [];
    return out;
  }

  /** Dispose the trash + payload maps (document close / save). Trash nodes are
   *  removed from the scene; geometry disposal is left to the GC/renderer since
   *  trashed CAD meshes may share materials with live clones. */
  flushTrash(): void {
    const arena = this.viewer.editorArena;
    for (const entry of this._trash.values()) {
      // plan-766 §2.4.4: trashed meshes leave their arena BEFORE their
      // geometry can be disposed below (the arena copied it, but the record
      // still points at the source and must not outlive it).
      if (arena) arena.remove(meshesUnder(entry.node));
      // Geometries the SEPARATOR built are exclusively owned by their island
      // mesh — nothing else in the scene references them — so this is the one
      // place where disposal is provably safe (the trashed CAD meshes above are
      // not, which is why the rest of the trash is still left to the GC).
      // `disposeBoundsTree()` first: the tree holds its own typed arrays and
      // three-mesh-bvh patches it onto the prototype, so disposing the geometry
      // alone would strand it.
      this._disposeSeparatorGeometries(entry.node);
      // Same exclusive-ownership rule for the merger — and here the distinction is
      // load-bearing: the OTHER trash entry of a merge holds the original geometries,
      // which may be shared and must never be disposed.
      this._disposeMergerGeometries(entry.node);
      entry.node.removeFromParent();
    }
    this._trash.clear();
    this._trashGroup?.removeFromParent();
    this._trashGroup = null;
    // Displaced materials are no longer reachable for undo. Their textures may
    // still be shared with live materials, so leave disposal to the renderer —
    // same reasoning as the trashed CAD meshes above.
    this._materialTrash.clear();
    // Displaced geometries of `replaceNodeGeometry` (plan-621): a stash slot
    // never holds a live geometry, so the ones the op built are disposed here —
    // exactly once, the slot goes with it. An undo after this point
    // re-materialises from the CAD-GLB cache (`prevSha256`).
    const geometryStashes = [...this._geometryStash.values()];
    this._geometryStash.clear();
    for (const entry of geometryStashes) {
      if (entry.prev) this._disposeOwnedGeometry(entry.prev);
      if (entry.next) this._disposeOwnedGeometry(entry.next);
    }
    for (const opId of [...this._geometryPayloads.keys()]) this.discardGeometryPayload(opId);
  }

  dispose(): void {
    // Every in-flight BVH build is abandoned before the trash flush disposes
    // the geometries it would otherwise write its tree into.
    for (const record of this._separateRecords.values()) record.alive.value = false;
    for (const record of this._mergeRecords.values()) record.alive.value = false;
    this.flushTrash();
    this._cadPayloads.clear();
    this._overridePrev.clear();
    this._separatePayloads.clear();
    this._separateRecords.clear();
    for (const opId of [...this._mergePayloads.keys()]) this.discardMergePayload(opId);
    this._mergeRecords.clear();
    this._missingCadGeometry = [];
    this._unappliedSeparations = [];
    this._unappliedMerges = [];
  }

  // ─── Public entry points ──────────────────────────────────────────────

  /**
   * Apply an op to the live scene.
   *
   * REJECTS when the op could not be applied. The two documented exceptions are
   * {@link CadGeometryUnavailableError} (`takeMissingCadGeometry`) and
   * {@link SeparateMeshUnappliedError} (`takeUnappliedSeparations`), which stay
   * collected, user-recoverable conditions so draft replay of a model whose GLB
   * cache was evicted still restores everything else. Every other failure propagates, so
   * `AssetDocument` can decline to record an op that never landed — recording one
   * was the mechanism behind "half-rebuilt scene, nothing to undo" (plan-359 Phase 3).
   */
  async applyForward(op: RvAssetOp): Promise<void> {
    // plan-589 spike: every signal (re-)registration of this op - composites
    // included - is ONE catalog wave, i.e. one `onCatalogChanged`.
    beginSignalSyncWave(this.viewer.signalStore);
    try {
      await this._withMatrixBatch(op, () => this._forwardAny(op));
    } finally {
      // Runs on the failure path too: a rolled-back composite touched the graph
      // on its way in and out, so hierarchy/BVH consumers must resync either way.
      this._afterApply(op, 'forward');
      endSignalSyncWave(this.viewer.signalStore);
    }
  }

  /** Inverse counterpart of {@link applyForward} — same rejection contract. */
  async applyInverse(op: RvAssetOp): Promise<void> {
    beginSignalSyncWave(this.viewer.signalStore);
    try {
      await this._withMatrixBatch(op, () => this._inverseAny(op));
    } finally {
      this._afterApply(op, 'inverse');
      endSignalSyncWave(this.viewer.signalStore);
    }
  }

  // ─── Matrix batching for bulk moves ───────────────────────────────────

  /** Parents whose subtree matrices are pending a forced refresh (null = no batch). */
  private _matrixBatch: Set<Object3D> | null = null;

  /**
   * Run `body` with the per-node world-matrix refresh deferred to the end — but
   * ONLY for a composite made purely of moves and renames (optionally followed
   * by the setField steps of a reference rewrite, plan-610; every field
   * re-apply drains the batch first, see `_drainMatrixBatch`).
   *
   * Why the deferral is safe there and nowhere else: those two primitives apply a
   * local TRS that was resolved BEFORE the first mutation, so nothing inside the
   * batch reads `matrixWorld`. A composite that also constructs components would
   * break that (component construction may measure the node), so it keeps the
   * eager per-op refresh.
   *
   * The flush is unconditional (`finally`): the editor pick backend reads
   * `matrixWorld` RAW and `freezeStaticMatrices` runs in editor loads too, so a
   * skipped refresh would break picking AND rendering — contract-bake-picking.md §2.5,
   * "load-bearing invariant".
   */
  private async _withMatrixBatch(op: RvAssetOp, body: () => Promise<void>): Promise<void> {
    if (this._matrixBatch || !isPureMoveComposite(op)) return body();
    this._matrixBatch = new Set<Object3D>();
    try {
      await body();
    } finally {
      const parents = this._matrixBatch;
      this._matrixBatch = null;
      // One walk per TARGET parent covers every node moved into it — that is the
      // whole saving: 434 subtree walks collapse to one.
      for (const parent of parents) parent.updateMatrixWorld(true);
    }
  }

  /** Force-refresh `node`'s world matrices, or defer it to the open batch. */
  private _refreshWorldMatrix(node: Object3D): void {
    const batch = this._matrixBatch;
    if (batch) { batch.add(node.parent ?? node); return; }
    node.updateMatrixWorld(true);
  }

  /** Post-apply notifications — exactly once per top-level op (composites
   *  included), on BOTH directions so undo/redo/replay stay consistent.
   *  Failures (e.g. a throwing event listener) must never break the op queue —
   *  the scene mutation has already been applied at this point.
   *
   *  Each step gets its OWN try/catch, because they are independent consumers of
   *  the same mutation and one must not starve the next. The group sync is the
   *  one that matters: it maintains live SCENE STATE (GroupRegistry membership),
   *  not just a notification, and a kinematic axis whose group is missing from
   *  the registry silently drives nothing — a drive gizmo that moves an empty
   *  node. Sharing a try block with an arbitrary `editor-structure-changed`
   *  listener or a BVH rebuild made that outcome one unrelated exception away. */
  private _afterApply(op: RvAssetOp, direction: AssetApplyDirection): void {
    this._notifyStep(op, 'structure-changed', () => {
      if (assetOpTouchesHierarchy(op)) {
        this.viewer.emit('editor-structure-changed', { source: 'asset-editor' });
      }
    });
    // Pick membership is maintained INLINE at the scene-mutation sites below
    // (trash detach/restore, import, create, rename/reparent/component epoch
    // bumps) by the instance pick backend — transforms and visibility need
    // nothing at all. The merged-group resync that used to sit here went with
    // the merged pick geometry (plan-753 Phase 4b).
    this._notifyStep(op, 'group-sync', () => {
      if (this._syncGroupOps(op)) this._emitGroupsChanged();
    });
    // plan-766 §2.4.4: the op stream seam for the editor arenas. Runs AFTER
    // the scene mutation, in both directions (undo/redo/replay included), on
    // the failure path too — a rolled-back composite touched the tree.
    if (this._applyListeners.size > 0) {
      this._notifyStep(op, 'apply-listeners', () => {
        for (const fn of [...this._applyListeners]) fn(op, direction);
      });
    }
  }

  // ─── Apply listeners (plan-766) ───────────────────────────────────────

  private readonly _applyListeners = new Set<AssetApplyListener>();

  /**
   * Observe every applied op (forward and inverse, composites as ONE call
   * with the composite). Used by the editor arena op listener; no listener =
   * nothing happens. Returns the unsubscribe function.
   */
  addApplyListener(fn: AssetApplyListener): () => void {
    this._applyListeners.add(fn);
    return () => { this._applyListeners.delete(fn); };
  }

  // ─── Replay brackets (plan-766 §2.4.4) ────────────────────────────────

  private readonly _replayListeners = new Set<AssetReplayListener>();
  private _replayDepth = 0;

  /** True inside a bulk replay (draft replay, recompose). */
  get replaying(): boolean { return this._replayDepth > 0; }

  /**
   * A bulk replay starts. Nests; the OUTERMOST begin notifies the replay
   * listeners (`'begin'`), the matching outermost {@link endReplay} notifies
   * `'end'`. Called by `RvDocument.replayOps` / `replayOntoTreeLocked` through
   * the unified executor — the editor arenas suspend their per-op reaction
   * and build once at the end.
   */
  beginReplay(): void {
    this._replayDepth++;
    if (this._replayDepth === 1) this._notifyReplay('begin');
  }

  /** Counterpart of {@link beginReplay}; an unmatched call is ignored. */
  endReplay(): void {
    if (this._replayDepth === 0) return;
    this._replayDepth--;
    if (this._replayDepth === 0) this._notifyReplay('end');
  }

  /**
   * plan-774 F8: the first target path of `op` that lies inside PLACED content
   * (below a non-embedded reference node of the live tree), and whether its
   * node is absent. A replay skips an op whose placed target is missing — an
   * old draft's path into grafted CAD parts that the placed asset's bake merged
   * away — instead of the silent no-op a field write on a missing node is.
   * IMPLEMENTS RvExecutor::replayTargetInPlacedContent
   */
  replayTargetInPlacedContent(op: RvAssetOp | RvOp): RvPlacedReplayTarget | null {
    const registry = this.viewer.registry;
    if (!registry) return null;
    let first: RvPlacedReplayTarget | null = null;
    for (const path of opTargetPaths(op as RvOp)) {
      // Review fix E4/E6: the INNERMOST placed reference over the path, found by
      // exact prefix lookups — whether IT is materialised decides "baked away"
      // (the instance is there, the node is not) vs "not loaded" (placeholder,
      // offline source, cap, cycle: the content was never there to look at).
      const reference = placedReferenceOfPath(path, registry);
      if (!reference) continue;
      const materialized = !!this.viewer.placements?.instanceOf?.(reference);
      if (!registry.getNode(path)) return { nodePath: path, missing: true, materialized };
      first ??= { nodePath: path, missing: false, materialized };
    }
    return first;
  }

  /**
   * plan-774 F8: the ops of one replay skipped on placed content → Problems
   * `replay-op-skipped` (path + op kind + why). IMPLEMENTS RvExecutor::reportReplaySkips
   */
  reportReplaySkips(skips: ReadonlyArray<ReplayOpSkippedReport>, what: string): void {
    if (skips.length > 0) reportReplayOpsSkipped(skips, what);
  }

  /** Observe replay brackets. Returns the unsubscribe function. */
  addReplayListener(fn: AssetReplayListener): () => void {
    this._replayListeners.add(fn);
    return () => { this._replayListeners.delete(fn); };
  }

  private _notifyReplay(phase: 'begin' | 'end'): void {
    for (const fn of [...this._replayListeners]) {
      try {
        fn(phase);
      } catch (e) {
        console.warn(`[asset-edits] replay ${phase} listener failed:`, e);
      }
    }
  }

  /** Run one post-apply step; report its failure without taking the others down. */
  private _notifyStep(op: RvAssetOp, step: string, body: () => void): void {
    try {
      body();
    } catch (e) {
      console.warn(
        `[asset-edits] post-apply ${step} failed for ${op.kind} (op ${op.id}):`, e,
      );
    }
  }

  /** Re-sync GroupRegistry memberships for every Group-touching primitive in
   *  the op (composites recursed). Runs on both directions via _afterApply.
   *  Returns true when the registry changed. */
  private _syncGroupOps(op: RvAssetOp): boolean {
    if (op.kind === 'composite') {
      let changed = false;
      for (const child of op.ops) changed = this._syncGroupOps(child as RvAssetPrimitiveOp) || changed;
      return changed;
    }
    if (
      op.kind === 'addComponent' || op.kind === 'removeComponent' ||
      op.kind === 'setField' || op.kind === 'unsetField'
    ) {
      if (GROUP_KEY_RE.test(op.componentType)) {
        const node = this._node(op.nodePath);
        if (node) return syncNodeGroups(this.viewer, node);
      }
    }
    return false;
  }

  private _emitGroupsChanged(): void {
    this.viewer.emit('groups-changed', { source: 'editor' });
    this.viewer.markRenderDirty();
  }

  /**
   * A composite is ATOMIC: it either applies completely or leaves the scene as it
   * found it. A partially applied structural batch is the one state the op log
   * cannot describe — the document records the composite only after this resolves,
   * so a half-applied one would be an un-undoable rebuild of the user's scene
   * (plan-359 §2.4 / Phase 3).
   */
  private async _forwardAny(op: RvAssetOp): Promise<void> {
    if (op.kind === 'composite') {
      await this._runComposite(op, 'forward');
      return;
    }
    try {
      await this._forward(op);
    } catch (e) {
      // Missing CAD geometry is a RECOVERABLE, user-visible condition, not a
      // stale-op hiccup: swallowing it made the geometry disappear silently and
      // every later op targeting those node paths silently no-op. Collect it and
      // CONTINUE (the documented exception to the rejection contract) so replaying
      // a draft whose GLB cache was evicted still restores everything else.
      if (e instanceof CadGeometryUnavailableError) {
        this._missingCadGeometry.push(
          e.reason ? { cadlink: e.cadlink, reason: e.reason } : { cadlink: e.cadlink },
        );
        console.warn(`[asset-edits] forward apply failed for ${op.kind} (op ${op.id}):`, e);
        return;
      }
      // Same contract for a split that could not be reproduced: it is the
      // upstream half of the SAME failure (an evicted CAD cache takes the
      // source mesh with it), so it must not abort the replay of everything
      // else — but it must reach the user rather than a console warning.
      if (e instanceof SeparateMeshUnappliedError) {
        this._unappliedSeparations.push({
          sourcePath: e.sourcePath, reason: e.reason, opId: e.opId,
        });
        console.warn(`[asset-edits] forward apply failed for ${op.kind} (op ${op.id}):`, e);
        return;
      }
      // …and the same for a merge that could not be reproduced. Collected, never
      // rethrown: the replay caller replaces a THROWING document with an empty one,
      // so a fatal merge divergence would cost the user the whole draft.
      if (e instanceof MergeMeshUnappliedError) {
        this._unappliedMerges.push({
          rootPath: e.rootPath, reason: e.reason, opId: e.opId,
        });
        console.warn(`[asset-edits] forward apply failed for ${op.kind} (op ${op.id}):`, e);
        return;
      }
      throw e;
    }
  }

  private async _inverseAny(op: RvAssetOp): Promise<void> {
    if (op.kind === 'composite') {
      await this._runComposite(op, 'inverse');
      return;
    }
    await this._inverse(op);
  }

  /**
   * Run a composite's children in `direction` (forward: in order; inverse: in
   * reverse) — ALL OR NOTHING: on a failure the children already run are
   * reversed newest first (forward → inverse, a failed undo → re-apply, so the
   * document keeps the entry on its undo stack) and the ORIGINAL error is
   * rethrown.
   *
   * plan-610: the reference-rewrite ranges of the composite
   * ({@link referenceRewriteRangesOf}) each run in their OWN re-bind session —
   * opened when the walk enters the range, flushed when it leaves it. Outside
   * the ranges nothing changes. A flush failure of the main pass is a failure
   * of the composite (it triggers the rollback); the rollback's own flushes are
   * best-effort and only log — a rollback that could roll back again would
   * never end.
   */
  private async _runComposite(op: RvAssetOp & { kind: 'composite' }, direction: 'forward' | 'inverse'): Promise<void> {
    const children = op.ops as RvAssetPrimitiveOp[];
    const ranges = referenceRewriteRangesOf(op);
    const rangeOf = (i: number): readonly [number, number] | null => {
      for (const r of ranges) if (i >= r[0] && i < r[1]) return r;
      return null;
    };
    const run = direction === 'forward'
      ? (c: RvAssetPrimitiveOp) => this._forwardAny(c)
      : (c: RvAssetPrimitiveOp) => this._inverseAny(c);
    const back = direction === 'forward'
      ? (c: RvAssetPrimitiveOp) => this._inverseAny(c)
      : (c: RvAssetPrimitiveOp) => this._forwardAny(c);

    // The range whose session THIS walk holds open (null = none).
    let open: readonly [number, number] | null = null;
    const enter = (i: number, strict: boolean): void => {
      const r = ranges.length > 0 ? rangeOf(i) : null;
      if (r === open) return;
      if (open) { open = null; this._closeRefRebind(op.id, strict); }
      if (r && this._openRefRebind()) open = r;
    };

    const done: number[] = [];
    try {
      const n = children.length;
      for (let k = 0; k < n; k++) {
        const i = direction === 'forward' ? k : n - 1 - k;
        enter(i, true);
        await run(children[i]);
        done.push(i);
      }
      if (open) { open = null; this._closeRefRebind(op.id, true); }
    } catch (e) {
      for (let k = done.length - 1; k >= 0; k--) {
        const i = done[k];
        enter(i, false);
        try {
          await back(children[i]);
        } catch (undoErr) {
          console.error(
            `[asset-edits] rollback of composite ${op.id} failed at ${children[i].kind} ` +
            `(op ${children[i].id}) — the scene may be inconsistent:`, undoErr,
          );
        }
      }
      if (open) { open = null; this._closeRefRebind(op.id, false); }
      throw e;
    }
  }

  private async _forward(op: RvAssetPrimitiveOp): Promise<void> {
    switch (op.kind) {
      case 'importCad':       return this._importCadForward(op);
      case 'transformNode':   return this._applyTransform(op.nodePath, op.transform);
      case 'renameNode':      return this._rename(op.nodePath, op.name);
      case 'deleteNode':      return this._detachToTrash(op.id, op.nodePath);
      case 'setNodeVisible':  return this._setNodeVisible(op.nodePath, op.visible);
      case 'createNode':      return this._createNodeForward(op);
      case 'reparentNode':    return this._reparent(op.nodePath, op.newParentPath, op.transform, op.newIndex);
      case 'addComponent':    return this._addComponent(op);
      case 'removeComponent': return this._removeComponent(op);
      case 'setField':        return this._setField(op);
      case 'unsetField':      return this._unsetField(op);
      case 'setMaterial':     return this._setMaterialForward(op);
      case 'separateMesh':    return this._separateMeshForward(op);
      case 'mergeMesh':       return this._mergeMeshForward(op);
      case 'replaceNodeGeometry': return this._replaceGeometryForward(op);
      case 'cloneNode':       return this._cloneNodeForward(op);
    }
  }

  private async _inverse(op: RvAssetPrimitiveOp): Promise<void> {
    switch (op.kind) {
      case 'importCad':
        // Undo an import: park the subtree in the trash (redo re-attaches it).
        return this._detachToTrash(`import:${op.id}`, op.rootPath);
      case 'transformNode':   return this._applyTransform(op.nodePath, op.prev);
      case 'renameNode': {
        // The node now carries the NEW name — its path ends in op.name.
        const renamedPath = replaceLeaf(op.nodePath, op.name);
        // plan-765 F2: the authored-name stamp the forward step deleted comes
        // back — only when the op recorded one (old ops and unstamped nodes
        // carry no `prevOrigName`, and nothing is written then).
        return this._rename(renamedPath, op.prevName, op.prevOrigName);
      }
      case 'deleteNode':      return this._restoreFromTrash(op.id);
      case 'setNodeVisible':  return this._setNodeVisible(op.nodePath, op.prev);
      case 'createNode':
        // Undo a create: park the subtree in the trash (redo re-attaches it,
        // keeping any components/children added before the undo).
        return this._detachToTrash(`create:${op.id}`, op.nodePath);
      case 'reparentNode': {
        // The node now lives under the new parent — resolve its current path.
        const currentPath = joinPath(op.newParentPath, leaf(op.nodePath));
        return this._reparent(currentPath, op.prevParentPath, op.prevTransform, op.prevIndex);
      }
      case 'addComponent':    return this._removeComponentByKey(op.nodePath, op.componentType);
      case 'removeComponent': return this._addComponentWithFields(op.nodePath, op.componentType, op.prevFields);
      case 'setField': {
        if (op.prev === undefined) {
          deleteUserDataField(this.viewer, op.nodePath, op.componentType, op.fieldName);
        } else {
          writeUserDataField(this.viewer, op.nodePath, op.componentType, op.fieldName, op.prev);
        }
        this._restoreInstanceOverride(op);
        this._reapplyOrDefer(op.nodePath, op.componentType);
        this._syncSignals(this._node(op.nodePath));
        this._syncSignalLinks(op);
        this.viewer.markRenderDirty();
        return;
      }
      case 'unsetField': {
        writeUserDataField(this.viewer, op.nodePath, op.componentType, op.fieldName, op.prev);
        this._restoreInstanceOverride(op);
        this._reapplyOrDefer(op.nodePath, op.componentType);
        this._syncSignals(this._node(op.nodePath));
        this._syncSignalLinks(op);
        this.viewer.markRenderDirty();
        return;
      }
      case 'setMaterial':     return this._setMaterialInverse(op);
      case 'separateMesh':    return this._separateMeshInverse(op);
      case 'mergeMesh':       return this._mergeMeshInverse(op);
      case 'replaceNodeGeometry': return this._replaceGeometryInverse(op);
      // Undo a clone: park the copy in the trash (redo re-attaches it).
      case 'cloneNode':       return this._detachToTrash(cloneTrashKey(op.id), op.nodePath);
    }
  }

  // ─── setMaterial ──────────────────────────────────────────────────────

  /**
   * Paint every mesh listed in `op.prev` with the op's material.
   *
   * Iterates `op.prev` rather than re-expanding `op.nodePaths`: the mesh set was
   * resolved when the op was created, so replay paints exactly the meshes the
   * user saw change even if the selection has since moved. Meshes missing from
   * the scene (deleted since) are skipped, not an error — draft replay after a
   * delete is a normal path.
   */
  private _setMaterialForward(op: SetMaterialOp): void {
    const shared = materialForValue(op.material);
    const stash = new Map<string, Material | Material[]>();
    for (const { meshPath } of op.prev) {
      const mesh = this._node(meshPath) as Mesh | null;
      if (!mesh || !(mesh as { isMesh?: boolean }).isMesh) continue;
      const current = mesh.material;
      // Stash EVERY displaced material, not only the ones MaterialValue cannot
      // express. Rebuilding from the value would restore the right appearance
      // but a fresh instance, so a material shared with un-painted parts would
      // come back unshared — and the Materials window would then correctly
      // report the result as a duplicate the user never created. A material
      // ARRAY is stashed as the original array instance, for the same reason.
      if (current) stash.set(meshPath, current);
      // Multi-material mesh: paint every slot, keep the array — its
      // `geometry.groups` index into it, so collapsing it to one material
      // would drop every group but the first from rendering.
      mesh.material = Array.isArray(current) ? current.map(() => shared) : shared;
    }
    if (stash.size > 0) this._materialTrash.set(op.id, stash);
    this.viewer.markShadowsDirty();
  }

  /**
   * Restore each mesh's pre-op material.
   *
   * Prefers the exact instance stashed by the forward pass, which preserves
   * material sharing across the asset. Falls back to rebuilding from the op's
   * `MaterialValue` — the draft-replay path, where the stash was never filled
   * because the forward pass ran in a previous page session.
   */
  private _setMaterialInverse(op: SetMaterialOp): void {
    const stash = this._materialTrash.get(op.id);
    for (const { meshPath, material } of op.prev) {
      const mesh = this._node(meshPath) as Mesh | null;
      if (!mesh || !(mesh as { isMesh?: boolean }).isMesh) continue;
      const original = stash?.get(meshPath);
      if (original) mesh.material = original;
      else if (material) mesh.material = materialForValue(material);
    }
    // Keep the stash: a redo re-runs forward, and a second undo must restore
    // the same instances again. It is released with the rest of the trash.
    this.viewer.markShadowsDirty();
  }

  // ─── replaceNodeGeometry (plan-621) ───────────────────────────────────

  /**
   * Swap the node's mesh geometry for `op.sha256`. Source, in order: the
   * document's payload (fresh apply), the geometry the inverse displaced (redo),
   * the CAD-GLB cache (redo after a save, draft replay). The displaced geometry
   * is stashed under the op id so undo restores the EXACT instance.
   *
   * A node that no longer resolves to one mesh is skipped with a warning — the
   * stale-op tolerance of `transformNode`/`setMaterial`; the document validates
   * a fresh op before it is ever queued. A cache miss throws
   * {@link CadGeometryUnavailableError}, which replay collects.
   */
  private async _replaceGeometryForward(op: ReplaceNodeGeometryOp): Promise<void> {
    const mesh = this._geometryTarget(op);
    const payload = this._geometryPayloads.get(op.id) ?? null;
    this._geometryPayloads.delete(op.id);
    if (!mesh) {
      if (payload) this._disposeOwnedGeometry(payload);
      return;
    }
    let entry = this._geometryStash.get(op.id);
    let geometry: BufferGeometry | null = payload;
    if (!geometry && entry?.next) {
      geometry = entry.next;
      entry.next = null;
    }
    geometry ??= await this._geometryFromCache(op, op.sha256);
    this._geometryKeys.set(geometry, { sha256: op.sha256, quality: op.quality, converter: op.converter });
    const displaced = this._installGeometry(mesh, geometry);
    for (const path of op.sharedNodePaths ?? []) {
      const user = this._geometryTarget({ ...op, nodePath: path });
      if (user) this._installGeometry(user, geometry);
    }
    if (displaced === geometry) return;
    if (!entry) {
      entry = { prev: null, next: null };
      this._geometryStash.set(op.id, entry);
    }
    entry.prev = displaced;
  }

  /**
   * Put the previous geometry back: the instance the forward displaced, or —
   * after a save flushed it — `op.prevSha256` from the CAD-GLB cache. A miss
   * REJECTS (the undo fails and the entry stays on the undo stack); it is not
   * collected like a replay miss, because an undo that silently does nothing
   * would part the tree from its history.
   */
  private async _replaceGeometryInverse(op: ReplaceNodeGeometryOp): Promise<void> {
    const mesh = this._geometryTarget(op);
    if (!mesh) return;
    let entry = this._geometryStash.get(op.id);
    let geometry = entry?.prev ?? null;
    if (geometry) entry!.prev = null;
    else geometry = await this._geometryFromCache(op, op.prevSha256);
    this._geometryKeys.set(geometry, { sha256: op.prevSha256, quality: op.quality, converter: op.converter });
    const displaced = this._installGeometry(mesh, geometry);
    for (const path of op.sharedNodePaths ?? []) {
      const user = this._geometryTarget({ ...op, nodePath: path });
      if (user) this._installGeometry(user, geometry);
    }
    if (displaced === geometry) return;
    if (!entry) {
      entry = { prev: null, next: null };
      this._geometryStash.set(op.id, entry);
    }
    entry.next = displaced;
  }

  /** The one mesh `op` targets, or null (warned). */
  private _geometryTarget(op: ReplaceNodeGeometryOp): Mesh | null {
    const node = this._node(op.nodePath);
    const mesh = node ? singleMeshOf(node) : null;
    if (!mesh) {
      console.warn(
        `[asset-edits] replaceNodeGeometry skipped: "${op.nodePath}" ` +
        (node ? 'does not resolve to exactly one mesh' : 'not found') + ` (op ${op.id})`,
      );
    }
    return mesh;
  }

  /** Parse the geometry cached under `sha` — or throw the collected-on-replay error. */
  private async _geometryFromCache(op: ReplaceNodeGeometryOp, sha: string): Promise<BufferGeometry> {
    const bytes = await getCadGlb(sha, op.quality, op.converter);
    if (!bytes) {
      throw new CadGeometryUnavailableError({
        File: leaf(op.nodePath), Sha256: sha, Quality: op.quality,
        ImportScaleFactor: 0.001, ZIsUpVector: false, Converter: op.converter,
      }, `the geometry of "${op.nodePath}" is no longer in the CAD-GLB cache`);
    }
    const geometry = await geometryFromGlb(bytes);
    this._ownedGeometries.add(geometry);
    return geometry;
  }

  /**
   * `mesh.geometry = geometry`, and everything that hangs on it: bounds, the
   * world matrices (unfrozen exactly like `_applyTransform` — editor loads freeze
   * static matrices), pick membership and the mesh's local BVH. Returns the
   * displaced geometry. The material, the node and its components stay.
   */
  private _installGeometry(mesh: Mesh, geometry: BufferGeometry): BufferGeometry {
    const displaced = mesh.geometry as BufferGeometry;
    if (displaced === geometry) return displaced;
    mesh.geometry = geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    ensureMovableTransform(mesh);
    refreshWorldMatricesDeep(mesh);
    // Membership is per MESH and survives the swap; the call only guarantees
    // it (a mesh that was not pickable before is now). The BVH is per
    // GEOMETRY: the new one has none until the background build lands — the
    // native raycast covers it meanwhile, and it never hits the old triangles.
    const pick = this.viewer.instancePickIndex;
    if (pick) {
      pick.addSubtree(mesh);
      this.viewer.buildMeshBvhsAsync(mesh, () => mesh.geometry === geometry && !this._disposedGeometries.has(geometry));
    }
    this.viewer.markShadowsDirty();
    this.viewer.markRenderDirty();
    return displaced;
  }

  /** Dispose a geometry this context built — never one it did not (shared imports). */
  private _disposeOwnedGeometry(geometry: BufferGeometry): void {
    if (!this._ownedGeometries.has(geometry)) return;
    if (this._disposedGeometries.has(geometry)) return;
    // A later single-user replacement can leave a shared instance live on its
    // other users, or held by another undo entry. Dispose only the last owner.
    let live = false;
    const inspect = (node: Object3D) => { if ((node as Mesh).geometry === geometry) live = true; };
    this.viewer.currentModelRoot?.traverse(inspect);
    this._trashGroup?.traverse(inspect);
    if (live) return;
    for (const entry of this._geometryStash.values()) {
      if (entry.prev === geometry || entry.next === geometry) return;
    }
    for (const payload of this._geometryPayloads.values()) if (payload === geometry) return;
    this._disposedGeometries.add(geometry);
    try {
      geometry.disposeBoundsTree?.();
      geometry.dispose();
    } catch (e) {
      console.warn('[asset-edits] replaceNodeGeometry: geometry disposal failed:', e);
    }
  }

  // ─── importCad ────────────────────────────────────────────────────────

  private async _importCadForward(op: ImportCadOp): Promise<void> {
    const assetRoot = this.viewer.currentModelRoot;
    if (!assetRoot) throw new Error('no asset root loaded');

    // Redo after an undo: the subtree is parked in the trash — re-attach it.
    if (this._trash.has(`import:${op.id}`)) {
      return this._restoreFromTrash(`import:${op.id}`);
    }

    let root = this._cadPayloads.get(op.id) ?? null;
    // Were these bytes addressed by the op's own cache key? A provider rebuild
    // (below) is a fresh conversion that may never have reached the cache.
    let keyedBytes = true;
    if (!root) {
      // Draft replay / redo after a trash flush. The converted GLB is the single
      // source of truth: read the cached bytes and parse them — no occt, no WASM
      // worker, and no CadGeometryProvider needed (so the public build works).
      // plan-561: the converter is part of the key — a CONNECT import and a browser
      // import of the same file are different trees and never share an entry.
      let bytes = await getCadGlb(op.cadlink.Sha256, op.cadlink.Quality, op.cadlink.Converter);
      if (!bytes) {
        // Cache evicted. A provider that kept the ORIGINAL CAD bytes can rebuild
        // them (and re-populate the GLB cache); the public build cannot.
        try {
          bytes = (await getCadProvider(cadFormatOfName(op.cadlink.File))?.retessellate?.(op.cadlink, { modelRoot: assetRoot })) ?? null;
        } catch (e) {
          // The provider REFUSED (plan-561: e.g. the recorded converter is CONNECT and no
          // gateway is reachable — it never silently switches converters). Recoverable like
          // a plain miss: record the cause, the rest of the draft keeps replaying.
          throw new CadGeometryUnavailableError(op.cadlink, e instanceof Error ? e.message : String(e));
        }
        // A rebuilt GLB is a fresh conversion and gets the same weld as an import.
        // Cached bytes are NOT welded here: they replay exactly as they were stored.
        if (bytes) bytes = weldImportedGlb(bytes, op.cadlink.File);
        keyedBytes = false;
      }
      if (!bytes) throw new CadGeometryUnavailableError(op.cadlink);
      root = await parseGlbSubtree(bytes);
    }
    this._cadPayloads.delete(op.id);

    // Give every mesh its own vertices. A converter that writes one shared vertex
    // pool (OBJ → GLB) leaves each mesh with the bounds of the WHOLE pool; a
    // single-island mesh would keep it forever, since `separateMesh` never touches
    // it. Runs on fresh imports AND cache replays — it is deterministic, so later
    // ops address the same triangles in both.
    const compacted = compactSharedVertexPools(root);
    if (compacted.compactedMeshes > 0) {
      console.info(
        `[asset-editor] "${op.cadlink.File}": gave ${compacted.compactedMeshes} mesh(es) their own vertices ` +
        '(they indexed into an oversized shared vertex pool).',
      );
    }

    // plan-621: a single-mesh import IS its body's first geometry, addressable
    // by the import's own cache key — a later `replaceNodeGeometry` on it gets
    // its mandatory `prevSha256` from here without writing anything.
    // (`geometryFromGlb` re-parses these bytes with the same compaction.)
    if (keyedBytes) {
      const meshes = meshesUnder(root);
      if (meshes.length === 1) {
        this._geometryKeys.set(meshes[0].geometry as BufferGeometry, {
          sha256: op.cadlink.Sha256, quality: op.cadlink.Quality, converter: op.cadlink.Converter,
        });
      }
    }

    root.name = leaf(op.rootPath);
    // Unique sibling names BEFORE registration — duplicate CAD part names
    // would collapse onto one registry path (picking would always resolve
    // the same instance). Runs on fresh imports AND cache replays, so live
    // paths stay identical across sessions.
    dedupeSiblingNames(root);
    // plan-769 Phase 2 (F11): the CAD file's ids are relative to THAT file — a
    // second import of the same file would bring the same ids into this document.
    // Every imported node gets a fresh id from the op's map (keyed by its seed, so a
    // cache re-parse of the same bytes maps the same way; a CADLink re-import has
    // pre-filled the map with the ids of the matched old nodes).
    // plan-2216: a parametric variant's explicitly named nodes carry deterministic
    // `<familyId>:_Generated:<name>` identities that references (Grip.PartToGrip) and
    // overrides address. Keep them (map to themselves) instead of minting fresh ids, so
    // every regeneration and a draft replay produce the same ids. All other nodes
    // (CAD-style seeds) are reidentified as usual.
    let seededMap = op.idMap;
    if (op.cadlink.Converter === 'parametric') {
      seededMap = { ...(op.idMap ?? {}) };
      root.traverse((n) => {
        const id = identityIdOf(n);
        if (id && id.includes(':_Generated:') && seededMap![id] === undefined) seededMap![id] = id;
      });
    }
    op.idMap = reidentifySubtree(root, seededMap);
    applyTransform(root, op.transform);
    // Stamp the CADLink extras (kept across GLB save/load round-trips).
    const ud = root.userData as Record<string, unknown>;
    const rv = (ud['realvirtual'] ?? {}) as Record<string, unknown>;
    rv['CADLink'] = { ...op.cadlink };
    ud['realvirtual'] = rv;

    assetRoot.add(root);
    root.updateMatrixWorld(true);
    this._registerSubtree(root);
    this._syncSignals(root);
    // Index the imported meshes + build their local BVHs in the background
    // (native raycast fallback keeps them pickable immediately).
    this.viewer.instancePickIndex?.addSubtree(root);
    if (this.viewer.instancePickIndex) this.viewer.buildMeshBvhsAsync(root);
    this.viewer.markShadowsDirty();
  }

  // ─── transform / rename ───────────────────────────────────────────────

  /**
   * `t.scale` is optional in the unified payload, and its ABSENCE is the scene
   * lineage (see `RvNodeTransform`). Routing keeps scale-less transforms out of
   * this executor entirely, so the guard below never fires in practice — it is
   * here so that if one ever did arrive, the node keeps whatever scale it has
   * instead of being silently reset to identity.
   */
  private _applyTransform(nodePath: string, t: RvNodeTransform): void {
    const node = this._node(nodePath);
    if (!node) return;
    if (this._skipRootReplay(node, nodePath, 'transformNode')) return;
    // Editor loads run `freezeStaticMatrices()` (loader Phase 11), and
    // `updateMatrixWorld(true)` skips every frozen node — so a transform op on
    // a static CAD node used to land in the log and the local matrix while
    // the RENDERED pose (matrixWorld) stayed baked. Visible symptom: the
    // Quick-Edit transform tools "only worked" on a node the gizmo had
    // already touched, because the gizmo unfreezes on drag start. Do the same
    // unfreeze here, then force the whole subtree's world matrices — frozen
    // descendants keep valid LOCAL matrices, so the recompose is exact.
    ensureMovableTransform(node);
    applyTransform(node, { ...t, scale: t.scale ?? node.scale.toArray() as [number, number, number] });
    refreshWorldMatricesDeep(node);
    this._refreshDriveBase(nodePath);
    this.viewer.markShadowsDirty();
  }

  /**
   * Re-cache the home pose of a live Drive whose node an op just moved.
   *
   * In the editor the Drive family is constructed live on add (plan-411), and
   * `RVDrive.initDrive()` caches the node's pose of THAT moment as
   * `basePosition`/`baseQuaternion`. Every later field edit goes through
   * `reapplySchemaForComponent` → `reapplyConfig()` → `applyToNode()`, which
   * rewrites the node FROM that cache. So a pivot set with "Pivot to Object"
   * (or any transform / reparent op) after the Drive was added was silently
   * undone by the next Direction change in the inspector — the drive snapped
   * the node back to its stale base. In the editor the authored transform IS
   * the base, exactly as the loader treats the GLB pose (it calls the same
   * refresh after its own re-parenting, Phase 8b). No-op without a live Drive.
   */
  private _refreshDriveBase(nodePath: string): void {
    const comps = this.viewer.registry?.getComponentsAt(nodePath);
    if (!comps) return;
    for (const [type, instance] of comps) {
      if (type === 'Drive') (instance as RVDrive).refreshBaseTransform();
    }
  }

  /**
   * Root ops are SKIPPED on replay, not rejected (plan-715 Entscheidungs-Log).
   *
   * `AssetDocument` refuses a root rename/transform loudly, so no NEW op log can
   * contain one. An OLD one can: the guards did not exist before plan-715, and a
   * draft written then still lives in IndexedDB. Replay is crash recovery — the
   * one path that must never throw — so a historical root op is dropped with a
   * warning and the rest of the log applies. That also means old drafts defuse
   * themselves on their next replay; no migration pass is needed.
   */
  private _skipRootReplay(node: Object3D, nodePath: string, verb: string): boolean {
    if (!isModelRoot(node, this.viewer.currentModelRoot)) return false;
    console.warn(
      `[asset-edits] skipping replayed ${verb} on the model root "${nodePath}" ` +
      '(historical op from before the root guards) — the rest of the log still applies.',
    );
    return true;
  }

  /**
   * `restoreOrigName` is the undo leg only (plan-765 F2): forward always
   * deletes `userData._rvOrigName` — the user's name is what a save writes
   * from now on, and a delete is idempotent, so redo is right too — and the
   * inverse writes the recorded stamp back when there is one.
   */
  private _rename(nodePath: string, name: string, restoreOrigName?: string): void {
    const node = this._node(nodePath);
    if (!node) return;
    if (this._skipRootReplay(node, nodePath, 'renameNode')) return;
    node.name = name;
    if (typeof restoreOrigName === 'string') node.userData[RV_ORIG_NAME_KEY] = restoreOrigName;
    else delete node.userData[RV_ORIG_NAME_KEY];
    // Re-key every registered path under this subtree (nodes + components).
    const rekeyed = this.viewer.registry?.recomputePathsForSubtrees([node]);
    if (rekeyed) this._noteRemap(rekeyed.remap);
    // plan-589 spike: the signals of the subtree follow (node identity -> new path).
    this._syncSignals(node);
    // Cached pick paths are stale — re-resolve lazily on the next hit.
    this.viewer.instancePickIndex?.bumpResolutionEpoch();
    this.viewer.markRenderDirty();
  }

  // ─── delete / restore (trash) ─────────────────────────────────────────

  private _detachToTrash(key: string, nodePath: string): void {
    const node = this._node(nodePath);
    if (!node || !node.parent) return;
    const parent = node.parent;
    const childIndex = parent.children.indexOf(node);
    const components = this._componentRegistrationsOf(node);
    this.viewer.registry?.unregisterSubtree(node);
    // MANDATORY, not an optimization: a trashed mesh left in the pick index
    // with a cached path would alias a node later created at the same path.
    this.viewer.instancePickIndex?.removeSubtree(node);
    // Trashed nodes leave their groups (undo re-attaches them below).
    if (syncSubtreeGroups(this.viewer, node, 'detach')) this._emitGroupsChanged();
    this._ensureTrashGroup().add(node);
    this._trash.set(key, { node, parent, childIndex, components });
    // plan-589 spike: the trashed subtree is unregistered -> its signals are released.
    this._syncSignals(node);
    this.viewer.markShadowsDirty();
  }

  private _restoreFromTrash(key: string): void {
    const entry = this._trash.get(key);
    if (!entry) return;
    this._trash.delete(key);
    const { node, parent, childIndex, components } = entry;
    parent.add(node);
    // Restore the original sibling position (add() appends).
    const arr = parent.children;
    arr.splice(arr.indexOf(node), 1);
    arr.splice(Math.min(childIndex, arr.length), 0, node);
    node.updateMatrixWorld(true);
    // Same object, same userData → the SAME ids come back (plan-769 Phase 2:
    // undo of a delete restores the identity; references to it resolve again).
    this._registerSubtree(node);
    this._registerAuthoredAliases(node);
    // The SAME component instances come back with their nodes (the trash parks
    // them alive, it never disposes them), filed at the path each node has now.
    const registry = this.viewer.registry;
    if (registry && components) {
      for (const { node: owner, entries } of components) {
        const path = registry.getPathForNode(owner);
        if (!path) continue;
        for (const [type, instance] of entries) registry.register(type, path, instance);
      }
    }
    this._syncSignals(node);
    // Fresh index entries resolve lazily on the next pick (epoch 0).
    this.viewer.instancePickIndex?.addSubtree(node);
    // Restored nodes rejoin their groups (memberships derive from extras).
    if (syncSubtreeGroups(this.viewer, node, 'attach')) this._emitGroupsChanged();
    this.viewer.markShadowsDirty();
  }

  // ─── separateMesh ─────────────────────────────────────────────────────

  /**
   * Replace the source mesh with a same-named `Group` carrying one mesh per
   * partition (plan-331 §2.6).
   *
   * NOT "throw the source away and put a Group next to it": everything on the
   * source node has to travel — world transform, `userData`, existing child
   * nodes — and the components on the whole subtree have to be torn down and
   * rebuilt around the move. The order below is load-bearing; the two places it
   * is easiest to get wrong are marked inline.
   */
  private _separateMeshForward(op: SeparateMeshOp): void {
    // Redo after an undo. NOT the `_importCadForward` trash short-circuit: two
    // objects plus the children are in play here (the original is live again
    // WITH its children, the Group sits in the trash), so a plain restore would
    // produce two nodes at the same path and strand the children.
    if (this._trash.has(separateTrashKey(op.id))) return this._separateMeshRedo(op);

    // Every bail-out below is a DIVERGENCE, never a no-op: the op stays in the
    // draft either way, so a split that silently did not happen would leave the
    // draft claiming a tree the scene does not have, and every later op would
    // edit the wrong one. Raise the collected, user-recoverable error instead.
    // The explicit annotation is what makes TS treat a `fail(...)` statement as
    // never-returning, so the narrowing below needs no `!`.
    const fail: (reason: string) => never = (reason) => {
      throw new SeparateMeshUnappliedError(op.sourcePath, reason, op.id);
    };

    const source = this._node(op.sourcePath) as Mesh | null;
    if (!source || !(source as { isMesh?: boolean }).isMesh) {
      fail(`"${op.sourcePath}" is not a live mesh`);
    }
    const parent = source.parent;
    if (!parent) fail(`"${op.sourcePath}" has no parent`);

    const geometry = source.geometry as BufferGeometry;
    const shapeReason = unsupportedMeshShapeReason(source);
    if (shapeReason) fail(shapeReason);
    if (op.mode === 'islands' && Array.isArray(source.material)) {
      fail(REASON_MULTI_MATERIAL);
    }
    if (op.mode === 'groups') {
      const groupReason = groupModeIneligibility(source);
      if (groupReason) fail(groupReason);
    }

    // The preview already paid for weld + union-find; only recompute on replay.
    // The single-island case is read off the partition list rather than through
    // `islandModeIneligibility()`, which would run the union-find a second time.
    const payload = this._takeSeparatePayload(op.id, geometry);
    const partitions = payload?.partitions
      ?? (op.mode === 'groups'
        ? computeGroupPartitions(geometry)
        : computeMeshIslands(geometry, op.weldThreshold));
    if (partitions.length < 2) fail(REASON_SINGLE_PART);
    if (partitions.length !== op.childNames.length) {
      fail(
        `replay divergence — ${partitions.length} parts but ` +
        `${op.childNames.length} recorded names`,
      );
    }
    // Names are applied VERBATIM (plan-331 §2.3) — a collision on replay is an
    // error with a diagnostic, never a silent rename, or the live run and the
    // replay would drift apart.
    const collision = firstNameCollision(op.childNames, source.children);
    if (collision) {
      fail(
        `recorded child name "${collision}" collides with an existing child of ` +
        `"${op.sourcePath}"`,
      );
    }

    // ── 2. Transform, from the BAKED world matrix ───────────────────────
    // Editor loads run `freezeStaticMatrices()`, after which local TRS is not
    // authoritative — the world matrix is.
    this.viewer.currentModelRoot?.updateMatrixWorld(true);
    const localMatrix = new Matrix4().copy(parent.matrixWorld).invert().multiply(source.matrixWorld);

    // ── 3.-6. Teardown of the WHOLE live subtree, components first ──────
    this._teardownSubtree(source);

    // ── 7. Children off the source, in stable order ─────────────────────
    const authored = source.children.slice();
    for (const child of authored) source.remove(child);

    // ── 8. Source into the trash BEFORE the Group is built — otherwise two
    //       nodes would carry the same name under the same parent.
    const childIndex = parent.children.indexOf(source);
    parent.remove(source);
    this._parkNode(sourceTrashKey(op.id), source, parent, childIndex);

    // ── 9. The Group ────────────────────────────────────────────────────
    const group = new Group();
    group.name = source.name;
    group.visible = source.visible;
    localMatrix.decompose(group.position, group.quaternion, group.scale);
    // Both: the TRS for anything that recomputes, the matrix for the frozen
    // case where nothing will.
    group.matrix.copy(localMatrix);
    group.matrixWorld.copy(source.matrixWorld);
    group.matrixAutoUpdate = source.matrixAutoUpdate;
    group.matrixWorldAutoUpdate = source.matrixWorldAutoUpdate;
    // Deep copy — a shared userData object would mean every later edit on the
    // Group also mutates the original parked in the trash.
    group.userData = cloneUserData(source.userData as Record<string, unknown>);
    parent.add(group);
    spliceChildTo(parent, group, childIndex);

    // ── 10. Children back, then the parts under the verbatim names ──────
    for (const child of authored) group.add(child);
    const materials = Array.isArray(source.material) ? source.material : null;
    const geometryGroups = geometry.groups ?? [];
    const islands = new Set<Object3D>();
    for (let i = 0; i < partitions.length; i++) {
      const partGeometry = payload?.geometries[i] ?? extractSubGeometry(geometry, partitions[i]);
      (partGeometry.userData as Record<string, unknown>)[SEPARATOR_GEOMETRY_MARK] = op.id;
      // Materials are SHARED by reference — never cloned, never disposed. In
      // group mode each part takes the material of its own slot.
      const material = op.mode === 'groups' && materials
        ? materials[Math.min(geometryGroups[i]?.materialIndex ?? 0, materials.length - 1)]
        : (source.material as Material);
      const part = new Mesh(partGeometry, material);
      part.name = op.childNames[i];
      // plan-769 Phase 2 (F11): every part is a new node with a new id (the Group
      // keeps the source mesh's identity — it IS that node, re-formed).
      assignRuntimeIdentity(part, mintFromIdMap(this._idMapOf(op), `part:${i}`));
      part.castShadow = source.castShadow;
      part.receiveShadow = source.receiveShadow;
      group.add(part);
      islands.add(part);
    }
    const record: SeparateRecord = { islands, alive: { value: true } };
    this._separateRecords.set(op.id, record);

    group.updateMatrixWorld(true);
    this._reviveSubtree(group, record);
  }

  /** Inverse: the Group goes back into the trash, the source mesh comes out. */
  private _separateMeshInverse(op: SeparateMeshOp): void {
    const entry = this._trash.get(sourceTrashKey(op.id));
    const group = this._node(op.sourcePath);
    if (!entry || !group || !group.parent) {
      console.warn(`[asset-edits] separateMesh inverse: nothing to restore for op ${op.id}`);
      return;
    }
    const record = this._separateRecords.get(op.id);
    const islands = record?.islands ?? new Set<Object3D>();

    this._teardownSubtree(group);

    // Everything that is NOT a generated part is an authored child and belongs
    // back on the source — including children added AFTER the split.
    const authored = group.children.filter((child) => !islands.has(child));
    for (const child of authored) group.remove(child);

    const groupParent = group.parent!;
    const groupIndex = groupParent.children.indexOf(group);
    groupParent.remove(group);
    this._parkNode(separateTrashKey(op.id), group, groupParent, groupIndex);

    this._trash.delete(sourceTrashKey(op.id));
    const source = entry.node;
    entry.parent.add(source);
    spliceChildTo(entry.parent, source, entry.childIndex);
    for (const child of authored) source.add(child);
    source.updateMatrixWorld(true);
    this._reviveSubtree(source, null);
  }

  /**
   * Redo: original (live, with children) → trash, Group (trashed) → live.
   *
   * The children are read from the LIVE original rather than from the record,
   * so a child added while the split was undone travels with it.
   */
  private _separateMeshRedo(op: SeparateMeshOp): void {
    const entry = this._trash.get(separateTrashKey(op.id));
    const source = this._node(op.sourcePath);
    if (!entry || !source || !source.parent) {
      console.warn(`[asset-edits] separateMesh redo: nothing to restore for op ${op.id}`);
      return;
    }

    this._teardownSubtree(source);

    const authored = source.children.slice();
    for (const child of authored) source.remove(child);

    const sourceParent = source.parent!;
    const sourceIndex = sourceParent.children.indexOf(source);
    sourceParent.remove(source);
    this._parkNode(sourceTrashKey(op.id), source, sourceParent, sourceIndex);

    this._trash.delete(separateTrashKey(op.id));
    const group = entry.node;
    entry.parent.add(group);
    spliceChildTo(entry.parent, group, entry.childIndex);
    // In FRONT of the parts, which came back from the trash still attached —
    // that is the layout the forward pass produces, and redo has to reproduce
    // the same tree, not merely an equivalent one.
    for (let i = 0; i < authored.length; i++) {
      group.add(authored[i]);
      spliceChildTo(group, authored[i], i);
    }
    group.updateMatrixWorld(true);
    this._reviveSubtree(group, this._separateRecords.get(op.id) ?? null);
  }

  /**
   * Tear a live subtree down in the ONLY order that works: components first —
   * they are unresolvable once the paths are gone — then registry, pick index
   * and group memberships.
   *
   * `disposeComponentsInSubtree` and not `_removeComponentByKey`: the latter
   * deletes `userData.realvirtual[type]`, i.e. exactly the extras that have to
   * survive for undo.
   *
   * Disposing is only HALF the job. The components it kills are also held by the
   * central runtime collections (`viewer.drives`, the transport manager's lists),
   * which nothing else prunes — and `_reviveSubtree` pushes fresh ones in. Without
   * the purge below every separate/undo/redo cycle would leave dead entries behind
   * and the lists would grow monotonically.
   */
  private _teardownSubtree(root: Object3D): void {
    const v = this.viewer;
    // LogicSteps FIRST, while the subtree is still attached: `removeSubtree`
    // finds its roots by walking each step node UP to `root`. `processExtras`
    // deliberately does not rebuild logic, so this is the only thing that drops
    // the steps a torn-down subtree carried.
    v.logicEngine?.removeSubtree(root);
    const registry = v.registry;
    if (registry) {
      const disposed = disposeComponentsInSubtree(registry, root);
      const removedPaths = registry.unregisterSubtree(root);
      this._purgeRuntimeCollections(disposed, removedPaths);
    }
    this._syncSignals(root);
    // MANDATORY: a stale entry would alias a node later built at the same path.
    v.instancePickIndex?.removeSubtree(root);
    if (syncSubtreeGroups(v, root, 'detach')) this._emitGroupsChanged();
  }

  /**
   * Drop the just-unregistered components from the runtime collections that own
   * no back-reference to the registry. Mirrors `removePlacedFromScene()` in the
   * layout planner — the other place a live subtree leaves the scene.
   *
   * Called while the subtree is STILL attached, so `computeNodePath` yields the
   * same paths `unregisterSubtree` just returned.
   */
  private _purgeRuntimeCollections(disposed: Set<unknown>, removedPaths: Set<string>): void {
    if (removedPaths.size === 0) return;
    const v = this.viewer;
    const registry = v.registry;
    if (!registry) return;

    if (v.drives.length > 0) {
      // A drive whose node no longer resolves to a path was just unregistered.
      // (Its meshes left the instance pick index with the subtree detach.)
      v.drives = v.drives.filter((d) => registry.getPathForNode(d.node) !== null);
    }

    const tm = v.transportManager;
    if (!tm) return;
    const isRemoved = (c: { node: Object3D }): boolean =>
      removedPaths.has(NodeRegistry.computeNodePath(c.node));
    removeSensorsFrom(tm, isRemoved);
    tm.surfaces = tm.surfaces.filter((s) => !isRemoved(s));
    // Sources hold ghost materials; dispose the ones the sweep above missed.
    for (const s of tm.sources) {
      if (isRemoved(s) && !disposed.has(s)) s.dispose?.();
    }
    tm.sources = tm.sources.filter((s) => !isRemoved(s));
    tm.sinks = tm.sinks.filter((s) => !isRemoved(s));
    tm.grips = tm.grips.filter((s) => !isRemoved(s));
    tm.gripTargets = tm.gripTargets.filter((s) => !isRemoved(s));
    // Surfaces changed — invalidate the spatial index + dead-end adjacency cache.
    tm.notifyTopologyChanged?.();
  }

  /** Bring a freshly (re)attached subtree back to life — the mirror of {@link _teardownSubtree}.
   *  `record` is only read for its BVH liveness gate, so separator and merger records
   *  both fit. */
  private _reviveSubtree(root: Object3D, record: { alive: { value: boolean } } | null): void {
    this._registerSubtree(root);
    this._rebuildComponents(root);
    this._syncSignals(root);
    // After the components: `buildStep` resolves its targets through the
    // registry, so the steps must be built on a fully populated subtree.
    this._rebuildLogic(root);
    if (syncSubtreeGroups(this.viewer, root, 'attach')) this._emitGroupsChanged();
    this.viewer.instancePickIndex?.addSubtree(root);
    if (this.viewer.instancePickIndex) {
      // The alive predicate is what `_loadGeneration` alone cannot express: undo
      // and the trash flush do not start a new load, but they do make these
      // geometries unwritable.
      const alive = record?.alive;
      this.viewer.buildMeshBvhsAsync(root, alive ? () => alive.value : undefined);
    }
    this.viewer.instancePickIndex?.bumpResolutionEpoch();
    this.viewer.markShadowsDirty();
    this.viewer.markRenderDirty();
  }

  /**
   * Reconstruct the rv_extras components of a subtree that was just re-attached.
   *
   * Skipped when the runtime systems are absent (minimal test viewers, headless
   * documents) — exactly as component authoring does via `_runtimeDeps()`.
   */
  private _rebuildComponents(root: Object3D): void {
    const v = this.viewer;
    if (!v.registry || !v.signalStore || !v.transportManager) return;
    try {
      // plan-757 F4: the session's ONE init context plus the per-source data.
      const result = processExtras(
        root, v.initContext()!,
        // plan-727: this runs on every separateMesh/mergeMesh undo/redo inside a
        // normal editing session. Without the authoring flag it would re-parent
        // kinematic group members live and bake that into the next save.
        { logicRunState: v.logicRunState, preserveAuthoringHierarchy: true },
      );
      // The returns are live runtime state, not diagnostics — dropping them
      // would leave drives unsimulated and gated logic never started. The
      // matching removals happen in `_teardownSubtree`, so these pushes replace
      // rather than accumulate.
      if (result.deferredLogic) v.registerDeferredLogic(result.deferredLogic);
      if (result.drives.length > 0) v.drives.push(...result.drives);
      // `signalsRegistered` / `componentsCreated` are counts, not handles: the
      // signals went into the SignalStore and the components into the registry
      // during the call. Nothing to re-file, so they are only reported.
      debug(
        'loader',
        `subtree rebuild: ${result.componentsCreated} components, ` +
        `${result.signalsRegistered} signals, ${result.drives.length} drives`,
      );
      v.transportManager.notifyTopologyChanged?.();
    } catch (e) {
      // Shared by separateMesh and mergeMesh — both rebuild a re-attached subtree.
      console.warn('[asset-edits] subtree component rebuild failed:', e);
    }
  }

  /**
   * Re-merge the LogicSteps of a re-attached subtree — the mirror of the
   * `logicEngine.removeSubtree()` in {@link _teardownSubtree}.
   *
   * `processExtras` explicitly does NOT rebuild logic (its doc comment puts the
   * duty on the caller), so without this a source mesh whose children carried
   * LogicSteps lost their execution on the first separate and never got it back.
   *
   * No lazy engine creation, unlike the layout planner's `mergePlacedLogic`: an
   * engine that did not exist held no steps to tear down either, and building one
   * here would START logic the editor never had running.
   */
  private _rebuildLogic(root: Object3D): void {
    const v = this.viewer;
    if (!v.logicEngine || !v.registry || !v.signalStore) return;
    v.logicEngine.addSubtree(root, v.registry, v.signalStore);
  }

  /** Trash bookkeeping only — the caller has already detached and unregistered. */
  private _parkNode(key: string, node: Object3D, parent: Object3D, childIndex: number): void {
    this._ensureTrashGroup().add(node);
    this._trash.set(key, { node, parent, childIndex });
    this.viewer.markShadowsDirty();
  }

  /** Consume a preview payload, but only when it still describes THIS geometry. */
  private _takeSeparatePayload(opId: string, geometry: BufferGeometry): SeparateMeshPayload | null {
    const payload = this._separatePayloads.get(opId);
    if (!payload) return null;
    this._separatePayloads.delete(opId);
    const vertexCount = geometry.getAttribute('position')?.count ?? -1;
    if (payload.sourceGeometry !== geometry || payload.vertexCount !== vertexCount) {
      console.warn(
        `[asset-edits] separateMesh: the source geometry changed after it was analyzed ` +
        `(op ${opId}) — recomputing`,
      );
      return null;
    }
    // `geometries: []` is the legitimate analyze-only payload (a caller that
    // resolved the partition for the child names but never ran the extract);
    // the parts are then built here. Any other mismatch is corrupt — recompute.
    if (payload.geometries.length !== 0 && payload.geometries.length !== payload.partitions.length) {
      return null;
    }
    return payload;
  }

  /** Dispose the part geometries of a trashed subtree (exclusive ownership only). */
  private _disposeSeparatorGeometries(root: Object3D): void {
    root.traverse((node) => {
      const geometry = (node as Mesh).geometry as BufferGeometry | undefined;
      const opId = (geometry?.userData as Record<string, unknown> | undefined)?.[SEPARATOR_GEOMETRY_MARK];
      if (!geometry || typeof opId !== 'string') return;
      const record = this._separateRecords.get(opId);
      if (record) record.alive.value = false;
      try {
        geometry.disposeBoundsTree?.();
        geometry.dispose();
      } catch (e) {
        console.warn('[asset-edits] separateMesh: part geometry disposal failed:', e);
      }
    });
  }

  // ─── mergeMesh ────────────────────────────────────────────────────────

  /**
   * Collapse the subtree of one node into one mesh per material AND per Group
   * (plan-372 §2.6) — the mirror image of {@link _separateMeshForward}.
   *
   * The separator parks ONE node and builds many; the merger parks many and builds few.
   * Two things make this harder than the mirror suggests, and both are load-bearing:
   *
   * - **Owner zones.** Geometry below an anchor (`Drive`, `Kinematic`, `CADLink`,
   *   `JTData`) merges into an output that stays a CHILD OF THAT ANCHOR. Hanging every
   *   output under the new root mesh would silently stop the anchor from moving its own
   *   geometry — an asset that looks right and is broken.
   * - **Bit-exact undo.** Every node that changes parent is recorded with its ORIGINAL
   *   parent object, sibling index, depth and local matrix, captured in one pass BEFORE
   *   the first detachment (a later capture would read indices that earlier removals
   *   already shifted).
   */
  private _mergeMeshForward(op: MergeMeshOp): void {
    // Redo after an undo: the merged result is parked and the original is live again.
    if (this._trash.has(mergedTrashKey(op.id)) && this._mergeRecords.has(op.id)) {
      return this._mergeMeshRedo(op);
    }

    // Every bail-out is a DIVERGENCE, never a no-op — see MergeMeshUnappliedError.
    const fail: (reason: string) => never = (reason) => {
      throw new MergeMeshUnappliedError(op.rootPath, reason, op.id);
    };

    const root = this._node(op.rootPath);
    if (!root) fail(`"${op.rootPath}" is not in the tree`);
    const rootParent = root.parent;
    if (!rootParent) fail(`"${op.rootPath}" has no parent`);

    // ── 1. Sources, validated against their recorded signatures ─────────
    const sources: Mesh[] = [];
    for (let i = 0; i < op.sourcePaths.length; i++) {
      const path = op.sourcePaths[i];
      const node = this._node(path) as Mesh | null;
      if (!node || (node as { isMesh?: boolean }).isMesh !== true) {
        fail(`source "${path}" is not a live mesh`);
      }
      if (!isDescendantOf(node, root)) {
        fail(`source "${path}" is no longer inside "${op.rootPath}"`);
      }
      const shape = unsupportedMeshShapeReason(node);
      if (shape) fail(`source "${path}": ${shape}`);
      if (Array.isArray(node.material)) fail(`source "${path}" became multi-material`);
      const signature = op.sourceSignatures[i];
      if (signature) {
        const geometry = node.geometry as BufferGeometry;
        const vertexCount = geometry.getAttribute('position')?.count ?? -1;
        const triCount = triangleCount(geometry);
        if (vertexCount !== signature.vertexCount || triCount !== signature.triangleCount) {
          fail(
            `source "${path}" diverged — recorded ${signature.vertexCount} vertices / ` +
            `${signature.triangleCount} triangles, found ${vertexCount} / ${triCount}`,
          );
        }
        const materialKey = materialFingerprint(node.material as Material);
        if (materialKey !== signature.materialKey) {
          fail(`source "${path}" no longer carries the recorded material`);
        }
      }
      sources.push(node);
    }

    // ── 2. Surviving nodes and the owner zones they belong to ───────────
    const keptByNode = new Map<Object3D, MergeKeptNodeSpec>();
    const anchorByPath = new Map<string, Object3D>();
    for (const spec of op.kept) {
      const node = this._node(spec.path);
      if (!node) fail(`kept node "${spec.path}" is not in the tree`);
      if (!isDescendantOf(node, root)) {
        fail(`kept node "${spec.path}" is no longer inside "${op.rootPath}"`);
      }
      keptByNode.set(node, spec);
      if (spec.role === 'anchor') anchorByPath.set(spec.path, node);
    }

    const rootSpecs = op.outputs.filter((o) => o.role === 'root');
    if (rootSpecs.length !== 1) {
      fail(`expected exactly one root output, found ${rootSpecs.length}`);
    }
    for (const spec of op.outputs) {
      if (spec.ownerPath === op.rootPath) continue;
      if (!anchorByPath.has(spec.ownerPath)) {
        fail(`output owner "${spec.ownerPath}" is not a live anchor`);
      }
    }
    const collision = firstOutputNameCollision(op, keptByNode);
    if (collision) fail(collision);

    // ── 3. World matrices, captured BEFORE anything moves ───────────────
    // Editor loads run `freezeStaticMatrices()`, after which local TRS is not
    // authoritative — the world matrix is.
    this.viewer.currentModelRoot?.updateMatrixWorld(true);
    const rootWorld = root.matrixWorld.clone();
    const rootLocal = new Matrix4().copy(rootParent.matrixWorld).invert().multiply(rootWorld);
    const sourceWorld = sources.map((s) => s.matrixWorld.clone());
    const ownerWorld = new Map<string, Matrix4>([[op.rootPath, rootWorld]]);
    for (const [path, node] of anchorByPath) ownerWorld.set(path, node.matrixWorld.clone());

    // ── 4. The merged geometries — from the preview, or built here ──────
    const payload = this._takeMergePayload(op.id, sources);
    const geometries: BufferGeometry[] = [];
    try {
      for (let i = 0; i < op.outputs.length; i++) {
        const spec = op.outputs[i];
        const ready = payload?.geometries[i] ?? null;
        if (ready) { geometries.push(ready); continue; }
        if (spec.sourceIndices.length === 0) {
          // The root zone carries no geometry of its own — the replacement is the
          // geometry-less carrier that keeps the result form "one same-named mesh".
          geometries.push(new BufferGeometry());
          continue;
        }
        geometries.push(buildMergedGeometry(
          spec.sourceIndices.map((si) => ({
            geometry: sources[si].geometry as BufferGeometry,
            worldMatrix: sourceWorld[si],
          })),
          ownerWorld.get(spec.ownerPath)!,
        ));
      }
    } catch (e) {
      // Everything built so far AND every pre-built geometry this loop never reached:
      // the op will not run, so nothing else will ever own them.
      const orphaned = new Set<BufferGeometry>(geometries);
      for (const geometry of payload?.geometries ?? []) if (geometry) orphaned.add(geometry);
      for (const geometry of orphaned) geometry.dispose();
      fail(e instanceof Error ? e.message : String(e));
    }

    // ── 5. Teardown of the WHOLE live subtree, components first ─────────
    this._teardownSubtree(root);

    // ── 6. One capture pass, then detach deepest-first ──────────────────
    const sourceSet = new Set<Object3D>(sources);
    const moved: MergeMovedNode[] = [];
    const capture = (node: Object3D, depth: number): void => {
      if (node !== root) {
        const spec = keptByNode.get(node);
        const parent = node.parent;
        if (spec && parent) {
          moved.push({
            node, parent, childIndex: parent.children.indexOf(node), depth,
            role: spec.role, targetParent: null, prevMatrix: node.matrix.clone(),
          });
          // A protected node exempts its WHOLE subtree — never descend into it.
          if (spec.role === 'protected') return;
        } else if (sourceSet.has(node) && parent) {
          moved.push({
            node, parent, childIndex: parent.children.indexOf(node), depth,
            role: 'source', targetParent: null, prevMatrix: node.matrix.clone(),
          });
        }
      }
      for (const child of node.children.slice()) capture(child, depth + 1);
    };
    capture(root, 0);
    moved.sort((a, b) => a.depth - b.depth || a.childIndex - b.childIndex);
    // Deepest first: an anchor must be free of its own consumed meshes before it moves.
    for (let i = moved.length - 1; i >= 0; i--) moved[i].parent.remove(moved[i].node);

    // ── 7. The original subtree into the trash, sources with it ─────────
    const rootIndex = rootParent.children.indexOf(root);
    rootParent.remove(root);
    this._parkNode(mergeSourceTrashKey(op.id), root, rootParent, rootIndex);
    for (const source of sources) root.add(source);
    const parked = new Set<Object3D>();
    root.traverse((n) => parked.add(n));

    // ── 8. Build the outputs; the 'root' one REPLACES the root ──────────
    const generated = new Set<Object3D>();
    const outputs: MergeOutputRecord[] = [];
    const deferred: { mesh: Mesh; spec: MergeOutputSpec }[] = [];
    let rootOutput: Mesh | null = null;
    for (let i = 0; i < op.outputs.length; i++) {
      const spec = op.outputs[i];
      const geometry = geometries[i];
      (geometry.userData as Record<string, unknown>)[MERGER_GEOMETRY_MARK] = op.id;
      // Materials are SHARED by reference — never cloned, never disposed.
      const material = spec.sourceIndices.length > 0
        ? (sources[spec.sourceIndices[0]].material as Material)
        : null;
      const mesh = material ? new Mesh(geometry, material) : new Mesh(geometry);
      mesh.name = spec.name;
      generated.add(mesh);

      if (spec.role === 'root') {
        applyRootParity(mesh, root, rootLocal, rootWorld);
        applyGroupExtras(mesh, spec.groupNames);
        rootParent.add(mesh);
        spliceChildTo(rootParent, mesh, rootIndex);
        rootOutput = mesh;
        outputs.push({ node: mesh, targetParent: null, originOwner: root });
      } else {
        // plan-769 Phase 2 (F11): a child output is a new node with a new id (the
        // root output keeps the root's identity — it replaces that node).
        assignRuntimeIdentity(mesh, mintFromIdMap(this._idMapOf(op), `output:${i}`));
        const owner = spec.ownerPath === op.rootPath ? root : anchorByPath.get(spec.ownerPath)!;
        mesh.castShadow = owner.castShadow;
        mesh.receiveShadow = owner.receiveShadow;
        applyGroupExtras(mesh, spec.groupNames);
        deferred.push({ mesh, spec });
      }
    }

    // ── 9. Survivors home, shallowest first (an anchor before its children) ──
    for (const record of moved) {
      if (record.role === 'source') continue;
      const spec = keptByNode.get(record.node)!;
      const target = spec.ownerPath === op.rootPath
        ? rootOutput!
        : anchorByPath.get(spec.ownerPath)!;
      record.targetParent = target;
      target.add(record.node);
      rebaseLocalMatrix(record.node, target);
    }

    // ── 10. The remaining outputs, after their owners are in place ──────
    for (const { mesh, spec } of deferred) {
      const target = spec.ownerPath === op.rootPath
        ? rootOutput!
        : anchorByPath.get(spec.ownerPath)!;
      target.add(mesh);
      outputs.push({
        node: mesh,
        targetParent: target,
        originOwner: spec.ownerPath === op.rootPath ? root : anchorByPath.get(spec.ownerPath)!,
      });
    }

    const record: MergeRecord = {
      moved, outputs, rootOutput: rootOutput!, generated, parked,
      outputGeometries: geometries, alive: { value: true },
    };
    this._mergeRecords.set(op.id, record);

    rootOutput!.updateMatrixWorld(true);
    this._reviveSubtree(rootOutput!, record);
  }

  /** Inverse: the merged result goes into the trash, the original subtree comes back. */
  private _mergeMeshInverse(op: MergeMeshOp): void {
    const record = this._mergeRecords.get(op.id);
    const entry = this._trash.get(mergeSourceTrashKey(op.id));
    const rootOutput = record?.rootOutput ?? null;
    if (!record || !entry || !rootOutput || !rootOutput.parent) {
      console.warn(`[asset-edits] mergeMesh inverse: nothing to restore for op ${op.id}`);
      return;
    }

    this._teardownSubtree(rootOutput);

    // Anything under an output that the merge did NOT generate and that is not a
    // recorded moved node was authored AFTER the merge — it goes to the origin owner
    // of that output rather than into the trash.
    const movedNodes = new Set(record.moved.map((m) => m.node));
    const late: { node: Object3D; home: Object3D }[] = [];
    for (const out of record.outputs) {
      for (const child of out.node.children.slice()) {
        if (record.generated.has(child) || movedNodes.has(child)) continue;
        out.node.remove(child);
        late.push({ node: child, home: out.originOwner });
      }
    }

    for (let i = record.moved.length - 1; i >= 0; i--) {
      record.moved[i].node.parent?.remove(record.moved[i].node);
    }
    // Child outputs collapse under the root output so the result parks as ONE subtree.
    for (const out of record.outputs) {
      if (!out.targetParent) continue;
      out.node.parent?.remove(out.node);
      rootOutput.add(out.node);
    }

    const outParent = rootOutput.parent!;
    const outIndex = outParent.children.indexOf(rootOutput);
    outParent.remove(rootOutput);
    this._parkNode(mergedTrashKey(op.id), rootOutput, outParent, outIndex);

    this._trash.delete(mergeSourceTrashKey(op.id));
    const root = entry.node;
    entry.parent.add(root);
    spliceChildTo(entry.parent, root, entry.childIndex);
    // Shallowest first, ascending sibling index — that reconstructs each original
    // children array exactly, not merely an equivalent one.
    for (const m of record.moved) {
      m.parent.add(m.node);
      spliceChildTo(m.parent, m.node, m.childIndex);
      restoreLocalMatrix(m.node, m.prevMatrix);
    }
    for (const l of late) l.home.add(l.node);

    root.updateMatrixWorld(true);
    this._reviveSubtree(root, null);
  }

  /**
   * Redo: original (live) → trash, merged result (trashed) → live.
   *
   * Reproduces the FORWARD tree, not merely an equivalent one: the child outputs are
   * pulled off the root output first so that survivors and outputs land back in the same
   * order the forward pass produced.
   */
  private _mergeMeshRedo(op: MergeMeshOp): void {
    const record = this._mergeRecords.get(op.id)!;
    const entry = this._trash.get(mergedTrashKey(op.id))!;
    const root = this._node(op.rootPath);
    if (!root || !root.parent) {
      console.warn(`[asset-edits] mergeMesh redo: nothing to restore for op ${op.id}`);
      return;
    }

    this._teardownSubtree(root);

    for (let i = record.moved.length - 1; i >= 0; i--) {
      record.moved[i].node.parent?.remove(record.moved[i].node);
    }
    // Anything added under the root WHILE the merge was undone is authored work — it
    // must not disappear into the trash with the dissolved subtree.
    const late: Object3D[] = [];
    for (const child of root.children.slice()) {
      if (record.parked.has(child)) continue;
      root.remove(child);
      late.push(child);
    }

    const rootParent = root.parent!;
    const rootIndex = rootParent.children.indexOf(root);
    rootParent.remove(root);
    this._parkNode(mergeSourceTrashKey(op.id), root, rootParent, rootIndex);
    for (const m of record.moved) if (m.role === 'source') root.add(m.node);

    this._trash.delete(mergedTrashKey(op.id));
    const rootOutput = record.rootOutput;
    for (const out of record.outputs) {
      if (out.targetParent) out.node.parent?.remove(out.node);
    }
    entry.parent.add(rootOutput);
    spliceChildTo(entry.parent, rootOutput, entry.childIndex);

    for (const m of record.moved) {
      if (m.role === 'source' || !m.targetParent) continue;
      m.targetParent.add(m.node);
      rebaseLocalMatrix(m.node, m.targetParent);
    }
    for (const out of record.outputs) {
      if (out.targetParent) out.targetParent.add(out.node);
    }
    for (const node of late) rootOutput.add(node);

    rootOutput.updateMatrixWorld(true);
    this._reviveSubtree(rootOutput, record);
  }

  /** Consume a merge payload, but only when it still describes THESE geometries. */
  private _takeMergePayload(opId: string, sources: Mesh[]): MergeMeshPayload | null {
    const payload = this._mergePayloads.get(opId);
    if (!payload) return null;
    this._mergePayloads.delete(opId);

    let stale = payload.sources.length !== sources.length;
    for (let i = 0; !stale && i < sources.length; i++) {
      const geometry = sources[i].geometry as BufferGeometry;
      const vertexCount = geometry.getAttribute('position')?.count ?? -1;
      stale = payload.sources[i].geometry !== geometry
        || payload.sources[i].vertexCount !== vertexCount;
    }
    if (stale) {
      console.warn(
        `[asset-edits] mergeMesh: the subtree changed while the dialog was open ` +
        `(op ${opId}) — recomputing`,
      );
      for (const geometry of payload.geometries) geometry?.dispose();
      return null;
    }
    return payload;
  }

  /** Dispose the OUTPUT geometries of a trashed subtree — never the parked originals. */
  private _disposeMergerGeometries(root: Object3D): void {
    root.traverse((node) => {
      const geometry = (node as Mesh).geometry as BufferGeometry | undefined;
      const opId = (geometry?.userData as Record<string, unknown> | undefined)?.[MERGER_GEOMETRY_MARK];
      if (!geometry || typeof opId !== 'string') return;
      const record = this._mergeRecords.get(opId);
      if (record) record.alive.value = false;
      try {
        // `disposeBoundsTree()` FIRST: the tree holds its own typed arrays, and
        // three-mesh-bvh patches it onto the prototype — disposing the geometry alone
        // would strand it.
        geometry.disposeBoundsTree?.();
        geometry.dispose();
      } catch (e) {
        console.warn('[asset-edits] mergeMesh: output geometry disposal failed:', e);
      }
    });
  }

  // ─── create / reparent ────────────────────────────────────────────────

  private _createNodeForward(op: CreateNodeOp): void {
    // Redo after an undo: the subtree is parked in the trash — re-attach it
    // (keeps components/children that were added between create and undo).
    if (this._trash.has(`create:${op.id}`)) {
      return this._restoreFromTrash(`create:${op.id}`);
    }
    const parentPath = dirname(op.nodePath);
    const parent = parentPath ? this._node(parentPath) : this.viewer.currentModelRoot;
    if (!parent) {
      console.warn(`[asset-edits] createNode: parent "${parentPath}" not found (op ${op.id})`);
      return;
    }
    const node = new Object3D();
    node.name = leaf(op.nodePath);
    // Runtime-only marker (stripped by sanitizeUserDataForExport on save).
    (node.userData as Record<string, unknown>)['__rvAdded'] = true;
    parent.add(node);
    if (op.index !== undefined) {
      const arr = parent.children;
      arr.splice(arr.indexOf(node), 1);
      arr.splice(Math.min(op.index, arr.length), 0, node);
    }
    applyTransform(node, op.transform);
    node.updateMatrixWorld(true);
    // plan-769 Phase 2 (F11): a new node gets a new identity — the op carries it.
    assignRuntimeIdentity(node, mintFromIdMap(this._idMapOf(op), 'node'));
    this.viewer.registry?.registerNode(op.nodePath, node);
    this.viewer.registry?.registerSubtreeIds?.(node);
    // A fresh empty node carries no meshes yet, but children added later
    // (reparent) index via their own ops; keep membership consistent anyway.
    this.viewer.instancePickIndex?.addSubtree(node);
    this.viewer.markRenderDirty();
  }

  // ─── clone (plan-641 Phase 3) ─────────────────────────────────────────

  /**
   * Copy the live source subtree under the parent of `op.nodePath`.
   *
   * Like `createNode`, a missing source or parent is warned about and skipped
   * (draft replay must not throw); the command checks both before it creates
   * the op. Components on the copy are constructed live (Drive first on every
   * node, so a drive behavior finds its drive), signals and groups follow.
   */
  private _cloneNodeForward(op: CloneNodeOp): void {
    const key = cloneTrashKey(op.id);
    if (this._trash.has(key)) return this._restoreFromTrash(key);
    const source = this._node(op.sourcePath);
    if (!source) {
      console.warn(`[asset-edits] cloneNode: source "${op.sourcePath}" not found (op ${op.id})`);
      return;
    }
    const parentPath = dirname(op.nodePath);
    const parent = parentPath ? this._node(parentPath) : this.viewer.currentModelRoot;
    if (!parent) {
      console.warn(`[asset-edits] cloneNode: parent "${parentPath}" not found (op ${op.id})`);
      return;
    }
    for (const mesh of meshesUnder(source)) {
      if (mesh.geometry && geometryBuffersDetached(mesh.geometry as BufferGeometry)) {
        throw new Error(`cloneNode: the geometry of "${mesh.name}" is being indexed right now — retry in a moment`);
      }
    }
    // plan-769 Phase 2 (F10, D9 — Unity Ctrl+D): fresh ids for every copied node
    // (the op's id map makes them replay-stable), and a stored reference inside the
    // copy that named a node of the copied subtree follows the copy.
    const registry = this.viewer.registry;
    const { root: copy, idMap } = instantiateSubtree(source, {
      ids: 'fresh',
      idMap: op.idMap,
      clone: cloneSubtreeDeep,
      attach: (c) => {
        c.name = leaf(op.nodePath);
        // The copy's name is the user's, not the source's authored one (the rename
        // rule, plan-765 F2): a save must not write the copy back under the source's name.
        if (c.name !== source.name) delete c.userData[RV_ORIG_NAME_KEY];
        parent.add(c);
        if (op.index !== undefined) {
          const arr = parent.children;
          arr.splice(arr.indexOf(c), 1);
          arr.splice(Math.min(op.index, arr.length), 0, c);
        }
        refreshWorldMatricesDeep(c);
      },
      resolveTarget: registry ? (sourceReferrer, ref) => copiedReferenceTarget(registry, sourceReferrer, ref) : undefined,
      spellPath: ({ copyTarget, defaultPath, copyReferrer }) => {
        if (defaultPath) return defaultPath;
        // The copy has another parent: the ONE writer's spelling (plan-765 F3),
        // relative to the scope the copy now lives in.
        if (!registry) return null;
        const scopeRoot = registry.enclosingScope(copyReferrer).root;
        if (authoredPathIsAmbiguous(copyTarget, scopeRoot)) return null;
        return authoredAssetRelativePath(copyTarget, scopeRoot);
      },
    });
    op.idMap = idMap;
    this._registerSubtree(copy);
    // The copy's AUTHORED spellings (`_rvOrigName`, copied with the userData) as
    // aliases: a reference that follows the copy keeps the spelling it was written in.
    this._registerAuthoredAliases(copy);
    const deps = this._runtimeDeps();
    if (deps) {
      copy.traverse((node) => {
        const rv = (node.userData as Record<string, unknown>)['realvirtual'] as Record<string, unknown> | undefined;
        if (!rv || typeof rv !== 'object') return;
        const keys = Object.keys(rv).sort((a, b) => Number(!/^Drive(_\d+)?$/.test(a)) - Number(!/^Drive(_\d+)?$/.test(b)));
        for (const type of keys) {
          const fields = rv[type];
          if (!fields || typeof fields !== 'object' || Array.isArray(fields)) continue;
          try {
            constructComponentOnNode(deps, node, type, { ...(fields as Record<string, unknown>) });
          } catch (e) {
            console.warn(`[asset-edits] cloneNode: ${type} on "${node.name}" not constructed:`, e);
          }
        }
      });
    }
    this._syncSignals(copy);
    if (syncSubtreeGroups(this.viewer, copy, 'attach')) this._emitGroupsChanged();
    this.viewer.instancePickIndex?.addSubtree(copy);
    if (this.viewer.instancePickIndex) this.viewer.buildMeshBvhsAsync(copy);
    this.viewer.markShadowsDirty();
  }

  /** Move a subtree under a new parent at a given sibling index with the
   *  recorded local TRS. Shared by reparentNode forward AND inverse.
   *
   *  THROWS on an unresolvable move (missing node, missing parent, cycle). These
   *  used to warn and return, which let `AssetDocument` record a move that never
   *  happened — and inside a bulk import that means a group whose contents the
   *  op log claims are elsewhere (plan-359 Phase 3). */
  private _reparent(
    nodePath: string, newParentPath: string, transform: NodeTransform, index?: number,
  ): void {
    const node = this._node(nodePath);
    if (!node) throw new Error(`reparent: node "${nodePath}" not found`);
    const newParent = newParentPath ? this._node(newParentPath) : this.viewer.currentModelRoot;
    if (!newParent) throw new Error(`reparent: new parent "${newParentPath}" not found`);
    // Cycle guard — a node must never become a descendant of itself.
    for (let p: Object3D | null = newParent; p; p = p.parent) {
      if (p === node) {
        throw new Error(`reparent: "${nodePath}" is an ancestor of "${newParentPath}"`);
      }
    }
    newParent.add(node);
    if (index !== undefined) {
      const arr = newParent.children;
      arr.splice(arr.indexOf(node), 1);
      arr.splice(Math.min(index, arr.length), 0, node);
    }
    applyTransform(node, transform);
    this._refreshWorldMatrix(node);
    // A moved subtree may hold materialised placements: their nesting follows
    // the new parent (plan-774 — highlight / bounds of the enclosing placement).
    this.viewer.bakeRegistry?.relinkSubtree?.(node);
    // The world-preserving re-parent changed the LOCAL pose a live Drive caches
    // as home — refresh it while the registry still knows the OLD path.
    this._refreshDriveBase(nodePath);
    // Re-key registered paths under the moved subtree and carry the signal
    // store's path registrations across the move. Stored references in other
    // nodes' extras are NOT touched here — that is the reference rewrite the
    // document plans as setField steps of the same composite (plan-610).
    this._remapSubtreePaths(node);
    this._syncSignals(node);
    // Cached pick paths are stale — re-resolve lazily on the next hit.
    this.viewer.instancePickIndex?.bumpResolutionEpoch();
    this.viewer.markShadowsDirty();
  }

  /** Re-key every registered path under a moved subtree and carry the signal
   *  store's path registrations across the move, so a signal owned by a dragged
   *  node still resolves under its new path (name↔path stay consistent). Only
   *  REGISTRY and SIGNAL-STORE keys move here; serialized reference paths in
   *  `userData.realvirtual` are rewritten by the document's reference-rewrite
   *  composite (plan-610), and the re-key's remap feeds that composite's
   *  re-bind session ({@link _noteRemap}).
   *
   *  Unlike the loader's Phase-8c handling this does NOT register the old paths
   *  as aliases: at load time serialized references still point at the authoring
   *  hierarchy Phase-8b just changed, but in the interactive editor a moved
   *  node's old path is genuinely gone — keeping it resolvable would shadow a
   *  node later created at that path (and `_rename`, which re-keys paths the
   *  same way, aliases nothing either). */
  private _remapSubtreePaths(node: Object3D): void {
    const registry = this.viewer.registry;
    if (!registry) return;
    const { remap } = registry.recomputePathsForSubtrees([node]);
    this._noteRemap(remap);
    if (remap.size === 0) return;
    this.viewer.signalStore?.remapPaths(remap);
  }

  // ─── visibility ───────────────────────────────────────────────────────

  /** Show/hide a node. The authored state is mirrored into
   *  `userData.realvirtual.Hidden` because glTF has no node visibility — the
   *  scene loader re-applies the flag on GLB load, and the raycast BVH keys
   *  pick-exclusion on it (never on `.visible`, which the static merge uses
   *  for its own bookkeeping). */
  private _setNodeVisible(nodePath: string, visible: boolean): void {
    const node = this._node(nodePath);
    if (!node) return;
    node.visible = visible;
    // Clone-on-write so memoized inspector/hierarchy readers see a new object.
    const ud = node.userData as Record<string, unknown>;
    const rv = { ...(ud['realvirtual'] as Record<string, unknown> | undefined) };
    if (visible) delete rv['Hidden'];
    else rv['Hidden'] = true;
    ud['realvirtual'] = rv;
    // plan-766 F11: editor arena instances follow the chain visibility.
    this.viewer.editorArena?.bumpVisibility();
    this.viewer.markShadowsDirty();
    this.viewer.markRenderDirty();
  }

  // ─── add/remove component ─────────────────────────────────────────────

  private _addComponent(op: AddComponentOp): void {
    this._addComponentWithFields(op.nodePath, op.componentType, op.fields);
  }

  private _addComponentWithFields(
    nodePath: string, componentType: string, fields: Record<string, unknown>,
  ): void {
    const node = this._node(nodePath);
    if (!node || isUnsafeObjectKey(componentType)) return;
    const ud = node.userData as Record<string, unknown>;
    const rv = { ...(ud['realvirtual'] as Record<string, unknown> | undefined) };
    rv[componentType] = { ...fields };
    ud['realvirtual'] = rv;

    const deps = this._runtimeDeps();
    if (deps) {
      const instance = constructComponentOnNode(deps, node, componentType, { ...fields });
      // A REFUSED construction (plan-411 Phase 1: a drive behavior without its
      // drive, a drive without a direction) must not leave the extras stamp
      // behind — that half-state is exactly the silent failure the finding
      // replaces. Only the Drive family can refuse; every other type either
      // constructs or has no factory at all (unchanged: the stamp stays, so an
      // unknown component still round-trips through the GLB).
      if (!instance && isDriveFamilyType(componentType)) {
        const back = { ...(ud['realvirtual'] as Record<string, unknown> | undefined) };
        delete back[componentType];
        ud['realvirtual'] = back;
      }
      // plan-525 §2.4b: a (re-)added BoxCollider is the volume of a
      // WebPhysicsZone on the same node — undo of its removal restores the zone.
      if (instance && isBoxColliderKey(componentType)) {
        (instance as { notifyZone?: () => void }).notifyZone?.();
      }
    }
    this._syncSignals(node);
    // Components change hoverable/CADLink/Drive resolution — re-resolve lazily.
    this.viewer.instancePickIndex?.bumpResolutionEpoch();
    this.viewer.markRenderDirty();
  }

  private _removeComponent(op: RemoveComponentOp): void {
    this._removeComponentByKey(op.nodePath, op.componentType);
  }

  private _removeComponentByKey(nodePath: string, componentType: string): void {
    const node = this._node(nodePath);
    if (!node) return;
    // Drive / drive behaviors own their teardown (tick-list membership, the
    // drive↔behavior link) — plan-411 Phase 1, the symmetric half of the
    // construction branches.
    const deps = this._runtimeDeps();
    const handled = deps
      ? removeDriveComponentFromNode(deps, nodePath, componentType)
      : false;
    // Dispose the live instance and unregister it.
    const comps = handled ? [] : this.viewer.registry?.getComponentsAt(nodePath) ?? [];
    const entry = comps.find(([type]) => type === componentType);
    if (entry) {
      const inst = entry[1] as { dispose?: () => void };
      try { inst.dispose?.(); } catch (e) { console.warn(`[asset-edits] dispose failed for ${componentType}:`, e); }
      this.viewer.registry?.unregisterComponent(componentType, nodePath);
    }
    // Drop the userData entry (clone-on-write for inspector memoisation).
    const ud = node.userData as Record<string, unknown>;
    const rv = { ...(ud['realvirtual'] as Record<string, unknown> | undefined) };
    delete rv[componentType];
    ud['realvirtual'] = rv;
    // plan-525 §2.4b: the BoxCollider was the volume of a WebPhysicsZone on the
    // same node — the zone goes inactive (one warning) until undo re-adds it.
    if (isBoxColliderKey(componentType) && this.viewer.registry) {
      syncPhysicsZoneBounds(this.viewer.registry, nodePath, null, null);
    }
    this._syncSignals(node);
    // Components change hoverable/CADLink/Drive resolution — re-resolve lazily.
    this.viewer.instancePickIndex?.bumpResolutionEpoch();
    this.viewer.markRenderDirty();
  }

  // ─── field ops ────────────────────────────────────────────────────────

  private _setField(op: AssetSetFieldOp): void {
    // plan-765 F3: a reference-typed value is stored in AUTHORED names. Inside a
    // plan-610 reference-rewrite range the rewrite planner already chose the
    // spelling of each step (F2b) — those steps are written verbatim.
    const spelled = this._refRebind ? op.value : this._authoredReferenceValue(op);
    // plan-769 Phase 3b: a ComponentReference the writer can pin is stored as its
    // ADDRESS (`#id`), in the live extras too — rename/move never touch it again.
    // Inside a plan-610 rewrite range the planner's steps are written verbatim (they
    // re-spell PATH references a rename/move touched; address references need none).
    const reg = this.viewer.registry;
    const owner = reg && !this._refRebind ? this._node(op.nodePath) : null;
    const value = reg && owner ? addressedReferenceValue(reg, owner, op.componentType, op.fieldName, spelled) : spelled;
    // plan-774 F1: inside placed content the edit IS an instance override — the
    // save prunes everything under the reference node, so the value must also
    // land in `AssetOverrides.byAddress` of the OUTERMOST reference, spelled
    // exactly as the live node got it, inside this same op.
    const placed = this._instanceOverrideTarget(op.nodePath);
    // The asset's own value (for a later Revert) when no override holds the
    // field yet: the live value before this edit. Interactive ops carry it as
    // `op.prev` (the inspector writes userData optimistically BEFORE the op
    // runs, so userData is already the new value); a REPLAYED op's `prev` is
    // history, not the tree it lands on — there nothing wrote ahead, so the
    // node's current userData is the truth.
    const liveBefore: OverrideBase | null = !placed ? null
      : this.replaying ? this._liveFieldState(placed.node, op.componentType, op.fieldName)
        : op.prev === undefined ? { has: false } : { has: true, value: op.prev };
    writeUserDataField(this.viewer, op.nodePath, op.componentType, op.fieldName, value);
    if (placed) {
      // One read-modify-write of the record; what it held before is the undo capture.
      const before = writeOverride(placed.target.referenceNode, placed.target.address, op.componentType, op.fieldName, value);
      this._overridePrev.set(op.id, before);
      if (!before.has && liveBefore) recordOverrideBase(placed.node, op.componentType, op.fieldName, liveBefore);
    }
    this._reapplyOrDefer(op.nodePath, op.componentType);
    this._syncSignals(this._node(op.nodePath));
    this._syncSignalLinks(op);
    this.viewer.markRenderDirty();
  }

  /**
   * plan-2233: a write to `SignalLinks.Mappings` (do, undo, redo) reaches the binding
   * persistence cache and the runtime bindings, exactly as in the planner's document
   * (`syncSignalLinksRuntime`) — so a slot bound in the editor is bound, not just stored.
   */
  private _syncSignalLinks(op: { nodePath: string; componentType: string; fieldName: string }): void {
    if (op.componentType !== 'SignalLinks' || op.fieldName !== 'Mappings') return;
    const live = this._node(op.nodePath)?.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
    syncSignalLinksRuntime(this.viewer, op.nodePath, op.componentType, op.fieldName, live?.SignalLinks?.Mappings);
  }

  /**
   * plan-765 F3: `op.value` with every reference path re-spelled by the ONE
   * writer ({@link authoredAssetRelativePath}) when the field is reference-typed
   * in the rv-ODT schema (`ComponentReference` or an array of them) and the
   * written path pins exactly one node: a deterministic lookup stage (`exact` /
   * `alias` / `space` — never the guessing `suffix` / `sanitized` /
   * `name-in-scope` fallbacks) inside the owner's reference scope, whose
   * authored path is not shared by a sibling twin. An MCP or script author that
   * sends the loader's `Gripper_rv3/NL6501_1` then stores `Gripper_rv3/NL6:501`,
   * which survives save + reload. Anything else is written as given, and the
   * reference audit reports it. The op itself is not touched: replay re-spells
   * deterministically, and undo writes `op.prev` verbatim (`_inverse`).
   */
  private _authoredReferenceValue(op: AssetSetFieldOp): unknown {
    const prop = getRawOdtDef(op.componentType)?.properties?.[op.fieldName] as
      (Record<string, unknown> & { items?: Record<string, unknown> }) | undefined;
    const isRefDef = (p: Record<string, unknown> | undefined): boolean =>
      typeof p?.['$ref'] === 'string' && (p['$ref'] as string).endsWith('/ComponentReference');
    const single = isRefDef(prop);
    const array = !single && prop?.['type'] === 'array' && isRefDef(prop.items);
    if (!single && !array) return op.value;
    const reg = this.viewer.registry;
    const owner = this._node(op.nodePath);
    if (!reg || !owner) return op.value;
    const scope = reg.enclosingScope(owner);
    const respell = (v: unknown): unknown => {
      // An address-form reference (plan-769 Phase 3) names its target by id — there
      // is no spelling to choose.
      if (!isComponentReference(v) || typeof v.path !== 'string') return v;
      const hit = reg.resolveWithStage({ path: v.path }, typeof v.componentType === 'string' ? v.componentType : '', scope);
      if (!hit || (hit.stage !== 'exact' && hit.stage !== 'alias' && hit.stage !== 'space')) return v;
      if (authoredPathIsAmbiguous(hit.node, scope.root)) return v;
      const authored = authoredAssetRelativePath(hit.node, scope.root);
      return authored && authored !== v.path ? { ...v, path: authored } : v;
    };
    if (single) return respell(op.value);
    if (!Array.isArray(op.value)) return op.value;
    let changed = false;
    const out = op.value.map((e) => { const r = respell(e); if (r !== e) changed = true; return r; });
    return changed ? out : op.value;
  }

  private _unsetField(op: AssetUnsetFieldOp): void {
    const placed = this._instanceOverrideTarget(op.nodePath);
    if (!placed) {
      deleteUserDataField(this.viewer, op.nodePath, op.componentType, op.fieldName);
    } else {
      // plan-774 F1: on placed content an unset is a Revert of the instance
      // override — the override goes, and the live node returns to the asset's
      // own value where it is known (recorded at load or at the first edit).
      const base = overrideBaseOf(placed.node, op.componentType, op.fieldName);
      const before = writeOverride(placed.target.referenceNode, placed.target.address, op.componentType, op.fieldName, undefined);
      this._overridePrev.set(op.id, before);
      if (base?.has) {
        writeUserDataField(this.viewer, op.nodePath, op.componentType, op.fieldName, base.value);
      } else if (base || before.has) {
        // The asset does not set the field (known), or an override held it and
        // the asset's value is unknown: the field goes, as on own content.
        deleteUserDataField(this.viewer, op.nodePath, op.componentType, op.fieldName);
      }
      // else: nothing overrode the field and its base is unknown — the live
      // value IS the asset's value; deleting it would make the live tree and
      // the saved file disagree. A no-op Revert.
    }
    this._reapplyOrDefer(op.nodePath, op.componentType);
    this._syncSignals(this._node(op.nodePath));
    this._syncSignalLinks(op);
    this.viewer.markRenderDirty();
  }

  // ─── plan-774 F1: instance overrides of placed content ─────────────────

  /**
   * The outermost reference that owns an override for the node at `nodePath`,
   * with its address — null for the open file's own content (and for a node
   * that does not resolve).
   */
  private _instanceOverrideTarget(nodePath: string): { node: Object3D; target: OverrideTarget } | null {
    const node = this._node(nodePath);
    if (!node) return null;
    const target = overrideTargetOf(node, this.viewer.currentModelRoot ?? null);
    return target ? { node, target } : null;
  }

  /** What the node's live extras hold for one field right now (`has: false` = not set). */
  private _liveFieldState(node: Object3D, componentType: string, fieldName: string): OverrideBase {
    const fields = (node.userData?.realvirtual as Record<string, unknown> | undefined)?.[componentType];
    return fields && typeof fields === 'object' && fieldName in fields
      ? { has: true, value: (fields as Record<string, unknown>)[fieldName] }
      : { has: false };
  }

  /**
   * The inverse half: put back the override the forward step found — or its
   * absence. Same writer as forward. Without a capture (an op this executor
   * never applied forward) the previous live value is the best available
   * statement of the previous override — unless it IS the asset's own value
   * (the recorded base), which no override held: then there was none.
   */
  private _restoreInstanceOverride(op: AssetSetFieldOp | AssetUnsetFieldOp): void {
    const placed = this._instanceOverrideTarget(op.nodePath);
    if (!placed) return;
    const prev = this._overridePrev.get(op.id);
    let value: unknown;
    if (prev) {
      value = prev.has ? prev.value : undefined;
    } else {
      const base = overrideBaseOf(placed.node, op.componentType, op.fieldName);
      const isBase = !!base && (base.has
        ? op.prev !== undefined && jsonEqual(base.value, op.prev)
        : op.prev === undefined);
      value = isBase ? undefined : op.prev;
    }
    writeOverride(placed.target.referenceNode, placed.target.address, op.componentType, op.fieldName, value);
  }

  // ─── plan-610: deferred reference re-binding ─────────────────────────

  /**
   * Open re-bind session of the running reference-rewrite RANGE (null = none).
   * Holds the referrers whose schema re-apply was deferred (by node IDENTITY —
   * their paths change inside the range) and the composed old→new path remap
   * of every rename/reparent step.
   */
  private _refRebind: {
    deferred: Map<Object3D, Set<string>>;
    remap: Map<string, string>;
    /** Reverse of `remap`: current path → original path. */
    origOf: Map<string, string>;
  } | null = null;

  /**
   * Diagnostics: what the last re-bind flush did — deferred re-applies, foreign
   * referrers re-bound, distinct stale paths, failed referrers.
   */
  lastRefRebind: { deferred: number; foreign: number; stalePaths: number; failed: number } | null = null;

  /** Open a session; false when one is already open (it then collects for both). */
  private _openRefRebind(): boolean {
    if (this._refRebind) return false;
    this._refRebind = { deferred: new Map(), remap: new Map(), origOf: new Map() };
    return true;
  }

  /**
   * The schema re-apply of a written field: immediate (unscoped, as always)
   * outside a re-bind session; inside one only the extras are written now and
   * applySchema + resolveRefs + reapplyConfig run ONCE when the range is left.
   * reapplyConfig moves with resolveRefs on purpose — Lamp (`_rebind`) and
   * EnergyChain (`_resolveRefs`) read their reference fields there.
   */
  private _reapplyOrDefer(nodePath: string, componentType: string): void {
    const session = this._refRebind;
    const node = session ? this._node(nodePath) : null;
    if (!session || !node) {
      // A component re-apply may measure the node: never against matrices a
      // bulk move still owes (plan-610: moves followed by setField batch).
      this._drainMatrixBatch();
      reapplySchemaForComponent(this.viewer, nodePath, componentType);
      return;
    }
    let types = session.deferred.get(node);
    if (!types) session.deferred.set(node, (types = new Set()));
    types.add(componentType);
  }

  /**
   * Fold a step's old→new remap into the session's composed remap (A→B→C =
   * A→C, A→B→A = A→A, dropped at the flush). The reverse index `origOf` is
   * maintained incrementally — rebuilding it per step made a 434-move batch
   * quadratic in the number of re-keyed paths.
   */
  private _noteRemap(remap: ReadonlyMap<string, string>): void {
    const session = this._refRebind;
    if (!session || remap.size === 0) return;
    const { remap: composed, origOf } = session;
    for (const [from, to] of remap) {
      // A path an earlier step produced that moves again: carry the ORIGINAL key.
      const orig = origOf.get(from);
      if (orig !== undefined) {
        origOf.delete(from);
        composed.set(orig, to);
        origOf.set(to, orig);
      } else if (!composed.has(from)) {
        composed.set(from, to);
        origOf.set(to, from);
      }
    }
  }

  /**
   * Close the open session: re-apply every deferred referrer with its
   * AUTHORING scope, then re-bind foreign referrers — components whose extras
   * were NOT written but whose RESOLVED value is an address string under a
   * path that moved.
   *
   * Failures are collected PER REFERRER and never stop the flush: every other
   * referrer and the foreign scan still run. `strict` (the main pass of a
   * composite) then throws {@link ReferenceRebindError}, which rolls the
   * composite back; otherwise (a rollback's own flush) they are only logged.
   */
  private _closeRefRebind(compositeId: string, strict: boolean): void {
    const session = this._refRebind;
    this._refRebind = null;
    const reg = this.viewer.registry;
    if (!session || !reg) return;
    this._drainMatrixBatch();
    const failures: RebindFailure[] = [];
    let deferred = 0;
    for (const [node, types] of session.deferred) {
      const path = reg.getPathForNode(node);
      if (!path) continue; // trashed inside the range
      for (const type of types) {
        try {
          reapplySchemaForComponent(this.viewer, path, type, { scope: node });
          deferred++;
        } catch (e) {
          failures.push({ path, componentType: type, error: e });
        }
      }
    }
    const stale = new Map<string, string>();
    for (const [from, to] of session.remap) if (from !== to) stale.set(from, to);
    let foreign = 0;
    if (stale.size > 0) {
      try {
        foreign = this._rebindForeignReferrers(stale, session.deferred, failures);
      } catch (e) {
        failures.push({ path: '', componentType: '', error: e });
      }
    }
    // Stored references (and possibly paths) changed: "referenced by" is stale.
    reg.invalidateReverseRefs();
    this.lastRefRebind = { deferred, foreign, stalePaths: stale.size, failed: failures.length };
    if (failures.length === 0) return;
    const err = new ReferenceRebindError(compositeId, failures);
    if (strict) throw err;
    console.error(`[asset-edits] ${err.message} (during a rollback — not retried)`, failures);
  }

  /**
   * Re-bind FOREIGN referrers — components whose extras the range did not
   * write (e.g. content of a placed asset) but whose RESOLVED value is an
   * address string (scalar or array element) under a path that moved.
   *
   * plan-614 F1 — the target IDENTITY is kept, nothing is re-resolved:
   *
   * - The address a field held BEFORE the flush is the identity of its target.
   *   The session's composed remap (`stale`, A→B→C already folded to A→C,
   *   A→B→A already dropped) is applied to it ONCE and exactly that address is
   *   set. Re-resolving the unchanged extras instead (the plan-610 form) let an
   *   old absolute spelling land on a FOREIGN node by suffix after a move — and
   *   undo could not repair it, because the foreign address is no stale key.
   * - Only the affected fields / array elements change. Every other field of
   *   the component — instance references, untouched array elements, plain
   *   values — keeps its value bit for bit (an array without an affected
   *   element keeps even its identity).
   * - Per component the old values are snapshotted before the first write and
   *   the change is ATOMIC: a component is either fully re-bound or untouched.
   * - Refuse, never guess: when the remapped address of any affected field has
   *   no live registry node (the target was trashed inside the range, or the
   *   remap names nothing), the component is left untouched and a failure with
   *   the reason is recorded — the strict flush then throws
   *   {@link ReferenceRebindError} and the composite is rolled back.
   * - Undo / redo / rollback need no state of their own: the inverse walk
   *   re-keys the paths the other way round, its session's remap maps the
   *   re-bound address back, and this very routine sets it — so after undo the
   *   field points at its OWN target again.
   *
   * Instance-valued references (Drive, Sensor, node) are left alone: they
   * follow the node by identity across rename/move.
   *
   * Cost: one registry walk, O(components), per flushed range.
   */
  private _rebindForeignReferrers(
    stale: ReadonlyMap<string, string>,
    handled: ReadonlyMap<Object3D, ReadonlySet<string>>,
    failures: RebindFailure[],
  ): number {
    const reg = this.viewer.registry;
    if (!reg) return 0;
    let count = 0;
    const isStale = (v: unknown): v is string => typeof v === 'string' && stale.has(v);
    const isLive = (p: unknown): p is string => {
      if (typeof p !== 'string' || p === '') return false;
      const n = reg.getNode(p);
      return !!n && reg.getPathForNode(n) === p;
    };
    const isRefField = (raw: unknown): boolean =>
      isComponentReference(raw) || (Array.isArray(raw) && raw.some((e) => isComponentReference(e)));

    reg.forEachNode((path, node) => {
      if (reg.getPathForNode(node) !== path) return; // alias entry
      const done = handled.get(node);
      const extrasAll = node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
      if (!extrasAll) return;
      for (const [type, instance] of reg.getComponentsAt(path)) {
        if (done?.has(type)) continue;
        if (!instance || typeof instance !== 'object') continue;
        const inst = instance as Record<string, unknown>;
        const extras = extrasAll[type];
        if (!extras || typeof extras !== 'object') continue;

        // Plan the change: per affected reference-backed field the snapshot
        // (value before) and the remapped value. Nothing is written yet.
        const snapshot = new Map<string, unknown>();
        const next = new Map<string, unknown>();
        const plan: { refusal: string | null } = { refusal: null };
        const remapOnce = (key: string, held: string, index: number | null): string | null => {
          const to = stale.get(held);
          const where = index === null ? `${type}.${key}` : `${type}.${key}[${index}]`;
          if (to === undefined) {
            plan.refusal ??= `${where} held "${held}", which moved, but no remap target is known — refusing to guess`;
            return null;
          }
          if (!isLive(to)) {
            plan.refusal ??= `${where} held "${held}", which moved to "${to}" — no live node there, refusing to guess`;
            return null;
          }
          return to;
        };
        for (const key of Object.keys(extras)) {
          if (!isRefField(extras[key])) continue;
          const held = inst[key];
          if (isStale(held)) {
            const to = remapOnce(key, held, null);
            snapshot.set(key, held);
            if (to !== null) next.set(key, to);
          } else if (Array.isArray(held) && held.some(isStale)) {
            const arr = held as unknown[];
            const out = arr.slice();
            for (let i = 0; i < arr.length; i++) {
              const el: unknown = arr[i];
              if (!isStale(el)) continue; // neighbour element: untouched
              const to = remapOnce(key, el, i);
              if (to !== null) out[i] = to;
            }
            snapshot.set(key, held);
            next.set(key, out);
          }
        }
        if (snapshot.size === 0) continue;
        if (plan.refusal !== null) {
          // Atomic: the component is left exactly as it was (binding included).
          failures.push({ path, componentType: type, error: new Error(plan.refusal) });
          continue;
        }

        try {
          for (const [key, value] of next) inst[key] = value;
        } catch (e) {
          // A setter refused the value: put the snapshot back, report.
          for (const [key, value] of snapshot) {
            try { inst[key] = value; } catch { /* best effort — reported below */ }
          }
          failures.push({ path, componentType: type, error: e });
          continue;
        }
        try {
          // Move the consumer's listeners (Lamp `_rebind`, …) onto the new addresses.
          const c = inst as { reapplyConfig?: () => void };
          if (typeof c.reapplyConfig === 'function') c.reapplyConfig();
          count++;
        } catch (e) {
          // The fields keep their re-bound values on purpose: a rollback's
          // inverse remap maps exactly these back and re-runs reapplyConfig
          // against live paths (restoring the old, now dead addresses here
          // would subscribe to nothing).
          failures.push({ path, componentType: type, error: e });
        }
      }
    });
    return count;
  }

  /** Run the matrix refresh a bulk move still owes, keeping the batch open. */
  private _drainMatrixBatch(): void {
    const batch = this._matrixBatch;
    if (!batch || batch.size === 0) return;
    for (const parent of batch) parent.updateMatrixWorld(true);
    batch.clear();
  }

  // ─── helpers ──────────────────────────────────────────────────────────

  private _node(path: string): Object3D | null {
    return this.viewer.registry?.getNode(path) ?? null;
  }

  private _ensureTrashGroup(): Group {
    if (!this._trashGroup) {
      this._trashGroup = new Group();
      this._trashGroup.name = TRASH_GROUP_NAME;
      this._trashGroup.visible = false;
      this.viewer.scene.add(this._trashGroup);
    }
    return this._trashGroup;
  }

  /** plan-589 spike: bring the SignalStore in line with a mutated subtree (node identity). */
  private _syncSignals(node: Object3D | null): void {
    if (!node) return;
    try {
      syncSignalSubtree(this.viewer, node);
    } catch (e) {
      // The scene mutation has landed; a sync failure must not reject the op.
      console.warn('[asset-edits] signal sync failed:', e);
    }
  }

  /** The registry's component entries of every node below `root` ({@link TrashEntry.components}). */
  private _componentRegistrationsOf(root: Object3D): TrashEntry['components'] {
    const registry = this.viewer.registry;
    if (!registry) return undefined;
    const out: NonNullable<TrashEntry['components']> = [];
    root.traverse((n) => {
      const path = registry.getPathForNode(n);
      if (!path) return;
      const entries = registry.getComponentsAt(path);
      if (entries.length > 0) out.push({ node: n, entries });
    });
    return out;
  }

  private _registerSubtree(root: Object3D): void {
    const registry = this.viewer.registry;
    if (!registry) return;
    root.traverse((child) => {
      registry.registerNode(NodeRegistry.computeNodePath(child), child);
    });
    // plan-769 Phase 2 (F5): the id index follows every attach an op makes —
    // create, clone, import, restore from the trash, a separate/merge rebuild —
    // under the occurrence of the document the subtree landed in. The removal
    // side is `unregisterSubtree` (detach to trash, teardown).
    registry.registerSubtreeIds?.(root);
  }

  /**
   * Publish the AUTHORED spellings (`userData._rvOrigName`) of a subtree an op
   * attached as registry aliases — what the loader publishes for loaded nodes
   * (`forEachNodeAlias`): a copy (plan-769 D9) or a subtree back from the trash
   * resolves in the spelling its references are written in. `unregisterSubtree`
   * takes them down again; a claimed path is never overwritten.
   */
  private _registerAuthoredAliases(root: Object3D): void {
    const registry = this.viewer.registry;
    if (!registry) return;
    const renamed = new Map<Object3D, string>();
    root.traverse((n) => {
      const orig = n.userData?.[RV_ORIG_NAME_KEY];
      if (typeof orig === 'string' && orig.length > 0 && orig !== n.name) renamed.set(n, orig);
    });
    if (renamed.size > 0) registerNodeAliasesInRegistry(renamed, registry);
  }

  /**
   * plan-769 Phase 2: the op's id map, completed. A recorded op carries it (replay /
   * redo after a trash flush give the same ids); the FIRST apply starts it empty and
   * the map is written back onto the op before the document records it.
   */
  private _idMapOf(op: { idMap?: NodeIdMap }): NodeIdMap {
    if (!op.idMap || typeof op.idMap !== 'object') op.idMap = {};
    return op.idMap;
  }

  private _runtimeDeps(): RuntimeNodeDeps | null {
    const v = this.viewer;
    if (!v.registry || !v.signalStore || !v.transportManager) return null;
    return {
      registry: v.registry,
      signalStore: v.signalStore,
      scene: v.scene,
      transportManager: v.transportManager,
      gizmoManager: v.gizmoManager,
      lampManager: v.lampManager,
      webLabelManager: v.webLabelManager,
      sceneButtonManager: v.sceneButtonManager,
      errorStore: v.errorStore,
      instructionStore: v.instructionStore,
      // plan-411 Phase 1: the viewer IS the drive lifecycle host, and it is the
      // typed event bus the construction findings travel on.
      driveHost: v,
      events: v,
    };
  }
}

// ─── module helpers ───────────────────────────────────────────────────

/**
 * plan-769 Phase 2 (D9): the node a stored reference of `sourceReferrer` names, read
 * exactly as the source reads it — the file's verdict for a reference the file
 * carries (`readStoredRef`, never guessed), else (`legacy`: a path the web wrote) the
 * registry's own chain relative to the referrer, exact stages only. A miss is null:
 * the copy's reference then stays as written.
 */
function copiedReferenceTarget(registry: NodeRegistry, sourceReferrer: Object3D, ref: VisitedReference): Object3D | null {
  // plan-769 Phase 3a: THE writer's read (`referenceTargetForWrite`, exact stages only) —
  // the copy follows exactly the target a save would write for the source.
  const t = referenceTargetForWrite(registry, sourceReferrer, ref.value, { exactOnly: true });
  return t.status === 'resolved' ? t.node : null;
}

/** `BoxCollider` (with or without a `_N` dedup suffix). */
function isBoxColliderKey(componentType: string): boolean {
  return componentType.replace(/_\d+$/, '') === 'BoxCollider';
}

/** `Drive` or one of the `Drive_*` behaviors (with or without a `_N` dedup
 *  suffix) — the family whose runtime construction can REFUSE (plan-411). */
function isDriveFamilyType(componentType: string): boolean {
  const base = componentType.replace(/_\d+$/, '');
  return base === 'Drive' || base in DRIVE_BEHAVIOR_MAP;
}

/** A composite that only moves and renames nodes — the shape `reparentNodesBatch`
 *  produces — optionally FOLLOWED by setField/unsetField steps (plan-610: the
 *  reference rewrite of a rename/move). The only shape whose world-matrix
 *  refresh may be batched: the batch covers the move prefix, and the executor
 *  drains it before any field re-apply runs (`_drainMatrixBatch`). */
function isPureMoveComposite(op: RvAssetOp): boolean {
  if (op.kind !== 'composite' || op.ops.length <= 1) return false;
  let moves = 0;
  let inFields = false;
  for (const child of op.ops) {
    if (child.kind === 'reparentNode' || child.kind === 'renameNode') {
      if (inFields) return false;
      moves++;
    } else if (child.kind === 'setField' || child.kind === 'unsetField') {
      inFields = true;
    } else {
      return false;
    }
  }
  return moves > 0;
}

/** Move an already-added child to a specific sibling slot (`add()` appends). */
function spliceChildTo(parent: Object3D, child: Object3D, index: number): void {
  const arr = parent.children;
  const at = arr.indexOf(child);
  if (at < 0 || index < 0) return;
  arr.splice(at, 1);
  arr.splice(Math.min(index, arr.length), 0, child);
}

/** True when `node` sits inside `root`'s subtree (root itself counts). */
function isDescendantOf(node: Object3D, root: Object3D): boolean {
  for (let p: Object3D | null = node; p; p = p.parent) if (p === root) return true;
  return false;
}

/**
 * The first recorded output name that would collide under its owner, or `null`.
 *
 * Names are applied VERBATIM on replay (same contract as `separateMesh.childNames`), so a
 * collision has to be reported rather than silently renamed — a rename would shift the
 * paths every later op in the draft refers to.
 */
function firstOutputNameCollision(
  op: MergeMeshOp,
  keptByNode: Map<Object3D, MergeKeptNodeSpec>,
): string | null {
  const takenByOwner = new Map<string, Set<string>>();
  for (const [node, spec] of keptByNode) {
    let taken = takenByOwner.get(spec.ownerPath);
    if (!taken) { taken = new Set<string>(); takenByOwner.set(spec.ownerPath, taken); }
    taken.add(node.name);
  }
  for (const spec of op.outputs) {
    // The 'root' output's name lives under the root's PARENT (it replaces the root), so
    // it never competes with the kept children that end up beneath it.
    if (spec.role === 'root') continue;
    let taken = takenByOwner.get(spec.ownerPath);
    if (!taken) { taken = new Set<string>(); takenByOwner.set(spec.ownerPath, taken); }
    if (taken.has(spec.name)) {
      return `recorded output name "${spec.name}" collides under "${spec.ownerPath}"`;
    }
    taken.add(spec.name);
  }
  return null;
}

/**
 * Property parity for the mesh that REPLACES the merged subtree root (plan-372 §2.6
 * step 8). Anything missing here is a property the asset silently loses on a merge.
 */
function applyRootParity(mesh: Mesh, root: Object3D, localMatrix: Matrix4, worldMatrix: Matrix4): void {
  localMatrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
  // Both: the TRS for anything that recomputes, the matrix for the frozen case where
  // nothing will.
  mesh.matrix.copy(localMatrix);
  mesh.matrixWorld.copy(worldMatrix);
  mesh.matrixAutoUpdate = root.matrixAutoUpdate;
  mesh.matrixWorldAutoUpdate = root.matrixWorldAutoUpdate;
  mesh.visible = root.visible;
  mesh.layers.mask = root.layers.mask;
  mesh.castShadow = root.castShadow;
  mesh.receiveShadow = root.receiveShadow;
  mesh.renderOrder = root.renderOrder;
  mesh.frustumCulled = root.frustumCulled;
  // Deep copy — a shared userData object would mean every later edit on the output also
  // mutates the original parked in the trash.
  mesh.userData = cloneUserData(root.userData as Record<string, unknown>);
}

/**
 * Ensure the node carries a `Group`/`Group_N` extra for every resolved group name.
 *
 * `rv-group-sync` derives membership EXCLUSIVELY from `userData.realvirtual.Group*`, so
 * an output without these extras silently drops out of its groups — no overlay, no
 * visibility switching, and the loss survives the GLB round-trip.
 */
function applyGroupExtras(node: Object3D, groupNames: string[]): void {
  if (groupNames.length === 0) return;
  const ud = node.userData as Record<string, unknown>;
  const rv = { ...(ud['realvirtual'] as Record<string, unknown> | undefined) };

  const present = new Set<string>();
  for (const key of Object.keys(rv)) {
    if (!GROUP_KEY_RE.test(key)) continue;
    const name = (rv[key] as Record<string, unknown> | undefined)?.['GroupName'];
    if (typeof name === 'string') present.add(name);
  }
  for (const name of groupNames) {
    if (present.has(name)) continue;
    let key = 'Group';
    for (let n = 1; key in rv; n++) key = `Group_${n}`;
    rv[key] = { GroupName: name };
    present.add(name);
  }
  ud['realvirtual'] = rv;
}

/** Re-express a node's local TRS under a new parent so its WORLD pose is unchanged. */
function rebaseLocalMatrix(node: Object3D, target: Object3D): void {
  const local = new Matrix4().copy(target.matrixWorld).invert().multiply(node.matrixWorld);
  local.decompose(node.position, node.quaternion, node.scale);
  node.matrix.copy(local);
}

/** Put a recorded local matrix back, TRS and matrix alike (frozen nodes need both). */
function restoreLocalMatrix(node: Object3D, matrix: Matrix4): void {
  matrix.decompose(node.position, node.quaternion, node.scale);
  node.matrix.copy(matrix);
}

/** First generated name that collides with an existing sibling, or with itself. */
function firstNameCollision(names: readonly string[], siblings: readonly Object3D[]): string | null {
  const taken = new Set(siblings.map((c) => c.name));
  for (const name of names) {
    if (taken.has(name)) return name;
    taken.add(name);
  }
  return null;
}

/**
 * Deep copy of a node's `userData`.
 *
 * JSON round-trip on purpose (same as `deepCloneJSON`): it drops exactly the
 * things that must not be copied — the non-enumerable `_rvComponentInstance` /
 * `_rvComponentInstances` back-references and any function — while duplicating
 * `realvirtual` deeply, so
 * the Group and the parked original never share a mutable object.
 */
function cloneUserData(userData: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(userData ?? {})) as Record<string, unknown>;
  } catch {
    // A non-serializable extra (should not happen — rv_extras are JSON) must not
    // cost the whole split; fall back to a shallow copy with a cloned rv block.
    const shallow: Record<string, unknown> = { ...userData };
    const rv = shallow['realvirtual'];
    if (rv && typeof rv === 'object') shallow['realvirtual'] = { ...(rv as Record<string, unknown>) };
    return shallow;
  }
}

function applyTransform(node: Object3D, t: NodeTransform): void {
  node.position.fromArray(t.position);
  node.quaternion.fromArray(t.quaternion);
  node.scale.fromArray(t.scale);
  node.updateMatrix();
}

function leaf(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

function replaceLeaf(path: string, newLeaf: string): string {
  const idx = path.lastIndexOf('/');
  return idx < 0 ? newLeaf : path.slice(0, idx + 1) + newLeaf;
}

function dirname(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx < 0 ? '' : path.slice(0, idx);
}

// Always join with '/' so the result matches NodeRegistry.computeNodePath —
// including under an UNNAMED asset root, where the parent path is '' and the
// child path is '/child' (leading empty segment). Dropping the slash for empty
// parent paths would desync the reparent inverse from the registry key. See the
// matching note on childPath/joinPaths in rv-asset-document.ts.
function joinPath(parentPath: string, childName: string): string {
  return `${parentPath}/${childName}`;
}
