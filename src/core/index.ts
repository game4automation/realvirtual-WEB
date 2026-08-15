// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Public core API barrel.
 *
 * Re-exports the public-facing types and runtime helpers so consumers can
 * `import { ... } from '@/core'` without reaching into engine-private paths.
 *
 * Note: `GizmoOptions` name-collides with a local type in the private DES
 * helper module (`rv-des-gizmo-helpers.ts`). This barrel re-exports ONLY the
 * public `rv-gizmo-manager.ts` version to avoid ambiguity at consumer-import
 * sites.
 */

// ── WebSensor Configuration API ────────────────────────────────────────
export {
  initWebSensor,
  resetWebSensorConfig,
  WebSensorConfig,
  parseIntStateMap,
  RVWebSensor,
  type WebSensorInitOptions,
  type WebSensorState,
  type StateStyle,
} from './engine/rv-web-sensor';

export { RVLamp } from './engine/rv-lamp';
export { RVSceneButtonBase } from './engine/rv-scene-button-base';
export { RVSceneButtonMoveable } from './engine/rv-scene-button-moveable';
export { RVPushButton3D } from './engine/rv-push-button3d';
export { RVEmergencyButton3D } from './engine/rv-emergency-button3d';
export { RVHandleSwitch3D } from './engine/rv-handle-switch3d';
export { LampManager } from './engine/rv-lamp-manager';
export { SceneButtonManager } from './engine/rv-scene-button-manager';

// ── Generic Gizmo Overlay System ───────────────────────────────────────
export {
  GizmoOverlayManager,
  type GizmoShape,
  type GizmoOptions,
  type GizmoHandle,
} from './engine/rv-gizmo-manager';

// ── Component Event Dispatcher ─────────────────────────────────────────
export { ComponentEventDispatcher } from './engine/rv-component-event-dispatcher';
