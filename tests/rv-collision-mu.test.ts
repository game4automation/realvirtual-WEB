// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-394 §9.8 / plan-781 §9.5 / 9.8b — spawned MUs.
 *
 * Since plan-781 MUs are checked with EXACT triangles (F8): a clone MU through
 * its own meshes (shared geometry → one shared KeepPick), an instanced MU
 * through the pool's template geometry posed by its SLOT. Every instance of an
 * `InstancedMesh` pool shares ONE `node.matrixWorld`, so that matrix alone would
 * put every instance in the same place (the plan-394 trap).
 *
 * MU bodies come and go INCREMENTALLY (F9): a spawn appends one body and its
 * pairs, a removal drops them (swap-and-pop) — deferred to the next tick head
 * (F18), never a full rebuild. MU × node pairs go through the transport's MU
 * grid when one is installed.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BoxGeometry, InstancedMesh, MeshBasicMaterial, Object3D, TorusGeometry, Vector3, Mesh } from 'three';
import type { BufferGeometry } from 'three';
import { RVCollisionManager, bodyPairKey, type CollisionMU, type CollisionMUQuery } from '../src/core/engine/rv-collision-manager';
import { KEEP_BRUTE_TRIS } from '../src/core/engine/rv-pick-backend';
import type { IMUAccessor } from '../src/core/engine/rv-mu';
import { FakeMU, FakeHighlightHost, boxMesh, bakeCollisionScene, bodyNode, plainGroup } from './collision-fixture';
import { __resetCollisionAlertStore } from '../src/core/hmi/collision-alert-store';

const DT = 1 / 60;
const HALF = new Vector3(0.5, 0.5, 0.5);
const MAT = new MeshBasicMaterial();

/** A baked machine body (static, 2 m) at the origin. */
async function machineScene(size: [number, number, number] = [2, 2, 2]) {
  const s = await bakeCollisionScene(plainGroup('Asset', bodyNode('Machine', { role: 'Machine', size })));
  const machine = s.node('Machine');
  s.manager.register(machine, 'Machine');
  return { ...s, machine };
}

/** One pool InstancedMesh, root-parented like the real pools. */
function pool(scene: import('three').Scene, geometry: BufferGeometry = new BoxGeometry(1, 0.8, 0.8), count = 16): InstancedMesh {
  const mesh = new InstancedMesh(geometry, MAT, count);
  mesh.name = 'MUPool';
  scene.add(mesh);
  mesh.updateMatrixWorld(true);
  return mesh;
}

function instanced(id: number, p: InstancedMesh, x: number, y = 0, z = 0): FakeMU {
  const mu = new FakeMU(id, p, HALF, true);
  mu.moveTo(x, y, z);
  return mu;
}

function clone(id: number, scene: import('three').Scene, mesh: Mesh, x: number, y = 0, z = 0): FakeMU {
  const node = new Object3D();
  node.name = `Part${id}`;
  node.add(mesh);
  scene.add(node);
  const mu = new FakeMU(id, node, HALF, false);
  mu.moveTo(x, y, z);
  return mu;
}

function reported(m: RVCollisionManager): string[] {
  return m.activePairs.map((p) => [p.aPath, p.bPath].sort().join('|')).sort();
}

const asMU = (m: FakeMU): CollisionMU => m as unknown as CollisionMU;

beforeEach(() => __resetCollisionAlertStore());

describe('spawned MUs', () => {
  it('registers a spawned MU with the role configured on its source', async () => {
    const s = await machineScene();
    const mu = instanced(1, pool(s.scene), 5);
    s.manager.onMUSpawned(asMU(mu), 'Workpiece');
    s.manager.rebuild();
    const body = s.manager.bodies.find((b) => b.kind === 'mu');
    expect(body?.role).toBe('Workpiece');
    expect(s.manager.pairs).toHaveLength(1);
  });

  it('ignores a spawn whose source role is None (default)', async () => {
    const s = await machineScene();
    const mu = instanced(1, pool(s.scene), 5);
    s.manager.onMUSpawned(asMU(mu), 'None');
    s.manager.onMUSpawned(asMU(mu), undefined);
    s.manager.update(DT);
    expect(s.manager.bodies.filter((b) => b.kind === 'mu')).toHaveLength(0);
  });

  it('spawn and removal change the pair list WITHOUT a rebuild (F9)', async () => {
    const s = await machineScene();
    const p = pool(s.scene);
    s.manager.update(DT);
    const rebuild = vi.spyOn(s.manager, 'rebuild');
    const a = instanced(1, p, 5);
    const b = instanced(2, p, 8);
    s.manager.onMUSpawned(asMU(a), 'Workpiece');
    s.manager.onMUSpawned(asMU(b), 'Tool');
    expect(s.manager.pairs).toHaveLength(0);        // deferred to the tick head (F18)
    s.manager.update(DT);
    // Workpiece↔Machine, Tool↔Machine, Tool↔Workpiece.
    expect(s.manager.pairs).toHaveLength(3);
    s.manager.onMURemoved(asMU(a));
    s.manager.update(DT);
    expect(s.manager.bodies.filter((x) => x.kind === 'mu')).toHaveLength(1);
    expect(s.manager.pairs).toHaveLength(1);
    expect(rebuild).not.toHaveBeenCalled();
    // Swap-and-pop kept every index consistent.
    for (const pr of s.manager.pairs) {
      expect(pr.pairKey).toBe(bodyPairKey(s.manager.bodies[pr.i].key, s.manager.bodies[pr.j].key));
    }
  });

  it('an instanced MU is exact through its slot pose; two instances of one pool are independent', async () => {
    const s = await machineScene();
    const p = pool(s.scene);
    p.position.set(50, 0, 0);                        // the pool mesh itself sits far away
    p.updateMatrixWorld(true);
    const near = instanced(1, p, -45);               // slot pose is relative to the pool mesh
    const far = instanced(2, p, -20);
    s.manager.onMUSpawned(asMU(near), 'Workpiece');
    s.manager.onMUSpawned(asMU(far), 'Workpiece');
    s.manager.update(DT);                            // both apart → armed
    expect(reported(s.manager)).toEqual([]);

    near.moveTo(-49.4, 0.1, 0.05);                   // world x = 0.6: through the machine's face
    s.manager.update(DT);
    expect(reported(s.manager)).toEqual([`Machine|${near.getName()}`].sort());
    const body = s.manager.bodies.find((b) => b.mu === asMU(near))!;
    expect(body.parts).toHaveLength(1);
    expect(body.parts[0].kind).toBe('mu-instance');
  });

  it('an instance whose box only TOUCHES the machine is no collision; a mirrored pool stays exact', async () => {
    const s = await machineScene();
    const p = pool(s.scene);
    const mu = instanced(1, p, 5);
    s.manager.onMUSpawned(asMU(mu), 'Workpiece');
    s.manager.update(DT);
    mu.moveTo(1.5, 0, 0);                            // face to face at x = 1 (0.5 + 1.0)
    s.manager.update(DT);
    expect(reported(s.manager)).toEqual([]);

    // A mirrored pool (det < 0) — the triangle test is winding-independent.
    const s2 = await machineScene();
    const pm = pool(s2.scene);
    pm.scale.set(-1, 1, 1);
    pm.updateMatrixWorld(true);
    const m2 = instanced(2, pm, -5);
    s2.manager.onMUSpawned(asMU(m2), 'Workpiece');
    s2.manager.update(DT);
    m2.moveTo(-1.3, 0.1, 0);                         // world x = +1.3 → through the face
    s2.manager.update(DT);
    expect(reported(s2.manager)).toEqual([`Machine|${m2.getName()}`].sort());
  });

  it('a clone MU gets exact triangles: a torus around a rod does not collide until its tube touches', async () => {
    const s = await machineScene([0.1, 0.1, 4]);     // the "machine" is a thin rod along z
    const torus = new Mesh(new TorusGeometry(1, 0.15, 12, 48), MAT);
    const mu = clone(7, s.scene, torus, 0, 5, 0);
    s.manager.onMUSpawned(asMU(mu), 'Workpiece');
    s.manager.update(DT);
    mu.moveTo(0, 0, 0);                              // the rod runs through the hole
    s.manager.update(DT);
    expect(reported(s.manager)).toEqual([]);
    mu.moveTo(1, 0, 0);                              // the tube now crosses the rod
    s.manager.update(DT);
    expect(reported(s.manager)).toEqual(['Machine|mu#7']);
    const body = s.manager.bodies.find((b) => b.mu === asMU(mu))!;
    expect(body.parts.map((p) => p.mesh)).toEqual([torus]);
    expect(body.parts[0].pick).not.toBeNull();       // > KEEP_BRUTE_TRIS → its KeepPick
  });

  it('small, non-indexed and Uint16 templates take the brute-force path and stay exact', async () => {
    for (const make of [
      () => new BoxGeometry(1, 0.8, 0.8),                     // 12 tris, Uint16 index
      () => new BoxGeometry(1, 0.8, 0.8).toNonIndexed(),      // implicit index
    ]) {
      __resetCollisionAlertStore();
      const s = await machineScene();
      const geo = make();
      const tris = (geo.index ? geo.index.count : geo.getAttribute('position').count) / 3;
      expect(tris).toBeLessThanOrEqual(KEEP_BRUTE_TRIS);
      const mu = instanced(1, pool(s.scene, geo), 5);
      s.manager.onMUSpawned(asMU(mu), 'Workpiece');
      s.manager.update(DT);
      expect(s.manager.bodies.find((b) => b.kind === 'mu')!.parts[0].pick).toBeNull();
      mu.moveTo(1.3, 0.1, 0);
      s.manager.update(DT);
      expect(reported(s.manager)).toHaveLength(1);
    }
  });

  it('remembered pair states of removed MUs are pruned across rebuilds (review #4)', async () => {
    const s = await machineScene();
    const p = pool(s.scene, new BoxGeometry(1, 0.8, 0.8), 64);
    s.manager.update(DT);
    let id = 1;
    const sizes: number[] = [];
    for (let round = 0; round < 20; round++) {
      // Spawn 3, tick (pairs exist), then remove them WHILE a rebuild is
      // pending — the removal goes through rebuild(), which used to copy the
      // dead pairs into the memory and never drop them.
      const batch = [instanced(id++, p, 5), instanced(id++, p, 8), instanced(id++, p, 11)];
      for (const mu of batch) s.manager.onMUSpawned(asMU(mu), 'Workpiece');
      s.manager.update(DT);
      expect(s.manager.pairs.length).toBe(3);
      s.manager.invalidate();
      for (const mu of batch) s.manager.onMURemoved(asMU(mu));
      s.manager.update(DT);
      sizes.push(s.manager.pairMemorySize);
    }
    expect(s.manager.bodies.filter((b) => b.kind === 'mu')).toHaveLength(0);
    // Bounded: no entry per dead MU survives — 60 MUs spawned and removed.
    expect(Math.max(...sizes)).toBeLessThanOrEqual(3);
    expect(s.manager.pairMemorySize).toBe(0);
  });

  it('a reused pool slot gets no stale motion stamp (stamps are per MU, never per slot)', async () => {
    const s = await machineScene();
    const p = pool(s.scene);
    const a = instanced(1, p, 5);
    s.manager.onMUSpawned(asMU(a), 'Workpiece');
    s.manager.update(DT);
    s.manager.onMURemoved(asMU(a));
    s.manager.update(DT);
    const b = instanced(2, p, 9);                    // the same slot, somewhere else
    s.manager.onMUSpawned(asMU(b), 'Workpiece');
    s.manager.update(DT);
    const body = s.manager.bodies.find((x) => x.mu === asMU(b))!;
    expect(body.moved).toBe(false);
    expect(body.parts[0].lastMatrix[12]).toBeCloseTo(9, 6);
  });

  it('a removal during a tick is applied at the next tick head; latches and indices stay consistent (F18)', async () => {
    const s = await machineScene();
    const p = pool(s.scene);
    const victim = instanced(1, p, 5);
    const other = instanced(2, p, 8);
    s.manager.onMUSpawned(asMU(victim), 'Workpiece');
    s.manager.onMUSpawned(asMU(other), 'Tool');
    s.manager.update(DT);
    // The highlight host fires INSIDE the tick — remove the MU from there.
    let removedInside = false;
    s.manager.setHighlightHost({
      showCollision: () => {
        if (!removedInside) { removedInside = true; s.manager.onMURemoved(asMU(victim)); }
      },
      hideCollision: () => {},
    });
    victim.moveTo(1.3, 0.1, 0);
    s.manager.update(DT);
    expect(removedInside).toBe(true);
    expect(s.manager.bodies.some((b) => b.mu === asMU(victim))).toBe(true);    // still there this tick
    s.manager.update(DT);
    expect(s.manager.bodies.some((b) => b.mu === asMU(victim))).toBe(false);
    expect(s.manager.activePairs).toHaveLength(1);                             // the latch stays
    for (const pr of s.manager.pairs) {
      expect(pr.pairKey).toBe(bodyPairKey(s.manager.bodies[pr.i].key, s.manager.bodies[pr.j].key));
    }
  });

  it('the MU grid prunes MU × node pairs: an MU outside the box is never tested (counter)', async () => {
    const s = await machineScene();
    const p = pool(s.scene);
    const mus: FakeMU[] = [];
    for (let i = 0; i < 10; i++) mus.push(instanced(i + 1, p, i === 0 ? 3 : 20 + i * 3));
    for (const mu of mus) s.manager.onMUSpawned(asMU(mu), 'Workpiece');
    const query: CollisionMUQuery = {
      queryMUsXZ(min, max, out: IMUAccessor[]): number {
        out.length = 0;
        for (const mu of mus) {
          const a = mu.aabb;
          if (a.max.x < min[0] || a.min.x > max[0] || a.max.z < min[2] || a.min.z > max[2]) continue;
          out.push(mu as unknown as IMUAccessor);
        }
        return out.length;
      },
    };
    s.manager.setMUQuery(query);
    s.manager.update(DT);
    s.manager.resetCounters();
    for (const [i, mu] of mus.entries()) mu.moveTo(i === 0 ? 1.3 : 20 + i * 3 + 0.1, 0.1, 0);   // all move
    s.manager.update(DT);
    expect(s.manager.counters.gridQueries).toBe(1);
    expect(s.manager.counters.gridSkipped).toBe(9);
    expect(s.manager.counters.pairsEvaluated).toBe(1);
    expect(reported(s.manager)).toEqual([`Machine|${mus[0].getName()}`].sort());
  });

  it('never puts the shared pool mesh into the highlight set', async () => {
    const s = await machineScene();
    const highlight = new FakeHighlightHost();
    s.manager.setHighlightHost(highlight);
    const p = pool(s.scene);
    const near = instanced(1, p, 5);
    s.manager.onMUSpawned(asMU(near), 'Workpiece');
    s.manager.update(DT);
    near.moveTo(1.3, 0.1, 0);
    s.manager.update(DT);
    expect(highlight.current).not.toBeNull();
    expect(highlight.current).not.toContain(p);
    expect(highlight.current).toContain(s.machine);
  });

  it('a gripped clone MU is skipped while it hangs under the gripper body (F16, unchanged)', async () => {
    const s = await machineScene();
    const gripper = new Object3D();
    gripper.name = 'Gripper';
    gripper.add(boxMesh({ name: 'Jaw', size: [0.4, 0.4, 0.4] }));
    gripper.position.set(0, 5, 0);
    s.scene.add(gripper);
    s.manager.register(gripper, 'Tool');
    const mu = clone(3, s.scene, boxMesh({ name: 'PartMesh', size: [0.5, 0.5, 0.5] }), 0, 8, 0);
    s.manager.onMUSpawned(asMU(mu), 'Workpiece');
    s.manager.update(DT);
    const key = (n: string) => s.manager.bodies.find((b) => b.label === n)!.key;
    expect(s.manager.pairStateOf(key('Gripper'), key('mu#3'))).not.toBeNull();
    gripper.attach(mu.node);                         // the grip re-parents the MU …
    s.manager.invalidate();                          // … and invalidates (RVGrip)
    s.manager.update(DT);
    expect(s.manager.pairStateOf(key('Gripper'), key('mu#3'))).toBeNull();
  });

  // ── plan-409 §9.3 — the Cutter role on the MU path (F2). ──────────────

  it('registers a spawned MU with CollisionRoleForMUs = Cutter', async () => {
    const s = await machineScene();
    const mu = instanced(1, pool(s.scene), 5);
    s.manager.onMUSpawned(asMU(mu), 'Cutter');
    s.manager.update(DT);
    const body = s.manager.bodies.find((b) => b.kind === 'mu');
    expect(body?.role).toBe('Cutter');
    expect(s.manager.pairs).toHaveLength(1);      // Cutter ↔ Machine
  });

  it('pairs an MU cutter against Workpiece and Machine but never against another cutter', async () => {
    const s = await bakeCollisionScene(plainGroup('Asset',
      bodyNode('Machine', { role: 'Machine', size: [2, 2, 2] }),
      bodyNode('Workpiece', { role: 'Workpiece', size: [2, 2, 2], at: [5, 0, 0] }),
    ));
    s.manager.register(s.node('Machine'), 'Machine');
    s.manager.register(s.node('Workpiece'), 'Workpiece');
    const p = pool(s.scene);
    s.manager.onMUSpawned(asMU(instanced(1, p, 9)), 'Cutter');
    s.manager.onMUSpawned(asMU(instanced(2, p, 12)), 'Cutter');
    s.manager.update(DT);

    const roles = s.manager.pairs.map((pr) =>
      [s.manager.bodies[pr.i].role, s.manager.bodies[pr.j].role].sort().join('|'));
    expect(roles).not.toContain('Cutter|Cutter');
    expect(roles.filter((r) => r === 'Cutter|Machine')).toHaveLength(2);
    expect(roles.filter((r) => r === 'Cutter|Workpiece')).toHaveLength(2);
  });

  it('reports and then cleanly removes an MU cutter that cuts into the machine', async () => {
    const s = await machineScene();
    const mu = clone(9, s.scene, boxMesh({ name: 'InsertMesh', size: [1, 0.8, 0.8] }), 4, 0, 0);
    s.manager.onMUSpawned(asMU(mu), 'Cutter');
    s.manager.update(DT);
    mu.moveTo(1.4, 0.1, 0);
    s.manager.update(DT);
    expect(s.manager.activePairs.some((p) => p.aRole === 'Cutter' || p.bRole === 'Cutter')).toBe(true);

    s.manager.onMURemoved(asMU(mu));
    s.manager.update(DT);
    expect(s.manager.bodies.filter((b) => b.kind === 'mu')).toHaveLength(0);
  });

  it('drops every MU body on clear (model change)', async () => {
    const s = await machineScene();
    const mu = instanced(1, pool(s.scene), 5);
    s.manager.onMUSpawned(asMU(mu), 'Workpiece');
    s.manager.update(DT);
    s.manager.clear();
    s.manager.update(DT);
    expect(s.manager.bodies).toHaveLength(0);
  });
});
