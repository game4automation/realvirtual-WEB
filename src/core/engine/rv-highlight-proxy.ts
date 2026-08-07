// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ProxyOverlayProvider — §4.2 zero-copy drawRange highlight proxies.
 *
 * Serves the overlay-family highlight (fill + edges) for targets covered by
 * the merged raycast pick geometry (rv-raycast-geometry.ts) WITHOUT building
 * any geometry at hover time:
 *
 *   - Fill proxy: a pooled Mesh whose BufferGeometry SHARES the group mesh's
 *     `position` attribute + index (zero-copy on GPU) and renders only the hit
 *     node's contiguous face window via `setDrawRange`.
 *   - Edge proxy: a pooled LineSegments over a one-time async **edge-index
 *     arena** — ONE line-segment index per group, in DFS face order, so each
 *     face range maps to a contiguous segment window.
 *
 * Both rest on the DFS-contiguity invariant of the face-range tables: all
 * ranges belonging to one node path form ONE consecutive run. That invariant
 * is asserted here (warn + legacy fallback, never a throw in the pick path).
 *
 * Hard constraints (doc-render-picking.md §4.2):
 *   - NEVER dispose a proxy BufferGeometry while the RaycastGeometrySet is
 *     alive — three.js `geometry.dispose()` dispatches a dispose event that
 *     deallocates the GL buffers of ALL its attributes, including the shared
 *     position/index VBOs used by every other proxy AND the pick mesh itself
 *     (WebGLGeometries has no refcount). On provider dispose we therefore only
 *     DROP references; the shared attribute VBOs are freed when the set's own
 *     geometries are disposed (clearModel traverse).
 *   - Proxies need `frustumCulled = false` + a pre-assigned `boundingSphere`
 *     (renderer sorting would otherwise compute one over ALL merged vertices).
 *   - Full overlay object contract: `_highlightOverlay`, raycast noop,
 *     HIGHLIGHT_OVERLAY_LAYER, depthTest/depthWrite false.
 *   - Never touches arena/batch state (no setVisibleAt / setColorAt).
 */

import {
  Object3D,
  Mesh,
  LineSegments,
  BufferGeometry,
  BufferAttribute,
  MeshBasicMaterial,
  LineBasicMaterial,
  Sphere,
  Vector3,
} from 'three';
import type {
  RaycastGeometrySet,
  RaycastGroup,
  FaceRange,
} from './rv-raycast-geometry';
import type {
  HighlightOverlayProvider,
  OverlayChannel,
  OverlayHandle,
  HighlightStyle,
} from './rv-highlight-manager';
import { HIGHLIGHT_OVERLAY_LAYER } from './rv-group-registry';
import { debug } from './rv-debug';

// ─── Tuning constants ───────────────────────────────────────────────

/** Faces processed per idle slice of the edge-arena build. */
const ARENA_CHUNK_FACES = 20_000;
/** Vertex-weld quantization (~0.1 mm at meter scale). */
const WELD_INV_PRECISION = 10_000;
/** Same crease threshold as EdgesGeometry in the legacy path (30°).
 *  An edge is a silhouette edge when the adjacent face normals satisfy
 *  dot <= cos(threshold) — or when it borders only one face (boundary). */
const EDGE_THRESHOLD_DOT = Math.cos(30 * (Math.PI / 180));

/** Render-order bases per channel — mirrors RVHighlightManager's legacy
 *  overlay pairs (selection under hover under flash; edge draws over fill). */
const CHANNEL_RENDER_ORDER: Record<OverlayChannel, number> = {
  hover: 1000,
  selection: 900,
  aux: 900,
  flash: 1100,
};

// ─── Face-window derivation ─────────────────────────────────────────

/** Contiguous face window of one node path inside one RaycastGroup. */
export interface FaceWindow {
  /** Inclusive start triangle index. */
  startFace: number;
  /** Exclusive end triangle index. */
  endFace: number;
  /** Index of the first matching entry in the group's faceRanges. */
  firstRange: number;
  /** Index of the last matching entry in the group's faceRanges. */
  lastRange: number;
}

/**
 * Derive the merged face window of `path` from a DFS-ordered face-range table:
 * the run of consecutive ranges whose objectPath equals `path` or starts with
 * `path + '/'`. Returns null when nothing matches, and the literal
 * `'violation'` when matches are NON-consecutive — that breaks the
 * DFS-contiguity invariant a single drawRange window depends on.
 */
export function deriveFaceWindow(
  ranges: readonly FaceRange[],
  path: string,
): FaceWindow | null | 'violation' {
  const prefix = path + '/';
  let first = -1;
  let last = -1;
  for (let i = 0; i < ranges.length; i++) {
    const p = ranges[i].objectPath;
    const match = p === path || p.startsWith(prefix);
    if (!match) continue;
    if (first === -1) {
      first = i;
      last = i;
    } else if (i === last + 1) {
      last = i;
    } else {
      return 'violation';
    }
  }
  if (first === -1) return null;
  return {
    startFace: ranges[first].startFace,
    endFace: ranges[last].endFace,
    firstRange: first,
    lastRange: last,
  };
}

// ─── Minimal registry seam (NodeRegistry satisfies this structurally) ──

/** The only NodeRegistry capability the provider needs. */
export interface PathResolver {
  getPathForNode(node: Object3D): string | null;
}

// ─── Internal state types ───────────────────────────────────────────

/** Segment window of one face range inside the group's edge arena. */
interface SegRange {
  startSeg: number;
  endSeg: number;
}

/** Adjacency record for one welded edge during arena extraction. */
interface EdgeRec {
  count: number;
  /** First adjacent face normal (zero when degenerate). */
  nx: number;
  ny: number;
  nz: number;
  /** ORIGINAL (un-welded) index pair to emit — references the shared position attribute. */
  ia: number;
  ib: number;
  /** Marked when any adjacent-face pair exceeds the crease threshold. */
  keep: boolean;
}

/** Incremental per-group edge-arena build cursor (survives idle slices). */
interface ArenaBuild {
  rangeIdx: number;
  /** Next absolute face to process (ranges tile the face space contiguously). */
  face: number;
  /** Position-hash → canonical vertex id. Scoped PER RANGE — ranges come from
   *  separate source meshes, and per-range scoping keeps segment windows
   *  independent (an edge shared across ranges is a boundary in each). */
  weld: Map<string, number>;
  edges: Map<string, EdgeRec>;
  /** Arena accumulation: original index pairs, 2 entries per segment. */
  segs: number[];
  segRanges: SegRange[];
}

interface GroupState {
  group: RaycastGroup;
  /** Cached face windows per queried path (null = no coverage). */
  windows: Map<string, FaceWindow | null>;
  /** Paths whose face ranges violated the DFS-contiguity assertion. */
  violated: Set<string>;
  /** In-progress arena build, null once finished (or before start). */
  build: ArenaBuild | null;
  /** Edge arena results — non-null when the arena is ready. */
  edgeIndex: BufferAttribute | null;
  segRanges: SegRange[] | null;
}

/** One live proxy object (fill or edge) belonging to an acquired handle. */
interface ProxyItem {
  obj: Mesh | LineSegments;
  kind: 'fill' | 'edge';
}

// ─── Idle scheduling (requestIdleCallback with setTimeout fallback) ──

type IdleGlobal = {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
};

function scheduleIdle(cb: () => void): void {
  const ric = (globalThis as IdleGlobal).requestIdleCallback;
  if (typeof ric === 'function') ric(cb, { timeout: 100 });
  else setTimeout(cb, 0);
}

// ─── Scratch (allocation-free face-normal computation) ──────────────

const _vA = new Vector3();
const _vB = new Vector3();
const _vC = new Vector3();
const _vAB = new Vector3();
const _vAC = new Vector3();
const _vN = new Vector3();

// ─── Provider ───────────────────────────────────────────────────────

/**
 * §4.2 drawRange highlight-proxy provider over a RaycastGeometrySet.
 *
 * Lifecycle: constructed after the set is built, `startEdgeArenaBuild()`
 * kicked immediately (chunked, idle-time), `dispose()` together with the set
 * (clearModel / grouped-BVH rebuild). Until a group's edge arena is ready,
 * `canHandle` reports false for targets in that group and the highlighter
 * keeps using the legacy overlay path — behavior identical to today.
 */
export class ProxyOverlayProvider implements HighlightOverlayProvider {
  private readonly _groups: GroupState[] = [];
  private readonly _stateByGroup = new Map<RaycastGroup, GroupState>();

  /** Pooled fill wrappers (parked out of the scene). */
  private readonly _freeFills: Mesh[] = [];
  /** Pooled edge wrappers (parked out of the scene). */
  private readonly _freeEdges: LineSegments[] = [];
  /** All live (acquired, in-scene) proxy items — released on dispose. */
  private readonly _liveItems = new Set<ProxyItem>();

  /** Style-keyed material caches (provider-owned; disposed with the provider). */
  private readonly _fillMats = new Map<string, MeshBasicMaterial>();
  private readonly _edgeMats = new Map<string, LineBasicMaterial>();

  private _disposed = false;
  private _buildStarted = false;
  private _buildDone = false;
  private readonly _whenReady: Promise<void>;
  private _resolveReady!: () => void;

  constructor(
    private readonly _registry: PathResolver,
    set: RaycastGeometrySet,
  ) {
    if (set.staticGroup) this._addGroup(set.staticGroup);
    for (const group of set.kinematicGroups.values()) this._addGroup(group);
    this._whenReady = new Promise<void>((r) => { this._resolveReady = r; });
  }

  private _addGroup(group: RaycastGroup): void {
    const state: GroupState = {
      group,
      windows: new Map(),
      violated: new Set(),
      build: null,
      edgeIndex: null,
      segRanges: null,
    };
    this._groups.push(state);
    this._stateByGroup.set(group, state);
  }

  // ─── Readiness ────────────────────────────────────────────────────

  /** Resolves when ALL edge arenas are built (or the provider is disposed). */
  get whenReady(): Promise<void> {
    return this._whenReady;
  }

  /** Whether the edge arena of one group is ready. */
  isReady(group: RaycastGroup): boolean {
    return this._stateByGroup.get(group)?.segRanges != null;
  }

  /**
   * Start the chunked edge-arena build (idempotent). Runs in idle slices of
   * ~20k faces so a large model never janks the frame it loaded into.
   */
  startEdgeArenaBuild(): void {
    if (this._buildStarted || this._disposed) return;
    this._buildStarted = true;
    if (this._groups.length === 0) {
      this._finishBuild();
      return;
    }
    for (const gs of this._groups) {
      gs.build = {
        rangeIdx: 0,
        face: gs.group.faceRanges[0]?.startFace ?? 0,
        weld: new Map(),
        edges: new Map(),
        segs: [],
        segRanges: [],
      };
    }
    scheduleIdle(() => this._pump());
  }

  // ─── HighlightOverlayProvider ─────────────────────────────────────

  /**
   * True when (a) at least one group has a face window for the target's path,
   * (b) EVERY contributing group's edge arena is ready, and (c) no group's
   * face-range table violates the DFS-contiguity assertion for the path.
   */
  canHandle(target: Object3D): boolean {
    if (this._disposed) return false;
    const path = this._registry.getPathForNode(target);
    if (!path) return false;
    let any = false;
    for (const gs of this._groups) {
      const win = this._windowFor(gs, path);
      if (gs.violated.has(path)) return false;
      if (!win) continue;
      if (!gs.segRanges) return false; // arena not ready → legacy path
      any = true;
    }
    return any;
  }

  /**
   * Acquire pooled fill/edge proxies for every group covering the target.
   * Defensive: acquiring an uncovered target returns an empty (no-op) handle.
   */
  acquire(target: Object3D, channel: OverlayChannel, style: HighlightStyle): OverlayHandle {
    const items: ProxyItem[] = [];
    const path = this._disposed ? null : this._registry.getPathForNode(target);
    if (path) {
      const renderOrder = CHANNEL_RENDER_ORDER[channel];
      for (const gs of this._groups) {
        const win = this._windowFor(gs, path);
        if (!win) continue;
        if (style.showOverlay) {
          const item = this._acquireFill(gs, win, style, renderOrder);
          if (item) items.push(item);
        }
        if (style.showEdges && gs.segRanges && gs.edgeIndex) {
          const item = this._acquireEdge(gs, win, style, renderOrder + 1);
          if (item) items.push(item);
        }
      }
    }
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        for (const item of items) this._releaseItem(item);
      },
    };
  }

  // ─── Disposal ─────────────────────────────────────────────────────

  /**
   * Remove all live proxies from the scene and drop the pools. Proxy
   * BufferGeometries are NOT disposed — their attributes are shared with the
   * pick geometry, and `geometry.dispose()` would deallocate those GL buffers
   * for every proxy AND the pick mesh. References are dropped instead; the
   * shared VBOs die with the RaycastGeometrySet's own geometry disposal.
   */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    for (const item of this._liveItems) item.obj.removeFromParent();
    this._liveItems.clear();
    for (const wrapper of [...this._freeFills, ...this._freeEdges]) {
      // Drop shared-attribute references WITHOUT dispose (see doc above).
      wrapper.geometry.setIndex(null);
      wrapper.geometry.deleteAttribute('position');
    }
    this._freeFills.length = 0;
    this._freeEdges.length = 0;
    for (const m of this._fillMats.values()) m.dispose();
    for (const m of this._edgeMats.values()) m.dispose();
    this._fillMats.clear();
    this._edgeMats.clear();
    for (const gs of this._groups) {
      gs.build = null;
      gs.edgeIndex = null; // reference drop only — never disposed
      gs.segRanges = null;
      gs.windows.clear();
    }
    this._finishBuild(); // never leave a whenReady await dangling
  }

  // ─── Window cache ─────────────────────────────────────────────────

  private _windowFor(gs: GroupState, path: string): FaceWindow | null {
    const cached = gs.windows.get(path);
    if (cached !== undefined) return cached;
    const derived = deriveFaceWindow(gs.group.faceRanges, path);
    if (derived === 'violation') {
      // Invariant guard, not control flow: the group builders emit DFS-ordered
      // tables, so matches for one subtree MUST be consecutive. Warn once per
      // path and fall back to the legacy overlay (never throw in a pick path).
      console.warn(
        `[HighlightProxy] non-contiguous face ranges for '${path}' — ` +
        `DFS-contiguity invariant violated, falling back to legacy overlay`,
      );
      gs.violated.add(path);
      gs.windows.set(path, null);
      return null;
    }
    gs.windows.set(path, derived);
    return derived;
  }

  // ─── Proxy acquisition ────────────────────────────────────────────

  private _acquireFill(
    gs: GroupState,
    win: FaceWindow,
    style: HighlightStyle,
    renderOrder: number,
  ): ProxyItem | null {
    const srcGeo = gs.group.mesh.geometry;
    const position = srcGeo.getAttribute('position');
    if (!position) return null;

    const wrapper = this._freeFills.pop() ?? this._newWrapper('fill');
    const geo = wrapper.geometry;
    if (geo.getAttribute('position') !== position) geo.setAttribute('position', position);
    const srcIndex = srcGeo.getIndex();
    if (geo.getIndex() !== srcIndex) geo.setIndex(srcIndex);
    // drawRange counts index entries (or vertices when non-indexed) — either
    // way one face is 3 entries, so the face window maps directly.
    geo.setDrawRange(win.startFace * 3, (win.endFace - win.startFace) * 3);
    this._assignBoundingSphere(geo, srcGeo);

    wrapper.material = this._fillMaterial(style);
    wrapper.renderOrder = renderOrder;
    this._attach(wrapper, gs);
    const item: ProxyItem = { obj: wrapper, kind: 'fill' };
    this._liveItems.add(item);
    return item;
  }

  private _acquireEdge(
    gs: GroupState,
    win: FaceWindow,
    style: HighlightStyle,
    renderOrder: number,
  ): ProxyItem | null {
    const srcGeo = gs.group.mesh.geometry;
    const position = srcGeo.getAttribute('position');
    const segRanges = gs.segRanges!;
    const startSeg = segRanges[win.firstRange].startSeg;
    const endSeg = segRanges[win.lastRange].endSeg;
    if (!position || endSeg <= startSeg) return null;

    const wrapper = this._freeEdges.pop() ?? this._newWrapper('edge');
    const geo = wrapper.geometry;
    if (geo.getAttribute('position') !== position) geo.setAttribute('position', position);
    if (geo.getIndex() !== gs.edgeIndex) geo.setIndex(gs.edgeIndex);
    geo.setDrawRange(startSeg * 2, (endSeg - startSeg) * 2);
    this._assignBoundingSphere(geo, srcGeo);

    wrapper.material = this._edgeMaterial(style);
    wrapper.renderOrder = renderOrder;
    this._attach(wrapper, gs);
    const item: ProxyItem = { obj: wrapper, kind: 'edge' };
    this._liveItems.add(item);
    return item;
  }

  /** Parent the proxy EXACTLY like the group's BVH mesh: same parent, same
   *  local matrix, matrixAutoUpdate off. Kinematic groups are children of
   *  their Drive node, so the proxy follows drive motion for free (its world
   *  matrix composes from the live parent chain each frame — that is why,
   *  unlike the scene-rooted legacy pairs, matrixWorldAutoUpdate stays ON). */
  private _attach(wrapper: Mesh | LineSegments, gs: GroupState): void {
    wrapper.matrix.copy(gs.group.mesh.matrix);
    gs.group.mesh.parent?.add(wrapper);
    wrapper.updateMatrixWorld(true);
  }

  /** Pre-assign the group's boundingSphere (computed once, lazily) so the
   *  renderer's sort never walks ALL merged vertices for a proxy. */
  private _assignBoundingSphere(geo: BufferGeometry, srcGeo: BufferGeometry): void {
    if (!srcGeo.boundingSphere) srcGeo.computeBoundingSphere();
    if (!geo.boundingSphere) geo.boundingSphere = new Sphere();
    if (srcGeo.boundingSphere) geo.boundingSphere.copy(srcGeo.boundingSphere);
  }

  private _releaseItem(item: ProxyItem): void {
    if (!this._liveItems.delete(item)) return; // already gone (e.g. dispose)
    item.obj.removeFromParent();
    if (this._disposed) return;
    if (item.kind === 'fill') this._freeFills.push(item.obj as Mesh);
    else this._freeEdges.push(item.obj as LineSegments);
  }

  /** New pooled wrapper with the full overlay object contract. */
  private _newWrapper(kind: 'fill'): Mesh;
  private _newWrapper(kind: 'edge'): LineSegments;
  private _newWrapper(kind: 'fill' | 'edge'): Mesh | LineSegments {
    const obj = kind === 'fill'
      ? new Mesh(new BufferGeometry())
      : new LineSegments(new BufferGeometry());
    obj.name = kind === 'fill' ? '__hlProxyFill' : '__hlProxyEdge';
    obj.userData._highlightOverlay = true; // excluded from picking + collectMeshes
    obj.raycast = () => {};
    obj.matrixAutoUpdate = false;
    obj.layers.set(HIGHLIGHT_OVERLAY_LAYER);
    obj.frustumCulled = false; // drawRange window ≠ full geometry bounds
    return obj;
  }

  // ─── Materials (cached per style key; provider-owned) ─────────────

  private _fillMaterial(style: HighlightStyle): MeshBasicMaterial {
    const key = `${style.overlayColor}_${style.overlayOpacity}_${style.overlayWireframe ? 1 : 0}`;
    let mat = this._fillMats.get(key);
    if (!mat) {
      mat = new MeshBasicMaterial({
        color: style.overlayColor,
        opacity: style.overlayOpacity,
        wireframe: style.overlayWireframe,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      });
      mat.name = '_hlProxyFill';
      this._fillMats.set(key, mat);
    }
    return mat;
  }

  private _edgeMaterial(style: HighlightStyle): LineBasicMaterial {
    const key = `${style.edgeColor}_${style.edgeOpacity}`;
    let mat = this._edgeMats.get(key);
    if (!mat) {
      mat = new LineBasicMaterial({
        color: style.edgeColor,
        opacity: style.edgeOpacity,
        linewidth: style.edgeLinewidth ?? 1,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      });
      mat.name = '_hlProxyEdge';
      this._edgeMats.set(key, mat);
    }
    return mat;
  }

  // ─── Edge-arena build (chunked) ───────────────────────────────────

  private _pump(): void {
    if (this._disposed || this._buildDone) return;
    let budget = ARENA_CHUNK_FACES;
    for (const gs of this._groups) {
      if (budget <= 0) break;
      if (!gs.build) continue; // this group already finished
      budget = this._advanceGroup(gs, budget);
    }
    if (this._groups.every((g) => !g.build)) {
      this._finishBuild();
      return;
    }
    scheduleIdle(() => this._pump());
  }

  /** Advance one group's arena build by up to `budget` faces; returns the
   *  remaining budget. Completes ranges incrementally — a range larger than
   *  one slice keeps its weld/edge maps alive across slices. */
  private _advanceGroup(gs: GroupState, budget: number): number {
    const build = gs.build!;
    const ranges = gs.group.faceRanges;
    while (budget > 0 && build.rangeIdx < ranges.length) {
      const range = ranges[build.rangeIdx];
      if (build.face < range.startFace) build.face = range.startFace;
      const todo = Math.min(range.endFace - build.face, budget);
      if (todo > 0) {
        this._extractEdges(gs, build, build.face, build.face + todo);
        build.face += todo;
        budget -= todo;
      }
      if (build.face >= range.endFace) this._flushRange(build);
    }
    if (build.rangeIdx >= ranges.length) {
      // Group complete → publish the arena.
      gs.edgeIndex = new BufferAttribute(new Uint32Array(build.segs), 1);
      gs.segRanges = build.segRanges;
      gs.build = null;
      debug('loader',
        `[HighlightProxy] edge arena ready: '${gs.group.mesh.name}' — ` +
        `${build.segs.length / 2} segments over ${ranges.length} ranges`);
    }
    return budget;
  }

  /** Extract candidate edges for faces [from, to) of the CURRENT range. */
  private _extractEdges(gs: GroupState, build: ArenaBuild, from: number, to: number): void {
    const geo = gs.group.mesh.geometry;
    const position = geo.getAttribute('position');
    const index = geo.getIndex();
    const { weld, edges } = build;

    for (let f = from; f < to; f++) {
      const i0 = index ? index.getX(f * 3) : f * 3;
      const i1 = index ? index.getX(f * 3 + 1) : f * 3 + 1;
      const i2 = index ? index.getX(f * 3 + 2) : f * 3 + 2;

      const c0 = this._canonical(weld, position, i0);
      const c1 = this._canonical(weld, position, i1);
      const c2 = this._canonical(weld, position, i2);

      // Face normal (zero for degenerate faces → adjacency counted, crease not).
      _vA.fromBufferAttribute(position as BufferAttribute, i0);
      _vB.fromBufferAttribute(position as BufferAttribute, i1);
      _vC.fromBufferAttribute(position as BufferAttribute, i2);
      _vAB.subVectors(_vB, _vA);
      _vAC.subVectors(_vC, _vA);
      _vN.crossVectors(_vAB, _vAC);
      const lenSq = _vN.lengthSq();
      const degenerate = lenSq < 1e-20;
      if (!degenerate) _vN.multiplyScalar(1 / Math.sqrt(lenSq));

      this._recordEdge(edges, c0, c1, i0, i1, degenerate);
      this._recordEdge(edges, c1, c2, i1, i2, degenerate);
      this._recordEdge(edges, c2, c0, i2, i0, degenerate);
    }
  }

  /** Welded canonical vertex id: first original index seen at this position. */
  private _canonical(weld: Map<string, number>, position: { getX(i: number): number; getY(i: number): number; getZ(i: number): number }, i: number): number {
    const key =
      `${Math.round(position.getX(i) * WELD_INV_PRECISION)}_` +
      `${Math.round(position.getY(i) * WELD_INV_PRECISION)}_` +
      `${Math.round(position.getZ(i) * WELD_INV_PRECISION)}`;
    const existing = weld.get(key);
    if (existing !== undefined) return existing;
    weld.set(key, i);
    return i;
  }

  private _recordEdge(
    edges: Map<string, EdgeRec>,
    ca: number,
    cb: number,
    ia: number,
    ib: number,
    degenerate: boolean,
  ): void {
    const key = ca < cb ? `${ca}_${cb}` : `${cb}_${ca}`;
    const rec = edges.get(key);
    if (!rec) {
      edges.set(key, {
        count: 1,
        nx: degenerate ? 0 : _vN.x,
        ny: degenerate ? 0 : _vN.y,
        nz: degenerate ? 0 : _vN.z,
        ia,
        ib,
        keep: false,
      });
      return;
    }
    rec.count++;
    if (rec.keep || degenerate) return;
    const firstIsZero = rec.nx === 0 && rec.ny === 0 && rec.nz === 0;
    if (firstIsZero) return;
    const dot = rec.nx * _vN.x + rec.ny * _vN.y + rec.nz * _vN.z;
    if (dot <= EDGE_THRESHOLD_DOT) rec.keep = true;
  }

  /** Emit the finished range's silhouette segments into the arena, aligned
   *  with the faceRanges table (one SegRange per FaceRange). */
  private _flushRange(build: ArenaBuild): void {
    const startSeg = build.segs.length / 2;
    for (const rec of build.edges.values()) {
      if (rec.count === 1 || rec.keep) {
        build.segs.push(rec.ia, rec.ib);
      }
    }
    build.segRanges.push({ startSeg, endSeg: build.segs.length / 2 });
    build.weld.clear();
    build.edges.clear();
    build.rangeIdx++;
  }

  private _finishBuild(): void {
    if (this._buildDone) return;
    this._buildDone = true;
    this._resolveReady();
  }
}
