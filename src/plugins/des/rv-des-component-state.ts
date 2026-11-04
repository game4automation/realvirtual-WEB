// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Shared by every bound MaterialFlowAdapter type. Keep declarations literal:
 * deriving services from live keys would silently accept newly added state.
 * SnapshotRegistry checks Reflect.ownKeys, including symbols, at capture only.
 * freezeEvent stores no handle: it cancels the event and returns remaining
 * seconds. FrozenDescriptor stores action/remaining/payload, not queue ids.
 * The retained queue handles are manager warmup/checkpoint schema fields.
 */
export const componentStateKeys = [
  // Captured by DESComponent.toSnapshot (timing start is folded into durations).
  'state', '_currentLoad', 'isBlocked', 'isWorking', 'isFailure', 'exitBlocked',
  'totalProcessed', 'prop', 'mus', 'stateTimings', 'currentStateName', 'stateStartTime',
  'statBaselineTime', 'processedBaseline', '_pendingTransferCommits',
  // Captured as DES-id/MU-id tuples by the component participant.
  'blockedMUs',
  // Captured by MaterialFlowAdapter.toSnapshot; snapshotState is the staged
  // onRestore argument, refreshed by the next behaviour onSnapshot call.
  'frozen',
] as const;

export const componentServices = [
  // References: model/configuration, fixed for a bound run (fingerprint guarded).
  'node', 'isOwner', 'ProcessingTime', 'MaxCapacity', 'LinkedNode', 'EntryNode',
  'ExitNode', 'autoConnect', 'freeStates', 'def', 'processingAttachmentTime',
  'processingAttachmentSource',
  // Wiring: registration ids, topology, infrastructure and subscriptions survive restore.
  // Identity: plan-769 address + type, fixed for a bound run (the fingerprint covers it); named RNG streams
  // hang off it (plan-2061) and are snapshot-pending under RNG v2.
  'desId',
  'entityId', 'nextComponents', 'previousComponents', 'registry', 'signalStore',
  'manager', 'scene', 'self', 'signalHandlers', 'cleanups', '_drives',
  // Reference: this stream's state is owned and captured by des.rng.
  '_rng',
  // Caches: resolved model nodes and connection geometry, rebuilt at bind.
  'visualNode', 'entryNodeRef', 'exitNodeRef', 'inputPoints', 'outputPoints',
  'defaultInPosition', 'defaultOutPosition',
  // Hooks: external observers and runner-owned dispatch/scheduling seams.
  'onLoadChanged', 'completionListeners', 'onSelectNext', 'onCanAccept',
  'onMUEnter', 'onMUExit', 'onFailure', 'onRepaired', 'onSignalChange', 'onRestored',
  'onMUConsumed', 'materializeMu', 'devSettleGuard', 'beforeHookDispatch',
  // plan-2212 Phase 2: sink-arrival listeners of Model-Scripts - each belongs to a
  // script VM and is re-registered by the VM's setup(), never by a restore.
  'consumedListeners',
  'synchronizeScheduledClock', 'freezeScheduledWork', 'resumeScheduledWork',
  // Scratch: synchronous call stacks, cleared in finally; never continuation state.
  'tentativeReleases', 'pendingPoses', 'savedAccept',
  // Scratch: moveAll writes these legacy slots but never reads them; the queued
  // named action contains the actual continuation (including component and MU).
  '_moveAllPending', '_moveAllAction', '_moveAllComp', '_moveAllMu',
  // Scratch: prepared behaviour restore argument, consumed only by onRestored.
  'snapshotState', 'restoredSourcePending',
] as const;
