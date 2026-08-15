// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-scene-button-base.ts — browser runtime counterpart of Unity's
 * `SceneButtonBase` (plan-417).
 *
 * This is the CLICK AND HOVER TARGET of a 3D scene button: in Unity the same
 * component carries the collider and `OnMouseDown`, and in the WebViewer the
 * `ComponentEventDispatcher` routes `object-clicked` / `object-hover` here. The
 * wrapper components (`PushButton3D`, `EmergencyButton3D`, `HandleSwitch3D`)
 * only configure it — they are never the event target themselves.
 *
 * Write model (plan-417 §2.5). A click is an OPERATOR interaction, so BOTH
 * flanks — the `true` on click and the timed `false` of a momentary button —
 * go through one writer of operator kind (`hmi`). Operator writers are allowed
 * through `authority: bound` (`rv-signal-store.ts` canWriteSlot), so the PLC
 * sees the full pulse in live mode; a `component`-kind writer would be rejected
 * there and the button would look dead. `liveControlled` gates only AUTONOMOUS
 * state changes (e.g. an `activeOnStart` self-click), never the operator pulse.
 *
 * Confirmed state. The base also SUBSCRIBES to its own `stateSignal`, so the
 * visual state follows the store value. After a reconnect, a force or a remote
 * echo the optics resynchronize instead of drifting on a private flag.
 *
 * Deliberate deviation from Unity (documented, plan-417 §2.4): Unity holds a
 * momentary button down until `OnMouseUp` (`released` / `request_release`).
 * The WebViewer click pipeline delivers a single click event after pointerup,
 * so a momentary click is modelled as "active for `simpleClickTime` seconds
 * from the click" without hold semantics.
 */

import type { Object3D } from 'three';
import type { ComponentContext, ComponentSchema, RVComponent } from './rv-component-registry';
import {
  loadSchemaFromSpec,
  registerComponent,
  removeComponentInstance,
  setComponentInstance,
} from './rv-component-registry';
import { NodeRegistry } from './rv-node-registry';
import { createSignalWriter, type SignalWriter } from './rv-signal-store';
import type { SceneButtonManager } from './rv-scene-button-manager';
import type { RVSceneButtonMoveable } from './rv-scene-button-moveable';
import { wireValueSignal } from './rv-signal-wiring';

/** Who caused a state change — decides whether `liveControlled` may gate it. */
export type SceneButtonClickSource = 'operator' | 'auto';

/** Browser runtime counterpart of Unity's SceneButtonBase component. */
export class RVSceneButtonBase implements RVComponent {
  static readonly schema: ComponentSchema = loadSchemaFromSpec('SceneButtonBase');

  readonly node: Object3D;
  isOwner = true;

  // Schema fields — exact Unity (camelCase) names. `moveable` is resolved from
  // its ComponentReference to the instance by resolveComponentRefs().
  moveable: RVSceneButtonMoveable | string | null = null;
  autoLight = true;
  isToggle = false;
  simpleClickTime = 0.5;

  /** Raised by the signal-binding manager while a live source owns this slot. */
  liveControlled = false;

  private _ctx?: ComponentContext;
  private _manager?: SceneButtonManager;
  private _writer?: SignalWriter;
  private _stateSignal: string | null = null;
  private _unsubState?: () => void;

  private _active = false;
  private _timerRemaining = 0;
  private _timerRunning = false;
  /** Source of the click that armed the running timer — the release flank
   *  belongs to the same interaction and must be written the same way. */
  private _timerSource: SceneButtonClickSource = 'operator';

  constructor(node: Object3D) {
    this.node = node;
  }

  init(ctx: ComponentContext): void {
    this._ctx = ctx;
    this._manager = ctx.sceneButtonManager;
    this._manager?.register(this);
    const path = NodeRegistry.computeNodePath(this.node);
    // Operator kind on purpose — see the write model in the file header.
    this._writer = createSignalWriter(
      ctx.signalStore,
      `hmi:SceneButton:${path}`,
      'hmi',
      { slotContext: path },
    );
  }

  /** True while the button is pressed / latched. */
  get active(): boolean {
    return this._active;
  }

  /** Remaining hold time of a running momentary click, in seconds. */
  get timerRemaining(): number {
    return this._timerRunning ? this._timerRemaining : 0;
  }

  /** The resolved cap, or undefined while the reference is still raw/unresolved.
   *  Duck-typed rather than `instanceof`: the loader resolves refs per component
   *  in traversal order, so an early caller can still see the raw ComponentRef. */
  get cap(): RVSceneButtonMoveable | undefined {
    const m = this.moveable as RVSceneButtonMoveable | undefined;
    return m && typeof (m as { setLight?: unknown }).setLight === 'function' ? m : undefined;
  }

  /**
   * Wire the PLC input signal this button writes. Called by the wrapper
   * component (Unity: `SceneButtonBase.SetInputSignal`). Passing null unwires.
   */
  setStateSignal(address: string | null): void {
    this._unsubState?.();
    this._unsubState = undefined;
    this._stateSignal = address;
    if (!address || !this._ctx) return;

    // plan-427: BIDIRECTIONAL slot — the button writes this address on click and
    // reads it back here. `_syncFromSignal` returns early when the value already
    // matches, so a replay of the button's own last write is a pure no-op; what
    // it does buy is resynchronisation after a reset or a reconnect, where the
    // store may hold a state the optics no longer reflect.
    this._unsubState = wireValueSignal(this._ctx.signalStore, address, (value) => {
      this._syncFromSignal(Boolean(value));
    }, undefined, this._ctx.reapply).unsubscribe;
  }

  // ── Event hooks (ComponentEventDispatcher) ───────────────────────

  /** Pointer entered / left the button — Unity `OnMouseEnter` / `OnMouseExit`. */
  onHover(hovered: boolean): void {
    const cap = this.cap;
    if (!cap) return;
    if (hovered) cap.hover();
    else cap.unhover();
  }

  /** Unity `OnMouseDown` — the operator pressed the button. */
  onClick(): void {
    this.click('operator');
  }

  /** Programmatic click (Unity `SceneButtonBase.Click()`). */
  click(source: SceneButtonClickSource = 'operator'): void {
    // `liveControlled` blocks AUTONOMOUS state changes completely — not just
    // their write. Flipping the optics while the live source keeps the signal
    // at its own value would desynchronize the button from the PLC and, for a
    // momentary button, the local "already active" guard would then swallow the
    // operator's next real click.
    if (source === 'auto' && this.liveControlled) return;
    if (this.isToggle) {
      this._toggle(source);
      return;
    }
    this._simpleClickOn(source);
  }

  // ── Light ────────────────────────────────────────────────────────

  /** Unity `SetLight` — drive the cap light from outside (lightSignal). */
  setLight(on: boolean): void {
    this.cap?.setLight(on);
  }

  // ── Per-frame timer (driven by SceneButtonManager) ───────────────

  updateButton(dt: number): boolean {
    if (!this._timerRunning) return false;
    this._timerRemaining -= Math.max(0, dt);
    if (this._timerRemaining > 0) return false;
    this._timerRunning = false;
    this._timerRemaining = 0;
    this._manager?.setActive(this, false);
    // Unity SimpleClickOff → ToggleClick: the release flank of the SAME
    // interaction, hence the same source.
    if (this._active) this._toggle(this._timerSource);
    return true;
  }

  // ── Internals ────────────────────────────────────────────────────

  private _simpleClickOn(source: SceneButtonClickSource): void {
    // Unity parity: a re-click while the button is still held is ignored and
    // does NOT restart the timer.
    if (this._active) return;
    this._toggle(source);
    this._timerRemaining = Math.max(0, this.simpleClickTime);
    this._timerSource = source;
    if (this._timerRemaining <= 0) {
      // Degenerate configuration: release on the next tick rather than never.
      this._timerRemaining = 0;
    }
    this._timerRunning = true;
    this._manager?.setActive(this, true);
  }

  /** Unity `ToggleClick()` — flip state, animate, write the signal, light. */
  private _toggle(source: SceneButtonClickSource): void {
    const next = !this._active;
    this._applyActive(next, source);
    this._writeState(next, source);
  }

  /** Apply one state to the visuals (idempotent — also used by the signal echo). */
  private _applyActive(active: boolean, source: SceneButtonClickSource): void {
    const cap = this.cap;
    if (this._active !== active) {
      this._active = active;
      cap?.click();
    }
    // Unity ToggleClick calls Click() then Hover(): the cap keeps the hover
    // bonus while the pointer is still on the button. A self-click has no
    // pointer on it, so it settles on the plain state offset instead.
    if (source === 'operator') cap?.hover();
    else cap?.release();
    if (this.autoLight) cap?.setLight(active);
  }

  /** Write one flank of the operator pulse. Autonomous flanks respect the live gate. */
  private _writeState(value: boolean, source: SceneButtonClickSource): void {
    if (!this._stateSignal || !this._writer) return;
    // Defense in depth: `click()` already refuses an autonomous change while
    // live-controlled, but the release flank of a pulse started BEFORE the gate
    // was raised still passes through here.
    if (source === 'auto' && this.liveControlled) return;
    this._writer.setByPath(this._stateSignal, value);
  }

  /** Confirmed state from the store (own write echo, force, remote, PLC). */
  private _syncFromSignal(value: boolean): void {
    if (this._active === value) return;
    this._active = value;
    this.cap?.setPressed(value);
    if (this.autoLight) this.cap?.setLight(value);
    // A remote/forced release also ends a pending momentary timer.
    if (!value && this._timerRunning) {
      this._timerRunning = false;
      this._timerRemaining = 0;
      this._manager?.setActive(this, false);
    }
  }

  dispose(): void {
    this._unsubState?.();
    this._unsubState = undefined;
    this._manager?.unregister(this);
    this._manager = undefined;
    this._writer = undefined;
    this._ctx = undefined;
    this._timerRunning = false;
    this._timerRemaining = 0;
    removeComponentInstance(this.node, this);
  }
}

registerComponent({
  type: 'SceneButtonBase',
  schema: RVSceneButtonBase.schema,
  capabilities: {
    hoverable: true,
    hoverEnabledByDefault: true,
    selectable: true,
    filterLabel: 'Buttons',
    badgeColor: '#7e57c2',
  },
  create: (node) => new RVSceneButtonBase(node),
  afterCreate: (inst, node) => {
    setComponentInstance(node, inst);
  },
});
