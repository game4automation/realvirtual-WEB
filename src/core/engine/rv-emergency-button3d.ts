// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-emergency-button3d.ts — browser runtime counterpart of Unity's
 * `EmergencyButton3D` (plan-417).
 *
 * A latching mushroom head that writes its `stateSignal`. The latching itself
 * comes from the authored `SceneButtonBase.isToggle` — like Unity, this wrapper
 * only wires the signal and the optional self-click on start.
 *
 * NOTE: a virtual emergency stop is a comfort trigger and a status display. It
 * is never the safety function and never a substitute for a hard-wired
 * emergency stop.
 */

import type { Object3D } from 'three';
import type { ComponentSchema } from './rv-component-registry';
import {
  loadSchemaFromSpec,
  registerComponent,
  setComponentInstance,
} from './rv-component-registry';
import type { RVSceneButtonBase } from './rv-scene-button-base';
import { RVSceneButtonWrapper } from './rv-scene-button-wrapper';

/** Browser runtime counterpart of Unity's EmergencyButton3D component. */
export class RVEmergencyButton3D extends RVSceneButtonWrapper {
  static readonly schema: ComponentSchema = loadSchemaFromSpec('EmergencyButton3D');

  protected configure(_base: RVSceneButtonBase): void {
    // Unity parity: EmergencyButton3D.Start() only wires the signal; the
    // latching behavior stays as authored on the SceneButtonBase.
  }
}

registerComponent({
  type: 'EmergencyButton3D',
  schema: RVEmergencyButton3D.schema,
  capabilities: {
    hoverable: false,
    selectable: false,
    filterLabel: 'Buttons',
    badgeColor: '#e53935',
  },
  create: (node: Object3D) => new RVEmergencyButton3D(node),
  afterCreate: (inst, node) => {
    setComponentInstance(node, inst);
  },
});
