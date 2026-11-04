// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * physics-zone2d-schema.test.ts — plan-661 test 9.2.
 *
 * `WebPhysicsZone2D`: schema loads from rv-odt.json, the inspector fields and
 * the rawFields, the factory builds a zone like the loader (create →
 * beforeSchema → applySchema → init), raw references are read as paths, the
 * BoxCollider volume follows `syncPhysicsZoneBounds`, the category is physics,
 * and the bake keeps Surface / Guides / KinematicDrives alive. The Unity
 * field-name parity lives in physics-zone2d-unity-fields.node.test.ts.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Object3D } from 'three';
import rvOdt from '../schema/v1/rv-odt.json';
import { AABB } from '../src/core/engine/rv-aabb';
import {
  RVPhysicsZone2D, PHYSICS_ZONE2D_TYPE, refPathsOf,
} from '../src/core/engine/rv-physics-zone2d';
import { syncPhysicsZoneBounds } from '../src/core/engine/rv-physics-zone';
import {
  applySchema, getRegisteredFactories, getSchemaDefaults, type ComponentContext,
} from '../src/core/engine/rv-component-registry';
import { categoryOf } from '../src/core/engine/rv-component-category';
import { REFERENCE_BAKE_TARGETS, referenceBakeTargetOf } from '../src/core/engine/rv-bake-survival';
import '../src/core/engine/rv-scene-loader';

const DEF = (rvOdt as unknown as {
  $defs: Record<string, { properties: Record<string, unknown>; rawFields?: Record<string, unknown> }>;
  components: Record<string, unknown>;
}).$defs[PHYSICS_ZONE2D_TYPE];

const ref = (path: string, componentType?: string) => ({ type: 'ComponentReference', path, ...(componentType ? { componentType } : {}) });

function build(extras: Record<string, unknown>, box: boolean = true): RVPhysicsZone2D {
  const f = getRegisteredFactories().get(PHYSICS_ZONE2D_TYPE);
  if (!f) throw new Error('factory missing');
  const node = new Object3D();
  node.name = 'Zone2D';
  node.updateMatrixWorld(true);
  const aabb = box
    ? AABB.fromBoxCollider(node, { x: 0, y: 0, z: 0 }, { x: 0.4, y: 0.1, z: 2 })
    : AABB.fromNode(node);
  node.userData.realvirtual = { [PHYSICS_ZONE2D_TYPE]: extras };
  const zone = f.create(node, aabb) as RVPhysicsZone2D;
  f.beforeSchema?.(zone, extras);
  applySchema(zone as unknown as Record<string, unknown>, f.schema, extras);
  zone.init({ gizmoManager: undefined } as unknown as ComponentContext);
  return zone;
}

afterEach(() => RVPhysicsZone2D.clearAll());

describe('WebPhysicsZone2D schema (plan-661 9.2)', () => {
  it('is a component of the rv-ODT spec with the plan fields and Guides as rawField', () => {
    expect(DEF).toBeDefined();
    expect((rvOdt as unknown as { components: Record<string, unknown> }).components[PHYSICS_ZONE2D_TYPE]).toBeDefined();
    expect(Object.keys(DEF.properties).sort()).toEqual(
      ['Damping', 'ForceReturnAfter', 'Kind', 'KinematicDrives', 'ShowGizmo', 'SleepThreshold', 'Surface'].sort(),
    );
    expect(Object.keys(DEF.rawFields ?? {})).toEqual(['Guides']);
  });

  it('loads the inspector schema with types and defaults', () => {
    const s = RVPhysicsZone2D.schema;
    expect(s['Kind']).toMatchObject({ type: 'enum', default: 'Jam' });
    expect(Object.keys(s['Kind'].enumMap ?? {})).toEqual(['Jam', 'BufferTable', 'Diverter', 'Merge']);
    expect(s['Surface'].type).toBe('componentRef');
    expect(s['KinematicDrives'].type).toBe('componentRefArray');
    expect(s['Damping']).toMatchObject({ type: 'number', default: 0 });
    expect(s['SleepThreshold']).toMatchObject({ type: 'number', default: 0.05 });
    expect(s['ForceReturnAfter']).toMatchObject({ type: 'number', default: 0 });
    expect(s['Guides']).toBeUndefined();
    expect(getSchemaDefaults(PHYSICS_ZONE2D_TYPE)).toMatchObject({ Kind: 'Jam', ShowGizmo: true });
  });

  it('builds like the loader: fields, raw reference paths, registration', () => {
    const zone = build({
      Kind: 'BufferTable', Damping: 1.5, ForceReturnAfter: 3,
      Surface: ref('Line/Outfeed', 'realvirtual.TransportSurface'),
      Guides: [ref('Line/GuideL'), 'Line/GuideR', 42, null],
      KinematicDrives: [ref('Line/Pusher', 'realvirtual.Drive')],
    });
    expect(zone.Kind).toBe('BufferTable');
    expect(zone.Damping).toBe(1.5);
    expect(zone.ForceReturnAfter).toBe(3);
    expect(zone.SleepThreshold).toBe(0.05);
    expect(zone.surfacePath).toBe('Line/Outfeed');
    expect(zone.guidePaths).toEqual(['Line/GuideL', 'Line/GuideR']);
    expect(zone.kinematicDrivePaths).toEqual(['Line/Pusher']);
    expect(zone.active).toBe(true);
    expect(RVPhysicsZone2D.zones).toEqual([zone]);
    expect(zone.node.userData._rvType).toBe(PHYSICS_ZONE2D_TYPE);
  });

  it('defensive values: unknown Kind falls back to Jam, negative numbers clamp to 0', () => {
    const zone = build({ Kind: 'Nonsense', Damping: -2, ForceReturnAfter: -1 });
    expect(zone.Kind).toBe('Jam');
    expect(zone.Damping).toBe(0);
    expect(zone.ForceReturnAfter).toBe(0);
  });

  it('a zone without a BoxCollider is ignored with a warning, and registers once a box arrives', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const zone = build({}, false);
    expect(zone.active).toBe(false);
    expect(RVPhysicsZone2D.zones).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    const registry = { getByPath: <T,>(type: string) => (type === PHYSICS_ZONE2D_TYPE ? zone as unknown as T : null) };
    syncPhysicsZoneBounds(registry, 'Zone2D', { x: 0, y: 0, z: 0 }, { x: 1, y: 0.2, z: 3 });
    expect(zone.active).toBe(true);
    expect(zone.worldAabb!.max.z - zone.worldAabb!.min.z).toBeCloseTo(3, 6);
    syncPhysicsZoneBounds(registry, 'Zone2D', null, null);
    expect(zone.active).toBe(false);
    warn.mockRestore();
  });

  it('refPathsOf drops malformed entries', () => {
    expect(refPathsOf(undefined)).toEqual([]);
    expect(refPathsOf(['', { path: '' }, { path: 'A' }, 'B'])).toEqual(['A', 'B']);
  });

  it('refPathsOf keeps a web-saved address / kept path as its label (plan-769)', () => {
    expect(refPathsOf([
      { type: 'ComponentReference', address: '#a1b2', componentType: 'UnityEngine.Transform' },
      { type: 'ComponentReference', unresolvedPath: 'Line/Gone', reason: 'missing' },
    ])).toEqual(['#a1b2', 'Line/Gone']);
  });

  it('is in the physics category', () => {
    expect(categoryOf(PHYSICS_ZONE2D_TYPE)?.category).toBe('physics');
  });

  it('declares merge bake targets for Surface, Guides and KinematicDrives', () => {
    for (const field of ['Surface', 'Guides', 'KinematicDrives']) {
      expect(REFERENCE_BAKE_TARGETS.some((e) => e.component === PHYSICS_ZONE2D_TYPE && e.field === field)).toBe(true);
      expect(referenceBakeTargetOf(PHYSICS_ZONE2D_TYPE, field)).toBe('merge');
    }
  });
});
