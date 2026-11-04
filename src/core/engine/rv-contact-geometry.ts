// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-contact-geometry.ts — `RVContactProfile` and `RVCollisionShapeSet`
 * (plan-673 Phase 2). The two components that describe the CONTACT side of a
 * node: what its surface behaves like, and what shape actually collides.
 *
 * ## Why `ContactProfile` carries `Priority` and `Solmix`
 *
 * MuJoCo maximises `friction` ELEMENT-WISE between two geoms and averages
 * `solref`/`solimp` weighted by `solmix`. A pairing table built from per-geom
 * profiles is therefore not representable: the rougher side always wins, and one
 * grippy gripper pad pulls every other pairing up with it. "Jaw and part grippy,
 * board and floor smooth" cannot be said that way.
 *
 * Two forms work. `Priority` on the side that sets the tone — exactly what the
 * Robotiq 2F-85 does on its pads — is the normal case and the reason `Priority`
 * is a visible property rather than a writer detail. Explicit `<contact><pair>`
 * elements are the literal pairing table, but they are not derivable from
 * per-node components at all; the writer has to produce them from a catalogue,
 * and they are reserved for named special pairings.
 *
 * ## Why `CollisionShapeSet` exists
 *
 * MuJoCo convexifies every collision mesh. Any concave shape whose behaviour
 * relies on its concavity is silently ineffective — and the rule holds for the
 * part AND its counterpart: a part with a hole and the board it should pass
 * through are both concave. There is no automatic convex decomposition in this
 * codebase and none planned, so the decomposition is AUTHORED content. The probe
 * is the minimum width of the convex hull against the narrowest point of the
 * opening; for the three-armed star of the plan-673 first case it is 83.7 mm
 * against a 21 mm slot, so the negative case cannot slip through by accident.
 *
 * `Shapes[].Size` is read TYPE-DEPENDENTLY and as HALF extents (what MuJoCo
 * wants), unlike the existing `colliders[]` extras, which are Unity FULL sizes
 * in METRES. Three conventions in one model is exactly the trap the writer needs
 * a stated rule for, so the rule is stated here and in the schema.
 */

import type { Object3D } from 'three';
import type { ComponentContext, ComponentSchema, RVComponent } from './rv-component-registry';
import { registerComponent, loadSchemaFromSpec } from './rv-component-registry';

/** Extras key / Unity class name. */
export const CONTACT_PROFILE_TYPE = 'ContactProfile';
/** Extras key / Unity class name. */
export const COLLISION_SHAPE_SET_TYPE = 'CollisionShapeSet';

/** Named contact role; every role but `Custom` takes its numbers from the profile library. */
export type ContactProfileRole =
  | 'Pallet' | 'Workpiece' | 'BeltSurface' | 'StopperFace'
  | 'GripperJaw' | 'MachineFrame' | 'FixtureBore' | 'Custom';
export const CONTACT_PROFILE_ROLES: readonly ContactProfileRole[] = Object.freeze([
  'Pallet', 'Workpiece', 'BeltSurface', 'StopperFace',
  'GripperJaw', 'MachineFrame', 'FixtureBore', 'Custom',
]);

/**
 * Contact dimensionality as the author NAMES it. The stored value is the name,
 * not the MuJoCo number: a schema `enumMap` that resolved the name to 1/3/4/6
 * would make the stamped default a number, which the inspector then offers as a
 * fifth dropdown entry and the save writes back as a value the schema's own
 * `enum` rejects. The number is derived through {@link condimOf} instead, in
 * one place, for the writer.
 */
export type CondDimName = 'Frictionless' | 'Sliding' | 'SlidingTorsional' | 'Full';
export const COND_DIM_NAMES: readonly CondDimName[] =
  Object.freeze(['Frictionless', 'Sliding', 'SlidingTorsional', 'Full']);

/** MuJoCo `condim` of each name. */
export const COND_DIM_VALUES: Readonly<Record<CondDimName, 1 | 3 | 4 | 6>> = Object.freeze({
  Frictionless: 1,
  Sliding: 3,
  SlidingTorsional: 4,
  Full: 6,
});

/**
 * The MuJoCo `condim` of a stored value. An unknown name falls back to
 * `SlidingTorsional` (4) and NEVER to MuJoCo's own default of 3: without spin
 * friction a gripped part rotates out of the jaws within seconds and nothing is
 * reported, so 3 must always be an explicit choice.
 */
export function condimOf(name: unknown): 1 | 3 | 4 | 6 {
  return COND_DIM_NAMES.includes(name as CondDimName)
    ? COND_DIM_VALUES[name as CondDimName]
    : COND_DIM_VALUES.SlidingTorsional;
}

/** Convex primitive kinds a shape set may contain. */
export type CollisionShapeKind = 'box' | 'sphere' | 'capsule' | 'cylinder' | 'ellipsoid';
export const COLLISION_SHAPE_KINDS: readonly CollisionShapeKind[] =
  Object.freeze(['box', 'sphere', 'capsule', 'cylinder', 'ellipsoid']);

/**
 * How many components of `Size` MuJoCo reads for each kind — the reason `Size`
 * cannot be treated as a plain Vector3 full size.
 */
export const COLLISION_SHAPE_SIZE_COMPONENTS: Readonly<Record<CollisionShapeKind, 1 | 2 | 3>> =
  Object.freeze({ box: 3, sphere: 1, capsule: 2, cylinder: 2, ellipsoid: 3 });

export interface Vec3Like { x: number; y: number; z: number }

/** One authored convex primitive, in the node's local frame, millimetres and degrees. */
export interface CollisionShape {
  Kind: CollisionShapeKind;
  Center: Vec3Like;
  Size: Vec3Like;
  Rotation: Vec3Like;
}

function finiteOr(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

function vec3Of(v: unknown): Vec3Like {
  const o = (v ?? {}) as Partial<Vec3Like>;
  return { x: finiteOr(o.x, 0), y: finiteOr(o.y, 0), z: finiteOr(o.z, 0) };
}

/** Normalise one raw `Shapes` entry; an unknown kind becomes a box rather than nothing. */
export function normalizeCollisionShape(raw: unknown): CollisionShape {
  const o = (raw ?? {}) as Partial<CollisionShape>;
  const kind = COLLISION_SHAPE_KINDS.includes(o.Kind as CollisionShapeKind)
    ? (o.Kind as CollisionShapeKind) : 'box';
  return { Kind: kind, Center: vec3Of(o.Center), Size: vec3Of(o.Size), Rotation: vec3Of(o.Rotation) };
}

/**
 * The `Size` components MuJoCo reads for `shape`, in millimetres and as HALF
 * extents — one, two or three numbers, never a full Vector3. A non-positive
 * value is a degenerate primitive, which the writer must refuse rather than
 * silently grow.
 */
export function collisionShapeSizeArray(shape: CollisionShape): number[] {
  const n = COLLISION_SHAPE_SIZE_COMPONENTS[shape.Kind];
  const all = [shape.Size.x, shape.Size.y, shape.Size.z];
  return all.slice(0, n);
}

/** True when every `Size` component MuJoCo reads for this shape is positive. */
export function isCollisionShapeValid(shape: CollisionShape): boolean {
  return collisionShapeSizeArray(shape).every((v) => Number.isFinite(v) && v > 0);
}

export class RVContactProfile implements RVComponent {
  static readonly schema: ComponentSchema = loadSchemaFromSpec(CONTACT_PROFILE_TYPE);

  /** All contact profiles of the loaded scene, in registration order. */
  static readonly profiles: RVContactProfile[] = [];

  static clearAll(): void {
    for (const p of [...RVContactProfile.profiles]) p.dispose();
    RVContactProfile.profiles.length = 0;
  }

  readonly node: Object3D;
  isOwner = true;

  // ── Schema-populated ──
  Profile: ContactProfileRole = 'Workpiece';
  Priority = 0;
  Solmix = 1;
  FrictionSlide = 1;
  FrictionSpin = 0.005;
  FrictionRoll = 0.0001;
  CondDim: CondDimName = 'SlidingTorsional';
  SolrefTimeConst = 0.02;   //!< s
  SolrefDampRatio = 1;

  private _registered = false;

  constructor(node: Object3D) {
    this.node = node;
  }

  /** True when this side decides friction and compliance for every pairing it takes part in. */
  get setsTheTone(): boolean {
    return this.Priority > 0;
  }

  /** MuJoCo `condim` of {@link CondDim} — the number the MJCF writer needs. */
  get condim(): 1 | 3 | 4 | 6 {
    return condimOf(this.CondDim);
  }

  /** True when the numbers on this component are read at all. */
  get isCustom(): boolean {
    return this.Profile === 'Custom';
  }

  init(_ctx: ComponentContext): void {
    this.node.userData._rvType = CONTACT_PROFILE_TYPE;
    this._normalize();
    if (!this._registered) {
      this._registered = true;
      RVContactProfile.profiles.push(this);
    }
  }

  reapplyConfig(): void {
    this._normalize();
  }

  private _normalize(): void {
    if (!CONTACT_PROFILE_ROLES.includes(this.Profile)) this.Profile = 'Workpiece';
    this.Priority = Math.max(0, Math.round(finiteOr(this.Priority, 0)));
    this.Solmix = Math.max(0, finiteOr(this.Solmix, 1));
    this.FrictionSlide = Math.max(0, finiteOr(this.FrictionSlide, 1));
    this.FrictionSpin = Math.max(0, finiteOr(this.FrictionSpin, 0.005));
    this.FrictionRoll = Math.max(0, finiteOr(this.FrictionRoll, 0.0001));
    if (!COND_DIM_NAMES.includes(this.CondDim)) this.CondDim = 'SlidingTorsional';
    this.SolrefTimeConst = Math.max(0, finiteOr(this.SolrefTimeConst, 0.02));
    this.SolrefDampRatio = Math.max(0, finiteOr(this.SolrefDampRatio, 1));
  }

  dispose(): void {
    if (!this._registered) return;
    this._registered = false;
    const idx = RVContactProfile.profiles.indexOf(this);
    if (idx !== -1) RVContactProfile.profiles.splice(idx, 1);
  }
}

export class RVCollisionShapeSet implements RVComponent {
  static readonly schema: ComponentSchema = loadSchemaFromSpec(COLLISION_SHAPE_SET_TYPE);

  /** All shape sets of the loaded scene, in registration order. */
  static readonly sets: RVCollisionShapeSet[] = [];

  static clearAll(): void {
    for (const s of [...RVCollisionShapeSet.sets]) s.dispose();
    RVCollisionShapeSet.sets.length = 0;
  }

  readonly node: Object3D;
  isOwner = true;

  // ── Schema-populated ──
  /** Raw authored list; `shapes` is the normalised read. */
  Shapes: unknown[] = [];
  ReplacesMesh = false;

  private _shapes: CollisionShape[] = [];
  private _registered = false;

  constructor(node: Object3D) {
    this.node = node;
  }

  /** The authored primitives, normalised, in author order. */
  get shapes(): readonly CollisionShape[] {
    return this._shapes;
  }

  /** The primitives whose read `Size` components are all positive. */
  get validShapes(): readonly CollisionShape[] {
    return this._shapes.filter(isCollisionShapeValid);
  }

  init(_ctx: ComponentContext): void {
    this.node.userData._rvType = COLLISION_SHAPE_SET_TYPE;
    this._normalize();
    if (!this._registered) {
      this._registered = true;
      RVCollisionShapeSet.sets.push(this);
    }
  }

  reapplyConfig(): void {
    this._normalize();
  }

  private _normalize(): void {
    this._shapes = Array.isArray(this.Shapes) ? this.Shapes.map(normalizeCollisionShape) : [];
    this.ReplacesMesh = this.ReplacesMesh === true;
  }

  dispose(): void {
    if (!this._registered) return;
    this._registered = false;
    const idx = RVCollisionShapeSet.sets.indexOf(this);
    if (idx !== -1) RVCollisionShapeSet.sets.splice(idx, 1);
  }
}

registerComponent({
  type: CONTACT_PROFILE_TYPE,
  displayName: 'ContactProfile',
  schema: RVContactProfile.schema,
  capabilities: {
    pick: 'none',
    authorable: true,
    ui: { badge: '#26a69a', category: 'physics', filter: 'Contact Profiles' },
  },
  create: (node) => new RVContactProfile(node),
});

registerComponent({
  type: COLLISION_SHAPE_SET_TYPE,
  displayName: 'CollisionShapeSet',
  schema: RVCollisionShapeSet.schema,
  capabilities: {
    pick: 'none',
    authorable: true,
    ui: { badge: '#26a69a', category: 'physics', filter: 'Collision Shape Sets' },
  },
  create: (node) => new RVCollisionShapeSet(node),
});
