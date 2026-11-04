// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-locomotion-policy-component.ts — `RVLocomotionPolicyComponent`
 * (plan-673 Phase 2b).
 *
 * A trained locomotion policy on the root node of a legged robot: the
 * counterpart of `RobotIK` one level deeper in the physics. `RobotIK` computes a
 * pose from geometry; a policy computes joint setpoints from a state. The point
 * of making it a component is that the robot then needs no script of its own.
 *
 * ## `RateHz` is not a field
 *
 * The rate is `1 / (region.TimestepS * Decimation)`, and the timestep must match
 * the one the policy was trained with. A `RateHz` field would be a third number
 * the author can set against the other two. It is therefore DERIVED and
 * displayed — {@link RVLocomotionPolicyComponent.rateHz}, shown next to
 * `Decimation` in the inspector — never entered.
 *
 * ## `Observation` is a profile name, the layout is data
 *
 * The ordered segment list lives in the contract document, not in code and not
 * in an enum: six known segment names combine into as many conventions as
 * needed, and a new robot with known segments costs no code at all. The
 * component carries the EXPECTED profile name, which is checked against the
 * contract's `observation_layout` on load; a contradiction is a problems entry
 * (`policy-observation-mismatch`), never a silent run with the wrong numbers.
 *
 * ## `Axes` is a reference list, and its ORDER is the contract
 *
 * `Axes[i]` is the drive of the i-th policy actuator, which is why it replaces
 * `rv_joint.actuator_index` on every joint node: the assignment stands ONCE at
 * the policy instead of fourteen times in the model. It is
 * `ComponentReference[]`, not a list of names, and the house has the
 * counter-evidence for the name form: `RobotIK.Axis` filters non-reference
 * entries out SILENTLY, and one axis short means the solver models the wrong
 * chain. A reference claims its target node in the bake, survives renaming,
 * placing and nesting, and shows up in the reference audit — a name string does
 * none of that.
 *
 * The inference, the observation assembly and the actuator write live in the
 * private physics plugin; this component carries the authored declaration and is
 * the one place that states the axis order.
 */

import type { Object3D } from 'three';
import type { ComponentContext, ComponentSchema, RVComponent } from './rv-component-registry';
import { registerComponent, loadSchemaFromSpec } from './rv-component-registry';
import { enclosingMuJoCoRegion } from './rv-mujoco-region';
import { isComponentReference } from './rv-node-path-rewrite.mjs';
import { reportProblem } from '../hmi/problems-store';

/** Extras key / Unity class name. */
export const LOCOMOTION_POLICY_TYPE = 'LocomotionPolicy';

/** Problems code for an `Axes` entry that is not a reference (the `RobotIK.Axis` counter-test). */
export const POLICY_AXIS_NOT_A_REFERENCE = 'policy-axis-not-a-reference';

function finiteOr(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

export class RVLocomotionPolicyComponent implements RVComponent {
  static readonly schema: ComponentSchema = loadSchemaFromSpec(LOCOMOTION_POLICY_TYPE);

  /** All policies of the loaded scene, in registration order. */
  static readonly policies: RVLocomotionPolicyComponent[] = [];

  static clearAll(): void {
    for (const p of [...RVLocomotionPolicyComponent.policies]) p.dispose();
    RVLocomotionPolicyComponent.policies.length = 0;
  }

  readonly node: Object3D;
  isOwner = true;

  // ── Schema-populated ──
  Enabled = true;
  Policy = '';
  FallbackPolicy = '';
  Observation = '';
  Contract = '';
  Decimation = 4;
  ActionScale = 1;
  /** Resolved drives in policy order; unresolved entries stay as the raw reference. */
  Axes: unknown[] = [];

  /** Raw `Axes` as written, kept so the axis ORDER survives a failed resolve. */
  private _rawAxes: unknown[] = [];
  private _registered = false;

  constructor(node: Object3D) {
    this.node = node;
  }

  /** Number of declared axes — compared against the contract's actuator count on load. */
  get axisCount(): number {
    return this._rawAxes.length;
  }

  /**
   * Policy rate in Hz, derived from the enclosing region's timestep and
   * `Decimation`. `null` when the node is not inside a `WebMuJoCoRegion`, because
   * without a timestep there is no rate to state.
   */
  get rateHz(): number | null {
    const region = enclosingMuJoCoRegion(this.node);
    return region ? region.policyRateHz(this.Decimation) : null;
  }

  /** Read the raw `Axes` list from rv_extras (also after a field edit). */
  readAxes(extras?: Record<string, unknown>): void {
    const raw = extras ?? (this.node.userData?.realvirtual as
      Record<string, Record<string, unknown>> | undefined)?.[LOCOMOTION_POLICY_TYPE];
    const list = raw?.['Axes'];
    this._rawAxes = Array.isArray(list) ? [...list] : [];
  }

  init(_ctx: ComponentContext): void {
    this.node.userData._rvType = LOCOMOTION_POLICY_TYPE;
    this._normalize();
    this._reportNonReferenceAxes();
    if (!this._registered) {
      this._registered = true;
      RVLocomotionPolicyComponent.policies.push(this);
    }
  }

  reapplyConfig(): void {
    this.readAxes();
    this._normalize();
    this._reportNonReferenceAxes();
  }

  private _normalize(): void {
    this.Enabled = this.Enabled !== false;
    this.Decimation = Math.max(1, Math.round(finiteOr(this.Decimation, 4)));
    this.ActionScale = finiteOr(this.ActionScale, 1);
    if (!Array.isArray(this.Axes)) this.Axes = [];
    if (this._rawAxes.length === 0 && Array.isArray(this.Axes)) this._rawAxes = [...this.Axes];
  }

  /**
   * A bare string in `Axes` is REPORTED, not dropped. This is the explicit
   * counter-test to today's `RobotIK.Axis` behaviour, where a `.filter(isRef)`
   * removes such an entry without a word and the chain is silently one axis
   * short.
   */
  private _reportNonReferenceAxes(): void {
    const bad: number[] = [];
    this._rawAxes.forEach((entry, i) => {
      if (!isComponentReference(entry)) bad.push(i);
    });
    if (bad.length === 0) return;
    const path = this.node.name || LOCOMOTION_POLICY_TYPE;
    reportProblem({
      id: `${POLICY_AXIS_NOT_A_REFERENCE}:${path}`,
      severity: 'error',
      code: POLICY_AXIS_NOT_A_REFERENCE,
      title: `LocomotionPolicy "${path}": ${bad.length} of ${this._rawAxes.length} Axes entries are not references`,
      detail: `Axes[${bad.join(', ')}] is a plain value instead of a ComponentReference. `
        + 'The order of Axes is the policy actuator order, so a dropped entry shifts every axis after it. '
        + 'Re-add the drive through the Axes list in the inspector so it is stored as a reference.',
      nodePath: path,
    });
  }

  dispose(): void {
    if (!this._registered) return;
    this._registered = false;
    const idx = RVLocomotionPolicyComponent.policies.indexOf(this);
    if (idx !== -1) RVLocomotionPolicyComponent.policies.splice(idx, 1);
  }
}

registerComponent({
  type: LOCOMOTION_POLICY_TYPE,
  displayName: 'LocomotionPolicy',
  schema: RVLocomotionPolicyComponent.schema,
  capabilities: {
    pick: 'none',
    authorable: true,
    ui: { badge: '#7e57c2', category: 'physics', filter: 'Locomotion Policies' },
  },
  create: (node) => new RVLocomotionPolicyComponent(node),
  beforeSchema: (inst, extras) => {
    (inst as RVLocomotionPolicyComponent).readAxes(extras);
  },
});
