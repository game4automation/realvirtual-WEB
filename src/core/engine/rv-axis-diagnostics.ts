// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-axis-diagnostics.ts — the following-error and overload model of
 * plan-673 Phase 4.
 *
 * ── The one thing this file exists to get right ───────────────────────────
 * A MuJoCo `<position>` actuator is P+D **without an integral term**. A
 * permanent gravity sag of `tau / Kp` therefore remains even with no contact at
 * all. The Phase-1 gate measured it on a 39 kg six-axis arm: 1.07 deg of axis
 * sag at the Menagerie stock gain (14.9 mm at the tool), 0.10 deg (0.92 mm) at
 * the `Kp` this component defaults to. 15 mm of tool drop is not
 * distinguishable from 15 mm of contact refusal.
 *
 * So an overload model that compares the RAW following error against a window
 * **reports permanent overload** — the axis never gets closer than its base sag
 * and the panel fills up with a finding that is simply the servo working as
 * designed. {@link netFollowingError} is the whole answer: the declared base
 * share (`DynamicAxis.BaseFollowingError`, authored in the axis's own unit) is
 * subtracted from the magnitude before anything is compared, and the test
 * `tests/axis-contract-overload.test.ts` drives a sag-only axis for a simulated
 * minute and requires silence.
 *
 * ── What the display must contain, and why it is not just the axes ────────
 * The Phase-1 gate measured that the jam becomes visible AT THE GRIPPER: in two
 * of three failure cases the axis following error was identical to the
 * successful run (0.07–0.08 deg) while the part slid 17–20 mm in the jaws. The
 * pass therefore covers both halves — axis (net following error, torque,
 * saturation) and gripper (part slip, clamping force) — see `rv-grip-load.ts`.
 *
 * ── Report, never trip (decision 2026-10-24) ──────────────────────────────
 * Leaving the window raises the `Overload` signal and a Problems entry. The
 * motion path KEEPS RUNNING. That is the conservative half of the open question
 * in 2.4: a real controller does stop, but a default that halts a running demo
 * because 2 mm of following error appeared somewhere gets switched off instead
 * of understood.
 *
 * **Where a trip would attach, if Thomas wants one.** Exactly one place: the
 * rising edge inside {@link AxisDiagnosticsManager.update}, where `verdict.rose`
 * becomes true. A trip is an additional call there — `path.cancel()` on the
 * `RVIKPath` that commands the axis (it already stops every axis it moved and
 * disarms the start edge, `rv-ik-path.ts` `cancel()`), plus NOT setting
 * `SignalEnded`. Nothing in this file would have to be rearranged for it: the
 * window, the timer, the net error and the latch are the trip's condition
 * already. The one NEW ingredient is a drive -> planner lookup:
 * `plannerCommandedAxes()` flattens the participants into a set of drives and
 * deliberately loses which participant owns which, so a trip needs the
 * ownership module to expose the participant of a drive as well.
 */

import type { RVDrive } from './rv-drive';
import { RVDynamicAxis } from './rv-dynamic-axis';
import { RVGripLoad } from './rv-grip-load';
import type { SignalStore } from './rv-signal-store';
import { auditAxisRoles, clearAxisRoleProblems } from './rv-axis-contract';
import { plannerCommandedAxes } from './rv-axis-ownership';
import { reportProblem, clearProblem, clearProblemsOfCode } from '../hmi/problems-store';

/** Net following error outside its window for longer than the declared time. */
export const AXIS_OVERLOAD = 'axis-overload';
/** The held part is travelling inside the jaws. */
export const GRIP_SLIP = 'grip-slip';

/**
 * Following error with the declared structural share removed, in the drive's
 * own unit (mm / deg) — never negative.
 *
 * The base share is subtracted from the MAGNITUDE, not signed. The sag's sign
 * depends on which way gravity pulls the link at the current pose, so a signed
 * subtraction would ADD to the error in half of the workspace. Subtracting the
 * magnitude is the conservative reading: it can only ever make the reported
 * error smaller, so the model under-reports rather than invents an overload.
 */
export function netFollowingError(rawError: number, baseError: number): number {
  return Math.max(0, Math.abs(rawError) - Math.max(0, baseError));
}

/** One axis's verdict for one tick. */
export interface AxisVerdict {
  readonly net: number;
  readonly overloaded: boolean;
  /** True on the tick the overload STARTED (for the Problems entry). */
  readonly rose: boolean;
  /** True on the tick it ended. */
  readonly fell: boolean;
}

/**
 * The window timer of one axis. One instance per `DynamicAxis`, kept in the
 * manager's map — the state is the elapsed time above the limit, nothing else.
 */
class AxisWindow {
  private aboveMs = 0;
  private latched = false;

  /** Advance by `dtMs` and judge. */
  step(net: number, limit: number, timeMs: number, dtMs: number): AxisVerdict {
    if (limit <= 0) {
      // Monitoring off: still report the net error, never an overload.
      const fell = this.latched;
      this.aboveMs = 0;
      this.latched = false;
      return { net, overloaded: false, rose: false, fell };
    }
    if (net > limit) this.aboveMs += dtMs;
    else this.aboveMs = 0;
    const overloaded = this.aboveMs >= timeMs;
    const rose = overloaded && !this.latched;
    const fell = !overloaded && this.latched;
    this.latched = overloaded;
    return { net, overloaded, rose, fell };
  }

  reset(): void {
    this.aboveMs = 0;
    this.latched = false;
  }

  get isLatched(): boolean {
    return this.latched;
  }
}

/**
 * The per-tick diagnostics pass.
 *
 * Ordering: AFTER the drive loop of the same fixed tick. The drive loop is what
 * applies the position the physics reported and fires the feedback bindings, so
 * running before it would publish the previous tick's numbers.
 *
 * Cost: one `setMany()` batch per tick, which is what the Phase-1b measurement
 * asks for ("ONE setMany per control step"). That measurement put 56 float
 * signals at 100 Hz at 0.019 ms p95 per frame against a 0.5 ms budget, so the
 * four signals per axis and three per grip are not a cost question — but the
 * batch is still the rule, because the factor it buys is 6.
 */
export class AxisDiagnosticsManager {
  private readonly windows = new WeakMap<RVDynamicAxis, AxisWindow>();
  private readonly slipWindows = new WeakMap<RVGripLoad, AxisWindow>();
  /** Problems ids this manager raised, so it clears only its own. */
  private readonly raised = new Set<string>();
  /** The role audit runs once per model (see `auditAxisRoles`). */
  private audited = false;
  /** Scratch for the one batch — never reallocated per tick. */
  private readonly batch: Record<string, boolean | number> = {};

  constructor(private readonly store: () => SignalStore | null) {}

  /** Arm a fresh audit and forget every window (model change, sim reset). */
  reset(): void {
    this.audited = false;
    for (const id of this.raised) clearProblem(id);
    this.raised.clear();
  }

  /**
   * Drop everything, including the role findings (model teardown).
   *
   * It also EMPTIES the two component lists this pass iterates, and that is a
   * gap closed rather than a convenience: nothing in `src/` calls the Phase-2
   * `clearAll()` of any of those components, because there is no generic
   * component-dispose pass on `clearModel()` and nothing iterated the lists
   * yet. The moment this pass walks `RVDynamicAxis.axes` every tick, a stale
   * entry from the previous model is an axis that no longer exists being
   * measured and reported. The other five Phase-2 lists (region, contact
   * profile, collision shape set, free body, movable, policy) have the same
   * gap and no iterator yet — they belong to whoever starts walking them.
   */
  clear(): void {
    this.reset();
    clearProblemsOfCode(AXIS_OVERLOAD);
    clearProblemsOfCode(GRIP_SLIP);
    clearAxisRoleProblems();
    RVDynamicAxis.clearAll();
    RVGripLoad.clearAll();
  }

  /**
   * One fixed step. Returns true when a published value changed, so the caller
   * can mark the frame dirty — a readout that changed is a reason to repaint
   * even though nothing moved.
   */
  update(dt: number): boolean {
    const axes = RVDynamicAxis.axes;
    const loads = RVGripLoad.loads;
    if (axes.length === 0 && loads.length === 0) return false;

    if (!this.audited) {
      this.audited = true;
      auditAxisRoles(axes, plannerCommandedAxes());
    }

    const dtMs = dt * 1000;
    const batch = this.batch;
    for (const key of Object.keys(batch)) delete batch[key];

    for (const axis of axes) {
      const drive = axis.drive;
      if (!drive) continue;
      const verdict = this.stepAxis(axis, drive, dtMs);
      const sig = axis.signals;
      if (!sig) continue;
      batch[sig.followingError.name] = verdict.net;
      batch[sig.isTorque.name] = drive.actualTorque;
      batch[sig.saturated.name] = drive.saturated;
      batch[sig.overload.name] = verdict.overloaded;
    }

    for (const load of loads) {
      const verdict = this.stepGrip(load, dtMs);
      const sig = load.signals;
      if (!sig) continue;
      batch[sig.partSlip.name] = verdict.net;
      batch[sig.gripForce.name] = load.forceN;
      batch[sig.slipping.name] = verdict.overloaded;
    }

    const names = Object.keys(batch);
    if (names.length === 0) return false;
    this.store()?.setMany(batch);
    return true;
  }

  /** Net error + window verdict of one axis, and its Problems entry. */
  private stepAxis(axis: RVDynamicAxis, drive: RVDrive, dtMs: number): AxisVerdict {
    let window = this.windows.get(axis);
    if (!window) {
      window = new AxisWindow();
      this.windows.set(axis, window);
    }
    const net = netFollowingError(drive.followingError, axis.BaseFollowingError);
    const verdict = window.step(net, axis.FollowingErrorLimit, axis.FollowingErrorTimeMs, dtMs);

    const id = `${AXIS_OVERLOAD}:${axis.nodePath}`;
    if (verdict.rose) {
      this.raised.add(id);
      // The numbers go INTO the message. A finding that says "overload" without
      // the net error, the window and the torque cannot be acted on, and the
      // whole reason the base share is named in the model is that the reader
      // has to be able to tell servo sag from a jam.
      reportProblem({
        id,
        code: AXIS_OVERLOAD,
        severity: 'warning',
        title: `Axis ${axis.node.name || '(unnamed)'} is not following its setpoint`,
        detail: `Net following error ${net.toFixed(3)} (raw ${Math.abs(drive.followingError).toFixed(3)} minus the `
          + `declared base share ${axis.BaseFollowingError.toFixed(3)}) stayed above the window `
          + `${axis.FollowingErrorLimit.toFixed(3)} for ${axis.FollowingErrorTimeMs} ms. Actuator force `
          + `${drive.actualTorque.toFixed(2)}${drive.saturated ? ' (AT THE FORCE LIMIT)' : ''}. `
          + 'The motion path keeps running — this is a report, not a trip. Note that the axis is the SECOND '
          + 'place a jam shows: check the part slip at the gripper as well, which stays visible when the '
          + 'following error does not.',
        nodePath: axis.nodePath,
      });
    } else if (verdict.fell) {
      this.raised.delete(id);
      clearProblem(id);
    }
    return verdict;
  }

  /** Slip + window verdict of one grip load, and its Problems entry. */
  private stepGrip(load: RVGripLoad, dtMs: number): AxisVerdict {
    let window = this.slipWindows.get(load);
    if (!window) {
      window = new AxisWindow();
      this.slipWindows.set(load, window);
    }
    const slip = load.measure();
    const verdict = window.step(slip, load.monitorsSlip ? load.SlipLimit : 0, load.SlipTimeMs, dtMs);

    const id = `${GRIP_SLIP}:${load.nodePath}`;
    if (verdict.rose) {
      this.raised.add(id);
      reportProblem({
        id,
        code: GRIP_SLIP,
        severity: 'warning',
        title: `Part is slipping in ${load.node.name || '(unnamed gripper)'}`,
        detail: `The held part has travelled ${slip.toFixed(2)} mm inside the jaws, above the limit `
          + `${load.SlipLimit.toFixed(2)} mm for ${load.SlipTimeMs} ms, at a clamping force of `
          + `${load.forceN.toFixed(1)} N. This is the measurement that stays visible when the axis following `
          + 'error does not: in two of three measured failure cases the axes behaved exactly as in the '
          + 'successful run while the part slid 17–20 mm. Holding capacity is decided by the pad friction '
          + '(ContactProfile on the jaws) roughly seven times more strongly than by the clamping force.',
        nodePath: load.nodePath,
      });
    } else if (verdict.fell) {
      this.raised.delete(id);
      clearProblem(id);
    }
    return verdict;
  }

  /** True while this axis is reported overloaded (HMI, tests). */
  isOverloaded(axis: RVDynamicAxis): boolean {
    return this.windows.get(axis)?.isLatched ?? false;
  }

  /** True while this gripper is reported slipping (HMI, tests). */
  isSlipping(load: RVGripLoad): boolean {
    return this.slipWindows.get(load)?.isLatched ?? false;
  }
}
