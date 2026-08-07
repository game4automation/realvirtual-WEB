// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-energy-chain.ts — `EnergyChain`, the browser runtime counterpart of the
 * (future) Unity `EnergyChain` component. Plan-362.
 *
 * Turns a rigid CAD energy-chain mesh into a chain that actually moves with its
 * linear axis. The user's only action is attaching the component; drive axis,
 * bend radius, link height, chain length and the location of the bend are
 * MEASURED from the CAD rest pose (`rv-energy-chain-path.ts`), never asked for.
 *
 * ## Three things in here are load-bearing and easy to get wrong
 *
 * 1. **The bind frame (2.8).** Every number — the vertex projection, the path,
 *    the bone poses — lives in the chain root's local frame at rigging time,
 *    NEVER in world space. A chain hanging under a moving kinematic parent, a
 *    planner-relocated asset and a multiuser-synchronised transform therefore
 *    all move the chain as a whole without deforming it, because the anchor and
 *    follower scalars are re-derived in that same frame every tick.
 *
 * 2. **The rigging moment (2.6).** On `loadGLB` / `processExtras` the kinematic
 *    re-parenting pass runs BETWEEN `init()` and `onSceneReady()`, so rigging in
 *    `init()` would freeze the pre-reparent hierarchy. Those paths defer to
 *    `onSceneReady()` (flagged by `ComponentContext.expectSceneReady`); the
 *    `constructComponentOnNode` path — where no `onSceneReady` runs at all —
 *    rigs immediately.
 *
 * 3. **The structure signature carries NO world matrices.** It is the parent
 *    identity chain plus the local bind data. If it contained `matrixWorld`,
 *    every ordinary movement of a parent would trigger a re-rig — the exact
 *    opposite of point 1.
 *
 * Multiple source meshes share ONE `Skeleton`: the reference chain keeps both
 * straight strands in one mesh and the bend in another, each with its own local
 * transform. A single `SkinnedMesh` cannot express that, and merging would
 * destroy the materials and the node structure. Cost: +1 draw call per SOURCE
 * MESH, not per chain.
 */

import {
  Bone,
  Box3,
  BoxGeometry,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Quaternion,
  Skeleton,
  Sphere,
  SkinnedMesh,
  Uint16BufferAttribute,
  Float32BufferAttribute,
  Vector3,
} from 'three';
import type { BufferGeometry, Material } from 'three';
import type { ComponentContext, ComponentSchema, RVComponent } from './rv-component-registry';
import {
  loadSchemaFromSpec,
  registerComponent,
  resolveComponentRefs,
  setComponentInstance,
} from './rv-component-registry';
import type { EnergyChainManager } from './rv-energy-chain-manager';
import {
  RV_CHAIN_PROXY,
  RV_CHAIN_SKIN,
  RV_CHAIN_SOURCE,
  RV_CHAIN_SOURCE_VISIBLE,
  traverseMeshes,
} from './rv-traverse-utils';
import {
  findAutoFollower,
  type AssignmentStage,
  type AutoFollowerResult,
  type StrandEnds,
} from './rv-energy-chain-assign';
import {
  boneArcLengths,
  calibrate,
  chainStatus,
  followerRange,
  minimumBoneCount,
  pointAt,
  projectToPath,
  solveBend,
  tangentAt,
  type CalibrationResult,
  type ChainPathConfig,
  type ChainPoint,
} from './rv-energy-chain-path';

/** Bind-frame units per millimetre (glTF/Unity export is metres). */
const MM = 0.001;
/** Below this follower delta (bind-frame units) the pose is considered unchanged. */
const POSE_EPS = 1e-6;

export type ChainDiagnosis =
  | 'ok'
  | 'disabled'
  | 'no-geometry'
  | 'degraded-calibration'
  | 'degraded-assignment'
  | 'overstretched';

interface SourceMeshEntry {
  mesh: Mesh;
  skinned: SkinnedMesh;
  /** Whether this entry added the skin attributes (so dispose can remove them). */
  addedAttributes: boolean;
  originalVisible: boolean;
}

// ── Pre-allocated scratch (no GC in the per-frame path) ─────────────
const _mat = new Matrix4();
const _mat2 = new Matrix4();
const _vec = new Vector3();
const _quat = new Quaternion();
const _axis = new Vector3();
const _pt: ChainPoint = { u: 0, v: 0 };
const _tan: ChainPoint = { u: 0, v: 0 };

/** Browser runtime counterpart of Unity's EnergyChain component. */
export class RVEnergyChain implements RVComponent {
  static readonly schema: ComponentSchema = loadSchemaFromSpec('EnergyChain');

  readonly node: Object3D;
  isOwner = true;

  // ── Schema fields (PascalCase == C# field names == GLB extras keys) ──
  /** Fixed chain end. Wire: `ComponentReference` with `UnityEngine.Transform`. */
  Anchor: unknown = null;
  /** Moving chain end (the carrier). Same wire contract as {@link Anchor}. */
  Follower: unknown = null;
  /** mm, centerline bend radius. `0` = measure. */
  BendRadius = 0;
  /** mm, total centerline length. `0` = measure. */
  ChainLength = 0;
  Axis: 'Auto' | 'X' | 'Y' | 'Z' = 'Auto';
  BendUp = true;
  Bones = 24;
  Enabled = true;

  // ── Runtime state ───────────────────────────────────────────────
  private _ctx?: ComponentContext;
  private _manager?: EnergyChainManager;
  private _rigged = false;
  private _signature = '';
  private _riggedWith = '';
  private _diagnosis: ChainDiagnosis = 'ok';
  private _statusDetail = '';
  private _clampedBones = 0;

  private _entries: SourceMeshEntry[] = [];
  private _boneContainer?: Object3D;
  private _bones: Bone[] = [];
  private _skeleton?: Skeleton;
  private _boneS?: Float64Array;
  private _proxy?: Mesh;

  private _cal?: CalibrationResult;
  /** Bind-frame axis indices and signs mapping bind coords ↔ the (u, v) plane. */
  private _uIndex = 2;
  private _vIndex = 1;
  private _wIndex = 0;
  private _uSign = 1;
  private _vSign = 1;
  private _wSign = 1;

  private _cfg: ChainPathConfig = { a: 0, m: 0, R: 0, L: 0, vc: 0, vSign: 1 };
  private _aRest = 0;
  private _mRest = 0;
  /** Transverse centre of the source cloud — the third coordinate of a strand end. */
  private _wMid = 0;
  private _anchorNode: Object3D | null = null;
  /** The `Follower` field once resolved — an explicit reference always wins (2.5). */
  private _explicitFollower: Object3D | null = null;
  /** The node actually followed: the explicit reference, or the auto-assigned one. */
  private _followerNode: Object3D | null = null;
  private _assignStage: AssignmentStage = 'none';
  private _anchorRefRest = 0;
  private _followerRefRest = 0;
  private _lastM = Number.NaN;
  private _lastA = Number.NaN;

  constructor(node: Object3D) {
    this.node = node;
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  init(ctx: ComponentContext): void {
    this._ctx = ctx;
    this._tagNode();
    // Path-dependent rigging (2.6). `expectSceneReady` marks the loader paths
    // that still run the Kinematic re-parenting pass; only those defer.
    if (ctx.expectSceneReady) return;
    this._resolveRefs();
    this._ensureRigged();
  }

  onSceneReady(ctx: ComponentContext): void {
    this._ctx = ctx;
    this._resolveRefs();
    this._ensureRigged();
  }

  /**
   * Re-derive everything after a live field write (inspector overlay, op-log,
   * `web_editor_set_field`, undo). This is what makes the MCP correction path
   * of 2.9 work WITHOUT a reload: `_setField()` only re-applies the schema and
   * never calls `resolveComponentRefs()`, so a `Follower` written through it
   * would stay a raw wire object forever. Resolving here covers all three
   * cases — reference set, reference cleared (falls back to auto assignment),
   * and undo restoring a previous value.
   */
  reapplyConfig(): void {
    if (!this._ctx) return;
    this._resolveRefs();
    if (!this._rigged) {
      this._ensureRigged();
      return;
    }
    // Anything that invalidates the BAKED state forces a rebuild: a changed
    // structure, a changed authored number, or a follower that moved to the
    // other strand. Everything else is absorbed in place.
    if (
      this._computeSignature() !== this._signature
      || this._numericFingerprint() !== this._riggedWith
      || this._refreshReferences()
    ) {
      this._teardownRig();
      this._ensureRigged();
      return;
    }
    this._lastM = Number.NaN;
    this.updatePose(0);
  }

  dispose(): void {
    this._manager?.unregister(this);
    this._manager = undefined;
    this._teardownRig();
    this._ctx = undefined;
    if (this.node.userData._rvEnergyChain === this) delete this.node.userData._rvEnergyChain;
  }

  // ── Public state ────────────────────────────────────────────────

  /** Current diagnosis; anything but `'ok'` means the chain holds its rest pose. */
  get diagnosis(): ChainDiagnosis {
    return this._diagnosis;
  }

  /** One-line status for the inspector (F5 carrier). */
  get statusLine(): string {
    return this._statusDetail;
  }

  /** True once the runtime rig exists. */
  get isRigged(): boolean {
    return this._rigged;
  }

  /** The shared skeleton — `undefined` until rigged. Every source mesh uses it. */
  get skeleton(): Skeleton | undefined {
    return this._skeleton;
  }

  /** The invisible picking hull registered as an auxiliary raycast target. */
  get pickProxy(): Mesh | undefined {
    return this._proxy;
  }

  /** Measured values, for the inspector's `(auto)` markers and tests. */
  get calibration(): CalibrationResult | undefined {
    return this._cal;
  }

  /** How the moving end was determined (2.5) — `'none'` means degraded. */
  get assignmentStage(): AssignmentStage {
    return this._assignStage;
  }

  /** The node the chain currently follows, whether referenced or auto-assigned. */
  get followerNode(): Object3D | null {
    return this._followerNode;
  }

  /**
   * Current bend-center position along the drive axis, in BIND-FRAME units
   * (not the internal `u`, so it is directly comparable to
   * `calibration.bendCenter`). This is the model value, free of the
   * bone-sampling discretisation — what the 3D diagnosis overlay draws and
   * what a test should assert the half-speed property on.
   */
  get bendCenter(): number {
    return this._rigged ? this._uSign * solveBend(this._cfg) : Number.NaN;
  }

  /** Current follower scalar along the drive axis, bind-frame units. */
  get followerScalar(): number {
    return this._rigged ? this._uSign * this._cfg.m : Number.NaN;
  }

  getLiveState(): Record<string, unknown> {
    return {
      BendRadius: this._cal ? round1(this._cfg.R / MM) : this.BendRadius,
      ChainLength: this._cal ? round1(this._cfg.L / MM) : this.ChainLength,
      Axis: this._cal ? this._cal.axis : this.Axis,
      Bones: this._bones.length || this.Bones,
      Status: this._statusDetail,
    };
  }

  /** Re-measure from the CAD rest pose, discarding manual numeric overrides. */
  recalibrate(): void {
    this.BendRadius = 0;
    this.ChainLength = 0;
    this.Axis = 'Auto';
    this._teardownRig();
    this._ensureRigged();
  }

  // ── Per-frame update (EnergyChainManager) ───────────────────────

  /**
   * Move the bones to the current follower pose. Returns `true` when anything
   * changed, which the manager turns into BOTH a render- and a shadow-dirty
   * flag (a live-signal-driven chain never touches the drive loop that would
   * otherwise raise the shadow flag).
   *
   * Allocation-free: every temporary is a module-level scratch object.
   */
  updatePose(_dt: number): boolean {
    if (!this._rigged || !this.Enabled) return false;
    // Every degraded state means the same thing: hold the CAD rest pose, which
    // is exactly today's behaviour and never worse (F5). Without a follower
    // there is nothing to follow, so animating would be inventing motion.
    if (this._diagnosis !== 'ok' && this._diagnosis !== 'overstretched') return false;

    const a = this._anchorNode ? this._aRest + this._refDelta(this._anchorNode, this._anchorRefRest) : this._aRest;
    const m = this._followerNode
      ? this._mRest + this._refDelta(this._followerNode, this._followerRefRest)
      : this._mRest;

    if (Math.abs(m - this._lastM) < POSE_EPS && Math.abs(a - this._lastA) < POSE_EPS) return false;
    this._lastM = m;
    this._lastA = a;

    this._cfg.a = a;
    this._cfg.m = m;

    const status = chainStatus(this._cfg);
    if (status === 'overstretched') {
      if (this._diagnosis !== 'overstretched') {
        this._diagnosis = 'overstretched';
        this._statusDetail = `Overstretched: follower outside [${round1((this._cfg.a - (this._cfg.L - Math.PI * this._cfg.R)) / MM)}, ${round1((this._cfg.a + (this._cfg.L - Math.PI * this._cfg.R)) / MM)}] mm`;
      }
      // Clamp rather than draw nonsense — the bones stay on the last valid pose.
      const range = followerRange(this._cfg);
      this._cfg.m = Math.min(range.max, Math.max(range.min, m));
    } else if (this._diagnosis === 'overstretched') {
      this._diagnosis = 'ok';
      this._statusDetail = this._buildOkStatus();
    }

    this._applyBones();
    return true;
  }

  // ── Reference resolution ────────────────────────────────────────

  private _resolveRefs(): void {
    const ctx = this._ctx;
    if (!ctx) return;
    resolveComponentRefs(this as unknown as Record<string, unknown>, ctx.registry);
    this._anchorNode = asNode(this.Anchor);
    // Only the EXPLICIT reference is derived here. The effective follower is
    // decided in `_assignReferences()` / `_refreshReferences()`, because with an
    // empty field it comes from the auto assignment instead (2.5) — overwriting
    // `_followerNode` here would wipe that out on every live field write.
    this._explicitFollower = asNode(this.Follower);
  }

  /** Bind-frame `u` of a reference node, minus its value at rigging time. */
  private _refDelta(ref: Object3D, restValue: number): number {
    _mat.copy(this.node.matrixWorld).invert().multiply(ref.matrixWorld);
    _vec.setFromMatrixPosition(_mat);
    return this._toU(_vec) - restValue;
  }

  private _toU(p: Vector3): number {
    return this._uSign * p.getComponent(this._uIndex);
  }

  private _toV(p: Vector3): number {
    return this._vSign * p.getComponent(this._vIndex);
  }

  // ── Rigging ─────────────────────────────────────────────────────

  private _tagNode(): void {
    if (!this.node.userData._rvType) this.node.userData._rvType = 'EnergyChain';
    Object.defineProperty(this.node.userData, '_rvEnergyChain', {
      value: this, writable: true, configurable: true, enumerable: false,
    });
  }

  /**
   * Build the rig if it does not exist yet. Idempotent WITHIN one structure —
   * a changed structure signature goes through `reapplyConfig()` / `dispose()`
   * first. Never throws: everything that can fail sets a diagnosis and leaves
   * the chain in its CAD rest pose (F5).
   */
  private _ensureRigged(): void {
    if (this._rigged) return;
    try {
      this._rig();
    } catch (e) {
      console.warn(`[EnergyChain] "${this.node.name}" could not be rigged:`, e);
      this._teardownRig();
      this._diagnosis = 'degraded-calibration';
      this._statusDetail = 'Rigging failed — chain holds its CAD rest pose';
    }
    // Registering even in the degraded case keeps a later `reapplyConfig()`
    // (a corrected Follower via MCP) able to bring the chain to life.
    const manager = this._ctx?.energyChainManager;
    if (manager && this._manager !== manager) {
      this._manager?.unregister(this);
      this._manager = manager;
      manager.register(this);
    }
    if (this._proxy) this._manager?.registerProxy(this._proxy, this.node);
  }

  private _rig(): void {
    this.node.updateMatrixWorld(true);

    // ── 1. Collect source meshes ──────────────────────────────────
    const sources: Mesh[] = [];
    traverseMeshes(this.node, (mesh) => {
      const ud = mesh.userData as Record<string, unknown>;
      if (ud[RV_CHAIN_PROXY] || ud[RV_CHAIN_SKIN] || ud._rvGizmo || ud._highlightOverlay) return;
      if ((mesh as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh) return;
      if (!mesh.geometry?.getAttribute('position')) return;
      sources.push(mesh);
    });
    if (sources.length === 0) {
      this._diagnosis = 'no-geometry';
      this._statusDetail = 'No mesh geometry under this node';
      return;
    }

    // ── 2. Merge every vertex into the chain-local bind frame ─────
    const bindInv = new Matrix4().copy(this.node.matrixWorld).invert();
    const meshBind: Matrix4[] = [];
    let total = 0;
    for (const mesh of sources) {
      total += mesh.geometry.getAttribute('position').count;
      meshBind.push(new Matrix4().multiplyMatrices(bindInv, mesh.matrixWorld));
    }
    const cloud = new Float32Array(total * 3);
    let w = 0;
    for (let i = 0; i < sources.length; i++) {
      const pos = sources[i].geometry.getAttribute('position');
      const m = meshBind[i];
      for (let v = 0; v < pos.count; v++) {
        _vec.fromBufferAttribute(pos as never, v).applyMatrix4(m);
        cloud[w++] = _vec.x; cloud[w++] = _vec.y; cloud[w++] = _vec.z;
      }
    }

    // ── 3. Calibrate ──────────────────────────────────────────────
    const cal = calibrate({ points: cloud, unitsToMm: 1 / MM, axis: this.Axis });
    this._cal = cal;
    if (cal.status !== 'ok') {
      this._diagnosis = 'degraded-calibration';
      this._statusDetail = `Calibration failed: ${cal.reason ?? 'unknown'} — chain holds its CAD rest pose`;
      return;
    }

    this._uIndex = cal.axisIndex;
    this._vIndex = cal.upIndex;
    this._wIndex = 3 - cal.axisIndex - cal.upIndex;
    this._uSign = cal.bendDir;
    // `BendUp === false` mirrors the transverse axis, i.e. swaps which physical
    // strand plays the role of "the moving one" in the canonical formula.
    this._vSign = this.BendUp ? 1 : -1;
    // Right-handed (u, v, w): w = u × v, with u = uSign·e_i and v = vSign·e_j.
    this._wSign = handedness(this._uIndex, this._vIndex) * this._uSign * this._vSign;

    // Transverse centre of the cloud — the auto assignment needs a full 3D point
    // per strand end, and the chain plane says nothing about the width axis.
    let wLo = Infinity, wHi = -Infinity;
    for (let i = this._wIndex; i < cloud.length; i += 3) {
      if (cloud[i] < wLo) wLo = cloud[i];
      if (cloud[i] > wHi) wHi = cloud[i];
    }
    this._wMid = Number.isFinite(wLo) ? (wLo + wHi) / 2 : 0;

    // Manual overrides win over the measurement; `0` means "keep measuring".
    const R = (this.BendRadius > 0 ? this.BendRadius : cal.bendRadiusMm) * MM;
    const L = (this.ChainLength > 0 ? this.ChainLength : cal.chainLengthMm) * MM;

    // ── 4. Which strand end is the anchor, which the follower ─────
    const lowU = this._uSign * cal.lowEnd;
    const highU = this._uSign * cal.highEnd;
    // In the canonical formula the FIXED strand runs at `vc − R`, i.e. the
    // low-v strand when `_vSign === 1`.
    this._aRest = this._vSign === 1 ? lowU : highU;
    this._mRest = this._vSign === 1 ? highU : lowU;

    this._cfg = {
      a: this._aRest,
      m: this._mRest,
      R,
      L,
      vc: this._vSign * cal.bendCenterV,
      vSign: 1,
    };

    // The rest pose must reproduce the CAD exactly (F5/9.4). The measured
    // length may be off by a fraction of a millimetre through vertex noise;
    // pin `L` so that `solveBend` lands on the measured bend center.
    const measuredC = this._uSign * cal.bendCenter;
    this._cfg.L = 2 * measuredC + Math.PI * R - this._aRest - this._mRest;
    if (!(this._cfg.L > 0)) this._cfg.L = L;

    this._assignReferences(cal);

    // ── 5. Bones ──────────────────────────────────────────────────
    const minBones = minimumBoneCount();
    const requested = Math.max(2, Math.round(this.Bones) || 0);
    const count = Math.max(minBones, requested);
    this._clampedBones = count > requested ? count : 0;

    this._boneS = boneArcLengths(this._cfg, count);
    const container = new Object3D();
    container.name = '__rvEnergyChainBones';
    container.userData._rvGizmo = true;
    this.node.add(container);
    this._boneContainer = container;

    this._bones = [];
    for (let i = 0; i < count; i++) {
      const bone = new Bone();
      bone.name = `__rvChainBone${i}`;
      container.add(bone);
      this._bones.push(bone);
    }
    // Rest frames FIRST, world matrices updated, THEN the Skeleton — otherwise
    // `boneInverses` are captured from an arbitrary pose and the mesh is
    // silently distorted with no error anywhere.
    this._poseBones(this._cfg);
    container.updateMatrixWorld(true);
    this._skeleton = new Skeleton(this._bones);

    // ── 6. One SkinnedMesh per source mesh, ONE shared skeleton ───
    for (let i = 0; i < sources.length; i++) {
      const entry = this._buildSkinnedMesh(sources[i], meshBind[i]);
      if (entry) this._entries.push(entry);
    }
    if (this._entries.length === 0) {
      this._diagnosis = 'no-geometry';
      this._statusDetail = 'No skinnable geometry under this node';
      this._teardownRig();
      return;
    }

    // ── 7. Picking proxy ──────────────────────────────────────────
    this._buildProxy(cloud);

    this._rigged = true;
    this._signature = this._computeSignature();
    this._riggedWith = this._numericFingerprint();
    this._lastM = this._cfg.m;
    this._lastA = this._cfg.a;
    if (this._diagnosis !== 'degraded-assignment') this._diagnosis = 'ok';
    this._statusDetail = this._buildOkStatus();
  }

  /**
   * Decide which scene node the moving end follows, and with it which physical
   * strand is the moving one (2.5, F3).
   *
   * Stage 0 — an explicit `Follower` reference ALWAYS wins over every automatic
   * stage; the strand end nearest to it in the bind frame becomes the moving
   * one, which also fixes the transverse orientation without asking the user
   * for `BendUp`.
   * Stages 1 and 2 — with an empty reference, the scene context decides:
   * a drive travelling along the chain's axis, else a kinematic node
   * (`rv-energy-chain-assign.ts`). The automatic stages report which END is the
   * moving one directly, which is a sharper signal than a reference node's own
   * transverse position.
   * Nothing found — `degraded-assignment` plus the CAD rest pose: exactly
   * today's behaviour, never worse (F5).
   */
  private _assignReferences(cal: CalibrationResult): void {
    this._followerNode = null;
    this._assignStage = 'none';

    if (this._explicitFollower) {
      _mat.copy(this.node.matrixWorld).invert().multiply(this._explicitFollower.matrixWorld);
      _vec.setFromMatrixPosition(_mat);
      const followerV = this._vSign * _vec.getComponent(this._vIndex);
      const lowV = this._vSign * (cal.bendCenterV - cal.bendRadiusMm * MM);
      const highV = this._vSign * (cal.bendCenterV + cal.bendRadiusMm * MM);
      // Whichever strand the follower sits closer to is the moving one.
      if (Math.abs(followerV - lowV) < Math.abs(followerV - highV)) this._flipStrands();
      this._followerNode = this._explicitFollower;
      this._followerRefRest = this._toU(_vec);
      this._assignStage = 'reference';
    } else {
      const auto = this._autoAssign(cal);
      if (auto) {
        // `_vSign === 1` means the HIGH strand is the moving one.
        if (auto.movingIsHigh !== (this._vSign === 1)) this._flipStrands();
        _mat.copy(this.node.matrixWorld).invert().multiply(auto.node.matrixWorld);
        _vec.setFromMatrixPosition(_mat);
        this._followerNode = auto.node;
        this._followerRefRest = this._toU(_vec);
        this._assignStage = auto.stage;
      }
    }

    if (this._anchorNode) {
      _mat.copy(this.node.matrixWorld).invert().multiply(this._anchorNode.matrixWorld);
      _vec.setFromMatrixPosition(_mat);
      this._anchorRefRest = this._toU(_vec);
    }
    if (!this._followerNode) {
      this._diagnosis = 'degraded-assignment';
    }
  }

  /**
   * Swap which physical strand plays the moving role in the canonical formula.
   *
   * Mirroring the transverse axis is the whole operation: `vSign` flips, the two
   * rest scalars trade places, `w` follows to keep the basis right-handed, and
   * the bend centre — stored pre-multiplied by `vSign` — is negated with it.
   */
  private _flipStrands(): void {
    const t = this._aRest; this._aRest = this._mRest; this._mRest = t;
    this._vSign = -this._vSign as 1 | -1;
    this._wSign = handedness(this._uIndex, this._vIndex) * this._uSign * this._vSign;
    this._cfg.vc = -(this._cfg.vc ?? 0);
    this._cfg.a = this._aRest;
    this._cfg.m = this._mRest;
  }

  /** The two open strand ends as bind-frame points — input to the auto assignment. */
  private _strandEnds(cal: CalibrationResult): StrandEnds {
    const r = cal.bendRadiusMm * MM;
    const low = new Vector3();
    low.setComponent(this._uIndex, cal.lowEnd);
    low.setComponent(this._vIndex, cal.bendCenterV - r);
    low.setComponent(this._wIndex, this._wMid);
    const high = new Vector3();
    high.setComponent(this._uIndex, cal.highEnd);
    high.setComponent(this._vIndex, cal.bendCenterV + r);
    high.setComponent(this._wIndex, this._wMid);
    return { low, high };
  }

  /** Stages 1 and 2 of 2.5. Runs at rigging time and on a live field write. */
  private _autoAssign(cal: CalibrationResult): AutoFollowerResult | null {
    const registry = this._ctx?.registry;
    if (!registry) return null;
    return findAutoFollower({
      chainRoot: this.node,
      registry,
      ends: this._strandEnds(cal),
      uIndex: this._uIndex,
      bendRadius: this._cfg.R,
      chainLength: this._cfg.L,
    });
  }

  /**
   * Update the reference anchors of an EXISTING rig after a live edit (2.9).
   *
   * Returns `true` when the change cannot be absorbed and a full re-rig is
   * required — namely when the new follower sits on the OTHER strand: which
   * strand moves is baked into the skin weights and the bone frames, so
   * flipping it at runtime would silently deform the chain inside out.
   * Everything else (a reference set, cleared, or restored by undo) is just a
   * new rest scalar plus a new diagnosis, with the skeleton untouched — which
   * is what keeps the ASSIGNMENT from ever re-rigging on its own: it is path
   * configuration, not structure.
   */
  private _refreshReferences(): boolean {
    const cal = this._cal;
    if (!cal) return false;

    // An explicit reference wins; a CLEARED one falls back to the automatic
    // stages rather than to degradation (2.5 / 2.9).
    let node = this._explicitFollower;
    let stage: AssignmentStage = 'reference';
    let movingIsHigh: boolean | undefined;
    if (!node) {
      const auto = this._autoAssign(cal);
      if (auto) {
        node = auto.node;
        stage = auto.stage;
        movingIsHigh = auto.movingIsHigh;
      } else {
        stage = 'none';
      }
    }

    if (node) {
      _mat.copy(this.node.matrixWorld).invert().multiply(node.matrixWorld);
      _vec.setFromMatrixPosition(_mat);
      if (movingIsHigh === undefined) {
        const followerV = this._toV(_vec);
        const vc = this._cfg.vc ?? 0;
        const movingV = vc + this._cfg.R;
        const fixedV = vc - this._cfg.R;
        if (Math.abs(followerV - fixedV) < Math.abs(followerV - movingV)) return true;
      } else if (movingIsHigh !== (this._vSign === 1)) {
        return true;
      }
      this._followerNode = node;
      this._followerRefRest = this._toU(_vec);
      this._assignStage = stage;
      if (this._diagnosis === 'degraded-assignment') this._diagnosis = 'ok';
    } else {
      this._followerNode = null;
      this._followerRefRest = 0;
      this._assignStage = 'none';
      this._diagnosis = 'degraded-assignment';
    }

    if (this._anchorNode) {
      _mat.copy(this.node.matrixWorld).invert().multiply(this._anchorNode.matrixWorld);
      _vec.setFromMatrixPosition(_mat);
      this._anchorRefRest = this._toU(_vec);
    } else {
      this._anchorRefRest = 0;
    }

    // A cleared follower must snap back to the CAD rest pose, not freeze
    // wherever the last live pose left it.
    this._cfg.a = this._aRest;
    this._cfg.m = this._mRest;
    this._applyBones();
    this._statusDetail = this._buildOkStatus();
    return false;
  }

  private _buildSkinnedMesh(source: Mesh, meshBind: Matrix4): SourceMeshEntry | null {
    const geometry = source.geometry as BufferGeometry;
    const pos = geometry.getAttribute('position');
    if (!pos) return null;

    // Skin attributes are written onto the SHARED geometry rather than a clone:
    // the extra vec4s are far cheaper than a second copy of the vertex buffer,
    // the original mesh is invisible from here on, and `dispose()` removes them
    // again. `rv-uber-material.ts` refuses to bake any geometry a rig holds, so
    // nothing else can write into it behind our back.
    const addedAttributes = !geometry.getAttribute('skinIndex');
    if (addedAttributes) {
      const count = pos.count;
      const idx = new Uint16Array(count * 4);
      const wgt = new Float32Array(count * 4);
      const s = this._boneS!;
      const last = s.length - 1;
      for (let v = 0; v < count; v++) {
        _vec.fromBufferAttribute(pos as never, v).applyMatrix4(meshBind);
        const { s: arc } = projectToPath(this._cfg, this._toU(_vec), this._toV(_vec));
        // Bracketing bone pair + linear blend in ARC LENGTH. Two influences are
        // all a chain needs, and they sum to exactly 1 by construction.
        let hi = 1;
        while (hi < last && s[hi] < arc) hi++;
        const lo = hi - 1;
        const span = s[hi] - s[lo];
        const t = span > 0 ? clamp01((arc - s[lo]) / span) : 0;
        idx[v * 4] = lo;
        idx[v * 4 + 1] = hi;
        wgt[v * 4] = 1 - t;
        wgt[v * 4 + 1] = t;
      }
      geometry.setAttribute('skinIndex', new Uint16BufferAttribute(idx, 4));
      geometry.setAttribute('skinWeight', new Float32BufferAttribute(wgt, 4));
    }

    const skinned = new SkinnedMesh(geometry, source.material as Material);
    skinned.name = `${source.name}__rvChainSkin`;
    skinned.position.copy(source.position);
    skinned.quaternion.copy(source.quaternion);
    skinned.scale.copy(source.scale);
    skinned.castShadow = source.castShadow;
    skinned.receiveShadow = source.receiveShadow;
    skinned.renderOrder = source.renderOrder;
    skinned.userData[RV_CHAIN_SKIN] = true;
    // Not `frustumCulled = false`: the envelope below gives exact, cheap bounds.
    source.parent?.add(skinned);
    skinned.updateMatrixWorld(true);
    skinned.bind(this._skeleton!, skinned.matrixWorld);

    const originalVisible = source.visible;
    source.visible = false;
    source.userData[RV_CHAIN_SOURCE] = true;
    source.userData[RV_CHAIN_SOURCE_VISIBLE] = originalVisible;

    return { mesh: source, skinned, addedAttributes, originalVisible };
  }

  /**
   * Invisible picking hull covering the whole motion envelope (3.3).
   *
   * Derived GEOMETRICALLY from `L`, `R` and the anchor — NOT from drive limits,
   * which simply do not exist in drive-free operation. The follower range
   * `m ∈ [a − (L − πR), a + (L − πR)]` is symmetric, so the hull is correct no
   * matter which way the axis travels (the reference chain travels toward
   * negative Z).
   */
  private _buildProxy(cloud: Float32Array): void {
    const { R, L } = this._cfg;
    const reach = L - Math.PI * R;
    const uLo = this._cfg.a - reach;
    const uHi = this._cfg.a + reach + R;
    const vc = this._cfg.vc ?? 0;
    const linkHalf = ((this._cal?.linkHeightMm ?? 0) * MM) / 2;
    const vLo = vc - R - linkHalf;
    const vHi = vc + R + linkHalf;

    // The width axis is not part of the chain plane — take it from the cloud.
    let wLo = Infinity, wHi = -Infinity;
    for (let i = 0; i < cloud.length; i += 3) {
      const value = this._wSign * cloud[i + this._wIndex];
      if (value < wLo) wLo = value;
      if (value > wHi) wHi = value;
    }
    if (!Number.isFinite(wLo)) { wLo = -R; wHi = R; }

    const size = new Vector3();
    size.setComponent(this._uIndex, Math.abs(uHi - uLo));
    size.setComponent(this._vIndex, Math.abs(vHi - vLo));
    size.setComponent(this._wIndex, Math.max(1e-4, Math.abs(wHi - wLo)));

    const proxy = new Mesh(
      new BoxGeometry(Math.max(1e-4, size.x), Math.max(1e-4, size.y), Math.max(1e-4, size.z)),
      new MeshBasicMaterial({ visible: false, depthWrite: false }),
    );
    proxy.name = '__rvEnergyChainProxy';
    proxy.visible = false;
    proxy.userData[RV_CHAIN_PROXY] = true;
    proxy.position.setComponent(this._uIndex, this._uSign * ((uLo + uHi) / 2));
    proxy.position.setComponent(this._vIndex, this._vSign * ((vLo + vHi) / 2));
    proxy.position.setComponent(this._wIndex, this._wSign * ((wLo + wHi) / 2));
    this.node.add(proxy);
    proxy.updateMatrixWorld(true);
    this._proxy = proxy;

    // Fixed bounds instead of per-frame recomputation: a SkinnedMesh never
    // updates its bounding sphere on its own (three.js #14499 / #11991), and
    // `frustumCulled = false` would be a blunter, more expensive answer.
    const box = new Box3().setFromObject(proxy);
    for (const entry of this._entries) {
      const geo = entry.skinned.geometry;
      // The proxy lives in chain-root space, the skinned geometry in mesh-local
      // space — convert once, then never recompute.
      _mat2.copy(entry.skinned.matrixWorld).invert().multiply(this.node.matrixWorld);
      const local = box.clone().applyMatrix4(_mat2);
      geo.boundingBox = local;
      geo.boundingSphere = local.getBoundingSphere(new Sphere());
    }
  }

  // ── Bone posing ─────────────────────────────────────────────────

  private _applyBones(): void {
    this._poseBones(this._cfg);
    this._boneContainer?.updateMatrixWorld(true);
  }

  /**
   * Place every bone on the centerline. Bone `i` keeps its arc length `s_i`
   * FOREVER — arc length is a material coordinate on an inextensible chain, so
   * a bone always follows the same physical link. Recomputing `s_i` per frame
   * would make the bones slide through the geometry.
   *
   * Consequence worth knowing: the bend-heavy sample grid is optimal for the
   * REST pose and drifts relative to the bend as the chain travels, so the apex
   * ends up slightly under-sampled at the ends of the stroke. What does NOT
   * degrade is the ANGULAR spacing between neighbouring bones — it equals the
   * (constant) arc-length spacing divided by `R` everywhere on the bend, which
   * is the quantity linear blend skinning actually cares about. The default of
   * 24 bones over a minimum of 21 is the reserve for this drift.
   */
  private _poseBones(cfg: ChainPathConfig): void {
    const s = this._boneS;
    if (!s) return;
    _axis.set(0, 0, 0).setComponent(this._wIndex, this._wSign);
    for (let i = 0; i < this._bones.length; i++) {
      pointAt(cfg, s[i], _pt);
      tangentAt(cfg, s[i], _tan);
      const bone = this._bones[i];
      bone.position.set(0, 0, 0);
      bone.position.setComponent(this._uIndex, this._uSign * _pt.u);
      bone.position.setComponent(this._vIndex, this._vSign * _pt.v);
      _quat.setFromAxisAngle(_axis, Math.atan2(_tan.v, _tan.u));
      bone.quaternion.copy(_quat);
      bone.scale.set(1, 1, 1);
      bone.updateMatrix();
    }
  }

  /**
   * The authored numbers the current rig was built from.
   *
   * Changing any of them invalidates far more than the path: the skin weights
   * map each vertex to a FIXED arc length computed against the old geometry, and
   * the bone count defines the skeleton itself. Patching `_cfg` in place would
   * leave the weights pointing at a path that no longer exists — a silent
   * distortion. So a changed number means a full, cheap rebuild.
   */
  private _numericFingerprint(): string {
    return `${this.BendRadius}|${this.ChainLength}|${this.Axis}|${this.BendUp}|${Math.round(this.Bones)}`;
  }

  // ── Structure signature (2.6 / Re-Challenge R1) ─────────────────

  /**
   * Identity of the structure the rig was built for.
   *
   * Deliberately contains NO world matrices: the parent identity chain plus the
   * local bind data. A moved kinematic parent, a planner relocation or a
   * multiuser transform must NOT invalidate the rig — that is the whole point
   * of the bind frame (2.8). Only genuinely structural changes (late
   * re-parenting, exchanged geometry, re-calibrated numbers) do.
   */
  private _computeSignature(): string {
    const parents: string[] = [];
    let cur: Object3D | null = this.node;
    while (cur) { parents.push(cur.uuid); cur = cur.parent; }
    const meshes = this._entries.map(e => e.mesh.uuid).sort().join(',');
    return `${parents.join('>')}|${meshes}|${this._cfg.R}|${this._cfg.L}|${this._uIndex}${this._vIndex}${this._uSign}${this._vSign}`;
  }

  private _buildOkStatus(): string {
    const parts: string[] = [];
    if (this._diagnosis === 'degraded-assignment') {
      parts.push('No follower found — chain holds its CAD rest pose');
    } else {
      parts.push('OK');
    }
    if (this._assignStage === 'drive' || this._assignStage === 'kinematic') {
      parts.push(`follower auto-detected (${this._assignStage}): ${this._followerNode?.name || '?'}`);
    }
    if (this._cal) {
      parts.push(`bend at ${round1(this._uSign * this._cal.bendCenter / MM)} mm`);
      parts.push(`R ${round1(this._cfg.R / MM)} mm`);
      parts.push(`L ${round1(this._cfg.L / MM)} mm`);
    }
    parts.push(`${this._entries.length} mesh${this._entries.length === 1 ? '' : 'es'}`);
    if (this._clampedBones > 0) {
      parts.push(`Bones raised to ${this._clampedBones} (min for 15° per joint)`);
    }
    return parts.join(' · ');
  }

  // ── Teardown ────────────────────────────────────────────────────

  private _teardownRig(): void {
    for (const entry of this._entries) {
      entry.skinned.removeFromParent();
      if (entry.addedAttributes) {
        entry.skinned.geometry.deleteAttribute('skinIndex');
        entry.skinned.geometry.deleteAttribute('skinWeight');
      }
      entry.mesh.visible = entry.originalVisible;
      delete entry.mesh.userData[RV_CHAIN_SOURCE];
      delete entry.mesh.userData[RV_CHAIN_SOURCE_VISIBLE];
    }
    this._entries = [];

    if (this._proxy) {
      (this._manager ?? this._ctx?.energyChainManager)?.unregisterProxy(this._proxy);
      this._proxy.removeFromParent();
      this._proxy.geometry.dispose();
      (this._proxy.material as Material).dispose();
      this._proxy = undefined;
    }

    this._skeleton?.dispose();
    this._skeleton = undefined;
    for (const bone of this._bones) bone.removeFromParent();
    this._bones = [];
    this._boneContainer?.removeFromParent();
    this._boneContainer = undefined;
    this._boneS = undefined;
    this._followerNode = null;
    this._assignStage = 'none';
    this._rigged = false;
    this._signature = '';
    this._riggedWith = '';
    this._lastM = Number.NaN;
    this._lastA = Number.NaN;
  }
}

// ─── helpers ─────────────────────────────────────────────────────

function asNode(value: unknown): Object3D | null {
  const candidate = value as Object3D | null;
  return candidate && (candidate as unknown as { isObject3D?: boolean }).isObject3D ? candidate : null;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : (x > 1 ? 1 : x);
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/**
 * Sign of `e_i × e_j` along the remaining axis, for the right-handed basis
 * `(u, v, w)` built from two coordinate axes. `X×Y=+Z`, `Y×Z=+X`, `Z×X=+Y`;
 * the reversed pairs are negative.
 */
function handedness(i: number, j: number): 1 | -1 {
  return ((j - i + 3) % 3) === 1 ? 1 : -1;
}

registerComponent({
  type: 'EnergyChain',
  schema: RVEnergyChain.schema,
  capabilities: {
    authorable: true,
    hoverable: true,
    selectable: true,
    filterLabel: 'Energy Chains',
    badgeColor: '#8d6e63',
  },
  create: (node) => new RVEnergyChain(node),
  afterCreate: (inst, node) => {
    setComponentInstance(node, inst);
  },
});

export { solveBend };
