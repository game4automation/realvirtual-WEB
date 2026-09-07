// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-ribbon-dancer.ts — `RibbonDancer`, the accumulator roller between two
 * driven sections of a web path (plan-460 F2-F4).
 *
 * A dancer IS a roller (it extends {@link RVRibbonRoller}) that TRANSLATES along
 * a travel axis instead of standing still. It splits its path into an upstream
 * and a downstream section at its own departure tangent point, and it stores the
 * difference between the two section speeds as web length — which is exactly
 * what a real dancer does to hold tension while two drives run at slightly
 * different surface speeds.
 *
 * ## Three decisions worth keeping
 *
 * 1. **No drive references at all.** `v_up` and `v_down` are the speeds of the
 *    neighbouring sections, which come from the DRIVEN ROLLERS of those sections
 *    (plan-460 F0). A dancer that named its own drives would be a second,
 *    competing speed source — the thing plan-460 exists to remove.
 *
 * 2. **The limits are DIRECTIONAL, and they never stop a drive.** At the upper
 *    stop only further FILLING is prevented (`v_up_eff = min(v_up, v_down)`); at
 *    the lower stop only further EMPTYING (`v_down_eff = min(v_down, v_up)`).
 *    A symmetric "stop everything" clamp deadlocks: with both sections at 0 no
 *    delta can ever free the carriage again (SOL round-1 finding 1). The PLC is
 *    expected to regulate on `PositionMm` / `AtMin` / `AtMax`.
 *
 * 3. **Position is derived from `L_acc`, and `L_acc` is rewound on a clamp.**
 *    See `ribbon/ribbon-dancer-math.ts` — the anti-windup rule is the reason the
 *    mathematics lives in a `three`-free file with its own unit tests.
 */

import { Object3D, Vector3 } from 'three';
import type { ComponentContext, ComponentSchema } from './rv-component-registry';
import {
  loadSchemaFromSpec,
  registerComponent,
  setComponentInstance,
} from './rv-component-registry';
import { MM_TO_METERS } from './rv-constants';
import { RVRibbonRoller, axisVector, type RibbonAxis } from './rv-ribbon-roller';
import {
  accumulate,
  clampTravel,
  normaliseStrands,
  positionFromAccumulated,
} from './ribbon/ribbon-dancer-math';

/** mm — a position change below this does not warrant a signal write (F3). */
const SIGNAL_EPSILON_MM = 0.1;

const _travel = new Vector3();

/** True when `value` is a first write or moved more than the signal epsilon. */
function changedBy(value: number, previous: number): boolean {
  return !Number.isFinite(previous) || Math.abs(value - previous) > SIGNAL_EPSILON_MM;
}

/** Browser runtime counterpart of Unity's `RibbonDancer` component (plan-460). */
export class RVRibbonDancer extends RVRibbonRoller {
  static readonly schema: ComponentSchema = loadSchemaFromSpec('RibbonDancer');

  // -- Schema fields --
  /** Travel axis of the carriage, in the dancer node's PARENT frame. */
  TravelAxis: RibbonAxis = 'Y';
  /** mm — lower stop relative to `HomeMm`; must be <= 0. */
  TravelMinMm = -200;
  /** mm — upper stop relative to `HomeMm`; must be >= 0. */
  TravelMaxMm = 200;
  /** mm — rest position along the travel axis; 0 = the authored position. */
  HomeMm = 0;
  /** Web strands through the carriage: 1 mm of travel stores `Strands` mm of web. */
  Strands = 2;
  /** Signal slots — resolved to signal addresses by `resolveComponentRefs`. */
  PositionMm: unknown = null;
  AtMin: unknown = null;
  AtMax: unknown = null;

  // -- Runtime state --
  /** mm — accumulated web length (positive = the loop is longer than at home). */
  lAccMm = 0;
  /** mm — the carriage position along the travel axis. */
  positionMm = 0;

  private _atMin = false;
  private _atMax = false;
  private _inert = false;
  private readonly _authoredPosition = new Vector3();
  private _dancerReady = false;
  private _lastPositionMm = Number.NaN;
  private _lastAtMin: boolean | null = null;
  private _lastAtMax: boolean | null = null;

  /** True when the configuration is unusable (`warn`ed once, then ignored). */
  get isInert(): boolean {
    return this._inert;
  }

  /** True while the carriage sits at its lower stop (the store is empty). */
  get atMin(): boolean {
    return this._atMin;
  }

  /** True while the carriage sits at its upper stop (the store is full). */
  get atMax(): boolean {
    return this._atMax;
  }

  /** The travel axis, defaulted like {@link RVRibbonRoller.axis}. */
  get travelAxis(): RibbonAxis {
    return this.TravelAxis === 'X' || this.TravelAxis === 'Z' ? this.TravelAxis : 'Y';
  }

  override init(context: ComponentContext): void {
    super.init(context);
    this._initDancer();
  }

  private _initDancer(): void {
    if (this._dancerReady) return;
    this._dancerReady = true;
    this._authoredPosition.copy(this.node.position);
    if (this.TravelMinMm > 0 || this.TravelMaxMm < 0 || this.TravelMinMm >= this.TravelMaxMm) {
      this._inert = true;
      console.warn(
        `[RibbonDancer] "${this.node.name}" is inactive: TravelMinMm (${this.TravelMinMm}) must be `
        + `<= 0 and below TravelMaxMm (${this.TravelMaxMm}), which must be >= 0.`,
      );
      return;
    }
    if (!(this.Strands >= 1)) {
      console.warn(
        `[RibbonDancer] "${this.node.name}": Strands (${this.Strands}) must be at least 1 — using 1.`,
      );
    }
    this.reset();
  }

  // -- Tick -----------------------------------------------------

  /**
   * Apply the directional limit rule to a section speed pair, IN PLACE.
   *
   * `speeds[upIndex]` and `speeds[downIndex]` are the sections above and below
   * this dancer. See decision 2 in the file header for why this is `min` on one
   * side only rather than a symmetric stop.
   */
  clampSpeeds(speeds: number[], upIndex: number, downIndex: number): void {
    if (this._inert) return;
    if (upIndex < 0 || downIndex < 0 || upIndex >= speeds.length || downIndex >= speeds.length) return;
    const vUp = speeds[upIndex];
    const vDown = speeds[downIndex];
    if (this._atMax) speeds[upIndex] = Math.min(vUp, vDown);
    if (this._atMin) speeds[downIndex] = Math.min(vDown, vUp);
  }

  /** Integrate the section difference for `dt` seconds and move the carriage. */
  advance(vUpMmPerS: number, vDownMmPerS: number, dt: number): void {
    if (this._inert || !(dt > 0)) return;
    const next = accumulate(this.lAccMm, vUpMmPerS, vDownMmPerS, dt);
    const pos = positionFromAccumulated(this.HomeMm, next, this.Strands);
    const clamped = clampTravel(pos, this.HomeMm, this.TravelMinMm, this.TravelMaxMm, this.Strands);
    this.lAccMm = clamped.lAccMm;
    this.positionMm = clamped.posMm;
    this._atMin = clamped.atMin;
    this._atMax = clamped.atMax;
    this.applyPosition();
  }

  /**
   * Write `node.position` from {@link positionMm}, relative to the authored pose.
   *
   * `updateMatrix()` for the same reason as `RVRibbonRoller.applyAngle()`: a node
   * with `matrixAutoUpdate = false` never rebuilds its local matrix from the
   * position, so the carriage would travel in the numbers only.
   */
  applyPosition(): void {
    axisVector(this.travelAxis, _travel).multiplyScalar(this.positionMm / MM_TO_METERS);
    this.node.position.copy(this._authoredPosition).add(_travel);
    this.node.updateMatrix();
  }

  /**
   * Write the three feedback slots, but only on a real change: `PositionMm`
   * moves less than {@link SIGNAL_EPSILON_MM}, or a bool that did not flip, is
   * not written at all (F3).
   */
  writeSignals(write: (address: string, value: number | boolean) => void): void {
    if (this._inert) return;
    // `NaN` is the "never written" marker, and `Math.abs(x - NaN) > eps` is
    // FALSE — so the first write has to be its own case, or the PLC would never
    // see the initial position at all.
    const p = this.positionMm;
    if (typeof this.PositionMm === 'string' && changedBy(p, this._lastPositionMm)) {
      this._lastPositionMm = p;
      write(this.PositionMm, p);
    }
    if (typeof this.AtMin === 'string' && this._atMin !== this._lastAtMin) {
      this._lastAtMin = this._atMin;
      write(this.AtMin, this._atMin);
    }
    if (typeof this.AtMax === 'string' && this._atMax !== this._lastAtMax) {
      this._lastAtMax = this._atMax;
      write(this.AtMax, this._atMax);
    }
  }

  /** Restore the authored carriage position, the balance and the edge memory. */
  override reset(): void {
    super.reset();
    if (this._inert) return;
    this.lAccMm = 0;
    this.positionMm = this.HomeMm;
    const clamped = clampTravel(
      this.positionMm, this.HomeMm, this.TravelMinMm, this.TravelMaxMm, normaliseStrands(this.Strands),
    );
    this._atMin = clamped.atMin;
    this._atMax = clamped.atMax;
    this.applyPosition();
    this._lastPositionMm = Number.NaN;
    this._lastAtMin = null;
    this._lastAtMax = null;
  }

  override getLiveState(): Record<string, unknown> {
    return {
      RadiusMm: this.radiusMm,
      PositionMm: this.positionMm,
      AccumulatedMm: this.lAccMm,
      AtMin: this._atMin,
      AtMax: this._atMax,
      AngleDeg: (this.angle * 180) / Math.PI,
    };
  }

  override dispose(): void {
    this.node.position.copy(this._authoredPosition);
    this.node.updateMatrix();
    super.dispose();
  }
}

/** True when `roller` is a dancer (kept here so the path needs no cast). */
export function isRibbonDancer(value: unknown): value is RVRibbonDancer {
  return value instanceof RVRibbonDancer;
}

/** The dancer node type the schema exposes (documentation aid). */
export type RibbonDancerNode = Object3D;

registerComponent({
  type: 'RibbonDancer',
  schema: RVRibbonDancer.schema,
  capabilities: {
    hoverable: true,
    selectable: true,
    authorable: true,
    filterLabel: 'Web handling',
    badgeColor: '#26a69a',
  },
  create: (node) => new RVRibbonDancer(node),
  afterCreate: (inst, node) => {
    setComponentInstance(node, inst);
  },
});
