// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-push-button3d.ts — browser runtime counterpart of Unity's `PushButton3D`
 * (plan-417).
 *
 * Configures the `SceneButtonBase` below it (toggle vs. momentary with `timer`)
 * and owns the light source decision: with a `lightSignal` wired, the light
 * follows that PLC output; without one, it follows the button's own state
 * (`autoLight`) — exactly like `PushButton3D.Start()` / `Update()` in Unity.
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
import { wireValueSignal } from './rv-signal-wiring';

/** Browser runtime counterpart of Unity's PushButton3D component. */
export class RVPushButton3D extends RVSceneButtonWrapper {
  static readonly schema: ComponentSchema = loadSchemaFromSpec('PushButton3D');

  /** Resolved PLC output signal address driving the button light (or null). */
  lightSignal: string | null = null;
  label = '';
  timer = 0.5;
  toggle = false;

  private _unsubLight?: () => void;

  protected configure(base: RVSceneButtonBase): void {
    base.isToggle = this.toggle;
    base.simpleClickTime = this.timer;
    // Unity: a wired lightSignal takes the light away from the button state.
    base.autoLight = typeof this.lightSignal !== 'string';
  }

  /** Unity `Update()`: `if (useSignalLight) base.SetLight(lightSignal.Value)` — as
   *  a subscription instead of a per-frame poll. */
  protected onWired(base: RVSceneButtonBase): void {
    const ctx = this.ctx;
    const address = typeof this.lightSignal === 'string' ? this.lightSignal : null;
    if (!address || !ctx) return;
    // plan-427: idempotent level setter — a replay after reset/reconnect just
    // re-confirms the lamp state the PLC still holds.
    this._unsubLight = wireValueSignal(ctx.signalStore, address, (value) => {
      base.setLight(Boolean(value));
    }, undefined, ctx.reapply).unsubscribe;
  }

  dispose(): void {
    this._unsubLight?.();
    this._unsubLight = undefined;
    super.dispose();
  }
}

registerComponent({
  type: 'PushButton3D',
  schema: RVPushButton3D.schema,
  capabilities: {
    // The click target is the SceneButtonBase below this node, never the
    // wrapper itself (plan-417 §2.4).
    hoverable: false,
    selectable: false,
    filterLabel: 'Buttons',
    badgeColor: '#7e57c2',
  },
  create: (node: Object3D) => new RVPushButton3D(node),
  afterCreate: (inst, node) => {
    setComponentInstance(node, inst);
  },
});
