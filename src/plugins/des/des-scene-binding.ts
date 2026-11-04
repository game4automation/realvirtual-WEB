// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * des-scene-binding.ts (PRIVATE) -- model-load → DESRunner instance binding
 * (Plan 194 §2.6 P5 / P5b).
 *
 * Discovers placed material-flow components in a loaded scene and registers each
 * one with a `DESRunner`, mirroring how the continuous `BehaviorManager`
 * discovers + dispatches placed objects (`dispatchPlacedObjectsIn` →
 * `matchMaterialFlows`). For every matched LayoutObject root it:
 *
 *   1. builds an `RVBindContext` (the same projection the continuous behaviours
 *      use) so signals/drives/ports resolve identically;
 *   2. seeds the shared `self.prop` config bag from the node's rv_extras for the
 *      definition type (via `applySchema`, so timing params like ConveyorLength /
 *      RotationSpeed reach `self.prop`);
 *   3. creates a DES-mode `self` wired to the runner's GC-free scheduler
 *      (`self.in/at`) and blocking transfer handshake (`self.transfer`);
 *   4. adds the instance to the runner (`runner.addInstance`).
 *
 * After all instances exist, the topology is resolved by the ONE connection
 * resolver of the public core (`src/core/connect`, plan-633): snap stage with
 * port roles, conflict rule, typed distance fallback. The links are folded into
 * the native DES handshake by applying each to the adapters' `nextComponents` /
 * `previousComponents`. Without a snap-point plugin the binding builds (and
 * owns) a headless snap registry per component owner, so headless DES sees the
 * same snap ports as the planner (plan-633 F4).
 *
 * PRIVATE — imports the private `DESRunner`/`MaterialFlowAdapter` plus the PUBLIC
 * material-flow + behavior-runtime types. The public build never sees this file
 * (it lives only in the private folder); the public side stays DES-free.
 */

import { Box3, Quaternion, Vector3, type Object3D } from 'three';
import {
  createBindContext,
  type BindContextHost,
  type KinematicsSpec,
} from '../../core/behavior-runtime';
import {
  createSelf,
  type AcceptPose,
  type MaterialFlowSelf,
  type MU,
  type Port,
  type PoseReadiness,
  type PoseTransferBackend,
  type PoseTransferOutcome,
} from '../../core/material-flow/material-flow-self';
import type { MaterialFlowDefinition } from '../../core/material-flow/define-material-flow';
import { resolveNodeMaterialFlows } from '../../core/material-flow/registry';
import { getEngineSourceForNode, type RVSource } from '../../core/engine/rv-source';
import { RVMovingUnit } from '../../core/engine/rv-mu';
import { stripIdentity } from '../../core/engine/rv-decode-identity';
import { measureMuVisualBugSize, presetMuBugSize } from '../../behaviors/_shared/mu-reference';
import { applySchema, type ComponentSchema } from '../../core/engine/rv-component-registry';
import type { JsonValue } from '../../core/material-flow/material-flow-self';
import type { DESRunner } from './des-runner';
import type { MaterialFlowAdapter, PoseTransferResult } from './material-flow-adapter';
import type { DESMU } from './rv-des-mu';
import type { DESComponent } from './rv-des-component';
import { breakTwoCycles, type ConnectableInstance } from './logical-connections';
import {
  resolveConnectionsDetailed,
  surfacesFromComponentRegistry,
  type Connectable,
  type ConnectionLink,
  type SurfaceComponentRegistry,
} from '../../core/connect/rv-connection-resolver';
import {
  acquireBindingConnectionRegistry,
  detachHeadlessConnectionRegistry,
  type HomePoseDrive,
} from '../../core/connect/rv-connection-registry';
import type { SnapPointRegistry } from '../../core/engine/rv-snap-point-registry';
import { NodeRegistry } from '../../core/engine/rv-node-registry';
import { desComponentIdForNode, type DesAddressSource } from './rv-des-identity';
import { clearProblemsOfCode, reportProblem } from '../../core/hmi/problems-store';

const LEGACY_PROBLEM_CODE = 'des-legacy-component';
const INVALID_CAPACITY_PROBLEM_CODE = 'des-invalid-capacity';
const LEGACY_DES_TYPES = ['DESSource', 'DESSink', 'DESStation', 'DESStorage', 'DESConveyor', 'DESDowntime'] as const;

/** Diagnose retired extras once per node at bind time, including non-placement nodes. */
function reportLegacyComponent(node: Object3D): void {
  const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
  if (!rv) return;
  const types = LEGACY_DES_TYPES.filter(type => Object.prototype.hasOwnProperty.call(rv, type));
  if (types.length === 0) return;
  const path = NodeRegistry.computeNodePath(node) || node.name || node.uuid;
  reportProblem({
    id: `${LEGACY_PROBLEM_CODE}:${node.uuid}`,
    severity: 'warning',
    code: LEGACY_PROBLEM_CODE,
    title: 'Retired DES component',
    detail: `Node '${path}' uses retired DES types: ${types.map(type => `${type} → ${type.slice(3)}`).join(', ')}. Replace them with the corresponding material-flow behaviours.`,
    nodePath: path,
  });
}

/** A bound instance kept locally so the topology pass can wire neighbours. */
interface BoundInstance {
  readonly root: Object3D;
  readonly self: MaterialFlowSelf;
  readonly adapter: MaterialFlowAdapter;
}

/**
 * Resolve the engine `RVSource` bound to a source LayoutObject root (via the
 * off-node WeakMap in rv-source). It owns the MU template + clone logic, so the
 * DES path reuses it to give event-driven MUs a real visual the tween registry
 * can move — mirroring the Unity `DESSource.GenerateMU()` reusing
 * `Source.Generate()`. Null when the node carries no engine source.
 */
function engineSourceFor(root: Object3D): RVSource | null {
  return getEngineSourceForNode(root);
}

/** True if `node` is the ROOT of a placed LayoutObject (carries the marker). */
function isLayoutObjectRoot(node: Object3D): boolean {
  const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
  return !!(rv && rv.LayoutObject);
}

/** Asset name to match against: the node name minus the `_N` duplicate suffix. */
function layoutMatchName(node: Object3D): string {
  return node.name.replace(/_\d+$/, '');
}

function sceneRootFor(node: Object3D): Object3D {
  let root = node;
  while (root.parent) root = root.parent;
  return root;
}

function registerMuVisualTemplateFactories(
  runner: DESRunner,
  componentRoot: Object3D,
  self: MaterialFlowSelf,
  properties: readonly string[],
): void {
  const sceneRoot = sceneRootFor(componentRoot);
  for (const key of properties) {
    const templateId = self.prop[key];
    if (typeof templateId !== 'string' || !templateId) continue;
    const template = sceneRoot.getObjectByName(templateId);
    if (!template) continue; // the runner provides the visible unknown-id fallback
    runner.registerMuVisualFactory(
      templateId,
      () => {
        const clone = template.clone(true);
        // plan-769 Inventory C: a DES MU visual is a runtime clone — no identity.
        stripIdentity(clone);
        clone.visible = true;
        clone.name = `${template.name}_MU`;
        sceneRoot.add(clone);
        return new RVMovingUnit(clone, templateId);
      },
      (visual) => { visual.dispose(); },
    );
  }
}

/** Read the rv_extras config object for a definition type off a node, if present. */
function extrasFor(node: Object3D, type: string): Record<string, unknown> {
  const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
  const cfg = rv?.[type];
  return cfg && typeof cfg === 'object' ? (cfg as Record<string, unknown>) : {};
}

/**
 * Seed `self.prop` with the definition's schema applied to the node's rv_extras,
 * so DES timing reads real values (ConveyorLength / ConveyorSpeed / RotationSpeed
 * / ProcessingTime …), falling back to schema defaults when absent.
 */
function seedConfig(
  self: MaterialFlowSelf,
  def: MaterialFlowDefinition,
  root: Object3D,
  adapter?: MaterialFlowAdapter,
): void {
  const extras = extrasFor(root, def.type);
  const cfg: Record<string, unknown> = {};
  applySchema(cfg, def.schema as ComponentSchema, extras);
  for (const k of Object.keys(cfg)) {
    const v = cfg[k];
    const field = (def.schema as ComponentSchema)[k];
    if (k !== 'MaxCapacity' && field?.type === 'number' && (typeof v !== 'number' || !Number.isFinite(v))) {
      throw new Error(`invalid numeric config '${k}' for '${def.type}'`);
    }
    // Component references are runtime objects in the generic schema mapper,
    // but DES configuration is persisted through the JSON-only prop bag. Keep
    // the canonical hierarchy path and resolve the typed component at bind time.
    if (field?.type === 'componentRef') {
      const path = typeof v === 'string'
        ? v
        : v && typeof v === 'object' && typeof (v as { path?: unknown }).path === 'string'
          ? (v as { path: string }).path
          : null;
      if (path !== null) self.prop[k] = path;
      continue;
    }
    // Only JSON-serializable scalars belong in the snapshot-safe prop bag.
    if (v === null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') {
      self.prop[k] = v as JsonValue;
    }
  }
  if (adapter && def.kind !== 'sink') {
    const rawCapacity = cfg.MaxCapacity ?? self.prop.MaxCapacity ?? 1;
    adapter.reconfigureCapacity(Number(rawCapacity));
  }
}

/**
 * Re-seed every bound instance's `self.prop` from its node's (possibly
 * overridden) rv_extras — the PRODUCTION re-config path for plan-265 parameter
 * overrides. Unlike `DESComponent.reconfigureFromExtras()` (native components,
 * used by tests), the live DES runner binds `MaterialFlowAdapter`s whose config
 * lives in `self.prop` (seeded once at bind by {@link seedConfig}). The batch
 * runner writes overrides into `userData.realvirtual[...]`, calls this to refresh
 * `self.prop`, then `runner.reset()` — whose `start()` re-runs `def.setup(self)`,
 * so the setup re-reads the refreshed prop and the override takes effect.
 *
 * Idempotent; touches only schema/config keys (seedConfig writes JSON scalars into
 * prop), never the runtime `__load` / MU state.
 */
export function reconfigureInstancesFromExtras(runner: DESRunner): void {
  for (const inst of runner.liveInstances) {
    seedConfig(inst.self, inst.def, inst.self.root, inst.adapter);
  }
}

/** The store surface `releaseUnownedSignals` needs (RVViewer.signalStore). */
interface ReleasableSignalStore {
  get(name: string): boolean | number | undefined;
  register(name: string, path: string, initialValue: boolean | number): void;
  unregisterPath(path: string, expectedName?: string): 'none' | 'path' | 'name';
  registeredPaths(name: string): readonly string[];
  hasInterfaceOwner(name: string): boolean;
  isForced(name: string): boolean;
}

/**
 * Remove signal names from the host's store that nothing owns any more (plan-612
 * CP1d-b) — a name a dropped DES instance declared and wrote, but no rebound
 * instance declares again (the unscoped `Agv.Run` of a vehicle bound before its
 * placement scope stamp existed). Kept: names with a model path, an interface
 * owner or a force pin. The store has no path-less removal, so the release goes
 * through its existing ownership rule: claim a private path, release it — the
 * last owner gone removes the name (`SignalStore.unregisterPath`). Listener sets
 * stay, as with every release. No-op on a store without that surface.
 */
export function releaseUnownedSignals(host: BindContextHost, names: Iterable<string>): string[] {
  const store = host.signalStore as Partial<ReleasableSignalStore> | null;
  if (!store?.register || !store.unregisterPath || !store.registeredPaths
    || !store.hasInterfaceOwner || !store.isForced || !store.get) return [];
  const released: string[] = [];
  for (const name of names) {
    if (store.get(name) === undefined) continue;
    if (store.registeredPaths(name).length > 0 || store.hasInterfaceOwner(name) || store.isForced(name)) continue;
    const path = `__des-rebind__/${name}`;
    store.register(name, path, store.get(name)!);
    if (store.unregisterPath(path, name) === 'name') released.push(name);
  }
  return released;
}

/**
 * Retire the bind-time Problems (`des-legacy-component`, `des-invalid-capacity`).
 * Runs at the start of every bind and in `DESRunner.dispose()` — the kernel
 * disposes the runner in `RVViewer.clearModel()` and on viewer dispose, so the
 * entries do not outlive the model they describe.
 */
export function clearSceneBindingProblems(): void {
  clearProblemsOfCode(LEGACY_PROBLEM_CODE);
  clearProblemsOfCode(INVALID_CAPACITY_PROBLEM_CODE);
}

/**
 * Discover the material-flow components under `root` and register them with
 * `runner`. Returns the number of instances bound. Idempotent only insofar as it
 * (re)builds instances for the current scene — call once per `start()`.
 *
 * Discovery is `resolveNodeMaterialFlows` (the shared dual discovery in the
 * public core): a placement matches by asset NAME, and any node — placement or
 * not — matches by rv_extras PAYLOAD.
 *
 * @param runner the DES runner to populate (must NOT have been `start()`ed yet).
 * @param root   the loaded scene root.
 * @param host   the bind-context host (the RVViewer).
 */
export function bindSceneToRunner(runner: DESRunner, root: Object3D, host: BindContextHost): number {
  const bound: BoundInstance[] = [];
  clearSceneBindingProblems();

  // Payload-detected, not placement-gated (plan-455 F4). A placement still
  // matches by asset name; every OTHER node is offered to the payload branch
  // alone (empty match name), so a component embedded in a scene — three AGVs
  // in a saved layout, a self-spawning `EuropalletLoaded` — reaches the runner
  // instead of being invisible for want of a LayoutObject marker.
  root.traverse((node) => {
    reportLegacyComponent(node);
    const placed = isLayoutObjectRoot(node);
    const matchName = placed ? layoutMatchName(node) : '';
    for (const def of resolveNodeMaterialFlows(node, matchName)) {
      try {
        const instance = bindOne(runner, node, host, def);
        if (instance) bound.push(instance);
      } catch (e) {
        console.error(`[des-binding] '${def.type}' bind error for '${matchName || node.name}':`, e);
      }
    }
  });

  // Connection registry for this binding (plan-633 F4): the planner's live
  // registry, or a headless one built per component owner. Acquired BEFORE the
  // topology pass so `self.outputs()` (routers, SDK ports) reads the same graph.
  const conn = acquireBindingConnectionRegistry(
    host,
    bound.map(b => b.root),
    { drives: homePoseDrivesOf(host) },
  );
  if (conn.headless) {
    // Lifetime = binding: released when the binding ends (scene rebind, plan-612
    // CP1d-b) or the runner is disposed.
    runner.onSceneUnbind(() => detachHeadlessConnectionRegistry(host, conn.registry));
  }

  // Topology pass: wire native DES neighbours through the core resolver.
  wireTopology(bound, host, conn.registry, conn.headless);
  bindLoopSaturation(runner);

  return bound.length;
}

/** Drives that can report a home pose (real `RVDrive`s; stubs without one are
 *  skipped) — ports riding on them are paired in that pose. */
function homePoseDrivesOf(host: BindContextHost): HomePoseDrive[] {
  const drives = (host as { drives?: readonly unknown[] }).drives ?? [];
  const out: HomePoseDrive[] = [];
  for (const d of drives) {
    const c = d as Partial<HomePoseDrive> | null;
    if (c && c.node && typeof c.getHomeLocalPosition === 'function'
      && typeof c.getHomeLocalQuaternion === 'function') {
      out.push(c as HomePoseDrive);
    }
  }
  return out;
}

/**
 * Probe whether `adapter`'s downstream would accept `mu` right now. Mirrors the
 * native `selectNextComponent` canAccept pre-check the handshake performs.
 *
 * MUST stay consistent with the ACTUAL transfer: `tryTransferMU` →
 * `selectNextComponent` is port-AGNOSTIC — it picks the first
 * `nextComponents` entry that can accept, NOT the port's partner. So when a
 * `port` is given we use it as a HINT (router: prefer the partner whose node is
 * the port's owner root), but if it does not resolve to a wired neighbour
 * (router ownerRoot mismatch, a re-built port instance, or a partner that is not
 * a DES instance) we FALL BACK to first-fit. Returning `false` on a port miss
 * (the old behaviour) blocked the belt forever even though the real transfer
 * would have succeeded — that was the conveyor→conveyor loop deadlock.
 */
function downstreamCanAccept(adapter: MaterialFlowAdapter, mu: MU, port?: Port): boolean {
  const nexts = adapter.nextComponents;
  if (nexts.length === 0) return false; // no downstream → cannot release (ZPA)
  if (port) {
    const partner = nexts.find(c => c.node === port.ownerRoot);
    if (partner) return partner.canAccept(mu as never);
    // Port did not map to a wired neighbour → fall through to first-fit.
  }
  // Any downstream that can accept (first-fit, exactly like selectNextComponent).
  return nexts.some(c => c.canAccept(mu as never));
}

/** Number of saturated sinkless conveyor SCCs downstream of each source. */
const sourceLoopState = new WeakMap<DESComponent, { blocked: number }>();

function loopSaturated(source: MaterialFlowAdapter): boolean {
  return (sourceLoopState.get(source)?.blocked ?? 0) > 0;
}

/** Tarjan over conveyor connections; all flow kinds participate in sink reachability.
 * Rebuilt at bind/start, never during generation. Load hooks preserve Phase 2's
 * between-holders count during upstream wakes (pendingTransferCommits).
 */
export function bindLoopSaturation(runner: DESRunner): void {
  const conveyors = new Set<DESComponent>();
  const routers = new Set<DESComponent>();
  const sinks = new Set<DESComponent>();
  for (const i of runner.liveInstances) {
    i.adapter.onLoadChanged = null;
    sourceLoopState.delete(i.adapter);
    if (i.def.kind === 'conveyor') conveyors.add(i.adapter);
    if (i.def.kind === 'router') routers.add(i.adapter);
    if (i.def.kind === 'sink') sinks.add(i.adapter);
  }
  const reachable = (roots: readonly DESComponent[]): Set<DESComponent> => {
    const seen = new Set<DESComponent>();
    const todo = [...roots];
    while (todo.length) {
      const c = todo.pop()!;
      if (seen.has(c)) continue;
      seen.add(c);
      for (const next of c.nextComponents) todo.push(next);
    }
    return seen;
  };
  const indices = new Map<DESComponent, number>();
  // A turntable/transfer is an edge in the conveyor graph, not another zone.
  // Preserve every wired output, including the branch that reaches a sink.
  const edges = new Map<DESComponent, Set<DESComponent>>();
  const via = new Map<DESComponent, Set<DESComponent>>();
  for (const c of conveyors) {
    const nexts = new Set<DESComponent>();
    const seen = new Set<DESComponent>();
    const todo = [...c.nextComponents];
    while (todo.length) {
      const next = todo.pop()!;
      if (conveyors.has(next)) { nexts.add(next); continue; }
      if (!routers.has(next) || seen.has(next)) continue;
      seen.add(next);
      for (const out of next.nextComponents) todo.push(out);
    }
    edges.set(c, nexts); via.set(c, seen);
  }
  const low = new Map<DESComponent, number>();
  const stack: DESComponent[] = [];
  const stacked = new Set<DESComponent>();
  const groups: { members: DESComponent[]; cap: number; load: number; sources: { blocked: number }[] }[] = [];
  let index = 0;
  const visit = (c: DESComponent): void => {
    indices.set(c, index); low.set(c, index++);
    stack.push(c); stacked.add(c);
    for (const next of edges.get(c)!) {
      if (!indices.has(next)) { visit(next); low.set(c, Math.min(low.get(c)!, low.get(next)!)); }
      else if (stacked.has(next)) low.set(c, Math.min(low.get(c)!, indices.get(next)!));
    }
    if (low.get(c) !== indices.get(c)) return;
    const members: DESComponent[] = [];
    let member: DESComponent;
    do { member = stack.pop()!; stacked.delete(member); members.push(member); } while (member !== c);
    if (members.length === 1 && !edges.get(c)!.has(c)) return;
    for (const downstream of reachable(members)) if (sinks.has(downstream)) return;
    const cap = Math.max(1, Math.floor(members.length * 0.7));
    const internalRouters = new Set<DESComponent>();
    for (const m of members) for (const router of via.get(m)!) {
      const downstream = reachable([router]);
      if (members.some(member => downstream.has(member))) internalRouters.add(router);
    }
    // MUs held on an internal router still occupy this circuit, counted once.
    for (const router of internalRouters) members.push(router);
    const group = { members, cap,
      load: 0, sources: [] as { blocked: number }[] };
    for (const m of members) group.load += m.currentLoad - m.pendingTransferCommits;
    const changed = (delta: number): void => {
      const was = group.load >= group.cap;
      group.load += delta;
      const is = group.load >= group.cap;
      if (was !== is) {
        for (let i = 0; i < group.sources.length; i++) group.sources[i].blocked += is ? 1 : -1;
      }
    };
    for (const m of members) m.onLoadChanged = changed;
    groups.push(group);
  };
  for (const c of conveyors) if (!indices.has(c)) visit(c);
  for (const i of runner.liveInstances) {
    if (i.def.kind !== 'source') continue;
    const flow = reachable(i.adapter.nextComponents);
    const state = { blocked: 0 };
    for (const group of groups) {
      if (!group.members.some(c => flow.has(c))) continue;
      group.sources.push(state);
      if (group.load >= group.cap) state.blocked++;
    }
    sourceLoopState.set(i.adapter, state);
  }
}

// ─── Pose hand-over of a source lying on its belt (plan-638) ────────────────

const _spawnPos = new Vector3();
const _spawnQuat = new Quaternion();
const _spawnFwd = new Vector3();

/**
 * The logical spawn pose of a source: the world position of its node (where
 * `RVSource.spawn` puts the MU origin) and the yaw of the node's local +Z
 * about world +Y (`setMuForward` convention, yaw = atan2(fx, fz)).
 */
function spawnPoseOf(node: Object3D): AcceptPose {
  node.updateWorldMatrix(true, false);
  node.getWorldPosition(_spawnPos);
  node.getWorldQuaternion(_spawnQuat);
  _spawnFwd.set(0, 0, 1).applyQuaternion(_spawnQuat);
  return {
    position: [_spawnPos.x, _spawnPos.y, _spawnPos.z],
    yaw: Math.atan2(_spawnFwd.x, _spawnFwd.z),
  };
}

const FALLBACK_NOT_CONTAINED: PoseReadiness = Object.freeze({ state: 'fallback', reason: 'not-contained' } as const);
const FALLBACK_POSE_REFUSED: PoseReadiness = Object.freeze({ state: 'fallback', reason: 'pose-refused' } as const);
const BLOCKED_TARGET_REFUSED: PoseReadiness = Object.freeze({ state: 'blocked', reason: 'target-refused' } as const);
/** Pose-less probe for the standard acceptance check (never registered, id −1). */
const STANDARD_PROBE = Object.freeze({ id: -1 }) as unknown as MU;

/** Map the private hand-over result onto the public outcome (same reasons). */
function toOutcome(r: PoseTransferResult): PoseTransferOutcome {
  return r.ok ? { ok: true } : { ok: false, reason: r.reason };
}

/**
 * Pose backend of a source instance (plan-638 Gate R1 #6). Injected at self
 * creation; the target is resolved on EVERY call through `containedTargetOf`
 * (no mutation after `wireTopology`, a rebind brings a new backend).
 *
 * Order of `readiness()` (Gate R1 #1/#4/#5, R3-1): not contained -> silent
 * fallback; capability BEFORE capacity (target type, async accept, the
 * source's own Processing at transfer, template size) -> fallback; then the
 * source release that also gates the standard path (engine source can spawn,
 * loop saturation) -> blocked; then the target's pre-check with the template
 * size at the spawn pose -> blocked or ready. Nothing is spawned or counted.
 */
function makePoseBackend(
  runner: DESRunner,
  getAdapter: () => MaterialFlowAdapter,
  root: Object3D,
  engineSource: RVSource | null,
  armSpawnSize: (size: readonly [number, number, number] | null) => void,
): PoseTransferBackend {
  return {
    readiness(): PoseReadiness {
      armSpawnSize(null); // only a `ready` answer arms the next spawn
      const adapter = getAdapter();
      const target = containedTargetOf(adapter);
      if (!target) return FALLBACK_NOT_CONTAINED;
      const unsupported = target.poseUnsupportedReason();
      if (unsupported) return { state: 'fallback', reason: unsupported };
      if (adapter.defersTransfer) return { state: 'fallback', reason: 'source-processing' };
      const size = engineSource?.templateSize() ?? null;
      if (!engineSource || !size) return { state: 'fallback', reason: 'no-template-size' };
      if (!engineSource.canSpawn(true)) {
        return { state: 'blocked', reason: engineSource.Enabled ? 'quantity-limit' : 'source-disabled' };
      }
      // plan-2006 #10: the quantity limit is counted on the DES side (Source
      // `local.generated`), not by the engine source's own `Created`.
      const src = adapter.self as unknown as { prop: Record<string, unknown>; local: { generated?: number; pending?: unknown } };
      if (src.prop['LimitNumber'] === true && !src.local.pending &&
        (src.local.generated ?? 0) >= Number(src.prop['MaxNumberMUs'])) {
        return { state: 'blocked', reason: 'quantity-limit' };
      }
      if (loopSaturated(adapter)) return { state: 'blocked', reason: 'loop-saturated' };
      const pose = spawnPoseOf(root);
      if (!runner.canAcceptWithPose(target, size, pose)) {
        // Refused WITH the pose: capacity, or the pose is off the belt for good
        // (a source origin inside the conveyor box but beside / above the
        // rollers). The standard check (same probe as the standard source path,
        // without a pose) tells them apart: it accepts → the pose is the problem
        // → standard transfer instead of waiting forever; it refuses → capacity → wait.
        return downstreamCanAccept(adapter, STANDARD_PROBE) ? FALLBACK_POSE_REFUSED : BLOCKED_TARGET_REFUSED;
      }
      armSpawnSize(size);
      return { state: 'ready', pose, size };
    },
    transfer(mu: MU, pose: AcceptPose): PoseTransferOutcome {
      armSpawnSize(null);
      const adapter = getAdapter();
      const target = containedTargetOf(adapter);
      if (!target) return { ok: false, reason: 'no-target' };
      // R1 #7: the source's release inside the hand-over is tentative - a
      // roll-back counts nothing, a success counts exactly one output.
      const r = adapter.releaseTentatively(
        mu as unknown as DESMU,
        () => runner.transferMUWithPose(mu, target, pose, adapter),
        (res) => res.ok,
      );
      return toOutcome(r);
    },
  };
}

/** Build one DES instance (self + scheduler + transfer + adapter) and add it. */
function bindOne(
  runner: DESRunner,
  root: Object3D,
  host: BindContextHost,
  def: MaterialFlowDefinition,
): BoundInstance | null {
  const accum: KinematicsSpec = {};
  const { ctx, handle } = createBindContext(root, host, accum);

  // Forward-reference the adapter so the scheduler/transfer can read its
  // entityId once the runner has assigned one.
  let adapter: MaterialFlowAdapter;

  // For a source, reuse the engine RVSource (if present) to clone a real MU mesh
  // per generated MU, so the DES MU has a `visual` the tween registry animates.
  const engineSource = def.kind === 'source' ? engineSourceFor(root) : null;
  // plan-638: template size of the last `ready` pose pre-check - the NEXT
  // spawned MU (the pose MU) gets exactly this size, so pre-check and MU agree.
  // Consumed by that spawn; the standard path never arms it.
  let poseSpawnSize: readonly [number, number, number] | null = null;
  // plan-2059: a snapshot stores the template id of every MU, so it must be reload-stable —
  // the DES component id (plan-769 address), the per-load three uuid only for unaddressed hosts.
  const templateAddresses = (host as { desAddresses?: DesAddressSource | null }).desAddresses
    ?? (host as { registry?: DesAddressSource | null }).registry ?? null;
  const sourceTemplateId = engineSource
    ? `source:${desComponentIdForNode(templateAddresses, root, def.type) ?? root.uuid}` : undefined;

  // Template bug size, cached ONCE per source (plan-262 Phase 3). Visual MUs
  // used to measure it lazily per MU (identical result — the geometry is
  // constant per template); a HEADLESS MU (FastForward) has no visual to
  // measure, so BOTH now draw from this cache → identical bug offsets →
  // identical tween endpoints and ride times (the headless-vs-visual
  // determinism gate). Filled from the first spawned visual; a headless-first
  // run measures a one-off temporary clone (spawn → measure → dispose).
  let templateBugSize: readonly [number, number, number] | null = null;
  let templateBugMeasured = false;
  const templateBugSizeFor = (visual: unknown): readonly [number, number, number] | null => {
    if (!templateBugMeasured && engineSource) {
      let probe = visual as { node?: Object3D } | null;
      let temp: { node?: Object3D; dispose?: () => void } | null = null;
      if (!probe) {
        temp = engineSource.spawnMU(true) as { node?: Object3D; dispose?: () => void } | null;
        probe = temp;
      }
      templateBugSize = probe?.node ? measureMuVisualBugSize(probe.node) : null;
      temp?.dispose?.();
      templateBugMeasured = true;
    }
    return templateBugSize;
  };

  const self = createSelf(ctx, def, {
    mode: 'des',
    // plan-644 Phase 2.2: partner transport surfaces memoised per run.
    portCache: runner.portCacheScope,
    scheduler: runner.makeScheduler(def, () => adapter.entityId),
    // plan-2051: self.rng — lazy like entityId above; the adapter is assigned
    // below and gets its seeded RNG when the DES manager attaches it.
    rng: () => adapter.rng,
    rngFor: (purpose) => adapter.rngFor(purpose),
    onTransfer: (mu) => adapter.transferMU(mu as unknown as DESMU),
    // Statistics (Plan 201, both-modes): forward the canonical category a
    // component reports via `self.statState(...)` into the live DESComponent so the
    // discrete-event stats capture Working / Blocked / Empty / Setup — the same
    // categories the continuous StateStatistics books. The base handshake also auto-
    // tracks Empty/Blocked; DESComponent.setState is idempotent so they reinforce.
    onStatState: (name) => adapter.setState(name),
    onStatOutput: (n) => adapter.recordOutput(n),
    spawnMU: (visualTemplateId) => {
      const mu = runner.createMU(visualTemplateId ?? sourceTemplateId);
      if (engineSource) {
        // plan-262 Phase 3: in FastForward MUs spawn HEADLESS (no mesh clone —
        // visual stays null); they are materialised on FastForward exit
        // (DESRunner.setSubMode → _materializeHeadlessMUs).
        if (!runner.headlessSpawnActive && !mu.visual) {
          // RVMovingUnit | InstancedMovingUnit | null — the DESMU.visual slot.
          (mu as unknown as { visual: unknown }).visual = engineSource.spawnMU(true);
        }
        if (poseSpawnSize) {
          // plan-638 (Gate R3-1): the pose MU takes the template size its
          // pre-check used (`templateSize()`); the cache is not consulted.
          presetMuBugSize(mu as unknown as MU, poseSpawnSize);
          poseSpawnSize = null;
        } else {
          // Pre-set the bug size from the per-template cache for BOTH paths, so
          // headless and visual MUs deliver identical bug offsets (determinism).
          presetMuBugSize(
            mu as unknown as MU,
            templateBugSizeFor((mu as unknown as { visual?: unknown }).visual ?? null),
          );
        }
      }
      return mu;
    },
    // Downstream-acceptance probe (Plan 194 §2.5): query the resolved downstream
    // adapter's handshake. `port` (router) selects the partner by its ownerRoot;
    // otherwise the first downstream is used. nextComponents is wired by
    // wireTopology() after all instances exist, so this resolves at sim time.
    //
    // SOURCE loop-saturation guard: a closed loop has no sink, so a source that
    // keeps generating fills every zone and DEADLOCKS at 100% (M = N: no MU can
    // move because nothing is free). Gate source generation on a safe fill level
    // (≤ ~70% of the conveyor zones) so free zones always remain for circulation.
    // Open lines and cycles with a reachable sink are not throttled.
    canAcceptDownstream: (mu, port) => {
      if (def.kind === 'source' && loopSaturated(adapter)) return false;
      return downstreamCanAccept(adapter, mu, port);
    },
    // plan-638: a source lying on its belt (`contained` link) hands over at its
    // spawn pose. Every source gets the backend; without a contained target it
    // answers `not-contained` and the source keeps its standard path.
    poseTransfer: def.kind === 'source'
      ? makePoseBackend(runner, () => adapter, root, engineSource, (size) => { poseSpawnSize = size; })
      : null,
    mus: () => adapter.heldMUs as unknown as ReadonlyArray<MU>,
    reservedLoad: () => adapter.reservedLoad,
    downstreamFreeCapacity: (port) => adapter.downstreamFreeCapacity(port),
    reserveDownstream: (n, port, carrier) => adapter.reserveDownstream(n, port, carrier),
    reservation: (id) => adapter.reservation(id),
    // Seed the typed per-instance state slot from the def's own factory so the
    // shared setup() can resolve nodes/handles/flags into it (same slot the
    // continuous shim builds via toBehavior). `state` is the preferred inline
    // factory (Plan 197 §2.4b-C); `local` is the fallback — same reconciliation
    // as the library-component factory.
    local: (() => { const make = def.state ?? def.local; return make ? make() : undefined; })(),
  });

  // Seed timing/config from rv_extras BEFORE def.setup runs (setup reads prop).
  seedConfig(self, def, root);
  const capacity = Number(self.prop.MaxCapacity ?? 1);
  if (def.kind !== 'sink' && (!Number.isInteger(capacity) || capacity <= 0)) {
    const path = NodeRegistry.computeNodePath(root) || root.name || root.uuid;
    reportProblem({ id: `${INVALID_CAPACITY_PROBLEM_CODE}:${root.uuid}:${def.type}`,
      severity: 'warning', code: INVALID_CAPACITY_PROBLEM_CODE, title: 'Invalid DES capacity',
      detail: `MaxCapacity for '${path}' must be a positive integer (got ${capacity}).`, nodePath: path });
    handle.dispose();
    return null;
  }
  if (def.muVisualTemplateProperties) {
    registerMuVisualTemplateFactories(runner, root, self, def.muVisualTemplateProperties);
  }
  if (engineSource && sourceTemplateId) {
    runner.registerMuVisualFactory(
      sourceTemplateId,
      () => engineSource.spawnMU(true) as ReturnType<DESRunner['createMuVisual']>,
      (visual) => { visual.dispose(); },
    );
  }

  // Scene-discovered: `rebindScene()` disposes the bind context and releases the
  // declared names no rebound instance declares again (plan-612 CP1d-b).
  // plan-2059 Phase 1: the DES component id — plan-769 address + '@' + type.
  // `desAddresses` overrides the address source (headless/test hosts without a NodeRegistry).
  const registry = (host as { desAddresses?: DesAddressSource | null }).desAddresses
    ?? (host as { registry?: DesAddressSource | null }).registry ?? null;
  const desId = desComponentIdForNode(registry, root, def.type);
  adapter = runner.addInstance(def, self, root, {
    dispose: () => { handle.dispose(); if (desId) runner.getManager().releaseStreams(desId); },
    signals: (accum.signals ?? []).map((s) => s.name),
  }, { desId });
  adapter.desId = desId;
  if (def.kind !== 'sink') {
    adapter.reconfigureCapacity(capacity);
  }
  return { root, self, adapter };
}

/**
 * Wire each instance's native DES `nextComponents` / `previousComponents` from
 * the core resolver's links (plan-633 Phase 2). The resolver is pure; this pass
 * only APPLIES its ordered link list, which reproduces the wiring order the
 * binding always had:
 *
 *   1. snap links (partner root → instance), roles decided once by the core's
 *      `portRoleOf` — the old `self.outputs()` classification;
 *   2. the conflict rule on snap 2-cycles (the old `breakTwoCycles` rule, now
 *      applied at classification, Gate R2-3);
 *   3. the typed distance fallback (plan-225) for instances still without a
 *      downstream.
 *
 * The link flag `contained` (distance 0: the source lies inside the target's
 * AABB) is recorded for plan-638; the hand-over itself is UNCHANGED here.
 *
 * `breakTwoCycles` stays as a GUARD on the applied graph: it must break 0 links
 * (a non-zero count means the resolver produced a 2-cycle — logged as a warning).
 * The guard runs under `import.meta.env.DEV` only (dev server, tests); a
 * production build reports `guardBroken: 0` (plan-644 D4).
 */
function wireTopology(
  bound: BoundInstance[],
  host: BindContextHost,
  registry: SnapPointRegistry | null,
  headless: boolean,
): WireTopologyStats {
  const byRoot = new Map<Object3D, BoundInstance>();
  for (const b of bound) byRoot.set(b.root, b);

  const compReg = (host as { registry?: unknown }).registry as Partial<SurfaceComponentRegistry> | null | undefined;
  const surfacesOf = compReg && typeof compReg.findInChildren === 'function'
    ? surfacesFromComponentRegistry(compReg as SurfaceComponentRegistry)
    : undefined;

  const connectables: Connectable[] = bound.map(b => ({
    root: b.root,
    kind: b.adapter.def.kind ?? '',
    connectionType: 'material-flow',
    autoConnect: b.adapter.autoConnect,
    existingNext: b.adapter.nextComponents.length > 0
      ? b.adapter.nextComponents.map(c => c.node)
      : undefined,
  }));

  const result = resolveConnectionsDetailed(connectables, { registry, surfacesOf });

  // Order as before: snap links → 2-cycle guard → distance links. The guard
  // inspects the SNAP graph only (a distance link may legitimately close a
  // 2-cycle with a snap link, exactly as the old pass 2 did after the breaker).
  for (const link of result.links) if (link.via === 'snap') applyLink(byRoot, link);

  // Guard (plan-633 F3): the resolver settles snap 2-cycles at classification
  // (Gate R2-3), so the breaker must find nothing here. DEV + tests only
  // (plan-644 D4): a production build skips the pass and reports 0.
  let guardBroken = 0;
  if (import.meta.env.DEV) {
    const guard: ConnectableInstance[] = bound.map(b => ({
      root: b.root,
      adapter: b.adapter,
      kind: b.adapter.def.kind ?? '',
      connectionType: 'material-flow',
    }));
    guardBroken = breakTwoCycles(guard);
    if (guardBroken > 0) {
      console.warn(`[des-binding] 2-cycle guard broke ${guardBroken} snap link(s) the resolver produced (expected 0).`);
    }
  }

  for (const link of result.links) if (link.via === 'distance') applyLink(byRoot, link);

  if (result.conflictsResolved > 0) {
    console.info(`[des-binding] broke ${result.conflictsResolved} bidirectional 2-cycle(s) from the snap graph.`);
  }
  if (result.distanceLinks > 0) {
    console.info(`[des-binding] auto-connected ${result.distanceLinks} material-flow link(s) by distance.`);
  }
  lastWireStats = {
    links: result.links.length,
    conflictsResolved: result.conflictsResolved,
    distanceLinks: result.distanceLinks,
    guardBroken,
    headlessRegistry: headless,
    // The binding builds a headless registry exactly when no snap-point plugin
    // is present (`acquireBindingConnectionRegistry`).
    pluginPresent: !headless,
  };
  return lastWireStats;
}

/** Apply one resolver link to the native DES graph (bidirectional, no duplicates). */
function applyLink(byRoot: Map<Object3D, BoundInstance>, link: ConnectionLink): void {
  const from = byRoot.get(link.from);
  const to = byRoot.get(link.to);
  if (!from || !to || from === to) return;
  if (!from.adapter.nextComponents.includes(to.adapter)) {
    from.adapter.nextComponents.push(to.adapter);
  }
  if (!to.adapter.previousComponents.includes(from.adapter)) {
    to.adapter.previousComponents.push(from.adapter);
  }
  // plan-638: the source pose backend resolves its target through this.
  if (link.contained || spawnsInside(from, to, link)) containedLinks.set(from.adapter, to.adapter);
}

const _containBox = new Box3();
const _spawnOrigin = new Vector3();

/**
 * plan-638: a SOURCE whose spawn point (the world origin of its node, where
 * `RVSource` puts the MU origin) lies inside its distance target's world AABB
 * spawns ON that target, even when its bounds CENTRE does not (the resolver's
 * `contained` metric). A loaded pallet on a roller conveyor is the case: its
 * centre is ~0.2 m above the roller top and can stick out of the conveyor's
 * AABB, its origin (the underside) sits on the rollers. Only the flag the pose
 * backend reads changes; the link itself (distance, order) is the resolver's.
 */
function spawnsInside(from: BoundInstance, to: BoundInstance, link: ConnectionLink): boolean {
  if (link.via !== 'distance' || (from.adapter.def.kind ?? '') !== 'source') return false;
  to.root.updateWorldMatrix(true, true);
  _containBox.makeEmpty().expandByObject(to.root);
  if (_containBox.isEmpty()) return false;
  from.root.updateWorldMatrix(true, false);
  return _containBox.containsPoint(from.root.getWorldPosition(_spawnOrigin));
}

/** Counters of the last `wireTopology` pass (diagnostics + plan-633 parity tests). */
export interface WireTopologyStats {
  /** Links the resolver returned (snap + distance). */
  readonly links: number;
  /** Snap 2-cycles settled by the conflict rule (what the old breaker counted). */
  readonly conflictsResolved: number;
  /** Links created by the typed distance fallback. */
  readonly distanceLinks: number;
  /** Links the `breakTwoCycles` guard removed afterwards — must be 0. Always 0 in a
   *  production build, where the guard does not run (plan-644 D4). */
  readonly guardBroken: number;
  /** The binding resolved against its own headless snap registry. */
  readonly headlessRegistry: boolean;
  /** A snap-point plugin was present (planner registry used as is). */
  readonly pluginPresent: boolean;
}

let lastWireStats: WireTopologyStats | null = null;

/** Counters of the most recent topology pass, or null before the first bind. */
export function getLastWireTopologyStats(): WireTopologyStats | null {
  return lastWireStats;
}

/**
 * `contained` links (distance 0: the source lies inside its target's AABB),
 * keyed by the emitting adapter. Read by the source pose backend (plan-638):
 * a source with a contained target hands over at its spawn pose.
 */
const containedLinks = new WeakMap<MaterialFlowAdapter, MaterialFlowAdapter>();

/** The downstream an adapter reaches through a `contained` link, if any. */
export function containedTargetOf(adapter: MaterialFlowAdapter): MaterialFlowAdapter | null {
  return containedLinks.get(adapter) ?? null;
}
