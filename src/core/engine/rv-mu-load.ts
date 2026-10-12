// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mu-load.ts — passive MU loads decided by colliders (plan-516 F2/F3).
 *
 * An MU is the LOAD of another MU (its carrier) when its collider bottom rests
 * on the carrier's collider top within {@link LOAD_TOLERANCE_MM} and the
 * carrier's XZ footprint contains the load's collider centre. Hierarchy and
 * "topmost" play no role; a carrier may hold any number of loads, and a load
 * may carry loads of its own (stacks — the carrier is always the NEAREST MU
 * below).
 *
 * A load is PASSIVE: it is attached (`Object3D.attach`, world pose kept) to
 * its carrier's node and taken out of `RVTransportManager.mus`, so it rides
 * along through the scene graph and costs nothing per tick. Grips unload it
 * (`unloadMu`) and may put it onto another MU (`findCarrierByCollider` +
 * `loadMu`).
 *
 * The collider box every test here reads is the MU's `aabb` — for a
 * pre-placed MU that is built from its own colliders (`rv-mu-collider-bounds`).
 *
 * Seats (plan-577): a carrier may declare `MU.LoadSeatDepth` — a load whose
 * bottom lies up to that depth BELOW the carrier's top still rests on it (a
 * part in a jig, a cap over a valve end). The depth is limited to
 * {@link SEAT_DEPTH_MAX_RATIO} of the carrier's collider height, and a load's
 * bottom never lies below the carrier's bottom. {@link decideCarrierPlacement}
 * is the place-time check a Grip runs at a `LoadOnCarrier` GripTarget.
 */

import type { RVMovingUnit, InstancedMovingUnit } from './rv-mu';
import { MM_TO_METERS } from './rv-constants';

/** Vertical gap (mm) between a load's collider bottom and its carrier's top that still counts as resting. */
export const LOAD_TOLERANCE_MM = 5;
/** {@link LOAD_TOLERANCE_MM} in metres (scene units). */
export const LOAD_TOLERANCE_M = LOAD_TOLERANCE_MM / MM_TO_METERS;
/** A carrier's seat depth is limited to this share of its collider height (plan-577). */
export const SEAT_DEPTH_MAX_RATIO = 0.8;
/** Overlap inset (m) of the place-time check: touching boxes (shared face) do not overlap. Same value as plan-567's placement check. */
export const LOAD_OVERLAP_EPS = 0.001;

/**
 * The slice of the transport manager load changes need: a load leaves the
 * active MU list, an unloaded MU joins it again. Structural so tests (and a
 * grip without a manager) can pass their own.
 */
export interface MULoadHost {
  /** Remove `mu` from the ticked set (no dispose, no lifecycle hooks). */
  deactivateMU(mu: RVMovingUnit): void;
  /** Add `mu` to the ticked set (idempotent). */
  activateMU(mu: RVMovingUnit): void;
}

type AnyMU = RVMovingUnit | InstancedMovingUnit;

/** Call `fn` for every load below `root`, depth-first (not for `root` itself). */
export function forEachInLoadTree(root: RVMovingUnit, fn: (mu: RVMovingUnit) => void): void {
  const loads = root.loadedMus;
  for (let i = 0; i < loads.length; i++) {
    fn(loads[i]);
    forEachInLoadTree(loads[i], fn);
  }
}

/** True when `mu` is `root` or lies anywhere in `root`'s load tree. */
export function isInLoadTree(root: RVMovingUnit, mu: RVMovingUnit): boolean {
  for (let cur: RVMovingUnit | null = mu; cur; cur = cur.loadedOn) {
    if (cur === root) return true;
  }
  return false;
}

/**
 * Make `load` a passive load of `carrier`: detach it from any previous carrier,
 * take it out of the ticked set, attach its node under the carrier's node
 * (world pose kept) and link both sides. Refuses (returns false) a cycle, a
 * physics-owned MU and an MU held by a subsystem.
 */
export function loadMu(load: RVMovingUnit, carrier: RVMovingUnit, host?: MULoadHost | null): boolean {
  if (load === carrier || load.isInstanced || carrier.isInstanced) return false;
  if (load.physicsOwned || load.isGripped) return false;
  if (isInLoadTree(load, carrier)) return false; // carrier rests on load → cycle
  if (load.loadedOn === carrier) return true;
  if (load.loadedOn) unlink(load);
  host?.deactivateMU(load);
  carrier.node.attach(load.node);
  load.loadedOn = carrier;
  carrier.loadedMus.push(load);
  load.currentSurface = null;
  load.lastSurfaceTickId = undefined;
  load.blocked = false;
  return true;
}

/**
 * Release `load` from its carrier and make it active again. The node stays
 * where it is in the scene graph — the caller (a grip) re-parents it.
 */
export function unloadMu(load: RVMovingUnit, host?: MULoadHost | null): void {
  if (!load.loadedOn) return;
  unlink(load);
  host?.activateMU(load);
}

function unlink(load: RVMovingUnit): void {
  const carrier = load.loadedOn;
  if (!carrier) return;
  const idx = carrier.loadedMus.indexOf(load);
  if (idx >= 0) carrier.loadedMus.splice(idx, 1);
  load.loadedOn = null;
}

/**
 * `MU.LoadSeatDepth` of a node's rv-extras (millimetres) in metres; anything
 * that is not a finite positive number is 0 (plan-577 F2).
 */
export function readLoadSeatDepth(node: { userData?: Record<string, unknown> } | null | undefined): number {
  const rv = node?.userData?.realvirtual as { MU?: { LoadSeatDepth?: unknown } } | undefined;
  const raw = rv?.MU?.LoadSeatDepth;
  if (raw === undefined || raw === null || raw === '') return 0;
  const mm = Number(raw);
  return Number.isFinite(mm) && mm > 0 ? mm / MM_TO_METERS : 0;
}

/** The seat depth `carrier` grants right now (m): its authored depth, limited
 *  to {@link SEAT_DEPTH_MAX_RATIO} of its current collider height. AABB must be current. */
export function effectiveSeatDepth(carrier: AnyMU): number {
  if (carrier.isInstanced) return 0;
  const depth = (carrier as RVMovingUnit).loadSeatDepth;
  if (!(depth > 0)) return 0;
  const a = carrier.aabb;
  const cap = SEAT_DEPTH_MAX_RATIO * (a.max.y - a.min.y);
  return depth < cap ? depth : cap;
}

/**
 * F2/F3 geometry: does `load` rest on `carrier`? Both AABBs must be current.
 * The load's bottom lies within `-(tolerance + seat depth) … +tolerance` of the
 * carrier's top and not below the carrier's bottom, the carrier's centre is
 * below the load's, and the load's centre lies inside the carrier's XZ
 * footprint. Allocation-free.
 */
export function restsOn(load: AnyMU, carrier: AnyMU): boolean {
  const l = load.aabb;
  const c = carrier.aabb;
  const gap = l.min.y - c.max.y;
  if (gap > LOAD_TOLERANCE_M) return false;
  if (gap < -LOAD_TOLERANCE_M && gap < -(LOAD_TOLERANCE_M + effectiveSeatDepth(carrier))) return false;
  if (l.min.y < c.min.y - LOAD_TOLERANCE_M) return false;
  if (c.center.y >= l.center.y) return false;
  return l.center.x >= c.min.x && l.center.x <= c.max.x
    && l.center.z >= c.min.z && l.center.z <= c.max.z;
}

/**
 * Find the MU `mu` would rest on (F2), among the active MUs in `actives` and,
 * recursively, their load trees — so a part can be put onto the third level of
 * a stack. Gripped, marked, physics-owned and instanced MUs are skipped, as is
 * `mu` itself together with everything it carries. Returns the carrier whose
 * top is highest (the nearest MU below), or null.
 */
export function findCarrierByCollider(mu: RVMovingUnit, actives: readonly (AnyMU | { isInstanced: boolean })[]): RVMovingUnit | null {
  mu.updateAABB();
  let best: RVMovingUnit | null = null;
  const consider = (c: RVMovingUnit): void => {
    c.updateAABB();
    if (!restsOn(mu, c)) return;
    if (!best || c.aabb.max.y > best.aabb.max.y) best = c;
  };
  const visit = (c: RVMovingUnit): void => {
    if (c === mu) return; // never onto itself or its own loads
    consider(c);
    for (let i = 0; i < c.loadedMus.length; i++) visit(c.loadedMus[i]);
  };
  for (const a of actives) {
    if (a.isInstanced) continue;
    const c = a as RVMovingUnit;
    if (c === mu || c.markedForRemoval || c.isGripped || c.physicsOwned) continue;
    visit(c);
  }
  return best;
}

/** Index of the first entry of `sorted` (ascending by top) whose top is ≥ `y`. */
function lowerBoundTop(sorted: RVMovingUnit[], y: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid].aabb.max.y < y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Resolve the loads among `mus` (F2): every MU whose collider rests on another
 * becomes that MU's passive load; the carrier is the nearest MU below (highest
 * top within the window). Processed bottom → top over a list sorted by
 * collider top, so the cost is O(n log n) plus the candidates in the height
 * window per MU. The window is the tolerance, widened only by the largest
 * seat depth present (plan-577 F4); each candidate is judged with its OWN
 * seat depth (`restsOn`).
 *
 * Returns the MUs that remain FREE (not a load) — the caller registers those.
 */
export function resolveLoads(mus: readonly RVMovingUnit[], host?: MULoadHost | null): RVMovingUnit[] {
  let maxDepth = 0;
  for (const mu of mus) {
    mu.updateAABB();
    const d = effectiveSeatDepth(mu);
    if (d > maxDepth) maxDepth = d;
  }
  const byTop = [...mus].sort((a, b) => a.aabb.max.y - b.aabb.max.y);
  const byBottom = [...mus].sort((a, b) => a.aabb.min.y - b.aabb.min.y);
  for (const mu of byBottom) {
    const bottom = mu.aabb.min.y;
    let best: RVMovingUnit | null = null;
    for (let i = lowerBoundTop(byTop, bottom - LOAD_TOLERANCE_M); i < byTop.length; i++) {
      const c = byTop[i];
      if (c.aabb.max.y > bottom + LOAD_TOLERANCE_M + maxDepth) break;
      if (c === mu || !restsOn(mu, c)) continue;
      if (isInLoadTree(mu, c)) continue;
      if (!best || c.aabb.max.y > best.aabb.max.y) best = c;
    }
    if (best) loadMu(mu, best, host);
  }
  return mus.filter((mu) => !mu.loadedOn);
}

// ─── Place-time decision at a LoadOnCarrier GripTarget (plan-577 §2.4) ──────

/**
 * Outcome of {@link decideCarrierPlacement}:
 *  - `free` — exactly one MU the part rests on, nothing in the way;
 *  - `blocked` — the moving tree overlaps a foreign MU outside the one allowed
 *    seat contact, or the part overlaps two or more MUs it could rest on
 *    (ambiguous seat — `carrier` then names the first, `obstacle` the second);
 *  - `noCarrier` — nothing below the part and nothing in the way.
 */
export type CarrierPlacement =
  | { readonly kind: 'free'; readonly carrier: RVMovingUnit }
  | { readonly kind: 'blocked'; readonly obstacle: AnyMU; readonly carrier: RVMovingUnit | null; readonly ambiguous: boolean }
  | { readonly kind: 'noCarrier' };

const NO_CARRIER: CarrierPlacement = Object.freeze({ kind: 'noCarrier' });

function boxesOverlap(a: AnyMU, b: AnyMU): boolean {
  const p = a.aabb;
  const q = b.aabb;
  return p.min.x < q.max.x - LOAD_OVERLAP_EPS && p.max.x > q.min.x + LOAD_OVERLAP_EPS
    && p.min.y < q.max.y - LOAD_OVERLAP_EPS && p.max.y > q.min.y + LOAD_OVERLAP_EPS
    && p.min.z < q.max.z - LOAD_OVERLAP_EPS && p.max.z > q.min.z + LOAD_OVERLAP_EPS;
}

/**
 * Where would `part` go if released at its CURRENT pose (plan-577 §2.4)? The
 * caller has aligned it at the target and brought its world matrix up to date.
 *
 * The moving tree is `part` with everything it carries. Every foreign MU —
 * the active MUs in `actives` (free, held by another grip or zone, physics-
 * owned, instanced) and, recursively, their passive loads — is tested in
 * one pass:
 *  - a carrier CANDIDATE is an MU `part` rests on (`restsOn`, seat depth
 *    included) that may carry (clone MU, not held, not physics-owned, not
 *    being removed);
 *  - the overlap of `part` itself with a candidate is the allowed seat
 *    contact; every other overlap of the moving tree with a foreign MU is an
 *    obstacle;
 *  - two or more candidates in seat contact make the seat ambiguous → blocked.
 * With one seat contact that candidate is the carrier; without one the highest
 * candidate (plain contact, the plan-516 rule) is. Only runs at a place flank.
 */
export function decideCarrierPlacement(
  part: RVMovingUnit,
  actives: readonly (AnyMU | { isInstanced: boolean })[],
): CarrierPlacement {
  const moving: RVMovingUnit[] = [part];
  forEachInLoadTree(part, (m) => moving.push(m));
  for (const m of moving) m.updateAABB();

  const st: PlacementScan = { seat: null, best: null, blocked: null };
  for (const a of actives) {
    if (st.blocked) break;
    if (a.isInstanced) { considerForPlacement(part, moving, a as AnyMU, st); continue; }
    const c = a as RVMovingUnit;
    if (c === part || c.markedForRemoval) continue;
    visitForPlacement(part, moving, c, st);
  }
  if (st.blocked) {
    // An obstacle met after the seat was found still names that seat as the carrier.
    return st.blocked.carrier || st.blocked.ambiguous ? st.blocked : { ...st.blocked, carrier: st.seat };
  }
  const carrier = st.seat ?? st.best;
  return carrier ? { kind: 'free', carrier } : NO_CARRIER;
}

type BlockedPlacement = Extract<CarrierPlacement, { kind: 'blocked' }>;

interface PlacementScan {
  /** The one candidate the part overlaps (seat contact). */
  seat: RVMovingUnit | null;
  /** Highest candidate in plain contact (no overlap). */
  best: RVMovingUnit | null;
  blocked: BlockedPlacement | null;
}

function visitForPlacement(part: RVMovingUnit, moving: readonly RVMovingUnit[], c: RVMovingUnit, st: PlacementScan): void {
  if (isInLoadTree(part, c)) return; // the moving tree itself
  considerForPlacement(part, moving, c, st);
  const loads = c.loadedMus;
  for (let i = 0; i < loads.length && !st.blocked; i++) visitForPlacement(part, moving, loads[i], st);
}

function considerForPlacement(part: RVMovingUnit, moving: readonly RVMovingUnit[], f: AnyMU, st: PlacementScan): void {
  if (st.blocked) return;
  f.updateAABB();
  let candidate: RVMovingUnit | null = null;
  if (!f.isInstanced) {
    const c = f as RVMovingUnit;
    if (!c.markedForRemoval && !c.isGripped && !c.physicsOwned && restsOn(part, c)) candidate = c;
  }
  for (let i = 0; i < moving.length; i++) {
    if (!boxesOverlap(moving[i], f)) continue;
    if (i === 0 && candidate) {
      if (st.seat) {
        st.blocked = { kind: 'blocked', obstacle: candidate, carrier: st.seat, ambiguous: true };
        return;
      }
      st.seat = candidate;
      continue;
    }
    st.blocked = { kind: 'blocked', obstacle: f, carrier: null, ambiguous: false };
    return;
  }
  if (candidate && (!st.best || candidate.aabb.max.y > st.best.aabb.max.y)) st.best = candidate;
}
