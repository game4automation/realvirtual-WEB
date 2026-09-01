// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-path.ts — the `RVPath` substrate (plan-268 Phase 0).
 *
 * Arc-length-parametrised path representation for path-based movement
 * (AGV/FTS, overhead conveyors): a chain of `LineSegment` / `ArcSegment`
 * segments with cached lengths + prefix sums, so `getAbsPosition(meters)`
 * moves at CONSTANT speed regardless of curvature (never `getPoint(t)`).
 *
 * This file is also the TS-SSOT of the WebViewer-native `rv_extras.Path`
 * schema, version 1 (plan-268 §2.3) — no Unity export, no C# field parity:
 *
 * ```jsonc
 * // rv_extras.Path
 * {
 *   "type": "Path",
 *   "version": 1,
 *   "segments": [
 *     { "kind": "line", "from": [x,y,z], "to": [x,y,z] },
 *     { "kind": "arc",  "center": [x,y,z], "radius": r,
 *       "startAngle": a, "degrees": d, "clockwise": true, "plane": "XZ" }
 *   ],
 *   "closed": false,            // circulating (overhead conveyor / loop)
 *   "successors": ["<pathId>"], // graph chaining (junctions)
 *   "align": [0,1,0],           // up vector for the carrier pose
 *   "zone": "X1",               // optional: control-point zone this path belongs to (Phase 2)
 *   "zoneCapacity": 1           // optional: explicit zone capacity (max of declarations wins)
 * }
 * ```
 *
 * Phase-2 addition (still schema version 1, additive + defensively parsed):
 * `zone` / `zoneCapacity` declare the path as part of a reservation zone
 * (control-point model, rv-zone-registry.ts). A zone is the set of paths
 * sharing the same `zone` id — a crossing is two crossing paths with the same
 * id. These fields stay TS-SSOT here (like segments/successors/align) and are
 * NOT part of the scalar rv-ODT factory schema.
 *
 * Detection is coupled to the rv_extras payload (`rv_extras.Path` whose inner
 * `type` is `'Path'` or absent), NEVER to node names (plan-268 §10 review risk).
 *
 * The scene-loader factory component (`type: 'Path'`, registered below) parses
 * the extras into an `RVPath` and registers it in the default `RVPathNetwork`.
 * Import this module for its side effect from `rv-scene-loader.ts`.
 */

import { Vector3 } from 'three';
import type { Object3D } from 'three';
import type { ComponentContext, ComponentSchema, RVComponent } from './rv-component-registry';
import { registerComponent, setComponentInstance, loadSchemaFromSpec } from './rv-component-registry';
import { defaultPathNetwork } from './rv-path-network';
import { defaultZoneRegistry } from './rv-zone-registry';

const DEG2RAD = Math.PI / 180;

/** Fallback tangent for degenerate (zero-length) geometry — glTF forward. */
const DEGENERATE_DIR = new Vector3(0, 0, 1);

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

// ─── Segments ────────────────────────────────────────────────────────────

/** One arc-length-parametrised path piece. `t01` is the NORMALISED position. */
export interface IPathSegment {
  /** Segment length in meters, cached at construction. */
  readonly length: number;
  /** World position at `t01 ∈ [0..1]` (constant-speed within the segment). */
  getPosition(t01: number, out?: Vector3): Vector3;
  /** Normalised world tangent at `t01 ∈ [0..1]`. */
  getDirection(t01: number, out?: Vector3): Vector3;
}

/** Straight segment `from → to`. Degenerate (`from == to`) → length 0, no NaN. */
export class LineSegment implements IPathSegment {
  readonly length: number;
  private readonly from: Vector3;
  private readonly to: Vector3;
  private readonly dir: Vector3;

  constructor(from: Vector3, to: Vector3) {
    this.from = from.clone();
    this.to = to.clone();
    this.length = this.from.distanceTo(this.to);
    this.dir = this.length > 0
      ? this.to.clone().sub(this.from).divideScalar(this.length)
      : DEGENERATE_DIR.clone();
  }

  getPosition(t01: number, out: Vector3 = new Vector3()): Vector3 {
    return out.copy(this.from).lerp(this.to, clamp01(t01));
  }

  getDirection(_t01: number, out: Vector3 = new Vector3()): Vector3 {
    return out.copy(this.dir);
  }
}

/** Plane the arc lies in. `'XZ'` (ground plane, Y up) is the default. */
export type ArcPlane = 'XZ' | 'XY' | 'YZ';

/**
 * Circular arc: `center`, `radius`, `startAngle` (deg) and swept `degrees`
 * in the plane's (u,v) basis (`XZ`: u=+X, v=+Z). `clockwise` negates the
 * sweep. Length is analytic (`2πR·|deg|/360`). Degenerate radius/degrees →
 * length 0, position stays at the start point, no NaN.
 */
export class ArcSegment implements IPathSegment {
  readonly length: number;
  private readonly center: Vector3;
  private readonly radius: number;
  private readonly startRad: number;
  private readonly sweepRad: number;
  private readonly u: Vector3;
  private readonly v: Vector3;

  constructor(
    center: Vector3,
    radius: number,
    startAngleDeg: number,
    degrees: number,
    clockwise = false,
    plane: ArcPlane = 'XZ',
  ) {
    this.center = center.clone();
    this.radius = Number.isFinite(radius) ? Math.max(0, radius) : 0;
    this.startRad = (Number.isFinite(startAngleDeg) ? startAngleDeg : 0) * DEG2RAD;
    const sweepDeg = Number.isFinite(degrees) ? degrees : 0;
    this.sweepRad = (clockwise ? -1 : 1) * sweepDeg * DEG2RAD;
    switch (plane) {
      case 'XY': this.u = new Vector3(1, 0, 0); this.v = new Vector3(0, 1, 0); break;
      case 'YZ': this.u = new Vector3(0, 1, 0); this.v = new Vector3(0, 0, 1); break;
      default:   this.u = new Vector3(1, 0, 0); this.v = new Vector3(0, 0, 1); break; // 'XZ'
    }
    this.length = this.radius * Math.abs(this.sweepRad); // == 2πR·|deg|/360
  }

  getPosition(t01: number, out: Vector3 = new Vector3()): Vector3 {
    const a = this.startRad + this.sweepRad * clamp01(t01);
    return out
      .copy(this.center)
      .addScaledVector(this.u, this.radius * Math.cos(a))
      .addScaledVector(this.v, this.radius * Math.sin(a));
  }

  getDirection(t01: number, out: Vector3 = new Vector3()): Vector3 {
    const a = this.startRad + this.sweepRad * clamp01(t01);
    const sgn = this.sweepRad < 0 ? -1 : 1;
    // d/da of (cos a·u + sin a·v), signed by travel direction — always unit length.
    return out
      .set(0, 0, 0)
      .addScaledVector(this.u, -Math.sin(a) * sgn)
      .addScaledVector(this.v, Math.cos(a) * sgn);
  }
}

// ─── RVPath ──────────────────────────────────────────────────────────────

export interface RVPathOptions {
  /** Circulating path (overhead conveyor / loop). Default false. */
  closed?: boolean;
  /** Up vector for the carrier pose (`lookRotation(tangent, align)`). Default (0,1,0). */
  align?: Vector3;
  /** Graph chaining — ids of the successor paths (junction candidates). */
  successorIds?: readonly string[];
  /** Control-point zone this path belongs to (Phase 2) — null/absent = unzoned. */
  zoneId?: string | null;
  /** Explicit zone capacity declared by this path — null/absent = not declared. */
  zoneCapacity?: number | null;
}

/**
 * One connected route: an ordered segment chain, arc-length addressed via
 * prefix sums. Graph edges (`successors` / `predecessors`) are resolved by
 * `RVPathNetwork.resolveGraph()` from the id-based `successorIds`.
 */
export class RVPath {
  readonly id: string;
  readonly segments: readonly IPathSegment[];
  readonly closed: boolean;
  readonly align: Vector3;
  readonly successorIds: readonly string[];
  /** Control-point zone id (Phase 2, rv-zone-registry.ts) — null = unzoned. */
  readonly zoneId: string | null;
  /** Explicit zone capacity declared by this path — null = not declared. */
  readonly zoneCapacity: number | null;
  /** Resolved graph links — filled by `RVPathNetwork.resolveGraph()`. */
  readonly successors: RVPath[] = [];
  readonly predecessors: RVPath[] = [];
  /** Total length in meters (Σ segment.length), cached. */
  readonly length: number;

  /** prefix[i] = arc length at the START of segment i. */
  private readonly prefix: Float64Array;

  constructor(id: string, segments: readonly IPathSegment[], opts: RVPathOptions = {}) {
    this.id = id;
    this.segments = segments;
    this.closed = opts.closed ?? false;
    this.align = (opts.align ?? new Vector3(0, 1, 0)).clone();
    if (this.align.lengthSq() < 1e-12) this.align.set(0, 1, 0);
    this.successorIds = [...(opts.successorIds ?? [])];
    this.zoneId = opts.zoneId ?? null;
    this.zoneCapacity = opts.zoneCapacity ?? null;
    this.prefix = new Float64Array(segments.length);
    let sum = 0;
    for (let i = 0; i < segments.length; i++) {
      this.prefix[i] = sum;
      sum += segments[i].length;
    }
    this.length = sum;
  }

  /** Normalise an arc-length address: wrap when closed, clamp otherwise. */
  private normalize(meters: number): number {
    const L = this.length;
    if (L <= 0) return 0;
    if (this.closed) {
      const m = meters % L;
      return m < 0 ? m + L : m;
    }
    return meters < 0 ? 0 : meters > L ? L : meters;
  }

  /** Locate `(segmentIndex, t01)` for a normalised arc-length address. */
  private locate(meters: number): { i: number; t: number } {
    const n = this.segments.length;
    if (n === 0) return { i: -1, t: 0 };
    const m = this.normalize(meters);
    // Binary search: greatest i with prefix[i] <= m.
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.prefix[mid] <= m) lo = mid;
      else hi = mid - 1;
    }
    const seg = this.segments[lo];
    const t = seg.length > 0 ? (m - this.prefix[lo]) / seg.length : 0;
    return { i: lo, t: clamp01(t) };
  }

  /** World position at an ABSOLUTE arc length in meters (constant speed). */
  getAbsPosition(meters: number, out: Vector3 = new Vector3()): Vector3 {
    const { i, t } = this.locate(meters);
    if (i < 0) return out.set(0, 0, 0);
    return this.segments[i].getPosition(t, out);
  }

  /** Normalised world tangent at an ABSOLUTE arc length in meters. */
  getAbsDirection(meters: number, out: Vector3 = new Vector3()): Vector3 {
    const { i, t } = this.locate(meters);
    if (i < 0) return out.copy(DEGENERATE_DIR);
    return this.segments[i].getDirection(t, out);
  }

  /**
   * `getSpacedPoints` equivalent: `divisions + 1` positions at EQUAL arc-length
   * spacing (a cheap LUT for placing many carriers / rendering the path).
   * Built on demand — call once and keep the result; never per frame.
   */
  getSpacedPoints(divisions: number): Vector3[] {
    const n = Math.max(1, Math.floor(divisions));
    const pts: Vector3[] = [];
    for (let i = 0; i <= n; i++) {
      pts.push(this.getAbsPosition((this.length * i) / n));
    }
    return pts;
  }
}

// ─── Path ends (plan-447 F2: snappoints at start/end) ────────────────────

/** One free end of a path — the geometric basis of a path-end snappoint. */
export interface PathEndpoint {
  /** Which end of the segment chain this is. */
  readonly which: 'start' | 'end';
  /** World position of the end. */
  readonly position: Vector3;
  /**
   * OUTWARD direction: at the start it points AGAINST travel (into the
   * upstream neighbour), at the end it points ALONG travel (into the
   * downstream neighbour) — the same convention the snap system uses for a
   * port's outward normal, so two mating ends face each other.
   */
  readonly outward: Vector3;
  /** Travel tangent at the end (always ALONG the path direction). */
  readonly tangent: Vector3;
  /** Material-flow semantics: a path START consumes, a path END emits. */
  readonly flow: 'in' | 'out';
}

/**
 * The two free ends of `path` (plan-447 F2) — null for a CLOSED path (a loop
 * has no free ends) and for an empty segment chain. Positions/directions are
 * derived from the SEGMENT DATA, not from a node's `matrixWorld`: path snaps
 * are data-bound and must be re-derived after every geometry edit.
 */
export function getPathEndpoints(path: RVPath): { start: PathEndpoint; end: PathEndpoint } | null {
  if (path.closed || path.segments.length === 0) return null;
  const startPos = path.getAbsPosition(0);
  const endPos = path.getAbsPosition(path.length);
  const startTan = path.getAbsDirection(0);
  const endTan = path.getAbsDirection(path.length);
  return {
    start: {
      which: 'start',
      position: startPos,
      outward: startTan.clone().negate(),
      tangent: startTan,
      flow: 'in',
    },
    end: {
      which: 'end',
      position: endPos,
      outward: endTan.clone(),
      tangent: endTan,
      flow: 'out',
    },
  };
}

// ─── rv_extras.Path schema (TS-SSOT, version 1) ──────────────────────────

export const PATH_SCHEMA_VERSION = 1;

export interface PathLineSpec {
  kind: 'line';
  from: [number, number, number];
  to: [number, number, number];
}

export interface PathArcSpec {
  kind: 'arc';
  center: [number, number, number];
  radius: number;
  startAngle: number;
  degrees: number;
  clockwise?: boolean;
  plane?: ArcPlane;
}

export type PathSegmentSpec = PathLineSpec | PathArcSpec;

/** The `rv_extras.Path` payload (see the module JSDoc for the JSONC example). */
export interface PathExtras {
  type: 'Path';
  version?: number;
  /** Optional stable path id — defaults to the carrying node's name. */
  id?: string;
  segments?: PathSegmentSpec[];
  closed?: boolean;
  successors?: string[];
  align?: [number, number, number];
  /** Control-point zone id (Phase 2) — absent = unzoned. */
  zone?: string;
  /** Explicit zone capacity (≥ 0; capacity 0 = zone never enterable). */
  zoneCapacity?: number;
}

/** Schema defaults (TS-SSOT) — mirrored by the conformance tests (§9.6). */
export const PATH_EXTRAS_DEFAULTS = Object.freeze({
  version: PATH_SCHEMA_VERSION,
  closed: false,
  successors: [] as readonly string[],
  align: [0, 1, 0] as readonly [number, number, number],
  zone: null as string | null,
  zoneCapacity: null as number | null,
});

/**
 * True when `raw` is an `rv_extras.Path` payload this loader owns: an object
 * whose inner `type` is `'Path'` or absent (the extras KEY already selects).
 * An explicit different `type` rejects — detection is payload-coupled, never
 * name-coupled (plan-268 §10).
 */
export function isPathExtras(raw: unknown): raw is Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const t = (raw as Record<string, unknown>).type;
  return t === undefined || t === 'Path';
}

function num(v: unknown, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function vec3(v: unknown, def: readonly [number, number, number]): Vector3 {
  if (Array.isArray(v)) {
    return new Vector3(num(v[0], def[0]), num(v[1], def[1]), num(v[2], def[2]));
  }
  return new Vector3(def[0], def[1], def[2]);
}

const VALID_PLANES: ReadonlySet<string> = new Set(['XZ', 'XY', 'YZ']);

/**
 * Reconstruct an `RVPath` from a raw `rv_extras.Path` payload. Defensive
 * throughout (`?? default`): unknown `plane` / `version` fall back to defined
 * defaults (never NaN); unknown segment kinds are skipped with a warning;
 * a payload with a foreign `type` returns null (not ours).
 */
export function parsePathExtras(raw: unknown, fallbackId: string): RVPath | null {
  if (!isPathExtras(raw)) return null;
  const version = num(raw.version, PATH_EXTRAS_DEFAULTS.version);
  if (version !== PATH_SCHEMA_VERSION) {
    console.warn(
      `[Path] '${fallbackId}': unknown rv_extras.Path version ${version} — ` +
        `parsing best-effort as version ${PATH_SCHEMA_VERSION}`,
    );
  }
  const segments: IPathSegment[] = [];
  const rawSegments = Array.isArray(raw.segments) ? raw.segments : [];
  for (const s of rawSegments) {
    if (!s || typeof s !== 'object') continue;
    const spec = s as Record<string, unknown>;
    if (spec.kind === 'line') {
      segments.push(new LineSegment(vec3(spec.from, [0, 0, 0]), vec3(spec.to, [0, 0, 0])));
    } else if (spec.kind === 'arc') {
      const plane = typeof spec.plane === 'string' && VALID_PLANES.has(spec.plane)
        ? (spec.plane as ArcPlane)
        : 'XZ';
      segments.push(new ArcSegment(
        vec3(spec.center, [0, 0, 0]),
        num(spec.radius, 0),
        num(spec.startAngle, 0),
        num(spec.degrees, 0),
        spec.clockwise === true,
        plane,
      ));
    } else {
      console.warn(`[Path] '${fallbackId}': unknown segment kind '${String(spec.kind)}' — skipped`);
    }
  }
  const successorIds = Array.isArray(raw.successors)
    ? raw.successors.filter((s): s is string => typeof s === 'string' && s.length > 0)
    : [...PATH_EXTRAS_DEFAULTS.successors];
  const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : fallbackId;
  // Zone attributes (Phase 2) — defensive: junk types fall back to "unzoned" /
  // "undeclared capacity" (never NaN, never a negative capacity).
  const zoneId = typeof raw.zone === 'string' && raw.zone.length > 0 ? raw.zone : null;
  let zoneCapacity: number | null = null;
  if (raw.zoneCapacity !== undefined) {
    const c = Number(raw.zoneCapacity);
    zoneCapacity = Number.isFinite(c) && c >= 0 ? Math.floor(c) : null;
  }
  return new RVPath(id, segments, {
    closed: raw.closed === true, // default false
    align: vec3(raw.align, PATH_EXTRAS_DEFAULTS.align),
    successorIds,
    zoneId,
    zoneCapacity,
  });
}

// ─── Node access ─────────────────────────────────────────────────────────

/** True when the node carries an `rv_extras.Path` payload (name-independent). */
export function isPathNode(node: Object3D): boolean {
  const rv = (node.userData as { realvirtual?: Record<string, unknown> } | undefined)?.realvirtual;
  return isPathExtras(rv?.['Path']);
}

/**
 * The `RVPath` reconstructed from a node's `rv_extras.Path` — parsed once and
 * cached on `userData` (non-enumerable, JSON/clone-safe). Null when the node
 * carries no (or a foreign) Path payload.
 */
export function pathFromNode(node: Object3D): RVPath | null {
  const ud = node.userData as Record<string, unknown> | undefined;
  const cached = ud?.['_rvPath'];
  if (cached instanceof RVPath) return cached;
  const rv = ud?.realvirtual as Record<string, unknown> | undefined;
  const raw = rv?.['Path'];
  if (raw === undefined) return null;
  const path = parsePathExtras(raw, node.name || 'Path');
  if (path && ud) {
    Object.defineProperty(ud, '_rvPath', {
      value: path, writable: true, configurable: true, enumerable: false,
    });
  }
  return path;
}

// ─── Scene-loader factory component ──────────────────────────────────────

/**
 * `RVPathComponent` — the scene-loader wrapper for a node with `rv_extras.Path`.
 * Parses the payload into an `RVPath` and registers it in the default
 * `RVPathNetwork` (graph resolution across all loaded paths); unregisters on
 * dispose (model-cleared) so no stale routes survive a model switch.
 */
export class RVPathComponent implements RVComponent {
  /** Loaded from the rv-ODT specification (schema/v1/rv-odt.json, plan-187
   *  style). Structured fields (segments/successors/align) are generic 'json'
   *  schema fields; `parsePathExtras` (this module) stays the SSOT for their
   *  inner shape and validates on every (re)parse. */
  static readonly schema: ComponentSchema = loadSchemaFromSpec('Path');

  readonly node: Object3D;
  isOwner = true;

  // Schema-populated
  version = PATH_SCHEMA_VERSION;
  closed = false;

  /** The reconstructed path — null when the payload could not be parsed. */
  path: RVPath | null = null;

  constructor(node: Object3D) {
    this.node = node;
  }

  init(_ctx: ComponentContext): void {
    this.node.userData._rvType = 'Path';
    this.path = pathFromNode(this.node);
    if (!this.path) {
      console.warn(`[Path] node '${this.node.name}' carries rv_extras.Path but it could not be parsed`);
      return;
    }
    defaultPathNetwork.register(this.path);
    // Declare the zone (Phase 2) so `capacityOf` reflects the schema before the
    // first claim. Max of explicit declarations wins across paths sharing the id.
    if (this.path.zoneId) {
      defaultZoneRegistry.define(this.path.zoneId, this.path.zoneCapacity ?? undefined);
    }
  }

  dispose(): void {
    if (this.path) {
      defaultPathNetwork.unregister(this.path.id);
      // Drop the zone definition on model-cleared so a later model declaring a
      // SMALLER capacity for the same id is not widened by a stale max().
      // (Partial single-path removal re-declares on the next claim walk.)
      if (this.path.zoneId) defaultZoneRegistry.undefine(this.path.zoneId);
    }
    this.path = null;
  }

  /** Re-derive the path from the node's (edited) rv_extras and swap the
   *  network/zone registration. Called by the generic editor pipeline after
   *  setField/unsetField (`reapplySchemaForComponent` → `reapplyConfig`), so
   *  segment/successor/zone edits take effect live — id changes included.
   *
   *  This is the LIVE-EDIT path (plan-447), NOT model-clear:
   *  - the zone declaration goes through `ZoneRegistry.redefine` (hard capacity
   *    overwrite so a SHRINK takes effect, holders preserved) instead of
   *    `undefine` + `define` — a claim held by a driving vehicle must survive a
   *    geometry edit, otherwise two vehicles end up inside one exclusive zone;
   *    `undefine` stays reserved for {@link dispose} (model-cleared);
   *  - the network is notified per pathId afterwards, which re-projects every
   *    traveler onto the FRESH readonly `RVPath` object (rv-path-network.ts,
   *    `reprojectTravelersOnPath`) and lets the visualizer / snap sources
   *    re-derive.
   */
  reapplyConfig(): void {
    const prevId = this.path?.id ?? null;
    const prevZone = this.path?.zoneId ?? null;
    if (this.path) defaultPathNetwork.unregister(this.path.id);
    // Invalidate the parse cache (pathFromNode memoizes on userData).
    delete (this.node.userData as Record<string, unknown>)['_rvPath'];
    this.path = pathFromNode(this.node);
    if (!this.path) {
      // Unparsable payload → stays unregistered until fixed. Still announce the
      // change so visualizer/snap consumers drop their stale derivation.
      if (prevId !== null) defaultPathNetwork.notifyPathChanged(prevId);
      return;
    }
    defaultPathNetwork.register(this.path);
    // The path LEFT its previous zone → withdraw only its capacity DECLARATION
    // (back to "undeclared"), never the holders: another path may still share
    // the zone, and the Agv claim walk re-declares the effective capacity on
    // its next pass. `undefine` here would again free live claims.
    if (prevZone && prevZone !== this.path.zoneId) {
      defaultZoneRegistry.redefine(prevZone);
    }
    if (this.path.zoneId) {
      defaultZoneRegistry.redefine(this.path.zoneId, this.path.zoneCapacity ?? undefined);
    }
    // An id rename affects BOTH ids: the old one vanished, the new one appeared.
    if (prevId !== null && prevId !== this.path.id) {
      defaultPathNetwork.notifyPathChanged(prevId);
    }
    defaultPathNetwork.notifyPathChanged(this.path.id);
  }
}

// ─── Self-register ───────────────────────────────────────────────────────

registerComponent({
  type: 'Path',
  schema: RVPathComponent.schema,
  capabilities: {
    hierarchyVisible: true,
    inspectorVisible: true,
    filterLabel: 'Paths',
    badgeColor: '#26a69a',
    // Authorable in the asset editor / via MCP: a fresh Path starts from the
    // schema defaults (empty segment list) and is edited through the generic
    // json fields (segments/successors) — no dedicated path tool needed.
    authorable: true,
  },
  create: (node) => new RVPathComponent(node),
  afterCreate: (inst, node) => {
    node.userData._rvType = 'Path';
    setComponentInstance(node, inst);
  },
});
