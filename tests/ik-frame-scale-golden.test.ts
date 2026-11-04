// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * ik-frame-scale-golden.test.ts — the frame a target pose is handed to the
 * solver in, pinned against Unity's own answer (plan-772 F5/F6/N2).
 *
 * ## The defect
 *
 * `targetPoseInBase()` used to divide the relative translation by the
 * decomposed scale:
 *
 * ```ts
 * _poseMat.decompose(_posePos, _poseQuat, _poseScl);
 * outPos[0] = _posePos.x / (_poseScl.x || 1);
 * ```
 *
 * `Matrix4.decompose()` puts the sign of a negative determinant on `scale.x`,
 * so for a target node authored with a mirrored scale that division silently
 * performed the glTF → Unity X mirror — the conversion the Pieper core needs,
 * because the OPW parameters it solves from are serialized Unity values. Right
 * answer, wrong reason: the mirror happened only where a target happened to be
 * authored mirrored, the scale MAGNITUDE leaked into the position everywhere
 * else, and the quaternion half of the conversion was never done at all.
 *
 * Measured on the 18 `DemoRobotIK.glb` targets that carry Unity-baked
 * `AxisPos`, in the BAKED tree, before and after:
 *
 * | robot / targets | authored scale | before | after |
 * |---|---|---|---|
 * | CRX Home, PickBefore, Pick, PlaceBefore, Place | (1,1,1) | 0.00° | **0.00°** |
 * | IRB Target1…Target5 | (-1,1,1) | 0.00° | **0.00°** |
 * | IRB Target6 | (1,1,1) | 91.56° | **0.00°** |
 * | IRB Target0_1…Target5_1 (second path) | (-1,1,1) | 60.00° | **0.00°** |
 * | IRB Target0 | (0.5,0.5,-0.5) | 178.88° | 180.00° |
 *
 * Two of those rows are findings in their own right. The second path's
 * constant 60.00° was read as stale demo data (plan-772 B5); it was the
 * missing quaternion half of the conversion. And `Target0` is not fixable from
 * a matrix at all — see the last case.
 *
 * ## What the cases assert
 *
 * Unity's `RobotIK` reads `target.position` and `target.rotation`; a target's
 * SCALE is not part of its pose. So the same authored position and rotation
 * must solve to the same joint angles at any scale, and the targets that
 * reproduce Unity exactly must keep doing so — the mirror is REPLACED here,
 * never removed (without it the mirrored IRB targets land 107–168° off, which
 * the `'chain'`-frame row of the variant table below still shows).
 *
 * Needs `DemoRobotIK.glb` (private Development project) and the WASM solver.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Object3D, Scene } from 'three';
import { type LoadResult } from '../src/core/engine/rv-scene-loader';
import { loadBakedGLB } from './helpers/load-baked-glb';
import { ikSolverRegistry, solveFrameFor, targetPoseInBase } from '../src/core/engine/rv-ik-solver';
import type { RVRobotIK } from '../src/core/engine/rv-robot-ik';
import type { RVIKTarget } from '../src/core/engine/rv-ik-target';
import { WasmIKSolver } from '@rv-private/ik-solver/rv-ik-solver-provider';
import { DEV_GLB } from './fixtures/glb-paths.mjs';
import { devAssetAvailable } from './fixtures/dev-asset-available';

const DEV_ASSETS = await devAssetAvailable(DEV_GLB.robotIK);
const GLB_URL = DEV_GLB.robotIK;

/** The four scalings of plan-772 F6; the first is what Unity exports. */
const SCALE_VARIANTS: ReadonlyArray<{ label: string; s: [number, number, number] }> = [
  { label: '(-1,1,1)', s: [-1, 1, 1] },
  { label: '(1,1,1)', s: [1, 1, 1] },
  { label: '(-0.5,0.5,0.5)', s: [-0.5, 0.5, 0.5] },
  { label: '(1,-1,1)', s: [1, -1, 1] },
];

/** The one target of the fixture that no matrix-based reading can place. */
const AMBIGUOUS_TARGET = 'Target0';

function angDiff(a: number, b: number): number {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

/** Largest per-axis difference between two 6-angle sets, in degrees. */
function maxAxisDiff(a: readonly number[], b: readonly number[]): number {
  let worst = 0;
  for (let i = 0; i < 6; i++) worst = Math.max(worst, angDiff(a[i] ?? 0, b[i] ?? 0));
  return worst;
}

/**
 * Set a node's scale on a node the loader's freeze pass turned static.
 *
 * `matrixAutoUpdate` AND `matrixWorldAutoUpdate` are false there, which makes
 * `updateMatrix()` reach nothing and `updateWorldMatrix()` return before it
 * recomputes: writing `node.scale` alone changes NOTHING, and a variant test
 * written that way passes while comparing a value against itself. (It did,
 * while this test was being written.) So both matrices are composed by hand.
 */
function setScale(node: Object3D, s: readonly [number, number, number]): void {
  node.scale.set(s[0], s[1], s[2]);
  node.matrix.compose(node.position, node.quaternion, node.scale);
  const parent = node.parent;
  if (parent) {
    parent.updateWorldMatrix(true, false);
    node.matrixWorld.multiplyMatrices(parent.matrixWorld, node.matrix);
  } else {
    node.matrixWorld.copy(node.matrix);
  }
}

let baked: LoadResult | null = null;
let robots: RVRobotIK[] = [];
let solverIsPro = false;

const p3: [number, number, number] = [0, 0, 0];
const q4: [number, number, number, number] = [0, 0, 0, 1];

/** Solve `target` for `robot` in the frame that robot's solver reads. */
function solve(robot: RVRobotIK, target: RVIKTarget): number[] | null {
  const chain = robot.getJointChain();
  const opw = robot.getOpwParams();
  if (!opw) return null;
  targetPoseInBase(robot.node.matrixWorld, target.node.matrixWorld, p3, q4,
    solveFrameFor(robot.WristType, chain));
  const sols = solveFrameFor(robot.WristType, chain) === 'chain' && chain
    ? ikSolverRegistry.solveCobot(chain, p3, q4, { opw, warmStart: new Float64Array(target.AxisPos) })
    : ikSolverRegistry.solvePieper(opw, p3, q4);
  return sols ? ikSolverRegistry.selectClosest(sols, [...target.AxisPos]) : null;
}

/** Every target of `robot` that carries Unity-baked angles. */
function bakedTargetsOf(robot: RVRobotIK): RVIKTarget[] {
  return (robot.getPaths() ?? []).flatMap((p) => [...p.targets]).filter((t) => t.hasReplayAngles(6));
}

describe.skipIf(!DEV_ASSETS)('IK target frame: scale is not part of the pose', () => {
  beforeAll(async () => {
    const bytes = await (await fetch(GLB_URL)).arrayBuffer();
    baked = await loadBakedGLB(GLB_URL, new Scene(), { data: bytes });
    robots = baked.registry.getAll<RVRobotIK>('RobotIK')
      .map((r) => r.instance)
      .filter((r) => r.getAxisDrives().length === 6);
    const solver = new WasmIKSolver();
    await solver.load();
    solverIsPro = solver.tier === 'pro';
    if (solverIsPro) ikSolverRegistry.register(solver);
  }, 180000);

  afterAll(() => {
    ikSolverRegistry.register(null);
    ikSolverRegistry.resetLiveSolveClaims();
  });

  function ready(): boolean {
    if (!baked || robots.length < 2) {
      console.warn(`${GLB_URL}: needs both demo robots — skipping`);
      return false;
    }
    if (!solverIsPro) {
      console.warn('WASM cobot solver not pro tier — skipping the frame golden test');
      return false;
    }
    return true;
  }

  it('N2 + F5: every demo target but the ambiguous one reproduces Unity exactly', () => {
    if (!ready()) return;
    const rows: string[] = [];
    let checked = 0;
    for (const robot of robots) {
      for (const t of bakedTargetsOf(robot)) {
        const angles = solve(robot, t);
        const dev = angles ? maxAxisDiff(angles, t.AxisPos) : Number.NaN;
        rows.push(`${robot.node.name}/${t.node.name} (${t.node.scale.x},${t.node.scale.y},${t.node.scale.z}): `
          + `${Number.isNaN(dev) ? 'NO SOLUTION' : `${dev.toFixed(2)}°`}`);
        if (t.node.name === AMBIGUOUS_TARGET) continue;
        checked++;
        expect(angles, `no reachable solution at "${t.node.name}"`).not.toBeNull();
        expect(dev, `${robot.node.name}/${t.node.name}: lost parity with Unity's baked AxisPos`)
          .toBeLessThan(0.5);
      }
    }
    console.info(`[ik-frame] parity with Unity, baked tree:\n  ${rows.join('\n  ')}`);
    // 17 of the fixture's 18 targets. A fixture change that quietly dropped
    // targets would otherwise make this test pass on nothing.
    expect(checked, 'the fixture must still contribute its 17 unambiguous targets').toBe(17);
  }, 120000);

  it('F6: a target\'s scale does not move the robot', () => {
    if (!ready()) return;
    const cobot = robots.find((r) => r.WristType === 'NonSpherical')!;
    const target = bakedTargetsOf(cobot)[0];
    const authored: [number, number, number] = [target.node.scale.x, target.node.scale.y, target.node.scale.z];
    try {
      const rows: string[] = [];
      let reference: number[] | null = null;
      for (const variant of SCALE_VARIANTS) {
        setScale(target.node, variant.s);
        const angles = solve(cobot, target);
        const dev = angles && reference ? maxAxisDiff(angles, reference) : 0;
        if (!reference) reference = angles;
        rows.push(`${variant.label}: ${angles ? `${dev.toFixed(2)}°` : 'NO SOLUTION'}`);
      }
      console.info(`[ik-frame] F6 at "${target.node.name}" (deviation from the (-1,1,1) variant): ${rows.join(', ')}`);

      // Re-run as assertions, so a failure names the variant.
      setScale(target.node, SCALE_VARIANTS[0].s);
      const base = solve(cobot, target);
      expect(base, 'the reference variant must solve').not.toBeNull();
      for (const variant of SCALE_VARIANTS.filter((v) => v.label !== '(1,-1,1)')) {
        setScale(target.node, variant.s);
        const angles = solve(cobot, target);
        expect(angles, `${variant.label}: no reachable solution`).not.toBeNull();
        expect(maxAxisDiff(angles!, base!), `${variant.label}: the target's scale moved the robot`)
          .toBeLessThan(0.5);
      }
    } finally {
      setScale(target.node, authored);
    }
  }, 120000);

  /**
   * The honest limit of a matrix-based reading, stated as a test so nobody
   * "fixes" it twice.
   *
   * A node with rotation `R` and scale `(1,-1,1)` and a node with rotation
   * `R · Rz(180°)` and scale `(-1,1,1)` have the SAME world matrix, element
   * for element. `decompose()` has to pick one, and it picks the second (it
   * assigns a negative determinant's sign to X). So a Y- or Z-mirrored target
   * reads as a 180°-rolled tool, and the solver answers for the pose it was
   * given. The fixture's `Target0` (scale (0.5, 0.5, -0.5)) is exactly that
   * case, and it is why it stays 180° from Unity's baked angles while the
   * other 17 targets are exact.
   *
   * Recovering it would mean reading the authored quaternion instead of the
   * world matrix, i.e. a different signature for `targetPoseInBase` — or
   * re-authoring the target. Both are decisions for the plan, not for this
   * file.
   */
  it('a Y/Z-mirrored target reads as a tool roll, because a matrix cannot say otherwise', () => {
    if (!ready()) return;
    const irb = robots.find((r) => r.WristType !== 'NonSpherical')!;
    const ambiguous = bakedTargetsOf(irb).find((t) => t.node.name === AMBIGUOUS_TARGET);
    expect(ambiguous, `the fixture must still contain "${AMBIGUOUS_TARGET}"`).toBeDefined();
    expect(ambiguous!.node.scale.z, 'its Z mirror is the whole point').toBeLessThan(0);
    const angles = solve(irb, ambiguous!);
    expect(angles, 'it must still SOLVE — an ambiguous frame is not an unreachable one').not.toBeNull();
    const dev = maxAxisDiff(angles!, ambiguous!.AxisPos);
    console.info(`[ik-frame] "${AMBIGUOUS_TARGET}" (scale ${ambiguous!.node.scale.x},`
      + `${ambiguous!.node.scale.y},${ambiguous!.node.scale.z}) vs Unity: ${dev.toFixed(2)}° — the tool roll`);

    // And the measurement that says WHERE the defect is: the target's authored
    // QUATERNION is right. Give the same node any scale that is not Y/Z
    // mirrored and it reproduces Unity at 0.00°, position included (which also
    // shows the position no longer depends on the scale at all). So this is one
    // node authored with a mirrored Z in the demo file, not a solver or a data
    // problem — re-authoring that one scale makes all 18 targets exact.
    const authored: [number, number, number] = [
      ambiguous!.node.scale.x, ambiguous!.node.scale.y, ambiguous!.node.scale.z,
    ];
    try {
      const rows: string[] = [];
      for (const s of [[-1, 1, 1], [1, 1, 1], [0.5, 0.5, 0.5]] as Array<[number, number, number]>) {
        setScale(ambiguous!.node, s);
        const a = solve(irb, ambiguous!);
        rows.push(`(${s.join(',')}): ${a ? `${maxAxisDiff(a, ambiguous!.AxisPos).toFixed(2)}°` : 'NO SOLUTION'}`);
        expect(a, `${s.join(',')}: no solution`).not.toBeNull();
        expect(maxAxisDiff(a!, ambiguous!.AxisPos),
          `${s.join(',')}: the authored rotation should reproduce Unity once the Z mirror is gone`)
          .toBeLessThan(0.5);
      }
      console.info(`[ik-frame] "${AMBIGUOUS_TARGET}" at un-mirrored scales: ${rows.join(', ')}`);
    } finally {
      setScale(ambiguous!.node, authored);
    }
    // Pinned as the known 180° roll, not as "anything goes": a value that is
    // neither 0 nor 180 would mean something else changed.
    expect(dev).toBeGreaterThan(175);
  }, 120000);
});
