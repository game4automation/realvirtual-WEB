// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-des-event.ts -- DES event interfaces and constants.
 *
 * Defines the logical DES event shape (for external APIs and snapshots)
 * and the ActionContext scratch object used for zero-allocation dispatch.
 *
 * The actual event *storage* is struct-of-arrays TypedArrays inside
 * DESEventQueue -- these interfaces are for user-facing code and serialization only.
 */

// ── Forward declaration (avoid circular import) ──

/** Minimal manager interface for ActionContext (avoids full DESManager import). */
export interface IDESManagerRef {
  readonly currentTime: number;
  getComponentByEntityId(entityId: number): unknown;
  getMU(muId: number): unknown;
}

// ── ActionContext ──

/**
 * Context passed to every Named Action callback.
 *
 * A single pre-allocated instance is reused per dispatch (zero GC).
 * Fields are mutated by DESManager before each call -- never hold a reference
 * across async boundaries.
 */
export interface ActionContext {
  /** Current simulation time in seconds. */
  simTime: number;
  /** Hierarchy path of the owning component (for user-facing code, not lookup). */
  componentPath: string;
  /** Integer ID of the associated MU (-1 if none). */
  muId: number;
  /** Optional JSON-serializable payload (event-specific data). */
  data: unknown;
  /** Reference to the DESManager (for scheduling follow-up events). */
  manager: IDESManagerRef;
}

// ── DESEvent (logical shape) ──

/**
 * Logical representation of a DES event -- used in user APIs.
 * Internal storage is TypedArray struct-of-arrays (see DESEventQueue).
 */
export interface DESEvent {
  /** Scheduled simulation time in seconds. */
  time: number;
  /** Named Action index (uint32 into ACTION_BY_INDEX). */
  actionIndex: number;
  /** Integer component ID (index into DESManager._components). */
  entityId: number;
  /** Integer MU ID (-1 if none). */
  muId: number;
  /** Priority (higher = fires first at same time). */
  priority: number;
}

// ── Serialized event (JSON-safe for snapshots) ──

/**
 * JSON-serializable event for save/restore snapshots.
 * Uses string action names instead of integer indices (survives code changes).
 */
export interface DESSerializedEvent {
  time: number;
  action: string;
  componentPath: string;
  muId: number;
  priority: number;
  data: unknown;
}

// ── Constants ──

/** Sentinel value for "no MU associated with this event". */
export const NO_MU = -1;

/** Sentinel value for "no entity / global event". */
export const NO_ENTITY = -1;

/** Default event priority. */
export const DEFAULT_PRIORITY = 0;

/**
 * Name of the neutral SYSTEM event the checkpoint autosave rides on
 * (`DESManager.scheduleCheckpoint`). Never dispatched through the action
 * table, never serialized into snapshots, ignored by statistics.
 */
export const CHECKPOINT_ACTION = '__checkpoint__';

/** Warmup SYSTEM event: resets statistics before time-equal model events. */
export const WARMUP_ACTION = '__warmup__';
export const WARMUP_PRIORITY = 0x7fffffff;

/** At instant t: model events → live planning changes → checkpoint. Reserved system priority. */
export const PLANNING_PRIORITY = -0x7fffffff;

/**
 * Priority of the checkpoint system event: Int32 MINIMUM, so at a grid
 * boundary it fires AFTER every time-equal model event (tie-break is
 * time ASC → priority DESC → id ASC) — the snapshot captures the state at
 * the END of the boundary time point.
 */
export const CHECKPOINT_PRIORITY = -0x80000000;
