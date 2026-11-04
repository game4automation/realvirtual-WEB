// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-free-body.ts — `RVFreeBody` and `RVMovable` (plan-673 Phase 2).
 *
 * The two components an OBSTACLE needs, and together they replace a misuse.
 *
 * In the plan-659 demo every obstacle carried a `Drive` with `Direction:
 * 'Virtual'`. That was not decoration: the destructive bake only builds nodes
 * something CLAIMS, and `'Virtual'` was the one claim available that writes no
 * transform. It was still the wrong component in the wrong place — an obstacle
 * is not a drive, and whoever reads the demo learns a pattern they should not
 * copy. A component claims its node by default (`claimsNode`), so `FreeBody`
 * and `Movable` are the honest claim, and the drive disappears from the demo.
 *
 * `FreeBody` says the PHYSICS moves the node; `Movable` says the USER may. Both
 * may sit on the same node, and both carry their quantities as properties with a
 * unit and a default. The quantities deliberately do NOT live in a central
 * `obstacles[]` list inside a generator: a list entry is neither clickable in
 * the viewer, nor addressable over MCP, nor movable by hand, and a second home
 * for masses and friction values is the inconsistency source this plan avoids
 * in four other places.
 *
 * `CondDim` defaults to `SlidingTorsional` (4), NOT to MuJoCo's own default of 3.
 * Measured in the plan-673 Phase-1 gate: with `condim 3` there is no spin
 * friction at all, a gripped part rotated out of the jaws within five seconds and
 * was caught again on two other arms — a successful run turned SILENTLY into a
 * jam. The same failure shape as the plan-659 ball that travelled 8.46 m instead
 * of 0.38 m.
 *
 * The free body itself is built by the private physics plugin (Phase 3+); this
 * component carries the authored declaration.
 */

import type { Object3D } from 'three';
import type { ComponentContext, ComponentSchema, RVComponent } from './rv-component-registry';
import { registerComponent, loadSchemaFromSpec } from './rv-component-registry';
import { COND_DIM_NAMES, condimOf, type CondDimName } from './rv-contact-geometry';

/** Extras key / Unity class name. */
export const FREE_BODY_TYPE = 'FreeBody';
/** Extras key / Unity class name. */
export const MOVABLE_TYPE = 'Movable';

/** Directions the user may drag a `Movable` along. */
export type MovableAxes = 'XZ' | 'XYZ' | 'X' | 'Y' | 'Z';
export const MOVABLE_AXES: readonly MovableAxes[] = Object.freeze(['XZ', 'XYZ', 'X', 'Y', 'Z']);

function finiteOr(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export class RVFreeBody implements RVComponent {
  static readonly schema: ComponentSchema = loadSchemaFromSpec(FREE_BODY_TYPE);

  /** All free bodies of the loaded scene, in registration order. */
  static readonly bodies: RVFreeBody[] = [];

  static clearAll(): void {
    for (const b of [...RVFreeBody.bodies]) b.dispose();
    RVFreeBody.bodies.length = 0;
  }

  readonly node: Object3D;
  isOwner = true;

  // ── Schema-populated ──
  Enabled = true;
  MassKg = 0;               //!< kg; 0 = derive from MechanismBody
  CondDim: CondDimName = 'SlidingTorsional';
  FrictionSlide = 1;
  LinearDamping = 0;        //!< 1/s
  AngularDamping = 0;       //!< 1/s
  Restitution = 0;

  private _registered = false;

  constructor(node: Object3D) {
    this.node = node;
  }

  /** MuJoCo `condim` of {@link CondDim} — the number the MJCF writer needs. */
  get condim(): 1 | 3 | 4 | 6 {
    return condimOf(this.CondDim);
  }

  /** True when the mass has to be derived from the node's `MechanismBody`. */
  get massIsDerived(): boolean {
    return this.MassKg <= 0;
  }

  init(_ctx: ComponentContext): void {
    this.node.userData._rvType = FREE_BODY_TYPE;
    this._normalize();
    if (!this._registered) {
      this._registered = true;
      RVFreeBody.bodies.push(this);
    }
  }

  reapplyConfig(): void {
    this._normalize();
  }

  private _normalize(): void {
    this.Enabled = this.Enabled !== false;
    this.MassKg = Math.max(0, finiteOr(this.MassKg, 0));
    if (!COND_DIM_NAMES.includes(this.CondDim)) this.CondDim = 'SlidingTorsional';
    this.FrictionSlide = Math.max(0, finiteOr(this.FrictionSlide, 1));
    this.LinearDamping = Math.max(0, finiteOr(this.LinearDamping, 0));
    this.AngularDamping = Math.max(0, finiteOr(this.AngularDamping, 0));
    this.Restitution = clamp(finiteOr(this.Restitution, 0), 0, 1);
  }

  dispose(): void {
    if (!this._registered) return;
    this._registered = false;
    const idx = RVFreeBody.bodies.indexOf(this);
    if (idx !== -1) RVFreeBody.bodies.splice(idx, 1);
  }
}

export class RVMovable implements RVComponent {
  static readonly schema: ComponentSchema = loadSchemaFromSpec(MOVABLE_TYPE);

  /** All movable nodes of the loaded scene, in registration order. */
  static readonly movables: RVMovable[] = [];

  static clearAll(): void {
    for (const m of [...RVMovable.movables]) m.dispose();
    RVMovable.movables.length = 0;
  }

  readonly node: Object3D;
  isOwner = true;

  // ── Schema-populated ──
  Enabled = true;
  Axes: MovableAxes = 'XZ';
  SnapMm = 0;               //!< mm; 0 = free
  ResetOnStop = false;

  /** Authored local position, captured on init so `ResetOnStop` has something to return to. */
  private readonly _home = { x: 0, y: 0, z: 0 };
  private _registered = false;

  constructor(node: Object3D) {
    this.node = node;
  }

  /** Which of x / y / z the drag may change. */
  get allowedAxes(): { x: boolean; y: boolean; z: boolean } {
    switch (this.Axes) {
      case 'XYZ': return { x: true, y: true, z: true };
      case 'X': return { x: true, y: false, z: false };
      case 'Y': return { x: false, y: true, z: false };
      case 'Z': return { x: false, y: false, z: true };
      case 'XZ':
      default: return { x: true, y: false, z: true };
    }
  }

  /** The authored local position the node returns to with `ResetOnStop`. */
  get homePosition(): Readonly<{ x: number; y: number; z: number }> {
    return this._home;
  }

  /**
   * Snap one local coordinate to `SnapMm`. The grid is in millimetres and the
   * scene is in metres, which is the one place that conversion belongs.
   */
  snap(valueM: number): number {
    if (this.SnapMm <= 0) return valueM;
    const gridM = this.SnapMm / 1000;
    return Math.round(valueM / gridM) * gridM;
  }

  /** Return the node to its authored position (simulation stop with `ResetOnStop`). */
  resetToHome(): void {
    if (!this.ResetOnStop) return;
    this.node.position.set(this._home.x, this._home.y, this._home.z);
  }

  init(_ctx: ComponentContext): void {
    this.node.userData._rvType = MOVABLE_TYPE;
    this._normalize();
    this._home.x = this.node.position.x;
    this._home.y = this.node.position.y;
    this._home.z = this.node.position.z;
    if (!this._registered) {
      this._registered = true;
      RVMovable.movables.push(this);
    }
  }

  reapplyConfig(): void {
    this._normalize();
  }

  private _normalize(): void {
    this.Enabled = this.Enabled !== false;
    if (!MOVABLE_AXES.includes(this.Axes)) this.Axes = 'XZ';
    this.SnapMm = Math.max(0, finiteOr(this.SnapMm, 0));
    this.ResetOnStop = this.ResetOnStop === true;
  }

  dispose(): void {
    if (!this._registered) return;
    this._registered = false;
    const idx = RVMovable.movables.indexOf(this);
    if (idx !== -1) RVMovable.movables.splice(idx, 1);
  }
}

registerComponent({
  type: FREE_BODY_TYPE,
  displayName: 'FreeBody',
  schema: RVFreeBody.schema,
  capabilities: {
    // A free body is a thing in the scene the user points at, and it must stay a
    // chunk boundary: the physics moves it as a unit, so its mesh cannot merge
    // into a neighbour's chunk.
    pick: 'select',
    bake: 'chunk',
    authorable: true,
    ui: { badge: '#ef5350', category: 'physics', filter: 'Free Bodies' },
  },
  create: (node) => new RVFreeBody(node),
});

registerComponent({
  type: MOVABLE_TYPE,
  displayName: 'Movable',
  schema: RVMovable.schema,
  capabilities: {
    // Same reason as FreeBody: the user grabs it and it moves on its own, so it
    // owns its chunk instead of merging into an ancestor's.
    pick: 'select',
    bake: 'chunk',
    authorable: true,
    ui: { badge: '#ffca28', category: 'physics', filter: 'Movable' },
  },
  create: (node) => new RVMovable(node),
});
