// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ik-cobot-glb-chain.test.ts — FK consistency of the Cobot joint chain against
 * the REAL exported GLB (plan-233 Phase 2g diagnosis + regression).
 *
 * The synthetic/golden tests in ik-cobot.test.ts validate the WASM in a
 * hand-built Unity-frame chain. This test closes the remaining gap: the chain
 * that getJointChain() derives from the ACTUAL loaded glTF scene graph
 * (X-mirrored frame, real node hierarchy, serialized TCP ref) must be
 * consistent with the Unity-baked ground truth in the same GLB:
 *
 *   FK(chain, target.AxisPos)  ≡  targetPoseInBase(robot, targetNode)
 *
 * for every IKTarget of the FANUC CRX path — the baked AxisPos are what Unity's
 * RobotIK solved, so they reach the target pose by definition. A divergence
 * here means the browser chain (axis dirs / home transforms / TCP) does not
 * match the convention RVDrive uses to apply angles, i.e. live-solve and
 * replay disagree — exactly the "gripper orientation wrong on pathpoint click"
 * bug (root cause: RobotIK.TCP is serialized as a plain node-path STRING, which
 * resolveTcpNode() rejected, collapsing the TCP to the A6 flange).
 *
 * Also verifies the full live-solve loop: solveCobot on the glTF-frame target
 * pose, warm-started with the baked AxisPos, must echo the baked angles.
 *
 * Finally verifies the LIN replay (cartesian TCP line, IKPath.cs parity) on
 * BOTH robots — IRB2400 (Pieper) and FANUC CRX (Cobot): while a Linear segment
 * runs cartesian, every sampled TCP position must lie on the straight line
 * between the two waypoints; segments the guard rail rejects (baked AxisPos
 * disagree with the live solve — stale export data) must instead arrive at the
 * baked AxisPos via plain joint-space replay (LIN must NEVER degrade replay).
 * The path execution is solver-agnostic; only the per-step solve routes by
 * wrist type.
 *
 * Needs the DemoRealvirtual project's DemoRobotIK.glb (served by the vitest browser
 * server via the rv-private-models middleware) and the private WASM solver.
 * Skips with a warning when either is absent.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Scene, Vector3, Quaternion, Matrix4 } from 'three';
import { loadGLB, type LoadResult } from '../src/core/engine/rv-scene-loader';
import { ikSolverRegistry, targetPoseInBase, type JointChainParams } from '../src/core/engine/rv-ik-solver';
import type { RVRobotIK } from '../src/core/engine/rv-robot-ik';
import type { RVIKTarget } from '../src/core/engine/rv-ik-target';
import { WasmIKSolver } from '@rv-private/ik-solver/rv-ik-solver-provider';
import { DEV_GLB } from './fixtures/glb-paths.mjs';

const GLB_URL = DEV_GLB.robotIK;

// ── Test-local mini-FK (same convention as ik-cobot.test.ts / fk.rs) ─────────

type Q = [number, number, number, number];
type V3 = [number, number, number];
const DEG2RAD = Math.PI / 180;

function qMul(a: Q, b: Q): Q {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function qAxisAngle(axis: V3, rad: number): Q {
  const h = rad * 0.5, s = Math.sin(h);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
}

function qRotate(q: Q, v: V3): V3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

/** compute_fk(joints°, chain) → TCP (pos, rot) in the chain's base frame. */
function fk(joints: readonly number[], chain: JointChainParams): { pos: V3; rot: Q } {
  const homePos = (i: number): V3 => [chain.axisHomePos[i * 3], chain.axisHomePos[i * 3 + 1], chain.axisHomePos[i * 3 + 2]];
  const homeRot = (i: number): Q => [chain.axisHomeRot[i * 4], chain.axisHomeRot[i * 4 + 1], chain.axisHomeRot[i * 4 + 2], chain.axisHomeRot[i * 4 + 3]];
  const dir = (i: number): V3 => [chain.axisDir[i * 3], chain.axisDir[i * 3 + 1], chain.axisDir[i * 3 + 2]];

  let gPos = homePos(0);
  let gRot = qMul(homeRot(0), qAxisAngle(dir(0), joints[0] * DEG2RAD));
  for (let i = 1; i < 6; i++) {
    const off = qRotate(gRot, homePos(i));
    gPos = [gPos[0] + off[0], gPos[1] + off[1], gPos[2] + off[2]];
    gRot = qMul(gRot, qMul(homeRot(i), qAxisAngle(dir(i), joints[i] * DEG2RAD)));
  }
  const toff = qRotate(gRot, chain.tcpLocalOffset as V3);
  return {
    pos: [gPos[0] + toff[0], gPos[1] + toff[1], gPos[2] + toff[2]],
    rot: qMul(gRot, chain.tcpLocalRot as Q),
  };
}

function posDist(a: V3, b: V3): number {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Angle (deg) between two quaternions (sign/double-cover tolerant). */
function quatAngleDeg(a: Q, b: Q): number {
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return 2 * Math.acos(Math.min(1, dot)) / DEG2RAD;
}

function angDiff(a: number, b: number): number {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

// ── Fixture: load the real demo GLB once ─────────────────────────────────────

let result: LoadResult | null = null;
let robot: RVRobotIK | null = null;
let allRobots: RVRobotIK[] = [];
let targets: RVIKTarget[] = [];

beforeAll(async () => {
  try {
    const head = await fetch(GLB_URL, { method: 'HEAD' });
    if (!head.ok) return;
    const bytes = await (await fetch(GLB_URL)).arrayBuffer();
    if (bytes.byteLength < 100) return;
    const scene = new Scene();
    // preserveHierarchy: skip the uber/merge bakes so local transforms stay
    // authored — the drive-application check below recomputes world matrices.
    result = await loadGLB(GLB_URL, scene, { data: bytes, preserveHierarchy: true });
    const robots = result.registry.getAll<RVRobotIK>('RobotIK');
    allRobots = robots.map((r) => r.instance).filter((r) => r.getAxisDrives().length === 6);
    robot = allRobots.find((r) => r.WristType === 'NonSpherical') ?? null;
    targets = (robot?.getPaths() ?? []).flatMap((p) => [...p.targets])
      .filter((t) => t.hasReplayAngles(6));
  } catch (err) {
    console.warn(`ik-cobot-glb-chain: GLB load failed — skipping (${String(err)})`);
    result = null;
  }
}, 60000);

afterAll(() => {
  ikSolverRegistry.register(null);
  ikSolverRegistry.resetLiveSolveClaims();
});

function ready(): boolean {
  if (!result || !robot || targets.length === 0) {
    console.warn(`${GLB_URL} / CRX robot not available — skipping GLB chain test`);
    return false;
  }
  return true;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Cobot joint chain from the real GLB (FANUC CRX)', () => {
  it('resolves the serialized TCP (plain node-path string) into the chain', () => {
    if (!ready()) return;
    const chain = robot!.getJointChain();
    expect(chain).not.toBeNull();
    // The CRX gripper TCP sits ~0.24 m off the A6 flange with a non-identity
    // mount rotation. A zero offset means resolveTcpNode() failed and the chain
    // targets the flange — the "gripper orientation wrong" bug.
    const [ox, oy, oz] = chain!.tcpLocalOffset;
    expect(Math.hypot(ox, oy, oz)).toBeGreaterThan(0.1);
    const [rx, ry, rz, rw] = chain!.tcpLocalRot;
    expect(quatAngleDeg([rx, ry, rz, rw], [0, 0, 0, 1])).toBeGreaterThan(10);
  });

  it('chain FK on the Unity-baked AxisPos reproduces every target pose', () => {
    if (!ready()) return;
    const chain = robot!.getJointChain()!;
    const p3: [number, number, number] = [0, 0, 0];
    const q4: Q = [0, 0, 0, 1];
    for (const t of targets) {
      targetPoseInBase(robot!.node.matrixWorld, t.node.matrixWorld, p3, q4);
      const { pos, rot } = fk(t.AxisPos, chain);
      // Baked AxisPos are float32 + Unity solve tolerance → allow ~1 cm / 2°.
      expect(posDist(pos, p3), `pos mismatch at "${t.node.name}"`).toBeLessThan(0.01);
      expect(quatAngleDeg(rot, q4), `rot mismatch at "${t.node.name}"`).toBeLessThan(2);
    }
  });

  it('applying baked AxisPos through the drives puts the TCP node on the target', () => {
    if (!ready()) return;
    const drives = robot!.getAxisDrives();
    expect(drives.length).toBe(6);
    // Resolve the TCP node from the serialized ref (string form) independently
    // of resolveTcpNode(), so this check pins the replay convention itself.
    const raw = (robot!.node.userData?.realvirtual as Record<string, Record<string, unknown>>)['RobotIK'];
    const tcpRef = raw['TCP'];
    const tcpPath = typeof tcpRef === 'string' ? tcpRef : (tcpRef as { path?: string } | undefined)?.path;
    const tcpNode = tcpPath ? result!.registry.getNode(tcpPath) : null;
    expect(tcpNode, 'TCP node resolvable from serialized ref').toBeTruthy();

    const wp = new Vector3(), wq = new Quaternion(), ws = new Vector3();
    const tp = new Vector3(), tq = new Quaternion(), ts = new Vector3();
    const rel = new Matrix4();
    for (const t of targets) {
      for (let i = 0; i < 6; i++) {
        drives[i].currentPosition = t.AxisPos[i];
        drives[i].applyToNode();
      }
      robot!.node.updateWorldMatrix(true, true);
      // TCP pose relative to the target node — identity when replay is exact.
      rel.copy(t.node.matrixWorld).invert().multiply(tcpNode!.matrixWorld);
      rel.decompose(wp, wq, ws);
      tp.set(wp.x / (ws.x || 1), wp.y / (ws.y || 1), wp.z / (ws.z || 1));
      expect(tp.length(), `drive-applied TCP offset at "${t.node.name}"`).toBeLessThan(0.01);
      tq.set(0, 0, 0, 1);
      expect(quatAngleDeg([wq.x, wq.y, wq.z, wq.w], [tq.x, tq.y, tq.z, tq.w]),
        `drive-applied TCP rotation at "${t.node.name}"`).toBeLessThan(2);
    }
    // Restore home pose for the live-solve test below.
    for (const d of drives) { d.currentPosition = d.StartPosition; d.applyToNode(); }
    robot!.node.updateWorldMatrix(true, true);
  });

  it('live solveCobot warm-started with baked AxisPos echoes the baked angles', async () => {
    if (!ready()) return;
    const solver = new WasmIKSolver();
    await solver.load();
    if (solver.tier !== 'pro') {
      console.warn('WASM cobot solver not pro tier — skipping live-solve check');
      return;
    }
    ikSolverRegistry.register(solver);
    const chain = robot!.getJointChain()!;
    const opw = robot!.getOpwParams();
    expect(opw).not.toBeNull();
    const p3: [number, number, number] = [0, 0, 0];
    const q4: Q = [0, 0, 0, 1];
    for (const t of targets) {
      targetPoseInBase(robot!.node.matrixWorld, t.node.matrixWorld, p3, q4);
      const sols = ikSolverRegistry.solveCobot(chain, p3, q4, {
        opw: opw!,
        warmStart: new Float64Array(t.AxisPos),
      });
      expect(sols).not.toBeNull();
      const best = ikSolverRegistry.selectClosest(sols!, [...t.AxisPos]);
      expect(best, `no reachable solution at "${t.node.name}"`).not.toBeNull();
      for (let a = 0; a < 6; a++) {
        expect(angDiff(best![a], t.AxisPos[a]),
          `axis ${a + 1} at "${t.node.name}" (got ${best!.map((v) => v.toFixed(2)).join(', ')})`,
        ).toBeLessThan(1);
      }
    }
  }, 30000);

  it('LIN segments replay as straight TCP lines on BOTH robots (Pieper + Cobot)', async () => {
    if (!ready()) return;
    const solver = new WasmIKSolver();
    await solver.load();
    if (solver.tier !== 'pro') {
      console.warn('WASM cobot solver not pro tier — skipping LIN replay check');
      return;
    }
    ikSolverRegistry.register(solver);
    expect(allRobots.length, 'demo has 2 robots (IRB2400 + CRX)').toBeGreaterThanOrEqual(2);

    const dt = 1 / 60;
    const A = new Vector3(), B = new Vector3(), P = new Vector3();
    const AB = new Vector3(), AP = new Vector3(), C = new Vector3();

    let linearPathsTested = 0;
    for (const rb of allRobots) {
      const drives = rb.getAxisDrives();
      const tcp = rb.getTcpNode();
      expect(tcp, `TCP node for ${rb.node.name}`).toBeTruthy();
      let cartesianSegments = 0;

      for (const ikPath of rb.getPaths()) {
        const list = [...ikPath.targets];
        // Linear segments (index > 0 — the first target is always PTP).
        const linIdx = list
          .map((t, i) => ({ t, i }))
          .filter((e) => e.i > 0 && e.t.InterpolationToTarget === 'Linear')
          .map((e) => e.i);
        if (linIdx.length === 0) continue;
        linearPathsTested++;
        const lastLin = linIdx[linIdx.length - 1];

        // Fresh run from the authored start pose (paths share the drives).
        for (const d of drives) d.reset();
        ikPath.reset();
        ikPath.startPath();

        const stats = new Map<number, { maxDev: number; midSeen: boolean; n: number }>();
        for (const i of linIdx) stats.set(i, { maxDev: 0, midSeen: false, n: 0 });
        // Joint-space arrival error per segment, captured on the tick the path
        // advances (before drives start toward the next target).
        const arrival = new Map<number, number>();
        let prevNum = ikPath.NumTarget;

        // Loop guards: LoopPath (CRX) and cross-chained StartNextPath (IRB)
        // would run forever — stop once the last linear segment is done.
        for (let frame = 0; frame < 20000 && ikPath.PathIsActive; frame++) {
          ikPath.fixedUpdate(dt);
          if (ikPath.NumTarget !== prevNum) {
            const t = list[prevNum];
            if (t && stats.has(prevNum)) {
              arrival.set(prevNum,
                Math.max(...drives.map((d, i) => angDiff(d.currentPosition, t.AxisPos[i]))));
            }
            prevNum = ikPath.NumTarget;
          }
          for (const d of drives) d.update(dt);
          if (ikPath.NumTarget > lastLin) break;
          const st = stats.get(ikPath.NumTarget);
          // Sample only during actual LIN stepping: mid-path steps drive via
          // positionOverwrite (PTP/dwell/end-snap never do) — this also proves
          // the segment really ran cartesian, not the PTP fallback.
          if (!st || !drives.some((d) => d.positionOverwrite)) continue;
          rb.node.updateWorldMatrix(true, true);
          P.setFromMatrixPosition(tcp!.matrixWorld);
          A.setFromMatrixPosition(list[ikPath.NumTarget - 1].node.matrixWorld);
          B.setFromMatrixPosition(list[ikPath.NumTarget].node.matrixWorld);
          AB.subVectors(B, A);
          AP.subVectors(P, A);
          const len2 = AB.lengthSq();
          const s = len2 > 1e-12 ? Math.min(1, Math.max(0, AP.dot(AB) / len2)) : 0;
          C.copy(A).addScaledVector(AB, s);
          st.maxDev = Math.max(st.maxDev, P.distanceTo(C));
          st.n++;
          if (s > 0.35 && s < 0.65) st.midSeen = true;
        }

        for (const [i, st] of stats) {
          const label = `${rb.node.name}/${ikPath.node.name} → "${list[i].node.name}"`;
          if (st.n > 0) {
            // Segment ran cartesian → must cover the full straight line.
            expect(st.n, `${label}: LIN steps sampled`).toBeGreaterThan(3);
            expect(st.midSeen, `${label}: mid-line covered`).toBe(true);
            // 12 mm tolerance: the IRB's serialized OPW/tool model sits ~1 cm off
            // the GLB node chain (same constant offset the drive-application check
            // shows at every target) — the path itself is straight. The CRX, whose
            // chain/TCP are derived from the GLB nodes, is exact to <0.1 mm.
            expect(st.maxDev, `${label}: straight-line deviation [m]`).toBeLessThan(0.012);
            cartesianSegments++;
          } else {
            // Guard rail rejected the segment (baked AxisPos disagree with the
            // live solve — stale demo data on IRB Path1→Target1 and Path2) →
            // the fallback must behave EXACTLY like the plain joint-space
            // replay: arrive at the baked AxisPos.
            expect(arrival.get(i), `${label}: PTP-fallback arrival at baked AxisPos [deg]`)
              .toBeLessThan(1);
          }
        }
      }
      // The live-solve LIN must actually prove itself on this robot's solver
      // branch (IRB→Pieper, CRX→Cobot) — at least one cartesian segment each.
      expect(cartesianSegments, `${rb.node.name}: cartesian LIN segments`).toBeGreaterThanOrEqual(1);
    }
    // Both robots contribute at least one linear path each (IRB Path1/Path2 + CRX Robotpath).
    expect(linearPathsTested).toBeGreaterThanOrEqual(2);
  }, 120000);
});
