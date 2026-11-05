// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-637 — SyncTracker: only changed node indices, rate gate, no per-frame
 * allocation, full state, MU spawn with the template of the SOURCE OBJECT
 * (two sources of the same name), pre-placed MU moved not spawned, MU world
 * pose across grip / release, instanced MU from the pool accessors (stale
 * instance matrix, slot shift after a delete).
 */

import { describe, it, expect } from 'vitest';
import { BoxGeometry, Matrix4, Mesh, MeshStandardMaterial, Object3D, Quaternion, Scene, Vector3 } from 'three';
import { RVMovingUnit, MUInstancePool } from '../src/core/engine/rv-mu';
import { RVSource } from '../src/core/engine/rv-source';
import { decodeMessage, type DecodedMessage } from '../src/plugins/usd-live-link/livesync-protocol';
import { RateGate, SyncTracker, collectTrackedIndices, type TrackedMu } from '../src/plugins/usd-live-link/sync-tracker';
import { buildTemplateTable, templateIndexOfMu } from '../src/core/usd/collect-stage-input';

const HALF = new Vector3(0.1, 0.1, 0.1);

function rig(opts: { preplaced?: Map<number, number>; mus?: TrackedMu[]; templateIndexOf?: (mu: TrackedMu) => number } = {}) {
  const scene = new Scene();
  const root = new Object3D(); root.name = 'Root';
  const a = new Object3D(); a.name = 'AxisA';
  const b = new Object3D(); b.name = 'AxisB';
  const fixed = new Object3D(); fixed.name = 'Fixed';
  scene.add(root); root.add(a, b, fixed);
  const nodes = [root, a, b, fixed];
  const sent: DecodedMessage[] = [];
  const mus: TrackedMu[] = opts.mus ?? [];
  const tracker = new SyncTracker({
    nodes,
    trackedIndices: [1, 2],
    mus: () => mus,
    templateIndexOf: opts.templateIndexOf ?? (() => 0),
    preplaced: opts.preplaced ?? new Map(),
    send: (bytes) => sent.push(decodeMessage(bytes.slice())),
  });
  return { scene, root, a, b, fixed, nodes, sent, mus, tracker };
}

const frames = (msgs: DecodedMessage[]) => msgs.filter((m): m is Extract<DecodedMessage, { type: 'frame' }> => m.type === 'frame');

describe('usd-live-link SyncTracker', () => {
  it('sends the full state first, then nothing while nothing moves', () => {
    const r = rig();
    expect(r.tracker.sample(1)).toBe(1);
    expect(frames(r.sent)[0].nodes.map((n) => n.index)).toEqual([1, 2]);
    r.sent.length = 0;
    expect(r.tracker.sample(1)).toBe(0);
    expect(r.sent).toEqual([]);
  });

  it('sends only the moved index, read from position (no updateMatrix needed)', () => {
    const r = rig();
    r.tracker.sample(1);
    r.sent.length = 0;
    r.b.position.set(0, 0.3, 0); // RVDrive writes position only; node.matrix is stale
    r.tracker.sample(1);
    const f = frames(r.sent);
    expect(f).toHaveLength(1);
    expect(f[0].nodes.map((n) => n.index)).toEqual([2]);
    expect(f[0].nodes[0].m[13]).toBeCloseTo(0.3, 6);
  });

  it('ignores changes below epsilon', () => {
    const r = rig();
    r.tracker.sample(1);
    r.sent.length = 0;
    r.a.position.x = 1e-8;
    expect(r.tracker.sample(1)).toBe(0);
  });

  it('requestFull re-sends every tracked node', () => {
    const r = rig();
    r.tracker.sample(1);
    r.sent.length = 0;
    r.tracker.requestFull();
    r.tracker.sample(2);
    const f = frames(r.sent)[0];
    expect(f.session).toBe(2);
    expect(f.nodes.map((n) => n.index)).toEqual([1, 2]);
  });

  it('RateGate: 30 samples per second at a 60 Hz tick', () => {
    const gate = new RateGate(30);
    let n = 0;
    for (let i = 0; i < 600; i++) if (gate.advance(1 / 60)) n++;
    expect(n).toBe(300);
    const g60 = new RateGate(60);
    let m = 0;
    for (let i = 0; i < 60; i++) if (g60.advance(1 / 60)) m++;
    expect(m).toBe(60);
  });

  it('reuses its frame buffer and allocates no MU entries in steady state', () => {
    const node = new Object3D();
    const r = rig();
    r.scene.add(node);
    const mu = new RVMovingUnit(node, 'Src', HALF);
    r.mus.push(mu as unknown as TrackedMu);
    r.tracker.sample(1);
    const buffer = r.tracker.frameWriter.buffer;
    const views = new Set<ArrayBufferLike>();
    const t = new SyncTracker({
      nodes: r.nodes, trackedIndices: [1, 2], mus: () => r.mus, templateIndexOf: () => 0, preplaced: new Map(),
      send: (bytes) => { if (bytes[0] === 3) views.add(bytes.buffer); },
    });
    t.sample(1);
    for (let i = 0; i < 50; i++) {
      r.a.position.x = i * 0.01;
      node.position.z = i * 0.01;
      r.tracker.sample(1);
      t.sample(1);
    }
    expect(r.tracker.frameWriter.buffer).toBe(buffer);
    // Every frame of 51 samples went out as a view on ONE buffer.
    expect(views.size).toBe(1);
  });

  it('MU spawn carries the template of the SOURCE OBJECT when two sources share a name', () => {
    const scene = new Scene();
    const tplA = new Mesh(new BoxGeometry(0.2, 0.2, 0.2), new MeshStandardMaterial()); tplA.name = 'BoxA';
    const tplB = new Mesh(new BoxGeometry(0.4, 0.4, 0.4), new MeshStandardMaterial()); tplB.name = 'BoxB';
    // Multi-mesh templates take the clone path (single meshes would instance).
    tplA.add(new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshStandardMaterial()));
    tplB.add(new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshStandardMaterial()));
    const n1 = new Object3D(); n1.name = 'Source';
    const n2 = new Object3D(); n2.name = 'Source';
    scene.add(tplA, tplB, n1, n2);
    const s1 = new RVSource(n1);
    const s2 = new RVSource(n2);
    for (const [s, t] of [[s1, tplA], [s2, tplB]] as const) {
      s.spawnParent = scene;
      s.setTemplate(t);
    }
    const table = buildTemplateTable([s1, s2]);
    expect(table.templates).toEqual([tplA, tplB]);
    const mu2 = s2.spawnMU()!;
    const mu1 = s1.spawnMU()!;
    const paths = ['/Root/Scenes/Scene/BoxA', '/Root/Scenes/Scene/BoxB'];
    expect(templateIndexOfMu(mu1, table.bySource, paths)).toBe(0);
    expect(templateIndexOfMu(mu2, table.bySource, paths)).toBe(1);
    expect(templateIndexOfMu({}, table.bySource, paths)).toBe(-1);

    const r = rig({ mus: [mu1, mu2] as unknown as TrackedMu[], templateIndexOf: (mu) => templateIndexOfMu(mu, table.bySource, paths) });
    r.tracker.sample(1);
    const spawns = r.sent.filter((m) => m.type === 'muSpawn');
    expect(spawns.map((m) => m.type === 'muSpawn' && [m.muId, m.templateIndex])).toEqual([[mu1.id, 0], [mu2.id, 1]]);
  });

  it('a pre-placed MU is moved, never spawned; deleted only once its node left the scene', () => {
    const node = new Object3D();
    const r = rig();
    r.root.add(node);
    r.nodes.push(node);
    const mu = new RVMovingUnit(node, '', HALF);
    const pre = new Map([[mu.id, 4]]);
    const t = new SyncTracker({
      nodes: r.nodes, trackedIndices: [1, 2], mus: () => r.mus, templateIndexOf: () => 0, preplaced: pre,
      send: (bytes) => r.sent.push(decodeMessage(bytes.slice())),
    });
    r.mus.push(mu as unknown as TrackedMu);
    node.position.set(1, 2, 3);
    t.sample(1);
    expect(r.sent.some((m) => m.type === 'muSpawn')).toBe(false);
    const f = frames(r.sent)[0];
    expect(f.mus.map((m) => m.muId)).toEqual([mu.id]);
    expect(f.mus[0].m.slice(12, 15)).toEqual([1, 2, 3]);
    // Inactive but still standing: no delete.
    r.sent.length = 0;
    r.mus.length = 0;
    t.sample(1);
    expect(r.sent.some((m) => m.type === 'muDelete')).toBe(false);
    // Back on the line, then sunk (detached): delete.
    r.mus.push(mu as unknown as TrackedMu);
    t.sample(1);
    r.mus.length = 0;
    node.removeFromParent();
    r.sent.length = 0;
    t.sample(1);
    expect(r.sent.filter((m) => m.type === 'muDelete').map((m) => m.type === 'muDelete' && m.muId)).toEqual([mu.id]);
  });

  it('pick-and-place: MU world pose follows the gripper and stays right after release', () => {
    const r = rig();
    const gripper = new Object3D();
    r.root.add(gripper);
    const muNode = new Object3D();
    r.scene.add(muNode);
    muNode.position.set(1, 0, 0);
    const mu = new RVMovingUnit(muNode, 'S', HALF);
    r.mus.push(mu as unknown as TrackedMu);
    r.tracker.sample(1);
    // Grip: re-parent under the gripper, keep the world pose.
    gripper.position.set(0, 1, 0);
    gripper.updateMatrixWorld(true);
    gripper.attach(muNode);
    // The gripper moves; nobody renders (matrixWorld stale).
    gripper.position.set(0, 2, 0.5);
    r.sent.length = 0;
    r.tracker.sample(1);
    const expected = new Vector3(1, 1, 0.5); // world (1,0,0) + gripper delta (0,1,0.5)
    const f = frames(r.sent)[0];
    const m = f.mus.find((x) => x.muId === mu.id)!.m;
    expect(m[12]).toBeCloseTo(expected.x, 5);
    expect(m[13]).toBeCloseTo(expected.y, 5);
    expect(m[14]).toBeCloseTo(expected.z, 5);
    // Release: back to the scene, same world pose — no MU change sent.
    r.scene.attach(muNode);
    r.sent.length = 0;
    r.tracker.sample(1);
    expect(frames(r.sent).flatMap((x) => x.mus)).toEqual([]);
  });

  it('instanced MUs: pose from the pool accessors, also with a stale instance matrix and after a slot shift', () => {
    const r = rig();
    const pool = new MUInstancePool(new BoxGeometry(0.2, 0.2, 0.2), new MeshStandardMaterial(), 'Box', HALF);
    r.scene.add(pool.instancedMesh);
    const q = new Quaternion();
    const m0 = pool.spawn(new Vector3(0, 0, 0), q, 'a', 'S');
    const m1 = pool.spawn(new Vector3(1, 0, 0), q, 'b', 'S');
    const m2 = pool.spawn(new Vector3(2, 0, 0), q, 'c', 'S');
    // GPU compute path: the CPU instance matrices are stale garbage.
    const junk = new Matrix4().makeTranslation(99, 99, 99);
    for (let i = 0; i < 3; i++) pool.instancedMesh.setMatrixAt(i, junk);
    r.mus.push(...([m0, m1, m2] as unknown as TrackedMu[]));
    r.tracker.sample(1);
    const spawnX = new Map(r.sent.filter((m) => m.type === 'muSpawn').map((m) => [m.type === 'muSpawn' ? m.muId : 0, m.type === 'muSpawn' ? m.m[12] : 0]));
    expect(spawnX.get(m0.id)).toBeCloseTo(0);
    expect(spawnX.get(m1.id)).toBeCloseTo(1);
    expect(spawnX.get(m2.id)).toBeCloseTo(2);
    // Delete the middle one: m2 swaps into slot 1 but keeps ITS pose and id.
    m1.dispose();
    r.mus.splice(1, 1);
    expect(m2.slotIndex).toBe(1);
    m2.setPosition(new Vector3(2.5, 0, 0));
    r.sent.length = 0;
    r.tracker.sample(1);
    expect(r.sent.find((m) => m.type === 'muDelete')).toMatchObject({ muId: m1.id });
    const f = frames(r.sent)[0];
    expect(f.mus.map((x) => x.muId)).toEqual([m2.id]);
    expect(f.mus[0].m[12]).toBeCloseTo(2.5);
  });

  it('collectTrackedIndices: drive nodes + subtree in the snapshot, never the root', () => {
    const root = new Object3D();
    const drive = new Object3D();
    const child = new Object3D();
    const outside = new Object3D();
    root.add(drive, outside); drive.add(child);
    const indexOf = new Map<Object3D, number>([[root, 0], [drive, 1], [child, 2], [outside, 3]]);
    expect(collectTrackedIndices([drive, root], indexOf)).toEqual([1, 2, 3]);
    expect(collectTrackedIndices([drive], indexOf)).toEqual([1, 2]);
  });
});
