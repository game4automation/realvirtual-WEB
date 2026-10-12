// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * physics-zone-authoring.test.ts — plan-525 T4: `WebPhysicsZone` is authorable
 * and its volume follows the BoxCollider of its node.
 *
 *  - adding a zone adds a missing 1 m BoxCollider in the SAME undo step and
 *    keeps an existing box; a second zone on the node is refused, no change;
 *  - a BoxCollider field edit, a live preview (explicit values) and undo move
 *    the zone AABB and its gizmo at once;
 *  - removing the BoxCollider makes the zone inactive, undo restores it;
 *  - removing / re-adding the zone leaves no ghost zone in `RVPhysicsZone.zones`.
 *
 * PRIVATE-DEPENDENT (the add rules live with the asset editor): listed in
 * `tests/private-dependent-tests.json`.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { makeAuthoringRig, rvOf, type AuthoringRig } from './helpers/collider-authoring-rig';
import { RVPhysicsZone } from '../src/core/engine/rv-physics-zone';
import type { RVBoxCollider } from '../src/core/engine/rv-box-collider';
import type { GizmoHandle } from '../src/core/engine/rv-gizmo-manager';
import {
  addColliderAwareComponent, colliderAddRefusal, ERR_HAS_PHYSICS_ZONE,
} from '@rv-private/plugins/asset-editor/collider-add-rules';

const rigs: AuthoringRig[] = [];
afterEach(() => {
  for (const r of rigs.splice(0)) r.dispose();
  vi.restoreAllMocks();
});

function stationRig(): AuthoringRig {
  const r = makeAuthoringRig();
  rigs.push(r);
  const station = r.addNode('Station');
  station.position.set(2, 1, 0);
  station.updateMatrixWorld(true);
  return r;
}

function zoneAt(r: AuthoringRig, path = 'Asset/Station'): RVPhysicsZone {
  const zone = r.registry.getByPath<RVPhysicsZone>('WebPhysicsZone', path);
  expect(zone, `zone at ${path}`).toBeInstanceOf(RVPhysicsZone);
  return zone!;
}

function gizmoOf(zone: RVPhysicsZone): GizmoHandle | null {
  return (zone as unknown as { _gizmo: GizmoHandle | null })._gizmo;
}

function extent(zone: RVPhysicsZone): number[] {
  const v = zone.worldAabb!;
  return [v.max.x - v.min.x, v.max.y - v.min.y, v.max.z - v.min.z].map((n) => +n.toFixed(6));
}

describe('WebPhysicsZone authoring (plan-525 T4)', () => {
  it('zone add adds a missing 1 m BoxCollider in ONE undo step; undo leaves nothing', async () => {
    const r = stationRig();
    const res = await addColliderAwareComponent(r.viewer, r.doc, 'Asset/Station', 'WebPhysicsZone');
    const node = r.registry.getNode('Asset/Station')!;
    expect(res.component).toBe('WebPhysicsZone');
    expect(rvOf(node).BoxCollider).toEqual({ center: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } });
    expect(rvOf(node).WebPhysicsZone.WholeScene).toBe(false);
    expect(r.doc.document.opCount).toBe(1);
    const zone = zoneAt(r);
    expect(zone.active).toBe(true);
    expect(RVPhysicsZone.zones).toEqual([zone]);
    expect(extent(zone)).toEqual([1, 1, 1]);
    expect(zone.worldAabb!.min.x).toBeCloseTo(1.5, 9); // centred on the node (x = 2)

    await r.doc.undo();
    expect(rvOf(node).BoxCollider).toBeUndefined();
    expect(rvOf(node).WebPhysicsZone).toBeUndefined();
    expect(RVPhysicsZone.zones).toHaveLength(0); // no ghost zone
  });

  it('keeps an existing BoxCollider; a second zone is refused without a change', async () => {
    const r = stationRig();
    await addColliderAwareComponent(r.viewer, r.doc, 'Asset/Station', 'BoxCollider', {
      size: { x: 0.5, y: 0.25, z: 2 },
    });
    await addColliderAwareComponent(r.viewer, r.doc, 'Asset/Station', 'WebPhysicsZone');
    const node = r.registry.getNode('Asset/Station')!;
    expect(rvOf(node).BoxCollider.size).toEqual({ x: 0.5, y: 0.25, z: 2 });
    expect(extent(zoneAt(r))).toEqual([0.5, 0.25, 2]);
    const ops = r.doc.document.opCount;
    const before = JSON.stringify(rvOf(node));
    expect(colliderAddRefusal(node, 'WebPhysicsZone')).toBe(ERR_HAS_PHYSICS_ZONE);
    await expect(addColliderAwareComponent(r.viewer, r.doc, 'Asset/Station', 'WebPhysicsZone'))
      .rejects.toThrow(ERR_HAS_PHYSICS_ZONE);
    expect(JSON.stringify(rvOf(node))).toBe(before);
    expect(r.doc.document.opCount).toBe(ops);
    expect(RVPhysicsZone.zones).toHaveLength(1);
  });

  it('a BoxCollider field edit, a live preview and undo move the zone AABB and its gizmo', async () => {
    const r = stationRig();
    await addColliderAwareComponent(r.viewer, r.doc, 'Asset/Station', 'WebPhysicsZone');
    const zone = zoneAt(r);
    const gizmo = gizmoOf(zone);
    expect(gizmo).not.toBeNull();
    expect(gizmo!.root.scale.x).toBeCloseTo(1, 6);

    // Persisted edit (inspector / web_editor_set_field): size 2 m in X.
    r.doc.setField('Asset/Station', 'BoxCollider', 'size', { x: 2, y: 1, z: 1 }, { x: 1, y: 1, z: 1 });
    await r.doc.whenIdle();
    expect(extent(zone)).toEqual([2, 1, 1]);
    expect(gizmoOf(zone)!.root.scale.x).toBeCloseTo(2, 6);

    // Live preview (handle drag): explicit values on the instance, no op.
    const box = r.registry.getByPath<RVBoxCollider>('BoxCollider', 'Asset/Station')!;
    const ops = r.doc.document.opCount;
    box.center.set(0.5, 0, 0);
    box.size.set(3, 1, 1);
    box.reapplyConfig();
    expect(extent(zone)).toEqual([3, 1, 1]);
    expect(zone.worldAabb!.min.x).toBeCloseTo(2 + 0.5 - 1.5, 9);
    expect(gizmoOf(zone)!.root.position.x).toBeCloseTo(2.5, 6);
    expect(r.doc.document.opCount).toBe(ops);

    // Undo the persisted edit: back to 1 m (the extras re-apply the instance).
    await r.doc.undo();
    expect(rvOf(r.registry.getNode('Asset/Station')).BoxCollider.size).toEqual({ x: 1, y: 1, z: 1 });
    expect(extent(zone)).toEqual([1, 1, 1]);
  });

  it('removing the BoxCollider makes the zone inactive (one warning); undo restores it', async () => {
    const r = stationRig();
    await addColliderAwareComponent(r.viewer, r.doc, 'Asset/Station', 'WebPhysicsZone');
    const zone = zoneAt(r);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    r.doc.removeComponent('Asset/Station', 'BoxCollider');
    await r.doc.whenIdle();
    expect(zone.active).toBe(false);
    expect(zone.worldAabb).toBeNull();
    expect(gizmoOf(zone)).toBeNull();
    expect(RVPhysicsZone.findZoneOverlapping({ min: { x: 1.9, y: 0.9, z: -0.1 }, max: { x: 2.1, y: 1.1, z: 0.1 } })).toBeNull();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('zone inactive'))).toHaveLength(1);

    await r.doc.undo();
    expect(zone.active).toBe(true);
    expect(extent(zone)).toEqual([1, 1, 1]);
    expect(gizmoOf(zone)).not.toBeNull();
    expect(RVPhysicsZone.zones).toEqual([zone]); // same slot, no duplicate
  });

  it('removing and re-adding the zone component leaves exactly one registered zone', async () => {
    const r = stationRig();
    await addColliderAwareComponent(r.viewer, r.doc, 'Asset/Station', 'WebPhysicsZone');
    r.doc.removeComponent('Asset/Station', 'WebPhysicsZone');
    await r.doc.whenIdle();
    expect(RVPhysicsZone.zones).toHaveLength(0);
    await r.doc.undo();
    expect(RVPhysicsZone.zones).toHaveLength(1);
    expect(RVPhysicsZone.zones[0]).toBe(zoneAt(r));
    await r.doc.redo();
    expect(RVPhysicsZone.zones).toHaveLength(0);
  });
});
