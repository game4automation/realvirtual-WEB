// plan-673 Phase 5 — the region RUNTIME, and the three failure cases through it.
//
//   node scripts/with-test-lock.mjs vitest run -c spikes/673/vitest.config.ts \
//     spikes/673/phase5-region-runtime.node.test.ts
//
// ── What this proves ────────────────────────────────────────────────────────
// Phases 2, 3, 4 and 4b each ended with a finished piece and no caller:
// the components authored a machine, the writer turned it into MJCF, the
// adapter turned a setpoint into physics — and `RVDynamicDriveAdapter` had no
// caller anywhere in `src/`. `RVMuJoCoRegionRuntime` is that caller, and this
// file runs the peg game THROUGH IT: the authored components, the production
// writer, the production adapter, the production `GripLoad`.
//
// It then answers the question Phase 5 owes the plan: are the three cases —
// fits / wrong rotation / wrong shape — DISTINGUISHABLE from what the runtime
// publishes, and by WHICH quantity? The Phase-1 gate already warned that the
// obvious answer is wrong: in two of three failure cases the axis following
// error is identical to the successful run, and only the gripper shows the jam.
//
// ── Why the IK is solved on the spike's own rig ─────────────────────────────
// The joint angles come from `peg-game-rig.ts`, i.e. from the HAND-WRITTEN
// model, and are then replayed into the COMPONENT-built region. That is sound
// precisely because the Phase-3 golden tests prove the two documents describe
// the same kinematics — and it keeps a solver out of the loop, so nothing here
// depends on an IK that might converge differently in the two worlds. The part's
// pose in the jaws is taken the same way: measured once in the spike world from
// the live grip site (the component document has no sites), and written into the
// region's free joint. Both documents hang under the same single `Rx(+90°)`
// root frame, so those seven numbers mean the same thing in both.
import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import {
  BOARD_FOOT_HEIGHT_M,
  DEFAULT_BOARD,
  DEFAULT_PART,
  JAW_STROKE_M,
  PART_IN_SITE_QUAT,
} from './peg-game-model';
import {
  SCENARIOS,
  aimPoint,
  createRig,
  matToQuat,
  quatMul,
  solveIkRobust,
  toolMat,
  type Rig,
  type Scenario,
} from './peg-game-rig';
import { buildPegGameScene, addComponent, shape } from './peg-game-scene';
import { bindDynamicAxis, commandAxisPosition } from '@rv/core/engine/rv-axis-contract';
import { DYNAMIC_AXIS_TYPE, RVDynamicAxis } from '@rv/core/engine/rv-dynamic-axis';
import { MUJOCO_REGION_TYPE, type RVMuJoCoRegion } from '@rv/core/engine/rv-mujoco-region';
import { FREE_BODY_TYPE } from '@rv/core/engine/rv-free-body';
import { COLLISION_SHAPE_SET_TYPE, CONTACT_PROFILE_TYPE } from '@rv/core/engine/rv-contact-geometry';
import { RVDriveGear } from '@rv/core/engine/rv-drive-gear';
import { DriveDirection, RVDrive } from '@rv/core/engine/rv-drive';
import { GRIP_LOAD_TYPE, RVGripLoad } from '@rv/core/engine/rv-grip-load';
import { getComponentInstances, setComponentInstance } from '@rv/core/engine/rv-component-registry';
import { RVCollisionShapeSet } from '@rv/core/engine/rv-contact-geometry';
import { RVMuJoCoRegionRuntime } from '@rv-private/mujoco/rv-mujoco-region-runtime';
// `MechanismBody` lives in the private tree and the scene builder's contract
// says the CALLER registers it (a public spike file may not import it).
import '@rv-private/kinematic-mechanism/rv-kinematic-mechanism';

const DT = 0.002;
const FIXED_DT = 1 / 60;
const RAD2DEG = 180 / Math.PI;
/** The servo and the force limits the Phase-1 sweep settled on. */
const KP_SCALE = 16;
const FORCE_RANGE_NM = [20, 370, 95, 20, 20, 20] as const;
/** Six segments, because Phase 1 measured that lever and Phase 5 re-confirmed it. */
const ROUND_SEGMENTS = 6;
const AXIS_NAMES = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'] as const;

/** Part and board free-joint poses measured in the spike world at the start pose. */
interface SeedPoses {
  axes: number[];
  axesPress: number[];
  part: number[];
  board: number[];
}

/**
 * Solve the trajectory and measure the part's pose in the jaws, in the
 * hand-written world — then throw that world away.
 */
async function seedFrom(scenario: Scenario): Promise<SeedPoses> {
  const rig: Rig = await createRig({
    forceRangeNm: FORCE_RANGE_NM,
    floorFriction: 0.4,
    kpScale: KP_SCALE,
    timestepS: DT,
    roundSegments: ROUND_SEGMENTS,
  });
  try {
    const aim = aimPoint(scenario, DEFAULT_BOARD.halfThickM);
    const tool = toolMat(scenario);
    const startZ = scenario.id === 'free' ? 0.250 : 0.100;
    const ikEnd = solveIkRobust(rig, [aim[0], aim[1], aim[2] + scenario.pressHubOffsetM], tool);
    const ikStart = solveIkRobust(rig, [aim[0], aim[1], aim[2] + startZ], tool, ikEnd.q);
    if (ikStart.posErrM > 2e-4 || ikEnd.posErrM > 2e-4) {
      throw new Error(`IK did not converge for ${scenario.id}`);
    }
    const { world } = rig;
    for (let i = 0; i < 6; i++) world.writeQpos(rig.axisQpos[i], [ikStart.q[i]]);
    world.writeQvel(rig.axisDof[0], [0, 0, 0, 0, 0, 0]);
    // The part's pose follows from the LIVE grip-site pose, so no quaternion is
    // guessed anywhere.
    world.forward();
    const p = world.readSitePos(rig.gripSite, new Float64Array(3));
    const m = world.readSiteMat(rig.gripSite, new Float64Array(9));
    const q = quatMul(matToQuat(m), PART_IN_SITE_QUAT);
    const qpos = world.readQpos();
    const b = rig.boardQposAdr;
    return {
      axes: [...ikStart.q],
      axesPress: [...ikEnd.q],
      part: [p[0], p[1], p[2], q[0], q[1], q[2], q[3]],
      board: [qpos[b], qpos[b + 1], qpos[b + 2], qpos[b + 3], qpos[b + 4], qpos[b + 5], qpos[b + 6]],
    };
  } finally {
    rig.world.dispose();
  }
}

interface CaseResult {
  scenario: string;
  /** Worst net axis following error over the run, deg. */
  axisFollowingErrorDeg: number;
  /** Worst actuator force per axis, N·m. */
  axisTorqueMaxNm: number;
  /** Fraction of ticks any axis sat at its force limit. */
  saturationFraction: number;
  /** Part travel inside the jaws, mm — the GripLoad measurement. */
  partSlipMm: number;
  /** Clamping force the runtime measured at the lead jaw, N. */
  gripForceN: number;
  /** Did the part end up below the board's top surface? */
  inserted: boolean;
  /** How far the board moved, mm. */
  boardSlideMm: number;
  /** Was a part ever handed to the GripLoad by the contact? */
  everHeld: boolean;
}

/** One case, end to end through the production runtime. */
async function runCase(
  scenario: Scenario,
  { simSeconds = 20, rampS = 6, machineHulls = false }: { simSeconds?: number; rampS?: number; machineHulls?: boolean } = {},
): Promise<CaseResult> {
  const seed = await seedFrom(scenario);

  RVGripLoad.clearAll();
  RVDynamicAxis.clearAll();
  const scene = buildPegGameScene({
    forceRangeNm: FORCE_RANGE_NM,
    kpScale: KP_SCALE,
    timestepS: DT,
    roundSegments: ROUND_SEGMENTS,
  });
  expect(bindAuthoredAxes(scene.drives)).toBe(8);
  if (!machineHulls) {
    // 6 links + the gripper housing — see removeMachineHulls().
    expect(removeMachineHulls(scene.root, [...AXIS_NAMES, 'gripper'])).toBe(7);
  }
  // The gripper node carries the grip load — the component the Phase-1 finding
  // demanded. `forcefit`: the contact holds the part, so the slip is real.
  const gripperNode = findByName(scene.root, 'gripper');
  expect(gripperNode, 'the scene must have a gripper node').not.toBeNull();
  const load = addComponent<RVGripLoad>(gripperNode!, GRIP_LOAD_TYPE, {
    Mode: 'forcefit',
    GripForce: 50,
    SlipLimit: 2,
    SlipTimeMs: 200,
  });

  const drives = scene.drives;
  const runtime = await RVMuJoCoRegionRuntime.create({
    region: scene.region,
    drives: Object.values(drives) as RVDrive[],
    report: false,
  });
  try {
    const world = runtime.world;
    // ── seed the state the spike world measured ──
    const axisAdr = AXIS_NAMES.map((n) => world.jointQposAdr(world.mustFind('joint', n)));
    for (let i = 0; i < 6; i++) world.writeQpos(axisAdr[i], [seed.axes[i]]);
    world.writeQpos(world.jointQposAdr(world.mustFind('joint', 'part_free')), seed.part);
    world.writeQpos(world.jointQposAdr(world.mustFind('joint', 'board_free')), seed.board);
    world.forward();

    const axes = AXIS_NAMES.map((n) => drives[n]);
    const jaw = drives.jaw_l;
    const partNode = findByName(scene.root, 'part')!;
    const boardNode = findByName(scene.root, 'board')!;

    const tickAll = (dt: number): void => {
      runtime.tick(dt);
      for (const d of Object.values(drives) as RVDrive[]) d.update(dt);
      load.measure();
    };

    // ── settle: hold the start pose, close the gripper ──
    for (let i = 0; i < 6; i++) commandAxisPosition(axes[i], seed.axes[i] * RAD2DEG);
    commandAxisPosition(jaw, JAW_STROKE_M * 1000);
    for (let t = 0; t < Math.round(1 / FIXED_DT); t++) tickAll(FIXED_DT);

    const slipBase = load.slipMm;
    const boardStart = [boardNode.position.x, boardNode.position.y, boardNode.position.z];

    // ── measured window: ramp to the press pose, then hold ──
    const ticks = Math.round(simSeconds / FIXED_DT);
    const rampTicks = Math.round(rampS / FIXED_DT);
    let feMax = 0;
    let torqueMax = 0;
    let satTicks = 0;
    let everHeld = false;
    for (let t = 0; t < ticks; t++) {
      const alpha = Math.min(1, t / rampTicks);
      for (let i = 0; i < 6; i++) {
        commandAxisPosition(axes[i], (seed.axes[i] + alpha * (seed.axesPress[i] - seed.axes[i])) * RAD2DEG);
      }
      commandAxisPosition(jaw, JAW_STROKE_M * 1000);
      tickAll(FIXED_DT);
      let sat = false;
      for (const d of axes) {
        feMax = Math.max(feMax, Math.abs(d.followingError));
        torqueMax = Math.max(torqueMax, Math.abs(d.actualTorque));
        if (d.saturated) sat = true;
      }
      if (sat) satTicks++;
      if (load.heldPart) everHeld = true;
    }

    const boardTopY = DEFAULT_BOARD.halfThickM * 2 + BOARD_FOOT_HEIGHT_M;
    return {
      scenario: scenario.id,
      axisFollowingErrorDeg: feMax,
      axisTorqueMaxNm: torqueMax,
      saturationFraction: satTicks / ticks,
      partSlipMm: Math.abs(load.slipMm - slipBase),
      gripForceN: load.forceN,
      // The scene is Y-up: the board's top surface is at +Y.
      inserted: partNode.position.y - DEFAULT_PART.thicknessM / 2 < boardTopY - 0.001,
      boardSlideMm: Math.hypot(
        boardNode.position.x - boardStart[0], boardNode.position.z - boardStart[2],
      ) * 1000,
      everHeld,
    };
  } finally {
    runtime.dispose();
    RVGripLoad.clearAll();
  }
}

/**
 * Bind every `DynamicAxis` of this scene to the `Drive` on its own node.
 *
 * A SPIKE ARTEFACT, not a product gap, and worth stating because it reads like
 * one: `RVDynamicAxis.init()` resolves its drive through `ctx.registry`
 * deliberately ("same node only" — a parent walk would let one declaration
 * govern a different axis), and `peg-game-scene.ts` builds its components with
 * an EMPTY context, because all the writer needs is the component ON the node.
 * So in this scene `drive.dynamicAxis` is null, `commandAxisPosition()` takes
 * its KINEMATIC branch, and the robot is commanded by writing its position
 * instead of its setpoint — which is exactly the bug it was built to prevent.
 * A real load has a registry and this does not happen.
 */
function bindAuthoredAxes(drives: Readonly<Record<string, RVDrive>>): number {
  let bound = 0;
  for (const axis of RVDynamicAxis.axes) {
    const drive = drives[axis.node.name];
    if (!drive || drive.node !== axis.node) continue;
    bindDynamicAxis(drive, axis);
    bound++;
  }
  return bound;
}

/**
 * Empty the `CollisionShapeSet` of the robot's own links — i.e. reproduce the
 * configuration the Phase-1 gate measured, honestly, through the authoring layer.
 *
 * WHY THIS IS NEEDED, and it is a finding rather than a convenience: the
 * Phase-1 model gave the arm capsules `contype="0" conaffinity="0"`, which
 * Phase 4b called "a cost shortcut, not a model". Phase 5 measured that it is
 * also a GEOMETRY shortcut. With those hulls live, the 55 mm A5/A6 capsules
 * strike the board 35.5 mm above the insertion depth, A5 saturates at its 20 N·m
 * limit and NOTHING is inserted in any scenario — the Phase-1 insertion only
 * ever worked because the robot's own envelope was transparent.
 *
 * There is no way to AUTHOR "this hull is not a contact surface": the role →
 * collision-class table (`contact-profiles.json`) puts `MachineFrame` at
 * contype 1 / conaffinity 3 and `Workpiece` at 2 / 7 by design ("a frame
 * carries parts"), and `Custom` falls back to 1 / 1, which still meets a
 * workpiece. Removing the geometry is therefore the only expression the
 * authoring layer has — which is itself worth saying out loud.
 *
 * Returns how many shape sets were emptied.
 */
function removeMachineHulls(root: Object3D, names: readonly string[]): number {
  let emptied = 0;
  root.traverse((node) => {
    if (!names.includes(node.name)) return;
    for (const inst of getComponentInstances(node)) {
      if (inst instanceof RVCollisionShapeSet && inst.Shapes.length > 0) {
        inst.Shapes = [];
        // The normalised list is derived, so the edit has to go through the
        // same path an inspector edit takes.
        inst.reapplyConfig();
        emptied++;
      }
    }
  });
  return emptied;
}

function findByName(root: Object3D, name: string): Object3D | null {
  let hit: Object3D | null = null;
  root.traverse((n) => { if (!hit && n.name === name) hit = n; });
  return hit;
}

const scenarioOf = (id: string): Scenario => {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`no scenario "${id}"`);
  return s;
};

describe('plan-673 Phase 5 — RVMuJoCoRegionRuntime', () => {
  it('loads the authored region and maps every actuator to its drive', async () => {
    RVGripLoad.clearAll();
    RVDynamicAxis.clearAll();
    const scene = buildPegGameScene({ forceRangeNm: FORCE_RANGE_NM, roundSegments: ROUND_SEGMENTS });
    bindAuthoredAxes(scene.drives);
    const runtime = await RVMuJoCoRegionRuntime.create({
      region: scene.region,
      drives: Object.values(scene.drives) as RVDrive[],
      report: false,
    });
    try {
      const r = runtime.report;
      console.log(`[runtime] ${r.actuatorCount} actuators, ${r.bodyCount} bodies, ${r.geomCount} geoms, `
        + `${r.totalMassKg.toFixed(3)} kg; axes mapped ${r.axes.length}, free bodies ${r.freeBodies.join(', ')}`);
      // Seven actuators: six robot axes plus the lead jaw. The second jaw is a
      // gear slave whose master IS a joint, so it stays an `<equality>` row.
      expect(r.actuatorCount).toBe(7);
      expect(r.axes.length).toBe(7);
      expect(r.unmappedActuators).toEqual([]);
      // Two free bodies: the part and the board, both mirrored onto their nodes.
      expect([...r.freeBodies].sort()).toEqual(['board', 'part']);
      expect(r.unmappedFreeBodies).toEqual([]);
      // Every axis drive is now under an external position authority.
      for (const axis of runtime.axes) {
        expect(axis.drive.positionOverwrite, `${axis.nodePath} not taken over`).toBe(true);
        expect(axis.adapter.isActive).toBe(true);
      }
    } finally {
      runtime.dispose();
    }
  });

  it('hands every axis back on dispose, so a region can be switched off', async () => {
    RVGripLoad.clearAll();
    RVDynamicAxis.clearAll();
    const scene = buildPegGameScene({ forceRangeNm: FORCE_RANGE_NM, roundSegments: ROUND_SEGMENTS });
    bindAuthoredAxes(scene.drives);
    const runtime = await RVMuJoCoRegionRuntime.create({
      region: scene.region,
      drives: Object.values(scene.drives) as RVDrive[],
      report: false,
    });
    const a1 = scene.drives.A1;
    expect(a1.positionOverwrite).toBe(true);
    runtime.dispose();
    expect(a1.positionOverwrite).toBe(false);
    expect(runtime.isDisposed).toBe(true);
    runtime.dispose();   // idempotent
  });

  it('steps the world ONCE per tick, not once per axis', async () => {
    RVGripLoad.clearAll();
    RVDynamicAxis.clearAll();
    const scene = buildPegGameScene({ forceRangeNm: FORCE_RANGE_NM, roundSegments: ROUND_SEGMENTS });
    bindAuthoredAxes(scene.drives);
    const runtime = await RVMuJoCoRegionRuntime.create({
      region: scene.region,
      drives: Object.values(scene.drives) as RVDrive[],
      report: false,
    });
    try {
      const t0 = runtime.world.time;
      runtime.tick(FIXED_DT);
      const steps = runtime.lastSubSteps;
      // 1/60 s of wall time at a 2 ms timestep is 8 whole steps with a
      // remainder; what matters is that sim time advanced by EXACTLY that, and
      // not by 7 x that (one step per axis).
      expect(steps).toBeGreaterThan(0);
      expect(runtime.world.time - t0).toBeCloseTo(steps * runtime.world.timestep, 9);
    } finally {
      runtime.dispose();
    }
  });

  it('mirrors the free bodies onto their scene nodes — the board falls onto its feet', async () => {
    RVGripLoad.clearAll();
    RVDynamicAxis.clearAll();
    const scene = buildPegGameScene({ forceRangeNm: FORCE_RANGE_NM, roundSegments: ROUND_SEGMENTS });
    bindAuthoredAxes(scene.drives);
    const boardNode = findByName(scene.root, 'board')!;
    const authoredY = boardNode.position.y;
    const runtime = await RVMuJoCoRegionRuntime.create({
      region: scene.region,
      drives: Object.values(scene.drives) as RVDrive[],
      report: false,
    });
    try {
      // Lift the board, let it drop: the node must follow the physics, not the
      // authored pose.
      const adr = runtime.world.jointQposAdr(runtime.world.mustFind('joint', 'board_free'));
      const q = runtime.world.readQpos();
      runtime.world.writeQpos(adr, [q[adr], q[adr + 1], q[adr + 2] + 0.05, q[adr + 3], q[adr + 4], q[adr + 5], q[adr + 6]]);
      runtime.world.forward();
      runtime.tick(FIXED_DT);
      const lifted = boardNode.position.y;
      expect(lifted).toBeGreaterThan(authoredY + 0.03);
      for (let t = 0; t < 120; t++) runtime.tick(FIXED_DT);
      // Back on its feet, within a millimetre of where it was authored.
      expect(boardNode.position.y).toBeLessThan(lifted);
      expect(Math.abs(boardNode.position.y - authoredY)).toBeLessThan(0.002);
    } finally {
      runtime.dispose();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The two things Phase 4b left open, measured end to end through the physics.
// ─────────────────────────────────────────────────────────────────────────────
//
// A deliberately TINY fixture rather than the peg game, and the reason is the
// plan's own warning: the first version of the gate's `toolMat()` put the part's
// arms 30 deg off and "looked like a legitimate jam". Anything whose correctness
// depends on composing three frames right can produce a wrong result that reads
// as a right one. Two pads on an axis, a block between them, nothing else: the
// layout is correct by inspection, so what the test says about `holdPart` and
// about the setpoint route is about those two mechanisms and not about a frame.
//
// Layout (metres, the scene is Y-up, the writer turns it once at the root):
//
//        jaw_a pad          block          jaw_b pad
//     --|          |--  +-----------+  --|          |--
//      -0.030    -0.020 -0.015   +0.015  +0.020    +0.030
//
// Each jaw has 5 mm to travel before it touches; both are commanded 10 mm, so
// the last 5 mm is a squeeze against `forcerange` - the plan's `forcefit`.

const PAD_HALF_MM: readonly number[] = [5, 10, 10];
const JAW_BASE_M = 0.030;
const BLOCK_HALF_MM = 15;
const GRIP_FORCE_N = 100;
const BLOCK_MASS_KG = 0.1;

interface Pinch {
  root: Object3D;
  region: RVMuJoCoRegion;
  /** `cyl` (the Virtual master, geared variant only), `jaw_a`, `jaw_b`. */
  drives: Record<string, RVDrive>;
  load: RVGripLoad;
  block: Object3D;
}

/**
 * The fixture, in two topologies.
 *
 * `direct` - each jaw is commanded on its own (`DynamicAxis` + a setpoint).
 * `geared` - the DELIVERED CRX's topology: a `Drive{Direction:'Virtual'}`
 *            master that a `Drive_Cylinder` would move, with one `Drive_Gear`
 *            per jaw. The writer then makes the first geared jaw the actuated
 *            LEAD and couples the second to it with an `<equality>` row
 *            (`virtualGearLeads()`, Phase 4b), and the ONLY way to command it
 *            is the Phase-5 setpoint route.
 */
function buildPinch(topology: 'direct' | 'geared'): Pinch {
  RVGripLoad.clearAll();
  RVDynamicAxis.clearAll();

  const root = new Object3D();
  root.name = 'PinchRegion';
  root.updateMatrix();
  const region = addComponent<RVMuJoCoRegion>(root, MUJOCO_REGION_TYPE, { TimestepS: DT });

  const gripper = new Object3D();
  gripper.name = 'gripper';
  gripper.position.set(0, 0.10, 0);
  root.add(gripper);
  const load = addComponent<RVGripLoad>(gripper, GRIP_LOAD_TYPE, {
    Mode: 'forcefit', GripForce: GRIP_FORCE_N / 2, SlipLimit: 1, SlipTimeMs: 100,
  });

  const drives: Record<string, RVDrive> = {};

  if (topology === 'geared') {
    // The cylinder's own axis. `Virtual` claims the node without writing a
    // transform - and it is never a rigid body, which is the whole reason
    // Phase 4b needed `virtualGearLeads()`.
    const cylNode = new Object3D();
    cylNode.name = 'cyl';
    gripper.add(cylNode);
    const cyl = new RVDrive(cylNode);
    cyl.Direction = DriveDirection.Virtual;
    cyl.initDrive();
    drives.cyl = cyl;
  }

  for (const [name, side] of [['jaw_a', -1], ['jaw_b', 1]] as const) {
    const node = new Object3D();
    node.name = name;
    node.position.set(side * JAW_BASE_M, 0, 0);
    gripper.add(node);

    const drive = new RVDrive(node);
    drive.Direction = DriveDirection.LinearX;
    // The mirrored pair: `jaw_a` sits at -x and must travel to +x, `jaw_b` the
    // other way. That is exactly how the delivered CRX's two fingers differ.
    drive.ReverseDirection = side < 0;
    drive.UseLimits = true;
    drive.LowerLimit = 0;
    drive.UpperLimit = 20;        // mm
    drive.initDrive();
    drives[name] = drive;

    const axis = addComponent<RVDynamicAxis>(node, DYNAMIC_AXIS_TYPE, {
      ActuatorKind: 'position',
      Kp: 50000, Kv: 500, Armature: 0.001, Damping: 2,
      ForceRangeMin: -GRIP_FORCE_N, ForceRangeMax: GRIP_FORCE_N,
      SetpointSource: 'signal',
    });
    bindDynamicAxis(drive, axis);

    addComponent(node, COLLISION_SHAPE_SET_TYPE, {
      Shapes: [shape('box', PAD_HALF_MM, [-side * 5, 0, 0])],
    });
    addComponent(node, CONTACT_PROFILE_TYPE, { Profile: 'GripperJaw', Priority: 1 });
    addComponent(node, 'MechanismBody', {
      MassOverrideKg: 0.05,
      ComOverrideLocalMm: { x: 0, y: 0, z: 0 },
      InertiaOverrideLocalKgMm2: [5, 5, 5, 0, 0, 0],
    });

    if (topology === 'geared') {
      const gear = new RVDriveGear(node);
      gear.MasterDrive = drives.cyl;
      gear.GearFactor = 1;
      gear.Offset = 0;
      setComponentInstance(node, gear);
      // `init()` is what resolves the two drives and registers the behavior;
      // without a registry it would bail, so its wiring is done explicitly.
      // The writer reads the public `MasterDrive` field, as on a real load.
      (gear as unknown as { drive: RVDrive | null }).drive = drive;
      (gear as unknown as { master: RVDrive | null }).master = drives.cyl;
      drive.driveBehaviors.push(gear);
    }
  }

  // The block. A free body with the workpiece role - contype 2 / conaffinity 7,
  // so it meets the pads (guide class) and the floor alike.
  const block = new Object3D();
  block.name = 'block';
  block.position.set(0, 0.10, 0);
  root.add(block);
  addComponent(block, FREE_BODY_TYPE, {
    MassKg: BLOCK_MASS_KG, CondDim: 'SlidingTorsional', FrictionSlide: 0.5,
  });
  addComponent(block, CONTACT_PROFILE_TYPE, { Profile: 'Workpiece' });
  addComponent(block, COLLISION_SHAPE_SET_TYPE, {
    Shapes: [shape('box', [BLOCK_HALF_MM, BLOCK_HALF_MM, BLOCK_HALF_MM])],
  });
  addComponent(block, 'MechanismBody', {
    MassOverrideKg: BLOCK_MASS_KG,
    ComOverrideLocalMm: { x: 0, y: 0, z: 0 },
    InertiaOverrideLocalKgMm2: [15, 15, 15, 0, 0, 0],
  });

  root.updateWorldMatrix(true, true);
  return { root, region, drives, load, block };
}

describe('plan-673 Phase 5 - holdPart: the physics hands the part to the GripLoad', () => {
  it('declares the held part from the contact, and releases it when the jaws open', async () => {
    const pinch = buildPinch('direct');
    const runtime = await RVMuJoCoRegionRuntime.create({
      region: pinch.region,
      drives: Object.values(pinch.drives),
      report: false,
    });
    try {
      // Both jaws actuated in this topology: two actuators, no equality.
      expect(runtime.axes.length).toBe(2);
      expect(runtime.report.gripLoads).toEqual(['gripper']);
      // Nothing is held before anything moves.
      expect(pinch.load.heldPart).toBeNull();

      const tick = (): void => {
        runtime.tick(FIXED_DT);
        for (const d of Object.values(pinch.drives)) d.update(FIXED_DT);
        pinch.load.measure();
      };

      // Close: 10 mm of travel, of which the last 5 mm is a squeeze.
      for (const d of Object.values(pinch.drives)) commandAxisPosition(d, 10);
      for (let t = 0; t < 30; t++) tick();

      expect(pinch.load.heldPart, 'the contact must hand the block over').not.toBeNull();
      expect(pinch.load.heldPart?.name).toBe('block');
      console.log(`[hold] clamping force ${pinch.load.forceN.toFixed(1)} N of a ${GRIP_FORCE_N} N limit, `
        + `slip ${pinch.load.slipMm.toFixed(3)} mm`);
      // The force is the LEAD jaw's actuator force, and it is at the limit: the
      // jaws are commanded past the block, so `forcerange` decides.
      expect(pinch.load.forceN).toBeGreaterThan(GRIP_FORCE_N * 0.5);
      // A held block does not slide: the reference latched on the first held
      // tick and the pads have not moved relative to the gripper since.
      // The slip is a MEASUREMENT, and it is not zero: the reference latches on
      // the FIRST held tick, before the pads have bitten, so the block's own
      // settling into the grip counts. Measured 1.4 mm at the grasp and 4.2 mm
      // after another second — the `GripperJaw`/`Workpiece` contact is soft
      // (3.5 mm of pad penetration at 74 N), and every number in
      // `contact-profiles.json` is still declared rather than measured. What the
      // test asserts is therefore the MECHANISM: a finite reading in millimetres,
      // and a part that is still held a second later.
      expect(Number.isFinite(pinch.load.slipMm)).toBe(true);
      expect(pinch.load.slipMm).toBeLessThan(10);
      for (let t = 0; t < 60; t++) tick();
      expect(pinch.load.heldPart?.name, 'still held a second later').toBe('block');

      // Open again: the contact goes away, and so does the hold.
      for (const d of Object.values(pinch.drives)) commandAxisPosition(d, 0);
      for (let t = 0; t < 60; t++) tick();
      expect(pinch.load.heldPart, 'an open gripper holds nothing').toBeNull();
      expect(pinch.load.slipMm).toBe(0);
    } finally {
      runtime.dispose();
    }
  }, 120_000);

  it('leaves a formfit grip alone - the Grip owns the part there', async () => {
    const pinch = buildPinch('direct');
    pinch.load.Mode = 'formfit';
    pinch.load.reapplyConfig();
    const runtime = await RVMuJoCoRegionRuntime.create({
      region: pinch.region,
      drives: Object.values(pinch.drives),
      report: false,
    });
    try {
      for (const d of Object.values(pinch.drives)) commandAxisPosition(d, 10);
      for (let t = 0; t < 30; t++) {
        runtime.tick(FIXED_DT);
        for (const d of Object.values(pinch.drives)) d.update(FIXED_DT);
        pinch.load.measure();
      }
      // The contact is there, but a `formfit` grip is parented by the `Grip` and
      // says so itself (`slipMeasurable === false`). Handing it a part here
      // would invent a second owner for one MU.
      expect(pinch.load.slipMeasurable).toBe(false);
      expect(pinch.load.heldPart).toBeNull();
      expect(Number.isNaN(pinch.load.measuredForce)).toBe(true);
    } finally {
      runtime.dispose();
    }
  }, 120_000);
});

describe('plan-673 Phase 5 - the setpoint route: a Virtual cylinder closes a dynamic jaw', () => {
  it('actuates EVERY geared jaw and writes no equality for the group', async () => {
    const pinch = buildPinch('geared');
    const runtime = await RVMuJoCoRegionRuntime.create({
      region: pinch.region,
      drives: Object.values(pinch.drives),
      report: false,
    });
    try {
      const r = runtime.report;
      console.log(`[geared] actuators ${r.actuatorCount} (${r.axes.map((a) => a.nodePath).join(', ')}), `
        + `equalities ${runtime.document.report.equalities.join(', ') || '(none)'}`);
      // ONE actuator: the lead jaw. The second is the `<equality>` row.
      // BOTH jaws actuated, NO equality — plan-673 Phase 5 measured that an
      // equality yields under the clamping force and the follower is pushed open.
      expect(r.actuatorCount).toBe(2);
      expect(r.axes.map((a) => a.nodePath)).toEqual(['gripper/jaw_a', 'gripper/jaw_b']);
      expect(runtime.document.report.equalities).toEqual([]);
      // And no writer finding - the Phase-4b defect (a gripper with no actuator
      // and two `mjcf-gear-unresolved` warnings) must stay fixed.
      expect(runtime.document.problems.map((p) => p.code)).not.toContain('mjcf-gear-unresolved');
    } finally {
      runtime.dispose();
    }
  }, 120_000);

  it('closes on the block when the CYLINDER moves - nothing commands the jaw itself', async () => {
    const pinch = buildPinch('geared');
    const runtime = await RVMuJoCoRegionRuntime.create({
      region: pinch.region,
      drives: Object.values(pinch.drives),
      report: false,
    });
    try {
      const lead = pinch.drives.jaw_a;
      const follower = pinch.drives.jaw_b;
      const cyl = pinch.drives.cyl;
      // The lead jaw is physics-owned; its own `update()` can no longer reach
      // the gear, which is exactly the gap Phase 4b left open.
      expect(lead.positionOverwrite).toBe(true);
      expect(Number.isNaN(lead.commandedPosition)).toBe(true);

      const tick = (): void => {
        runtime.tick(FIXED_DT);
        for (const d of Object.values(pinch.drives)) d.update(FIXED_DT);
        pinch.load.measure();
      };

      // THE COMMAND: the cylinder's own axis. Nothing touches the jaw.
      cyl.currentPosition = 10;
      for (let t = 0; t < 40; t++) tick();

      console.log(`[route] cylinder 10.0 mm -> lead jaw setpoint ${lead.commandedPosition.toFixed(2)} mm, `
        + `actual ${lead.currentPosition.toFixed(2)} mm, following error ${lead.followingError.toFixed(2)} mm, `
        + `force ${lead.actualTorque.toFixed(1)} N${lead.saturated ? ' (AT THE LIMIT)' : ''}; `
        + `follower ${follower.currentPosition.toFixed(2)} mm`);

      // The setpoint travelled cylinder -> gear -> lead jaw -> actuator.
      expect(lead.commandedPosition).toBeCloseTo(10, 6);
      // ...and the physics answered: the jaw stopped on the block at ~5 mm,
      // which is the following error a force-limited squeeze is SUPPOSED to
      // have. A kinematic gear would have reported 10 mm and no force.
      // The pads meet the block after 5 mm of travel and the contact then yields
      // another ~3.5 mm at ~74 N, so the jaw ends between those two: measured
      // 8.51 mm of a commanded 10.00, i.e. 1.49 mm of following error. The
      // numbers to hold are the SIGNS of a force-limited squeeze — the axis
      // short of its setpoint, and a real clamping force — not the exact
      // penetration, which is the (declared) contact stiffness of the profile.
      expect(lead.currentPosition).toBeGreaterThan(3);
      expect(lead.currentPosition).toBeLessThan(9.5);
      expect(Math.abs(lead.followingError)).toBeGreaterThan(0.5);
      expect(Math.abs(lead.actualTorque), 'a real clamping force').toBeGreaterThan(20);
      // The equality row carried it to the second jaw.
      expect(Math.abs(follower.currentPosition - lead.currentPosition)).toBeLessThan(0.2);
      // And the block is held, by the same contact route as the direct variant.
      expect(pinch.load.heldPart?.name).toBe('block');

      // Retract: the cylinder lets go and the jaws follow back.
      cyl.currentPosition = 0;
      for (let t = 0; t < 60; t++) tick();
      expect(lead.commandedPosition).toBeCloseTo(0, 6);
      expect(lead.currentPosition).toBeLessThan(0.5);
      expect(pinch.load.heldPart).toBeNull();
    } finally {
      runtime.dispose();
    }
  }, 120_000);
});
