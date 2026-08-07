// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-collision-manager.ts — viewer-owned collision detection with preset roles
 * (plan-394).
 *
 * While the simulation runs, every pair of collision bodies with DIFFERENT
 * roles is checked once per sim tick:
 *
 *   1. **Body bounds** — the world AABB of a body is re-unioned EVERY tick from
 *      `localBox.applyMatrix4(mesh.matrixWorld)` over all its meshes. That is
 *      the only form that stays correct under rotation, non-uniform scale AND
 *      articulation (a robot arm extending). A cached half-size (`AABB.fromNode`)
 *      would freeze the build pose and silently drop real collisions.
 *   2. **Broadphase** — `Box3.intersectsBox` over a pair list precomputed at
 *      rebuild time, so the role filter costs nothing per tick.
 *   3. **Narrowphase** — `bvhcast` with an `intersectsTriangles` callback over
 *      the per-mesh `geometry.boundsTree`. NOT `intersectsRanges`: a `true`
 *      from that callback SKIPS the triangle iteration entirely, which would
 *      silently degrade the whole feature to a finer bounding-box test.
 *
 * Hard rules:
 * - The merged pick geometries of the batched render pipeline are never touched
 *   (see doc-render-picking.md) — only per-mesh `boundsTree`s.
 * - The simulation is never stopped or paused. A hit outlines the involved
 *   nodes (OutlinePass status channel — the error-message silhouette) and adds
 *   a card in the right-side messages panel. Both LATCH: they stay after the
 *   geometry separates, until the pair's TYPE is ignored from its card, a
 *   `ResetCollisions` edge arrives, or the model changes (user decisions
 *   2026-08-07; the original acknowledge-modal is gone).
 * - A body is never checked against a body nested inside it (a robot against
 *   its own gripper always touches at the flange).
 * - No OWN allocation in the hot path. `bvhcast` itself allocates closures per
 *   call upstream; that cost is inside the measured tick budget, not denied.
 */

import { Box3, Matrix4 } from 'three';
import type { BufferGeometry, Mesh, Object3D } from 'three';
import type { MeshBVH, ExtendedTriangle } from 'three-mesh-bvh';
import { NodeRegistry } from './rv-node-registry';
import type { CollisionRoleName, CollisionRoleRegistrar } from './rv-collision-role';
import { toCollisionRole } from './rv-collision-role';
import type { IMULifecycleHook } from './rv-transport-manager';
import type { IMUAccessor } from './rv-mu';
import type { AABB } from './rv-aabb';
import type { SignalStore } from './rv-signal-store';
import { createSignalWriter, type SignalWriter } from './rv-signal-store';
import type { CollisionPairView } from '../hmi/collision-alert-store';
import { publishCollisionAlert } from '../hmi/collision-alert-store';
import { debug } from './rv-debug';

// ─── Signal names ────────────────────────────────────────────────────────

export const SIGNAL_COLLISION_ACTIVE = 'CollisionActive';
export const SIGNAL_COLLISION_COUNT = 'CollisionCount';
export const SIGNAL_RESET_COLLISIONS = 'ResetCollisions';
/** Synthetic path prefix (same idea as the interface layer's `__iface__/`). */
const SIGNAL_PATH_PREFIX = '__collision__';


// ─── Narrowphase ─────────────────────────────────────────────────────────

/** Module scratch — `meshesIntersect` is called from a single-threaded tick. */
const _castMat = new Matrix4();

/**
 * Triangle-pair callback. Returning `true` ends the cast immediately
 * (MeshBVH.js:530-533) — that early exit is what keeps the narrowphase cheap.
 */
function trianglesHit(t1: ExtendedTriangle, t2: ExtendedTriangle): boolean {
  return t1.intersectsTriangle(t2);
}

/**
 * Callback options built ONCE. A `{ intersectsTriangles }` object literal at
 * the call site would be one allocation per mesh pair per tick.
 *
 * `intersectsTriangles` is mandatory here: `intersectsRanges` returning `true`
 * makes MeshBVH skip `iterateOverDoubleTriangles` (MeshBVH.js:544-557), i.e. it
 * would never compare a single triangle.
 */
const CAST_OPTS = { intersectsTriangles: trianglesHit } as const;

/**
 * Exact triangle-against-triangle test between two meshes in world space.
 *
 * Meshes without a `boundsTree` (batched-render sources, freshly created
 * geometry) return `true`: the caller only ever gets here after the world boxes
 * already overlapped, and reporting a possible hit beats missing one.
 */
export function meshesIntersect(a: Mesh, b: Mesh): boolean {
  const ba = (a.geometry as BufferGeometry).boundsTree as MeshBVH | undefined;
  const bb = (b.geometry as BufferGeometry).boundsTree as MeshBVH | undefined;
  if (!ba || !bb) return true;
  // matrixToLocal maps b's BVH-local frame into a's BVH-local frame — not the
  // other way round, and not world space. A flipped matrix silently produces
  // wrong results (guarded by the rotation test in rv-collision-narrowphase).
  _castMat.copy(a.matrixWorld).invert().multiply(b.matrixWorld);
  return ba.bvhcast(bb, _castMat, CAST_OPTS);
}

// ─── Data model ──────────────────────────────────────────────────────────

/** One participating mesh of a body. `localBox` is cached once per rebuild. */
export interface BodyMesh {
  readonly mesh: Mesh;
  /** `geometry.boundingBox`, computed once. Never mutated. */
  readonly localBox: Box3;
  /** Ancestor chain up to the scene root — read-only visibility input (F6). */
  readonly ancestors: readonly Object3D[];
  /** Per-tick world box. Pre-allocated. */
  readonly worldBox: Box3;
  /** Per-tick: does this mesh take part in this tick's check? */
  visibleThisTick: boolean;
}

/** An MU accessor plus the per-instance AABB both MU classes carry. */
export type CollisionMU = IMUAccessor & { readonly aabb: AABB; readonly node: Object3D };

export interface CollisionBody {
  /** Node body: the role-carrying node. MU body: the MU's node (shared for
   *  instanced MUs — never used for bounds, only for the highlight of clones). */
  readonly root: Object3D;
  readonly role: CollisionRoleName;   // never 'None'
  /** Stable identity across rebuilds — node path, or `mu:<id>` for MUs. */
  readonly key: string;
  /** Display name for the modal. */
  readonly label: string;
  readonly kind: 'node' | 'mu';
  /** Only for `kind === 'node'` (and clone MUs, which can use the exact path). */
  readonly meshes: BodyMesh[];
  /** Only for `kind === 'mu'`: the per-instance AABB the transport system keeps
   *  current. An instanced MU shares `node.matrixWorld` with its whole pool, so
   *  a matrix-derived box would put every instance in the same place (§2.8). */
  readonly mu: CollisionMU | null;
  /** Per-tick union box. Pre-allocated. */
  readonly worldBox: Box3;
  /** True when the check must stop after the box (no usable BVH). */
  aabbOnly: boolean;
  /** Bodies whose subtree contains this body — the F16 skip set. */
  readonly ancestorBodies: Set<CollisionBody>;
}

/** Index pair into a body array. */
export interface CrossPair {
  readonly i: number;
  readonly j: number;
}

/** A currently intersecting pair: display view + the highlight roots that
 *  belong to it, so the aux set can be re-derived when pairs come and go.
 *  Roots are `null` for instanced MUs (highlighting the pool mesh would light
 *  up every instance). */
interface ActivePair {
  readonly view: CollisionPairView;
  readonly aRoot: Object3D | null;
  readonly bRoot: Object3D | null;
}

/** Minimal body shape `buildCrossPairs` needs (keeps the function unit-testable). */
export interface PairableBody {
  readonly role: string;
  readonly ancestorBodies?: ReadonlySet<unknown>;
}

/**
 * Precompute the checked pairs. TWO conditions, not one:
 *   - different roles (identical roles never collide, `None` never collides), and
 *   - not related (a body inside another body's subtree — F16).
 *
 * Without the second condition every robot with a gripper reports the
 * design-inherent flange contact from the very first tick, and the plan
 * deliberately has neither a baseline nor exclusion pairs to switch that off.
 */
export function buildCrossPairs(bodies: readonly PairableBody[]): CrossPair[] {
  const pairs: CrossPair[] = [];
  for (let i = 0; i < bodies.length; i++) {
    const a = bodies[i];
    if (a.role === 'None') continue;
    for (let j = i + 1; j < bodies.length; j++) {
      const b = bodies[j];
      if (b.role === 'None') continue;
      if (a.role === b.role) continue;
      if (a.ancestorBodies?.has(b)) continue;
      if (b.ancestorBodies?.has(a)) continue;
      pairs.push({ i, j });
    }
  }
  return pairs;
}

// ─── Hosts (narrow seams, no hard viewer dependency) ─────────────────────

/**
 * Highlight seam. The production host (wired in RVViewer) drives the
 * OutlinePass STATUS channel via `showStatusOutline` / `hideStatusOutline` —
 * the same pulsing severity silhouette the error-message system uses (user
 * decision 2026-08-07: "highlighted with the same outline like error
 * message"). Tests inject a recording fake.
 */
export interface CollisionHighlightHost {
  /** Show the collision outline on `roots` (replaces the previous set). */
  showCollision(roots: readonly Object3D[]): void;
  /** Remove the collision outline. */
  hideCollision(): void;
}

/** The slice of `SignalStore` this manager uses. */
export type CollisionSignalHost = Pick<SignalStore, 'register' | 'get' | 'set' | 'subscribe'>
  & Partial<Pick<SignalStore, 'createWriter'>>;

// ─── Deformed-geometry detection (F17) ───────────────────────────────────

/**
 * True for geometry whose cached `localBox` would be a lie: skinned meshes
 * (the viewer builds them for energy chains), morph-target animation, and
 * anything explicitly excluded from the BVH build (`_rvSkipBVH`, i.e. batched
 * render sources). Such meshes are left out of every body — a named blind spot,
 * not a silent wrong answer.
 */
function isDeformedMesh(mesh: Mesh): boolean {
  if ((mesh as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh) return true;
  if (mesh.userData?._rvSkipBVH) return true;
  const influences = mesh.morphTargetInfluences;
  return Array.isArray(influences) && influences.length > 0;
}

/**
 * Pipeline helper meshes are not machine geometry and never join a body:
 * merged raycast/pick meshes (`_rvRaycastBVH`, invisible by contract, span a
 * whole batch range) and pooled highlight-proxy overlays
 * (`_highlightOverlay`, BVH-less wrappers). The proxies are the treacherous
 * case: the collision highlight itself parents them into the hit body's
 * subtree, so the next rebuild would collect them and their missing
 * boundsTree drags the body to `aabbOnly` — a box-test feedback loop born
 * from the manager's own alarm.
 */
function isPipelineHelperMesh(mesh: Mesh): boolean {
  const ud = mesh.userData as Record<string, unknown> | undefined;
  return ud?._rvRaycastBVH === true || ud?._highlightOverlay === true;
}

/** Normalized role-pair key for the ignore set (order-independent). */
export function typeKey(roleA: string, roleB: string): string {
  return roleA < roleB ? `${roleA}|${roleB}` : `${roleB}|${roleA}`;
}

// ─── Manager ─────────────────────────────────────────────────────────────

export class RVCollisionManager implements CollisionRoleRegistrar, IMULifecycleHook {
  // ── Registry (authored roles) ──
  private readonly _roles = new Map<Object3D, CollisionRoleName>();
  private readonly _muRoles = new Map<CollisionMU, CollisionRoleName>();

  // ── Built state ──
  private _bodies: CollisionBody[] = [];
  private _pairs: CrossPair[] = [];
  private _dirty = true;

  // ── Active collisions (latched: a pair stays reported after separation,
  //    until an ignore, a reset edge or a model change — user decision
  //    2026-08-07: "why is it auto cleared?") ──
  private readonly _active = new Map<string, ActivePair>();
  private readonly _activeRoots: Object3D[] = [];

  /** Ignored collision TYPES (normalized role-pair keys, e.g.
   *  `Tool|Workpiece`) — "ignore this type for the current run". Survives
   *  reset(); wiped only on model change (clear()). */
  private readonly _ignoredTypes = new Set<string>();

  // ── Hosts ──
  private _highlight: CollisionHighlightHost | null = null;
  private _writer: SignalWriter | null = null;
  private _unsubReset: (() => void) | null = null;
  private _prevReset = false;

  // ── Last written signal values (write only on change) ──
  private _lastActive: boolean | null = null;
  private _lastCount: number | null = null;

  // ── Warn-once per model load ──
  private _warnedNoBVH = false;
  private _warnedDeformed = false;

  // ─── Registration ──────────────────────────────────────────────────

  /** IMPLEMENTS CollisionRoleRegistrar::register */
  register(node: Object3D, role: CollisionRoleName): void {
    const next = toCollisionRole(role);
    if (this._roles.get(node) === next) return;
    this._roles.set(node, next);
    this._dirty = true;
  }

  /** IMPLEMENTS CollisionRoleRegistrar::unregister */
  unregister(node: Object3D): void {
    if (this._roles.delete(node)) this._dirty = true;
  }

  /** Role currently registered for a node (`'None'` when unknown). */
  roleOf(node: Object3D): CollisionRoleName {
    return this._roles.get(node) ?? 'None';
  }

  /** IMPLEMENTS IMULifecycleHook::onMUSpawned */
  onMUSpawned(mu: IMUAccessor, role: CollisionRoleName | string | undefined): void {
    const parsed = toCollisionRole(role);
    if (parsed === 'None') return;
    this._muRoles.set(mu as CollisionMU, parsed);
    this._dirty = true;
  }

  /** IMPLEMENTS IMULifecycleHook::onMURemoved */
  onMURemoved(mu: IMUAccessor): void {
    if (this._muRoles.delete(mu as CollisionMU)) this._dirty = true;
  }

  /** Force a rebuild at the head of the next tick (F11). */
  invalidate(): void {
    this._dirty = true;
  }

  // ─── Host wiring ───────────────────────────────────────────────────

  setHighlightHost(host: CollisionHighlightHost | null): void {
    this._highlight = host;
  }

  /**
   * Attach to a model's SignalStore: register the three signals and subscribe
   * to the acknowledge edge. Detaches a previous store first, so a model switch
   * never leaves a listener on a dead store.
   */
  attachSignals(store: CollisionSignalHost | null): void {
    this._unsubReset?.();
    this._unsubReset = null;
    this._writer = null;
    this._lastActive = null;
    this._lastCount = null;
    this._prevReset = false;
    if (!store) return;

    store.register(SIGNAL_COLLISION_ACTIVE, `${SIGNAL_PATH_PREFIX}/${SIGNAL_COLLISION_ACTIVE}`, false, 'PLCInputBool');
    store.register(SIGNAL_COLLISION_COUNT, `${SIGNAL_PATH_PREFIX}/${SIGNAL_COLLISION_COUNT}`, 0, 'PLCInputInt');
    store.register(SIGNAL_RESET_COLLISIONS, `${SIGNAL_PATH_PREFIX}/${SIGNAL_RESET_COLLISIONS}`, false, 'PLCOutputBool');

    this._writer = createSignalWriter(store, 'component:CollisionManager', 'component', {
      slotContext: SIGNAL_PATH_PREFIX,
    });
    this._prevReset = store.get(SIGNAL_RESET_COLLISIONS) === true;
    this._unsubReset = store.subscribe(SIGNAL_RESET_COLLISIONS, (v) => {
      const now = v === true;
      const rising = now && !this._prevReset;
      this._prevReset = now;
      if (rising) this.reset();
    });
    this._writeSignals();
  }

  // ─── Rebuild ───────────────────────────────────────────────────────

  /** True when the next `update()` will rebuild first. */
  get isDirty(): boolean { return this._dirty; }

  get bodies(): readonly CollisionBody[] { return this._bodies; }
  get pairs(): readonly CrossPair[] { return this._pairs; }

  /**
   * Rebuild bodies + pair list. Runs at most once per tick, at the head, so a
   * role change can never race a running check.
   */
  rebuild(): void {
    this._dirty = false;
    this._bodies = [];

    // Body roots first — needed as cut-off markers during the mesh collection.
    const roots = new Map<Object3D, CollisionRoleName>();
    for (const [node, role] of this._roles) {
      if (role !== 'None') roots.set(node, role);
    }

    let deformedSkipped = 0;
    let meshesWithoutBVH = 0;

    for (const [node, role] of roots) {
      const meshes: BodyMesh[] = [];
      let aabbOnly = false;
      const collect = (obj: Object3D): void => {
        // Cut-off: a nested node with its own role starts a body of its own —
        // "the robot counts up to the gripper" (user decision 2026-08-06).
        if (obj !== node && roots.has(obj)) return;
        const mesh = obj as Mesh;
        if (mesh.isMesh && mesh.geometry && !isPipelineHelperMesh(mesh)) {
          if (isDeformedMesh(mesh)) {
            deformedSkipped++;
          } else {
            const bm = this._makeBodyMesh(mesh);
            if (!(mesh.geometry as BufferGeometry).boundsTree) {
              meshesWithoutBVH++;
              aabbOnly = true;
            }
            meshes.push(bm);
          }
        }
        for (const child of obj.children) collect(child);
      };
      collect(node);

      this._bodies.push({
        root: node,
        role,
        key: NodeRegistry.computeNodePath(node),
        label: node.name || NodeRegistry.computeNodePath(node),
        kind: 'node',
        meshes,
        mu: null,
        worldBox: new Box3(),
        aabbOnly,
        ancestorBodies: new Set<CollisionBody>(),
      });
    }

    // MU bodies. The world box ALWAYS comes from the MU's own AABB — an
    // instanced MU's `node` is the pool's shared InstancedMesh (§2.8).
    for (const [mu, role] of this._muRoles) {
      const meshes: BodyMesh[] = [];
      let aabbOnly = mu.isInstanced;
      if (!mu.isInstanced) {
        mu.node.traverse((obj) => {
          const mesh = obj as Mesh;
          if (!mesh.isMesh || !mesh.geometry) return;
          if (isPipelineHelperMesh(mesh)) return;
          if (isDeformedMesh(mesh)) { deformedSkipped++; return; }
          if (!(mesh.geometry as BufferGeometry).boundsTree) {
            meshesWithoutBVH++;
            aabbOnly = true;
          }
          meshes.push(this._makeBodyMesh(mesh));
        });
        if (meshes.length === 0) aabbOnly = true;
      }
      this._bodies.push({
        root: mu.node,
        role,
        key: `mu:${(mu as unknown as { id: number }).id}`,
        label: mu.getName(),
        kind: 'mu',
        meshes,
        mu,
        worldBox: new Box3(),
        aabbOnly,
        ancestorBodies: new Set<CollisionBody>(),
      });
    }

    // Ancestor relation (F16) — a body inside another body's subtree.
    const byRoot = new Map<Object3D, CollisionBody[]>();
    for (const body of this._bodies) {
      if (body.kind !== 'node') continue;
      const list = byRoot.get(body.root);
      if (list) list.push(body);
      else byRoot.set(body.root, [body]);
    }
    for (const body of this._bodies) {
      let p: Object3D | null = body.root.parent;
      while (p) {
        const owners = byRoot.get(p);
        if (owners) for (const o of owners) body.ancestorBodies.add(o);
        p = p.parent;
      }
      // An instanced MU shares its node with the whole pool; the pool mesh is
      // never a body root, so this loop is a no-op for it.
    }

    this._pairs = buildCrossPairs(this._bodies).filter((pair) =>
      !this._ignoredTypes.has(typeKey(this._bodies[pair.i].role, this._bodies[pair.j].role)));

    if (meshesWithoutBVH > 0 && !this._warnedNoBVH) {
      this._warnedNoBVH = true;
      console.warn(
        `[CollisionManager] ${meshesWithoutBVH} mesh(es) have no geometry.boundsTree — `
        + 'those bodies fall back to a pure AABB check (no triangle precision).',
      );
    }
    if (deformedSkipped > 0 && !this._warnedDeformed) {
      this._warnedDeformed = true;
      console.warn(
        `[CollisionManager] ${deformedSkipped} deformed mesh(es) (SkinnedMesh / morph targets / `
        + '_rvSkipBVH) are excluded from collision checking — their cached local box would be '
        + 'the undeformed one. Energy chains are a known blind spot.',
      );
    }
    debug('sensor', `[collision] rebuild: ${this._bodies.length} bodies, ${this._pairs.length} pairs`);
  }

  private _makeBodyMesh(mesh: Mesh): BodyMesh {
    const geo = mesh.geometry as BufferGeometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const ancestors: Object3D[] = [];
    let p: Object3D | null = mesh.parent;
    while (p) { ancestors.push(p); p = p.parent; }
    return {
      mesh,
      localBox: (geo.boundingBox ?? new Box3()).clone(),
      ancestors,
      worldBox: new Box3(),
      visibleThisTick: true,
    };
  }

  // ─── Per-tick ──────────────────────────────────────────────────────

  /**
   * One collision tick. Returns true when the visual state changed (new
   * highlight), so the caller can mark the frame dirty.
   *
   * A collision found here is reported in THIS call — there is deliberately no
   * time budget or round-robin that would push the report past a tick boundary.
   */
  update(_dt: number): boolean {
    if (this._dirty) this.rebuild();
    if (this._pairs.length === 0) {
      this._writeSignals();
      return false;
    }

    for (const body of this._bodies) this.updateBodyBounds(body);

    let added = false;
    for (const pair of this._pairs) {
      const a = this._bodies[pair.i];
      const b = this._bodies[pair.j];
      if (!a.worldBox.intersectsBox(b.worldBox)) continue;
      if (!this._narrowphase(a, b)) continue;
      if (this._recordPair(a, b)) added = true;
    }

    if (added) {
      this._rebuildHighlightRoots();
      this._applyHighlight();
      this._publish();
    }
    this._writeSignals();
    return added;
  }

  /**
   * Re-union a body's world AABB from the CURRENT world matrices.
   *
   * `Box3.copy(localBox).applyMatrix4(matrixWorld)` transforms all eight
   * corners and is therefore correct under rotation and non-uniform scale, and
   * the per-mesh union makes it correct under articulation. `Box3.setFromObject`
   * is deliberately NOT used — it re-runs `updateMatrixWorld` internally.
   */
  updateBodyBounds(body: CollisionBody): void {
    if (body.kind === 'mu' && body.mu) {
      const a = body.mu.aabb;
      body.worldBox.min.copy(a.min);
      body.worldBox.max.copy(a.max);
      // Mesh boxes still come from the matrices — they are only used as the
      // narrowphase prefilter for clone MUs, where they are self-consistent
      // with the bvhcast matrices.
      for (const bm of body.meshes) {
        bm.visibleThisTick = this._isEffectivelyVisible(bm);
        if (!bm.visibleThisTick) continue;
        bm.worldBox.copy(bm.localBox).applyMatrix4(bm.mesh.matrixWorld);
      }
      return;
    }
    body.worldBox.makeEmpty();
    for (const bm of body.meshes) {
      bm.visibleThisTick = this._isEffectivelyVisible(bm);
      if (!bm.visibleThisTick) continue;
      bm.worldBox.copy(bm.localBox).applyMatrix4(bm.mesh.matrixWorld);
      body.worldBox.union(bm.worldBox);
    }
  }

  /**
   * Effective visibility (F6) — the same rule the highlight system uses
   * (`visible` AND `layers.mask !== 0`), extended over the cached ancestor
   * chain. Batched render sources keep `visible = true` but carry
   * `layers.mask = 0`; hidden MU templates fail the `visible` chain.
   */
  private _isEffectivelyVisible(bm: BodyMesh): boolean {
    const m = bm.mesh;
    if (!m.visible || m.layers.mask === 0) return false;
    for (const a of bm.ancestors) {
      if (!a.visible) return false;
    }
    return true;
  }

  private _narrowphase(a: CollisionBody, b: CollisionBody): boolean {
    // A body without usable BVHs already counted its box overlap as a hit.
    if (a.aabbOnly || b.aabbOnly) return true;
    for (const ma of a.meshes) {
      if (!ma.visibleThisTick) continue;
      for (const mb of b.meshes) {
        if (!mb.visibleThisTick) continue;
        // Mesh-level prefilter so a big body does not cast all its meshes
        // against all of the partner's.
        if (!ma.worldBox.intersectsBox(mb.worldBox)) continue;
        if (meshesIntersect(ma.mesh, mb.mesh)) return true;
      }
    }
    return false;
  }

  /** Marks a pair as hit this tick and adds it to the active set when new.
   *  Returns true when it was new. */
  private _recordPair(a: CollisionBody, b: CollisionBody): boolean {
    const key = a.key < b.key ? `${a.key}\u0000${b.key}` : `${b.key}\u0000${a.key}`;
    if (this._active.has(key)) return false;
    this._active.set(key, {
      view: {
        aPath: a.label, aRole: a.role,
        bPath: b.label, bRole: b.role,
        aKey: a.key, bKey: b.key,
        since: performance.now(),
      },
      aRoot: this._highlightRootOf(a),
      bRoot: this._highlightRootOf(b),
    });
    return true;
  }

  /** Instanced MUs share the pool mesh — highlighting it would light up every
   *  instance in the pool, so they contribute no highlight root. */
  private _highlightRootOf(body: CollisionBody): Object3D | null {
    return body.kind === 'mu' && body.mu?.isInstanced ? null : body.root;
  }

  /** Re-derive the aux highlight roots from the CURRENT active pairs — the
   *  set shrinks now, so incremental adds are not enough. */
  private _rebuildHighlightRoots(): void {
    this._activeRoots.length = 0;
    for (const ap of this._active.values()) {
      if (ap.aRoot && !this._activeRoots.includes(ap.aRoot)) this._activeRoots.push(ap.aRoot);
      if (ap.bRoot && !this._activeRoots.includes(ap.bRoot)) this._activeRoots.push(ap.bRoot);
    }
  }

  // ─── Reporting ─────────────────────────────────────────────────────

  private _applyHighlight(): void {
    if (this._activeRoots.length > 0) this._highlight?.showCollision(this._activeRoots);
    else this._highlight?.hideCollision();
  }

  /** Re-apply the aux set — e.g. after a workspace-mode change (F15). */
  reapplyHighlight(): void {
    this._applyHighlight();
  }

  private _publish(): void {
    publishCollisionAlert(this.activePairs);
  }

  private _writeSignals(): void {
    if (!this._writer) return;
    const active = this._active.size > 0;
    const count = this._active.size;
    if (this._lastActive !== active) {
      this._lastActive = active;
      this._writer.set(SIGNAL_COLLISION_ACTIVE, active);
    }
    if (this._lastCount !== count) {
      this._lastCount = count;
      this._writer.set(SIGNAL_COLLISION_COUNT, count);
    }
  }

  // ─── Ignore types (user decision 2026-08-07) ────────────────────

  /** Role-pair types currently ignored for this run (normalized keys). */
  get ignoredTypes(): ReadonlySet<string> { return this._ignoredTypes; }

  /**
   * Ignore a collision TYPE (role pair, e.g. Tool↔Workpiece) for the rest of
   * the current run: matching latched pairs are dropped immediately and the
   * pair list stops checking that combination. Survives reset(); wiped on
   * model change.
   */
  ignoreType(roleA: string, roleB: string): void {
    const key = typeKey(roleA, roleB);
    if (this._ignoredTypes.has(key)) return;
    this._ignoredTypes.add(key);
    // Stop future checks without waiting for a rebuild.
    this._pairs = this._pairs.filter((pair) =>
      typeKey(this._bodies[pair.i].role, this._bodies[pair.j].role) !== key);
    // Drop matching latched pairs.
    let removed = false;
    for (const [k, ap] of this._active) {
      if (typeKey(ap.view.aRole, ap.view.bRole) === key) {
        this._active.delete(k);
        removed = true;
      }
    }
    if (removed) {
      this._rebuildHighlightRoots();
      this._applyHighlight();
      this._publish();
      this._writeSignals();
    }
  }

  /**
   * Acknowledge ONE latched pair (the card's OK): its card and outline share
   * are dropped. A pair whose geometry still intersects is re-detected on the
   * very next tick — OK only closes it for good once the contact is over
   * (same contract as the original modal's OK). Unknown keys are a no-op.
   */
  acknowledge(aKey: string, bKey: string): void {
    const key = aKey < bKey ? `${aKey}\u0000${bKey}` : `${bKey}\u0000${aKey}`;
    if (!this._active.delete(key)) return;
    this._rebuildHighlightRoots();
    this._applyHighlight();
    this._publish();
    this._writeSignals();
  }

  // ─── Reset / lifecycle ─────────────────────────────────────────────

  /** Snapshot of the latched pairs (persist until acknowledge/ignore/reset). */
  get activePairs(): readonly CollisionPairView[] {
    const views: CollisionPairView[] = [];
    for (const ap of this._active.values()) views.push(ap.view);
    return views;
  }

  /**
   * Clear the whole reported state (highlights, cards, signals). A pair that
   * still intersects is re-detected on the very next tick — this exists for
   * the PLC-side `ResetCollisions` edge and for teardown paths; single cards
   * are acknowledged via {@link acknowledge}, types muted via
   * {@link ignoreType}.
   * Never touches the simulation — it keeps running throughout (user decision).
   */
  reset(): void {
    this._active.clear();
    this._activeRoots.length = 0;
    this._highlight?.hideCollision();
    publishCollisionAlert([]);
    this._writeSignals();
  }

  /** Model change: drop the whole registry and every reported state (F12). */
  clear(): void {
    this._roles.clear();
    this._muRoles.clear();
    this._bodies = [];
    this._pairs = [];
    this._dirty = true;
    this._warnedNoBVH = false;
    this._warnedDeformed = false;
    this._active.clear();
    this._activeRoots.length = 0;
    this._ignoredTypes.clear();
    this._highlight?.hideCollision();
    publishCollisionAlert([]);
    this.attachSignals(null);
  }

  /** Viewer teardown. */
  dispose(): void {
    this.clear();
    this._highlight = null;
  }
}
