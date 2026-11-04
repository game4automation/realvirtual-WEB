// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { getLocalStorage, readLocalStorage } from '../rv-safe-storage';

/**
 * EditorArenaManager — the asset editor's batched display (plan-766 Phase 2).
 *
 * The editor keeps ONE tree: the authored meshes stay in the scene, pickable,
 * highlightable, exportable, with their `.visible` untouched. What changes is
 * who DRAWS them: every mesh that can be (see `rv-editor-arena-classify.ts`)
 * becomes an instance of a `BatchedMesh` arena — one arena per material
 * bucket × attribute layout, the untextured majority on one uber arena with
 * colour and roughness/metalness per instance — and the source is taken off
 * the renderer with `layers.mask = 0` (the existing "batched source:
 * visible=true, mask=0" contract, `rv-highlight-manager.ts` `isRenderedMesh`,
 * `rv-pick-utils.ts`). Picking (InstancePickIndex), highlight pairs, the MCP
 * universe and the GLB export keep working on the sources unchanged.
 *
 * Keeping the arenas in step with the tree (§2.4.2):
 *   - transforms: {@link beforeFrame} runs once per frame after the viewer's
 *     single `scene.updateMatrixWorld()` and compares every source's
 *     `matrixWorld` with the instance cache — one `setMatrixAt` per moved
 *     part, no writer wiring (gizmo, jog, MCP, undo, reparent, root move);
 *     a determinant sign flip switches the instance to the mirrored geometry
 *     copy (three sets `frontFaceCW` per object, not per instance);
 *   - visibility: {@link bumpVisibility} (op executor, group registry,
 *     auto-filter, isolate) arms an epoch; the next {@link beforeFrame}
 *     recomputes the chain visibility (`.visible` + `rv.Hidden`, detached /
 *     trashed = hidden) of every instance;
 *   - structure/material: {@link add} / {@link remove} / {@link setMaterial} /
 *     {@link invalidate} / {@link reconcile}, driven by the op listener in
 *     `rv-editor-arena-ops.ts`.
 *
 * Capture mode ({@link enterCapture} / {@link leaveCapture}, refcounted):
 * sources back on their ORIGINAL layers, arenas masked out — for render paths
 * that need the real meshes (thumbnail clone, agent-eye capture, wireframe
 * view, group/filter isolate).
 *
 * Ownership: the manager owns the arenas' BatchedMesh geometry + textures and
 * every `RVUberArenaMaterial`; a material arena draws with the SOURCE material,
 * which is never disposed here. Nothing is ever written to a source's
 * `userData` (it is JSON-cloned on export) — the mesh → instance map is a
 * WeakMap plus an iterable record array.
 *
 * DORMANT in plan-766 Phase 2 steps 1–4: nothing installs a manager yet; the
 * viewer seams (`viewer.editorArena?.…`, `arenaSinkOf(…)`) are null checks.
 */

import {
  BatchedMesh,
  type BufferAttribute,
  type BufferGeometry,
  type InterleavedBufferAttribute,
  type Material,
  type Mesh,
  type MeshStandardMaterial,
  type Object3D,
} from 'three';
import { bakeRoleOf } from '../engine/rv-component-registry';
import { isAuthoredHidden, isPickableMesh } from '../engine/rv-pick-utils';
import { isPlacedReferenceNode } from '../engine/rv-reference-scope';
import {
  canonicalizeForArena,
  arenaLayoutSignature,
  flipWinding,
  type ArenaAttrSpec,
} from '../engine/rv-mesh-merge-batch';
import { RVUberArenaMaterial } from '../engine/rv-uber-arena-material';
import { setSceneArenaSink, sceneArenaSink, type ArenaVisibilitySink } from '../engine/rv-arena-sink';
import {
  ARENA_INSTANCE_SLACK,
  ARENA_RESERVE,
  ARENA_MATERIAL_THRESHOLD,
  arenaLayoutFor,
  bucketKeyOf,
  classifyMeshDetailed,
  geometryKeyOf,
  isMirrored,
  planArenas,
  stagedSizeOf,
  type PlannedArena,
  type RoleOf,
} from './rv-editor-arena-classify';

// ─── Public types (plan-766 §2.3) ───────────────────────────────────────

export type ArenaBucket = { kind: 'uber' } | { kind: 'material'; material: Material };

export interface InstanceRef {
  readonly arena: EditorArena;
  readonly instanceId: number;
  readonly geometryId: number;
}

export interface EditorArena {
  readonly bucket: ArenaBucket;
  /** Attribute-layout signature — one arena per bucket × signature. */
  readonly signature: string;
  /** In the manager's scene, NEVER under the asset root. */
  readonly mesh: BatchedMesh;
  readonly capacity: { instances: number; vertices: number; indices: number };
  readonly used: { instances: number; vertices: number; indices: number };
  /** `${geometry.uuid}|${mirrored ? 1 : 0}` → geometry id. */
  readonly geometryIds: ReadonlyMap<string, number>;
  /** Uber arenas only: the per-instance RG8 roughness/metalness texture. */
  readonly rmTexture?: import('three').DataTexture;
}

export interface EditorArenaStats {
  arenas: number;
  instances: number;
  standalone: number;
  /** Visible renderables of one frame: arenas with a visible instance + visible standalone meshes
   *  (capture mode: every visible source). No GPU involved. */
  drawCallsEstimate: number;
  /** In-place capacity growths since the last build. */
  grows: number;
  /** Capture refcount. */
  captureDepth: number;
  /** Meshes waiting for their CPU buffers (a worker BVH build holds them) — drawn on their own meanwhile. */
  deferred: number;
}

/**
 * localStorage key: '1' turns per-instance frustum culling ON (measurement switch).
 *
 * Default OFF, fixed by the plan-766 Schritt-5 acceptance (Chrome, 2026-10-19):
 * culling costs more CPU than it saves GPU on both models (two runs) — render
 * CPU CAD-import showcase model totale 5.0–5.8 → 10.3–11.0 ms, close-up 2.8–5.4 → 8.0–10.1 ms; the large CAD line
 * totale 75–141 → 126–199 ms, close-up 66–82 → 97–192 ms; the large CAD line close-up wall
 * time incl. `gl.finish()` 74–106 → 93–113 ms (unbatched tree: 145 ms). Spatial
 * sub-arenas are the follow-up lever, not this flag.
 */
export const ARENA_CULL_LS_KEY = 'rv-webviewer-arena-cull';

function readArenaCullFlag(): boolean {
  try {
    return getLocalStorage() !== null && readLocalStorage(ARENA_CULL_LS_KEY) === '1';
  } catch {
    return false;
  }
}

export interface EditorArenaManagerOptions {
  /** Parent of the arenas — `viewer.scene`. Its sink slot is claimed while built. */
  scene: Object3D;
  /** WebGPU renderer → no rm shader patch (colour per instance only). */
  isWebGPU?: boolean;
  /** Bake-role lookup (default `bakeRoleOf`). */
  roleOf?: RoleOf;
  /** Minimum mesh count of a material bucket (default 16). */
  materialThreshold?: number;
  /** Capacity reserve fraction (default 0.25). */
  reserve?: number;
  /** Per-instance frustum culling (default: dev flag `rv-webviewer-arena-cull` = '1'). */
  perObjectCulling?: boolean;
  /** Subtrees to leave alone entirely (viewer fixtures, ghosts, …). Placed references are always left alone (plan-774). */
  isExcluded?: (node: Object3D) => boolean;
  /** Called after a mutation outside the frame loop (markRenderDirty / markShadowsDirty). */
  onChanged?: () => void;
}

// ─── Internals ──────────────────────────────────────────────────────────

interface InstanceRecord extends InstanceRef {
  readonly mesh: Mesh;
  arena: ArenaImpl;
  instanceId: number;
  geometryId: number;
  mirrored: boolean;
  /** Geometry / material the instance was built from (in-place change detection). */
  geometry: BufferGeometry;
  material: Material;
  /** The source's layer mask BEFORE the manager touched it. */
  readonly originalMask: number;
  /** Visibility last written with setVisibleAt. */
  visible: boolean;
  /** Position in the record array (swap-remove). */
  slot: number;
}

interface StandaloneRecord {
  geometry: BufferGeometry;
  material: Material | Material[];
}

/** Arena layer mask while drawing (layer 0). */
const ARENA_DRAW_MASK = 1;

class ArenaImpl implements EditorArena {
  readonly geometryIds = new Map<string, number>();
  live = 0;
  capVertices: number;
  capIndices: number;

  constructor(
    readonly key: string,
    readonly bucket: ArenaBucket,
    readonly signature: string,
    readonly layout: ArenaAttrSpec[],
    readonly mesh: BatchedMesh,
    readonly ownMaterial: RVUberArenaMaterial | null,
    capVertices: number,
    capIndices: number,
  ) {
    this.capVertices = capVertices;
    this.capIndices = capIndices;
  }

  get capacity() {
    return { instances: this.mesh.maxInstanceCount, vertices: this.capVertices, indices: this.capIndices };
  }

  get used() {
    return {
      instances: this.mesh.instanceCount,
      vertices: this.capVertices - this.mesh.unusedVertexCount,
      indices: this.capIndices - this.mesh.unusedIndexCount,
    };
  }

  get rmTexture() { return this.ownMaterial?.rmTexture; }
}

/** BatchedMesh skips its draw-list rebuild unless this flag is set (r185
 *  `onBeforeRender`); `setGeometryIdAt` does not set it. */
function markDrawListDirty(mesh: BatchedMesh): void {
  (mesh as unknown as { _visibilityChanged: boolean })._visibilityChanged = true;
}

/**
 * True when a CPU buffer of `geometry` is detached right now. The worker BVH
 * build (`rv-bvh-build-port.ts`) TRANSFERS a geometry's position/index buffers
 * for the duration of the build and restores them on resolve; staging such a
 * geometry into an arena would throw. The GPU copy is unaffected.
 */
export function hasDetachedBuffers(geometry: BufferGeometry): boolean {
  const idx = geometry.index;
  if (idx && (idx.array as unknown as { buffer?: ArrayBufferLike }).buffer?.byteLength === 0) return true;
  for (const name in geometry.attributes) {
    const a = geometry.attributes[name] as BufferAttribute | InterleavedBufferAttribute;
    const arr = (a as InterleavedBufferAttribute).isInterleavedBufferAttribute
      ? (a as InterleavedBufferAttribute).data.array
      : (a as BufferAttribute).array;
    if ((arr as unknown as { buffer?: ArrayBufferLike }).buffer?.byteLength === 0) return true;
  }
  return false;
}

/** Frames between two retries of the deferred meshes. */
const DEFERRED_RETRY_FRAMES = 15;

function hasOverlayMarker(o: Object3D): boolean {
  const u = o.userData;
  return !!u && !!(u._isSourceGhost || u._isSourcePreview || u._isGhostOverlay
    || u._rvGroundPlane || u._rvGroundReflector || u._rvToonOutline || u._highlightOverlay
    || u._rvBatchedRender);
}

// ─── Manager ────────────────────────────────────────────────────────────

export class EditorArenaManager implements ArenaVisibilitySink {
  private readonly _scene: Object3D;
  private readonly _isWebGPU: boolean;
  private readonly _roleOf: RoleOf;
  private readonly _threshold: number;
  private readonly _reserve: number;
  private readonly _cull: boolean;
  private readonly _isExcluded: (node: Object3D) => boolean;
  private readonly _onChanged: () => void;

  private _root: Object3D | null = null;
  private readonly _arenas: ArenaImpl[] = [];
  private readonly _byKey = new Map<string, ArenaImpl>();
  private readonly _refs = new WeakMap<Mesh, InstanceRecord>();
  private readonly _records: InstanceRecord[] = [];
  /** `matrixWorld.elements` of each record, by slot (hot loop: no object chase). */
  private readonly _elems: number[][] = [];
  /** Last uploaded matrix per SLOT, 16 doubles each — Float64 so the compare
   *  against `matrixWorld.elements` is exact (Float32 would never match). */
  private _matrixCache = new Float64Array(16 * 64);
  private readonly _standalone = new Map<Mesh, StandaloneRecord>();
  /** Meshes whose buffers were detached when they should have joined an arena
   *  (worker BVH build in flight). Untouched — they keep drawing on their own
   *  layer — and retried every {@link DEFERRED_RETRY_FRAMES} frames. */
  private readonly _deferred = new Set<Mesh>();
  private _deferTick = 0;
  private _visEpoch = 1;
  private _appliedVisEpoch = 1;
  private _captureDepth = 0;
  private _grows = 0;

  constructor(opts: EditorArenaManagerOptions) {
    this._scene = opts.scene;
    this._isWebGPU = opts.isWebGPU ?? false;
    this._roleOf = opts.roleOf ?? ((n) => bakeRoleOf(n));
    this._threshold = opts.materialThreshold ?? ARENA_MATERIAL_THRESHOLD;
    this._reserve = opts.reserve ?? ARENA_RESERVE;
    this._cull = opts.perObjectCulling ?? readArenaCullFlag();
    // plan-774 F9: PLACED content never enters an editor arena — a placed
    // reference is materialised like in the HMI (chunks + `keep` meshes, drawn
    // and picked through the bake registry / `PickBackend`). Only the open
    // document's OWN content is authorable, so only it is batched here. Chunks
    // were already out (`isPickableMesh`); this also keeps the placements' keep
    // meshes (Lamp, Source template, …) on their own layers.
    const extra = opts.isExcluded;
    this._isExcluded = extra
      ? (node) => isPlacedReferenceNode(node) || extra(node)
      : isPlacedReferenceNode;
    this._onChanged = opts.onChanged ?? (() => {});
  }

  // ── read side ────────────────────────────────────────────────────────

  get arenas(): readonly EditorArena[] { return this._arenas; }
  get standalone(): ReadonlySet<Mesh> { return new Set(this._standalone.keys()); }
  /** The asset root of the last {@link build} (null when not built). */
  get root(): Object3D | null { return this._root; }
  get isBuilt(): boolean { return this._root !== null; }
  get captureDepth(): number { return this._captureDepth; }

  refOf(mesh: Mesh): InstanceRef | undefined {
    return this._refs.get(mesh);
  }

  isStandalone(mesh: Mesh): boolean {
    return this._standalone.has(mesh);
  }

  stats(): EditorArenaStats {
    let draws = 0;
    if (this._captureDepth > 0) {
      for (const r of this._records) if (r.visible) draws++;
    } else {
      const drawing = new Set<ArenaImpl>();
      for (const r of this._records) if (r.visible) drawing.add(r.arena);
      draws += drawing.size;
    }
    for (const m of this._standalone.keys()) if (this._effectiveVisible(m, null)) draws++;
    for (const m of this._deferred) if (this._effectiveVisible(m, null)) draws++;
    return {
      arenas: this._arenas.length,
      instances: this._records.length,
      standalone: this._standalone.size,
      drawCallsEstimate: draws,
      grows: this._grows,
      captureDepth: this._captureDepth,
      deferred: this._deferred.size,
    };
  }

  // ── lifecycle ────────────────────────────────────────────────────────

  /**
   * Build the arenas for `root` (idempotent: an existing build is torn down
   * first). Claims the scene's arena-sink slot.
   */
  build(root: Object3D): void {
    if (this._root) this._teardown();
    this._root = root;
    this._grows = 0;
    try {
      root.updateMatrixWorld(true);
      const meshes = this._collect(root);
      const plan = planArenas(meshes, {
        materialThreshold: this._threshold, reserve: this._reserve, roleOf: this._roleOf,
      });
      for (const m of plan.standalone) this._standalone.set(m, { geometry: m.geometry, material: m.material });
      for (const planned of plan.arenas) {
        const arena = this._createArena(planned);
        for (const m of planned.meshes) this._addToArena(arena, m);
        // Every member deferred (all buffers in flight) → no empty arena.
        if (arena.live === 0) this._destroyArena(arena);
      }
    } catch (e) {
      // Never leave a half build behind: masked sources without an arena
      // would simply vanish. Everything back on its own layer, then report.
      this._teardown();
      this._root = null;
      throw e;
    }
    this._appliedVisEpoch = this._visEpoch;
    setSceneArenaSink(this._scene, this);
    this._onChanged();
  }

  /** Full rebuild from the current root (fallback; the large CAD line ≈ 0.3 s). */
  rebuild(): void {
    const root = this._root;
    if (!root) return;
    this.build(root);
  }

  /**
   * Tear everything down: source layers restored (OR-ing the remembered
   * original mask back — never `.visible`), arenas removed from the scene,
   * their geometry/textures and every `RVUberArenaMaterial` disposed. Source
   * materials and geometries are never disposed. Releases the scene's sink.
   */
  dispose(): void {
    this._teardown();
    this._root = null;
    this._captureDepth = 0;
    if (sceneArenaSink(this._scene) === this) setSceneArenaSink(this._scene, null);
  }

  // ── per frame ────────────────────────────────────────────────────────

  /**
   * Pre-frame sync (§2.4.2). Call once per frame after the viewer's single
   * `scene.updateMatrixWorld()` and before the first pass.
   */
  beforeFrame(): void {
    const elems = this._elems;
    const c = this._matrixCache;
    const n = elems.length;
    for (let i = 0, o = 0; i < n; i++, o += 16) {
      const e = elems[i];
      // Translation first (the usual change), then the 3×3, then the projective row.
      if (
        e[12] === c[o + 12] && e[13] === c[o + 13] && e[14] === c[o + 14] &&
        e[0] === c[o] && e[1] === c[o + 1] && e[2] === c[o + 2] &&
        e[4] === c[o + 4] && e[5] === c[o + 5] && e[6] === c[o + 6] &&
        e[8] === c[o + 8] && e[9] === c[o + 9] && e[10] === c[o + 10] &&
        e[3] === c[o + 3] && e[7] === c[o + 7] && e[11] === c[o + 11] && e[15] === c[o + 15]
      ) continue;
      for (let k = 0; k < 16; k++) c[o + k] = e[k];
      const rec = this._records[i];
      const bm = rec.arena.mesh;
      bm.setMatrixAt(rec.instanceId, rec.mesh.matrixWorld);
      const mirrored = rec.mesh.matrixWorld.determinant() < 0;
      if (mirrored !== rec.mirrored) {
        if (!rec.arena.geometryIds.has(geometryKeyOf(rec.mesh.geometry, mirrored))
          && hasDetachedBuffers(rec.mesh.geometry)) {
          // The mirrored copy needs the CPU buffers, which a BVH build holds
          // right now — retry next frame (NaN never equals the cached row).
          c[o] = NaN;
          continue;
        }
        const gid = this._geometryIdFor(rec.arena, rec.mesh.geometry, mirrored);
        rec.mirrored = mirrored;
        rec.geometryId = gid;
        bm.setGeometryIdAt(rec.instanceId, gid);
        markDrawListDirty(bm);
      }
    }
    if (this._visEpoch !== this._appliedVisEpoch) {
      this._appliedVisEpoch = this._visEpoch;
      this._applyVisibility();
    }
    if (this._deferred.size > 0 && ++this._deferTick >= DEFERRED_RETRY_FRAMES) {
      this._deferTick = 0;
      this._retryDeferred();
    }
  }

  /** A `.visible` / `rv.Hidden` changed — recompute instance visibility next frame. */
  bumpVisibility(): void {
    this._visEpoch++;
  }

  // ── capture mode ─────────────────────────────────────────────────────

  enterCapture(): void {
    this._captureDepth++;
    if (this._captureDepth !== 1) return;
    for (const r of this._records) r.mesh.layers.mask |= r.originalMask;
    for (const a of this._arenas) a.mesh.layers.mask = 0;
    this._onChanged();
  }

  leaveCapture(): void {
    if (this._captureDepth === 0) return; // unpaired — ignore rather than corrupt masks
    this._captureDepth--;
    if (this._captureDepth !== 0) return;
    for (const r of this._records) r.mesh.layers.mask &= ~r.originalMask;
    for (const a of this._arenas) a.mesh.layers.mask = ARENA_DRAW_MASK;
    this._onChanged();
  }

  /** Synchronous wrapper — `fn` must not await (use enter/leave for async paths). */
  withCaptureMode<T>(fn: () => T): T {
    this.enterCapture();
    try {
      return fn();
    } finally {
      this.leaveCapture();
    }
  }

  // ── structural maintenance ───────────────────────────────────────────

  /**
   * Add meshes (import / separate / merge / create). Already-tracked meshes
   * are skipped. A mesh whose bucket has an arena joins it (growing it in
   * place when full); new buckets form an arena when the uber bucket or
   * ≥ threshold meshes of one material arrive together, otherwise standalone.
   */
  add(meshes: Iterable<Mesh>): void {
    if (!this._root) return;
    const fresh: Mesh[] = [];
    let touched = false;
    for (const mesh of meshes) {
      if (this._refs.has(mesh) || this._standalone.has(mesh)) continue;
      if (this._deferred.has(mesh)) {
        if (hasDetachedBuffers(mesh.geometry)) continue;
        this._deferred.delete(mesh);
      }
      if (!this._isCandidate(mesh)) continue;
      mesh.updateWorldMatrix(true, false);
      const cls = classifyMeshDetailed(mesh, this._roleOf);
      if (cls.kind === 'standalone') {
        this._standalone.set(mesh, { geometry: mesh.geometry, material: mesh.material });
        touched = true;
        continue;
      }
      const layout = arenaLayoutFor(cls.kind, mesh);
      const key = bucketKeyOf(cls.kind, cls.kind === 'uber' ? null : (mesh.material as Material),
        arenaLayoutSignature(layout));
      const arena = this._byKey.get(key);
      if (arena) {
        this._addToArena(arena, mesh);
        touched = true;
      } else {
        fresh.push(mesh);
      }
    }
    if (fresh.length > 0) {
      const plan = planArenas(fresh, {
        materialThreshold: this._threshold, reserve: this._reserve, roleOf: this._roleOf,
      });
      for (const m of plan.standalone) this._standalone.set(m, { geometry: m.geometry, material: m.material });
      for (const planned of plan.arenas) {
        const arena = this._createArena(planned);
        for (const m of planned.meshes) this._addToArena(arena, m);
        if (arena.live === 0) this._destroyArena(arena);
      }
      touched = true;
    }
    if (touched) this._onChanged();
  }

  /**
   * Drop meshes from their arena (trash flush, invalidate, bucket change).
   * The source's layer mask is restored. An arena left empty is removed.
   */
  remove(meshes: Iterable<Mesh>): void {
    let touched = false;
    for (const mesh of meshes) {
      if (this._deferred.delete(mesh)) { touched = true; continue; }
      if (this._standalone.delete(mesh)) { touched = true; continue; }
      const rec = this._refs.get(mesh);
      if (!rec) continue;
      this._removeRecord(rec);
      touched = true;
    }
    if (touched) this._onChanged();
  }

  /**
   * The mesh's material reference changed (or its uber colour/rm values did).
   * Same bucket → per-instance colour/rm update; otherwise remove + add (the
   * source layer flips in the same call, so nothing is drawn twice or not at all).
   */
  setMaterial(mesh: Mesh): void {
    const rec = this._refs.get(mesh);
    if (!rec) {
      if (this._standalone.has(mesh)) {
        this._standalone.delete(mesh);
      }
      this.add([mesh]);
      return;
    }
    const cls = classifyMeshDetailed(mesh, this._roleOf);
    if (cls.kind !== 'standalone') {
      const sig = arenaLayoutSignature(arenaLayoutFor(cls.kind, mesh));
      const key = bucketKeyOf(cls.kind, cls.kind === 'uber' ? null : (mesh.material as Material), sig);
      if (key === rec.arena.key) {
        rec.material = mesh.material as Material;
        if (rec.arena.ownMaterial) this._writeUberAppearance(rec.arena, rec.instanceId, mesh);
        this._onChanged();
        return;
      }
    }
    this._removeRecord(rec);
    this.add([mesh]);
  }

  /** Geometry/material replaced in place (reimport, weld) → remove + add. */
  invalidate(mesh: Mesh): void {
    this.remove([mesh]);
    this.add([mesh]);
  }

  /**
   * Bring the arenas in line with the tree under the root: new meshes are
   * added, in-place geometry swaps invalidated, material swaps re-bucketed;
   * then a visibility epoch. O(meshes under root) — the op listener's answer
   * to structural ops. Trashed meshes stay instances (hidden by the trash
   * group's `.visible = false`) until the trash flush removes them.
   */
  reconcile(): void {
    const root = this._root;
    if (!root) return;
    const fresh: Mesh[] = [];
    for (const mesh of this._collect(root)) {
      const rec = this._refs.get(mesh);
      if (rec) {
        if (rec.geometry !== mesh.geometry) this.invalidate(mesh);
        else if (rec.material !== mesh.material) this.setMaterial(mesh);
        continue;
      }
      if (this._deferred.has(mesh)) continue; // retried by beforeFrame
      const sa = this._standalone.get(mesh);
      if (sa) {
        if (sa.geometry !== mesh.geometry || sa.material !== mesh.material) {
          this._standalone.delete(mesh);
          fresh.push(mesh);
        }
        continue;
      }
      fresh.push(mesh);
    }
    if (fresh.length > 0) this.add(fresh);
    this.bumpVisibility();
    this._onChanged();
  }

  // ── internals ────────────────────────────────────────────────────────

  private _isCandidate(mesh: Mesh): boolean {
    if (!(mesh as { isMesh?: boolean }).isMesh) return false;
    if ((mesh as unknown as { isBatchedMesh?: boolean }).isBatchedMesh) return false;
    if (hasOverlayMarker(mesh)) return false;
    // Only what the main camera draws today (layer 0). Overlay-layer UI and
    // already-masked meshes are left exactly as they are.
    if ((mesh.layers.mask & ARENA_DRAW_MASK) === 0) return false;
    if (isPickableMesh(mesh)) return true;
    // Not pickable but drawable → standalone candidates (skinned / morphed).
    const skinned = (mesh as Mesh & { isSkinnedMesh?: boolean }).isSkinnedMesh === true;
    const morph = !!mesh.morphTargetInfluences && mesh.morphTargetInfluences.length > 0;
    return (skinned || morph) && !!mesh.geometry?.getAttribute('position');
  }

  private _collect(root: Object3D): Mesh[] {
    const out: Mesh[] = [];
    const stack: Object3D[] = [root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node !== root && (this._isExcluded(node) || hasOverlayMarker(node))) continue;
      const m = node as Mesh;
      // Tracked meshes are always collected — their mask is 0 BECAUSE the arena
      // draws them; the layer-0 rule only decides about untracked meshes.
      if (this._refs.has(m) || this._standalone.has(m) || this._isCandidate(m)) out.push(m);
      const ch = node.children;
      for (let i = ch.length - 1; i >= 0; i--) stack.push(ch[i]);
    }
    return out;
  }

  private _createArena(planned: PlannedArena): ArenaImpl {
    const own = planned.kind === 'uber'
      ? new RVUberArenaMaterial(planned.capacity.instances, this._isWebGPU)
      : null;
    const material = own ?? planned.material!;
    const cap = planned.capacity;
    const bm = new BatchedMesh(cap.instances, cap.vertices, cap.indices, material);
    bm.name = `__rvEditorArena:${planned.key}`;
    bm.sortObjects = false;
    bm.perObjectFrustumCulled = this._cull;
    bm.frustumCulled = false;
    bm.raycast = () => {};
    bm.castShadow = true;
    bm.receiveShadow = true;
    bm.matrixAutoUpdate = false;
    bm.userData._rvBatchedRender = true;
    bm.userData._rvEditorArena = true;
    bm.layers.mask = this._captureDepth > 0 ? 0 : ARENA_DRAW_MASK;
    const bucket: ArenaBucket = planned.kind === 'uber'
      ? { kind: 'uber' }
      : { kind: 'material', material: planned.material! };
    const arena = new ArenaImpl(
      planned.key, bucket, planned.signature, planned.layout, bm, own, cap.vertices, cap.indices,
    );
    this._arenas.push(arena);
    this._byKey.set(planned.key, arena);
    this._scene.add(bm);
    bm.updateMatrixWorld(true);
    return arena;
  }

  private _destroyArena(arena: ArenaImpl): void {
    const i = this._arenas.indexOf(arena);
    if (i >= 0) this._arenas.splice(i, 1);
    if (this._byKey.get(arena.key) === arena) this._byKey.delete(arena.key);
    arena.mesh.removeFromParent();
    arena.mesh.dispose(); // its own merged geometry + matrices/indirect/colour textures
    arena.ownMaterial?.dispose(); // RVUberArenaMaterial + rm texture; source materials never
  }

  private _geometryIdFor(arena: ArenaImpl, geometry: BufferGeometry, mirrored: boolean): number {
    const key = geometryKeyOf(geometry, mirrored);
    const known = arena.geometryIds.get(key);
    if (known !== undefined) return known;
    let staged = canonicalizeForArena(geometry, arena.layout);
    if (mirrored) staged = flipWinding(staged);
    const sz = stagedSizeOf(staged);
    const bm = arena.mesh;
    if (bm.unusedVertexCount < sz.vertices || bm.unusedIndexCount < sz.indices) {
      const usedV = arena.capVertices - bm.unusedVertexCount;
      const usedI = arena.capIndices - bm.unusedIndexCount;
      const v = Math.ceil((usedV + sz.vertices) * (1 + this._reserve));
      const ix = Math.ceil((usedI + sz.indices) * (1 + this._reserve));
      bm.setGeometrySize(v, ix);
      arena.capVertices = v;
      arena.capIndices = ix;
      this._grows++;
    }
    const gid = bm.addGeometry(staged);
    arena.geometryIds.set(key, gid);
    return gid;
  }

  private _ensureInstanceSlot(arena: ArenaImpl): void {
    const bm = arena.mesh;
    if (bm.instanceCount < bm.maxInstanceCount) return;
    const next = Math.ceil((bm.instanceCount + 1) * (1 + this._reserve)) + ARENA_INSTANCE_SLACK;
    bm.setInstanceCount(next);
    arena.ownMaterial?.ensureCapacity(next);
    this._grows++;
  }

  private _writeUberAppearance(arena: ArenaImpl, instanceId: number, mesh: Mesh): void {
    const mat = mesh.material as MeshStandardMaterial;
    arena.mesh.setColorAt(instanceId, mat.color);
    arena.ownMaterial!.setRmAt(instanceId, mat.roughness, mat.metalness);
  }

  private _addToArena(arena: ArenaImpl, mesh: Mesh): void {
    const mirrored = isMirrored(mesh);
    if (!arena.geometryIds.has(geometryKeyOf(mesh.geometry, mirrored)) && hasDetachedBuffers(mesh.geometry)) {
      this._deferred.add(mesh);
      return;
    }
    const gid = this._geometryIdFor(arena, mesh.geometry, mirrored);
    this._ensureInstanceSlot(arena);
    const bm = arena.mesh;
    const iid = bm.addInstance(gid);
    bm.setMatrixAt(iid, mesh.matrixWorld);
    // Uber: colour texture is created by the FIRST setColorAt, i.e. before the
    // arena's first render (a lazily created one would switch the program).
    if (arena.ownMaterial) this._writeUberAppearance(arena, iid, mesh);
    const visible = this._effectiveVisible(mesh, null);
    if (!visible) bm.setVisibleAt(iid, false);
    const rec: InstanceRecord = {
      mesh, arena, instanceId: iid, geometryId: gid, mirrored,
      geometry: mesh.geometry, material: mesh.material as Material,
      originalMask: mesh.layers.mask, visible, slot: this._records.length,
    };
    if (this._captureDepth === 0) mesh.layers.mask = 0;
    const slot = this._records.length;
    if (this._matrixCache.length < (slot + 1) * 16) {
      const grown = new Float64Array(Math.max(64, Math.ceil((slot + 1) * 1.5)) * 16);
      grown.set(this._matrixCache);
      this._matrixCache = grown;
    }
    this._matrixCache.set(mesh.matrixWorld.elements, slot * 16);
    this._elems.push(mesh.matrixWorld.elements);
    this._records.push(rec);
    this._refs.set(mesh, rec);
    arena.live++;
  }

  private _removeRecord(rec: InstanceRecord): void {
    const arena = rec.arena;
    arena.mesh.deleteInstance(rec.instanceId);
    rec.mesh.layers.mask |= rec.originalMask;
    // swap-remove from the iteration arrays (record, elements ref, cache row)
    const lastSlot = this._records.length - 1;
    const last = this._records.pop()!;
    const lastElems = this._elems.pop()!;
    if (last !== rec) {
      this._records[rec.slot] = last;
      this._elems[rec.slot] = lastElems;
      this._matrixCache.copyWithin(rec.slot * 16, lastSlot * 16, lastSlot * 16 + 16);
      last.slot = rec.slot;
    }
    this._refs.delete(rec.mesh);
    arena.live--;
    if (arena.live === 0) this._destroyArena(arena);
  }

  /** Deferred meshes whose buffers are back join their arenas (or go standalone). */
  private _retryDeferred(): void {
    const ready: Mesh[] = [];
    for (const m of this._deferred) {
      if (!m.parent) { this._deferred.delete(m); continue; }
      if (!hasDetachedBuffers(m.geometry)) ready.push(m);
    }
    if (ready.length === 0) return;
    for (const m of ready) this._deferred.delete(m);
    this.add(ready);
  }

  private _teardown(): void {
    this._deferred.clear();
    this._deferTick = 0;
    for (const r of this._records) {
      r.mesh.layers.mask |= r.originalMask;
      this._refs.delete(r.mesh);
    }
    this._records.length = 0;
    this._elems.length = 0;
    for (const a of [...this._arenas]) this._destroyArena(a);
    this._arenas.length = 0;
    this._byKey.clear();
    this._standalone.clear();
  }

  /** Chain visibility: every ancestor `.visible`, no `rv.Hidden`, attached to the scene. */
  private _effectiveVisible(node: Object3D, memo: Map<Object3D, boolean> | null): boolean {
    const path: Object3D[] = [];
    let cur: Object3D | null = node;
    let result = true;
    while (cur) {
      if (memo) {
        const m = memo.get(cur);
        if (m !== undefined) { result = m; break; }
      }
      path.push(cur);
      if (!cur.visible || isAuthoredHidden(cur)) { result = false; break; }
      if (!cur.parent) { result = cur === this._scene; break; }
      cur = cur.parent;
    }
    if (memo) for (const p of path) memo.set(p, result);
    return result;
  }

  private _applyVisibility(): void {
    const memo = new Map<Object3D, boolean>();
    for (const rec of this._records) {
      const v = this._effectiveVisible(rec.mesh, memo);
      if (v === rec.visible) continue;
      rec.visible = v;
      rec.arena.mesh.setVisibleAt(rec.instanceId, v);
    }
  }
}
