// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * mujoco-components-schema.test.ts — plan-673 Phase 2 / 2b acceptance.
 *
 * The seven components of the detail-physics layer, and the one property that
 * matters most about them: every one of them is EDITABLE. Thomas' rule
 * (2026-10-24) is that a function in realvirtual WEB is a component with
 * properties, each property has a type, a unit and a default, and each property
 * has a real inspector editor — "a property you can only set as raw text is not
 * finished". The tests below are the machine-checkable form of that rule:
 *
 *  - every property declares a default, so `getSchemaDefaults` seeds a full
 *    field set and the inspector renders a row for it (a row only exists for a
 *    key the data carries);
 *  - every property either maps to a built-in editor for its field type, or has
 *    a registered field renderer — the two array-shaped types (`json`,
 *    `componentRefArray`) have no generic editor at all, so for them a renderer
 *    is mandatory rather than optional;
 *  - every number property carries a unit unless it is genuinely dimensionless,
 *    and its schema bounds reach the descriptor the number editor reads.
 *
 * Plus the two measured findings this layer exists to carry, pinned so a later
 * edit cannot quietly drop them: `CondDim` does NOT default to MuJoCo's own 3,
 * and `ContactProfile` carries `Priority` and `Solmix`.
 */

import { describe, it, expect } from 'vitest';
import rvOdt from '../schema/v1/rv-odt.json';
import {
  getFieldDescriptor,
  getRawOdtDef,
  getSchemaDefaults,
  getStructItemFields,
  loadSchemaFromSpec,
  type FieldDescriptor,
} from '../src/core/engine/rv-component-registry';
import { REFERENCE_BAKE_TARGETS } from '../src/core/engine/rv-bake-survival';
import { fieldRendererRegistry } from '../src/core/hmi/rv-field-renderer-registry';
import { getFieldUnit } from '../src/core/hmi/rv-inspector-helpers';
import {
  COLLISION_SHAPE_SIZE_COMPONENTS,
  COND_DIM_VALUES,
  condimOf,
  collisionShapeSizeArray,
  isCollisionShapeValid,
  normalizeCollisionShape,
} from '../src/core/engine/rv-contact-geometry';
import { defaultStructEntry, moveEntry } from '../src/core/hmi/rv-struct-list-field-renderer';
// Side-effect imports: the component registrations and the field renderers.
import '../src/core/engine/rv-scene-loader';
import '../src/core/hmi/rv-struct-list-field-renderer';
import '../src/core/hmi/rv-locomotion-policy-field-renderers';

const TYPES = [
  'WebMuJoCoRegion',
  'DynamicAxis',
  'GripLoad',
  'ContactProfile',
  'CollisionShapeSet',
  'FreeBody',
  'Movable',
  'LocomotionPolicy',
] as const;

const doc = rvOdt as unknown as {
  $defs: Record<string, { properties?: Record<string, { type?: string; unit?: string; minimum?: number; maximum?: number; step?: number }> }>;
  components: Record<string, unknown>;
};

/**
 * Number properties that are genuinely dimensionless — a factor, a ratio, a
 * count or a coefficient. Named explicitly so a NEW number field without a unit
 * fails the test instead of joining a silent majority.
 */
const DIMENSIONLESS = new Set([
  'DynamicAxis.Kp', 'DynamicAxis.Kv', 'DynamicAxis.Gear', 'DynamicAxis.Damping',
  'ContactProfile.Priority', 'ContactProfile.Solmix', 'ContactProfile.FrictionSlide',
  'ContactProfile.FrictionSpin', 'ContactProfile.FrictionRoll', 'ContactProfile.SolrefDampRatio',
  'FreeBody.FrictionSlide', 'FreeBody.Restitution',
  'LocomotionPolicy.Decimation', 'LocomotionPolicy.ActionScale',
]);

/** Field types the inspector's built-in `FieldEditor` can edit without help. */
const BUILT_IN_EDITABLE: ReadonlySet<FieldDescriptor['type']> =
  new Set(['number', 'boolean', 'string', 'enum', 'vector3', 'componentRef']);

describe('plan-673 — the seven detail-physics components exist as schema components', () => {
  it.each(TYPES)('%s is indexed and loads', (type) => {
    expect(doc.components[type], `${type} missing from the components index`).toBeDefined();
    expect(getRawOdtDef(type), `${type} missing from $defs`).toBeDefined();
    const schema = loadSchemaFromSpec(type);
    expect(Object.keys(schema).length).toBeGreaterThan(0);
  });

  it.each(TYPES)('%s is registered at runtime with the spec schema', (type) => {
    const props = Object.keys(doc.$defs[type].properties ?? {});
    for (const field of props) {
      expect(getFieldDescriptor(type, field), `${type}.${field} not registered`).toBeDefined();
    }
  });
});

describe('plan-673 — every property is editable (Thomas 2026-10-24)', () => {
  it.each(TYPES)('%s: every property declares a default, so the inspector gets a row', (type) => {
    const props = Object.keys(doc.$defs[type].properties ?? {});
    const defaults = getSchemaDefaults(type);
    const missing = props.filter((f) => !(f in defaults));
    expect(missing, `${type}: properties without a default never reach the inspector`).toEqual([]);
  });

  it.each(TYPES)('%s: every property has a real editor', (type) => {
    const schema = loadSchemaFromSpec(type);
    const rawText: string[] = [];
    for (const [field, desc] of Object.entries(schema)) {
      const hasRenderer = fieldRendererRegistry.getRenderer(type, field) !== null;
      if (hasRenderer) continue;
      // `json` and `componentRefArray` have NO generic editor: the array editor
      // offers no add, no remove and no reorder, and an entry's sub-fields fall
      // through to a text box. For those a registered renderer is mandatory.
      if (!BUILT_IN_EDITABLE.has(desc.type)) rawText.push(`${type}.${field} (${desc.type})`);
    }
    expect(rawText, 'fields with neither a built-in editor nor a registered renderer').toEqual([]);
  });

  it('the two array-shaped fields have their dedicated renderers', () => {
    expect(fieldRendererRegistry.getRenderer('CollisionShapeSet', 'Shapes')).not.toBeNull();
    expect(fieldRendererRegistry.getRenderer('LocomotionPolicy', 'Axes')).not.toBeNull();
    // The derived policy rate is shown next to the input it comes from.
    expect(fieldRendererRegistry.getRenderer('LocomotionPolicy', 'Decimation')).not.toBeNull();
  });

  it.each(TYPES)('%s: every number property has a unit or is declared dimensionless', (type) => {
    const props = doc.$defs[type].properties ?? {};
    const naked: string[] = [];
    for (const [field, p] of Object.entries(props)) {
      if (p.type !== 'number') continue;
      const key = `${type}.${field}`;
      if (DIMENSIONLESS.has(key)) {
        expect(p.unit, `${key} is declared dimensionless but carries a unit`).toBeUndefined();
        continue;
      }
      if (!p.unit) naked.push(key);
      else expect(getFieldUnit(type, field), `${key} unit does not reach the inspector`).toBeTruthy();
    }
    expect(naked, 'number fields with neither a unit nor a dimensionless declaration').toEqual([]);
  });

  it.each(TYPES)('%s: schema bounds reach the descriptor the number editor reads', (type) => {
    const props = doc.$defs[type].properties ?? {};
    for (const [field, p] of Object.entries(props)) {
      if (p.type !== 'number') continue;
      const desc = getFieldDescriptor(type, field)!;
      expect(desc.min, `${type}.${field} min`).toBe(p.minimum);
      expect(desc.max, `${type}.${field} max`).toBe(p.maximum);
      expect(desc.step, `${type}.${field} step`).toBe(p.step);
    }
  });

  it('a bound on a non-number field is ignored rather than half-applied', () => {
    // `Movable.Axes` is an enum; no bound keyword may leak into its descriptor.
    const desc = getFieldDescriptor('Movable', 'Axes')!;
    expect(desc.type).toBe('enum');
    expect(desc.min).toBeUndefined();
    expect(desc.max).toBeUndefined();
  });
});

describe('plan-673 — the measured findings the schema has to carry', () => {
  it('CondDim does NOT default to MuJoCo\'s own 3 (no spin friction = a silent jam)', () => {
    for (const type of ['ContactProfile', 'FreeBody']) {
      const desc = getFieldDescriptor(type, 'CondDim')!;
      expect(desc.type).toBe('enum');
      // The STORED value is the name: a resolved number would be stamped as
      // the default, show up as a fifth dropdown entry, and be saved back as a
      // value the schema's own enum rejects.
      expect(desc.default, `${type}.CondDim default`).toBe('SlidingTorsional');
      expect(condimOf(desc.default)).toBe(COND_DIM_VALUES.SlidingTorsional);
      expect(condimOf(desc.default)).not.toBe(3);
      // All four MuJoCo values stay offerable — the default is a choice, not a cage.
      expect(Object.keys(desc.enumMap!)).toEqual(['Frictionless', 'Sliding', 'SlidingTorsional', 'Full']);
      expect(Object.keys(desc.enumMap!).map(condimOf)).toEqual([1, 3, 4, 6]);
    }
  });

  it('ContactProfile carries Priority (0) and Solmix (1) — without them no pairing is expressible', () => {
    expect(getFieldDescriptor('ContactProfile', 'Priority')!.default).toBe(0);
    expect(getFieldDescriptor('ContactProfile', 'Solmix')!.default).toBe(1);
  });

  it('DynamicAxis declares the structural share of the following error', () => {
    const desc = getFieldDescriptor('DynamicAxis', 'BaseFollowingError')!;
    expect(desc.type).toBe('number');
    expect(desc.unit).toBe('mm');
    expect(desc.default).toBe(0);
    expect(desc.min).toBe(0);
  });

  it('FreeBody has mass, friction, damping and restitution as properties, not literals', () => {
    for (const f of ['MassKg', 'CondDim', 'FrictionSlide', 'LinearDamping', 'AngularDamping', 'Restitution']) {
      expect(getFieldDescriptor('FreeBody', f), `FreeBody.${f}`).toBeDefined();
    }
    const r = getFieldDescriptor('FreeBody', 'Restitution')!;
    expect([r.min, r.max]).toEqual([0, 1]);
  });
});

describe('plan-673 — CollisionShapeSet.Shapes is a typed struct list', () => {
  it('the item shape comes from the schema with real field types', () => {
    const item = getStructItemFields('CollisionShapeSet', 'Shapes');
    expect(item).not.toBeNull();
    expect(Object.keys(item!).sort()).toEqual(['Center', 'Kind', 'Rotation', 'Size']);
    expect(item!.Kind.type).toBe('enum');
    expect(Object.keys(item!.Kind.enumMap!)).toEqual(['box', 'sphere', 'capsule', 'cylinder', 'ellipsoid']);
    expect(item!.Center.type).toBe('vector3');
    expect(item!.Size.type).toBe('vector3');
    expect(item!.Rotation.type).toBe('vector3');
  });

  it('a dedup-suffixed component key resolves the item shape like its base type', () => {
    expect(getStructItemFields('CollisionShapeSet_2', 'Shapes')).not.toBeNull();
  });

  it('a non-array field has no item shape', () => {
    expect(getStructItemFields('CollisionShapeSet', 'ReplacesMesh')).toBeNull();
    expect(getStructItemFields('LocomotionPolicy', 'Axes')).toBeNull();
  });

  it('a fresh entry opens with the item schema defaults, never with empty rows', () => {
    const item = getStructItemFields('CollisionShapeSet', 'Shapes')!;
    const entry = defaultStructEntry(item);
    expect(entry.Kind).toBe('box');
    expect(entry.Center).toEqual({ x: 0, y: 0, z: 0 });
    expect(entry.Size).toEqual({ x: 0, y: 0, z: 0 });
    expect(entry.Rotation).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('reorder moves one entry and leaves the rest in order', () => {
    const list = ['a', 'b', 'c', 'd'];
    expect(moveEntry(list, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveEntry(list, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    // Out-of-range stays a copy of the input rather than corrupting the list.
    expect(moveEntry(list, 0, 9)).toEqual(list);
    expect(moveEntry(list, -1, 0)).toEqual(list);
    expect(moveEntry(list, 1, 1)).toEqual(list);
  });

  it('Size is read type-dependently — the MuJoCo convention, not a Vector3 full size', () => {
    expect(COLLISION_SHAPE_SIZE_COMPONENTS).toEqual({
      box: 3, sphere: 1, capsule: 2, cylinder: 2, ellipsoid: 3,
    });
    const box = normalizeCollisionShape({ Kind: 'box', Size: { x: 10, y: 20, z: 30 } });
    expect(collisionShapeSizeArray(box)).toEqual([10, 20, 30]);
    const sphere = normalizeCollisionShape({ Kind: 'sphere', Size: { x: 5, y: 99, z: 99 } });
    expect(collisionShapeSizeArray(sphere)).toEqual([5]);
    const capsule = normalizeCollisionShape({ Kind: 'capsule', Size: { x: 4, y: 12, z: 99 } });
    expect(collisionShapeSizeArray(capsule)).toEqual([4, 12]);
  });

  it('a degenerate primitive is invalid instead of silently growing', () => {
    expect(isCollisionShapeValid(normalizeCollisionShape({ Kind: 'sphere', Size: { x: 5 } }))).toBe(true);
    expect(isCollisionShapeValid(normalizeCollisionShape({ Kind: 'sphere', Size: { x: 0 } }))).toBe(false);
    // A box ignores nothing: all three half extents must be positive.
    expect(isCollisionShapeValid(normalizeCollisionShape({ Kind: 'box', Size: { x: 1, y: 1, z: 0 } }))).toBe(false);
    // An unknown kind becomes a box rather than disappearing.
    expect(normalizeCollisionShape({ Kind: 'torus' }).Kind).toBe('box');
  });
});

describe('plan-673 — LocomotionPolicy.Axes is an ordered reference list', () => {
  it('Axes is a componentRefArray, not a list of names', () => {
    const desc = getFieldDescriptor('LocomotionPolicy', 'Axes')!;
    expect(desc.type).toBe('componentRefArray');
    expect(desc.default).toEqual([]);
  });

  it('every Axes target survives the bake — a vanished one would shift every axis after it', () => {
    const entry = REFERENCE_BAKE_TARGETS.find(
      (e) => e.component === 'LocomotionPolicy' && e.field === 'Axes',
    );
    expect(entry, 'no REFERENCE_BAKE_TARGETS row for LocomotionPolicy.Axes').toBeDefined();
    expect(entry!.kind).toBe('refArray');
    expect(entry!.bakeTarget).toBe('merge');
  });

  it('RateHz is NOT a field — it is derived from the region timestep and Decimation', () => {
    expect(getFieldDescriptor('LocomotionPolicy', 'RateHz')).toBeUndefined();
    expect(getFieldDescriptor('LocomotionPolicy', 'Decimation')!.min).toBe(1);
  });
});
