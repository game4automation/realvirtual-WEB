// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-handle-switch3d.ts — browser runtime counterpart of Unity's
 * `HandleSwitch3D` (plan-417).
 *
 * A latching lever that writes its `stateSignal`. The lever rotation comes from
 * the `SceneButtonMoveable` cap (`angularMovement`), the latching from the
 * authored `SceneButtonBase.isToggle` — like Unity, this wrapper only wires the
 * signal and the optional self-click on start.
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

/** Browser runtime counterpart of Unity's HandleSwitch3D component. */
export class RVHandleSwitch3D extends RVSceneButtonWrapper {
  static readonly schema: ComponentSchema = loadSchemaFromSpec('HandleSwitch3D');

  protected configure(_base: RVSceneButtonBase): void {
    // Unity parity: HandleSwitch3D.Start() only wires the signal.
  }
}

registerComponent({
  type: 'HandleSwitch3D',
  schema: RVHandleSwitch3D.schema,
  capabilities: {
    hoverable: false,
    selectable: false,
    filterLabel: 'Buttons',
    badgeColor: '#7e57c2',
  },
  create: (node: Object3D) => new RVHandleSwitch3D(node),
  afterCreate: (inst, node) => {
    setComponentInstance(node, inst);
  },
});
