// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { Object3D } from 'three';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponentSchema, loadSchemaFromSpec } from './rv-component-registry';
import { RVDrive } from './rv-drive';
import { NodeRegistry } from './rv-node-registry';
import { scaleFeedbackPosition } from './rv-signal-wiring';
import { createSignalWriter } from './rv-signal-store';

/**
 * RVDriveDestinationMotor — TypeScript port of Drive_DestinationMotor.cs.
 *
 * Position-controlled (servo-like) drive behavior for virtual commissioning
 * (VIBN). Reads `Destination`/`StartDrive`/`TargetSpeed`/`Acceleration` PLC
 * output signals and drives the parent {@link RVDrive} to the target position
 * via the existing `startMove()` + acceleration/deceleration physics. Writes
 * `IsAtPosition`/`IsAtSpeed`/`IsAtDestination`/`IsDriving` feedback every tick.
 *
 * Naming parity with the Unity C# class: identical signal + setting names.
 *
 * This is a pure signal ADAPTER — it has no autonomous demo path. The relay
 * (plan-226) writes the same `Destination` slot this subscribes to, so live
 * control works automatically. The `liveControlled` flag is only declared so the
 * SignalBindingManager can set it (used for badge/state). Feedback writes ALWAYS
 * run (also under live control — the PLC reads them, F6).
 *
 * Web vs Unity: Web `RVDrive` has no `TargetStartMove` flag, so `StartDrive=true`
 * calls `drive.startMove()`. Because the SignalStore only fires subscriptions on
 * value CHANGE, StartDrive has implicit rising-edge semantics (no auto-restart
 * while it stays true after the drive reaches the target).
 */
export class RVDriveDestinationMotor implements RVComponent {
  // PLC IOs — declared like the C# fields (`public PLCOutputBool StartDrive;`).
  // `signal:` marks the slot as bindable. Empty slots remain null.
  // Loaded from the rv-ODT specification (schema/v1/rv-odt.json, plan-187).
  static readonly schema: ComponentSchema = loadSchemaFromSpec('Drive_DestinationMotor');

  readonly node: Object3D;
  isOwner = true;

  /** Planner Signal Linking: set by SignalBindingManager when a slot is driven
   *  by a live CONNECT signal. The relay writes the same Destination slot this
   *  subscribes to, so no internal gate is needed here — the flag is only for
   *  state/badge purposes (mirrors RVDriveSimple / RVDriveCylinder). */
  liveControlled = false;

  // ComponentRef → resolved to SignalStore address strings (null when not wired).
  StartDrive: string | null = null;
  Destination: string | null = null;
  TargetSpeed: string | null = null;
  Acceleration: string | null = null;
  IsAtPosition: string | null = null;
  IsAtSpeed: string | null = null;
  IsAtDestination: string | null = null;
  IsDriving: string | null = null;

  // Settings (PascalCase, parity with C#).
  CurrentPositionScale = 1;
  CurrentPositionOffset = 0;
  ScaleFeedbackPosition = true;

  /** Bound feedback callback — kept so a future dispose() can detach it. */
  private feedbackCb: ((d: RVDrive) => void) | null = null;
  private drive: RVDrive | null = null;
  private startDriveValue = false;
  private readonly feedbackListeners: (() => void)[] = [];

  constructor(node: Object3D) {
    this.node = node;
  }

  commandDestination(value: boolean | number): void {
    if (!this.drive) return;
    this.drive.targetPosition = this.normalize(
      Number(value) * this.CurrentPositionScale + this.CurrentPositionOffset,
      this.drive,
    );
  }

  commandStartDrive(value: boolean | number): void {
    const active = Boolean(value);
    if (active && !this.startDriveValue) this.drive?.startMove();
    this.startDriveValue = active;
  }

  commandTargetSpeed(value: boolean | number): void {
    if (this.drive) this.drive.targetSpeed = Number(value);
  }

  commandAcceleration(value: boolean | number): void {
    if (!this.drive) return;
    this.drive.Acceleration = Number(value);
    this.drive.UseAcceleration = true;
  }

  neutralizeDestination(): void {}
  neutralizeStartDrive(): void {}
  neutralizeTargetSpeed(): void {}
  neutralizeAcceleration(): void {}

  addFeedbackListener(cb: () => void): void {
    if (!this.feedbackListeners.includes(cb)) this.feedbackListeners.push(cb);
  }

  removeFeedbackListener(cb: () => void): void {
    const index = this.feedbackListeners.indexOf(cb);
    if (index >= 0) this.feedbackListeners.splice(index, 1);
  }

  readFeedbackSlot(slot: string): boolean | number {
    const drive = this.drive;
    if (!drive) return slot === 'IsAtPosition' || slot === 'IsAtSpeed' ? 0 : false;
    if (slot === 'IsAtPosition') {
      return scaleFeedbackPosition(
        drive.currentPosition,
        this.ScaleFeedbackPosition,
        this.CurrentPositionScale,
        this.CurrentPositionOffset,
      );
    }
    if (slot === 'IsAtSpeed') return drive.currentSpeed;
    if (slot === 'IsAtDestination') return drive.isAtTarget;
    if (slot === 'IsDriving') return drive.isRunning;
    throw new Error(`[Drive_DestinationMotor] Unknown feedback slot "${slot}"`);
  }

  init(ctx: ComponentContext): void {
    const path = NodeRegistry.computeNodePath(this.node);
    const writer = createSignalWriter(
      ctx.signalStore,
      `component:Drive_DestinationMotor:${path}`,
      'component',
      { slotContext: path },
    );
    const drive = ctx.registry.getByPath<RVDrive>('Drive', path);
    if (!drive) {
      console.error(`[Drive_DestinationMotor] no Drive at path="${path}"`);
      return;
    }
    this.drive = drive;

    // ── Inputs (PLC → drive) ──
    if (this.Destination) {
      ctx.signalStore.subscribeByPath(this.Destination, (v) => {
        this.commandDestination(v);
      });
    }
    if (this.StartDrive) {
      ctx.signalStore.subscribeByPath(this.StartDrive, (v) => {
        // Web has no TargetStartMove flag — start on rising edge (the store only
        // fires this subscription on value change, so true→startMove once).
        this.commandStartDrive(v);
      });
    }
    if (this.TargetSpeed) {
      ctx.signalStore.subscribeByPath(this.TargetSpeed, (v) => {
        this.commandTargetSpeed(v);
      });
    }
    if (this.Acceleration) {
      ctx.signalStore.subscribeByPath(this.Acceleration, (v) => {
        this.commandAcceleration(v);
      });
    }

    // ── Feedback (drive → PLC) — ALWAYS, also under liveControlled (F6) ──
    // Chained via addAfterUpdate so direct-feedback listeners can subscribe.
    this.feedbackCb = () => {
      if (this.IsAtPosition) writer.setByPath(this.IsAtPosition, this.readFeedbackSlot('IsAtPosition'));
      if (this.IsAtSpeed) writer.setByPath(this.IsAtSpeed, this.readFeedbackSlot('IsAtSpeed'));
      if (this.IsAtDestination) writer.setByPath(this.IsAtDestination, this.readFeedbackSlot('IsAtDestination'));
      if (this.IsDriving) writer.setByPath(this.IsDriving, this.readFeedbackSlot('IsDriving'));
      for (let i = 0; i < this.feedbackListeners.length; i++) this.feedbackListeners[i]();
    };
    drive.addAfterUpdate(this.feedbackCb);
  }

  /**
   * Normalize a commanded position. For rotary (periodic) axes the destination
   * is wrapped onto the shortest path relative to the current position — a
   * turntable commanded 10° from 350° turns +20°, not −340°. Linear axes pass
   * through unchanged.
   */
  private normalize(target: number, drive: RVDrive): number {
    if (!drive.isRotary) return target;
    // Shortest-path delta wrapped to (-180, 180], added back to current position.
    let delta = (target - drive.currentPosition) % 360;
    if (delta > 180) delta -= 360;
    if (delta <= -180) delta += 360;
    return drive.currentPosition + delta;
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

// Register schema for auto-derivation of CONSUMED fields + hierarchy badge color.
registerComponentSchema('Drive_DestinationMotor', RVDriveDestinationMotor.schema, {
  badgeColor: '#29b6f6',
});
