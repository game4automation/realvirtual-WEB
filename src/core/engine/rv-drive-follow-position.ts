// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { Object3D } from 'three';
import { RVDrive, type IDriveBehavior } from './rv-drive';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponentSchema, loadSchemaFromSpec } from './rv-component-registry';
import { NodeRegistry } from './rv-node-registry';
import {
  createSignalWriter,
  type SignalStore,
  type SignalWriter,
} from './rv-signal-store';
import { debug } from './rv-debug';

/**
 * RVDriveFollowPosition — TypeScript port of Drive_FollowPosition.cs
 *
 * The drive follows the PLC-commanded position exactly, every fixed step —
 * used to couple motion / robot controllers to a realvirtual drive:
 *
 *   Drive.CurrentPosition = Position * Scale + Offset            (command)
 *   CurrentPosition       = ((Drive.CurrentPosition - Offset)    (feedback)
 *                            / Scale) * CurrentPositionScale
 *
 * PLC IOs (Unity parity — same field names as Drive_FollowPosition.cs):
 *   Position        — PLCOutput (PLC → drive): commanded position in mm
 *   CurrentPosition — PLCInput  (drive → PLC): position feedback in mm
 *
 * Implements IDriveBehavior — owned by the drive and called from drive.update()
 * BEFORE physics, mirroring Unity's Drive.CalcFixedUpdate() calling its
 * DriveBehaviours. Because the position is copied (not physics-integrated), the
 * behavior writes currentPosition and applies the transform itself; the drive's
 * own physics stays inert (no jog, no active move → updatePositioning returns
 * early), exactly like RVDriveGear.
 *
 * Feedback is written inline in the same update() from the just-set position —
 * this reads the value C# reads in its single CalcFixedUpdate, so the two paths
 * are frame-exact.
 */
export class RVDriveFollowPosition implements IDriveBehavior, RVComponent {
  // Loaded from the rv-ODT specification (schema/v1/rv-odt.json, plan-187).
  static readonly schema: ComponentSchema = loadSchemaFromSpec('Drive_FollowPosition');

  readonly node: Object3D;
  isOwner = true;

  // ComponentRef → resolved to SignalStore address strings (null when not wired).
  Position: string | null = null;
  CurrentPosition: string | null = null;

  // Settings (PascalCase, parity with C#).
  Offset = 0;
  Scale = 1;
  CurrentPositionScale = 1;
  ScaleFeedbackPosition = true;

  private drive: RVDrive | null = null;
  private signalStore: SignalStore | null = null;
  private signalWriter: SignalWriter | null = null;
  private positionSignalName: string | null = null;
  private directPosition: number | null = null;
  private holdPosition: number | null = null;
  private wasLive = false;
  private feedbackCb: ((drive: RVDrive) => void) | null = null;
  private readonly feedbackListeners: (() => void)[] = [];

  constructor(node: Object3D) {
    this.node = node;
  }

  commandPosition(value: boolean | number): void {
    this.directPosition = Number(value) * this.Scale + this.Offset;
  }

  neutralizePosition(): void {
    this.directPosition = null;
    if (this.drive) this.drive.currentSpeed = 0;
  }

  addFeedbackListener(cb: () => void): void {
    if (!this.feedbackListeners.includes(cb)) this.feedbackListeners.push(cb);
  }

  removeFeedbackListener(cb: () => void): void {
    const index = this.feedbackListeners.indexOf(cb);
    if (index >= 0) this.feedbackListeners.splice(index, 1);
  }

  readFeedbackSlot(slot: string): boolean | number {
    if (slot !== 'CurrentPosition') throw new Error(`[Drive_FollowPosition] Unknown feedback slot "${slot}"`);
    const drive = this.drive;
    if (!drive) return 0;
    const scale = this.Scale || 1;
    return this.ScaleFeedbackPosition
      ? ((drive.currentPosition - this.Offset) / scale) * this.CurrentPositionScale
      : drive.currentPosition;
  }

  init(context: ComponentContext): void {
    const path = NodeRegistry.computeNodePath(this.node);

    const drive = context.registry.getByPath<RVDrive>('Drive', path);
    if (!drive) {
      console.warn(`[Drive_FollowPosition] No Drive found at "${path}" — behavior inactive`);
      return;
    }
    this.drive = drive;
    this.signalStore = context.signalStore;
    this.signalWriter = createSignalWriter(
      context.signalStore,
      `component:Drive_FollowPosition:${path}`,
      'component',
      { slotContext: path },
    );
    this.positionSignalName = this.Position
      ? (context.signalStore.nameForPath(this.Position) ?? this.Position)
      : null;

    // Register self as a drive behavior so drive.update() calls our update().
    drive.driveBehaviors.push(this);
    this.feedbackCb = () => {
      for (let i = 0; i < this.feedbackListeners.length; i++) this.feedbackListeners[i]();
    };
    drive.addAfterUpdate(this.feedbackCb);

    debug('loader',
      `  Drive_FollowPosition "${drive.name}": ` +
      `pos="${this.Position}" fb="${this.CurrentPosition}" ` +
      `scale=${this.Scale} offset=${this.Offset}`);
  }

  /** Called every fixed timestep from the drive's update(), before physics.
   *  Snaps the drive to the commanded position and writes the feedback. */
  update(dt: number): void {
    const drive = this.drive;
    const store = this.signalStore;
    if (!drive || !store) return;
    // Recording playback owns the transform — don't fight it.
    if (drive.positionOverwrite) return;

    // A disconnected control binding neutralizes its target signal to zero.
    // Latch the last live position before reading that neutralized value, then
    // release the latch only on a new live binding or an explicit operator force.
    if (drive.liveControlled
      || (this.positionSignalName !== null && store.isForced(this.positionSignalName))) {
      this.holdPosition = null;
    } else if (this.wasLive) {
      this.holdPosition = drive.currentPosition;
    }
    this.wasLive = drive.liveControlled;

    // Command: follow the PLC position exactly (mirrors Drive.SetPosition()).
    if (this.holdPosition !== null) {
      drive.currentPosition = this.holdPosition;
      drive.currentSpeed = 0;
      drive.applyToNode();
    } else if (this.directPosition !== null || this.Position) {
      const prev = drive.currentPosition;
      const target = this.directPosition
        ?? (store.getFloatByPath(this.Position!) * this.Scale + this.Offset);
      drive.currentPosition = target;
      // Derive speed from the position delta so charts show data. isRunning is
      // left FALSE on purpose: the drive's own positioning must stay inert so it
      // doesn't integrate toward targetPosition and overwrite the followed value
      // (same reason RVDriveGear copies position without arming physics).
      drive.currentSpeed = dt > 0 ? Math.abs(target - prev) / dt : 0;
      drive.applyToNode();
      if (target !== prev) drive.markBehaviorChanged();
    }

    // Feedback: report the current position back to the PLC.
    if (this.CurrentPosition) {
      this.signalWriter!.setByPath(this.CurrentPosition, this.readFeedbackSlot('CurrentPosition'));
    }
  }

  dispose(): void {
    if (this.drive) {
      const index = this.drive.driveBehaviors.indexOf(this);
      if (index >= 0) this.drive.driveBehaviors.splice(index, 1);
      if (this.feedbackCb) this.drive.removeAfterUpdate(this.feedbackCb);
    }
    this.feedbackCb = null;
    this.drive = null;
    this.signalStore = null;
    this.signalWriter = null;
    this.positionSignalName = null;
    this.holdPosition = null;
    this.wasLive = false;
    this.feedbackListeners.length = 0;
  }
}

// Register schema so rv-extras-validator auto-derives CONSUMED fields.
registerComponentSchema('Drive_FollowPosition', RVDriveFollowPosition.schema, {
  badgeColor: '#29b6f6',
});
