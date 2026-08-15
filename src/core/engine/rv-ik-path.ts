// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-ik-path.ts — TypeScript pendant of IKPath.cs (realvirtual Robotics Pro).
 *
 * Orchestrates a robot motion path by sequencing RVIKTarget waypoints. This is
 * the **replay engine** (plan-215 Phase 1): it drives the robot's axis drives to
 * each target's pre-computed `AxisPos` joint angles, with full functional parity
 * for the start/end/wait signal contract and LogicStep triggering.
 *
 * Parity scope:
 *   - PTP motion (synced + unsynced) via the axis drives' own physics, driving
 *     to the baked `AxisPos` joint angles
 *   - LIN motion (InterpolationToTarget === 'Linear'): cartesian straight TCP
 *     line (position lerp, orientation slerp) with a trapezoid speed profile
 *     (LinearSpeedToTarget mm/s, LinearAcceleration mm/s²) and a continuous IK
 *     re-solve per fixed step — mirrors IKPath.cs StartDriveLinear/DriveLinear.
 *     Needs the live WASM solver; without one (tier 'none'), when the free-tier
 *     robot limit is hit, or when a step is unreachable or configuration-jumping
 *     (guard rail, LIN_MAX_STEP_JUMP_DEG), the segment seamlessly falls back to
 *     joint-space PTP replay of the baked AxisPos (replay robustness must never
 *     break). The FIRST target of a path is always PTP,
 *     like Unity's forceFirstPTP (linear from an arbitrary start pose can cross
 *     unreachable IK zones).
 *   - Signal contract: SignalStart (read, rising-edge → startPath), SignalIsStarted
 *     / SignalEnded (written), per-target SetSignal + WaitForSignal + WaitForSeconds
 *   - LoopPath / StartNextPath chaining
 *   - Pick/Place at targets (via RVGrip)
 *   - Start via StartPath (sim start) AND via SignalStart AND via LogicStep_IKPath
 *
 * Out of scope here (later phases): zone blending (EnableBlending/BlendRadius).
 *
 * Per-frame tick: RVViewer ticks all RVIKPath instances once per fixed step,
 * BEFORE the drive loop, so target/positionOverwrite writes apply the same frame.
 */

import type { Object3D } from 'three';
import { MathUtils, Vector3, Quaternion } from 'three';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponent, loadSchemaFromSpec } from './rv-component-registry';
import type { ComponentRef, NodeRegistry } from './rv-node-registry';
import {
  createSignalWriter,
  type SignalStore,
  type SignalWriter,
} from './rv-signal-store';
import type { RVDrive } from './rv-drive';
import { RVIKTarget } from './rv-ik-target';
import { wireBoolSignal } from './rv-signal-wiring';
import { debug } from './rv-debug';
import { ikSolverRegistry, targetPoseInBase, type CobotSolveOpts, type IKSolution } from './rv-ik-solver';
import { getDriveSpeedOverride } from './rv-speed-override';
import { MM_TO_METERS } from './rv-constants';
import { axisTargetPosition } from './rv-axis-angle-utils';
import {
  isAnyAxisOwned,
  registerAxisOwnershipParticipant,
  type AxisOwner,
} from './rv-axis-ownership';
// Type-only — rv-robot-ik imports runtime helpers from this file; a value import
// here would create a cycle. The instance is resolved via the registry at init.
import type { RVRobotIK } from './rv-robot-ik';

interface PendingSignalReset { addr: string; at: number; }

/**
 * LIN guard rail: max per-axis angular change (deg) the live solve may request
 * in ONE fixed step (and between the PTP arrival state and the segment-start
 * solution). Normal LIN steps move each joint fractions of a degree; anything
 * near this bound is a solution-branch flip or stale baked data. Exceeding it
 * hands the ENTIRE remaining segment to joint-space PTP replay — the LIN live
 * solve must never make the motion worse than the plain AxisPos replay.
 */
const LIN_MAX_STEP_JUMP_DEG = 30;

export class RVIKPath implements RVComponent {
  // Loaded from the rv-ODT specification (schema/v1/rv-odt.json, plan-187).
  // Path is listed so it shows in the inspector (rendered by a custom
  // reorderable-list field renderer). The runtime target list is resolved from
  // raw node extras in init(), NOT from this instance field (resolveComponentRefs
  // rewrites it to a path-string array — unused).
  // NOTE: StartNextPath (IKPath ref) is read raw in init().
  static readonly schema: ComponentSchema = loadSchemaFromSpec('IKPath');

  readonly node: Object3D;
  isOwner = true;

  // ── Authoring properties (parity with IKPath.cs) ──
  SpeedOverride = 1;
  SetNewTCP = false;
  DrawPath = true;
  DrawTargets = true;
  DebugPath = false;
  DebugBlending = false;
  StartPath = false;
  LoopPath = false;
  SignalStart: string | null = null;
  SignalIsStarted: string | null = null;
  SignalEnded: string | null = null;

  // ── Runtime status (read-only; surfaced via getLiveState) ──
  PathIsActive = false;
  PathIsFinished = false;
  NumTarget = 0;
  CurrentTarget: RVIKTarget | null = null;
  LastTarget: RVIKTarget | null = null;
  WaitForSignal = false;

  // ── Resolved in init() ──
  private _path: RVIKTarget[] = [];
  private _startNextPath: RVIKPath | null = null;
  private _axisDrives: RVDrive[] = [];
  private _store: SignalStore | null = null;
  private _writer: SignalWriter | null = null;
  private _signalStartAddr: string | null = null;
  private _signalIsStartedAddr: string | null = null;
  private _signalEndedAddr: string | null = null;
  private _unsubStart: (() => void) | null = null;
  private _startSignalValue = false;

  // ── Internal state machine ──
  private _simTime = 0;
  private _startBefore = false;
  private _waitForStartTimer = 0;
  private _checkNextTargetTimer = 0;
  private _activeMoving = false;
  private _waitSignalAddr: string | null = null;
  private _pendingReset: PendingSignalReset | null = null;
  private _warnedNoDrives = false;
  private _ownershipPaused = false;
  private _ownershipUnregister: (() => void) | null = null;

  // ── LIN (cartesian) segment state — poses in the robot-local, scale-free
  //    meter frame (the solver frame; see targetPoseInBase). ──
  private _robot: RVRobotIK | null = null;
  private _linActive = false;
  private _linTarget: RVIKTarget | null = null;
  private readonly _linStartPos = new Vector3();
  private readonly _linStartQuat = new Quaternion();
  private readonly _linEndPos = new Vector3();
  private readonly _linEndQuat = new Quaternion();
  private _linDist = 0;   // segment length [m]
  private _linPos = 0;    // distance travelled [m]
  private _linSpeed = 0;  // current speed [m/s]
  private _linDecel = false; // latched deceleration flag (IKPath.cs lineardeceleration)
  // Reusable unwrapped PTP destinations (per-target, not per-frame).
  private readonly _ptpDest: number[] = [];
  // Reusable solver inputs — no allocation in the per-step hot path.
  private readonly _p3: [number, number, number] = [0, 0, 0];
  private readonly _q4: [number, number, number, number] = [0, 0, 0, 1];
  private readonly _warm = new Float64Array(6);
  private readonly _seed: number[] = [0, 0, 0, 0, 0, 0];
  private readonly _cobotOpts: CobotSolveOpts = {};
  private readonly _stepPos = new Vector3();
  private readonly _stepQuat = new Quaternion();

  constructor(node: Object3D) {
    this.node = node;
  }

  init(context: ComponentContext): void {
    const registry = context.registry;
    this._store = context.signalStore;
    this._writer = createSignalWriter(
      context.signalStore,
      `component:IKPath:${this.node.name}`,
      'component',
    );

    // Read object refs DIRECTLY from node extras. We must NOT read them from
    // instance fields: resolveComponentRefs() (run by the loader before init)
    // iterates every instance property and rewrites ref-holding fields —
    // ref arrays become path-string arrays and single non-signal refs become
    // null — so any captured ref field is already corrupted by now. The raw
    // node.userData.realvirtual extras are untouched and authoritative.
    const raw = (this.node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined)?.['IKPath'] ?? {};

    // Resolve the ordered target list from raw extras.
    this.rebuildTargets(registry);

    // Resolve the chained path.
    const nextRef = raw['StartNextPath'];
    if (isRef(nextRef)) {
      this._startNextPath = resolveComp<RVIKPath>(registry, 'IKPath', (nextRef as ComponentRef).path);
    }

    // Resolve the ordered axis drives from the parent RobotIK's serialized Axis[].
    this._axisDrives = this.resolveAxisDrives(registry);
    this._ownershipUnregister?.();
    this._ownershipUnregister = registerAxisOwnershipParticipant({
      label: this.node.name,
      drives: this._axisDrives,
      isActive: () => this.PathIsActive,
      pause: (owner) => this.pauseForAxisOwnership(owner),
      resume: () => this.resumeAfterAxisOwnership(),
    });

    // Parent RobotIK component instance (WristType routing, joint chain, TCP)
    // for the LIN live-solve. Null ⇒ LIN segments replay as joint-space PTP.
    this._robot = registry.findInParent<RVRobotIK>(this.node, 'RobotIK');

    // Signal addresses (already resolved to strings by resolveComponentRefs).
    this._signalIsStartedAddr = typeof this.SignalIsStarted === 'string' ? this.SignalIsStarted : null;
    this._signalEndedAddr = typeof this.SignalEnded === 'string' ? this.SignalEnded : null;
    this._signalStartAddr = typeof this.SignalStart === 'string' ? this.SignalStart : null;

    // Subscribe to SignalStart (PLCOutputBool: PLC writes, viewer reads).
    //
    // plan-427 F10 — the one slot that must distinguish a replay from a change.
    // `SignalStart` is edge-detected in fixedUpdate (`_startBefore`), and
    // `reset()` clears `_startBefore`. Re-applying a level that has been held
    // `true` since before the reset would therefore look like a fresh rising
    // edge and start the robot program by itself. On a replay we only
    // re-synchronise the edge BASELINE — the same value the next tick would
    // have computed — so a genuine false→true afterwards still starts the path.
    this._unsubStart = wireBoolSignal(
      context.signalStore, this._signalStartAddr,
      (v, ctx) => {
        this._startSignalValue = v;
        if (ctx?.replay) this._startBefore = this.StartPath || v;
      },
      `IKPath "${this.node.name}": SignalStart`,
      context.reapply,
    ).unsubscribe;

    debug('loader',
      `  IKPath: ${this.node.name} targets=${this._path.length} axes=${this._axisDrives.length}` +
      ` start=${this.StartPath} loop=${this.LoopPath}`);
  }

  /** Walk up to the parent RobotIK node and resolve its ordered Axis[] drives. */
  private resolveAxisDrives(registry: NodeRegistry): RVDrive[] {
    let n: Object3D | null = this.node;
    while (n) {
      const rv = n.userData?.realvirtual as Record<string, unknown> | undefined;
      if (rv?.['RobotIK']) return resolveAxisDrivesFromNode(registry, n);
      n = n.parent;
    }
    return [];
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  startPath(): void {
    if (this.PathIsActive) return;
    this.PathIsActive = true;
    this.PathIsFinished = false;
    this.NumTarget = 0;
    this.WaitForSignal = false;
    this._activeMoving = false;
    this._checkNextTargetTimer = 0;
    this._waitForStartTimer = 0.1; // inhibit immediate stale-StartPath re-trigger
    this.setSignal(this._signalIsStartedAddr, true);
    this.setSignal(this._signalEndedAddr, false);
    debug('logic', `IKPath "${this.node.name}": startPath (${this._path.length} targets)`);
    this.checkNextTarget();
  }

  private checkNextTarget(): void {
    if (this.NumTarget < this._path.length) {
      this.driveToTarget(this._path[this.NumTarget]);
    } else {
      // Path end.
      this.PathIsActive = false;
      this.PathIsFinished = true;
      this.setSignal(this._signalEndedAddr, true);
      this.setSignal(this._signalIsStartedAddr, false);
      debug('logic', `IKPath "${this.node.name}": finished`);
      if (this._startNextPath) {
        this._startNextPath.startPath();
      } else if (this.LoopPath) {
        this.startPath();
      }
    }
  }

  private driveToTarget(target: RVIKTarget): void {
    this.CurrentTarget = target;

    const axisCount = this._axisDrives.length;
    if (axisCount === 0) {
      if (!this._warnedNoDrives) {
        console.warn(`[RVIKPath] "${this.node.name}": no axis drives resolved — cannot replay path.`);
        this._warnedNoDrives = true;
      }
      // No drives ⇒ allAxesAtTarget() is vacuously true ⇒ the fixedUpdate poll
      // advances on the next tick (never synchronously — see _activeMoving note).
      this._activeMoving = true;
      return;
    }

    // LIN segment: cartesian TCP line with a continuous live IK solve
    // (IKPath.cs parity). First target is always PTP (Unity forceFirstPTP).
    // tryStartLinear returning false ⇒ joint-space PTP replay fallback.
    if (target.InterpolationToTarget === 'Linear' && this.NumTarget > 0 && this.tryStartLinear(target)) {
      this._activeMoving = true;
      return;
    }

    this.drivePtpToTarget(target);
  }

  /** Joint-space PTP replay to the target's baked AxisPos — also the universal
   *  fallback for LIN segments (no solver / free-limit / unreachable step).
   *  Each rotary destination is unwrapped to the 360° representation closest to
   *  the drive's CURRENT position (RobotIK.cs:556 parity — Unity re-solves and
   *  unwraps AxisPos before every PTP move; the exported values keep whatever
   *  representation Unity stored, which can be a full turn away from where the
   *  previous segment — especially a LIN live-solve — left the axis). */
  private drivePtpToTarget(target: RVIKTarget): void {
    const axisCount = this._axisDrives.length;
    if (!target.hasReplayAngles(axisCount)) {
      console.warn(`[RVIKPath] "${this.node.name}": target "${target.node.name}" has no replay angles (AxisPos) — skipping motion.`);
      this._activeMoving = true; // drives left in place ⇒ poll advances next tick
      return;
    }

    const speedFactor = MathUtils.clamp(this.SpeedOverride * target.SpeedToTarget, 0.0001, 10);
    const synced = target.InterpolationToTarget !== 'PointToPointUnsynced';

    // Shortest-way destinations (linear axes untouched — a gantry axis must
    // never be wrapped mod 360).
    if (this._ptpDest.length !== axisCount) this._ptpDest.length = axisCount;
    for (let i = 0; i < axisCount; i++) {
      const drive = this._axisDrives[i];
      this._ptpDest[i] = axisTargetPosition(target.AxisPos[i], drive);
    }

    // Synced PTP: longest axis dictates the move time; others scale their speed.
    let maxTime = 0;
    if (synced) {
      for (let i = 0; i < axisCount; i++) {
        const drive = this._axisDrives[i];
        const delta = Math.abs(this._ptpDest[i] - drive.currentPosition);
        const speed = Math.max(drive.TargetSpeed * speedFactor, 0.0001);
        maxTime = Math.max(maxTime, delta / speed);
      }
    }

    for (let i = 0; i < axisCount; i++) {
      const drive = this._axisDrives[i];
      const dest = this._ptpDest[i];
      drive.positionOverwrite = false;
      const delta = Math.abs(dest - drive.currentPosition);
      if (synced && maxTime > 0) {
        drive.targetSpeed = Math.max(delta / maxTime, 0.0001);
      } else {
        drive.targetSpeed = Math.max(drive.TargetSpeed * speedFactor, 0.0001);
      }
      drive.startMove(dest);
    }

    // Arrival is detected by the next fixedUpdate poll (never synchronously here):
    // guarantees ≥1 tick per target, which prevents infinite recursion on
    // zero-delta targets and LoopPath/StartNextPath restarts.
    this._activeMoving = true;
  }

  // ── LIN (cartesian) segment execution ──────────────────────────

  /**
   * Try to start a LIN segment: capture the segment endpoints in the robot-local
   * frame and verify both are solvable AND configuration-continuous with the
   * current joint state. Returns false (⇒ PTP fallback) when: no RobotIK / not
   * 6 axes, no live solver for the robot's wrist type, no OPW params, the
   * free-tier live-solve limit is reached, an endpoint has no IK solution, or
   * the start solution jumps > LIN_MAX_STEP_JUMP_DEG from the current angles
   * (stale baked data / configuration mismatch ⇒ never worse than replay).
   *
   * C# parity (IKPath.cs): the segment START pose is the PREVIOUS target's pose
   * — Unity stores `LastPlannedPosition/Rotation = CurrentTarget.position/rotation`
   * on PTP arrival (IKPath.cs:546-547) and StartDriveLinear uses exactly that
   * (IKPath.cs:381-388); GetTCPPos/RotGlobal is only the degenerate fallback.
   * The TCP node pose must NOT be used as the start: its orientation convention
   * in the GLB differs from the target/solver frame (180° tool flip), which
   * poisons the slerp and drives the Pieper solve into unreachable/flipped
   * configurations (the "IRB 1.27 m off the line" bug).
   */
  private tryStartLinear(target: RVIKTarget): boolean {
    const robot = this._robot;
    if (!robot || this._axisDrives.length !== 6) return false;
    const prev = this._path[this.NumTarget - 1];
    if (!prev) return false; // LIN needs a previous target as segment start
    // Wrist-type routing (same as the edit plugin) — but replay must stay
    // exact: a NonSpherical robot without the Cobot solver would land subtly
    // off with Pieper, so it keeps joint-space replay instead.
    if (robot.WristType === 'NonSpherical') {
      if (!ikSolverRegistry.canSolveCobot || !robot.getJointChain()) return false;
    } else if (!ikSolverRegistry.available) {
      return false;
    }
    if (!robot.getOpwParams()) return false;
    if (!ikSolverRegistry.claimLiveSolve(robot.node.uuid)) return false;

    // Segment endpoints in the robot-local, scale-free meter frame — BOTH from
    // target nodes (identical frame convention; matrixWorld read directly, no
    // updateWorldMatrix: frozen nodes have it baked).
    targetPoseInBase(robot.node.matrixWorld, prev.node.matrixWorld, this._p3, this._q4);
    this._linStartPos.set(this._p3[0], this._p3[1], this._p3[2]);
    this._linStartQuat.set(this._q4[0], this._q4[1], this._q4[2], this._q4[3]);
    targetPoseInBase(robot.node.matrixWorld, target.node.matrixWorld, this._p3, this._q4);
    this._linEndPos.set(this._p3[0], this._p3[1], this._p3[2]);
    this._linEndQuat.set(this._q4[0], this._q4[1], this._q4[2], this._q4[3]);

    // Guard rail (replay must NEVER get worse than joint-space replay): the
    // START pose solution must match where the PTP replay parked the robot.
    // A large offset means the baked AxisPos and the live solve disagree
    // (stale export, different configuration branch) — joint-space replay of
    // the baked angles is then the trustworthy motion.
    const startAngles = this.solveStep(this._linStartPos, this._linStartQuat);
    if (!startAngles || this.maxJumpFromCurrent(startAngles) > LIN_MAX_STEP_JUMP_DEG) return false;

    // End pose must be solvable — Unity errors here; replay falls back to PTP.
    if (!this.solveStep(this._linEndPos, this._linEndQuat)) return false;

    this._linDist = this._linStartPos.distanceTo(this._linEndPos);
    this._linPos = 0;
    this._linSpeed = 0;
    this._linDecel = false;
    this._linTarget = target;
    this._linActive = true;
    return true;
  }

  /**
   * Advance the LIN trapezoid profile by one fixed step, interpolate the TCP
   * pose on the straight line (lerp/slerp) and re-solve the joints for it —
   * mirrors IKPath.cs DriveLinear. An unreachable step hands the remaining
   * motion over to joint-space PTP (never freeze mid-path).
   */
  private stepLinear(dt: number): void {
    const target = this._linTarget!;
    // Speed profile in meters (LinearSpeedToTarget mm/s, LinearAcceleration
    // mm/s²), scaled by the path override × the global sim speed override —
    // Unity's combinedSpeedOverride (SpeedToTarget is PTP-only, as in Unity).
    const override = getDriveSpeedOverride() * MathUtils.clamp(this.SpeedOverride, 0.0001, 10);
    const vMax = (Math.max(target.LinearSpeedToTarget, 0.0001) / MM_TO_METERS) * override;
    const accel = Math.max(target.LinearAcceleration, 0.0001) / MM_TO_METERS;
    // Deceleration latch (IKPath.cs lineardeceleration): stopping distance
    // v²/(2a) ≥ remaining distance ⇔ Unity's needslowdowntime ≥ availslowdowntime.
    if (!this._linDecel) {
      const distToEnd = Math.max(this._linDist - this._linPos, 0);
      if ((this._linSpeed * this._linSpeed) / (2 * accel) >= distToEnd) this._linDecel = true;
    }
    if (this._linDecel) {
      this._linSpeed -= accel * dt; // decelerate toward the segment end
    } else if (this._linSpeed < vMax) {
      this._linSpeed = Math.min(vMax, this._linSpeed + accel * dt);
    } else {
      this._linSpeed = vMax; // override was lowered mid-move — clamp down
    }
    this._linPos += Math.max(this._linSpeed, 0) * dt;

    let frac = this._linDist > 1e-9 ? this._linPos / this._linDist : 1;
    // At destination when the line is covered — or when the discretized
    // deceleration hits zero speed first (Unity: lineardeceleration && speed<0
    // ⇒ pathpercent=1 snap).
    const end = frac >= 1 || (this._linDecel && this._linSpeed <= 0);
    if (end) frac = 1;
    this._stepPos.lerpVectors(this._linStartPos, this._linEndPos, frac);
    this._stepQuat.slerpQuaternions(this._linStartQuat, this._linEndQuat, frac);

    const angles = this.solveStep(this._stepPos, this._stepQuat);
    if (!angles || this.maxJumpFromCurrent(angles) > LIN_MAX_STEP_JUMP_DEG) {
      // Guard rail: unreachable step OR configuration jump (solution branch
      // flip — one fixed step never legitimately moves a joint this far).
      // Hand the ENTIRE remaining segment over to joint-space PTP replay of
      // the baked AxisPos (checked BEFORE applying, so the jump never renders;
      // no per-step ping-pong — worst case equals the plain replay).
      this._linActive = false;
      this._linTarget = null;
      this.drivePtpToTarget(target);
      return;
    }
    for (let i = 0; i < 6; i++) {
      const d = this._axisDrives[i];
      // Continuous representation (RobotIK.cs:478-483 parity): the solver may
      // hand back any 360° branch (e.g. −179° while the axis sits at +181°) —
      // unwrap to the current position so currentPosition never jumps a turn
      // (chart speeds stay sane and the following PTP starts from a continuous
      // state). Same physical pose either way.
      const a = axisTargetPosition(angles[i], d);
      if (end) {
        // Final pose: snap, mark at-target so the arrival poll advances the
        // path on the next tick (same ≥1-tick guarantee as PTP).
        d.positionOverwrite = false;
        d.currentPosition = a;
        d.targetPosition = a;
        d.currentSpeed = 0;
        d.applyToNode();
      } else {
        // Mid-path: overwrite mode — the drive loop (after this tick) applies
        // the transform and derives currentSpeed for charts.
        d.positionOverwrite = true;
        d.currentPosition = a;
      }
    }
    if (end) {
      this._linActive = false;
      this._linTarget = null;
    }
  }

  /** Largest per-axis angular distance (deg, 360°-unwrapped) between a solve
   *  result and the drives' CURRENT positions — the configuration-jump metric
   *  for the LIN guard rail. */
  private maxJumpFromCurrent(angles: number[]): number {
    let max = 0;
    for (let i = 0; i < 6; i++) {
      let d = Math.abs(angles[i] - this._axisDrives[i].currentPosition) % 360;
      if (d > 180) d = 360 - d;
      if (d > max) max = d;
    }
    return max;
  }

  /** Solve the joints for a robot-local TCP pose, routed by wrist type; warm
   *  start + closest-selection use the CURRENT drive angles (previous step) for
   *  step-to-step continuity — Unity references the previous target's AxisPos
   *  instead (IKPath.cs:1249-1252), which is equivalent at the segment start
   *  and strictly less continuous mid-segment. Returns the selected angles or null. */
  private solveStep(pos: Vector3, quat: Quaternion): number[] | null {
    const robot = this._robot;
    if (!robot) return null;
    const params = robot.getOpwParams();
    if (!params) return null;
    this._p3[0] = pos.x; this._p3[1] = pos.y; this._p3[2] = pos.z;
    this._q4[0] = quat.x; this._q4[1] = quat.y; this._q4[2] = quat.z; this._q4[3] = quat.w;
    for (let i = 0; i < 6; i++) {
      const cur = this._axisDrives[i].currentPosition;
      this._warm[i] = cur;
      this._seed[i] = cur;
    }
    let sols: IKSolution[] | null = null;
    if (robot.WristType === 'NonSpherical') {
      // Cobot-only (gated in tryStartLinear) — no Pieper fallback for replay.
      const chain = robot.getJointChain();
      if (chain && ikSolverRegistry.canSolveCobot) {
        this._cobotOpts.opw = params;
        this._cobotOpts.warmStart = this._warm;
        sols = ikSolverRegistry.solveCobot(chain, this._p3, this._q4, this._cobotOpts);
      }
    } else {
      sols = ikSolverRegistry.solvePieper(params, this._p3, this._q4);
    }
    return sols ? ikSolverRegistry.selectClosest(sols, this._seed) : null;
  }

  private atTarget(): void {
    const target = this.CurrentTarget;
    if (target) {
      target.onAtTarget();
      // Schedule SetSignal reset (mirrors IKTarget.OnLeaveTarget timer).
      if (target.setSignalAddr && target.SetSignalDuration > 0) {
        this._pendingReset = { addr: target.setSignalAddr, at: this._simTime + target.SetSignalDuration };
      }
    }
    this.LastTarget = target;
    this.NumTarget++;

    // Wait for a signal at this target before advancing?
    if (target?.waitForSignalAddr) {
      this.WaitForSignal = true;
      this._waitSignalAddr = target.waitForSignalAddr;
    } else {
      this.readyForCheckNextTarget();
    }
  }

  private readyForCheckNextTarget(): void {
    this.WaitForSignal = false;
    this._waitSignalAddr = null;
    const wait = this.CurrentTarget?.WaitForSeconds ?? 0;
    if (wait > 0) {
      this._checkNextTargetTimer = wait;
    } else {
      this.checkNextTarget();
    }
  }

  private allAxesAtTarget(): boolean {
    for (const drive of this._axisDrives) {
      if (!drive.isAtTarget) return false;
    }
    return true;
  }

  private setSignal(addr: string | null, value: boolean): void {
    if (addr && this._writer) this._writer.setByPath(addr, value);
  }

  // ── Per-frame tick (called by RVViewer before the drive loop) ──
  fixedUpdate(dt: number): void {
    if (this._ownershipPaused || isAnyAxisOwned(this._axisDrives)) return;
    this._simTime += dt;

    // Pending SetSignal reset (deferred, sim-time based).
    if (this._pendingReset && this._simTime >= this._pendingReset.at) {
      this.setSignal(this._pendingReset.addr, false);
      this._pendingReset = null;
    }

    if (this._waitForStartTimer > 0) this._waitForStartTimer -= dt;

    // Start trigger: StartPath (sim start) OR SignalStart rising edge.
    const startTrigger = this.StartPath || this._startSignalValue;
    if (!this._startBefore && startTrigger && !this.PathIsActive && this._waitForStartTimer <= 0) {
      this.startPath();
    }
    this._startBefore = startTrigger;

    if (!this.PathIsActive) return;

    // Waiting for a per-target signal.
    if (this.WaitForSignal) {
      const ok = !this._waitSignalAddr || (this._store?.getBoolByPath(this._waitSignalAddr) ?? false);
      if (ok) this.readyForCheckNextTarget();
      return;
    }

    // Dwell timer (WaitForSeconds).
    if (this._checkNextTargetTimer > 0) {
      this._checkNextTargetTimer -= dt;
      if (this._checkNextTargetTimer <= 0) this.checkNextTarget();
      return;
    }

    // LIN motion in progress — advance the cartesian profile and re-solve.
    // When the segment ends, stepLinear snaps the drives to the final solution
    // (targetPosition = currentPosition), so the arrival poll below fires on
    // the NEXT tick — same ≥1-tick-per-target guarantee as PTP.
    if (this._linActive) {
      this.stepLinear(dt);
      return;
    }

    // PTP motion in progress — poll axis drives.
    if (this._activeMoving && this.allAxesAtTarget()) {
      this._activeMoving = false;
      this.atTarget();
    }
  }

  /** Reset to idle (used by RVIKPathStep.reset and engine reset). */
  reset(): void {
    this.PathIsActive = false;
    this.PathIsFinished = false;
    this.NumTarget = 0;
    this.CurrentTarget = null;
    this.LastTarget = null;
    this.WaitForSignal = false;
    this._activeMoving = false;
    this._checkNextTargetTimer = 0;
    this._waitForStartTimer = 0;
    this._startBefore = false;
    this._waitSignalAddr = null;
    this._pendingReset = null;
    this._linActive = false;
    this._linTarget = null;
    this._linPos = 0;
    this._linSpeed = 0;
    this._linDecel = false;
  }

  /** Resolved, ordered target list (read-only) — used by the path visualizer. */
  get targets(): readonly RVIKTarget[] { return this._path; }

  /** Re-resolve the ordered target list from the (possibly overridden) raw
   *  `IKPath.Path` extras. Called from init() and again after op-created target
   *  nodes are added on scene load (they don't exist yet when init() first runs). */
  rebuildTargets(registry: NodeRegistry): void {
    const raw = (this.node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined)?.['IKPath'] ?? {};
    const pathArr = Array.isArray(raw['Path']) ? (raw['Path'] as unknown[]) : [];
    this._path = pathArr
      .filter(isRef)
      .map((ref) => resolveComp<RVIKTarget>(registry, 'IKTarget', (ref as ComponentRef).path))
      .filter((t): t is RVIKTarget => t != null);
  }

  /** Reorder the runtime target list (authoring). Indices into the target list. */
  reorderTargets(from: number, to: number): void {
    const n = this._path.length;
    if (from < 0 || from >= n || to < 0 || to >= n || from === to) return;
    const [item] = this._path.splice(from, 1);
    this._path.splice(to, 0, item);
  }

  /** Insert a target into the runtime list at `index` (authoring, optimistic). */
  insertTarget(index: number, target: RVIKTarget): void {
    const i = Math.max(0, Math.min(index, this._path.length));
    this._path.splice(i, 0, target);
  }

  /** Remove a target from the runtime list (authoring). Index into the target list. */
  removeTarget(index: number): RVIKTarget | null {
    if (index < 0 || index >= this._path.length) return null;
    const [removed] = this._path.splice(index, 1);
    return removed ?? null;
  }

  getLiveState(): Record<string, unknown> {
    return {
      PathIsActive: this.PathIsActive,
      PathIsFinished: this.PathIsFinished,
      NumTarget: this.NumTarget,
      WaitForSignal: this.WaitForSignal,
      OwnershipPaused: this._ownershipPaused,
    };
  }

  dispose(): void {
    this._ownershipUnregister?.();
    this._ownershipUnregister = null;
    this._unsubStart?.();
    this._unsubStart = null;
  }

  private pauseForAxisOwnership(owner: AxisOwner): void {
    if (this._ownershipPaused) return;
    this._ownershipPaused = true;
    if (this.PathIsActive) {
      const ownerName = typeof owner === 'object'
        ? ((owner as { name?: unknown; id?: unknown }).name ?? (owner as { id?: unknown }).id ?? 'DES')
        : String(owner);
      console.warn(`[RVIKPath] "${this.node.name}" paused because its axes are claimed by ${String(ownerName)}.`);
    }
  }

  private resumeAfterAxisOwnership(): void {
    if (!this._ownershipPaused) return;
    this._ownershipPaused = false;
    if (this.PathIsActive && this.CurrentTarget) this.driveToTarget(this.CurrentTarget);
  }
}

export function isRef(v: unknown): v is ComponentRef {
  return !!v && typeof v === 'object'
    && (v as Record<string, unknown>).type === 'ComponentReference'
    && typeof (v as Record<string, unknown>).path === 'string';
}

/** Resolve a component by path, robust against undefined paths and Three.js node
 *  renames (duplicate-name dedup): falls back to node lookup → current path. */
export function resolveComp<T>(registry: NodeRegistry, type: string, path: string | undefined): T | null {
  if (typeof path !== 'string' || path.length === 0) return null;
  const direct = registry.getByPath<T>(type, path);
  if (direct) return direct;
  const node = registry.getNode(path);
  if (node) {
    const cur = registry.getPathForNode(node);
    if (cur) return registry.getByPath<T>(type, cur);
  }
  return null;
}

/** Resolve a RobotIK node's ordered Axis[] drives from its serialized extras.
 *  Reads raw extras (not the RobotIK instance) so it is independent of init order.
 *  Shared by RVRobotIK and RVIKPath. */
export function resolveAxisDrivesFromNode(registry: NodeRegistry, node: Object3D): RVDrive[] {
  const robot = (node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined)?.['RobotIK'];
  const axis = robot?.['Axis'];
  if (!Array.isArray(axis)) return [];
  return axis
    .filter(isRef)
    .map((ref) => resolveComp<RVDrive>(registry, 'Drive', (ref as ComponentRef).path))
    .filter((d): d is RVDrive => d != null);
}

registerComponent({
  type: 'IKPath',
  schema: RVIKPath.schema,
  capabilities: { selectable: true, badgeColor: '#ba68c8', filterLabel: 'IK Paths' },
  create: (node: Object3D) => new RVIKPath(node),
});
