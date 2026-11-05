// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-781 §9.8b — bodies inside PLACEMENTS (F14).
 *
 * Every reference is a placement (plan-757): two placements of one asset share
 * the chunk geometry but are separate bodies with their own matrices; a nested
 * placement inside a placed asset resolves per instance mesh; releasing a
 * placement (the registry's `onRelease`) and `layout-content-added` invalidate
 * the bodies.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Group, Object3D, Scene } from 'three';
import { registerComponentSchema } from '../src/core/engine/rv-component-registry';
import { BakeRegistry } from '../src/core/engine/rv-bake-registry';
import { RVCollisionManager, type CollisionViewerEvent } from '../src/core/engine/rv-collision-manager';
import { __resetCollisionAlertStore } from '../src/core/hmi/collision-alert-store';
import { COLLISION_UBER, FakeHighlightHost, bodyNode, boxMesh, plainGroup } from './collision-fixture';
import { bakeTree } from './fixtures/bake-fixture';

registerComponentSchema('TestCollisionMount', {}, {});

const DT = 1 / 60;

function find(root: Object3D, name: string): Object3D {
  let hit: Object3D | null = null;
  root.traverse((n) => { if (!hit && n.name === name) hit = n; });
  if (!hit) throw new Error(`no node ${name}`);
  return hit;
}

async function stationScene() {
  // Inner asset: a fixture with a static clamp.
  const fixtureBaked = await bakeTree(
    plainGroup('Fixture', bodyNode('Clamp', { role: 'Tool', at: [0, 0.4, 0], size: [0.4, 0.4, 0.4] })),
    { uber: COLLISION_UBER, destructive: true, assetId: 'fixture' },
  );
  // Outer asset: a station with a static table and a mount node for the fixture.
  const mount = plainGroup('Mount');
  mount.userData.realvirtual = { TestCollisionMount: { enabled: true } };
  mount.position.set(0.5, 0, 0);
  const stationBaked = await bakeTree(
    plainGroup('Station', bodyNode('Table', { role: 'Machine', size: [2, 0.2, 2] }), mount),
    { uber: COLLISION_UBER, destructive: true, assetId: 'station' },
  );

  const scene = new Scene();
  const registry = new BakeRegistry();
  const rootA = new Group(); rootA.name = 'StationA';
  const rootB = new Group(); rootB.name = 'StationB'; rootB.position.x = 10;
  scene.add(rootA, rootB);
  const a = registry.instantiate(stationBaked, rootA);
  const b = registry.instantiate(stationBaked, rootB);
  // A nested placement inside placement A.
  const nestedRoot = new Group(); nestedRoot.name = 'FixtureA';
  find(rootA, 'Mount').add(nestedRoot);
  const nested = registry.instantiate(fixtureBaked, nestedRoot);
  scene.updateMatrixWorld(true);

  const manager = new RVCollisionManager();
  manager.setGeometrySource(registry);
  manager.setHighlightHost(new FakeHighlightHost());

  // A free probe body made of a real mesh (a keep part).
  const probe = new Object3D(); probe.name = 'Probe';
  probe.add(boxMesh({ name: 'ProbeMesh', size: [0.3, 0.3, 0.3] }));
  probe.position.set(0, 5, 0);
  scene.add(probe);
  manager.register(probe, 'Robot');
  return { scene, registry, manager, a, b, nested, rootA, rootB, probe };
}

function reported(m: RVCollisionManager): string[] {
  return m.activePairs.map((p) => [p.aKey, p.bKey].sort().join('|')).sort();
}

beforeEach(() => __resetCollisionAlertStore());

describe('collision bodies in placements (F14)', () => {
  it('two placements of one asset are separate bodies with their own matrices', async () => {
    const s = await stationScene();
    const tableA = find(s.rootA, 'Table');
    const tableB = find(s.rootB, 'Table');
    s.manager.register(tableA, 'Machine');
    s.manager.register(tableB, 'Machine');
    s.manager.update(DT);
    const ba = s.manager.bodies.find((x) => x.root === tableA)!;
    const bb = s.manager.bodies.find((x) => x.root === tableB)!;
    expect(ba.parts).toHaveLength(1);
    expect(bb.parts).toHaveLength(1);
    expect(ba.parts[0].mesh).not.toBe(bb.parts[0].mesh);
    expect(ba.parts[0].mesh.geometry).toBe(bb.parts[0].mesh.geometry);     // shared chunk geometry
    expect(bb.parts[0].world[12] - ba.parts[0].world[12]).toBeCloseTo(10, 6);

    s.probe.position.set(10.3, 0.1, 0.2);            // into table B only
    s.manager.update(DT);
    expect(s.manager.activePairs).toHaveLength(1);
    expect(s.manager.activePairs[0].aKey + s.manager.activePairs[0].bKey).toContain('StationB');
  });

  it('a role inside a NESTED placement resolves per instance mesh', async () => {
    const s = await stationScene();
    const clamp = find(s.rootA, 'Clamp');           // lives in the nested instance
    expect(s.registry.placementOf(clamp)).toBe(find(s.rootA, 'FixtureA'));
    s.manager.register(clamp, 'Tool');
    s.manager.update(DT);
    const body = s.manager.bodies.find((x) => x.root === clamp)!;
    expect(body.parts).toHaveLength(1);
    expect(s.nested.chunks).toContain(body.parts[0].mesh);

    s.probe.position.set(0.6, 0.45, 0.1);            // into the clamp (mount at x 0.5, clamp y 0.4)
    s.manager.update(DT);
    expect(reported(s.manager)).toHaveLength(1);
  });

  it('a role on the OUTER placement root includes the nested placement whole', async () => {
    const s = await stationScene();
    s.manager.register(s.rootA, 'Machine');
    s.manager.rebuild();
    const body = s.manager.bodies.find((x) => x.root === s.rootA)!;
    const meshes = body.parts.map((p) => p.mesh);
    for (const m of s.a.chunks) expect(meshes).toContain(m);
    for (const m of s.nested.chunks) expect(meshes).toContain(m);
  });

  it('releasing a placement (onRelease) and layout-content-added invalidate the bodies', async () => {
    const s = await stationScene();
    const listeners = new Map<CollisionViewerEvent, Set<() => void>>();
    s.manager.attachEvents((ev, cb) => {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev)!.add(cb);
      return () => { listeners.get(ev)!.delete(cb); };
    });
    const tableB = find(s.rootB, 'Table');
    s.manager.register(tableB, 'Machine');
    s.manager.update(DT);
    expect(s.manager.bodies.find((x) => x.root === tableB)!.parts).toHaveLength(1);

    s.registry.release(s.b);                         // the registry's release listener fires
    expect(s.manager.isDirty).toBe(true);
    s.manager.update(DT);
    expect(s.manager.bodies.find((x) => x.root === tableB)!.parts).toHaveLength(0);

    for (const cb of listeners.get('layout-content-added') ?? []) cb();
    expect(s.manager.isDirty).toBe(true);
    s.manager.clear();                               // drops the release listener too
    s.registry.release(s.a);
    expect(s.manager.isDirty).toBe(true);            // clear() leaves it dirty by itself …
    s.manager.update(DT);
    expect(s.manager.isDirty).toBe(false);
    s.registry.release(s.nested);
    expect(s.manager.isDirty).toBe(false);           // … and no listener is left behind
  });
});
