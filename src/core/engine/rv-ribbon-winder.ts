// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-ribbon-winder.ts — `RibbonWinder`, the unwinder / rewinder at one end of a web path
 * (plan-459).
 *
 * A winder IS a roller (it extends {@link RVRibbonRoller}) whose radius follows the
 * wound length through `R(L) = sqrt(R0² + L·t/π)` — see `web/ribbon-winder-math.ts`
 * for the derivation. Everything the path needs is the moving `radiusMm`, so the
 * tangent solver has no winder special case at all.
 *
 * ## Three decisions worth keeping
 *
 * 1. **Length is the state, radius is derived.** The incremental form
 *    `dR = t·v·dt/(2πR)` is the textbook one, but it drifts: a rewinder driven
 *    forward and back would not return to its authored diameter. Integrating `L`
 *    and deriving `R` makes the roll exactly reversible, which is what
 *    `resetAll()` and a jogged drive both depend on.
 *
 * 2. **The roll is SCALED, never rebuilt.** `RollMesh` is scaled radially in the
 *    two axes perpendicular to the winding axis, relative to the AUTHORED scale
 *    of that node. A CAD roll therefore needs no remodelling, the axial length of
 *    the roll stays put, and no geometry is touched per tick. A winder without a
 *    `RollMesh` gets a procedural cylinder so it is never invisible.
 *
 * 3. **The authored scale is remembered on the node, not only in the instance.**
 *    The asset exporter clones the LIVE tree and cannot reach a component; the
 *    `RV_RIBBON_ROLL_SCALE` triple in `userData` is how the clone learns what to
 *    restore (and why it is not simply reset to `(1,1,1)` — see the marker doc).
 */

import {
  CylinderGeometry,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Vector3,
} from 'three';
import type { ComponentContext, ComponentSchema } from './rv-component-registry';
import {
  loadSchemaFromSpec,
  registerComponent,
  setComponentInstance,
} from './rv-component-registry';
import { RVRibbonRoller, axisVector, measureRollerRadiusMm } from './rv-ribbon-roller';
import { RV_RIBBON_ROLL_SCALE } from './rv-traverse-utils';
import { MM_TO_METERS } from './rv-constants';
import { lengthFromRadiusMm, radiusFromLengthMm } from './ribbon/ribbon-winder-math';

/** Which end of the path a winder sits at — assigned by the owning `RVRibbonPath`. */
export type RibbonWinderRole = 'unwind' | 'rewind' | 'none';

/** mm — a diameter change below this does not warrant a signal write (F8). */
const SIGNAL_EPSILON_MM = 0.1;

/** Radial segments of the procedural fallback roll. */
const FALLBACK_SEGMENTS = 24;

/** True when `value` is a first write or moved more than the signal epsilon. */
function changedBy(value: number, previous: number): boolean {
  return !Number.isFinite(previous) || Math.abs(value - previous) > SIGNAL_EPSILON_MM;
}

const _axis = new Vector3();
const _scale = new Vector3();

/** True when `node` carries geometry of its own (the plan-460 mesh-node roller). */
function isMeshNode(node: Object3D): boolean {
  const mesh = node as unknown as { isMesh?: boolean; geometry?: unknown };
  return mesh.isMesh === true && mesh.geometry != null;
}

/** Browser runtime counterpart of Unity's `RibbonWinder` component (plan-459). */
export class RVRibbonWinder extends RVRibbonRoller {
  static readonly schema: ComponentSchema = loadSchemaFromSpec('RibbonWinder');

  // ── Schema fields ──
  /** mm — radius of the bare core; must be > 0. */
  CoreRadiusMm = 76.2;
  /** mm — thickness of one web layer; must be > 0. */
  RibbonThicknessMm = 0.1;
  /** mm — length on the roll at load; `-1` derives it from the measured radius. */
  InitialWoundLengthMm = -1;
  /** mm — diameter at which the roll is Full; 0 = no limit. */
  MaxDiameterMm = 0;
  /** Child node scaled radially. Wire: `ComponentReference` (`UnityEngine.Transform`). */
  RollMesh: unknown = null;
  /** Signal slots — resolved to signal addresses by `resolveComponentRefs`. */
  DiameterMm: unknown = null;
  WoundLengthMm: unknown = null;
  Empty: unknown = null;
  Full: unknown = null;

  // ── Runtime state ──
  /** mm — the currently wound web length. */
  woundLengthMm = 0;
  /** Which end of its path this winder is. Set by `RVRibbonPath` on build. */
  role: RibbonWinderRole = 'none';

  /** mm — the length the roll starts (and resets) with. */
  private _initialLengthMm = 0;
  /** mm — the AUTHORED outer radius the roll mesh scale is measured against. */
  private _authoredRadiusMm = 0;
  private _rollNode: Object3D | null = null;
  private readonly _authoredRollScale = new Vector3(1, 1, 1);
  /** The procedural roll this component created (and therefore must dispose). */
  private _generatedRoll: Mesh | null = null;
  private _inert = false;
  private _ribbonWinderReady = false;

  /** True when the configuration is unusable (`warn`ed once, then ignored). */
  get isInert(): boolean {
    return this._inert;
  }

  /** mm — current outer radius of the roll (this is the roller contact radius). */
  override get radiusMm(): number {
    return this._radiusMm;
  }

  /** mm — current outer DIAMETER (what the `DiameterMm` signal carries). */
  get diameterMm(): number {
    return this._radiusMm * 2;
  }

  /** True while the roll is down to its bare core. */
  get isEmpty(): boolean {
    return !this._inert && this.woundLengthMm <= 0;
  }

  /** True once `MaxDiameterMm` is reached (never, when it is 0). */
  get isFull(): boolean {
    return !this._inert && this.MaxDiameterMm > 0 && this.diameterMm >= this.MaxDiameterMm;
  }

  override init(context: ComponentContext): void {
    // `super.init` wires the node registry the DRIVE lookup needs (plan-460) and
    // runs `initRoller()`; skipping it left a driven winder without a drive.
    super.init(context);
    this.initRibbonWinder(context);
  }

  /** Idempotent roll setup — validation, initial length, roll mesh. */
  private initRibbonWinder(context: ComponentContext): void {
    if (this._ribbonWinderReady) return;
    this._ribbonWinderReady = true;

    if (!(this.CoreRadiusMm > 0) || !(this.RibbonThicknessMm > 0)) {
      this._inert = true;
      console.warn(
        `[RibbonWinder] "${this.node.name}" is inactive: CoreRadiusMm (${this.CoreRadiusMm}) and `
        + `RibbonThicknessMm (${this.RibbonThicknessMm}) must both be greater than 0.`,
      );
      return;
    }

    // The authored outer radius: the configured one, or the measured mesh bounds.
    // It is the reference the roll scale is expressed against, so it must be read
    // BEFORE anything is scaled.
    this._authoredRadiusMm = this.RadiusMm > 0
      ? this.RadiusMm
      : measureRollerRadiusMm(this.node, this.axis) || this.CoreRadiusMm;

    this._initialLengthMm = this.InitialWoundLengthMm >= 0
      ? this.InitialWoundLengthMm
      : lengthFromRadiusMm(this.CoreRadiusMm, this.RibbonThicknessMm, this._authoredRadiusMm);

    // An authoring load must not materialise runtime geometry into the document
    // (same rule as RVChain's element clones, plan-733 R4) — the procedural roll
    // is skipped there; an authored RollMesh is still bound so the inspector
    // shows a live radius.
    this._bindRollMesh(context.authoring === true);
    this.reset();
  }

  /**
   * Resolve (or build) the node that visualises the wound roll.
   *
   * plan-460 §2.4 turns the default around: the winder IS the roll mesh, so an
   * empty `RollMesh` scales the winder's OWN node. `RollMesh` stays for the
   * plan-459 structure (an empty parent with mesh children) and for CAD rolls
   * that are modelled as a separate part. A procedural cylinder is only built
   * when the node has no geometry of its own to scale.
   *
   * A core modelled as a CHILD of the roll would scale with it — the core is a
   * `_Core` SIBLING, and a child that looks like one is warned about.
   */
  private _bindRollMesh(authoring: boolean): void {
    const ref = this.RollMesh as { node?: unknown } | Object3D | null;
    const direct = ref as Object3D | null;
    const node = direct && (direct as unknown as { isObject3D?: boolean }).isObject3D
      ? direct
      : ((ref as { node?: unknown } | null)?.node as Object3D | undefined) ?? null;

    if (node) {
      this._rollNode = node;
    } else if (isMeshNode(this.node)) {
      this._rollNode = this.node;
      this._warnAboutCoreChild();
    } else if (!authoring) {
      this._rollNode = this._buildProceduralRoll();
    } else {
      return;
    }

    this._authoredRollScale.copy(this._rollNode.scale);
    // The exporter works on a clone and cannot reach this instance — see the
    // marker doc in rv-traverse-utils.ts.
    this._rollNode.userData[RV_RIBBON_ROLL_SCALE] = [
      this._authoredRollScale.x,
      this._authoredRollScale.y,
      this._authoredRollScale.z,
    ];
  }

  /** Warn once when a core is modelled as a CHILD of the scaled roll node. */
  private _warnAboutCoreChild(): void {
    for (const child of this.node.children) {
      if (!/(^|[_\s-])core$/i.test(child.name)) continue;
      console.warn(
        `[RibbonWinder] "${this.node.name}" scales its own node, but "${child.name}" is a CHILD of `
        + 'it and will scale with the roll. Model the core as a sibling (e.g. '
        + `"${this.node.name}_Core").`,
      );
      return;
    }
  }

  /**
   * A plain cylinder at the AUTHORED radius, so a winder without a CAD roll is
   * still visible and still scales. Marked with `RV_RIBBON_ROLL_SCALE` like an
   * authored roll and disposed in {@link dispose}.
   */
  private _buildProceduralRoll(): Object3D {
    const rM = this._authoredRadiusMm / MM_TO_METERS;
    // Axial length: whatever the node measures along its axis, else 2·r.
    const geo = new CylinderGeometry(rM, rM, rM * 2, FALLBACK_SEGMENTS, 1, true);
    const mesh = new Mesh(geo, new MeshStandardMaterial({ color: 0xd9d2c5, roughness: 0.9 }));
    mesh.name = `${this.node.name}_Roll`;
    // CylinderGeometry is built around +Y; rotate it onto the winding axis.
    if (this.axis === 'X') mesh.rotation.z = Math.PI / 2;
    else if (this.axis === 'Z') mesh.rotation.x = Math.PI / 2;
    mesh.userData._rvGenerated = true;
    this.node.add(mesh);
    this._generatedRoll = mesh;
    return mesh;
  }

  // ── Tick ───────────────────────────────────────────────────────

  /**
   * How much of `vMmPerS` this winder can take in `dt` seconds without running
   * past its own limits. Returns the SIGNED speed the caller may use.
   *
   * The manager takes the minimum magnitude over every winder of a path group,
   * which is what makes a shared unwinder stop every strip of a slitter in the
   * same tick (plan §Entscheidungs-Log, "Bahngruppen").
   */
  clampSpeed(vMmPerS: number, dt: number): number {
    if (this._inert || this.role === 'none' || !(dt > 0)) return vMmPerS;
    // dL/dt as seen by THIS winder: an unwinder loses what a rewinder gains.
    const sign = this.role === 'rewind' ? 1 : -1;
    const dL = sign * vMmPerS * dt;
    if (dL < 0 && this.woundLengthMm <= 0) return 0;
    if (dL > 0 && this.isFull) return 0;
    return vMmPerS;
  }

  /** Integrate `vMmPerS` for `dt` seconds and update radius + roll visual. */
  advance(vMmPerS: number, dt: number): void {
    if (this._inert || this.role === 'none' || !(dt > 0) || vMmPerS === 0) return;
    const sign = this.role === 'rewind' ? 1 : -1;
    let next = this.woundLengthMm + sign * vMmPerS * dt;
    if (next < 0) next = 0;
    if (next === this.woundLengthMm) return;
    this.woundLengthMm = next;
    this._recomputeRadius();
  }

  private _recomputeRadius(): void {
    this._radiusMm = radiusFromLengthMm(this.CoreRadiusMm, this.RibbonThicknessMm, this.woundLengthMm);
    this.applyVisual();
  }

  /**
   * Scale `RollMesh` radially to the current radius, in the two axes
   * perpendicular to the winding axis. The axial component keeps the authored
   * value — the roll grows in diameter, not in width.
   */
  applyVisual(): void {
    const roll = this._rollNode;
    if (!roll || !(this._authoredRadiusMm > 0)) return;
    const f = this._radiusMm / this._authoredRadiusMm;
    axisVector(this.axis, _axis);
    _scale.copy(this._authoredRollScale);
    if (_axis.x === 0) _scale.x *= f;
    if (_axis.y === 0) _scale.y *= f;
    if (_axis.z === 0) _scale.z *= f;
    roll.scale.copy(_scale);
    // A roll node classified as static keeps `matrixAutoUpdate = false`, and then
    // the scale below never reaches `matrixWorld` — the diameter grows in the
    // signals and the roll stays the size it was modelled at. Same defence as
    // `RVRibbonRoller.applyAngle()`.
    roll.updateMatrix();
  }

  /**
   * Write the four feedback slots, but only on a real change: a float signal
   * whose value moved less than {@link SIGNAL_EPSILON_MM}, or a bool that did
   * not flip, is not written at all (F8).
   */
  writeSignals(write: (address: string, value: number | boolean) => void): void {
    if (this._inert) return;
    // `NaN` is the "never written" marker, and `Math.abs(x - NaN) > eps` is
     // FALSE — so the first write has to be its own case, or the PLC would never
     // see the initial diameter at all.
    const d = this.diameterMm;
    if (typeof this.DiameterMm === 'string' && changedBy(d, this._lastDiameterMm)) {
      this._lastDiameterMm = d;
      write(this.DiameterMm, d);
    }
    const l = this.woundLengthMm;
    if (typeof this.WoundLengthMm === 'string' && changedBy(l, this._lastLengthMm)) {
      this._lastLengthMm = l;
      write(this.WoundLengthMm, l);
    }
    const empty = this.isEmpty;
    if (typeof this.Empty === 'string' && empty !== this._lastEmpty) {
      this._lastEmpty = empty;
      write(this.Empty, empty);
    }
    const full = this.isFull;
    if (typeof this.Full === 'string' && full !== this._lastFull) {
      this._lastFull = full;
      write(this.Full, full);
    }
  }

  private _lastDiameterMm = Number.NaN;
  private _lastLengthMm = Number.NaN;
  private _lastEmpty: boolean | null = null;
  private _lastFull: boolean | null = null;

  /** Restore the authored roll, the authored pose and the signal edge memory. */
  override reset(): void {
    super.reset();
    if (this._inert) return;
    this.woundLengthMm = this._initialLengthMm;
    this._recomputeRadius();
    this._lastDiameterMm = Number.NaN;
    this._lastLengthMm = Number.NaN;
    this._lastEmpty = null;
    this._lastFull = null;
  }

  override getLiveState(): Record<string, unknown> {
    return {
      RadiusMm: this._radiusMm,
      DiameterMm: this.diameterMm,
      WoundLengthMm: this.woundLengthMm,
      Empty: this.isEmpty,
      Full: this.isFull,
      AngleDeg: (this.angle * 180) / Math.PI,
    };
  }

  override dispose(): void {
    if (this._rollNode) {
      this._rollNode.scale.copy(this._authoredRollScale);
      this._rollNode.updateMatrix();
      delete this._rollNode.userData[RV_RIBBON_ROLL_SCALE];
    }
    if (this._generatedRoll) {
      this._generatedRoll.removeFromParent();
      this._generatedRoll.geometry.dispose();
      (this._generatedRoll.material as MeshStandardMaterial).dispose();
      this._generatedRoll = null;
    }
    this._rollNode = null;
    super.dispose();
  }
}

registerComponent({
  type: 'RibbonWinder',
  schema: RVRibbonWinder.schema,
  capabilities: {
    hoverable: true,
    selectable: true,
    authorable: true,
    filterLabel: 'Web handling',
    badgeColor: '#26a69a',
  },
  create: (node) => new RVRibbonWinder(node),
  afterCreate: (inst, node) => {
    setComponentInstance(node, inst);
  },
});
