// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mu-manipulation.ts — taking a workpiece carrier off the line by hand, or
 * putting it somewhere else (plan-567).
 *
 * The engine primitives behind the Commissioning interaction (Delete key,
 * context menu, drag) and the MCP tools `web_mu_delete` / `web_mu_move`:
 *
 *  - {@link deleteMU} — the carrier AND its passive load tree leave the
 *    simulation: connection holds released (belt-stop refcount included),
 *    flow-ledger bookings struck, grips / zones / GripTargets / sensors
 *    notified, then `removeMU` (not counted as consumed) and a detection
 *    refresh so a paused line shows the freed sensor at once. A pre-placed
 *    carrier keeps its snapshot — a simulation reset brings it back.
 *  - {@link placeMUOnSurface} — teleport onto a transport surface: collider
 *    bottom on the surface top, yaw kept, optional centre-line snap, a
 *    placement check that excludes the carrier's own load tree and counts held
 *    and passive MUs, then the full transport-state reset `restoreFromSnapshot`
 *    does, re-index and detection refresh. A refusal changes NOTHING.
 *  - {@link beginUserDrag} / {@link previewUserDrag} / {@link cancelUserDrag} /
 *    {@link commitUserDrag} — the drag gesture on the shared hold kernel
 *    (`holdMU` with owner `'user'`). The GripTarget the carrier sat on stays
 *    reserved for it during the gesture (SOL R2-1); a cancel puts owner,
 *    parent, surface state and pose back; a commit is "cancel, then place", so
 *    a refused drop leaves the carrier exactly where it was.
 *
 * Scope decision (SOL #6/7): only clone and pre-placed carriers are
 * manipulable — an instanced (pooled) carrier has no node of its own.
 * Physics-owned carriers are refused (SOL #4). Every refusal is a reason
 * string, the same text the UI shows and the MCP tool returns.
 */

import { Quaternion, Vector3 } from 'three';
import type { Object3D } from 'three';
import type { RVMovingUnit, InstancedMovingUnit, MuHolder } from './rv-mu';
import type { RVTransportManager } from './rv-transport-manager';
import type { RVTransportSurface } from './rv-transport-surface';
import type { RVGripTarget } from './rv-grip-target';
import { holdMU, detachMU, sceneRootOf } from './rv-mu-hold';
import { LOAD_OVERLAP_EPS } from './rv-mu-load';
import { getConnectionHolds, type HoldMode } from './rv-connection-hold';
import { forgetMuInFlowLedgers } from '../sdk/rv-sdk-flow';
import { isPhysicsOwned } from './rv-mu-owner';

type AnyMU = RVMovingUnit | InstancedMovingUnit;

// ─── Reasons (UI tooltip = MCP error) ───────────────────────────────────

export const REASON_POOLED = 'Pooled carriers cannot be moved or removed';
export const REASON_PHYSICS = 'This carrier is simulated by physics — it cannot be moved or removed by hand';
export const REASON_GONE = 'This carrier no longer exists';
export const REASON_NO_SURFACE = 'No transport surface at the drop point';
export const REASON_OCCUPIED = 'The drop position is occupied by another carrier';
export const REASON_SURFACE_MISS = 'The drop point is not on the given transport surface';

const HOLDER_TEXT: Readonly<Record<MuHolder, string>> = {
  grip: 'This carrier is held by a gripper',
  zone: 'This carrier is held by a zone',
  connection: 'This carrier is held at a station (StopOnExit)',
  user: 'This carrier is being moved by hand',
  pusher: 'This carrier is being pushed',
};

/** The refusal text for an MU held by `holder`. */
export function heldReason(holder: MuHolder): string {
  return HOLDER_TEXT[holder];
}

export interface Refusal { readonly ok: false; readonly reason: string }

const refuse = (reason: string): Refusal => ({ ok: false, reason });

// ─── Addressing ─────────────────────────────────────────────────────────

/** The carrier an MU rides on — itself when it is not a passive load (SOL #2). */
export function carrierOf(mu: RVMovingUnit): RVMovingUnit {
  let cur = mu;
  while (cur.loadedOn) cur = cur.loadedOn;
  return cur;
}

/** True when `mu` (a carrier) is simulated by `tm` right now. */
export function isLiveCarrier(tm: RVTransportManager, mu: AnyMU): boolean {
  return !mu.markedForRemoval && tm.hasMU(mu);
}

/**
 * Resolve an engine MU id to the carrier it addresses: a live active MU, or a
 * passive load of one (→ its carrier). Null for an unknown id.
 */
export function resolveCarrierById(tm: RVTransportManager, id: number): AnyMU | null {
  for (const mu of tm.mus) {
    if (mu.markedForRemoval) continue;
    if (mu.id === id) return mu;
    if (!mu.isInstanced) {
      const hit = findInTree(mu as RVMovingUnit, id);
      if (hit) return mu;
    }
  }
  return null;
}

function findInTree(root: RVMovingUnit, id: number): RVMovingUnit | null {
  const loads = root.loadedMus;
  for (let i = 0; i < loads.length; i++) {
    if (loads[i].id === id) return loads[i];
    const inner = findInTree(loads[i], id);
    if (inner) return inner;
  }
  return null;
}

/** Common precondition of every manipulation of `mu` (already a carrier). */
function checkManipulable(tm: RVTransportManager, mu: AnyMU): string | null {
  if (mu.isInstanced) return REASON_POOLED;
  if (!isLiveCarrier(tm, mu)) return REASON_GONE;
  if (isPhysicsOwned(mu)) return REASON_PHYSICS;
  return null;
}

/** Ids of `root` and every MU of its load tree, depth-first. */
function collectTreeIds(root: RVMovingUnit, out: number[]): number[] {
  out.push(root.id);
  for (let i = 0; i < root.loadedMus.length; i++) collectTreeIds(root.loadedMus[i], out);
  return out;
}

// ─── Delete ─────────────────────────────────────────────────────────────

export interface DeleteResult {
  readonly ok: true;
  /** Engine id of the removed carrier. */
  readonly id: number;
  readonly name: string;
  /** Ids of the carrier and of every load that went with it. */
  readonly removed: readonly number[];
  /** True for an authored carrier — a simulation reset brings it back. */
  readonly preplaced: boolean;
  /** The connection hold released for the carrier ('none' when it had none). */
  readonly releasedHold: HoldMode;
}

/**
 * Take `mu` — or, for a passive load, its carrier — off the line, with its
 * whole load tree (SOL #2). Works while paused: sensors and zones are
 * re-evaluated before returning (F3).
 */
export function deleteMU(tm: RVTransportManager, target: AnyMU): DeleteResult | Refusal {
  const mu = target.isInstanced ? target : carrierOf(target as RVMovingUnit);
  const why = checkManipulable(tm, mu);
  if (why) return refuse(why);
  const carrier = mu as RVMovingUnit;
  if (carrier.heldBy === 'user') return refuse(heldReason('user'));

  const ids = collectTreeIds(carrier, []);
  const holds = getConnectionHolds();
  // The carrier's own hold: a belt stop restarts the belt once its last
  // stopper is gone (refcount), a single-MU hold clears the owner tag.
  const releasedHold = holds.releaseForRemoval(carrier.id);
  for (const id of ids) {
    if (id !== carrier.id) holds.releaseForRemoval(id);
    forgetMuInFlowLedgers(id);
  }
  // Loads are not in `mus` — `removeMU` never sees them. Notify every observer
  // the per-MU dispose paths notify, without touching the tree structure: the
  // carrier's node takes the loads' nodes with it, and a pre-placed load is put
  // back from its snapshot by the next reset.
  releaseLoadTree(tm, carrier);

  const name = carrier.getName();
  const preplaced = carrier.preplaced;
  tm.removeMU(carrier, false);
  tm.refreshDetection();
  return { ok: true, id: carrier.id, name, removed: ids, preplaced, releasedHold };
}

function releaseLoadTree(tm: RVTransportManager, root: RVMovingUnit): void {
  const loads = root.loadedMus;
  for (let i = 0; i < loads.length; i++) {
    const load = loads[i];
    tm.notifyPhysicsMUDisposed(load);
    tm.muLifecycleHook?.onMURemoved(load);
    for (const grip of tm.grips) grip.onMUDisposed(load);
    for (const zone of tm.zones) zone.onMUDisposed(load);
    for (const t of tm.gripTargets) if (t.occupiedBy === load) t.clearOccupied();
    for (const s of tm.sensors) if (s.occupiedMU === load) s.occupiedMU = null;
    if (!load.preplaced) {
      load.dissolve?.dispose();
      load.dissolve = null;
      load.grow?.dispose();
      load.grow = null;
    }
    releaseLoadTree(tm, load);
  }
}

// ─── Placement check ────────────────────────────────────────────────────

/** Result of {@link checkPlacement} — reused by the drag preview (no GC). */
export interface PlacementCheck {
  ok: boolean;
  reason: string | null;
  surface: RVTransportSurface | null;
  /** World translation that puts the carrier at the target pose. */
  readonly delta: Vector3;
}

export function createPlacementCheck(): PlacementCheck {
  return { ok: false, reason: null, surface: null, delta: new Vector3() };
}

export interface PlaceOptions {
  /** Drop onto this surface; the point must lie on its footprint. Default: the topmost surface under the point. */
  surface?: RVTransportSurface | null;
  /** Remove the lateral offset (belt centre line). Default false. */
  snapToCenterLine?: boolean;
  /** Collision registry (plan-394) — its ancestor relation goes stale on a re-parent. */
  collision?: { invalidate(): void } | null;
}

/** Overlap tolerance: touching carriers (shared face) are not an overlap — the
 *  same inset the Grip's LoadOnCarrier place check uses (plan-577). */
const OVERLAP_EPS = LOAD_OVERLAP_EPS;
const _target = new Vector3();
const _minC = new Vector3();
const _maxC = new Vector3();

/** Topmost surface whose XZ footprint contains (x, z), or null. */
export function surfaceUnderXZ(surfaces: readonly RVTransportSurface[], x: number, z: number): RVTransportSurface | null {
  let best: RVTransportSurface | null = null;
  for (const s of surfaces) {
    s.aabb.update();
    const a = s.aabb;
    if (x < a.min.x || x > a.max.x || z < a.min.z || z > a.max.z) continue;
    if (!best || a.max.y > best.aabb.max.y) best = s;
  }
  return best;
}

function overlapsCandidate(other: AnyMU): boolean {
  const a = other.aabb;
  return a.min.x < _maxC.x - OVERLAP_EPS && a.max.x > _minC.x + OVERLAP_EPS
    && a.min.y < _maxC.y - OVERLAP_EPS && a.max.y > _minC.y + OVERLAP_EPS
    && a.min.z < _maxC.z - OVERLAP_EPS && a.max.z > _minC.z + OVERLAP_EPS;
}

function treeOverlaps(root: RVMovingUnit): boolean {
  const loads = root.loadedMus;
  for (let i = 0; i < loads.length; i++) {
    loads[i].updateAABB();
    if (overlapsCandidate(loads[i])) return true;
    if (treeOverlaps(loads[i])) return true;
  }
  return false;
}

/**
 * Would `mu` fit with its collider centre over `point`, its collider bottom on
 * the surface top? Checks the surface and the overlap with every OTHER live
 * carrier and its passive loads — held carriers included, the carrier's own
 * load tree excluded (SOL #5). Writes into `out`; mutates nothing.
 * `point` is not modified.
 */
export function checkPlacement(
  tm: RVTransportManager,
  mu: RVMovingUnit,
  point: Vector3,
  opts: PlaceOptions,
  out: PlacementCheck,
): PlacementCheck {
  out.ok = false;
  out.reason = null;
  out.surface = null;
  out.delta.set(0, 0, 0);
  _target.copy(point);
  let surface = opts.surface ?? null;
  if (surface) {
    surface.aabb.update();
    const a = surface.aabb;
    if (_target.x < a.min.x || _target.x > a.max.x || _target.z < a.min.z || _target.z > a.max.z) {
      out.reason = REASON_SURFACE_MISS;
      return out;
    }
  } else {
    surface = surfaceUnderXZ(tm.surfaces, _target.x, _target.z);
    if (!surface) { out.reason = REASON_NO_SURFACE; return out; }
  }
  if (opts.snapToCenterLine) surface.snapToCenterLine(_target);
  out.surface = surface;

  mu.updateAABB();
  const box = mu.aabb;
  out.delta.set(_target.x - box.center.x, surface.aabb.max.y - box.min.y, _target.z - box.center.z);
  _minC.copy(box.min).add(out.delta);
  _maxC.copy(box.max).add(out.delta);

  for (const other of tm.mus) {
    if (other === mu || other.markedForRemoval) continue;
    if (overlapsCandidate(other)) { out.reason = REASON_OCCUPIED; return out; }
    if (!other.isInstanced && treeOverlaps(other as RVMovingUnit)) { out.reason = REASON_OCCUPIED; return out; }
  }
  out.ok = true;
  return out;
}

// ─── Place ──────────────────────────────────────────────────────────────

export interface PlaceResult {
  readonly ok: true;
  readonly id: number;
  readonly name: string;
  readonly surface: string;
  /** World position of the carrier's node after the move (metres). */
  readonly position: [number, number, number];
}

const _check = createPlacementCheck();
const _worldPos = new Vector3();

/**
 * Teleport `mu` (a passive load addresses its carrier) onto a transport
 * surface with its collider centre over `point` (world metres). Refused —
 * with nothing changed — for pooled, physics-owned, held or gone carriers, a
 * point off every surface and an occupied drop position.
 */
export function placeMUOnSurface(
  tm: RVTransportManager,
  target: AnyMU,
  point: Vector3,
  opts: PlaceOptions = {},
): PlaceResult | Refusal {
  const mu = target.isInstanced ? target : carrierOf(target as RVMovingUnit);
  const why = checkManipulable(tm, mu);
  if (why) return refuse(why);
  const carrier = mu as RVMovingUnit;
  if (carrier.heldBy !== null) return refuse(heldReason(carrier.heldBy));

  // Re-check the FINAL pose at commit (SOL #5) — a preview can be stale.
  const check = checkPlacement(tm, carrier, point, opts, _check);
  if (!check.ok || !check.surface) return refuse(check.reason ?? REASON_NO_SURFACE);
  const surface = check.surface;

  // Leaving a GripTarget: free it and re-parent to the neutral parent (else the
  // carrier would keep following the target node).
  let reparented = false;
  for (const t of tm.gripTargets) {
    if (t.occupiedBy !== carrier) continue;
    t.clearOccupied();
    if (carrier.node.parent === t.node) {
      const neutral = tm.neutralParentOf(carrier) ?? sceneRootOf(carrier.node);
      neutral.attach(carrier.node);
      reparented = true;
    }
  }

  // Pose: translate in world space by the checked delta (yaw and tilt kept).
  carrier.node.getWorldPosition(_worldPos).add(check.delta);
  const parent = carrier.node.parent;
  if (parent) {
    parent.updateWorldMatrix(true, false);
    parent.worldToLocal(_worldPos);
  }
  carrier.node.position.copy(_worldPos);
  carrier.node.updateWorldMatrix(true, true);

  resetTransportState(carrier);
  // A teleport ends the carrier's flow membership: a station's booking and a
  // belt-stop hold do not travel with it.
  getConnectionHolds().releaseForRemoval(carrier.id);
  forgetMuInFlowLedgers(carrier.id);
  if (reparented) opts.collision?.invalidate();

  tm.reindexMU(carrier);
  tm.refreshDetection();
  carrier.node.getWorldPosition(_worldPos);
  return {
    ok: true,
    id: carrier.id,
    name: carrier.getName(),
    surface: surface.node.name,
    position: [_worldPos.x, _worldPos.y, _worldPos.z],
  };
}

/** The transport state a teleport clears — what `restoreFromSnapshot` clears (SOL #4). */
function resetTransportState(mu: RVMovingUnit): void {
  mu.currentSurface = null;
  mu.lastSurface = null;
  mu.lastSurfaceTickId = undefined;
  mu.blocked = false;
  mu.everOnSurface = undefined;
  mu.onLayoutObject = undefined;
  mu.offSurfaceTime = undefined;
  mu.vanishElapsed = undefined;
  mu.dissolve?.dispose();
  mu.dissolve = null;
  mu.grow?.dispose();
  mu.grow = null;
}

// ─── Drag gesture ───────────────────────────────────────────────────────

/** Everything a cancelled drag puts back (SOL #3, R2-1). */
export interface MuDragSession {
  readonly mu: RVMovingUnit;
  readonly parent: Object3D | null;
  readonly position: Vector3;
  readonly quaternion: Quaternion;
  readonly currentSurface: RVTransportSurface | null;
  readonly lastSurface: RVTransportSurface | null;
  readonly lastSurfaceTickId: number | undefined;
  readonly everOnSurface: boolean | undefined;
  readonly onLayoutObject: boolean | undefined;
  readonly offSurfaceTime: number | undefined;
  /** The GripTarget the carrier sat on — reserved for it while the gesture runs. */
  readonly gripTarget: RVGripTarget | null;
  /** Latest preview result (reused, no GC per pointer move). */
  readonly check: PlacementCheck;
}

/**
 * Start dragging `target` (a load addresses its carrier). Only a FREE carrier
 * can be taken (`heldBy === null`, SOL #3); it is then held with owner
 * `'user'` (transport, sinks, grips and zones leave it alone) under the scene
 * root. Its GripTarget keeps `occupiedBy` — nobody else can be put there.
 */
export function beginUserDrag(
  tm: RVTransportManager,
  target: AnyMU,
  collision?: { invalidate(): void } | null,
): MuDragSession | Refusal {
  const mu = target.isInstanced ? target : carrierOf(target as RVMovingUnit);
  const why = checkManipulable(tm, mu);
  if (why) return refuse(why);
  const carrier = mu as RVMovingUnit;
  if (carrier.heldBy !== null) return refuse(heldReason(carrier.heldBy));

  let gripTarget: RVGripTarget | null = null;
  for (const t of tm.gripTargets) if (t.occupiedBy === carrier) { gripTarget = t; break; }
  const session: MuDragSession = {
    mu: carrier,
    parent: carrier.node.parent,
    position: carrier.node.position.clone(),
    quaternion: carrier.node.quaternion.clone(),
    currentSurface: carrier.currentSurface,
    lastSurface: carrier.lastSurface ?? null,
    lastSurfaceTickId: carrier.lastSurfaceTickId,
    everOnSurface: carrier.everOnSurface,
    onLayoutObject: carrier.onLayoutObject,
    offSurfaceTime: carrier.offSurfaceTime,
    gripTarget,
    check: createPlacementCheck(),
  };
  // `gripTargets: null` — the hold kernel would free the target; the gesture
  // keeps it reserved until the drop (R2-1).
  holdMU(carrier, sceneRootOf(carrier.node), 'user', { gripTargets: null, loadHost: tm, collision });
  return session;
}

/**
 * Pointer moved: check the drop at `point` (on `surface`, if the ray hit a
 * drop plane) and move the carrier there so it follows the pointer. The
 * returned check says whether a release would place it. No allocation.
 */
export function previewUserDrag(
  tm: RVTransportManager,
  session: MuDragSession,
  point: Vector3,
  surface: RVTransportSurface | null,
): PlacementCheck {
  const mu = session.mu;
  const check = checkPlacement(tm, mu, point, { surface }, session.check);
  if (check.surface) {
    mu.node.position.add(check.delta); // held under the scene root: local = world
  } else {
    // Off every surface: follow the pointer horizontally at the current height.
    mu.updateAABB();
    mu.node.position.x += point.x - mu.aabb.center.x;
    mu.node.position.z += point.z - mu.aabb.center.z;
  }
  mu.node.updateWorldMatrix(true, true);
  mu.updateAABB();
  return check;
}

/**
 * Abort the gesture: owner, parent, local pose, surface state and the
 * GripTarget link are exactly what they were at the start. A no-op when the
 * carrier is no longer held by the gesture (a reset or model switch already
 * took it back).
 */
export function cancelUserDrag(
  tm: RVTransportManager,
  session: MuDragSession,
  collision?: { invalidate(): void } | null,
): void {
  const mu = session.mu;
  if (mu.heldBy !== 'user') return;
  detachMU(mu, 'user', session.parent, collision);
  mu.node.position.copy(session.position);
  mu.node.quaternion.copy(session.quaternion);
  mu.node.updateWorldMatrix(true, true);
  mu.currentSurface = session.currentSurface;
  mu.lastSurface = session.lastSurface;
  mu.lastSurfaceTickId = session.lastSurfaceTickId;
  mu.everOnSurface = session.everOnSurface;
  mu.onLayoutObject = session.onLayoutObject;
  mu.offSurfaceTime = session.offSurfaceTime;
  if (session.gripTarget && session.gripTarget.occupiedBy === null) session.gripTarget.setOccupied(mu);
  if (isLiveCarrier(tm, mu)) {
    tm.reindexMU(mu);
    tm.refreshDetection();
  }
}

/**
 * Release: put everything back (cancel), then place through
 * {@link placeMUOnSurface} — so a refused drop leaves the carrier where it was
 * and an accepted one goes through the same checks as the MCP tool.
 */
export function commitUserDrag(
  tm: RVTransportManager,
  session: MuDragSession,
  point: Vector3,
  surface: RVTransportSurface | null,
  collision?: { invalidate(): void } | null,
): PlaceResult | Refusal {
  const wasHeld = session.mu.heldBy === 'user';
  cancelUserDrag(tm, session, collision);
  if (!wasHeld) return refuse(REASON_GONE);
  return placeMUOnSurface(tm, session.mu, point, { surface, collision });
}
