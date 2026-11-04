// plan-659 Phase 3 — one drive axis driven by a MuJoCo position actuator.
//
// This file answers the two Phase-3 questions with numbers:
//
//  A) THE MECHANISM. Can an external computer own a drive's ACTUAL position
//     without a core change and without an AxisOwnership claim? The answer is
//     `drive.positionOverwrite` (rv-drive.ts:307) — and the tests below pin
//     both halves of it: with the flag the position we write survives the
//     drive's own update AND `Drive_FollowPosition`; without the flag
//     `Drive_FollowPosition` snaps the axis to the raw setpoint
//     (rv-drive-follow-position.ts:170), which is the stumbling block the
//     review found.
//
//  B) THE AXIS. Tracking error under gravity, saturation at a small
//     `forcerange`, actual torque as a signal, and the acceptance case
//     "setpoint through a real signal, disconnect → the axis holds".
//
// Run:  node scripts/with-test-lock.mjs npx vitest run -c spikes/659/vitest.config.ts -t "Phase 3"
import { afterAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Object3D } from 'three';
import { RVDrive } from '@rv/core/engine/rv-drive';
import { DriveDirection } from '@rv/core/engine/rv-coordinate-utils';
import { RVDriveFollowPosition } from '@rv/core/engine/rv-drive-follow-position';
import { SignalStore } from '@rv/core/engine/rv-signal-store';
import { NodeRegistry } from '@rv/core/engine/rv-node-registry';
import { RVMuJoCoWorld } from '@rv-private/mujoco/rv-mujoco-world';
import {
  DEG_PER_RAD,
  RVDynamicDriveAdapter,
} from '@rv-private/mujoco/rv-dynamic-drive-adapter';

// ── The axis under test ─────────────────────────────────────────────────────
//
// One hinge about Y at 0.5 m height carrying a 1 kg capsule arm of 0.3 m, so
// the centre of mass sits 0.15 m out: at qpos = 0 (arm horizontal) gravity
// needs 1 * 9.81 * 0.15 = 1.47 Nm to hold the axis. That number is what makes
// the tracking error and the saturation visible instead of theoretical.
//
// `angle="radian"` on purpose: MJCF defaults to DEGREES for ranges, and a
// position actuator's ctrl is in joint units. Pinning the unit here keeps the
// adapter's one conversion (DEG_PER_RAD) the only one in the chain.
const GRAVITY_TORQUE_NM = 9.81 * 1.0 * 0.15;

function oneAxisXml(opts: {
  kp: number; kv: number; forcerange: number; timestep?: number; damping?: number;
}): string {
  return `<mujoco model="rv-one-axis">
  <compiler angle="radian"/>
  <option timestep="${opts.timestep ?? 0.002}" gravity="0 0 -9.81"/>
  <worldbody>
    <geom name="floor" type="plane" size="0 0 0.05" pos="0 0 0"/>
    <body name="link" pos="0 0 0.5">
      <joint name="axis" type="hinge" axis="0 1 0" range="-3.14159 3.14159" damping="${opts.damping ?? 0.5}"/>
      <geom name="arm" type="capsule" fromto="0 0 0 0.3 0 0" size="0.02" mass="1.0"/>
    </body>
  </worldbody>
  <actuator>
    <position name="axis_pos" joint="axis"
              kp="${opts.kp}" kv="${opts.kv}"
              forcerange="-${opts.forcerange} ${opts.forcerange}"
              ctrlrange="-3.14159 3.14159"/>
  </actuator>
</mujoco>`;
}

/** A drive on a bare node, rotary (degrees), nothing else wired. */
function makeDrive(name = 'Axis1'): RVDrive {
  const node = new Object3D();
  node.name = name;
  const drive = new RVDrive(node);
  drive.Direction = DriveDirection.RotationY;
  drive.UseLimits = false;
  drive.initDrive();
  return drive;
}

const FIXED_DT = 1 / 60;

/** Measured numbers for the plan's Phase 3 result section. */
const report: Record<string, unknown> = {
  plan: 659,
  phase: 3,
  measured: new Date().toISOString().slice(0, 10),
  fixedDt: FIXED_DT,
  gravityTorqueNm: GRAVITY_TORQUE_NM,
};

afterAll(() => {
  writeFileSync(
    resolve(__dirname, 'phase3-report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
});

async function makeAxis(opts: { kp?: number; kv?: number; forcerange?: number } = {}) {
  const world = await RVMuJoCoWorld.load(oneAxisXml({
    kp: opts.kp ?? 20,
    kv: opts.kv ?? 1,
    forcerange: opts.forcerange ?? 5,
  }));
  const drive = makeDrive();
  const adapter = new RVDynamicDriveAdapter(world, {
    drive,
    actuator: 'axis_pos',
    joint: 'axis',
    unitsPerJointUnit: DEG_PER_RAD,
  });
  adapter.activate();
  return { world, drive, adapter };
}

/** One fixed tick in the viewer's order: PRE (adapter) → SIM (drive.update). */
function tick(adapter: RVDynamicDriveAdapter, drive: RVDrive, dt = FIXED_DT): void {
  adapter.tick(dt);
  drive.update(dt);
}

describe('Phase 3 A — the mechanism (no core change)', () => {
  it('positionOverwrite keeps an externally written currentPosition through drive.update()', () => {
    const drive = makeDrive();
    // A drive that WOULD move on its own: jog armed, target speed set.
    drive.TargetSpeed = 90;
    drive.targetSpeed = 90;
    drive.jogForward = true;

    // Without the flag the drive integrates straight over the written value.
    // (Unity parity: the jog integrates with the PREVIOUS tick's speed, so the
    // first tick after a standstill only arms the speed — hence three ticks.)
    drive.currentPosition = 12.5;
    for (let i = 0; i < 3; i++) drive.update(FIXED_DT);
    expect(drive.currentPosition).not.toBeCloseTo(12.5, 6);

    // With the flag it does not touch the position at all.
    drive.positionOverwrite = true;
    drive.currentPosition = 12.5;
    drive.update(FIXED_DT);
    expect(drive.currentPosition).toBeCloseTo(12.5, 12);
    // …and it still derives a speed from the delta, so charts keep data.
    expect(drive.currentSpeed).toBeGreaterThan(0);
  });

  it('Drive_FollowPosition DOES overwrite the position without the flag (the review finding)', () => {
    const store = new SignalStore();
    store.register('Axis1_Set', 'PLC/Axis1_Set', 0);
    const drive = makeDrive();
    const path = NodeRegistry.computeNodePath(drive.node);

    const follow = new RVDriveFollowPosition(drive.node);
    follow.Position = 'PLC/Axis1_Set';
    const registry = new NodeRegistry();
    registry.register('Drive', path, drive);
    follow.init({ registry, signalStore: store } as never);

    store.setByPath('PLC/Axis1_Set', 45);
    // An external computer writes the PHYSICAL position first…
    drive.currentPosition = 30;
    drive.update(FIXED_DT);
    // …and the behavior has replaced it with the raw setpoint. No dynamics.
    expect(drive.currentPosition).toBeCloseTo(45, 9);
  });

  it('positionOverwrite also keeps Drive_FollowPosition out of the way', () => {
    const store = new SignalStore();
    store.register('Axis1_Set', 'PLC/Axis1_Set', 0);
    const drive = makeDrive();
    const path = NodeRegistry.computeNodePath(drive.node);

    const follow = new RVDriveFollowPosition(drive.node);
    follow.Position = 'PLC/Axis1_Set';
    const registry = new NodeRegistry();
    registry.register('Drive', path, drive);
    follow.init({ registry, signalStore: store } as never);

    store.setByPath('PLC/Axis1_Set', 45);
    drive.positionOverwrite = true;
    drive.currentPosition = 30;
    drive.update(FIXED_DT);
    // The overwrite branch returns BEFORE the behavior loop (rv-drive.ts:770).
    expect(drive.currentPosition).toBeCloseTo(30, 12);
  });

  it('direct-feedback listeners still fire under positionOverwrite', () => {
    const drive = makeDrive();
    let fired = 0;
    drive.addAfterUpdate(() => { fired++; });
    drive.positionOverwrite = true;
    drive.currentPosition = 5;
    drive.update(FIXED_DT);
    drive.currentPosition = 6;
    drive.update(FIXED_DT);
    // This is the path a `direct-feedback` signal binding is driven by
    // (rv-signal-binding-manager.ts:368 → addFeedbackListener).
    expect(fired).toBe(2);
  });
});

describe('Phase 3 B — the axis (MuJoCo position actuator)', () => {
  it('holds the setpoint with a steady-state tracking error set by kp and gravity', async () => {
    const { world, drive, adapter } = await makeAxis({ kp: 20, kv: 1, forcerange: 5 });
    try {
      // Hold horizontal (0 deg) — the worst case for gravity on this arm.
      adapter.commandPosition(0);
      for (let i = 0; i < 300; i++) tick(adapter, drive); // 5 s

      const s = adapter.lastSample;
      // kp * err = gravity torque → err = 1.47 / 20 rad = 4.22 deg.
      const expectedDeg = (GRAVITY_TORQUE_NM / 20) * DEG_PER_RAD;
      expect(Math.abs(s.error)).toBeGreaterThan(expectedDeg * 0.7);
      expect(Math.abs(s.error)).toBeLessThan(expectedDeg * 1.3);
      expect(Math.abs(s.torque)).toBeGreaterThan(GRAVITY_TORQUE_NM * 0.8);
      expect(s.saturated).toBe(false);
      // The drive carries the PHYSICAL position, not the setpoint.
      expect(drive.currentPosition).toBeCloseTo(s.actual, 9);
      expect(drive.currentPosition).not.toBeCloseTo(0, 1);
      report.hold = {
        kp: 20, kv: 1, forcerangeNm: 5, setpointDeg: 0,
        actualDeg: s.actual, trackingErrorDeg: s.error, predictedErrorDeg: expectedDeg,
        torqueNm: s.torque, saturated: s.saturated, subStepsPerTick: s.subSteps,
      };
    } finally {
      adapter.dispose();
      world.dispose();
    }
  });

  it('shows a dynamic tracking error while following a ramp', async () => {
    const { world, drive, adapter } = await makeAxis({ kp: 20, kv: 1, forcerange: 5 });
    try {
      adapter.commandPosition(0);
      for (let i = 0; i < 120; i++) tick(adapter, drive); // settle 2 s

      let maxErr = 0;
      const rateDegPerS = 60;
      for (let i = 0; i < 180; i++) { // 3 s ramp to +180 deg
        adapter.commandPosition(i * FIXED_DT * rateDegPerS);
        tick(adapter, drive);
        maxErr = Math.max(maxErr, Math.abs(adapter.lastSample.error));
      }
      // A kinematic drive would report error 0 by construction; this one cannot.
      expect(maxErr).toBeGreaterThan(1);
      expect(Number.isFinite(drive.currentPosition)).toBe(true);
      report.ramp = {
        rateDegPerS, maxTrackingErrorDeg: maxErr,
        endSetpointDeg: 180, endActualDeg: adapter.lastSample.actual,
        endTorqueNm: adapter.lastSample.torque,
      };
    } finally {
      adapter.dispose();
      world.dispose();
    }
  });

  it('saturates at a small forcerange — the axis droops and reports it', async () => {
    const strong = await makeAxis({ kp: 20, kv: 1, forcerange: 5 });
    const weak = await makeAxis({ kp: 20, kv: 1, forcerange: 0.5 });
    try {
      for (const a of [strong, weak]) {
        a.adapter.commandPosition(0);
        for (let i = 0; i < 900; i++) tick(a.adapter, a.drive); // 15 s — the weak
        // axis swings into its droop and has to settle there first.
      }
      const s = strong.adapter.lastSample;
      const w = weak.adapter.lastSample;

      expect(w.saturated).toBe(true);
      expect(Math.abs(w.torque)).toBeLessThanOrEqual(0.5 + 1e-6);
      // The weak motor cannot hold 1.47 Nm, so the arm hangs down until the
      // gravity torque equals the force limit: cos(droop) * 1.47 = 0.5.
      const droopDeg = Math.acos(0.5 / GRAVITY_TORQUE_NM) * DEG_PER_RAD;
      expect(Math.abs(w.error)).toBeGreaterThan(droopDeg * 0.7);
      expect(Math.abs(w.error)).toBeGreaterThan(Math.abs(s.error) * 5);
      expect(weak.adapter.forceRange).toBe(0.5);
      expect(strong.adapter.forceRange).toBe(5);
      report.saturation = {
        setpointDeg: 0,
        strong: { forcerangeNm: 5, actualDeg: s.actual, errorDeg: s.error, torqueNm: s.torque, saturated: s.saturated },
        weak: { forcerangeNm: 0.5, actualDeg: w.actual, errorDeg: w.error, torqueNm: w.torque, saturated: w.saturated },
        predictedDroopDeg: droopDeg,
      };
    } finally {
      for (const a of [strong, weak]) { a.adapter.dispose(); a.world.dispose(); }
    }
  });

  it('takes the setpoint from a real signal and HOLDS when the signal disconnects', async () => {
    const store = new SignalStore();
    store.register('Axis1_Set', 'PLC/Axis1_Set', 0);
    store.register('Axis1_Act', 'PLC/Axis1_Act', 0);
    store.register('Axis1_Trq', 'PLC/Axis1_Trq', 0);

    const world = await RVMuJoCoWorld.load(oneAxisXml({ kp: 20, kv: 1, forcerange: 5 }));
    const drive = makeDrive();
    const adapter = new RVDynamicDriveAdapter(world, {
      drive,
      actuator: 'axis_pos',
      joint: 'axis',
      unitsPerJointUnit: DEG_PER_RAD,
      positionPath: 'PLC/Axis1_Set',
      currentPositionPath: 'PLC/Axis1_Act',
      actualTorquePath: 'PLC/Axis1_Trq',
    }, store);
    adapter.activate();
    try {
      // Setpoint through the signal — nothing pushed, nothing hardcoded.
      store.setByPath('PLC/Axis1_Set', -60);
      for (let i = 0; i < 300; i++) tick(adapter, drive); // 5 s
      const held = adapter.lastSample;
      expect(held.setpoint).toBeCloseTo(-60, 9);
      expect(held.actual).toBeLessThan(-50);
      // Actual position and actual torque left through the signal store.
      expect(store.getFloatByPath('PLC/Axis1_Act')).toBeCloseTo(held.actual, 9);
      expect(Math.abs(store.getFloatByPath('PLC/Axis1_Trq'))).toBeGreaterThan(0.1);
      expect(adapter.readFeedbackSlot('ActualTorque')).toBeCloseTo(held.torque, 12);

      // DISCONNECT: the binding manager neutralizes the command slot, which
      // sets the source signal to 0. A naive adapter would drive the axis to
      // zero; this one latches.
      adapter.neutralizePosition();
      store.setByPath('PLC/Axis1_Set', 0);
      for (let i = 0; i < 300; i++) tick(adapter, drive); // 5 s more

      const after = adapter.lastSample;
      expect(after.holding).toBe(true);
      expect(after.setpoint).toBeCloseTo(-60, 9);
      expect(Math.abs(after.actual - held.actual)).toBeLessThan(1); // deg
      report.signalAndDisconnect = {
        setpointDeg: -60,
        liveActualDeg: held.actual, liveErrorDeg: held.error, liveTorqueNm: held.torque,
        signalActualDeg: store.getFloatByPath('PLC/Axis1_Act'),
        signalTorqueNm: store.getFloatByPath('PLC/Axis1_Trq'),
        afterDisconnectActualDeg: after.actual,
        afterDisconnectSetpointDeg: after.setpoint,
        driftDeg: Math.abs(after.actual - held.actual),
        holding: after.holding,
      };
    } finally {
      adapter.dispose();
      world.dispose();
    }
  });

  it('deactivate hands the axis back to the drive', async () => {
    const { world, drive, adapter } = await makeAxis();
    try {
      adapter.commandPosition(0);
      for (let i = 0; i < 60; i++) tick(adapter, drive);
      expect(drive.positionOverwrite).toBe(true);
      adapter.deactivate();
      expect(drive.positionOverwrite).toBe(false);
      // The drive's own physics is inert (no command) but alive again.
      const before = drive.currentPosition;
      drive.update(FIXED_DT);
      expect(drive.currentPosition).toBeCloseTo(before, 9);
    } finally {
      adapter.dispose();
      world.dispose();
    }
  });
});
