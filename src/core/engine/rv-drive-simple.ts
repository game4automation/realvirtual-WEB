// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { Object3D } from 'three';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponentSchema } from './rv-component-registry';
import { RVDrive } from './rv-drive';
import { NodeRegistry } from './rv-node-registry';
import { wireBoolSignal } from './rv-signal-wiring';

/**
 * RVDriveSimple — TypeScript port of Drive_Simple.cs
 *
 * Wires Forward/Backward PLCOutputBool signals to the parent drive's
 * jogForward/jogBackward properties, enabling continuous jog motion
 * driven by PLC output signals.
 *
 * Uses init() to wire up subscriptions after all signals are registered,
 * exactly mirroring the Unity two-phase Awake/Start initialisation pattern.
 */
export class RVDriveSimple implements RVComponent {
  static readonly schema: ComponentSchema = {
    Forward: { type: 'componentRef' },
    Backward: { type: 'componentRef' },
  };

  readonly node: Object3D;
  isOwner = true;

  /** Forward jog signal address (resolved from Forward componentRef) */
  Forward: string | null = null;

  /** Backward jog signal address (resolved from Backward componentRef) */
  Backward: string | null = null;

  constructor(node: Object3D) {
    this.node = node;
  }

  init(context: ComponentContext): void {
    // Find the Drive on the same node
    const path = NodeRegistry.computeNodePath(this.node);
    const drive = context.registry.getByPath<RVDrive>('Drive', path);
    if (!drive) {
      console.error(`[Drive_Simple] NO DRIVE found at path="${path}"`);
      return;
    }

    // Wire Forward/Backward jog signals
    wireBoolSignal(context.signalStore, this.Forward,
      (v) => { drive.jogForward = v; }, `Drive_Simple "${drive.name}": Forward signal`);
    wireBoolSignal(context.signalStore, this.Backward,
      (v) => { drive.jogBackward = v; }, `Drive_Simple "${drive.name}": Backward signal`);
  }
}

// Register schema for auto-derivation of CONSUMED fields
registerComponentSchema('Drive_Simple', RVDriveSimple.schema, {
  badgeColor: '#29b6f6',
});
