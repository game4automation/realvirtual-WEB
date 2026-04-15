// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { Vector3 } from 'three';

/**
 * Unity LHS → glTF RHS Coordinate Conversion Utilities
 *
 * UnityGLTF applies these conversions to glTF node transforms at EXPORT time:
 *   - Positions:    (x, y, z) → (-x, y, z)        [negate X]
 *   - Quaternions:  (x, y, z, w) → (x, -y, -z, w)  [negate Y and Z]
 *   - Scale:        unchanged
 *   - Mesh verts:   X negated, triangle winding reversed
 *
 * Quaternion conversion derivation (from UnityGLTF SchemaExtensions.cs):
 *   axisOfRotation = (qx, qy, qz)
 *   Step 1: Scale by CoordinateSpaceConversionScale (-1,1,1) → (-qx, qy, qz)
 *   Step 2: Multiply by axisFlipScale (-1, for handedness flip) → (qx, -qy, -qz)
 *   Result: (qx, -qy, -qz, qw)
 *
 * However, GLB extras (Drive direction, BoxCollider center, TransportDirection, etc.)
 * are written RAW in Unity's LHS coordinate system. The WebViewer must convert these
 * values to match the glTF RHS node transforms.
 *
 * This module centralizes all such conversions.
 */

// ─── Position Conversion ─────────────────────────────────────────────

/**
 * Convert a Unity local-space position/offset to glTF local space.
 * UnityGLTF negates X for positions: (x, y, z) → (-x, y, z)
 *
 * Use for: BoxCollider center, any raw Vector3 position from extras.
 */
export function unityPositionToGltf(x: number, y: number, z: number): Vector3 {
  return new Vector3(-x, y, z);
}

/**
 * Convert a Unity local-space position in-place (mutates the vector).
 */
export function convertPositionInPlace(v: Vector3): Vector3 {
  v.x = -v.x;
  return v;
}

// ─── Direction Conversion ────────────────────────────────────────────

/** Unity DIRECTION enum values (serialized as strings in GLB extras) */
export enum DriveDirection {
  LinearX = 'LinearX',
  LinearY = 'LinearY',
  LinearZ = 'LinearZ',
  RotationX = 'RotationX',
  RotationY = 'RotationY',
  RotationZ = 'RotationZ',
  Virtual = 'Virtual',
}

/**
 * Convert a Unity Drive DIRECTION enum to the corresponding local-space
 * axis vector in glTF/Three.js coordinates.
 *
 * The conversion accounts for UnityGLTF's handedness flip:
 *
 * LINEAR directions (position-based):
 *   UnityGLTF negates X for all positions: (x,y,z) → (-x,y,z).
 *   A displacement of +d along Unity local X means moving from (-px) to
 *   (-(px+d)) = -px-d in glTF, so the glTF delta is -d. Hence X is negated.
 *   Y and Z are unchanged by UnityGLTF, so they keep their sign.
 *
 *   LinearX  → (-1, 0, 0)   [X negated by UnityGLTF position export]
 *   LinearY  → ( 0,+1, 0)   [Y unchanged]
 *   LinearZ  → ( 0, 0,+1)   [Z unchanged]
 *
 * ROTATION directions (quaternion-based):
 *   UnityGLTF converts quaternions: (x,y,z,w) → (x,-y,-z,w)
 *   A rotation "around axis A by angle θ" encoded as Euler(ax*θ, ay*θ, az*θ)
 *   needs the same sign flip as the quaternion components:
 *
 *   RotationX → (+1, 0, 0)  [X component unchanged in quaternion]
 *   RotationY → ( 0,-1, 0)  [Y component negated in quaternion]
 *   RotationZ → ( 0, 0,-1)  [Z component negated in quaternion]
 */
export function directionToGltfAxis(dir: DriveDirection): Vector3 {
  switch (dir) {
    case DriveDirection.LinearX:   return new Vector3(-1, 0, 0);
    case DriveDirection.LinearY:   return new Vector3(0, 1, 0);
    case DriveDirection.LinearZ:   return new Vector3(0, 0, 1);
    case DriveDirection.RotationX: return new Vector3(1, 0, 0);
    case DriveDirection.RotationY: return new Vector3(0, -1, 0);
    case DriveDirection.RotationZ: return new Vector3(0, 0, -1);
    case DriveDirection.Virtual:   return new Vector3(0, 0, 0);
  }
}

/**
 * Check if a DriveDirection is rotational.
 */
export function isRotation(dir: DriveDirection): boolean {
  return dir === DriveDirection.RotationX ||
         dir === DriveDirection.RotationY ||
         dir === DriveDirection.RotationZ;
}

// ─── Raw Vector3 Conversion ──────────────────────────────────────────

/**
 * Convert a raw Unity Vector3 direction (from extras) to glTF space.
 * This applies the same X-negation as UnityGLTF does for positions.
 *
 * Use for: TransportDirection, any raw direction vectors from extras
 * that will be used in the glTF/Three.js scene.
 *
 * Note: The resulting vector is NOT normalized — call .normalize() if needed.
 */
export function unityDirectionToGltf(x: number, y: number, z: number): Vector3 {
  return new Vector3(-x, y, z);
}

/**
 * Convert a raw Unity Vector3 direction in-place (mutates the vector).
 */
export function convertDirectionInPlace(v: Vector3): Vector3 {
  v.x = -v.x;
  return v;
}
