// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-grip-load.ts — `RVGripLoad` (plan-673 Phase 4, F7).
 *
 * ── Why this component exists, and why it is not optional ─────────────────
 * The plan expected the jam to show up at the ROBOT: following error first,
 * torque second, grip force "as a second place". The Phase-1 gate measured the
 * opposite. In two of three failure cases the axis following error was
 * 0.07–0.08 deg — IDENTICAL to the successful run — while the part slid 17–20 mm
 * between the jaws:
 *
 * | case           | axis refusal | part slip in the jaws | note              |
 * |----------------|--------------|-----------------------|-------------------|
 * | wrong rotation | −1.0 mm      | 20.0 mm               |                   |
 * | wrong shape    | −1.5 mm      | 20.3 mm               |                   |
 * | skew push      |  2.2 mm      | 16.7 mm               | A5 saturated 71 % |
 *
 * An overload model that knows only following error and torque therefore shows
 * NOTHING in two of three failure cases. The reason is mechanical, not
 * numerical: the gripper transmits at most `2 · F · mu` along the joining axis
 * (50 N for the catalogue gripper), while the arm pushes with over 100 N at the
 * tool — so the part slips before the axis is refused. That is why the slip is a
 * first-class measured quantity here and not a derived curiosity.
 *
 * ── The two grip modes (F7) ───────────────────────────────────────────────
 * `Grip` structurally refuses a physics-owned MU (`isPhysicsOwned` gates it at
 * four places), so the two modes cannot be mixed:
 *
 * - `formfit` — the Grip parents the part as it always has. The part CANNOT
 *   slip: its pose in the jaw frame is constant by construction. This component
 *   says so ({@link slipMeasurable} is false) instead of displaying a reassuring
 *   zero.
 * - `forcefit` — the physics contact holds the part, the Grip only reports, and
 *   the slip is the real measurement. The part is handed in by the physics
 *   runtime through {@link holdPart}; the Phase-5 MuJoCo plugin is the caller.
 *
 * ── The measurement ───────────────────────────────────────────────────────
 * Slip is the distance the held part has travelled IN THE JAW FRAME since it
 * was first seen held — not in world space, because the jaws move. The
 * reference pose is latched on the first tick the part is held and dropped when
 * it is released, so a slip reading is always "since this grasp".
 */

import { Object3D, Vector3 } from 'three';
import type { ComponentContext, ComponentSchema, RVComponent } from './rv-component-registry';
import { registerComponent, loadSchemaFromSpec } from './rv-component-registry';
import { NodeRegistry } from './rv-node-registry';
import { MM_TO_METERS } from './rv-constants';
import { addSignal, type SignalHandle } from './rv-signal-construction';
import type { SignalStore } from './rv-signal-store';

/** Extras key / Unity class name. */
export const GRIP_LOAD_TYPE = 'GripLoad';

/** How the gripper holds the part. */
export type GripHoldMode = 'formfit' | 'forcefit';
export const GRIP_HOLD_MODES: readonly GripHoldMode[] = Object.freeze(['formfit', 'forcefit']);

/** The three PLC INPUT signals a grip load publishes. */
export interface GripLoadSignals {
  /** Travel of the part inside the jaws since the grasp, mm. */
  readonly partSlip: SignalHandle;
  /** Clamping force actually applied, N (declared, or measured by the runtime). */
  readonly gripForce: SignalHandle;
  /** Slip above its limit for longer than the declared time. */
  readonly slipping: SignalHandle;
}

/** What the grip minimally has to look like — keeps this file off `rv-grip.ts`. */
interface GripLike {
  readonly grippedMUs: ReadonlyArray<{ node?: Object3D } | Object3D>;
}

function finiteOr(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

/** The scene node of an MU entry (an `RVMovingUnit` carries its node). */
function nodeOf(mu: { node?: Object3D } | Object3D): Object3D | null {
  if (mu instanceof Object3D) return mu;
  return mu.node ?? null;
}

const _scratch = new Vector3();

export class RVGripLoad implements RVComponent {
  static readonly schema: ComponentSchema = loadSchemaFromSpec(GRIP_LOAD_TYPE);

  /** All grip loads of the loaded scene, in registration order. */
  static readonly loads: RVGripLoad[] = [];

  /** Dispose every grip load and empty the list (model switch, tests). */
  static clearAll(): void {
    for (const load of [...RVGripLoad.loads]) load.dispose();
    RVGripLoad.loads.length = 0;
  }

  readonly node: Object3D;
  isOwner = true;

  // ── Schema-populated ──
  Mode: GripHoldMode = 'formfit';
  GripForce = 0;      //!< N per jaw, 0 = not declared
  SlipLimit = 0;      //!< mm, 0 = monitoring off
  SlipTimeMs = 200;

  // ── Resolved at init ──
  /** Registration path of this node (for Problems entries). */
  nodePath = '';
  /** The `Grip` on this very node, or null. */
  grip: GripLike | null = null;
  signals: GripLoadSignals | null = null;

  /** Measured clamping force, written by the physics runtime; NaN = none. */
  measuredForce = Number.NaN;

  private _registered = false;
  /** The part the physics runtime says is held (`forcefit`), or null. */
  private _heldPart: Object3D | null = null;
  /** Pose of the held part in the jaw frame at the grasp; null = not latched. */
  private readonly _reference = new Vector3();
  private _referenceLatched = false;
  private _slipMm = 0;

  constructor(node: Object3D) {
    this.node = node;
  }

  /** True when a slip reading means anything at all — see the header. */
  get slipMeasurable(): boolean {
    return this.Mode === 'forcefit';
  }

  /** True when the slip window is armed. */
  get monitorsSlip(): boolean {
    return this.slipMeasurable && this.SlipLimit > 0;
  }

  /** Travel of the part inside the jaws since the grasp, in mm. */
  get slipMm(): number {
    return this._slipMm;
  }

  /**
   * The clamping force to display: the measurement when the runtime supplies
   * one, otherwise the declared value, otherwise 0.
   *
   * Phase 0 measured that the PAD FRICTION decides the holding capacity by a
   * factor of 7 and the clamping force does not — so this number never explains
   * a dropped part on its own. It is here because it is half of the product that
   * does.
   */
  get forceN(): number {
    return Number.isFinite(this.measuredForce) ? this.measuredForce : this.GripForce;
  }

  /** The node currently held, whichever mode produced it. */
  get heldPart(): Object3D | null {
    if (this._heldPart) return this._heldPart;
    const first = this.grip?.grippedMUs[0];
    return first ? nodeOf(first) : null;
  }

  /**
   * The physics runtime declares which part the contact is holding
   * (`forcefit`), or `null` when the contact let go.
   *
   * Needed because a `forcefit` part is physics-owned and therefore never
   * enters `Grip.grippedMUs` — that gate is what makes the two modes mutually
   * exclusive in the first place. The Phase-5 MuJoCo plugin is the caller.
   */
  holdPart(part: Object3D | null): void {
    if (part === this._heldPart) return;
    this._heldPart = part;
    this._referenceLatched = false;
    this._slipMm = 0;
  }

  init(ctx: ComponentContext): void {
    this.node.userData._rvType = GRIP_LOAD_TYPE;
    this._normalize();
    const registry = registryOf(ctx);
    this.nodePath = registry?.getPathForNode(this.node) ?? NodeRegistry.computeNodePath(this.node);
    this.grip = registry ? gripAt(registry, this.nodePath) : null;
    this.signals = createGripLoadSignals(this.node, ctx, this.nodePath);
    this._register();
  }

  /** Field edit on the live instance (inspector, `setField`, undo). */
  reapplyConfig(): void {
    const wasMeasurable = this.slipMeasurable;
    this._normalize();
    // Switching the mode invalidates the reference: a formfit grasp never had
    // one, and carrying a stale latch into forcefit would report the jaw travel
    // since the mode change as part slip.
    if (wasMeasurable !== this.slipMeasurable) {
      this._referenceLatched = false;
      this._slipMm = 0;
    }
  }

  /**
   * Measure the slip of this tick. Returns the slip in mm, 0 when nothing is
   * held or the mode makes the reading meaningless.
   *
   * Called by the axis-diagnostics pass after the drive loop, so the jaws are
   * already at this tick's pose.
   */
  measure(): number {
    const part = this.heldPart;
    if (!part || !this.slipMeasurable) {
      this._referenceLatched = false;
      this._slipMm = 0;
      return 0;
    }
    // The part's position in the JAW frame — the jaws move, world space does not
    // answer the question "did it slide in the gripper".
    this.node.updateWorldMatrix(true, false);
    part.updateWorldMatrix(true, false);
    _scratch.setFromMatrixPosition(part.matrixWorld);
    this.node.worldToLocal(_scratch);
    if (!this._referenceLatched) {
      this._reference.copy(_scratch);
      this._referenceLatched = true;
      this._slipMm = 0;
      return 0;
    }
    this._slipMm = _scratch.distanceTo(this._reference) * MM_TO_METERS;
    return this._slipMm;
  }

  /** Forget the grasp (sim reset) — a new run starts without a reference. */
  reset(): void {
    this._referenceLatched = false;
    this._slipMm = 0;
    this.measuredForce = Number.NaN;
  }

  private _normalize(): void {
    if (!GRIP_HOLD_MODES.includes(this.Mode)) this.Mode = 'formfit';
    this.GripForce = Math.max(0, finiteOr(this.GripForce, 0));
    this.SlipLimit = Math.max(0, finiteOr(this.SlipLimit, 0));
    this.SlipTimeMs = Math.max(0, finiteOr(this.SlipTimeMs, 200));
  }

  private _register(): void {
    if (this._registered) return;
    this._registered = true;
    RVGripLoad.loads.push(this);
  }

  dispose(): void {
    this.grip = null;
    this.signals = null;
    this._heldPart = null;
    this._referenceLatched = false;
    if (!this._registered) return;
    this._registered = false;
    const idx = RVGripLoad.loads.indexOf(this);
    if (idx !== -1) RVGripLoad.loads.splice(idx, 1);
  }
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

/** The `Grip` registered at exactly `nodePath` — no ancestor walk. */
function gripAt(registry: NodeRegistry, nodePath: string): GripLike | null {
  for (const [type, instance] of registry.getComponentsAt(nodePath)) {
    if (type === 'Grip') return instance as GripLike;
  }
  return null;
}

/** The three feedback signals of one grip load (see `rv-dynamic-axis.ts`). */
function createGripLoadSignals(
  node: Object3D,
  ctx: ComponentContext,
  nodePath: string,
): GripLoadSignals | null {
  const registry = registryOf(ctx);
  const store = signalStoreOf(ctx);
  if (!store || !registry) return null;
  const base = node.name || 'Grip';
  const opts = { ownerPath: nodePath };
  return {
    partSlip: addSignal(node, `${base}.PartSlip`, 'PLCInputFloat', store, registry, opts),
    gripForce: addSignal(node, `${base}.GripForce`, 'PLCInputFloat', store, registry, opts),
    slipping: addSignal(node, `${base}.PartSlipping`, 'PLCInputBool', store, registry, opts),
  };
}

registerComponent({
  type: GRIP_LOAD_TYPE,
  displayName: 'GripLoad',
  schema: RVGripLoad.schema,
  capabilities: {
    pick: 'none',
    authorable: true,
    ui: { badge: '#7e57c2', category: 'physics', filter: 'Grip Loads' },
  },
  create: (node) => new RVGripLoad(node),
});
