// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-ribbon-roller.ts — `RibbonRoller`, one roller of a taut web path
 * (plan-459, extended by plan-460).
 *
 * A roller is geometry plus a rotation: a contact radius, a local axis, and the
 * side the web lies on. `RVRibbonPath` reads the radius and the world pose,
 * solves the tangent chain, and hands back an angular increment every tick.
 *
 * ## Driven vs. follower (plan-460 F0)
 *
 * A roller is **driven** when a ROTATIONAL `Drive` sits on the SAME node with an
 * axis parallel (or antiparallel) to the roller axis. Its surface speed
 *
 *     v = omega * pi/180 * r * dot(driveAxisLocal, rollerAxisLocal)
 *
 * is the web speed of its section — the only speed source there is. Everything
 * else is a **follower**: the path turns it with `v / r`.
 *
 * Decisions worth keeping:
 *
 * 1. **omega comes from the POSITION DIFFERENCE, not from `currentSpeed`.**
 *    `RVDrive.currentSpeed` is a magnitude in DriveTo reverse travel and under
 *    `positionOverwrite` (see `driveRibbonSpeedMmPerS`), so reading it would run
 *    a web forward while its drive turns back. `(currentPosition - last) / dt`
 *    is signed by construction and covers jog, DriveTo, playback and overwrite
 *    with one expression.
 *
 * 2. **The drive is resolved from the registry on every read**, never cached in
 *    `init()`. Adding or removing a `Drive` in the editor then takes effect on
 *    the very next tick instead of on the next model load.
 *
 * 3. **The radius is measured in the node's OWN local frame.** `Box3.setFromObject`
 *    would give world extents and a parent scale would then leak into a value the
 *    path treats as millimetres of the local frame.
 *
 * 4. **The rotation is absolute, not incremental.** The node quaternion is
 *    rebuilt every tick as `authoredQuat * axisRotation(angle)`. An incremental
 *    `rotateOnAxis` accumulates float drift over a long run and, worse, has no
 *    way back to the authored pose on `reset()`.
 *
 * ## SpinMode Texture (plan-460 F11)
 *
 * A follower may fake its rotation by scrolling the MANTLE material instead of
 * turning the node (`SpinMode: 'Texture'`). The effective mode is decided per
 * tick: `Texture` only while the roller has no drive, `Transform` otherwise —
 * a driven roller is always turned by its own drive.
 */

import { Box3, Matrix4, Object3D, Quaternion, RepeatWrapping, Vector3 } from 'three';
import type { Material, Mesh, Texture } from 'three';
import type { ComponentContext, ComponentSchema, RVComponent } from './rv-component-registry';
import {
  loadSchemaFromSpec,
  registerComponent,
  removeComponentInstance,
  setComponentInstance,
} from './rv-component-registry';
import { MM_TO_METERS } from './rv-constants';
import { asDrive } from './rv-drive-utils';
import type { RVDrive } from './rv-drive';
import type { NodeRegistry } from './rv-node-registry';
import { resetMapOffsets } from './rv-texture-scroll';
import { RV_RIBBON_SPIN_MESH } from './rv-traverse-utils';

/** Local axis a roller turns about. */
export type RibbonAxis = 'X' | 'Y' | 'Z';

/** The side of the running direction the web lies on. */
export type RibbonSideName = 'Auto' | 'Left' | 'Right';

/** `+1` = Left (counter-clockwise wrap), `-1` = Right (clockwise wrap). */
export type RibbonSideSign = 1 | -1 | 0;

/** How a roller shows its rotation. */
export type RibbonSpinMode = 'Transform' | 'Texture';

/** mm — a measured radius below this counts as "no geometry found". */
const MIN_MEASURED_RADIUS_MM = 1e-3;

/** mm — fallback radius when nothing could be measured (keeps the path solvable). */
const FALLBACK_RADIUS_MM = 50;

/**
 * The smallest `|dot(driveAxis, rollerAxis)|` that still counts as parallel.
 * 0.999 is ~2.6 deg — the same order as the path's own 2 deg axis tolerance.
 */
const AXIS_PARALLEL_DOT = 0.999;

/** A material that may carry a scrollable colour map. */
interface MappedMaterial extends Material {
  map?: Texture | null;
}

// -- Pre-allocated scratch: the per-tick path allocates nothing --
const _axisVec = new Vector3();
const _rot = new Quaternion();
const _box = new Box3();
const _mat = new Matrix4();
const _inv = new Matrix4();
const _v = new Vector3();
const _driveAxis = new Vector3();
const _rollerAxis = new Vector3();

/** The unit axis vector of a {@link RibbonAxis}, written into `out`. */
export function axisVector(axis: RibbonAxis, out: Vector3): Vector3 {
  return out.set(axis === 'X' ? 1 : 0, axis === 'Y' ? 1 : 0, axis === 'Z' ? 1 : 0);
}

/**
 * The interface `RVRibbonPath` and `RibbonManager` consume. `RVRibbonWinder` and
 * `RVRibbonDancer` satisfy it too, which is what keeps the path code free of
 * winder and dancer special cases.
 */
export interface RibbonRollerLike {
  readonly node: Object3D;
  /** mm — the CURRENT contact radius. */
  readonly radiusMm: number;
  /** `+1` Left / `-1` Right. */
  readonly sideSign: RibbonSideSign;
  readonly axis: RibbonAxis;
  /** rad — current rotation about {@link axis}, relative to the authored pose. */
  angle: number;
  /** True when a usable rotational drive sits on this node (last sample). */
  readonly isDriven: boolean;
  /** mm/s — signed surface speed of the last {@link sampleDrive}. */
  readonly surfaceSpeedMmPerS: number;
  /** Read the drive of THIS tick exactly once. Called by the manager. */
  sampleDrive(dt: number): void;
  /** Add `dAngle` (rad) and write the node quaternion (or scroll the mantle). */
  advanceAngle(dAngle: number): void;
  /** Restore the authored pose (and, for a winder, the authored roll). */
  reset(): void;
}

/**
 * mm — half-extent of `node`'s mesh subtree in the plane perpendicular to
 * `axis`, expressed in `node`'s own local frame.
 *
 * `ownGeometryOnly` restricts the measurement to the node's OWN geometry, which
 * is what the plan-460 mesh-node structure wants: a roller IS the mesh, and a
 * decorative child must not inflate its radius. The caller falls back to the
 * full subtree when the node carries no geometry itself.
 *
 * Returns `0` when nothing was found; the caller decides what to do with that (a
 * `RibbonRoller` warns and falls back, a `RibbonWinder` treats it as "no authored roll").
 */
export function measureRadiusMm(node: Object3D, axis: RibbonAxis, ownGeometryOnly = false): number {
  node.updateMatrixWorld(true);
  _inv.copy(node.matrixWorld).invert();
  _box.makeEmpty();
  let found = false;
  const consider = (child: Object3D): void => {
    const mesh = child as Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox;
    if (!bb) return;
    _mat.multiplyMatrices(_inv, mesh.matrixWorld);
    // Eight corners rather than `Box3.applyMatrix4` on a shared box, so a
    // rotated child does not inflate the result through an axis-aligned re-fit
    // of an already axis-aligned re-fit.
    for (let i = 0; i < 8; i++) {
      _v.set(
        i & 1 ? bb.max.x : bb.min.x,
        i & 2 ? bb.max.y : bb.min.y,
        i & 4 ? bb.max.z : bb.min.z,
      ).applyMatrix4(_mat);
      _box.expandByPoint(_v);
      found = true;
    }
  };
  if (ownGeometryOnly) consider(node);
  else node.traverse(consider);
  if (!found) return 0;

  // Half-extent in the two axes perpendicular to the rotation axis, in mm.
  const half = (min: number, max: number): number => (max - min) / 2;
  const hx = half(_box.min.x, _box.max.x);
  const hy = half(_box.min.y, _box.max.y);
  const hz = half(_box.min.z, _box.max.z);
  const perp = axis === 'X' ? Math.max(hy, hz) : axis === 'Y' ? Math.max(hx, hz) : Math.max(hx, hy);
  return perp * MM_TO_METERS;
}

/**
 * mm — the roller radius of `node`: its OWN geometry first (the plan-460 mesh
 * node), the whole subtree second (the plan-459 parent node).
 */
export function measureRollerRadiusMm(node: Object3D, axis: RibbonAxis): number {
  const own = measureRadiusMm(node, axis, true);
  if (own > MIN_MEASURED_RADIUS_MM) return own;
  return measureRadiusMm(node, axis, false);
}

/** Browser runtime counterpart of Unity's `RibbonRoller` component (plan-459/460). */
export class RVRibbonRoller implements RVComponent, RibbonRollerLike {
  static readonly schema: ComponentSchema = loadSchemaFromSpec('RibbonRoller');

  readonly node: Object3D;
  isOwner = true;

  // -- Schema fields (PascalCase == C# field names == GLB extras keys) --
  /** mm — contact radius; 0 measures it from the mesh bounds. */
  RadiusMm = 0;
  Axis: RibbonAxis = 'X';
  RibbonSide: RibbonSideName = 'Auto';
  /** `-1` flips the visible rotation when the CAD axis points the other way. */
  RotationDirection = 1;
  /** `Texture` scrolls the mantle instead of turning the node (followers only). */
  SpinMode: RibbonSpinMode = 'Transform';
  /** The mesh that carries the mantle texture. Wire: `ComponentReference`. */
  MantleMesh: unknown = null;

  // -- Runtime state --
  /** rad — rotation relative to the authored pose. */
  angle = 0;
  /** mm — the effective radius after measuring. */
  protected _radiusMm = 0;
  protected readonly _authoredQuat = new Quaternion();
  private _initialised = false;

  // -- Drive (plan-460 F0) --
  protected _registry: NodeRegistry | null = null;
  private _nodePath = '';
  private _drive: RVDrive | null = null;
  private _lastDriveSeen: RVDrive | null = null;
  private _lastDrivePosition = 0;
  /** `dot(driveAxis, rollerAxis)` reduced to +1/-1, or 0 when unusable. */
  private _driveDot = 0;
  private _surfaceSpeedMmPerS = 0;
  private _warnedLinearDrive = false;
  private _warnedSkewDrive = false;

  // -- SpinMode Texture (plan-460 F11) --
  private _textureSpin = false;
  private _spinBound = false;
  private _mantleMesh: Mesh | null = null;
  private _authoredMantleMaterial: Material | Material[] | null = null;
  private readonly _spinMaterials: Material[] = [];
  private readonly _spinMaps: Texture[] = [];
  private _warnedDrivenTexture = false;
  private _warnedNoMantle = false;

  constructor(node: Object3D) {
    this.node = node;
  }

  get radiusMm(): number {
    return this._radiusMm;
  }

  get axis(): RibbonAxis {
    return this.Axis === 'Y' || this.Axis === 'Z' ? this.Axis : 'X';
  }

  get sideSign(): RibbonSideSign {
    return this.RibbonSide === 'Right' ? -1 : this.RibbonSide === 'Left' ? 1 : 0;
  }

  /** True when the last {@link sampleDrive} found a usable rotational drive. */
  get isDriven(): boolean {
    return this._drive !== null && this._driveDot !== 0;
  }

  /** mm/s — signed surface speed of the last {@link sampleDrive}. */
  get surfaceSpeedMmPerS(): number {
    return this._surfaceSpeedMmPerS;
  }

  /** True while this roller is currently scrolling its mantle instead of turning. */
  get isTextureSpinning(): boolean {
    return this._textureSpin;
  }

  /** The maps this roller scrolls in `Texture` mode (diagnostics + tests). */
  get spinMaps(): readonly Texture[] {
    return this._spinMaps;
  }

  init(context: ComponentContext): void {
    this._registry = context.registry ?? null;
    this._nodePath = this._registry?.getPathForNode(this.node) ?? nodePathOf(this.node);
    this.initRoller();
    this.rebaseDrive();
  }

  /**
   * Take the drive's CURRENT position as the baseline, so the next
   * {@link sampleDrive} measures a real one-tick delta instead of the whole
   * distance since load.
   *
   * Needed in exactly two places, and both are bugs without it: at `init()` (or
   * the first tick would be a lost tick) and at `reset()` (or a drive that was
   * reset to its start position would hand the web one enormous backwards tick).
   */
  rebaseDrive(): void {
    const drive = this.driveOnNode();
    this._lastDriveSeen = drive;
    this._lastDrivePosition = drive ? drive.currentPosition : 0;
  }

  /**
   * Idempotent roller setup — the authored quaternion and the radius. Split out
   * so {@link RVRibbonWinder} can run it from its own `init()` before the roll setup
   * without re-entering the component lifecycle.
   */
  protected initRoller(): void {
    if (this._initialised) return;
    this._initialised = true;
    this._authoredQuat.copy(this.node.quaternion);
    this._radiusMm = this.resolveRadiusMm();
    // Marked BEFORE the material dedup pass (loader phase 10) so a mantle whose
    // material is about to be cloned per roller is never collapsed onto shared
    // geometry — the `isRuntimeRigMesh` treatment, for the same reason.
    if (this.SpinMode === 'Texture') {
      const mantle = this._resolveMantleMesh();
      if (mantle) mantle.userData[RV_RIBBON_SPIN_MESH] = true;
    }
  }

  /** mm — the configured radius, or the measured one when `RadiusMm <= 0`. */
  protected resolveRadiusMm(): number {
    if (this.RadiusMm > 0) return this.RadiusMm;
    const measured = measureRollerRadiusMm(this.node, this.axis);
    if (measured > MIN_MEASURED_RADIUS_MM) return measured;
    console.warn(
      `[RibbonRoller] "${this.node.name}" carries no measurable geometry and no RadiusMm - `
      + `falling back to ${FALLBACK_RADIUS_MM} mm.`,
    );
    return FALLBACK_RADIUS_MM;
  }

  // -- Drive (plan-460 F0) --------------------------------------

  /**
   * The `Drive` on THIS node, resolved from the registry on every call (see the
   * file header, decision 2). A `null` registry — a bare unit test — falls back
   * to no drive, i.e. the roller is a follower.
   */
  driveOnNode(): RVDrive | null {
    if (!this._registry || !this._nodePath) return null;
    return asDrive(this._registry.getByPath<RVDrive>('Drive', this._nodePath));
  }

  /**
   * Read this tick's drive state ONCE: the signed surface speed and the
   * effective spin mode. The manager calls this for every roller of a group
   * before any path reads a speed, so a roller shared by two strips is sampled
   * exactly once and both strips see the same number.
   */
  sampleDrive(dt: number): void {
    const drive = this.driveOnNode();
    this._drive = drive;
    this._driveDot = drive ? this._resolveDriveDot(drive) : 0;

    let v = 0;
    if (drive) {
      if (drive !== this._lastDriveSeen) {
        // A drive that appeared this tick has no history: start from its
        // current position so the first tick is 0 and not a jump.
        this._lastDriveSeen = drive;
        this._lastDrivePosition = drive.currentPosition;
      }
      if (this._driveDot !== 0 && dt > 0) {
        const omegaDegPerS = (drive.currentPosition - this._lastDrivePosition) / dt;
        v = ((omegaDegPerS * Math.PI) / 180) * this._radiusMm * this._driveDot;
      }
      this._lastDrivePosition = drive.currentPosition;
    } else {
      this._lastDriveSeen = null;
    }
    this._surfaceSpeedMmPerS = Number.isFinite(v) ? v : 0;
    this._syncSpinMode(drive !== null);
  }

  /**
   * `dot(driveAxisLocal, rollerAxisLocal)` as +1/-1, or 0 when the drive cannot
   * move this roller: a LINEAR drive, or one whose axis is not (anti)parallel to
   * the roller axis. Both cases warn once and leave the roller a follower.
   */
  private _resolveDriveDot(drive: RVDrive): number {
    if (drive.isRotary === false) {
      if (!this._warnedLinearDrive) {
        this._warnedLinearDrive = true;
        console.warn(
          `[RibbonRoller] "${this.node.name}" carries a LINEAR Drive; only a rotational drive `
          + 'about the roller axis moves a web. The roller stays a follower.',
        );
      }
      return 0;
    }
    if (typeof drive.getAxis !== 'function') return 0;
    drive.getAxis(_driveAxis);
    if (_driveAxis.lengthSq() < 1e-9) return 0;   // Direction: Virtual
    _driveAxis.normalize();
    axisVector(this.axis, _rollerAxis);
    const dot = _driveAxis.dot(_rollerAxis);
    if (Math.abs(dot) <= AXIS_PARALLEL_DOT) {
      if (!this._warnedSkewDrive) {
        this._warnedSkewDrive = true;
        console.warn(
          `[RibbonRoller] "${this.node.name}": the Drive axis deviates from the roller axis `
          + `${this.axis} (|dot| = ${Math.abs(dot).toFixed(3)}); the roller stays a follower.`,
        );
      }
      return 0;
    }
    return dot > 0 ? 1 : -1;
  }

  // -- Rotation -------------------------------------------------

  /**
   * Add `dAngle` (rad) to the rotation. In `Texture` mode the node stays put and
   * the mantle map scrolls by `dAngle / 2pi` instead — which is exactly
   * `v / (2 pi r) * dt`, since the caller passes `v / r * dt`.
   */
  advanceAngle(dAngle: number): void {
    if (!Number.isFinite(dAngle) || dAngle === 0) return;
    const signed = dAngle * (this.RotationDirection < 0 ? -1 : 1);
    if (this._textureSpin) {
      if (!this._bindTextureSpin()) return;
      const du = signed / (2 * Math.PI);
      for (const tex of this._spinMaps) {
        let u = tex.offset.x + du;
        u -= Math.floor(u);            // wrap into [0,1): a long run must not lose precision
        tex.offset.x = u;
      }
      return;
    }
    this.angle += signed;
    this.applyAngle();
  }

  /**
   * Rebuild the node quaternion from the authored pose plus {@link angle}.
   *
   * `updateMatrix()` is not optional: a roller that the loader classified as
   * static carries `matrixAutoUpdate = false`, and then Three.js rebuilds the
   * local matrix from the quaternion NEVER — the angle climbs and the geometry
   * stands still. The loader keeps web nodes dynamic (`processMeshes`), but the
   * component must not depend on that classification being right; `RVDrive`
   * writes its own matrix for exactly the same reason.
   */
  protected applyAngle(): void {
    axisVector(this.axis, _axisVec);
    _rot.setFromAxisAngle(_axisVec, this.angle);
    this.node.quaternion.copy(this._authoredQuat).multiply(_rot);
    this.node.updateMatrix();
  }

  /** Restore the authored pose. */
  reset(): void {
    this.angle = 0;
    this.node.quaternion.copy(this._authoredQuat);
    this.node.updateMatrix();
    resetMapOffsets(this._spinMaps);
    this._surfaceSpeedMmPerS = 0;
    this.rebaseDrive();
  }

  // -- SpinMode Texture (plan-460 F11) --------------------------

  /**
   * Decide the EFFECTIVE spin mode for this tick and run the transition.
   * `Texture` requires `SpinMode === 'Texture'` AND no drive on the node; a
   * driven roller is turned by its drive, always.
   */
  private _syncSpinMode(hasDrive: boolean): void {
    const want = this.SpinMode === 'Texture' && !hasDrive;
    if (want === this._textureSpin) {
      if (this.SpinMode === 'Texture' && hasDrive) this._warnDrivenTexture();
      return;
    }
    this._textureSpin = want;
    if (want) {
      // -> Texture: the node returns to its authored pose and stays there.
      this.angle = 0;
      this.node.quaternion.copy(this._authoredQuat);
      this.node.updateMatrix();
      this._bindTextureSpin();
    } else {
      // -> Transform: the scroll offsets go back to 0 so the mantle does not
      // keep a frozen, arbitrary phase while the node turns.
      resetMapOffsets(this._spinMaps);
      if (this.SpinMode === 'Texture') this._warnDrivenTexture();
    }
  }

  private _warnDrivenTexture(): void {
    if (this._warnedDrivenTexture) return;
    this._warnedDrivenTexture = true;
    console.warn(
      `[RibbonRoller] "${this.node.name}" has SpinMode Texture but carries a Drive; a driven roller `
      + 'is always turned by its drive (SpinMode falls back to Transform).',
    );
  }

  /** Clone the mantle material + maps once, so this roller scrolls alone. */
  private _bindTextureSpin(): boolean {
    if (this._spinBound) return this._spinMaps.length > 0;
    this._spinBound = true;
    const mesh = this._resolveMantleMesh();
    if (!mesh) {
      if (!this._warnedNoMantle) {
        this._warnedNoMantle = true;
        console.warn(
          `[RibbonRoller] "${this.node.name}" has SpinMode Texture but no mantle mesh with a `
          + 'colour map (set MantleMesh); the roller will not appear to spin.',
        );
      }
      return false;
    }
    this._mantleMesh = mesh;
    this._authoredMantleMaterial = mesh.material;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const clones: Material[] = [];
    for (const raw of mats) {
      const clone = (raw as Material).clone();
      this._spinMaterials.push(clone);
      clones.push(clone);
      const mapped = clone as MappedMaterial;
      if (!mapped.map) continue;
      const tex = mapped.map.clone();
      tex.wrapS = RepeatWrapping;
      tex.wrapT = RepeatWrapping;
      tex.needsUpdate = true;
      mapped.map = tex;
      this._spinMaps.push(tex);
    }
    mesh.material = Array.isArray(mesh.material) ? clones : clones[0];
    return this._spinMaps.length > 0;
  }

  /**
   * The mesh that carries the mantle texture: `MantleMesh` when set, else the
   * node's own mesh, else the mapped mesh descendant with the largest bounding
   * volume that does not hang under a `Faces` node (the end discs).
   */
  private _resolveMantleMesh(): Mesh | null {
    const explicit = asMesh(nodeOf(this.MantleMesh));
    if (explicit) return explicit;
    const own = asMesh(this.node);
    if (own) return own;

    let best: Mesh | null = null;
    let bestVolume = -1;
    const walk = (obj: Object3D, underFaces: boolean): void => {
      const faces = underFaces || /(^|_)faces$/i.test(obj.name);
      const mesh = asMesh(obj);
      if (mesh && !faces && hasMap(mesh)) {
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        const bb = mesh.geometry.boundingBox;
        const volume = bb
          ? (bb.max.x - bb.min.x) * (bb.max.y - bb.min.y) * (bb.max.z - bb.min.z)
          : 0;
        if (volume > bestVolume) { bestVolume = volume; best = mesh; }
      }
      for (const child of obj.children) walk(child, faces);
    };
    for (const child of this.node.children) walk(child, false);
    return best;
  }

  getLiveState(): Record<string, unknown> {
    return {
      RadiusMm: this._radiusMm,
      AngleDeg: (this.angle * 180) / Math.PI,
      Driven: this.isDriven,
      SurfaceSpeedMmPerS: this._surfaceSpeedMmPerS,
      SpinMode: this._textureSpin ? 'Texture' : 'Transform',
    };
  }

  dispose(): void {
    if (this._mantleMesh && this._authoredMantleMaterial) {
      this._mantleMesh.material = this._authoredMantleMaterial;
    }
    for (const tex of this._spinMaps) tex.dispose();
    for (const mat of this._spinMaterials) mat.dispose();
    this._spinMaps.length = 0;
    this._spinMaterials.length = 0;
    this._mantleMesh = null;
    this._authoredMantleMaterial = null;
    this._spinBound = false;
    this._textureSpin = false;
    this._registry = null;
    this._drive = null;
    this._lastDriveSeen = null;
    removeComponentInstance(this.node, this);
  }
}

// --- helpers ---------------------------------------------------

/** A `ComponentReference`-resolved value as an `Object3D`, or `null`. */
function nodeOf(value: unknown): Object3D | null {
  const direct = value as Object3D | null;
  if (direct && (direct as unknown as { isObject3D?: boolean }).isObject3D) return direct;
  const owner = (value as { node?: unknown } | null)?.node as Object3D | undefined;
  return owner && (owner as unknown as { isObject3D?: boolean }).isObject3D ? owner : null;
}

function asMesh(obj: Object3D | null): Mesh | null {
  const mesh = obj as Mesh | null;
  return mesh && mesh.isMesh && mesh.geometry ? mesh : null;
}

function hasMap(mesh: Mesh): boolean {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const raw of mats) if ((raw as MappedMaterial)?.map) return true;
  return false;
}

/** Slash-joined ancestry — the fallback when the registry has no path. */
function nodePathOf(node: Object3D): string {
  const parts: string[] = [];
  for (let n: Object3D | null = node; n && n.parent; n = n.parent) {
    parts.unshift(n.name);
    if (!n.parent.parent) break;
  }
  return parts.join('/');
}

registerComponent({
  type: 'RibbonRoller',
  schema: RVRibbonRoller.schema,
  capabilities: {
    hoverable: true,
    selectable: true,
    authorable: true,
    filterLabel: 'Web handling',
    badgeColor: '#26a69a',
  },
  create: (node) => new RVRibbonRoller(node),
  afterCreate: (inst, node) => {
    setComponentInstance(node, inst);
  },
});
