// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-des-mu.ts -- DESMU data model.
 *
 * DESMU is a companion data structure (not a subclass) that wraps
 * RVMovingUnit or InstancedMovingUnit with DES-specific metadata:
 * routing, timing, state flags, custom properties, and statistics.
 *
 * DESMUManager maintains the Map<MU visual, DESMU> companion lookup
 * and the flat array indexed by integer MU ID for O(1) dispatch.
 */

import type { Object3D } from 'three';
import type { RVMovingUnit, InstancedMovingUnit } from '../../core/engine/rv-mu';
import type { MuRef } from '../../core/material-flow/material-flow-self';

export type { MuRef } from '../../core/material-flow/material-flow-self';

// ── JSON value type ──

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

// ── Forward reference (avoid circular) ──

export interface IDESComponentRef {
  readonly entityId: number;
  readonly path: string;
  readonly node: Object3D;
}

// ── DESMU interface ──

export interface DESMU {
  // Identity
  id: number;
  /** Per-slot generation. Incremented whenever the manager reuses an id. */
  generation: number;
  customId: string;
  priority: number;

  // Visual MU reference
  visual: RVMovingUnit | InstancedMovingUnit | null;

  // Location & routing
  currentComponent: IDESComponentRef | null;
  nextComponent: IDESComponentRef | null;
  route: IDESComponentRef[];
  routeStep: number;

  // Timing
  entryTime: number;
  plannedExitTime: number;
  creationTime: number;
  totalTimeInSystem: number;

  // State flags
  /** Synchronous handover guard; never serialized. Optional for structural fixtures. */
  inTransfer?: boolean;
  isBlocked: boolean;
  isInTransit: boolean;
  isProcessing: boolean;
  isLoaded: boolean;
  loadedOn: IDESComponentRef | null;
  loadedOnNode: string | null;

  // Logical carrier hierarchy. MuRef is deliberately limited to hierarchy and
  // reservations; queued events keep the established muId + pendingEvents guard.
  childMUs: MuRef[];
  parentMU: MuRef | null;
  carrierType?: string;
  carrierCapacity?: number;
  visualTemplateId?: string;

  // Custom properties — JSON-serializable, survives save/restore
  prop: Record<string, JsonValue>;

  // Per-MU statistics
  componentsVisited: number;
  blockedCount: number;
  totalBlockedTime: number;
  totalProcessingTime: number;
  totalTransitTime: number;

  // Lifecycle (manager-internal, NOT serialized): refcount of queued events
  // referencing this MU + deferred-retire flag. A sink-consumed MU's slot is
  // only freed once no pending event references it, so memory stays bounded by
  // WIP instead of total production. Optional so test doubles stay valid.
  pendingEvents?: number;
  retired?: boolean;
  retireNotified?: boolean;
  /** Restore-only pose cache used until a headless MU is materialized. */
  restoredPosition?: [number, number, number];
  restoredQuaternion?: [number, number, number, number];
  /** Restore-only: node the visual must be parented under (add, local pose kept) once it is materialized - a turntable disc the MU rides on (plan-2059 O2). */
  restoredVisualParent?: import('three').Object3D;
  /** Travel heading is independent of the visual pose (e.g. after a fork turn).
   * Its presence controls setMuForward's redundant-write guard. */
  forward?: [number, number, number];
  /** Cached part-frame bounds used by muBugOffset, including while headless. */
  _bugSize?: [number, number, number];
}

// ── DESMUSnapshot (for save/restore) ──

export interface DESMUSnapshot {
  id: number;
  /** Optional only so v1/v2 fixture shapes remain accepted by the v3 migrator. */
  generation?: number;
  customId: string;
  priority: number;
  currentComponentPath: string | null;
  routePaths: string[];
  routeStep: number;
  entryTime: number;
  plannedExitTime: number;
  creationTime: number;
  totalTimeInSystem: number;
  isBlocked: boolean;
  isInTransit: boolean;
  isProcessing: boolean;
  isLoaded: boolean;
  loadedOnPath: string | null;
  loadedOnNode: string | null;
  childMUs?: MuRef[];
  parentMU?: MuRef | null;
  carrierType?: string;
  carrierCapacity?: number;
  visualTemplateId?: string;
  prop: Record<string, JsonValue>;
  componentsVisited: number;
  blockedCount: number;
  totalBlockedTime: number;
  totalProcessingTime: number;
  totalTransitTime: number;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  forward?: [number, number, number];
  _bugSize?: [number, number, number];
}

// ── Factory ──



/**
 * Create a fresh DESMU with default values.
 */
export function createDESMU(
  simTime: number,
  visual: RVMovingUnit | InstancedMovingUnit | null = null,
  manager: { customIdCounter: number },
): DESMU {
  return createDESMUForRestore(simTime, `MU-${++manager.customIdCounter}`, visual);
}

/** Allocate a detached MU without consuming any run-owned ids. */
export function createDESMUForRestore(
  simTime: number, customId: string, visual: RVMovingUnit | InstancedMovingUnit | null = null,
): DESMU {
  return {
    id: -1, // assigned by DESManager.registerMU()
    generation: 0, // assigned by DESManager.registerMU()/registerMUAt()
    customId,
    priority: 0,
    visual,
    currentComponent: null,
    nextComponent: null,
    route: [],
    routeStep: 0,
    entryTime: simTime,
    plannedExitTime: -1,
    creationTime: simTime,
    totalTimeInSystem: 0,
    isBlocked: false,
    inTransfer: false,
    isInTransit: false,
    isProcessing: false,
    isLoaded: false,
    loadedOn: null,
    loadedOnNode: null,
    childMUs: [],
    parentMU: null,
    prop: {},
    componentsVisited: 0,
    blockedCount: 0,
    totalBlockedTime: 0,
    totalProcessingTime: 0,
    totalTransitTime: 0,
    pendingEvents: 0,
    retired: false,
    retireNotified: false,
  };
}

/**
 * Reset the custom ID counter (for tests / simulation reset).
 */
export function resetDESMUCounter(): void {
  // Legacy standalone API; counters now belong to the manager.
}
