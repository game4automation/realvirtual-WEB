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

// ─── Frame Conversion (glTF ⇄ Unity), in place ───────────────────────

/**
 * Mirror a POSITION between the glTF (right-handed) and the Unity
 * (left-handed) frame, in place: `(x, y, z) → (-x, y, z)`.
 *
 * The map is its own inverse, so one function serves both directions — which
 * is why it is named "mirror" and not "toUnity".
 *
 * In place and on a tuple on purpose (plan-772 F5): the IK solve path writes
 * into pre-allocated tuples and must not allocate per solve.
 *
 * Use it wherever a pose crosses INTO or OUT OF the Unity frame — the frame
 * the serialized OPW parameters and the Pieper solver core live in. Before
 * plan-772 this mirror existed only as an accident: `targetPoseInBase()`
 * divided the position by the decomposed scale, and `Matrix4.decompose()`
 * puts a negative determinant's sign on `scale.x`, so a target node authored
 * with a mirrored scale got the X flip and every other target did not
 * (measured: 91.56° off on an unmirrored demo target, 178.9° on a scaled one).
 */
export function mirrorPositionGltfUnity(out: [number, number, number]): void {
  out[0] = -out[0];
}

/**
 * Mirror a ROTATION quaternion between the glTF and the Unity frame, in
 * place: `(x, y, z, w) → (x, -y, -z, w)` — the conversion derived at the top
 * of this file, and likewise its own inverse.
 *
 * Why it was never missed: the map is conjugation by the unit quaternion `i`,
 * so it leaves every rotation about X unchanged AND maps any 180° rotation
 * about an axis in the YZ plane to its own negative, which is the SAME
 * rotation. Tool frames are usually exactly that (flipped 180°, or rolled
 * about the tool axis), so the demo targets agreed with Unity without it —
 * until one did not: the six targets of the IRB's second demo path were a
 * constant 60.00° off, and this conversion is what brings them to 0.00°
 * (plan-772 Phase 3 measurement).
 */
export function mirrorQuaternionGltfUnity(out: [number, number, number, number]): void {
  out[1] = -out[1];
  out[2] = -out[2];
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

