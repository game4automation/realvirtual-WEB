// plan-673 Phase 5 — RE-MEASUREMENT: what the peg game costs once the ROBOT'S
// OWN LINKS COLLIDE.
//
//   node scripts/with-test-lock.mjs npx vitest run -c spikes/673/vitest.config.ts \
//     -t "colliding arm hulls"
//
// ── Why this file exists ────────────────────────────────────────────────────
// The Phase-1 gate reported 1.215 ms p95 against a 2 ms budget. That number was
// measured on a hand-written MJCF whose arm capsules carry
// `contype="0" conaffinity="0"` — the links were present as MASS and as
// INERTIA, but they could not touch anything. Phase 4b then authored the
// delivered CRX with the `MachineFrame` contact role, which is
// `contype 1 / conaffinity 3`: the arm hulls now really collide — with the
// floor, with the board, with the part, and with each other.
//
// Phase 4b wrote that down as a binding obligation on this phase:
//   "PHASE 5 MUSS DIE FRAMEKOSTEN MIT KOLLIDIERENDEN ARMHUELLEN NEU MESSEN;
//    die 1,215 ms p95 des Gates wurden ohne sie gemessen."
//
// ── Why it does not touch the spike ─────────────────────────────────────────
// `peg-game-model.ts` is the golden witness of the Phase-3 writer tests. Editing
// it to add a flag would make the witness depend on this measurement. So the
// contact flags are changed on the GENERATED XML, by one exact string
// substitution whose hit count is asserted (8 = six axis capsules + gripper +
// base). Everything else — geometry, masses, servo gains, force ranges, the
// trajectory, the clock discipline — is byte-identical to the gate.
//
// ── What is measured, and against what ──────────────────────────────────────
//   A  arms inert   (contype 0/0)  — the gate's configuration, REPRODUCED here
//                                    so the machine of this run is calibrated
//                                    against a published number before any new
//                                    number is quoted.
//   B  arms colliding (1/3)        — the delivered robot's configuration.
//   C  arms colliding + HEXAGON    — B with the one measured lever of Phase 1
//      blocking opening             (6 segments instead of 12; factor 1.58).
//
// A, B and C run the same five scenarios in the same process, one after the
// other, so the comparison A→B is a difference of ONE attribute pair and not a
// difference of two machines on two days.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BOARD_FOOT_HEIGHT_M,
  DEFAULT_BOARD,
  DEFAULT_PART,
  JAW_STROKE_M,
  PART_IN_SITE_QUAT,
  buildPegGameMjcf,
  type SceneOptions,
} from './peg-game-model';
import {
  SCENARIOS,
  aimPoint,
  matToQuat,
  quatMul,
  solveIkRobust,
  toolMat,
  type Rig,
  type Scenario,
} from './peg-game-rig';
import { RVMuJoCoWorld } from '@rv-private/mujoco/rv-mujoco-world';
import { mean, percentile } from './stats';

const REPORT_PATH = resolve(__dirname, 'phase5-colliding-arms-report.json');
const DT = 0.002;
/** The plan's abort criterion, ms per 60 Hz frame. */
const FRAME_BUDGET_MS = 2.0;
/** The servo the Phase-1 sweep PICKED (`servoSweep.chosen` of phase1-report.json). */
const KP_SCALE = 16;
/** The force limits the Phase-1 RNEA stage derived (`forceRange.chosenNm`). */
const FORCE_RANGE_NM = [20, 370, 95, 20, 20, 20] as const;
/** The gate's published verdict, for the calibration check. */
const GATE_P95_MS = 1.2150000000001455;

/** The two contact-flag strings. The inert pair is what the spike writes. */
const INERT_FLAGS = 'contype="0" conaffinity="0"';
/** `MachineFrame` as Phase 4b authored it: collides with floor, board and part. */
const MACHINE_FRAME_FLAGS = 'contype="1" conaffinity="3"';
/**
 * `MachineFrame` WITHOUT machine-against-machine contact.
 *
 * MuJoCo's rule is `(contype1 & conaffinity2) || (contype2 & conaffinity1)`.
 * Dropping bit 1 (the machine's own group) out of the affinity leaves
 * `1 & 2 = 0` in both directions between two machine hulls, while every
 * environment pair survives: floor is contype 1 (`1 & 1` from the floor's
 * side), the board segments and the part are contype 2 (`2 & 2`), the board's
 * underside contype 4 (`1 & 1` from the floor's affinity). So the hulls still
 * collide with everything they are supposed to — just not with each other.
 */
const MACHINE_FRAME_NO_SELF_FLAGS = 'contype="1" conaffinity="2"';
/** Six axis capsules + `gripper_col` + `base_col`. */
const EXPECTED_INERT_GEOMS = 8;

type ArmMode = 'inert' | 'colliding' | 'colliding-noself' | 'colliding-excluded';

const ARM_FLAGS: Record<ArmMode, string> = {
  inert: INERT_FLAGS,
  colliding: MACHINE_FRAME_FLAGS,
  'colliding-noself': MACHINE_FRAME_NO_SELF_FLAGS,
  'colliding-excluded': MACHINE_FRAME_FLAGS,
};

/**
 * The contact pairs a real machine has to exclude, measured from the start pose
 * of the `fits` scenario rather than guessed.
 *
 * With the hulls colliding, the start pose has 28 contacts and they are not the
 * ones the demo is about:
 *
 *   gripper_box <-> part_box{,_2,_3}   14 contacts
 *   A6_capsule  <-> part_box{,_2,_3}    4
 *   A5_capsule  <-> part_box{,_2,_3}    4
 *   A1_capsule  <-> floor_box           1
 *   A2_capsule  <-> base_cylinder       1
 *
 * The first three groups are the same defect: a `MachineFrame` hull that
 * ENVELOPES THE PADS. The part has to be between the pads, the pads are inside
 * the gripper housing's 35x30x25 mm box and inside the 55 mm wrist capsules, so
 * the housing ejects the very part it is supposed to hold — measured: the part
 * leaves the jaws, the axes saturate 87 % of the time and nothing is inserted in
 * ANY scenario. A `forcefit` grip and an enveloping machine hull are mutually
 * exclusive.
 *
 * The last two are the other defect: coarse hulls of a serial arm permanently
 * interpenetrate the machine's own base and floor. MuJoCo excludes only
 * PARENT–CHILD pairs automatically, and `A2`'s parent is `A1`, not `base`.
 *
 * Neither is a numerics problem and neither is visible with `contype 0`. They
 * are the price of the coarse hulls, and a real integrator pays it with
 * exclusion rows — which is why this configuration exists: it is the only one in
 * this file in which the robot still does the task, so it is the only one whose
 * frame cost is the frame cost OF THE DEMO.
 */
const EXCLUSIONS = `  <contact>
    <exclude body1="gripper" body2="part"/>
    <exclude body1="A6" body2="part"/>
    <exclude body1="A5" body2="part"/>
    <exclude body1="A1" body2="base"/>
    <exclude body1="A2" body2="base"/>
    <exclude body1="A1" body2="world"/>
    <exclude body1="A2" body2="world"/>
  </contact>
`;

/**
 * The gate's XML with the machine-frame contact flags on every robot hull.
 *
 * One substitution, counted. A silent miss here would turn config B back into
 * config A and the whole file would report "no change" — which is exactly the
 * shape of a wrong measurement that reads as a reassuring one.
 */
function armFlags(xml: string, mode: ArmMode): string {
  const hits = xml.split(INERT_FLAGS).length - 1;
  expect(
    hits,
    `the model must carry exactly ${EXPECTED_INERT_GEOMS} inert hulls — the spike changed shape`,
  ).toBe(EXPECTED_INERT_GEOMS);
  const flagged = mode === 'inert' ? xml : xml.split(INERT_FLAGS).join(ARM_FLAGS[mode]);
  if (mode !== 'colliding-excluded') return flagged;
  const close = '</mujoco>';
  expect(flagged.endsWith(`${close}\n`) || flagged.endsWith(close)).toBe(true);
  return flagged.replace(close, `${EXCLUSIONS}${close}`);
}

const AXIS_NAMES = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'] as const;

/**
 * `createRig()` of the spike, with the contact flags switched.
 *
 * Deliberately a copy and not a parameter on the spike's own factory: the gate's
 * rig is a finished artefact, and a measurement that edits its subject is not a
 * second opinion.
 */
async function createRigWithArms(mode: ArmMode, opts: SceneOptions = {}): Promise<Rig> {
  const { xml } = buildPegGameMjcf(opts);
  const world = await RVMuJoCoWorld.load(armFlags(xml, mode));
  return {
    world,
    axisQpos: AXIS_NAMES.map((n) => world.jointQposAdr(world.mustFind('joint', n))),
    axisDof: AXIS_NAMES.map((n) => world.jointDofAdr(world.mustFind('joint', n))),
    gripSite: world.mustFind('site', 'grip_site'),
    partBody: world.mustFind('body', 'part'),
    boardBody: world.mustFind('body', 'board'),
    partQposAdr: world.jointQposAdr(world.mustFind('joint', 'part_free')),
    boardQposAdr: world.jointQposAdr(world.mustFind('joint', 'board_free')),
    partDofAdr: world.jointDofAdr(world.mustFind('joint', 'part_free')),
    boardDofAdr: world.jointDofAdr(world.mustFind('joint', 'board_free')),
    gripActuator: world.mustFind('actuator', 'act_grip'),
  };
}

/** Place the part between the jaws from the LIVE grip-site pose (gate parity). */
function placePartInGrip(rig: Rig): void {
  const { world, gripSite, partQposAdr, partDofAdr } = rig;
  world.forward();
  const p = world.readSitePos(gripSite, new Float64Array(3));
  const m = world.readSiteMat(gripSite, new Float64Array(9));
  const q = quatMul(matToQuat(m), PART_IN_SITE_QUAT);
  world.writeQpos(partQposAdr, [p[0], p[1], p[2], q[0], q[1], q[2], q[3]]);
  world.writeQvel(partDofAdr, [0, 0, 0, 0, 0, 0]);
  world.forward();
}

interface Metrics {
  mode: ArmMode;
  scenario: string;
  roundSegments: number;
  nconMean: number;
  nconMax: number;
  nefcMax: number;
  solverIterMean: number;
  solverIterMax: number;
  msPerFrameP50: number;
  msPerFrameP95: number;
  msPerFrameMax: number;
  msPerStepFrom60: number;
  realTimeFactor: number;
  partSlipInJawsMm: number;
  hubTravelRefusedMm: number;
  boardSlideMm: number;
  maxFollowingErrorDeg: number;
  maxSaturationFraction: number;
  partBelowBoardTop: boolean;
}

/**
 * One scenario, 20 s of sim, measured per 60 Hz frame worth of steps.
 *
 * The trajectory is solved off-line on the SAME world (contact-free IK, as in
 * the gate) and replayed as the actuators' setpoint, so the measured loop runs
 * physics and nothing else.
 */
async function run(
  mode: ArmMode,
  scenario: Scenario,
  { simSeconds = 20, rampS = 6, roundSegments = 12 } = {},
): Promise<Metrics> {
  const rig = await createRigWithArms(mode, {
    forceRangeNm: FORCE_RANGE_NM,
    floorFriction: 0.4,
    kpScale: KP_SCALE,
    timestepS: DT,
    roundSegments,
  });
  const { world, axisQpos } = rig;
  try {
    const aim = aimPoint(scenario, DEFAULT_BOARD.halfThickM);
    const tool = toolMat(scenario);
    const startZ = scenario.id === 'free' ? 0.250 : 0.100;
    const ikEnd = solveIkRobust(rig, [aim[0], aim[1], aim[2] + scenario.pressHubOffsetM], tool);
    const ikStart = solveIkRobust(rig, [aim[0], aim[1], aim[2] + startZ], tool, ikEnd.q);
    if (ikStart.posErrM > 2e-4 || ikEnd.posErrM > 2e-4) {
      throw new Error(`IK did not converge for ${scenario.id}`);
    }

    for (let i = 0; i < 6; i++) world.writeQpos(axisQpos[i], [ikStart.q[i]]);
    world.writeQvel(rig.axisDof[0], [0, 0, 0, 0, 0, 0]);
    placePartInGrip(rig);
    const ctrl = new Float64Array(world.nu);
    for (let i = 0; i < 6; i++) ctrl[i] = ikStart.q[i];
    ctrl[rig.gripActuator] = JAW_STROKE_M;
    world.setCtrl(ctrl);
    world.step(Math.round(1.0 / DT));

    const hubZStart = world.readSitePos(rig.gripSite, new Float64Array(3))[2];
    const partHubOffsetAtStart = hubZStart - world.readXpos(rig.partBody, new Float64Array(3))[2];
    const boardStart = world.readXpos(rig.boardBody, new Float64Array(3));

    const stepsPerFrame = Math.ceil(1 / 60 / DT);
    const totalSteps = Math.round(simSeconds / DT);
    const rampSteps = Math.round(rampS / DT);
    const frameMs: number[] = [];
    const bundle60Ms: number[] = [];
    const ncons: number[] = [];
    const iters: number[] = [];
    let nefcMax = 0;
    let feMaxRad = 0;
    let satFraction = 0;
    const satCount = new Array(6).fill(0);
    let satSamples = 0;
    const qbuf = new Float64Array(world.nq);
    const fbuf = new Float64Array(world.nu);

    let done = 0;
    let bundleStart = performance.now();
    let bundleSteps = 0;
    const wall0 = performance.now();
    while (done < totalSteps) {
      const n = Math.min(stepsPerFrame, totalSteps - done);
      const alpha = Math.min(1, done / rampSteps);
      for (let i = 0; i < 6; i++) ctrl[i] = ikStart.q[i] + alpha * (ikEnd.q[i] - ikStart.q[i]);
      world.setCtrl(ctrl);

      const t0 = performance.now();
      world.step(n);
      frameMs.push(performance.now() - t0);

      done += n;
      bundleSteps += n;
      if (bundleSteps >= 60) {
        bundle60Ms.push((performance.now() - bundleStart) / bundleSteps);
        bundleStart = performance.now();
        bundleSteps = 0;
      }

      ncons.push(world.ncon);
      iters.push(world.solverIterations());
      if (world.nefc > nefcMax) nefcMax = world.nefc;
      world.readQpos(qbuf);
      world.readActuatorForce(fbuf);
      satSamples++;
      for (let i = 0; i < 6; i++) {
        const fe = Math.abs(ctrl[i] - qbuf[axisQpos[i]]);
        if (fe > feMaxRad) feMaxRad = fe;
        if (Math.abs(fbuf[i]) >= 0.98 * FORCE_RANGE_NM[i]) satCount[i]++;
      }
    }
    const wallMs = performance.now() - wall0;
    satFraction = Math.max(...satCount.map((c) => c / satSamples));

    const hubEnd = world.readSitePos(rig.gripSite, new Float64Array(3));
    const boardEnd = world.readXpos(rig.boardBody, new Float64Array(3));
    const partPos = world.readXpos(rig.partBody, new Float64Array(3));
    const boardTopZ = DEFAULT_BOARD.halfThickM * 2 + BOARD_FOOT_HEIGHT_M;

    return {
      mode,
      scenario: scenario.id,
      roundSegments,
      nconMean: mean(ncons),
      nconMax: Math.max(...ncons),
      nefcMax,
      solverIterMean: mean(iters),
      solverIterMax: Math.max(...iters),
      msPerFrameP50: percentile(frameMs, 0.5),
      msPerFrameP95: percentile(frameMs, 0.95),
      msPerFrameMax: Math.max(...frameMs),
      msPerStepFrom60: mean(bundle60Ms),
      realTimeFactor: (totalSteps * DT) / (wallMs / 1000),
      partSlipInJawsMm: (partPos[2] - hubEnd[2] + partHubOffsetAtStart) * 1000,
      hubTravelRefusedMm: (hubEnd[2] - (aim[2] + scenario.pressHubOffsetM)) * 1000,
      boardSlideMm: Math.hypot(boardEnd[0] - boardStart[0], boardEnd[1] - boardStart[1]) * 1000,
      maxFollowingErrorDeg: (feMaxRad * 180) / Math.PI,
      maxSaturationFraction: satFraction,
      partBelowBoardTop: partPos[2] - DEFAULT_PART.thicknessM / 2 < boardTopZ - 0.001,
    };
  } finally {
    rig.world.dispose();
  }
}

function line(m: Metrics): string {
  return `[cost] ${m.mode.padEnd(9)} seg${String(m.roundSegments).padStart(3)} ${m.scenario.padEnd(15)}`
    + ` ncon ${m.nconMean.toFixed(1).padStart(5)}/${String(m.nconMax).padStart(3)}`
    + `  iter ${m.solverIterMean.toFixed(1)}/${m.solverIterMax}`
    + `  p50 ${m.msPerFrameP50.toFixed(3)}  p95 ${m.msPerFrameP95.toFixed(3)}  max ${m.msPerFrameMax.toFixed(3)} ms/frame`
    + `  rtf ${m.realTimeFactor.toFixed(1)}`;
}

const report: Record<string, unknown> = {
  plan: 673,
  phase: 5,
  subject: 'frame cost with colliding arm hulls (the Phase-4b obligation)',
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  gateReference: { p95MsPerFrame: GATE_P95_MS, budgetMsPerFrame: FRAME_BUDGET_MS, armFlags: INERT_FLAGS },
  machineFrameFlags: MACHINE_FRAME_FLAGS,
};

describe('plan-673 Phase 5 — frame cost with colliding arm hulls', () => {
  const inert: Metrics[] = [];
  const colliding: Metrics[] = [];

  it('A: reproduces the gate configuration, so this machine is calibrated first', async () => {
    for (const scenario of SCENARIOS) {
      const m = await run('inert', scenario);
      inert.push(m);
      console.log(line(m));
    }
    const worst = inert.reduce((a, b) => (b.msPerFrameP95 > a.msPerFrameP95 ? b : a));
    report.inert = inert;
    report.inertWorst = { scenario: worst.scenario, p95MsPerFrame: worst.msPerFrameP95 };
    console.log(
      `[calib] gate published ${GATE_P95_MS.toFixed(3)} ms p95 (${'wrong-shape'});`
      + ` this machine reproduces ${worst.msPerFrameP95.toFixed(3)} ms (${worst.scenario})`
      + ` -> machine factor x${(worst.msPerFrameP95 / GATE_P95_MS).toFixed(2)}`,
    );
    // Calibration, not a gate: a machine within a factor of 2 of the published
    // number is measuring the same physics. Anything outside that means the new
    // numbers below are about this machine and must not be quoted as the plan's.
    expect(worst.msPerFrameP95).toBeGreaterThan(GATE_P95_MS / 2);
    expect(worst.msPerFrameP95).toBeLessThan(GATE_P95_MS * 2);
  });

  it('B: measures the same five scenarios with the arm hulls colliding', async () => {
    for (const scenario of SCENARIOS) {
      const m = await run('colliding', scenario);
      colliding.push(m);
      console.log(line(m));
    }
    const worst = colliding.reduce((a, b) => (b.msPerFrameP95 > a.msPerFrameP95 ? b : a));
    const worstInert = inert.reduce((a, b) => (b.msPerFrameP95 > a.msPerFrameP95 ? b : a));
    report.colliding = colliding;
    report.collidingWorst = { scenario: worst.scenario, p95MsPerFrame: worst.msPerFrameP95 };
    report.armCollisionFactor = worst.msPerFrameP95 / worstInert.msPerFrameP95;
    console.log(
      `[GATE] colliding arms: worst p95 ${worst.msPerFrameP95.toFixed(3)} ms/frame (${worst.scenario})`
      + ` against ${FRAME_BUDGET_MS} ms -> ${worst.msPerFrameP95 <= FRAME_BUDGET_MS ? 'PASS' : 'FAIL'}`
      + ` (headroom x${(FRAME_BUDGET_MS / worst.msPerFrameP95).toFixed(2)});`
      + ` the arm hulls cost x${(worst.msPerFrameP95 / worstInert.msPerFrameP95).toFixed(2)} over config A`,
    );
    // The contact count MUST rise — otherwise the substitution did nothing and
    // the "no change" reading would be the measurement's own failure.
    const nconUp = colliding.some((c, i) => c.nconMean > inert[i].nconMean + 0.5);
    expect(nconUp, 'colliding hulls that produce no extra contacts are not colliding').toBe(true);
  });

  it('C: applies the hexagon lever on top, which is the configuration to ship', async () => {
    const rows: Metrics[] = [];
    for (const scenario of SCENARIOS) {
      const m = await run('colliding', scenario, { roundSegments: 6 });
      rows.push(m);
      console.log(line(m));
    }
    const worst = rows.reduce((a, b) => (b.msPerFrameP95 > a.msPerFrameP95 ? b : a));
    const worst12 = colliding.reduce((a, b) => (b.msPerFrameP95 > a.msPerFrameP95 ? b : a));
    report.collidingHexagon = rows;
    report.collidingHexagonWorst = { scenario: worst.scenario, p95MsPerFrame: worst.msPerFrameP95 };
    report.hexagonLeverFactor = worst12.msPerFrameP95 / worst.msPerFrameP95;
    console.log(
      `[GATE] colliding arms + hexagon: worst p95 ${worst.msPerFrameP95.toFixed(3)} ms/frame`
      + ` (${worst.scenario}) -> ${worst.msPerFrameP95 <= FRAME_BUDGET_MS ? 'PASS' : 'FAIL'}`
      + ` (headroom x${(FRAME_BUDGET_MS / worst.msPerFrameP95).toFixed(2)});`
      + ` the hexagon buys x${(worst12.msPerFrameP95 / worst.msPerFrameP95).toFixed(2)} back`,
    );
    // NOT the gate. A loop-pass p95 is a statement about the position of the
    // run in the process (the Phase-1 gate measured 35 % between a loop pass
    // and the isolated re-runs of identical physics). The verdict is the
    // order-fair block below; this one only has to produce contacts.
    expect(worst.nconMean).toBeGreaterThan(0);
  });

  /**
   * THE DECISIVE BLOCK — and the reason the three loop passes above are only
   * orientation.
   *
   * The Phase-1 gate wrote down that its own loop pass and its isolated re-runs
   * of IDENTICAL physics differed by up to 35 % ("`ncon` is bit-identical, so
   * the whole spread is measurement environment"). This file reproduced that
   * verbatim: `colliding/fits` read 2.475 ms inside the loop and 1.74–1.80 ms
   * on its own. A verdict taken from a loop pass is therefore a verdict about
   * the POSITION of a run in the process, and the three configs above each sat
   * at a different position.
   *
   * So the comparison is made order-fair: the REPEAT index is the outer loop
   * and the configuration the inner one, which puts every config at every
   * position in the process and makes drift common-mode instead of a bias
   * towards whichever config ran last.
   */
  it('compares the three configurations order-fairly, which is the verdict', async () => {
    const configs = [
      { key: 'A inert/12', mode: 'inert' as ArmMode, seg: 12 },
      { key: 'B colliding/12', mode: 'colliding' as ArmMode, seg: 12 },
      { key: 'C colliding/6', mode: 'colliding' as ArmMode, seg: 6 },
      // D isolates WHERE the cost of B comes from: environment contact, or the
      // machine's own hulls touching each other. A cobot's authored link hulls
      // overlap at almost every pose (Phase 4b authored measured AABBs, and an
      // AABB of a slim link is generous where the link bends), and MuJoCo
      // excludes only PARENT–CHILD pairs automatically — A1 against A3 is a
      // contact pair nobody asked for.
      { key: 'D noself/6', mode: 'colliding-noself' as ArmMode, seg: 6 },
      // E is the only colliding configuration in which the robot still DOES the
      // task, so it is the only one whose number answers "what does the demo
      // cost with the delivered robot's contact flags".
      { key: 'E excluded/12', mode: 'colliding-excluded' as ArmMode, seg: 12 },
      { key: 'E excluded/6', mode: 'colliding-excluded' as ArmMode, seg: 6 },
    ];
    // The three contact-heavy scenarios. `free` and `wrong-rotation` were never
    // close to the budget in any config and only lengthen the run.
    const heavy = ['fits', 'wrong-shape', 'skew-push']
      .map((id) => SCENARIOS.find((s) => s.id === id)!);
    type Cell = {
      p95: number[]; ncon: number[];
      /** Task validity — a cost number of a robot that is no longer doing the
       *  task is not the cost of the demo. */
      feDeg: number[]; sat: number[]; inserted: boolean[]; slipMm: number[];
    };
    const rows: Record<string, Record<string, Cell>> = {};
    for (const c of configs) {
      rows[c.key] = {};
      for (const s of heavy) {
        rows[c.key][s.id] = { p95: [], ncon: [], feDeg: [], sat: [], inserted: [], slipMm: [] };
      }
    }

    for (let rep = 0; rep < 3; rep++) {
      for (const c of configs) {
        for (const s of heavy) {
          const m = await run(c.mode, s, { roundSegments: c.seg });
          const cell = rows[c.key][s.id];
          cell.p95.push(m.msPerFrameP95);
          cell.ncon.push(m.nconMean);
          cell.feDeg.push(m.maxFollowingErrorDeg);
          cell.sat.push(m.maxSaturationFraction);
          cell.inserted.push(m.partBelowBoardTop);
          cell.slipMm.push(m.partSlipInJawsMm);
        }
      }
    }

    const verdict: Record<string, unknown> = {};
    for (const c of configs) {
      let worstOfConfig = 0;
      let worstScenario = '';
      for (const s of heavy) {
        const r = rows[c.key][s.id];
        const worst = Math.max(...r.p95);
        const med = percentile(r.p95, 0.5);
        console.log(
          `[fair] ${c.key.padEnd(16)} ${s.id.padEnd(15)} p95 ${r.p95.map((v) => v.toFixed(3)).join(' / ')}`
          + `  median ${med.toFixed(3)}  worst ${worst.toFixed(3)} ms/frame  ncon ${r.ncon[0].toFixed(1)}`
          + `${r.ncon.every((v) => Math.abs(v - r.ncon[0]) < 0.1) ? '' : ' (NCON NOT DETERMINISTIC)'}`,
        );
        // The same line again, but about whether the number MEANS anything: a
        // run with a 19 deg following error and 87 % saturation is a jammed
        // robot, and its frame cost is not the frame cost of the demo.
        console.log(
          `       └─ task: inserted ${String(r.inserted[0]).padEnd(5)} fe ${r.feDeg[0].toFixed(2).padStart(6)} deg`
          + `  sat ${(r.sat[0] * 100).toFixed(0).padStart(3)} %  slip ${r.slipMm[0].toFixed(1).padStart(6)} mm`
          + `${r.sat[0] > 0.5 || r.feDeg[0] > 2 ? '   <-- NOT PERFORMING THE TASK' : ''}`,
        );
        if (worst > worstOfConfig) { worstOfConfig = worst; worstScenario = s.id; }
      }
      verdict[c.key] = {
        worstP95MsPerFrame: worstOfConfig,
        worstScenario,
        verdict: worstOfConfig <= FRAME_BUDGET_MS ? 'PASS' : 'FAIL',
        headroomFactor: FRAME_BUDGET_MS / worstOfConfig,
        perScenario: rows[c.key],
      };
      console.log(
        `[VERDICT] ${c.key.padEnd(16)} worst p95 ${worstOfConfig.toFixed(3)} ms/frame (${worstScenario})`
        + ` -> ${worstOfConfig <= FRAME_BUDGET_MS ? 'PASS' : 'FAIL'} (headroom x${(FRAME_BUDGET_MS / worstOfConfig).toFixed(2)})`,
      );
    }
    const worstOf = (k: string): number => (verdict[k] as { worstP95MsPerFrame: number }).worstP95MsPerFrame;
    const a = worstOf('A inert/12');
    const b = worstOf('B colliding/12');
    const c6 = worstOf('C colliding/6');
    const d = worstOf('D noself/6');
    const e12 = worstOf('E excluded/12');
    const e6 = worstOf('E excluded/6');
    report.orderFair = verdict;
    report.orderFairSummary = {
      armCollisionFactor: b / a,
      hexagonLeverFactor: b / c6,
      selfCollisionFactor: c6 / d,
      excludedWorstP95: { seg12: e12, seg6: e6 },
      verdictForTheDemo: e6 <= FRAME_BUDGET_MS ? 'PASS' : 'FAIL',
      budgetMsPerFrame: FRAME_BUDGET_MS,
      note: 'Worst of three isolated runs per (config, scenario), repeat index as the OUTER loop so every config sits at every position in the process. This is the number to quote.',
    };
    writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(
      `[report] arm hulls cost x${(b / a).toFixed(2)}; the hexagon buys x${(b / c6).toFixed(2)} back;`
      + ` dropping MACHINE SELF-CONTACT buys x${(c6 / d).toFixed(2)};`
      + ` THE DEMO (exclusions + hexagon) costs ${e6.toFixed(3)} ms p95`
      + ` -> ${e6 <= FRAME_BUDGET_MS ? 'PASS' : 'FAIL'} (headroom x${(FRAME_BUDGET_MS / e6).toFixed(2)})`
      + ` -> ${REPORT_PATH}`,
    );

    // The physics must be deterministic in every cell — without that, nothing
    // above is a measurement of the code.
    for (const c of configs) {
      for (const s of heavy) {
        const n = rows[c.key][s.id].ncon;
        expect(n.every((v) => Math.abs(v - n[0]) < 0.1), `${c.key}/${s.id}: ncon drifted`).toBe(true);
      }
    }
    // Colliding hulls must cost something — a factor of 1.0 would mean the flag
    // substitution did nothing and every "PASS" above would be config A again.
    expect(b).toBeGreaterThan(a);
  });
});
