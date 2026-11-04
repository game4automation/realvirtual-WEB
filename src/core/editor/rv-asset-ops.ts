// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-asset-ops — the ASSET-lineage op payloads and their classifiers.
 *
 * The asset editor (workspace mode `editor`) authors a GLB asset: import CAD
 * subtrees, transform/rename/delete nodes, add/remove rv_extras components,
 * edit fields. Every edit is an immutable {@link RvAssetOp} carrying its own
 * inverse payload — the same command-pattern the Scene op log uses, over the
 * same ONE vocabulary (`core/ops/rv-unified-ops.ts`), but a different TARGET
 * (a Scene is a layout/session over a base model; an Asset is the GLB itself
 * being authored — see doc-persistence.md).
 *
 * plan-710 removed this module's second op union (`AssetOp` /
 * `AssetPrimitiveOp` / `AssetCompositeOp`) and its hand-maintained twins of the
 * unified coalescing and description helpers. What remains is what has no
 * counterpart in the union: the per-kind PAYLOAD interfaces and the two
 * asset-specific classifiers (`assetOpTouchesHierarchy`,
 * `classifyAssetOpRaycastImpact`).
 *
 * This module is **pure** (no Three.js / DOM / storage). Application to the live
 * scene lives in `rv-asset-executors.ts`; the queue/undo machinery in
 * `core/ops/rv-document.ts`.
 *
 * Ops are JSON-safe by construction — CAD geometry is never inlined, only
 * referenced by content hash (`CADLinkExtras.Sha256`) and re-materialised via
 * the `CadGeometryProvider` on draft replay.
 */

import { freshOpId } from '../ops/rv-op-utils';
// Type-only, and the cycle is deliberate: the union imports these PAYLOADS and
// this module imports the origin-filtered VIEW of the union back. One
// vocabulary, described where each half belongs.
import type { RvAssetOp, RvAssetPrimitiveOp } from '../ops/rv-unified-ops';
import type { CadConverter } from '../import/rv-cad-glb-cache';
import type { NodeIdMap } from '../engine/rv-subtree-instantiate';

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
  /**
   * Converter that produced the geometry (plan-561). Absent = 'browser' (every import before
   * plan-561). Browser and CONNECT produce different trees, so the GLB cache keys on it and
   * re-import / re-tessellation stay with the original converter. Web-only field.
   * `'solidcraft'` (plan-621): geometry written by a live CAD link, one body per GLB.
   */
  Converter?: CadConverter;
  /**
   * Live-link identity of a node mirrored from a SolidCraft design (plan-621, optional,
   * additive — readers that do not know it ignore it). Matching uses these ids only,
   * never node names or paths.
   */
  SolidCraft?: CADLinkSolidCraft;
  /**
   * Variant identity of a parametric family's `_Generated` subtree (plan-650, optional,
   * additive). With `Converter: 'parametric'` the cache key is `(InputHash, 'param-v2')`; a
   * cache miss during draft replay regenerates the variant from these fields.
   */
  Parametric?: CADLinkParametric;
}

/** Which family variant an `importCad` of converter `'parametric'` holds (plan-650 Phase 4). */
export interface CADLinkParametric {
  /** Path of the family node relative to the model root (`''` = the model root itself). */
  FamilyPath: string;
  /** Normalized parameter values of the variant. */
  Values: Record<string, number | boolean | string>;
}

/**
 * Which part of a SolidCraft design a node mirrors (plan-621 §2.3). Since plan-649 only the sync ROOT
 * carries it as `CADLink.SolidCraft`; occurrence, body and joint nodes carry the same fields in the hidden
 * `userData.realvirtual.SolidCraftLink` block (documents of the old format are migrated on connect).
 */
export interface CADLinkSolidCraft {
  /** `root` = sync root, `occurrence` = placed component, `body` = one body mesh, `joint` = pivot. */
  Role: 'root' | 'occurrence' | 'body' | 'joint';
  /**
   * Root: path of the `.solidcraft` file. Absent for an unsaved design — such a root is found again only
   * within the same sync session (plan-649: never by its name).
   */
  DesignPath?: string;
  /** Root: design name. */
  DesignName?: string;
  /** Occurrence and body: SolidCraft occurrence id (0 = the root component). */
  OccurrenceId?: number;
  /** Body: identity key (the body's stable SolidCraft feature id, as a string). */
  BodyKey?: string;
  /** Body: display name, used to detect a rename. */
  BodyName?: string;
  /** Joint: SolidCraft joint id. */
  JointId?: number;
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
  /**
   * plan-769 Phase 2 (F10/F11): the ids the imported nodes got, keyed by the decoded
   * CAD node's seeded id (`@<preorder index>` without one); a CADLink re-import
   * pre-fills it with the ids of the matched old nodes. Minted on the FIRST apply and
   * written back here, so redo, draft replay and a remote peer give the same nodes the
   * same ids. Runtime ids only (never persisted, F17); ops recorded before plan-769
   * lack it and mint afresh.
   */
  idMap?: NodeIdMap;
}

/**
 * Swap the GEOMETRY of one mesh node for the single mesh of a cached GLB
 * (plan-621). The node itself — name, transform, material, children, rv_extras
 * components — is untouched; only `mesh.geometry` changes.
 *
 * Geometry by hash, like {@link ImportCadOp}: both directions are addressed in
 * the CAD-GLB cache under `(sha, quality, converter)`, so redo, draft replay
 * AND undo after a save (the trash is flushed, the old geometry object is gone)
 * re-materialise from the cache. That is why `prevSha256` is mandatory: an op
 * whose previous geometry has no key could never be undone across a save.
 *
 * Only the vertices of the GLB's one mesh are used, in that mesh's LOCAL frame;
 * node transforms inside the GLB are ignored.
 */
export interface ReplaceNodeGeometryOp extends AssetOpBase {
  kind: 'replaceNodeGeometry';
  /** A mesh node, or a node whose subtree holds exactly one mesh. */
  nodePath: string;
  /** Other users of the SAME source geometry; one decoded instance for all (plan-663). */
  sharedNodePaths?: string[];
  /** Cache key of the new geometry — SHA-256 of the GLB bytes stored under it. */
  sha256: string;
  /** Cache quality token of BOTH keys (e.g. `'source'`). */
  quality: string;
  /** Cache converter of BOTH keys (e.g. `'solidcraft'`). */
  converter: CadConverter;
  /** Cache key of the geometry the node carried before — the undo payload. */
  prevSha256: string;
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
  /**
   * The authored name (`userData._rvOrigName`) the node carried before the
   * rename; ABSENT — never `undefined` — when it carried none (plan-765 F2).
   * Forward deletes the stamp (the user's name is what a save writes now);
   * undo writes this back. Ops recorded before plan-765 lack it: they replay
   * forward correctly and only lose the stamp restore on undo.
   */
  prevOrigName?: string;
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
  /** plan-769 Phase 2: the created node's id under key `node` — see {@link ImportCadOp.idMap}. */
  idMap?: NodeIdMap;
}

/**
 * Deep-copy a live subtree (plan-641 Phase 3, `editor.clone`): nodes, local
 * transforms, `userData` (rv_extras components included), own geometry and
 * material copies. The copy lands under `parentPath` with the leaf name of
 * `nodePath`, deduped at op CREATION, so draft replay is deterministic. Forward
 * copies the source AS IT STANDS when the op applies — the ops before it in the
 * log have already put it there. Undo detaches the copy to the trash
 * (`clone:<opId>`); redo re-attaches it. Stored references inside the copy that
 * pointed INTO the copied subtree follow the copy; all others keep pointing where
 * the source's did (plan-769 D9 — Unity Ctrl+D).
 */
export interface CloneNodeOp extends AssetOpBase {
  kind: 'cloneNode';
  /** Path of the subtree that is copied. */
  sourcePath: string;
  /** Full path of the copy: `<parentPath>/<dedupedName>` ('' parent = the asset root). */
  nodePath: string;
  /** Sibling insert position under the parent (append when omitted). */
  index?: number;
  /**
   * plan-769 Phase 2 (D9): the copy's ids, keyed by the SOURCE node's identity id
   * (`@<preorder index>` without one) — see {@link ImportCadOp.idMap}.
   */
  idMap?: NodeIdMap;
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
 * A plain JSON record, including an optional embedded color texture, so the
 * material can replay from an IndexedDB draft without an external asset URL.
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
  /** Embedded PNG color map (data URL, sRGB); existing mesh UV coordinates are used. */
  texture?: string;
  /**
   * plan-675: embedded ORM map (data URL, LINEAR): G = roughness, B = metalness —
   * the glTF metallicRoughness layout, so the exporter writes it as one texture.
   * The scalar `roughness` / `metalness` multiply it, as in glTF.
   */
  ormTexture?: string;
  /** plan-675: embedded tangent-space normal map (data URL, LINEAR). */
  normalTexture?: string;
  /**
   * plan-675: the preset this value came from. Persisted in the material's glTF
   * `extras` (`rvMaterialPreset`) so a reloaded GLB rehydrates the preset's maps
   * from its id — texture identities do not survive glTF.
   */
  presetId?: string;
  /**
   * plan-675: texture scale along U. Planar/box UVs (metres): metres per tile.
   * A roller mantle preset (cylindrical UVs, u = revolutions): tiles per revolution.
   * Omitted = 1.
   */
  textureScaleU?: number;
  /** plan-675: texture scale along V — always metres per tile. Omitted = 1. */
  textureScaleV?: number;
  /** plan-675: animated roller mantle — the runtime spins its maps with the conveyor (Phase 3). */
  spin?: 'roller';
}

/**
 * Assign a material to every mesh under each of `nodePaths`.
 *
 * Editor mode loads with `preserveHierarchy: true` — no uber bake, no
 * BatchTable — so every node keeps its own real material and a plain
 * `mesh.material = …` assignment both renders immediately AND survives the GLB
 * export (GLTFExporter serializes the live graph). See contract-bake-picking.md
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
  /**
   * plan-769 Phase 2: the generated parts' ids under keys `part:<i>` (the Group keeps
   * the source mesh's id) — see {@link ImportCadOp.idMap}.
   */
  idMap?: NodeIdMap;
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
  /**
   * plan-769 Phase 2: the non-root outputs' ids under keys `output:<i>` (the root
   * output keeps the root's id) — see {@link ImportCadOp.idMap}.
   */
  idMap?: NodeIdMap;
}

// The composite (transaction) op and the union over these payloads live in
// `core/ops/rv-unified-ops.ts` — `RvCompositeOp`, `RvAssetOp` /
// `RvAssetPrimitiveOp`. There is exactly one union, derived from the origin
// table, so a payload declared here reaches the asset executor by construction.

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

// ─── Structural classification ──────────────────────────────────────────

/**
 * True if applying (or inverting) this op changes what the hierarchy panel
 * shows: nodes added/removed/renamed or component badges changed. Transform
 * and field edits don't move nodes in or out of the tree.
 */
export function assetOpTouchesHierarchy(op: RvAssetOp): boolean {
  if (op.kind === 'composite') return (op.ops as RvAssetPrimitiveOp[]).some(assetOpTouchesHierarchy);
  return op.kind === 'importCad'
    || op.kind === 'deleteNode'
    || op.kind === 'setNodeVisible' // eye-icon state lives on the live node
    || op.kind === 'renameNode'
    || op.kind === 'createNode'
    || op.kind === 'cloneNode'
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
export function classifyAssetOpRaycastImpact(op: RvAssetOp): AssetOpRaycastImpact {
  const impact: AssetOpRaycastImpact = { rebuild: false, refitPaths: [] };
  collectRaycastImpact(op, impact);
  if (impact.rebuild) impact.refitPaths.length = 0; // the rebuild covers them
  return impact;
}

function collectRaycastImpact(op: RvAssetOp, into: AssetOpRaycastImpact): void {
  switch (op.kind) {
    case 'composite':
      for (const child of op.ops) collectRaycastImpact(child as RvAssetPrimitiveOp, into);
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
    // The mesh set stays, but its triangles are new — merged pick geometry
    // baked from the old ones would hit faces that no longer exist.
    case 'replaceNodeGeometry':
      into.rebuild = true;
      return;
    default:
      into.rebuild = true;
  }
}

