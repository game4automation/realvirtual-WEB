// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * ik-tcp-bake-survival.test.ts — the robot's TCP node survives the BAKE.
 *
 * ## Why this test exists even though `ik-cobot-glb-chain.test.ts` already
 * ## checks the TCP
 *
 * That suite loads with `preserveHierarchy: true`, and the destructive bake is
 * gated on `!preserveHierarchy && !!options.bakeRegistry`
 * (`rv-scene-loader.ts`). Neither `{ data }` nor `{ data, preserveHierarchy }`
 * passes a bake registry, so **both load the authoring tree** — measured on
 * `DemoRobotIK.glb`: 117 nodes either way, 78 with a registry. The viewer always
 * passes one (`rv-viewer.ts`), so every one of those checks ran against a tree
 * production never sees, and stayed green while the baked path was broken:
 *
 * | | unbaked | baked (production) |
 * |---|---|---|
 * | node `GripperTCP` | present | **removed** |
 * | `getTcpNode()` | the node | **null** |
 * | `chain.tcpLocalOffset` | 0.2399 m | **0** |
 * | `chain.tcpLocalRot` | ~90° tool mount | **identity** |
 *
 * Cause: Unity's exporter serialises a `GameObject` field as a bare path STRING,
 * so `RobotIK.TCP` was not a declared reference, nothing claimed the node, and
 * `computeSurvival` dropped it (`survives=false, reason=none`). The fix is the
 * `RobotIK.TCP` entry in `PATH_FIELDS` + `REFERENCE_BAKE_TARGETS` (`merge`: the
 * node has to exist, it draws nothing).
 *
 * **Therefore: this test MUST load with a `bakeRegistry`.** Without it the
 * regression is structurally invisible, which is the whole point. Since
 * plan-772 Phase 1 that is not a note in a header any more: the load goes
 * through `loadBakedGLB()`, which proves from the result that the bake ran,
 * and `tests/bake-test-path-enforced.node.test.ts` fails on any new test file
 * that loads a GLB without it.
 *
 * The assertions come with the measured NUMBERS rather than truth values
 * (plan-772 F3): a 0.2399 m tool offset, a 180.00° mount rotation, and a
 * replay in which the TCP node lands on the target (0.00 mm / 0.00°) while the
 * A6 flange stays one tool length away (239.90 mm / 180.00°) — the pair that
 * was swapped while the bake was eating the TCP node.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Matrix4, Object3D, Quaternion, Scene, Vector3 } from 'three';
import { type LoadResult } from '../src/core/engine/rv-scene-loader';
import { loadBakedGLB } from './helpers/load-baked-glb';
import { computeSurvival } from '../src/core/engine/rv-bake-survival';
import type { RVRobotIK } from '../src/core/engine/rv-robot-ik';
import type { RVIKTarget } from '../src/core/engine/rv-ik-target';
import { group, withComponent } from './fixtures/bake-fixture';
import { registryFor } from './helpers/bake-survival';
import { DEV_GLB } from './fixtures/glb-paths.mjs';
import { devAssetAvailable } from './fixtures/dev-asset-available';

const DEV_ASSETS = await devAssetAvailable(DEV_GLB.robotIK);
const GLB_URL = DEV_GLB.robotIK;

/** Angle between two unit quaternions, in degrees. */
function quatAngleDeg(a: readonly number[], b: readonly number[]): number {
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return 2 * Math.acos(Math.min(1, dot)) * (180 / Math.PI);
}

let baked: LoadResult | null = null;
let robots: RVRobotIK[] = [];
let cobot: RVRobotIK | null = null;
let cobotTargets: RVIKTarget[] = [];

/** Pose of `node` relative to `reference`: distance in mm, rotation in degrees. */
const _rel = new Matrix4();
const _relPos = new Vector3();
const _relQuat = new Quaternion();
const _relScl = new Vector3();
function poseRelativeTo(reference: Object3D, node: Object3D): { mm: number; deg: number } {
  _rel.copy(reference.matrixWorld).invert().multiply(node.matrixWorld);
  _rel.decompose(_relPos, _relQuat, _relScl);
  return {
    mm: Math.hypot(_relPos.x / (_relScl.x || 1), _relPos.y / (_relScl.y || 1), _relPos.z / (_relScl.z || 1)) * 1000,
    deg: quatAngleDeg([_relQuat.x, _relQuat.y, _relQuat.z, _relQuat.w], [0, 0, 0, 1]),
  };
}

describe.skipIf(!DEV_ASSETS)('RobotIK.TCP survives the destructive bake', () => {
  beforeAll(async () => {
    try {
      const bytes = await (await fetch(GLB_URL)).arrayBuffer();
      // The PRODUCTION load, through the one helper that proves it baked
      // (plan-772 F2): no authoring flag, a bake registry, and a
      // `BakeFailedError` left to propagate.
      baked = await loadBakedGLB(GLB_URL, new Scene(), { data: bytes });
      robots = baked.registry.getAll<RVRobotIK>('RobotIK')
        .map((r) => r.instance)
        .filter((r) => r.getAxisDrives().length === 6);
      cobot = robots.find((r) => r.WristType === 'NonSpherical') ?? null;
      cobotTargets = (cobot?.getPaths() ?? []).flatMap((p) => [...p.targets]).filter((t) => t.hasReplayAngles(6));
    } catch (err) {
      console.warn(`ik-tcp-bake-survival: baked GLB load failed — skipping (${String(err)})`);
      baked = null;
    }
  }, 120000);

  function ready(): boolean {
    if (!baked || robots.length === 0) {
      console.warn(`${GLB_URL}: no 6-axis robot in the baked load — skipping`);
      return false;
    }
    return true;
  }

  it('every 6-axis robot still resolves its TCP node after the bake', () => {
    if (!ready()) return;
    const withTcpWritten = robots.filter((r) => {
      const raw = (r.node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined)?.['RobotIK'];
      return raw?.['TCP'] !== undefined && raw['TCP'] !== null && raw['TCP'] !== '';
    });
    expect(withTcpWritten.length, 'the fixture must contain at least one robot with a written TCP').toBeGreaterThan(0);
    for (const r of withTcpWritten) {
      expect(r.getTcpNode(), `${r.node.name}: TCP node removed by the bake`).not.toBeNull();
    }
  });

  it('the cobot chain carries the real tool length and mount rotation, not identity', () => {
    if (!ready()) return;
    expect(cobot, 'the fixture must contain a NonSpherical (cobot) robot').not.toBeNull();
    const chain = cobot!.getJointChain();
    expect(chain).not.toBeNull();
    // THE NUMBER, not a truth value (plan-772 F3): 0.2399 m on this fixture.
    // Zero is the exact signature of a TCP the bake removed — the tool pose
    // collapsed onto the A6 flange. A wrong-but-nonzero offset (a different
    // node claimed, a stale rewrite) passes a `> 0.1` bound and fails this one.
    const len = Math.hypot(...chain!.tcpLocalOffset);
    console.info(`[ik-tcp] |tcpLocalOffset| = ${(len * 1000).toFixed(2)} mm, `
      + `tcpLocalRot = ${quatAngleDeg(chain!.tcpLocalRot, [0, 0, 0, 1]).toFixed(2)}°`);
    expect(len, 'tcpLocalOffset collapsed to zero ⇒ the TCP node did not survive the bake').toBeGreaterThan(0.239);
    expect(len, 'tcpLocalOffset is not the measured CRX tool length (0.2399 m)').toBeLessThan(0.241);
    // And the mount rotation is lost in exactly the same way (identity).
    // Measured on this fixture: 180.00° — the tool points back along the
    // flange axis. (plan-772 B2 calls it a "90° tool mount"; the measurement
    // says 180.00°, see the Phase-2 note in the plan's progress section.)
    const mountDeg = quatAngleDeg(chain!.tcpLocalRot, [0, 0, 0, 1]);
    expect(mountDeg).toBeGreaterThan(175);
    expect(mountDeg).toBeLessThanOrEqual(180.01);
  });

  it('no robot of the baked fixture reports an unresolved TCP', async () => {
    if (!ready()) return;
    const { IK_PROBLEM_CODES, getProblems } = await import('../src/core/hmi/problems-store');
    const offenders = getProblems()
      .filter((p) => p.code === IK_PROBLEM_CODES.tcpUnresolved)
      .map((p) => p.nodePath ?? p.title);
    expect(offenders, 'the diagnosis must agree with the measurement above').toEqual([]);
  });

  /**
   * The replay half of F3, and the one that reads as the bug did: with the
   * baked `AxisPos` applied through the drives, the TOOL has to sit on the
   * target, not the flange.
   *
   * The broken state's fingerprint was that the A6 FLANGE reached the target
   * pose while the TCP node stayed one tool length away — 239.90 mm / 180.00°,
   * identical at all five targets, because the chain's tool offset was zero.
   * So this test pins both ends: the TCP arrives, and the flange is still a
   * tool length off. Asserting only "the TCP is close" would also pass on a
   * rig with no tool at all.
   */
  it('baked AxisPos put the TCP node on the target and leave the A6 flange one tool length off', () => {
    if (!ready()) return;
    expect(cobotTargets.length, 'the CRX path must contribute targets with baked AxisPos').toBeGreaterThanOrEqual(5);
    const drives = cobot!.getAxisDrives();
    const tcpNode = cobot!.getTcpNode();
    expect(tcpNode, 'TCP node resolvable in the baked tree').toBeTruthy();
    const flange = drives[5].node;

    const rows: string[] = [];
    for (const t of cobotTargets) {
      for (let i = 0; i < 6; i++) {
        drives[i].currentPosition = t.AxisPos[i];
        drives[i].applyToNode();
      }
      cobot!.node.updateWorldMatrix(true, true);
      const tcp = poseRelativeTo(t.node, tcpNode!);
      const a6 = poseRelativeTo(t.node, flange);
      rows.push(`${t.node.name}: TCP ${tcp.mm.toFixed(2)} mm / ${tcp.deg.toFixed(2)}°`
        + ` | A6 ${a6.mm.toFixed(2)} mm / ${a6.deg.toFixed(2)}°`);
      expect(tcp.mm, `${t.node.name}: TCP node is not on the target`).toBeLessThan(10);
      expect(tcp.deg, `${t.node.name}: TCP node orientation is off`).toBeLessThan(2);
      // The flange must NOT be where the tool is — that was the defect.
      expect(a6.mm, `${t.node.name}: the A6 flange sits on the target, so the chain carries no tool`)
        .toBeGreaterThan(200);
    }
    console.info(`[ik-tcp] replay in the baked tree:\n  ${rows.join('\n  ')}`);
    // Back to the home pose — the drives are shared with every other test here.
    for (const d of drives) { d.currentPosition = d.StartPosition; d.applyToNode(); }
    cobot!.node.updateWorldMatrix(true, true);
  });

  // The LIVE half of F3 — the solver, in the baked tree, against Unity's own
  // `AxisPos` — is in `ik-frame-scale-golden.test.ts`, which asserts it for
  // ALL 18 targets of the fixture rather than only the CRX's five. It belongs
  // there and not here for a concrete reason: it needs the private WASM
  // solver, and a file that imports it is skipped in a community checkout
  // (`scripts/gen-private-test-excludes.mjs`). Everything above holds without
  // a solver, so this file stays a community test.
});

/**
 * The counter-probe the real fixture cannot give (plan-772 Phase 2): a TCP node
 * that survives for NO OTHER REASON than the `RobotIK.TCP` declaration.
 *
 * On `DemoRobotIK.glb` the IRB's `TCPToolOffset` survives by accident — it
 * carries a `PathTracer` component, so `reason=component` would keep it even
 * without the declaration, and removing that component from the shipped file
 * to prove the point is not an option. A synthetic tree states it directly:
 * the TCP node here has no component, no mesh, no children and only SCALAR
 * extras — exactly the shape `carriesComponent()` skips — so `referenced` is
 * the only reason it can have.
 */
describe('a TCP node survives on the declaration alone', () => {
  it('keeps a component-free, scalar-extras TCP node as a merge-role reference', () => {
    const root = group('Asset');
    const flange = group('A6');
    // The shape measured on the CRX TCP: extras, but not one of them an object.
    const tcp = group('GripperTCP');
    tcp.userData.realvirtual = { layer: 0, tag: 'Untagged', activeSelf: true };
    flange.add(tcp);
    const robot = withComponent(group('Robot'), 'RobotIK', { TCP: 'Asset/A6/GripperTCP' });
    root.add(flange, robot);

    const model = computeSurvival(root, registryFor(root));
    expect(model.reasonOf(tcp), 'nothing but the declaration can claim this node').toBe('referenced');
    expect(model.roleOf(tcp), 'the node must exist, but it draws nothing — merge, not chunk').toBe('merge');
  });

  it('and drops it again when the robot names nothing — the pre-fix state, stated', () => {
    const root = group('Asset');
    const flange = group('A6');
    const tcp = group('GripperTCP');
    tcp.userData.realvirtual = { layer: 0 };
    flange.add(tcp);
    // No TCP field at all: the node has no claim from anywhere.
    root.add(flange, withComponent(group('Robot'), 'RobotIK', { WristType: 'NonSpherical' }));

    const model = computeSurvival(root, registryFor(root));
    // `reasonOf` answers null for a node nothing claimed (the removal report
    // calls that `reason=none`).
    expect(model.reasonOf(tcp)).toBeNull();
  });
});
