// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-robot-tools — the `web_robot_*` family (plan-773 Phases 1 and 2).
 *
 * ## Why an own family and not `authorable: true` (decision E6)
 *
 * `web_component_add` is gone, and `web_editor_add_component` offers only types
 * whose registry capabilities declare `authorable: true` — which `RobotIK`,
 * `IKPath` and `IKTarget` deliberately do not. A rig is a TRANSACTION, not a
 * field: six axis references in order, a TCP, a wrist type and seven kinematic
 * constants, each of which is wrong on its own. An "Add Component ▸ RobotIK"
 * that produced an empty shell would create exactly the half-rigged robot the
 * five `robot-ik-*` Problems entries exist to complain about. So the three
 * components stay un-authorable and the rig gets its own verb.
 *
 * ## The read tools are Unity's four, in web form (Phase 1)
 *
 * `web_robot_list` / `_get_chain` / `_get_state` / `_verify_fk` are the pendants
 * of `ik_get_chain`, `ik_get_state` and `ik_verify_fk` in
 * `Packages/io.realvirtual.professional/Runtime/IK/IKTools.cs`. Two differences
 * are intentional and not omissions:
 *
 * - Unity's `ik_solve_target` SELECTS a target to trigger the editor's solve.
 *   It has no web pendant here: a solving verb belongs with the path tools of
 *   Phase 3, and a read family that silently moved the robot would not be
 *   read-only.
 * - Unity's `ik_verify_fk` computes DH forward kinematics from the OPW
 *   parameters. {@link McpRobotTools.queryVerifyFk} computes it from the
 *   DERIVED JOINT CHAIN instead, because that chain is what the web actually
 *   solves and replays with, and because the OPW parameters of a cobot cannot
 *   express its wrist at all (see `rv-robot-rig.ts`). Verifying the model the
 *   viewer does not use would prove nothing.
 *
 * ## Frames are never guessed
 *
 * Every pose this file hands to or takes from a solver goes through
 * `solveFrameFor(wristType, chain)` and `targetPoseInBase(..., frame)`. There
 * are TWO solve frames (`rv-ik-solver.ts` header): the glTF chain frame for
 * `solveCobot` and Unity's mirrored frame for `solvePieper`. A tool that picked
 * one by hand would be the plan-772 defect again, in a new file.
 *
 * ## Tier is reported, never silently degraded (F7)
 *
 * Reading needs no solver, so every read tool answers at tier `'none'` and says
 * so. The one robot the public library ships is a COBOT and therefore needs
 * `'pro'` to live-solve; at `'free'` it can only replay. Every answer carries
 * `tier` and, where it matters, `tierVerdict` — the refusal is a sentence, not
 * an empty result.
 *
 * ## Every WRITE of this family is a view of an `ik.*` command
 *
 * The seven writing tools (`_rig_from_library` and the six path verbs) dispatch
 * `ik.robot.rig` / `ik.path.create` / `ik.target.add` / `_set` / `_remove` /
 * `_reorder` / `_solve` through {@link dispatchBoundCommand}; the routines they
 * used to be are the commands' `run()` bodies. Phase 5's `_program_export`
 * dispatches `ik.program.export` the same way although it is read-only, because
 * the IKPath inspector's Export button is its second caller. The wire args ARE the command
 * args, so nothing an agent can observe changed — except that a bound tool is
 * no longer listed separately in `tools/list`. The reasoning, and what
 * `macro: true` is worth today, is at the bottom of this file.
 */

import { checkPath } from './rv-mcp-robot-check';
import { moveTcp, runPath, type MoveTcpArgs } from './rv-mcp-robot-run';
import type { Object3D } from 'three';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import type { RVRobotIK } from '../../core/engine/rv-robot-ik';
import type { RVDrive } from '../../core/engine/rv-drive';
import { isRef, type RVIKPath } from '../../core/engine/rv-ik-path';
import type { NodeRegistry } from '../../core/engine/rv-node-registry';
import {
  ikSolverRegistry, solveFrameFor, targetPoseInBase,
  type JointChainParams,
} from '../../core/engine/rv-ik-solver';
import {
  applyAnglesToDrives, currentDriveAngles, solveRobotToWorldPose,
  reportTargetReplayAngles, writeLiveAxisPos,
  IK_AXIS_COUNT, type IkSolveOutcome,
} from '../../core/engine/rv-ik-authoring';
import { directionToGltfAxis } from '../../core/engine/rv-coordinate-utils';
import { chainFk, orientationErrorDeg, positionErrorMm, type Quat, type Vec3 } from '../../core/engine/rv-robot-fk';
import {
  buildRobotIkRigFields, chainFromDerivation, chainGeometry, deriveSerialAxisChain, driveKindOf,
  estimateOpwFromChain, measureWristType,
  type OpwEstimate, type SerialChainDerivation, type WristVerdict,
} from '../../core/engine/rv-robot-rig';
import { getFieldDescriptor } from '../../core/engine/rv-component-registry';
import { downloadTextFile } from '../../core/hmi/rv-download-text-file';
// Type-only: erased at build time, so it does NOT put the export core into this
// chunk. Every VALUE from `src/core/robot-program/` is reached by `import()`.
import type { RobotProgram } from '../../core/robot-program/rv-robot-program';
import { storedReferenceValue } from '../../core/engine/rv-node-path-rewrite.mjs';
import { assetRelativePath } from '../../core/engine/rv-reference-resolver';
import { authoredAssetRelativePath, listReferenceCandidates, makeComponentReference } from '../../core/hmi/rv-reference-field';
import type { RuntimeNodeSpec } from '../../core/engine/rv-scene-loader';
import type { SceneStore } from '../../core/hmi/scene/scene-store';
import type { RvScenePrimitiveOp } from '../../core/ops/rv-unified-ops';
import {
  clearRobotIkProblems, getProblems, IK_PROBLEM_CODES,
} from '../../core/hmi/problems-store';
import {
  commandRegistry,
  type CommandContext,
  type CommandArgType,
  type CommandDescriptor,
  type CommandImpl,
  type CommandMcpMirror,
  type CommandRegistry,
} from '../../core/hmi/rv-command-registry';
import {
  valueOrThrowToolJson,
} from '../../core/hmi/rv-command-context';

// ─── The `ik.*` command ids (plan-773 Phase 3 Nachtrag 2026-10-23) ───────

/** Create an IKPath node under a robot. Alias tool: `web_robot_path_create`. */
export const IK_PATH_CREATE_COMMAND = 'ik.path.create';
/** Add a waypoint to an IK path and solve it. Alias tool: `web_robot_target_add`. */
export const IK_TARGET_ADD_COMMAND = 'ik.target.add';
/** Set a scoped Grip reference through the same picker contract as the inspector. */
export const IK_TARGET_SET_GRIP_COMMAND = 'ik.target.setGrip';
/** Change a waypoint's pose and/or fields. Alias tool: `web_robot_target_set`. */
export const IK_TARGET_SET_COMMAND = 'ik.target.set';
/** Drop a waypoint from an IK path. Alias tool: `web_robot_target_remove`. */
export const IK_TARGET_REMOVE_COMMAND = 'ik.target.remove';
/** Move a waypoint inside the order. Alias tool: `web_robot_target_reorder`. */
export const IK_TARGET_REORDER_COMMAND = 'ik.target.reorder';
/** Solve a waypoint and drive the robot onto it. Alias tool: `web_robot_solve_target`. */
export const IK_TARGET_SOLVE_COMMAND = 'ik.target.solve';
/** Derive and write a complete RobotIK. Alias tool: `web_robot_rig_from_library`. */
export const IK_ROBOT_RIG_COMMAND = 'ik.robot.rig';
/**
 * Export an IK path as a vendor robot program (plan-773 Phase 5, F18/F19).
 * Alias tool: `web_robot_program_export`; the IKPath inspector's download
 * button is the second view of the SAME command.
 *
 * `readOnly: true` and therefore NOT `macro: true`: the export re-solves every
 * waypoint but writes nothing — no drive moves, no extras, no document op (see
 * `rv-ik-path-to-program.ts`, "What this port does NOT do: write to the
 * scene"). It is bound all the same, because a binding is what gives the
 * download button and the tool ONE implementation and keeps the tool out of
 * `tools/list`.
 */
export const IK_PROGRAM_EXPORT_COMMAND = 'ik.program.export';

/** Every `ik.*` command id — for `preload` and for the family's own tests. */
export const IK_COMMAND_IDS: readonly string[] = [
  IK_ROBOT_RIG_COMMAND, IK_PATH_CREATE_COMMAND, IK_TARGET_ADD_COMMAND, IK_TARGET_SET_COMMAND,
  IK_TARGET_SET_GRIP_COMMAND, IK_TARGET_REMOVE_COMMAND, IK_TARGET_REORDER_COMMAND, IK_TARGET_SOLVE_COMMAND,
  IK_PROGRAM_EXPORT_COMMAND, 'ik.path.run', 'ik.path.stop', 'ik.robot.moveTcp', 'ik.path.check',
];

/** How many decimals a length in meters is reported with (0.1 mm). */
function m4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

/** Degrees, two decimals — the precision `ik_get_state` prints. */
function deg2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** A position triple, rounded for the answer. */
function pos3(v: readonly number[]): [number, number, number] {
  return [m4(v[0] ?? 0), m4(v[1] ?? 0), m4(v[2] ?? 0)];
}

/** The disclaimer every rig answer carries: a derived rig is measured, not certified. */
export const RIG_DISCLAIMER =
  'A derived rig is measured off the robot\'s own scene graph, not read from a datasheet. '
  + 'Verify it with ik.robot.verifyFk before you trust a pose, and read the opw.confidence field: '
  + '"seed-only" means the OPW parameters are a solver seed, not kinematic data.';

/** The codes this family reports back to the caller — the panel's own entries (plan-772). */
const ROBOT_PROBLEM_CODES: ReadonlySet<string> = new Set(Object.values(IK_PROBLEM_CODES));

/**
 * How many instructions carry freshly solved angles and how many fall back to
 * the ones baked into the file — the one number that says whether an exported
 * program describes the rig as it is today (plan-773 Phase 4's `AnglesSource`).
 *
 * `none` never reaches a successful answer: a vendor refuses on it.
 */
function countAnglesSources(prog: RobotProgram): { solved: number; baked: number; none: number } {
  const out = { solved: 0, baked: 0, none: 0 };
  for (const m of prog.Instructions) out[m.AnglesSource]++;
  return out;
}

export class McpRobotTools {
  constructor(private readonly getViewer: () => RVViewer | undefined) {
    // The eight bound tools need their `ik.*` commands before discover.
    ensureIkCommandsRegistered();
  }

  private get viewer(): RVViewer | undefined { return this.getViewer(); }

  // ─── shared helpers ────────────────────────────────────────────────────

  /** The tier block every answer carries — stated, so nothing degrades in silence. */
  private tierBlock(): { tier: string; maxLiveSolvingRobots: number; canSolveCobot: boolean } {
    return {
      tier: ikSolverRegistry.tier,
      maxLiveSolvingRobots: ikSolverRegistry.maxRobots,
      canSolveCobot: ikSolverRegistry.canSolveCobot,
    };
  }

  /**
   * What this tier can do with THIS robot — the sentence, not a boolean.
   *
   * The library's only robot is a cobot, so `'free'` plus `'NonSpherical'` is
   * the case a first-time user hits, and "replay only" has to be said out loud
   * rather than shown as an empty solutions list (R7).
   */
  private tierVerdict(wristType: string): string {
    const tier = ikSolverRegistry.tier;
    if (tier === 'none') {
      return 'No solver is loaded (open-source or unlicensed build): this robot can replay baked AxisPos '
        + 'but cannot be solved live. Reading and rigging work; solving does not.';
    }
    if (wristType === 'NonSpherical' && !ikSolverRegistry.canSolveCobot) {
      return `Tier "${tier}" carries the analytic Pieper solver only. This robot has a NON-SPHERICAL wrist `
        + 'and needs the numerical cobot solver (Pro) to be solved live; until then it replays baked '
        + 'AxisPos. This is the case for the library robot FanucCRX-10iA-L, which ships rigged (RobotIK) with a '
        + 'demo IKPath "Robotpath" whose targets carry baked AxisPos, so it replays on every tier.';
    }
    return `Tier "${tier}" can solve this robot live (${ikSolverRegistry.maxRobots} robot(s) concurrently).`;
  }

  /** Problems the robotics diagnosis reported for `nodePath` — code + detail, as the panel has them. */
  private problemsFor(nodePath: string): Array<{ code: string; severity: string; detail: string }> {
    return getProblems()
      .filter((p) => ROBOT_PROBLEM_CODES.has(p.code) && p.nodePath === nodePath)
      .map((p) => ({ code: p.code, severity: p.severity, detail: p.detail }));
  }

  /** Every `RobotIK` in the loaded model with its registry path. */
  private robots(): Array<{ path: string; instance: RVRobotIK }> {
    return this.viewer?.registry?.getAll<RVRobotIK>('RobotIK') ?? [];
  }

  /** Resolve one robot by path or name; with no argument, the only one. */
  private robot(path?: string): { path: string; robot: RVRobotIK } | { error: string } {
    const all = this.robots();
    if (all.length === 0) {
      return {
        error: 'No RobotIK in the loaded model. web_query("ik.robot.list", {}) shows what is there; '
          + 'ik.robot.rig builds a rig from a library robot.',
      };
    }
    const want = (path ?? '').trim();
    if (!want) {
      if (all.length === 1) return { path: all[0].path, robot: all[0].instance };
      return {
        error: `${all.length} robots are loaded — pass path. Available: ${all.map((r) => r.path).join(', ')}`,
      };
    }
    const exact = all.find((r) => r.path === want);
    if (exact) return { path: exact.path, robot: exact.instance };
    const byName = all.filter((r) => r.instance.node.name === want || r.path.endsWith(`/${want}`));
    if (byName.length === 1) return { path: byName[0].path, robot: byName[0].instance };
    if (byName.length > 1) {
      return { error: `"${want}" matches ${byName.length} robots: ${byName.map((r) => r.path).join(', ')}` };
    }
    return { error: `No RobotIK at "${want}". Available: ${all.map((r) => r.path).join(', ')}` };
  }

  // ─── Phase 1 — reading (F1-F4, F7) ─────────────────────────────────────

  async queryList(): Promise<string> {
    const all = this.robots();
    if (!this.viewer?.registry) return JSON.stringify({ error: 'No model is loaded.' });
    return JSON.stringify({
      ...this.tierBlock(),
      count: all.length,
      robots: all.map(({ path, instance }) => {
        const axes = instance.getAxisDrives();
        const chain = instance.getJointChain();
        const paths = instance.getPaths();
        return {
          path,
          name: instance.node.name,
          axisCount: axes.length,
          wristType: instance.WristType,
          chainDerived: chain !== null,
          tcpResolved: instance.getTcpNode() !== null,
          opwUsable: instance.getOpwParams() !== null,
          elbowInUnityX: instance.ElbowInUnityX,
          solveFrame: solveFrameFor(instance.WristType, chain),
          ikPaths: paths.map((p: RVIKPath) => ({
            path: this.viewer?.registry?.getPathForNode(p.node) ?? p.node.name,
            targets: p.targets.length,
            targetsWithAngles: p.targets.filter((t) => t.hasReplayAngles(axes.length || 6)).length,
          })),
          problems: this.problemsFor(path),
          tierVerdict: this.tierVerdict(instance.WristType),
        };
      }),
    });
  }

  async queryGetChain(
    path?: string,
  ): Promise<string> {
    const hit = this.robot(path);
    if ('error' in hit) return JSON.stringify({ error: hit.error, ...this.tierBlock() });
    const { robot } = hit;
    const registry = this.viewer?.registry;
    const axes = robot.getAxisDrives();
    const chain = robot.getJointChain();

    const base = robot.node;
    base.updateWorldMatrix(true, false);
    const invBase = new Matrix4().copy(base.matrixWorld).invert();
    const localOf = (node: Object3D): [number, number, number] => {
      const m = new Matrix4().copy(invBase).multiply(node.matrixWorld);
      return pos3([m.elements[12], m.elements[13], m.elements[14]]);
    };

    let prev = base;
    const axisRows = axes.map((d: RVDrive, i: number) => {
      // Segment length from the previous axis, in mm — Unity's `segmentMm`.
      const a = d.node.matrixWorld.elements;
      const b = prev.matrixWorld.elements;
      const dx = a[12] - b[12], dy = a[13] - b[13], dz = a[14] - b[14];
      prev = d.node;
      return {
        index: i,
        name: d.node.name,
        path: registry?.getPathForNode(d.node) ?? null,
        direction: d.Direction,
        kind: driveKindOf(d.Direction),
        reverseDirection: d.ReverseDirection,
        worldPos: pos3([a[12], a[13], a[14]]),
        localPos: localOf(d.node),
        currentAngleDeg: deg2(d.currentPosition),
        segmentMm: Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz) * 10000) / 10,
        useLimits: d.UseLimits,
        limitsDeg: d.UseLimits ? [d.LowerLimit, d.UpperLimit] : null,
      };
    });

    const tcpNode = robot.getTcpNode();
    const geom = chain ? chainGeometry(chain) : null;
    const wrist = geom ? measureWristType(geom) : null;

    return JSON.stringify({
      ...this.tierBlock(),
      path: hit.path,
      name: robot.node.name,
      wristType: robot.WristType,
      elbowInUnityX: robot.ElbowInUnityX,
      solveFrame: solveFrameFor(robot.WristType, chain),
      robotBase: {
        worldPos: pos3([base.matrixWorld.elements[12], base.matrixWorld.elements[13], base.matrixWorld.elements[14]]),
      },
      axisCount: axes.length,
      axes: axisRows,
      tcp: tcpNode
        ? {
          name: tcpNode.name,
          path: registry?.getPathForNode(tcpNode) ?? null,
          worldPos: pos3([tcpNode.matrixWorld.elements[12], tcpNode.matrixWorld.elements[13], tcpNode.matrixWorld.elements[14]]),
          localPos: localOf(tcpNode),
          localOffsetFromFlange: chain ? pos3(chain.tcpLocalOffset) : null,
        }
        : null,
      chainDerived: chain !== null,
      wristMeasurement: wrist
        ? { wristPointLocal: pos3(geom!.wrist), offsetMm: Math.round(wrist.offsetMm * 10) / 10, verdict: wrist.wristType, evidence: wrist.evidence }
        : null,
      opwParams: robot.getOpwParams(),
      problems: this.problemsFor(hit.path),
      tierVerdict: this.tierVerdict(robot.WristType),
    });
  }

  async queryGetState(
    path?: string,
  ): Promise<string> {
    const hit = this.robot(path);
    if ('error' in hit) return JSON.stringify({ error: hit.error, ...this.tierBlock() });
    const { robot } = hit;
    const registry = this.viewer?.registry;
    const axes = robot.getAxisDrives();
    const chain = robot.getJointChain();
    const angles = axes.map((d: RVDrive) => deg2(d.currentPosition));

    robot.node.updateWorldMatrix(true, false);
    const fk = chain ? chainFk(chain, angles) : null;
    const tcpNode = robot.getTcpNode();

    // The TCP node's real pose in the robot frame, for the same comparison
    // `ik_get_state` makes between the solved pose and the scene.
    let tcpActual: { pos: Vec3; quat: Quat } | null = null;
    if (tcpNode) {
      const p: Vec3 = [0, 0, 0];
      const q: Quat = [0, 0, 0, 1];
      targetPoseInBase(robot.node.matrixWorld, tcpNode.matrixWorld, p, q, 'chain');
      tcpActual = { pos: p, quat: q };
    }

    const activePaths = robot.getPaths().map((p: RVIKPath) => ({
      path: registry?.getPathForNode(p.node) ?? p.node.name,
      pathIsActive: p.PathIsActive,
      currentTarget: p.CurrentTarget
        ? {
          name: p.CurrentTarget.node.name,
          path: registry?.getPathForNode(p.CurrentTarget.node) ?? null,
          axisPos: p.CurrentTarget.AxisPos.map(deg2),
          interpolation: p.CurrentTarget.InterpolationToTarget,
        }
        : null,
      lastTarget: p.LastTarget ? p.LastTarget.node.name : null,
      targets: p.targets.length,
    }));

    return JSON.stringify({
      ...this.tierBlock(),
      path: hit.path,
      name: robot.node.name,
      wristType: robot.WristType,
      jointAnglesDeg: angles,
      chainDerived: chain !== null,
      tcpFromChain: fk ? { pos: pos3(fk.tcp.pos), quat: fk.tcp.quat.map((v) => m4(v)) } : null,
      flangeFromChain: fk ? { pos: pos3(fk.flange.pos), quat: fk.flange.quat.map((v) => m4(v)) } : null,
      tcpFromScene: tcpActual ? { pos: pos3(tcpActual.pos), quat: tcpActual.quat.map((v) => m4(v)) } : null,
      tcpAgreementMm: fk && tcpActual ? Math.round(positionErrorMm(fk.tcp.pos, tcpActual.pos) * 10) / 10 : null,
      ikPaths: activePaths,
      problems: this.problemsFor(hit.path),
      tierVerdict: this.tierVerdict(robot.WristType),
    });
  }

  async queryVerifyFk(
    path?: string,
    targetPath?: string,
    anglesJson?: string,
  ): Promise<string> {
    const hit = this.robot(path);
    if ('error' in hit) return JSON.stringify({ error: hit.error, ...this.tierBlock() });
    const { robot } = hit;
    const chain = robot.getJointChain();
    if (!chain) {
      return JSON.stringify({
        error: 'No joint chain could be derived from this robot, so there is no forward kinematics to verify.',
        code: IK_PROBLEM_CODES.chainUnresolved,
        problems: this.problemsFor(hit.path),
        ...this.tierBlock(),
      });
    }

    // Where the joint vector comes from — stated in the answer, because the
    // three sources mean three different claims.
    let angles: number[];
    let source: 'anglesJson' | 'target-axispos' | 'current-drive-positions';
    let target: { name: string; path: string | null; node: Object3D } | null = null;

    if (anglesJson) {
      let parsed: unknown;
      try { parsed = JSON.parse(anglesJson); } catch { return JSON.stringify({ error: 'anglesJson must be a JSON array of six numbers.' }); }
      if (!Array.isArray(parsed) || parsed.length < 6 || parsed.some((v) => !Number.isFinite(Number(v)))) {
        return JSON.stringify({ error: 'anglesJson must be a JSON array of six finite numbers (degrees).' });
      }
      angles = parsed.slice(0, 6).map((v) => Number(v));
      source = 'anglesJson';
    } else if (targetPath) {
      const found = this.findTarget(robot, targetPath);
      if ('error' in found) return JSON.stringify({ error: found.error, ...this.tierBlock() });
      target = found;
      const t = found.target;
      if (!t.hasReplayAngles(6)) {
        return JSON.stringify({
          error: `IKTarget "${t.node.name}" carries no usable AxisPos, so there is no joint vector to verify.`,
          code: IK_PROBLEM_CODES.targetNoAngles,
          ...this.tierBlock(),
        });
      }
      angles = t.AxisPos.slice(0, 6);
      source = 'target-axispos';
    } else {
      angles = robot.getAxisDrives().map((d: RVDrive) => d.currentPosition);
      source = 'current-drive-positions';
      while (angles.length < 6) angles.push(0);
    }

    robot.node.updateWorldMatrix(true, false);
    const fk = chainFk(chain, angles);

    // The reference pose: the target node when there is one, otherwise the TCP
    // node — in the CHAIN frame, named, never guessed.
    const referenceNode = target?.node ?? robot.getTcpNode();
    let reference: { pos: Vec3; quat: Quat } | null = null;
    if (referenceNode) {
      const p: Vec3 = [0, 0, 0];
      const q: Quat = [0, 0, 0, 1];
      targetPoseInBase(robot.node.matrixWorld, referenceNode.matrixWorld, p, q, 'chain');
      reference = { pos: p, quat: q };
    }

    return JSON.stringify({
      ...this.tierBlock(),
      path: hit.path,
      name: robot.node.name,
      wristType: robot.WristType,
      anglesDeg: angles.map(deg2),
      anglesSource: source,
      frame: 'chain',
      frameNote: 'Poses are robot-local in the glTF/chain frame (IKSolveFrame "chain"). The Unity-frame pendant '
        + 'is reached through the named mirror in rv-coordinate-utils.ts, never by sign-flipping by hand.',
      tcpFromFk: { pos: pos3(fk.tcp.pos), quat: fk.tcp.quat.map((v) => m4(v)) },
      flangeFromFk: { pos: pos3(fk.flange.pos), quat: fk.flange.quat.map((v) => m4(v)) },
      axisFrames: fk.frames.map((f) => ({ axis: f.axis, pos: pos3(f.pos) })),
      reference: reference
        ? {
          node: referenceNode?.name ?? null,
          kind: target ? 'IKTarget' : 'TCP node',
          pos: pos3(reference.pos),
          quat: reference.quat.map((v) => m4(v)),
        }
        : null,
      positionErrorMm: reference ? Math.round(positionErrorMm(fk.tcp.pos, reference.pos) * 100) / 100 : null,
      orientationErrorDeg: reference ? Math.round(orientationErrorDeg(fk.tcp.quat, reference.quat) * 100) / 100 : null,
      toolLengthM: m4(Math.sqrt(
        chain.tcpLocalOffset[0] ** 2 + chain.tcpLocalOffset[1] ** 2 + chain.tcpLocalOffset[2] ** 2,
      )),
      problems: this.problemsFor(hit.path),
    });
  }

  /** Find an IKTarget of this robot by path or name. */
  private findTarget(
    robot: RVRobotIK, want: string,
  ): { name: string; path: string | null; node: Object3D; target: import('../../core/engine/rv-ik-target').RVIKTarget } | { error: string } {
    const registry = this.viewer?.registry;
    const all = robot.getPaths().flatMap((p: RVIKPath) => [...p.targets]);
    const trimmed = want.trim();
    const matches = all.filter((t) => {
      const p = registry?.getPathForNode(t.node) ?? null;
      return p === trimmed || t.node.name === trimmed || (p?.endsWith(`/${trimmed}`) ?? false);
    });
    if (matches.length === 1) {
      const t = matches[0];
      return { name: t.node.name, path: registry?.getPathForNode(t.node) ?? null, node: t.node, target: t };
    }
    if (matches.length > 1) {
      return { error: `"${want}" matches ${matches.length} IKTargets of this robot — pass the full path.` };
    }
    return {
      error: `No IKTarget "${want}" under this robot. Available: `
        + (all.map((t) => t.node.name).join(', ') || '(none — this robot has no IK path with targets)'),
    };
  }

  // ─── Phase 2 — rigging (F5, F6) ────────────────────────────────────────

  async queryRigDiagnose(
    path: string,
  ): Promise<string> {
    const registry = this.viewer?.registry;
    if (!registry) return JSON.stringify({ error: 'No model is loaded.' });
    const root = registry.getNode(path);
    if (!root) return JSON.stringify({ error: `No node at "${path}". Use web_node_find to locate the robot root.` });

    const derivation = deriveSerialAxisChain(root, allDrivesUnder(registry, root));
    const existing = registry.getAll<RVRobotIK>('RobotIK').find((r) => r.instance.node === root)?.instance ?? null;

    // The chain to measure: the robot's own when it is already rigged (so the
    // diagnosis and the solver cannot disagree), otherwise one built from the
    // derived axes through a temporary rig — see `chainFromDerivation`.
    const chain = existing?.getJointChain() ?? chainFromDerivation(root, derivation);

    return JSON.stringify({
      ...this.tierBlock(),
      path,
      name: root.name,
      alreadyRigged: existing !== null,
      ...this.derivationReport(derivation, chain, existing),
      disclaimer: RIG_DISCLAIMER,
    });
  }

  /** The rig itself — the body of `ik.robot.rig`. JSON, `{error}` on refusal. */
  async rigRobot(path: string, wristType?: string, elbowInUnityX?: boolean): Promise<string> {
    const viewer = this.viewer;
    const registry = viewer?.registry;
    if (!viewer || !registry) return JSON.stringify({ error: 'No model is loaded.' });
    const root = registry.getNode(path);
    if (!root) return JSON.stringify({ error: `No node at "${path}". Use web_node_find to locate the robot root.` });

    const wantWrist = (wristType ?? '').trim();
    if (wantWrist && wantWrist !== 'Spherical' && wantWrist !== 'NonSpherical') {
      return JSON.stringify({ error: `wristType must be "Spherical" or "NonSpherical", not "${wristType}".` });
    }

    const derivation = deriveSerialAxisChain(root, allDrivesUnder(registry, root));
    if (derivation.failure) {
      return JSON.stringify({
        error: derivation.failure,
        code: IK_PROBLEM_CODES.chainUnresolved,
        path,
        rotaryDrives: derivation.rotaryCandidates.map((n) => n.name),
        otherDrives: derivation.nonRotaryCandidates.map((n) => n.name),
        hint: 'web_query("ik.robot.rigDiagnose", {path}) shows the same derivation read-only, with every measurement.',
        ...this.tierBlock(),
      });
    }

    const chain = chainFromDerivation(root, derivation);
    if (!chain) {
      return JSON.stringify({
        error: 'The six axes were found but no joint chain could be derived from them (a non-serial nesting, or a '
          + 'node without a parent). web_query("ik.robot.rigDiagnose", {path}) names the step that failed.',
        code: IK_PROBLEM_CODES.chainUnresolved,
        path,
        ...this.tierBlock(),
      });
    }

    const geom = chainGeometry(chain);
    const measured = measureWristType(geom);
    const wrist: WristVerdict = wantWrist
      ? {
        wristType: wantWrist as 'Spherical' | 'NonSpherical',
        offsetMm: measured.offsetMm,
        evidence: `Caller override: ${wantWrist}. The MEASUREMENT says ${measured.wristType} — ${measured.evidence}`,
      }
      : measured;
    const estimate = estimateOpwFromChain(chain, elbowInUnityX);

    const fields = buildRobotIkRigFields(registry, derivation, estimate, wrist);
    if ('error' in fields) return JSON.stringify({ error: fields.error, path, ...this.tierBlock() });

    // ONE write path: the extras editor's own per-field write, which is where
    // `web_execute("component.setFields", …)` lands too — so a rig is persisted exactly like an
    // inspector edit and saved by web_document_save / web_editor_save. The
    // readonly guard of `updateOverlayField` is why this does not go through it:
    // `WristType` and `ElbowInUnityX` are display-readonly by schema (nobody
    // should hand-type them) and this tool MEASURED them.
    const written = await this.writeRigFields(path, { ...fields } as unknown as Record<string, unknown>);
    if ('error' in written) return JSON.stringify({ error: written.error, path, ...this.tierBlock() });

    // Read the rig BACK off the live scene. A rig reported without this is a
    // claim; with it, it is a measurement (the house rule `web_editor_set_field`
    // states: ok only after the value came back from the live scene).
    const live = registry.getAll<RVRobotIK>('RobotIK').find((r) => r.instance.node === root)?.instance ?? null;
    const liveAxes = live?.getAxisDrives().length ?? 0;
    const liveChain = live?.getJointChain() ?? null;
    const verified = live !== null && liveAxes === 6 && liveChain !== null;

    return JSON.stringify({
      ok: verified,
      path,
      name: root.name,
      ...this.tierBlock(),
      verified,
      ...(verified ? {} : {
        warning: 'The RobotIK component was written but did not come back from the live scene as a complete rig '
          + '(six axes and a derivable chain). Read web_query("ik.robot.rigDiagnose", {path}) and the problems below before using it.',
      }),
      rig: {
        axes: derivation.axes.map((d, i) => ({ index: i, name: d.node.name, path: registry.getPathForNode(d.node), direction: d.Direction })),
        tcp: derivation.tcp ? { name: derivation.tcp.name, path: registry.getPathForNode(derivation.tcp), identifiedBy: derivation.tcpReason } : null,
        wristType: wrist.wristType,
        wristOverridden: wantWrist.length > 0,
        elbowInUnityX: estimate.params.elbowInUnityX,
        toolOffset: pos3(estimate.toolOffset),
      },
      wristMeasurement: { offsetMm: Math.round(measured.offsetMm * 10) / 10, verdict: measured.wristType, evidence: wrist.evidence },
      opw: this.opwReport(estimate),
      liveReadback: {
        componentPresent: live !== null,
        axesResolved: liveAxes,
        chainDerived: liveChain !== null,
        tcpResolved: live?.getTcpNode() !== null,
        opwUsable: live?.getOpwParams() !== null,
      },
      problems: this.problemsFor(path),
      tierVerdict: this.tierVerdict(wrist.wristType),
      nextStep: 'web_query("ik.robot.verifyFk", {path}) measures this rig against the scene; web_query("ik.robot.chain", {path}) prints it. '
        + 'Save it with web_document_save (or web_editor_save inside the asset editor) — an unsaved rig is lost on a scene change.',
      disclaimer: RIG_DISCLAIMER,
    });
  }

  /** The OPW block of an answer: numbers, provenance per field, and the verdict. */
  private opwReport(estimate: OpwEstimate): Record<string, unknown> {
    const p = estimate.params;
    return {
      confidence: estimate.confidence,
      unrepresentableOffsetMm: Math.round(estimate.unrepresentableOffsetMm * 10) / 10,
      params: { a1: m4(p.a1), a2: m4(p.a2), b: m4(p.b), c1: m4(p.c1), c2: m4(p.c2), c3: m4(p.c3), c4: m4(p.c4) },
      sources: estimate.sources,
      measurements: estimate.measurements.map((m) => ({
        name: m.name, value: m.unit === 'm' ? m4(m.value) : Math.round(m.value * 100) / 100, unit: m.unit, note: m.note,
      })),
      modelAssumptions: estimate.assumptions.map((m) => ({
        name: m.name, deviation: Math.round(m.value * 1000) / 1000, unit: m.unit, note: m.note,
      })),
      summary: estimate.summary,
    };
  }

  /** The derivation half shared by `_rig_diagnose` and the failure answers. */
  private derivationReport(
    derivation: SerialChainDerivation, chain: JointChainParams | null, existing: RVRobotIK | null,
  ): Record<string, unknown> {
    const registry = this.viewer?.registry;
    const geom = chain ? chainGeometry(chain) : null;
    const wrist = geom ? measureWristType(geom) : null;
    const estimate = chain ? estimateOpwFromChain(chain) : null;
    return {
      chainDerivable: chain !== null,
      derivation: {
        failure: derivation.failure,
        axes: derivation.axes.map((d, i) => ({
          index: i, name: d.node.name, path: registry?.getPathForNode(d.node) ?? null,
          direction: d.Direction, kind: driveKindOf(d.Direction),
        })),
        tcp: derivation.tcp
          ? { name: derivation.tcp.name, path: registry?.getPathForNode(derivation.tcp) ?? null, identifiedBy: derivation.tcpReason }
          : null,
        rotaryDrives: derivation.rotaryCandidates.map((n) => n.name),
        otherDrives: derivation.nonRotaryCandidates.map((n) => n.name),
      },
      wristMeasurement: wrist
        ? { offsetMm: Math.round(wrist.offsetMm * 10) / 10, verdict: wrist.wristType, evidence: wrist.evidence }
        : null,
      opw: estimate ? this.opwReport(estimate) : null,
      currentRig: existing
        ? {
          wristType: existing.WristType,
          elbowInUnityX: existing.ElbowInUnityX,
          axesResolved: existing.getAxisDrives().length,
          tcpResolved: existing.getTcpNode() !== null,
          opwUsable: existing.getOpwParams() !== null,
          opwParams: existing.getOpwParams(),
        }
        : null,
      tierVerdict: this.tierVerdict(wrist?.wristType ?? existing?.WristType ?? 'Spherical'),
    };
  }

  /**
   * Write the rig onto the node and bring the live component up.
   *
   * Two steps, because they answer two questions. The extras editor's
   * `applyFieldToScene` + the active edit target make the values DURABLE (the
   * same route `web_execute("component.setFields", …)` takes, so one save verb covers both);
   * `constructComponentOnNode` makes them LIVE in this session, which is what
   * lets the read-back below be a measurement instead of an echo.
   */
  private async writeRigFields(
    nodePath: string, fields: Record<string, unknown>,
  ): Promise<{ ok: true } | { error: string }> {
    const viewer = this.viewer;
    const node = viewer?.registry?.getNode(nodePath);
    if (!viewer || !node) return { error: `No node at "${nodePath}".` };

    // The extras stamp first — one clone-on-write, so memoised inspector and
    // hierarchy readers see a new object (the convention of `_addComponentWithFields`).
    const ud = node.userData as Record<string, unknown>;
    const rv = { ...(ud['realvirtual'] as Record<string, unknown> | undefined) };
    rv['RobotIK'] = { ...fields };
    ud['realvirtual'] = rv;

    // Durability through the active edit target, field by field — the shape
    // `setField` ops have. A target that is unavailable (pre-boot, a test
    // viewer) leaves the extras stamp in place and the rig live but unsaved,
    // which the answer's `nextStep` already tells the caller to fix.
    const { getActiveEditTarget } = await import('../../core/hmi/rv-edit-target');
    const target = getActiveEditTarget();
    if (target.available) {
      try {
        await target.withTransaction('Rig robot (RobotIK)', async () => {
          for (const [field, value] of Object.entries(fields)) {
            target.setField(nodePath, 'RobotIK', field, value, undefined);
          }
        });
      } catch (e) {
        return { error: `The rig could not be persisted: ${e instanceof Error ? e.message : String(e)}` };
      }
    }

    // Live instance. `constructComponentOnNode` is the ONE construction path
    // outside the loader (it is what the editor's addComponent executor uses).
    try {
      const [{ constructComponentOnNode }, { buildInitContext }] = await Promise.all([
        import('../../core/engine/rv-scene-loader'),
        import('../../core/engine/rv-init-context'),
      ]);
      const { registry, signalStore, transportManager } = viewer;
      if (registry && signalStore && transportManager) {
        constructComponentOnNode(
          buildInitContext({ registry, signalStore, transportManager, scene: viewer.scene, events: viewer }),
          node, 'RobotIK', { ...fields },
        );
      }
    } catch (e) {
      return { error: `The rig was written but the live component could not be constructed: ${e instanceof Error ? e.message : String(e)}` };
    }
    viewer.markRenderDirty();
    return { ok: true };
  }

  // ─── Phase 3 — paths and waypoints (F8-F13) ────────────────────────────

  /** The path creation itself — the body of `ik.path.create`. JSON, `{error}` on refusal. */
  async createPath(
    robotPath?: string, name?: string, loopPath?: boolean, speedOverride?: number,
  ): Promise<string> {
    const hit = this.robot(robotPath);
    if ('error' in hit) return JSON.stringify({ error: hit.error, ...this.tierBlock() });
    const registry = this.viewer?.registry;
    if (!registry) return JSON.stringify({ error: 'No model is loaded.' });

    const route = await this.editRoute();
    if ('error' in route) return JSON.stringify({ error: route.error, ...this.tierBlock() });

    const speed = Number(speedOverride);
    const leaf = uniqueChildName(hit.robot.node, (name ?? '').trim() || 'IKPath');
    const spec: RuntimeNodeSpec = {
      parentPath: hit.path, name: leaf,
      position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1],
      components: {
        IKPath: {
          Path: [],
          LoopPath: loopPath === true,
          SpeedOverride: Number.isFinite(speed) && speed > 0 ? speed : 1,
          StartPath: false, DrawPath: true, DrawTargets: true, SetNewTCP: false,
        },
      },
    };
    const nodePath = `${hit.path}/${leaf}`;
    const committed = await this.commit(route, 'Create IK path', [{ kind: 'addNode', nodePath, spec }]);
    if ('error' in committed) return JSON.stringify({ error: committed.error, ...this.tierBlock() });

    // Read it back off the live scene, the way the rig tool does: the question
    // is not "was an op accepted" but "does the robot see a path".
    const live = hit.robot.getPaths().find((p: RVIKPath) => this.viewer?.registry?.getPathForNode(p.node) === nodePath) ?? null;
    return JSON.stringify({
      ok: live !== null,
      ...this.tierBlock(),
      path: nodePath,
      name: leaf,
      robot: hit.path,
      boundToRobot: live !== null,
      ...(live ? {} : {
        warning: 'The IKPath node was created but the robot does not list it. That happens when the node did not '
          + 'land inside the robot\'s subtree — check with web_query("ik.robot.list", {}).',
      }),
      targets: live?.targets.length ?? 0,
      axesAvailable: hit.robot.getAxisDrives().length,
      persistence: committed.persistence,
      ...persistenceNote(committed.persistence),
      nextStep: 'ik.target.add(pathPath) adds the first waypoint at the robot\'s current TCP pose; '
        + 'web_query("ik.path.inspect", {pathPath}) lists what is there.',
    });
  }

  async queryPathInspect(
    pathPath?: string,
  ): Promise<string> {
    const found = this.findPath(pathPath);
    if ('error' in found) return JSON.stringify({ error: found.error, ...this.tierBlock() });
    const { ikPath, robot } = found;
    const chain = robot.getJointChain();
    robot.node.updateWorldMatrix(true, false);

    return JSON.stringify({
      ...this.tierBlock(),
      path: found.path,
      name: ikPath.node.name,
      robot: found.robotPath,
      wristType: robot.WristType,
      solveFrame: solveFrameFor(robot.WristType, chain),
      loopPath: ikPath.LoopPath,
      speedOverride: ikPath.SpeedOverride,
      pathIsActive: ikPath.PathIsActive,
      storedRefs: rawPathArray(ikPath.node).length,
      targetCount: ikPath.targets.length,
      targets: ikPath.targets.map((t, i) => this.targetRow(t, i, robot, chain)),
      problems: this.problemsFor(found.robotPath).concat(
        ikPath.targets.flatMap((t) => this.problemsFor(this.viewer?.registry?.getPathForNode(t.node) ?? '')),
      ),
      tierVerdict: this.tierVerdict(robot.WristType),
    });
  }

  /** The waypoint creation itself — the body of `ik.target.add`. JSON, `{error}` on refusal. */
  async addTarget(
    pathPath?: string, positionJson?: string, rotationJson?: string, index?: number,
    name?: string, fieldsJson?: string, allowUnreachable?: boolean,
  ): Promise<string> {
    const found = this.findPath(pathPath);
    if ('error' in found) return JSON.stringify({ error: found.error, ...this.tierBlock() });
    const { ikPath, robot } = found;
    const registry = this.viewer?.registry;
    if (!registry) return JSON.stringify({ error: 'No model is loaded.' });

    const route = await this.editRoute();
    if ('error' in route) return JSON.stringify({ error: route.error, ...this.tierBlock() });

    const fields = parseTargetFields(fieldsJson);
    if ('error' in fields) return JSON.stringify({ error: fields.error, ...this.tierBlock() });

    // The reference pose: the robot's current TCP, so "add a waypoint here" is
    // always a reachable default (the robot IS at that pose).
    const anchor = this.currentToolWorld(robot);
    if (!anchor) {
      return JSON.stringify({
        error: 'The robot has neither a TCP node nor six axis nodes, so there is no pose to place a waypoint at. '
          + 'Rig it first with ik.robot.rig.',
        code: IK_PROBLEM_CODES.chainUnresolved,
        ...this.tierBlock(),
      });
    }
    const pose = buildWorldPose(anchor, positionJson, rotationJson);
    if ('error' in pose) return JSON.stringify({ error: pose.error, ...this.tierBlock() });

    // Seed: the LAST waypoint's stored configuration when there is one, so a
    // path keeps one branch instead of hopping between elbow configurations;
    // the current drive angles otherwise.
    const last = ikPath.targets[ikPath.targets.length - 1];
    const seed = last?.hasReplayAngles(IK_AXIS_COUNT) ? last.AxisPos.slice(0, IK_AXIS_COUNT) : currentDriveAngles(robot);
    const solved = solveRobotToWorldPose(robot, pose.world, seed);
    if (!solved.reachable && allowUnreachable !== true) {
      return JSON.stringify({
        ok: false,
        ...this.tierBlock(),
        reachable: false,
        created: false,
        refusal: solved.refusal,
        ...(solved.refusalCode ? { code: solved.refusalCode } : {}),
        solveFrame: solved.solveFrame,
        solver: solved.solver,
        requestedPose: { positionM: pos3(pose.position), eulerDeg: deg3(pose.euler) },
        hint: 'Nothing was created — the waypoint and its joint angles are written together or not at all. '
          + 'Move the pose into the workspace, or pass allowUnreachable=true to store it WITHOUT angles '
          + '(it is then skipped by the replay and listed in the Problems panel).',
        problems: this.problemsFor(found.robotPath),
      });
    }

    const parent = ikPath.node;
    const leaf = uniqueChildName(parent, (name ?? '').trim() || nextTargetName(ikPath));
    const local = localPoseUnder(parent, pose.world);
    const spec: RuntimeNodeSpec = {
      parentPath: found.path, name: leaf,
      position: local.position, quaternion: local.quaternion, scale: local.scale,
      components: { IKTarget: { ...fields.fields, AxisPos: solved.angles ? [...solved.angles] : [] } },
    };
    const nodePath = `${found.path}/${leaf}`;

    const prevRefs = rawPathArray(parent);
    const at = clampIndex(index, prevRefs.length);
    const nextRefs = [...prevRefs];
    nextRefs.splice(at, 0, authoredTargetReference(registry, parent, parent, leaf));

    // addNode BEFORE setField(Path), the other way round from the gizmo's
    // `addPathpoint`, and deliberately: a reference written while its target
    // does not exist yet cannot be pinned, so `setFieldForward`'s
    // `addressedReferenceValue` keeps the path STRING instead of the node's
    // address (plan-769), and the resolve that runs with the write logs a miss
    // for a node that is about to appear. With the node first the reference is
    // addressed properly and nothing transiently dangles. What the gizmo needs
    // the old order for — `addNode`'s executor re-resolving the IKPath — is
    // covered by the re-resolve {@link commit} does after the transaction.
    const committed = await this.commit(route, 'Add IK waypoint', [
      { kind: 'addNode', nodePath, spec },
      { kind: 'setField', nodePath: found.path, componentType: 'IKPath', fieldName: 'Path', value: nextRefs, prev: prevRefs },
    ]);
    if ('error' in committed) return JSON.stringify({ error: committed.error, ...this.tierBlock() });

    const live = ikPath.targets.find((t) => registry.getPathForNode(t.node) === nodePath) ?? null;
    if (live) this.reportTargetAngles(live, ikPath, nodePath);

    return JSON.stringify({
      ok: live !== null,
      ...this.tierBlock(),
      path: nodePath,
      name: leaf,
      ikPath: found.path,
      robot: found.robotPath,
      created: true,
      index: ikPath.targets.findIndex((t) => registry.getPathForNode(t.node) === nodePath),
      ...this.solveReport(solved),
      pose: { positionM: pos3(pose.position), eulerDeg: deg3(pose.euler) },
      axisPos: solved.angles ? solved.angles.map(deg2) : [],
      ...(solved.reachable ? {} : {
        warning: 'Stored WITHOUT joint angles because allowUnreachable was set: the replay skips this waypoint and '
          + 'the Problems panel lists it. It never carries angles from another pose.',
      }),
      ...(live ? {} : { warning: 'The waypoint node was created but the path does not list it — read web_query("ik.path.inspect", {pathPath}).' }),
      targetCount: ikPath.targets.length,
      persistence: committed.persistence,
      ...persistenceNote(committed.persistence),
      problems: this.problemsFor(nodePath),
      nextStep: 'web_query("ik.path.inspect", {pathPath:ikPath}) lists the order; ik.target.solve(path) drives the robot there '
        + 'and lists the alternative configurations.',
    });
  }

  /** The waypoint edit itself — the body of `ik.target.set`. JSON, `{error}` on refusal. */
  async setTarget(
    targetPath: string, positionJson?: string, rotationJson?: string,
    fieldsJson?: string, allowUnreachable?: boolean,
  ): Promise<string> {
    const found = this.findTargetAnywhere(targetPath);
    if ('error' in found) return JSON.stringify({ error: found.error, ...this.tierBlock() });
    const { target, ikPath, robot } = found;
    const registry = this.viewer?.registry;
    if (!registry) return JSON.stringify({ error: 'No model is loaded.' });

    const route = await this.editRoute();
    if ('error' in route) return JSON.stringify({ error: route.error, ...this.tierBlock() });

    const fields = parseTargetFields(fieldsJson);
    if ('error' in fields) return JSON.stringify({ error: fields.error, ...this.tierBlock() });
    const movesPose = positionJson !== undefined || rotationJson !== undefined;
    if (!movesPose && Object.keys(fields.fields).length === 0) {
      return JSON.stringify({
        error: 'Nothing to change: pass positionJson, rotationJson or fieldsJson.',
        ...this.tierBlock(),
      });
    }

    robot.node.updateWorldMatrix(true, false);
    const pose = buildWorldPose(target.node.matrixWorld, positionJson, rotationJson);
    if ('error' in pose) return JSON.stringify({ error: pose.error, ...this.tierBlock() });

    // The seed is the waypoint's OWN stored configuration when it has one, so a
    // small move keeps the branch the replay already drives.
    const seed = target.hasReplayAngles(IK_AXIS_COUNT)
      ? target.AxisPos.slice(0, IK_AXIS_COUNT)
      : currentDriveAngles(robot);
    const solved = movesPose ? solveRobotToWorldPose(robot, pose.world, seed) : null;

    if (solved && !solved.reachable && allowUnreachable !== true) {
      return JSON.stringify({
        ok: false,
        ...this.tierBlock(),
        path: found.path,
        reachable: false,
        changed: false,
        refusal: solved.refusal,
        ...(solved.refusalCode ? { code: solved.refusalCode } : {}),
        solveFrame: solved.solveFrame,
        solver: solved.solver,
        requestedPose: { positionM: pos3(pose.position), eulerDeg: deg3(pose.euler) },
        currentAxisPos: target.AxisPos.map(deg2),
        hint: 'NOTHING was written — not the transform either. This is deliberate: a persisted pose next to the '
          + 'joint angles of the PREVIOUS pose is a silent drift between what the viewer shows and what the replay '
          + 'drives. Pass allowUnreachable=true to move it and EMPTY AxisPos instead.',
        problems: this.problemsFor(found.path),
      });
    }

    const edits: IkEdit[] = [];
    const prevLocal = {
      position: [target.node.position.x, target.node.position.y, target.node.position.z] as [number, number, number],
      quaternion: [target.node.quaternion.x, target.node.quaternion.y, target.node.quaternion.z, target.node.quaternion.w] as [number, number, number, number],
    };
    if (movesPose) {
      const local = localPoseUnder(target.node.parent, pose.world);
      // NO scale in the transform — that is what routes the op to the
      // frozen-safe path and leaves a Unity target's (-1,1,1) mirror alone.
      edits.push({
        kind: 'transformNode', nodePath: found.path,
        transform: { position: local.position, quaternion: local.quaternion },
        prev: prevLocal,
      });
      // The second half of the ONE pair: angles for the new pose, or none.
      const prevAxis = rawExtrasOf(target.node, 'IKTarget')['AxisPos'];
      edits.push({
        kind: 'setField', nodePath: found.path, componentType: 'IKTarget', fieldName: 'AxisPos',
        value: solved?.angles ? [...solved.angles] : [], prev: prevAxis,
      });
    }
    for (const [field, value] of Object.entries(fields.fields)) {
      edits.push({
        kind: 'setField', nodePath: found.path, componentType: 'IKTarget', fieldName: field,
        value, prev: rawExtrasOf(target.node, 'IKTarget')[field],
      });
    }

    const committed = await this.commit(route, 'Edit IK waypoint', edits);
    if ('error' in committed) return JSON.stringify({ error: committed.error, ...this.tierBlock() });
    if (movesPose) this.writeLiveAxisPos(target, solved?.angles ?? null);
    this.reportTargetAngles(target, ikPath, found.path);

    return JSON.stringify({
      ok: true,
      ...this.tierBlock(),
      path: found.path,
      name: target.node.name,
      ikPath: found.ikPathPath,
      robot: found.robotPath,
      changed: true,
      movedPose: movesPose,
      fieldsWritten: Object.keys(fields.fields),
      ...(solved ? this.solveReport(solved) : {}),
      pose: { positionM: pos3(pose.position), eulerDeg: deg3(pose.euler) },
      axisPos: target.AxisPos.map(deg2),
      ...(solved && !solved.reachable ? {
        warning: 'The waypoint was MOVED and its AxisPos EMPTIED because allowUnreachable was set. The replay now '
          + 'skips it and the Problems panel lists it — which is the honest state, not a silent stale angle set.',
      } : {}),
      persistence: committed.persistence,
      ...persistenceNote(committed.persistence),
      problems: this.problemsFor(found.path),
    });
  }

  /** Validate the picker spelling from the target, so two placed robots never cross-wire grips. */
  async setGrip(targetPath: string, gripPath: string | null): Promise<string> {
    const found = this.findTargetAnywhere(targetPath);
    if ('error' in found) return JSON.stringify({ error: found.error, ...this.tierBlock() });
    const registry = this.viewer!.registry!;
    const { target } = found;
    const route = await this.editRoute();
    if ('error' in route) return JSON.stringify({ error: route.error, ...this.tierBlock() });
    const raw = target.node.userData.realvirtual?.IKTarget ?? {};
    const candidates = listReferenceCandidates(cb => registry.forEachNode(cb),
      { kind: 'component', componentType: 'Grip' }, registry.enclosingScope(target.node).root, target.node);
    let ref: ReturnType<typeof makeComponentReference> | null = null;
    let grip = null;
    if (gripPath !== null) {
      const requested = registry.getNode(gripPath) ?? registry.resolvePath(gripPath, target.node);
      const candidate = candidates.find(c => !c.ambiguous &&
        (requested ? registry.resolvePath(c.path, target.node) === requested : c.path === gripPath));
      if (candidate) {
        ref = makeComponentReference(candidate);
        grip = registry.storedComponent<NonNullable<typeof target.gripTarget>>(target.node, ref, 'Grip', {
          // Newly picked paths are legacy inputs until commit converts them to addresses.
          // Keep that fallback inside the target scope, even with identical placed robots.
          legacy: path => {
            const node = registry.resolvePath(path, target.node);
            return node ? registry.componentOn(node, 'Grip') : null;
          },
        });
      }
      if (!candidate || !grip) return JSON.stringify({
        error: `"${gripPath}" is not an addressable Grip in this waypoint's scope. Choose one of the Grip candidates and retry ik.target.setGrip.`,
        candidates: candidates.slice(0, 10), ...this.tierBlock(),
      });
    }
    const committed = await this.commit(route, 'Set waypoint grip', [{
      kind: 'setField', nodePath: found.path, componentType: 'IKTarget', fieldName: 'gripTarget',
      value: ref, prev: raw.gripTarget ?? null,
    }]);
    if ('error' in committed) return JSON.stringify({ error: committed.error, ...this.tierBlock() });
    // References are not schema fields; update the live pointer as well as the saved extras.
    target.refreshGrip(registry);
    return JSON.stringify({ ok: true, ...this.tierBlock(), path: found.path, gripTarget: ref,
      warnings: [
        ...(!target.PickAndPlace ? ['PickAndPlace is false. Use ik.target.set with fieldsJson {"PickAndPlace":true,"Pick":true} to enable picking.'] : []),
        ...(raw.fixer ? ['A fixer reference is also set. gripTarget takes priority; inspect fixer before clearing gripTarget.'] : []),
      ], persistence: committed.persistence, ...persistenceNote(committed.persistence) });
  }

  /** Index addresses the raw reference list: unresolved entries have no runtime target index. */
  async removeTarget(targetPath?: string, pathPath?: string, index?: number): Promise<string> {
    const byTarget = !!targetPath;
    if (byTarget ? pathPath !== undefined || index !== undefined : !pathPath || index === undefined) {
      return JSON.stringify({ error: 'Choose exactly one form: {targetPath} or {pathPath, index} with a raw IKPath.Path index. Inspect the path and retry.', ...this.tierBlock() });
    }
    const found = byTarget ? this.findTargetAnywhere(targetPath!) : this.findPath(pathPath);
    if ('error' in found) return JSON.stringify({ error: found.error, ...this.tierBlock() });
    const { ikPath } = found;
    const registry = this.viewer!.registry!;
    const route = await this.editRoute();
    if ('error' in route) return JSON.stringify({ error: route.error, ...this.tierBlock() });
    const prevRefs = rawPathArray(ikPath.node);
    const target = 'target' in found ? found.target as import('../../core/engine/rv-ik-target').RVIKTarget : null;
    const idx = target ? prevRefs.findIndex(ref => resolveRefNode(registry, ikPath.node, ref) === target.node) : index!;
    if (!Number.isInteger(idx) || idx < 0 || idx >= prevRefs.length) return JSON.stringify({
      error: `The raw index must lie in 0..${prevRefs.length - 1}. Inspect ik.path.inspect and retry with an existing reference.`, ...this.tierBlock(),
    });
    const nextRefs = target ? prevRefs.filter(ref => resolveRefNode(registry, ikPath.node, ref) !== target.node) : prevRefs.filter((_ref, i) => i !== idx);
    // Index-form deletes only the selected reference, even if it resolves to an authored node.
    const wasAdded = !!target && target.node.userData['__rvAdded'] === true;
    const ikPathPath = registry.getPathForNode(ikPath.node)!;
    const edits: IkEdit[] = [{ kind: 'setField', nodePath: ikPathPath, componentType: 'IKPath', fieldName: 'Path', value: nextRefs, prev: prevRefs }];
    if (wasAdded && target) edits.push({ kind: 'removeNode', nodePath: found.path, spec: specFromLiveNode(target.node, found.path) });
    const committed = await this.commit(route, 'Delete IK waypoint', edits);
    if ('error' in committed) return JSON.stringify({ error: committed.error, ...this.tierBlock() });
    ikPath.rebuildTargets(registry);
    if (target) clearRobotIkProblems(found.path);
    return JSON.stringify({ ok: true, ...this.tierBlock(), path: found.path, ikPath: ikPathPath,
      robot: found.robotPath, removedIndex: idx, nodeDeleted: wasAdded, targetCount: ikPath.targets.length,
      ...(wasAdded || !target ? {} : { note: 'The node came from the GLB, so only the path reference was removed. The node itself still exists and can be re-added with ik.target.add after a pose change, or deleted in the asset editor.' }),
      persistence: committed.persistence, ...persistenceNote(committed.persistence) });
  }

  /** The reorder itself — the body of `ik.target.reorder`. JSON, `{error}` on refusal. */
  async reorderTargets(fromIndex: number, toIndex: number, pathPath?: string): Promise<string> {
    const found = this.findPath(pathPath);
    if ('error' in found) return JSON.stringify({ error: found.error, ...this.tierBlock() });
    const { ikPath } = found;

    const route = await this.editRoute();
    if ('error' in route) return JSON.stringify({ error: route.error, ...this.tierBlock() });

    const prevRefs = rawPathArray(ikPath.node);
    const n = ikPath.targets.length;
    if (prevRefs.length !== n) {
      return JSON.stringify({
        error: `IKPath.Path carries ${prevRefs.length} reference(s) but only ${n} of them resolve to an IKTarget. `
          + 'Reordering by index would then move a different waypoint than the one named. Repair the unresolved '
          + 'references first — web_query("ik.path.inspect", {pathPath}) lists both counts.',
        ...this.tierBlock(),
      });
    }
    const from = Math.trunc(Number(fromIndex));
    const to = Math.trunc(Number(toIndex));
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || from >= n || to < 0 || to >= n) {
      return JSON.stringify({
        error: `fromIndex / toIndex must lie in 0..${n - 1} (this path has ${n} waypoint(s)).`,
        ...this.tierBlock(),
      });
    }
    if (from === to) {
      return JSON.stringify({ ok: true, ...this.tierBlock(), path: found.path, moved: false, note: 'fromIndex equals toIndex — nothing to do.' });
    }

    const nextRefs = [...prevRefs];
    const [moved] = nextRefs.splice(from, 1);
    nextRefs.splice(to, 0, moved);
    ikPath.reorderTargets(from, to);

    const committed = await this.commit(route, 'Reorder IK waypoints', [
      { kind: 'setField', nodePath: found.path, componentType: 'IKPath', fieldName: 'Path', value: nextRefs, prev: prevRefs },
    ]);
    if ('error' in committed) return JSON.stringify({ error: committed.error, ...this.tierBlock() });

    const registry = this.viewer?.registry;
    return JSON.stringify({
      ok: true,
      ...this.tierBlock(),
      path: found.path,
      robot: found.robotPath,
      moved: true,
      fromIndex: from,
      toIndex: to,
      order: ikPath.targets.map((t, i) => ({ index: i, name: t.node.name, path: registry?.getPathForNode(t.node) ?? null })),
      persistence: committed.persistence,
      ...persistenceNote(committed.persistence),
    });
  }

  /** The solve itself — the body of `ik.target.solve`. JSON, `{error}` on refusal. */
  async solveTarget(targetPath: string, solutionIndex?: number): Promise<string> {
    const found = this.findTargetAnywhere(targetPath);
    if ('error' in found) return JSON.stringify({ error: found.error, ...this.tierBlock() });
    const { target, ikPath, robot } = found;

    const route = await this.editRoute();
    if ('error' in route) return JSON.stringify({ error: route.error, ...this.tierBlock() });

    robot.node.updateWorldMatrix(true, false);
    const seed = target.hasReplayAngles(IK_AXIS_COUNT)
      ? target.AxisPos.slice(0, IK_AXIS_COUNT)
      : currentDriveAngles(robot);
    const want = solutionIndex === undefined ? undefined : Math.trunc(Number(solutionIndex));
    const solved = solveRobotToWorldPose(robot, target.node.matrixWorld, seed, want);

    if (!solved.reachable) {
      this.reportTargetAngles(target, ikPath, found.path);
      return JSON.stringify({
        ok: false,
        ...this.tierBlock(),
        path: found.path,
        reachable: false,
        applied: false,
        refusal: solved.refusal,
        ...(solved.refusalCode ? { code: solved.refusalCode } : {}),
        solveFrame: solved.solveFrame,
        solver: solved.solver,
        solutionCount: solved.solutions.length,
        axisPos: target.AxisPos.map(deg2),
        hint: 'The robot was not moved and AxisPos was left as it is. Move the waypoint with '
          + 'ik.target.set, or read web_query("ik.robot.chain", {path}) for the joint limits.',
        problems: this.problemsFor(found.path),
      });
    }

    applyAnglesToDrives(robot, solved.angles!);
    const prevAxis = rawExtrasOf(target.node, 'IKTarget')['AxisPos'];
    const committed = await this.commit(route, 'Solve IK waypoint', [
      { kind: 'setField', nodePath: found.path, componentType: 'IKTarget', fieldName: 'AxisPos', value: [...solved.angles!], prev: prevAxis },
    ]);
    if ('error' in committed) return JSON.stringify({ error: committed.error, ...this.tierBlock() });
    this.writeLiveAxisPos(target, solved.angles!);
    this.reportTargetAngles(target, ikPath, found.path);

    // Prove it: forward kinematics of the applied angles against the waypoint.
    const chain = robot.getJointChain();
    const fk = chain ? chainFk(chain, solved.angles!) : null;
    const ref: Vec3 = [0, 0, 0];
    const refQ: Quat = [0, 0, 0, 1];
    targetPoseInBase(robot.node.matrixWorld, target.node.matrixWorld, ref, refQ, 'chain');

    return JSON.stringify({
      ok: true,
      ...this.tierBlock(),
      path: found.path,
      name: target.node.name,
      ikPath: found.ikPathPath,
      robot: found.robotPath,
      reachable: true,
      applied: true,
      ...this.solveReport(solved),
      axisPos: solved.angles!.map(deg2),
      verify: fk
        ? {
          positionErrorMm: Math.round(positionErrorMm(fk.tcp.pos, ref) * 100) / 100,
          orientationErrorDeg: Math.round(orientationErrorDeg(fk.tcp.quat, refQ) * 100) / 100,
          note: 'Forward kinematics of the applied configuration against the waypoint node, in the chain frame — '
            + 'the same measurement web_query("ik.robot.verifyFk", {path}) makes.',
        }
        : null,
      persistence: committed.persistence,
      ...persistenceNote(committed.persistence),
      problems: this.problemsFor(found.path),
    });
  }

  /**
   * The export itself — the body of `ik.program.export` (plan-773 F18/F19).
   *
   * Every `src/core/robot-program/` module is reached through `import()` here
   * and nowhere else in this file, which is what keeps the export core (and
   * each vendor formatter) out of the default load (plan-773 §2.5).
   *
   * The order of the three steps is the order of their cost and of their
   * authority: the vendor ID is validated from the STATIC metadata table (no
   * chunk), then the program is built (which runs the licence gate and the F21
   * check and may refuse), and only a program that survived both loads a
   * formatter.
   */
  async exportProgram(
    vendor: string,
    pathPath?: string,
    axisBased?: boolean,
    includeLinkedPaths?: boolean,
    download?: boolean,
  ): Promise<string> {
    const { ROBOT_VENDORS, isRobotVendorId, loadRobotPostProcessor } =
      await import('../../core/robot-program/rv-robot-vendors');
    const vendorList = Object.values(ROBOT_VENDORS)
      .map((v) => ({ id: v.id, displayName: v.displayName, fileExtension: v.fileExtension, description: v.description }));

    if (!isRobotVendorId(vendor)) {
      return JSON.stringify({
        error: `Unknown vendor "${vendor}".`,
        vendors: vendorList,
        ...this.tierBlock(),
      });
    }
    const info = ROBOT_VENDORS[vendor];

    const found = this.findPath(pathPath);
    if ('error' in found) return JSON.stringify({ error: found.error, vendors: vendorList, ...this.tierBlock() });

    const { ikPathToProgram } = await import('../../core/robot-program/rv-ik-path-to-program');
    const prog = ikPathToProgram(found.ikPath, { includeLinkedPaths: includeLinkedPaths === true });

    const head = {
      ...this.tierBlock(),
      vendorId: info.id,
      vendor: info.displayName,
      axisBased: axisBased !== false,
      path: found.path,
      robot: found.robotPath,
      program: prog.Name,
      waypoints: prog.Instructions.length,
      fkCheck: prog.FkCheck,
      problems: this.problemsFor(found.path),
    };

    // A refusal from the licence gate (E3) or the F21 check: answer it without
    // loading a formatter — there is nothing for one to format.
    if (prog.refusal) {
      return JSON.stringify({ ok: false, ...head, refusal: prog.refusal, warnings: prog.Warnings });
    }

    const pp = await loadRobotPostProcessor(vendor, { axisBased: axisBased !== false });
    const result = pp.emit(prog);
    if (!result.ok) {
      return JSON.stringify({ ok: false, ...head, refusal: result.refusal, warnings: result.warnings });
    }

    let downloaded = false;
    if (download === true) {
      for (const f of result.files) downloadTextFile(f.content, f.fileName);
      downloaded = typeof document !== 'undefined';
    }

    return JSON.stringify({
      ok: true,
      ...head,
      files: result.files,
      anglesSources: countAnglesSources(prog),
      warnings: result.warnings,
      disclaimer: result.disclaimer,
      downloaded,
    });
  }

  // ─── Phase 3 helpers ───────────────────────────────────────────────────

  /** The solve half of an answer — frame, solver and every branch, never just a boolean. */
  private solveReport(solved: IkSolveOutcome): Record<string, unknown> {
    return {
      reachable: solved.reachable,
      solveFrame: solved.solveFrame,
      solver: solved.solver,
      solutionCount: solved.solutions.length,
      selectedSolution: solved.selectedIndex,
      solutions: solved.solutions.map((s, i) => ({ index: i, anglesDeg: s.map(deg2) })),
      // Never silent: the limits are allowed to shrink the choice, but they say
      // so (plan-772 Phase 5). `solutionCount` counts what SURVIVED them.
      ...(solved.limitRejected > 0
        ? {
          limitRejectedSolutions: solved.limitRejected,
          limitRejectedAxes: solved.limitRejectedAxes.map((i) => `A${i + 1}`),
          limitNote: `${solved.limitRejected} geometrically reachable configuration(s) were discarded because a `
            + 'joint limit refuses them in every 360° representation. The solver itself is not given the limits, '
            + 'so this is a rejection and not a search — web_query("ik.robot.chain", {path}) lists the limits.',
        }
        : {}),
    };
  }

  /** One row of a waypoint listing — pose, stored angles, and whether they reach it. */
  private targetRow(
    t: import('../../core/engine/rv-ik-target').RVIKTarget, index: number,
    robot: RVRobotIK, chain: JointChainParams | null,
  ): Record<string, unknown> {
    const registry = this.viewer?.registry;
    const world = t.node.matrixWorld.elements;
    const replayable = t.hasReplayAngles(IK_AXIS_COUNT);
    let reach: { positionErrorMm: number; orientationErrorDeg: number } | null = null;
    if (chain && replayable) {
      const fk = chainFk(chain, t.AxisPos);
      const ref: Vec3 = [0, 0, 0];
      const refQ: Quat = [0, 0, 0, 1];
      targetPoseInBase(robot.node.matrixWorld, t.node.matrixWorld, ref, refQ, 'chain');
      reach = {
        positionErrorMm: Math.round(positionErrorMm(fk.tcp.pos, ref) * 100) / 100,
        orientationErrorDeg: Math.round(orientationErrorDeg(fk.tcp.quat, refQ) * 100) / 100,
      };
    }
    return {
      index,
      name: t.node.name,
      path: registry?.getPathForNode(t.node) ?? null,
      opCreated: (t.node.userData as Record<string, unknown>)['__rvAdded'] === true,
      positionM: pos3([world[12], world[13], world[14]]),
      eulerDeg: deg3(eulerFromMatrix(t.node.matrixWorld)),
      axisPos: t.AxisPos.map(deg2),
      replayable,
      storedAnglesReach: reach,
      interpolation: t.InterpolationToTarget,
      speedToTarget: t.SpeedToTarget,
      linearSpeedToTarget: t.LinearSpeedToTarget,
      enableBlending: t.EnableBlending,
      blendRadius: t.BlendRadius,
      waitForSeconds: t.WaitForSeconds,
      setSignal: t.SetSignal,
      waitForSignal: t.WaitForSignal,
      pickAndPlace: t.PickAndPlace,
    };
  }

  /** Every IKPath of every robot, with the robot it belongs to. */
  private paths(): Array<{ path: string; ikPath: RVIKPath; robot: RVRobotIK; robotPath: string }> {
    const registry = this.viewer?.registry;
    if (!registry) return [];
    return this.robots().flatMap(({ path: robotPath, instance }) =>
      instance.getPaths().map((p: RVIKPath) => ({
        path: registry.getPathForNode(p.node) ?? p.node.name,
        ikPath: p, robot: instance, robotPath,
      })));
  }

  /** Resolve one IKPath by path or name; with no argument, the only one. */
  private findPath(want?: string):
  { path: string; ikPath: RVIKPath; robot: RVRobotIK; robotPath: string } | { error: string } {
    const all = this.paths();
    if (all.length === 0) {
      return {
        error: 'No IKPath in the loaded model. ik.path.create makes one under a rigged robot; '
          + 'web_query("ik.robot.list", {}) shows which robots are there.',
      };
    }
    const trimmed = (want ?? '').trim();
    if (!trimmed) {
      if (all.length === 1) return all[0];
      return { error: `${all.length} IK paths are loaded — pass pathPath. Available: ${all.map((p) => p.path).join(', ')}` };
    }
    const exact = all.find((p) => p.path === trimmed);
    if (exact) return exact;
    const byName = all.filter((p) => p.ikPath.node.name === trimmed || p.path.endsWith(`/${trimmed}`));
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) return { error: `"${want}" matches ${byName.length} IK paths: ${byName.map((p) => p.path).join(', ')}` };
    return { error: `No IKPath at "${want}". Available: ${all.map((p) => p.path).join(', ')}` };
  }

  /** Resolve one IKTarget across every robot, with its path and robot. */
  private findTargetAnywhere(want: string): {
    path: string; target: import('../../core/engine/rv-ik-target').RVIKTarget;
    ikPath: RVIKPath; ikPathPath: string; robot: RVRobotIK; robotPath: string;
  } | { error: string } {
    const registry = this.viewer?.registry;
    if (!registry) return { error: 'No model is loaded.' };
    const rows = this.paths().flatMap((p) => p.ikPath.targets.map((t) => ({
      path: registry.getPathForNode(t.node) ?? t.node.name,
      target: t, ikPath: p.ikPath, ikPathPath: p.path, robot: p.robot, robotPath: p.robotPath,
    })));
    if (rows.length === 0) {
      return { error: 'No IKTarget in the loaded model. ik.target.add creates one on an IK path.' };
    }
    const trimmed = want.trim();
    const exact = rows.find((r) => r.path === trimmed);
    if (exact) return exact;
    const byName = rows.filter((r) => r.target.node.name === trimmed || r.path.endsWith(`/${trimmed}`));
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) return { error: `"${want}" matches ${byName.length} IKTargets — pass the full path: ${byName.map((r) => r.path).join(', ')}` };
    return { error: `No IKTarget at "${want}". Available: ${rows.map((r) => r.path).join(', ')}` };
  }

  /** The pose a new waypoint defaults to: the robot's TCP, else its axis-6 flange. */
  /**
   * plan-641 M4 for `ik.path.create` / `ik.target.add` / `ik.target.reorder`:
   * turn "the only robot", "the only path", "the current TCP" and "append" into
   * EXPLICIT values, read off the scene the call started against.
   *
   * A recorded line has to do the same thing on replay whatever is loaded and
   * wherever the robot happens to stand, so the three implicit inputs of this
   * family are frozen here. Never throws and never guesses: when the scene
   * cannot answer (no robot, an ambiguous name, no TCP) the args come back
   * unchanged and the routine refuses with its own sentence.
   */
  resolveImplicitPath(want?: string): string | undefined {
    const found = this.findPath(want);
    return 'error' in found ? want : found.path;
  }

  async moveRobotTcp(args: MoveTcpArgs): Promise<Record<string, unknown>> {
    const hit = this.robot(args.path);
    if ('error' in hit) return { error: hit.error, ...this.tierBlock() };
    const { getActivePersistenceTarget } = await import('../../core/hmi/rv-edit-target');
    if (getActivePersistenceTarget() === 'asset') return { error: 'The asset editor is open. Close it with web_editor_close before moving the robot.', ...this.tierBlock() };
    if (this.viewer?.registry?.getAll<RVIKPath>('IKPath').some(p => p.instance.robot === hit.robot && p.instance.PathIsActive)) {
      return { kind: 'path-running', applied: false, error: 'A path of this robot is running. Stop it with ik.path.stop before moving the TCP.', ...this.tierBlock() };
    }
    return { ...moveTcp(hit.robot, args), ...this.tierBlock() };
  }

  queryCheckPath(pathPath?: string): Record<string, unknown> {
    const hit = this.findPath(pathPath);
    if ('error' in hit) return { error: hit.error, ...this.tierBlock() };
    return { ...checkPath(hit.ikPath, this.viewer!.loop.fixedTimeStep), ...this.tierBlock() };
  }

  /** Replay is transient: validate the scene route without opening an undo transaction. */
  async runOrStopPath(pathPath?: string, timeoutMs?: number, signal?: AbortSignal, stop = false): Promise<Record<string, unknown>> {
    const found = this.findPath(pathPath);
    if ('error' in found) return { error: found.error, ...this.tierBlock() };
    const { ikPath } = found;
    if (stop) {
      const wasActive = ikPath.PathIsActive;
      ikPath.cancel();
      return { wasActive, ...this.tierBlock() };
    }
    const { getActivePersistenceTarget } = await import('../../core/hmi/rv-edit-target');
    if (getActivePersistenceTarget() === 'asset') return {
      error: 'The asset editor is open. Close it with web_editor_close and run the path in the viewer.', ...this.tierBlock(),
    };
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 590_000)) return {
      error: 'timeoutMs must be greater than zero and at most 590000. Pass a valid wall-clock limit.', ...this.tierBlock(),
    };
    if (ikPath.PathIsActive) return {
      error: 'The path is already running. Stop it with ik.path.stop before starting another run.', kind: 'already-running', ...this.tierBlock(),
    };
    const viewer = this.viewer!;
    if (!viewer.currentModelRoot || !viewer.runtime.isAttached || viewer.isSimulationPaused) return {
      error: 'The simulation is not advancing. Use sim.playPause to resume the simulation before ik.path.run.', ...this.tierBlock(),
    };
    if (!ikPath.targets.length) return {
      error: 'The path has no targets. Add a waypoint with ik.target.add before running it.', ...this.tierBlock(),
    };
    if (!ikPath.axesAvailable) return {
      error: 'The path has no resolved axes. Use ik.robot.rigDiagnose and repair the rig before running it.', ...this.tierBlock(),
    };
    return { ...await runPath(viewer, ikPath, { timeoutMs, signal }), ...this.tierBlock() };
  }

  /** The robot's own path, so a recorded `ik.path.create` names it. */
  resolveImplicitRobot(want?: string): string | undefined {
    const hit = this.robot(want);
    return 'error' in hit ? want : hit.path;
  }

  /** The current TCP pose of the path's robot as `[positionJson, rotationJson]`, or nulls. */
  resolveCurrentTcpPose(pathPath?: string): [string, string] | null {
    const found = this.findPath(pathPath);
    if ('error' in found) return null;
    const anchor = this.currentToolWorld(found.robot);
    if (!anchor) return null;
    const p = new Vector3();
    const q = new Quaternion();
    const s = new Vector3();
    anchor.decompose(p, q, s);
    return [JSON.stringify([p.x, p.y, p.z]), JSON.stringify(eulerFromMatrix(anchor))];
  }

  /** The append index a recorded `ik.target.add` has to name explicitly. */
  resolveAppendIndex(pathPath?: string): number | undefined {
    const found = this.findPath(pathPath);
    return 'error' in found ? undefined : found.ikPath.targets.length;
  }

  /** The waypoint name `ik.target.add` would pick — explicit, so a replay names it too. */
  resolveTargetName(pathPath?: string): string | undefined {
    const found = this.findPath(pathPath);
    return 'error' in found ? undefined : nextTargetName(found.ikPath);
  }

  private currentToolWorld(robot: RVRobotIK): Matrix4 | null {
    robot.node.updateWorldMatrix(true, false);
    const tcp = robot.getTcpNode();
    if (tcp) return tcp.matrixWorld;
    const axes = robot.getAxisDrives();
    const last = axes[axes.length - 1]?.node;
    return last ? last.matrixWorld : null;
  }

  /**
   * The live half of the pose-and-angles pair, and the "does it replay" entry.
   *
   * Both live in `rv-ik-authoring.ts` since plan-772 Phase 5 / plan-773 Phase 4,
   * because the gizmo needs the exact same two writes and two implementations of
   * the AxisPos instance write would be a way to drift. These thin wrappers keep
   * the call sites below reading as before.
   */
  private writeLiveAxisPos(
    target: import('../../core/engine/rv-ik-target').RVIKTarget, angles: readonly number[] | null,
  ): void {
    writeLiveAxisPos(target, angles);
  }

  private reportTargetAngles(
    target: import('../../core/engine/rv-ik-target').RVIKTarget, ikPath: RVIKPath, nodePath: string,
  ): void {
    reportTargetReplayAngles(target, ikPath, nodePath);
  }

  /**
   * Where a Phase-3 write goes, decided once.
   *
   * Creating and moving waypoints is node work (`addNode` / `removeNode` /
   * `transformNode`), and those ops exist in the SCENE op log. The asset
   * editor's document has its own op set and its `addComponent` route refuses
   * types that are not `authorable` — which `IKTarget` deliberately is not
   * (decision E6). So rather than half-write into the editor, this family
   * refuses there and says where to go. Without a store at all (pre-boot, a
   * test viewer) the edit is applied LIVE and the answer says `persistence:
   * "none"` — the same honesty `ik.robot.rig` keeps.
   */
  private async editRoute(): Promise<{ store: SceneStore } | { live: true } | { error: string }> {
    const { getActivePersistenceTarget } = await import('../../core/hmi/rv-edit-target');
    if (getActivePersistenceTarget() === 'asset') {
      return {
        error: 'The asset editor is open, and IK path authoring writes into the document open in the planner (node ops in the '
          + 'scene op log) — not into the editor document, whose add-component route refuses IKTarget because it is '
          + 'deliberately not authorable. Close the editor with web_editor_close and author the path in the viewer, '
          + 'or move the waypoints with the quick-edit popover.',
      };
    }
    const { getSceneStore } = await import('../../core/hmi/scene/scene-store-singleton');
    const store = getSceneStore();
    return store ? { store } : { live: true };
  }

  /**
   * Apply a list of edits as ONE undoable step, or live when there is no store.
   *
   * The op route is the authority: its executors write the live extras, re-apply
   * the schema and re-resolve every IKPath, so the read-back below is the scene
   * answering rather than this file echoing. The live route exists for the
   * no-store case only and does the same four things by hand.
   */
  private async commit(
    route: { store: SceneStore } | { live: true }, label: string, edits: readonly IkEdit[],
  ): Promise<{ persistence: 'scene' | 'none' } | { error: string }> {
    const viewer = this.viewer;
    if (!viewer) return { error: 'No viewer.' };
    try {
      if ('store' in route) {
        const { freshOpId } = await import('../../core/hmi/scene/rv-scene-edits');
        await route.store.withTransaction(label, async () => {
          for (const edit of edits) {
            // Built as a typed union member, NOT spread-and-cast: a cast would
            // let a field name or a payload shape drift away from the executor
            // that has to read it, and this is exactly the place where that
            // would show up only at runtime.
            const header = { id: freshOpId(), ts: Date.now(), schemaV: 1 as const };
            let op: RvScenePrimitiveOp;
            switch (edit.kind) {
              case 'addNode':
                op = { ...header, kind: 'addNode', nodePath: edit.nodePath, spec: edit.spec };
                break;
              case 'removeNode':
                op = { ...header, kind: 'removeNode', nodePath: edit.nodePath, spec: edit.spec };
                break;
              case 'setField':
                op = {
                  ...header, kind: 'setField', nodePath: edit.nodePath,
                  componentType: edit.componentType, fieldName: edit.fieldName,
                  value: edit.value, prev: edit.prev,
                };
                break;
              default:
                op = {
                  ...header, kind: 'transformNode', nodePath: edit.nodePath,
                  transform: edit.transform, prev: edit.prev,
                };
                break;
            }
            await route.store.applyOp(op);
          }
        });
      } else {
        // The same four things the executors do, by hand — including the two
        // halves of a field write: the extras (clone-on-write, so memoised
        // inspector rows re-render) and the live instance through the schema.
        const [{ applyLocalPose }, { writeUserDataField, reapplySchemaForComponent }] = await Promise.all([
          import('../../core/engine/rv-node-transform'),
          import('../../core/hmi/scene/rv-scene-executors'),
        ]);
        for (const edit of edits) {
          if (edit.kind === 'addNode') {
            if (!viewer.createComponentNode(edit.spec)) return { error: `The node "${edit.nodePath}" could not be created (parent missing).` };
          } else if (edit.kind === 'removeNode') {
            viewer.removeComponentNode(edit.nodePath);
          } else if (edit.kind === 'setField') {
            writeUserDataField(viewer, edit.nodePath, edit.componentType, edit.fieldName, edit.value);
            reapplySchemaForComponent(viewer, edit.nodePath, edit.componentType);
          } else {
            const node = viewer.registry?.getNode(edit.nodePath);
            if (node) applyLocalPose(node, edit.transform.position, edit.transform.quaternion);
          }
        }
        viewer.rebuildIKPaths?.();
      }
    } catch (e) {
      return { error: `The edit could not be applied: ${e instanceof Error ? e.message : String(e)}` };
    }
    viewer.rebuildIKPaths?.();
    viewer.markRenderDirty();
    return { persistence: 'store' in route ? 'scene' : 'none' };
  }
}

/** The four edits Phase 3 makes, in the shape the scene ops have. */
type IkEdit =
  | { kind: 'addNode'; nodePath: string; spec: RuntimeNodeSpec }
  | { kind: 'removeNode'; nodePath: string; spec: RuntimeNodeSpec }
  | { kind: 'setField'; nodePath: string; componentType: string; fieldName: string; value: unknown; prev: unknown }
  | {
    kind: 'transformNode'; nodePath: string;
    transform: { position: [number, number, number]; quaternion: [number, number, number, number] };
    prev: { position: [number, number, number]; quaternion: [number, number, number, number] };
  };

/** Degrees, two decimals — the precision a joint angle is reported with. */
function deg3(v: readonly number[]): [number, number, number] {
  return [deg2(v[0] ?? 0), deg2(v[1] ?? 0), deg2(v[2] ?? 0)];
}

/** What `persistence` means for the caller, in a sentence. */
function persistenceNote(p: 'scene' | 'none'): Record<string, string> {
  return p === 'scene'
    ? { persistenceNote: 'Booked into the scene op log as one undo step — editor.undo takes it back, and the draft autosave keeps it.' }
    : { persistenceNote: 'Applied LIVE only: no document is open in the planner in this session, so the change is lost on reload. Nothing was persisted.' };
}

/** The raw extras of one component on a node — the untouched export. */
function rawExtrasOf(node: Object3D, type: string): Record<string, unknown> {
  return ((node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined)?.[type]) ?? {};
}

/** `IKPath.Path` as written, as an array (an absent or malformed field is empty). */
function rawPathArray(ikPathNode: Object3D): unknown[] {
  const raw = rawExtrasOf(ikPathNode, 'IKPath')['Path'];
  return Array.isArray(raw) ? [...raw] : [];
}

/** The node one stored `IKPath.Path` entry names, read the way `RVIKPath` reads it. */
function resolveRefNode(registry: NodeRegistry, referrer: Object3D, ref: unknown): Object3D | null {
  if (!isRef(ref)) return null;
  const stored = storedReferenceValue(ref);
  const direct = registry.storedNode(referrer, stored);
  if (direct) return direct;
  return typeof stored === 'string' ? registry.getNode(stored) : null;
}

/** A child name that is free under `parent` — `Target_3`, `Target_3_2`, … */
function uniqueChildName(parent: Object3D, wanted: string): string {
  const taken = new Set(parent.children.map((c) => c.name));
  if (!taken.has(wanted)) return wanted;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${wanted}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${wanted}_${Date.now().toString(36)}`;
}

/** The next waypoint name of a path: `Target_1`, `Target_2`, … in path order. */
function nextTargetName(ikPath: RVIKPath): string {
  return `Target_${ikPath.targets.length + 1}`;
}

/** An insert position clamped into `0..length`; a missing index appends. */
function clampIndex(index: number | undefined, length: number): number {
  if (index === undefined) return length;
  const i = Math.trunc(Number(index));
  if (!Number.isFinite(i)) return length;
  return Math.max(0, Math.min(i, length));
}

/**
 * The stored reference a new waypoint is written as.
 *
 * The same rule the gizmo's `addPathpoint` follows, and it has two halves that
 * both matter: ASSET-RELATIVE to the IKPath's own reference scope (plan-757
 * D12), so the file works as a document and as a placement; and spelled through
 * the AUTHORED names of the node's existing PARENT plus the new leaf (plan-765
 * F3), because the node does not exist yet when this reference is written —
 * `setField(Path)` runs before `addNode` so the executor's re-resolve finds it.
 */
function authoredTargetReference(
  registry: NodeRegistry, ikPathNode: Object3D, parent: Object3D, leafName: string,
): { type: 'ComponentReference'; path: string } {
  const scope = registry.enclosingScope(ikPathNode);
  const parentAuthored = parent === scope.root ? '' : authoredAssetRelativePath(parent, scope.root);
  const parentPath = registry.getPathForNode(parent) ?? parent.name;
  const path = parentAuthored === null
    ? assetRelativePath(`${parentPath}/${leafName}`, scope)
    : (parentAuthored === '' ? leafName : `${parentAuthored}/${leafName}`);
  return { type: 'ComponentReference', path };
}

/** A removable node's spec, so undo can re-create it (the gizmo's `specFromNode`). */
function specFromLiveNode(node: Object3D, nodePath: string): RuntimeNodeSpec {
  const components = JSON.parse(JSON.stringify((node.userData?.realvirtual ?? {}) as Record<string, unknown>)) as Record<string, Record<string, unknown>>;
  delete (components as Record<string, unknown>)['__rvAdded'];
  return {
    parentPath: nodePath.slice(0, nodePath.lastIndexOf('/')),
    name: node.name,
    position: [node.position.x, node.position.y, node.position.z],
    quaternion: [node.quaternion.x, node.quaternion.y, node.quaternion.z, node.quaternion.w],
    scale: [node.scale.x, node.scale.y, node.scale.z],
    components,
  };
}

/** XYZ-Euler angles of a world matrix, in DEGREES — the unit the quick-edit shows. */
function eulerFromMatrix(m: Matrix4): [number, number, number] {
  const q = new Quaternion();
  const p = new Vector3();
  const s = new Vector3();
  m.decompose(p, q, s);
  const e = new Euler().setFromQuaternion(q, 'XYZ');
  const r = 180 / Math.PI;
  return [e.x * r, e.y * r, e.z * r];
}

/**
 * The world pose a pose argument asks for, starting from `current`.
 *
 * Position in METERS and orientation as XYZ-Euler DEGREES, each optional: an
 * omitted half keeps what `current` has. The composed matrix carries unit
 * scale deliberately — a waypoint's pose is position and rotation (Unity's
 * `RobotIK` reads exactly those two off a target and never its scale), and
 * {@link localPoseUnder} takes the parent's scale back out.
 */
function buildWorldPose(
  current: Matrix4, positionJson?: string, rotationJson?: string,
): { world: Matrix4; position: [number, number, number]; euler: [number, number, number] } | { error: string } {
  const p = new Vector3();
  const q = new Quaternion();
  const s = new Vector3();
  current.decompose(p, q, s);
  let position: [number, number, number] = [p.x, p.y, p.z];
  let euler = eulerFromMatrix(current);

  if (positionJson !== undefined) {
    const v = parseTriple(positionJson, 'positionJson');
    if ('error' in v) return v;
    position = v.value;
  }
  if (rotationJson !== undefined) {
    const v = parseTriple(rotationJson, 'rotationJson');
    if ('error' in v) return v;
    euler = v.value;
  }
  const d = Math.PI / 180;
  const quat = new Quaternion().setFromEuler(new Euler(euler[0] * d, euler[1] * d, euler[2] * d, 'XYZ'));
  const world = new Matrix4().compose(new Vector3(position[0], position[1], position[2]), quat, new Vector3(1, 1, 1));
  return { world, position, euler };
}

/** A JSON triple of finite numbers, or a refusal naming the parameter. */
function parseTriple(json: string, param: string): { value: [number, number, number] } | { error: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return { error: `${param} must be a JSON array of three numbers, e.g. "[1.2,0,0.5]".` }; }
  if (!Array.isArray(parsed) || parsed.length !== 3 || parsed.some((v) => !Number.isFinite(Number(v)))) {
    return { error: `${param} must be a JSON array of exactly three finite numbers, e.g. "[1.2,0,0.5]".` };
  }
  return { value: [Number(parsed[0]), Number(parsed[1]), Number(parsed[2])] };
}

/** A world pose expressed in `parent`'s (possibly frozen) local frame. */
function localPoseUnder(parent: Object3D | null, world: Matrix4): {
  position: [number, number, number]; quaternion: [number, number, number, number]; scale: [number, number, number];
} {
  const m = new Matrix4().copy(world);
  if (parent) m.premultiply(new Matrix4().copy(parent.matrixWorld).invert());
  const p = new Vector3();
  const q = new Quaternion();
  const s = new Vector3();
  m.decompose(p, q, s);
  return { position: [p.x, p.y, p.z], quaternion: [q.x, q.y, q.z, q.w], scale: [s.x, s.y, s.z] };
}

/**
 * The `IKTarget` fields of a `fieldsJson` argument, validated by NAME.
 *
 * Like `web_execute("component.setFields", …)`, this checks names against the
 * registered schema. It additionally refuses the two kinds of field that are
 * not the caller's to type.
 */
function parseTargetFields(json?: string): { fields: Record<string, unknown> } | { error: string } {
  if (json === undefined || json.trim() === '') return { fields: {} };
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return { error: 'fieldsJson must be a JSON object, e.g. {"InterpolationToTarget":"Linear"}.' }; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: 'fieldsJson must be a JSON OBJECT of IKTarget field names, e.g. {"BlendRadius":40}.' };
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (key === 'AxisPos') {
      return {
        error: 'AxisPos is solved, not typed: it is written by ik.target.add / _set / _solve_target together '
          + 'with the pose it belongs to. Setting it by hand is how a pose and its joint angles drift apart.',
      };
    }
    if (key === 'gripTarget') return { error: 'gripTarget is a Grip reference. Use ik.target.setGrip with targetPath and gripPath (or null to clear).' };
    if (key === 'fixer') {
      return { error: `"${key}" is a reference to a Grip and is not set through this tool — use web_execute("component.setFields", …) on the IKTarget.` };
    }
    if (!getFieldDescriptor('IKTarget', key)) {
      return {
        error: `"${key}" is not an IKTarget field. Known: InterpolationToTarget, SpeedToTarget, LinearSpeedToTarget, `
          + 'LinearAcceleration, EnableBlending, BlendRadius, WaitForSeconds, SetSignalDuration, TurnCorrection, '
          + 'PickAndPlace, Pick, Place, FollowInEditMode, SetSignal, WaitForSignal. '
          + 'web_component_schema("IKTarget") prints the types.',
      };
    }
    out[key] = value;
  }
  return { fields: out };
}

/** Every `Drive` whose node lies in `root`'s subtree. */
function allDrivesUnder(registry: NodeRegistry, root: Object3D): RVDrive[] {
  return registry.findAllInChildren<RVDrive>(root, 'Drive').map((r) => r.instance);
}

// ─── The `ik.*` commands (plan-773 Phase 3 Nachtrag 2026-10-23,
//     plus `ik.program.export` from Phase 5, 2026-10-24) ─────────────────

/**
 * Eight commands, eight bound tools — one vocabulary for robot programs.
 *
 * Phase 3 first put the authoring tools on the plan-499 §9.2 allow-list, with
 * the reason that an `ik.*` command would have "no second caller and no button
 * to glow". That weighed two of the three things a binding buys and missed the
 * third: a bound tool is NOT listed separately in `tools/list` (it answers as
 * `alias (web_execute)`), so the surface an agent has to read SHRINKS instead
 * of growing by seven, and every model change stays reachable through the ONE
 * command vocabulary (`web_commands` / `web_execute` / `web_batch`). The
 * allow-list is meant to shrink with every migration; growing it by seven was
 * the wrong direction, and these seven are ordinary document writes.
 *
 * Phase 5 added an eighth, `ik.program.export`, and it is the first binding
 * here that is NOT a write: it exists because the export has a real second
 * caller (the Export button on the IKPath inspector) and because one shared
 * implementation is the only way the licence gate, the F21 check and the E9
 * refusals cannot be reached by one caller and skipped by the other.
 *
 * ## Why the implementations are the tool routines
 *
 * Unlike `mechanism-command-descriptors`, there is no private half to load
 * lazily: the IK authoring routines are in this open file, so the descriptors
 * carry them as `eagerImpl` — the shape `signal.bind` / `signal.unbind` use.
 * `run()` goes through {@link valueOrThrowToolJson}, which turns the routines'
 * `{error, …}` answer into a `CommandError` so the bound tool serialises it
 * back to exactly the same JSON a direct call produced. Nothing about the
 * answers changes, in either direction.
 *
 * ## `macro: true` is declared, and what it is worth TODAY
 *
 * All seven WRITES change the document, which is the registry's own criterion,
 * and
 * each carries the `resolveArgs` that makes "the only robot", "the only path",
 * "the current TCP" and "append" explicit. But the recorder books lines into
 * the MACRO BOOK OF THE EDITOR'S DOCUMENT (`stepDocumentOf` reads
 * `getActiveAssetContext()`), while this family writes into the PLANNER's document
 * and refuses while the asset editor is open (`editRoute`). The two are
 * mutually exclusive, so a path authored over MCP is NOT recorded yet —
 * `web_macro_record_start` answers "No document is open" in the very mode these
 * tools work in. The flag is correct and costs nothing (`runCommandStep` falls
 * through to the plain dispatch when there is no document); making a recorded
 * path replayable needs the recorder extended to the planner's document, which is
 * its own piece of work.
 *
 * ## `scope: 'none'`
 *
 * Not `'editor'`: an editor scope would make the registry demand an asset
 * document, which is precisely the state these commands refuse in.
 */

interface IkPathCreateArgs {
  readonly robotPath?: string; readonly name?: string;
  readonly loopPath?: boolean; readonly speedOverride?: number;
}
interface IkTargetAddArgs {
  readonly pathPath?: string; readonly positionJson?: string; readonly rotationJson?: string;
  readonly index?: number; readonly name?: string; readonly fieldsJson?: string;
  readonly allowUnreachable?: boolean;
}
interface IkTargetSetArgs {
  readonly targetPath: string; readonly positionJson?: string; readonly rotationJson?: string;
  readonly fieldsJson?: string; readonly allowUnreachable?: boolean;
}
interface IkTargetRefArgs { readonly targetPath: string }
interface IkTargetSolveArgs { readonly targetPath: string; readonly solutionIndex?: number }
interface IkTargetReorderArgs {
  readonly fromIndex: number; readonly toIndex: number; readonly pathPath?: string;
}
interface IkRobotRigArgs {
  readonly path: string; readonly wristType?: string; readonly elbowInUnityX?: boolean;
}
interface IkProgramExportArgs {
  readonly vendor: string; readonly pathPath?: string; readonly axisBased?: boolean;
  readonly includeLinkedPaths?: boolean; readonly download?: boolean;
}

/** A trimmed string, or undefined — what an omitted optional wire value means. */
const ikStr = (v: unknown): string | undefined => {
  const t = typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v);
  return t === '' ? undefined : t;
};

/** A finite number, or undefined. */
const ikNum = (v: unknown): number | undefined => {
  const n = Number(v);
  return v === undefined || v === null || v === '' || !Number.isFinite(n) ? undefined : n;
};

const ikTools = (ctx: { viewer: RVViewer }): McpRobotTools => new McpRobotTools(() => ctx.viewer);

const ikPathCreate: CommandImpl<IkPathCreateArgs, Record<string, unknown>> = {
  enabled: () => true,
  run: async (ctx, a) => valueOrThrowToolJson(
    await ikTools(ctx).createPath(a?.robotPath, a?.name, a?.loopPath, a?.speedOverride),
  ),
  resolveArgs: (ctx, a) => {
    const t = ikTools(ctx);
    return {
      robotPath: t.resolveImplicitRobot(ikStr(a?.robotPath)),
      name: ikStr(a?.name) ?? 'IKPath',
      loopPath: a?.loopPath === true,
      speedOverride: ikNum(a?.speedOverride) ?? 1,
    };
  },
};

const ikTargetAdd: CommandImpl<IkTargetAddArgs, Record<string, unknown>> = {
  enabled: () => true,
  run: async (ctx, a) => valueOrThrowToolJson(await ikTools(ctx).addTarget(
    a?.pathPath, a?.positionJson, a?.rotationJson, a?.index, a?.name, a?.fieldsJson, a?.allowUnreachable,
  )),
  resolveArgs: (ctx, a) => {
    const t = ikTools(ctx);
    const pathPath = t.resolveImplicitPath(ikStr(a?.pathPath));
    // The default pose is the robot's CURRENT TCP — frozen here, because on a
    // replay the robot stands somewhere else.
    const pose = a?.positionJson === undefined || a?.rotationJson === undefined
      ? t.resolveCurrentTcpPose(pathPath) : null;
    return {
      pathPath,
      positionJson: a?.positionJson ?? pose?.[0],
      rotationJson: a?.rotationJson ?? pose?.[1],
      index: ikNum(a?.index) ?? t.resolveAppendIndex(pathPath),
      name: ikStr(a?.name) ?? t.resolveTargetName(pathPath),
      fieldsJson: ikStr(a?.fieldsJson),
      allowUnreachable: a?.allowUnreachable === true,
    };
  },
};

const ikTargetSet: CommandImpl<IkTargetSetArgs, Record<string, unknown>> = {
  enabled: (_ctx, a) => (ikStr(a?.targetPath) ? true : { reason: 'targetPath is required' }),
  run: async (ctx, a) => valueOrThrowToolJson(await ikTools(ctx).setTarget(
    a.targetPath, a?.positionJson, a?.rotationJson, a?.fieldsJson, a?.allowUnreachable,
  )),
  resolveArgs: (_ctx, a) => ({
    targetPath: ikStr(a?.targetPath) ?? '',
    positionJson: a?.positionJson,
    rotationJson: a?.rotationJson,
    fieldsJson: ikStr(a?.fieldsJson),
    allowUnreachable: a?.allowUnreachable === true,
  }),
};

const ikTargetSetGrip: CommandImpl<{ targetPath: string; gripPath: string | null }, Record<string, unknown>> = {
  enabled: (_ctx, a) => ikStr(a?.targetPath) && (a?.gripPath === null || ikStr(a?.gripPath))
    ? true : { reason: 'Provide targetPath and gripPath (a Grip path or null to clear), then retry ik.target.setGrip.' },
  run: async (ctx, a) => valueOrThrowToolJson(await ikTools(ctx).setGrip(a.targetPath, a.gripPath)),
  resolveArgs: (_ctx, a) => ({ targetPath: ikStr(a?.targetPath) ?? '', gripPath: a?.gripPath === null ? null : ikStr(a?.gripPath)! }),
};
const ikTargetRemove: CommandImpl<{ targetPath?: string; pathPath?: string; index?: number }, Record<string, unknown>> = {
  enabled: () => true,
  run: async (ctx, a) => valueOrThrowToolJson(await ikTools(ctx).removeTarget(a?.targetPath, a?.pathPath, a?.index)),
  resolveArgs: (_ctx, a) => ({ targetPath: ikStr(a?.targetPath), pathPath: ikStr(a?.pathPath), index: a?.index }),
};

const ikTargetReorder: CommandImpl<IkTargetReorderArgs, Record<string, unknown>> = {
  enabled: (_ctx, a) => (ikNum(a?.fromIndex) === undefined || ikNum(a?.toIndex) === undefined
    ? { reason: 'fromIndex and toIndex are required (0-based)' } : true),
  run: async (ctx, a) => valueOrThrowToolJson(
    await ikTools(ctx).reorderTargets(a.fromIndex, a.toIndex, a?.pathPath),
  ),
  resolveArgs: (ctx, a) => ({
    fromIndex: ikNum(a?.fromIndex) ?? 0,
    toIndex: ikNum(a?.toIndex) ?? 0,
    pathPath: ikTools(ctx).resolveImplicitPath(ikStr(a?.pathPath)),
  }),
};

const ikTargetSolve: CommandImpl<IkTargetSolveArgs, Record<string, unknown>> = {
  enabled: (_ctx, a) => (ikStr(a?.targetPath) ? true : { reason: 'targetPath is required' }),
  run: async (ctx, a) => valueOrThrowToolJson(
    await ikTools(ctx).solveTarget(a.targetPath, a?.solutionIndex),
  ),
  resolveArgs: (_ctx, a) => ({
    targetPath: ikStr(a?.targetPath) ?? '',
    solutionIndex: ikNum(a?.solutionIndex),
  }),
};

const ikRobotRig: CommandImpl<IkRobotRigArgs, Record<string, unknown>> = {
  enabled: (_ctx, a) => (ikStr(a?.path) ? true : { reason: 'path is required (the robot ROOT node)' }),
  run: async (ctx, a) => valueOrThrowToolJson(
    await ikTools(ctx).rigRobot(a.path, a?.wristType, a?.elbowInUnityX),
  ),
  // The wrist type and the elbow sign are MEASURED when they are omitted, and
  // the measurement is what the answer reports — so a recorded line keeps the
  // omission rather than freezing one scene's verdict onto another robot.
  resolveArgs: (_ctx, a) => ({
    path: ikStr(a?.path) ?? '',
    wristType: ikStr(a?.wristType),
    ...(a?.elbowInUnityX === undefined ? {} : { elbowInUnityX: a.elbowInUnityX === true }),
  }),
};

/**
 * plan-773 Phase 5 (F18/F19). The ONE difference to the seven above: it is
 * `readOnly` and therefore not `macro` — see {@link IK_PROGRAM_EXPORT_COMMAND}.
 *
 * `resolveArgs` makes "the only path" and the two defaults explicit, for the
 * same reason the authoring commands do: a recorded or replayed line must not
 * change meaning because a second path was loaded in the meantime.
 */
const ikProgramExport: CommandImpl<IkProgramExportArgs, Record<string, unknown>> = {
  enabled: (_ctx, a) => (ikStr(a?.vendor) ? true : { reason: 'vendor is required (abb-rapid | sew-srlprg)' }),
  run: async (ctx, a) => valueOrThrowToolJson(await ikTools(ctx).exportProgram(
    a.vendor, a?.pathPath, a?.axisBased, a?.includeLinkedPaths, a?.download,
  )),
  resolveArgs: (ctx, a) => ({
    vendor: ikStr(a?.vendor) ?? '',
    pathPath: ikTools(ctx).resolveImplicitPath(ikStr(a?.pathPath)),
    axisBased: a?.axisBased !== false,
    includeLinkedPaths: a?.includeLinkedPaths === true,
    download: a?.download === true,
  }),
};

interface IkSpec {
  readonly id: string;
  readonly label: string;
  /** Omitted for a read-only command — there is nothing to undo. */
  readonly undoLabel?: string;
  /** Default false (a write). True only for `ik.program.export` (plan-773 F18). */
  readonly readOnly?: boolean;
  readonly argsSchema: Readonly<Record<string, CommandArgType>>;
  readonly toolClass?: CommandDescriptor['toolClass'];
  readonly timeoutMs?: number;
  readonly cancellable?: boolean;
  /** Transient simulation commands must not be recorded as document writes. */
  readonly macro?: boolean;
  readonly mcp?: CommandMcpMirror;
  readonly impl: CommandImpl<never, Record<string, unknown>>;
}

type IkParam = CommandMcpMirror['params'][number];
const ikReq = (name: string, type = 'string'): IkParam => ({ name, type, required: true });
const ikOpt = (name: string, type = 'string'): IkParam => ({ name, type, required: false });

/** The specs — `argsSchema` IS the wire shape (the parity gate compares them). */
const IK_SPECS: readonly IkSpec[] = [
  {
    id: 'ik.robot.moveTcp', label: 'Move robot TCP', toolClass: 'sim', macro: false,
    argsSchema: { path: 'string', positionJson: 'string', rotationJson: 'string', deltaJson: 'string', frame: 'string', solutionIndex: 'number' },
    impl: {
      enabled: () => true,
      run: async (ctx: CommandContext, a: MoveTcpArgs) => valueOrThrowToolJson(JSON.stringify(await ikTools(ctx).moveRobotTcp(a))),
      resolveArgs: (ctx: CommandContext, a: MoveTcpArgs) => ({ ...a, path: ikTools(ctx).resolveImplicitRobot(ikStr(a?.path)) }),
    } as unknown as CommandImpl<never, Record<string, unknown>>,
  },
  {
    id: 'ik.path.check', label: 'Check robot path', readOnly: true, macro: false,
    argsSchema: { pathPath: 'string' },
    impl: {
      enabled: () => true,
      run: async (ctx: CommandContext, a: { pathPath?: string }) => valueOrThrowToolJson(JSON.stringify(ikTools(ctx).queryCheckPath(a?.pathPath))),
      resolveArgs: (ctx: CommandContext, a: { pathPath?: string }) => ({ pathPath: ikTools(ctx).resolveImplicitPath(ikStr(a?.pathPath)) }),
    } as unknown as CommandImpl<never, Record<string, unknown>>,
  },
  ...[false, true].map((stop): IkSpec => ({
    id: stop ? 'ik.path.stop' : 'ik.path.run', label: stop ? 'Stop IK path' : 'Run IK path',
    toolClass: 'sim', macro: false,
    ...(stop ? {} : { timeoutMs: 600_000, cancellable: true }),
    argsSchema: stop ? { pathPath: 'string' } : { pathPath: 'string', timeoutMs: 'number' },
    impl: {
      enabled: () => true,
      run: async (ctx: CommandContext, a: { pathPath?: string; timeoutMs?: number }) => {
        const value = await ikTools(ctx).runOrStopPath(a?.pathPath, a?.timeoutMs, ctx.signal, stop);
        // Runtime termination is a result; refused starts must fail batch execution.
        return 'finished' in value ? value : valueOrThrowToolJson(JSON.stringify(value));
      },
      resolveArgs: (ctx: CommandContext, a: { pathPath?: string; timeoutMs?: number }) => ({
        pathPath: ikTools(ctx).resolveImplicitPath(ikStr(a?.pathPath)),
        ...(stop ? {} : { timeoutMs: a?.timeoutMs ?? 120_000 }),
      }),
    } as unknown as CommandImpl<never, Record<string, unknown>>,
  })),
  {
    id: IK_ROBOT_RIG_COMMAND, label: 'Rig robot', undoLabel: 'Rig robot (RobotIK)',
    argsSchema: { path: 'string', wristType: 'string', elbowInUnityX: 'boolean' },
    mcp: {
      tool: 'web_robot_rig_from_library',
      params: [ikReq('path'), ikOpt('wristType'), ikOpt('elbowInUnityX', 'boolean')],
    },
    impl: ikRobotRig as unknown as CommandImpl<never, Record<string, unknown>>,
  },
  {
    id: IK_PATH_CREATE_COMMAND, label: 'Create IK path', undoLabel: 'Create IK path',
    argsSchema: { robotPath: 'string', name: 'string', loopPath: 'boolean', speedOverride: 'number' },
    mcp: {
      tool: 'web_robot_path_create',
      params: [ikOpt('robotPath'), ikOpt('name'), ikOpt('loopPath', 'boolean'), ikOpt('speedOverride', 'number')],
    },
    impl: ikPathCreate as unknown as CommandImpl<never, Record<string, unknown>>,
  },
  {
    id: IK_TARGET_ADD_COMMAND, label: 'Add IK waypoint', undoLabel: 'Add IK waypoint',
    argsSchema: {
      pathPath: 'string', positionJson: 'string', rotationJson: 'string', index: 'number',
      name: 'string', fieldsJson: 'string', allowUnreachable: 'boolean',
    },
    mcp: {
      tool: 'web_robot_target_add',
      params: [
        ikOpt('pathPath'), ikOpt('positionJson'), ikOpt('rotationJson'), ikOpt('index', 'integer'),
        ikOpt('name'), ikOpt('fieldsJson'), ikOpt('allowUnreachable', 'boolean'),
      ],
    },
    impl: ikTargetAdd as unknown as CommandImpl<never, Record<string, unknown>>,
  },
  {
    id: IK_TARGET_SET_COMMAND, label: 'Edit IK waypoint', undoLabel: 'Edit IK waypoint',
    argsSchema: {
      targetPath: 'string', positionJson: 'string', rotationJson: 'string',
      fieldsJson: 'string', allowUnreachable: 'boolean',
    },
    mcp: {
      tool: 'web_robot_target_set',
      params: [
        ikReq('targetPath'), ikOpt('positionJson'), ikOpt('rotationJson'), ikOpt('fieldsJson'),
        ikOpt('allowUnreachable', 'boolean'),
      ],
    },
    impl: ikTargetSet as unknown as CommandImpl<never, Record<string, unknown>>,
  },
  {
    id: IK_TARGET_SET_GRIP_COMMAND, label: 'Set waypoint grip', undoLabel: 'Set waypoint grip',
    argsSchema: { targetPath: 'string', gripPath: 'string' },
    impl: ikTargetSetGrip as unknown as CommandImpl<never, Record<string, unknown>>,
  },
  {
    id: IK_TARGET_REMOVE_COMMAND, label: 'Delete IK waypoint', undoLabel: 'Delete IK waypoint',
    argsSchema: { targetPath: 'string', pathPath: 'string', index: 'number' },
    mcp: { tool: 'web_robot_target_remove', params: [ikOpt('targetPath'), ikOpt('pathPath'), ikOpt('index', 'integer')] },
    impl: ikTargetRemove as unknown as CommandImpl<never, Record<string, unknown>>,
  },
  {
    id: IK_TARGET_REORDER_COMMAND, label: 'Reorder IK waypoints', undoLabel: 'Reorder IK waypoints',
    argsSchema: { fromIndex: 'number', toIndex: 'number', pathPath: 'string' },
    mcp: {
      tool: 'web_robot_target_reorder',
      params: [ikReq('fromIndex', 'integer'), ikReq('toIndex', 'integer'), ikOpt('pathPath')],
    },
    impl: ikTargetReorder as unknown as CommandImpl<never, Record<string, unknown>>,
  },
  {
    id: IK_TARGET_SOLVE_COMMAND, label: 'Solve IK waypoint', undoLabel: 'Solve IK waypoint',
    argsSchema: { targetPath: 'string', solutionIndex: 'number' },
    mcp: {
      tool: 'web_robot_solve_target',
      params: [ikReq('targetPath'), ikOpt('solutionIndex', 'integer')],
    },
    impl: ikTargetSolve as unknown as CommandImpl<never, Record<string, unknown>>,
  },
  {
    id: IK_PROGRAM_EXPORT_COMMAND, label: 'Export robot program', readOnly: true,
    argsSchema: {
      vendor: 'string', pathPath: 'string', axisBased: 'boolean',
      includeLinkedPaths: 'boolean', download: 'boolean',
    },
    mcp: {
      tool: 'web_robot_program_export',
      params: [
        ikReq('vendor'), ikOpt('pathPath'), ikOpt('axisBased', 'boolean'),
        ikOpt('includeLinkedPaths', 'boolean'), ikOpt('download', 'boolean'),
      ],
    },
    impl: ikProgramExport as unknown as CommandImpl<never, Record<string, unknown>>,
  },
];

/** Build the descriptors (testable seam: no registry side effect). */
export function createIkCommandDescriptors(): CommandDescriptor<never, unknown>[] {
  return [...createIkQueryDescriptors(), ...IK_SPECS.map((sp): CommandDescriptor<never, unknown> => ({
    id: sp.id,
    label: sp.label,
    ...(sp.undoLabel === undefined ? {} : { undoLabel: sp.undoLabel }),
    readOnly: sp.readOnly === true,
    // `macro` is the registry's "this call changed the document" flag and
    // REQUIRES readOnly: false. The export changes nothing, so it carries none.
    macro: sp.macro ?? sp.readOnly !== true,
    ...(sp.toolClass === undefined ? {} : { toolClass: sp.toolClass }),
    ...(sp.timeoutMs === undefined ? {} : { timeoutMs: sp.timeoutMs }),
    ...(sp.cancellable === undefined ? {} : { cancellable: sp.cancellable }),
    scope: 'none',
    available: true,
    unavailableReason: 'Not available',
    ...(sp.mcp === undefined ? {} : { mcp: sp.mcp }),
    argsSchema: sp.argsSchema,
    eagerImpl: sp.impl,
    impl: () => Promise.resolve(sp.impl),
  } as unknown as CommandDescriptor<never, unknown>))];
}

/** Read-only queries preserve error objects as values, without the write-path error conversion. */
function createIkQueryDescriptors(): CommandDescriptor<never, unknown>[] {
  return [
    {
      id: 'ik.robot.list', label: 'ik.robot.list', readOnly: true, scope: 'none',
      available: true, unavailableReason: 'Not available',
      argsSchema: {},
      impl: async () => {
        const impl: CommandImpl<{}, unknown> = {
          enabled: () => true,
          run: async (ctx) => JSON.parse(await ikTools(ctx).queryList()),
        };
        return impl;
      },
    },
    {
      id: 'ik.robot.chain', label: 'ik.robot.chain', readOnly: true, scope: 'none',
      available: true, unavailableReason: 'Not available',
      argsSchema: { path: 'string' },
      impl: async () => {
        const impl: CommandImpl<{ path?: string }, unknown> = {
          enabled: () => true,
          run: async (ctx, a) => JSON.parse(await ikTools(ctx).queryGetChain(a?.path)),
        };
        return impl;
      },
    },
    {
      id: 'ik.robot.state', label: 'ik.robot.state', readOnly: true, scope: 'none',
      available: true, unavailableReason: 'Not available',
      argsSchema: { path: 'string' },
      impl: async () => {
        const impl: CommandImpl<{ path?: string }, unknown> = {
          enabled: () => true,
          run: async (ctx, a) => JSON.parse(await ikTools(ctx).queryGetState(a?.path)),
        };
        return impl;
      },
    },
    {
      id: 'ik.robot.verifyFk', label: 'ik.robot.verifyFk', readOnly: true, scope: 'none',
      available: true, unavailableReason: 'Not available',
      argsSchema: { path: 'string', targetPath: 'string', anglesJson: 'string' },
      impl: async () => {
        const impl: CommandImpl<{ path?: string; targetPath?: string; anglesJson?: string }, unknown> = {
          enabled: () => true,
          run: async (ctx, a) => JSON.parse(await ikTools(ctx).queryVerifyFk(a?.path, a?.targetPath, a?.anglesJson)),
        };
        return impl;
      },
    },
    {
      id: 'ik.robot.rigDiagnose', label: 'ik.robot.rigDiagnose', readOnly: true, scope: 'none',
      available: true, unavailableReason: 'Not available',
      argsSchema: { path: 'string' },
      impl: async () => {
        const impl: CommandImpl<{ path: string }, unknown> = {
          enabled: () => true,
          run: async (ctx, a) => JSON.parse(await ikTools(ctx).queryRigDiagnose(a?.path)),
        };
        return impl;
      },
    },
    {
      id: 'ik.path.inspect', label: 'ik.path.inspect', readOnly: true, scope: 'none',
      available: true, unavailableReason: 'Not available',
      argsSchema: { pathPath: 'string' },
      impl: async () => {
        const impl: CommandImpl<{ pathPath?: string }, unknown> = {
          enabled: () => true,
          run: async (ctx, a) => JSON.parse(await ikTools(ctx).queryPathInspect(a?.pathPath)),
        };
        return impl;
      },
    },
  ] as CommandDescriptor<never, unknown>[];
}

const registeredIk = new WeakSet<CommandRegistry>();

/** Idempotent eager registration of the `ik.*` commands. */
export function ensureIkCommandsRegistered(registry: CommandRegistry = commandRegistry): void {
  if (registeredIk.has(registry)) return;
  registeredIk.add(registry);
  for (const d of createIkCommandDescriptors()) registry.register(d);
}
