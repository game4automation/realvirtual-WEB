// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * RVTransportGuided — port of Unity `TransportGuided` + `GuideCircle` / `GuideLine`
 * (plan-2016 Phase 3).
 *
 * A guided conveyor leads MUs along a straight line or a circular arc at the
 * LINEAR speed of the Drive on the same node (mm/s, Unity `GuidedMU.Move`:
 * velocity = tangent * Drive.IsSpeed / Scale). Unity does this with a physics
 * joint that holds the MU on the closest guide point; the web transport is
 * kinematic, so each tick the MU is put on the guide and advanced along it.
 *
 * Geometry (Unity local frame, `GuideCircle.CreatePath`): the path starts at the
 * node origin with tangent `transform.right`; the arc bends around the centre
 * `-forward * sign(Angle) * Radius` (`GuideCircle.cs:89`). In the web the X axis
 * is mirrored (glTF), so in NODE-LOCAL web coordinates, with s = sign(Angle):
 *
 *   centre      c   = (0, 0, -s·R)
 *   point       P(φ) = (-R·sin φ, 0, -s·R·(1 - cos φ))      φ ∈ [0, |Angle|]
 *   tangent     T(φ) = (-cos φ, 0, -s·sin φ)
 *
 * Beyond either end the guide angle is clamped (Unity `Mathf.Clamp`), so an MU
 * leaving the arc continues straight along the end tangent until the next
 * surface takes it over through the transport manager's normal contact path.
 * Reverse drive speed runs the same guide backwards.
 *
 * Contact (`SetColliderSizeArc`): the transport manager uses the box Unity
 * generates as BoxCollider — (maxX + ColliderBorderX) × Height × (maxZ +
 * ColliderBorderZ) below the transport plane; straight guide: Length × Height ×
 * Width.
 *
 * Orientation (`GuidedMU.Move`): the MU yaw follows the tangent, keeping the
 * entry offset rounded to a multiple of 90° (`GetOffsetAngle`).
 *
 * No allocation in `transportMU` (module scratch + per-instance matrices).
 */

import { Box3, Matrix4, Object3D, Quaternion, Vector3 } from 'three';
import { MM_TO_METERS } from './rv-constants';
import { RVTransportSurface } from './rv-transport-surface';
import type { RVMovingUnit, InstancedMovingUnit } from './rv-mu';
import type { AABB } from './rv-aabb';
import type { ComponentSchema, ComponentContext } from './rv-component-registry';
import { registerComponent, loadSchemaFromSpec } from './rv-component-registry';

const HALF_PI = Math.PI / 2;
const DEG2RAD = Math.PI / 180;

// Scratch (no GC in the transport hot path; single-threaded reuse is safe).
const _p = new Vector3();
const _axis = new Vector3();
const _fwd = new Vector3();
const _q = new Quaternion();
const _qa = new Quaternion();
const _qb = new Quaternion();
const _worldQuat = new Quaternion();
const _pos = new Vector3();
const _scale = new Vector3();
const UP = new Vector3(0, 1, 0);
/** Result of {@link RVTransportGuided.advanceLocal}: new local x/z and the guide angle (rad) before/after. */
interface GuideStep { x: number; z: number; phiFrom: number; phiTo: number }
const _step: GuideStep = { x: 0, z: 0, phiFrom: 0, phiTo: 0 };

export class RVTransportGuided extends RVTransportSurface {
  static override readonly schema: ComponentSchema = loadSchemaFromSpec('TransportGuided');

  // Properties — exact C# Inspector field names (meters / degrees, like Unity).
  Circular = false;
  Length = 1;
  Radius = 1;
  Angle = 90;
  Height = 0.5;
  Width = 0.5;
  ColliderBorderX = 0.2;
  ColliderBorderZ = 0.2;
  DistanceCollider = 0.005;

  /** Inverse of the node's world matrix, refreshed once per transport tick. */
  private readonly _invWorld = new Matrix4();
  private _invTickId = -1;
  /** Node-local units per world metre in the guide plane (1 on an unscaled node). */
  private _localPerWorld = 1;

  constructor(node: Object3D, aabb: AABB) {
    super(node, aabb);
    // Unity's TransportGuided does not scroll belt textures.
    this.AnimateSurface = false;
    this.Accumulate = false;
  }

  /** Sign of the arc (Unity `Mathf.Sign(Angle)`; 0 counts as +1 like Mathf.Sign). */
  private get _s(): number { return this.Angle < 0 ? -1 : 1; }
  /** Arc span in radians. */
  private get _span(): number { return Math.min(Math.abs(this.Angle), 360) * DEG2RAD; }
  /** True when the guide is a usable arc (Circular, R > 0, Angle ≠ 0). */
  get isArc(): boolean { return this.Circular && this.Radius > 0 && this.Angle !== 0; }

  /** Base-class "transport direction" (entering test of the transport manager,
   *  selection arrow): the chord start → end of the guide, node-local web coords. */
  private _setChordDirection(): void {
    if (this.isArc) {
      const e = this.pointAt(this._span, _p);
      if (e.lengthSq() > 1e-12) this.TransportDirection.copy(e).normalize();
      else this.TransportDirection.set(-1, 0, 0); // full circle: start tangent
    } else {
      this.TransportDirection.set(-1, 0, 0); // Unity +X (transform.right), X mirrored
    }
  }

  init(context: ComponentContext): void {
    this._setChordDirection();
    if (this.Circular && !this.isArc) {
      console.warn(`  TransportGuided "${this.node.name}": Circular with Radius ${this.Radius} / Angle ${this.Angle} is not a valid arc - guiding as a straight line`);
    }
    super.init(context);
  }

  /** Re-derive chord direction AND contact box after an inspector edit
   *  (Circular / Length / Radius / Angle / Height / Width / borders).
   *  IMPLEMENTS RVComponent::reapplyConfig */
  override reapplyConfig(): void {
    this._setChordDirection();
    super.reapplyConfig();
    this.node.updateMatrixWorld(true);
    this.refreshContactBox();
    this.updateAABB();
  }

  /** Contact box = Unity's generated BoxCollider (`SetColliderSizeArc`),
   *  converted to web node-local (X mirrored). For |Angle| > 180° Unity's formula
   *  only covers the first half circle (x ≥ 0 in Unity), so beyond 180° the box is
   *  the arc's true bounding box grown by the borders on every side. */
  protected override computeContactLocalBox(): Box3 | null {
    let cx: number, cy: number, cz: number, sx: number, sy: number, sz: number;
    if (this.isArc && this._span > Math.PI) {
      // x(φ) = -R sin φ, z(φ) = -sR(1 - cos φ) over [0, span]: extremes at the
      // ends and at the quarter angles inside the span.
      let minX = 0, maxX = 0, minZ = 0, maxZ = 0;
      const span = this._span;
      for (const a of [span, HALF_PI, Math.PI, 3 * HALF_PI]) {
        if (a > span) continue;
        this.pointAt(a, _p);
        if (_p.x < minX) minX = _p.x; if (_p.x > maxX) maxX = _p.x;
        if (_p.z < minZ) minZ = _p.z; if (_p.z > maxZ) maxZ = _p.z;
      }
      const bx = this.ColliderBorderX, bz = this.ColliderBorderZ;
      return new Box3(
        new Vector3(minX - bx, -this.Height, minZ - bz),
        new Vector3(maxX + bx, 0, maxZ + bz),
      );
    }
    if (this.isArc) {
      const span = this._span;
      const R = this.Radius;
      const maxx = span >= HALF_PI ? R : R * Math.sin(span);
      const maxz = R * (1 - Math.cos(span));
      sx = maxx + this.ColliderBorderX;
      sy = this.Height;
      let sizez = maxz + this.ColliderBorderZ;
      let borz = this.ColliderBorderZ;
      if (this.Angle < 0) { sizez = -sizez; borz = -borz; }
      sz = sizez;
      // Unity centre (sizex/2, -H/2, -sizez/2 + borz); web: x negated.
      cx = -sx * 0.5;
      cy = -this.Height * 0.5;
      cz = -sizez * 0.5 + borz;
    } else {
      sx = this.Length; sy = this.Height; sz = this.Width;
      cx = -this.Length / 2;
      cy = -this.Height / 2 - this.DistanceCollider;
      cz = 0;
    }
    const hx = Math.abs(sx) / 2, hy = Math.abs(sy) / 2, hz = Math.abs(sz) / 2;
    if (!(hx > 0 && hz > 0)) return null;
    return new Box3(new Vector3(cx - hx, cy - hy, cz - hz), new Vector3(cx + hx, cy + hy, cz + hz));
  }

  /** Arc point at guide angle φ (rad), node-local web coordinates. */
  pointAt(phi: number, out: Vector3): Vector3 {
    const R = this.Radius;
    return out.set(-R * Math.sin(phi), 0, -this._s * R * (1 - Math.cos(phi)));
  }

  /** Unit tangent at guide angle φ (rad), node-local web coordinates. */
  tangentAt(phi: number, out: Vector3): Vector3 {
    return out.set(-Math.cos(phi), 0, -this._s * Math.sin(phi));
  }

  /** Guide angle (rad, clamped to [0, span]) of the closest guide point to a
   *  node-local point — Unity `GetClosestPoint` / `GetClosestDirection`.
   *  Up to 180° this is Unity's clamp of the signed angle exactly; beyond 180°
   *  (where Unity's [-180°, 180°] SignedAngle cannot reach the second half) the
   *  angle is taken in [0°, 360°) and a point in the gap snaps to the nearer end. */
  closestAngle(x: number, z: number): number {
    const s = this._s;
    const relz = z + s * this.Radius;
    let phi = Math.atan2(-x, s * relz);
    const span = this._span;
    if (span > Math.PI) {
      if (phi < 0) phi += 2 * Math.PI;
      if (phi > span) phi = (phi - span) < (2 * Math.PI - phi) ? span : 0;
      return phi;
    }
    if (phi < 0) phi = 0;
    if (phi > span) phi = span;
    return phi;
  }

  /**
   * Advance a node-local point by `dist` metres (signed) along the guide.
   * Writes into a shared scratch and returns it. Pure (no node access) — the
   * kinematic core used by `transportMU` and the unit tests.
   */
  advanceLocal(x: number, z: number, dist: number): GuideStep {
    if (!this.isArc) {
      // Straight guide along local -X (Unity +X), lateral offset removed.
      _step.x = x - dist;
      _step.z = 0;
      _step.phiFrom = 0;
      _step.phiTo = 0;
      return _step;
    }
    const R = this.Radius;
    const span = this._span;
    const phi0 = this.closestAngle(x, z);
    // Offset of the point along the tangent line at the clamped angle: 0 on the
    // arc, ≠ 0 before the start / past the end (straight run-in / run-out).
    this.pointAt(phi0, _p);
    const tx = -Math.cos(phi0);
    const tz = -this._s * Math.sin(phi0);
    const along = (x - _p.x) * tx + (z - _p.z) * tz;
    // Arc length coordinate u: < 0 before the start, > span·R past the end.
    let u: number;
    if (phi0 <= 0 && along < 0) u = along;
    else if (phi0 >= span && along > 0) u = span * R + along;
    else u = phi0 * R;
    u += dist;
    const len = span * R;
    let phi1: number;
    if (u < 0) {
      phi1 = 0;
      this.pointAt(0, _p);
      _step.x = _p.x + (-1) * u; // tangent at 0 is (-1, 0, 0)
      _step.z = _p.z;
    } else if (u > len) {
      phi1 = span;
      this.pointAt(span, _p);
      const rest = u - len;
      _step.x = _p.x - Math.cos(span) * rest;
      _step.z = _p.z - this._s * Math.sin(span) * rest;
    } else {
      phi1 = u / R;
      this.pointAt(phi1, _p);
      _step.x = _p.x;
      _step.z = _p.z;
    }
    _step.phiFrom = phi0;
    _step.phiTo = phi1;
    return _step;
  }

  /** Yaw (rad, about node-local +Y) of the tangent at guide angle φ. */
  private _tangentYaw(phi: number): number {
    // heading h(v) = atan2(-vz, vx) increases with a +Y rotation.
    if (!this.isArc) return Math.PI; // (-1, 0, 0)
    return Math.atan2(this._s * Math.sin(phi), -Math.cos(phi));
  }

  override transportMU(mu: RVMovingUnit | InstancedMovingUnit, dt: number): void {
    const speedM = this.speed / MM_TO_METERS;
    if (speedM === 0 || dt === 0) return;

    const tick = RVTransportSurface.currentTickId;
    if (this._invTickId !== tick) {
      this._invTickId = tick;
      this.node.updateWorldMatrix(true, false);
      this._invWorld.copy(this.node.matrixWorld).invert();
      // The guide lives in node-local units; the Drive speed is a WORLD speed.
      // Scale of the guide plane = mean length of the node's world X and Z axes.
      const e = this.node.matrixWorld.elements;
      const sxw = Math.hypot(e[0], e[1], e[2]);
      const szw = Math.hypot(e[8], e[9], e[10]);
      const sw = (sxw + szw) / 2;
      this._localPerWorld = sw > 1e-12 ? 1 / sw : 1;
    }

    // MU position: parent-local (clone) or world (instanced / scene root) → node-local.
    const muNode: Object3D | null = (mu as RVMovingUnit).node ?? null;
    const muParent: Object3D | null = (muNode && !(mu as { isInstanced?: boolean }).isInstanced)
      ? muNode.parent
      : null;
    _p.copy(mu.getPosition());
    if (muParent) muParent.localToWorld(_p);
    _p.applyMatrix4(this._invWorld);
    const y = _p.y;

    const step = this.advanceLocal(_p.x, _p.z, speedM * dt * this._localPerWorld);
    const yawFrom = this._tangentYaw(step.phiFrom);
    const yawTo = this._tangentYaw(step.phiTo);

    _p.set(step.x, y, step.z).applyMatrix4(this.node.matrixWorld);
    if (muParent) muParent.worldToLocal(_p);
    mu.setPosition(_p);

    // ── Orientation: tangent yaw + entry offset rounded to 90° (GuidedMU) ──
    if (typeof mu.getQuaternion !== 'function') return;
    this.node.matrixWorld.decompose(_pos, _worldQuat, _scale);
    _axis.copy(UP).applyQuaternion(_worldQuat).normalize(); // node up in world
    // MU world quaternion.
    if (muParent) {
      muParent.getWorldQuaternion(_qa);
      _qb.copy(_qa).multiply(mu.getQuaternion());
    } else {
      _qb.copy(mu.getQuaternion());
    }
    // MU forward (Unity transform.forward = +Z, not mirrored) in node-local.
    _fwd.set(0, 0, 1).applyQuaternion(_qb).applyQuaternion(_qa.copy(_worldQuat).invert());
    if (_fwd.x * _fwd.x + _fwd.z * _fwd.z < 0.01) {
      _fwd.set(1, 0, 0).applyQuaternion(_qb).applyQuaternion(_qa.copy(_worldQuat).invert());
    }
    const muYaw = Math.atan2(-_fwd.z, _fwd.x);
    let offset = muYaw - yawFrom;
    offset = Math.atan2(Math.sin(offset), Math.cos(offset));
    const snapped = Math.round(offset / HALF_PI) * HALF_PI;
    let delta = (yawTo + snapped) - muYaw;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    if (Math.abs(delta) < 1e-9) return;
    _q.setFromAxisAngle(_axis, delta);
    _qb.premultiply(_q); // new world quaternion
    if (muParent) {
      muParent.getWorldQuaternion(_qa);
      _qa.invert().multiply(_qb);
      mu.setQuaternion(_qa);
    } else {
      mu.setQuaternion(_qb);
    }
  }
}

registerComponent({
  type: 'TransportGuided',
  schema: RVTransportGuided.schema,
  needsAABB: true,
  capabilities: {
    // Same bake role as TransportSurface: the guide is a boundary of its own.
    bake: 'chunk',
    ui: { badge: '#ffa726', filter: 'Conveyors', category: 'transport' },
  },
  create: (node, aabb) => new RVTransportGuided(node, aabb!),
});
