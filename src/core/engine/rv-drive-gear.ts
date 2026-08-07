// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { Object3D } from 'three';
import { RVDrive, type IDriveBehavior } from './rv-drive';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponentSchema, loadSchemaFromSpec } from './rv-component-registry';
import { NodeRegistry } from './rv-node-registry';
import { debug } from './rv-debug';

/**
 * RVDriveGear — TypeScript port of Drive_Gear.cs
 *
 * Couples this drive to a master drive through a gear ratio. Every fixed step
 * the slave position is derived directly from the master, exactly like the C#
 * Drive_Gear.CalcFixedUpdate():
 *
 *   CurrentPosition = MasterDrive.CurrentPosition * GearFactor + Offset
 *   CurrentSpeed    = MasterDrive.CurrentSpeed    * GearFactor
 *
 * Typical uses: gripper fingers (mirrored via opposite ReverseDirection,
 * factor 1) or arrestor clamps where a single cylinder-driven master leaf
 * drives a mirrored slave leaf.
 *
 * Implements IDriveBehavior — owned by the slave drive and called from
 * drive.update() before physics, mirroring Unity's Drive.CalcFixedUpdate()
 * calling its DriveBehaviours. Because the slave position is copied (not
 * physics-integrated), the behavior writes CurrentPosition and applies the
 * transform itself; the slave's own physics is inert (IsRunning stays false).
 *
 * The DriveOrderPlugin topologically sorts viewer.drives so masters update
 * before their gear slaves; if that ordering is unavailable for a given master
 * the slave simply lags by one fixed step, which is visually harmless.
 */
export class RVDriveGear implements IDriveBehavior, RVComponent {
  // Loaded from the rv-ODT specification (schema/v1/rv-odt.json, plan-187).
  static readonly schema: ComponentSchema = loadSchemaFromSpec('Drive_Gear');

  readonly node: Object3D;
  isOwner = true;

  /** ComponentRef → resolved to the master RVDrive instance by
   *  resolveComponentRefs() before init(). May stay a raw string / null when
   *  the master could not be resolved (handled with a path fallback in init). */
  MasterDrive: RVDrive | string | null = null;
  GearFactor = 1;
  Offset = 0;

  private drive: RVDrive | null = null;
  private master: RVDrive | null = null;

  constructor(node: Object3D) {
    this.node = node;
  }

  init(context: ComponentContext): void {
    const path = NodeRegistry.computeNodePath(this.node);

    // The slave drive lives on the same node as this behavior.
    const drive = context.registry.getByPath<RVDrive>('Drive', path);
    if (!drive) {
      console.warn(`[Drive_Gear] No Drive found at "${path}" — behavior inactive`);
      return;
    }
    this.drive = drive;

    // MasterDrive is resolved to an RVDrive instance by resolveComponentRefs().
    // Fallback: look it up by the raw ref path from the behavior extras — covers
    // the case where resolution returned null (e.g. a registry suffix-map miss).
    let master = (this.MasterDrive && typeof this.MasterDrive !== 'string')
      ? (this.MasterDrive as RVDrive)
      : null;
    if (!master) {
      const raw = drive.BehaviorExtras['Drive_Gear']?.['MasterDrive'] as { path?: string } | undefined;
      if (raw?.path) master = context.registry.getByPath<RVDrive>('Drive', raw.path) ?? null;
    }
    if (!master) {
      console.warn(`[Drive_Gear] "${drive.name}": MasterDrive could not be resolved — behavior inactive`);
      return;
    }
    this.master = master;

    // Register self as a drive behavior so drive.update() calls our update().
    drive.driveBehaviors.push(this);

    debug('loader',
      `  Drive_Gear "${drive.name}": master="${master.name}" factor=${this.GearFactor} offset=${this.Offset}`);
  }

  /** Called every fixed timestep from the slave drive's update(), before physics.
   *  Transfers the master position/speed through the gear ratio and applies the
   *  transform (the slave's own physics stays inert). */
  update(_dt: number): void {
    const drive = this.drive;
    const master = this.master;
    if (!drive || !master) return;
    // Recording playback owns the transform — don't fight it.
    if (drive.positionOverwrite) return;

    drive.currentPosition = master.currentPosition * this.GearFactor + this.Offset;
    drive.currentSpeed = master.currentSpeed * this.GearFactor;
    drive.applyToNode();
  }
}

// Register schema so rv-extras-validator auto-derives CONSUMED fields.
registerComponentSchema('Drive_Gear', RVDriveGear.schema, {
  badgeColor: '#29b6f6',
});
