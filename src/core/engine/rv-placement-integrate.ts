// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-placement-integrate.ts — the planner-INDEPENDENT half of registering a
 * placed subtree with the runtime (plan-753 structure hardening, 2026-09-17).
 *
 * Lifted out of the layout planner's `integrateSubtree`
 * (`plugins/layout-planner/scene-mutations.ts`) so a viewer WITHOUT the
 * planner plugin can bring the materialised placements of a layout document
 * to life: naming-convention scan, `processExtras` (signals, drives,
 * components, sensors, transport surfaces), deferred-logic hand-over, transport
 * topology invalidation, the drive list, placed behaviors and LogicSteps.
 *
 * plan-757 — a placement is the main model at another origin, so its init IS
 * the main model's init (step 6 of `load → prepare → bake → drop → place →
 * init`), fed from the same builder (`viewer.initContext()`, F4) and told the
 * same things the loader tells it for a baked template:
 *  - a hierarchy that is already final (R2): the `Kinematic` hook re-parented
 *    on `tmp` and the `Drive` hook stamped the home pose before the bake; the
 *    init moves nothing (plan-757 Phase 3 commit B);
 *  - the asset's alias table for this instance (D4);
 *  - the trust gate at ONE named point (F6): `logicGated` is derived from
 *    `baked.signatureState` — the asset's OWN verdict, never inherited from the
 *    document (D8) — weighed against the document exactly as a composed frame
 *    is (`isFrameGated`), BEFORE `initSubtree`; `mergePlacedLogic` adds no
 *    subtree of a gated instance, the components are held as deferred logic
 *    and the Problems panel says so (`logic-gated`);
 *  - the static freeze after the init (F13), as loader Phase 11 does;
 *  - its groups merged into the viewer's registry — a group is a NAME, global
 *    to the viewer (Unity semantics): ten instances with a group `Platen` are
 *    one group with ten member sets.
 *
 * What is NOT here, because it is planner bookkeeping: unique names, the
 * placement id maps, aux raycast targets of virtual/DES nodes, snap ports,
 * selection, undo, the store. The planner's `integrateSubtree` calls
 * {@link integratePlacedContent} in the middle of its own sequence — one
 * implementation, one order, both hosts.
 */

import type { Object3D, Scene } from 'three';
import {
  collectKinematicGroupMembers, processExtras, type DeferredLogic, type ProcessExtrasResult,
} from './rv-scene-loader';
import { buildInitContext, subsystemsOf, type InitContextBase, type InitSubsystems } from './rv-init-context';
import type { SignalStore } from './rv-signal-store';
import type { RVTransportManager } from './rv-transport-manager';
import type { RVDrive } from './rv-drive';
import type { RVUberMaterial } from './rv-uber-material';
import type { BakeRegistry } from './rv-bake-registry';
import { getNodeId } from './rv-node-id';
import { RVLogicEngine } from './rv-logic-engine';
import { applyNamingScan } from './rv-naming-scan';
import { NodeRegistry } from './rv-node-registry';
import { GroupRegistry } from './rv-group-registry';
import { freezeStaticMatrices } from './rv-freeze-static';
import { isFrameGated, weakestSignatureState } from './rv-glb-compose';
import { getAssetReference, getPlacementMeta } from './rv-asset-reference';
import { buildMissingReferencePlaceholder, missingReferenceLabel } from './rv-missing-reference-placeholder';
import {
  describeLoadError, reportLogicGated, reportMissingReference, reportNestedReferenceRefused, reportPlacementCapReached,
  reportPlacementRegisterFailed, reportPluginClaimNotApplicable,
} from '../hmi/problems-store';
import { resolveReferencePath } from './rv-reference-resolver';
import { syncSubtreeGroups } from './rv-group-sync';
import type { PlacementInstance } from './rv-bake-registry';
import type { BakedAsset } from './rv-bake-chunk';
import type { SignatureState } from '../persistence/rv-sig-verify';
import {
  PlacementInstancer, type DeferredPlacementEntry, type NestedReferenceRefusal, type PlacementRef,
} from './rv-placement-instancer';
import { createReferenceResolver } from './rv-glb-reference-resolver';

/**
 * What a placement needs from the shell it lives in (plan-757 F4/F8) — the
 * SAME contract for `RVViewer` (which satisfies it structurally) and for the
 * embed facade (`rv-embed-viewer.ts`), which has no `RVViewer` and builds this
 * bag from its own load result. Everything optional is a shell service a
 * minimal host may not have; everything required is what `processExtras`
 * itself needs. Declared as METHODS on purpose: a host's stricter event map
 * (`RVViewer.emit<K>`) is then assignable.
 */
export interface PlacementHost {
  readonly scene: Scene;
  registry: NodeRegistry | null;
  signalStore: SignalStore | null;
  transportManager: RVTransportManager | null;
  /** The runtime drives — a placement's drives are PUSHED here. */
  drives: RVDrive[];
  /** Created lazily by the first placed LogicStep when the document had none. */
  logicEngine: RVLogicEngine | null;
  /**
   * plan-538 F1h — the CURRENT connection state, read before a placed root
   * starts: a placed asset's `Disconnected` root never starts (or writes) in an
   * already-connected document. Absent (the embed facade) = Disconnected.
   */
  readonly connectionState?: 'Connected' | 'Disconnected';
  /** Viewer-wide groups, names global (plan-757); created lazily. */
  groups: GroupRegistry | null;
  readonly bakeRegistry: BakeRegistry;
  /** The session uber material — null when the loader skipped the uber bake (S4). */
  readonly placementUberMaterial: RVUberMaterial | null;
  readonly isWebGPU: boolean;
  logicRunState: 'active' | 'gated' | 'activating';
  registerDeferredLogic(deferred: DeferredLogic): void;
  /** The ONE init context (F4); a host without the builder gets it built from its fields. */
  initContext?(): InitContextBase | null;
  /** The subsystem bag the builder is fed (a host without `initContext`). */
  initSubsystems?(): InitSubsystems;
  /** The user's explicit release of untrusted logic (F6). Default false. */
  readonly allowUntrustedLogic?: boolean;
  /** The DOCUMENT's signature verdict the placed asset is weighed against (F6). Default `'none'`. */
  getSignatureState?(): SignatureState;
  /** Hold a gated instance's logic until the user releases it; without it the logic is registered as deferred. */
  holdPlacementLogic?(deferred: DeferredLogic, root: Object3D): void;
  /** Plugin bake claims of the main model (D5) — a claim aimed into a placement is a Problems entry. */
  readonly collectedBakeClaims?: ReadonlyArray<{ path: string; role: 'merge' | 'chunk'; pluginId: string }>;
  readonly behaviors?: { dispatchPlaced(root: Object3D): void };
  applyRenderModeToSubtree?(root: Object3D): void;
  markRenderDirty?(): void;
  markShadowsDirty?(): void;
  emit?(event: string, payload?: unknown): void;
  /**
   * `false` = the host has no Problems panel (the embed facade): the placement
   * path warns on the console instead of writing the problems store. Default
   * true. (Orphaned overrides reported by `BakeRegistry.applyOverrides` still
   * reach the store — it is a module singleton and inert without a panel.)
   */
  readonly reportProblems?: boolean;
}

/** Does this host want Problems entries? */
function wantsProblems(host: PlacementHost): boolean {
  return host.reportProblems !== false;
}

/**
 * The subsystem bag of a host WITHOUT an init-context builder: its
 * `initSubsystems()` when it has one, else the manager fields read straight
 * off the host (the planner test harnesses' duck-typed viewers), with the host
 * itself as the event bus when it can emit and listen.
 */
function fallbackSubsystems(host: PlacementHost): InitSubsystems {
  const bag = host.initSubsystems?.() ?? subsystemsOf(host as InitSubsystems);
  if (!bag.events && typeof (host as { on?: unknown }).on === 'function' && typeof host.emit === 'function') {
    bag.events = host as unknown as InitSubsystems['events'];
  }
  return bag;
}

/** Phase names {@link integratePlacedContent} reports — kept identical to the
 *  planner's `web_layout_timings` phases. */
export type PlacedContentPhase = 'namingScan' | 'processExtras' | 'bvhRequest' | 'behaviorsAndLogic';

/** Options for {@link integratePlacedContent}. */
export interface IntegratePlacedContentOptions {
  /** Timing hook — called after each phase, in order. */
  mark?: (phase: PlacedContentPhase) => void;
  /** Runs right after the naming scan, before `processExtras` — the planner
   *  attaches drive datasheets (AAS) here. */
  afterNamingScan?: (root: Object3D) => void;
  /**
   * Occurrence chain of this placement (plan-757 Phase 2b, F10): every node of
   * the instance that carries a `NodeId` is indexed under
   * `fullNodeAddress(occurrence, nodeId)` — what `registerNodeIdsForSubtree`
   * does for a composed frame — so `NodeRegistry.getNodeByAddress` answers for
   * placed content exactly as it did for grafted content. Default: the
   * placement root's own NodeId, else its registry path.
   */
  occurrence?: string;
}

/**
 * Naming-convention scan on a placed subtree, mirroring what `loadGLB` does for
 * the top-level scene: `Drive-*` / `Transport-*` / `Sensor*` names become rv
 * extras. Idempotent — `applyKinematicsSpec` deep-merges without overwrite, so
 * a subtree whose master was already scanned keeps its extras unchanged.
 */
export function applyNamingScanToPlaced(root: Object3D): void {
  applyNamingScan(root);
}

/** True when the viewer is wired far enough for `processExtras` to run. */
export function canIntegratePlacedContent(viewer: PlacementHost | null | undefined): boolean {
  return !!viewer?.registry && !!viewer.signalStore && !!viewer.transportManager;
}

/**
 * THE trust rule of a placed asset (plan-757 F6 / D8): the asset's OWN
 * signature verdict, weighed against the document it is placed in exactly as
 * a composed frame is (`isFrameGated`, plan-397 §2.9) — a broken signature
 * gates, a signed document gates an unsigned asset, an unsigned document takes
 * nothing away, and the user's explicit release overrides all of it. Trust
 * never flows from the document INTO the asset, nor from the asset UP into the
 * document: the viewer's own `logicRunState` is untouched by what it places.
 */
export function isPlacedAssetGated(
  assetState: SignatureState,
  documentState: SignatureState,
  allowUntrustedLogic: boolean,
): boolean {
  return isFrameGated(assetState, documentState, allowUntrustedLogic);
}

/**
 * The trust rule of a NESTED placement (plan-757 Phase 2, F7): the chain of
 * containing assets lends nothing and can only take away. The effective state
 * is the weakest of the chain above the asset (`PlacementInstance.chainState`,
 * every containing asset's OWN verdict folded together — exactly `compose()`'s
 * `effectiveState`) and the asset's own; it is weighed against the document
 * as {@link isPlacedAssetGated} does. So an unsigned or broken outer asset
 * gates a signed inner one, and a signed outer asset never lifts an unsigned
 * inner one. Trust still never flows from the document into the chain (D8):
 * a document-level placement has NO chain (`undefined`) and this IS
 * `isPlacedAssetGated` — `'none'` is a verdict, not a neutral element.
 */
export function isPlacedChainGated(
  chainState: SignatureState | undefined,
  assetState: SignatureState,
  documentState: SignatureState,
  allowUntrustedLogic: boolean,
): boolean {
  return isFrameGated(effectivePlacedState(chainState, assetState), documentState, allowUntrustedLogic);
}

/** The verdict a placement is judged by: its own, weakened by its chain when it has one (F7). */
export function effectivePlacedState(chainState: SignatureState | undefined, assetState: SignatureState): SignatureState {
  return chainState === undefined ? assetState : weakestSignatureState(chainState, assetState);
}

/**
 * Merge the LogicSteps carried by a placed subtree into the viewer's logic
 * engine. `loadGLB()` builds the engine for the main model only; placed assets
 * register through `processExtras()`, which deliberately handles components
 * but not logic — without this merge a placed asset's sequences never run. The
 * engine is created lazily when the main model itself carried no logic; roots
 * added after the engine started run immediately.
 *
 * A subtree the trust gate holds (F6) is NEVER merged here — `integratePlacedContent`
 * hands it to `viewer.holdPlacementLogic()` instead, and the viewer merges it
 * if and when the user releases the gate.
 */
export function mergePlacedLogic(viewer: PlacementHost, root: Object3D): void {
  if (!viewer.registry || !viewer.signalStore) return;
  if (!RVLogicEngine.hasLogicSteps(root)) return;
  // plan-538 F1h: the engine knows the connection state BEFORE the placed
  // roots are added, so each starts only when it is active for that state.
  const connected = viewer.connectionState === 'Connected';
  if (!viewer.logicEngine) {
    viewer.logicEngine = new RVLogicEngine();
    // Mid-session engine: mark started so the roots added below run at once.
    viewer.logicEngine.start(connected);
  } else {
    viewer.logicEngine.setConnected?.(connected);
  }
  viewer.logicEngine.addSubtree(root, viewer.registry, viewer.signalStore);
}

/**
 * Merge a subtree's LOCAL group registry into the viewer's (plan-757: a group
 * is a NAME, global to the viewer). Members of an existing name join it;
 * kinematic marks carry over. Creates the viewer registry when the document
 * had no groups of its own. Returns true when anything was added.
 */
function mergePlacedGroups(viewer: PlacementHost, local: GroupRegistry | null): boolean {
  if (!local) return false;
  const groups = local.getAll();
  if (groups.length === 0) return false;
  const target = (viewer.groups ??= new GroupRegistry());
  let changed = false;
  for (const g of groups) {
    for (const node of g.nodes) {
      target.register(g.name, node);
      changed = true;
    }
    if (local.isKinematic(g.name)) target.markAsKinematic(g.name);
  }
  return changed;
}

/**
 * Take a placed subtree's nodes OUT of the viewer-wide group registry — the
 * reverse of {@link mergePlacedGroups}, for the planner's remove path (plan-757
 * Phase 1b, 1a residual 4). Every node under `root` leaves every group; a
 * group emptied by that is dropped by the registry. Emits `groups-changed`
 * when anything moved. Returns true when it did.
 */
export function releasePlacedGroups(viewer: PlacementHost, root: Object3D): boolean {
  if (!viewer.groups) return false;
  const changed = syncSubtreeGroups({ groups: viewer.groups, registry: viewer.registry }, root, 'detach');
  if (changed) viewer.emit?.('groups-changed', { source: 'placement' });
  return changed;
}

/**
 * plan-757 §2.6 / D5: plugin bake claims are a MAIN-MODEL input. A claim
 * ADDRESSED INTO this placement kept nothing — the asset was baked without a
 * plugin layer — so it is reported in the Problems panel instead of a console
 * line. "Addressed into" is the ONE resolver's reading (F7): the claim path
 * starts with the placement's registry path, or its first segment is one of
 * the asset root's names (`Conveyor/Label` for a placed `Conveyor`), or it
 * resolves inside the instance. Whether the node happens to survive for
 * another reason does not matter — the claim did nothing. Idempotent per
 * (placement, claim).
 */
function reportClaimsInsidePlacement(viewer: PlacementHost, root: Object3D, rootPath: string, assetId: string): number {
  const claims = viewer.collectedBakeClaims;
  if (!claims || claims.length === 0 || !viewer.registry) return 0;
  const scope = viewer.registry.scopeFor(root);
  let reported = 0;
  for (const c of claims) {
    const first = c.path.split('/')[0];
    const inside = c.path === rootPath || c.path.startsWith(rootPath + '/')
      || scope.rootNames.has(first)
      || resolveReferencePath(viewer.registry, c.path, scope).node !== null;
    if (!inside) continue;
    if (wantsProblems(viewer)) {
      reportPluginClaimNotApplicable({ nodePath: rootPath, label: root.name, assetId, claimPath: c.path, role: c.role, pluginId: c.pluginId });
    } else {
      console.warn(`[placement] plugin claim "${c.path}" (${c.pluginId}) is aimed into placement ${rootPath} and did nothing`);
    }
    reported++;
  }
  return reported;
}

/**
 * Wire an already-parented, already-positioned placed subtree into the
 * runtime. The caller must have checked {@link canIntegratePlacedContent}.
 *
 * Order (load-bearing): naming scan → `afterNamingScan` hook → trust gate →
 * processExtras → deferred logic (held or registered) → transport topology →
 * drives → groups → static freeze → placed behaviors → LogicSteps (after
 * drives/components exist, so step ComponentReferences resolve; never for a
 * gated instance).
 */
export function integratePlacedContent(
  viewer: PlacementHost,
  root: Object3D,
  opts?: IntegratePlacedContentOptions,
): ProcessExtrasResult {
  const mark = opts?.mark;
  applyNamingScanToPlaced(root);
  opts?.afterNamingScan?.(root);
  mark?.('namingScan');

  // The instance this subtree is — null for a legacy unbaked placement (a
  // virtual / DES node), which then runs the init exactly as before plan-757.
  // Optional calls throughout: the planner test harnesses drive this with a
  // duck-typed viewer that has the four runtime systems and little else.
  const instance: PlacementInstance | null = viewer.bakeRegistry?.instanceOf(root) ?? null;
  const baked: BakedAsset | null = instance?.baked ?? null;

  // ── F6: the trust gate, at THIS one point, before the init. F7: the chain
  // above a nested instance is weighed in — its weakest verdict, never more.
  const documentState: SignatureState = viewer.getSignatureState?.() ?? 'none';
  const chainState: SignatureState | undefined = instance?.chainState;
  const effectiveState: SignatureState = baked ? effectivePlacedState(chainState, baked.signatureState) : 'none';
  const assetGated = baked
    ? isPlacedChainGated(chainState, baked.signatureState, documentState, viewer.allowUntrustedLogic ?? false)
    : false;

  // The session's ONE init context (F4); a duck-typed host without the
  // builder gets the same bag built from its own fields.
  const base = viewer.initContext?.() ?? buildInitContext({
    registry: viewer.registry!,
    signalStore: viewer.signalStore!,
    transportManager: viewer.transportManager!,
    scene: viewer.scene,
    ...fallbackSubsystems(viewer),
  });
  const result = processExtras(root, base, {
    logicRunState: viewer.logicRunState,
    logicGated: assetGated,
    // A placement is never an authoring call: the flag is the asset editor's
    // (plan-757 Phase 3 commit B — the init re-parents in no mode, so R2's
    // "skip the second attach" reason for setting it on a baked instance is
    // gone; a baked instance arrives with the final hierarchy and the `Drive`
    // hook's home stamps regardless).
    preserveAuthoringHierarchy: false,
    aliases: instance?.aliases,
    // F7: the reference node is named by the planner (`Arburg_1`); the asset's
    // own root name is what a root-prefixed reference in the file starts with.
    assetRootNames: baked ? [baked.template.name] : undefined,
  });
  // plan-757 Phase 2b (F10): the instance's NodeIds under this placement's
  // occurrence — what a composed frame got from `registerNodeIdsForSubtree`.
  // Authored ids only (the template carries them; a node without one stays
  // reachable by path, as the whole pre-existing corpus is).
  if (viewer.registry) {
    const occurrence = opts?.occurrence
      ?? getNodeId(root)
      ?? viewer.registry.getPathForNode(root)
      ?? NodeRegistry.computeNodePath(root);
    viewer.registry.registerNodeIdsForSubtree(root, occurrence);
  }
  if (result.deferredLogic) {
    if (assetGated && viewer.holdPlacementLogic) viewer.holdPlacementLogic(result.deferredLogic, root);
    else viewer.registerDeferredLogic(result.deferredLogic);
  }
  const placedAssetId = getAssetReference(root)?.assetId || getPlacementMeta(root)?.catalogId || baked?.assetId || root.name;
  if (assetGated && baked) {
    const nodePath = viewer.registry?.getPathForNode(root) ?? NodeRegistry.computeNodePath(root);
    if (wantsProblems(viewer)) {
      reportLogicGated({
        nodePath,
        label: root.name,
        assetId: placedAssetId,
        // The verdict that gated: the asset's own, or the weaker one its chain carries (F7).
        signatureState: effectiveState,
        documentState,
      });
    } else {
      console.warn(`[placement] logic of ${nodePath} (${placedAssetId}) is gated: asset ${effectiveState}, document ${documentState}`);
    }
  }
  // §2.6: a plugin claim aimed into this placement did nothing — say so.
  if (baked) {
    const rootPath = viewer.registry?.getPathForNode(root) ?? NodeRegistry.computeNodePath(root);
    reportClaimsInsidePlacement(viewer, root, rootPath, placedAssetId);
  }
  mark?.('processExtras');

  // The placement may have registered new transport surfaces/sensors —
  // invalidate the transport manager's spatial index + dead-end adjacency
  // cache (plan-240 F4). Defensive optional call: tolerates duck-typed managers.
  viewer.transportManager!.notifyTopologyChanged?.();

  // Append new drives to the viewer. NO whole-scene BVH rebuild (plan-745
  // Phase 2c, F11): a baked placement picks through its own chunk meshes.
  if (result.drives.length > 0) viewer.drives.push(...result.drives);

  // Groups into the viewer-wide registry (names global), then the Groups
  // panel refresh the editor's group ops also trigger.
  if (mergePlacedGroups(viewer, result.groups)) viewer.emit?.('groups-changed', { source: 'placement' });

  // F13: the static freeze — loader Phase 11 for a placement. Runs AFTER the
  // init on the final hierarchy; the kinematic group members are handed in
  // explicitly, exactly as the loader does. A placement root is a mover
  // (`isMoverNode`: `PlacementMeta` on a reloaded reference node, the
  // `_layoutId` / `_layoutNestedOf` markers on a live or nested root), so its
  // subtree keeps live WORLD matrices — the placement moves as a unit — while
  // every node no drive writes stops re-composing its LOCAL matrix per frame.
  const freeze = freezeStaticMatrices(
    root, collectKinematicGroupMembers(result.kinematicGroupNames, result.groups),
    { extraMoversReparented: baked !== null },
  );
  void freeze;
  mark?.('bvhRequest');

  // Behavior files matching this placed asset, scoped to its subtree. Runs
  // after components are constructed + drives registered.
  viewer.behaviors?.dispatchPlaced(root);
  if (!assetGated) mergePlacedLogic(viewer, root);
  mark?.('behaviorsAndLogic');
  return result;
}

// ─── Viewer-owned instancer + the no-planner defaults ───────────────────

/** True when `node` is `ancestor` or below it. */
function isUnder(node: Object3D, ancestor: Object3D | null | undefined): boolean {
  if (!ancestor) return false;
  for (let cur: Object3D | null = node; cur; cur = cur.parent) if (cur === ancestor) return true;
  return false;
}

/**
 * Bring a materialised deferred placement to life in a viewer WITHOUT the
 * layout planner (HMI / embed-style deployments): runtime registration
 * ({@link integratePlacedContent}), the saved visibility flag, shadows, render
 * mode and the `layout-content-added` announcement (clip/section tools, AAS
 * resolution). Snap ports, id maps and signal-link bindings are planner
 * bookkeeping and are not created here.
 */
export function registerMaterializedPlacement(
  viewer: PlacementHost,
  entry: DeferredPlacementEntry,
  instance: PlacementInstance,
): void {
  const root = entry.node;
  if (canIntegratePlacedContent(viewer)) {
    // The occurrence chain is the NodeId address prefix of the placed content (F10).
    integratePlacedContent(viewer, root, { occurrence: entry.occurrence });
  } else if (viewer.registry) {
    viewer.registry.registerNode(NodeRegistry.computeNodePath(root), root);
  }
  if (getPlacementMeta(root)?.visible === false) root.visible = false;
  viewer.markShadowsDirty?.();
  // Again after processExtras: it may have created component sub-meshes.
  viewer.applyRenderModeToSubtree?.(root);
  viewer.emit?.('layout-content-added', { root, chunks: instance.chunks, keep: instance.keep });
  viewer.markRenderDirty?.();
}

/**
 * A deferred placement whose asset could not be loaded: the hole you can see +
 * its problem entry. `error` is what the instancer caught — carried into the
 * entry so the panel says WHY (a parse error is not "not found").
 */
export function placeMissingPlacement(viewer: PlacementHost, entry: DeferredPlacementEntry, error?: unknown): void {
  const node = entry.node;
  const ref = getAssetReference(node);
  const label = missingReferenceLabel({ assetId: entry.ref.catalogId, path: entry.ref.glbUrl });
  node.add(buildMissingReferencePlaceholder({
    label, bounds: ref?.bounds, assetId: entry.ref.catalogId, path: entry.ref.glbUrl,
  }));
  if (wantsProblems(viewer)) {
    reportMissingReference({
      assetId: entry.ref.catalogId,
      path: entry.ref.glbUrl || undefined,
      occurrence: entry.occurrence,
      label,
      nodePath: viewer.registry?.getPathForNode(node) ?? undefined,
      reason: error === undefined ? undefined : describeLoadError(error),
    });
  }
  viewer.markRenderDirty?.();
}

/** Options of {@link createViewerPlacementInstancer}. */
export interface ViewerPlacementInstancerOptions {
  /** Per-load placement cap (plan-757 Phase 2, F9). Default `MAX_PLACEMENTS_PER_LOAD` (5000). */
  maxPlacementsPerLoad?: number;
}

/**
 * A nested reference the instancer refused (cycle / depth) shows the hole you
 * can see — the missing-reference placeholder, labelled with the reason — and
 * files its Problems entry (plan-757 Phase 2, F9). The node itself stays a
 * reference node: nothing of the placeholder is ever written back.
 */
export function placeRefusedNestedReference(viewer: PlacementHost, r: NestedReferenceRefusal): void {
  const node = r.node;
  const ref = getAssetReference(node);
  const assetLabel = missingReferenceLabel({ assetId: r.ref.catalogId, path: r.ref.glbUrl });
  const label = r.reason === 'cycle' ? `${assetLabel} (reference cycle)` : `${assetLabel} (nested too deep)`;
  if (!node.children.some((c) => c.userData?.__rvMissingPlaceholder === true)) {
    node.add(buildMissingReferencePlaceholder({
      label, bounds: ref?.bounds, assetId: r.ref.catalogId, path: r.ref.glbUrl,
    }));
  }
  const nodePath = viewer.registry?.getPathForNode(node) ?? NodeRegistry.computeNodePath(node);
  if (wantsProblems(viewer)) {
    reportNestedReferenceRefused({
      reason: r.reason,
      nodePath,
      label: r.label,
      assetKey: r.assetKey,
      chain: r.chain,
      depth: r.depth,
    });
  } else {
    console.warn(`[placement] nested reference ${nodePath} refused (${r.reason}): ${r.chain.join(' → ')} → ${r.assetKey}`);
  }
  viewer.markRenderDirty?.();
}

/**
 * The viewer's ONE placement instancer (`viewer.placements`). Lives here so
 * `rv-viewer.ts` only carries the field, the post-load call, the document
 * change and the dispose.
 */
export function createViewerPlacementInstancer(viewer: PlacementHost, opts?: ViewerPlacementInstancerOptions): PlacementInstancer {
  const pathOf = (node: Object3D): string => viewer.registry?.getPathForNode(node) ?? NodeRegistry.computeNodePath(node);
  const problems = wantsProblems(viewer);
  return new PlacementInstancer({
    maxPlacementsPerLoad: opts?.maxPlacementsPerLoad,
    bakeRegistry: () => viewer.bakeRegistry,
    // Null exactly when the loader skipped the uber bake too (editor / STEP
    // load, merging off) — the parity guard plan-752 S4 asks for.
    uber: () => viewer.placementUberMaterial,
    isWebGPU: () => viewer.isWebGPU,
    applyRenderMode: (root) => viewer.applyRenderModeToSubtree?.(root),
    // A cleared / superseded model is detached from the scene before disposal.
    isLive: (node) => isUnder(node, viewer.scene),
    registerDefault: (entry, instance) => registerMaterializedPlacement(viewer, entry, instance),
    missingDefault: (entry, err) => {
      console.warn(`[PlacementInstancer] Cannot restore "${entry.label}" (${entry.ref.catalogId}): ${err}`);
      placeMissingPlacement(viewer, entry, err);
    },
    // plan-757 Phase 2b: a deferred reference the instancer cannot source
    // itself (no url, no registry origin — e.g. an `assetId` that only the open
    // project's manifest knows) goes through the SAME resolver `compose()`
    // grafts with, so deferring a reference never resolves LESS than grafting
    // it did. The bytes come back as a `blob:` url the cache decodes.
    resolveReference: resolveDeferredReferenceBytes,
    // The scene-ready contract (rv-scene-ready.ts): ONE event per load.
    onSettled: (info) => viewer.emit?.('placements-materialized', info),
    onStateChanged: (state) => viewer.emit?.('placements-state-changed', { state }),
    // plan-757 Phase 2 (F9): a refused nested reference (cycle / depth) is a
    // visible hole + a Problems entry; the cap is ONE aggregated entry per
    // load, its nodes stay empty.
    onNestedRefused: (r) => placeRefusedNestedReference(viewer, r),
    onCapReached: (info) => {
      if (problems) reportPlacementCapReached({ cap: info.cap, refused: info.refused, nodePaths: info.nodes.map(pathOf) });
      else console.warn(`[placement] placement cap ${info.cap} reached — ${info.refused} nested reference(s) left empty`);
    },
    // F11: a throwing registration is a Problems entry, never a silent gap.
    onRegisterFailed: (entry, error) => {
      if (problems) reportPlacementRegisterFailed({ nodePath: pathOf(entry.node), label: entry.label, assetId: entry.ref.catalogId, error });
      else console.warn(`[placement] registration of ${pathOf(entry.node)} failed: ${String(error)}`);
    },
  });
}

/**
 * The compose resolver as a placement source (plan-757 Phase 2b): the asset id
 * through every library source and the open project's manifest, else the
 * resolved path — exactly `createReferenceResolver()`. Returns the verified
 * bytes as an object url the `ModelCache` decodes (its own verify sees the
 * same signature), released after the decode. `null` when nothing resolves —
 * the instancer then reports the reference as missing.
 */
async function resolveDeferredReferenceBytes(ref: PlacementRef): Promise<{ url: string; revokeUrl(): void } | null> {
  const resolved = await createReferenceResolver()(
    { assetId: ref.catalogId },
    { baseUrl: '', occurrence: '', depth: 0, resolvedPath: ref.url || ref.glbUrl || '' },
  );
  if (!resolved) return null;
  const url = URL.createObjectURL(new Blob([resolved.bytes], { type: 'model/gltf-binary' }));
  return { url, revokeUrl: () => URL.revokeObjectURL(url) };
}
