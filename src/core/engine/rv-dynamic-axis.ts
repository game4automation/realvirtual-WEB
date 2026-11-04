// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-dynamic-axis.ts — `RVDynamicAxis` (plan-673 Phase 2).
 *
 * Sits next to a `Drive` and declares that axis DYNAMIC: the setpoint becomes
 * the `ctrl` of a force-limited MuJoCo actuator, the solver moves the body, and
 * the resulting joint position comes back as the drive's actual position. A
 * kinematic axis has structurally no following error; a dynamic one has, and on
 * a real machine that error is the overload signal.
 *
 * `BaseFollowingError` exists because a MuJoCo position actuator is P+D WITHOUT
 * an integral term: a permanent gravity sag of `torque / Kp` remains even with
 * no contact at all. Measured on a 39 kg six-axis arm it is 14.9 mm at the stock
 * gain and 0.9 mm at the gain this component defaults to. An overload model
 * that does not subtract this declared share reports permanent overload.
 *
 * Phase 4 added the rest of the contract: the component resolves the `Drive` on
 * its own node, registers it as dynamic (`rv-axis-contract.ts`), publishes the
 * three quantities a kinematic axis cannot show as PLC input signals, and
 * carries the window the overload model watches (`FollowingErrorLimit` /
 * `FollowingErrorTimeMs`) plus the arrival tolerance a waiting LogicStep needs.
 *
 * It still does NOT trip. Leaving the window raises `Saturated` / `Overload`
 * and a Problems entry; the motion path keeps running (decision of 2026-10-24,
 * the conservative half of the open question in 2.4).
 */

import type { Object3D } from 'three';
import type { ComponentContext, ComponentSchema, RVComponent } from './rv-component-registry';
import { registerComponent, loadSchemaFromSpec } from './rv-component-registry';
import { NodeRegistry } from './rv-node-registry';
import type { RVDrive } from './rv-drive';
import { bindDynamicAxis, unbindDynamicAxis, arrivalToleranceOf } from './rv-axis-contract';
import { enclosingMuJoCoRegion } from './rv-mujoco-region';
import { addSignal, type SignalHandle } from './rv-signal-construction';
import type { SignalStore } from './rv-signal-store';

/** Extras key / Unity class name. */
export const DYNAMIC_AXIS_TYPE = 'DynamicAxis';

/** Who writes the setpoint — and therefore whether the axis is claimed. */
export type AxisSetpointSource = 'planner' | 'signal' | 'operator' | 'policy';
export const AXIS_SETPOINT_SOURCES: readonly AxisSetpointSource[] =
  Object.freeze(['planner', 'signal', 'operator', 'policy']);

/** MuJoCo actuator type of the axis. */
export type AxisActuatorKind = 'position' | 'velocity' | 'motor';
export const AXIS_ACTUATOR_KINDS: readonly AxisActuatorKind[] =
  Object.freeze(['position', 'velocity', 'motor']);

function finiteOr(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

export class RVDynamicAxis implements RVComponent {
  static readonly schema: ComponentSchema = loadSchemaFromSpec(DYNAMIC_AXIS_TYPE);

  /** All dynamic axes of the loaded scene, in registration order. */
  static readonly axes: RVDynamicAxis[] = [];

  /** Dispose every axis and empty the list (model switch, tests). */
  static clearAll(): void {
    for (const axis of [...RVDynamicAxis.axes]) axis.dispose();
    RVDynamicAxis.axes.length = 0;
  }

  readonly node: Object3D;
  isOwner = true;

  // ── Schema-populated ──
  SetpointSource: AxisSetpointSource = 'planner';
  ActuatorKind: AxisActuatorKind = 'position';
  Kp = 80000;
  Kv = 0;
  ForceRangeMin = 0;        //!< Nm
  ForceRangeMax = 0;        //!< Nm
  Gear = 1;
  Armature = 0.1;           //!< kgm2
  Damping = 0;
  FrictionLoss = 0;         //!< Nm
  /**
   * Declared structural share of the following error, IN THE DRIVE'S OWN UNIT
   * (mm for a linear axis, DEGREES for a rotary one — the `Drive.LowerLimit`
   * convention).
   *
   * The Phase-1 gate measured 1.07 deg of axis sag at the Menagerie stock gain
   * — which is the 14.9 mm of tool drop the schema cites — against 0.10 deg
   * (0.92 mm) at `Kp` 80000. The quantity it is subtracted from
   * (`drive.followingError`) lives in AXIS space, so declaring the millimetre
   * figure on a rotary axis would subtract 14.9 degrees and mask every real
   * overload. Phase 2's field description named only the tool projection; the
   * unit is pinned here and in the schema text since Phase 4.
   */
  BaseFollowingError = 0;   //!< mm (linear) / deg (rotary)
  FollowingErrorLimit = 0;  //!< mm / deg, 0 = monitoring off
  FollowingErrorTimeMs = 200;
  ArrivalTolerance = 0;     //!< mm / deg, 0 = derived

  // ── Resolved at init ──
  /** The `Drive` on this very node, or null — the conflict the audit reports. */
  drive: RVDrive | null = null;
  /** Registration path of this node (for Problems entries). */
  nodePath = '';
  /** `<node>.FollowingError` / `.IsTorque` / `.Saturated` / `.Overload`, or null. */
  signals: AxisFeedbackSignals | null = null;

  private _registered = false;

  constructor(node: Object3D) {
    this.node = node;
  }

  /** True when the actuator has a force limit at all (`0 … 0` = unlimited). */
  get hasForceLimit(): boolean {
    return this.ForceRangeMin !== 0 || this.ForceRangeMax !== 0;
  }

  /** The axis is driven by something that owns it exclusively. */
  get claimsAxis(): boolean {
    return this.SetpointSource === 'policy';
  }

  /** True when the overload window is armed at all. */
  get monitorsFollowingError(): boolean {
    return this.FollowingErrorLimit > 0;
  }

  init(ctx: ComponentContext): void {
    this.node.userData._rvType = DYNAMIC_AXIS_TYPE;
    this._normalize();
    const registry = registryOf(ctx);
    this.nodePath = registry?.getPathForNode(this.node) ?? NodeRegistry.computeNodePath(this.node);
    // Same node ONLY. `findInParent` would happily take a parent's Drive, which
    // would make one declaration silently govern a different axis — and the
    // audit could then never report the honest "no Drive on this node".
    this.drive = registry ? driveAt(registry, this.nodePath) : null;
    // Dynamic ONLY inside a detail-physics world. A `DynamicAxis` declares how
    // the axis behaves WHEN a `WebMuJoCoRegion` simulates it; the region is a
    // property of the scene the part is placed in, not of the part. Outside any
    // region nothing steps the actuator, so a bound axis would take setpoints and
    // never move — the library CRX, placed in a plain layout, sat frozen while its
    // IKPath ran (2026-10-25). Unbound, the axis is kinematic there and every
    // caller (IKPath, LogicStep, jog) moves it the way it always did.
    if (this.drive && enclosingMuJoCoRegion(this.node)) bindDynamicAxis(this.drive, this);
    this.signals = createAxisFeedbackSignals(this.node, ctx, this.nodePath);
    this._register();
  }

  /** Field edit on the live instance (inspector, `setField`, undo). */
  reapplyConfig(): void {
    this._normalize();
    // An edited window or tolerance must reach the drive immediately — the
    // inspector is the place where a stuck LogicStep gets fixed.
    if (this.drive) this.drive.arrivalTolerance = arrivalToleranceOf(this);
  }

  private _normalize(): void {
    if (!AXIS_SETPOINT_SOURCES.includes(this.SetpointSource)) this.SetpointSource = 'planner';
    if (!AXIS_ACTUATOR_KINDS.includes(this.ActuatorKind)) this.ActuatorKind = 'position';
    this.Kp = Math.max(0, finiteOr(this.Kp, 80000));
    this.Kv = Math.max(0, finiteOr(this.Kv, 0));
    this.ForceRangeMin = finiteOr(this.ForceRangeMin, 0);
    this.ForceRangeMax = finiteOr(this.ForceRangeMax, 0);
    this.Gear = finiteOr(this.Gear, 1) || 1;
    this.Armature = Math.max(0, finiteOr(this.Armature, 0.1));
    this.Damping = Math.max(0, finiteOr(this.Damping, 0));
    this.FrictionLoss = Math.max(0, finiteOr(this.FrictionLoss, 0));
    this.BaseFollowingError = Math.max(0, finiteOr(this.BaseFollowingError, 0));
    this.FollowingErrorLimit = Math.max(0, finiteOr(this.FollowingErrorLimit, 0));
    this.FollowingErrorTimeMs = Math.max(0, finiteOr(this.FollowingErrorTimeMs, 200));
    this.ArrivalTolerance = Math.max(0, finiteOr(this.ArrivalTolerance, 0));
    // An inverted range is a typo, not a limit — swapping it is visible in the
    // inspector, while passing it on produces an actuator that cannot move.
    if (this.hasForceLimit && this.ForceRangeMin > this.ForceRangeMax) {
      const lo = this.ForceRangeMax;
      this.ForceRangeMax = this.ForceRangeMin;
      this.ForceRangeMin = lo;
    }
  }

  private _register(): void {
    if (this._registered) return;
    this._registered = true;
    RVDynamicAxis.axes.push(this);
  }

  dispose(): void {
    if (this.drive) unbindDynamicAxis(this.drive, this);
    this.drive = null;
    this.signals = null;
    if (!this._registered) return;
    this._registered = false;
    const idx = RVDynamicAxis.axes.indexOf(this);
    if (idx !== -1) RVDynamicAxis.axes.splice(idx, 1);
  }
}

/** The four PLC INPUT signals a dynamic axis publishes. */
export interface AxisFeedbackSignals {
  /** Net following error (raw minus declared base share), mm / deg. */
  readonly followingError: SignalHandle;
  /** Actuator force / torque, N / Nm — `IsTorque` in Unity's naming. */
  readonly isTorque: SignalHandle;
  /** At the actuator force limit. */
  readonly saturated: SignalHandle;
  /** Net following error outside its window for longer than the declared time. */
  readonly overload: SignalHandle;
}

/**
 * The registry / signal store of a context, or null.
 *
 * Both are declared non-optional on `ComponentContext`, but a component is
 * also built from a MINIMAL context in tests and headless tooling
 * (`{} as ComponentContext` is the established shape there), and resolving
 * them must not throw. Narrowing through these two says so instead of hiding
 * it behind an optional chain on a non-optional type.
 */
function registryOf(ctx: ComponentContext): NodeRegistry | null {
  return (ctx as { registry?: NodeRegistry }).registry ?? null;
}

function signalStoreOf(ctx: ComponentContext): SignalStore | null {
  return (ctx as { signalStore?: SignalStore }).signalStore ?? null;
}

/**
 * The `Drive` registered at exactly `nodePath` — no ancestor walk.
 */
function driveAt(registry: NodeRegistry, nodePath: string): RVDrive | null {
  for (const [type, instance] of registry.getComponentsAt(nodePath)) {
    if (type === 'Drive') return instance as RVDrive;
  }
  return null;
}

/**
 * Create the four feedback signals of one axis.
 *
 * The leaf names are prefixed with the axis node's name (`A2.FollowingError`)
 * because `addSignal` puts all of a component root's signals in ONE `Signals`
 * folder: six axes of one robot would otherwise collide on four bare names.
 *
 * They are PLC **inputs** on purpose — the viewer writes them and a controller
 * reads them, which is exactly what a real drive does with its following error
 * (2.4, stage 2). Nothing here forces a binding: an unbound signal is still
 * visible in the signal list, forceable, recordable and readable over CONNECT
 * and MCP, which is the whole point of routing the quantity through a signal.
 */
function createAxisFeedbackSignals(
  node: Object3D,
  ctx: ComponentContext,
  nodePath: string,
): AxisFeedbackSignals | null {
  const registry = registryOf(ctx);
  const store = signalStoreOf(ctx);
  if (!store || !registry) return null;
  const base = node.name || 'Axis';
  const opts = { ownerPath: nodePath };
  const sig = (name: string, type: 'PLCInputFloat' | 'PLCInputBool'): SignalHandle =>
    addSignal(node, `${base}.${name}`, type, store, registry, opts);
  return {
    followingError: sig('FollowingError', 'PLCInputFloat'),
    isTorque: sig('IsTorque', 'PLCInputFloat'),
    saturated: sig('Saturated', 'PLCInputBool'),
    overload: sig('Overload', 'PLCInputBool'),
  };
}

registerComponent({
  type: DYNAMIC_AXIS_TYPE,
  displayName: 'DynamicAxis',
  schema: RVDynamicAxis.schema,
  capabilities: {
    pick: 'none',
    authorable: true,
    ui: { badge: '#7e57c2', category: 'physics', filter: 'Dynamic Axes' },
  },
  create: (node) => new RVDynamicAxis(node),
});
