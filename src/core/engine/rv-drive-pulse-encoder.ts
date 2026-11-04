// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { Object3D } from 'three';
import type { RVDrive } from './rv-drive';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponent, loadSchemaFromSpec } from './rv-component-registry';
import { NodeRegistry } from './rv-node-registry';
import { createSignalWriter, type SignalWriter } from './rv-signal-store';
import { debug } from './rv-debug';
import { slotDeclare, slotUndeclare, slotWrite } from './rv-slot-io';

/**
 * RVDrivePulseEncoder — TypeScript port of DrivePulseEncoder.cs
 *
 * An incremental pulse encoder on a Drive: every time the drive position passes
 * the next pulse mark (`Offset`, `Offset + PulseIntervall`, `Offset + 2 ·
 * PulseIntervall`, …) the bool signal is TOGGLED. Mirrors
 * DrivePulseEncoder.FixedUpdate():
 *
 *   if (Drive.CurrentPosition > intervall) { intervall += PulseIntervall; Signal = !Signal }
 *
 * Two deliberate differences from the C# original:
 *  - it is NOT a `Drive_*` behavior (its Unity name carries no underscore), so
 *    it sits on the drive node NEXT TO the one active `Drive_*` behavior and is
 *    constructed through the ordinary component factory;
 *  - a `PulseIntervall` of 0 (the C# default) would toggle every tick forever
 *    once the position passes the offset; here it disables the encoder.
 *
 * The encoder runs after the drive's physics step (`addAfterUpdate`), so it
 * sees the position of the tick it reports on.
 */
export class RVDrivePulseEncoder implements RVComponent {
  // Loaded from the rv-ODT specification (schema/v1/rv-odt.json, plan-187).
  static readonly schema: ComponentSchema = loadSchemaFromSpec('DrivePulseEncoder');

  readonly node: Object3D;
  isOwner = true;

  // ComponentRef → resolved to SignalStore address string (null when not wired).
  PulseEncoderSignal: string | null = null;

  // Settings (PascalCase, parity with C# — including the "Intervall" spelling).
  PulseIntervall = 0;
  Offset = 0;

  /** Current signal level — runtime only. */
  value = false;

  private drive: RVDrive | null = null;
  private signalWriter: SignalWriter | null = null;
  private nextPulseAt = 0;
  private afterUpdateCb: ((drive: RVDrive) => void) | null = null;

  constructor(node: Object3D) {
    this.node = node;
  }

  init(context: ComponentContext): void {
    const path = NodeRegistry.computeNodePath(this.node);

    const drive = context.registry.getByPath<RVDrive>('Drive', path);
    if (!drive) {
      console.warn(`[DrivePulseEncoder] No Drive found at "${path}" — encoder inactive`);
      return;
    }
    // The unwired slot stays bindable in the viewer (SlotIO, rv-slot-io.ts) —
    // also while the encoder is inactive; it then reports a steady `false`.
    slotDeclare(this, 'PulseEncoderSignal', 'feedback', { initial: false });
    if (!(this.PulseIntervall > 0)) {
      console.warn(`[DrivePulseEncoder] PulseIntervall must be > 0 at "${path}" — encoder inactive`);
      return;
    }
    this.drive = drive;
    this.signalWriter = createSignalWriter(
      context.signalStore,
      `component:DrivePulseEncoder:${path}`,
      'component',
      { slotContext: path },
    );
    this.nextPulseAt = this.PulseIntervall + this.Offset;
    this.value = false;
    slotWrite(this, 'PulseEncoderSignal', this.PulseEncoderSignal, false, this.signalWriter);

    this.afterUpdateCb = (d) => this.tick(d);
    drive.addAfterUpdate(this.afterUpdateCb);

    debug('loader',
      `  DrivePulseEncoder "${drive.name}": interval=${this.PulseIntervall} offset=${this.Offset} signal="${this.PulseEncoderSignal}"`);
  }

  /** One encoder step — exposed for tests; the drive calls it after every physics tick. */
  tick(drive: RVDrive): void {
    if (drive.currentPosition > this.nextPulseAt) {
      this.nextPulseAt += this.PulseIntervall;
      this.value = !this.value;
      slotWrite(this, 'PulseEncoderSignal', this.PulseEncoderSignal, this.value, this.signalWriter);
    }
  }

  dispose(): void {
    slotUndeclare(this);
    if (this.drive && this.afterUpdateCb) this.drive.removeAfterUpdate(this.afterUpdateCb);
    this.afterUpdateCb = null;
    this.drive = null;
    this.signalWriter = null;
  }
}

// Self-register for auto-discovery by the scene loader (ordinary component,
// NOT a Drive_* behavior — see the class comment).
registerComponent({
  type: 'DrivePulseEncoder',
  schema: RVDrivePulseEncoder.schema,
  capabilities: {
    bake: 'chunk', // sits on the Drive node it extends — moves with it (plan-753 §2.3)
    authorable: true, // addable in the asset editor on a node that carries a Drive
    ui: { badge: '#29b6f6' },
  },
  create: (node) => new RVDrivePulseEncoder(node),
});
