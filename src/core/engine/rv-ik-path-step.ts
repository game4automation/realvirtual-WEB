// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-ik-path-step.ts — LogicStep leaf that starts an RVIKPath and blocks until
 * the path finishes. Mirrors how IKPath is triggered from a LogicStep in Unity.
 *
 * The path's own per-frame state machine is driven by RVViewer (before the drive
 * loop); this step only kicks it off and observes `PathIsFinished`.
 *
 * plan-538 F1g — `cancel()`: when the logic root is deactivated, a path this
 * step started is stopped together with the axes it moves; later path ticks
 * must not move them again (no re-trigger from `StartPath` / `SignalStart`).
 */

import { RVLogicStep, StepState } from './rv-logic-step';
import type { RVIKPath } from './rv-ik-path';

export class RVIKPathStep extends RVLogicStep {
  /** True while the path this step started may still be running. */
  private _ownsPath = false;
  /** Set by cancel(): the following root reset must not re-arm the path's start edge. */
  private _cancelled = false;

  constructor(private readonly ikPath: RVIKPath | null) {
    super();
  }

  get progress(): number {
    if (this.state === StepState.Finished) return 100;
    if (this.state === StepState.Idle || !this.ikPath) return 0;
    return this.ikPath.PathIsActive ? 50 : 0;
  }

  get startsMotion(): boolean { return true; }

  start(): void {
    this._cancelled = false;
    if (!this.ikPath) {
      console.warn(`[LogicStep] IKPath "${this.name}": null path — skipping`);
      this.state = StepState.Finished;
      return;
    }
    this.ikPath.startPath();
    this._ownsPath = true;
    this.state = StepState.Active;
    // A degenerate (empty) path finishes within startPath() synchronously.
    if (this.ikPath.PathIsFinished) this.finish();
  }

  fixedUpdate(_dt: number): void {
    if (this.state !== StepState.Active || !this.ikPath) return;
    if (this.ikPath.PathIsFinished) this.finish();
  }

  /** plan-538 F1g — stop the path this step started and hold its axes. */
  cancel(): void {
    if (!this.ikPath || !this._ownsPath) return;
    this._ownsPath = false;
    this._cancelled = true;
    this.ikPath.cancel();
  }

  reset(): void {
    super.reset();
    // After a cancel the path is already idle with its start edge disarmed;
    // a plain reset() would re-arm it and restart the path on the next tick.
    if (this._cancelled) return;
    this.ikPath?.reset();
  }
}
