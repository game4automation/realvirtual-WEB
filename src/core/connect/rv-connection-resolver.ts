// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-connection-resolver.ts — ONE connection resolver for planner snaps and DES
 * material flow (unified and legacy), plan-633. The path network derives its
 * topology from the path ends instead (`path-topology.ts`, non-exclusive).
 *
 * `resolveConnections(connectables, options)` is PURE: it reads the snap
 * registry and the scene geometry and returns an ordered list of directed
 * {@link ConnectionLink}s. It never writes `nextComponents`, `successors` or
 * registry state — callers apply the links.
 *
 * Stages (in this order, each only where the previous left a gap):
 *
 *  1. SNAP — every paired snap of a connectable whose partner belongs to
 *     another connectable. The ROLE of the port (input/output) is decided in
 *     exactly one place, {@link portRoleOf}: the authored flow, refined by the
 *     travel direction of the partner's transport surfaces (the projection rule
 *     `classifyConnections` has always used; surfaces are injected, so the core
 *     knows no `RVTransportSurface`). A port classified `output` yields the link
 *     self → partner.
 *  2. CONFLICT — where BOTH ends of a connection claim `output` the snap stage
 *     holds a 2-cycle; the resolver settles it with the rule the DES binding's
 *     `breakTwoCycles` applied afterwards until now (Gate R2-3): the link stays
 *     with the endpoint of SMALLER out-degree, a tie keeps the direction from
 *     the SMALLER uuid. Same order of evaluation (endpoints by uuid, live
 *     out-degrees), so the resulting topology is today's end topology. Both
 *     ends `input` produce no link, as before.
 *  3. DISTANCE — typed fallback for connectables that still have no downstream
 *     (ported from the DES `autoConnectByDistance`, plan-225): same
 *     `connectionType` (+ `subType`), emitter → acceptor, nearest within the
 *     radius, tie-break by uuid. Metric: source CENTRE → candidate world AABB
 *     (0 when inside → `contained`), or OUT → IN port points for connectables
 *     that carry `portPositions` (legacy native DES components).
 *
 * Output order is the wiring order the DES binding has always produced: snap
 * links grouped by `from` in input order, each in the order of `from`'s snaps
 * in the registry; then distance links by source uuid. Applying the links in
 * list order therefore reproduces `nextComponents` AND `previousComponents`
 * order. Per-`from` successor order does not depend on the input order.
 *
 * Runs at load / layout change only — never per tick.
 */

import { Box3, Vector3 } from 'three';
import type { Object3D } from 'three';
import { findAll, NODE_KIND_TESTS } from '../library-component-loader';
import { stableNodeOrderKey } from '../engine/rv-decode-identity';

// ─── Public types ─────────────────────────────────────────────────────────

/** Direction of a port relative to the connectable that owns it. */
export type PortRole = 'input' | 'output';

/** How a connectable reads a non-positive `autoConnect.maxDistance`. */
export type RadiusPolicy =
  /** Unified material flow (plan-225): ≤ 0 → 1.0 m. */
  | 'typed'
  /** Legacy native DES components: ≤ 0 → unbounded. */
  | 'legacy';

/** One instance the resolver reasons about (structural — no DES types). */
export interface Connectable {
  /** Instance root (the placement / component node). */
  readonly root: Object3D;
  /** Material-flow kind: source | conveyor | sink | router | station | … */
  readonly kind: string;
  /** Typed compatibility key, e.g. 'material-flow'. */
  readonly connectionType: string;
  /** Optional sub-type; must match when both sides set one. */
  readonly subType?: string;
  /** Distance fallback switch + radius (m). Default `{ enabled: true, maxDistance: 1 }`. */
  readonly autoConnect?: { readonly enabled: boolean; readonly maxDistance: number };
  /** Reading of a non-positive radius. Default 'typed'. */
  readonly radiusPolicy?: RadiusPolicy;
  /** Can receive parts (legacy `canHaveInputs()`). Default: kind !== 'source'. */
  readonly acceptsInputs?: boolean;
  /** Can hand parts on. Default: kind !== 'sink'. */
  readonly emitsOutputs?: boolean;
  /** Legacy port points (world): with both `from.out` and `to.in` the distance
   *  stage measures OUT → IN instead of centre → AABB. */
  readonly portPositions?: { readonly out?: Vector3; readonly in?: Vector3 };
  /** Successors the caller already holds (explicit / authored links). They are
   *  kept by the caller, not returned; a connectable with any is skipped by the
   *  distance stage (explicit links win). */
  readonly existingNext?: readonly Object3D[];
}

/** One directed connection. */
export interface ConnectionLink {
  readonly from: Object3D;
  readonly to: Object3D;
  readonly via: 'snap' | 'distance';
  /** Metres: snap–snap distance, or the distance-stage metric. */
  readonly distance: number;
  /** Distance 0 under the centre → AABB metric: `from` lies inside `to`. */
  readonly contained: boolean;
  /** [from-side snap id, to-side snap id] for snap links. */
  readonly snapIds?: readonly [string, string];
}

/** Snap as the resolver reads it (structural subset of `SnapPoint`). */
export interface ResolverSnap {
  readonly id: string;
  readonly object3D: Object3D;
  readonly flow?: 'in' | 'out' | 'bidi';
  readonly pairedSnapId?: string;
  readonly ownerRoot: Object3D;
}

/** Registry as the resolver reads it (structural subset of `SnapPointRegistry`). */
export interface ResolverRegistry {
  getByOwnerRoot(root: Object3D): readonly ResolverSnap[];
  getById(id: string): ResolverSnap | undefined;
}

/** A transport surface as the role refinement reads it (structural). */
export interface TransportSurfaceLike {
  getWorldDirection(out?: Vector3): Vector3;
}

/** Transport surfaces of an instance root, in scene order. */
export type SurfacesOf = (root: Object3D) => readonly TransportSurfaceLike[];

export interface ResolveOptions {
  /** Snap connection graph; null → no snap stage. */
  readonly registry: ResolverRegistry | null;
  /** Role refinement source. Absent → roles from the authored flow only. */
  readonly surfacesOf?: SurfacesOf;
  /** Run the distance stage. Default true. */
  readonly distanceFallback?: boolean;
  /** Global radius override (m) for 'typed' connectables when > 0. */
  readonly maxDistance?: number;
}

/** Result plus the stage counters the callers log. */
export interface ResolveResult {
  readonly links: ConnectionLink[];
  /** Snap 2-cycles settled by the conflict rule (stage 2). */
  readonly conflictsResolved: number;
  /** Links created by the distance stage. */
  readonly distanceLinks: number;
}

// ─── Scratch (load-time only, never per tick) ─────────────────────────────

const _dir = new Vector3();
const _matingPos = new Vector3();
const _centre = new Vector3();
const _toCentre = new Vector3();
const _box = new Box3();
const _srcCentre = new Vector3();
const _a = new Vector3();
const _b = new Vector3();

// ─── Roles (the one place) ────────────────────────────────────────────────

/**
 * Role of `snap` (owned by `root`) on its connection to `partner`.
 *
 * Authored flow first (`in` → input, else output). Then, when surfaces are
 * available, the partner's transport direction decides: from the mating point
 * toward `root`'s origin, a belt moving TOWARD `root` feeds it (input), one
 * moving AWAY is fed by it (output). All partner surfaces are evaluated and the
 * one most aligned with the connection wins (a ChainTransfer carries a straight
 * and a cross surface); a projection of ~0 keeps the authored flow.
 */
export function portRoleOf(
  root: Object3D,
  snap: ResolverSnap,
  partner: ResolverSnap,
  surfacesOf?: SurfacesOf,
): PortRole {
  let role: PortRole = snap.flow === 'in' ? 'input' : 'output';
  if (!surfacesOf) return role;
  partner.object3D.getWorldPosition(_matingPos);
  root.getWorldPosition(_centre);
  _toCentre.copy(_centre).sub(_matingPos);
  let bestProj = 0;
  let bestAbs = 1e-4;
  for (const surface of surfacesOf(partner.ownerRoot)) {
    surface.getWorldDirection(_dir);
    const proj = _dir.dot(_toCentre);
    const abs = Math.abs(proj);
    if (abs > bestAbs) { bestAbs = abs; bestProj = proj; }
  }
  if (bestProj !== 0) role = bestProj > 0 ? 'input' : 'output';
  return role;
}

/** Minimal component-registry slice that resolves a `TransportSurface`. */
export interface SurfaceComponentRegistry {
  findInChildren<T = unknown>(node: Object3D, type: string): T | null;
}

/**
 * The standard {@link SurfacesOf}: every `Transport-*` node under the root (scene
 * order) resolved to its `TransportSurface` through the component registry.
 */
export function surfacesFromComponentRegistry(reg: SurfaceComponentRegistry): SurfacesOf {
  return (root) => {
    const out: TransportSurfaceLike[] = [];
    for (const t of findAll(root, NODE_KIND_TESTS.transport)) {
      const s = reg.findInChildren<TransportSurfaceLike>(t, 'TransportSurface');
      if (s) out.push(s);
    }
    return out;
  };
}

// ─── Distance metric (ported 1:1 from logical-connections.ts) ────────────

/**
 * World bounds of a node as the distance metric reads them: the AABB from
 * `expandByObject`, or, when the subtree has no geometry, the node's world
 * position. Memoised for ONE resolve call (plan-644 Phase 2.3) — the resolver
 * is pure and moves nothing, so the bounds of an acceptor are the same for
 * every source that measures against it. Same formula as before.
 */
interface NodeBounds {
  readonly box: Box3;
  readonly empty: boolean;
  readonly position: Vector3;
}

/** Bounds cache of one `resolveConnectionsDetailed` call. */
type BoundsCache = Map<Object3D, NodeBounds>;

function boundsOf(node: Object3D, cache: BoundsCache): NodeBounds {
  let b = cache.get(node);
  if (!b) {
    node.updateWorldMatrix(true, false);
    _box.makeEmpty();
    _box.expandByObject(node);
    const empty = _box.isEmpty();
    b = {
      box: _box.clone(),
      empty,
      position: empty ? node.getWorldPosition(new Vector3()) : new Vector3(),
    };
    cache.set(node, b);
  }
  return b;
}

/** World-space centre of a node (AABB centre, or transform position if no geometry). */
function worldCentre(node: Object3D, target: Vector3, cache: BoundsCache): Vector3 {
  const b = boundsOf(node, cache);
  return b.empty ? target.copy(b.position) : b.box.getCenter(target);
}

/** Distance from `p` to a node's world AABB (0 when `p` is inside). */
function pointToNodeDistance(p: Vector3, node: Object3D, cache: BoundsCache): number {
  const b = boundsOf(node, cache);
  if (b.empty) return p.distanceTo(b.position);
  const box = b.box;
  const dx = Math.max(box.min.x - p.x, 0, p.x - box.max.x);
  const dy = Math.max(box.min.y - p.y, 0, p.y - box.max.y);
  const dz = Math.max(box.min.z - p.z, 0, p.z - box.max.z);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function autoOf(c: Connectable): { enabled: boolean; maxDistance: number } {
  return c.autoConnect ?? { enabled: true, maxDistance: 1.0 };
}
function emits(c: Connectable): boolean { return c.emitsOutputs ?? c.kind !== 'sink'; }
function accepts(c: Connectable): boolean { return c.acceptsInputs ?? c.kind !== 'source'; }

function typesCompatible(a: Connectable, b: Connectable): boolean {
  if (a.connectionType !== b.connectionType) return false;
  if (a.subType && b.subType && a.subType !== b.subType) return false;
  return true;
}

function radiusOf(c: Connectable, override: number | undefined): number {
  const max = autoOf(c).maxDistance;
  if ((c.radiusPolicy ?? 'typed') === 'legacy') return max > 0 ? max : Infinity;
  if (override !== undefined && override > 0) return override;
  return max > 0 ? max : 1.0;
}

/**
 * Stable order of two connectables. `Object3D.uuid` is random per load, so ordering by it alone made every
 * tie (equal degree in a snap 2-cycle, equal distance) resolve differently after a reload - a snapshot
 * restored into a freshly loaded scene then continued on another topology (plan-2059 O3). The ancestor chain of
 * node identities (authored NodeId or the id seeded from the authored path) is identical across loads and tells
 * placements of the same file apart; uuid is only the last-resort tie-break.
 */
function uuidOrder(a: Connectable, b: Connectable): number {
  const ka = stableNodeOrderKey(a.root), kb = stableNodeOrderKey(b.root);
  if (ka !== kb) return ka < kb ? -1 : 1;
  return a.root.uuid < b.root.uuid ? -1 : a.root.uuid > b.root.uuid ? 1 : 0;
}

// ─── Resolver ─────────────────────────────────────────────────────────────

interface SnapEdge {
  readonly to: number;
  readonly distance: number;
  readonly snapIds: readonly [string, string];
}

/**
 * Resolve every connection between `connectables`. See the module comment for
 * the stages and the output order. Pure: returns links, mutates nothing.
 */
export function resolveConnectionsDetailed(
  connectables: readonly Connectable[],
  options: ResolveOptions,
): ResolveResult {
  const n = connectables.length;
  // Root → connectable index. Several connectables on ONE root (a node carrying
  // two material-flow payloads) resolve to the LAST one, as the DES binding's
  // root map always did.
  const indexOf = new Map<Object3D, number>();
  connectables.forEach((c, i) => indexOf.set(c.root, i));

  // ── 1. Snap stage: per connectable, its output ports in registry order. ──
  const next: SnapEdge[][] = connectables.map(() => []);
  const reg = options.registry;
  if (reg) {
    for (let i = 0; i < n; i++) {
      const root = connectables[i].root;
      for (const sp of reg.getByOwnerRoot(root)) {
        if (!sp.pairedSnapId) continue;
        const partner = reg.getById(sp.pairedSnapId);
        if (!partner || partner.ownerRoot === root) continue;
        const j = indexOf.get(partner.ownerRoot);
        if (j === undefined || j === i) continue;
        if (portRoleOf(root, sp, partner, options.surfacesOf) !== 'output') continue;
        if (next[i].some((e) => e.to === j)) continue;
        sp.object3D.getWorldPosition(_a);
        partner.object3D.getWorldPosition(_b);
        next[i].push({ to: j, distance: _a.distanceTo(_b), snapIds: [sp.id, partner.id] });
      }
    }
  }

  // ── 2. Conflict rule on snap 2-cycles (endpoints by uuid, live degrees). ──
  const byUuid = [...Array(n).keys()].sort((x, y) => uuidOrder(connectables[x], connectables[y]));
  const has = (from: number, to: number): boolean => next[from].some((e) => e.to === to);
  const drop = (from: number, to: number): void => {
    const k = next[from].findIndex((e) => e.to === to);
    if (k >= 0) next[from].splice(k, 1);
  };
  let conflictsResolved = 0;
  for (const a of byUuid) {
    for (const edge of [...next[a]]) {
      const b = edge.to;
      if (uuidOrder(connectables[b], connectables[a]) <= 0) continue;
      if (!has(a, b) || !has(b, a)) continue;
      const aOut = next[a].length;
      const bOut = next[b].length;
      if (aOut > bOut) drop(a, b);
      else drop(b, a); // b over-subscribed, or tie → keep a→b (a has the smaller uuid)
      conflictsResolved++;
    }
  }

  const links: ConnectionLink[] = [];
  for (let i = 0; i < n; i++) {
    for (const e of next[i]) {
      links.push({
        from: connectables[i].root, to: connectables[e.to].root,
        via: 'snap', distance: e.distance, contained: false, snapIds: e.snapIds,
      });
    }
  }

  // ── 3. Typed distance fallback for connectables without a downstream. ──
  let distanceLinks = 0;
  if (options.distanceFallback !== false) {
    const nextCount = (i: number): number => next[i].length + (connectables[i].existingNext?.length ?? 0);
    const sources = byUuid
      .filter((i) => emits(connectables[i]) && autoOf(connectables[i]).enabled && nextCount(i) === 0)
      .map((i) => connectables[i]);
    const acceptors = byUuid
      .map((i) => connectables[i])
      .filter((c) => accepts(c) && autoOf(c).enabled);
    const bounds: BoundsCache = new Map();
    for (const from of sources) {
      const radius = radiusOf(from, options.maxDistance);
      const outPort = from.portPositions?.out;
      if (!outPort) worldCentre(from.root, _srcCentre, bounds);
      let best: Connectable | null = null;
      let bestDist = Infinity;
      let bestContained = false;
      for (const to of acceptors) {
        if (to === from || to.root === from.root) continue;
        if (!typesCompatible(from, to)) continue;
        const inPort = to.portPositions?.in;
        const legacyMetric = outPort !== undefined && inPort !== undefined;
        const d = legacyMetric
          ? outPort.distanceTo(inPort)
          : pointToNodeDistance(outPort ?? _srcCentre, to.root, bounds);
        if (d > radius) continue;
        if (d < bestDist) { bestDist = d; best = to; bestContained = !outPort && d === 0; }
      }
      if (best) {
        links.push({ from: from.root, to: best.root, via: 'distance', distance: bestDist, contained: bestContained });
        distanceLinks++;
      }
    }
  }

  return { links, conflictsResolved, distanceLinks };
}

/** {@link resolveConnectionsDetailed} without the counters. */
export function resolveConnections(
  connectables: readonly Connectable[],
  options: ResolveOptions,
): ConnectionLink[] {
  return resolveConnectionsDetailed(connectables, options).links;
}
