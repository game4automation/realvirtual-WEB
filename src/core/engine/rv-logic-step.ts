// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { RVDrive } from './rv-drive';
import type { SignalStore } from './rv-signal-store';
import type { RVSensor } from './rv-sensor';
import type { RVGrip } from './rv-grip';
import { debug } from './rv-debug';

// ─── Step State ──────────────────────────────────────────────────

export enum StepState {
  Idle = 'Idle',
  Active = 'Active',
  Waiting = 'Waiting',
  Finished = 'Finished',
}

// ─── Base Class ──────────────────────────────────────────────────

export abstract class RVLogicStep {
  state: StepState = StepState.Idle;
  name = '';
  /** Full hierarchy path (set by engine during build) */
  hierarchyPath = '';

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

  /** Reset step to idle (for container restart) */
  reset(): void {
    this.state = StepState.Idle;
  }
}

// ─── Containers ──────────────────────────────────────────────────

/**
 * SerialContainer - Executes children one after another.
 * When autoLoop is true, restarts from first child after last finishes.
 */
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
    this.cycleStartTime = performance.now() / 1000;
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

    const child = this.children[this.currentIndex];

    // Update active or waiting child
    if (child.state === StepState.Active || child.state === StepState.Waiting) {
      child.fixedUpdate(dt);
    }

    // Check if child finished -> advance
    if (child.state === StepState.Finished) {
      this.currentIndex++;

      // Start next child (may finish immediately -> keep advancing)
      while (this.currentIndex < this.children.length) {
        this.startChild(this.currentIndex);
        const next = this.children[this.currentIndex];
        if (next.state === StepState.Finished) {
          this.currentIndex++;
        } else {
          return; // Next child is Active or Waiting, wait for it
        }
      }

      // All children done — record cycle time
      const cycleTime = performance.now() / 1000 - this.cycleStartTime;
      this.cycleTimes.push(cycleTime);
      this.completedCycles++;
      debug('logic', `[${this.name}] cycle #${this.completedCycles} complete (${cycleTime.toFixed(3)}s)`);
      if (this.autoLoop) {
        // Reset all children and restart
        for (const c of this.children) c.reset();
        this.currentIndex = 0;
        this.cycleStartTime = performance.now() / 1000;
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
    if (this.duration <= 0) {
      this.finish();
    }
  }

  fixedUpdate(dt: number): void {
    if (this.state !== StepState.Active) return;
    this.elapsed += dt;
    if (this.elapsed >= this.duration) {
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

  constructor(signalAddress: string | null, value: boolean, signalStore: SignalStore) {
    super();
    this.signalAddress = signalAddress;
    this.value = value;
    this.signalStore = signalStore;
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
    this.signalStore.setByPath(this.signalAddress, this.value);
    debug('logic', `SetSignalBool "${this.name}": ${this.signalAddress} = ${this.value}`);
    this.state = StepState.Finished;
  }

  fixedUpdate(_dt: number): void {}
}

/** WaitForSignalBool - polls until a boolean signal matches the expected value */
export class RVWaitForSignalBool extends RVLogicStep {
  signalAddress: string | null;
  waitForTrue: boolean;
  private signalStore: SignalStore;

  constructor(signalAddress: string | null, waitForTrue: boolean, signalStore: SignalStore) {
    super();
    this.signalAddress = signalAddress;
    this.waitForTrue = waitForTrue;
    this.signalStore = signalStore;
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
    // Check immediately
    if (this.signalStore.getBoolByPath(this.signalAddress) === this.waitForTrue) {
      this.finish();
    }
  }

  fixedUpdate(_dt: number): void {
    if (this.state !== StepState.Waiting || !this.signalAddress) return;
    if (this.signalStore.getBoolByPath(this.signalAddress) === this.waitForTrue) {
      debug('logic', `WaitForSignalBool "${this.name}": ${this.signalAddress} matched (${this.waitForTrue})`);
      this.finish();
    }
  }
}

/** WaitForSensor - polls until a sensor matches the expected occupied state */
export class RVWaitForSensor extends RVLogicStep {
  sensor: RVSensor | null;
  waitForOccupied: boolean;

  constructor(sensor: RVSensor | null, waitForOccupied: boolean) {
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
    if (this.sensor.occupied === this.waitForOccupied) {
      this.finish();
    }
  }

  fixedUpdate(_dt: number): void {
    if (this.state !== StepState.Waiting || !this.sensor) return;
    if (this.sensor.occupied === this.waitForOccupied) {
      debug('logic', `WaitForSensor "${this.name}": sensor "${this.sensor.node.name}" ${this.waitForOccupied ? 'occupied' : 'cleared'}`);
      this.finish();
    }
  }
}

/** DriveTo - moves a drive to a target position, finishes when reached */
export class RVDriveTo extends RVLogicStep {
  drive: RVDrive | null;
  destination: number;
  relative: boolean;
  direction: string;
  private startPosition = 0;
  private targetPosition = 0;

  constructor(drive: RVDrive | null, destination: number, relative: boolean, direction: string) {
    super();
    this.drive = drive;
    this.destination = destination;
    this.relative = relative;
    this.direction = direction;
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
    this.state = StepState.Active;

    // Check if already at target
    if (this.drive.isAtTarget) {
      this.finish();
    }
  }

  fixedUpdate(_dt: number): void {
    if (this.state !== StepState.Active || !this.drive) return;
    if (this.drive.isAtTarget) {
      this.finish();
    }
  }
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
  direction: string;

  constructor(drive: RVDrive | null, destination: number, relative: boolean, direction: string) {
    super();
    this.drive = drive;
    this.destination = destination;
    this.relative = relative;
    this.direction = direction;
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

    let dest = this.relative
      ? this.drive.currentPosition + this.destination
      : this.destination;

    if (this.drive.UseLimits) {
      dest = Math.max(this.drive.LowerLimit, Math.min(this.drive.UpperLimit, dest));
    }

    this.drive.startMove(dest);
    debug('logic', `StartDriveTo "${this.name}": drive → ${dest}`);
    this.state = StepState.Finished;
  }

  fixedUpdate(_dt: number): void {}
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
    const atTarget = this.drives.filter(d => d.isAtTarget).length;
    return (atTarget / this.drives.length) * 100;
  }

  start(): void {
    if (this.drives.length === 0) {
      this.state = StepState.Finished;
      return;
    }
    this.state = StepState.Waiting;
    if (this.drives.every(d => d.isAtTarget)) {
      this.finish();
    }
  }

  fixedUpdate(_dt: number): void {
    if (this.state !== StepState.Waiting) return;
    if (this.drives.every(d => d.isAtTarget)) {
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

  constructor(signalAddress: string | null, value: number, signalStore: SignalStore) {
    super();
    this.signalAddress = signalAddress;
    this.value = value;
    this.signalStore = signalStore;
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
    this.signalStore.setByPath(this.signalAddress, this.value);
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
    const current = this.signalStore.getFloatByPath(this.signalAddress);
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
    const value = this.signalStore.getBoolByPath(this.signalAddress);
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
