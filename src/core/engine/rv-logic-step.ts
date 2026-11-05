// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { RVDrive } from './rv-drive';
import {
  createSignalWriter,
  type SignalStore,
  type SignalWriter,
} from './rv-signal-store';
import type { RVSensor } from './rv-sensor';
import type { RVGrip } from './rv-grip';
import type { RVZone } from './rv-zone';
import { debug } from './rv-debug';
import { scaleSimDt } from './rv-speed-override';
import { isSignalLiveControlled } from './rv-slot-authority';
import type { RVLogicEngine } from './rv-logic-engine';
import { reportProblem } from '../hmi/problems-store';

// ─── Step State ──────────────────────────────────────────────────

export enum StepState {
  Idle = 'Idle',
  Active = 'Active',
  Waiting = 'Waiting',
  Finished = 'Finished',
}

// ─── Root context (plan-538) ─────────────────────────────────────

/**
 * What a step sees of the top-level root it belongs to (plan-538 F1d/F1f).
 * Set by `RVLogicEngine` on every step of a registered root. A step that
 * commands a drive reports it here, so the engine knows which root moved the
 * axis LAST — deactivating a root only stops drives it still commands, never a
 * drive an active root took over since.
 */
export interface LogicRootContext {
  readonly engine?: RVLogicEngine;
  readonly root?: RVLogicStep;
  /** Record that `drive` was just commanded by a step of this root. */
  noteDriveCommand(drive: RVDrive): void;
  /** True when the LAST command on `drive` came from a step of this root. */
  isLastCommander(drive: RVDrive): boolean;
}

function readSignal(step: RVLogicStep, store: SignalStore, path: string): boolean | number | undefined {
  return step.rootContext?.engine?.eventImage?.get(store.nameForPath(path) ?? path) ?? store.getByPath(path);
}
function readFloat(step: RVLogicStep, store: SignalStore, path: string): number {
  const v = readSignal(step, store, path);
  return typeof v === 'number' ? v : 0;
}

const evT = (s: RVLogicStep): number | null => {
  const e = s.rootContext?.engine;
  return e ? e.eventTime ?? e.desHooks?.now() ?? null : null;
};
const clock = (s: RVLogicStep): number => evT(s) ?? performance.now() / 1000;

export const LOGIC_MAX_INSTANT_TRANSITIONS = 10_000;

/** Optional edge mode of `LogicStep_WaitForSignalBool` (plan-538 F5). */
export type SignalEdge = 'Level' | 'Rising' | 'Falling';

/** Parse the `Edge` field; anything unknown is `'Level'` (today's behaviour). */
export function parseSignalEdge(raw: unknown): SignalEdge {
  return raw === 'Rising' || raw === 'Falling' ? raw : 'Level';
}

// ─── Base Class ──────────────────────────────────────────────────

export abstract class RVLogicStep {
  state: StepState = StepState.Idle;
  /** Why an otherwise successful step finished without applying its command. */
  reason?: 'suppressed-live';
  name = '';
  /** Full hierarchy path (set by engine during build) */
  hierarchyPath = '';
  /** Root this step belongs to — set by the engine (plan-538), null for a loose step. */
  rootContext: LogicRootContext | null = null;

  /**
   * True for a step type that starts motion (a drive, a robot path). A root
   * whose `Active` is not `Always` warns at load for such a step WITHOUT a
   * {@link cancel} hook — deactivating the root could not stop its motion.
   */
  get startsMotion(): boolean { return false; }

  /**
   * Optional cancel hook (plan-538 F1g): called by the engine when the root is
   * DEACTIVATED, BEFORE the root is reset to Idle. Stops the motion this step
   * started and that is still running; later ticks must not move it again.
   */
  cancel?(): void;

  /** Called by container when this step should begin executing */
  abstract start(): void;

  /** Called every fixed timestep while state === Active or Waiting */
  abstract fixedUpdate(dt: number): void;

  /** Progress percentage (0-100). Subclasses must implement. */
  abstract get progress(): number;

  /** Call to mark step as finished. Container advances on next update. */
  protected finish(): void {
    this.state = StepState.Finished;
  }

  /** Finish while documenting that live control suppressed the internal command. */
  protected finishSuppressedLive(): void {
    this.reason = 'suppressed-live';
    this.finish();
  }

  /** Reset step to idle (for container restart) */
  reset(): void {
    this.state = StepState.Idle;
    this.reason = undefined;
  }
}

// ─── Containers ──────────────────────────────────────────────────

/** Web-native step completed explicitly by a sandboxed WebComponent script. */
export class RVJavaScriptStep extends RVLogicStep {
  runId = 0;
  start(): void { this.runId++; this.state = StepState.Active; }
  fixedUpdate(_dt: number): void { /* The web script host drives execution. */ }
  complete(): void {
    if (this.state !== StepState.Active) throw new Error('JavaScript step is not active');
    this.finish();
  }
  get progress(): number { return this.state === StepState.Finished ? 100 : 0; }
}

/** Executes children in order, optionally restarting after the last finishes. */
export class RVSerialContainer extends RVLogicStep {
  children: RVLogicStep[];
  currentIndex = 0;
  autoLoop: boolean;
  completedCycles = 0;

  // Cycle time statistics
  private cycleStartTime = 0;
  private cycleTimes: number[] = [];

  constructor(children: RVLogicStep[], autoLoop = true) {
    super();
    this.children = children;
    this.autoLoop = autoLoop;
  }

  get minCycleTime(): number {
    return this.cycleTimes.length ? Math.min(...this.cycleTimes) : 0;
  }

  get maxCycleTime(): number {
    return this.cycleTimes.length ? Math.max(...this.cycleTimes) : 0;
  }

  get medianCycleTime(): number {
    if (!this.cycleTimes.length) return 0;
    const sorted = [...this.cycleTimes].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  get progress(): number {
    if (this.children.length === 0) return 0;
    if (this.state === StepState.Finished) return 100;
    if (this.state === StepState.Idle) return 0;
    const width = 100 / this.children.length;
    const childProgress = this.currentIndex < this.children.length
      ? this.children[this.currentIndex].progress
      : 0;
    return this.currentIndex * width + childProgress / this.children.length;
  }

  start(): void {
    this.state = StepState.Active;
    this.currentIndex = 0;
    this.cycleStartTime = clock(this);
    if (this.children.length === 0) {
      console.warn(`[LogicStep] SerialContainer "${this.name}" has 0 children — finishing immediately`);
      this.finish();
      return;
    }
    this.startChild(0);
  }

  fixedUpdate(dt: number): void {
    if (this.state !== StepState.Active) return;
    if (this.currentIndex >= this.children.length) return;

    const child = this.children[Math.max(0, this.currentIndex)];

    // Update active or waiting child
    if (child.state === StepState.Active || child.state === StepState.Waiting) {
      child.fixedUpdate(dt);
      if (this.rootContext?.root?.state === StepState.Finished) return;
    }

    // Check if child finished -> advance
    if (child.state === StepState.Finished) {
      this.currentIndex++;

      // Start next child (may finish immediately -> keep advancing). Read the started child BEFORE
      // starting it: a JumpOnSignal moves currentIndex to target-1 inside start(), and re-reading
      // children[currentIndex] afterwards stalled a forward jump on a never-started step and read
      // children[-1] on a jump to the first step.
      let transitions = 0;
      while (this.currentIndex < this.children.length) {
        if (++transitions > LOGIC_MAX_INSTANT_TRANSITIONS) {
          this.finish();
          this.reason = undefined;
          const root = this.rootContext?.root ?? this;
          const t = evT(this);
          this.rootContext?.engine?.haltRoot(root, 'logic-instant-loop');
          reportProblem({ id: `logic-instant-loop:${this.hierarchyPath}`, code: 'logic-instant-loop',
            severity: 'error', title: 'Logic instant transition limit exceeded',
            detail: `${root.name}: ${this.hierarchyPath}`, nodePath: this.hierarchyPath,
            at: t === null ? undefined : t * 1000 });
          return;
        }
        const next = this.children[this.currentIndex];
        this.startChild(this.currentIndex);
        if (next.state === StepState.Finished) {
          this.currentIndex++;
        } else {
          return; // Next child is Active or Waiting, wait for it
        }
      }

      // All children done — record cycle time
      const cycleTime = clock(this) - this.cycleStartTime;
      this.cycleTimes.push(cycleTime);
      this.completedCycles++;
      debug('logic', `[${this.name}] cycle #${this.completedCycles} complete (${cycleTime.toFixed(3)}s)`);
      if (this.autoLoop) {
        // Reset all children and restart
        for (const c of this.children) c.reset();
        this.currentIndex = 0;
        this.cycleStartTime = clock(this);
        this.startChild(0);
      } else {
        this.finish();
      }
    }
  }

  private startChild(index: number): void {
    const child = this.children[index];
    child.reset();
    child.start();
    debug('logic', `[${this.name}] step ${index}/${this.children.length}: "${child.name}" -> ${child.state}`);
  }

  reset(): void {
    super.reset();
    this.currentIndex = 0;
    for (const c of this.children) c.reset();
  }
}

/**
 * ParallelContainer - Executes all children simultaneously.
 * Finishes when all children have finished.
 */
export class RVParallelContainer extends RVLogicStep {
  children: RVLogicStep[];
  finishedCount = 0;

  constructor(children: RVLogicStep[]) {
    super();
    this.children = children;
  }

  get progress(): number {
    if (this.children.length === 0) return 0;
    if (this.state === StepState.Finished) return 100;
    if (this.state === StepState.Idle) return 0;
    return Math.min(...this.children.map(c => c.progress));
  }

  start(): void {
    this.state = StepState.Active;
    this.finishedCount = 0;

    if (this.children.length === 0) {
      this.finish();
      return;
    }

    for (const child of this.children) {
      child.start();
      if (child.state === StepState.Finished) {
        this.finishedCount++;
      }
    }

    if (this.finishedCount >= this.children.length) {
      this.finish();
    }
  }

  fixedUpdate(dt: number): void {
    if (this.state !== StepState.Active) return;

    for (const child of this.children) {
      if (child.state === StepState.Active || child.state === StepState.Waiting) {
        child.fixedUpdate(dt);
        if (this.rootContext?.root?.state === StepState.Finished) return;
        // Re-check state after fixedUpdate (step may have called finish())
        if ((child.state as StepState) === StepState.Finished) {
          this.finishedCount++;
        }
      }
    }

    if (this.finishedCount >= this.children.length) {
      this.finish();
    }
  }

  reset(): void {
    super.reset();
    this.finishedCount = 0;
    for (const c of this.children) c.reset();
  }
}

// ─── Leaf Steps ──────────────────────────────────────────────────

/** Delay - waits for a specified duration in seconds */
export class RVDelay extends RVLogicStep {
  duration: number;
  elapsed = 0;
  startT = 0;

  constructor(duration: number) {
    super();
    this.duration = duration;
  }

  get progress(): number {
    if (this.state === StepState.Finished) return 100;
    if (this.state === StepState.Idle) return 0;
    return this.duration > 0 ? (this.elapsed / this.duration) * 100 : 0;
  }

  start(): void {
    this.state = StepState.Active;
    this.elapsed = 0;
    this.startT = evT(this) ?? 0;
    if (this.duration <= 0) {
      this.finish();
    }
  }

  fixedUpdate(dt: number): void {
    if (this.state !== StepState.Active) return;
    const t = evT(this);
    this.elapsed = t === null ? this.elapsed + scaleSimDt(dt) : t - this.startT;
    if (t === null ? this.elapsed >= this.duration : t - this.startT >= this.duration) {
      this.finish();
    }
  }

  reset(): void {
    super.reset();
    this.elapsed = 0;
  }
}

/** SetSignalBool - sets a boolean signal and finishes immediately */
export class RVSetSignalBool extends RVLogicStep {
  signalAddress: string | null;
  value: boolean;
  private signalStore: SignalStore;
  private signalWriter: SignalWriter;
  private targetName: string | null;

  constructor(signalAddress: string | null, value: boolean, signalStore: SignalStore) {
    super();
    this.signalAddress = signalAddress;
    this.value = value;
    this.signalStore = signalStore;
    this.signalWriter = createSignalWriter(
      signalStore,
      `component:LogicStep:SetSignalBool:${signalAddress ?? 'unbound'}`,
      'component',
      signalAddress ? { slotContext: signalAddress } : undefined,
    );
    this.targetName = signalAddress
      ? (signalStore.nameForPath(signalAddress) ?? signalAddress)
      : null;
  }

  get progress(): number {
    return this.state === StepState.Finished ? 100 : 0;
  }

  start(): void {
    if (!this.signalAddress) {
      console.warn(`[LogicStep] SetSignalBool "${this.name}": null signal address — skipping`);
      this.state = StepState.Finished;
      return;
    }
    if (this.targetName && isSignalLiveControlled(this.targetName)) {
      this.finishSuppressedLive();
      return;
    }
    this.signalWriter.setByPath(this.signalAddress, this.value);
    debug('logic', `SetSignalBool "${this.name}": ${this.signalAddress} = ${this.value}`);
    this.state = StepState.Finished;
  }

  fixedUpdate(_dt: number): void {}
}

/**
 * WaitForSignalBool - waits until a boolean signal matches the expected value.
 *
 * plan-538 F5 — `edge`:
 * - `'Level'` (default, today's behaviour): finishes as soon as the signal
 *   equals `waitForTrue` — immediately when it already does at start.
 * - `'Rising'` / `'Falling'`: the value is sampled at step start; the step
 *   finishes on the FIRST false→true (true→false) transition after that. An
 *   already-high (low) level at start does not count. `waitForTrue` is
 *   ignored. Transitions are caught through a store subscription while the
 *   step waits, so a pulse shorter than one tick is not lost.
 */
export class RVWaitForSignalBool extends RVLogicStep {
  signalAddress: string | null;
  waitForTrue: boolean;
  readonly edge: SignalEdge;
  private signalStore: SignalStore;
  /** Last value seen by the edge detector (sampled at start). */
  private _edgePrev = false;
  /** Latched: the wanted transition happened while waiting. */
  private _edgeSeen = false;
  private _edgeUnsub: (() => void) | null = null;
  /** Created once — no closure allocation per start. */
  private readonly _onEdgeValue = (value: boolean | number): void => {
    const cur = value === true;
    if (this.edge === 'Rising' ? (!this._edgePrev && cur) : (this._edgePrev && !cur)) this._edgeSeen = true;
    this._edgePrev = cur;
  };

  constructor(signalAddress: string | null, waitForTrue: boolean, signalStore: SignalStore, edge: SignalEdge = 'Level') {
    super();
    this.signalAddress = signalAddress;
    this.waitForTrue = waitForTrue;
    this.signalStore = signalStore;
    this.edge = edge;
  }

  get progress(): number {
    if (this.state === StepState.Finished) return 100;
    if (this.state === StepState.Waiting) return 50;
    return 0;
  }

  start(): void {
    if (!this.signalAddress) {
      console.warn(`[LogicStep] WaitForSignalBool "${this.name}": null signal address — skipping`);
      this.state = StepState.Finished;
      return;
    }
    this.state = StepState.Waiting;
    if (this.edge !== 'Level') {
      // Sample at start; only a transition AFTER this point finishes the step.
      this._dropEdgeSubscription();
      this._edgePrev = this.signalStore.getBoolByPath(this.signalAddress);
      this._edgeSeen = false;
      this._edgeUnsub = this.signalStore.subscribeByPath(this.signalAddress, this._onEdgeValue);
      return;
    }
    // Check immediately
    if ((readSignal(this, this.signalStore, this.signalAddress) === true) === this.waitForTrue) {
      this.finish();
    }
  }

  fixedUpdate(_dt: number): void {
    if (this.state !== StepState.Waiting || !this.signalAddress) return;
    if (this.edge !== 'Level') {
      // Polling fallback for a store without notification on this path.
      this._onEdgeValue(this.signalStore.getBoolByPath(this.signalAddress));
      if (this._edgeSeen) {
        debug('logic', `WaitForSignalBool "${this.name}": ${this.signalAddress} ${this.edge} edge`);
        this.finish();
      }
      return;
    }
    if ((readSignal(this, this.signalStore, this.signalAddress) === true) === this.waitForTrue) {
      debug('logic', `WaitForSignalBool "${this.name}": ${this.signalAddress} matched (${this.waitForTrue})`);
      this.finish();
    }
  }

  protected finish(): void {
    this._dropEdgeSubscription();
    super.finish();
  }

  reset(): void {
    super.reset();
    this._dropEdgeSubscription();
    this._edgeSeen = false;
  }

  private _dropEdgeSubscription(): void {
    if (this._edgeUnsub) {
      this._edgeUnsub();
      this._edgeUnsub = null;
    }
  }
}

/** WaitForSensor - polls until a sensor matches the expected occupied state */
export class RVWaitForSensor extends RVLogicStep {
  sensor: RVSensor | null;
  waitForOccupied: boolean;

  constructor(sensor: RVSensor | null, waitForOccupied: boolean, readonly waitForStopped = false) {
    super();
    this.sensor = sensor;
    this.waitForOccupied = waitForOccupied;
  }

  get progress(): number {
    if (this.state === StepState.Finished) return 100;
    if (this.state === StepState.Waiting) return 50;
    return 0;
  }

  start(): void {
    if (!this.sensor) {
      console.warn(`[LogicStep] WaitForSensor "${this.name}": null sensor — skipping`);
      this.state = StepState.Finished;
      return;
    }
    this.state = StepState.Waiting;
    if (this.matches()) {
      this.finish();
    }
  }

  fixedUpdate(_dt: number): void {
    if (this.state !== StepState.Waiting || !this.sensor) return;
    if (this.matches()) {
      debug('logic', `WaitForSensor "${this.name}": sensor "${this.sensor.node.name}" ${this.waitForOccupied ? 'occupied' : 'cleared'}`);
      this.finish();
    }
  }

  private matches(): boolean {
    return this.sensor?.occupied === this.waitForOccupied
      && (!this.waitForOccupied || !this.waitForStopped || this.sensor?.occupiedMU?.blocked === true);
  }
}

/**
 * WaitForZone (plan-521) — waits until a Zone reports occupied (or free).
 * Reads the zone's Detect result (`RVZone.occupied`); pattern RVWaitForSensor.
 * A missing zone reference is reported (warning) and the step finishes, so a
 * broken reference never stalls the sequence silently.
 */
export class RVWaitForZone extends RVLogicStep {
  zone: RVZone | null;
  waitForOccupied: boolean;

  constructor(zone: RVZone | null, waitForOccupied: boolean) {
    super();
    this.zone = zone;
    this.waitForOccupied = waitForOccupied;
  }

  get progress(): number {
    if (this.state === StepState.Finished) return 100;
    if (this.state === StepState.Waiting) return 50;
    return 0;
  }

  start(): void {
    if (!this.zone) {
      console.warn(`[LogicStep] WaitForZone "${this.name}": no Zone referenced — skipping`);
      this.state = StepState.Finished;
      return;
    }
    this.state = StepState.Waiting;
    if (this.zone.occupied === this.waitForOccupied) this.finish();
  }

  fixedUpdate(_dt: number): void {
    if (this.state !== StepState.Waiting || !this.zone) return;
    if (this.zone.occupied === this.waitForOccupied) {
      debug('logic', `WaitForZone "${this.name}": zone "${this.zone.node.name}" ${this.waitForOccupied ? 'occupied' : 'free'}`);
      this.finish();
    }
  }
}

/**
 * DriveTo - moves a drive to a target position, finishes when reached.
 *
 * `destinationSignal` mirrors Unity `LogicStep_DriveTo.DestinationFromPLCOutput`
 * (plan-2016 S3): when the drive and the signal are set and the signal's value
 * at construction (= Unity `Awake`, signals already initialised) is not 0, the
 * signal becomes the destination source (`valueBySignal`) and `destination`
 * follows it on every start and every fixed update. As in Unity, a change during
 * a running move updates `destination` but does not re-command that move; it
 * takes effect on the next start. A signal that is 0 at construction is never
 * followed — `Destination` stays the target.
 */
export class RVDriveTo extends RVLogicStep {
  drive: RVDrive | null;
  destination: number;
  relative: boolean;
  /** Signal address of `DestinationFromPLCOutput`, or null. */
  readonly destinationSignal: string | null;
  /** True when the destination is taken from `destinationSignal` (Unity `ValueBySignal`). */
  readonly valueBySignal: boolean;
  private readonly signalStore: SignalStore | null;
  private startPosition = 0;
  private targetPosition = 0;

  constructor(
    drive: RVDrive | null,
    destination: number,
    relative: boolean,
    destinationSignal: string | null = null,
    signalStore: SignalStore | null = null,
  ) {
    super();
    this.drive = drive;
    this.destination = destination;
    this.relative = relative;
    this.destinationSignal = destinationSignal;
    this.signalStore = signalStore;
    let bySignal = false;
    if (drive && destinationSignal && signalStore) {
      const v = signalStore.getFloatByPath(destinationSignal);
      if (v !== 0) {
        this.destination = v;
        bySignal = true;
      }
    }
    this.valueBySignal = bySignal;
  }

  /** Unity FixedUpdate parity: follow the destination signal while `valueBySignal`. */
  private syncDestinationFromSignal(): void {
    if (!this.valueBySignal) return;
    this.destination = readFloat(this, this.signalStore!, this.destinationSignal!);
  }

  get progress(): number {
    if (this.state === StepState.Finished) return 100;
    if (this.state === StepState.Idle || !this.drive) return 0;
    const totalDelta = Math.abs(this.targetPosition - this.startPosition);
    if (totalDelta < 0.001) return 100;
    const currentDelta = Math.abs(this.drive.currentPosition - this.startPosition);
    return Math.min(100, (currentDelta / totalDelta) * 100);
  }

  start(): void {
    if (!this.drive) {
      console.warn(`[LogicStep] DriveTo "${this.name}": null drive — skipping`);
      this.state = StepState.Finished;
      return;
    }
    if (this.drive.liveControlled) {
      this.finishSuppressedLive();
      return;
    }

    this.syncDestinationFromSignal();
    this.startPosition = this.drive.currentPosition;

    let dest = this.relative
      ? this.drive.currentPosition + this.destination
      : this.destination;

    // Clamp to drive limits
    if (this.drive.UseLimits) {
      dest = Math.max(this.drive.LowerLimit, Math.min(this.drive.UpperLimit, dest));
    }

    this.targetPosition = dest;
    this.drive.startMove(dest);
    this.rootContext?.noteDriveCommand(this.drive);
    this.state = StepState.Active;

    // Check if already at target
    if (this.drive.isAtTarget) {
      this.finish();
    }
  }

  fixedUpdate(_dt: number): void {
    this.syncDestinationFromSignal();
    if (this.state !== StepState.Active || !this.drive) return;
    if (this.drive.liveControlled) {
      this.finishSuppressedLive();
      return;
    }
    if (this.drive.isAtTarget) {
      this.finish();
    }
  }

  get startsMotion(): boolean { return true; }

  /** plan-538 F1g — a running move of this step stops and holds its position. */
  cancel(): void {
    const drive = this.drive;
    if (!drive || this.state !== StepState.Active) return;
    if (this.rootContext && !this.rootContext.isLastCommander(drive)) return;
    holdDrive(drive);
  }
}

/**
 * Stop a drive and hold it where it stands (plan-538 F1d): no running move,
 * no jog, the target set to the current position so a later `startMove()`
 * without argument cannot resume the old destination.
 */
export function holdDrive(drive: RVDrive): void {
  drive.positionOverwrite = false;
  drive.stop();
  drive.targetPosition = drive.currentPosition;
}

/** SetDriveSpeed - changes a drive's target speed and finishes immediately */
export class RVSetDriveSpeed extends RVLogicStep {
  drive: RVDrive | null;
  speed: number;

  constructor(drive: RVDrive | null, speed: number) {
    super();
    this.drive = drive;
    this.speed = speed;
  }

  get progress(): number {
    return this.state === StepState.Finished ? 100 : 0;
  }

  start(): void {
    if (!this.drive) {
      console.warn(`[LogicStep] SetDriveSpeed "${this.name}": null drive — skipping`);
      this.state = StepState.Finished;
      return;
    }
    if (this.drive.liveControlled) {
      this.finishSuppressedLive();
      return;
    }
    this.drive.targetSpeed = this.speed;
    this.state = StepState.Finished;
  }

  fixedUpdate(_dt: number): void {}
}

/** Enable - enables/disables a Three.js Object3D (visibility) and finishes immediately */
export class RVEnable extends RVLogicStep {
  readonly target: { visible: boolean } | null;
  readonly enable: boolean;

  constructor(target: { visible: boolean } | null, enable: boolean) {
    super();
    this.target = target;
    this.enable = enable;
  }

  get progress(): number {
    return this.state === StepState.Finished ? 100 : 0;
  }

  start(): void {
    if (this.target) {
      this.target.visible = this.enable;
    }
    this.state = StepState.Finished;
  }

  fixedUpdate(_dt: number): void {}
}

/** StartDriveTo - starts a drive move and finishes immediately (non-blocking) */
export class RVStartDriveTo extends RVLogicStep {
  drive: RVDrive | null;
  destination: number;
  relative: boolean;

  constructor(drive: RVDrive | null, destination: number, relative: boolean) {
    super();
    this.drive = drive;
    this.destination = destination;
    this.relative = relative;
  }

  get progress(): number {
    return this.state === StepState.Finished ? 100 : 0;
  }

  start(): void {
    if (!this.drive) {
      console.warn(`[LogicStep] StartDriveTo "${this.name}": null drive — skipping`);
      this.state = StepState.Finished;
      return;
    }
    if (this.drive.liveControlled) {
      this.finishSuppressedLive();
      return;
    }

    let dest = this.relative
      ? this.drive.currentPosition + this.destination
      : this.destination;

    if (this.drive.UseLimits) {
      dest = Math.max(this.drive.LowerLimit, Math.min(this.drive.UpperLimit, dest));
    }

    this.drive.startMove(dest);
    this._commandedTarget = dest;
    this.rootContext?.noteDriveCommand(this.drive);
    debug('logic', `StartDriveTo "${this.name}": drive → ${dest}`);
    this.state = StepState.Finished;
  }

  fixedUpdate(_dt: number): void {}

  /** Target of the move this step started (survives the container's per-cycle reset). */
  private _commandedTarget: number | null = null;

  get startsMotion(): boolean { return true; }

  /**
   * plan-538 F1g — the step finishes at once, but the move it started keeps
   * running: stop it while it is still under way toward this step's target and
   * no other root commanded the drive since.
   */
  cancel(): void {
    const drive = this.drive;
    const target = this._commandedTarget;
    this._commandedTarget = null;
    if (!drive || target === null || !drive.isRunning || drive.targetPosition !== target) return;
    if (this.rootContext && !this.rootContext.isLastCommander(drive)) return;
    holdDrive(drive);
  }
}

/** WaitForDrivesAtTarget - waits until all drives in the list have reached their targets */
export class RVWaitForDrivesAtTarget extends RVLogicStep {
  drives: RVDrive[];

  constructor(drives: RVDrive[]) {
    super();
    this.drives = drives;
  }

  get progress(): number {
    if (this.state === StepState.Finished) return 100;
    if (this.drives.length === 0) return 100;
    const atTarget = this.drives.filter(d => d.liveControlled || d.isAtTarget).length;
    return (atTarget / this.drives.length) * 100;
  }

  start(): void {
    if (this.drives.length === 0) {
      this.state = StepState.Finished;
      return;
    }
    this.state = StepState.Waiting;
    if (this.drives.every(d => d.liveControlled || d.isAtTarget)) {
      this.finish();
    }
  }

  fixedUpdate(_dt: number): void {
    if (this.state !== StepState.Waiting) return;
    if (this.drives.every(d => d.liveControlled || d.isAtTarget)) {
      debug('logic', `WaitForDrivesAtTarget "${this.name}": all ${this.drives.length} drives at target`);
      this.finish();
    }
  }
}

/** SetSignalFloat - sets a float signal value and finishes immediately */
export class RVSetSignalFloat extends RVLogicStep {
  signalAddress: string | null;
  value: number;
  private signalStore: SignalStore;
  private signalWriter: SignalWriter;
  private targetName: string | null;

  constructor(signalAddress: string | null, value: number, signalStore: SignalStore) {
    super();
    this.signalAddress = signalAddress;
    this.value = value;
    this.signalStore = signalStore;
    this.signalWriter = createSignalWriter(
      signalStore,
      `component:LogicStep:SetSignalFloat:${signalAddress ?? 'unbound'}`,
      'component',
      signalAddress ? { slotContext: signalAddress } : undefined,
    );
    this.targetName = signalAddress
      ? (signalStore.nameForPath(signalAddress) ?? signalAddress)
      : null;
  }

  get progress(): number {
    return this.state === StepState.Finished ? 100 : 0;
  }

  start(): void {
    if (!this.signalAddress) {
      console.warn(`[LogicStep] SetSignalFloat "${this.name}": null signal address — skipping`);
      this.state = StepState.Finished;
      return;
    }
    if (this.targetName && isSignalLiveControlled(this.targetName)) {
      this.finishSuppressedLive();
      return;
    }
    this.signalWriter.setByPath(this.signalAddress, this.value);
    debug('logic', `SetSignalFloat "${this.name}": ${this.signalAddress} = ${this.value}`);
    this.state = StepState.Finished;
  }

  fixedUpdate(_dt: number): void {}
}

/** WaitForSignalFloat - polls until a float signal matches the comparison condition */
export class RVWaitForSignalFloat extends RVLogicStep {
  signalAddress: string | null;
  comparison: string;
  value: number;
  tolerance: number;
  private signalStore: SignalStore;

  constructor(
    signalAddress: string | null,
    comparison: string,
    value: number,
    tolerance: number,
    signalStore: SignalStore,
  ) {
    super();
    this.signalAddress = signalAddress;
    this.comparison = comparison;
    this.value = value;
    this.tolerance = Math.max(tolerance, 0.0001);
    this.signalStore = signalStore;
  }

  get progress(): number {
    if (this.state === StepState.Finished) return 100;
    if (this.state === StepState.Waiting) return 50;
    return 0;
  }

  start(): void {
    if (!this.signalAddress) {
      console.warn(`[LogicStep] WaitForSignalFloat "${this.name}": null signal address — skipping`);
      this.state = StepState.Finished;
      return;
    }
    this.state = StepState.Waiting;
    if (this.checkCondition()) {
      this.finish();
    }
  }

  fixedUpdate(_dt: number): void {
    if (this.state !== StepState.Waiting || !this.signalAddress) return;
    if (this.checkCondition()) {
      debug('logic', `WaitForSignalFloat "${this.name}": ${this.signalAddress} matched (${this.comparison} ${this.value})`);
      this.finish();
    }
  }

  private checkCondition(): boolean {
    if (!this.signalAddress) return false;
    const current = readFloat(this, this.signalStore, this.signalAddress);
    switch (this.comparison) {
      case 'GreaterThan':    return current > this.value;
      case 'LessThan':       return current < this.value;
      case 'Equals':         return Math.abs(current - this.value) <= this.tolerance;
      case 'GreaterOrEqual': return current >= this.value;
      case 'LessOrEqual':    return current <= this.value;
      default:               return false;
    }
  }
}

/** GripPick - triggers a Grip pick operation, optionally waits for a gripped MU */
export class RVGripPick extends RVLogicStep {
  grip: RVGrip | null;
  blocking: boolean;

  constructor(grip: RVGrip | null, blocking: boolean) {
    super();
    this.grip = grip;
    this.blocking = blocking;
  }

  get progress(): number {
    if (this.state === StepState.Finished) return 100;
    if (this.state === StepState.Waiting) return 50;
    return 0;
  }

  start(): void {
    if (!this.grip) {
      console.warn(`[LogicStep] GripPick "${this.name}": null grip — skipping`);
      this.state = StepState.Finished;
      return;
    }
    this.grip.pick();
    debug('logic', `GripPick "${this.name}": pick() called, blocking=${this.blocking}`);
    if (!this.blocking || this.grip.grippedMUs.length > 0) {
      this.state = StepState.Finished;
    } else {
      this.state = StepState.Waiting;
    }
  }

  fixedUpdate(_dt: number): void {
    if (this.state !== StepState.Waiting || !this.grip) return;
    if (this.grip.grippedMUs.length > 0) {
      debug('logic', `GripPick "${this.name}": MU gripped`);
      this.finish();
    }
  }
}

/** GripPlace - triggers a Grip place operation, optionally waits for release */
export class RVGripPlace extends RVLogicStep {
  grip: RVGrip | null;
  blocking: boolean;

  constructor(grip: RVGrip | null, blocking: boolean) {
    super();
    this.grip = grip;
    this.blocking = blocking;
  }

  get progress(): number {
    if (this.state === StepState.Finished) return 100;
    if (this.state === StepState.Waiting) return 50;
    return 0;
  }

  start(): void {
    if (!this.grip) {
      console.warn(`[LogicStep] GripPlace "${this.name}": null grip — skipping`);
      this.state = StepState.Finished;
      return;
    }
    this.grip.place();
    debug('logic', `GripPlace "${this.name}": place() called, blocking=${this.blocking}`);
    if (!this.blocking || this.grip.grippedMUs.length === 0) {
      this.state = StepState.Finished;
    } else {
      this.state = StepState.Waiting;
    }
  }

  fixedUpdate(_dt: number): void {
    if (this.state !== StepState.Waiting || !this.grip) return;
    if (this.grip.grippedMUs.length === 0) {
      debug('logic', `GripPlace "${this.name}": all MUs released`);
      this.finish();
    }
  }
}

/** JumpOnSignal - conditional jump to a named step within the parent container */
export class RVJumpOnSignal extends RVLogicStep {
  signalAddress: string | null;
  jumpOn: boolean;
  jumpToStep: string;
  private signalStore: SignalStore;
  private parentContainer: RVSerialContainer | null;

  constructor(
    signalAddress: string | null,
    jumpOn: boolean,
    jumpToStep: string,
    signalStore: SignalStore,
    parentContainer: RVSerialContainer | null,
  ) {
    super();
    this.signalAddress = signalAddress;
    this.jumpOn = jumpOn;
    this.jumpToStep = jumpToStep;
    this.signalStore = signalStore;
    this.parentContainer = parentContainer;
  }

  get progress(): number {
    return this.state === StepState.Finished ? 100 : 0;
  }

  start(): void {
    if (!this.signalAddress) {
      console.warn(`[LogicStep] JumpOnSignal "${this.name}": null signal — skipping`);
      this.state = StepState.Finished;
      return;
    }
    const value = readSignal(this, this.signalStore, this.signalAddress) === true;
    if (value === this.jumpOn && this.parentContainer && this.jumpToStep) {
      const idx = this.parentContainer.children.findIndex(c => c.name === this.jumpToStep);
      if (idx >= 0) {
        debug('logic', `JumpOnSignal "${this.name}": jumping to "${this.jumpToStep}" (index ${idx})`);
        // Set currentIndex so the container will start this step next
        this.parentContainer.currentIndex = idx - 1; // container will increment after this step finishes
      } else {
        console.warn(`[LogicStep] JumpOnSignal "${this.name}": step "${this.jumpToStep}" not found`);
      }
    }
    this.state = StepState.Finished;
  }

  fixedUpdate(_dt: number): void {}
}
