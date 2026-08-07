// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { Object3D } from 'three';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponentSchema, loadSchemaFromSpec } from './rv-component-registry';
import { RVDrive } from './rv-drive';
import { NodeRegistry } from './rv-node-registry';
import { wireBoolSignal, scaleFeedbackPosition } from './rv-signal-wiring';
import { createSignalWriter } from './rv-signal-store';

/**
 * RVDriveSimple — TypeScript port of Drive_Simple.cs (full C# signal parity).
 *
 * PLC Outputs (PLC → drive, read by the viewer):
 *   Speed        — target speed in mm/s (scaled by ScaleSpeed)
 *   Accelaration — acceleration in mm/s² (C# field name kept for GLB parity)
 *   Forward      — jog forward
 *   Backward     — jog backward
 * PLC Inputs (drive → PLC, written by the viewer every tick):
 *   IsAtPosition — current position in mm (scale/offset applied)
 *   IsAtSpeed    — current speed in mm/s
 *   IsDriving    — true while the drive is running
 *
 * Uses init() to wire up subscriptions after all signals are registered,
 * exactly mirroring the Unity two-phase Awake/Start initialisation pattern.
 * Feedback is chained via `drive.addAfterUpdate`.
 */
export class RVDriveSimple implements RVComponent {
  // PLC IOs — declared like the C# fields (`public PLCOutputBool Forward;`).
  // `signal:` marks the slot as bindable. Empty slots remain null.
  // Loaded from the rv-ODT specification (schema/v1/rv-odt.json, plan-187).
  static readonly schema: ComponentSchema = loadSchemaFromSpec('Drive_Simple');

  readonly node: Object3D;
  isOwner = true;

  // ComponentRef → resolved to SignalStore address strings (null when not wired).
  Speed: string | null = null;
  Accelaration: string | null = null;
  Forward: string | null = null;
  Backward: string | null = null;
  IsAtPosition: string | null = null;
  IsAtSpeed: string | null = null;
  IsDriving: string | null = null;

  // Settings (PascalCase, parity with C#).
  ScaleSpeed = 1;
  CurrentPositionScale = 1;
  CurrentPositionOffset = 0;
  ScaleFeedbackPosition = true;

  /** Planner Signal Linking: when live-controlled, internal jog defaults are
   *  suppressed so the CONNECT relay drives Forward/Backward (mirrors
   *  drive.positionOverwrite / isOwner). Set by SignalBindingManager. */
  liveControlled = false;

  /** Bound feedback callback — kept so dispose() can detach it. */
  private feedbackCb: ((d: RVDrive) => void) | null = null;
  private drive: RVDrive | null = null;
  private readonly feedbackListeners: (() => void)[] = [];

  constructor(node: Object3D) {
    this.node = node;
  }

  commandForward(value: boolean | number): void {
    if (this.drive) this.drive.jogForward = Boolean(value);
  }

  commandBackward(value: boolean | number): void {
    if (this.drive) this.drive.jogBackward = Boolean(value);
  }

  commandSpeed(value: boolean | number): void {
    if (this.drive) this.drive.targetSpeed = Number(value) * this.ScaleSpeed;
  }

  commandAccelaration(value: boolean | number): void {
    if (!this.drive) return;
    this.drive.Acceleration = Number(value) * this.ScaleSpeed;
    this.drive.UseAcceleration = true;
  }

  neutralizeForward(): void { this.commandForward(false); }
  neutralizeBackward(): void { this.commandBackward(false); }
  neutralizeSpeed(): void {}
  neutralizeAccelaration(): void {}

  addFeedbackListener(cb: () => void): void {
    if (!this.feedbackListeners.includes(cb)) this.feedbackListeners.push(cb);
  }

  removeFeedbackListener(cb: () => void): void {
    const index = this.feedbackListeners.indexOf(cb);
    if (index >= 0) this.feedbackListeners.splice(index, 1);
  }

  readFeedbackSlot(slot: string): boolean | number {
    const drive = this.drive;
    if (!drive) return slot === 'IsDriving' ? false : 0;
    if (slot === 'IsAtPosition') {
      return scaleFeedbackPosition(
        drive.currentPosition,
        this.ScaleFeedbackPosition,
        this.CurrentPositionScale,
        this.CurrentPositionOffset,
      );
    }
    if (slot === 'IsAtSpeed') return drive.currentSpeed / (this.ScaleSpeed || 1);
    if (slot === 'IsDriving') return drive.isRunning;
    throw new Error(`[Drive_Simple] Unknown feedback slot "${slot}"`);
  }

  init(ctx: ComponentContext): void {
    // Find the Drive on the same node
    const path = NodeRegistry.computeNodePath(this.node);
    const writer = createSignalWriter(
      ctx.signalStore,
      `component:Drive_Simple:${path}`,
      'component',
      { slotContext: path },
    );
    const drive = ctx.registry.getByPath<RVDrive>('Drive', path);
    if (!drive) {
      console.error(`[Drive_Simple] NO DRIVE found at path="${path}"`);
      return;
    }
    this.drive = drive;

    // ── Inputs (PLC → drive) ──
    wireBoolSignal(ctx.signalStore, this.Forward,
      (v) => this.commandForward(v), `Drive_Simple "${drive.name}": Forward signal`);
    wireBoolSignal(ctx.signalStore, this.Backward,
      (v) => this.commandBackward(v), `Drive_Simple "${drive.name}": Backward signal`);
    if (this.Speed) {
      ctx.signalStore.subscribeByPath(this.Speed, (v) => {
        this.commandSpeed(v);
      });
    }
    if (this.Accelaration) {
      ctx.signalStore.subscribeByPath(this.Accelaration, (v) => {
        this.commandAccelaration(v);
      });
    }

    // ── Feedback (drive → PLC) — ALWAYS, also under liveControlled ──
    // Chained via addAfterUpdate so a sibling behavior on the same drive is
    // not overwritten.
    this.feedbackCb = () => {
      if (this.IsAtPosition) writer.setByPath(this.IsAtPosition, this.readFeedbackSlot('IsAtPosition'));
      if (this.IsAtSpeed) writer.setByPath(this.IsAtSpeed, this.readFeedbackSlot('IsAtSpeed'));
      if (this.IsDriving) writer.setByPath(this.IsDriving, this.readFeedbackSlot('IsDriving'));
      for (let i = 0; i < this.feedbackListeners.length; i++) this.feedbackListeners[i]();
    };
    drive.addAfterUpdate(this.feedbackCb);
  }

  dispose(): void {
    if (this.drive && this.feedbackCb) {
      this.drive.removeAfterUpdate(this.feedbackCb);
    }
    this.feedbackCb = null;
    this.drive = null;
    this.feedbackListeners.length = 0;
  }
}

// Register schema for auto-derivation of CONSUMED fields
registerComponentSchema('Drive_Simple', RVDriveSimple.schema, {
  badgeColor: '#29b6f6',
});
