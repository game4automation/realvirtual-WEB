// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { MOUSE, TOUCH } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export interface OrbitNavigationSettings {
  orbitRotateSpeed: number;
  orbitPanSpeed: number;
  orbitZoomSpeed: number;
  orbitDampingFactor: number;
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
});

/**
 * Apply the interaction contract and sensitivity settings used by realvirtual WEB.
 *
 * plan-515 Phase 2: OrbitControls is only the camera STATE holder (target,
 * update(), damping settings, speeds). Every mouse button and touch gesture is
 * handled by the NavigationController (orbit about the point under the cursor,
 * point-keeping pan, pinch toward the surface), so OrbitControls' own mouse and
 * touch mapping is switched off here — and the controller disconnects its DOM
 * listeners while attached. `enableZoom` stays on (harmless: no wheel reaches it).
 *
 * The main app may reapply sensitivity values from its visual-settings store at
 * runtime; the controller reads rotateSpeed / panSpeed / zoomSpeed /
 * dampingFactor from the controls. rv-embed deliberately stays on the shared
 * defaults.
 */
export function configureOrbitControls(
  controls: ConfigurableOrbitControls,
  settings: OrbitNavigationSettings = DEFAULT_ORBIT_NAVIGATION_SETTINGS,
): void {
  controls.enableDamping = true;
  controls.zoomToCursor = true;
  controls.mouseButtons = {
    LEFT: -1 as MOUSE,
    MIDDLE: -1 as MOUSE,
    RIGHT: -1 as MOUSE,
  };
  controls.touches = {
    ONE: -1 as TOUCH,
    TWO: -1 as TOUCH,
  };
  applyNavigationSettingsToControls(controls, settings);
}

/**
 * Apply store-backed navigation sensitivity without changing the interaction
 * mapping. `zoomSpeed` also scales the wheel step of the NavigationController
 * (plan-515).
 */
export function applyNavigationSettingsToControls(
  controls: Pick<OrbitControls, 'rotateSpeed' | 'panSpeed' | 'zoomSpeed' | 'dampingFactor'>,
  settings: OrbitNavigationSettings,
): void {
  controls.rotateSpeed = settings.orbitRotateSpeed;
  controls.panSpeed = settings.orbitPanSpeed;
  controls.zoomSpeed = settings.orbitZoomSpeed;
  controls.dampingFactor = settings.orbitDampingFactor;
}
