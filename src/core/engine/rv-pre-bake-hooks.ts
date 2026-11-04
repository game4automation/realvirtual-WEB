// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-pre-bake-hooks.ts — the built-in {@link PreBakeHook}s (plan-754 D18).
 *
 * Each hook replaces a loader phase that used to run on CONSTRUCTED components
 * and therefore forced the bake to come last. Expressed from extras alone they
 * move ahead of the bake, which is what makes `bake()` a pure function of
 * (GLB, capability table, plugin claims) — see the `prepare` step of
 * rv-pre-bake.ts.
 *
 * | type             | does                                            | replaces           |
 * |------------------|-------------------------------------------------|--------------------|
 * | `Drive`          | stamps the AUTHORED home pose into `userData`    | Phase 8a           |
 * | `Group`          | stamps resolved group names as partition labels  | — (plan-755)       |
 * | `Kinematic`      | group + parent re-parenting, once per tree       | Phase 8b           |
 * | `Sensor`         | beam from the `Ray` child or own source bounds   | init `autoConfigureRay` |
 * | `MachiningVolume`| `Shape: 'Mesh'` → keep its own stock geometry    | init voxelize      |
 * | `RibbonPath`     | marks the `Material` DONOR node `keep`           | init donor read    |
 * | `TransportSurface` | roller-mantle speed groups + figures (plan-675) | —                  |
 *
 * THE RULE (R2b): extras in, extras-or-tree out. No hook here resolves another
 * component, reads a signal, touches the viewer, or keeps a reference to
 * anything it saw. `tests/bake-pre-bake-hooks.test.ts` lints this module's
 * import list for runtime-instance APIs.
 *
 * `MechanismBody` (mass / centre of mass from the mesh) has no hook: the
 * component does not exist in the public engine. When it lands, its hook
 * belongs here.
 */

import type { Object3D } from 'three';
import {
  registerPreBakeHook,
  RV_BAKE_ROLE_KEY,
  type PreBakeContext,
} from './rv-component-registry';
import { storedReferenceLabel, storedReferenceValue } from './rv-node-path-rewrite.mjs';
import { NodeRegistry } from './rv-node-registry';
import { registerPartitionExtras, RV_PARTITION_KEY } from './rv-bake-chunk';
import { computeBeamFromBounds, computeSensorLocalBox, findRayChild } from './rv-sensor';
import { prepareRollerSpin } from './rv-roller-spin';
// The TransportSurface capability registration must exist before its hook is
// attached (`registerCapabilities()` would rebuild the type and drop it) —
// the same reason the Sensor hook's module is imported above.
import './rv-transport-surface';
import {
  RV_DRIVE_HOME_KEY,
  RV_SENSOR_BEAM_KEY,
  RV_SENSOR_BOX_KEY,
  type DriveHomePose,
  type PreBakedSensorBeam,
} from './rv-pre-bake-keys';

export { RV_DRIVE_HOME_KEY, RV_SENSOR_BEAM_KEY };

// ─── Drive (Phase 8a) ────────────────────────────────────────────────

/**
 * Phase 8a used to drive every axis back to its authored base pose because
 * behaviour `init()` had already moved some of them BEFORE the bake. In the
 * pipeline order nothing has been constructed yet, so the node's own TRS IS the
 * home pose — the hook's job is to make that explicit and durable: the pose is
 * stamped as plain data, travels into the template with the JSON-cloned
 * `userData`, and `RVDrive.initDrive()` prefers it over the live transform.
 * That closes the one remaining gap: the kinematic hook below may `attach()` a
 * drive node into a new parent, which rewrites its local TRS.
 */
function onPreBakeDrive(node: Object3D): void {
  const home: DriveHomePose = {
    p: [node.position.x, node.position.y, node.position.z],
    q: [node.quaternion.x, node.quaternion.y, node.quaternion.z, node.quaternion.w],
    s: [node.scale.x, node.scale.y, node.scale.z],
  };
  node.userData[RV_DRIVE_HOME_KEY] = home;
}

// ─── Kinematic / Group (Phase 8b) ────────────────────────────────────

/** Trees whose kinematic pass already ran in this `prepare` (once per tree). */
const _kinematicDone = new WeakSet<Object3D>();

/** Reset the once-per-tree guard (test-only). */
export function _resetKinematicPreBakeForTesting(): void {
  // A WeakSet cannot be cleared; tests use a fresh root, which is the natural key.
}

interface GroupMembers {
  /** Resolved group name → member nodes, in traversal order. */
  byName: Map<string, Object3D[]>;
}

/** Collect `Group` / `Group_N` membership from extras — the `buildGroups` rule. */
function collectGroups(root: Object3D, ctx: PreBakeContext): GroupMembers {
  const byName = new Map<string, Object3D[]>();
  root.traverse((node) => {
    const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
    if (!rv) return;
    for (const key of Object.keys(rv)) {
      if (key !== 'Group' && !/^Group_\d+$/.test(key)) continue;
      const data = rv[key] as Record<string, unknown> | undefined;
      if (!data || data['_enabled'] === false) continue;
      const groupName = data['GroupName'] as string | undefined;
      if (!groupName) continue;
      const resolved = resolveGroupName(groupName, data['GroupNamePrefix'], ctx);
      let list = byName.get(resolved);
      if (!list) byName.set(resolved, (list = []));
      list.push(node);
    }
  });
  return { byName };
}

/** `GroupNamePrefix` resolves to a NODE whose NAME is prepended (Unity parity). */
function resolveGroupName(groupName: string, prefixRef: unknown, ctx: PreBakeContext): string {
  const prefixPath = typeof prefixRef === 'string'
    ? prefixRef
    : (prefixRef as { path?: string } | undefined)?.path;
  if (!prefixPath) return groupName;
  const prefixNode = ctx.resolvePath(prefixPath);
  return prefixNode ? prefixNode.name + groupName : groupName;
}

/** Is this extras key a `Group` block (`Group`, `Group_1`, …)? */
const isGroupKey = (key: string): boolean => key === 'Group' || /^Group_\d+$/.test(key);

/**
 * plan-755 — `Group` as the PARTITION KEY of a chunk (Unity
 * `MeshCombiner.CombineByGroups` parity). The hook turns every enabled `Group`
 * block of the node into a resolved name and stamps the deduplicated list as
 * `userData._rvPartition` — the generic label contract the bake reads
 * ({@link RV_PARTITION_KEY}); the bake never learns that a label is a group.
 *
 * Same membership rule as `buildGroups` / {@link collectGroups}: `_enabled:
 * false` and an empty `GroupName` stamp nothing (D10), `GroupNamePrefix`
 * resolves to the prefix NODE's name (D6) — resolved HERE, on `tmp`, because
 * the partition object the bake creates carries the resolved name and no
 * prefix reference.
 *
 * Called once per node (the dispatcher folds `Group_N` onto `Group`), with the
 * node's full extras. Order against the `Kinematic` hook does not matter: the
 * stamp is node-local plain data and travels with `attach()`.
 */
function onPreBakeGroup(node: Object3D, extras: Record<string, unknown>, ctx: PreBakeContext): void {
  let labels: string[] | null = null;
  for (const key of Object.keys(extras)) {
    if (!isGroupKey(key)) continue;
    const data = extras[key] as Record<string, unknown> | undefined;
    if (!data || typeof data !== 'object' || data['_enabled'] === false) continue;
    const groupName = data['GroupName'];
    if (typeof groupName !== 'string' || !groupName) continue;
    const resolved = resolveGroupName(groupName, data['GroupNamePrefix'], ctx);
    if (!labels) labels = [];
    if (!labels.includes(resolved)) labels.push(resolved);
  }
  if (labels) node.userData[RV_PARTITION_KEY] = labels;
}

/**
 * What a partition object carries (plan-755 D6): one `Group` block per label —
 * `Group`, `Group_1`, … in label order — with the RESOLVED name and no prefix
 * reference. That is the exact shape of a Unity pre-combined object
 * (`CNCCase|CNCDoor` in DemoRealvirtualWeb), so the load traversal collects it
 * and `buildGroups` registers it as a member without knowing it is synthetic.
 */
function groupExtrasOfPartition(labels: readonly string[]): Record<string, unknown> | null {
  if (labels.length === 0) return null;
  const extras: Record<string, unknown> = {};
  labels.forEach((label, i) => { extras[i === 0 ? 'Group' : 'Group_' + i] = { GroupName: label }; });
  return extras;
}

/**
 * Phase 8b as a hook. Runs ONCE per tree (the first `Kinematic` node it is
 * called for does the whole pass), so the group index is complete before
 * anything moves and the result cannot depend on traversal order.
 *
 * This is the ONE re-parent mechanism (plan-757 Phase 3 commit B deleted the
 * runtime pass of the init, `applyKinematicParenting`). Differences to that
 * deleted pass, all of them consequences of running BEFORE component
 * construction rather than after it:
 *  - no `Drive.refreshBaseTransform()` pass — no drive instance exists, and the
 *    `initDrive()` that runs later captures the POST-move transform anyway,
 *    which is exactly what the refresh used to restore;
 *  - the moved subtrees are reported through `ctx.notifyReparented`, so the
 *    recipe can put the AUTHORED path on the asset's alias table (D4) and the
 *    place step registers it per instance (the old Phase 8c did that from the
 *    recomputed remap).
 */
function onPreBakeKinematic(_node: Object3D, _extras: Record<string, unknown>, ctx: PreBakeContext): void {
  const root = ctx.root;
  if (_kinematicDone.has(root)) return;
  _kinematicDone.add(root);

  const groups = collectGroups(root, ctx);
  const kinematicNodes: Array<{ node: Object3D; data: Record<string, unknown> }> = [];
  root.traverse((node) => {
    const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
    const data = rv?.['Kinematic'] as Record<string, unknown> | undefined;
    if (!data) return;
    const integrateGroup = data['IntegrateGroupEnable'] === true;
    const kinParent = data['KinematicParentEnable'] === true;
    if (kinParent || (integrateGroup && data['GroupName'])) kinematicNodes.push({ node, data });
  });
  if (kinematicNodes.length === 0) return;

  const affected: Object3D[] = [];

  // Pass 1 — IntegrateGroupEnable: group members move under the axis node.
  for (const { node: kinNode, data } of kinematicNodes) {
    if (data['IntegrateGroupEnable'] !== true) continue;
    const groupName = (data['GroupName'] as string | undefined) ?? '';
    if (!groupName) continue;
    const resolved = resolveGroupName(groupName, data['GroupNamePrefix'], ctx);
    const members = groups.byName.get(resolved);
    if (!members || members.length === 0) continue;

    const simplify = data['SimplifyHierarchy'] === true;
    const candidates = simplify
      ? members.filter((n) => (n as { isMesh?: boolean }).isMesh === true)
      : [...members];
    // Unity `GetAllWithGroup`: only TOP-LEVEL members move; a member below
    // another member travels with its parent.
    const memberSet = new Set(members);
    for (const member of candidates) {
      let ancestorInGroup = false;
      for (let c = member.parent; c; c = c.parent) {
        if (memberSet.has(c)) { ancestorInGroup = true; break; }
      }
      if (ancestorInGroup) continue;
      if (member === kinNode || isAncestorOf(member, kinNode)) continue;
      const previousPath = NodeRegistry.computeNodePath(member);
      kinNode.attach(member);
      ctx.notifyReparented(member, previousPath);
      affected.push(member);
    }
    affected.push(kinNode);
  }

  // Pass 2 — KinematicParentEnable: the axis node itself moves under `Parent`.
  for (const { node: kinNode, data } of kinematicNodes) {
    if (data['KinematicParentEnable'] !== true) continue;
    // plan-769 Phase 1b / 3: `Parent` is a stored path field — the file's verdict
    // (by id, independent of pass 1's moves), never a guessing stage; a path, a
    // `{ path }` record, or (web-saved) an `{ address }` / `{ unresolvedPath }`.
    const parentValue = storedReferenceValue(data['Parent']);
    if (parentValue === null) continue;
    const parentNode = ctx.resolveStored
      ? ctx.resolveStored(parentValue)
      : (typeof parentValue === 'string' ? ctx.resolvePath(parentValue) : null);
    if (!parentNode || parentNode === kinNode || isAncestorOf(kinNode, parentNode)) continue;
    const previousPath = NodeRegistry.computeNodePath(kinNode);
    parentNode.attach(kinNode);
    ctx.notifyReparented(kinNode, previousPath);
    affected.push(kinNode);
  }

  // A moved subtree is dynamic by definition: `processMeshes` classified it
  // against the AUTHORED parent chain, where no drive was an ancestor.
  for (const subtree of affected) {
    subtree.traverse((child) => { child.matrixAutoUpdate = true; });
  }
  root.updateMatrixWorld(true);
}

/** Is `maybeAncestor` anywhere above `node`? Guards against a re-parent cycle. */
function isAncestorOf(maybeAncestor: Object3D, node: Object3D): boolean {
  for (let c: Object3D | null = node.parent; c; c = c.parent) {
    if (c === maybeAncestor) return true;
  }
  return false;
}

// ─── Sensor (init-time `autoConfigureRay`) ───────────────────────────

/**
 * A convention sensor derives its beam from the longest edge of its own source
 * bounds when it has no `Ray` marker child. Those source meshes are merged into
 * a chunk by the destructive bake, so the derivation has to happen here. The
 * result is plain data in `userData`; `RVSensor.autoConfigureRay()` prefers it
 * and falls back to the live geometry walk when it is absent (every non-baking
 * load).
 */
function onPreBakeSensor(node: Object3D, extras: Record<string, unknown>): void {
  const cfg = extras['Sensor'] as Record<string, unknown> | undefined;
  if (!cfg) return;
  if (node.userData?.realvirtual?.BoxCollider || hasBoxCollider(extras)) return;
  // plan-655 B1: a COLLISION sensor's box comes from its own meshes — which the
  // bake merges into a chunk, leaving the loader's `AABB.fromNode` an empty box
  // at the node origin (the SolidCraft sensor beam never became occupied). The
  // node-local box is stamped here while the meshes are still there.
  const box = computeSensorLocalBox(node);
  if (box) node.userData[RV_SENSOR_BOX_KEY] = box;
  // Same gate as `RVSensor.init()`: only convention sensors auto-configure.
  if (cfg['AutoRay'] === false) return;
  const beam = computeBeamFromBounds(node, findRayChild(node));
  if (!beam) return;
  const stored: PreBakedSensorBeam = {
    originOffset: [beam.originOffset.x, beam.originOffset.y, beam.originOffset.z],
    direction: beam.direction,
    lengthMm: beam.lengthMm,
  };
  node.userData[RV_SENSOR_BEAM_KEY] = stored;
}

/** `colliders[]` entries carry the authored BoxCollider a sensor prefers. */
function hasBoxCollider(extras: Record<string, unknown>): boolean {
  const colliders = extras['colliders'];
  if (!Array.isArray(colliders)) return false;
  for (const c of colliders) {
    const t = (c as { type?: unknown } | null)?.type;
    if (t === 'BoxCollider') return true;
  }
  return false;
}

// ─── TransportSurface — animated roller mantle (plan-675) ────────────

/**
 * plan-675 Phase 3 (SOL R2-1/R2-3): measure the rollers that wear an animated
 * mantle, canonicalise their U, split them into speed groups (one material
 * each — the dedup fingerprint keeps groups apart) and leave the per-group
 * figures as plain data on THIS surface node. Tree in, tree + extras out; the
 * binding happens at runtime (`rv-roller-spin.ts`).
 */
function onPreBakeTransportSurface(node: Object3D, extras: Record<string, unknown>, ctx: PreBakeContext): void {
  const key = Object.keys(extras).find((k) => k === 'TransportSurface' || /^TransportSurface_\d+$/.test(k));
  const cfg = key ? extras[key] as Record<string, unknown> | undefined : undefined;
  if (!cfg) return;
  prepareRollerSpin(ctx.root, node, cfg);
}

// ─── MachiningVolume / RibbonPath — the authored-override route ──────

/**
 * Two components read a SOURCE MESH at init: a `Shape: 'Mesh'` machining stock
 * voxelizes its own render geometry, and a `RibbonPath` copies the material of
 * the node its `Material` reference points at. D7 forbids a reference from
 * claiming `keep` for its target, and names the sanctioned fallback: an
 * authored `rv.BakeRole` on the node itself. Both hooks write exactly that —
 * plain data on `tmp`, read by `bakeRoleOf` a few milliseconds later — so the
 * mesh survives the bake untouched and NEITHER component needs an init change.
 */
function onPreBakeMachiningVolume(node: Object3D, extras: Record<string, unknown>): void {
  const cfg = extras['MachiningVolume'] as Record<string, unknown> | undefined;
  if (!cfg || cfg['Shape'] !== 'Mesh') return;
  markKeep(node);
}

function onPreBakeRibbonPath(node: Object3D, extras: Record<string, unknown>, ctx: PreBakeContext): void {
  const cfg = extras['RibbonPath'] as Record<string, unknown> | undefined;
  if (!cfg) return;
  // Any stored form (plan-769 Phase 3): a path, a ComponentReference, an address.
  const stored = storedReferenceValue(cfg['Material']);
  const materialName = typeof cfg['MaterialName'] === 'string' ? (cfg['MaterialName'] as string) : '';
  if (stored === null) return;
  // A stored reference (plan-769 Phase 1b): the file's verdict first.
  const donor = ctx.resolveStored
    ? ctx.resolveStored(stored)
    : (typeof stored === 'string' ? ctx.resolvePath(stored) : null);
  if (!donor) return;

  const mesh = donor as { isMesh?: boolean; material?: unknown };
  const single = mesh.isMesh && mesh.material && !Array.isArray(mesh.material)
    ? (mesh.material as import('three').Material)
    : null;
  // Also hand the material to the template table, so a future template-only
  // consumer can find it without walking the graph. Under the AUTHORED name
  // too when there is one — that is the key the runtime asks for (plan-496).
  if (single) {
    ctx.keepMaterial(storedReferenceLabel(cfg['Material']) ?? '', single);
    if (materialName) ctx.keepMaterial(materialName, single);
  }

  // plan-496: a `_MaterialDonor` node is what the Unity GLB exporter adds so the
  // library material reaches the document at all — UnityGLTF exports only
  // materials that sit on a renderer, and a band mesh does not exist while
  // authoring. Its geometry is a 1 mm quad nobody wants to see or click, and
  // nothing needs it once the document material index has been taken (that
  // happens BEFORE this hook runs — `prepareAndBake` step 1). So the donor is
  // REMOVED from the tree, and with it the reference that would otherwise keep
  // it alive as a reference target: no chunk, no draw call, no pick target, and
  // nothing dangling. `visible = false` first, so the kill-switch path (static
  // mesh batching off, no bake at all) also never draws it.
  if (isMaterialDonor(donor)) {
    donor.visible = false;
    donor.removeFromParent();
    delete cfg['Material'];
    return;
  }

  markKeep(donor);
  void node;
}

/** Node name suffix the Unity GLB export gives its temporary material donors. */
export const MATERIAL_DONOR_SUFFIX = '_MaterialDonor';

/** True for a donor node the Unity exporter created (plan-496 F7). */
function isMaterialDonor(node: Object3D): boolean {
  return typeof node.name === 'string' && node.name.endsWith(MATERIAL_DONOR_SUFFIX);
}

/** Stamp the authored `keep` override on a node (idempotent, plain data). */
function markKeep(node: Object3D): void {
  const ud = (node.userData ??= {});
  const rv = (ud.realvirtual ??= {}) as Record<string, unknown>;
  rv[RV_BAKE_ROLE_KEY] = 'keep';
}

// ─── Registration ────────────────────────────────────────────────────

let _registered = false;

/**
 * Install the built-in hooks. Idempotent and called from the loader module's
 * top level, next to the other capability registrations, so every entry point
 * that can bake has them.
 */
export function registerBuiltInPreBakeHooks(): void {
  if (_registered) return;
  _registered = true;
  registerPreBakeHook('Drive', onPreBakeDrive);
  // plan-755: AFTER the `Group` schema/capability registration (module top of
  // rv-group-component.ts) — `registerCapabilities()` rebuilds a type from the
  // defaults and would drop a hook attached before it.
  registerPreBakeHook('Group', onPreBakeGroup);
  registerPartitionExtras(groupExtrasOfPartition);
  registerPreBakeHook('Kinematic', onPreBakeKinematic);
  registerPreBakeHook('Sensor', onPreBakeSensor);
  registerPreBakeHook('MachiningVolume', onPreBakeMachiningVolume);
  registerPreBakeHook('RibbonPath', onPreBakeRibbonPath);
  registerPreBakeHook('TransportSurface', onPreBakeTransportSurface);
}

/** Re-install after `_resetCapabilitiesForTesting()` cleared the map (test-only). */
export function _reinstallPreBakeHooksForTesting(): void {
  _registered = false;
  registerBuiltInPreBakeHooks();
}
