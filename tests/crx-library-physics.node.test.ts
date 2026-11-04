// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * crx-library-physics.node.test.ts — plan-673 test 9.18, on the SHIPPED file.
 *
 * The library part `public/library/Robots/FanucCRX-10iA-L.glb` is authored by
 * `scripts/author-robot-physics.mjs`. This test is the counter-witness: it reads
 * the file that ships, re-derives every number from its GEOMETRY, and fails when
 * the authored value and the geometry drift apart — which is the only way an
 * authoring script can be trusted in a repo where the asset is a binary.
 *
 * It also pins the three things Phase 4b found that a reader would otherwise have
 * to rediscover:
 *
 *   1. **The link shells are open.** `computeLinkMassProperties` refuses Mirtich
 *      on them and falls back to the bounding box; the boundary-edge counts are
 *      asserted at five weld tolerances so nobody can mistake it for a weld
 *      tolerance that is finer than Draco's position quantisation.
 *   2. **The gravity statics reproduces MuJoCo.** `torquesAtPose` returns the
 *      three canonical `qfrc_bias` vectors the Phase-1 gate measured, to four
 *      decimals, from Phase 1's own declared masses. That is what licenses
 *      deriving the force limits without a compiled model.
 *   3. **The realvirtual gripper idiom reaches MuJoCo.** A `Virtual` master with
 *      one `Drive_Gear` per jaw becomes ONE actuator on a lead jaw plus ONE
 *      `<equality>` row — not, as before Phase 4b, nothing at all.
 */

import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import {
  applySchema,
  getComponentInstances,
  getRegisteredFactories,
  setComponentInstance,
  type ComponentContext,
} from '../src/core/engine/rv-component-registry';
import { MUJOCO_REGION_TYPE, RVMuJoCoRegion } from '../src/core/engine/rv-mujoco-region';
import { RVDynamicAxis } from '../src/core/engine/rv-dynamic-axis';
import { RVDrive } from '../src/core/engine/rv-drive';
import { directionToGltfAxis } from '../src/core/engine/rv-coordinate-utils';
import { RVDriveGear } from '../src/core/engine/rv-drive-gear';
import '../src/core/engine/rv-drive-cylinder';
import '../src/core/engine/rv-contact-geometry';
import '../src/core/engine/rv-grip-load';
import '@rv-private/kinematic-mechanism/rv-kinematic-mechanism';
import { computeLinkMassProperties } from '@rv-private/kinematic-mechanism/rv-mechanism-mass-props';
import { writeMjcf, type MjcfDocument } from '@rv-private/mujoco/rv-mjcf-writer';
import { loadGlbAsThree } from '../scripts/lib/rv-glb-three.mjs';
import { measureBodies, massesFromDatasheetSum, WELD_TOLERANCES_MM } from '../scripts/lib/rv-robot-link-geometry.mjs';
import { torquesAtPose, worstCaseGravityTorque, forceLimitNm } from '../scripts/lib/rv-robot-statics.mjs';
import {
  CRX_SPEC, ROBOT_PHYSICS_ROLE, bodyPaths, deriveRobotPhysics,
} from '../scripts/author-robot-physics.mjs';
import { driveView } from '../scripts/author-robot-ik.mjs';
import {
  buildRobotIkRigFields, chainFromDerivation, chainGeometry, deriveSerialAxisChain,
  estimateOpwFromChain, measureWristType,
} from '../src/core/engine/rv-robot-rig';

const FILE = 'public/library/Robots/FanucCRX-10iA-L.glb';
const CTX = {} as unknown as ComponentContext;

/** Components whose `init()` needs a NodeRegistry this harness does not have. */
const SKIP_CONSTRUCT = new Set(['RobotIK', 'IKPath', 'IKTarget']);

/**
 * Construct the components the node's extras declare, in file order.
 *
 * `Drive` and `Drive_Gear` are registered as SCHEMAS, not as factories (the
 * loader builds them on its own path), so they are built the way the Phase-3
 * writer test builds them: construct, apply the schema, `initDrive()`.
 */
function constructComponents(node: Object3D): void {
  const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
  if (rv) {
    for (const [type, raw] of Object.entries(rv)) {
      if (SKIP_CONSTRUCT.has(type) || !raw || typeof raw !== 'object') continue;
      const extras = raw as Record<string, unknown>;
      if (type === 'Drive') {
        const drive = new RVDrive(node);
        applySchema(drive as unknown as Record<string, unknown>, RVDrive.schema, extras);
        drive.initDrive();
        continue;
      }
      if (type === 'Drive_Gear') {
        const gear = new RVDriveGear(node);
        applySchema(gear as unknown as Record<string, unknown>, RVDriveGear.schema, extras);
        setComponentInstance(node, gear);
        continue;
      }
      const factory = getRegisteredFactories().get(type);
      if (!factory) continue;
      const inst = factory.create(node, null);
      factory.beforeSchema?.(inst, extras);
      applySchema(inst as unknown as Record<string, unknown>, factory.schema, extras);
      setComponentInstance(node, inst);
      inst.init(CTX);
    }
  }
  for (const child of node.children) constructComponents(child);
}

function instanceOf<T>(node: Object3D, ctor: new (...a: never[]) => T): T | null {
  for (const i of getComponentInstances(node)) if (i instanceof ctor) return i as T;
  return null;
}

function elements(xml: string, tag: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (const m of xml.matchAll(new RegExp(`<${tag}\\s([^>]*?)/?>`, 'g'))) {
    const attrs: Record<string, string> = {};
    for (const a of m[1].matchAll(/([A-Za-z_][\w:.-]*)="([^"]*)"/g)) attrs[a[1]] = a[2];
    out.push(attrs);
  }
  return out;
}

describe('plan-673 9.18 — the Fanuc CRX library part is physics-capable', () => {
  let tree: Awaited<ReturnType<typeof loadGlbAsThree>>;
  let doc: MjcfDocument;
  let derived: Awaited<ReturnType<typeof deriveRobotPhysics>>;

  beforeAll(async () => {
    RVDynamicAxis.clearAll();
    tree = await loadGlbAsThree(FILE);
    derived = await deriveRobotPhysics(CRX_SPEC);

    constructComponents(tree.root);

    // The gear references are resolved by the loader in production; here they
    // are wired by path, because this test is about the MJCF and not about
    // reference resolution.
    const master = instanceOf(tree.byPath.get(CRX_SPEC.gripper.node)!, RVDrive);
    expect(master).not.toBeNull();
    for (const jaw of CRX_SPEC.gripper.jaws) {
      const gear = instanceOf(tree.byPath.get(jaw)!, RVDriveGear);
      expect(gear).not.toBeNull();
      gear!.MasterDrive = master!;
    }

    // A region is a property of the SCENE, not of the robot, so the asset does
    // not carry one — the test supplies it, exactly as a placement scene would.
    const factory = getRegisteredFactories().get(MUJOCO_REGION_TYPE)!;
    const region = factory.create(tree.root, null) as RVMuJoCoRegion;
    applySchema(region as unknown as Record<string, unknown>, factory.schema, {});
    setComponentInstance(tree.root, region);
    region.init(CTX);
    doc = writeMjcf({ region, modelName: 'crx' });
  });

  afterAll(() => { RVDynamicAxis.clearAll(); });

  // ── The rig ──────────────────────────────────────────────────────────────

  it('has nine bodies: the static base, six rotary axes and two jaws', () => {
    const joints = doc.report.bodies.map((b) => `${b.name}:${b.jointType}`);
    expect(joints).toEqual([
      'rv_static:',
      'A1:hinge', 'A2:hinge', 'A3:hinge', 'A4:hinge', 'A5:hinge', 'A6:hinge',
      'LeftFinger:slide', 'RightFinger:slide',
    ]);
  });

  it('gives every body collision geometry — one authored box, never a convexified mesh', () => {
    expect(doc.report.geoms).toHaveLength(9);
    for (const g of doc.report.geoms) {
      expect(g.type).toBe('box');
      expect(g.convexified).toBe(false);
    }
    // The jaw pads are the side that sets the tone of a contact pairing.
    const jaws = doc.report.geoms.filter((g) => g.body.endsWith('Finger'));
    expect(jaws).toHaveLength(2);
    for (const g of jaws) {
      expect(g.role).toBe(ROBOT_PHYSICS_ROLE.jawProfile);
      expect(g.priority).toBe(1);
    }
    expect(doc.problems.filter((p) => p.code === 'mjcf-no-geometry')).toHaveLength(0);
  });

  it('carries no demo wiggle any more — the benchmark sweeps its own copy', () => {
    // Until 2026-10-25 the wiggle stayed here because this asset was also the
    // plan-492 benchmark's robot. Thomas: the library robot gets a logical robot
    // definition instead; the benchmark places
    // public/perf/Robots/FanucCRX-10iA-L-erratic.glb (tests/robot-library-asset).
    const carriers: string[] = [];
    tree.root.traverse((n) => {
      const rv = n.userData?.realvirtual as Record<string, unknown> | undefined;
      if (rv && 'Drive_ErraticPosition' in rv) carriers.push(n.name);
    });
    expect(carriers).toEqual([]);
  });

  it('carries a RobotIK written from the runtime derivation — plan-773 E5 lifted for this asset', async () => {
    // E5 kept this part unrigged as the one real example of the derivation.
    // Thomas lifted that for the library CRX (2026-10-25); the rig is written by
    // scripts/author-robot-ik.mjs WITH the derivation, so re-running the
    // derivation on the shipped geometry must reproduce every field.
    const fresh = await loadGlbAsThree(FILE);
    const root = fresh.byPath.get(CRX_SPEC.root)!;
    const shipped = root.userData.realvirtual.RobotIK as Record<string, unknown>;
    expect(shipped, 'RobotIK on the robot root').toBeDefined();

    const pathOf = new Map([...fresh.byPath].map(([p, n]) => [n, p] as const));
    const drives: ReturnType<typeof driveView>[] = [];
    root.traverse((n) => { if (n.userData?.realvirtual?.Drive) drives.push(driveView(n)); });
    const derivation = deriveSerialAxisChain(root, drives as never);
    expect(derivation.failure).toBeNull();
    const chain = chainFromDerivation(root, derivation)!;
    const wrist = measureWristType(chainGeometry(chain));
    const estimate = estimateOpwFromChain(chain);
    const fields = buildRobotIkRigFields(
      { getPathForNode: (n: Object3D) => pathOf.get(n) ?? null } as never, derivation, estimate, wrist,
    );
    if ('error' in fields) throw new Error(fields.error);

    expect(shipped.WristType).toBe(CRX_SPEC.expectedRig.WristType);
    expect(wrist.offsetMm).toBeCloseTo(CRX_SPEC.expectedRig.unrepresentableOffsetMm, 0);
    expect(shipped.WristType).toBe(fields.WristType);
    expect(shipped.ElbowInUnityX).toBe(fields.ElbowInUnityX);
    expect(shipped.Axis).toEqual(fields.Axis);
    expect(shipped.TCP).toBe(fields.TCP);
    for (const k of ['a1', 'a2', 'b', 'c1', 'c2', 'c3', 'c4'] as const) {
      expect(shipped[k] as number, k).toBeCloseTo(fields[k], 9);
    }
    const tool = shipped.ToolOffset as { x: number; y: number; z: number };
    expect(tool.x).toBeCloseTo(fields.ToolOffset.x, 9);
    expect(tool.y).toBeCloseTo(fields.ToolOffset.y, 9);
    expect(tool.z).toBeCloseTo(fields.ToolOffset.z, 9);
  });

  // ── Mass: the 39 kg calibration ──────────────────────────────────────────

  it('weighs the datasheet 39 kg, authored as overrides because the shells are open', () => {
    expect(doc.report.totalMassKg).toBeCloseTo(CRX_SPEC.datasheet.massKg, 2);
    for (const b of doc.report.bodies) {
      expect(b.massKg).toBeGreaterThan(0);
      expect(b.massSource).toBe('override');
      expect(b.massProvenance).toBe('component');
    }
    // An override clears the degraded-mass warning, which is correct — an
    // authored mass is a fact. The justification is the next test.
    expect(doc.problems.filter((p) => p.code === 'mjcf-mass-degraded')).toHaveLength(0);
    expect(doc.problems.filter((p) => p.code === 'mjcf-no-mass')).toHaveLength(0);
  });

  it('justifies the overrides: the link shells are open, not merely unwelded', async () => {
    const bodies = bodyPaths(CRX_SPEC).map((p) => tree.byPath.get(p)!);
    const measured = measureBodies(bodies);
    // The question this answers: is the refusal real, or is the production weld
    // tolerance (0.0001 mm) simply finer than Draco's position quantisation? A
    // quantisation seam closes as soon as the weld is coarser than the error, so
    // the count is checked at every tolerance BELOW any real geometric feature
    // of a part this size. It stays non-zero there — the shells are open.
    const belowAnyFeature = WELD_TOLERANCES_MM.filter((t) => t <= 0.01);
    expect(belowAnyFeature).toEqual([0.0001, 0.001, 0.01]);
    for (const m of measured) {
      for (const t of belowAnyFeature) {
        expect(m.boundaryEdges[String(t)], `${m.node} @ ${t} mm`).toBeGreaterThan(0);
      }
    }
    // At 0.1 / 1 mm a weld starts bridging real holes instead of seams (A4
    // "closes" at a 1 mm weld), which is exactly why the production tolerance is
    // not allowed to be loosened to make this problem go away.
    const a4 = measured.find((m) => m.node === 'A4')!;
    expect(a4.boundaryEdges['1']).toBe(0);
    // And the production integrator says the same thing in its own words.
    for (const body of bodies) {
      const props = computeLinkMassProperties(body, bodies.filter((b) => b !== body), 1350, 1000);
      expect(props.source).toBe('bounds');
      expect(props.warning).toContain('not closed');
    }
  });

  it('distributes the mass by envelope volume, not by bounding box', () => {
    const bodies = bodyPaths(CRX_SPEC).map((p) => tree.byPath.get(p)!);
    const measured = measureBodies(bodies, { weld: false });
    const mass = massesFromDatasheetSum(measured, CRX_SPEC.datasheet.massKg);
    // The effective ENVELOPE density: a hollow housing counts as full, so this
    // is far below any material density and is NOT one.
    expect(mass.densityKgM3).toBeCloseTo(1350.1, 0);
    for (const [i, b] of doc.report.bodies.entries()) {
      expect(b.massKg, b.name).toBeCloseTo(mass.massKg[i], 2);
    }
    // Why the override exists: the bounding box over-reports every body, but by
    // very DIFFERENT factors (1.37x on A1, 4.50x on a jaw finger), so the
    // fallback distribution is distorted and not merely scaled. Normalised to
    // the same 39 kg, a jaw finger would get 2.3x its share and A1 0.69x.
    const boxVol = measured.map((m) => 8 * m.halfMm[0] * m.halfMm[1] * m.halfMm[2]);
    const ratio = boxVol.map((v, i) => v / measured[i].shellVolumeMm3);
    const mean = boxVol.reduce((s, v) => s + v, 0) / mass.totalVolumeMm3;
    const distortion = ratio.map((r) => r / mean);
    expect(Math.max(...distortion)).toBeGreaterThan(2);
    expect(Math.min(...distortion)).toBeLessThan(0.75);
    // And the one body it matters most for: the lower arm would carry 52 % of
    // the robot instead of the 43 % its envelope says.
    const boxShare = boxVol[2] / boxVol.reduce((s, v) => s + v, 0);
    const envShare = measured[2].shellVolumeMm3 / mass.totalVolumeMm3;
    expect(boxShare).toBeGreaterThan(0.5);
    expect(envShare).toBeLessThan(0.45);
    expect(boxShare).toBeGreaterThan(envShare);
  });

  // ── Actuators and the force limit ────────────────────────────────────────

  it('actuates six axes and BOTH jaws, each with a force limit', () => {
    expect(doc.report.actuators.map((a) => a.joint)).toEqual([
      'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'LeftFinger', 'RightFinger',
    ]);
    for (const a of doc.report.actuators) {
      expect(a.kind).toBe('position');
      expect(a.forceRange, a.joint).not.toBeNull();
      expect(a.ctrlRange, a.joint).not.toBeNull();
    }
    expect(doc.problems.filter((p) => p.code === 'mjcf-no-force-limit')).toHaveLength(0);
    // ONE setpoint, TWO actuators, NO coupling row.
    //
    // Phase 4b wrote one actuated lead plus `RightFinger=LeftFinger*1+0`,
    // because at the time nothing could command a geared jaw: `Drive_Gear` is a
    // drive behavior and a physics-owned drive returns before the behavior loop.
    // plan-673 Phase 5 opened that route (`commandDynamicSetpoint`) and then
    // measured the lead-plus-equality form under clamping load: an `<equality>`
    // is a solver constraint, not a rigid gear, and the follower jaw is pushed
    // OPEN (lead to 10.0 mm, follower from +3.4 to −6.5 mm, the part squeezed
    // out in 100 ms). With one actuator per jaw the same pinch holds at 85.6 N
    // and the jaws stay symmetric to 0.01 mm, because the ratio now rides on
    // two setpoints that cannot disagree instead of on a constraint that yields.
    expect(doc.report.equalities).toEqual([]);
    expect(doc.problems.filter((p) => p.code === 'mjcf-gear-unresolved')).toHaveLength(0);
    const jaw = doc.report.actuators.find((a) => a.joint === 'LeftFinger')!;
    expect(jaw.forceRange).toEqual([-CRX_SPEC.gripper.gripForceTotalN, CRX_SPEC.gripper.gripForceTotalN]);
    expect(jaw.ctrlRange![0]).toBeCloseTo(0, 9);
    expect(jaw.ctrlRange![1]).toBeCloseTo(CRX_SPEC.gripper.strokeMm / 1000, 9);
  });

  it('keeps the authored force limits equal to what the geometry derives', () => {
    for (const [i, a] of CRX_SPEC.axes.entries()) {
      const axis = instanceOf(tree.byPath.get(a.node)!, RVDynamicAxis)!;
      expect(axis.ForceRangeMax, a.node).toBe(derived.forceRangeNm[i]);
      expect(axis.ForceRangeMin, a.node).toBe(-derived.forceRangeNm[i]);
      expect(axis.ForceRangeMax, a.node).toBeGreaterThanOrEqual(
        derived.worstNm[i] * ROBOT_PHYSICS_ROLE.forceLimit.safety,
      );
    }
  });

  it('declares the structural following error in DEGREES and a window that cannot false-trip', () => {
    for (const a of CRX_SPEC.axes) {
      const axis = instanceOf(tree.byPath.get(a.node)!, RVDynamicAxis)!;
      // The unit trap of this plan: these are AXIS degrees, never the tool
      // projection in millimetres. 1.07 deg of A2 sag is 14.9 mm at the tool;
      // declaring 14.9 here would subtract 14.9 DEGREES and mask every overload.
      expect(axis.BaseFollowingError, a.node).toBeLessThan(0.2);
      expect(axis.FollowingErrorLimit, a.node).toBe(ROBOT_PHYSICS_ROLE.followingErrorLimitDeg);
      expect(axis.FollowingErrorLimit).toBeGreaterThan(axis.BaseFollowingError);
      // 0 = derived from base + window, never below the kinematic 0.01.
      expect(axis.ArrivalTolerance, a.node).toBe(0);
    }
  });

  it('limits every axis to its datasheet motion range', () => {
    const ranges = doc.report.actuators.slice(0, 6).map((a) => a.ctrlRange!);
    for (const [i, r] of ranges.entries()) {
      const halfDeg = CRX_SPEC.datasheet.motionRangeDeg[i] / 2;
      expect(r[1] * (180 / Math.PI), CRX_SPEC.axes[i].node).toBeCloseTo(halfDeg, 6);
      expect(r[0] * (180 / Math.PI)).toBeCloseTo(-halfDeg, 6);
    }
  });

  // ── The statics, validated against the Phase-1 gate ──────────────────────

  it('reproduces the Phase-1 qfrc_bias to four decimals (the third witness)', () => {
    // Phase 1's DECLARED masses at its capsule midpoints, in the asset's own
    // frames — the same model whose `qfrc_bias` the gate recorded.
    const tool = derived.toolFrames;
    const bodies = [
      { axisIndex: 0, massKg: 8.0, comMm: [0, 122.5, 0] as [number, number, number] },
      { axisIndex: 1, massKg: 7.0, comMm: [0, 355, 0] as [number, number, number] },
      { axisIndex: 2, massKg: 5.0, comMm: [75, 0, 0] as [number, number, number] },
      { axisIndex: 3, massKg: 3.5, comMm: [195, 0, 0] as [number, number, number] },
      { axisIndex: 4, massKg: 2.0, comMm: [50, 0, 75] as [number, number, number] },
      { axisIndex: 5, massKg: 1.0, comMm: [30, 0, 0] as [number, number, number] },
      { axisIndex: 5, massKg: 0.5, comMm: [0, 0, 5] as [number, number, number], frames: tool },
      { axisIndex: 5, massKg: 0.05, comMm: [-21.5, 25, 22.5] as [number, number, number], frames: tool },
      { axisIndex: 5, massKg: 0.05, comMm: [21.5, 25, 22.5] as [number, number, number], frames: tool },
    ];
    // The Phase-1 model declared A4 and A6 as +X, while the asset's drives
    // (RotationX with ReverseDirection) turn about -X. The sign flips the
    // torque's sign and nothing else, and the canonical poses hold q4 = q6 = 0,
    // so the gate's numbers stand — but the spike's axis table disagrees with
    // the shipped part on two of six axes, which is worth knowing. The
    // comparison uses the SPIKE's signs, because those are what it measured.
    const spikeAxisSign = [1, 1, 1, -1, 1, -1];
    const axes = derived.staticsAxes.map((a, i) => ({
      ...a,
      axis: a.axis.map((c) => c * spikeAxisSign[i]) as [number, number, number],
    }));
    const expected: Record<string, number[]> = {
      // Measured by the Phase-1 gate (spikes/673/phase1-report.json, forceRange.perPoseNm).
      'extended-horizontal': [0, 108.6089625, -0.0465975, 0, -0.0465975, 0],
      upright: [0, 37.75869, 37.75869, -3.8259, 3.163725, 0],
      'elbow-up-horizontal': [0, 146.41425, 37.75869, -3.8259, 3.163725, 0],
    };
    const poses: Record<string, number[]> = {
      'extended-horizontal': [0, -Math.PI / 2, 0, 0, 0, 0],
      upright: [0, 0, 0, 0, 0, 0],
      'elbow-up-horizontal': [0, -Math.PI / 2, Math.PI / 2, 0, 0, 0],
    };
    for (const [name, q] of Object.entries(poses)) {
      const mine = torquesAtPose(axes, bodies, q);
      for (let i = 0; i < 6; i++) expect(mine[i], `${name} axis ${i + 1}`).toBeCloseTo(expected[name][i], 4);
    }
  });

  it('states only the axis VECTORS, and they match the real Unity-to-glTF mapping', () => {
    // The spec restates six direction vectors because the mapping lives in
    // TypeScript. This is the pin that keeps the restatement honest — and the
    // place where the Phase-1 spike's table disagrees with the shipped part:
    // the spike declared A4 and A6 as +X, the drives turn about -X.
    for (const [i, a] of CRX_SPEC.axes.entries()) {
      const drive = instanceOf(tree.byPath.get(a.node)!, RVDrive)!;
      const want = directionToGltfAxis(drive.Direction);
      if (drive.ReverseDirection) want.negate();
      // `+ 0` on both sides: three's `negate()` produces -0, and deep equality
      // separates -0 from 0.
      expect([want.x + 0, want.y + 0, want.z + 0], a.node).toEqual(a.axis.map((c) => c + 0));
    }
    // Everything else about the chain is READ, not restated.
    for (const [i, a] of derived.staticsAxes.entries()) {
      const n = tree.byPath.get(CRX_SPEC.axes[i].node)!;
      expect(a.pos).toEqual([n.position.x, n.position.y, n.position.z]);
    }
    // Including the tool mount and where a payload hangs in it.
    expect(derived.toolFrames).toHaveLength(2);
    expect(derived.payloadComMm[1]).toBeCloseTo(156, 1);
  });

  it('derives the limit over the whole joint space, which dominates Phase 1s pose set', () => {
    // The A1 axis is world-vertical, so its gravity torque is identically zero
    // and the floor decides — Phase 1 measured 5e-14 N*m for the same reason.
    expect(derived.worstNm[0]).toBe(0);
    expect(derived.forceRangeNm[0]).toBe(ROBOT_PHYSICS_ROLE.forceLimit.floorNm);
    // Phase 1's worst A2 case was 146.4 N*m from a DECLARED mass split that put
    // 12 of 39 kg in the static base. The geometry puts 2.7 kg there, so the
    // real arm carries much more above A2 and Phase 1's +/-370 N*m limit would
    // have saturated it. This is the finding, pinned.
    expect(derived.worstNm[1]).toBeGreaterThan(146.4);
    expect(derived.forceRangeNm[1]).toBeGreaterThan(370);
    expect(forceLimitNm(derived.worstNm[1], ROBOT_PHYSICS_ROLE.forceLimit)).toBe(derived.forceRangeNm[1]);
  });

  it('bounds the sweep without sweeping the upstream joints', () => {
    // The bound |tau_i| <= |g| |a x d| does not depend on any upstream joint, so
    // the sweep shrinks from a product over six joints to one over the downstream
    // ones. Pinned so a later "let us sweep everything" rewrite shows up here.
    const { posesPerAxis } = worstCaseGravityTorque(derived.staticsAxes, [
      { axisIndex: 5, massKg: 1, comMm: [100, 0, 0] },
    ]);
    expect(posesPerAxis[5]).toBe(1);
    expect(posesPerAxis[4]).toBeLessThan(posesPerAxis[1]);
  });

  // ── The gripper ──────────────────────────────────────────────────────────

  it('reports the catalogue contradiction of the gripper instead of resolving it', () => {
    // Schunk EGH 80 catalogue: 40 mm per jaw, 0.8 s. The asset: 15 mm, 0.3 s.
    // The asset wins because it is the part that ships; the contradiction is
    // recorded here so it cannot quietly become a datasheet claim.
    const rv = tree.byPath.get(CRX_SPEC.gripper.node)!.userData.realvirtual as Record<string, Record<string, unknown>>;
    expect(rv.Drive_Cylinder.MaxPos).toBe(CRX_SPEC.gripper.strokeMm);
    expect(CRX_SPEC.gripper.strokeMm).not.toBe(40);
    expect(rv.Drive_Cylinder.TimeOut).toBe(0.3);
    expect(rv.GripLoad).toEqual({
      Mode: 'forcefit',
      GripForce: CRX_SPEC.gripper.gripForcePerJawN,
      SlipLimit: CRX_SPEC.gripper.slipLimitMm,
      SlipTimeMs: ROBOT_PHYSICS_ROLE.followingErrorTimeMs,
    });
  });

  it('keeps the virtual cylinder out of the body tree but its setpoint in', () => {
    // A `Virtual` drive moves no node, so it is no body — and before Phase 4b
    // that meant the whole gripper vanished from the MJCF.
    expect(doc.report.bodies.map((b) => b.name)).not.toContain('SchunkEGH80Gripper');
    const jawGeoms = elements(doc.xml, 'geom').filter((g) => (g.name ?? '').includes('Finger'));
    expect(jawGeoms).toHaveLength(2);
  });
});
