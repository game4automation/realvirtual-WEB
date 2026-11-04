// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * DES module public exports.
 *
 * Phase 1: Event engine core.
 * Phase 2: Material flow components.
 */

// ── Phase 1: Event engine core ──

export { DESEventQueue } from './rv-des-event-queue';
export { DESManager, DESMode } from './rv-des-manager';
export type { IDESComponent, IDESMU } from './rv-des-manager';
export { DES } from './rv-des-api';
export {
  registerAction,
  getActionIndex,
  getActionName,
  ACTION_BY_INDEX,
  ACTION_INDEX,
  ACTION_NAME,
} from './rv-des-named-actions';
export { SFC32, exponential, normal, uniform, erlang, weibull } from '../../core/rv-rng-distribution';
export type { SFC32State } from '../../core/rv-rng-distribution';
export type {
  ActionContext,
  IDESManagerRef,
  DESEvent,
  DESSerializedEvent,
} from './rv-des-event';
export { NO_MU, NO_ENTITY, DEFAULT_PRIORITY } from './rv-des-event';

// ── Phase 2: Material flow components ──

export {
  DESComponent,
  DESComponentState,
  freeCarrierSlots,
  loadMUOnCarrier,
  topmostPickable,
  unloadMUFromCarrier,
} from './rv-des-component';
export type {
  AutoConnectConfig,
  StateTimingEntry,
  DESComponentSnapshot,
} from './rv-des-component';

export { DESGizmoRenderer } from './rv-des-gizmo';

export { createDESMU, resetDESMUCounter } from './rv-des-mu';
export type { DESMU, DESMUSnapshot, IDESComponentRef, JsonValue, MuRef } from './rv-des-mu';

// ── Phase 3: Extended Components + Save/Restore ──

export {
  computeComponentStats,
  computeAllStatistics,
  snapshotStatistics,
  InfluxDBWriter,
  DEFAULT_STATISTICS_CONFIG,
} from './rv-des-statistics';
export type {
  DESStatisticsConfig,
  DESComponentStatsSnapshot,
  DESComponentStats,
} from './rv-des-statistics';

export {
  saveToStorage,
  loadFromStorage,
  deleteFromStorage,
} from './rv-des-snapshot';
export type { DESSnapshotV4 } from './rv-des-snapshot-v4';

// ── Phase 4: HMI integration ──

export { DESHMIPlugin } from './hmi/des-hmi-plugin';
export { DESComponentTooltipContent } from './hmi/DESComponentTooltip';
export type { DESComponentTooltipData } from './hmi/DESComponentTooltip';
