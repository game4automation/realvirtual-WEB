// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVXRManager — Central XR session management.
 * Handles platform detection, VR/AR button creation, controller setup,
 * and WebGPU guard (XR not supported on WebGPU renderer).
 */
import { WebGLRenderer, Scene, Group } from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { ARButton } from 'three/addons/webxr/ARButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';

export interface XRSupport {
  vr: boolean;
  ar: boolean;
}

export class RVXRManager {
  private _sessionType: 'none' | 'vr' | 'ar' = 'none';
  private _controllers: Group[] = [];
  private _controllerGrips: Group[] = [];

  get isPresenting(): boolean { return this._sessionType !== 'none'; }
  get sessionType(): 'none' | 'vr' | 'ar' { return this._sessionType; }

  static async checkSupport(): Promise<XRSupport> {
    if (!navigator.xr) return { vr: false, ar: false };
    const [vr, ar] = await Promise.all([
      navigator.xr.isSessionSupported('immersive-vr').catch(() => false),
      navigator.xr.isSessionSupported('immersive-ar').catch(() => false),
    ]);
    return { vr, ar };
  }

  static isXRCapable(renderer: unknown): boolean {
    if (!renderer || typeof renderer !== 'object') return false;
    const r = renderer as Record<string, unknown>;
    const xr = r.xr as Record<string, unknown> | undefined;
    return !!xr && typeof xr.setSession === 'function';
  }

  enableVR(renderer: WebGLRenderer, scene: Scene): HTMLElement | null {
    if (!RVXRManager.isXRCapable(renderer)) {
      console.warn('[XR] Renderer does not support WebXR (WebGPU active?)');
      return null;
    }
    const button = VRButton.createButton(renderer);
    renderer.xr.addEventListener('sessionstart', () => { this._sessionType = 'vr'; });
    renderer.xr.addEventListener('sessionend', () => { this._sessionType = 'none'; });
    return button;
  }

  enableAR(renderer: WebGLRenderer, scene: Scene, domOverlay?: HTMLElement): HTMLElement | null {
    if (!RVXRManager.isXRCapable(renderer)) {
      console.warn('[XR] Renderer does not support WebXR (WebGPU active?)');
      return null;
    }
    const sessionInit: Record<string, unknown> = {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['dom-overlay', 'anchors'],
    };
    if (domOverlay) {
      sessionInit.domOverlay = { root: domOverlay };
    }
    const button = ARButton.createButton(renderer, sessionInit);
    renderer.xr.addEventListener('sessionstart', () => {
      this._sessionType = 'ar';
      scene.background = null;
    });
    renderer.xr.addEventListener('sessionend', () => { this._sessionType = 'none'; });
    return button;
  }

  setupControllers(renderer: WebGLRenderer, scene: Scene): { controllers: Group[]; grips: Group[] } {
    const factory = new XRControllerModelFactory();
    for (let i = 0; i < 2; i++) {
      const controller = renderer.xr.getController(i);
      scene.add(controller);
      this._controllers.push(controller);
      const grip = renderer.xr.getControllerGrip(i);
      grip.add(factory.createControllerModel(grip));
      scene.add(grip);
      this._controllerGrips.push(grip);
    }
    return { controllers: this._controllers, grips: this._controllerGrips };
  }

  get controllers(): Group[] { return this._controllers; }
  get controllerGrips(): Group[] { return this._controllerGrips; }

  dispose(): void {
    this._controllers = [];
    this._controllerGrips = [];
    this._sessionType = 'none';
  }
}
