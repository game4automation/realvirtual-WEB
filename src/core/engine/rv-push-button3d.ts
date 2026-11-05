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
import { wireDisplaySignal } from './rv-signal-wiring';
import { slotBound } from './rv-slot-io';

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
    // A direct viewer binding (SlotIO) counts as wired too.
    base.autoLight = !slotBound(this, 'lightSignal', this.lightAddress());
  }

  /** Unity `Update()`: `if (useSignalLight) base.SetLight(lightSignal.Value)` — as
   *  a subscription instead of a per-frame poll. */
  protected onWired(base: RVSceneButtonBase): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const address = this.lightAddress();
    // plan-427: idempotent level setter — a replay after reset/reconnect just
    // re-confirms the lamp state the PLC still holds. Unwired, the slot is
    // bound directly (SlotIO): binding takes the light away from the button
    // state, neutralize hands it back — `autoLight` is re-evaluated per call.
    this._unsubLight = wireDisplaySignal(ctx.signalStore, address, (value) => {
      const bound = slotBound(this, 'lightSignal', address);
      base.autoLight = !bound;
      base.setLight(bound ? Boolean(value) : base.active);
    }, undefined, ctx.reapply, { instance: this, field: 'lightSignal', unbound: false }).unsubscribe;
  }

  private lightAddress(): string | null {
    return typeof this.lightSignal === 'string' ? this.lightSignal : null;
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
    // A clickable ACTION, not a selectable part: the click fires the button,
    // the node is never selected (plan-753 §2.3; the SceneButtonBase below
    // this node is the physical click target, plan-417 §2.4).
    pick: 'action',
    ui: { filter: 'Buttons', category: 'hmi', badge: '#7e57c2' },
  },
  create: (node: Object3D) => new RVPushButton3D(node),
  afterCreate: (inst, node) => {
    setComponentInstance(node, inst);
  },
});
