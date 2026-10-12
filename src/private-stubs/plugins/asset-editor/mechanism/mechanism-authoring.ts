// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plugins/asset-editor/mechanism/mechanism-authoring.ts — community stub for the COMMERCIAL asset editor (plan-434).
 *
 * The GLB authoring UI lives in the private sibling. Without it `@rv-private/*`
 * resolves here, so the core still type-checks, builds and runs — the editor is
 * simply absent. Every export is an inert no-op; nothing in this file is reached
 * unless the caller is an editor-only code path, which a community build never
 * enters (no AssetEditorPlugin, no Editor mode).
 */


export type DensityPresetId = any;
export const DensityPresetId: any = () => undefined;
export type JointKind = any;
export const JointKind: any = () => undefined;
export type MechanismDocumentLike = {
  withTransaction: (label: string, fn: () => any) => any;
  addComponent: (nodePath: string, baseType: string, fields?: any) => any;
  setField: (nodePath: string, componentType: string, fieldName: string, v: unknown, prev?: unknown) => any;
  unsetField: (nodePath: string, componentType: string, fieldName: string, prev?: unknown) => any;
};
export const MechanismDocumentLike: any = () => undefined;
export type MechanismOpPlan = any;
export const MechanismOpPlan: any = () => undefined;
export type planSetAxis = any;
export const planSetAxis: any = () => undefined;
export type planSetLimits = any;
export const planSetLimits: any = () => undefined;
export const DENSITY_PRESETS: any[] = [];
export const JOINT_KINDS: any[] = [];
export const planAddBody: any = () => undefined;
export const planAddJoint: any = () => undefined;
export const planAssignDrive: any = () => undefined;
export const planCreateMechanism: any = () => undefined;
export const planPickAnchor: any = () => undefined;
export const planSetAnchor: any = () => undefined;
export const planSetComOverride: any = () => undefined;
export const planSetDensity: any = () => undefined;
export const planSetMassOverride: any = () => undefined;
export const runMechanismPlan: any = () => undefined;
// plan-729 — Cartesian paths for mechanisms.
export type WaypointInterpolation = any;
export const WAYPOINT_INTERPOLATIONS: any[] = [];
export const MECHANISM_PATH_TYPE = 'MechanismPath';
export const MECHANISM_TARGET_TYPE = 'MechanismTarget';
export const planCreateTarget: any = () => undefined;
export const planCreatePath: any = () => undefined;
export const planAddWaypoint: any = () => undefined;
export const planRemoveWaypoint: any = () => undefined;
export const planReorderWaypoints: any = () => undefined;
export const readWaypointPaths: any = () => [];
// plan-501 — inertia override + drive-sizing trajectory.
export type CreateTrajectoryOptions = any;
export const MECHANISM_TRAJECTORY_TYPE = 'MechanismTrajectory';
export const planSetInertiaOverride: any = () => undefined;
export const planCreateTrajectory: any = () => undefined;
export const planSetTrajectorySamples: any = () => undefined;
export const planSetTrajectoryField: any = () => undefined;
export const planSetPathField: any = () => undefined;
