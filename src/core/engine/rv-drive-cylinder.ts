// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { Object3D } from 'three';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponentSchema } from './rv-component-registry';
import { RVDrive } from './rv-drive';
import { NodeRegistry } from './rv-node-registry';
import { debug } from './rv-debug';

/**
 * RVDriveCylinder — TypeScript port of Drive_Cylinder.cs
 *
 * Pneumatic/hydraulic cylinder: extends to MaxPos on Out signal, retracts to MinPos on In signal.
 * Speed = stroke / time. Supports OneBitCylinder mode (single signal toggles direction)
 * and InvertOutputLogic. Writes feedback signals for position state.
 */
export class RVDriveCylinder implements RVComponent {
  static readonly schema: ComponentSchema = {
    MinPos: { type: 'number', default: 0 },
    MaxPos: { type: 'number', default: 100 },
    TimeOut: { type: 'number', default: 1 },
    TimeIn: { type: 'number', default: 1 },
    OneBitCylinder: { type: 'boolean', default: false },
    InvertOutputLogic: { type: 'boolean', default: false },
    Out: { type: 'componentRef' },
    In: { type: 'componentRef' },
    IsOut: { type: 'componentRef' },
    IsIn: { type: 'componentRef' },
    IsMax: { type: 'componentRef' },
    IsMin: { type: 'componentRef' },
    IsMovingOut: { type: 'componentRef' },
    IsMovingIn: { type: 'componentRef' },
  };

  readonly node: Object3D;
  isOwner = true;

  // Schema properties (PascalCase matching C#)
  MinPos = 0;
  MaxPos = 100;
  TimeOut = 1;
  TimeIn = 1;
  OneBitCylinder = false;
  InvertOutputLogic = false;

  // ComponentRef → resolved to signal address strings
  Out: string | null = null;
  In: string | null = null;
  IsOut: string | null = null;
  IsIn: string | null = null;
  IsMax: string | null = null;
  IsMin: string | null = null;
  IsMovingOut: string | null = null;
  IsMovingIn: string | null = null;

  constructor(node: Object3D) {
    this.node = node;
  }

  init(context: ComponentContext): void {
    const path = NodeRegistry.computeNodePath(this.node);
    const drive = context.registry.getByPath<RVDrive>('Drive', path);
    if (!drive) return;

    const minPos = this.MinPos;
    const maxPos = this.MaxPos;
    const timeOut = this.TimeOut;
    const timeIn = this.TimeIn;
    const oneBit = this.OneBitCylinder;
    const invertLogic = this.InvertOutputLogic;
    const stroke = Math.abs(maxPos - minPos);

    debug('loader', `Drive_Cylinder "${drive.name}": min=${minPos} max=${maxPos} timeOut=${timeOut}s timeIn=${timeIn}s oneBit=${oneBit} invert=${invertLogic}`);

    // Set initial position
    drive.currentPosition = minPos;
    drive.applyToNode();

    // Out signal subscription
    if (this.Out) {
      const addr = this.Out;
      context.signalStore.subscribeByPath(addr, (value) => {
        let outVal = value === true;
        if (invertLogic) outVal = !outVal;
        if (oneBit) {
          if (outVal) {
            drive.targetSpeed = stroke / timeOut;
            drive.startMove(maxPos);
            debug('drive', `Cylinder "${drive.name}": OUT → ${maxPos}mm at ${drive.targetSpeed.toFixed(0)}mm/s`);
          } else {
            drive.targetSpeed = stroke / timeIn;
            drive.startMove(minPos);
            debug('drive', `Cylinder "${drive.name}": IN → ${minPos}mm at ${drive.targetSpeed.toFixed(0)}mm/s`);
          }
        } else {
          if (outVal) {
            drive.targetSpeed = stroke / timeOut;
            drive.startMove(maxPos);
            debug('drive', `Cylinder "${drive.name}": OUT → ${maxPos}mm at ${drive.targetSpeed.toFixed(0)}mm/s`);
          }
        }
      });
      debug('loader', `  Drive_Cylinder "${drive.name}": Out signal="${addr}"`);
    }

    // In signal subscription (only when NOT oneBit)
    if (this.In && !oneBit) {
      const addr = this.In;
      context.signalStore.subscribeByPath(addr, (value) => {
        let inVal = value === true;
        if (invertLogic) inVal = !inVal;
        if (inVal) {
          drive.targetSpeed = stroke / timeIn;
          drive.startMove(minPos);
        }
      });
      debug('loader', `  Drive_Cylinder "${drive.name}": In signal="${addr}"`);
    }

    // Feedback signals
    const feedbackRefs: { key: string; addr: string }[] = [];
    for (const [key, addr] of [
      ['IsOut', this.IsOut], ['IsIn', this.IsIn],
      ['IsMax', this.IsMax], ['IsMin', this.IsMin],
      ['IsMovingOut', this.IsMovingOut], ['IsMovingIn', this.IsMovingIn],
    ] as [string, string | null][]) {
      if (addr) {
        feedbackRefs.push({ key, addr });
        debug('loader', `  Drive_Cylinder "${drive.name}": ${key} feedback="${addr}"`);
      }
    }

    if (feedbackRefs.length > 0) {
      const fbMap = new Map(feedbackRefs.map(f => [f.key, f.addr]));
      let prevIsOut = false;
      let prevIsIn = true;

      drive.onAfterUpdate = (d) => {
        const atMax = Math.abs(d.currentPosition - maxPos) < 0.01;
        const atMin = Math.abs(d.currentPosition - minPos) < 0.01;
        const isOut = atMax;
        const isIn = atMin;
        const movingOut = d.isRunning && d.targetPosition === maxPos;
        const movingIn = d.isRunning && d.targetPosition === minPos;

        if (isOut !== prevIsOut) {
          debug('drive', `Cylinder "${d.name}" IsOut changed: ${prevIsOut}→${isOut} (pos=${d.currentPosition.toFixed(4)}, maxPos=${maxPos}, overwrite=${d.positionOverwrite})`);
          if (fbMap.has('IsOut')) context.signalStore.setByPath(fbMap.get('IsOut')!, isOut);
          if (fbMap.has('IsMax')) context.signalStore.setByPath(fbMap.get('IsMax')!, atMax);
          prevIsOut = isOut;
        }
        if (isIn !== prevIsIn) {
          if (fbMap.has('IsIn')) context.signalStore.setByPath(fbMap.get('IsIn')!, isIn);
          if (fbMap.has('IsMin')) context.signalStore.setByPath(fbMap.get('IsMin')!, atMin);
          prevIsIn = isIn;
        }
        if (fbMap.has('IsMovingOut')) context.signalStore.setByPath(fbMap.get('IsMovingOut')!, movingOut);
        if (fbMap.has('IsMovingIn')) context.signalStore.setByPath(fbMap.get('IsMovingIn')!, movingIn);
      };
    }
  }
}

// Register schema for auto-derivation of CONSUMED fields
registerComponentSchema('Drive_Cylinder', RVDriveCylinder.schema, {
  badgeColor: '#29b6f6',
});
