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

  /** The resolved master drive (null while inactive) — read by the pose adapter (plan-641 M6). */
  get masterDrive(): RVDrive | null {
    return this.master;
  }

  /** The slave drive this behavior moves (null while inactive). */
  get slaveDrive(): RVDrive | null {
    return this.drive;
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
    // Anything else — a raw string, or an UNRESOLVED reference object (an untagged
    // `{ path, componentType }` the loader never resolves, plan-612 b0) — is no
    // master: taking it would drive the slave from `undefined` (silent NaN).
    let master = this.MasterDrive instanceof RVDrive ? this.MasterDrive : null;
    // Fallback: look it up by the raw ref path from the behavior extras — covers
    // the case where resolution returned null (e.g. a registry suffix-map miss).
    if (!master) {
      const raw = drive.BehaviorExtras['Drive_Gear']?.['MasterDrive'] as { path?: string } | undefined;
      const hit = raw?.path ? context.registry.getByPath<RVDrive>('Drive', raw.path) : null;
      master = hit instanceof RVDrive ? hit : null;
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

  /** The geared position this behavior asks for, in slave drive units. */
  get gearedPosition(): number {
    const master = this.master;
    return master ? master.currentPosition * this.GearFactor + this.Offset : Number.NaN;
  }

  /**
   * plan-673 Phase 5 — the gear coupling as a SETPOINT, for a slave axis whose
   * position MuJoCo owns.
   *
   * The realvirtual idiom for a parallel gripper is a `Drive_Cylinder` on a
   * `Drive{Direction:'Virtual'}` with one `Drive_Gear` per jaw. A `Virtual`
   * drive is never a rigid body, so the MJCF writer makes the FIRST geared jaw
   * the actuated lead and couples the second to it with an `<equality>` row
   * (`virtualGearLeads()`, Phase 4b). That left exactly one gap: the lead jaw's
   * actuator had nobody writing its setpoint, because {@link update} — the only
   * thing that knows the gear ratio — is never reached once the jaw is
   * physics-driven (`positionOverwrite` returns before the behavior loop).
   *
   * This is that route, and it is deliberately the SETPOINT and nothing else:
   * the jaw closes because the actuator is told to, and `forcerange` decides how
   * hard it actually holds — which is what makes the grip force a datasheet
   * value instead of a function of the servo gain. Writing `currentPosition`
   * here (what {@link update} does) would overwrite the measurement MuJoCo
   * just produced and the whole `forcefit` mode would report the commanded
   * position as if it were the real one.
   *
   * `RVDrive` only calls this on a dynamic axis; the guard repeats that
   * invariant because the method is public. The kinematic gripper of every
   * non-physics scene therefore keeps running through {@link update},
   * untouched — the earlier attempt to route `update()` itself through the
   * setpoint killed exactly that.
   */
  commandDynamicSetpoint(_dt: number): void {
    const drive = this.drive;
    const master = this.master;
    if (!drive || !master || !drive.dynamicAxis) return;
    drive.commandPosition(master.currentPosition * this.GearFactor + this.Offset);
  }
}

// Register schema so rv-extras-validator auto-derives CONSUMED fields.
registerComponentSchema('Drive_Gear', RVDriveGear.schema, {
  bake: 'chunk', // sits on the Drive node it extends — moves with it (plan-753 §2.3)
  authorable: true, // addable in the asset editor on a node that carries a Drive
  ui: { badge: '#29b6f6' },
});
