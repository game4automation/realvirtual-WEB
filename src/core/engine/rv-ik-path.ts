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
import { NodeRegistry, type ComponentRef } from './rv-node-registry';
import { reportIkTargetNoAngles, reportRobotIkAxesUnresolved } from '../hmi/problems-store';
import { isComponentReference, storedReferenceValue, type StoredReferenceValue } from './rv-node-path-rewrite.mjs';
import {
  createSignalWriter,
  type SignalStore,
  type SignalWriter,
} from './rv-signal-store';
import type { RVDrive } from './rv-drive';
import { RVIKTarget } from './rv-ik-target';
import { wireBoolSignal } from './rv-signal-wiring';
import { debug } from './rv-debug';
import { ikSolverRegistry, solveFrameFor, targetPoseInBase, type CobotSolveOpts, type IKSolution } from './rv-ik-solver';
import { getDriveSpeedOverride } from './rv-speed-override';
import { MM_TO_METERS } from './rv-constants';
import { axisTargetPosition } from './rv-axis-angle-utils';
import {
  isAnyAxisOwned,
  registerAxisOwnershipParticipant,
  type AxisOwner,
} from './rv-axis-ownership';
import { commandAxisPosition, isDynamicAxis } from './rv-axis-contract';
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
export const LIN_MAX_STEP_JUMP_DEG = 30;

/** Wrapped distance treats full-turn representations as the same pose. */
export function linMaxJump(angles: readonly number[], current: readonly number[]): number {
  let max = 0;
  for (let i = 0; i < 6; i++) {
    let d = Math.abs(angles[i] - current[i]) % 360;
    if (d > 180) d = 360 - d;
    if (d > max) max = d;
  }
  return max;
}

/** Ordered guards preserve replay's first refusal, including the PTP arrival transition. */
export function linStartCheck(available: boolean, start: readonly number[] | null,
  current: readonly number[], endReachable = true): string | null {
  if (!available) return 'unavailable';
  if (!start) return 'start-unreachable';
  if (linMaxJump(start, current) > LIN_MAX_STEP_JUMP_DEG) return 'start-jump';
  return endReachable ? null : 'end-unreachable';
}

/** Same routing prerequisites as replay; budget inspection itself never claims. */
export function linAvailable(robot: RVRobotIK | null, axisCount: number): robot is RVRobotIK {
  return !!robot && axisCount === 6 && !!robot.getOpwParams()
    && (robot.WristType === 'NonSpherical' ? ikSolverRegistry.canSolveCobot && !!robot.getJointChain() : ikSolverRegistry.available)
    && ikSolverRegistry.wouldGrantLiveSolve(robot.node.uuid);
}

/** Shared numerical step, with caller-owned buffers for the runtime hot path. */
export function linSolveStep(robot: RVRobotIK, pos: [number, number, number], quat: [number, number, number, number],
  seed: number[], warm: Float64Array, opts: CobotSolveOpts): number[] | null {
  const params = robot.getOpwParams();
  if (!params) return null;
  for (let i = 0; i < 6; i++) warm[i] = seed[i];
  let sols: IKSolution[] | null = null;
  if (robot.WristType === 'NonSpherical') {
    const chain = robot.getJointChain();
    if (chain && ikSolverRegistry.canSolveCobot) {
      opts.opw = params; opts.warmStart = warm;
      sols = ikSolverRegistry.solveCobot(chain, pos, quat, opts);
    }
  } else sols = ikSolverRegistry.solvePieper(params, pos, quat);
  return sols ? ikSolverRegistry.selectClosest(sols, seed, robot.getAxisDrives()) : null;
}

export interface LinProfileState { distance: number; position: number; speed: number; decel: boolean; }

/** Reusable output keeps the runtime allocation-free; the deceleration latch
 * and zero-speed snap retain the original discrete Unity profile. */
export function linProfileStep(state: LinProfileState, speedMm: number, accelMm: number,
  dt: number, speedOverride: number, globalOverride: number, out: LinProfileState): number {
  const override = globalOverride * MathUtils.clamp(speedOverride, 0.0001, 10);
  const vMax = (Math.max(speedMm, 0.0001) / MM_TO_METERS) * override;
  const accel = Math.max(accelMm, 0.0001) / MM_TO_METERS;
  let speed = state.speed;
  const decel = state.decel || speed * speed / (2 * accel) >= Math.max(state.distance - state.position, 0);
  if (decel) speed -= accel * dt;
  else if (speed < vMax) speed = Math.min(vMax, speed + accel * dt);
  else speed = vMax;
  const position = state.position + Math.max(speed, 0) * dt;
  out.distance = state.distance; out.position = position; out.speed = speed; out.decel = decel;
  const frac = state.distance > 1e-9 ? position / state.distance : 1;
  return frac >= 1 || (decel && speed <= 0) ? 1 : frac;
}

export interface IKPathRunEvent {
  readonly type: 'started' | 'target-reached' | 'target-skipped' | 'lin-fallback' | 'finished' | 'cancelled';
  readonly runSeq: number;
  readonly index?: number;
  readonly reason?: string;
}

export class RVIKPath implements RVComponent {
  private _runSeq = 0;
  private readonly _runListeners = new Set<(event: IKPathRunEvent) => void>();
  private _observedTarget: 'moved' | 'skipped-no-angles' | null = null;

  /** Identity survives reset so a restarted LogicStep cannot impersonate an old run. */
  get runSeq(): number { return this._runSeq; }

  addRunListener(fn: (event: IKPathRunEvent) => void): () => void {
    this._runListeners.add(fn);
    return () => { this._runListeners.delete(fn); };
  }

  private emitRun(type: IKPathRunEvent['type'], index?: number, reason?: string): void {
    if (!this._runListeners.size) return;
    const event: IKPathRunEvent = { type, runSeq: this._runSeq, index, reason };
    for (const fn of this._runListeners) {
      // Observers must never interrupt motion, signal writes or path chaining.
      try { fn(event); } catch (e) { console.warn('[RVIKPath] Run listener failed', e); }
    }
  }

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
  get hasPendingWork(): boolean { return this._pendingReset !== null || this._waitForStartTimer > 0; }
  private _warnedNoDrives = false;
  /** Kept for the per-target diagnosis (target node paths). */
  private _registry: NodeRegistry | null = null;
  /** Resolved once in `init()` — the Problems entries key and display on it. */
  private _nodePath = '';
  private _ownershipPaused = false;
  private _ownershipUnregister: (() => void) | null = null;

  // ── LIN (cartesian) segment state — poses in the robot-local solve frame
  //    (`'chain'` or `'unity'`; see targetPoseInBase / solveFrameFor). ──
  private _robot: RVRobotIK | null = null;
  private _linActive = false;
  private _linTarget: RVIKTarget | null = null;
  private readonly _linStartPos = new Vector3();
  private readonly _linStartQuat = new Quaternion();
  private readonly _linEndPos = new Vector3();
  private readonly _linEndQuat = new Quaternion();
  private readonly _linProfile: LinProfileState = { distance: 0, position: 0, speed: 0, decel: false };
  private _linDist = 0;   // segment length [m]
  private _linPos = 0;    // distance travelled [m]
  private _linSpeed = 0;  // current speed [m/s]
  private _linDecel = false; // latched deceleration flag (IKPath.cs lineardeceleration)
  // Reusable unwrapped PTP destinations (per-target, not per-frame).
  private readonly _ptpDest: number[] = [];
  /**
   * plan-673 Phase 4 — per-axis setpoint speed (drive units/s) of a PTP segment
   * on a DYNAMIC axis. Empty while every axis of this path is kinematic.
   *
   * A dynamic axis cannot use the drive's own motion profile: with
   * `positionOverwrite` set, `updateMotion()` returns at the overwrite branch
   * before the profile runs, so `startMove()` would arm a profile that never
   * executes and the axis would simply never move. The planner therefore
   * generates the setpoint RAMP itself — one velocity-limited setpoint per
   * tick, which is also what a real controller sends. Commanding the
   * destination in one step instead would be a 180-degree step input into a
   * force-limited servo.
   */
  private readonly _ptpRampSpeed: number[] = [];
  /** True while a PTP setpoint ramp is running on at least one dynamic axis. */
  private _ptpRampActive = false;
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
    this._registry = registry;
    this._nodePath = registry.getPathForNode(this.node) ?? NodeRegistry.computeNodePath(this.node);
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
      this._startNextPath = resolveComp<RVIKPath>(registry, 'IKPath', storedReferenceValue(nextRef), this.node);
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

  /** How many axes the parent RobotIK DECLARES — so the diagnosis can tell
   *  "nothing was assigned" apart from "what was assigned did not resolve". */
  private declaredAxisCount(): number {
    let n: Object3D | null = this.node;
    while (n) {
      const robot = (n.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined)?.['RobotIK'];
      if (robot) return Array.isArray(robot['Axis']) ? (robot['Axis'] as unknown[]).length : 0;
      n = n.parent;
    }
    return 0;
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  startPath(): void {
    if (this.PathIsActive) return;
    this._runSeq++;
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
    this.emitRun('started');
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
      this.emitRun('finished');
      if (this._startNextPath) {
        this._startNextPath.startPath();
      } else if (this.LoopPath) {
        this.startPath();
      }
    }
  }

  private driveToTarget(target: RVIKTarget): void {
    this.CurrentTarget = target;
    this._observedTarget = null;

    const axisCount = this._axisDrives.length;
    if (axisCount === 0) {
      if (!this._warnedNoDrives) {
        console.warn(`[RVIKPath] "${this.node.name}": no axis drives resolved — cannot replay path.`);
        // A console warning nobody reads is how this stayed invisible: a path
        // that moves nothing looks identical to one that is simply idle.
        reportRobotIkAxesUnresolved({
          nodePath: this._nodePath || this.node.name,
          label: this.node.name || this._nodePath,
          declared: this.declaredAxisCount(),
        });
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
      this._observedTarget = 'moved';
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
      // Skipping a waypoint changes the pose sequence the robot visits, so it
      // belongs in the panel and not only in the console (same id per target ⇒
      // a LoopPath re-report replaces, never appends).
      reportIkTargetNoAngles({
        nodePath: this._registry?.getPathForNode(target.node) ?? NodeRegistry.computeNodePath(target.node),
        label: target.node.name || '(unnamed target)',
        pathLabel: this.node.name || this._nodePath,
        axisCount,
      });
      this._observedTarget = 'skipped-no-angles';
      this.emitRun('target-skipped', this.NumTarget, 'no-angles');
      this._activeMoving = true; // drives left in place ⇒ poll advances next tick
      return;
    }

    this._observedTarget = 'moved';
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

    if (this._ptpRampSpeed.length !== axisCount) this._ptpRampSpeed.length = axisCount;
    this._ptpRampActive = false;
    for (let i = 0; i < axisCount; i++) {
      const drive = this._axisDrives[i];
      const dest = this._ptpDest[i];
      const delta = Math.abs(dest - drive.currentPosition);
      const speed = (synced && maxTime > 0)
        ? Math.max(delta / maxTime, 0.0001)
        : Math.max(drive.TargetSpeed * speedFactor, 0.0001);

      // plan-673 Phase 4, the cascade of rule 2: on a dynamic axis the planner
      // writes the SETPOINT and the physics decides whether the axis gets
      // there. `positionOverwrite` is NOT cleared — the physics authority owns
      // it, and handing the axis back to its own integration mid-move is
      // exactly the "last writer in the tick wins" race the contract exists to
      // prevent.
      if (isDynamicAxis(drive)) {
        drive.targetSpeed = speed;
        // The FINAL goal, so `isAtTarget` (with the axis's widened arrival
        // tolerance) answers the arrival poll below.
        drive.targetPosition = dest;
        // The planner is the ONE setpoint source for this segment: a stale
        // `isRunning` would also arm the drive's own setpoint ramp
        // (`stepDynamicSetpoint`) toward the same destination, and two ramps on
        // one command is an ambiguity nobody should have to debug.
        drive.isRunning = false;
        // Nothing has commanded the axis yet ⇒ start the ramp where the axis
        // actually is, so the first tick is not a step input.
        if (!Number.isFinite(drive.commandedPosition)) drive.commandPosition(drive.currentPosition);
        this._ptpRampSpeed[i] = speed;
        this._ptpRampActive = true;
        continue;
      }

      drive.positionOverwrite = false;
      this._ptpRampSpeed[i] = 0;
      drive.targetSpeed = speed;
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
    if (!linAvailable(robot, this._axisDrives.length)) return this.linFallback('unavailable');
    const prev = this._path[this.NumTarget - 1];
    if (!prev) return this.linFallback('unavailable');
    if (!ikSolverRegistry.claimLiveSolve(robot.node.uuid)) return this.linFallback('unavailable');

    // Segment endpoints in the robot-local solve frame — BOTH from target nodes
    // (identical frame convention; matrixWorld read directly, no
    // updateWorldMatrix: frozen nodes have it baked). The frame follows the
    // solver this path routes to (plan-772 F5); interpolating in it is safe
    // either way, because the glTF ⇄ Unity mirror is linear on positions and a
    // quaternion conjugation on rotations, so a straight line stays straight
    // and a slerp stays the same motion.
    const frame = solveFrameFor(robot.WristType, robot.getJointChain());
    targetPoseInBase(robot.node.matrixWorld, prev.node.matrixWorld, this._p3, this._q4, frame);
    this._linStartPos.set(this._p3[0], this._p3[1], this._p3[2]);
    this._linStartQuat.set(this._q4[0], this._q4[1], this._q4[2], this._q4[3]);
    targetPoseInBase(robot.node.matrixWorld, target.node.matrixWorld, this._p3, this._q4, frame);
    this._linEndPos.set(this._p3[0], this._p3[1], this._p3[2]);
    this._linEndQuat.set(this._q4[0], this._q4[1], this._q4[2], this._q4[3]);

    // Guard rail (replay must NEVER get worse than joint-space replay): the
    // START pose solution must match where the PTP replay parked the robot.
    // A large offset means the baked AxisPos and the live solve disagree
    // (stale export, different configuration branch) — joint-space replay of
    // the baked angles is then the trustworthy motion.
    const startAngles = this.solveStep(this._linStartPos, this._linStartQuat);
    for (let i = 0; i < 6; i++) this._seed[i] = this._axisDrives[i].currentPosition;
    const startReason = linStartCheck(true, startAngles, this._seed);
    if (startReason) return this.linFallback(startReason);

    // End pose must be solvable — Unity errors here; replay falls back to PTP.
    if (!this.solveStep(this._linEndPos, this._linEndQuat)) return this.linFallback('end-unreachable');

    this._linDist = this._linStartPos.distanceTo(this._linEndPos);
    this._linPos = 0;
    this._linSpeed = 0;
    this._linDecel = false;
    this._linTarget = target;
    this._linActive = true;
    return true;
  }

  private linFallback(reason: string): false {
    this.emitRun('lin-fallback', this.NumTarget, reason);
    return false;
  }

  /**
   * Advance the LIN trapezoid profile by one fixed step, interpolate the TCP
   * pose on the straight line (lerp/slerp) and re-solve the joints for it —
   * mirrors IKPath.cs DriveLinear. An unreachable step hands the remaining
   * motion over to joint-space PTP (never freeze mid-path).
   */
  private stepLinear(dt: number): void {
    const target = this._linTarget!;
    const profile = this._linProfile;
    profile.distance = this._linDist; profile.position = this._linPos;
    profile.speed = this._linSpeed; profile.decel = this._linDecel;
    const frac = linProfileStep(profile, target.LinearSpeedToTarget, target.LinearAcceleration,
      dt, this.SpeedOverride, getDriveSpeedOverride(), profile);
    this._linPos = profile.position; this._linSpeed = profile.speed; this._linDecel = profile.decel;
    const end = frac >= 1;
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
      this.linFallback(angles ? 'step-jump' : 'step-unreachable');
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
      // plan-673 Phase 4: on a DYNAMIC axis `commandAxisPosition` writes the
      // setpoint and leaves the position to the physics; `positionOverwrite`
      // stays with the physics authority in both branches. On a kinematic axis
      // this is byte-for-byte the old behaviour. A LIN segment is already a
      // per-tick stream of poses, so it needs no ramp of its own — the
      // interpolation IS the ramp.
      if (isDynamicAxis(d)) {
        d.targetPosition = a;
        commandAxisPosition(d, a);
        continue;
      }
      if (end) {
        // Final pose: snap, mark at-target so the arrival poll advances the
        // path on the next tick (same ≥1-tick guarantee as PTP).
        d.positionOverwrite = false;
        commandAxisPosition(d, a, true);
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

  /**
   * plan-673 Phase 4 — one step of the PTP setpoint ramp on the dynamic axes.
   *
   * The setpoint moves toward the destination at the segment speed and stops
   * there; what the axis does with it is the physics' answer, which is the
   * whole point. The ramp is deliberately velocity-limited only and carries no
   * acceleration profile: the drive's own acceleration shaping belongs to its
   * motion integration, which a dynamic axis does not run, and a force-limited
   * actuator already rounds off the start of a move by saturating. Adding a
   * second S-curve here would shape a command whose execution is governed by
   * `forcerange` anyway.
   */
  private stepDynamicPtp(dt: number): void {
    let running = false;
    for (let i = 0; i < this._axisDrives.length; i++) {
      const speed = this._ptpRampSpeed[i] ?? 0;
      if (speed <= 0) continue;
      const drive = this._axisDrives[i];
      const dest = this._ptpDest[i];
      const from = Number.isFinite(drive.commandedPosition) ? drive.commandedPosition : drive.currentPosition;
      if (from === dest) continue;
      const step = speed * dt * Math.max(getDriveSpeedOverride(), 0);
      const next = from < dest ? Math.min(dest, from + step) : Math.max(dest, from - step);
      commandAxisPosition(drive, next);
      if (next !== dest) running = true;
    }
    this._ptpRampActive = running;
  }

  /** Largest per-axis angular distance (deg, 360°-unwrapped) between a solve
   *  result and the drives' CURRENT positions — the configuration-jump metric
   *  for the LIN guard rail. */
  private maxJumpFromCurrent(angles: number[]): number {
    for (let i = 0; i < 6; i++) this._seed[i] = this._axisDrives[i].currentPosition;
    return linMaxJump(angles, this._seed);
  }

  /** Solve the joints for a robot-local TCP pose, routed by wrist type; warm
   *  start + closest-selection use the CURRENT drive angles (previous step) for
   *  step-to-step continuity — Unity references the previous target's AxisPos
   *  instead (IKPath.cs:1249-1252), which is equivalent at the segment start
   *  and strictly less continuous mid-segment. Returns the selected angles or null. */
  private solveStep(pos: Vector3, quat: Quaternion): number[] | null {
    const robot = this._robot;
    if (!robot) return null;
    this._p3[0] = pos.x; this._p3[1] = pos.y; this._p3[2] = pos.z;
    this._q4[0] = quat.x; this._q4[1] = quat.y; this._q4[2] = quat.z; this._q4[3] = quat.w;
    for (let i = 0; i < 6; i++) this._seed[i] = this._axisDrives[i].currentPosition;
    return linSolveStep(robot, this._p3, this._q4, this._seed, this._warm, this._cobotOpts);
  }

  private atTarget(): void {
    const target = this.CurrentTarget;
    if (target) {
      if (this._observedTarget === 'moved') this.emitRun('target-reached', this.NumTarget);
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
    // plan-673 Phase 4: a running setpoint ramp means the COMMAND has not
    // arrived yet. Without this a dynamic axis that happens to pass close to
    // its destination early would advance the path mid-move.
    if (this._ptpRampActive) return false;
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

    // plan-673 Phase 4 — advance the setpoint ramp of the dynamic axes of a
    // PTP segment. Runs BEFORE the arrival poll so the last ramp step and the
    // arrival are not one tick apart.
    if (this._ptpRampActive) this.stepDynamicPtp(dt);

    // PTP motion in progress — poll axis drives.
    if (this._activeMoving && this.allAxesAtTarget()) {
      this._activeMoving = false;
      this.atTarget();
    }
  }

  /** Reset to idle (used by RVIKPathStep.reset and engine reset). */
  reset(): void {
    const wasActive = this.PathIsActive;
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
    this._ptpRampActive = false;
    if (wasActive) this.emitRun('cancelled');
  }

  /**
   * plan-538 F1g — stop the path NOW: back to idle like {@link reset}, every
   * axis it was moving stopped and held (a LIN segment's position overwrite
   * included), and the start edge disarmed against the CURRENT trigger level —
   * a held `StartPath` / `SignalStart` must not restart the path on the next
   * tick. A later genuine rising edge starts it again.
   */
  cancel(): void {
    const wasActive = this.PathIsActive || this._linActive || this._activeMoving;
    this.reset();
    if (wasActive) {
      for (const drive of this._axisDrives) {
        // plan-673 Phase 4: a dynamic axis keeps its physics authority and its
        // last SETPOINT — the actuator then holds the axis where it was
        // commanded, working against gravity. Clearing `positionOverwrite`
        // would hand it back to an integration that was never running, and
        // snapping the setpoint to the measured position would be a step input
        // the size of the following error.
        if (isDynamicAxis(drive)) {
          drive.targetPosition = Number.isFinite(drive.commandedPosition)
            ? drive.commandedPosition
            : drive.currentPosition;
          continue;
        }
        drive.positionOverwrite = false;
        drive.stop();
        drive.targetPosition = drive.currentPosition;
      }
    }
    this._startBefore = this.StartPath || this._startSignalValue;
  }

  /** Resolved, ordered target list (read-only) — used by the path visualizer. */
  get axesAvailable(): number { return this._axisDrives.length; }

  /** Signal being awaited, captured before cancel clears the state machine. */
  get waitingFor(): string | null { return this.WaitForSignal ? this._waitSignalAddr : null; }

  /** Resolved, ordered target list (read-only) — used by the path visualizer. */
  get targets(): readonly RVIKTarget[] { return this._path; }

  /** The parent robot this path belongs to, or null — the web pendant of
   *  Unity's `IKPath.RobotIK ?? GetComponentInParent<RobotIK>()`. Resolved once
   *  in `init()`; read by the LIN replay and by the program export (plan-773). */
  get robot(): RVRobotIK | null { return this._robot; }

  /** The chained `StartNextPath`, or null. Read-only: the chain is authored in
   *  the file, and the program export (plan-773 F16) walks it with its own
   *  cycle guard exactly like `IKPathToProgram.cs:67`. */
  get nextPath(): RVIKPath | null { return this._startNextPath; }

  /** Re-resolve the ordered target list from the (possibly overridden) raw
   *  `IKPath.Path` extras. Called from init() and again after op-created target
   *  nodes are added on scene load (they don't exist yet when init() first runs). */
  rebuildTargets(registry: NodeRegistry): void {
    const raw = (this.node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined)?.['IKPath'] ?? {};
    const pathArr = Array.isArray(raw['Path']) ? (raw['Path'] as unknown[]) : [];
    this._path = pathArr
      .filter(isRef)
      .map((ref) => resolveComp<RVIKTarget>(registry, 'IKTarget', storedReferenceValue(ref), this.node))
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
    this._runListeners.clear();
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
  // plan-769 Phase 3: THE guard — every stored form (path, address, kept path).
  return isComponentReference(v);
}

/** Resolve a component by path, robust against undefined paths and Three.js node
 *  renames (duplicate-name dedup): falls back to node lookup → current path.
 *
 *  plan-769 Phase 1b: with `referrer` (the node whose extras hold the reference)
 *  the path is a STORED reference — read by its file's verdict (address /
 *  migration; a typed miss on the named node is a miss), and the lookups below
 *  run only for a path the file does not carry. */
export function resolveComp<T>(
  registry: NodeRegistry,
  type: string,
  path: StoredReferenceValue | string | null | undefined,
  referrer?: Object3D | null,
): T | null {
  if (path === null || path === undefined || path === '') return null;
  if (referrer) {
    return registry.storedComponent<T>(referrer, path, type, {
      legacy: (p) => resolveComp<T>(registry, type, p),
    });
  }
  // An address names its target relative to a referrer's document — without one it
  // names nothing (plan-769 Phase 3).
  if (typeof path !== 'string') return null;
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
    .map((ref) => resolveComp<RVDrive>(registry, 'Drive', storedReferenceValue(ref), node))
    .filter((d): d is RVDrive => d != null);
}

registerComponent({
  type: 'IKPath',
  schema: RVIKPath.schema,
  capabilities: { pick: 'select', ui: { badge: '#ba68c8', filter: 'IK Paths', category: 'robotics' } },
  create: (node: Object3D) => new RVIKPath(node),
});
