// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * grip-place-on-carrier.test.ts — plan-577 §9.2: `GripTarget.LoadOnCarrier`.
 *
 * At a `LoadOnCarrier` target a Grip aligns the part (with everything it
 * carries) at the target pose and decides in ONE step (§2.4):
 *  - exactly one MU it rests on, nothing else in the way → load of that MU,
 *    the target stays free;
 *  - any other overlap of the moving tree with a foreign MU, or two MUs it
 *    would rest on (ambiguous) → refused: the part stays in the grip with its
 *    pose, a "seat occupied" warning (one per grip + target);
 *  - nothing below and nothing in the way → classic target placement.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { RVGrip } from '../src/core/engine/rv-grip';
import { RVGripTarget } from '../src/core/engine/rv-grip-target';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { RVZone } from '../src/core/engine/rv-zone';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { isInLoadTree } from '../src/core/engine/rv-mu-load';
import type { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';
import {
  getProblems, resetProblemsForTests, SEAT_OCCUPIED_CODE,
} from '../src/core/hmi/problems-store';
import {
  CAP_SINK, PALLET, PART, VALVE, VALVE_SINK, WT, classifiedScene, jigCell, muNode, muOf, withSeatDepth, worldPos,
  worldPose,
} from './_mu-preplaced-fixture';

beforeEach(() => resetProblemsForTests());
afterEach(() => resetProblemsForTests());

const VALVE_BOTTOM = WT[1] - VALVE_SINK;
const VALVE_TOP = VALVE_BOTTOM + VALVE[1];
/** Valve / cap x/z inside a jig (the fixture's offsets). */
const SEAT_X = 0.03;
const SEAT_Z = 0.02;

function makeGrip(tm: RVTransportManager, parent: Object3D, pos: Vector3, name = 'Gripper'): RVGrip {
  const node = new Object3D();
  node.name = name;
  node.position.copy(pos);
  parent.add(node);
  const grip = new RVGrip(node);
  grip.allMUs = () => tm.mus;
  grip.allGripTargets = () => tm.gripTargets;
  grip.loadHost = tm;
  tm.grips.push(grip);
  return grip;
}

function addTarget(tm: RVTransportManager, parent: Object3D, pos: Vector3, loadOnCarrier = true, name = 'Seat'): RVGripTarget {
  const n = new Object3D();
  n.name = name;
  n.position.copy(pos);
  parent.add(n);
  const t = new RVGripTarget(n);
  t.LoadOnCarrier = loadOnCarrier;
  tm.gripTargets.push(t);
  return t;
}

/** Grip exactly `mu` (the private hold path the pick uses — avoids nearest-box ties of nested parts). */
function fix(grip: RVGrip, mu: RVMovingUnit): void {
  (grip as unknown as { fix(m: RVMovingUnit): void }).fix(mu);
}

/** Move the grip node so it sits `dy` above the world point `p`. */
function moveGripTo(grip: RVGrip, p: Vector3, dy = 0.05): void {
  grip.node.position.set(p.x, p.y + dy, p.z);
  grip.node.updateWorldMatrix(true, true);
}

function seatProblems() {
  return getProblems().filter((p) => p.code === SEAT_OCCUPIED_CODE);
}

/** Valve seat in jig `i` (world, jig pitch 0.5 m). */
function valveSeat(i: number): Vector3 { return new Vector3(i * 0.5 + SEAT_X, VALVE_BOTTOM, SEAT_Z); }
/** Cap seat on the valve of jig `i`. */
function capSeat(i: number): Vector3 { return new Vector3(i * 0.5 + SEAT_X, VALVE_TOP - CAP_SINK, SEAT_Z); }

/**
 * Jig 0: valve + cap; jig 1: an EMPTY WT (no valve, no cap). Returns the MUs.
 */
function transferCell() {
  const { root, wts, valves, caps } = jigCell(2, (i) => i === 0);
  valves[1].parent!.remove(valves[1]); // jig 1 empty
  const { tm, scene } = classifiedScene(root);
  tm.activatePreplaced();
  return {
    tm, scene, root,
    wt0: muOf(tm, wts[0]), wt1: muOf(tm, wts[1]),
    valve0: muOf(tm, valves[0]), cap0: muOf(tm, caps[0]!),
  };
}

describe('LoadOnCarrier: free carrier (plan-577 F6)', () => {
  it('the part becomes the carrier load, the target stays free, and it rides along exactly', () => {
    const { tm, scene, wt1, valve0, cap0 } = transferCell();
    const grip = makeGrip(tm, scene, new Vector3(SEAT_X, VALVE_TOP + 0.01, SEAT_Z));
    grip.pick();
    expect(grip.grippedMUs).toEqual([valve0]); // nearest box: the valve (its top is 11 mm over the cap)
    expect(cap0.loadedOn).toBe(valve0);          // the cap rides along in the grip
    const target = addTarget(tm, scene, valveSeat(1));
    moveGripTo(grip, valveSeat(1), 0.2);
    grip.place();

    expect(valve0.loadedOn).toBe(wt1);
    expect(valve0.node.parent).toBe(wt1.node);
    expect(tm.mus).not.toContain(valve0);
    expect(valve0.isGripped).toBe(false);
    expect(target.isFree).toBe(true);
    expect(cap0.loadedOn).toBe(valve0);
    expect(worldPos(valve0.node).distanceTo(valveSeat(1))).toBeLessThan(1e-9);
    expect(seatProblems()).toHaveLength(0);

    // The WT moves 40 mm: the valve (and the cap on it) follow — deviation < 0.1 mm.
    const v0 = worldPos(valve0.node);
    const c0 = worldPos(cap0.node);
    wt1.node.position.x += 0.04;
    const dv = worldPos(valve0.node).sub(v0);
    const dc = worldPos(cap0.node).sub(c0);
    expect(dv.distanceTo(new Vector3(0.04, 0, 0))).toBeLessThan(1e-4);
    expect(dc.distanceTo(new Vector3(0.04, 0, 0))).toBeLessThan(1e-4);
  });

  it('no MU under the target pose → classic target placement (target occupied)', () => {
    const { tm, scene, valve0 } = transferCell();
    const grip = makeGrip(tm, scene, new Vector3(SEAT_X, VALVE_TOP + 0.01, SEAT_Z));
    grip.pick();
    const air = new Vector3(3, 1, 0);
    const target = addTarget(tm, scene, air);
    moveGripTo(grip, air, 0.1);
    grip.place();
    expect(valve0.node.parent).toBe(target.node);
    expect(target.occupiedBy).toBe(valve0);
    expect(valve0.loadedOn).toBeNull();
    expect(valve0.isGripped).toBe(false);
    expect(seatProblems()).toHaveLength(0);
  });

  it('LoadOnCarrier = false → the classic placement as before (target occupied, no load)', () => {
    const { tm, scene, wt1, valve0 } = transferCell();
    const grip = makeGrip(tm, scene, new Vector3(SEAT_X, VALVE_TOP + 0.01, SEAT_Z));
    grip.pick();
    const target = addTarget(tm, scene, valveSeat(1), false);
    moveGripTo(grip, valveSeat(1), 0.2);
    grip.place();
    expect(valve0.node.parent).toBe(target.node);
    expect(target.occupiedBy).toBe(valve0);
    expect(valve0.loadedOn).toBeNull();
    expect(wt1.loadedMus).toHaveLength(0);
  });
});

describe('LoadOnCarrier: seat occupied (plan-577 F7/F8)', () => {
  /** Jig 0 full (valve + cap), jig 1 with a valve only: the target is jig 0's OCCUPIED valve seat. */
  function occupiedCell() {
    const { root, wts, valves, caps } = jigCell(2, (i) => i === 0);
    const { tm, scene } = classifiedScene(root);
    tm.activatePreplaced();
    const valve1 = muOf(tm, valves[1]);
    const grip = makeGrip(tm, scene, new Vector3(0.5 + SEAT_X, VALVE_TOP + 0.01, SEAT_Z));
    grip.pick();
    expect(grip.grippedMUs).toEqual([valve1]);
    return { tm, scene, grip, valve1, valve0: muOf(tm, valves[0]), wt0: muOf(tm, wts[0]), cap0: muOf(tm, caps[0]!) };
  }

  it('refused: part stays gripped with its pose, one warning; a second flank keeps ONE; freed seat → placed, warning gone; reset clears it', () => {
    const { tm, scene, grip, valve1, valve0, wt0 } = occupiedCell();
    const target = addTarget(tm, scene, valveSeat(0), true, 'ValveSeat_0');
    moveGripTo(grip, valveSeat(0), 0.2);
    const before = worldPose(valve1.node);

    grip.place();
    expect(grip.grippedMUs).toEqual([valve1]);
    expect(valve1.heldBy).toBe('grip');
    expect(valve1.node.parent).toBe(grip.node);
    const after = worldPose(valve1.node);
    expect(after.pos.distanceTo(before.pos)).toBeLessThan(1e-9);
    expect(after.quat.angleTo(before.quat)).toBeLessThan(1e-9);
    expect(target.isFree).toBe(true);
    let probs = seatProblems();
    expect(probs).toHaveLength(1);
    expect(probs[0].severity).toBe('warning');
    expect(probs[0].title).toBe('Grip could not place part — seat occupied');
    expect(probs[0].detail).toContain('Gripper');
    expect(probs[0].detail).toContain('ValveSeat_0');
    expect(probs[0].detail).toContain('Valve.0');
    expect(probs[0].detail).toContain('Valve.1');

    grip.place(); // second place flank
    expect(seatProblems()).toHaveLength(1);
    expect(grip.grippedMUs).toEqual([valve1]);

    // Free the seat: a second gripper takes valve 0 (with its cap) far away.
    const grip2 = makeGrip(tm, scene, new Vector3(SEAT_X, VALVE_TOP + 0.01, SEAT_Z), 'Gripper2');
    grip2.pick();
    expect(grip2.grippedMUs).toEqual([valve0]);
    grip2.node.position.set(5, 2, 0);
    grip2.node.updateWorldMatrix(true, true);

    grip.place();
    expect(valve1.loadedOn).toBe(wt0);
    expect(seatProblems()).toHaveLength(0);

    // grip2 now brings valve 0 back to the same (free) target: occupied by valve 1 → refused.
    moveGripTo(grip2, valveSeat(0), 0.2);
    grip2.place();
    expect(grip2.grippedMUs).toEqual([valve0]);
    probs = seatProblems();
    expect(probs).toHaveLength(1);
    expect(probs[0].detail).toContain('Gripper2');
    // A simulation reset retires the warning.
    tm.reset();
    expect(seatProblems()).toHaveLength(0);
  });

  it('SOL R1 #1: the occupying load can never win as "highest carrier" — refused', () => {
    // The incoming valve at the occupied seat overlaps the WT (a candidate) AND the
    // seated valve 0: the seated valve is no candidate (same pose, centre rule) → obstacle.
    const { tm, scene, grip, valve1, wt0, valve0 } = occupiedCell();
    addTarget(tm, scene, valveSeat(0));
    moveGripTo(grip, valveSeat(0), 0.2);
    grip.place();
    expect(valve1.isGripped).toBe(true);
    expect(valve1.loadedOn).toBeNull();
    expect(valve0.loadedMus).not.toContain(valve1);
    expect(wt0.loadedMus).not.toContain(valve1);
    expect(seatProblems()).toHaveLength(1);
  });

  it('SOL R2 #1: a part that overlaps the WT AND a load seated in it (both candidates) is ambiguous — refused', () => {
    // Y intervals (m): WT 0 … 0.0938 (seat 70 mm), seated L 0.0318 … 0.1428 (seat 80 mm);
    // incoming P (valve size) bottom at 0.070: 23.8 mm into the WT window, 72.8 mm into L's
    // window, centre above both, centre inside both footprints, overlapping both boxes.
    const root = new Object3D();
    const wt = withSeatDepth(muNode('WT', WT, [0, 0, 0]), 70);
    const l = withSeatDepth(muNode('L', VALVE, [SEAT_X, VALVE_BOTTOM, SEAT_Z]), 80);
    const p = muNode('P', VALVE, [-1, 0, 0]);
    root.add(wt, l, p);
    const { tm, scene } = classifiedScene(root);
    tm.activatePreplaced();
    const P = muOf(tm, p);
    const L = muOf(tm, l);
    const W = muOf(tm, wt);
    expect(L.loadedOn).toBe(W);
    const grip = makeGrip(tm, scene, new Vector3(-1, VALVE[1] + 0.01, 0));
    grip.pick();
    expect(grip.grippedMUs).toEqual([P]);
    const seat = new Vector3(SEAT_X + 0.015, 0.07, SEAT_Z);
    addTarget(tm, scene, seat, true, 'AmbiguousSeat');
    moveGripTo(grip, seat, 0.2);
    grip.place();
    expect(P.isGripped).toBe(true);
    expect(P.loadedOn).toBeNull();
    const probs = seatProblems();
    expect(probs).toHaveLength(1);
    expect(probs[0].detail).toContain('ambiguous');
    expect(probs[0].detail).toContain('WT');
    expect(probs[0].detail).toContain('L');
  });

  it('legitimate: a cap onto a separate valve succeeds (overlaps only the valve) — and the valve takes it along', () => {
    const { root, wts, valves, caps } = jigCell(2, (i) => i === 0);
    const { tm, scene } = classifiedScene(root);
    tm.activatePreplaced();
    const cap0 = muOf(tm, caps[0]!);
    const valve1 = muOf(tm, valves[1]);
    const wt1 = muOf(tm, wts[1]);
    const grip = makeGrip(tm, scene, new Vector3(SEAT_X, VALVE_TOP + 0.05, SEAT_Z));
    fix(grip, cap0);
    expect(cap0.loadedOn).toBeNull();
    const target = addTarget(tm, scene, capSeat(1), true, 'CapSeat_1');
    moveGripTo(grip, capSeat(1), 0.1);
    grip.place();
    expect(cap0.loadedOn).toBe(valve1);
    expect(isInLoadTree(wt1, cap0)).toBe(true);
    expect(target.isFree).toBe(true);
    expect(seatProblems()).toHaveLength(0);

    // Grip the valve with the cap on it: the cap rides along in the grip.
    const g2 = makeGrip(tm, scene, new Vector3(0.5 + SEAT_X, VALVE_TOP + 0.005, SEAT_Z), 'Gripper2');
    g2.pick();
    expect(g2.grippedMUs).toEqual([valve1]);
    expect(cap0.loadedOn).toBe(valve1);
    const c0 = worldPos(cap0.node);
    g2.node.position.y += 0.1;
    expect(worldPos(cap0.node).y - c0.y).toBeCloseTo(0.1, 9);
  });

  it('a FREE MU or one held by a second gripper at the seat → blocked (SOL R2 #2)', () => {
    for (const mode of ['free', 'held'] as const) {
      resetProblemsForTests();
      const { tm, scene, wt1, valve0 } = transferCell();
      // Something in the empty seat of jig 1.
      const blockerNode = muNode(`Blocker.${mode}`, PART, [0.5 + SEAT_X, VALVE_BOTTOM + 0.02, SEAT_Z]);
      scene.add(blockerNode);
      const blocker = new RVMovingUnit(blockerNode, 'src', new Vector3(PART[0] / 2, PART[1] / 2, PART[2] / 2), new Vector3(0, PART[1] / 2, 0));
      tm.mus.push(blocker);
      if (mode === 'held') {
        const holder = makeGrip(tm, scene, worldPos(blockerNode), 'Holder');
        fix(holder, blocker);
        expect(blocker.heldBy).toBe('grip');
      }
      const grip = makeGrip(tm, scene, new Vector3(SEAT_X, VALVE_TOP + 0.01, SEAT_Z));
      grip.pick();
      expect(grip.grippedMUs).toEqual([valve0]);
      addTarget(tm, scene, valveSeat(1));
      moveGripTo(grip, valveSeat(1), 0.2);
      grip.place();
      expect(valve0.isGripped, mode).toBe(true);
      expect(wt1.loadedMus, mode).toHaveLength(0);
      expect(seatProblems(), mode).toHaveLength(1);
      expect(seatProblems()[0].detail, mode).toContain(`Blocker.${mode}`);
    }
  });

  it('no carrier but a collision at the target → blocked; no carrier and free → classic', () => {
    const { tm, scene, valve0 } = transferCell();
    const air = new Vector3(3, 1, 0);
    const blockerNode = muNode('Floating', PART, [3, 1.02, 0]);
    scene.add(blockerNode);
    const blocker = new RVMovingUnit(blockerNode, 'src', new Vector3(PART[0] / 2, PART[1] / 2, PART[2] / 2), new Vector3(0, PART[1] / 2, 0));
    tm.mus.push(blocker);
    const grip = makeGrip(tm, scene, new Vector3(SEAT_X, VALVE_TOP + 0.01, SEAT_Z));
    grip.pick();
    const target = addTarget(tm, scene, air);
    moveGripTo(grip, air, 0.3);
    grip.place();
    expect(valve0.isGripped).toBe(true);
    expect(target.isFree).toBe(true);
    expect(seatProblems()).toHaveLength(1);

    // The blocker leaves → classic placement on the target.
    blockerNode.position.set(9, 9, 9);
    grip.place();
    expect(valve0.node.parent).toBe(target.node);
    expect(target.occupiedBy).toBe(valve0);
    expect(seatProblems()).toHaveLength(0);
  });

  it('only the CARRIED load collides → refused; pose and hold state of the whole tree unchanged (SOL #2)', () => {
    // The cap lies inside the valve box (like the real part), so the carried load here is a
    // bracket wider than the valve, resting on the valve top: only IT can hit something.
    const { root, valves, wts } = jigCell(2, () => false);
    valves[1].parent!.remove(valves[1]);
    const bracketNode = muNode('Bracket', [0.12, 0.01, 0.02], [SEAT_X, VALVE_TOP, SEAT_Z]);
    root.add(bracketNode);
    const { tm, scene } = classifiedScene(root);
    tm.activatePreplaced();
    const valve0 = muOf(tm, valves[0]);
    const wt1 = muOf(tm, wts[1]);
    const bracket = muOf(tm, bracketNode);
    expect(bracket.loadedOn).toBe(valve0);
    // An obstacle beside jig 1's valve seat, at bracket height, outside the valve box.
    const obstacleNode = muNode('BracketObstacle', [0.02, 0.02, 0.02], [0.5 + SEAT_X + 0.05, VALVE_TOP - 0.005, SEAT_Z]);
    scene.add(obstacleNode);
    tm.mus.push(new RVMovingUnit(obstacleNode, 'src', new Vector3(0.01, 0.01, 0.01), new Vector3(0, 0.01, 0)));
    const grip = makeGrip(tm, scene, new Vector3(SEAT_X, VALVE_TOP + 0.05, SEAT_Z));
    fix(grip, valve0);
    expect(bracket.loadedOn).toBe(valve0); // carried along
    addTarget(tm, scene, valveSeat(1));
    moveGripTo(grip, valveSeat(1), 0.4);
    const v = worldPose(valve0.node);
    const c = worldPose(bracket.node);

    // The valve alone would fit; only the carried bracket hits the obstacle.
    grip.place();
    expect(valve0.heldBy).toBe('grip');
    expect(valve0.node.parent).toBe(grip.node);
    expect(bracket.loadedOn).toBe(valve0);
    expect(bracket.node.parent).toBe(valve0.node);
    expect(worldPose(valve0.node).pos.distanceTo(v.pos)).toBeLessThan(1e-9);
    expect(worldPose(valve0.node).quat.angleTo(v.quat)).toBeLessThan(1e-9);
    expect(worldPose(bracket.node).pos.distanceTo(c.pos)).toBeLessThan(1e-9);
    // The AABBs are back at the grip pose too (not left at the probed pose).
    bracket.updateAABB();
    const bracketBox = bracket.aabb.center.clone();
    bracket.node.updateWorldMatrix(true, true);
    bracket.updateAABB();
    expect(bracket.aabb.center.distanceTo(bracketBox)).toBeLessThan(1e-9);
    expect(bracketBox.distanceTo(worldPos(bracket.node).add(new Vector3(0, 0.005, 0)))).toBeLessThan(1e-6);
    expect(wt1.loadedMus).toHaveLength(0);
    const probs = seatProblems();
    expect(probs).toHaveLength(1);
    expect(probs[0].detail).toContain('BracketObstacle');

    // The obstacle leaves → the valve with its bracket is placed onto WT 1.
    obstacleNode.position.set(9, 9, 9);
    grip.place();
    expect(valve0.loadedOn).toBe(wt1);
    expect(bracket.loadedOn).toBe(valve0);
    expect(seatProblems()).toHaveLength(0);
  });

  it('two grips blocked; only one later places → the other grip keeps its warning (SOL #5)', () => {
    const { root, wts, valves } = jigCell(3, () => false);
    const { tm, scene } = classifiedScene(root);
    tm.activatePreplaced();
    const v1 = muOf(tm, valves[1]);
    const v2 = muOf(tm, valves[2]);
    const g1 = makeGrip(tm, scene, new Vector3(0.5 + SEAT_X, VALVE_TOP + 0.01, SEAT_Z), 'G1');
    const g2 = makeGrip(tm, scene, new Vector3(1.0 + SEAT_X, VALVE_TOP + 0.01, SEAT_Z), 'G2');
    g1.pick(); g2.pick();
    expect(g1.grippedMUs).toEqual([v1]);
    expect(g2.grippedMUs).toEqual([v2]);
    // Both grips aim at jig 0's occupied valve seat (each at its own target).
    const ta = addTarget(tm, scene, valveSeat(0), true, 'SeatA');
    moveGripTo(g1, valveSeat(0), 0.2);
    g1.place();
    moveGripTo(g2, valveSeat(0), 0.2);
    g2.place();
    expect(seatProblems()).toHaveLength(2);

    // G1 finds a free seat: jig 1's (its own valve is in the grip).
    ta.node.position.copy(valveSeat(1));
    moveGripTo(g1, valveSeat(1), 0.2);
    g1.place();
    expect(v1.loadedOn).toBe(muOf(tm, wts[1]));
    const left = seatProblems();
    expect(left).toHaveLength(1);
    expect(left[0].detail).toContain('G2');
  });
});

describe('Zone Hold ignores LoadOnCarrier (plan-577 decision log)', () => {
  it('a zone releasing onto a LoadOnCarrier target places classically', () => {
    const root = new Object3D();
    const pallet = muNode('Pallet', PALLET, [0, 0, 0]);
    root.add(pallet);
    const { tm, scene } = classifiedScene(root);
    tm.activatePreplaced();
    const store = new SignalStore();
    store.register('Act', 'Signals/Act', false);
    const axis = new Object3D();
    axis.position.set(2, 0, 0);
    scene.add(axis);
    const zone = new RVZone(axis);
    zone.Size.set(400, 300, 400);
    zone.Hold = true;
    zone.Activation = 'Signal';
    zone.ActivationSignal = 'Signals/Act';
    zone.init({ transportManager: tm, signalStore: store } as unknown as ComponentContext);
    const partNode = new Object3D();
    partNode.position.set(2, 0, 0);
    scene.add(partNode);
    const part = new RVMovingUnit(partNode, 'src', new Vector3(0.05, 0.05, 0.05));
    tm.mus.push(part);
    // The target sits right on the pallet top: a LoadOnCarrier grip would load the part there.
    const target = addTarget(tm, scene, new Vector3(0, PALLET[1], 0), true);
    zone.GripTargetSearchRadius = 5000;
    store.setByPath('Signals/Act', true);
    tm.update(1 / 60);
    expect(part.heldBy).toBe('zone');
    store.setByPath('Signals/Act', false);
    tm.update(1 / 60);
    expect(part.node.parent).toBe(target.node);
    expect(target.occupiedBy).toBe(part);
    expect(part.loadedOn).toBeNull();
  });
});
