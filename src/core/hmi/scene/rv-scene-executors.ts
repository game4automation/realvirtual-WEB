// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-scene-executors — Apply SCENE-lineage ops to the live RVViewer scene.
 *
 * For every kind in `RvScenePrimitiveOp` (the origin-filtered view of the ONE
 * op union — `core/ops/rv-unified-ops.ts`), this module provides:
 *   - applyForward(op):  mutate the live scene to reflect the op
 *   - applyInverse(op):  reverse the op using its `prev` payload
 *
 * Composite ops fan out to their primitives (forward in order, inverse in
 * reverse). All execution paths are wrapped in try/catch — a failed op never
 * throws across the SceneStore boundary, only logs a warning. This is what
 * lets a saved scene whose base GLB later changed (some node went missing)
 * still load: stale ops are skipped, the rest replay cleanly.
 *
 * The executors are async: `addPlacement` may need to load a GLB. The
 * SceneStore op queue is single-flight, so two ops never run concurrently.
 */

import type { Object3D } from 'three';
import { isUnsafeObjectKey, ownValue } from '../../engine/rv-safe-keys';
import type { RVViewer } from '../../rv-viewer';
import type { LayoutPlannerPlugin } from '../../../plugins/layout-planner';
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
} from './rv-scene-edits';
import type {
  RvSceneOp,
  RvScenePrimitiveOp,
  RvTransformNodeOp,
} from '../../ops/rv-unified-ops';
import { WEB_COMPONENT_TYPE, WEB_COMPONENT_CODE_FIELD } from './rv-scene-edits';
import { getConnectionSystem } from '../../engine/rv-connection-registry';
import { saveStartPos, clearStartPos } from '../camera-startpos-store';
import { deriveModelKey } from '../../../plugins/camera-startpos-plugin';
import { applySchema, getRegisteredFactories, resolveComponentRefs } from '../../engine/rv-component-registry';
import type { NodeRegistry } from '../../engine/rv-node-registry';
import { applyLocalPose, refreshWorldMatricesDeep } from '../../engine/rv-node-transform';
import { removeAuthoredSubtree } from '../../engine/rv-scene-loader';
import { mintFromIdMap } from '../../engine/rv-subtree-instantiate';
import { identityIdOf } from '../../engine/rv-decode-identity';
import { addressedReferenceValue } from '../../engine/rv-reference-writer';
import { reportReferenceTargetUnsaved } from '../problems-store';
import type { SignalMapping } from '../../../plugins/layout-planner/rv-layout-store';
import { syncNodeSignalBindingPersistence } from '../../../plugins/signal-bind/signal-binding-persistence';
import {
  beginSignalSyncWave, endSignalSyncWave, syncSignalSubtree,
} from '../../engine/rv-signal-editor-sync';
import { PARAMETRIC_COMPONENT_TYPE, emitParametricValuesChanged } from '../../engine/rv-parametric-component';

export interface ExecutorContext {
  viewer: RVViewer;
}

// ─── Public entry points ────────────────────────────────────────────────

/**
 * plan-589: every signal (re-)registration an op causes — a composite's
 * children included — is ONE catalog wave, i.e. one `onCatalogChanged`. Mirrors
 * `AssetExecutorContext.applyForward`; the wave nests, so the recursive
 * composite calls below fold into the outermost one.
 */
export async function applyForward(op: RvSceneOp, ctx: ExecutorContext): Promise<void> {
  beginSignalSyncWave(ctx.viewer.signalStore);
  try {
    await applyForwardInWave(op, ctx);
  } finally {
    endSignalSyncWave(ctx.viewer.signalStore);
  }
}

async function applyForwardInWave(op: RvSceneOp, ctx: ExecutorContext): Promise<void> {
  if (op.kind === 'composite') {
    // The cast is the composite's one soft spot, and it is deliberate:
    // `RvCompositeOp.ops` is not origin-restricted (see the constructor helpers
    // in `rv-unified-ops.ts`). A stray asset-lineage child lands in the
    // primitive switch's `default`, which is a documented no-op, not a crash.
    for (const child of op.ops) await applyForwardInWave(child as RvScenePrimitiveOp, ctx);
    return;
  }
  try {
    await applyPrimitiveForward(op, ctx);
  } catch (e) {
    console.warn(`[scene-edits] forward apply failed for ${op.kind} (op ${op.id}):`, e);
  }
}

export async function applyInverse(op: RvSceneOp, ctx: ExecutorContext): Promise<void> {
  beginSignalSyncWave(ctx.viewer.signalStore);
  try {
    await applyInverseInWave(op, ctx);
  } finally {
    endSignalSyncWave(ctx.viewer.signalStore);
  }
}

async function applyInverseInWave(op: RvSceneOp, ctx: ExecutorContext): Promise<void> {
  if (op.kind === 'composite') {
    for (let i = op.ops.length - 1; i >= 0; i--) {
      await applyInverseInWave(op.ops[i] as RvScenePrimitiveOp, ctx);
    }
    return;
  }
  try {
    await applyPrimitiveInverse(op, ctx);
  } catch (e) {
    console.warn(`[scene-edits] inverse apply failed for ${op.kind} (op ${op.id}):`, e);
  }
}

async function applyPrimitiveForward(op: RvScenePrimitiveOp, ctx: ExecutorContext): Promise<void> {
  switch (op.kind) {
    case 'setField':           return setFieldForward(op, ctx);
    case 'unsetField':         return unsetFieldForward(op, ctx);
    case 'addPlacement':       return addPlacementForward(op, ctx);
    case 'removePlacement':    return removePlacementForward(op, ctx);
    case 'transformPlacement': return transformPlacementForward(op, ctx);
    case 'transformNode':      return transformNodeForward(op, ctx);
    case 'setCamera':          return setCameraForward(op, ctx);
    case 'setCode':            return setCodeForward(op, ctx);
    case 'addNode':            return addNodeForward(op, ctx);
    case 'removeNode':         return removeNodeForward(op, ctx);
    case 'addConnection':      return addConnectionForward(op);
    case 'removeConnection':   return removeConnectionForward(op);
    case 'setConnectionType':  return setConnectionTypeForward(op);
    case 'removeConnectionType': return removeConnectionTypeForward(op);
  }
}

async function applyPrimitiveInverse(op: RvScenePrimitiveOp, ctx: ExecutorContext): Promise<void> {
  switch (op.kind) {
    case 'setField':           return setFieldInverse(op, ctx);
    case 'unsetField':         return unsetFieldInverse(op, ctx);
    case 'addPlacement':       return addPlacementInverse(op, ctx);
    case 'removePlacement':    return removePlacementInverse(op, ctx);
    case 'transformPlacement': return transformPlacementInverse(op, ctx);
    case 'transformNode':      return transformNodeInverse(op, ctx);
    case 'setCamera':          return setCameraInverse(op, ctx);
    case 'setCode':            return setCodeInverse(op, ctx);
    case 'addNode':            return addNodeInverse(op, ctx);
    case 'removeNode':         return removeNodeInverse(op, ctx);
    case 'addConnection':      return addConnectionInverse(op);
    case 'removeConnection':   return removeConnectionInverse(op);
    case 'setConnectionType':  return setConnectionTypeInverse(op);
    case 'removeConnectionType': return removeConnectionTypeInverse(op);
  }
}

// ─── Typed connections (plan-259) ────────────────────────────────────────
// Live application goes straight to the session connection registry; the
// persistence side is handled by materialise() folding the same ops.

function addConnectionForward(op: AddConnectionOp): void {
  getConnectionSystem().addConnection(op.connection);
}

function addConnectionInverse(op: AddConnectionOp): void {
  getConnectionSystem().removeConnection(op.connection.id);
}

function removeConnectionForward(op: RemoveConnectionOp): void {
  getConnectionSystem().removeConnection(op.connectionId);
}

function removeConnectionInverse(op: RemoveConnectionOp): void {
  getConnectionSystem().addConnection(op.connection);
}

function setConnectionTypeForward(op: SetConnectionTypeOp): void {
  getConnectionSystem().setConnectionType(op.connectionType);
}

function setConnectionTypeInverse(op: SetConnectionTypeOp): void {
  if (op.prev === undefined) getConnectionSystem().removeConnectionType(op.connectionType.type);
  else getConnectionSystem().setConnectionType(op.prev);
}

function removeConnectionTypeForward(op: RemoveConnectionTypeOp): void {
  getConnectionSystem().removeConnectionType(op.connectionType.type);
}

function removeConnectionTypeInverse(op: RemoveConnectionTypeOp): void {
  getConnectionSystem().setConnectionType(op.connectionType);
}

// ─── addNode / removeNode ───────────────────────────────────────────────

/**
 * plan-769 Phase 2 (F11): the id of the node an `addNode` creates / a `removeNode`
 * re-creates on undo — `op.idMap.node`, minted on the first apply and written back
 * onto the op (the store records it after the apply), so undo/redo, a reloaded op
 * log and a remote peer give the node the SAME id. Runtime only (F17).
 */
function opNodeId(op: AddNodeOp | RemoveNodeOp): string {
  if (!op.idMap || typeof op.idMap !== 'object') op.idMap = {};
  return mintFromIdMap(op.idMap, 'node');
}

function addNodeForward(op: AddNodeOp, ctx: ExecutorContext): void {
  ctx.viewer.createComponentNode(op.spec, opNodeId(op));
  syncSignalsAt(ctx, op.nodePath);
  ctx.viewer.rebuildIKPaths?.();
  ctx.viewer.markRenderDirty?.();
}

function addNodeInverse(op: AddNodeOp, ctx: ExecutorContext): void {
  removeNodeAndReleaseSignals(ctx, op.nodePath);
  ctx.viewer.rebuildIKPaths?.();
  ctx.viewer.markRenderDirty?.();
}

function removeNodeForward(op: RemoveNodeOp, ctx: ExecutorContext): void {
  // Remember the identity the node had, so undo re-creates THAT node (refs by
  // address to it resolve again) — unless the op already carries it.
  if (!op.idMap?.node) {
    const live = ctx.viewer.registry?.getNode(op.nodePath) ?? null;
    const id = live ? identityIdOf(live) : null;
    if (id) op.idMap = { ...(op.idMap ?? {}), node: id };
  }
  if (op.authored === true) removeAuthoredNodeAndReleaseSignals(ctx, op.nodePath);
  else removeNodeAndReleaseSignals(ctx, op.nodePath);
  ctx.viewer.rebuildIKPaths?.();
  ctx.viewer.markRenderDirty?.();
}

function removeNodeInverse(op: RemoveNodeOp, ctx: ExecutorContext): void {
  ctx.viewer.createComponentNode(op.spec, opNodeId(op));
  if (op.authored === true) {
    // plan-628 8.7: the restored node is the AUTHORED node again, not an
    // op-created one — a later delete must be persisted as an authored removal.
    const node = ctx.viewer.registry?.getNode(op.nodePath);
    if (node) delete node.userData.__rvAdded;
  }
  syncSignalsAt(ctx, op.nodePath);
  ctx.viewer.rebuildIKPaths?.();
  ctx.viewer.markRenderDirty?.();
}

// ─── Signal sync for the scene lineage (plan-589) ───────────────────────
//
// The ASSET lineage syncs inside `AssetExecutorContext`; the SCENE lineage
// mutates placement CONTENT and went past the SignalStore entirely (measured in
// `signal-placement-ist.node.test.ts`). These two helpers close that gap. A
// failure never rejects the op — the scene mutation has already landed.

/** Re-sync the signals of the subtree at `nodePath` (no-op when it is gone). */
function syncSignalsAt(ctx: ExecutorContext, nodePath: string): void {
  const node = ctx.viewer.registry?.getNode(nodePath);
  if (!node) return;
  try {
    syncSignalSubtree(ctx.viewer, node);
  } catch (e) {
    console.warn(`[scene-edits] signal sync failed for ${nodePath}:`, e);
  }
}

/**
 * Remove a component node AND release its signals. The node object must be
 * captured BEFORE the removal: afterwards the registry no longer knows the
 * path, and the sync derives "not live" from exactly that — it still needs the
 * object to find the snapshot (identity = node, not path).
 */
function removeNodeAndReleaseSignals(ctx: ExecutorContext, nodePath: string): void {
  const node = ctx.viewer.registry?.getNode(nodePath) ?? null;
  ctx.viewer.removeComponentNode(nodePath);
  if (!node) return;
  try {
    syncSignalSubtree(ctx.viewer, node);
  } catch (e) {
    console.warn(`[scene-edits] signal release failed for ${nodePath}:`, e);
  }
}

/**
 * plan-628 8.7: the authored twin of {@link removeNodeAndReleaseSignals}. The
 * eligibility rule lives in the core (`isAuthoredRemovalEligible`); an
 * ineligible target stays untouched — the protection of every other authored
 * node is unchanged.
 */
function removeAuthoredNodeAndReleaseSignals(ctx: ExecutorContext, nodePath: string): void {
  const registry = ctx.viewer.registry;
  const node = registry?.getNode(nodePath) ?? null;
  if (!registry || !node) return;
  if (!removeAuthoredSubtree(registry, nodePath)) {
    console.warn(`[scene-edits] authored removeNode refused for ${nodePath}: not an eligible path-network node`);
    return;
  }
  try {
    syncSignalSubtree(ctx.viewer, node);
  } catch (e) {
    console.warn(`[scene-edits] signal release failed for ${nodePath}:`, e);
  }
}

// ─── transformNode ──────────────────────────────────────────────────────
//
// `transform.scale` is read by NEITHER function, and that is the whole scene
// lineage in one sentence: the base GLB owns scale, and a Unity-exported mirror
// node (`IKTarget` ships `(-1,1,1)`) must survive every move and every undo.
// `applyLocalPose` writes position and quaternion only.
//
// Routing keeps scale-bearing transforms away from here in the first place
// (`resolveOpTarget` decides by payload, not by mode), so this is a second line
// of defence rather than the only one.

function transformNodeForward(op: RvTransformNodeOp, ctx: ExecutorContext): void {
  const node = ctx.viewer.registry?.getNode(op.nodePath);
  if (!node) return; // tolerate — base GLB may have changed
  applyLocalPose(node, op.transform.position, op.transform.quaternion);
  // Baked placement content is matrix-frozen: recompose the whole subtree, as the gizmo does.
  refreshWorldMatricesDeep(node);
  ctx.viewer.markRenderDirty?.();
}

function transformNodeInverse(op: RvTransformNodeOp, ctx: ExecutorContext): void {
  const node = ctx.viewer.registry?.getNode(op.nodePath);
  if (!node) return;
  applyLocalPose(node, op.prev.position, op.prev.quaternion);
  refreshWorldMatricesDeep(node);
  ctx.viewer.markRenderDirty?.();
}

// ─── setField / unsetField ──────────────────────────────────────────────

function setFieldForward(op: SetFieldOp, ctx: ExecutorContext): void {
  // plan-769 Phase 3b: a ComponentReference the writer can pin is stored as its
  // ADDRESS — and written back onto the op (recorded after the apply, the Phase-2
  // idMap pattern), so the draft and the overlay the planner save bakes carry it too.
  const registry = ctx.viewer.registry;
  const owner = registry?.getNode(op.nodePath) ?? null;
  if (registry && owner) {
    const addressed = addressedReferenceValue(registry, owner, op.componentType, op.fieldName, op.value, {
      // F21: a reference into another document's not-yet-saved id is visible now.
      onUnsavedTarget: (t) => reportReferenceTargetUnsaved({
        referrerPath: op.nodePath, address: t.address,
        targetPath: registry.getPathForNode(t.target) ?? t.target.name,
        documentName: t.documentRoot?.name ?? 'the referenced document',
      }),
    });
    if (addressed !== op.value) (op as { value: unknown }).value = addressed;
  }
  writeUserDataField(ctx.viewer, op.nodePath, op.componentType, op.fieldName, op.value);
  reapplySchemaForComponent(ctx.viewer, op.nodePath, op.componentType);
  syncSignalLinksRuntime(ctx.viewer, op.nodePath, op.componentType, op.fieldName, op.value);
  syncSignalsAt(ctx, op.nodePath);
  notifyParametricValues(ctx.viewer, op);
  ctx.viewer.markRenderDirty?.();
}

function setFieldInverse(op: SetFieldOp, ctx: ExecutorContext): void {
  // Inverse of setField: restore prev. If prev was undefined the field was
  // never set on the original GLB — delete the override entirely.
  if (op.prev === undefined) {
    deleteUserDataField(ctx.viewer, op.nodePath, op.componentType, op.fieldName);
  } else {
    writeUserDataField(ctx.viewer, op.nodePath, op.componentType, op.fieldName, op.prev);
  }
  reapplySchemaForComponent(ctx.viewer, op.nodePath, op.componentType);
  syncSignalLinksRuntime(ctx.viewer, op.nodePath, op.componentType, op.fieldName, op.prev);
  syncSignalsAt(ctx, op.nodePath);
  notifyParametricValues(ctx.viewer, op);
  ctx.viewer.markRenderDirty?.();
}

function unsetFieldForward(op: UnsetFieldOp, ctx: ExecutorContext): void {
  deleteUserDataField(ctx.viewer, op.nodePath, op.componentType, op.fieldName);
  reapplySchemaForComponent(ctx.viewer, op.nodePath, op.componentType);
  syncSignalLinksRuntime(ctx.viewer, op.nodePath, op.componentType, op.fieldName, undefined);
  syncSignalsAt(ctx, op.nodePath);
  notifyParametricValues(ctx.viewer, op);
  ctx.viewer.markRenderDirty?.();
}

function unsetFieldInverse(op: UnsetFieldOp, ctx: ExecutorContext): void {
  // Inverse of unset: restore the prev value.
  writeUserDataField(ctx.viewer, op.nodePath, op.componentType, op.fieldName, op.prev);
  reapplySchemaForComponent(ctx.viewer, op.nodePath, op.componentType);
  syncSignalLinksRuntime(ctx.viewer, op.nodePath, op.componentType, op.fieldName, op.prev);
  syncSignalsAt(ctx, op.nodePath);
  notifyParametricValues(ctx.viewer, op);
  ctx.viewer.markRenderDirty?.();
}

/**
 * plan-650 Phase 5: a write to `ParametricComponent.Values` (do, undo or redo)
 * re-materialises the placement that holds the family — the listener lives in
 * the lazily loaded placement module and is absent until it ran once.
 */
function notifyParametricValues(viewer: RVViewer, op: { nodePath: string; componentType: string; fieldName: string }): void {
  if (op.componentType !== PARAMETRIC_COMPONENT_TYPE || op.fieldName !== 'Values') return;
  emitParametricValuesChanged(viewer, op.nodePath);
}

function syncSignalLinksRuntime(
  viewer: RVViewer,
  nodePath: string,
  componentType: string,
  fieldName: string,
  value: unknown,
): void {
  if (componentType !== 'SignalLinks' || fieldName !== 'Mappings') return;
  const node = viewer.registry?.getNode(nodePath);
  if (!node) return;
  const mappings = Array.isArray(value) ? value as SignalMapping[] : [];
  syncNodeSignalBindingPersistence(node, mappings);
  if (mappings.length > 0) {
    viewer.signalBindingManager?.applyMappings(nodePath, node, mappings);
  } else {
    viewer.signalBindingManager?.unbindAll(nodePath);
  }
}

/** Exported for the asset editor's executors (same clone-on-write semantics). */
export function writeUserDataField(
  viewer: RVViewer, nodePath: string, componentType: string, fieldName: string, value: unknown,
): void {
  const node = viewer.registry?.getNode(nodePath);
  if (!node || isUnsafeObjectKey(componentType) || isUnsafeObjectKey(fieldName)) return;
  const ud = node.userData as Record<string, unknown>;
  let rv = ud['realvirtual'] as Record<string, Record<string, unknown>> | undefined;
  if (!rv) { rv = {}; ud['realvirtual'] = rv; }
  // Replace the component object with a shallow clone (new identity) so the
  // property inspector — which memoises its field rows on the `data` object
  // reference — re-renders with the new value. Covers undo/redo and any
  // op-driven edit that doesn't go through the inspector's optimistic path.
  rv[componentType] = { ...(ownValue(rv, componentType) as Record<string, unknown> | undefined), [fieldName]: value };
}

/** Exported for the asset editor's executors (same clone-on-write semantics). */
export function deleteUserDataField(
  viewer: RVViewer, nodePath: string, componentType: string, fieldName: string,
): void {
  const node = viewer.registry?.getNode(nodePath);
  if (!node) return;
  const rv = node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
  const compOv = rv?.[componentType];
  if (!compOv) return;
  // Clone-on-write (new identity) so the inspector's reference-memoised field
  // rows re-render after a reset/unset. See writeUserDataField.
  const next = { ...compOv };
  delete next[fieldName];
  if (Object.keys(next).length === 0) delete rv![componentType];
  else rv![componentType] = next;
}

/**
 * Push the updated `userData.realvirtual` values back into the live component
 * instance via the registered schema (so e.g. RVDrive.TargetSpeed reflects
 * the new value at runtime — not just inside userData).
 * Exported for the asset editor's executors.
 */
export function reapplySchemaForComponent(
  viewer: RVViewer,
  nodePath: string,
  componentType: string,
  /**
   * plan-610: the authoring scope for reference resolution — a node; the
   * registry walks to its enclosing registered scope root, exactly like the
   * loader (`initSubtree` → `registerScopeNames`). Omitted = the unscoped
   * resolution every other caller has always had.
   */
  opts?: { scope?: Object3D | null },
): void {
  const reg = viewer.registry;
  if (!reg) return;
  // plan-502 F13: LogicSteps are built by the logic engine, not the component
  // registry — hand an edited step's fields to the running step instead.
  if (componentType.startsWith('LogicStep_')) {
    const stepNode = reg.getNode(nodePath);
    const stepRv = stepNode?.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
    viewer.logicEngine?.reapplyStepFields(nodePath, componentType, stepRv?.[componentType] ?? {});
    return;
  }
  const components = reg.getComponentsAt(nodePath);
  if (!components || components.length === 0) return;
  const entry = components.find(([type]) => type === componentType);
  if (!entry) return;
  const instance = entry[1];
  const node = reg.getNode(nodePath);
  if (!node) return;
  const rv = node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
  const data = rv?.[componentType] ?? {};
  // IKTarget grip references live outside the schema; undo must restore the live pointer too.
  if (componentType === 'IKTarget') {
    (instance as import('../../engine/rv-ik-target').RVIKTarget).refreshGrip(reg);
  }

  // Find the schema. Most components register via `getRegisteredFactories`;
  // a few (Drive, drive behaviors) have their schema on the class itself.
  const factory = getRegisteredFactories().get(componentType);
  if (factory) {
    applySchema(instance as unknown as Record<string, unknown>, factory.schema, data);
    resolveRefs(instance, reg, opts?.scope);
    reapplyConfig(instance);
    // Path edits and their inverses must refresh the filtered runtime order together.
    if (componentType === 'IKPath') {
      (instance as import('../../engine/rv-ik-path').RVIKPath).rebuildTargets(reg);
    }
    return;
  }
  // Fallback: instance carries a static `schema` field (Drive / drive behaviors).
  const ctor = (instance as object).constructor as { schema?: Record<string, unknown> } | undefined;
  if (ctor?.schema) {
    applySchema(instance as unknown as Record<string, unknown>, ctor.schema as never, data);
    resolveRefs(instance, reg, opts?.scope);
    reapplyConfig(instance);
  }
}

/**
 * `applySchema` writes a `componentRef` field back as the RAW `ComponentReference`
 * record from the extras — the same two-phase state the loader's STEP 1 leaves
 * behind. Without STEP 2 the instance would then hold `{type,path,componentType}`
 * where the component expects a resolved instance or an address string, and an
 * edited reference (DrivenBy, TargetLink, a signal slot) would silently stop
 * working until the next reload (plan-411 §2.1). Same call, same order as
 * rv-scene-loader's `constructComponentOnNode`.
 */
function resolveRefs(instance: unknown, registry: NodeRegistry, scope?: Object3D | null): void {
  try {
    resolveComponentRefs(instance as Record<string, unknown>, registry, scope ?? undefined);
  } catch (e) {
    console.warn('[scene-exec] component ref resolution failed after reapplySchema:', e);
  }
}

/**
 * Re-derive runtime state from the freshly-applied config fields. applySchema
 * only writes raw values onto the instance; components with a config→runtime
 * split (e.g. RVDrive's Direction → axis / isRotary, TargetSpeed → targetSpeed)
 * need this to take effect at runtime instead of only after a reload. Mirrors
 * the scene loader's overlay reconciliation, which calls reapplyConfig() too.
 */
function reapplyConfig(instance: unknown): void {
  const c = instance as { reapplyConfig?: () => void };
  if (typeof c.reapplyConfig === 'function') c.reapplyConfig();
}

// ─── setCode (WebComponent script source, plan-210) ─────────────────────
//
// Writes the script source into `userData.realvirtual.WebComponent.Code` on
// the live node — the same overlay shape `materialise()` produces, so a
// reload replays identically. Component (re)instantiation from the changed
// code (hot-reload) is plan-210 phase 2 and deliberately NOT wired here;
// `reapplySchemaForComponent` is a graceful no-op until a `WebComponent`
// factory registers.

function setCodeForward(op: SetCodeOp, ctx: ExecutorContext): void {
  writeUserDataField(ctx.viewer, op.nodePath, WEB_COMPONENT_TYPE, WEB_COMPONENT_CODE_FIELD, op.code);
  reapplySchemaForComponent(ctx.viewer, op.nodePath, WEB_COMPONENT_TYPE);
}

function setCodeInverse(op: SetCodeOp, ctx: ExecutorContext): void {
  // Restore prev; when prev was undefined the node had no script before —
  // delete the override entirely (mirrors setField's inverse semantics).
  if (op.prev === undefined) {
    deleteUserDataField(ctx.viewer, op.nodePath, WEB_COMPONENT_TYPE, WEB_COMPONENT_CODE_FIELD);
  } else {
    writeUserDataField(ctx.viewer, op.nodePath, WEB_COMPONENT_TYPE, WEB_COMPONENT_CODE_FIELD, op.prev);
  }
  reapplySchemaForComponent(ctx.viewer, op.nodePath, WEB_COMPONENT_TYPE);
}

// ─── addPlacement / removePlacement / transformPlacement ────────────────

async function addPlacementForward(op: AddPlacementOp, ctx: ExecutorContext): Promise<void> {
  const planner = ctx.viewer.getPlugin<LayoutPlannerPlugin>('layout-planner');
  if (!planner) throw new Error('LayoutPlannerPlugin not registered');
  await planner.placeFromRecord(op.placement);
}

function addPlacementInverse(op: AddPlacementOp, ctx: ExecutorContext): void {
  const planner = ctx.viewer.getPlugin<LayoutPlannerPlugin>('layout-planner');
  planner?.removePlacementById(op.placement.id);
}

function removePlacementForward(op: RemovePlacementOp, ctx: ExecutorContext): void {
  const planner = ctx.viewer.getPlugin<LayoutPlannerPlugin>('layout-planner');
  planner?.removePlacementById(op.placementId);
}

async function removePlacementInverse(op: RemovePlacementOp, ctx: ExecutorContext): Promise<void> {
  const planner = ctx.viewer.getPlugin<LayoutPlannerPlugin>('layout-planner');
  if (!planner) throw new Error('LayoutPlannerPlugin not registered');
  await planner.placeFromRecord(op.placement);
}

function transformPlacementForward(op: TransformPlacementOp, ctx: ExecutorContext): void {
  const planner = ctx.viewer.getPlugin<LayoutPlannerPlugin>('layout-planner');
  planner?.applyTransformById(op.placementId, op.position, op.rotation, op.scale);
}

function transformPlacementInverse(op: TransformPlacementOp, ctx: ExecutorContext): void {
  const planner = ctx.viewer.getPlugin<LayoutPlannerPlugin>('layout-planner');
  planner?.applyTransformById(op.placementId, op.prev.position, op.prev.rotation, op.prev.scale);
}

// ─── setCamera ──────────────────────────────────────────────────────────

function setCameraForward(op: SetCameraOp, ctx: ExecutorContext): void {
  const key = deriveModelKey(ctx.viewer.currentModelUrl);
  if (!key) return;
  if (op.preset) saveStartPos(key, op.preset);
  else clearStartPos(key);
  // Kick the camera plugin to re-tween if it wants. The CAMERA_START_CHANGED
  // event fires from the saveStartPos / clearStartPos helpers automatically.
}

function setCameraInverse(op: SetCameraOp, ctx: ExecutorContext): void {
  const key = deriveModelKey(ctx.viewer.currentModelUrl);
  if (!key) return;
  if (op.prev) saveStartPos(key, op.prev);
  else clearStartPos(key);
}
