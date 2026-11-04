// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * dynamic-gear-setpoint-route.test.ts — plan-673 Phase 5.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 * The realvirtual idiom for a parallel gripper is a `Drive_Cylinder` on a
 * `Drive{Direction:'Virtual'}` master with one `Drive_Gear` per jaw. A
 * `Virtual` drive is never a rigid body, so the Phase-3 writer rules made both
 * jaws gear slaves of a non-joint and neither of them got an actuator; Phase 4b
 * fixed the DOCUMENT with `virtualGearLeads()` (the first slave becomes the
 * actuated lead, the second is coupled to it by an `<equality>` row) and left
 * the RUNTIME gap open:
 *
 *   "Nothing commands a dynamic coupled jaw. Phase 5 needs exactly one setpoint
 *    route from the cylinder's virtual drive axis to the lead jaw."
 *
 * ── Why it cannot be done in `update()` ─────────────────────────────────────
 * `Drive_Gear.update()` is a drive BEHAVIOR, and a drive whose position an
 * external authority owns (`positionOverwrite`) returns from `updateMotion()`
 * BEFORE the behavior loop. Phase 4b built the obvious shortcut — routing
 * `Drive_Gear.update()` through `commandAxisPosition()` — measured it, and
 * reverted it, because (a) it cannot work from a place that never runs and
 * (b) without a running physics region it killed the KINEMATIC gripper of every
 * other scene.
 *
 * ── The route that works ────────────────────────────────────────────────────
 * `IDriveBehavior.commandDynamicSetpoint?(dt)`, called from the overwrite
 * branch and ONLY when the axis is dynamic. So:
 *   - a dynamic jaw gets its setpoint from the gear and the physics answers;
 *   - a kinematic jaw keeps running through `update()`, bit for bit;
 *   - a kinematic drive under overwrite (recording playback, multiuser
 *     follower) never even enters the loop.
 *
 * The last two are what this file mostly asserts, because they are what the
 * reverted attempt broke.
 */

import { describe, it, expect } from 'vitest';
import { Object3D, Scene } from 'three';
import { RVDrive, DriveDirection, type IDriveBehavior } from '../src/core/engine/rv-drive';
import { RVDriveGear } from '../src/core/engine/rv-drive-gear';
import { RVDynamicAxis } from '../src/core/engine/rv-dynamic-axis';
import { RVMuJoCoRegion } from '../src/core/engine/rv-mujoco-region';
import { setComponentInstance } from '../src/core/engine/rv-component-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';

const DT = 1 / 60;

interface Fixture {
  /** The `Drive{Direction:'Virtual'}` a `Drive_Cylinder` would move. */
  cylinder: RVDrive;
  /** The lead jaw — the one the writer actuates. */
  jaw: RVDrive;
  gear: RVDriveGear;
  axis: RVDynamicAxis | null;
  ctx: ComponentContext;
}

function makeGripper({ dynamic, factor = 1, offset = 0, region = true }: {
  dynamic: boolean; factor?: number; offset?: number; region?: boolean;
}): Fixture {
  RVDynamicAxis.clearAll();
  const registry = new NodeRegistry();
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'Gripper';
  scene.add(root);
  // A dynamic axis binds only inside a detail-physics world (rv-dynamic-axis.ts,
  // 2026-10-25), so the gripper sits in a region — as it does in the peg game.
  if (region) setComponentInstance(root, new RVMuJoCoRegion(root, null));

  const cylNode = new Object3D();
  cylNode.name = 'Cylinder';
  root.add(cylNode);
  const jawNode = new Object3D();
  jawNode.name = 'LeftFinger';
  root.add(jawNode);

  const cylPath = NodeRegistry.computeNodePath(cylNode);
  const jawPath = NodeRegistry.computeNodePath(jawNode);
  registry.registerNode(cylPath, cylNode);
  registry.registerNode(jawPath, jawNode);

  // The master: a Virtual drive. It integrates normally — it is the kinematic
  // half of the gripper and MuJoCo never sees it.
  const cylinder = new RVDrive(cylNode);
  cylinder.Direction = DriveDirection.Virtual;
  cylinder.initDrive();
  registry.register('Drive', cylPath, cylinder);

  const jaw = new RVDrive(jawNode);
  jaw.Direction = DriveDirection.LinearX;
  jaw.initDrive();
  registry.register('Drive', jawPath, jaw);

  const ctx: ComponentContext = {
    registry,
    signalStore: new SignalStore(),
    scene,
    transportManager: new RVTransportManager(),
    root,
  };

  const gear = new RVDriveGear(jawNode);
  gear.MasterDrive = cylinder;
  gear.GearFactor = factor;
  gear.Offset = offset;
  jaw.BehaviorExtras['Drive_Gear'] = {
    MasterDrive: { type: 'ComponentReference', path: cylPath },
  } as Record<string, unknown>;
  gear.init(ctx);

  let axis: RVDynamicAxis | null = null;
  if (dynamic) {
    axis = new RVDynamicAxis(jawNode);
    axis.ForceRangeMin = -100;
    axis.ForceRangeMax = 100;
    axis.init(ctx);
    // What the MuJoCo adapter's `activate()` does: the position is now the
    // physics' answer, so the drive's own integration and behavior pass stand
    // down.
    jaw.positionOverwrite = true;
  }

  return { cylinder, jaw, gear, axis, ctx };
}

describe('plan-673 Phase 5 — the setpoint route to the lead jaw', () => {
  it('leaves the axis KINEMATIC outside any region — nothing would step its actuator', () => {
    const { jaw, axis } = makeGripper({ dynamic: true, region: false });
    expect(axis).not.toBeNull();
    expect(jaw.dynamicAxis).toBeNull();
  });

  it('binds the dynamic axis to the jaw drive, so the route is armed at all', () => {
    const { jaw, axis } = makeGripper({ dynamic: true });
    expect(axis).not.toBeNull();
    expect(jaw.dynamicAxis).toBe(axis);
  });

  it('turns the cylinder position into the jaw SETPOINT, not its position', () => {
    const { cylinder, jaw } = makeGripper({ dynamic: true });
    cylinder.currentPosition = 12;
    jaw.update(DT);
    // The setpoint followed the gear...
    expect(jaw.commandedPosition).toBeCloseTo(12, 9);
    // ...and the POSITION did not move, because nobody has stepped the physics.
    // That is the whole point: in `forcefit` the jaw closes because the actuator
    // is told to, and `forcerange` decides how far it actually gets.
    expect(jaw.currentPosition).toBe(0);
  });

  it('applies GearFactor and Offset to the setpoint exactly as update() does to the position', () => {
    const dyn = makeGripper({ dynamic: true, factor: 2, offset: 5 });
    dyn.cylinder.currentPosition = 40;
    dyn.jaw.update(DT);
    expect(dyn.jaw.commandedPosition).toBeCloseTo(85, 9);

    // The kinematic gripper reaches the same number through the position, which
    // is what pins the two branches to ONE formula.
    const kin = makeGripper({ dynamic: false, factor: 2, offset: 5 });
    kin.cylinder.currentPosition = 40;
    kin.jaw.update(DT);
    expect(kin.jaw.currentPosition).toBeCloseTo(85, 9);
  });

  it('tracks the cylinder as it strokes, one setpoint per tick', () => {
    const { cylinder, jaw } = makeGripper({ dynamic: true });
    const seen: number[] = [];
    for (const mm of [0, 3, 7, 11, 15]) {
      cylinder.currentPosition = mm;
      jaw.update(DT);
      seen.push(jaw.commandedPosition);
    }
    expect(seen).toEqual([0, 3, 7, 11, 15]);
  });

  it('reports the following error against the setpoint the physics answered', () => {
    const { cylinder, jaw } = makeGripper({ dynamic: true });
    cylinder.currentPosition = 15;
    jaw.update(DT);
    // The actuator got to 14.2 mm of the commanded 15 — a part between the jaws.
    jaw.reportDynamicSample(14.2, 48, false);
    expect(jaw.followingError).toBeCloseTo(0.8, 9);
    expect(jaw.actualTorque).toBe(48);
  });

  // ── The three regressions the reverted attempt broke ──────────────────────

  it('leaves the KINEMATIC gripper on its old path — position, speed and transform', () => {
    const { cylinder, jaw, gear } = makeGripper({ dynamic: false });
    expect(jaw.positionOverwrite).toBe(false);
    cylinder.currentPosition = 9;
    cylinder.currentSpeed = 120;
    jaw.update(DT);
    expect(jaw.currentPosition).toBeCloseTo(9, 9);
    expect(jaw.currentSpeed).toBeCloseTo(120, 9);
    // And no setpoint was invented on a kinematic axis.
    expect(Number.isNaN(jaw.commandedPosition)).toBe(true);
    expect(gear.gearedPosition).toBeCloseTo(9, 9);
  });

  it('does not run the behavior loop for a KINEMATIC drive under positionOverwrite', () => {
    // Recording playback / a multiuser follower: the position comes from
    // outside and NOTHING may contribute a command. A behavior that ran here
    // would fight the playback.
    const { cylinder, jaw } = makeGripper({ dynamic: false });
    jaw.positionOverwrite = true;
    jaw.currentPosition = 4.44;   // what the playback wrote
    cylinder.currentPosition = 15;
    jaw.update(DT);
    expect(jaw.currentPosition).toBeCloseTo(4.44, 9);
    expect(Number.isNaN(jaw.commandedPosition)).toBe(true);
  });

  it('calls commandDynamicSetpoint ONLY on a dynamic axis', () => {
    const calls: string[] = [];
    const probe: IDriveBehavior = {
      update: () => calls.push('update'),
      commandDynamicSetpoint: () => calls.push('setpoint'),
    };

    const kin = makeGripper({ dynamic: false });
    kin.jaw.positionOverwrite = true;
    kin.jaw.driveBehaviors.push(probe);
    kin.jaw.update(DT);
    expect(calls).toEqual([]);

    const dyn = makeGripper({ dynamic: true });
    dyn.jaw.driveBehaviors.push(probe);
    dyn.jaw.update(DT);
    expect(calls).toEqual(['setpoint']);
  });

  it('refuses to command a jaw whose master could not be resolved', () => {
    const { jaw, gear } = makeGripper({ dynamic: true });
    // What an unresolved ComponentReference leaves behind.
    (gear as unknown as { master: RVDrive | null }).master = null;
    jaw.update(DT);
    expect(Number.isNaN(jaw.commandedPosition)).toBe(true);
  });

  it('is inert when called directly on a kinematic drive — the public guard', () => {
    const { cylinder, jaw, gear } = makeGripper({ dynamic: false });
    cylinder.currentPosition = 15;
    gear.commandDynamicSetpoint(DT);
    expect(Number.isNaN(jaw.commandedPosition)).toBe(true);
  });
});

describe('plan-673 Phase 5 — the cost of the route in the hot loop', () => {
  /**
   * The change touches the hot drive loop, so it is measured and not asserted
   * by inspection.
   *
   * What it costs for the overwhelmingly common case — a kinematic drive, with
   * or without `positionOverwrite` — must be ONE boolean test. The comparison
   * is against a drive on the ordinary path, because that is the branch every
   * non-physics scene takes, and the number quoted is per-drive per-tick.
   */
  it('costs a kinematic overwrite drive no measurable behavior loop', () => {
    const TICKS = 200_000;
    const kin = makeGripper({ dynamic: false });
    kin.jaw.positionOverwrite = true;
    const dyn = makeGripper({ dynamic: true });
    dyn.cylinder.currentPosition = 7;

    // Warm-up, so neither number is a JIT artefact.
    for (let i = 0; i < 20_000; i++) { kin.jaw.update(DT); dyn.jaw.update(DT); }

    const t0 = performance.now();
    for (let i = 0; i < TICKS; i++) kin.jaw.update(DT);
    const kinNs = ((performance.now() - t0) * 1e6) / TICKS;

    const t1 = performance.now();
    for (let i = 0; i < TICKS; i++) dyn.jaw.update(DT);
    const dynNs = ((performance.now() - t1) * 1e6) / TICKS;

    console.log(
      `[hot-loop] kinematic overwrite ${kinNs.toFixed(0)} ns/tick, dynamic axis with the gear route `
      + `${dynNs.toFixed(0)} ns/tick (delta ${(dynNs - kinNs).toFixed(0)} ns)`,
    );

    // Order of magnitude only — a tight wall-clock bound on a shared machine is
    // the documented way to produce a red test that is about the machine.
    // 2 µs per drive per tick would be 120 µs/s for a 6-axis robot, i.e. 0.7 %
    // of one 60 Hz frame; anything near that is a different implementation.
    expect(kinNs).toBeLessThan(2000);
    expect(dynNs).toBeLessThan(2000);
  });
});
