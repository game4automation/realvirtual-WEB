// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-view-state — capture and restore the complete camera view (plan-365 §2.3b).
 *
 * Reloading a model is not a neutral operation for the camera: `loadModel()`
 * clears the scene and then re-fits position and orbit target to the new
 * bounds, and `loadScene()` additionally re-applies camera presets or frames the
 * whole assembled content. Both are right when a user *opens* something. They
 * are wrong when the same model merely got new bytes — there the view must not
 * move at all.
 *
 * "Camera position" is not enough to express that. An orthographic view also
 * carries its zoom, a rotated view its quaternion, and an orbiting view its
 * controls target; restoring only the position lands the user next to where
 * they were, looking somewhere else.
 */

/** Minimal camera surface — structural so tests need no three.js scene. */
export interface ViewStateVector {
  x: number;
  y: number;
  z: number;
  set(x: number, y: number, z: number): unknown;
}

/** Minimal quaternion surface. */
export interface ViewStateQuaternion {
  x: number;
  y: number;
  z: number;
  w: number;
  set(x: number, y: number, z: number, w: number): unknown;
}

/** Minimal camera surface. */
export interface ViewStateCamera {
  position: ViewStateVector;
  quaternion: ViewStateQuaternion;
  zoom: number;
  updateProjectionMatrix(): void;
}

/** Minimal viewer surface the capture/restore needs. */
export interface ViewStateHost {
  projection: 'perspective' | 'orthographic';
  readonly camera: ViewStateCamera;
  readonly controls: { target: ViewStateVector; update(): void };
  readonly cameraFollowMode?: 'off' | 'follow' | 'siton';
  /** Untyped on purpose — `RVViewer.getPlugin` is generic over its own plugin
   *  constraint, and only `unknown` accepts that signature structurally. */
  getPlugin?(id: string): unknown;
  markRenderDirty?(): void;
}

/** A complete view — everything that decides what the user sees. */
export interface RVViewState {
  projection: 'perspective' | 'orthographic';
  position: [number, number, number];
  quaternion: [number, number, number, number];
  target: [number, number, number];
  zoom: number;
}

/**
 * True when another system is actively driving the camera every frame.
 *
 * FPV and Follow/Sit-On own the camera continuously; writing a stored pose back
 * would either be overwritten in the next frame or fight the mode for one. Their
 * behaviour on a model refresh is therefore: leave them alone.
 */
export function isCameraExternallyDriven(host: ViewStateHost): boolean {
  if (host.cameraFollowMode && host.cameraFollowMode !== 'off') return true;
  const fpv = host.getPlugin?.('fpv') as { isActive?: boolean } | undefined;
  return fpv?.isActive === true;
}

/** Snapshot the full view, or null when another system owns the camera. */
export function captureViewState(host: ViewStateHost): RVViewState | null {
  if (isCameraExternallyDriven(host)) return null;
  const { camera, controls } = host;
  return {
    projection: host.projection,
    position: [camera.position.x, camera.position.y, camera.position.z],
    quaternion: [camera.quaternion.x, camera.quaternion.y, camera.quaternion.z, camera.quaternion.w],
    target: [controls.target.x, controls.target.y, controls.target.z],
    zoom: camera.zoom,
  };
}

/**
 * Put a captured view back.
 *
 * Projection first: switching it copies position and quaternion from the old
 * camera onto the new one, so writing the pose before the switch would only be
 * to be overwritten. A camera preset that the reload re-applied is overruled on
 * purpose — this is a content refresh, and the view the user had arranged is
 * newer information than the preset stored with the scene.
 */
export function restoreViewState(host: ViewStateHost, state: RVViewState | null): void {
  if (!state) return;
  if (isCameraExternallyDriven(host)) return;
  if (host.projection !== state.projection) host.projection = state.projection;

  const { camera, controls } = host;
  camera.position.set(state.position[0], state.position[1], state.position[2]);
  camera.quaternion.set(state.quaternion[0], state.quaternion[1], state.quaternion[2], state.quaternion[3]);
  camera.zoom = state.zoom;
  camera.updateProjectionMatrix();
  controls.target.set(state.target[0], state.target[1], state.target[2]);
  controls.update();
  host.markRenderDirty?.();
}
