// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { Object3D } from 'three';
import { RVDrive, type IDriveBehavior } from './rv-drive';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponentSchema, loadSchemaFromSpec } from './rv-component-registry';
import { NodeRegistry } from './rv-node-registry';
import { createSignalWriter, type SignalWriter } from './rv-signal-store';
import { debug } from './rv-debug';

/** One position range that contributes to the output (parity with C# PositionArea). */
interface PositionArea {
  StartPosition: number;
  EndPosition: number;
}

/**
 * RVDrivePositionSwitch — TypeScript port of Drive_PositionSwitch.cs
 *
 * Sets a boolean output when the drive position is inside ANY of the configured
 * areas (OR logic). Mirrors Drive_PositionSwitch.CalcFixedUpdate():
 *
 *   adjustedPos = Drive.CurrentPosition + PositionOffset
 *   inAnyArea   = OR over areas (start..end, or wrapped when start > end)
 *   OutputSignal = InvertAreas ? !inAnyArea : inAnyArea
 *
 * PLC IOs (Unity parity — same field names as Drive_PositionSwitch.cs):
 *   OutputSignal — PLCInput (drive → PLC): true when in any area (or inverted)
 *
 * The `Areas` list is not a scalar schema type, so it is read from the behavior's
 * rv_extras record in init() (mirroring how the C# serializes List<PositionArea>).
 *
 * Note: the Unity component additionally normalizes the position for wrapping
 * drives (JumpToLowerLimitOnUpperLimit). The web RVDrive does not model wrapping,
 * so no normalization is applied; wrapped AREAS (StartPosition > EndPosition) are
 * still supported via an OR range check.
 */
export class RVDrivePositionSwitch implements IDriveBehavior, RVComponent {
  // Loaded from the rv-ODT specification (schema/v1/rv-odt.json, plan-187).
  static readonly schema: ComponentSchema = loadSchemaFromSpec('Drive_PositionSwitch');

  readonly node: Object3D;
  isOwner = true;

  OutputSignal: string | null = null;
  InvertAreas = false;
  PositionOffset = 0;

  private drive: RVDrive | null = null;
  private signalWriter: SignalWriter | null = null;
  private areas: PositionArea[] = [];
  private feedbackCb: ((drive: RVDrive) => void) | null = null;
  private readonly feedbackListeners: (() => void)[] = [];

  constructor(node: Object3D) {
    this.node = node;
  }

  addFeedbackListener(cb: () => void): void {
    if (!this.feedbackListeners.includes(cb)) this.feedbackListeners.push(cb);
  }

  removeFeedbackListener(cb: () => void): void {
    const index = this.feedbackListeners.indexOf(cb);
    if (index >= 0) this.feedbackListeners.splice(index, 1);
  }

  evaluateOutput(drivePosition: number): boolean {
    const adjustedPos = drivePosition + this.PositionOffset;
    let inAnyArea = false;
    for (const area of this.areas) {
      const isInArea = area.StartPosition > area.EndPosition
        ? adjustedPos >= area.StartPosition || adjustedPos <= area.EndPosition
        : adjustedPos >= area.StartPosition && adjustedPos <= area.EndPosition;
      if (isInArea) {
        inAnyArea = true;
        break;
      }
    }
    return this.InvertAreas ? !inAnyArea : inAnyArea;
  }

  readFeedbackSlot(slot: string): boolean | number {
    if (slot !== 'OutputSignal') throw new Error(`[Drive_PositionSwitch] Unknown feedback slot "${slot}"`);
    return this.evaluateOutput(this.drive?.currentPosition ?? 0);
  }

  init(context: ComponentContext): void {
    const path = NodeRegistry.computeNodePath(this.node);

    const drive = context.registry.getByPath<RVDrive>('Drive', path);
    if (!drive) {
      console.warn(`[Drive_PositionSwitch] No Drive found at "${path}" — behavior inactive`);
      return;
    }
    this.drive = drive;
    this.signalWriter = createSignalWriter(
      context.signalStore,
      `component:Drive_PositionSwitch:${path}`,
      'component',
      { slotContext: path },
    );

    // Areas come from the behavior's rv_extras record (List<PositionArea> in C#).
    const extras = drive.BehaviorExtras['Drive_PositionSwitch'] as Record<string, unknown> | undefined;
    const rawAreas = extras?.['Areas'];
    if (Array.isArray(rawAreas)) {
      this.areas = rawAreas.map((a) => {
        const o = a as Record<string, unknown>;
        return {
          StartPosition: Number(o['StartPosition'] ?? 0),
          EndPosition: Number(o['EndPosition'] ?? 0),
        };
      });
    }

    // Register self as a drive behavior so drive.update() calls our update().
    drive.driveBehaviors.push(this);
    this.feedbackCb = () => {
      for (let i = 0; i < this.feedbackListeners.length; i++) this.feedbackListeners[i]();
    };
    drive.addAfterUpdate(this.feedbackCb);

    debug('loader',
      `  Drive_PositionSwitch "${drive.name}": ` +
      `areas=${this.areas.length} invert=${this.InvertAreas} offset=${this.PositionOffset} ` +
      `out="${this.OutputSignal}"`);
  }

  /** Called every fixed timestep from the drive's update(). */
  update(_dt: number): void {
    const drive = this.drive;
    const writer = this.signalWriter;
    if (!drive || !writer || !this.OutputSignal) return;

    writer.setByPath(this.OutputSignal, this.evaluateOutput(drive.currentPosition));
  }

  dispose(): void {
    if (this.drive) {
      const index = this.drive.driveBehaviors.indexOf(this);
      if (index >= 0) this.drive.driveBehaviors.splice(index, 1);
      if (this.feedbackCb) this.drive.removeAfterUpdate(this.feedbackCb);
    }
    this.feedbackCb = null;
    this.drive = null;
    this.signalWriter = null;
    this.feedbackListeners.length = 0;
  }
}

// Register schema so rv-extras-validator auto-derives CONSUMED fields.
registerComponentSchema('Drive_PositionSwitch', RVDrivePositionSwitch.schema, {
  badgeColor: '#29b6f6',
});
