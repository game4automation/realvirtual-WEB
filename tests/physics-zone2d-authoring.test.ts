// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * physics-zone2d-authoring.test.ts — plan-661 Phase 2 editor part.
 *
 *  - `WebPhysicsZone2D` add (rule path) adds a missing 1 m BoxCollider in ONE
 *    undo step; a second 2D zone on the node is refused without a change;
 *  - a BoxCollider live preview (the box handles' path) moves the zone volume;
 *  - `physicszone2d.add` / `physicszone2d.setReferences` write the authored
 *    fields as ComponentReferences in one undo step each.
 *
 * PRIVATE-DEPENDENT: listed in `tests/private-dependent-tests.json`.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { makeAuthoringRig, rvOf, type AuthoringRig } from './helpers/collider-authoring-rig';
import { RVPhysicsZone2D } from '../src/core/engine/rv-physics-zone2d';
import type { RVBoxCollider } from '../src/core/engine/rv-box-collider';
import type { CommandContext } from '../src/core/hmi/rv-command-registry';
import {
  PHYSICS_ZONE2D_ADD_COMMAND, PHYSICS_ZONE2D_SET_REFERENCES_COMMAND,
} from '../src/core/hmi/editor-command-descriptors';
import {
  addColliderAwareComponent, colliderAddRefusal, ERR_HAS_PHYSICS_ZONE2D,
} from '@rv-private/plugins/asset-editor/collider-add-rules';
import { impls } from '@rv-private/plugins/asset-editor/editor-commands';

interface Impl {
  enabled(ctx: CommandContext, args: Record<string, unknown>): unknown;
  run(ctx: CommandContext, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

const rigs: AuthoringRig[] = [];
afterEach(() => {
  for (const r of rigs.splice(0)) r.dispose();
  RVPhysicsZone2D.clearAll();
  vi.restoreAllMocks();
});

function rig(): AuthoringRig {
  const r = makeAuthoringRig();
  rigs.push(r);
  r.addNode('Jam');
  r.addNode('Outfeed');
  r.addNode('GuideL');
  r.addNode('GuideR');
  return r;
}

const ctxOf = (r: AuthoringRig): CommandContext => ({ doc: r.doc, viewer: r.viewer, selection: [] } as unknown as CommandContext);

function zoneAt(r: AuthoringRig): RVPhysicsZone2D {
  const zone = r.registry.getByPath<RVPhysicsZone2D>('WebPhysicsZone2D', 'Asset/Jam');
  expect(zone).toBeInstanceOf(RVPhysicsZone2D);
  return zone!;
}

describe('WebPhysicsZone2D authoring (plan-661 Phase 2)', () => {
  it('add adds a missing 1 m BoxCollider in ONE undo step; a second zone is refused', async () => {
    const r = rig();
    const res = await addColliderAwareComponent(r.viewer, r.doc, 'Asset/Jam', 'WebPhysicsZone2D', { Kind: 'BufferTable' });
    const node = r.registry.getNode('Asset/Jam')!;
    expect(res.component).toBe('WebPhysicsZone2D');
    expect(rvOf(node).BoxCollider).toEqual({ center: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } });
    expect(rvOf(node).WebPhysicsZone2D.Kind).toBe('BufferTable');
    expect(r.doc.document.opCount).toBe(1);
    expect(zoneAt(r).active).toBe(true);

    const before = JSON.stringify(rvOf(node));
    expect(colliderAddRefusal(node, 'WebPhysicsZone2D')).toBe(ERR_HAS_PHYSICS_ZONE2D);
    await expect(addColliderAwareComponent(r.viewer, r.doc, 'Asset/Jam', 'WebPhysicsZone2D')).rejects.toThrow(ERR_HAS_PHYSICS_ZONE2D);
    expect(JSON.stringify(rvOf(node))).toBe(before);

    await r.doc.undo();
    expect(rvOf(node).WebPhysicsZone2D).toBeUndefined();
    expect(RVPhysicsZone2D.zones).toHaveLength(0);
  });

  it('a BoxCollider live preview (box handles) moves the zone volume', async () => {
    const r = rig();
    await addColliderAwareComponent(r.viewer, r.doc, 'Asset/Jam', 'WebPhysicsZone2D');
    const zone = zoneAt(r);
    const box = r.registry.getByPath<RVBoxCollider>('BoxCollider', 'Asset/Jam')!;
    box.size.set(0.4, 0.1, 2.5);
    box.reapplyConfig();
    const v = zone.worldAabb!;
    expect(v.max.z - v.min.z).toBeCloseTo(2.5, 6);
    expect(v.max.x - v.min.x).toBeCloseTo(0.4, 6);
  });

  it('physicszone2d.add + setReferences write the fields as references', async () => {
    const r = rig();
    const ctx = ctxOf(r);
    const add = impls[PHYSICS_ZONE2D_ADD_COMMAND] as unknown as Impl;
    const set = impls[PHYSICS_ZONE2D_SET_REFERENCES_COMMAND] as unknown as Impl;
    expect(add.enabled(ctx, { path: 'Asset/Jam', kind: 'Sideways' })).not.toBe(true);
    expect(add.enabled(ctx, { path: 'Asset/Jam', kind: 'merge' })).toBe(true);
    await add.run(ctx, { path: 'Asset/Jam', kind: 'merge' });
    const node = r.registry.getNode('Asset/Jam')!;
    expect(rvOf(node).WebPhysicsZone2D.Kind).toBe('Merge');

    expect(set.enabled(ctx, { path: 'Asset/Jam', guides: ['Asset/Nope'] })).not.toBe(true);
    const ops = r.doc.document.opCount;
    const res = await set.run(ctx, { path: 'Asset/Jam', surface: 'Asset/Outfeed', guides: ['Asset/GuideL', 'Asset/GuideR'] });
    expect(res.changed).toEqual(['Surface', 'Guides']);
    const z = rvOf(node).WebPhysicsZone2D;
    expect(z.Surface).toMatchObject({ type: 'ComponentReference', path: 'Asset/Outfeed' });
    expect((z.Guides as { path: string }[]).map((g: { path: string }) => g.path)).toEqual(['Asset/GuideL', 'Asset/GuideR']);
    expect(r.doc.document.opCount).toBe(ops + 1);
    const zone = zoneAt(r);
    zone.readReferences();
    expect(zone.guidePaths).toEqual(['Asset/GuideL', 'Asset/GuideR']);
  });
});
