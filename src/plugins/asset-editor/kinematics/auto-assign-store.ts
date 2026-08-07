// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * auto-assign-store — module-level handle to the Kinematics window's ARMED
 * Auto Assign target (the selected kinematic's axis path + group name).
 *
 * Set by KinematicsList (React) while Auto Assign is on and a group-linked
 * kinematic is selected; read by the AssetEditorPlugin, which runs outside
 * React and needs it to decide whether a marquee commit should assign to the
 * group instead of selecting, and which color to draw the marquee in.
 */

export interface AutoAssignTarget {
  /** Registry path of the armed kinematic axis node. */
  kinematicPath: string;
  /** GroupName the armed kinematic collects into. */
  groupName: string;
}

let _armed: AutoAssignTarget | null = null;

/** Arm (or disarm, with null) the Auto Assign target. */
export function setAutoAssignTarget(target: AutoAssignTarget | null): void {
  _armed = target;
}

/** The armed Auto Assign target, or null when Auto Assign is off/unarmed. */
export function getAutoAssignTarget(): AutoAssignTarget | null {
  return _armed;
}
