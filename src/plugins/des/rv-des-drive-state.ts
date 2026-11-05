// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { RVDrive, IDriveBehavior } from '../../core/engine/rv-drive';

import { getComponentInstances } from '../../core/engine/rv-component-registry';
import { RVDriveDestinationMotor } from '../../core/engine/rv-drive-destination-motor';
import { RVDriveSimple } from '../../core/engine/rv-drive-simple';
import { RVDriveSpeed } from '../../core/engine/rv-drive-speed';
import { RVDriveCylinder } from '../../core/engine/rv-drive-cylinder';
import { RVDriveGear } from '../../core/engine/rv-drive-gear';
import { RVDriveFollowPosition } from '../../core/engine/rv-drive-follow-position';
import { RVErraticDriver } from '../../core/engine/rv-erratic';
import { RVDriveContinousDestination } from '../../core/engine/rv-drive-continous-destination';
import { RVDrivePositionSwitch } from '../../core/engine/rv-drive-position-switch';

export type DriveRunState = Record<string, boolean | number | null>;

/** Declared primitive state only; preserve NaN, infinities and signed zero. */
export function captureKeys(owner: object, keys: readonly string[]): DriveRunState {
  const state: DriveRunState = {};
  for (const key of keys) {
    const value = (owner as Record<string, unknown>)[key];
    if (value !== null && typeof value !== 'boolean' && typeof value !== 'number') {
      throw new Error(`Non-primitive run state: ${key}`);
    }
    state[key] = value;
  }
  return state;
}

export function restoreKeys(owner: object, keys: readonly string[], state: DriveRunState): void {
  const copy = captureKeys(state, keys);
  for (const key of keys) (owner as DriveRunState)[key] = copy[key];
}

export interface DriveStateDeclaration {
  readonly stateKeys: readonly string[];
  readonly services: readonly string[];
}

// Tick claims/change/arrival are transient; other services are config, refs and scratch.
export const DRIVE_STATE: Readonly<Record<string, DriveStateDeclaration>> = {
  'Drive': {
    stateKeys: [
      'TargetSpeed', 'Acceleration', 'UseAcceleration', 'liveControlled', 'currentPosition', 'currentSpeed',
      'targetPosition', 'targetSpeed', 'isRunning', '_moveSign', 'jogForward', 'jogBackward',
      'positionOverwrite', '_prevOverwritePos', 'commandedPosition', 'followingError', 'actualTorque',
      'saturated', 'stepTravel', 'travelOdometer', 'discontinuityRev', '_motionLastPos', '_stepWrap',
      '_wasJogging', '_stoppingJog', '_smoothPlanned', '_smoothPlanTarget', '_smoothEffectiveTarget',
      '_smoothLimitsDirty', '_smoothJogDir', '_smoothRebasePending', '_smoothJogBlocked', '_smoothRejected',
    ],
    services: [
      'node', 'name', 'isOwner', 'eventDrivenFeedback', 'onCommand', 'arrivedThisUpdate', '_initialConfig', 'Direction',
      'ReverseDirection', 'Offset', 'StartPosition', 'UseLimits', 'LowerLimit', 'UpperLimit', 'JogForward',
      'JogBackward', 'SmoothAcceleration', 'Jerk', 'SpeedOverride', 'JumpToLowerLimitOnUpperLimit', 'Behaviors',
      'BehaviorExtras', 'isRotary', 'basePosition', 'baseQuaternion', '_isTransportSurface',
      'positionClaimedThisTick', 'arrivalTolerance', 'dynamicAxis', '_smoothHandle', '_smoothSnapshot',
      '_smoothState', 'driveBehaviors', 'afterUpdateCallbacks', 'behaviorChangedThisTick', 'axis',
      'controllerScale', '_motionBlocks',
    ],
  },
  'Drive_DestinationMotor': {
    stateKeys: ['startDriveValue'],
    services: [
      'initialRunState', 'node', 'isOwner', 'liveControlled', 'StartDrive', 'Destination', 'TargetSpeed',
      'Acceleration', 'IsAtPosition', 'IsAtSpeed', 'IsAtDestination', 'IsDriving', 'CurrentPositionScale',
      'CurrentPositionOffset', 'ScaleFeedbackPosition', 'feedbackCb', 'drive', 'feedbackListeners',
      'inputUnsubs',
    ],
  },
  'Drive_Simple': {
    stateKeys: ['_enabled', '_forward', '_backward'],
    services: [
      'initialRunState', 'node', 'isOwner', 'Speed', 'Accelaration', 'Forward', 'Backward', 'IsAtPosition',
      'IsAtSpeed', 'IsDriving', 'Enable', 'ScaleSpeed', 'CurrentPositionScale', 'CurrentPositionOffset',
      'ScaleFeedbackPosition', 'liveControlled', 'feedbackCb', 'drive', 'feedbackListeners', 'inputUnsubs',
    ],
  },
  'Drive_Speed': {
    stateKeys: ['TargetSpeed', 'Acceleration'],
    services: [
      'node', 'isOwner', 'SignalTargetSpeed', 'SignalAcceleration', 'SignalCurrentSpeed',
      'SignalCurrentPosition', 'SignalIsDriving', 'CurrentPositionScale', 'CurrentPositionOffset',
      'ScaleFeedbackPosition', 'drive', 'signalStore', 'signalWriter', 'initialRunState', 'feedbackCb',
    ],
  },
  'Drive_Cylinder': {
    stateKeys: [
      '_enabled', '_pendingTarget', '_pendingTime', '_outLevel', '_inLevel', 'previousOut', 'previousIn',
    ],
    services: [
      'initialRunState', 'node', 'isOwner', 'liveControlled', 'MinPos', 'MaxPos', 'TimeOut', 'TimeIn',
      'OneBitCylinder', 'InvertOutputLogic', 'Mode', 'Out', 'In', 'IsOut', 'IsIn', 'IsMax', 'IsMin',
      'IsMovingOut', 'IsMovingIn', 'Enable', 'drive', '_home', 'writeMovingFeedback', '_writeAllFeedback',
      '_offSimStart', 'feedbackCb', 'feedbackListeners', 'inputUnsubs', 'forceEndpointFeedback',
    ],
  },
  'Drive_Gear': {
    stateKeys: [],
    services: [
      'node', 'isOwner', 'MasterDrive', 'GearFactor', 'Offset', 'drive', 'master',
    ],
  },
  'Drive_FollowPosition': {
    stateKeys: ['directPosition', 'holdPosition', 'wasLive'],
    services: [
      'node', 'isOwner', 'Position', 'CurrentPosition', 'Offset', 'Scale',
      'CurrentPositionScale', 'ScaleFeedbackPosition', 'drive', 'signalStore', 'signalWriter',
      'positionSignalName', 'feedbackCb', 'feedbackListeners',
    ],
  },
  'Drive_ErraticPosition': {
    stateKeys: ['driving', 'destPos', 'movingToZero'],
    services: [
      'node', 'isOwner', 'MinPos', 'MaxPos', 'Speed', 'IterateBetweenMaxAndMin',
      'SignalEnable', 'drive', 'signalStore', 'random', 'tolerance',
    ],
  },
  'Drive_ContinousDestination': {
    stateKeys: ['Destination', 'TargetSpeed', 'Acceleration', 'destinationBefore'],
    services: [
      'initialRunState', 'node', 'isOwner', 'SignalDestination', 'SignalAcceleration', 'SignalTargetSpeed',
      'SignalIsAtPosition', 'SignalIsAtSpeed', 'SignalIsAtDestination', 'SignalIsDriving',
      'CurrentPositionScale', 'CurrentPositionOffset', 'ScaleFeedbackPosition', 'drive', 'signalStore',
      'signalWriter',
    ],
  },
  'Drive_PositionSwitch': {
    stateKeys: [],
    services: [
      'node', 'isOwner', 'OutputSignal', 'InvertAreas', 'PositionOffset', 'drive', 'signalWriter', 'areas',
      'feedbackCb',
    ],
  },
};

export const RUN_STATE_KEYS = DRIVE_STATE.Drive.stateKeys;
export const RUN_STATE_SERVICES = DRIVE_STATE.Drive.services;

const behaviorTypes = [
  [RVDriveDestinationMotor, 'Drive_DestinationMotor'], [RVDriveSimple, 'Drive_Simple'],
  [RVDriveSpeed, 'Drive_Speed'], [RVDriveCylinder, 'Drive_Cylinder'], [RVDriveGear, 'Drive_Gear'],
  [RVDriveFollowPosition, 'Drive_FollowPosition'], [RVErraticDriver, 'Drive_ErraticPosition'],
  [RVDriveContinousDestination, 'Drive_ContinousDestination'], [RVDrivePositionSwitch, 'Drive_PositionSwitch'],
] as const;

/** Snapshot knowledge stays in the lazy DES graph. */
export function behaviorSnapshotType(owner: object): string | undefined {
  return behaviorTypes.find(([Type]) => owner instanceof Type)?.[1];
}

/** Functions attached by bind contexts/decorators are services, never state. */
function withOwnServices(owner: object, declaration: DriveStateDeclaration, config: readonly string[] = []): DriveStateDeclaration {
  const services = new Set(declaration.services);
  for (const key of Object.getOwnPropertyNames(owner)) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key)!;
    if (!declaration.stateKeys.includes(key) && (typeof descriptor.value === 'function' || config.includes(key))) services.add(key);
  }
  return { stateKeys: declaration.stateKeys, services: [...services] };
}

export function driveRunStateDeclaration(drive: RVDrive): DriveStateDeclaration {
  // applySchema copies this authored field; commands/live edits write targetPosition.
  return withOwnServices(drive, DRIVE_STATE.Drive, ['TargetPosition']);
}

export function runStateDeclaration(owner: object): DriveStateDeclaration {
  const type = behaviorSnapshotType(owner);
  if (!type) throw new Error('drive behavior without snapshot state: ' + owner.constructor.name);
  return withOwnServices(owner, DRIVE_STATE[type]);
}

/** Stable node registration order; adapters never enter the motion behavior loop. */
export function driveSignalAdapters(drive: { readonly node?: RVDrive['node'] }): IDriveBehavior[] {
  return drive.node ? getComponentInstances(drive.node).filter((owner): owner is RVDriveDestinationMotor | RVDriveSimple | RVDriveCylinder =>
    owner instanceof RVDriveDestinationMotor || owner instanceof RVDriveSimple || owner instanceof RVDriveCylinder) : [];
}

export function driveStateOwners(drive: RVDrive): readonly IDriveBehavior[] {
  return [...drive.driveBehaviors, ...driveSignalAdapters(drive)];
}

export function captureRunState(drive: RVDrive): DriveRunState {
  if (drive.usesSmoothCore()) throw new Error('smooth-motion drive ' + drive.name);
  return captureKeys(drive, RUN_STATE_KEYS);
}

export function restoreRunState(drive: RVDrive, state: DriveRunState): void {
  restoreKeys(drive, RUN_STATE_KEYS, state);
  drive.applyToNode();
}
