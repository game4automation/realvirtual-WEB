// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { Object3D } from 'three';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponentSchema, loadSchemaFromSpec, setComponentInstance, removeComponentInstance } from './rv-component-registry';
import { RVDrive } from './rv-drive';
import { NodeRegistry } from './rv-node-registry';
import { debug } from './rv-debug';
import { createSignalWriter } from './rv-signal-store';
import { wireBoolSignal } from './rv-signal-wiring';

/**
 * Two-position pneumatic/hydraulic drive behavior.
 *
 * plan-538:
 * - **Feedback from the actual pose (F2).** `IsIn/IsOut/IsMin/IsMax` are
 *   written from the cylinder's position right at init (before any logic
 *   starts) and again after a simulation reset — not only on a change, so a
 *   PLC waiting for "in home" sees it immediately. The home pose is `MinPos`,
 *   or `MaxPos` when the drive's authored `StartPosition` is `MaxPos`.
 * - **Motion enable (F3).** Optional `Enable` signal: false stops the drive
 *   and HOLDS it where it stands; `Out`/`In` changes are latched, not
 *   executed. True again executes the latched command (two-bit: the last
 *   command; one-bit: the current `Out` level). No `Enable` = always enabled.
 *
 * plan-570 F1/F2 — valve modes (`Mode`, opt-in; default `Legacy` = all of the
 * above unchanged). The three new modes are LEVEL based: one central
 * `_evaluate()` derives the motion from the current `Out` / `In` levels and
 * ignores `OneBitCylinder` / `InvertOutputLogic`:
 * - `DoubleActing` (5/3 valve, closed centre): moves only while exactly one of
 *   `Out` / `In` is on; both off or both on → holds where it stands.
 * - `SingleActingPositive` (5/2 with spring): `Out` on → MaxPos, off → MinPos.
 * - `SingleActingNegative`: `Out` on → MinPos, off → MaxPos.
 * Nothing is latched in these modes — Enable, reset and re-apply evaluate the
 * levels present at that moment.
 */
export type DriveCylinderMode = 'Legacy' | 'DoubleActing' | 'SingleActingPositive' | 'SingleActingNegative';

export class RVDriveCylinder implements RVComponent {
  static readonly schema: ComponentSchema = loadSchemaFromSpec('Drive_Cylinder');

  private initialRunState = {};
  resetRunState(): void {
    Object.assign(this, this.initialRunState);
    this.forceEndpointFeedback = true;
  }

  readonly node: Object3D;
  isOwner = true;
  liveControlled = false;

  MinPos = 0;
  MaxPos = 100;
  TimeOut = 1;
  TimeIn = 1;
  OneBitCylinder = false;
  InvertOutputLogic = false;
  /** plan-570 F1 — valve mode; `Legacy` keeps the historic latching behaviour. */
  Mode: DriveCylinderMode = 'Legacy';

  Out: string | null = null;
  In: string | null = null;
  IsOut: string | null = null;
  IsIn: string | null = null;
  IsMax: string | null = null;
  IsMin: string | null = null;
  IsMovingOut: string | null = null;
  IsMovingIn: string | null = null;
  /** plan-538 F3 — optional motion-enable signal (PLCOutputBool). */
  Enable: string | null = null;

  private drive: RVDrive | null = null;
  /** plan-538 F3 — false while `Enable` holds the cylinder. */
  private _enabled = true;
  /** Destination of the last command (executed or latched while disabled). */
  private _pendingTarget: number | null = null;
  private _pendingTime = 1;
  /** Home pose of this cylinder (MinPos, or MaxPos when the drive starts there). */
  private _home = 0;
  private previousOut = false;
  private previousIn = true;
  private forceEndpointFeedback = false;
  private writeMovingFeedback: ((out?: boolean, inn?: boolean) => void) | null = null;
  /** plan-570 F2 — current levels of Out / In (level-based modes only). */
  private _outLevel = false;
  private _inLevel = false;
  /** Writes ALL feedback slots from the actual pose (plan-538 F2). */
  private _writeAllFeedback: (() => void) | null = null;
  private _offSimStart: (() => void) | null = null;
  private feedbackCb: ((drive: RVDrive) => void) | null = null;
  private readonly feedbackListeners: (() => void)[] = [];
  /** Store subscriptions + re-apply slots of Out/In. Held so `dispose()` can
   *  drop them — before plan-427 the handles were discarded (F6). */
  private readonly inputUnsubs: (() => void)[] = [];

  get commandFeedbackWriter() { return this.writeMovingFeedback; }

  constructor(node: Object3D) {
    this.node = node;
  }

  /** True for the level-based modes of plan-570 (anything but `Legacy`). */
  get levelMode(): boolean {
    return this.Mode === 'DoubleActing' || this.Mode === 'SingleActingPositive' || this.Mode === 'SingleActingNegative';
  }

  commandOut(value: boolean | number): void {
    if (!this.drive) return;
    if (this.levelMode) {
      this._outLevel = value === true;
      this._evaluate();
    } else {
      let active = value === true;
      if (this.InvertOutputLogic) active = !active;
      if (this.OneBitCylinder) this._command(active ? this.MaxPos : this.MinPos, active ? this.TimeOut : this.TimeIn);
      else if (active) this._command(this.MaxPos, this.TimeOut);
    }
    this.drive?.onCommand?.(this);
  }

  commandIn(value: boolean | number): void {
    if (!this.drive) return;
    if (this.levelMode) {
      this._inLevel = value === true;
      this._evaluate();
    } else if (!this.OneBitCylinder) {
      let active = value === true;
      if (this.InvertOutputLogic) active = !active;
      if (active) this._command(this.MinPos, this.TimeIn);
    }
    this.drive?.onCommand?.(this);
  }

  /** True while the motion enable allows the cylinder to move (plan-538 F3). */
  get enabled(): boolean { return this._enabled; }

  /**
   * plan-538 F3 — motion enable. false: stop and HOLD at the current position;
   * commands arriving meanwhile are latched. true: execute the latched command.
   */
  setEnable(value: boolean | number): void {
    const enabled = value === true;
    if (enabled !== this._enabled) {
      this._enabled = enabled;
      const drive = this.drive;
      if (!drive) return;
      if (!enabled) {
        drive.stop();
        drive.targetPosition = drive.currentPosition;
      } else if (this.levelMode) {
        this._evaluate();
      } else {
        const target = this._pendingTarget;
        if (target !== null && Math.abs(drive.currentPosition - target) >= 0.01) this._move(drive, target, this._pendingTime);
      }
    }
    this.drive?.onCommand?.(this);
  }

  /** Remember a command; execute it unless the enable holds the cylinder. */
  private _command(target: number, time: number): void {
    this._pendingTarget = target;
    this._pendingTime = time;
    const drive = this.drive;
    if (!drive || !this._enabled) return;
    this._move(drive, target, time);
  }

  /**
   * plan-570 F2 — level-based evaluation of the new modes: derive the motion
   * from the CURRENT Out/In levels. Disabled → nothing (the hold stands).
   */
  private _evaluate(): void {
    const drive = this.drive;
    if (!drive || !this._enabled) return;
    const out = this._outLevel;
    const inn = this._inLevel;
    let target: number | null;
    let time: number;
    switch (this.Mode) {
      case 'DoubleActing':
        if (out && !inn) { target = this.MaxPos; time = this.TimeOut; }
        else if (inn && !out) { target = this.MinPos; time = this.TimeIn; }
        else { target = null; time = this.TimeIn; }
        break;
      case 'SingleActingPositive':
        target = out ? this.MaxPos : this.MinPos;
        time = out ? this.TimeOut : this.TimeIn;
        break;
      case 'SingleActingNegative':
        target = out ? this.MinPos : this.MaxPos;
        time = out ? this.TimeIn : this.TimeOut;
        break;
      default:
        return;
    }
    if (target === null) {
      // 5/3 closed centre: hold where it stands.
      if (drive.isRunning) drive.stop();
      drive.targetPosition = drive.currentPosition;
      return;
    }
    if (Math.abs(drive.currentPosition - target) < 0.01) return; // already there
    if (drive.isRunning && drive.targetPosition === target) return; // already on the way
    this._move(drive, target, time);
  }

  private _move(drive: RVDrive, target: number, time: number): void {
    drive.targetSpeed = Math.abs(this.MaxPos - this.MinPos) / time;
    drive.startMove(target);
  }

  neutralizeOut(): void {
    if (this.levelMode) { this._outLevel = false; this._evaluate(); }
    else this.drive?.stop();
    this.drive?.onCommand?.(this);
  }
  neutralizeIn(): void {
    if (this.levelMode) { this._inLevel = false; this._evaluate(); }
    else this.drive?.stop();
    this.drive?.onCommand?.(this);
  }

  /** Direct-binding command contract of the `Enable` slot (plan-538 F3). */
  commandEnable(value: boolean | number): void { this.setEnable(value); }

  /**
   * Released direct binding of `Enable`: back to the unauthored default
   * (always enabled) WITHOUT executing the command latched during the hold —
   * the cylinder stays where it stands until the next `Out` / `In` command.
   */
  neutralizeEnable(): void {
    this._pendingTarget = null;
    this._enabled = true;
    // plan-570: the level-based modes follow the levels present right now.
    if (this.levelMode) this._evaluate();
    this.drive?.onCommand?.(this);
  }

  addFeedbackListener(cb: () => void): void {
    if (!this.feedbackListeners.includes(cb)) this.feedbackListeners.push(cb);
  }

  removeFeedbackListener(cb: () => void): void {
    const index = this.feedbackListeners.indexOf(cb);
    if (index >= 0) this.feedbackListeners.splice(index, 1);
  }

  readFeedbackSlot(slot: string): boolean | number {
    const drive = this.drive;
    if (!drive) return false;
    const atMax = Math.abs(drive.currentPosition - this.MaxPos) < 0.01;
    const atMin = Math.abs(drive.currentPosition - this.MinPos) < 0.01;
    if (slot === 'IsOut' || slot === 'IsMax') return atMax;
    if (slot === 'IsIn' || slot === 'IsMin') return atMin;
    if (slot === 'IsMovingOut') return drive.isRunning && drive.targetPosition === this.MaxPos;
    if (slot === 'IsMovingIn') return drive.isRunning && drive.targetPosition === this.MinPos;
    throw new Error(`[Drive_Cylinder] Unknown feedback slot "${slot}"`);
  }

  init(context: ComponentContext): void {
    const path = NodeRegistry.computeNodePath(this.node);
    const writer = createSignalWriter(
      context.signalStore,
      `component:Drive_Cylinder:${path}`,
      'component',
      { slotContext: path },
    );
    const drive = context.registry.getByPath<RVDrive>('Drive', path);
    if (!drive) return;
    this.drive = drive;
    setComponentInstance(this.node, this);

    const minPos = this.MinPos;
    const maxPos = this.MaxPos;
    debug('loader', `Drive_Cylinder "${drive.name}": min=${minPos} max=${maxPos} timeOut=${this.TimeOut}s timeIn=${this.TimeIn}s oneBit=${this.OneBitCylinder} invert=${this.InvertOutputLogic} mode=${this.Mode}`);

    // plan-538 F2: the home pose is MinPos — or MaxPos when the drive is
    // authored to start there (a reset puts it back to its StartPosition too).
    this._home = Math.abs(drive.StartPosition - maxPos) < 0.01 ? maxPos : minPos;
    drive.currentPosition = this._home;
    drive.targetPosition = this._home;
    drive.applyToNode();

    // plan-538 F3: the enable is wired FIRST, so an `Enable` that is already
    // false at load latches the initial Out/In commands instead of executing them.
    this._enabled = true;
    this._pendingTarget = null;
    this._outLevel = false;
    this._inLevel = false;
    this.inputUnsubs.push(
      wireBoolSignal(context.signalStore, this.Enable,
        (value) => this.setEnable(value),
        `Drive_Cylinder "${drive.name}": Enable signal`, context.reapply).unsubscribe,
    );

    // plan-427: via the helper, so the current Out/In level is re-asserted after
    // a reset — an extended cylinder whose `Out` never toggles again would
    // otherwise sit at MinPos for the rest of the run.
    this.inputUnsubs.push(
      wireBoolSignal(context.signalStore, this.Out,
        (value) => this.commandOut(value),
        `Drive_Cylinder "${drive.name}": Out signal`, context.reapply).unsubscribe,
      // plan-570: DoubleActing always reads In; the single-acting modes ignore it.
      wireBoolSignal(context.signalStore,
        this.Mode === 'DoubleActing' ? this.In
          : (this.levelMode || this.OneBitCylinder) ? null : this.In,
        (value) => this.commandIn(value),
        `Drive_Cylinder "${drive.name}": In signal`, context.reapply).unsubscribe,
    );

    const feedbackRefs: { key: string; addr: string }[] = [];
    for (const [key, address] of [
      ['IsOut', this.IsOut], ['IsIn', this.IsIn],
      ['IsMax', this.IsMax], ['IsMin', this.IsMin],
      ['IsMovingOut', this.IsMovingOut], ['IsMovingIn', this.IsMovingIn],
    ] as [string, string | null][]) {
      if (address) feedbackRefs.push({ key, addr: address });
    }

    const feedback = new Map(feedbackRefs.map((entry) => [entry.key, entry.addr]));
    this.writeMovingFeedback = (
      out = Boolean(this.readFeedbackSlot('IsMovingOut')), inn = Boolean(this.readFeedbackSlot('IsMovingIn')),
    ) => {
      if (feedback.has('IsMovingOut')) writer.setByPath(feedback.get('IsMovingOut')!, out);
      if (feedback.has('IsMovingIn')) writer.setByPath(feedback.get('IsMovingIn')!, inn);
      for (let i = 0; i < this.feedbackListeners.length; i++) this.feedbackListeners[i]();
    };
    const writeFeedback = (all: boolean): void => {
      all ||= this.forceEndpointFeedback;
      this.forceEndpointFeedback = false;
      const atMax = Boolean(this.readFeedbackSlot('IsMax'));
      const atMin = Boolean(this.readFeedbackSlot('IsMin'));
      const movingOut = Boolean(this.readFeedbackSlot('IsMovingOut'));
      const movingIn = Boolean(this.readFeedbackSlot('IsMovingIn'));
      if (all || atMax !== this.previousOut) {
        if (feedback.has('IsOut')) writer.setByPath(feedback.get('IsOut')!, atMax);
        if (feedback.has('IsMax')) writer.setByPath(feedback.get('IsMax')!, atMax);
        this.previousOut = atMax;
      }
      if (all || atMin !== this.previousIn) {
        if (feedback.has('IsIn')) writer.setByPath(feedback.get('IsIn')!, atMin);
        if (feedback.has('IsMin')) writer.setByPath(feedback.get('IsMin')!, atMin);
        this.previousIn = atMin;
      }
      this.writeMovingFeedback?.(movingOut, movingIn);
    };
    this.feedbackCb = () => writeFeedback(false);
    this._writeAllFeedback = () => writeFeedback(true);
    drive.addAfterUpdate(this.feedbackCb);

    // plan-538 F2: feedback from the ACTUAL pose right now — before any logic
    // starts — not only after the first move.
    writeFeedback(true);

    // plan-538 F2/F6: after a simulation reset (drives are back at their
    // StartPosition, the logic has not restarted yet) the cylinder returns to
    // its home pose, drops the command latched before the reset (the re-apply
    // that follows re-asserts the current Out/In levels) and writes its whole
    // feedback again.
    this._offSimStart?.();
    this._offSimStart = context.events?.on('simulation-start', () => this.onSimulationStart()) ?? null;
    this.initialRunState = { _enabled: this._enabled, _pendingTarget: this._pendingTarget, _pendingTime: this._pendingTime, _outLevel: this._outLevel, _inLevel: this._inLevel, previousOut: this.previousOut, previousIn: this.previousIn };
  }

  /** plan-538 F2/F6 — re-initialise pose and feedback after a simulation reset. */
  onSimulationStart(): void {
    const drive = this.drive;
    if (!drive) return;
    this._pendingTarget = null;
    if (Math.abs(drive.currentPosition - this._home) >= 0.01 || drive.isRunning) {
      drive.stop();
      drive.currentPosition = this._home;
      drive.targetPosition = this._home;
      drive.applyToNode();
    }
    this._writeAllFeedback?.();
  }

  dispose(): void {
    removeComponentInstance(this.node, this);
    if (this.drive && this.feedbackCb) this.drive.removeAfterUpdate(this.feedbackCb);
    for (const unsub of this.inputUnsubs) unsub();
    this.inputUnsubs.length = 0;
    this._offSimStart?.();
    this._offSimStart = null;
    this._writeAllFeedback = null;
    this.writeMovingFeedback = null;
    this.feedbackCb = null;
    this.drive = null;
    this.feedbackListeners.length = 0;
  }
}

registerComponentSchema('Drive_Cylinder', RVDriveCylinder.schema, {
  bake: 'chunk', // sits on the Drive node it extends — moves with it (plan-753 §2.3)
  authorable: true, // addable in the asset editor on a node that carries a Drive
  ui: { badge: '#29b6f6' },
});
