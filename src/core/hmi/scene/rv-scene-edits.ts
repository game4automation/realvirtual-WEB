// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-scene-edits — the SCENE-lineage op payloads and their folding helpers.
 *
 * Edits to a Scene are stored as an ordered array of {@link RvOp} records — the
 * ONE op vocabulary (`core/ops/rv-unified-ops.ts`). Each op is immutable,
 * carries its own inverse (`prev`), and can be replayed deterministically on top
 * of the base GLB to materialise the live state (component overrides + planner
 * placements + camera preset).
 *
 * ── What plan-710 removed from this file ────────────────────────────────────
 *
 * Until plan-710 this module also declared a SECOND op union — `EditOp` /
 * `PrimitiveEditOp` / `CompositeOp` — plus its own `canCoalesce` / `mergeOps` /
 * `describeOp`, each a hand-maintained twin of the unified function next to it.
 * Every apply crossed the two vocabularies through an up-/downcast. The names
 * are gone and the twins with them; what stays here is what is genuinely
 * scene-specific: the per-kind PAYLOAD interfaces (which the union imports),
 * `materialise()` and `inverseOp()`.
 *
 * This module is **pure** — no Three.js, no DOM, no localStorage, no plugin
 * references.
 *
 * The actual application of ops to the live scene lives in
 * `rv-scene-executors.ts`; the queue / transaction machinery lives in
 * `core/ops/rv-document.ts`.
 */

import type { RVExtrasOverlay } from '../../engine/rv-extras-overlay-store';
import type { PlacedComponent } from '../../../plugins/layout-planner/rv-layout-store';
import type { ModelCameraStart } from '../camera-startpos-types';
import type { RvConnection, ConnectionType } from '../../engine/rv-connection-registry';
import type {
  RvOp,
  RvPrimitiveOp,
  RvSceneOp,
  RvScenePrimitiveOp,
} from '../../ops/rv-unified-ops';

// ─── Edit operations ────────────────────────────────────────────────────

/**
 * Common header fields on every scene-lineage op payload.
 *
 * Structurally the unified `RvOpHeader`; kept local so this module stays a leaf
 * of the union rather than a cycle through it.
 */
interface SceneOpHeader {
  /** Stable id (`op_<base36-time>_<rand6>`) used for stack identity and coalescing. */
  id: string;
  /** Wall-clock timestamp at the moment the op was created. Display-only. */
  ts: number;
  /** Op-shape version. Bump + add a migrator when a kind's payload changes. */
  schemaV: 1;
  /** Optional: node path that should be selected after forward / before inverse. */
  selectionAfter?: string | null;
  selectionBefore?: string | null;
}

/** Set a single field on `userData.realvirtual[componentType][fieldName]`. */
export interface SetFieldOp extends SceneOpHeader {
  kind: 'setField';
  nodePath: string;
  componentType: string;
  fieldName: string;
  value: unknown;
  /** Original value (deep-cloned for objects/arrays). Used by inverse. */
  prev: unknown;
}

/** Remove a field — restores the GLB-default value via inverse `prev`. */
export interface UnsetFieldOp extends SceneOpHeader {
  kind: 'unsetField';
  nodePath: string;
  componentType: string;
  fieldName: string;
  /** Pre-removal value, restored on undo. */
  prev: unknown;
}

/** Add a planner placement (catalog-spawned object). */
export interface AddPlacementOp extends SceneOpHeader {
  kind: 'addPlacement';
  /** Full placement record. `placement.id` is the stable handle for the
   *  placement throughout subsequent transform / remove ops. */
  placement: PlacedComponent;
}

/** Remove a planner placement by id. Carries the full snapshot for undo. */
export interface RemovePlacementOp extends SceneOpHeader {
  kind: 'removePlacement';
  placementId: string;
  placement: PlacedComponent;
}

/** Move / rotate / scale a placement. */
export interface TransformPlacementOp extends SceneOpHeader {
  kind: 'transformPlacement';
  placementId: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  prev: {
    position: [number, number, number];
    rotation: [number, number, number];
    scale: [number, number, number];
  };
}

// Moving / rotating an EXISTING scene node (e.g. a dragged IK path waypoint) is
// the unified `transformNode` op WITHOUT `scale` — see `RvNodeTransform` in
// `core/ops/rv-unified-ops.ts`. The absent scale is the scene lineage itself:
// GLB nodes may carry mirror scale that must survive, so the scene executor
// writes position and quaternion only and `[1,1,1]` is never substituted. For
// op-created nodes the transform folds into the addNode spec at materialise
// time — this op only reaches the loader for base-GLB nodes.
//
// Before plan-710 the same op existed a second time under the name
// `setNodeTransform`, with `position`/`quaternion` flat on the record. Logs in
// that shape are still readable: `normalizePersistedSceneOp` renames them where
// a persisted log enters the session.

// ─── WebComponent script code (plan-210 JS-in-GLB authoring) ─────────────
//
// The per-node script lives in the scene state as a `WebComponent` component
// override (`overlay.nodes[path].WebComponent.Code`) — the same shape §7 of
// plan-210 defines for `rv_extras`, so the future GLB export (plan-187)
// serialises it without translation. Only `Code` gets a dedicated op kind
// (keystroke coalescing + code-aware history labels); the remaining
// `WebComponent` fields (Active / ApiVersion / Language / DesSafe / TypeId)
// are edited through the existing generic `setField` op.
//
// Persistence: setCode ops ride the existing draft autosave / save pipeline
// (`rv-scene-storage.ts`) unchanged. Quota note: script sources are a few KB
// per node — well within the localStorage budget, and coalescing keeps a
// typing run to ONE op (with one code string) in the history, so no special
// storage mechanism is needed. writeScene/writeDraft already swallow quota
// errors and surface them to the caller.

/** Component-type key of the script component inside `userData.realvirtual`. */
export const WEB_COMPONENT_TYPE = 'WebComponent';
/** Field name of the script source on the WebComponent. */
export const WEB_COMPONENT_CODE_FIELD = 'Code';

/** Set the WebComponent script code on a node. Coalesces per keystroke run. */
export interface SetCodeOp extends SceneOpHeader {
  kind: 'setCode';
  nodePath: string;
  /** New script source. */
  code: string;
  /** Previous source; undefined when the node had no `WebComponent.Code` yet. */
  prev: string | undefined;
}

// ─── Typed connections (plan-259) ─────────────────────────────────────────
//
// Connection edges + user-defined type signatures are top-level rv-ODT data
// (`Connections` block). In the editor they live in the op log via dedicated
// op kinds (modelled on `setCode`): materialise() folds them into flat arrays
// that the ConnectionSystemPlugin applies onto the session registry after the
// base GLB (with its authored connections) has loaded.

/** Add one connection edge. Inverse: removeConnection. */
export interface AddConnectionOp extends SceneOpHeader {
  kind: 'addConnection';
  connection: RvConnection;
}

/** Remove one connection edge (full snapshot carried for undo). */
export interface RemoveConnectionOp extends SceneOpHeader {
  kind: 'removeConnection';
  connectionId: string;
  connection: RvConnection;
}

/** Add or replace a user-defined connection type signature. */
export interface SetConnectionTypeOp extends SceneOpHeader {
  kind: 'setConnectionType';
  connectionType: ConnectionType;
  /** Previous signature of the same type name (undefined = newly created). */
  prev: ConnectionType | undefined;
}

/** Remove a user-defined connection type signature (edges of the type stay). */
export interface RemoveConnectionTypeOp extends SceneOpHeader {
  kind: 'removeConnectionType';
  /** Full snapshot for undo. */
  connectionType: ConnectionType;
}

/** Set or clear the per-scene camera start preset. */
export interface SetCameraOp extends SceneOpHeader {
  kind: 'setCamera';
  preset: ModelCameraStart | null;
  prev: ModelCameraStart | null;
}

/** Describes a node to create at runtime (op-log `addNode`). Factory-based
 *  components only (e.g. IKTarget) — Drive/signals are not constructed here. */
export interface NodeSpec {
  parentPath: string;
  name: string;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
  /** userData.realvirtual content: { ComponentType: { field: value, … } }. */
  components: Record<string, Record<string, unknown>>;
}

/** Create a new node (e.g. an inserted IK path waypoint) under an existing parent. */
export interface AddNodeOp extends SceneOpHeader {
  kind: 'addNode';
  /** Resulting full path of the new node (parentPath + '/' + name). */
  nodePath: string;
  spec: NodeSpec;
}

/** Remove a node created by an `addNode` op (inverse / delete of an added node).
 *  Carries the full spec so undo can re-create it. Removal only affects nodes
 *  marked as op-created — original GLB nodes are unaffected. */
export interface RemoveNodeOp extends SceneOpHeader {
  kind: 'removeNode';
  nodePath: string;
  spec: NodeSpec;
}

// The composite (transaction) op and the union over these payloads live in
// `core/ops/rv-unified-ops.ts` — `RvCompositeOp`, `RvSceneOp` /
// `RvScenePrimitiveOp`. There is exactly one union, derived from the origin
// table, so a payload declared here reaches the scene executor by construction.

// ─── Container types ────────────────────────────────────────────────────

/** Workspace-level settings that aren't part of the undoable history. */
export interface SceneEditsSettings {
  catalogUrls: string[];
  gridSizeMm: number;
}

/** What `RvScene.edits` becomes (added in PR C; PR A only ships the type). */
export interface SceneEdits {
  ops: RvOp[];
  settings: SceneEditsSettings;
}

/** A node to create after the base GLB loads (op-log `addNode`). */
export interface AddedNode {
  nodePath: string;
  spec: NodeSpec;
}

/** A persisted local transform for a base-GLB node (op-log `transformNode`).
 *  Op-created nodes never appear here — their transform folds into the spec. */
export interface NodeTransformEntry {
  nodePath: string;
  position: [number, number, number];
  quaternion: [number, number, number, number];
}

/** The shape `materialise()` produces — fed into `loadGLB` and `applyPlacements`. */
export interface MaterialisedEdits {
  overlay: RVExtrasOverlay;
  placements: PlacedComponent[];
  cameraStart: ModelCameraStart | null;
  addedNodes: AddedNode[];
  nodeTransforms: NodeTransformEntry[];
  /** Edit-op connection edges (plan-259) — applied ADDITIVELY on top of the
   *  GLB-authored `Connections` block by the ConnectionSystemPlugin. */
  connections: RvConnection[];
  /** Edit-op user-defined connection type signatures (plan-259). */
  connectionTypes: ConnectionType[];
}

// ─── Constants + identity (shared with the asset editor's op log) ────────
//
// Extracted to `src/core/ops/rv-op-utils.ts` and re-exported here unchanged
// so existing imports keep working. The asset editor imports them from
// rv-op-utils directly (it must not depend on scene types).

export { MAX_OP_HISTORY, COALESCE_WINDOW_MS, freshOpId, deepCloneJSON } from '../../ops/rv-op-utils';
import { freshOpId, deepCloneJSON } from '../../ops/rv-op-utils';

// ─── Materialise (replay ops onto an empty workspace) ───────────────────

/**
 * Fold an op array into the materialised edit state — the shape the existing
 * loader pipeline already consumes (overlay → loadGLB, placements → planner,
 * camera → camera-startpos plugin).
 *
 * Pure function: no mutations, no async, no side effects. The result is
 * fully derived from `ops` (and only `ops`); replaying the same array
 * produces a structurally-equal output every time — the determinism property
 * the plan relies on for save/load round-trips.
 *
 * Composite ops are flattened recursively in apply order. Removal ops cancel
 * their corresponding adds. Transform ops update the live position/rotation/scale.
 */
export function materialise(ops: ReadonlyArray<RvOp>): MaterialisedEdits {
  const overlay: RVExtrasOverlay = emptyOverlay();
  const placements = new Map<string, PlacedComponent>();
  const addedNodes = new Map<string, AddedNode>();
  const nodeTransforms = new Map<string, NodeTransformEntry>();
  const connections = new Map<string, RvConnection>();
  const connectionTypes = new Map<string, ConnectionType>();
  let cameraStart: ModelCameraStart | null = null;

  for (const op of flattenOps(ops)) {
    applyForwardPure(op, overlay, placements, addedNodes, nodeTransforms, connections, connectionTypes, (next) => { cameraStart = next; });
  }

  // Fold any field overrides that target an added node INTO its spec, and drop
  // them from the overlay (the node doesn't exist during loadGLB traversal, so
  // the overlay can't apply them — createRuntimeNode reads them from the spec).
  for (const added of addedNodes.values()) {
    const nodeOv = overlay.nodes[added.nodePath];
    if (!nodeOv) continue;
    for (const [comp, fields] of Object.entries(nodeOv)) {
      const target = (added.spec.components[comp] ??= {});
      Object.assign(target, fields);
    }
    delete overlay.nodes[added.nodePath];
  }

  return {
    overlay,
    placements: [...placements.values()],
    cameraStart,
    addedNodes: [...addedNodes.values()],
    nodeTransforms: [...nodeTransforms.values()],
    connections: [...connections.values()],
    connectionTypes: [...connectionTypes.values()],
  };
}

function flattenOps(ops: ReadonlyArray<RvOp>): RvPrimitiveOp[] {
  const out: RvPrimitiveOp[] = [];
  for (const op of ops) {
    if (op.kind === 'composite') out.push(...op.ops);
    else out.push(op);
  }
  return out;
}

/**
 * Pure-data forward apply for a single primitive op against working buffers.
 *
 * Takes the WHOLE primitive union, not just the scene subset: a persisted log is
 * data, and a document that ever mixed lineages must fold rather than throw. The
 * `default` branch is that tolerance, stated once.
 */
function applyForwardPure(
  op: RvPrimitiveOp,
  overlay: RVExtrasOverlay,
  placements: Map<string, PlacedComponent>,
  addedNodes: Map<string, AddedNode>,
  nodeTransforms: Map<string, NodeTransformEntry>,
  connections: Map<string, RvConnection>,
  connectionTypes: Map<string, ConnectionType>,
  setCamera: (next: ModelCameraStart | null) => void,
): void {
  switch (op.kind) {
    case 'addConnection': {
      connections.set(op.connection.id, deepCloneJSON(op.connection));
      return;
    }
    case 'removeConnection': {
      connections.delete(op.connectionId);
      return;
    }
    case 'setConnectionType': {
      connectionTypes.set(op.connectionType.type, deepCloneJSON(op.connectionType));
      return;
    }
    case 'removeConnectionType': {
      connectionTypes.delete(op.connectionType.type);
      return;
    }
    case 'addNode': {
      addedNodes.set(op.nodePath, { nodePath: op.nodePath, spec: deepCloneJSON(op.spec) });
      return;
    }
    case 'removeNode': {
      addedNodes.delete(op.nodePath);
      nodeTransforms.delete(op.nodePath);
      return;
    }
    case 'transformNode': {
      // Op-created node: fold the transform straight into its creation spec
      // (the node doesn't exist during loadGLB, so the loader-side transform
      // pass could never find it). Base-GLB node: last-write-wins entry.
      //
      // `scale` is read by neither branch, and that is the scene lineage, not an
      // oversight: `NodeTransformEntry` has no scale field because the base GLB
      // owns it. An asset-lineage transform that reached here would fold its
      // position and rotation and leave the mirror scale alone — the same
      // tolerance the executor applies.
      const added = addedNodes.get(op.nodePath);
      if (added) {
        added.spec.position = [...op.transform.position];
        added.spec.quaternion = [...op.transform.quaternion];
        return;
      }
      nodeTransforms.set(op.nodePath, {
        nodePath: op.nodePath,
        position: [...op.transform.position],
        quaternion: [...op.transform.quaternion],
      });
      return;
    }
    case 'setField': {
      ensureNode(overlay, op.nodePath);
      ensureComponent(overlay, op.nodePath, op.componentType);
      overlay.nodes[op.nodePath][op.componentType][op.fieldName] = op.value;
      return;
    }
    case 'unsetField': {
      const nodeOv = overlay.nodes[op.nodePath];
      const compOv = nodeOv?.[op.componentType];
      if (!compOv) return;
      delete compOv[op.fieldName];
      if (Object.keys(compOv).length === 0) delete nodeOv[op.componentType];
      if (Object.keys(nodeOv).length === 0) delete overlay.nodes[op.nodePath];
      return;
    }
    case 'addPlacement': {
      placements.set(op.placement.id, deepCloneJSON(op.placement));
      return;
    }
    case 'removePlacement': {
      placements.delete(op.placementId);
      return;
    }
    case 'transformPlacement': {
      const p = placements.get(op.placementId);
      if (!p) return; // tolerate — base GLB may have changed
      placements.set(op.placementId, {
        ...p,
        position: [...op.position] as [number, number, number],
        rotation: [...op.rotation] as [number, number, number],
        scale: [...op.scale] as [number, number, number],
      });
      return;
    }
    case 'setCamera': {
      setCamera(op.preset ? { ...op.preset } : null);
      return;
    }
    case 'setCode': {
      ensureNode(overlay, op.nodePath);
      ensureComponent(overlay, op.nodePath, WEB_COMPONENT_TYPE);
      overlay.nodes[op.nodePath][WEB_COMPONENT_TYPE][WEB_COMPONENT_CODE_FIELD] = op.code;
      return;
    }
    default:
      // Asset-lineage kind in a scene log — nothing to fold, and refusing would
      // make a stale record unloadable rather than merely inert.
      return;
  }
}

function emptyOverlay(): RVExtrasOverlay {
  return { $schema: 'rv-extras-overlay/1.0', $source: 'edits', nodes: {} };
}

function ensureNode(overlay: RVExtrasOverlay, nodePath: string): void {
  if (!overlay.nodes[nodePath]) overlay.nodes[nodePath] = {};
}

function ensureComponent(overlay: RVExtrasOverlay, nodePath: string, componentType: string): void {
  if (!overlay.nodes[nodePath][componentType]) overlay.nodes[nodePath][componentType] = {};
}

// ─── Inverse helpers (used by executors and tests) ──────────────────────

/**
 * Compute the inverse op for a primitive forward op. The inverse is the
 * single op that, when applied forward, restores the state that existed
 * BEFORE the original op. Composite inverse = reverse the children and
 * invert each.
 *
 * Note: the executor doesn't necessarily call this — it applies the inverse
 * directly via the `prev` field of the original op. This helper is exposed
 * for tests and for any future code that wants an "inverse op" record.
 *
 * SCENE lineage only, and deliberately typed that way: the asset lineage never
 * had a counterpart (its executor inverts from `prev` directly), so widening the
 * signature to `RvOp` would promise an inverse this function cannot produce.
 */
export function inverseOp(op: RvSceneOp): RvSceneOp {
  switch (op.kind) {
    case 'setField': {
      // Inverse: setField with prev value (or unsetField if prev was undefined)
      if (op.prev === undefined) {
        return {
          id: freshOpId(), ts: Date.now(), schemaV: 1,
          kind: 'unsetField',
          nodePath: op.nodePath, componentType: op.componentType, fieldName: op.fieldName,
          prev: op.value,
        };
      }
      return {
        id: freshOpId(), ts: Date.now(), schemaV: 1,
        kind: 'setField',
        nodePath: op.nodePath, componentType: op.componentType, fieldName: op.fieldName,
        value: op.prev, prev: op.value,
      };
    }
    case 'unsetField': {
      return {
        id: freshOpId(), ts: Date.now(), schemaV: 1,
        kind: 'setField',
        nodePath: op.nodePath, componentType: op.componentType, fieldName: op.fieldName,
        value: op.prev, prev: undefined,
      };
    }
    case 'addPlacement': {
      return {
        id: freshOpId(), ts: Date.now(), schemaV: 1,
        kind: 'removePlacement',
        placementId: op.placement.id, placement: op.placement,
      };
    }
    case 'removePlacement': {
      return {
        id: freshOpId(), ts: Date.now(), schemaV: 1,
        kind: 'addPlacement', placement: op.placement,
      };
    }
    case 'transformPlacement': {
      return {
        id: freshOpId(), ts: Date.now(), schemaV: 1,
        kind: 'transformPlacement',
        placementId: op.placementId,
        position: op.prev.position, rotation: op.prev.rotation, scale: op.prev.scale,
        prev: { position: op.position, rotation: op.rotation, scale: op.scale },
      };
    }
    case 'transformNode': {
      // Swap forward and prev WITHOUT normalising either side: whatever the
      // original carried for `scale` (present or absent) is what its inverse
      // must carry, or an undo would change the lineage of the op it reverses.
      return {
        id: freshOpId(), ts: Date.now(), schemaV: 1,
        kind: 'transformNode',
        nodePath: op.nodePath,
        transform: op.prev,
        prev: op.transform,
      };
    }
    case 'setCamera': {
      return {
        id: freshOpId(), ts: Date.now(), schemaV: 1,
        kind: 'setCamera',
        preset: op.prev, prev: op.preset,
      };
    }
    case 'setCode': {
      // Inverse: restore the previous code — or, when the node had no
      // WebComponent.Code before, unset the field (mirrors setField's inverse).
      if (op.prev === undefined) {
        return {
          id: freshOpId(), ts: Date.now(), schemaV: 1,
          kind: 'unsetField',
          nodePath: op.nodePath,
          componentType: WEB_COMPONENT_TYPE, fieldName: WEB_COMPONENT_CODE_FIELD,
          prev: op.code,
        };
      }
      return {
        id: freshOpId(), ts: Date.now(), schemaV: 1,
        kind: 'setCode',
        nodePath: op.nodePath, code: op.prev, prev: op.code,
      };
    }
    case 'addNode': {
      return { id: freshOpId(), ts: Date.now(), schemaV: 1, kind: 'removeNode', nodePath: op.nodePath, spec: op.spec };
    }
    case 'removeNode': {
      return { id: freshOpId(), ts: Date.now(), schemaV: 1, kind: 'addNode', nodePath: op.nodePath, spec: op.spec };
    }
    case 'addConnection': {
      return {
        id: freshOpId(), ts: Date.now(), schemaV: 1,
        kind: 'removeConnection',
        connectionId: op.connection.id, connection: op.connection,
      };
    }
    case 'removeConnection': {
      return { id: freshOpId(), ts: Date.now(), schemaV: 1, kind: 'addConnection', connection: op.connection };
    }
    case 'setConnectionType': {
      if (op.prev === undefined) {
        return {
          id: freshOpId(), ts: Date.now(), schemaV: 1,
          kind: 'removeConnectionType', connectionType: op.connectionType,
        };
      }
      return {
        id: freshOpId(), ts: Date.now(), schemaV: 1,
        kind: 'setConnectionType', connectionType: op.prev, prev: op.connectionType,
      };
    }
    case 'removeConnectionType': {
      return {
        id: freshOpId(), ts: Date.now(), schemaV: 1,
        kind: 'setConnectionType', connectionType: op.connectionType, prev: undefined,
      };
    }
    case 'composite': {
      const reversed: RvScenePrimitiveOp[] = [];
      for (let i = op.ops.length - 1; i >= 0; i--) {
        const inv = inverseOp(op.ops[i] as RvScenePrimitiveOp);
        if (inv.kind === 'composite') {
          // Defensive — composites don't nest. Flatten.
          reversed.push(...(inv.ops as RvScenePrimitiveOp[]));
        } else {
          reversed.push(inv);
        }
      }
      return {
        id: freshOpId(), ts: Date.now(), schemaV: 1,
        kind: 'composite', label: `Undo: ${op.label}`, ops: reversed,
      };
    }
  }
}

// ─── Equality (for dirty + tests) ───────────────────────────────────────

/** Compare two op arrays by id sequence. Op records are immutable — id
 *  equality implies content equality. */
export function opsEqual(a: ReadonlyArray<RvOp>, b: ReadonlyArray<RvOp>): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].id !== b[i].id) return false;
  return true;
}

