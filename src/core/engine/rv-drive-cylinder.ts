// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { Object3D } from 'three';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponentSchema, loadSchemaFromSpec } from './rv-component-registry';
import { RVDrive } from './rv-drive';
import { NodeRegistry } from './rv-node-registry';
import { debug } from './rv-debug';
import { createSignalWriter } from './rv-signal-store';
import { wireBoolSignal } from './rv-signal-wiring';

/** Two-position pneumatic/hydraulic drive behavior. */
export class RVDriveCylinder implements RVComponent {
  static readonly schema: ComponentSchema = loadSchemaFromSpec('Drive_Cylinder');

  readonly node: Object3D;
  isOwner = true;
  liveControlled = false;

  MinPos = 0;
  MaxPos = 100;
  TimeOut = 1;
  TimeIn = 1;
  OneBitCylinder = false;
  InvertOutputLogic = false;

  Out: string | null = null;
  In: string | null = null;
  IsOut: string | null = null;
  IsIn: string | null = null;
  IsMax: string | null = null;
  IsMin: string | null = null;
  IsMovingOut: string | null = null;
  IsMovingIn: string | null = null;

  private drive: RVDrive | null = null;
  private feedbackCb: ((drive: RVDrive) => void) | null = null;
  private readonly feedbackListeners: (() => void)[] = [];
  /** Store subscriptions + re-apply slots of Out/In. Held so `dispose()` can
   *  drop them — before plan-427 the handles were discarded (F6). */
  private readonly inputUnsubs: (() => void)[] = [];

  constructor(node: Object3D) {
    this.node = node;
  }

  commandOut(value: boolean | number): void {
    const drive = this.drive;
    if (!drive) return;
    let active = value === true;
    if (this.InvertOutputLogic) active = !active;
    const stroke = Math.abs(this.MaxPos - this.MinPos);
    if (this.OneBitCylinder) {
      drive.targetSpeed = stroke / (active ? this.TimeOut : this.TimeIn);
      drive.startMove(active ? this.MaxPos : this.MinPos);
      return;
    }
    if (active) {
      drive.targetSpeed = stroke / this.TimeOut;
      drive.startMove(this.MaxPos);
    }
  }

  commandIn(value: boolean | number): void {
    const drive = this.drive;
    if (!drive || this.OneBitCylinder) return;
    let active = value === true;
    if (this.InvertOutputLogic) active = !active;
    if (!active) return;
    drive.targetSpeed = Math.abs(this.MaxPos - this.MinPos) / this.TimeIn;
    drive.startMove(this.MinPos);
  }

  neutralizeOut(): void { this.drive?.stop(); }
  neutralizeIn(): void { this.drive?.stop(); }

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

    const minPos = this.MinPos;
    const maxPos = this.MaxPos;
    debug('loader', `Drive_Cylinder "${drive.name}": min=${minPos} max=${maxPos} timeOut=${this.TimeOut}s timeIn=${this.TimeIn}s oneBit=${this.OneBitCylinder} invert=${this.InvertOutputLogic}`);

    drive.currentPosition = minPos;
    drive.applyToNode();

    // plan-427: via the helper, so the current Out/In level is re-asserted after
    // a reset — an extended cylinder whose `Out` never toggles again would
    // otherwise sit at MinPos for the rest of the run.
    this.inputUnsubs.push(
      wireBoolSignal(context.signalStore, this.Out,
        (value) => this.commandOut(value),
        `Drive_Cylinder "${drive.name}": Out signal`, context.reapply).unsubscribe,
      wireBoolSignal(context.signalStore, this.OneBitCylinder ? null : this.In,
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
    let previousOut = false;
    let previousIn = true;
    this.feedbackCb = () => {
      const atMax = Boolean(this.readFeedbackSlot('IsMax'));
      const atMin = Boolean(this.readFeedbackSlot('IsMin'));
      const movingOut = Boolean(this.readFeedbackSlot('IsMovingOut'));
      const movingIn = Boolean(this.readFeedbackSlot('IsMovingIn'));
      if (atMax !== previousOut) {
        if (feedback.has('IsOut')) writer.setByPath(feedback.get('IsOut')!, atMax);
        if (feedback.has('IsMax')) writer.setByPath(feedback.get('IsMax')!, atMax);
        previousOut = atMax;
      }
      if (atMin !== previousIn) {
        if (feedback.has('IsIn')) writer.setByPath(feedback.get('IsIn')!, atMin);
        if (feedback.has('IsMin')) writer.setByPath(feedback.get('IsMin')!, atMin);
        previousIn = atMin;
      }
      if (feedback.has('IsMovingOut')) writer.setByPath(feedback.get('IsMovingOut')!, movingOut);
      if (feedback.has('IsMovingIn')) writer.setByPath(feedback.get('IsMovingIn')!, movingIn);
      for (let i = 0; i < this.feedbackListeners.length; i++) this.feedbackListeners[i]();
    };
    drive.addAfterUpdate(this.feedbackCb);
  }

  dispose(): void {
    if (this.drive && this.feedbackCb) this.drive.removeAfterUpdate(this.feedbackCb);
    for (const unsub of this.inputUnsubs) unsub();
    this.inputUnsubs.length = 0;
    this.feedbackCb = null;
    this.drive = null;
    this.feedbackListeners.length = 0;
  }
}

registerComponentSchema('Drive_Cylinder', RVDriveCylinder.schema, {
  badgeColor: '#29b6f6',
});
