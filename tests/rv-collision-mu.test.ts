// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-394 §9.8 — spawned MUs (F13).
 *
 * The per-instance box test is the third regression test of the plan: every
 * instance of an `InstancedMesh` pool shares ONE `node.matrixWorld`, so a box
 * derived from that matrix would put an MU at the far end of the line inside
 * the machine as well. The world box therefore comes from `IMUAccessor.aabb`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InstancedMesh, Object3D, Scene, Vector3, BoxGeometry, MeshBasicMaterial } from 'three';
import { RVCollisionManager, type CollisionMU } from '../src/core/engine/rv-collision-manager';
import { FakeMU, FakeHighlightHost, boxMesh } from './collision-fixture';
import { __resetCollisionAlertStore } from '../src/core/hmi/collision-alert-store';

const DT = 1 / 60;
const HALF = new Vector3(0.5, 0.5, 0.5);

/** A machine body standing at the origin. */
function machineScene() {
  const scene = new Scene();
  const machine = new Object3D();
  machine.name = 'Machine';
  machine.add(boxMesh({ name: 'Frame', size: [2, 2, 2] }));
  scene.add(machine);
  scene.updateMatrixWorld(true);
  const manager = new RVCollisionManager();
  manager.setHighlightHost(new FakeHighlightHost());
  manager.register(machine, 'Machine');
  return { scene, machine, manager };
}

/** Two MUs backed by ONE shared InstancedMesh — the §2.8 trap. */
function twoMUsFromOnePool(scene: Scene): { near: FakeMU; far: FakeMU; pool: InstancedMesh } {
  const pool = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial(), 2);
  pool.name = 'MUPool';
  // The pool mesh itself sits far away — if the manager used its matrixWorld,
  // BOTH instances would be reported at this one place.
  pool.position.set(50, 0, 0);
  scene.add(pool);
  scene.updateMatrixWorld(true);

  const near = new FakeMU(1, pool, HALF, true);
  const far = new FakeMU(2, pool, HALF, true);
  near.moveTo(0, 0, 0);        // inside the machine
  far.moveTo(30, 0, 0);        // far away
  return { near, far, pool };
}

beforeEach(() => __resetCollisionAlertStore());

describe('spawned MUs', () => {
  it('registers a spawned MU with the role configured on its source', () => {
    const s = machineScene();
    const mu = new FakeMU(1, new Object3D(), HALF, true);
    mu.moveTo(0, 0, 0);
    s.manager.onMUSpawned(mu as unknown as CollisionMU, 'Workpiece');
    s.manager.rebuild();
    const body = s.manager.bodies.find((b) => b.kind === 'mu');
    expect(body?.role).toBe('Workpiece');
    expect(s.manager.pairs).toHaveLength(1);
  });

  it('ignores a spawn whose source role is None (default)', () => {
    const s = machineScene();
    const mu = new FakeMU(1, new Object3D(), HALF, true);
    s.manager.onMUSpawned(mu as unknown as CollisionMU, 'None');
    s.manager.onMUSpawned(mu as unknown as CollisionMU, undefined);
    s.manager.rebuild();
    expect(s.manager.bodies.filter((b) => b.kind === 'mu')).toHaveLength(0);
  });

  it('unregisters the MU when the sink removes it (swap-and-pop path)', () => {
    const s = machineScene();
    const mu = new FakeMU(1, new Object3D(), HALF, true);
    mu.moveTo(0, 0, 0);
    s.manager.onMUSpawned(mu as unknown as CollisionMU, 'Workpiece');
    s.manager.update(DT);
    expect(s.manager.bodies.filter((b) => b.kind === 'mu')).toHaveLength(1);

    s.manager.onMURemoved(mu as unknown as CollisionMU);
    s.manager.update(DT);
    expect(s.manager.bodies.filter((b) => b.kind === 'mu')).toHaveLength(0);
  });

  it('treats instanced MUs as aabbOnly (F14)', () => {
    const s = machineScene();
    const { near } = twoMUsFromOnePool(s.scene);
    s.manager.onMUSpawned(near as unknown as CollisionMU, 'Workpiece');
    s.manager.rebuild();
    const body = s.manager.bodies.find((b) => b.kind === 'mu');
    expect(body?.aabbOnly).toBe(true);
    expect(body?.meshes).toHaveLength(0);
  });

  it('gives each instance of one pool its own world box (F13)', () => {
    const s = machineScene();
    const { near, far } = twoMUsFromOnePool(s.scene);
    s.manager.onMUSpawned(near as unknown as CollisionMU, 'Workpiece');
    s.manager.onMUSpawned(far as unknown as CollisionMU, 'Workpiece');

    s.manager.update(DT);
    const reported = s.manager.activePairs.map((p) => [p.aPath, p.bPath].sort().join('|'));
    expect(reported).toContain(['Machine', near.getName()].sort().join('|'));
    expect(reported).not.toContain(['Machine', far.getName()].sort().join('|'));
    expect(reported).toHaveLength(1);
  });

  it('never puts the shared pool mesh into the highlight set', () => {
    const s = machineScene();
    const highlight = new FakeHighlightHost();
    s.manager.setHighlightHost(highlight);
    const { near, pool } = twoMUsFromOnePool(s.scene);
    s.manager.onMUSpawned(near as unknown as CollisionMU, 'Workpiece');
    s.manager.update(DT);
    expect(highlight.current).not.toBeNull();
    expect(highlight.current).not.toContain(pool);
    expect(highlight.current).toContain(s.machine);
  });

  it('uses the exact narrowphase for a non-instanced (clone) MU', () => {
    const s = machineScene();
    const node = new Object3D();
    node.name = 'Part';
    node.add(boxMesh({ name: 'PartMesh' }));
    s.scene.add(node);
    s.scene.updateMatrixWorld(true);

    const mu = new FakeMU(7, node, HALF, false);
    mu.moveTo(0, 0, 0);
    s.manager.onMUSpawned(mu as unknown as CollisionMU, 'Workpiece');
    s.manager.rebuild();
    const body = s.manager.bodies.find((b) => b.kind === 'mu');
    expect(body?.aabbOnly).toBe(false);
    expect(body?.meshes.map((m) => m.mesh.name)).toEqual(['PartMesh']);
  });

  // ── plan-409 §9.3 — the Cutter role on the MU path (F2). ──────────────
  //
  // A cutter can arrive as an MU (a tool magazine spawning inserts), so the
  // role must survive the whole spawn path. The MACHINING suppression
  // deliberately does NOT cover MU cutters in v1 — MachiningVolume.tools are
  // scene components, never MUs — so an MU cutter is simply always checked.

  it('registers a spawned MU with CollisionRoleForMUs = Cutter', () => {
    const s = machineScene();
    const mu = new FakeMU(1, new Object3D(), HALF, true);
    mu.moveTo(0, 0, 0);
    s.manager.onMUSpawned(mu as unknown as CollisionMU, 'Cutter');
    s.manager.rebuild();
    const body = s.manager.bodies.find((b) => b.kind === 'mu');
    expect(body?.role).toBe('Cutter');
    expect(s.manager.pairs).toHaveLength(1);      // Cutter ↔ Machine
  });

  it('pairs an MU cutter against Workpiece and Machine but never against another cutter', () => {
    const s = machineScene();
    // A second node body, role Workpiece, next to the machine.
    const workpiece = new Object3D();
    workpiece.name = 'Workpiece';
    workpiece.add(boxMesh({ name: 'Stock', size: [2, 2, 2] }));
    s.scene.add(workpiece);
    s.scene.updateMatrixWorld(true);
    s.manager.register(workpiece, 'Workpiece');

    const cutterA = new FakeMU(1, new Object3D(), HALF, true);
    const cutterB = new FakeMU(2, new Object3D(), HALF, true);
    cutterA.moveTo(0, 0, 0);
    cutterB.moveTo(0, 0, 0);
    s.manager.onMUSpawned(cutterA as unknown as CollisionMU, 'Cutter');
    s.manager.onMUSpawned(cutterB as unknown as CollisionMU, 'Cutter');
    s.manager.rebuild();

    const roles = s.manager.pairs.map((p) =>
      [s.manager.bodies[p.i].role, s.manager.bodies[p.j].role].sort().join('|'));
    expect(roles).not.toContain('Cutter|Cutter');
    expect(roles.filter((r) => r === 'Cutter|Machine')).toHaveLength(2);
    expect(roles.filter((r) => r === 'Cutter|Workpiece')).toHaveLength(2);
  });

  it('reports and then cleanly removes an MU cutter that touches the machine', () => {
    const s = machineScene();
    const node = new Object3D();
    node.name = 'Insert';
    node.position.set(1.4, 0, 0);
    node.add(boxMesh({ name: 'InsertMesh' }));
    s.scene.add(node);
    s.scene.updateMatrixWorld(true);

    // Partially overlapping, NOT contained: the narrowphase is an exact
    // triangle-against-triangle test, and a box fully inside another box has no
    // triangle crossing at all.
    const mu = new FakeMU(9, node, HALF, false);
    mu.moveTo(1.4, 0, 0);
    s.manager.onMUSpawned(mu as unknown as CollisionMU, 'Cutter');
    s.manager.update(DT);
    expect(s.manager.activePairs.some((p) => p.aRole === 'Cutter' || p.bRole === 'Cutter')).toBe(true);

    s.manager.onMURemoved(mu as unknown as CollisionMU);
    s.manager.update(DT);
    expect(s.manager.bodies.filter((b) => b.kind === 'mu')).toHaveLength(0);
  });

  it('drops every MU body on clear (model change)', () => {
    const s = machineScene();
    const mu = new FakeMU(1, new Object3D(), HALF, true);
    mu.moveTo(0, 0, 0);
    s.manager.onMUSpawned(mu as unknown as CollisionMU, 'Workpiece');
    s.manager.update(DT);
    s.manager.clear();
    s.manager.update(DT);
    expect(s.manager.bodies).toHaveLength(0);
  });
});
