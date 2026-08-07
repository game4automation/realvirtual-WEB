// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-asset-ops — Operation log for the Asset editor document.
 *
 * The asset editor (workspace mode `editor`) authors a GLB asset: import CAD
 * subtrees, transform/rename/delete nodes, add/remove rv_extras components,
 * edit fields. Every edit is an immutable `AssetOp` carrying its own inverse
 * payload — the same command-pattern the Scene op log uses, but a DELIBERATELY
 * SEPARATE document (a Scene is a layout/session over a base model; an Asset
 * is the GLB itself being authored — see doc-persistence.md).
 *
 * This module is **pure** (no Three.js / DOM / storage): op taxonomy,
 * coalescing, inverse and description helpers. Application to the live scene
 * lives in `rv-asset-executors.ts`; the queue/undo machinery in
 * `rv-asset-document.ts`.
 *
 * Ops are JSON-safe by construction — CAD geometry is never inlined, only
 * referenced by content hash (`CADLinkExtras.Sha256`) and re-materialised via
 * the `CadGeometryProvider` on draft replay.
 */

import { freshOpId, COALESCE_WINDOW_MS, deepCloneJSON } from '../ops/rv-op-utils';

// ─── CADLink ────────────────────────────────────────────────────────────

/**
 * The `CADLink` rv_extras stamped on every imported CAD root — the web
 * counterpart of Unity's CADLink component (File/Quality/scale/up-axis), plus
 * the content hash the browser uses to re-materialise cached geometry.
 * Enables later "re-import CAD" (geometry swap) without redoing component setup.
 */
export interface CADLinkExtras {
  /** Original CAD file name (e.g. "gearbox.step"). */
  File: string;
  /** SHA-256 of the original CAD bytes — cache key for re-tessellation. */
  Sha256: string;
  /** Tessellation quality preset id (e.g. 'coarse' | 'standard' | 'fine'). */
  Quality: string;
  /** Import scale factor (mm→m), mirrors Unity CADLink. Always 0.001 today. */
  ImportScaleFactor: number;
  /** Source CAD is Z-up (rotated to Y-up on import), mirrors Unity CADLink. */
  ZIsUpVector: boolean;
}

// ─── Op taxonomy ────────────────────────────────────────────────────────

/** Node-local TRS snapshot used by transform ops. */
export interface NodeTransform {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
}

/** Common header fields on every asset op. */
interface AssetOpBase {
  /** Stable id (`op_<base36-time>_<rand6>`). */
  id: string;
  /** Wall-clock timestamp at op creation. Display + coalescing window. */
  ts: number;
  /** Op-shape version. Bump + migrate when a kind's payload changes. */
  schemaV: 1;
}

/** Attach an imported CAD subtree under the asset root. Geometry by hash. */
export interface ImportCadOp extends AssetOpBase {
  kind: 'importCad';
  /** Node path of the created CAD root (child of the asset root). */
  rootPath: string;
  /** CADLink extras stamped on the root (also the geometry re-materialise key). */
  cadlink: CADLinkExtras;
  /** Local transform of the CAD root at import (identity unless placed). */
  transform: NodeTransform;
}

/** Set a node's local TRS. */
export interface TransformNodeOp extends AssetOpBase {
  kind: 'transformNode';
  nodePath: string;
  transform: NodeTransform;
  prev: NodeTransform;
}

/** Rename a node (updates all descendant registry paths). */
export interface RenameNodeOp extends AssetOpBase {
  kind: 'renameNode';
  nodePath: string;
  name: string;
  prevName: string;
}

/** Detach a subtree (undo re-attaches — executor keeps it in a hidden trash). */
export interface DeleteNodeOp extends AssetOpBase {
  kind: 'deleteNode';
  nodePath: string;
}

/** Show/hide a node. Persists as `userData.realvirtual.Hidden` so the state
 *  survives the GLB bake (glTF itself has no node visibility). */
export interface SetNodeVisibleOp extends AssetOpBase {
  kind: 'setNodeVisible';
  nodePath: string;
  visible: boolean;
  prev: boolean;
}

/** Create an EMPTY node (Object3D) under a parent. The leaf name is deduped
 *  at op CREATION (`uniqueChildName`) so draft replay is deterministic. Undo
 *  detaches to the trash (`create:<opId>`), so components/children added
 *  later survive an undo→redo cycle. */
export interface CreateNodeOp extends AssetOpBase {
  kind: 'createNode';
  /** Full path of the created node: `<parentPath>/<dedupedName>`. */
  nodePath: string;
  /** Local TRS at creation (identity for plain empties). */
  transform: NodeTransform;
  /** Sibling insert position under the parent (append when omitted). */
  index?: number;
}

/** Move a subtree under a new parent, preserving its world transform. The
 *  world-preserving local TRS is computed at op CREATION so the executor only
 *  applies recorded numbers (deterministic replay). */
export interface ReparentNodeOp extends AssetOpBase {
  kind: 'reparentNode';
  /** Node path BEFORE the move. */
  nodePath: string;
  /** Registry path of the new parent ('' = the asset root). */
  newParentPath: string;
  /** Sibling position under the new parent (append when omitted). */
  newIndex?: number;
  /** Local TRS under the new parent (world pose preserved). */
  transform: NodeTransform;
  // inverse payload
  prevParentPath: string;
  prevIndex: number;
  prevTransform: NodeTransform;
}

/** Add an rv_extras component to a node. `componentType` is the ALREADY
 *  DEDUPED key (`Drive`, `Drive_1`, …) so replay is deterministic. */
export interface AddComponentOp extends AssetOpBase {
  kind: 'addComponent';
  nodePath: string;
  componentType: string;
  /** Initial field map (schema defaults + any user overrides). */
  fields: Record<string, unknown>;
}

/** Remove an rv_extras component from a node. */
export interface RemoveComponentOp extends AssetOpBase {
  kind: 'removeComponent';
  nodePath: string;
  componentType: string;
  /** Field map at removal — restored by undo. */
  prevFields: Record<string, unknown>;
}

/** Set a single field on `userData.realvirtual[componentType][fieldName]`.
 *  Payload shape matches the Scene op so EditTarget adapters stay trivial. */
export interface AssetSetFieldOp extends AssetOpBase {
  kind: 'setField';
  nodePath: string;
  componentType: string;
  fieldName: string;
  value: unknown;
  prev: unknown;
}

/** Remove a field override (restores via inverse `prev`). */
export interface AssetUnsetFieldOp extends AssetOpBase {
  kind: 'unsetField';
  nodePath: string;
  componentType: string;
  fieldName: string;
  prev: unknown;
}

/**
 * A serializable PBR material value — the payload of a material preset.
 *
 * Deliberately a plain JSON record with NO texture maps: the Materials window
 * authors flat PBR appearance (the overwhelming majority of CAD-cleanup work),
 * and keeping the op JSON-safe is what lets it replay from an IndexedDB draft.
 * Meshes whose ORIGINAL material carried textures are restored on undo from the
 * executor's trash bin, not from this record — see `SetMaterialOp.prev`.
 */
export interface MaterialValue {
  /** Preset display name, carried for undo labels ("Material: Brushed Alu"). */
  name: string;
  /** Base color as `#rrggbb` (sRGB, as authored in the UI). */
  color: string;
  /** 0..1 */
  metalness: number;
  /** 0..1 */
  roughness: number;
  /** 0..1 — values < 1 imply `transparent`. */
  opacity: number;
  transparent: boolean;
  /** Emissive color `#rrggbb`. Omitted = black (non-emissive). */
  emissive?: string;
  emissiveIntensity?: number;
}

/**
 * Assign a material to every mesh under each of `nodePaths`.
 *
 * Editor mode loads with `preserveHierarchy: true` — no uber bake, no
 * BatchTable — so every node keeps its own real material and a plain
 * `mesh.material = …` assignment both renders immediately AND survives the GLB
 * export (GLTFExporter serializes the live graph). See doc-render-picking.md
 * §1.1; this op MUST NOT be reachable from batched modes.
 */
export interface SetMaterialOp extends AssetOpBase {
  kind: 'setMaterial';
  /** Selected node paths — the executor expands each to its descendant meshes. */
  nodePaths: string[];
  /** The material to apply. */
  material: MaterialValue;
  /**
   * Inverse payload, resolved per MESH at op creation (a selection can span
   * meshes with different starting materials). `material: null` means the
   * original was not expressible as a `MaterialValue` (it had texture maps or
   * was a non-standard material type) — the executor restores those from its
   * trash bin by `trashKey` instead.
   */
  prev: Array<{ meshPath: string; material: MaterialValue | null }>;
}

/**
 * Split ONE mesh into its connected islands (or into its `geometry.groups`),
 * replacing it with a same-named `Group` that carries the parts as children.
 *
 * PARAMETER-ONLY, never geometry (plan-331 §2.3). The source geometry is always
 * live in the tree when the op is reached — either from the loaded base (a draft
 * may start on a `libraryGlb` base, loaded BEFORE the replay) or from a preceding
 * op, and `replayOps()` applies strictly in order. So the executor can always
 * recompute the partition from the live mesh, which is what keeps the op
 * JSON-safe and the draft small.
 */
export interface SeparateMeshOp extends AssetOpBase {
  kind: 'separateMesh';
  /** Path of the source mesh — also the path of the Group that replaces it. */
  sourcePath: string;
  /** 'islands' = union-find over connectivity, 'groups' = `geometry.groups`. */
  mode: 'islands' | 'groups';
  /** Quantization resolution in scene units (`mode: 'islands'` only). */
  weldThreshold: number;
  /**
   * Names of the generated children, in partition order.
   *
   * Determined ONCE at op creation and applied VERBATIM by the executor, which
   * deliberately does not re-run `dedupeSiblingNames()`: otherwise the names
   * would hang off that function's implementation, and changing it would shift
   * every child path when an old draft replays — silently breaking the node
   * references of every later op. A collision on replay is an error (no-op with
   * a diagnostic), never a silent rename.
   */
  childNames: string[];
}

/**
 * Replay signature of ONE merge source (plan-372 §2.3, finding R-N1).
 *
 * `materialKey` is a SEMANTIC fingerprint, deliberately not `material.uuid`: three.js
 * mints a fresh uuid in every `Material` constructor, so a plain GLB reload would already
 * make a uuid-based op fail its own replay check.
 */
export interface MergeSourceSignature {
  /** `materialFingerprint()` — name, colour, metalness, roughness, map name, side, … */
  materialKey: string;
  vertexCount: number;
  triangleCount: number;
}

/** One output mesh of a `mergeMesh` op. */
export interface MergeOutputSpec {
  /** Indices into `MergeMeshOp.sourcePaths` that flow into this mesh. */
  sourceIndices: number[];
  /**
   * `'root'` exactly ONCE per merge: that output REPLACES the subtree root (same name,
   * property parity per plan §2.6 step 8) and is therefore its own owner — no
   * self-parenting. Every other root-zone output becomes ITS child; anchor outputs
   * become children of their anchor. When the root zone carries no geometry the
   * `'root'` output is the geometry-less carrier that keeps the result form intact.
   */
  role: 'root' | 'child';
  /**
   * STRUCTURAL OWNER: the root path itself, or the path of a nested anchor. Without it
   * geometry under a Drive/Kinematic would stop being moved by it.
   */
  ownerPath: string;
  /** Name under the owner — applied VERBATIM, never re-deduped. */
  name: string;
  /** Group names written back as `Group`/`Group_N` extras (rv-group-sync reads only those). */
  groupNames: string[];
}

/** One node that survives the merge and is re-homed under its owner zone. */
export interface MergeKeptNodeSpec {
  /** Path BEFORE the merge. */
  path: string;
  /** `protected` = carrier or naming convention (subtree exempt); `anchor` = owns a zone. */
  role: 'protected' | 'anchor';
  /** Owner zone it belongs under afterwards: the root path or an anchor path. */
  ownerPath: string;
}

/**
 * Merge the subtree of ONE node into one mesh per material AND per Group, replacing the
 * node with a same-named `Mesh` (plan-372). The inverse of `separateMesh`.
 *
 * PARAMETER-ONLY, never geometry. Unlike `separateMesh` the executor may NOT re-derive
 * the partition on replay: bucketing depends on the MATERIAL, and a `setMaterial` op
 * between op creation and replay would produce a different bucket split — different
 * output meshes, different paths, and every later op editing the wrong tree. So
 * `sourcePaths`, `outputs` and `kept` are resolved once, at op creation, and applied
 * verbatim; a divergence is a collected, user-recoverable failure, never a silent no-op.
 */
export interface MergeMeshOp extends AssetOpBase {
  kind: 'mergeMesh';
  /** Path of the subtree root — also the path of the mesh that replaces it. */
  rootPath: string;
  /** The source meshes, explicit and in bucket-partition order. */
  sourcePaths: string[];
  /** Replay signature per source, indexed like `sourcePaths`. */
  sourceSignatures: MergeSourceSignature[];
  /** One entry per output mesh; exactly one carries `role: 'root'`. */
  outputs: MergeOutputSpec[];
  /** Surviving nodes, in PRE-ORDER so an anchor is re-homed before anything under it. */
  kept: MergeKeptNodeSpec[];
}

/** Composite (transaction) — multiple primitives as one undo unit. */
export interface AssetCompositeOp extends AssetOpBase {
  kind: 'composite';
  label: string;
  ops: AssetPrimitiveOp[];
}

export type AssetPrimitiveOp =
  | ImportCadOp
  | TransformNodeOp
  | RenameNodeOp
  | DeleteNodeOp
  | SetNodeVisibleOp
  | CreateNodeOp
  | ReparentNodeOp
  | AddComponentOp
  | RemoveComponentOp
  | AssetSetFieldOp
  | AssetUnsetFieldOp
  | SetMaterialOp
  | SeparateMeshOp
  | MergeMeshOp;

export type AssetOp = AssetPrimitiveOp | AssetCompositeOp;

// ─── Op construction helpers ────────────────────────────────────────────

/** Header for a fresh op. */
export function assetOpHeader(): { id: string; ts: number; schemaV: 1 } {
  return { id: freshOpId(), ts: Date.now(), schemaV: 1 };
}

/**
 * Deduplicate a component key against a node's existing rv_extras — same
 * `_N` suffix convention the Unity exporter and the scene loader use
 * (`PLCOutputBool`, `PLCOutputBool_1`, …). Called at op CREATION time so the
 * stored key replays deterministically.
 */
export function dedupeComponentKey(
  rv: Record<string, unknown> | undefined,
  baseType: string,
): string {
  if (!rv || !(baseType in rv)) return baseType;
  for (let n = 1; ; n++) {
    const key = `${baseType}_${n}`;
    if (!(key in rv)) return key;
  }
}

// ─── Coalescing ─────────────────────────────────────────────────────────

/** Same-target adjacent ops within the window merge (typing / gizmo drags). */
export function canCoalesceAssetOps(last: AssetOp, next: AssetOp): boolean {
  if (last.kind !== next.kind) return false;
  if (last.kind === 'composite' || next.kind === 'composite') return false;
  if (next.ts - last.ts > COALESCE_WINDOW_MS) return false;
  if (next.ts < last.ts) return false;
  switch (next.kind) {
    case 'setField':
    case 'unsetField': {
      const a = last as AssetSetFieldOp | AssetUnsetFieldOp;
      return a.nodePath === next.nodePath
        && a.componentType === next.componentType
        && a.fieldName === next.fieldName;
    }
    case 'transformNode':
      return (last as TransformNodeOp).nodePath === next.nodePath;
    case 'renameNode':
      return (last as RenameNodeOp).nodePath === next.nodePath;
    // Dragging a roughness/metalness slider fires a value per pointermove.
    // Same selection within the window = one undo step (mirrors transformNode).
    case 'setMaterial': {
      const a = last as SetMaterialOp;
      return a.nodePaths.length === next.nodePaths.length
        && a.nodePaths.every((p, i) => p === next.nodePaths[i]);
    }
    // Structural ops are discrete user actions — never coalesce.
    // setNodeVisible: each toggle is a discrete undo step by design.
    case 'importCad':
    case 'deleteNode':
    case 'setNodeVisible':
    case 'createNode':
    case 'reparentNode':
    case 'addComponent':
    case 'removeComponent':
    // separateMesh / mergeMesh rebuild a subtree — one deliberate action, one undo step.
    case 'separateMesh':
    case 'mergeMesh':
      return false;
  }
}

/** Merge `next` into `last` (caller verified canCoalesceAssetOps). Keeps
 *  `last.id/ts/prev`, takes `next`'s forward payload — one undo reverts the
 *  whole run. */
export function mergeAssetOps(last: AssetOp, next: AssetOp): AssetOp {
  if (last.kind !== next.kind || last.kind === 'composite' || next.kind === 'composite') {
    throw new Error('mergeAssetOps: precondition violated — call canCoalesceAssetOps first');
  }
  switch (next.kind) {
    case 'setField':
      return { ...(last as AssetSetFieldOp), value: next.value };
    case 'unsetField':
      return last;
    case 'transformNode':
      return { ...(last as TransformNodeOp), transform: deepCloneJSON(next.transform) };
    case 'renameNode':
      return { ...(last as RenameNodeOp), name: next.name };
    // Keep `last.prev` — it holds the per-mesh state from BEFORE the drag began,
    // which is exactly what one undo must restore.
    case 'setMaterial':
      return { ...(last as SetMaterialOp), material: deepCloneJSON(next.material) };
    default:
      throw new Error('mergeAssetOps: structural ops never coalesce');
  }
}

// ─── Structural classification ──────────────────────────────────────────

/**
 * True if applying (or inverting) this op changes what the hierarchy panel
 * shows: nodes added/removed/renamed or component badges changed. Transform
 * and field edits don't move nodes in or out of the tree.
 */
export function assetOpTouchesHierarchy(op: AssetOp): boolean {
  if (op.kind === 'composite') return op.ops.some(assetOpTouchesHierarchy);
  return op.kind === 'importCad'
    || op.kind === 'deleteNode'
    || op.kind === 'setNodeVisible' // eye-icon state lives on the live node
    || op.kind === 'renameNode'
    || op.kind === 'createNode'
    || op.kind === 'reparentNode'
    || op.kind === 'addComponent'
    || op.kind === 'removeComponent'
    // The source mesh becomes a Group and gains N children — the hierarchy
    // panel shows a different tree afterwards.
    || op.kind === 'separateMesh'
    // The mirror image: a whole subtree collapses into one mesh per material.
    || op.kind === 'mergeMesh';
}

/** How an op affects the grouped raycast BVH ({@link classifyAssetOpRaycastImpact}). */
export interface AssetOpRaycastImpact {
  /** Structural change — needs a full `buildRaycastGeometries` rebuild. */
  rebuild: boolean;
  /** Pure transforms — node paths eligible for the position-refit fast path.
   *  Empty whenever `rebuild` is true (the rebuild re-bakes everything). */
  refitPaths: string[];
}

/**
 * Classify how an op (or its inverse — same shape) invalidates the grouped
 * raycast BVH:
 *
 *   - `transformNode` moves baked world-space positions but changes neither
 *     the mesh set, the face order nor any `FaceRange.objectPath` — the
 *     position-refit fast path (`RVViewer.refitRaycastSubtrees`) covers it.
 *   - `setField` / `unsetField` never touch pick geometry.
 *   - Everything else is structural: meshes enter/leave the merge
 *     (import/create/delete, `setNodeVisible` stamps the `rv.Hidden` flag the
 *     build EXCLUDES on), path strings change (rename/reparent), or the
 *     static/kinematic partition flips (add/remove Drive) — full rebuild.
 */
export function classifyAssetOpRaycastImpact(op: AssetOp): AssetOpRaycastImpact {
  const impact: AssetOpRaycastImpact = { rebuild: false, refitPaths: [] };
  collectRaycastImpact(op, impact);
  if (impact.rebuild) impact.refitPaths.length = 0; // the rebuild covers them
  return impact;
}

function collectRaycastImpact(op: AssetOp, into: AssetOpRaycastImpact): void {
  switch (op.kind) {
    case 'composite':
      for (const child of op.ops) collectRaycastImpact(child, into);
      return;
    case 'transformNode':
      into.refitPaths.push(op.nodePath);
      return;
    case 'setField':
    case 'unsetField':
    // Appearance only — the mesh set, face order and every FaceRange.objectPath
    // are untouched, so the pick BVH stays valid.
    case 'setMaterial':
      return;
    // Stated explicitly rather than left to the default branch: the mesh set
    // changes (one mesh leaves, N enter) AND every FaceRange.objectPath under
    // the source is replaced, so the merged pick geometry must be rebuilt.
    case 'separateMesh':
    // Same from the other direction: N meshes leave, few enter, and every
    // FaceRange.objectPath under the merged root is replaced.
    case 'mergeMesh':
      into.rebuild = true;
      return;
    default:
      into.rebuild = true;
  }
}

// ─── Description (undo/redo labels, history UI) ─────────────────────────

export function describeAssetOp(op: AssetOp): string {
  switch (op.kind) {
    case 'importCad':      return `Import ${op.cadlink.File}`;
    case 'transformNode':  return `Transform ${leaf(op.nodePath)}`;
    case 'renameNode':     return `Rename ${op.prevName} → ${op.name}`;
    case 'deleteNode':     return `Delete ${leaf(op.nodePath)}`;
    case 'setNodeVisible': return op.visible ? `Show ${leaf(op.nodePath)}` : `Hide ${leaf(op.nodePath)}`;
    case 'createNode':     return `Create ${leaf(op.nodePath)}`;
    case 'reparentNode':   return `Move ${leaf(op.nodePath)}`;
    case 'addComponent':   return `Add ${op.componentType} to ${leaf(op.nodePath)}`;
    case 'removeComponent':return `Remove ${op.componentType} from ${leaf(op.nodePath)}`;
    case 'setField':       return `Set ${op.componentType}.${op.fieldName} on ${leaf(op.nodePath)}`;
    case 'unsetField':     return `Reset ${op.componentType}.${op.fieldName} on ${leaf(op.nodePath)}`;
    case 'setMaterial':    return `Material ${op.material.name} (${op.prev.length} mesh${op.prev.length === 1 ? '' : 'es'})`;
    case 'separateMesh':   return `Separate ${leaf(op.sourcePath)} (${op.childNames.length} parts)`;
    case 'mergeMesh':      return `Merge ${leaf(op.rootPath)} (${op.sourcePaths.length} → ${op.outputs.length} mesh${op.outputs.length === 1 ? '' : 'es'})`;
    case 'composite':      return op.label;
  }
}

function leaf(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}
