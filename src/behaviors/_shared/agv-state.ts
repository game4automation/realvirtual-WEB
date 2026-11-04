// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** AgvLocal own-key inventory. Classification does not change runtime behavior. */
export const agvStateKeys = [
  // Activation / visibility and the task/dwell state machine are continuation data.
  'active', 'hiddenByActive', 'task', 'phase', 'serviceRemainingSec',
  'desServiceEvent', 'serviceMode', 'dockReleaseFlag', 'servedPathId',
  'atNodeId', 'desArrivedPathId',
  // Keep continuous bookkeeping explicit even though Phase 5 captures DES only.
  'cTime', 'lastCanMove', 'stepFrame',
  'frozen', 'frozenServiceSec', 'maneuver', 'maneuverEpoch', 'serviceEpoch',
] as const;

export const agvServices = [
  // Live wiring and traveler; persist its coordinates separately through authority.
  'traveler', 'mbHost', 'mbKind', 'kernelKind',
  // Resolved rv_extras / body geometry / reset seed, fingerprint guarded on restore.
  'targetSpeed', 'acceleration', 'useAcceleration', 'startTask',
  'safetyDistanceMm', 'minGapMm', 'lookAheadMm', 'headwayGain', 'startPath', 'startPosM',
  'decel', 'aLat', 'frontMm', 'rearMm', 'widthMm', 'gapMm', 'dockSpeed', 'dockDist',
  'scanner', 'reactionSec', 'protectiveMm', 'warningMm', 'allowReverse', 'reverseSpeed',
  // Reusable Three.js pose services; values are overwritten before use.
  '_pos', '_quat', '_parentQuat',
] as const;

export const agvScratch = [
  // Synchronous dispatch guard and per-call zone buffers; capture only outside hooks.
  'inHook', '_relevantZones', '_heldScratch',
] as const;

/** D1 applies to task, startTask and maneuver.pending.task alike. No callbacks
 * may disappear silently: A3 must reject undeclared callback attachments until
 * fleet.runner (Phase 6) can reattach them. data must pass JSON validation.
 * serviceMode is AgvLocal state, not an AgvTask field.
 */
export const agvTaskStateKeys = [
  'destination', 'serviceSec', 'data', 'serviceState', 'approach',
] as const;
export const agvTaskServices = ['onArrive', 'onServiceEnd'] as const;
export const agvTaskScratch = [] as const;

// A3 handleFields specification; full action name MF.Agv.ServiceEnd, no data.kind.
export const agvEventHandleFields = {
  desServiceEvent: [{ action: 'ServiceEnd', kind: null }],
} as const;
