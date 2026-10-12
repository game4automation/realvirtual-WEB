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
 * plan-538 F4 — `NormallyClosed`: the signal is true while the button is
 * released (OK) and false while it is pressed, like an NC emergency-stop
 * contact. The released value is written at start; the visuals are unchanged.
 * Default false = the signal carries the pressed state as today.
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

  /** plan-538 F4 — true: signal true = released (OK), false = pressed. */
  NormallyClosed = false;

  protected configure(base: RVSceneButtonBase): void {
    // Unity parity: EmergencyButton3D.Start() only wires the signal; the
    // latching behavior stays as authored on the SceneButtonBase. plan-538:
    // the NC inversion is set BEFORE the signal is wired, so the released
    // value is what the base writes at start.
    base.invertSignal = this.NormallyClosed === true;
  }
}

registerComponent({
  type: 'EmergencyButton3D',
  schema: RVEmergencyButton3D.schema,
  capabilities: {
    pick: 'action',   // click fires the button, never selects the node (plan-753 §2.3)
    ui: { filter: 'Buttons', category: 'hmi', badge: '#e53935' },
  },
  create: (node: Object3D) => new RVEmergencyButton3D(node),
  afterCreate: (inst, node) => {
    setComponentInstance(node, inst);
  },
});
