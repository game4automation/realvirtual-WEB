// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * zone-single-release.test.ts — plan-530 §9: Zone `SingleRelease` (stopper
 * singulation). A Block zone on a stopper axis releases exactly one MU per
 * lowering; the touching follower (belt `MinGap` 0) is caught at the fixed
 * home face. Full manager path: RVTransportManager + accumulating belt.
 *
 * Rig: belt along +X (x −2..2), MUs 100 mm cubes centred at y = 0, stopper
 * axis at x = 1 carrying a 20 × 20 × 300 mm zone centred 50 mm below the axis
 * (world y −0.06..−0.04, i.e. 10 mm into the MU) — the entry face is x = 0.99,
 * the exit face x = 1.01. Lowering the axis 15 mm takes the box clear below.
 */

import { describe, it, expect } from 'vitest';
import { Object3D, Scene, Vector3 } from 'three';
import { RVZone } from '../src/core/engine/rv-zone';
import { RVWaitForZone, StepState } from '../src/core/engine/rv-logic-step';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVMovingUnit, type InstancedMovingUnit } from '../src/core/engine/rv-mu';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { zoneRuleWarnings } from '../src/core/engine/rv-extras-validator';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';

const DT = 1 / 60;
const FACE = 0.99;   // entry face of the home box (x)
const EXIT = 1.01;   // exit face of the home box (x)
const LOWER = -0.015; // stopper stroke (m)

function createMU(name: string, x: number, z = 0, half = new Vector3(0.05, 0.05, 0.05)): RVMovingUnit {
  const node = new Object3D();
  node.name = name;
  node.position.set(x, 0, z);
  return new RVMovingUnit(node, 'test-source', half.clone());
}

function createSurface(speed: number): RVTransportSurface {
  const node = new Object3D();
  const surface = new RVTransportSurface(node, AABB.fromHalfSize(node, new Vector3(2, 0.1, 0.5)));
  surface.TransportDirection.set(1, 0, 0);
  surface.Radial = false;
  surface.TextureScale = 1;
  surface.HeightOffsetOverride = 0;
  surface.Accumulate = true;
  surface.MinGap = 0;
  surface.reapplyConfig();
  surface.initTransport();
  surface.drive = { currentSpeed: speed, name: 'mock-drive' } as unknown as RVTransportSurface['drive'];
  return surface;
}

interface Rig {
  manager: RVTransportManager;
  belt: RVTransportSurface;
  store: SignalStore;
}

function createRig(speed = 500): Rig {
  const manager = new RVTransportManager();
  manager.scene = new Scene();
  const belt = createSurface(speed);
  manager.surfaces.push(belt);
  return { manager, belt, store: new SignalStore() };
}

interface StopperOpts {
  singleRelease?: boolean;
  x?: number;
  signal?: string;
  occupiedSignal?: string;
  hold?: boolean;
}

/** A stopper axis with a Block + Detect zone, initialised (home = init pose). */
function stopper(rig: Rig, opts: StopperOpts = {}): { zone: RVZone; axis: Object3D } {
  const axis = new Object3D();
  axis.name = 'StopperAxis';
  axis.position.set(opts.x ?? 1, 0, 0);
  const zone = new RVZone(axis);
  zone.Size.set(20, 20, 300);
  zone.Center.set(0, -50, 0);
  zone.Block = true;
  zone.Detect = true;
  zone.Hold = opts.hold ?? false;
  zone.SingleRelease = opts.singleRelease ?? true;
  if (opts.signal) {
    zone.Activation = 'Signal';
    zone.ActivationSignal = opts.signal;
  }
  if (opts.occupiedSignal) zone.SignalOccupied = opts.occupiedSignal;
  zone.init({ transportManager: rig.manager, signalStore: rig.store } as unknown as ComponentContext);
  return { zone, axis };
}

function run(rig: Rig, ticks: number): void {
  for (let i = 0; i < ticks; i++) rig.manager.update(DT);
}

function addMUs(rig: Rig, ...mus: RVMovingUnit[]): void {
  for (const mu of mus) rig.manager.mus.push(mu);
}

/** Two touching MUs queued against the raised stopper (A at the face, B behind). */
function queuedPair(rig: Rig): { a: RVMovingUnit; b: RVMovingUnit } {
  const a = createMU('A', -0.5);
  const b = createMU('B', -0.65);
  addMUs(rig, a, b);
  run(rig, 300);
  return { a, b };
}

const atFace = (mu: RVMovingUnit): boolean => Math.abs(mu.aabb.max.x - FACE) < 0.0005;
const passed = (mu: RVMovingUnit): boolean => mu.aabb.min.x > EXIT;

describe('Zone SingleRelease — release cycle (F1–F6)', () => {
  it('off: a lowered zone lets both touching MUs pass (unchanged behaviour)', () => {
    const rig = createRig();
    const { axis } = stopper(rig, { singleRelease: false });
    const { a, b } = queuedPair(rig);
    expect(atFace(a)).toBe(true);
    // MinGap 0: B touches A (gap ≤ 1 mm).
    expect(a.aabb.min.x - b.aabb.max.x).toBeLessThan(0.001);
    axis.position.y = LOWER;
    run(rig, 120);
    expect(passed(a)).toBe(true);
    expect(passed(b)).toBe(true);
  });

  it('on: lower → only the contacting MU passes, the follower stops at the home face while the stopper is still down', () => {
    const rig = createRig();
    const { zone, axis } = stopper(rig);
    const { a, b } = queuedPair(rig);
    expect(atFace(a)).toBe(true);
    expect(a.aabb.min.x - b.aabb.max.x).toBeLessThan(0.001);
    axis.position.y = LOWER;
    run(rig, 1);
    expect(zone.singleReleaseReleased).toBe(true);
    expect(zone.singleReleaseToken).toBe(a);
    run(rig, 120);
    expect(passed(a)).toBe(true);
    expect(atFace(b)).toBe(true);
    expect(b.aabb.max.x).toBeLessThanOrEqual(FACE);
    expect(axis.position.y).toBe(LOWER);
  });

  it('on: raise again → follower held; lower again → follower passes, the third is held', () => {
    const rig = createRig();
    const { zone, axis } = stopper(rig);
    const a = createMU('A', -0.5);
    const b = createMU('B', -0.65);
    const c = createMU('C', -0.8);
    addMUs(rig, a, b, c);
    run(rig, 360);
    axis.position.y = LOWER;
    run(rig, 120);
    expect(passed(a)).toBe(true);
    expect(atFace(b)).toBe(true);

    axis.position.y = 0;
    run(rig, 60);
    expect(zone.singleReleaseReleased).toBe(false);
    expect(zone.singleReleaseToken).toBeNull();
    expect(atFace(b)).toBe(true);

    axis.position.y = LOWER;
    run(rig, 120);
    expect(passed(b)).toBe(true);
    expect(atFace(c)).toBe(true);
  });

  it('on: lowered with no MU in contact → the first arriving MU passes, the second is held', () => {
    const rig = createRig();
    const { zone, axis } = stopper(rig);
    axis.position.y = LOWER;
    run(rig, 2);
    expect(zone.singleReleaseReleased).toBe(true);
    expect(zone.singleReleaseToken).toBeNull();
    const a = createMU('A', -0.5);
    const b = createMU('B', -0.65);
    addMUs(rig, a, b);
    run(rig, 400);
    expect(passed(a)).toBe(true);
    expect(atFace(b)).toBe(true);
  });

  it('on: token MU disposed while released → NO further MU passes until the stopper is raised and lowered again', () => {
    const rig = createRig();
    const { zone, axis } = stopper(rig);
    const { a, b } = queuedPair(rig);
    axis.position.y = LOWER;
    run(rig, 3);
    expect(zone.singleReleaseToken).toBe(a);
    rig.manager.removeMU(a);
    expect(zone.singleReleaseToken).toBeNull();
    run(rig, 240);
    expect(atFace(b)).toBe(true);
    expect(zone.singleReleaseToken).toBeNull();

    axis.position.y = 0;
    run(rig, 5);
    axis.position.y = LOWER;
    run(rig, 120);
    expect(passed(b)).toBe(true);
  });
});

describe('Zone SingleRelease — fixed home box (F2)', () => {
  it('slow stroke (0.5 mm/tick, 30 ticks) → home does not creep, Released only after > 1 mm; a short stroke never releases', () => {
    const rig = createRig();
    const { zone, axis } = stopper(rig);
    const { a } = queuedPair(rig);
    const homeMinY = zone.homeBounds.min.y;
    expect(homeMinY).toBeCloseTo(-0.06, 9);
    const states: boolean[] = [];
    for (let i = 1; i <= 30; i++) {
      axis.position.y = -0.0005 * i;
      run(rig, 1);
      states.push(zone.singleReleaseReleased);
      expect(zone.homeBounds.min.y).toBeCloseTo(homeMinY, 9);
    }
    expect(states[0]).toBe(false); // 0.5 mm
    expect(states[2]).toBe(true);  // 1.5 mm
    run(rig, 120);
    expect(passed(a)).toBe(true);

    // Short stroke: 0.8 mm never leaves home — the zone stays Armed and blocks.
    const rig2 = createRig();
    const s2 = stopper(rig2);
    const p2 = queuedPair(rig2);
    s2.axis.position.y = -0.0008;
    run(rig2, 60);
    expect(s2.zone.singleReleaseReleased).toBe(false);
    expect(atFace(p2.a)).toBe(true);
  });

  it('stopper lowered before the very first tick / reapplyConfig / owner change while lowered → home stays the init pose, the next raise re-arms', () => {
    const rig = createRig();
    const { zone, axis } = stopper(rig);
    axis.position.y = LOWER; // lowered before any simulation tick
    run(rig, 1);
    expect(zone.homeBounds.min.y).toBeCloseTo(-0.06, 9);
    expect(zone.singleReleaseReleased).toBe(true);

    zone.reapplyConfig();
    run(rig, 1);
    expect(zone.homeBounds.min.y).toBeCloseTo(-0.06, 9);
    expect(zone.singleReleaseReleased).toBe(true);

    zone.isOwner = false;
    run(rig, 1);
    expect(zone.singleReleaseReleased).toBe(false);
    zone.isOwner = true;
    run(rig, 1);
    expect(zone.homeBounds.min.y).toBeCloseTo(-0.06, 9);
    expect(zone.singleReleaseReleased).toBe(true);

    axis.position.y = 0;
    run(rig, 1);
    expect(zone.singleReleaseReleased).toBe(false);
  });
});

describe('Zone SingleRelease — token and clamp (F4/F5)', () => {
  it('follower already overlapping the home box by 0.5 mm at release → held (travel 0), also diagonal, laterally offset and on a reversed belt', () => {
    const rig = createRig();
    const { zone, axis } = stopper(rig);
    const { a } = queuedPair(rig);
    axis.position.y = LOWER;
    run(rig, 1);
    expect(zone.singleReleaseToken).toBe(a);
    const probe = (x: number, z: number): RVMovingUnit => {
      const m = createMU('probe', x, z);
      m.node.updateWorldMatrix(true, false);
      m.updateAABB();
      return m;
    };
    const inside = probe(FACE + 0.0005 - 0.05, 0);
    expect(zone.clampTravel(inside, new Vector3(1, 0, 0), 0.01)).toBe(0);
    expect(zone.clampTravel(inside, new Vector3(1, 0, 1).normalize(), 0.01)).toBe(0);
    const offset = probe(FACE + 0.0005 - 0.05, 0.1);
    expect(zone.clampTravel(offset, new Vector3(1, 0, 0.3).normalize(), 0.01)).toBe(0);
    // Leading face already past the exit face → leaving, plain rule (inactive box is clear → full travel).
    const leaving = probe(EXIT + 0.01 - 0.05, 0);
    expect(zone.clampTravel(leaving, new Vector3(1, 0, 0), 0.01)).toBe(0.01);
    // The token MU itself is never clamped at the home box.
    expect(zone.clampTravel(a, new Vector3(1, 0, 0), 0.01)).toBe(0.01);

    // Reversed belt: MUs come from +x, the entry face is x = 1.01.
    const rev = createRig(-500);
    const s = stopper(rev);
    const ra = createMU('RA', 1.5);
    const rb = createMU('RB', 1.65);
    addMUs(rev, ra, rb);
    run(rev, 300);
    expect(ra.aabb.min.x).toBeGreaterThanOrEqual(EXIT);
    expect(ra.aabb.min.x).toBeLessThan(EXIT + 0.0005);
    s.axis.position.y = LOWER;
    run(rev, 1);
    expect(s.zone.singleReleaseToken).toBe(ra);
    const revInside = probe(EXIT - 0.0005 + 0.05, 0);
    expect(s.zone.clampTravel(revInside, new Vector3(-1, 0, 0), 0.01)).toBe(0);
    expect(s.zone.clampTravel(revInside, new Vector3(-1, 0, 1).normalize(), 0.01)).toBe(0);
    run(rev, 120);
    expect(ra.aabb.max.x).toBeLessThan(FACE);
    expect(Math.abs(rb.aabb.min.x - EXIT)).toBeLessThan(0.0005);
  });

  it('short MU downstream touching the exit face + long MU waiting at the entry face → the token goes to the waiting MU', () => {
    const rig = createRig();
    const { zone, axis } = stopper(rig);
    const long = createMU('Long', -0.5, 0, new Vector3(0.1, 0.05, 0.05));
    addMUs(rig, long);
    run(rig, 300);
    expect(atFace(long)).toBe(true);
    const short = createMU('Short', EXIT + 0.005, 0, new Vector3(0.005, 0.05, 0.05));
    short.node.updateWorldMatrix(true, false);
    short.updateAABB();
    short.currentSurface = rig.belt;
    addMUs(rig, short);
    axis.position.y = LOWER;
    run(rig, 1);
    expect(zone.singleReleaseToken).toBe(long);
  });

  it('reversed MU list order / two zones in sequence → same token, same result', () => {
    // Two MUs side by side at the face (lateral lanes): smallest id wins.
    const tokens: string[] = [];
    for (const order of ['ab', 'ba'] as const) {
      const rig = createRig();
      const { zone, axis } = stopper(rig);
      const a = createMU('A', -0.5, -0.08);
      const b = createMU('B', -0.5, 0.08);
      if (order === 'ab') addMUs(rig, a, b); else addMUs(rig, b, a);
      run(rig, 300);
      expect(atFace(a) && atFace(b)).toBe(true);
      axis.position.y = LOWER;
      run(rig, 1);
      tokens.push(zone.singleReleaseToken?.getName() ?? 'none');
      run(rig, 120);
      expect(passed(a), order).toBe(true);
      expect(atFace(b), order).toBe(true);
    }
    expect(tokens).toEqual(['A', 'A']);

    // Two SingleRelease stoppers in a row, both registration orders.
    const results: number[][] = [];
    for (const order of ['first', 'second'] as const) {
      const rig = createRig();
      const mk = (x: number): { zone: RVZone; axis: Object3D } => stopper(rig, { x });
      let z1: { zone: RVZone; axis: Object3D };
      let z2: { zone: RVZone; axis: Object3D };
      if (order === 'first') { z1 = mk(0.5); z2 = mk(1.2); } else { z2 = mk(1.2); z1 = mk(0.5); }
      const mus = [createMU('A', -0.5), createMU('B', -0.65), createMU('C', -0.8)];
      addMUs(rig, ...mus);
      run(rig, 300);
      z2.axis.position.y = LOWER; // downstream stopper down: first arrival passes
      z1.axis.position.y = LOWER;
      run(rig, 240);
      results.push(mus.map(m => m.aabb.center.x));
      // A went through both, B is held at the first stopper.
      expect(mus[0].aabb.min.x, order).toBeGreaterThan(1.21);
      expect(Math.abs(mus[1].aabb.max.x - 0.49), order).toBeLessThan(0.0005);
    }
    for (let i = 0; i < 3; i++) expect(results[1][i]).toBeCloseTo(results[0][i], 9);
  });

  it('arrival while the box is still lowering in the path → the token MU is still stopped by the actual box until it is clear', () => {
    const rig = createRig();
    const { zone, axis } = stopper(rig);
    const { a } = queuedPair(rig);
    for (let i = 1; i <= 4; i++) { // 2 mm per tick: 8 mm < 10 mm overlap
      axis.position.y = -0.002 * i;
      run(rig, 1);
      expect(a.aabb.max.x).toBeLessThanOrEqual(FACE);
    }
    expect(zone.singleReleaseToken).toBe(a);
    axis.position.y = LOWER;
    run(rig, 60);
    expect(passed(a)).toBe(true);
  });
});

describe('Zone SingleRelease — guard, eligibility, cleanup (F2/F3/F8/F10)', () => {
  it('Hold + SingleRelease → single release inactive at runtime (Hold behaviour unchanged)', () => {
    const rig = createRig();
    const { zone, axis } = stopper(rig, { hold: true });
    expect(zoneRuleWarnings(zone).some(w => w.includes('ignored while Hold'))).toBe(true);
    axis.position.y = LOWER;
    run(rig, 5);
    expect(zone.singleReleaseReleased).toBe(false);
    expect(zone.singleReleaseBlocking).toBe(false);
  });

  it('reset(), reapplyConfig() toggling SingleRelease off/on while released, owner→follower→owner → clean Armed state', () => {
    const rig = createRig();
    const { zone, axis } = stopper(rig);
    const { a } = queuedPair(rig);
    axis.position.y = LOWER;
    run(rig, 1);
    expect(zone.singleReleaseToken).toBe(a);

    zone.reset();
    expect(zone.singleReleaseReleased).toBe(false);
    expect(zone.singleReleaseToken).toBeNull();

    run(rig, 1);
    expect(zone.singleReleaseReleased).toBe(true); // still lowered, home = init pose
    zone.SingleRelease = false;
    zone.reapplyConfig();
    expect(zone.singleReleaseReleased).toBe(false);
    run(rig, 1);
    expect(zone.singleReleaseReleased).toBe(false);
    expect(zone.singleReleaseBlocking).toBe(false);
    zone.SingleRelease = true;
    zone.reapplyConfig();
    run(rig, 1);
    expect(zone.singleReleaseReleased).toBe(true);

    zone.isOwner = false;
    run(rig, 1);
    expect(zone.singleReleaseReleased).toBe(false);
    expect(zone.singleReleaseToken).toBeNull();
    axis.position.y = 0;
    zone.isOwner = true;
    run(rig, 1);
    expect(zone.singleReleaseReleased).toBe(false);
    expect(zone.homeBounds.min.y).toBeCloseTo(-0.06, 9);
  });

  // plan-539 F13: migrated from "inactive behaves like lowered" — only a
  // GEOMETRIC lowering releases now (Activation Always), the purpose is kept.
  it('geometric lowering (Activation Always): Released + blocking, exactly one MU passes; raise → Armed', () => {
    const rig = createRig();
    const { zone, axis } = stopper(rig);
    const { a, b } = queuedPair(rig);
    expect(atFace(a)).toBe(true);
    axis.position.y = LOWER;
    run(rig, 1);
    expect(zone.active).toBe(true);
    expect(zone.singleReleaseReleased).toBe(true);
    expect(zone.singleReleaseBlocking).toBe(true);
    run(rig, 120);
    expect(passed(a)).toBe(true);
    expect(atFace(b)).toBe(true);
    axis.position.y = 0;
    run(rig, 1);
    expect(zone.singleReleaseReleased).toBe(false);
  });

  it('instanced / physicsOwned MU → plain Block rule only', () => {
    const rig = createRig();
    // plan-539 F13: released by a geometric lowering (an inactive zone is off).
    const { zone, axis } = stopper(rig);
    axis.position.y = LOWER;
    run(rig, 1);
    expect(zone.singleReleaseReleased).toBe(true);
    const mu = createMU('probe', FACE - 0.05 - 0.0001);
    mu.node.updateWorldMatrix(true, false);
    mu.updateAABB();
    const dir = new Vector3(1, 0, 0);
    expect(zone.clampTravel(mu, dir, 0.01)).toBe(0); // eligible: caught at the home face
    mu.physicsOwned = true;
    expect(zone.clampTravel(mu, dir, 0.01)).toBe(0.01);
    mu.physicsOwned = false;
    const inst = { isInstanced: true, physicsOwned: false, markedForRemoval: false, aabb: mu.aabb } as unknown as InstancedMovingUnit;
    expect(zone.clampTravel(inst, dir, 0.01)).toBe(0.01);
    mu.heldBy = 'grip';
    expect(zone.clampTravel(mu, dir, 0.01)).toBe(0.01);
  });

  it('validator: SingleRelease without Block / with Hold warns', () => {
    const base = {
      Detect: true, Block: true, Hold: false, Activation: 'Always',
      ActivationSignal: null, ActivationDrive: null, Size: { x: 10, y: 10, z: 10 }, SingleRelease: true,
    };
    expect(zoneRuleWarnings(base)).toEqual([]);
    expect(zoneRuleWarnings({ ...base, Block: false }).some(w => w.includes('needs Block'))).toBe(true);
    expect(zoneRuleWarnings({ ...base, Hold: true }).some(w => w.includes('ignored while Hold'))).toBe(true);
    expect(zoneRuleWarnings({ ...base, Block: false, SingleRelease: false }).some(w => w.includes('SingleRelease'))).toBe(false);
  });
});

describe('Zone SingleRelease — Detect while released (F7)', () => {
  it('Detect union reports the follower at the home face on both candidate paths (array and spatial grid)', () => {
    for (const threshold of [64, 0]) {
      const rig = createRig();
      rig.manager.bruteForceThreshold = threshold;
      const { zone, axis } = stopper(rig);
      const { a, b } = queuedPair(rig);
      expect(zone.occupied, `threshold ${threshold}`).toBe(true);
      // plan-539 F13: lowered geometrically — the actual box (below the MUs) no longer counts.
      axis.position.y = LOWER;
      run(rig, 120);
      expect(passed(a), `threshold ${threshold}`).toBe(true);
      expect(atFace(b), `threshold ${threshold}`).toBe(true);
      expect(zone.occupied, `threshold ${threshold}`).toBe(true);
      rig.manager.removeMU(b);
      run(rig, 1);
      expect(zone.occupied, `threshold ${threshold}`).toBe(false);
    }
  });

  it('a follower held at the home face reports occupied; RVWaitForZone (occupied / free) and SignalOccupied follow it', () => {
    const rig = createRig();
    rig.store.register('Occ', 'Signals/Occ', false);
    const { zone, axis } = stopper(rig, { occupiedSignal: 'Signals/Occ' });
    const { a, b } = queuedPair(rig);
    expect(zone.occupied).toBe(true);
    expect(rig.store.getBoolByPath('Signals/Occ')).toBe(true);
    axis.position.y = LOWER;
    run(rig, 120);
    expect(passed(a)).toBe(true);
    expect(atFace(b)).toBe(true);
    expect(zone.occupied).toBe(true);
    expect(rig.store.getBoolByPath('Signals/Occ')).toBe(true);

    const waitOcc = new RVWaitForZone(zone, true);
    const waitFree = new RVWaitForZone(zone, false);
    waitOcc.start();
    waitFree.start();
    waitOcc.fixedUpdate(DT);
    waitFree.fixedUpdate(DT);
    expect(waitOcc.state).toBe(StepState.Finished);
    expect(waitFree.state).toBe(StepState.Waiting);

    rig.manager.removeMU(b);
    run(rig, 1);
    expect(zone.occupied).toBe(false);
    expect(rig.store.getBoolByPath('Signals/Occ')).toBe(false);
    waitFree.fixedUpdate(DT);
    expect(waitFree.state).toBe(StepState.Finished);
  });
});

describe('Zone SingleRelease — inactive = completely off (plan-539 F13)', () => {
  it('an activation-inactive SingleRelease zone is fully off: followers pass, token cleared, no Detect', () => {
    const rig = createRig();
    rig.store.register('En', 'Signals/En', true);
    const { zone } = stopper(rig, { signal: 'Signals/En' });
    const { a, b } = queuedPair(rig);
    expect(atFace(a)).toBe(true);
    expect(zone.occupied).toBe(true);
    rig.store.setByPath('Signals/En', false);
    run(rig, 1);
    expect(zone.active).toBe(false);
    expect(zone.singleReleaseReleased).toBe(false);
    expect(zone.singleReleaseBlocking).toBe(false);
    expect(zone.singleReleaseToken).toBeNull();
    run(rig, 120);
    expect(passed(a)).toBe(true);
    expect(passed(b)).toBe(true);
    expect(zone.occupied).toBe(false);
  });

  it('inactive while Released (token issued) clears the token; re-activation at home arms again and holds the next MU', () => {
    const rig = createRig();
    rig.store.register('En', 'Signals/En', true);
    const { zone, axis } = stopper(rig, { signal: 'Signals/En' });
    const { a } = queuedPair(rig);
    axis.position.y = LOWER;
    run(rig, 1);
    expect(zone.singleReleaseToken).toBe(a);
    rig.store.setByPath('Signals/En', false);
    run(rig, 1);
    expect(zone.singleReleaseReleased).toBe(false);
    expect(zone.singleReleaseToken).toBeNull();
    // Raised again while inactive, then re-activated at home → Armed.
    axis.position.y = 0;
    run(rig, 120);
    rig.store.setByPath('Signals/En', true);
    run(rig, 1);
    expect(zone.active).toBe(true);
    expect(zone.singleReleaseReleased).toBe(false);
    const c = createMU('C', -0.5);
    addMUs(rig, c);
    run(rig, 300);
    expect(atFace(c)).toBe(true);
  });

  it('re-activation while the box is still away from home releases exactly one MU (fresh lowering)', () => {
    const rig = createRig();
    rig.store.register('En', 'Signals/En', false);
    const { zone, axis } = stopper(rig, { signal: 'Signals/En' });
    axis.position.y = LOWER;
    run(rig, 1);
    expect(zone.singleReleaseReleased).toBe(false); // inactive: off
    rig.store.setByPath('Signals/En', true);
    run(rig, 1);
    expect(zone.singleReleaseReleased).toBe(true);
    const a = createMU('A', -0.5);
    const b = createMU('B', -0.65);
    addMUs(rig, a, b);
    run(rig, 400);
    expect(passed(a)).toBe(true);
    expect(atFace(b)).toBe(true);
  });
});
