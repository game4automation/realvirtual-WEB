// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Classification only: these literal inventories do not install a participant.
 * State includes handles and references requiring a persistence codec, not raw JSON.
 */
export const vehicleStateKeys = [
  // Identity, applied trajectory and causal planning / coalescing state.
  'id', 'p', 'plan', 'curIdx', 'version', 'usedLeaders', 'dirty', 'replansAtInstant',
  // Queue identities: encode through handleFields, including array / map entries.
  'legEvent', 'extendEvent', 'watchdogEvent', 'fieldEvent', 'statEvent', 'wakeEvent',
  'notifyEvents', 'releaseEvents',
  // Claims retain EXIT ODOMETERS, not just membership; routing uses stable path ids.
  'held', 'prevPathId', 'routeDecided', 'frozen', 'dir', 'fixedRoute',
  // Scanner continuation; fieldLeader.u becomes a vehicle-id reference.
  'field', 'fieldCap', 'fieldRestartAt', 'fieldLeader', 'sensor', 'sensorBound',
  'sensorInfeasibleReported',
  // Motion marks and timing influence future dispatch; renderT preserves overlay speed.
  'motion', 'motionMarks', 'motionIdx', 'renderT', 'lastExtendT', 'external',
  'softStale', 'statEventT', 'wakeDelay', 'releaseTimes',
  // Occurrence guards and one-shot diagnostics must survive continuation.
  'missedStops', 'orphans', 'orphanWarned',
] as const;

export const vehicleServices = [
  // Live traveler / callbacks survive container replacement; locCache is invalidated.
  // Traveler path-id/s/v/blocked/atEnd need an explicit codec in the participant.
  'traveler', 'host', 'locCache',
] as const;

// Vehicle has no call-local buffers: even dirty / counters affect continuation.
export const vehicleScratch = [] as const;

export const mbPlanStateKeys = [
  // Route is DATA as ordered {pathId, x0}; resolve ids without asking the router.
  'route', 'profile', 'stopCause', 'stopLeaderId', 'leaderBound', 'freeEnd',
  'staticLimits', 'odo0', 'capped', 'dir',
] as const;
// Profiles / limit pieces are numeric records, not samplers or callbacks.
export const mbPlanServices = [] as const;
export const mbPlanScratch = [] as const;

export const authorityStateKeys = [
  // Wait start (including passive NaN) determines FIFO; order is derived from ids.
  'vehicles', 'waiters', 'flushEventTime', 'instant', 'replansThisInstant', 'lastNow',
  // Preserve observable diagnostics, trace enablement and internal test policy.
  'stats', 'trace', 'replanCap', 'serviceReachCheck',
] as const;
export const authorityServices = [
  // Existing singleton wiring/listeners remain; geometry clearance is a cache.
  // MotionEventClock is continuous-only (D1), never a DES snapshot queue.
  // frozenListeners: failure-transition subscribers (the job runner's wait pause), wiring like listenersInstalled.
  'kind', 'network', 'listenersInstalled', 'clock', 'clearance', 'frozenListeners',
] as const;
export const authorityScratch = [
  // Sorted vehicle references rebuilt after restore; remaining fields are call-local.
  // Capture must occur outside flush/build callbacks: prevWaits must be null.
  'order', 'flushing', 'callbackDepth', 'prevWaits', 'oppositeScratch',
  'touchedZones', 'staleScratch', 'occStart', 'occEnd', 'occQueue', 'occPos', 'occSample',
] as const;

/** Expected hook suffix and USER data.kind (inside HookEventData.data).
 * Full action name is MF.Agv.<action>. null means no kind property, not kind:null.
 * legEvent has two alternatives; notifyEvents/releaseEvents describe each element.
 * This inventory is a specification for A2 handleFields, not registry registration.
 */
export const authorityEventHandleFields = {
  legEvent: [{ action: 'Arrival', kind: null }, { action: 'Replan', kind: 'stop' }],
  extendEvent: [{ action: 'Replan', kind: 'extend' }],
  watchdogEvent: [{ action: 'Replan', kind: 'watchdog' }],
  fieldEvent: [{ action: 'Replan', kind: 'field' }],
  statEvent: [{ action: 'Replan', kind: 'stat' }],
  wakeEvent: [{ action: 'Replan', kind: 'wake' }],
  notifyEvents: [{ action: 'Replan', kind: 'notify' }],
  releaseEvents: [{ action: 'Replan', kind: 'zoneRelease' }],
} as const;
