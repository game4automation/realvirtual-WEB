// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-scene-button-wrapper.ts — shared plumbing of the three 3D scene-button
 * wrappers (`PushButton3D`, `EmergencyButton3D`, `HandleSwitch3D`, plan-417).
 *
 * A wrapper is the node the user authored in Unity; the actual click target is
 * the `SceneButtonBase` on a descendant (Unity `GetComponentInChildren`). The
 * wrapper therefore carries NO event hooks — the dispatcher must reach the
 * base, not the wrapper — and only configures it: PLC signal, toggle/timer
 * behavior and the optional light subscription.
 */

import type { Object3D } from 'three';
import type { ComponentContext, RVComponent } from './rv-component-registry';
import { removeComponentInstance } from './rv-component-registry';
import { NodeRegistry } from './rv-node-registry';
import type { RVSceneButtonBase } from './rv-scene-button-base';
import type { SceneButtonManager } from './rv-scene-button-manager';

/** Common base of the three wrapper components. */
export abstract class RVSceneButtonWrapper implements RVComponent {
  readonly node: Object3D;
  isOwner = true;

  /** Resolved PLC input signal address (schema `componentRef` + `PLCInputBool`). */
  stateSignal: string | null = null;
  activeOnStart = false;

  protected base?: RVSceneButtonBase;
  protected ctx?: ComponentContext;
  private _manager?: SceneButtonManager;
  private _clickedOnStart = false;
  private _wired = false;

  constructor(node: Object3D) {
    this.node = node;
  }

  /**
   * The loader resolves refs and inits components in TRAVERSAL order, so a
   * wrapper is initialized BEFORE the `SceneButtonBase` below it — its
   * `moveable` reference is still a raw ComponentRef and its context is not set
   * yet. Wiring therefore waits for the late pass (`onSceneReady`), exactly as
   * Unity's `Start()` runs after every `Awake()`.
   *
   * The runtime construction paths (`createRuntimeNode` /
   * `constructComponentOnNode`) never run a late pass — they add a wrapper to a
   * hierarchy whose components are already live, so wiring happens right away.
   */
  init(ctx: ComponentContext): void {
    this.ctx = ctx;
    this._manager = ctx.sceneButtonManager;
    this._manager?.register(this);
    if (!ctx.expectSceneReady) this.wire();
  }

  onSceneReady(ctx: ComponentContext): void {
    this.ctx = ctx;
    this.wire();
  }

  /** Idempotent Unity `Start()` equivalent. */
  protected wire(): void {
    if (this._wired || !this.ctx) return;
    this._wired = true;

    this.base = findSceneButtonBase(this.node, this.ctx);
    if (!this.base) {
      console.warn(`[${this.constructor.name}] no SceneButtonBase below "${this.node.name}" — button is inert`);
      return;
    }
    this.configure(this.base);
    this.base.setStateSignal(typeof this.stateSignal === 'string' ? this.stateSignal : null);
    this.onWired(this.base);
    this.runActiveOnStart();
  }

  /** Per-wrapper configuration of the shared state machine (before signal wiring). */
  protected abstract configure(base: RVSceneButtonBase): void;

  /** Per-wrapper extras after the state signal is wired (e.g. a light subscription). */
  protected onWired(_base: RVSceneButtonBase): void {
    // default: nothing
  }

  /** Unity `Start()` tail: `if (activeOnStart) sceneButtonBase.Click();` */
  protected runActiveOnStart(): void {
    if (this._clickedOnStart || !this.activeOnStart || !this.base) return;
    this._clickedOnStart = true;
    // Not an operator interaction — `liveControlled` may suppress the write.
    this.base.click('auto');
  }

  dispose(): void {
    this._manager?.unregister(this);
    this._manager = undefined;
    this.base = undefined;
    this.ctx = undefined;
    this._wired = false;
    this._clickedOnStart = false;
    removeComponentInstance(this.node, this);
  }
}

/**
 * Unity `GetComponentInChildren<SceneButtonBase>()`: the first SceneButtonBase
 * on this node or below it, in traversal order. Resolved through the registry
 * (every component is constructed and registered in loader step 1, before any
 * init() runs in step 2).
 */
export function findSceneButtonBase(
  root: Object3D,
  ctx: ComponentContext,
): RVSceneButtonBase | undefined {
  let found: RVSceneButtonBase | undefined;
  root.traverse((node) => {
    if (found) return;
    const path = NodeRegistry.computeNodePath(node);
    const inst = ctx.registry.getByPath<RVSceneButtonBase>('SceneButtonBase', path);
    if (inst) found = inst;
  });
  return found;
}
