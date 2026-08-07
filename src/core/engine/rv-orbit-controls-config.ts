// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { MOUSE, TOUCH } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export interface OrbitNavigationSettings {
  orbitRotateSpeed: number;
  orbitPanSpeed: number;
  orbitZoomSpeed: number;
  orbitDampingFactor: number;
  distanceAdaptiveNav?: boolean;
}

type ConfigurableOrbitControls = Pick<
  OrbitControls,
  | 'enableDamping'
  | 'dampingFactor'
  | 'zoomToCursor'
  | 'mouseButtons'
  | 'touches'
  | 'rotateSpeed'
  | 'panSpeed'
  | 'zoomSpeed'
>;

/** HMI-free navigation defaults shared by the main viewer and rv-embed. */
export const DEFAULT_ORBIT_NAVIGATION_SETTINGS: Readonly<OrbitNavigationSettings> = Object.freeze({
  orbitRotateSpeed: 1,
  orbitPanSpeed: 1,
  orbitZoomSpeed: 1,
  orbitDampingFactor: 0.2,
  distanceAdaptiveNav: false,
});

/**
 * Apply the interaction contract and sensitivity settings used by realvirtual WEB.
 *
 * The main app may reapply sensitivity values from its visual-settings store at
 * runtime. rv-embed deliberately stays on the shared defaults.
 */
export function configureOrbitControls(
  controls: ConfigurableOrbitControls,
  settings: OrbitNavigationSettings = DEFAULT_ORBIT_NAVIGATION_SETTINGS,
): void {
  controls.enableDamping = true;
  controls.zoomToCursor = true;
  controls.mouseButtons = {
    LEFT: -1 as MOUSE,
    MIDDLE: MOUSE.PAN,
    RIGHT: MOUSE.ROTATE,
  };
  controls.touches = {
    ONE: TOUCH.ROTATE,
    TWO: TOUCH.DOLLY_PAN,
  };
  applyNavigationSettingsToControls(controls, settings);
}

/**
 * Apply store-backed navigation sensitivity without changing the interaction
 * mapping. Adaptive navigation continues to own pan/zoom writes when enabled.
 */
export function applyNavigationSettingsToControls(
  controls: Pick<OrbitControls, 'rotateSpeed' | 'panSpeed' | 'zoomSpeed' | 'dampingFactor'>,
  settings: OrbitNavigationSettings,
): void {
  controls.rotateSpeed = settings.orbitRotateSpeed;
  if (!settings.distanceAdaptiveNav) {
    controls.panSpeed = settings.orbitPanSpeed;
    controls.zoomSpeed = settings.orbitZoomSpeed;
  }
  controls.dampingFactor = settings.orbitDampingFactor;
}
